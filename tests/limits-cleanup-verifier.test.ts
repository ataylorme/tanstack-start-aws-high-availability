import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertCompactRunTombstone, payloadBoundaryEvent, validateLimitsEnvironment } from '../scripts/verify-limits-cleanup'

const valid = { AWS_PROFILE: 'test-profile', EXPECTED_AWS_ACCOUNT_ID: '123456789012', STACK_PREFIX: 'isolated-rc1' }
describe('limits and automatic cleanup verifier safety', () => {
  it('defaults to a genuinely offline plan without credentials', () => {
    const output = execFileSync(process.execPath, ['scripts/verify-limits-cleanup.ts'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } })
    expect(output).toContain('Offline plan:')
  })
  it.each(['AWS_PROFILE', 'EXPECTED_AWS_ACCOUNT_ID', 'STACK_PREFIX'])('requires explicit %s before AWS access', field => {
    expect(() => validateLimitsEnvironment({ ...valid, [field]: '' })).toThrow()
  })
  it.each([{ STACK_PREFIX: 'tanstack-ha' }, { STACK_PREFIX: '../prod' }, { TABLE_NAME: 'different-workflow' }, { EXPECTED_AWS_ACCOUNT_ID: 'unknown' }])('rejects unsafe overrides %o', patch => {
    expect(() => validateLimitsEnvironment({ ...valid, ...patch })).toThrow()
  })
  it('derives the sole allowed table from explicit isolated stack', () => {
    expect(validateLimitsEnvironment(valid)).toEqual({ profile: 'test-profile', account: '123456789012', tableName: 'isolated-rc1-workflow' })
  })
  it('requires compact tombstones and rejects retained workflow payload', () => {
    const tombstone = { PK: 'RUN#test', SK: 'META', schemaVersion: 1, version: 2, deleted: true, purgedAt: 100, cleanupAt: 200,
      run: { runId: 'test', workflowId: 'continuation-v1', status: 'finished' } }
    expect(() => assertCompactRunTombstone(tombstone, 'test')).not.toThrow()
    for (const retained of [{ input: {} }, { output: {} }, { history: [] }]) {
      expect(() => assertCompactRunTombstone({ ...tombstone, run: { ...tombstone.run, ...retained } }, 'test')).toThrow()
      expect(() => assertCompactRunTombstone({ ...tombstone, ...retained }, 'test')).toThrow()
    }
  })
  it('creates an exact UTF-8 application payload boundary', () => {
    const event = payloadBoundaryEvent('test-boundary')
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(240 * 1024)
    expect(Buffer.byteLength(JSON.stringify({ ...event, data: `${event.data}x` }))).toBe(240 * 1024 + 1)
  })
  it('observes deployed cleanup rather than invoking cleanup directly', () => {
    const source = readFileSync('scripts/verify-limits-cleanup.ts', 'utf8')
    expect(source).not.toContain('.cleanupItem(')
    expect(source).not.toContain('update-event-source-mapping')
    expect(source).not.toContain('DeleteCommand')
    expect(source).toContain("mode: 0o600")
    expect(source.indexOf('checkpoint() // Durable')).toBeLessThan(source.indexOf('await store.createRun('))
    expect(source).toContain('Date.now() + 86_400_000')
    expect(source).toContain('attribute_exists(purgedAt)')
    expect(source).toContain('originalCleanupAt: tombstone!.cleanupAt')
    expect(source).toContain('assert.deepEqual(await subscriber.inspect(streamId), cursor)')
  })
})

// Small conditional-write memory transport: these tests execute the installed package,
// not a replacement publisher/subscriber or preselected mock return sequence.
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { createDynamoOrderedEventPublisher, createDynamoOrderedSubscriber } from '@ataylorme/tanstack-workflow-aws/ordered-events'
import { createDynamoWorkflowExecutionStore, WorkflowLimitError } from '@ataylorme/tanstack-workflow-aws'
import { processWakeup } from '@ataylorme/tanstack-workflow-aws/wakeups'
function memoryTransport() {
  const items = new Map<string, Record<string, any>>()
  const key = (item: Record<string, any>) => `${item.PK}|${item.SK}`
  const client = { async send(command: GetCommand | PutCommand | DeleteCommand) {
    if (command instanceof GetCommand) return { Item: structuredClone(items.get(key(command.input.Key!))) }
    if (command instanceof DeleteCommand) { items.delete(key(command.input.Key!)); return {} }
    const item = command.input.Item!
    const previous = items.get(key(item))
    if ((command.input.ConditionExpression === 'attribute_not_exists(PK)' && previous) || (command.input.ConditionExpression === '#v = :v' && previous?.version !== command.input.ExpressionAttributeValues?.[':v'])) {
      throw Object.assign(new Error('conditional write failed'), { name: 'ConditionalCheckFailedException' })
    }
    items.set(key(item), JSON.parse(JSON.stringify(item)))
    return {}
  } } as unknown as DynamoDBDocumentClient
  return { client, items }
}

describe('installed-package verifier behavior', () => {
  it('drains only through the notified sequence and ignores an older replay', async () => {
    const { client } = memoryTransport()
    const publisher = createDynamoOrderedEventPublisher({ tableName: 'test', client, maxEvents: 2 })
    const first = await publisher.publish({ type: 'test', data: {}, ordering: { streamId: 'stream', sequence: 1 } })
    const second = await publisher.publish({ type: 'test', data: {}, ordering: { streamId: 'stream', sequence: 2 } })
    const seen: number[] = []
    const subscriber = createDynamoOrderedSubscriber({ tableName: 'test', client, subscriberId: 'test', handler: async event => { seen.push(event.ordering.sequence) } })
    await subscriber.process(first)
    expect((await subscriber.inspect('stream'))?.completed).toBe(1)
    await subscriber.process(second)
    const cursor = await subscriber.inspect('stream')
    expect(cursor?.completed).toBe(2)
    await subscriber.process(first)
    expect(await subscriber.inspect('stream')).toEqual(cursor)
    expect(seen).toEqual([1, 2])
  })
  it('accepts exact 240KiB and rejects one byte more before creating a stream', async () => {
    const { client, items } = memoryTransport()
    const publisher = createDynamoOrderedEventPublisher({ tableName: 'test', client })
    const event = payloadBoundaryEvent('boundary')
    await expect(publisher.publish({ ...event, data: `${event.data}x` })).rejects.toThrow('exceeds 240 KiB')
    expect(items.size).toBe(0)
    await expect(publisher.publish(event)).resolves.toEqual(event)
  })
  it('keeps synthetic queued signal fixtures future-due and enforces dedup budget', async () => {
    const { client, items } = memoryTransport()
    const store = createDynamoWorkflowExecutionStore({ tableName: 'test', client, limits: { maxSignalIds: 2 } })
    const now = Date.now()
    const future = now + 86_400_000
    await store.createRun({ runId: 'test-signals', workflowId: 'continuation-v1', input: {}, now: future })
    for (let i = 1; i <= 3; i++) {
      await store.markRunPaused({ runId: 'test-signals', waitingFor: { signalName: 'bounded', stepId: 'bounded' }, now: future })
      const args = { runId: 'test-signals', delivery: { signalId: `signal-${i}`, name: 'bounded', payload: {} }, now: future }
      if (i === 3) await expect(store.deliverSignal(args)).rejects.toBeInstanceOf(WorkflowLimitError)
      else {
        expect((await store.deliverSignal(args)).kind).toBe('delivered')
        expect((await store.deliverSignal(args)).kind).toBe('duplicate')
        const item = items.get('RUN#test-signals|META')!
        expect(item.dueSK).toBe(future)
        expect(await store.claimStaleRun({ runId: 'test-signals', now, leaseOwner: 'worker', leaseMs: 1000 })).toBeUndefined()
        const called: string[] = []
        await processWakeup({ version: 1, kind: 'due', key: { PK: 'RUN#test-signals', SK: 'META' }, dueKind: 'RUNNING', dueAt: now }, {
          read: async () => item, schedule: async () => { called.push('scheduled') }, enqueue: async () => {},
        }, { processTarget: async () => { called.push('processed') }, drainEffects: async () => {}, cleanupItem: async () => {} }, () => now)
        expect(called).toEqual(['scheduled'])
      }
    }
    expect(items.get('RUN#test-signals|META')?.deliveredIds).toHaveLength(2)
  })
})
