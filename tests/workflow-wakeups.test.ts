import type { DynamoDBRecord } from 'aws-lambda'
import { describe, expect, it, vi } from 'vitest'
import { marshall } from '@aws-sdk/util-dynamodb'
import { createWorkflowStreamRouter } from '@ataylorme/tanstack-workflow-aws/wakeups'
import { dispatchKey, itemWakeups, parseWakeup, processWakeup, type DueWakeup, type WakeupIO } from '../src/workflows/wakeups'
import { isSettledLegacyRecord } from '../src/workflows/dispatcher'
const key = { PK: 'RUN#fixture', SK: 'META' }
const wakeup: DueWakeup = { version: 1, kind: 'due', key, dueKind: 'RUNNING', dueAt: 100 }
const item = (extra = {}) => ({ ...key, schemaVersion: 1, duePK: 'RUNNING', dueSK: 100, run: { status: 'running' }, ...extra })
const io = (current: Record<string, unknown> | undefined = item()): WakeupIO => ({ read: vi.fn().mockResolvedValue(current), enqueue: vi.fn().mockResolvedValue(undefined), schedule: vi.fn().mockResolvedValue(undefined) })
const handlers = () => ({ processTarget: vi.fn().mockResolvedValue(undefined), drainEffects: vi.fn().mockResolvedValue(undefined), cleanupItem: vi.fn().mockResolvedValue(undefined) })
describe('rc.1 package-owned targeted wakeups', () => {
  it('recognizes lifecycle obligations without a due-index row', () => {
    const value = item({ duePK: undefined, outboxEnd: 2, outboxCursor: 1, cleanupAt: 300 })
    expect(itemWakeups(value).map(w => w.dueKind)).toEqual(['OUTBOX', 'CLEANUP'])
  })
  it('rejects unknown storage schemas instead of guessing compatibility', () => {
    expect(() => itemWakeups(item({ schemaVersion: 2 }))).toThrow('storage version')
  })
  it('dispatches all same-key obligations durably', async () => {
    const transport = io(item({ outboxEnd: 2, cleanupAt: 300 }))
    await dispatchKey(key, transport, 200)
    expect(transport.enqueue).toHaveBeenCalledTimes(2)
    expect(transport.schedule).toHaveBeenCalledWith(expect.objectContaining({ dueKind: 'CLEANUP' }), 300)
  })
  it('uses direct named claims and persists unresolved successors before ACK', async () => {
    const transport = io(); const work = handlers()
    await processWakeup(wakeup, transport, work, () => 200)
    expect(work.processTarget).toHaveBeenCalledWith({ kind: 'run', runId: 'fixture' })
    expect(transport.schedule).toHaveBeenCalledWith(wakeup, 1200)
    expect(work.drainEffects).not.toHaveBeenCalled()
  })
  it.each(['OUTBOX', 'CLEANUP'] as const)('executes %s independently', async dueKind => {
    const transport = io(item({ outboxEnd: 2, cleanupAt: 100 })); const work = handlers()
    await processWakeup({ ...wakeup, dueKind }, transport, work, () => 200)
    expect(dueKind === 'OUTBOX' ? work.drainEffects : work.cleanupItem).toHaveBeenCalledWith(dueKind === 'OUTBOX' ? 'fixture' : key.PK)
    expect(work.processTarget).not.toHaveBeenCalled()
  })
  it('re-reads current lease instead of trusting stale delivery timestamps', async () => {
    const transport = io(item({ run: { status: 'running', lease: { expiresAt: 900 } } })); const work = handlers()
    await processWakeup(wakeup, transport, work, () => 200)
    expect(transport.schedule).toHaveBeenCalledWith(expect.objectContaining({ dueAt: 900 }), 900)
    expect(work.processTarget).not.toHaveBeenCalled()
  })
  it('does not ACK a failed continuation handoff', async () => {
    const transport = io(); vi.mocked(transport.schedule).mockRejectedValue(new Error('unavailable'))
    await expect(processWakeup(wakeup, transport, handlers(), () => 200)).rejects.toThrow('unavailable')
  })
  it('does not generate obsolete drain work', () => {
    expect(() => parseWakeup({ version: 1, kind: 'drain' })).toThrow()
  })
  it('coalesces changed stream keys and ignores heartbeat-only updates', async () => {
    const transport = io(); const publishApplicationEvent = vi.fn()
    const router = createWorkflowStreamRouter({ transport, publishApplicationEvent })
    const record = (next: object, old?: object) => ({ eventName: 'MODIFY', dynamodb: { SequenceNumber: '1', NewImage: marshall(next), ...(old ? { OldImage: marshall(old) } : {}) } })
    expect(await router({ Records: [record(item()), record(item())] })).toEqual({ batchItemFailures: [] })
    expect(transport.read).toHaveBeenCalledTimes(1)
    vi.mocked(transport.read).mockClear()
    await router({ Records: [record(item({ run: { status: 'running', lease: { owner: 'same', expiresAt: 300 } } }), item({ run: { status: 'running', lease: { owner: 'same', expiresAt: 200 } } }))] })
    expect(transport.read).not.toHaveBeenCalled()
  })
  it('only bypasses settled legacy rows, never active or unknown-version metadata', () => {
    const record = (value: object) => ({ dynamodb: { NewImage: marshall(value) } }) as DynamoDBRecord
    expect(isSettledLegacyRecord(record({ ...key, run: { status: 'finished' } }))).toBe(true)
    expect(isSettledLegacyRecord(record({ ...key, run: { status: 'running' } }))).toBe(false)
    expect(isSettledLegacyRecord(record(item({ schemaVersion: 2, run: { status: 'finished' } })))).toBe(false)
    expect(isSettledLegacyRecord(record({ ...key, run: { status: 'finished' }, cleanupAt: 100 }))).toBe(false)
  })
})
