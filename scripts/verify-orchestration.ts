/** Deliberately live, opt-in acceptance against only the isolated POC. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TaskView } from '../src/orchestration/types.ts'
const prefix = 'devops-orchestration-poc'
if (!process.argv.includes('--execute')) { console.log('Plan only: --execute tests only the isolated POC, including briefly pausing/restoring its worker and relay mappings. No AWS calls made.'); process.exit(0) }
if (process.env.AWS_PROFILE !== 'ataylorme' || process.env.EXPECTED_AWS_ACCOUNT_ID !== '963564733329' || process.env.AWS_REGION !== 'us-east-1') throw new Error('Explicit POC profile/account/region required')
function aws(args: string[]) { return execFileSync('aws', ['--profile', 'ataylorme', '--region', 'us-east-1', ...args], { encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' }, maxBuffer: 16 * 1024 * 1024 }).trim() }
if (aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']) !== '963564733329') throw new Error('Wrong account')
const work = resolve('.deploy', prefix)
const credentials = JSON.parse(readFileSync(resolve(work, 'credentials.json'), 'utf8')) as { requester: string; approver: string }
const stack = JSON.parse(aws(['cloudformation', 'describe-stacks', '--stack-name', prefix, '--query', 'Stacks[0]', '--output', 'json'])) as { Outputs: Array<{ OutputKey: string; OutputValue: string }>; Tags?: Array<{ Key: string; Value: string }>; StackStatus: string }
if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus) || !stack.Tags?.some(tag => tag.Key === 'Project' && tag.Value === prefix)) throw new Error('Refusing unowned or unstable stack')
const outputs = stack.Outputs
const resources = JSON.parse(aws(['cloudformation', 'list-stack-resources', '--stack-name', prefix, '--query', 'StackResourceSummaries[].PhysicalResourceId', '--output', 'json'])) as string[]
const mappingIds = new Map<string, string>()
for (const role of ['worker', 'relay']) {
  const items = JSON.parse(aws(['lambda', 'list-event-source-mappings', '--function-name', `${prefix}-${role}`, '--query', 'EventSourceMappings', '--output', 'json'])) as Array<{ UUID: string; State: string }>
  const item = items[0]
  if (items.length !== 1 || !item || item.State !== 'Enabled' || !resources.includes(item.UUID)) throw new Error('Acceptance requires owned, initially enabled mappings')
  mappingIds.set(role, item.UUID)
}
const url = outputs.find(item => item.OutputKey === 'Url')?.OutputValue
if (!url || !/^https:\/\/[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws\/$/.test(url)) throw new Error('Unexpected POC URL')
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), url, source: aws(['lambda', 'get-function', '--function-name', `${prefix}-http`, '--query', 'Code.ResolvedImageUri', '--output', 'text']) }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function call(path: string, token: string, body?: unknown, key?: string): Promise<Response> { return fetch(new URL(path, url), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) }) }
async function json(response: Response): Promise<TaskView> { if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`); return response.json() as Promise<TaskView> }
async function waitTask(id: string, expected: TaskView['status'], max = 240000): Promise<TaskView> {
  const deadline = Date.now() + max
  while (Date.now() < deadline) {
    const task = await json(await call(`/api/tasks/${id}`, credentials.requester))
    if (task.status === expected) return task
    if (['blocked', 'failed', 'rejected'].includes(task.status)) throw new Error(`Task ${id}: ${task.status} ${task.reason}`)
    await sleep(2500)
  }
  throw new Error(`Timed out waiting for ${id} ${expected}`)
}
async function create(desiredConcurrency: number, executeAt?: string) {
  const key = `live-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const body = { desiredConcurrency, ...(executeAt ? { executeAt } : {}) }
  const task = await json(await call('/api/tasks', credentials.requester, body, key))
  const duplicate = await json(await call('/api/tasks', credentials.requester, body, key))
  if (duplicate.id !== task.id) throw new Error('Duplicate admission created another task')
  if ((await call('/api/tasks', credentials.requester, { desiredConcurrency: desiredConcurrency === 5 ? 4 : 5 }, key)).status !== 409) throw new Error('Conflicting idempotency key accepted')
  return task
}
async function decide(task: TaskView, approved = true) {
  if (!task.approvalId || !task.plan) throw new Error('Missing plan')
  const body = { approvalId: task.approvalId, planHash: task.plan.hash, approved }
  if ((await call(`/api/tasks/${task.id}/decision`, credentials.requester, body)).status !== 403) throw new Error('Requester can approve')
  await json(await call(`/api/tasks/${task.id}/decision`, credentials.approver, body))
  await json(await call(`/api/tasks/${task.id}/decision`, credentials.approver, body))
  if ((await call(`/api/tasks/${task.id}/decision`, credentials.approver, { ...body, approved: !approved })).status !== 409) throw new Error('Conflicting decision accepted')
}
function actualCapacity() { return Number(aws(['lambda', 'get-function-concurrency', '--function-name', `${prefix}-sandbox`, '--query', 'ReservedConcurrentExecutions', '--output', 'text'])) }
async function mapping(role: 'worker' | 'relay', enabled: boolean) {
  const id = mappingIds.get(role)
  if (!id) throw new Error('Missing validated mapping')
  aws(['lambda', 'update-event-source-mapping', '--uuid', id, enabled ? '--enabled' : '--no-enabled'])
  // Disabled is a control-plane state, not an invocation/poller drain barrier.
  // Allow the 120-second worker budget plus a long-poll margin before admission.
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) { const state = aws(['lambda', 'get-event-source-mapping', '--uuid', id, '--query', 'State', '--output', 'text']); if (state === (enabled ? 'Enabled' : 'Disabled')) { if (!enabled) await sleep(150000); return } await sleep(1500) }
  throw new Error('Mapping transition timeout')
}
try {
  if ((await call('/api/tasks', 'wrong')).status !== 401 || (await call('/internal/events', credentials.requester, {})).status !== 404 || (await call('/api/workflows', credentials.requester)).status !== 404) throw new Error('Public boundary check failed')
  evidence.publicBoundary = 'passed'
  let task = await waitTask((await create(2)).id, 'awaiting_approval'); await decide(task); task = await waitTask(task.id, 'succeeded')
  if (actualCapacity() !== 2) throw new Error('Immediate capacity mismatch')
  evidence.immediate = task
  let rejected = await waitTask((await create(3)).id, 'awaiting_approval'); await decide(rejected, false); rejected = await waitTask(rejected.id, 'rejected')
  if (actualCapacity() !== 2) throw new Error('Rejected task changed capacity')
  evidence.rejection = rejected
  const at = new Date(Date.now() + 90000).toISOString()
  let scheduled = await waitTask((await create(3, at)).id, 'awaiting_approval'); await decide(scheduled); await waitTask(scheduled.id, 'scheduled')
  if (Date.now() < Date.parse(at) && actualCapacity() !== 2) throw new Error('Executed early')
  scheduled = await waitTask(scheduled.id, 'succeeded')
  if (actualCapacity() !== 3 || Date.parse(scheduled.receipt?.completedAt ?? '') < Date.parse(at)) throw new Error('Scheduled result mismatch')
  evidence.scheduled = scheduled
  let recovery: TaskView
  try { await mapping('worker', false); recovery = await create(4); await sleep(3000); const paused = await json(await call(`/api/tasks/${recovery.id}`, credentials.requester)); evidence.workerPaused = paused; if (paused.status !== 'queued') throw new Error('Worker pause ineffective') }
  finally { await mapping('worker', true) }
  recovery = await waitTask(recovery!.id, 'awaiting_approval'); await decide(recovery); recovery = await waitTask(recovery.id, 'succeeded'); evidence.recovery = recovery
  let delivery: TaskView
  try { await mapping('relay', false); delivery = await waitTask((await create(5)).id, 'awaiting_approval'); await decide(delivery); delivery = await waitTask(delivery.id, 'succeeded'); if (actualCapacity() !== 5) throw new Error('Execution blocked on relay') }
  finally { await mapping('relay', true) }
  evidence.deliveryRecovery = delivery!
  const queueUrl = outputs.find(output => output.OutputKey === 'ObservationQueue')?.OutputValue
  if (!queueUrl || !resources.includes(queueUrl)) throw new Error('Missing owned observation queue output')
  const observedEvents: unknown[] = []
  evidence.observedEvents = observedEvents
  let found = false
  const deadline = Date.now() + 180000
  while (!found && Date.now() < deadline) {
    const response = JSON.parse(aws(['sqs', 'receive-message', '--queue-url', queueUrl, '--max-number-of-messages', '10', '--wait-time-seconds', '10', '--visibility-timeout', '15', '--output', 'json'])) as { Messages?: Array<{ Body: string; ReceiptHandle: string }> }
    for (const message of response.Messages ?? []) {
      const event = JSON.parse(message.Body) as { id?: string; type?: string; data?: { taskId?: string } }
      if (event.data?.taskId === delivery!.id && event.type === 'devops.task.succeeded.v1') { found = true; evidence.observedEvent = event }
      observedEvents.push(event)
      // Only this stack's dedicated observation queue; persist all seen event bodies for evidence.
      aws(['sqs', 'delete-message', '--queue-url', queueUrl, '--receipt-handle', message.ReceiptHandle])
    }
  }
  if (!found || actualCapacity() !== 5) throw new Error('Event did not recover independently')
  evidence.status = 'passed'
} catch (error) { evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error); throw error }
finally { evidence.finishedAt = new Date().toISOString(); writeFileSync(resolve(work, 'acceptance.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(`Evidence saved privately to ${work}/acceptance.json; status=${String(evidence.status)}`) }
