import { describe, expect, it, vi } from 'vitest'
import { defineWorkflowRuntime, inMemoryWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws/runtime'
import { createTaskApi, type DecisionRecord, type DecisionStore } from '../src/orchestration/api'
import { capacityWorkflow } from '../src/orchestration/workflow'
import { WORKFLOW_ID, type TaskView } from '../src/orchestration/types'
import { taskView } from '../src/orchestration/view'
const requester = 'requester'.repeat(8)
const approver = 'approver'.repeat(8)
function fixture() {
  const store = inMemoryWorkflowExecutionStore()
  const records = new Map<string, DecisionRecord>()
  // The vendor memory store has no persistent approval inbox; model the AWS
  // store's atomic inbox acceptance here, without executing the workflow inline.
  const originalDeliver = store.deliverApproval.bind(store)
  store.deliverApproval = async args => {
    const result = await originalDeliver(args)
    if (result.kind === 'delivered') records.set(args.runId, { approvalId: args.approval.approvalId, approved: args.approval.approved, planHash: String(args.approval.meta?.planHash), actor: 'approver-demo' })
    return result
  }
  const decisions: DecisionStore = { get: async id => records.get(id) }
  const now = Date.now()
  const api = createTaskApi({ store, decisions, requesterToken: requester, approverToken: approver, now: () => now })
  const readCapacity = vi.fn(async () => 1)
  const execute = vi.fn(async () => ({ status: 'blocked' as const, reason: 'test executor' }))
  const runtime = defineWorkflowRuntime({ store, workflows: { [WORKFLOW_ID]: { load: async () => capacityWorkflow({ target: 'sandbox', readCapacity, execute }) } } })
  const request = (path = '/api/tasks', body?: unknown, token = requester, method = body === undefined ? 'GET' : 'POST', key = 'request-key') => api(new Request(`http://local${path}`, { method, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const create = async () => (await (await request('/api/tasks', { desiredConcurrency: 3 })).json()) as TaskView
  const waiting = async () => { const task = await create(); await runtime.startRun({ runId: task.id, workflowId: WORKFLOW_ID, input: task.input, leaseOwner: 'worker' }); return (await taskView(store, task.id))! }
  return { store, records, decisions, request, create, waiting, now, readCapacity, execute }
}
describe('task API durable admission and authorization', () => {
  it('creates a queued task without running planning or execution inline', async () => {
    const f = fixture(); const response = await f.request('/api/tasks', { desiredConcurrency: 3 })
    expect(response.status).toBe(202)
    const task = await response.json() as TaskView
    expect(task.status).toBe('queued')
    expect(await f.store.loadRun(task.id)).toMatchObject({ status: 'queued' })
    expect(f.readCapacity).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
    expect((await f.request(`/api/tasks/${task.id}`, undefined, approver)).status).toBe(200)
  })
  it('deduplicates matching requests and rejects conflicting reuse', async () => {
    const f = fixture(); const first = await f.create()
    const retry = await f.request('/api/tasks', { desiredConcurrency: 3 })
    expect(retry.status).toBe(200); expect((await retry.json() as TaskView).id).toBe(first.id)
    expect((await f.request('/api/tasks', { desiredConcurrency: 4 })).status).toBe(409)
    expect(await f.store.listRuns({ limit: 100 })).toHaveLength(1)
  })
  it('fails closed and separates creation from approval authority', async () => {
    const f = fixture()
    expect((await f.request('/api/tasks', undefined, '')).status).toBe(401)
    expect((await f.request('/api/tasks', { desiredConcurrency: 3 }, approver)).status).toBe(403)
    const task = await f.waiting()
    expect((await f.request(`/api/tasks/${task.id}/decision`, { approvalId: task.approvalId, planHash: task.plan!.hash, approved: true })).status).toBe(403)
    expect(f.records.size).toBe(0)
  })
  it.each([{ desiredConcurrency: 0 }, { desiredConcurrency: 6 }, { desiredConcurrency: 1.5 }, { desiredConcurrency: '3' }, { desiredConcurrency: 3, target: 'production' }, { desiredConcurrency: 3, executeAt: '2026-01-01T00:00:00' }])('rejects malformed request %#', async body => {
    expect((await fixture().request('/api/tasks', body)).status).toBe(400)
  })
  it('bounds scheduling and idempotency keys', async () => {
    const f = fixture()
    for (const delta of [-1, 86_400_001]) expect((await f.request('/api/tasks', { desiredConcurrency: 3, executeAt: new Date(f.now + delta).toISOString() })).status).toBe(400)
    expect((await f.request('/api/tasks', { desiredConcurrency: 3 }, requester, 'POST', 'short')).status).toBe(400)
    expect((await f.request('/api/tasks', { desiredConcurrency: 3, executeAt: new Date(f.now + 1000).toISOString() })).status).toBe(202)
  })
  it('accepts only the pending plan and delivers a decision without executing inline', async () => {
    const f = fixture(); const task = await f.waiting()
    const path = `/api/tasks/${task.id}/decision`
    const decision = { approvalId: task.approvalId!, planHash: task.plan!.hash, approved: true }
    expect((await f.request(path, { ...decision, planHash: 'a'.repeat(64) }, approver)).status).toBe(409)
    expect((await f.request(path, { ...decision, approvalId: 'stale' }, approver)).status).toBe(409)
    expect((await f.request(path, decision, approver)).status).toBe(202)
    expect(f.records.get(task.id)).toEqual({ ...decision, actor: 'approver-demo' })
    expect(f.execute).not.toHaveBeenCalled()
    expect((await f.request(path, decision, approver)).status).toBe(200)
    expect((await f.request(path, { ...decision, approved: false }, approver)).status).toBe(409)
  })
  it('does not persist a separate decision when atomic delivery fails', async () => {
    const f = fixture(); const task = await f.waiting()
    const decision = { approvalId: task.approvalId!, planHash: task.plan!.hash, approved: true }
    const deliver = vi.spyOn(f.store, 'deliverApproval').mockRejectedValueOnce(new Error('unavailable'))
    await expect(f.request(`/api/tasks/${task.id}/decision`, decision, approver)).rejects.toThrow('unavailable')
    expect(f.records.get(task.id)).toBeUndefined()
    expect((await f.request(`/api/tasks/${task.id}/decision`, decision, approver)).status).toBe(202)
    expect(deliver).toHaveBeenCalledTimes(2)
  })
  it('recovers a lost acknowledgement after atomic approval acceptance', async () => {
    const f = fixture(); const task = await f.waiting()
    const decision = { approvalId: task.approvalId!, planHash: task.plan!.hash, approved: true }
    const original = f.store.deliverApproval.bind(f.store)
    vi.spyOn(f.store, 'deliverApproval').mockImplementationOnce(async args => { await original(args); throw new Error('acknowledgement lost') })
    await expect(f.request(`/api/tasks/${task.id}/decision`, decision, approver)).rejects.toThrow('acknowledgement lost')
    expect(f.records.get(task.id)).toMatchObject(decision)
    expect((await f.request(`/api/tasks/${task.id}/decision`, decision, approver)).status).toBe(200)
    expect((await f.request(`/api/tasks/${task.id}/decision`, { ...decision, approved: false }, approver)).status).toBe(409)
  })
  it('rejects a contradictory decision that wins the atomic-delivery race', async () => {
    const f = fixture(); const task = await f.waiting()
    const decision = { approvalId: task.approvalId!, planHash: task.plan!.hash, approved: true }
    const original = f.store.deliverApproval.bind(f.store)
    vi.spyOn(f.store, 'deliverApproval').mockImplementationOnce(async args => {
      await original({ ...args, approval: { ...args.approval, approved: false } })
      return original(args)
    })
    expect((await f.request(`/api/tasks/${task.id}/decision`, decision, approver)).status).toBe(409)
    expect(f.records.get(task.id)?.approved).toBe(false)
  })
  it('rejects malformed JSON, oversized payloads, and unsupported methods', async () => {
    const f = fixture()
    expect((await f.request('/api/tasks', undefined, requester, 'DELETE')).status).toBe(405)
    expect((await f.request('/api/tasks', { desiredConcurrency: 3, padding: 'x'.repeat(4096) })).status).toBe(413)
    const api = createTaskApi({ store: f.store, decisions: f.decisions, requesterToken: requester, approverToken: approver })
    expect((await api(new Request('http://local/api/tasks', { method: 'POST', headers: { authorization: `Bearer ${requester}` }, body: '{' }))).status).toBe(400)
  })
})
