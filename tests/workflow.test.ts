import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineWorkflowRuntime, inMemoryWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws/runtime'
import { workflows } from '../src/workflows/definitions'
import { authorized, parseCommand, validRunId, workflowApi } from '../src/workflows/api.server'

afterEach(() => vi.unstubAllEnvs())

describe('workflow API boundary', () => {
  it.each([null, {}, { action: 'sweep', runId: 'test-1' }, { action: 'start', runId: 'test-1', workflowId: 'unknown' },
    { action: 'signal', runId: 'test-1', signalId: 'x', message: 'x'.repeat(201) },
    { action: 'approve', runId: 'test-1', approvalId: '', approved: true }])('rejects invalid commands %#', value => {
    expect(() => parseCommand(value)).toThrow()
  })
  it('accepts strictly bounded start, signal and approval inputs', () => {
    for (const command of [
      { action: 'start', runId: 'test-1', workflowId: 'validation-v1' },
      { action: 'signal', runId: 'test-1', signalId: 'once', message: 'hello' },
      { action: 'approve', runId: 'test-1', approvalId: 'approval-1', approved: false },
    ]) expect(parseCommand(command)).toEqual(command)
    expect(validRunId('test-../evil')).toBe(false)
    expect(validRunId('test-' + 'a'.repeat(101))).toBe(false)
  })
  it('fails closed for missing/short/wrong/multibyte tokens', async () => {
    const key = 'a'.repeat(64)
    for (const supplied of ['', 'wrong', 'é'.repeat(64)]) {
      expect(authorized(new Request('https://example.test', { headers: { authorization: `Bearer ${supplied}` } }), key)).toBe(false)
    }
    expect(authorized(new Request('https://example.test'), undefined)).toBe(false)
    expect(authorized(new Request('https://example.test', { headers: { authorization: 'Bearer short' } }), 'short')).toBe(false)
    expect(authorized(new Request('https://example.test', { headers: { authorization: `Bearer ${key}` } }), key)).toBe(true)
    vi.stubEnv('WORKFLOW_TEST_TOKEN', '')
    expect((await workflowApi(new Request('https://example.test/api/workflows'))).status).toBe(401)
  })
})

describe('installed upstream engine with application definitions (not MRSC)', () => {
  function fixture() {
    const store = inMemoryWorkflowExecutionStore()
    return { store, runtime: defineWorkflowRuntime({ store, workflows }) }
  }
  it('retries, waits for a signal, then correctly honors approval rejection', async () => {
    const { store, runtime } = fixture()
    await runtime.startRun({ workflowId: 'validation-v1', runId: 'test-reject', input: {}, leaseOwner: 'east' })
    expect((await store.loadRun('test-reject'))?.status).toBe('paused')
    await runtime.deliverSignal({ runId: 'test-reject', signalId: 'once', name: 'continue', payload: { message: 'hello' }, leaseOwner: 'west' })
    const approvalId = (await store.loadRunState('test-reject'))?.pendingApproval?.approvalId
    expect(approvalId).toBeTruthy()
    if (!approvalId) throw new Error('Missing approval')
    await runtime.deliverApproval({ runId: 'test-reject', approval: { approvalId, approved: false }, leaseOwner: 'east' })
    expect(await store.loadRun('test-reject')).toMatchObject({ status: 'finished', output: { approved: false, retry: { attempt: 2 }, signal: { message: 'hello' } } })
    const events = await store.readEvents({ runId: 'test-reject' })
    expect(events.filter(item => item.event.type === 'SIGNAL_RESOLVED')).toHaveLength(1)
  })
  it('resumes two durable sleeps through successive sweeps', async () => {
    const { store, runtime } = fixture()
    await runtime.startRun({ workflowId: 'timer-v1', runId: 'test-timer', input: {}, leaseOwner: 'east' })
    expect((await store.loadRun('test-timer'))?.status).toBe('paused')
    await runtime.sweep({ now: Date.now() + 2000, leaseOwner: 'west' })
    await runtime.sweep({ now: Date.now() + 4000, leaseOwner: 'east' })
    expect((await store.loadRun('test-timer'))?.status).toBe('finished')
  })
})
