import { createWorkflow } from '@ataylorme/tanstack-workflow-aws/workflow'
import { publishWorkflowEvent } from '@ataylorme/tanstack-workflow-aws/workflow-effects'
import { hash, parseInput } from './domain'
import { WORKFLOW_ID, type CapacityPlan, type ExecutionResult } from './types'
export interface WorkflowPorts { target: string; readCapacity: () => Promise<number | null>; execute: (taskId: string) => Promise<ExecutionResult> }
export function capacityWorkflow(ports: WorkflowPorts) {
  return createWorkflow({ id: WORKFLOW_ID, version: 'v1' }).handler(async ctx => {
    const input = parseInput(ctx.input)
    const plan = await ctx.step('plan', async (): Promise<CapacityPlan> => {
      const data = { taskId: ctx.runId, target: ports.target, before: await ports.readCapacity(), after: input.desiredConcurrency, executeAt: input.executeAt, workflowVersion: 'v1' as const }
      return { ...data, hash: hash(data) }
    }, { retry: { maxAttempts: 3, backoff: 'fixed', baseMs: 250 } })
    const decision = await ctx.approve({ title: `Set sandbox reserved concurrency to ${plan.after}?`, description: `Plan ${plan.hash}; observed ${plan.before ?? 'unreserved'}; not before ${plan.executeAt}` })
    if (decision.meta?.planHash !== plan.hash || decision.meta?.actor !== 'approver-demo') return { status: 'blocked', reason: 'Approval is not bound to this plan' }
    if (!decision.approved) return { status: 'rejected' }
    await ctx.sleepUntil(Date.parse(plan.executeAt))
    const result = await ctx.step('execute', () => ports.execute(ctx.runId), { retry: { maxAttempts: 3, backoff: 'fixed', baseMs: 500 } })
    if (result.status === 'blocked') return result
    const receipt = result.receipt
    if (receipt.taskId !== ctx.runId || receipt.planHash !== plan.hash || receipt.target !== plan.target || receipt.after !== plan.after || receipt.before !== plan.before || receipt.operationId !== `${ctx.runId}:${plan.hash}`) throw new Error('Executor receipt does not match approved plan')
    await publishWorkflowEvent(ctx, 'completion-event', { id: `success-${ctx.runId}`, type: 'devops.task.succeeded.v1', version: 1, timestamp: receipt.completedAt, correlationId: ctx.runId, data: receipt })
    return result
  })
}
