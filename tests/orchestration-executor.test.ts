import { beforeEach, describe, expect, it } from 'vitest'
import { LambdaClient, GetFunctionConcurrencyCommand, PutFunctionConcurrencyCommand } from '@aws-sdk/client-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { mockClient } from 'aws-sdk-client-mock'
import { createExecutor } from '../src/orchestration/executor'
import type { CapacityPlan } from '../src/orchestration/types'

const lambda = mockClient(LambdaClient)
const dynamo = mockClient(DynamoDBDocumentClient)
const target = 'poc-sandbox'
const plan: CapacityPlan = { taskId: 'task-1', target, before: 1, after: 3, executeAt: '2026-01-01T00:00:00Z', workflowVersion: 'v1', hash: 'hash-1' }
const rows = new Map<string, Record<string, unknown>>()
const key = (row: Record<string, unknown>) => `${String(row.PK)}|${String(row.SK)}`
let capacity: number | undefined
function executor(approved: CapacityPlan | undefined = plan) {
  return createExecutor({ client: new LambdaClient({}), doc: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: 'ops', target,
    loadApprovedPlan: async () => approved, now: () => Date.parse('2026-01-02T00:00:00Z') })
}
function seedApplying(p = plan) {
  rows.set(`OP#${p.taskId}|RECEIPT`, { PK: `OP#${p.taskId}`, SK: 'RECEIPT', operationId: `${p.taskId}:${p.hash}`, plan: p, status: 'applying' })
  rows.set(`TARGET#${target}|LOCK`, { PK: `TARGET#${target}`, SK: 'LOCK', operationId: `${p.taskId}:${p.hash}` })
}
beforeEach(() => {
  lambda.reset(); dynamo.reset(); rows.clear(); capacity = 1
  lambda.on(GetFunctionConcurrencyCommand).callsFake(async () => ({ ReservedConcurrentExecutions: capacity }))
  lambda.on(PutFunctionConcurrencyCommand).callsFake(async input => { capacity = input.ReservedConcurrentExecutions; return {} })
  dynamo.on(GetCommand).callsFake(async input => ({ Item: rows.get(key(input.Key!)) }))
  dynamo.on(TransactWriteCommand).callsFake(async input => {
    for (const item of input.TransactItems ?? []) {
      const action = item.Put ?? item.Delete ?? item.ConditionCheck
      if (!action) throw new Error('Unexpected transaction action')
      const rowKey = item.Put ? item.Put.Item! : (item.Delete ?? item.ConditionCheck)!.Key!
      const current = rows.get(key(rowKey))
      if (action.ConditionExpression === 'attribute_not_exists(PK)' ? Boolean(current)
        : current?.operationId !== action.ExpressionAttributeValues?.[':id'] || (item.Put && current?.status !== 'applying')) {
        throw new Error('Conditional transaction failed')
      }
    }
    for (const item of input.TransactItems ?? []) {
      if (item.Put) rows.set(key(item.Put.Item!), structuredClone(item.Put.Item!))
      if (item.Delete) rows.delete(key(item.Delete.Key!))
    }
    return {}
  })
})

describe('capacity executor', () => {
  it('persists, applies, verifies, releases the lock and returns duplicate success without AWS effects', async () => {
    const run = executor()
    const first = await run(plan.taskId)
    expect(first.status).toBe('succeeded')
    expect(await run(plan.taskId)).toEqual(first)
    expect(lambda.commandCalls(PutFunctionConcurrencyCommand)).toHaveLength(1)
    expect(lambda.commandCalls(GetFunctionConcurrencyCommand)).toHaveLength(2)
    expect(rows.has(`TARGET#${target}|LOCK`)).toBe(false)
    expect(dynamo.commandCalls(GetCommand).every(call => call.args[0].input.ConsistentRead)).toBe(true)
  })
  it.each([
    { ...plan, target: 'production' }, { ...plan, after: 0 }, { ...plan, after: 6 }, { ...plan, after: 2.5 },
    { ...plan, taskId: 'different' }, { ...plan, executeAt: 'invalid' }, { ...plan, executeAt: '2027-01-01T00:00:00Z' },
  ])('rejects invalid or premature approved plan %#', async approved => {
    expect((await executor(approved)(plan.taskId)).status).toBe('blocked')
    expect(lambda.calls()).toHaveLength(0)
    expect(dynamo.calls()).toHaveLength(0)
  })
  it('rejects an unapproved task', async () => {
    const run = createExecutor({ client: new LambdaClient({}), doc: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: 'ops', target, loadApprovedPlan: async () => undefined })
    expect((await run(plan.taskId)).status).toBe('blocked')
    expect(lambda.calls()).toHaveLength(0)
  })
  it('blocks stale fresh plans without retaining a target lock', async () => {
    capacity = 2
    expect((await executor()(plan.taskId)).status).toBe('blocked')
    expect(lambda.commandCalls(PutFunctionConcurrencyCommand)).toHaveLength(0)
    expect(rows.has(`TARGET#${target}|LOCK`)).toBe(false)
  })
  it('recovers an applied but unacknowledged operation without repeating the mutation', async () => {
    seedApplying(); capacity = 3
    expect((await executor()(plan.taskId)).status).toBe('succeeded')
    expect(lambda.commandCalls(PutFunctionConcurrencyCommand)).toHaveLength(0)
  })
  it('retries an applying operation when the target is still at its before value', async () => {
    seedApplying()
    expect((await executor()(plan.taskId)).status).toBe('succeeded')
    expect(lambda.commandCalls(PutFunctionConcurrencyCommand)).toHaveLength(1)
  })
  it('retains an unresolved lock and blocks other tasks', async () => {
    seedApplying(); capacity = 2
    expect((await executor()(plan.taskId)).status).toBe('blocked')
    const next = { ...plan, taskId: 'task-2', hash: 'hash-2', before: 2 }
    expect((await executor(next)(next.taskId)).status).toBe('blocked')
    expect(rows.has(`TARGET#${target}|LOCK`)).toBe(true)
    expect(lambda.commandCalls(PutFunctionConcurrencyCommand)).toHaveLength(0)
  })
  it('propagates transient errors and recovers a lost mutation acknowledgement', async () => {
    lambda.on(PutFunctionConcurrencyCommand).callsFake(async input => { capacity = input.ReservedConcurrentExecutions; throw new Error('connection lost') })
    const run = executor()
    await expect(run(plan.taskId)).rejects.toThrow('connection lost')
    expect(rows.get(`OP#${plan.taskId}|RECEIPT`)?.status).toBe('applying')
    expect((await run(plan.taskId)).status).toBe('succeeded')
    expect(lambda.commandCalls(PutFunctionConcurrencyCommand)).toHaveLength(1)
  })
  it('does not use a receipt for a different plan', async () => {
    seedApplying()
    expect((await executor({ ...plan, hash: 'changed' })(plan.taskId)).status).toBe('blocked')
    expect(lambda.calls()).toHaveLength(0)
  })
  it('never mutates without lock ownership', async () => {
    seedApplying(); rows.delete(`TARGET#${target}|LOCK`)
    expect((await executor()(plan.taskId)).status).toBe('blocked')
    expect(lambda.calls()).toHaveLength(0)
  })
  it('uses simulator ports with the same durable operation receipt and no Lambda calls', async () => {
    let localCapacity: number | null = 1
    const run = createExecutor({ client: new LambdaClient({}), doc: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: 'ops', target,
      loadApprovedPlan: async () => plan, now: () => Date.parse('2026-01-02T00:00:00Z'),
      capacity: { read: async () => localCapacity, write: async value => { localCapacity = value } } })
    expect((await run(plan.taskId)).status).toBe('succeeded')
    expect(localCapacity).toBe(3)
    expect((await run(plan.taskId)).status).toBe('succeeded')
    expect(lambda.calls()).toHaveLength(0)
    expect(rows.get(`OP#${plan.taskId}|RECEIPT`)?.status).toBe('succeeded')
    expect(rows.has(`TARGET#${target}|LOCK`)).toBe(false)
  })
  it('keeps the lock when verification disagrees', async () => {
    lambda.on(PutFunctionConcurrencyCommand).resolves({})
    expect((await executor()(plan.taskId)).status).toBe('blocked')
    expect(rows.has(`TARGET#${target}|LOCK`)).toBe(true)
  })
})
