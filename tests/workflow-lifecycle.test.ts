import { describe, expect, it, vi } from 'vitest'
import { defineWorkflowRuntime, inMemoryWorkflowExecutionStore, materializeWorkflowSchedules } from '@ataylorme/tanstack-workflow-aws/runtime'
import { nextScheduleTime } from '@ataylorme/tanstack-workflow-aws/schedules'
import { workflows, timer } from '../src/workflows/definitions'
import { parseCommand } from '../src/workflows/api.server'

describe('rc.1 lifecycle fixtures', () => {
  it('commits an immutable publication intent, not a direct external publish', async () => {
    const store = inMemoryWorkflowExecutionStore()
    const runtime = defineWorkflowRuntime({ store, workflows })
    await runtime.startRun({ runId: 'test-outbox', workflowId: 'outbox-v1', input: {}, leaseOwner: 'east' })
    const run = await store.loadRun('test-outbox')
    expect(run).toMatchObject({ status: 'finished', output: { correlationId: 'test-outbox' } })
    const events = await store.readEvents({ runId: 'test-outbox' })
    const committed = events.map(item => item.event).filter(event => event.type === 'STEP_FINISHED')
    expect(committed).toHaveLength(1)
    expect(committed[0]).toMatchObject({ result: { $workflowEffect: 'publish', event: { type: 'ha.validation.event', data: { runId: 'test-outbox' } } } })
    const before = JSON.stringify(events)
    await runtime.startRun({ runId: 'test-outbox', workflowId: 'outbox-v1', input: {}, leaseOwner: 'west' })
    expect(JSON.stringify(await store.readEvents({ runId: 'test-outbox' }))).toBe(before)
  })
  it('commits exactly one successor then terminates with a fresh bounded history', async () => {
    const store = inMemoryWorkflowExecutionStore()
    const runtime = defineWorkflowRuntime({ store, workflows })
    await runtime.startRun({ runId: 'test-chain', workflowId: 'continuation-v1', input: {}, leaseOwner: 'east' })
    const first = await store.loadRun('test-chain')
    const intent = first?.output as { $workflowEffect: string; runId: string; input: unknown }
    expect(intent).toMatchObject({ $workflowEffect: 'continue', input: { generation: 1 } })
    expect(intent.runId).toMatch(/^continuation-[a-f0-9]{64}$/)
    // In-memory engine does not drain AWS effects: execute the committed intent explicitly here.
    await runtime.startRun({ runId: intent.runId, workflowId: 'continuation-v1', input: intent.input, leaseOwner: 'west' })
    expect(await store.loadRun(intent.runId)).toMatchObject({ status: 'finished', output: { generation: 1, completed: true } })
    const events = await store.readEvents({ runId: intent.runId })
    expect(events[0]?.eventIndex).toBe(0)
    expect(events.every(item => item.runId === intent.runId)).toBe(true)
  })
  it('uses enough bounded step history to exceed the configured 64-event budget', async () => {
    const store = inMemoryWorkflowExecutionStore()
    const runtime = defineWorkflowRuntime({ store, workflows })
    await runtime.startRun({ runId: 'test-history-shape', workflowId: 'history-limit-v1', input: {}, leaseOwner: 'east' })
    const events = await store.readEvents({ runId: 'test-history-shape' })
    expect(events.filter(item => item.eventType === 'STEP_FINISHED')).toHaveLength(70)
    expect(events.length).toBeGreaterThan(64)
    expect(events.length).toBeLessThan(100)
  })
  it('materializes fixed future deadlines and bounded policy configuration', async () => {
    const store = inMemoryWorkflowExecutionStore()
    const upsert = vi.spyOn(store, 'upsertSchedule')
    const now = Date.parse('2026-10-01T12:00:01Z')
    const runtime = defineWorkflowRuntime({ store, workflows: { 'timer-v1': { load: async () => timer, schedules: [{
      id: 'test-schedule', schedule: { kind: 'interval', everyMs: 300_000 }, overlapPolicy: 'allow', missedTickPolicy: 'catch-up', maxCatchUp: 2, input: {},
    }] } } })
    expect(await materializeWorkflowSchedules(runtime, { now })).toEqual([{ workflowId: 'timer-v1', scheduleId: 'test-schedule', fireAt: now + 299_000, kind: 'materialized' }])
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ nextFireAt: now + 299_000, maxCatchUp: 2, missedTickPolicy: 'catch-up', overlapPolicy: 'allow' }))
    expect(nextScheduleTime({ kind: 'cron', expression: '*/5 * * * *', timezone: 'America/Los_Angeles' }, now)).toBe(now + 299_000)
  })
  it.each(['skip', 'run-once', 'catch-up'])('validates schedule policy %s and disabled updates', missed => {
    for (const enabled of [true, false]) expect(parseCommand({ action: 'schedule', runId: 'test-schedule', enabled, timing: 'interval', overlap: 'skip', missed })).toMatchObject({ enabled, missed })
  })
  it.each([
    { timing: 'arbitrary' }, { overlap: 'terminate-previous' }, { missed: 'unbounded' }, { enabled: 'true' },
  ])('rejects unsafe schedule options %o', patch => {
    expect(() => parseCommand({ action: 'schedule', runId: 'test-schedule', enabled: true, timing: 'cron', overlap: 'allow', missed: 'run-once', ...patch })).toThrow()
  })
  it.each(['outbox-v1', 'continuation-v1', 'history-limit-v1'])('allows only registered lifecycle workflow %s', workflowId => {
    expect(parseCommand({ action: 'start', runId: 'test-feature', workflowId })).toMatchObject({ workflowId })
  })
})

describe('live verification safety contract', () => {
  it('keeps live execution opt-in, schedules reversible and retention isolated', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('scripts/verify-workflow-lifecycle.ts', 'utf8')
    expect(source).toContain("process.argv.includes('--execute')")
    expect(source).toContain('finally {')
    expect(source).toContain('enabled: false')
    expect(source).toContain('terminalRetentionMs: 1000')
    expect(source).toContain('duplicateRejected: true')
    expect(source).not.toContain('UpdateTimeToLive')
    expect(source).toContain('WORKFLOW_TEST_TOKEN_FILE')
    expect(source).toContain('EXPECTED_AWS_ACCOUNT_ID')
    expect(source).toContain('verifyWorkflowPackage()')
    expect(source).toContain('AbortSignal.timeout(60_000)')
    expect(source).toContain('mode: 0o600')
    expect(source).toContain('self-advancing schedule bucket')
    expect(source).toContain('scheduled timer run finishes')
    expect(source).toContain('reseededWhileWaiting: false')
    expect(source.indexOf('assert.equal(identity.Account')).toBeLessThan(source.indexOf('for (const workflowId'))
  })
})
