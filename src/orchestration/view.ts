import type { WorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws/runtime'
import { object, parseExecutionResult, parseInput, parsePlan } from './domain'
import { WORKFLOW_ID, type CapacityPlan, type TaskView } from './types'
export async function taskView(store: WorkflowExecutionStore, id: string): Promise<TaskView | undefined> {
  const loaded = await store.loadExecution(id)
  if (!loaded || loaded.run.workflowId !== WORKFLOW_ID) return undefined
  const { run, events } = loaded
  const state = await store.loadRunState(id)
  const view: TaskView = { id, status: 'queued', reason: 'Queued for processing', input: parseInput(run.input), createdAt: new Date(run.createdAt).toISOString(), release: process.env.RELEASE_ID ?? 'development', timeline: events.map(({ event }) => ({ type: event.type, at: new Date(event.ts).toISOString(), ...('stepId' in event ? { step: event.stepId } : {}) })) }
  for (const { event } of events) {
    if (event.type === 'STEP_STARTED' && event.stepId === 'plan') { view.status = 'planning'; view.reason = 'Reading sandbox capacity and generating immutable plan' }
    if (event.type === 'STEP_FINISHED' && event.stepId === 'plan') view.plan = parsePlan(event.result)
    if (event.type === 'APPROVAL_RESOLVED') view.decision = { approved: event.approved, actor: typeof event.meta?.actor === 'string' ? event.meta.actor : 'unknown' }
    if (event.type === 'STEP_STARTED' && event.stepId === 'execute') { view.status = 'executing'; view.reason = 'Executor is changing or reconciling sandbox capacity' }
  }
  if (run.status === 'paused' && state?.pendingApproval && !view.decision) { view.status = 'awaiting_approval'; view.approvalId = state.pendingApproval.approvalId; view.reason = 'Waiting for approver-demo to approve this exact plan' }
  if (run.status === 'paused' && run.waitingFor?.signalName === '__timer') { view.status = 'scheduled'; view.reason = `Approved; waiting until ${view.input.executeAt}` }
  if (run.status === 'queued' && view.plan) { view.status = 'queued'; view.reason = 'Queued for workflow resumption' }
  if (run.status === 'running') {
    view.status = view.decision?.approved ? 'executing' : 'planning'
    view.reason = view.decision?.approved ? 'Executing or reconciling the approved operation' : 'Processing request and preparing the approval wait'
    if (run.lease && run.lease.expiresAt < Date.now()) view.reason = 'Worker lease expired; waiting for durable recovery'
  }
  if (run.status === 'errored') { view.status = 'failed'; view.error = run.error?.message ?? 'Workflow failed'; view.reason = view.error }
  if (run.status === 'finished') {
    const output = object(run.output)
    if (output.status === 'rejected') { view.status = 'rejected'; view.reason = 'Approver rejected the plan; no change executed' }
    else { const result = parseExecutionResult(output); view.status = result.status; if (result.status === 'succeeded') { view.receipt = result.receipt; view.reason = 'Capacity verified; completion event committed for delivery' } else view.reason = result.reason }
  }
  return view
}
export async function approvedPlan(store: WorkflowExecutionStore, id: string): Promise<CapacityPlan | undefined> {
  const view = await taskView(store, id)
  if (!view?.plan || !view.decision?.approved || view.decision.actor !== 'approver-demo') return undefined
  const events = await store.readEvents({ runId: id })
  const decision = events.map(({ event }) => event).reverse().find(event => event.type === 'APPROVAL_RESOLVED')
  return decision?.type === 'APPROVAL_RESOLVED' && decision.approved && decision.meta?.actor === 'approver-demo' && decision.meta.planHash === view.plan.hash ? view.plan : undefined
}
