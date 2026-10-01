import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { createDynamoOrderedSubscriber } from '@ataylorme/tanstack-workflow-aws/ordered-events'
import { createHash } from 'node:crypto'
const tableName = process.env.TABLE_NAME
if (!tableName) throw new Error('TABLE_NAME is required')
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 3 }))
const subscriberId = 'ha-ordered-lab-transport-v1'
export const handler = createDynamoOrderedSubscriber({ tableName, client, subscriberId,
  async handler(event, delivery) {
    if (!event.ordering.streamId.startsWith('ha-ordered-lab:')) return
    const PK = `LABRECEIPT#${createHash('sha256').update(JSON.stringify([subscriberId, event.ordering.streamId])).digest('hex')}`
    try { await client.send(new PutCommand({ TableName: tableName, Item: { PK, SK: String(event.ordering.sequence), schemaVersion: 1, event, idempotencyKey: delivery.idempotencyKey, subscriberId }, ConditionExpression: 'attribute_not_exists(PK)' })) }
    catch (error) { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error }
  },
}).handler
