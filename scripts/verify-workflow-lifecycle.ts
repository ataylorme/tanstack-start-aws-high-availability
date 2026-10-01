import { verifyWorkflowPackage } from './workflow-package.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { createDynamoWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws'
import { defineWorkflowRuntime } from '@ataylorme/tanstack-workflow-aws/runtime'
import { workflows } from '../src/workflows/definitions.ts'

if (!process.argv.includes('--execute')) {
  console.log('Dry run: HTTPS site URL, WORKFLOW_TEST_TOKEN_FILE, AWS_PROFILE, STACK_PREFIX, EXPECTED_AWS_ACCOUNT_ID and --execute required. Tests cross-region committed outbox, one continuation, bounded history failure, schedule real tick/completion/self-advancement/idempotency/generation/disable, and isolated short-retention cleanup. Schedules disabled in finally. No global retention changes.')
  process.exit(0)
}
const site = process.argv.slice(2).find(arg => arg.startsWith('https://')) ?? process.env.SITE_URL
const token = process.env.WORKFLOW_TEST_TOKEN_FILE ? readFileSync(process.env.WORKFLOW_TEST_TOKEN_FILE, 'utf8').trim() : undefined
const profile = process.env.AWS_PROFILE
const stackPrefix = process.env.STACK_PREFIX
const tableName = process.env.TABLE_NAME ?? `${stackPrefix}-workflow`
assert.ok(site && new URL(site).protocol === 'https:', 'HTTPS SITE_URL required')
assert.ok(token && token.length >= 32 && profile && tableName, 'Explicit token, profile and table required')
assert.ok(stackPrefix && stackPrefix !== 'tanstack-ha' && /^[a-z][a-z0-9-]{0,39}$/.test(stackPrefix), 'Explicit STACK_PREFIX required')
assert.equal(tableName, `${stackPrefix}-workflow`, 'Table must match stack prefix')
const expectedAccount = process.env.EXPECTED_AWS_ACCOUNT_ID
assert.ok(expectedAccount && /^\d{12}$/.test(expectedAccount), 'Explicit EXPECTED_AWS_ACCOUNT_ID required')
const artifact = verifyWorkflowPackage()
const identity = JSON.parse(execFileSync('aws', ['--profile', profile, 'sts', 'get-caller-identity', '--output', 'json'], { encoding: 'utf8', timeout: 45_000, env: { ...process.env, AWS_PAGER: '' } }))
assert.equal(identity.Account, expectedAccount, 'AWS account mismatch')
const evidence: unknown[] = [{ artifact, account: identity.Account, tableName }]
mkdirSync('.deploy', { recursive: true })
const report = `.deploy/workflow-lifecycle-${Date.now()}.json`
process.on('uncaughtExceptionMonitor', error => {
  writeFileSync(report, JSON.stringify({ status: 'failed', error: String(error), evidence }, null, 2), { mode: 0o600 })
})
async function request(path: string, region: string, body?: unknown) {
  const response = await fetch(new URL(path, site), { signal: AbortSignal.timeout(60_000), method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ha-region': region }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const data = await response.json()
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`)
  assert.equal(response.headers.get('x-served-by-region'), region)
  return data
}
async function waitFor<T>(name: string, check: () => Promise<T | undefined>, duration = 180_000): Promise<T> {
  const deadline = Date.now() + duration
  do { const result = await check(); if (result !== undefined) return result; await setTimeout(2500) } while (Date.now() < deadline)
  throw new Error(`Timed out: ${name}`)
}
const prefix = `test-lifecycle-${randomUUID()}`
for (const workflowId of ['outbox-v1', 'continuation-v1', 'history-limit-v1']) {
  const runId = `${prefix}-${workflowId}`
  await request('/api/workflows', 'us-east-1', { action: 'start', runId, workflowId })
  const state = await waitFor(workflowId, async () => {
    const data = await request(`/api/workflows?runId=${runId}`, 'us-west-2')
    return ['finished', 'errored'].includes(data.run.status) ? data : undefined
  })
  if (workflowId === 'history-limit-v1') {
    assert.equal(state.run.status, 'errored')
    assert.match(JSON.stringify(state.run.error), /history budget|WorkflowLimitError/i)
  } else assert.equal(state.run.status, 'finished')
  if (workflowId === 'outbox-v1') {
    assert.equal(state.run.output.eventId, runId)
    await waitFor('outbox bridge observation', async () => {
      const delivery = await request('/api/application-events/delivery', 'us-west-2', { id: runId })
      return delivery.status === 'observed' ? delivery : undefined
    })
  }
  if (workflowId === 'continuation-v1') {
    const successor = state.run.output.runId
    assert.match(successor, /^continuation-[a-f0-9]{64}$/)
    type ChildState = { run: { status: string; output: { completed: boolean; generation: number } }; events: { eventIndex: number }[] }
    const child: ChildState = await waitFor<ChildState>('continuation successor', async (): Promise<ChildState | undefined> => {
      const response: Response = await fetch(new URL(`/api/workflows?runId=${successor}`, site), { signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${token}`, 'x-ha-region': 'us-west-2' } })
      if (response.status === 404) return undefined
      assert.ok(response.ok)
      const data: ChildState = await response.json()
      return data.run.status === 'finished' ? data : undefined
    })
    assert.equal(child.run.output.completed, true)
    assert.equal(child.run.output.generation, 1)
    assert.equal(child.events[0]?.eventIndex, 0)
    evidence.push({ successor, output: child.run.output })
  }
  evidence.push({ workflowId, runId, state })
}
const credentials = JSON.parse(execFileSync('aws', ['configure', 'export-credentials', '--profile', profile, '--format', 'process'], { encoding: 'utf8', timeout: 45_000 }))
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', maxAttempts: 3, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000, throwOnRequestTimeout: true }, credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken } }), { marshallOptions: { removeUndefinedValues: true } })
const scheduleId = `${prefix}-schedule`
const registration = { action: 'schedule', runId: scheduleId, enabled: true, timing: 'interval', overlap: 'skip', missed: 'run-once' }
try {
  await request('/api/workflows', 'us-east-1', registration)
  const first = (await request(`/api/workflows?scheduleId=${scheduleId}`, 'us-west-2')).schedule
  await request('/api/workflows', 'us-west-2', registration)
  const duplicate = (await request(`/api/workflows?scheduleId=${scheduleId}`, 'us-east-1')).schedule
  assert.equal(first.generation, duplicate.generation)
  assert.equal(first.nextFireAt, duplicate.nextFireAt)
  // Observe a real demand-driven bucket, without another materialization request.
  const tick = await waitFor('self-advancing schedule bucket', async () => {
    const schedule = (await request(`/api/workflows?scheduleId=${scheduleId}`, 'us-west-2')).schedule
    return schedule.activeRunId && schedule.lastStartedAt === first.nextFireAt && schedule.nextFireAt > first.nextFireAt ? schedule : undefined
  }, 360_000)
  assert.equal(tick.generation, first.generation)
  assert.equal(tick.lastBucketId, `${first.generation}:${first.nextFireAt}`)
  assert.equal(tick.activeRunId, `timer-v1:${scheduleId}:${tick.lastBucketId}`)
  const scheduledRun = await waitFor('scheduled timer run finishes', async () => {
    const item = (await client.send(new GetCommand({ TableName: tableName, Key: { PK: `RUN#${tick.activeRunId}`, SK: 'META' }, ConsistentRead: true }))).Item
    assert.notEqual(item?.run?.status, 'errored')
    return item?.run?.status === 'finished' ? item.run : undefined
  }, 180_000)
  evidence.push({ selfAdvancingSchedule: tick, scheduledRun, reseededWhileWaiting: false })
  for (const missed of ['skip', 'catch-up']) {
    await request('/api/workflows', 'us-east-1', { ...registration, timing: 'cron', overlap: 'allow', missed })
  }
  const changed = (await request(`/api/workflows?scheduleId=${scheduleId}`, 'us-west-2')).schedule
  assert.ok(changed.generation > duplicate.generation)
  assert.equal(changed.maxCatchUp, 2)
  evidence.push({ scheduleId, first, duplicate, changed })
} finally {
  await request('/api/workflows', 'us-east-1', { ...registration, enabled: false })
  assert.equal((await request(`/api/workflows?scheduleId=${scheduleId}`, 'us-west-2')).schedule.enabled, false)
}
// Only this unique fixture gets shortened retention. Existing and ordinary API runs retain their normal policy.
const store = createDynamoWorkflowExecutionStore({ tableName, client, limits: { terminalRetentionMs: 1000, tombstoneRetentionMs: 60_000 } })
const runtime = defineWorkflowRuntime({ store, workflows })
const retentionRun = `${prefix}-retention`
await store.withLeaseOwner('retention-verifier', () => runtime.startRun({ runId: retentionRun, workflowId: 'continuation-v1', input: { generation: 1 }, leaseOwner: 'retention-verifier' }))
await setTimeout(1100)
// Exercise retryable bounded cleanup directly; worker-driven deadlines are verified by deployed wakeup tests.
for (let page = 0; page < 10; page++) await store.cleanupItem(`RUN#${retentionRun}`)
const tombstone = (await client.send(new GetCommand({ TableName: tableName, Key: { PK: `RUN#${retentionRun}`, SK: 'META' }, ConsistentRead: true }))).Item
assert.equal(tombstone?.deleted, true)
assert.ok(tombstone?.purgedAt)
assert.equal(tombstone?.state, undefined)
await assert.rejects(store.createRun({ runId: retentionRun, workflowId: 'continuation-v1', input: {}, now: Date.now() }), /Deleted run IDs/)
evidence.push({ retentionRun, tombstone, duplicateRejected: true })
client.destroy()
writeFileSync(report, JSON.stringify({ status: 'passed', evidence }, null, 2), { mode: 0o600 })
console.log(`Lifecycle verification passed: ${report}`)
