import { afterEach, expect, it, vi } from 'vitest'
import { ApplicationEventConflictError, type ApplicationEventPublisher } from '@ataylorme/tanstack-workflow-aws/events'
import { applicationEventsApi, parseEvent } from '../src/events/api.server'

const token = 'a'.repeat(64)
const request = (body: unknown, auth = token, method = 'POST') => new Request('https://example.test/api/application-events', {
  method, headers: { authorization: `Bearer ${auth}` }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
})
afterEach(() => vi.unstubAllEnvs())
it.each([null, {}, { id: '../bad', message: 'x' }, { id: 'test-a', message: 'x'.repeat(201) }, { id: 'test-a', message: 'x', type: 'arbitrary' }])('rejects unsafe inputs %#', value => {
  expect(() => parseEvent(value)).toThrow()
})
it('authenticates before publishing and fails closed when unconfigured', async () => {
  vi.stubEnv('WORKFLOW_TEST_TOKEN', token)
  vi.stubEnv('TABLE_NAME', '')
  expect((await applicationEventsApi(request({}, 'wrong'))).status).toBe(401)
  expect((await applicationEventsApi(request({}))).status).toBe(503)
})
it('enforces method, payload and command boundaries without publishing', async () => {
  vi.stubEnv('WORKFLOW_TEST_TOKEN', token)
  vi.stubEnv('TABLE_NAME', 'test-table')
  const publish = vi.fn()
  expect((await applicationEventsApi(request({}, token, 'GET'), { publish })).status).toBe(405)
  expect((await applicationEventsApi(request({}), { publish })).status).toBe(400)
  expect((await applicationEventsApi(request({ message: 'x'.repeat(2049) }), { publish })).status).toBe(413)
  expect(publish).not.toHaveBeenCalled()
})
it('preserves the committed envelope and maps conflict/ambiguous failure', async () => {
  vi.stubEnv('WORKFLOW_TEST_TOKEN', token)
  vi.stubEnv('TABLE_NAME', 'test-table')
  const body = { id: 'test-one', message: 'hello' }
  const event = { ...parseEvent(body), timestamp: '2026-09-27T00:00:00.000Z' }
  const publish = vi.fn().mockResolvedValue(event)
  const publisher = { publish } as ApplicationEventPublisher
  const response = await applicationEventsApi(request(body), publisher)
  expect(response.status).toBe(202)
  expect(response.headers.get('x-event-candidate')).toBe('bfecb80ecf02d1f9630514a082030b63168e1d72')
  expect(response.headers.get('x-event-artifact')).toMatch(/^[a-f0-9]{64}$/)
  expect(await response.json()).toEqual(event)
  expect(publish).toHaveBeenCalledWith(parseEvent(body))
  publish.mockRejectedValueOnce(new ApplicationEventConflictError(body.id))
  expect((await applicationEventsApi(request(body), publisher)).status).toBe(409)
  publish.mockRejectedValueOnce(new Error('secret infrastructure details'))
  const failure = await applicationEventsApi(request(body), publisher)
  expect(failure.status).toBe(503)
  expect(await failure.text()).not.toContain('secret infrastructure')
})

it('cancels a chunked oversized body before consuming its tail', async () => {
  vi.stubEnv('WORKFLOW_TEST_TOKEN', token)
  vi.stubEnv('TABLE_NAME', 'test-table')
  const cancel = vi.fn()
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2049)) },
    cancel,
  })
  const incoming = new Request('https://example.test/api/application-events', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: stream, duplex: 'half',
  } as RequestInit)
  const publish = vi.fn()
  expect((await applicationEventsApi(incoming, { publish })).status).toBe(413)
  expect(cancel).toHaveBeenCalledOnce()
  expect(publish).not.toHaveBeenCalled()
})
