// Lambda's managed Node runtime supplies SDK v3. Deliberately not installed as
// an application dependency. Record the deployed runtime/SDK version in evidence.
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
export function createAwsReader(tableName, endpoints, credentials) {
  const clients = new Map(endpoints.map(region => [region, new DynamoDBClient({
    region, endpoint: `https://dynamodb.${region}.amazonaws.com`, maxAttempts: 1,
    ...(credentials ? { credentials } : {}),
  })]))
  return async (region, shardId, signal) => {
    const client = clients.get(region)
    if (!client) throw new Error('Unconfigured DynamoDB endpoint')
    const response = await client.send(new GetItemCommand({
      TableName: tableName, Key: { shardId: { S: shardId } }, ConsistentRead: true,
    }), { abortSignal: signal })
    if (!response.Item) return null
    return Object.fromEntries(Object.entries(response.Item).map(([key, attribute]) => [key,
      'S' in attribute ? attribute.S : 'N' in attribute ? Number(attribute.N) : undefined]))
  }
}
