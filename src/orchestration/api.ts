import { timingSafeEqual } from 'node:crypto'
import type { WorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws/runtime'
import { hash, parseDecision, parseInput, parseRequest } from './domain'
import { WORKFLOW_ID, type DecisionRequest, type TaskInput } from './types'
import { taskView } from './view'
export interface DecisionRecord extends DecisionRequest { actor: 'approver-demo' }
export interface DecisionStore { get: (taskId: string) => Promise<DecisionRecord | undefined> }
export interface ApiServices { store: WorkflowExecutionStore; decisions: DecisionStore; requesterToken: string; approverToken: string; now?: () => number }
function sameDecision(left: DecisionRecord, right: DecisionRecord): boolean {
  return left.actor === right.actor && left.approvalId === right.approvalId && left.planHash === right.planHash && left.approved === right.approved
}
function matches(request: Request, token: string): boolean {
  const actual = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return token.length >= 32 && actual.length === expected.length && timingSafeEqual(actual, expected)
}
export function createTaskApi(services: ApiServices) {
  const now = services.now ?? Date.now
  return async (request: Request): Promise<Response> => {
    const { store, decisions } = services
    if (services.requesterToken === services.approverToken) return Response.json({ error: 'Distinct credentials required' }, { status: 503 })
    const role = matches(request, services.requesterToken) ? 'requester' : matches(request, services.approverToken) ? 'approver' : undefined
    if (!role) return Response.json({ error: 'Bearer credential required' }, { status: 401 })
    const path = new URL(request.url).pathname
    const match = /^\/api\/tasks(?:\/(task-[a-f0-9]{64})(\/decision)?)?$/.exec(path)
    if (!match) return Response.json({ error: 'Not found' }, { status: 404 })
    const id = match[1]
    const decisionRoute = Boolean(match[2])
    if (request.method === 'GET' && !decisionRoute) {
      if (id) { const task = await taskView(store, id); return Response.json(task ?? { error: 'Not found' }, { status: task ? 200 : 404 }) }
      const runs = await store.listRuns({ limit: 100 })
      const tasks = (await Promise.all(runs.filter(run => run.workflowId === WORKFLOW_ID).map(run => taskView(store, run.runId)))).filter(task => task !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return Response.json({ tasks, role })
    }
    if (request.method !== 'POST' || (id && !decisionRoute)) return Response.json({ error: 'Method not allowed' }, { status: 405 })
    if ((decisionRoute && role !== 'approver') || (!id && role !== 'requester')) return Response.json({ error: 'Role not permitted' }, { status: 403 })
    let body: unknown
    try { const text = await request.text(); if (text.length > 4096) return Response.json({ error: 'Payload too large' }, { status: 413 }); body = JSON.parse(text) } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
    if (!id) {
      let parsed
      try { parsed = parseRequest(body) } catch (error) { return Response.json({ error: String(error) }, { status: 400 }) }
      const key = request.headers.get('idempotency-key') ?? ''
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) return Response.json({ error: 'Idempotency-Key must be 8–128 letters, digits, hyphens or underscores' }, { status: 400 })
      const runId = `task-${hash(['requester-demo', key])}`
      const requestHash = hash(parsed)
      const existing = await store.loadRun(runId)
      if (existing) return Response.json(parseInput(existing.input).requestHash === requestHash ? await taskView(store, runId) : { error: 'Idempotency key conflicts with another request' }, { status: parseInput(existing.input).requestHash === requestHash ? 200 : 409 })
      const at = now()
      if (parsed.executeAt && (Date.parse(parsed.executeAt) < at || Date.parse(parsed.executeAt) > at + 86_400_000)) return Response.json({ error: 'Schedule must be within the next 24 hours' }, { status: 400 })
      const input: TaskInput = { ...parsed, executeAt: parsed.executeAt ?? new Date(at).toISOString(), requestedAt: new Date(at).toISOString(), requester: 'requester-demo', requestHash }
      const result = await store.createRun({ runId, workflowId: WORKFLOW_ID, workflowVersion: 'v1', input, now: at })
      if (parseInput(result.run.input).requestHash !== requestHash) return Response.json({ error: 'Idempotency conflict' }, { status: 409 })
      return Response.json(await taskView(store, runId), { status: result.kind === 'created' ? 202 : 200 })
    }
    let decision: DecisionRequest
    try { decision = parseDecision(body) } catch { return Response.json({ error: 'Invalid decision' }, { status: 400 }) }
    const view = await taskView(store, id)
    if (!view) return Response.json({ error: 'Not found' }, { status: 404 })
    const record: DecisionRecord = { ...decision, actor: 'approver-demo' }
    const prior = await decisions.get(id)
    if (prior && !sameDecision(prior, record)) return Response.json({ error: 'A different decision already exists' }, { status: 409 })
    if (!view.plan || view.plan.hash !== decision.planHash || (!prior && view.approvalId !== decision.approvalId)) return Response.json({ error: 'Stale approval or plan' }, { status: 409 })
    const delivered = await store.deliverApproval({ runId: id, approval: { approvalId: decision.approvalId, approved: decision.approved, meta: { actor: record.actor, planHash: record.planHash } }, now: now() })
    if (delivered.kind === 'not-found' || delivered.kind === 'not-waiting') {
      if (prior && view.decision?.approved === decision.approved) return Response.json(view)
      return Response.json({ error: 'Task is not awaiting this decision; retry to reconcile acceptance' }, { status: 409 })
    }
    const accepted = await decisions.get(id)
    if (!accepted || !sameDecision(accepted, record)) return Response.json({ error: 'A different decision won the race' }, { status: 409 })
    return Response.json(await taskView(store, id), { status: delivered.kind === 'duplicate' ? 200 : 202 })
  }
}
