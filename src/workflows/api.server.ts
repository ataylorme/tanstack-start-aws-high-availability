import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { defineWorkflowRuntime, materializeWorkflowSchedules } from '@ataylorme/tanstack-workflow-aws/runtime'
import { workflows, timer } from './definitions'
import { timingSafeEqual } from 'node:crypto'
import { requestOwner, workflowServices, WORKFLOW_LIMITS } from './runtime.server'

interface BaseCommand { runId: string }
export type WorkflowCommand =
  | (BaseCommand & { action: 'start'; workflowId: keyof typeof workflows })
  | (BaseCommand & { action: 'schedule'; enabled: boolean; timing: 'interval' | 'cron'; overlap: 'skip' | 'allow'; missed: 'skip' | 'run-once' | 'catch-up' })
  | (BaseCommand & { action: 'signal'; signalId: string; message: string })
  | (BaseCommand & { action: 'approve'; approvalId: string; approved: boolean })
export function validRunId(value: unknown): value is string {
  return typeof value === 'string' && /^test-[a-zA-Z0-9_-]{1,100}$/.test(value)
}
export function parseCommand(value: unknown): WorkflowCommand {
  if (!value || typeof value !== 'object' || !('runId' in value) || !validRunId(value.runId) || !('action' in value)) throw new Error('Invalid command or test run ID')
  const runId = value.runId
  if (value.action === 'start' && 'workflowId' in value && typeof value.workflowId === 'string' && Object.hasOwn(workflows, value.workflowId)) {
    return { action: 'start', runId, workflowId: value.workflowId as keyof typeof workflows }
  }
  if (value.action === 'schedule' && 'enabled' in value && typeof value.enabled === 'boolean' &&
      'timing' in value && (value.timing === 'interval' || value.timing === 'cron') &&
      'overlap' in value && (value.overlap === 'skip' || value.overlap === 'allow') &&
      'missed' in value && (value.missed === 'skip' || value.missed === 'run-once' || value.missed === 'catch-up')) {
    return { action: 'schedule', runId, enabled: value.enabled, timing: value.timing, overlap: value.overlap, missed: value.missed }
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
    const query = new URL(request.url).searchParams
    const scheduleId = query.get('scheduleId')
    if (scheduleId !== null) {
      if (!validRunId(scheduleId)) return Response.json({ error: 'Invalid schedule ID' }, { status: 400 })
      const client = new DynamoDBClient({})
      try {
        const { Item } = await DynamoDBDocumentClient.from(client).send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: { PK: `SCHEDULE#${scheduleId}`, SK: 'META' }, ConsistentRead: true }))
        return Response.json(Item ? { schedule: Item } : { error: 'Not found' }, { status: Item ? 200 : 404 })
      } finally { client.destroy() }
    }
    const runId = query.get('runId')
    if (!validRunId(runId) && !(typeof runId === 'string' && /^continuation-[a-f0-9]{64}$/.test(runId))) return Response.json({ error: 'Invalid test run ID' }, { status: 400 })
    const run = await store.loadRun(runId)
    if (!run) return Response.json({ error: 'Not found' }, { status: 404 })
    const state = await store.loadRunState(runId)
    return Response.json({ run, limits: WORKFLOW_LIMITS, approvalId: state?.pendingApproval?.approvalId, events: await store.readEvents({ runId }) })
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
  let command: WorkflowCommand
  try {
    const body = await request.text()
    if (body.length > 2048) return Response.json({ error: 'Payload too large' }, { status: 413 })
    command = parseCommand(JSON.parse(body))
  } catch { return Response.json({ error: 'Invalid workflow command' }, { status: 400 }) }
  if (command.action === 'schedule') {
    // Fixed, slow fixtures prevent arbitrary cron expressions and catch-up floods.
    const schedules = [{ id: command.runId, enabled: command.enabled,
      schedule: command.timing === 'interval' ? { kind: 'interval' as const, everyMs: 300_000 } :
        { kind: 'cron' as const, expression: '*/5 * * * *', timezone: 'America/Los_Angeles' },
      overlapPolicy: command.overlap, missedTickPolicy: command.missed, maxCatchUp: 2,
      input: { lab: true },
    }]
    const configured = defineWorkflowRuntime({ store, workflows: { 'timer-v1': { load: async () => timer, schedules } } })
    return Response.json({ schedules: await materializeWorkflowSchedules(configured), note: 'Re-register identical input for idempotency; change policy to create a generation. Disable after testing.' }, { status: 202 })
  }
  const owner = requestOwner()
  const options = { runId: command.runId, leaseOwner: owner, maxDurationMs: 5_000, includeEvents: false }
  const result = await store.withLeaseOwner(owner, () => {
    if (command.action === 'start') return runtime.startRun({ ...options, workflowId: command.workflowId, input: {} })
    if (command.action === 'signal') return runtime.deliverSignal({ ...options, signalId: command.signalId, name: 'continue', payload: { message: command.message } })
    return runtime.deliverApproval({ ...options, approval: { approvalId: command.approvalId, approved: command.approved } })
  })
  return Response.json(result, { status: 202 })
}
