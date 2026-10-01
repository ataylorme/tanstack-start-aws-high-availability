import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { verifyWorkflowPackage } from './workflow-package.ts'

const prefix = process.env.STACK_PREFIX
if (!prefix || prefix === 'tanstack-ha' || !/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) throw new Error('Requires explicit isolated STACK_PREFIX other than tanstack-ha')
if (process.argv.slice(2).some(arg => arg !== '--execute')) throw new Error('Only --execute is supported')
if (!process.argv.includes('--execute')) {
  console.log(`Plan only (no AWS calls made): ${prefix}: pause east dispatcher, drain 65 seconds, checkpoint restoration instructions, temporarily deny only east router sqs:SendMessage to its application FIFO, verify denial, resume stream for a valid event, require native retries and exact S3 archive within five minutes, restore IAM, replay original unchanged archived record, and observe metric/alarm. Finally restore original mapping state and permissions. East application delivery is affected during the bounded drill; west stays online. No queue purges or table/archive deletions. --execute requires AWS_PROFILE and EXPECTED_AWS_ACCOUNT_ID. Run sequentially, not alongside other outage drills.`)
  process.exit(0)
}
if (!process.env.AWS_PROFILE || !/^\d{12}$/.test(process.env.EXPECTED_AWS_ACCOUNT_ID ?? '')) throw new Error('Execution requires AWS_PROFILE and EXPECTED_AWS_ACCOUNT_ID')
const artifact = verifyWorkflowPackage()
const region = 'us-east-1'
const runId = `test-destination-${randomUUID()}`
const policyName = runId
const started = new Date()
const work = mkdtempSync(resolve(tmpdir(), 'destination-recovery-'))
mkdirSync('.deploy/event-results', { recursive: true, mode: 0o700 })
const report = `.deploy/event-results/${runId}.json`
const evidence: Record<string, any> = { runId, startedAt: started.toISOString(), region, localCandidate: artifact,
  limitations: ['East application destination denial only; not archive denial or real regional outage.', 'Alarm state/history checked; no configured notification delivery is asserted.', 'East observation subscription and queue policy are checked; matching downstream envelope is required.'] }
const outcomes: { scenario: string; passed: boolean; detail?: string }[] = []
let interrupted = '', restoring = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { interrupted = signal })
let mappingId = '', roleName = '', originalEnabled = false, mappingTouched = false, policyMayExist = false
function save() { writeFileSync(report, JSON.stringify({ ...evidence, outcomes }, null, 2), { mode: 0o600 }) }
function aws(args: string[]): string {
  if (interrupted && !restoring) throw new Error(`Interrupted by ${interrupted}; restoring resources`)
  return execFileSync('aws', ['--profile', process.env.AWS_PROFILE!, '--region', region, '--cli-connect-timeout', '5', '--cli-read-timeout', '75', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 85_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '2' },
  }).trim()
}
const json = (args: string[]) => JSON.parse(aws([...args, '--output', 'json']))
const pause = (ms = 3_000) => new Promise(resolve => setTimeout(resolve, ms))
async function setMapping(enabled: boolean) {
  aws(['lambda', 'update-event-source-mapping', '--uuid', mappingId, enabled ? '--enabled' : '--no-enabled'])
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    if (json(['lambda', 'get-event-source-mapping', '--uuid', mappingId]).State === (enabled ? 'Enabled' : 'Disabled')) return
    await pause()
  }
  throw new Error(`Mapping did not become ${enabled ? 'Enabled' : 'Disabled'}`)
}
function removePolicy() {
  if (!policyMayExist) return
  // A prior delete can commit despite a client timeout; absence is success,
  // not a reason to leave restoration marked failed or stop restoring mappings.
  const present = json(['iam', 'list-role-policies', '--role-name', roleName]).PolicyNames
  if (present.includes(policyName)) aws(['iam', 'delete-role-policy', '--role-name', roleName, '--policy-name', policyName])
  const remaining = json(['iam', 'list-role-policies', '--role-name', roleName]).PolicyNames
  assert.ok(!remaining.includes(policyName), 'Temporary deny still present')
  policyMayExist = false
}
try {
  assert.equal(aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']), process.env.EXPECTED_AWS_ACCOUNT_ID)
  const tableName = `${prefix}-workflow`
  const table = json(['dynamodb', 'describe-table', '--table-name', tableName]).Table
  assert.equal(table.TableStatus, 'ACTIVE')
  const stack = json(['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-sweeper`]).Stacks[0]
  const outputs = Object.fromEntries(stack.Outputs.map((o: any) => [o.OutputKey, o.OutputValue]))
  for (const key of ['StreamMappingId', 'DispatcherFunctionName', 'ApplicationQueueArn', 'FailureBucketName']) assert.ok(outputs[key], `Missing ${key}`)
  mappingId = outputs.StreamMappingId
  const mapping = json(['lambda', 'get-event-source-mapping', '--uuid', mappingId])
  assert.ok(['Enabled', 'Disabled'].includes(mapping.State), 'Mapping transitioning; retry later')
  originalEnabled = mapping.State === 'Enabled'
  assert.equal(mapping.EventSourceArn, table.LatestStreamArn)
  assert.ok(mapping.MaximumRetryAttempts >= 2 && mapping.MaximumRetryAttempts <= 10)
  assert.equal(mapping.DestinationConfig?.OnFailure?.Destination, `arn:aws:s3:::${outputs.FailureBucketName}`)
  const router = json(['lambda', 'get-function-configuration', '--function-name', outputs.DispatcherFunctionName])
  assert.equal(router.FunctionArn, mapping.FunctionArn)
  assert.equal(router.Handler, 'dispatcher.handler')
  assert.ok(router.Role.startsWith(`arn:aws:iam::${process.env.EXPECTED_AWS_ACCOUNT_ID}:role/`))
  roleName = router.Role.split('/').at(-1)!
  assert.ok(roleName)
  const resources = json(['cloudformation', 'list-stack-resources', '--stack-name', `${prefix}-sweeper`]).StackResourceSummaries
  assert.equal(resources.find((r: any) => r.LogicalResourceId === 'DispatcherRole')?.PhysicalResourceId, roleName)
  assert.ok(outputs.ApplicationQueueArn.startsWith(`arn:aws:sqs:${region}:${process.env.EXPECTED_AWS_ACCOUNT_ID}:`))
  assert.ok(!json(['iam', 'list-role-policies', '--role-name', roleName]).PolicyNames.includes(policyName), 'Policy collision')
  const observer = json(['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-application-events`]).Stacks[0]
  const observationQueueUrl = observer.Outputs.find((o: any) => o.OutputKey === 'QueueUrl')?.OutputValue
  assert.ok(observationQueueUrl)
  assert.ok(outputs.ApplicationTopicArn?.startsWith(`arn:aws:sns:${region}:${process.env.EXPECTED_AWS_ACCOUNT_ID}:`))
  const queueAttributes = json(['sqs', 'get-queue-attributes', '--queue-url', observationQueueUrl, '--attribute-names', 'Policy', 'QueueArn']).Attributes
  const queuePolicy = JSON.parse(queueAttributes.Policy)
  assert.ok(queuePolicy.Statement.some((s: any) => s.Condition?.ArnEquals?.['aws:SourceArn'] === outputs.ApplicationTopicArn))
  const subscriptions = json(['sns', 'list-subscriptions-by-topic', '--topic-arn', outputs.ApplicationTopicArn]).Subscriptions
  assert.ok(subscriptions.some((s: any) => s.Protocol === 'sqs' && s.Endpoint === queueAttributes.QueueArn))
  evidence.observation = { observationQueueUrl, queueAttributes, subscriptions }
  evidence.resources = outputs
  evidence.routerCodeSha256 = router.CodeSha256
  evidence.originalMapping = mapping
  evidence.restoration = { profile: process.env.AWS_PROFILE, roleName, policyName, mappingId, originalEnabled,
    commands: [ ['aws', '--profile', process.env.AWS_PROFILE, 'iam', 'delete-role-policy', '--role-name', roleName, '--policy-name', policyName],
      ['aws', '--profile', process.env.AWS_PROFILE, '--region', region, 'lambda', 'update-event-source-mapping', '--uuid', mappingId, originalEnabled ? '--enabled' : '--no-enabled'] ] }
  save() // Durable recovery instructions BEFORE any live mutation, including disabling the mapping.
  mappingTouched = true
  await setMapping(false)
  await pause(65_000) // Dispatcher timeout is 60 seconds; drain previously accepted invocations.
  policyMayExist = true // A client timeout may still mean IAM accepted the write.
  aws(['iam', 'put-role-policy', '--role-name', roleName, '--policy-name', policyName, '--policy-document', JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 'sqs:SendMessage', Resource: outputs.ApplicationQueueArn }] })])
  function invoke(record: any) {
    const payload = resolve(work, 'payload.json'), response = resolve(work, 'response.json')
    writeFileSync(payload, JSON.stringify({ Records: [record] }), { mode: 0o600 })
    const result = json(['lambda', 'invoke', '--function-name', outputs.DispatcherFunctionName, '--log-type', 'Tail', '--payload', `fileb://${payload}`, response])
    assert.equal(result.StatusCode, 200)
    assert.equal(result.FunctionError, undefined)
    return { response: JSON.parse(readFileSync(response, 'utf8')), logs: Buffer.from(result.LogResult ?? '', 'base64').toString() }
  }
  const event = { id: runId, type: 'ha.validation.destination-recovery', version: 1, timestamp: new Date().toISOString(), data: { runId } }
  const item = { PK: { S: `EVENT#${runId}` }, SK: { S: 'META' }, schemaVersion: { N: '1' }, entityType: { S: 'APPLICATION_EVENT' }, event: { M: {
    id: { S: event.id }, type: { S: event.type }, version: { N: '1' }, timestamp: { S: event.timestamp }, data: { M: { runId: { S: runId } } },
  } } }
  // Distinct probe avoids polluting the real event's FIFO deduplication window before denial propagates.
  const probe = structuredClone(item)
  probe.PK.S += '-probe'
  probe.event.M.id.S += '-probe'
  const probeRecord = { eventID: `${runId}-probe`, eventName: 'INSERT', eventSource: 'aws:dynamodb', awsRegion: region,
    eventSourceARN: table.LatestStreamArn, dynamodb: { Keys: { PK: probe.PK, SK: probe.SK }, NewImage: probe, SequenceNumber: '1', StreamViewType: 'NEW_AND_OLD_IMAGES' } }
  let denial: ReturnType<typeof invoke> | undefined
  const denyDeadline = Date.now() + 300_000
  while (Date.now() < denyDeadline) {
    const result = invoke(probeRecord)
    evidence.lastDenialProbe = result
    save()
    if (result.response.batchItemFailures?.length && /AccessDenied|not authorized|explicit deny/i.test(result.logs)) { denial = result; break }
    await pause()
  }
  assert.ok(denial, 'IAM destination denial not proved; do not publish fixture')
  evidence.denialProbe = denial
  await setMapping(true)
  aws(['dynamodb', 'put-item', '--table-name', tableName, '--item', JSON.stringify(item), '--condition-expression', 'attribute_not_exists(PK)'])
  const untilArchive = Date.now() + 300_000
  const inspected = new Set<string>()
  let archivedRecord: any
  while (!archivedRecord && Date.now() < untilArchive) {
    const objects = json(['s3api', 'list-objects-v2', '--bucket', outputs.FailureBucketName]).Contents ?? []
    for (const object of objects) {
      if (new Date(object.LastModified).getTime() < started.getTime() || inspected.has(object.Key)) continue
      inspected.add(object.Key)
      const file = resolve(work, 'archive.json')
      aws(['s3api', 'get-object', '--bucket', outputs.FailureBucketName, '--key', object.Key, file])
      const archive = JSON.parse(readFileSync(file, 'utf8'))
      const raw = archive.payload ?? archive.requestPayload
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw
      const match = payload?.Records?.find((r: any) => r.dynamodb?.NewImage?.PK?.S === item.PK.S)
      if (!match) continue
      assert.deepEqual(match.dynamodb.NewImage, item)
      assert.equal(match.eventName, 'INSERT')
      assert.ok(match.dynamodb.SequenceNumber)
      assert.ok(archive.requestContext?.approximateInvokeCount >= 2, 'Archive must prove native repeated invocation')
      archivedRecord = match
      evidence.archive = archive
      evidence.archiveKey = object.Key
      break
    }
    if (!archivedRecord) await pause()
  }
  assert.ok(archivedRecord, 'Valid destination-denied event not archived within five minutes')
  outcomes.push({ scenario: 'Valid event native retries exhausted into full unchanged S3 archive', passed: true })
  removePolicy()
  const recoveryUntil = Date.now() + 120_000
  let recovered: ReturnType<typeof invoke> | undefined
  while (Date.now() < recoveryUntil) {
    const result = invoke(archivedRecord) // Exact original archive record: no schema or envelope repair.
    if (result.response.batchItemFailures?.length === 0) { recovered = result; break }
    await pause()
  }
  assert.ok(recovered, 'Exact archived replay did not recover after restoring destination permission')
  evidence.replay = recovered
  outcomes.push({ scenario: 'Exact archived valid record replay succeeds in east after IAM restoration', passed: true })
  const deliveryDeadline = Date.now() + 180_000
  let received = false
  while (!received && Date.now() < deliveryDeadline) {
    const batch = json(['sqs', 'receive-message', '--queue-url', observationQueueUrl, '--max-number-of-messages', '10', '--wait-time-seconds', '5', '--visibility-timeout', '10'])
    for (const message of batch.Messages ?? []) {
      let envelope
      try { envelope = JSON.parse(message.Body) } catch { continue }
      if (envelope?.id !== runId) continue
      assert.deepEqual(envelope, event)
      evidence.deliveredEnvelope = envelope
      aws(['sqs', 'delete-message', '--queue-url', observationQueueUrl, '--receipt-handle', message.ReceiptHandle])
      received = true
    }
  }
  assert.ok(received, 'East observation envelope not delivered after exact archived replay')
  outcomes.push({ scenario: 'Recovered event delivered through east FIFO, SNS and east observation SQS', passed: true })
  const alarmName = resources.find((r: any) => r.LogicalResourceId === 'DispatchFailureAlarm')?.PhysicalResourceId
  assert.ok(alarmName)
  const alarmDeadline = Date.now() + 180_000
  let alarmObserved = false
  while (Date.now() < alarmDeadline) {
    const alarms = json(['cloudwatch', 'describe-alarms', '--alarm-names', alarmName]).MetricAlarms
    const history = json(['cloudwatch', 'describe-alarm-history', '--alarm-name', alarmName, '--history-item-type', 'StateUpdate', '--start-date', started.toISOString()]).AlarmHistoryItems
    evidence.alarm = { alarms, history }
    alarmObserved = alarms.some((a: any) => a.StateValue === 'ALARM' && new Date(a.StateUpdatedTimestamp).getTime() >= started.getTime()) || history.some((h: any) => JSON.parse(h.HistoryData).newState?.stateValue === 'ALARM')
    if (alarmObserved) break
    await pause(10_000)
  }
  assert.ok(alarmObserved, 'DispatchFailure alarm transition not observed within bounded window')
  outcomes.push({ scenario: 'CloudWatch dispatch failure alarm observed (notification delivery not asserted)', passed: true })
} catch (error) {
  outcomes.push({ scenario: 'failure', passed: false, detail: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  restoring = true
  // Independent restoration attempts: a failed IAM restoration must not skip mapping restoration.
  for (const [name, restore] of [ ['temporary IAM deny', async () => removePolicy()], ['original mapping state', async () => { if (mappingTouched) await setMapping(originalEnabled) }] ] as const) {
    try {
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await restore(); lastError = undefined; break } catch (error) { lastError = error; await pause() }
      }
      if (lastError) throw lastError
      outcomes.push({ scenario: `Restore ${name}`, passed: true }) }
    catch (error) { outcomes.push({ scenario: `Restore ${name}`, passed: false, detail: String(error) }); process.exitCode = 1 }
  }
  evidence.finishedAt = new Date().toISOString()
  save()
  rmSync(work, { recursive: true, force: true })
  console.log(JSON.stringify({ report, outcomes }, null, 2))
}
