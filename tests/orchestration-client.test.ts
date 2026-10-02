import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import nock from 'nock'
import { createOrchestrationClient } from '../src/orchestration/client'

const origin = 'http://orchestration.test'
const client = createOrchestrationClient('requester-secret', origin)
const task = { id: 'task-1', status: 'queued' }

beforeEach(() => nock.disableNetConnect())
afterEach(() => { const pending = nock.pendingMocks(); nock.cleanAll(); nock.enableNetConnect(); expect(pending).toEqual([]) })

describe('orchestration HTTP client', () => {
  it('sends bearer authorization and idempotency key with the task body', async () => {
    const body = { desiredConcurrency: 3, executeAt: '2026-10-02T20:00:00.000Z' }
    nock(origin, { reqheaders: { authorization: 'Bearer requester-secret', 'idempotency-key': 'stable-key', 'content-type': 'application/json' } })
      .post('/api/tasks', body).reply(202, task)
    expect(await client.create(body, 'stable-key')).toEqual(task)
  })

  it('accepts an idempotently replayed creation response', async () => {
    nock(origin).post('/api/tasks', { desiredConcurrency: 1 }).reply(200, task)
    expect(await client.create({ desiredConcurrency: 1 }, 'stable-key')).toEqual(task)
  })

  it('lists and retrieves tasks without placing credentials in the URL', async () => {
    const scope = nock(origin, { reqheaders: { authorization: 'Bearer requester-secret' } })
    scope.get('/api/tasks').reply(200, { tasks: [task] })
    scope.get('/api/tasks/task%2Fwith%20space').reply(200, task)
    expect(await client.list()).toEqual({ tasks: [task] })
    expect(await client.get('task/with space')).toEqual(task)
  })

  it.each([true, false])('posts the approval ID and exact plan hash (approved=%s)', async approved => {
    const decision = { approvalId: 'approval-1', planHash: 'plan-hash', approved }
    nock(origin).post('/api/tasks/task-1/decision', decision).reply(200, task)
    expect(await client.decide('task-1', decision)).toEqual(task)
  })

  it.each([
    [403, { error: 'Approver role required' }, 'Request failed (403): Approver role required'],
    [409, { message: 'Plan changed' }, 'Request failed (409): Plan changed'],
    [502, '<html>upstream unavailable</html>', 'Request failed (502)'],
  ])('reports HTTP %s failures clearly', async (status, body, message) => {
    nock(origin).get('/api/tasks').reply(status as number, body)
    await expect(client.list()).rejects.toThrow(message as string)
  })

  it('rejects malformed success responses', async () => {
    nock(origin).get('/api/tasks').reply(200, 'not-json')
    await expect(client.list()).rejects.toThrow('invalid JSON response')
  })

  it('honors an aborted signal without issuing a request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(client.list(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
