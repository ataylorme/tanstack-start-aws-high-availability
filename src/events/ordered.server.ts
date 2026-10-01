import { createHash } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { createDynamoOrderedEventPublisher, createDynamoOrderedSubscriber, EventSequenceError } from '@ataylorme/tanstack-workflow-aws/ordered-events'
import { authorized, validRunId } from '../workflows/api.server'

export const lifecycleTypes = ['ha.lab.requested', 'ha.lab.approved', 'ha.lab.started', 'ha.lab.completed'] as const
const actions = ['publish', 'retry', 'conflict', 'gap', 'wrong-type', 'deliver', 'duplicate', 'block', 'recover', 'inspect'] as const
type Action = typeof actions[number]
const receiptKey = (subscriberId: string, streamId: string, sequence: number) => ({ PK: `LABRECEIPT#${createHash('sha256').update(JSON.stringify([subscriberId, streamId])).digest('hex')}`, SK: String(sequence) })

/** Only finite, synthetic lab streams and effects. Never an arbitrary operator API. */
export async function orderedApplicationEventsApi(request: Request, injected?: DynamoDBDocumentClient): Promise<Response> {
  if (!authorized(request, process.env.WORKFLOW_TEST_TOKEN)) return Response.json({ error: 'Test token required' }, { status: 401 })
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!process.env.TABLE_NAME) return Response.json({ error: 'Events not configured' }, { status: 503 })
  let runId: string, action: Action
  try {
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0
    if (reader) while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2048) { await reader.cancel(); return Response.json({ error: 'Payload too large' }, { status: 413 }) }; chunks.push(next.value) }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!input || !validRunId(input.runId) || !actions.includes(input.action) || Object.keys(input).some(key => !['runId', 'action'].includes(key))) throw new Error('Invalid command')
    runId = input.runId; action = input.action
  } catch { return Response.json({ error: 'Invalid ordered lab command' }, { status: 400 }) }
  const owned = injected ? undefined : new DynamoDBClient({ maxAttempts: 3, requestHandler: { connectionTimeout: 1000, requestTimeout: 4000, throwOnRequestTimeout: true } })
  const client = injected ?? DynamoDBDocumentClient.from(owned!, { marshallOptions: { removeUndefinedValues: true } })
  const tableName = process.env.TABLE_NAME
  const streamId = `ha-ordered-lab:${runId}`
  const publisher = createDynamoOrderedEventPublisher({ client, tableName, eventTypes: lifecycleTypes, maxEvents: 4 })
  const input = (sequence: number) => ({ type: lifecycleTypes[sequence - 1]!, ordering: { streamId, sequence }, data: { runId, phase: sequence } })
  const blockedId = 'ha-ordered-lab-blocked-v1'
  const normalId = 'ha-ordered-lab-receipts-v1'
  let syntheticFailureClaim: string | undefined
  const recoveryKey = { PK: `LABRECOVERY#${createHash('sha256').update(streamId).digest('hex')}`, SK: 'FAILURE' }
  const subscriber = (subscriberId: string, fail = false) => createDynamoOrderedSubscriber({ client, tableName, subscriberId, maxEventsPerInvocation: 4,
    async handler(event, delivery) {
      // This failure branch has NO effects, before or after throwing. Retrying it is safe
      // even if another HTTP invocation is still unwinding its synchronous exception.
      if (fail && event.ordering.sequence === 2) { syntheticFailureClaim = delivery.claimId; throw new Error('Synthetic no-effect failure') }
      const Item = { ...receiptKey(subscriberId, streamId, event.ordering.sequence), schemaVersion: 1, event, idempotencyKey: delivery.idempotencyKey, subscriberId }
      try { await client.send(new PutCommand({ TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(PK)' })) }
      catch (error) { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error }
    },
  })
  const normal = subscriber(normalId), blocked = subscriber(blockedId)
  try {
    let detail: unknown
    if (action === 'publish') { const events = []; for (let sequence = 1; sequence <= 4; sequence++) events.push(await publisher.publish(input(sequence))); detail = { events } }
    if (action === 'retry') { const original = await publisher.read(streamId, 1); if (!original) return Response.json({ error: 'Publish lifecycle first' }, { status: 409 }); const retried = await publisher.publish(input(1)); detail = { original, retried, identical: JSON.stringify(original) === JSON.stringify(retried) } }
    if (['gap', 'conflict', 'wrong-type'].includes(action)) {
      try {
        if (action === 'gap') await publisher.publish({ ...input(2), ordering: { streamId: `${streamId}:gap`, sequence: 2 } })
        if (action === 'wrong-type') await publisher.publish({ ...input(1), type: lifecycleTypes[3] })
        if (action === 'conflict') { if (!(await publisher.read(streamId, 1))) return Response.json({ error: 'Publish lifecycle first' }, { status: 409 }); await publisher.publish({ ...input(1), data: { runId, phase: 99 } }) }
        return Response.json({ error: 'Expected sequence rejection did not occur' }, { status: 500 })
      } catch (error) { if (!(error instanceof EventSequenceError)) throw error; detail = { rejected: true, reason: error.message } }
    }
    if (['deliver', 'duplicate', 'block', 'recover'].includes(action)) {
      const notification = await publisher.read(streamId, action === 'duplicate' ? 1 : 4)
      if (!notification) return Response.json({ error: 'Publish lifecycle first' }, { status: 409 })
      if (action === 'block') {
        try { await subscriber(blockedId, true).process(notification) } catch { /* inspect proves whether a claim was retained */ }
        if (syntheticFailureClaim) await client.send(new PutCommand({ TableName: tableName, Item: { ...recoveryKey, claimId: syntheticFailureClaim } }))
        const cursor = await blocked.inspect(streamId)
        if (!cursor?.claim || cursor.claim.sequence !== 2) return Response.json({ error: 'Expected synthetic blocked claim at sequence 2' }, { status: 409 })
      } else if (action === 'recover') {
        const cursor = await blocked.inspect(streamId)
        if (cursor?.claim) {
          // Only this dedicated subscriber's known no-effect sequence can be retried.
          const proof = await client.send(new GetCommand({ TableName: tableName, Key: recoveryKey, ConsistentRead: true }))
          const receipt = await client.send(new GetCommand({ TableName: tableName, Key: receiptKey(blockedId, streamId, 2), ConsistentRead: true }))
          if (cursor.claim.sequence !== 2 || receipt.Item || proof.Item?.claimId !== cursor.claim.id) return Response.json({ error: 'Claim requires manual investigation; unsafe to resolve' }, { status: 409 })
          await blocked.resolve({ streamId, claimId: cursor.claim.id, outcome: 'retry' })
        }
        await blocked.process(notification)
      } else {
        // Deliberately tamper notification data: callback must use retained source.
        await normal.process({ ...notification, data: { forged: true } })
      }
    }
    const receipts = async (subscriberId: string) => Promise.all([1, 2, 3, 4].map(async sequence => (await client.send(new GetCommand({ TableName: tableName, Key: receiptKey(subscriberId, streamId, sequence), ConsistentRead: true }))).Item ?? null))
    return Response.json({ streamId, action, detail, normal: { cursor: await normal.inspect(streamId) ?? null, receipts: await receipts(normalId) }, blocked: { cursor: await blocked.inspect(streamId) ?? null, receipts: await receipts(blockedId) }, transport: { receipts: await receipts('ha-ordered-lab-transport-v1'), description: 'Separate real SNS/SQS subscriber receipts; direct invocation is not transport proof' } })
  } catch (error) { return Response.json({ error: 'Ordered lab operation unavailable; retry same run ID', kind: error instanceof Error ? error.name : 'Error' }, { status: 503 }) }
  finally { owned?.destroy() }
}
