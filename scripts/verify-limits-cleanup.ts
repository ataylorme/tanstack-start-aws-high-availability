import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { createDynamoWorkflowExecutionStore, WorkflowLimitError } from '@ataylorme/tanstack-workflow-aws'
import { createDynamoOrderedEventPublisher, createDynamoOrderedSubscriber, EventSequenceError } from '@ataylorme/tanstack-workflow-aws/ordered-events'
import { verifyWorkflowPackage } from './workflow-package.ts'

export function validateLimitsEnvironment(env: NodeJS.ProcessEnv) {
  assert.ok(env.AWS_PROFILE, 'Explicit AWS_PROFILE required')
  assert.match(env.EXPECTED_AWS_ACCOUNT_ID ?? '', /^\d{12}$/, 'Explicit account required')
  assert.match(env.STACK_PREFIX ?? '', /^[a-z][a-z0-9-]{0,39}$/, 'Explicit STACK_PREFIX required')
  assert.notEqual(env.STACK_PREFIX, 'tanstack-ha', 'Use isolated lab stack')
  const tableName = `${env.STACK_PREFIX}-workflow`
  assert.equal(env.TABLE_NAME ?? tableName, tableName)
  return { profile: env.AWS_PROFILE, account: env.EXPECTED_AWS_ACCOUNT_ID, tableName }
}

export function payloadBoundaryEvent(streamId: string) {
  const envelope = { id: `${streamId}-payload`, type: 'lab.limit', version: 1, timestamp: '2026-01-01T00:00:00.000Z', data: '', ordering: { streamId, sequence: 1 } }
  return { ...envelope, data: 'x'.repeat(240 * 1024 - Buffer.byteLength(JSON.stringify(envelope))) }
}

export function assertCompactRunTombstone(tombstone: Record<string, any> | undefined, runId: string) {
  assert.ok(tombstone)
  assert.equal(tombstone.deleted, true)
  assert.equal(typeof tombstone.purgedAt, 'number')
  assert.deepEqual(tombstone.run, { runId, workflowId: 'continuation-v1', status: 'finished' })
  assert.deepEqual(Object.keys(tombstone).sort(), ['PK', 'SK', 'cleanupAt', 'deleted', 'purgedAt', 'run', 'schemaVersion', 'version'].sort())
}

export async function main() {
  if (!process.argv.includes('--execute')) {
    console.log('Offline plan: isolated live item/payload, history-byte, signal receipt and ordered-stream limits; deployed-worker run cleanup and synthetic tombstone expiry. Requires --execute, AWS_PROFILE, EXPECTED_AWS_ACCOUNT_ID, STACK_PREFIX. No mapping changes. Retains ordered source/cursor evidence.')
    return
  }
  const config = validateLimitsEnvironment(process.env)
  const artifact = verifyWorkflowPackage()
  const aws = (...args: string[]) => JSON.parse(execFileSync('aws', ['--profile', config.profile, ...args], { encoding: 'utf8', timeout: 45_000, env: { ...process.env, AWS_PAGER: '' } }))
  assert.equal(aws('sts', 'get-caller-identity', '--output', 'json').Account, config.account)
  const credentials = aws('configure', 'export-credentials', '--format', 'process')
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', maxAttempts: 3, credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken }, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000, throwOnRequestTimeout: true } }), { marshallOptions: { removeUndefinedValues: true } })
  const prefix = `test-limits-${randomUUID()}`
  const directory = '.deploy/limits-cleanup'
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const report = `${directory}/${prefix}.json`
  const evidence: Record<string, unknown> = { config, artifact, prefix, startedAt: new Date().toISOString(), status: 'running', isolation: 'Future timestamp/lease prevents live workers racing synthetic store fixtures; no global policy changes.' }
  const checkpoint = () => writeFileSync(report, JSON.stringify(evidence, null, 2), { mode: 0o600 })
  checkpoint() // Durable private recovery inventory before the first mutation.
  const TableName = config.tableName
  const get = async (PK: string) => (await client.send(new GetCommand({ TableName, Key: { PK, SK: 'META' }, ConsistentRead: true }))).Item
  async function waitFor(name: string, check: () => Promise<boolean>) {
    const deadline = Date.now() + 420_000
    do { if (await check()) return; await setTimeout(2500) } while (Date.now() < deadline)
    throw new Error(`Timed out: ${name}`)
  }
  // Only future-due synthetic records are manually driven; finish them in finally.
  const future = Date.now() + 86_400_000
  const store = createDynamoWorkflowExecutionStore({ tableName: TableName, client, limits: { maxSignalIds: 2, terminalRetentionMs: 1000 } })
  const runIds: string[] = []
  async function create(suffix: string) {
    const runId = `${prefix}-${suffix}`
    runIds.push(runId); evidence.runIds = runIds; checkpoint()
    await store.createRun({ runId, workflowId: 'continuation-v1', input: { generation: 1 }, now: future })
    return runId
  }
  try {
    const historyId = await create('history')
    const event = { type: 'RUN_STARTED' as const, ts: future, runId: historyId }
    const bytes = Buffer.byteLength(JSON.stringify([event]))
    const bounded = createDynamoWorkflowExecutionStore({ tableName: TableName, client, limits: { maxHistoryBytes: bytes } })
    await bounded.appendEvents({ runId: historyId, expectedNextIndex: 0, events: [event] })
    await assert.rejects(bounded.appendEvents({ runId: historyId, expectedNextIndex: 1, events: [event] }), WorkflowLimitError)
    assert.equal((await bounded.readEvents({ runId: historyId })).length, 1)
    evidence.historyBytes = { exactAcceptedBytes: bytes, secondAppendRejected: true, committedEvents: 1 }; checkpoint()

    const itemId = `${prefix}-item`
    // Exact serialized createRun META size, including metadata, not merely input size.
    const input = { payload: 'x'.repeat(1024) }
    const run = { runId: itemId, workflowId: 'continuation-v1', status: 'queued', input, createdAt: future, updatedAt: future }
    const itemBytes = Buffer.byteLength(JSON.stringify({ PK: `RUN#${itemId}`, SK: 'META', version: 0, nextIndex: 0, run, duePK: 'RUNNING', dueSK: future, schemaVersion: 1 }))
    const itemStore = createDynamoWorkflowExecutionStore({ tableName: TableName, client, limits: { maxItemBytes: itemBytes } })
    runIds.push(itemId); checkpoint()
    await assert.rejects(itemStore.createRun({ runId: itemId, workflowId: 'continuation-v1', input: { payload: `${input.payload}x` }, now: future }), WorkflowLimitError)
    assert.equal(await get(`RUN#${itemId}`), undefined)
    await itemStore.createRun({ runId: itemId, workflowId: 'continuation-v1', input, now: future })
    evidence.itemBytes = { exactAcceptedBytes: itemBytes, oneByteOverRejected: true }; checkpoint()

    // Store-level receipt budget fixture, not a complete signal workflow: each pause
    // deliberately replaces pending delivery state; no signal handler is executed.
    const signalId = await create('signals')
    for (let i = 1; i <= 3; i++) {
      await store.markRunPaused({ runId: signalId, waitingFor: { signalName: 'bounded', stepId: 'bounded' }, now: future })
      const args = { runId: signalId, delivery: { signalId: `${prefix}-signal-${i}`, name: 'bounded', payload: {} }, now: future }
      if (i <= 2) {
        assert.equal((await store.deliverSignal(args)).kind, 'delivered')
        assert.equal((await store.deliverSignal(args)).kind, 'duplicate')
      } else await assert.rejects(store.deliverSignal(args), WorkflowLimitError)
    }
    assert.equal((await get(`RUN#${signalId}`))?.deliveredIds.length, 2)
    evidence.signals = { accepted: 2, thirdRejected: true, duplicateDoesNotConsumeBudget: true }; checkpoint()

    const publisher = createDynamoOrderedEventPublisher({ tableName: TableName, client, maxEvents: 2 })
    const streamId = `${prefix}-stream`
    evidence.streamId = streamId; checkpoint()
    const publish = (sequence: number) => publisher.publish({ type: 'lab.limit', data: {}, ordering: { streamId, sequence } })
    const payloadStreamId = `${prefix}-payload`
    evidence.payloadStreamId = payloadStreamId; checkpoint()
    const boundaryEvent = payloadBoundaryEvent(payloadStreamId)
    await assert.rejects(publisher.publish({ ...boundaryEvent, data: `${boundaryEvent.data}x` }), /exceeds 240 KiB/)
    assert.equal(await publisher.read(payloadStreamId, 1), undefined)
    await publisher.publish(boundaryEvent)
    assert.deepEqual(await publisher.read(payloadStreamId, 1), boundaryEvent)
    evidence.applicationPayload = { exactAcceptedBytes: Buffer.byteLength(JSON.stringify(boundaryEvent)), oneByteOverRejected: true }; checkpoint()
    const first = await publish(1)
    const second = await publish(2)
    await assert.rejects(publish(3), EventSequenceError)
    assert.equal(await publisher.read(streamId, 3), undefined)
    const subscriber = createDynamoOrderedSubscriber({ tableName: TableName, client, subscriberId: `${prefix}-subscriber`, handler: async () => {} })
    await subscriber.process(second)
    const cursor = await subscriber.inspect(streamId)
    assert.equal(cursor?.completed, 2)
    await subscriber.process(first)
    assert.deepEqual(await subscriber.inspect(streamId), cursor)
    evidence.ordered = { maxEvents: 2, thirdRejected: true, cursor }; checkpoint()

    // Real worker cleanup of a completed run with actual history segments.
    for (const runId of runIds) await store.markRunFinished({ runId, output: { verifier: prefix }, now: Date.now() })
    await waitFor('worker tombstone (no direct cleanup call)', async () => Boolean((await get(`RUN#${historyId}`))?.purgedAt))
    const tombstone = await get(`RUN#${historyId}`)
    assertCompactRunTombstone(tombstone, historyId)
    const segments = await client.send(new QueryCommand({ TableName, ConsistentRead: true, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :segment)', ExpressionAttributeValues: { ':pk': `RUN#${historyId}`, ':segment': 'SEG#' } }))
    assert.equal(segments.Items?.length ?? 0, 0)
    await assert.rejects(store.createRun({ runId: historyId, workflowId: 'continuation-v1', input: {}, now: Date.now() }), /Deleted run IDs/)
    evidence.workerCleanup = { tombstone, segmentsRemaining: 0, reuseRejected: true }; checkpoint()
    // Synthetic elapsed retry window: conditionally accelerate ONLY this fixture's tombstone.
    evidence.syntheticExpiry = { runId: historyId, originalCleanupAt: tombstone!.cleanupAt, newCleanupAt: Date.now() + 2000, note: 'Tests worker expiry dispatch/deletion, not 30 days elapsed wall time.' }; checkpoint()
    await client.send(new UpdateCommand({ TableName, Key: { PK: `RUN#${historyId}`, SK: 'META' }, UpdateExpression: 'SET cleanupAt = :at, #v = #v + :one', ConditionExpression: '#v = :version AND deleted = :yes AND attribute_exists(purgedAt)', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':at': (evidence.syntheticExpiry as { newCleanupAt: number }).newCleanupAt, ':one': 1, ':version': tombstone!.version, ':yes': true } }))
    await waitFor('worker tombstone expiry', async () => (await get(`RUN#${historyId}`)) === undefined)
    assert.deepEqual(await publisher.read(streamId, 1), first)
    assert.deepEqual(await publisher.read(streamId, 2), second)
    assert.deepEqual(await subscriber.inspect(streamId), cursor)
    evidence.retainedOrderedSourceAndCursor = true
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error); process.exitCode = 1
  } finally {
    // Terminalize only this invocation's surviving fixtures; workers retain ownership of deletion.
    for (const runId of runIds) {
      try { const item = await get(`RUN#${runId}`); if (item && !item.deleted && !['finished', 'errored', 'aborted'].includes(item.run.status)) await store.markRunFinished({ runId, output: { verifier: prefix }, now: Date.now() }) }
      catch (error) { evidence.status = 'failed'; evidence.finalizationError = String(error); process.exitCode = 1 }
    }
    evidence.finishedAt = new Date().toISOString(); checkpoint(); client.destroy()
    console.log(`${evidence.status}: ${report}`)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
