import assert from 'node:assert/strict'
import { verifyWorkflowPackage } from './workflow-package.ts'
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: validate token protection, cross-region workflow signals/approvals, retries, duplicate submissions, and demand-driven timer recovery. Pass HTTPS site and --execute. Uses WORKFLOW_TEST_TOKEN_FILE; creates bounded test runs, never deletes data.')
  process.exit(0)
}
const upstreamPackage = `@ataylorme/tanstack-workflow-aws@${verifyWorkflowPackage().version}`
const site = new URL(process.argv[2] ?? '')
assert.equal(site.protocol, 'https:')
const tokenFile = process.env.WORKFLOW_TEST_TOKEN_FILE
assert.ok(tokenFile, 'Set WORKFLOW_TEST_TOKEN_FILE, not a plaintext token argument')
const token = readFileSync(tokenFile, 'utf8').trim()
assert.match(token, /^[a-f0-9]{64}$/)
type Region = 'us-east-1' | 'us-west-2'
const regions: Region[] = ['us-east-1', 'us-west-2']
const results: { scenario: string; runId?: string; ok: boolean; detail: unknown }[] = []
const attemptedRuns: { scenario: string; runId: string }[] = []
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
async function call(region: Region, command: Record<string, unknown> | string) {
  const response = await fetch(new URL(typeof command === 'string' ? `/api/workflows?runId=${encodeURIComponent(command)}` : '/api/workflows', site), {
    method: typeof command === 'string' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-ha-region': region, 'content-type': 'application/json' },
    ...(typeof command === 'string' ? {} : { body: JSON.stringify(command) }), signal: AbortSignal.timeout(60000),
  })
  const text = await response.text()
  assert.equal(response.status, typeof command === 'string' ? 200 : 202, `${region}: ${text}`)
  assert.equal(response.headers.get('x-served-by-region'), region)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const value: unknown = JSON.parse(text)
  return object(value)
}
function events(view: Record<string, unknown>) {
  assert.ok(Array.isArray(view.events))
  const entries = view.events.map(object)
  entries.forEach((event, index) => assert.equal(event.eventIndex, index, 'Contiguous committed event indices'))
  return entries
}
async function waitFor(region: Region, runId: string, ready: (view: Record<string, unknown>) => boolean) {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const view = await call(region, runId)
    const run = object(view.run)
    assert.notEqual(run.status, 'errored', JSON.stringify(run.error))
    if (ready(view)) return view
    await setTimeout(5000)
  }
  throw new Error(`Timed out waiting for demand-driven wakeups: ${runId}`)
}
const finished = (region: Region, runId: string) => waitFor(region, runId, view => object(view.run).status === 'finished')
const waitingForSignal = (view: Record<string, unknown>) => {
  const waiting = object(view.run).waitingFor
  return !!waiting && object(waiting).signalName === 'continue'
}
async function scenario(name: string, test: () => Promise<unknown>) {
  try { const detail = await test(); results.push({ scenario: name, ok: true, detail }); console.log(`${name}: PASS`) }
  catch (error) { const detail = error instanceof Error ? error.message : String(error); results.push({ scenario: name, ok: false, detail }); console.error(`${name}: FAIL ${detail}`) }
}
await scenario('authentication', async () => {
  const response = await fetch(new URL('/api/workflows', site))
  assert.equal(response.status, 401)
  return 'Public workflow API refuses unauthenticated requests'
})
await Promise.all(regions.map(startRegion => scenario(`cross-region ${startRegion}`, async () => {
  const other = startRegion === 'us-east-1' ? 'us-west-2' : 'us-east-1'
  const runId = `test-${randomUUID()}`
  attemptedRuns.push({ scenario: `cross-region ${startRegion}`, runId })
  await call(startRegion, { action: 'start', workflowId: 'validation-v1', runId })
  const initial = await call(other, runId)
  assert.equal(object(initial.run).workflowId, 'validation-v1')
  await waitFor(other, runId, waitingForSignal)
  await call(other, { action: 'signal', runId, signalId: 'once', message: startRegion })
  const waiting = await waitFor(startRegion, runId, view => typeof view.approvalId === 'string')
  assert.equal(typeof waiting.approvalId, 'string')
  const duplicate = await call(startRegion, { action: 'signal', runId, signalId: 'once', message: startRegion })
  assert.equal(duplicate.kind, 'duplicate')
  await call(startRegion, { action: 'approve', runId, approvalId: waiting.approvalId, approved: true })
  // No manual sweep: Demand-driven workers must execute both durable sleeps.
  const view = await finished(other, runId)
  const output = object(object(view.run).output)
  assert.equal(object(output.started).region, startRegion)
  assert.equal(object(output.signaled).region, other)
  assert.equal(object(output.retry).attempt, 2)
  assert.equal(object(output.signal).message, startRegion)
  assert.equal(output.approved, true)
  assert.ok(regions.includes(object(output.finished).region as Region))
  assert.equal(events(view).filter(event => event.eventType === 'SIGNAL_RESOLVED').length, 3) // explicit signal + two timer signals
  assert.equal(events(view).filter(event => event.eventType === 'APPROVAL_RESOLVED').length, 1)
  const opposite = await call(startRegion, runId)
  assert.deepEqual(opposite.run, view.run)
  assert.deepEqual(opposite.events, view.events)
  return { runId, output, eventCount: events(view).length }
})))
await scenario('concurrent duplicate start/signal and rejection', async () => {
  const runId = `test-${randomUUID()}`
  attemptedRuns.push({ scenario: 'concurrent duplicate start/signal and rejection', runId })
  await Promise.all(regions.map(region => call(region, { action: 'start', workflowId: 'validation-v1', runId })))
  await waitFor('us-east-1', runId, waitingForSignal)
  await Promise.all(regions.map(region => call(region, { action: 'signal', runId, signalId: 'concurrent', message: 'one delivery' })))
  const waiting = await waitFor('us-east-1', runId, view => typeof view.approvalId === 'string')
  assert.equal(typeof waiting.approvalId, 'string')
  await call('us-west-2', { action: 'approve', runId, approvalId: waiting.approvalId, approved: false })
  const view = await finished('us-east-1', runId)
  assert.equal(object(object(view.run).output).approved, false)
  assert.equal(object(object(object(view.run).output).signal).message, 'one delivery')
  assert.equal(events(view).filter(event => event.eventType === 'SIGNAL_RESOLVED').length, 1)
  assert.equal(events(view).filter(event => event.eventType === 'APPROVAL_RESOLVED').length, 1)
  return { runId, eventCount: events(view).length }
})
mkdirSync('.deploy', { recursive: true })
const report = `.deploy/workflow-validation-${Date.now()}.json`
writeFileSync(report, JSON.stringify({ site: site.origin, testedAt: new Date().toISOString(), upstreamPackage, attemptedRuns, results }, null, 2))
console.log(`Evidence: ${report}`)
assert.ok(results.every(result => result.ok), 'Workflow validation failures; inspect the evidence report')
