import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const prefix = process.env.STACK_PREFIX
if (!prefix || prefix === 'tanstack-ha' || !/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) {
  throw new Error('Recovery validation requires an explicit isolated STACK_PREFIX other than tanstack-ha')
}
if (process.argv.slice(2).some(arg => arg !== '--execute')) throw new Error('Only --execute is supported')
if (!process.argv.includes('--execute')) {
  console.log(`Plan only (no AWS calls made): ${prefix} east-only malformed APPLICATION_EVENT INSERT, good-event SQS delivery, bounded 3-minute S3 failure archive inspection, and private Lambda replay of a corrected archived record with the same ID. This is corrected-malformed-record replay, NOT destination-outage replay. Retains table items and archive objects; deletes only matching SQS messages. --execute creates test data and invokes billable resources.`)
  process.exit(0)
}
const artifact = JSON.parse(readFileSync('vendor/application-events-candidate.json', 'utf8'))
assert.equal(createHash('sha256').update(readFileSync(`vendor/${artifact.tarball}`)).digest('hex'), artifact.sha256)
const region = 'us-east-1'
const tableName = `${prefix}-workflow`
const runId = `test-recovery-${randomUUID()}`
const badId = `${runId}-malformed`
const started = new Date()
const work = mkdtempSync(resolve(tmpdir(), 'event-recovery-'))
const outcomes: { scenario: string; passed: boolean; detail?: string }[] = []
const evidence: Record<string, unknown> = { runId, startedAt: started.toISOString(), region, tableName, localCandidate: artifact,
  limitation: 'Corrected malformed archived record replay; not destination-outage replay. Local candidate metadata alone does not attest deployed code.' }
function aws(args: string[]): string {
  return execFileSync('aws', ['--region', region, '--cli-connect-timeout', '5', '--cli-read-timeout', '30', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000,
    env: { ...process.env, AWS_PAGER: '' }, maxBuffer: 16 * 1024 * 1024,
  }).trim()
}
const json = (args: string[]) => JSON.parse(aws([...args, '--output', 'json']))
const pause = () => new Promise(resolve => setTimeout(resolve, 3_000))
try {
  const table = json(['dynamodb', 'describe-table', '--table-name', tableName]).Table
  assert.equal(table.TableStatus, 'ACTIVE')
  assert.equal(table.MultiRegionConsistency, 'STRONG')
  assert.equal(table.StreamSpecification?.StreamEnabled, true)
  assert.ok(['NEW_IMAGE', 'NEW_AND_OLD_IMAGES'].includes(table.StreamSpecification?.StreamViewType))
  const stack = json(['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-application-events`]).Stacks[0]
  const outputs = Object.fromEntries(stack.Outputs.map((item: { OutputKey: string; OutputValue: string }) => [item.OutputKey, item.OutputValue]))
  for (const key of ['QueueUrl', 'FailureBucketName', 'FunctionArn', 'StreamMappingId']) assert.ok(outputs[key], `Missing ${key}`)
  const mapping = json(['lambda', 'get-event-source-mapping', '--uuid', outputs.StreamMappingId])
  assert.equal(mapping.State, 'Enabled')
  assert.equal(mapping.EventSourceArn, table.LatestStreamArn)
  assert.equal(mapping.FunctionArn, outputs.FunctionArn)
  assert.equal(mapping.BatchSize, 1)
  assert.ok(mapping.MaximumRetryAttempts >= 0 && mapping.MaximumRetryAttempts <= 5, 'Bounded retries required')
  assert.equal(mapping.DestinationConfig?.OnFailure?.Destination, `arn:aws:s3:::${outputs.FailureBucketName}`)
  evidence.resources = outputs
  const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs')
  const { createDynamoApplicationEventPublisher } = await import('@ataylorme/tanstack-workflow-aws/events')
  // The publisher's default SDK client resolves this Region at construction.
  process.env.AWS_REGION = region
  process.env.AWS_DEFAULT_REGION = region
  const sqs = new SQSClient({ region, maxAttempts: 2, requestHandler: { connectionTimeout: 3000, requestTimeout: 15000, throwOnRequestTimeout: true } })
  async function receive(expected: { id: string }) {
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      const batch = await sqs.send(new ReceiveMessageCommand({ QueueUrl: outputs.QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 5, VisibilityTimeout: 10 }))
      for (const message of batch.Messages ?? []) {
        let event
        try { event = JSON.parse(message.Body ?? '') } catch { continue }
        if (event?.id !== expected.id) continue
        assert.deepEqual(event, expected)
        assert.ok(message.ReceiptHandle)
        await sqs.send(new DeleteMessageCommand({ QueueUrl: outputs.QueueUrl, ReceiptHandle: message.ReceiptHandle }))
        return event
      }
    }
    throw new Error(`Timed out waiting for SQS envelope ${expected.id}`)
  }
  try {
    const malformed = { PK: { S: `EVENT#${badId}` }, SK: { S: 'META' }, entityType: { S: 'APPLICATION_EVENT' } }
    aws(['dynamodb', 'put-item', '--table-name', tableName, '--item', JSON.stringify(malformed), '--condition-expression', 'attribute_not_exists(PK)'])
    const good = await createDynamoApplicationEventPublisher({ tableName }).publish({ id: `${runId}-good`, type: 'ha.validation.recovery', data: { message: 'unblocked good record' } })
    evidence.goodEnvelope = await receive(good)
    outcomes.push({ scenario: 'good-event delivery despite malformed stream record', passed: true })
    const deadline = Date.now() + 180_000
    let archivedRecord: any
    let archiveObject: unknown
    const inspected = new Set<string>()
    while (!archivedRecord && Date.now() < deadline) {
      const objects = json(['s3api', 'list-objects-v2', '--bucket', outputs.FailureBucketName]).Contents ?? []
      for (const object of objects) {
        if (new Date(object.LastModified).getTime() < started.getTime() - 2000 || inspected.has(object.Key)) continue
        inspected.add(object.Key)
        const file = resolve(work, 'archive.json')
        aws(['s3api', 'get-object', '--bucket', outputs.FailureBucketName, '--key', object.Key, file])
        const archive = JSON.parse(readFileSync(file, 'utf8'))
        const rawPayload = archive.payload ?? archive.requestPayload
        const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload
        const records = payload?.Records ?? []
        const match = records.find((record: any) => record.dynamodb?.NewImage?.PK?.S === `EVENT#${badId}`)
        if (!match) continue
        assert.equal(match.eventName, 'INSERT')
        assert.deepEqual(match.dynamodb.NewImage, malformed)
        assert.ok(match.eventID)
        assert.ok(match.dynamodb.SequenceNumber)
        archivedRecord = match
        archiveObject = archive
        evidence.archiveKey = object.Key
        break
      }
      if (!archivedRecord) await pause()
    }
    assert.ok(archivedRecord, 'No full malformed record found in S3 archive within three minutes')
    evidence.archive = archiveObject
    outcomes.push({ scenario: 'full original malformed record retained in S3 failure archive', passed: true })
    const corrected = { id: badId, type: 'ha.validation.corrected-replay', version: 1, timestamp: new Date().toISOString(), data: { message: 'manually corrected archived malformed record' } }
    const replay = structuredClone(archivedRecord)
    replay.dynamodb.NewImage.event = { M: {
      id: { S: corrected.id }, type: { S: corrected.type }, version: { N: '1' }, timestamp: { S: corrected.timestamp },
      data: { M: { message: { S: corrected.data.message } } },
    } }
    const payloadFile = resolve(work, 'replay.json')
    const responseFile = resolve(work, 'response.json')
    writeFileSync(payloadFile, JSON.stringify({ Records: [replay] }), { mode: 0o600 })
    const invocation = json(['lambda', 'invoke', '--function-name', outputs.FunctionArn, '--invocation-type', 'RequestResponse', '--payload', `fileb://${payloadFile}`, responseFile])
    assert.equal(invocation.StatusCode, 200)
    assert.equal(invocation.FunctionError, undefined)
    assert.deepEqual(JSON.parse(readFileSync(responseFile, 'utf8')), { batchItemFailures: [] })
    evidence.correctedReplayEnvelope = await receive(corrected)
    outcomes.push({ scenario: 'private Lambda replay of corrected archived record with same ID and full SQS envelope', passed: true })
  } finally { sqs.destroy() }
} catch (error) {
  outcomes.push({ scenario: 'failure', passed: false, detail: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
  mkdirSync('.deploy/event-results', { recursive: true, mode: 0o700 })
  const report = `.deploy/event-results/${runId}.json`
  writeFileSync(report, JSON.stringify({ ...evidence, finishedAt: new Date().toISOString(), outcomes }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ report, outcomes }, null, 2))
}
