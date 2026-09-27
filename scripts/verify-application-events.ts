import assert from 'node:assert/strict'
import { verifyWorkflowPackage } from './workflow-package.ts'
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: authenticated application HTTP publication in both AWS Regions, stable-ID retry/conflict checks, and full-envelope stream-to-SQS delivery. Requires HTTPS site, WORKFLOW_TEST_TOKEN_FILE and EVENT_TEST_QUEUE_URL for a dedicated queue. Retains event items; deletes only matching test messages.')
  process.exit(0)
}
const artifact = verifyWorkflowPackage()
const deployedReleases = new Set<string>()
const site = new URL(process.argv[2] ?? '')
assert.equal(site.protocol, 'https:')
const token = readFileSync(process.env.WORKFLOW_TEST_TOKEN_FILE ?? '', 'utf8').trim()
assert.match(token, /^[a-f0-9]{64}$/)
const queueUrl = process.env.EVENT_TEST_QUEUE_URL
assert.ok(queueUrl, 'Dedicated EVENT_TEST_QUEUE_URL required; publisher-only is not a delivery pass')
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs')
const sqs = new SQSClient({ region: 'us-east-1', maxAttempts: 2, requestHandler: { connectionTimeout: 3000, requestTimeout: 15000, throwOnRequestTimeout: true } })
const runId = `test-${randomUUID()}`
const expected = new Map<string, unknown>()
const outcomes: { scenario: string; passed: boolean; detail?: string }[] = []
async function call(region: string, body: unknown, status = 202) {
  const response = await fetch(new URL('/api/application-events', site), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-ha-region': region, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  })
  assert.equal(response.status, status, await response.clone().text())
  assert.equal(response.headers.get('x-served-by-region'), region)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  if (status === 202) {
    assert.equal(response.headers.get('x-event-candidate'), artifact.commit)
    assert.equal(response.headers.get('x-event-artifact'), artifact.sha256)
    const release = response.headers.get('x-event-release')
    assert.ok(release && release !== 'local', 'Expected a deployed release')
    deployedReleases.add(release)
    assert.equal(deployedReleases.size, 1, 'Both Regions must serve the same release')
  }
  return response.json()
}
try {
  const unauth = await fetch(new URL('/api/application-events', site), { method: 'POST', body: '{}', signal: AbortSignal.timeout(60000) })
  assert.equal(unauth.status, 401)
  await call('us-east-1', { id: 'unsafe', message: 'no' }, 400)
  outcomes.push({ scenario: 'HTTP authorization and validation', passed: true })
  for (const region of ['us-east-1', 'us-west-2']) {
    const body = { id: `${runId}-${region}`, message: region }
    const event = await call(region, body)
    expected.set(body.id, event)
    assert.deepEqual(await call(region === 'us-east-1' ? 'us-west-2' : 'us-east-1', body), event)
    await call(region, { ...body, message: 'conflict' }, 409)
  }
  const concurrent = { id: `${runId}-concurrent`, message: 'same fact' }
  const copies = await Promise.all(['us-east-1', 'us-west-2'].map(region => call(region, concurrent)))
  assert.deepEqual(copies[0], copies[1])
  expected.set(concurrent.id, copies[0])
  outcomes.push({ scenario: 'cross-region HTTP publishing, retries, conflict and concurrent reconciliation', passed: true })
  const received = new Set<string>()
  const deadline = Date.now() + 180000
  while (Date.now() < deadline && received.size < expected.size) {
    const batch = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 5, VisibilityTimeout: 10 }))
    for (const message of batch.Messages ?? []) {
      let event
      try { event = JSON.parse(message.Body ?? '') } catch { continue }
      if (!event || typeof event !== 'object' || !('id' in event) || typeof event.id !== 'string' || !expected.has(event.id)) continue
      const id = event.id
      assert.deepEqual(event, expected.get(id))
      received.add(id)
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }))
    }
  }
  assert.equal(received.size, expected.size, 'Timed out waiting for full envelopes through the real stream mapping')
  outcomes.push({ scenario: 'application-to-stream-to-SQS delivery (three unique envelopes)', passed: true })
} catch (error) {
  outcomes.push({ scenario: 'failure', passed: false, detail: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  sqs.destroy()
  mkdirSync('.deploy/event-results', { recursive: true, mode: 0o700 })
  const report = { runId, testedAt: new Date().toISOString(), candidate: artifact, deployedReleases: [...deployedReleases], applicationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), eventIds: [...expected.keys()], outcomes }
  const path = `.deploy/event-results/${runId}.json`
  writeFileSync(path, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ report: path, outcomes }, null, 2))
}
