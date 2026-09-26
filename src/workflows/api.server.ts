import { timingSafeEqual } from 'node:crypto'
import { requestOwner, workflowServices } from './runtime.server'

interface BaseCommand { runId: string }
export type WorkflowCommand =
  | (BaseCommand & { action: 'start'; workflowId: 'validation-v1' | 'timer-v1' })
  | (BaseCommand & { action: 'signal'; signalId: string; message: string })
  | (BaseCommand & { action: 'approve'; approvalId: string; approved: boolean })
export function validRunId(value: unknown): value is string {
  return typeof value === 'string' && /^test-[a-zA-Z0-9_-]{1,100}$/.test(value)
}
export function parseCommand(value: unknown): WorkflowCommand {
  if (!value || typeof value !== 'object' || !('runId' in value) || !validRunId(value.runId) || !('action' in value)) throw new Error('Invalid command or test run ID')
  const runId = value.runId
  if (value.action === 'start' && 'workflowId' in value && (value.workflowId === 'validation-v1' || value.workflowId === 'timer-v1')) {
    return { action: 'start', runId, workflowId: value.workflowId }
  }
  if (value.action === 'signal' && 'signalId' in value && typeof value.signalId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.signalId) &&
      'message' in value && typeof value.message === 'string' && value.message.length <= 200) {
    return { action: 'signal', runId, signalId: value.signalId, message: value.message }
  }
  if (value.action === 'approve' && 'approvalId' in value && typeof value.approvalId === 'string' && value.approvalId.length > 0 && value.approvalId.length <= 256 &&
      'approved' in value && typeof value.approved === 'boolean') {
    return { action: 'approve', runId, approvalId: value.approvalId, approved: value.approved }
  }
  throw new Error('Invalid workflow command')
}
export function authorized(request: Request, expected: string | undefined): boolean {
  if (!expected || expected.length < 32) return false
  const actual = Buffer.from(request.headers.get('authorization') ?? '')
  const wanted = Buffer.from(`Bearer ${expected}`)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
export async function workflowApi(request: Request): Promise<Response> {
  if (!authorized(request, process.env.WORKFLOW_TEST_TOKEN)) return Response.json({ error: 'Workflow test token required' }, { status: 401 })
  if (!process.env.TABLE_NAME) return Response.json({ error: 'Workflows not configured' }, { status: 503 })
  const { store, runtime } = workflowServices()
  if (request.method === 'GET') {
    const runId = new URL(request.url).searchParams.get('runId')
    if (!validRunId(runId)) return Response.json({ error: 'Invalid test run ID' }, { status: 400 })
    const run = await store.loadRun(runId)
    if (!run) return Response.json({ error: 'Not found' }, { status: 404 })
    const state = await store.loadRunState(runId)
    return Response.json({ run, approvalId: state?.pendingApproval?.approvalId, events: await store.readEvents({ runId }) })
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
  let command: WorkflowCommand
  try {
    const body = await request.text()
    if (body.length > 2048) return Response.json({ error: 'Payload too large' }, { status: 413 })
    command = parseCommand(JSON.parse(body))
  } catch { return Response.json({ error: 'Invalid workflow command' }, { status: 400 }) }
  const owner = requestOwner()
  const options = { runId: command.runId, leaseOwner: owner, maxDurationMs: 5_000, includeEvents: false }
  const result = await store.withLeaseOwner(owner, () => {
    if (command.action === 'start') return runtime.startRun({ ...options, workflowId: command.workflowId, input: {} })
    if (command.action === 'signal') return runtime.deliverSignal({ ...options, signalId: command.signalId, name: 'continue', payload: { message: command.message } })
    return runtime.deliverApproval({ ...options, approval: { approvalId: command.approvalId, approved: command.approved } })
  })
  return Response.json(result, { status: 202 })
}
