/** Executable examples linked from the contributor cookbook and versioning guide. */
import { describe, expect, it, vi } from 'vitest'
import { createWorkflow } from '@ataylorme/tanstack-workflow-aws/workflow'
import { defineWorkflowRuntime, inMemoryWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws/runtime'
import { capacityWorkflow } from '../src/orchestration/workflow'
import { WORKFLOW_ID, type ExecutionResult } from '../src/orchestration/types'
import { taskView } from '../src/orchestration/view'

function example() {
  const store = inMemoryWorkflowExecutionStore()
  const readCapacity = vi.fn(async () => 1)
  const execute = vi.fn(async (taskId: string): Promise<ExecutionResult> => {
    const plan = (await taskView(store, taskId))?.plan
    if (!plan) throw new Error('Expected a persisted plan')
    return { status: 'succeeded', receipt: {
      operationId: `${taskId}:${plan.hash}`, taskId, planHash: plan.hash,
      target: plan.target, before: plan.before, after: plan.after,
      completedAt: new Date().toISOString(),
    } }
  })
  const v1 = capacityWorkflow({ target: 'sandbox-test', readCapacity, execute })
  const runtime = defineWorkflowRuntime({ store, workflows: { [WORKFLOW_ID]: { version: 'v1', load: async () => v1 } } })
  const input = {
    desiredConcurrency: 3, executeAt: new Date(Date.now() - 1000).toISOString(),
    requestedAt: new Date().toISOString(), requester: 'requester-demo', requestHash: 'test-only',
  }
  return { store, runtime, v1, input, readCapacity, execute }
}

describe('executable contributor documentation', () => {
  it('resumes an approved task through a replacement runtime and commits an event intent', async () => {
    const f = example()
    // Tests can drive the runtime directly; HTTP admission must use store.createRun.
    await f.runtime.startRun({ runId: 'task-docs', workflowId: WORKFLOW_ID, input: f.input, leaseOwner: 'first-process' })
    const paused = await taskView(f.store, 'task-docs')
    if (!paused?.plan || !paused.approvalId) throw new Error('Expected approval wait')
    expect(paused.status).toBe('awaiting_approval')
    expect(f.execute).not.toHaveBeenCalled()

    const replacement = defineWorkflowRuntime({ store: f.store, workflows: { [WORKFLOW_ID]: { version: 'v1', load: async () => f.v1 } } })
    await replacement.deliverApproval({ runId: paused.id, approval: {
      approvalId: paused.approvalId, approved: true,
      meta: { actor: 'approver-demo', planHash: paused.plan.hash },
    }, leaseOwner: 'replacement-process' })
    await replacement.sweep({ leaseOwner: 'timer-worker', now: Date.now() + 1000 })
    expect(await taskView(f.store, paused.id)).toMatchObject({ status: 'succeeded', plan: paused.plan })
    expect(f.readCapacity).toHaveBeenCalledTimes(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
    const history = await f.store.readEvents({ runId: paused.id })
    expect(history.some(({ event }) => event.type === 'STEP_FINISHED' && event.stepId === 'completion-event')).toBe(true)
    // This proves a committed intent, not actual SNS delivery.
  })

  it('keeps old runs on their retained definition when the registry advances', async () => {
    const f = example()
    await f.runtime.startRun({ runId: 'task-docs-version', workflowId: WORKFLOW_ID, input: f.input, leaseOwner: 'old-process' })
    const paused = await taskView(f.store, 'task-docs-version')
    if (!paused?.plan || !paused.approvalId) throw new Error('Expected approval wait')
    const incompatible = vi.fn(async () => { throw new Error('Old run entered new definition') })
    const v2 = createWorkflow({ id: WORKFLOW_ID, version: 'v2' }).handler(incompatible)
    const replacement = defineWorkflowRuntime({
      store: f.store,
      workflows: { [WORKFLOW_ID]: { version: 'v2', load: async () => v2, previousVersions: { v1: async () => f.v1 } } },
    })
    await replacement.deliverApproval({ runId: paused.id, approval: {
      approvalId: paused.approvalId, approved: true,
      meta: { actor: 'approver-demo', planHash: paused.plan.hash },
    }, leaseOwner: 'new-process' })
    await replacement.sweep({ leaseOwner: 'timer-worker', now: Date.now() + 1000 })
    expect(incompatible).not.toHaveBeenCalled()
    expect(await taskView(f.store, paused.id)).toMatchObject({ status: 'succeeded', plan: paused.plan })
    expect((await f.store.loadRun(paused.id))?.workflowVersion).toBe('v1')
  })
})
