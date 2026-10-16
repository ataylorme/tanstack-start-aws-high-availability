import { buildBeginFencing, buildInitialFencing } from './protocol.ts'
import type { OwnershipCommand, OwnershipConfig } from './protocol.ts'

export interface OperatorInput {
  action: 'initialize-fencing' | 'begin-fencing'
  shardId: string
  homeRegion: string
  transitionId: string
}
export function planOperation(input: OperatorInput, observed: unknown, config: OwnershipConfig): OwnershipCommand {
  if (input.shardId !== `v1:${String(config.expectedShard).padStart(2, '0')}`) throw new Error('Shard mismatch')
  if (input.action === 'initialize-fencing') {
    if (observed !== undefined) throw new Error('Initialization requires absent metadata')
    return buildInitialFencing(input, config)
  }
  if (input.action !== 'begin-fencing') throw new Error('Unsupported operation; activation/promotion is unavailable')
  const command = buildBeginFencing(observed, input.transitionId, config)
  if (command.expressionAttributeValues?.[':home'] !== input.homeRegion) throw new Error('Home region mismatch')
  return command
}

export function attributes(value: Record<string, string | number>): Record<string, { S: string } | { N: string }> {
  return Object.fromEntries(Object.entries(value).map(([key, field]) => {
    if (typeof field === 'string') return [key, { S: field }]
    if (!Number.isSafeInteger(field)) throw new Error('Invalid numeric attribute')
    return [key, { N: String(field) }]
  }))
}
export function writeInput(tableName: string, command: OwnershipCommand) {
  if (!/^tanstack-celld-[a-z0-9-]{1,24}-ownership$/.test(tableName)) throw new Error('Expected isolated experiment table')
  return {
    TableName: tableName,
    ...(command.operation === 'put' ? { Item: attributes(command.item!) } : { Key: attributes(command.key), UpdateExpression: command.updateExpression }),
    ConditionExpression: command.conditionExpression,
    ExpressionAttributeNames: command.expressionAttributeNames,
    ...(command.expressionAttributeValues ? { ExpressionAttributeValues: attributes(command.expressionAttributeValues) } : {}),
  }
}

/** Outcome evidence only, not proof that runtime execution/storage is fenced. */
export function matchesFencingOutcome(command: OwnershipCommand, observed: unknown): boolean {
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return false
  const row = observed as Record<string, unknown>
  const expected = command.item ?? {
    shardId: command.key.shardId, status: 'FENCING', routingVersion: 'v1', shardCount: 64,
    homeRegion: command.expressionAttributeValues?.[':home'], activeRegion: command.expressionAttributeValues?.[':region'],
    epoch: command.expressionAttributeValues?.[':nextEpoch'], leaseExpiresAt: command.expressionAttributeValues?.[':now'],
    transitionId: command.expressionAttributeValues?.[':transition'],
  }
  return Object.entries(expected).every(([key, value]) => row[key] === value)
}
