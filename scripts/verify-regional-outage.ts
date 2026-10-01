import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDynamoWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws'
import { verifyWorkflowPackage } from './workflow-package.ts'
// Helpers own bounded native FIS faults and independent restoration.
import { restoreRegionalResources } from './regional-outage-restore.ts'
import { RegionalOutageFis } from './regional-outage-fis.ts'

if (!process.argv.includes('--execute')) {
  console.log('Offline plan: one isolated region at a time; throttle Lambda origin, pause all four worker mappings, inject MRSC isolation using AWS FIS, prove read failover and explicit same-ID write retry, timer/signal/schedule/ordered delivery, then failback and backlog recovery. Requires region argument, SITE_URL, WORKFLOW_TEST_TOKEN_FILE, AWS_PROFILE, STACK_PREFIX, EXPECTED_AWS_ACCOUNT_ID and --execute. Not a network timeout or actual AWS region shutdown. External watchdog restores mutations after 25 minutes.')
  process.exit(0)
}
const region = process.argv[2]
assert.ok(region === 'us-east-1' || region === 'us-west-2')
const healthy = region === 'us-east-1' ? 'us-west-2' : 'us-east-1'
const prefix = process.env.STACK_PREFIX!
assert.match(prefix ?? '', /^[a-z][a-z0-9-]{0,39}$/)
assert.notEqual(prefix, 'tanstack-ha')
const profile = process.env.AWS_PROFILE!, account = process.env.EXPECTED_AWS_ACCOUNT_ID!
assert.ok(profile); assert.match(account ?? '', /^\d{12}$/)
const site = new URL(process.env.SITE_URL!); assert.equal(site.protocol, 'https:')
const token = readFileSync(process.env.WORKFLOW_TEST_TOKEN_FILE!, 'utf8').trim(); assert.match(token, /^[a-f0-9]{64}$/)
const id = `test-outage-${randomUUID()}`
const tableName = `${prefix}-workflow`
const artifact = verifyWorkflowPackage()
let interrupted = false, restoring = false
const executionDeadline = Date.now() + 23 * 60_000
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { interrupted = true })
function aws(r: string, args: string[]): any {
  if ((interrupted || Date.now() >= executionDeadline) && !restoring) throw new Error('Interrupted; restoration required')
  const output = execFileSync('aws', ['--profile', profile, '--region', r, '--cli-connect-timeout', '3', '--cli-read-timeout', '15', ...args, '--output', 'json'], { encoding: 'utf8', timeout: 25_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' } }).trim()
  return output ? JSON.parse(output) : {}
}
assert.equal(aws(region, ['sts', 'get-caller-identity']).Account, account)
const outputs = (r: string, stack: string) => {
  const s = aws(r, ['cloudformation', 'describe-stacks', '--stack-name', stack]).Stacks[0]
  assert.ok(['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(s.StackStatus))
  return Object.fromEntries(s.Outputs.map((o: any) => [o.OutputKey, o.OutputValue]))
}
const app = outputs(region, `${prefix}-app`), worker = outputs(region, `${prefix}-sweeper`)
const table = aws(region, ['dynamodb', 'describe-table', '--table-name', tableName]).Table
assert.equal(table.MultiRegionConsistency, 'STRONG'); assert.equal(table.TableStatus, 'ACTIVE')
assert.ok(table.Replicas.some((r: any) => r.RegionName === healthy))
assert.ok(table.GlobalTableWitnesses.some((r: any) => r.RegionName === 'us-east-2' && r.WitnessStatus === 'ACTIVE'))
const mappingKeys = ['StreamMappingId', 'QueueMappingId', 'ApplicationMappingId', 'OrderedMappingId']
const mappings = mappingKeys.map(key => {
  const value = aws(region, ['lambda', 'get-event-source-mapping', '--uuid', worker[key]])
  assert.equal(value.State, 'Enabled'); return { uuid: value.UUID, originalState: 'Enabled' as const }
})
const legacyRules = aws(region, ['events', 'list-rules', '--name-prefix', `${prefix}-sweeper`]).Rules
assert.ok(legacyRules.every((rule: any) => rule.State !== 'ENABLED'), 'Legacy polling must not bypass isolation')
const concurrency = aws(region, ['lambda', 'get-function-concurrency', '--function-name', app.FunctionName]).ReservedConcurrentExecutions ?? null
assert.notEqual(concurrency, 0, 'Origin already throttled')
mkdirSync('.deploy/regional-outage', { recursive: true, mode: 0o700 })
const report = resolve(`.deploy/regional-outage/${id}.json`)
const manifest: any = { id, prefix, profile, accountId: account, region, healthy, appFunctionName: app.FunctionName, originalConcurrency: concurrency, mappings, deadline: Date.now() + 25 * 60_000, restored: false, artifact, startedAt: new Date().toISOString(), phase: 'preflight', observations: [], ownedRuns: [], scheduleId: `${id}-schedule` }
const save = () => { writeFileSync(`${report}.leader`, JSON.stringify(manifest, null, 2), { mode: 0o600 }); renameSync(`${report}.leader`, report) }
save() // Durable ownership and original configuration BEFORE any AWS mutation.
const logFd = openSync(`${report}.watchdog.log`, 'a', 0o600)
const watchdog = spawn(process.execPath, ['scripts/regional-outage-restore.ts', '--watchdog', report], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env })
watchdog.unref(); closeSync(logFd)
manifest.watchdogPid = watchdog.pid; save()
for (let i = 0; i < 50 && !existsSync(`${report}.watchdog-ready`); i++) await pause(100)
assert.ok(existsSync(`${report}.watchdog-ready`), 'Watchdog failed to start; no AWS mutation allowed')
assert.equal(Number(readFileSync(`${report}.watchdog-ready`, 'utf8')), watchdog.pid)
process.kill(watchdog.pid!, 0)
let monitor: ReturnType<typeof setInterval> | undefined, monitorBusy = false, monitorFailure: unknown
manifest.fis = {}
const fis = new RegionalOutageFis({ aws, failedRegion: region, healthyRegion: healthy, account, runId: id, tableName, state: manifest.fis, checkpoint: () => { manifest.experimentId = manifest.fis.experimentId; save() } })
async function assertFisRunning() { assert.equal((await fis.get()).state.status, 'running', 'FIS must remain active throughout combined validation') }
async function request(path: string, preferred: string, body?: any, method = body ? 'POST' : 'GET') {
  const start = Date.now()
  const response = await fetch(new URL(path, site), { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ha-region': preferred }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
  const text = await response.text(); let data: any
  try { data = JSON.parse(text) } catch { data = text.slice(0, 300) }
  const result = { status: response.status, served: response.headers.get('x-served-by-region'), elapsedMs: Date.now() - start, data }
  manifest.observations.push({ path, preferred, method, ...result }); save()
  return result
}
async function ok(path: string, body?: any, preferred = healthy) {
  const result = await request(path, preferred, body)
  assert.ok(result.status >= 200 && result.status < 300, `${path}: ${result.status}`)
  assert.equal(result.served, healthy)
  return result.data
}
async function until(label: string, check: () => Promise<any>, ms = 240_000): Promise<any> {
  const deadline = Date.now() + ms
  do {
    if (interrupted || monitorFailure) throw new Error(`Stopped: ${String(monitorFailure ?? 'interrupted')}`)
    const value = await check(); if (value) return value
    await pause(3000)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
let revision = 0
const readKey = { PK: { S: `CHAOS#${id}` }, SK: { S: 'META' } }
const getCanary = (r: string) => aws(r, ['dynamodb', 'get-item', '--table-name', tableName, '--key', JSON.stringify(readKey), '--consistent-read'])
async function health() {
  const response = await fetch(new URL('/healthz', site), { headers: { 'x-ha-region': healthy }, signal: AbortSignal.timeout(20_000) })
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-served-by-region'), healthy); await response.arrayBuffer()
  aws(healthy, ['dynamodb', 'put-item', '--table-name', tableName, '--item', JSON.stringify({ ...readKey, testId: { S: id }, revision: { N: String(++revision) } })])
  assert.equal(getCanary(healthy).Item.revision.N, String(revision))
  manifest.latestCanaryRevision = revision; save()
}
let events: any[], transportReceipts: any[], timerState: any
try {
  await health(); assert.equal(getCanary(region).Item.testId.S, id)
  await fis.prepare()
  monitor = setInterval(() => {
    if (monitorBusy) return
    monitorBusy = true
    void health().then(() => fis.health(true)).catch(async error => { monitorFailure = error; try { await fis.health(false) } catch {} }).finally(() => { monitorBusy = false })
  }, 10_000)
  manifest.phase = 'disrupting'; save()
  for (const mapping of mappings) aws(region, ['lambda', 'update-event-source-mapping', '--uuid', mapping.uuid, '--no-enabled'])
  await until('all failed-region mappings disabled', async () => mappings.every(m => aws(region, ['lambda', 'get-event-source-mapping', '--uuid', m.uuid]).State === 'Disabled'))
  await pause(65_000) // Drain already accepted invocations before creating work.
  aws(region, ['lambda', 'put-function-concurrency', '--function-name', app.FunctionName, '--reserved-concurrent-executions', '0'])
  await until('origin truly unavailable', async () => {
    const response = await fetch(new URL('/readyz', app.FunctionUrl), { signal: AbortSignal.timeout(15_000) }); await response.arrayBuffer(); return response.status === 429
  })
  assert.ok(!monitorFailure && !interrupted, 'Healthy monitor failed before fault start')
  await fis.start()
  await until('FIS replica isolation observed', async () => {
    const state = (await fis.get()).state
    assert.ok(['initiating', 'running'].includes(state.status), `FIS stopped before isolation: ${JSON.stringify(state)}`)
    try { getCanary(region); return false } catch (error) {
      const stderr = (error as any).stderr?.toString() ?? String(error)
      if (!/InternalServerError|InternalFailure|ServiceUnavailable/.test(stderr)) throw error
      manifest.storageFailure = { at: new Date().toISOString(), error: stderr.slice(0, 1500) }; save(); return true
    }
  }, 360_000)
  await health(); await assertFisRunning()
  manifest.phase = 'combined-fault'; save()
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const response = await request('/healthz', region, undefined, method)
    assert.equal(response.status, 200); assert.equal(response.served, healthy)
  }
  const timerId = `${id}-timer`; manifest.ownedRuns.push(timerId); save()
  const command = { action: 'start', workflowId: 'timer-v1', runId: timerId }
  const failedWrite = await request('/api/workflows', region, command)
  assert.equal(failedWrite.status, 429, 'Writes must not be automatically retried by CloudFront')
  await ok('/api/workflows', command) // Exact same ID, explicit healthy-region retry.
  timerState = await until('timer under combined fault', async () => {
    const state = await ok(`/api/workflows?runId=${timerId}`)
    assert.notEqual(state.run.status, 'errored'); return state.run.status === 'finished' && state
  })
  for (const step of ['started', 'firstWake', 'finished']) assert.equal(timerState.run.output[step].region, healthy)
  assert.equal(timerState.events.filter((e: any) => e.eventType === 'SIGNAL_RESOLVED').length, 2)
  const validationId = `${id}-validation`; manifest.ownedRuns.push(validationId); save()
  await ok('/api/workflows', { action: 'start', workflowId: 'validation-v1', runId: validationId })
  await ok('/api/workflows', { action: 'signal', runId: validationId, signalId: `${id}-signal`, message: 'regional chaos' })
  const awaiting = await until('approval available', async () => { const state = await ok(`/api/workflows?runId=${validationId}`); return state.approvalId && state })
  await ok('/api/workflows', { action: 'approve', runId: validationId, approvalId: awaiting.approvalId, approved: true })
  await until('validation completes', async () => {
    const state = await ok(`/api/workflows?runId=${validationId}`)
    if (state.run.status !== 'finished') return false
    for (const step of ['started', 'signaled', 'firstWake', 'finished']) assert.equal(state.run.output[step].region, healthy)
    assert.equal(state.run.output.approved, true); return true
  })
  const published = await ok('/api/application-events/ordered', { runId: id, action: 'publish' }); events = published.detail.events
  const observed = await until('real healthy-region transport receipts', async () => {
    const state = await ok('/api/application-events/ordered', { runId: id, action: 'inspect' })
    return state.transport.receipts.every(Boolean) && state
  })
  transportReceipts = observed.transport.receipts
  assert.deepEqual(transportReceipts.map((r: any) => r.event), events)
  // This registration creates a real future interval deadline, never a synthetic missed tick.
  await ok('/api/workflows', { action: 'schedule', runId: manifest.scheduleId, enabled: true, timing: 'interval', overlap: 'skip', missed: 'run-once' })
  const schedule = await until('real scheduled run starts while isolated', async () => {
    const state = await ok(`/api/workflows?scheduleId=${manifest.scheduleId}`)
    return state.schedule.activeRunId && state.schedule
  }, 360_000)
  manifest.scheduleRunId = schedule.activeRunId; save()
  await until('scheduled run finishes on healthy workers', async () => {
    const item = aws(healthy, ['dynamodb', 'get-item', '--table-name', tableName, '--key', JSON.stringify({ PK: { S: `RUN#${schedule.activeRunId}` }, SK: { S: 'META' } }), '--consistent-read']).Item
    if (item?.run?.M?.status?.S !== 'finished') return false
    for (const key of ['started', 'firstWake', 'finished']) assert.equal(item.run.M.output.M[key].M.region.S, healthy)
    manifest.scheduledRun = item; save()
    return true
  })
  await ok('/api/workflows', { action: 'schedule', runId: manifest.scheduleId, enabled: false, timing: 'interval', overlap: 'skip', missed: 'run-once' })
  await assertFisRunning(); assert.ok(!monitorFailure && !interrupted, 'Healthy monitor failed during combined fault'); manifest.combinedFaultPassed = true; save()
} catch (error) {
  manifest.error = String(error); process.exitCode = 1; save()
} finally {
  if (monitor) clearInterval(monitor)
  while (monitorBusy) await pause(100)
  restoring = true; manifest.phase = 'restoring'; save()
  try { await fis.stop() } catch (error) { manifest.fisStopError = String(error); process.exitCode = 1; save() }
  const restoration = await restoreRegionalResources(manifest, aws)
  manifest.restoration = restoration
  // The helper throws/reports errors rather than treating an attempted restore as success.
  manifest.serviceRestored = restoration.errors.length === 0
  if (!manifest.serviceRestored) process.exitCode = 1
  save()
  try {
    await ok('/api/workflows', { action: 'schedule', runId: manifest.scheduleId, enabled: false, timing: 'interval', overlap: 'skip', missed: 'run-once' })
  } catch (error) { manifest.scheduleCleanupError = String(error); process.exitCode = 1 }
  try {
    const credentials = aws(healthy, ['configure', 'export-credentials', '--format', 'process'])
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: healthy, maxAttempts: 2, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000, throwOnRequestTimeout: true }, credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken } }), { marshallOptions: { removeUndefinedValues: true } })
    const store = createDynamoWorkflowExecutionStore({ tableName, client })
    try {
      for (const runId of [...manifest.ownedRuns, ...(manifest.scheduleRunId ? [manifest.scheduleRunId] : [])]) {
        const deadline = Date.now() + 90_000
        while (true) {
          const run = await store.loadRun(runId)
          if (!run || ['finished', 'errored', 'aborted'].includes(run.status)) break
          if (!run.lease) { await store.deleteRun(runId, 'aborted'); break }
          assert.ok(Date.now() < deadline, 'Owned run lease did not settle')
          await pause(1000)
        }
      }
    } finally { client.destroy() }
  } catch (error) { manifest.runCleanupError = String(error); process.exitCode = 1 }
  try { await fis.cleanup(); manifest.fisCleaned = true } catch (error) { manifest.fisCleanupError = String(error); process.exitCode = 1 }
  manifest.restored = Boolean(manifest.serviceRestored && manifest.fisCleaned)
  manifest.monitorFailure = monitorFailure ? String(monitorFailure) : undefined
  save()
}
if (manifest.combinedFaultPassed && manifest.restored) {
  try {
    assert.ok(!monitorFailure, 'Healthy monitor had failed')
    await until('restored table catches up', async () => { try { return getCanary(region).Item?.revision?.N === String(manifest.latestCanaryRevision) } catch { return false } })
    const recovered = await request('/healthz', region); assert.equal(recovered.status, 200); assert.equal(recovered.served, region)
    const state = await request(`/api/workflows?runId=${id}-timer`, region); assert.deepEqual(state.data, timerState)
    const after = await request('/api/application-events/ordered', region, { runId: id, action: 'inspect' })
    assert.equal(after.status, 200); assert.deepEqual(after.data.transport.receipts, transportReceipts!)
    const postId = `${id}-restored`; manifest.ownedRuns.push(postId); save()
    const started = await request('/api/workflows', region, { action: 'start', workflowId: 'timer-v1', runId: postId }); assert.equal(started.status, 202)
    await until('post-failback workflow', async () => { const state = await request(`/api/workflows?runId=${postId}`, region); return state.data.run?.status === 'finished' })
    for (const r of [region, healthy]) {
      const out = outputs(r, `${prefix}-sweeper`)
      await until(`${r} queues drain`, async () => ['WakeupQueueUrl', 'ApplicationQueueUrl', 'OrderedQueueUrl', 'WakeupDLQUrl', 'SchedulerDLQUrl', 'ApplicationDLQUrl', 'OrderedDLQUrl'].every(key => {
        assert.ok(out[key], `Missing ${key}`)
        const attrs = aws(r, ['sqs', 'get-queue-attributes', '--queue-url', out[key], '--attribute-names', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed']).Attributes
        return Object.values(attrs).every(v => Number(v) === 0)
      }), 300_000)
    }
    await pause(65_000) // Let restored stream readers advance beyond delayed replicated records.
    const afterDrain = await request('/api/application-events/ordered', region, { runId: id, action: 'inspect' })
    assert.deepEqual(afterDrain.data.transport.receipts, transportReceipts!)
    manifest.failbackPassed = true
  } catch (error) { manifest.failbackError = String(error); process.exitCode = 1 }
}
manifest.phase = 'finished'; manifest.passed = Boolean(manifest.combinedFaultPassed && manifest.failbackPassed && !process.exitCode); manifest.finishedAt = new Date().toISOString(); save()
console.log(JSON.stringify({ report, passed: manifest.passed, restored: manifest.restored, error: manifest.error, failbackError: manifest.failbackError }))
