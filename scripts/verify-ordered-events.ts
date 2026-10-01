import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: authenticated ordered lifecycle, cross-region retry, gap/type/conflict rejection, retained-source catchup and duplicate replay, synthetic blocked recovery, and bounded real SNS/SQS receipt polling. Use <https-site> --execute and WORKFLOW_TEST_TOKEN_FILE. Retains bounded test streams and receipts; no destructive operations.')
  process.exit(0)
}
const site = new URL(process.argv[2] ?? '')
assert.equal(site.protocol, 'https:')
const token = readFileSync(process.env.WORKFLOW_TEST_TOKEN_FILE ?? '', 'utf8').trim()
assert.match(token, /^[a-f0-9]{64}$/)
const runId = `test-ordered-${randomUUID()}`
const evidence: Record<string, unknown> = { runId, startedAt: new Date().toISOString(), site: site.origin }
const outcomes: { action: string; region: string; status: number }[] = []
async function call(action: string, region = 'us-east-1') {
  const response = await fetch(new URL('/api/application-events/ordered', site), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ha-region': region }, body: JSON.stringify({ runId, action }), signal: AbortSignal.timeout(60_000) })
  outcomes.push({ action, region, status: response.status })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(response.headers.get('x-served-by-region'), region)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json()
}
try {
  const unauthorized = await fetch(new URL('/api/application-events/ordered', site), { method: 'POST', body: '{}', signal: AbortSignal.timeout(60_000) })
  assert.equal(unauthorized.status, 401)
  const published = await call('publish')
  const events = published.detail.events
  assert.deepEqual(events.map((event: any) => event.ordering.sequence), [1, 2, 3, 4])
  const retried = await call('retry', 'us-west-2')
  assert.equal(retried.detail.identical, true)
  assert.deepEqual(retried.detail.original, events[0])
  for (const action of ['gap', 'wrong-type', 'conflict']) assert.equal((await call(action, 'us-west-2')).detail.rejected, true)
  const delivered = await call('deliver', 'us-west-2')
  assert.equal(delivered.normal.cursor.completed, 4)
  assert.deepEqual(delivered.normal.receipts.map((receipt: any) => receipt.event), events)
  assert.deepEqual((await call('duplicate')).normal.receipts, delivered.normal.receipts)
  const blocked = await call('block')
  assert.equal(blocked.blocked.cursor.completed, 1)
  assert.equal(blocked.blocked.cursor.claim.sequence, 2)
  assert.deepEqual(blocked.blocked.receipts.slice(1), [null, null, null])
  assert.equal((await call('block', 'us-west-2')).blocked.cursor.claim.id, blocked.blocked.cursor.claim.id)
  const recovered = await call('recover', 'us-west-2')
  assert.equal(recovered.blocked.cursor.completed, 4)
  assert.equal(recovered.blocked.cursor.resolution.outcome, 'retry')
  assert.deepEqual(recovered.blocked.receipts.map((receipt: any) => receipt.event), events)
  const deadline = Date.now() + 180_000
  let observed = await call('inspect')
  while (!observed.transport.receipts.every(Boolean) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    observed = await call('inspect', 'us-west-2')
  }
  assert.ok(observed.transport.receipts.every(Boolean), 'Real SNS/SQS transport receipts did not arrive within bounded polling window')
  assert.deepEqual(observed.transport.receipts.map((receipt: any) => receipt.event), events)
  evidence.finalState = observed; evidence.passed = true
  console.log(`Ordered lab verified: ${runId}; both Regions, synthetic recovery, and real SNS/SQS receipts.`)
} catch (error) {
  evidence.passed = false; evidence.error = error instanceof Error ? error.message : String(error)
  console.error(evidence.error); process.exitCode = 1
} finally {
  const directory = '.deploy/ordered-results'
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(`${directory}/${runId}.json`, JSON.stringify({ ...evidence, outcomes, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
}
