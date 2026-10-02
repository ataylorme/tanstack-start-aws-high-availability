import { describe, expect, it, vi } from 'vitest'
import { defineWorkflowRuntime, inMemoryWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws/runtime'
import { capacityWorkflow } from '../src/orchestration/workflow'
import { approvedPlan, taskView } from '../src/orchestration/view'
import { WORKFLOW_ID, type ExecutionResult } from '../src/orchestration/types'

function fixture(executeAt = new Date(Date.now() - 1000).toISOString()) {
  const store = inMemoryWorkflowExecutionStore()
  const readCapacity = vi.fn(async () => 1)
  const execute = vi.fn(async (taskId: string): Promise<ExecutionResult> => {
    const plan = (await taskView(store, taskId))!.plan!
    return { status: 'succeeded', receipt: { operationId: `${taskId}:${plan.hash}`, taskId, planHash: plan.hash, target: plan.target, before: plan.before, after: plan.after, completedAt: new Date().toISOString() } }
  })
  const freshRuntime = () => defineWorkflowRuntime({ store, workflows: { [WORKFLOW_ID]: { load: async () => capacityWorkflow({ target: 'sandbox', readCapacity, execute }) } } })
  const runtime = freshRuntime()
  const start = () => runtime.startRun({ runId: 'task-test', workflowId: WORKFLOW_ID, input: { desiredConcurrency: 3, executeAt, requestedAt: new Date().toISOString(), requester: 'requester-demo', requestHash: 'hash' }, leaseOwner: 'first' })
  const approve = async (approved = true, planHash?: string) => {
    const view = (await taskView(store, 'task-test'))!
    return runtime.deliverApproval({ runId: 'task-test', approval: { approvalId: view.approvalId!, approved, meta: { actor: 'approver-demo', planHash: planHash ?? view.plan!.hash } }, leaseOwner: 'first' })
  }
  return { store, runtime, freshRuntime, start, approve, readCapacity, execute }
}

describe('capacity workflow with real in-memory durable engine', () => {
  it('plans once, awaits approval, succeeds and commits a publication intent', async () => {
    const f = fixture(); await f.start()
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'awaiting_approval', plan: { before: 1, after: 3 } })
    expect(f.execute).not.toHaveBeenCalled()
    expect(await approvedPlan(f.store, 'task-test')).toBeUndefined()
    await f.approve(); await f.runtime.sweep({ leaseOwner: 'timer', now: Date.now() + 1000 })
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'succeeded', receipt: { after: 3 } })
    expect(f.readCapacity).toHaveBeenCalledTimes(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
    const events = await f.store.readEvents({ runId: 'task-test' })
    expect(events.filter(({ event }) => event.type === 'STEP_FINISHED' && event.stepId === 'completion-event')).toMatchObject([{ event: { result: { $workflowEffect: 'publish', event: { type: 'devops.task.succeeded.v1', correlationId: 'task-test' } } } }])
  })
  it('rejects without executing or publishing success', async () => {
    const f = fixture(); await f.start(); await f.approve(false)
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'rejected' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(await approvedPlan(f.store, 'task-test')).toBeUndefined()
  })
  it('blocks approval for another plan and denies executor authorization', async () => {
    const f = fixture(); await f.start(); await f.approve(true, 'wrong-hash')
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'blocked' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(await approvedPlan(f.store, 'task-test')).toBeUndefined()
  })
  it('survives runtime replacement while awaiting approval and preserves the plan', async () => {
    const f = fixture(); await f.start()
    const view = (await taskView(f.store, 'task-test'))!
    await f.freshRuntime().deliverApproval({ runId: 'task-test', approval: { approvalId: view.approvalId!, approved: true, meta: { actor: 'approver-demo', planHash: view.plan!.hash } }, leaseOwner: 'replacement' })
    await f.freshRuntime().sweep({ leaseOwner: 'replacement', now: Date.now() + 1000 })
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'succeeded', plan: view.plan })
    expect(f.readCapacity).toHaveBeenCalledTimes(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('waits durably for a future time and resumes through a replacement runtime', async () => {
    const at = Date.now() + 60_000
    const f = fixture(new Date(at).toISOString()); await f.start(); await f.approve(); await f.runtime.sweep({ leaseOwner: 'timer', now: Date.now() + 1000 })
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'scheduled' })
    expect(f.execute).not.toHaveBeenCalled()
    await f.freshRuntime().sweep({ leaseOwner: 'replacement', now: at + 1000 })
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'succeeded' })
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('exposes executor reconciliation blocks', async () => {
    const f = fixture(); f.execute.mockResolvedValue({ status: 'blocked', reason: 'Unresolved target operation' })
    await f.start(); await f.approve(); await f.runtime.sweep({ leaseOwner: 'timer', now: Date.now() + 1000 })
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'blocked', reason: 'Unresolved target operation' })
  })
  it.each(['before', 'operationId'] as const)('rejects a receipt with mismatched %s', async field => {
    const f = fixture()
    f.execute.mockImplementation(async taskId => {
      const plan = (await taskView(f.store, taskId))!.plan!
      const receipt = { operationId: `${taskId}:${plan.hash}`, taskId, planHash: plan.hash, target: plan.target, before: plan.before, after: plan.after, completedAt: new Date().toISOString() }
      if (field === 'before') receipt.before = 5
      else receipt.operationId = 'unrelated-operation'
      return { status: 'succeeded', receipt }
    })
    await f.start(); await f.approve(); await f.runtime.sweep({ leaseOwner: 'timer', now: Date.now() + 1000 })
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'failed', error: 'Executor receipt does not match approved plan' })
  })
  it('fails without publishing when executor returns another task receipt', async () => {
    const f = fixture(); f.execute.mockResolvedValue({ status: 'succeeded', receipt: { operationId: 'wrong', taskId: 'other', planHash: 'wrong', target: 'sandbox', before: 1, after: 3, completedAt: new Date().toISOString() } })
    await f.start(); await f.approve(); await f.runtime.sweep({ leaseOwner: 'timer', now: Date.now() + 1000 })
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'failed', error: 'Executor receipt does not match approved plan' })
    expect((await f.store.readEvents({ runId: 'task-test' })).some(({ event }) => event.type === 'STEP_FINISHED' && event.stepId === 'completion-event')).toBe(false)
  })
  it('does not show a stale approval prompt after the decision is durably queued', async () => {
    const f = fixture(); await f.start()
    const pending = (await taskView(f.store, 'task-test'))!
    await f.store.deliverApproval({ runId: 'task-test', approval: { approvalId: pending.approvalId!, approved: true, meta: { actor: 'approver-demo', planHash: pending.plan!.hash } }, now: Date.now() })
    const view = await taskView(f.store, 'task-test')
    expect(view).toMatchObject({ status: 'queued', reason: 'Queued for workflow resumption' })
    expect(view?.approvalId).toBeUndefined()
  })
  it('describes running work even when STEP_STARTED is not persisted', async () => {
    const f = fixture(); await f.start()
    const original = (await f.store.loadRun('task-test'))!
    vi.spyOn(f.store, 'loadExecution').mockResolvedValue({ run: { ...original, status: 'running', lease: { owner: 'crashed', expiresAt: 1 } }, events: await f.store.readEvents({ runId: 'task-test' }) })
    expect(await taskView(f.store, 'task-test')).toMatchObject({ status: 'planning', reason: 'Worker lease expired; waiting for durable recovery' })
  })

})
