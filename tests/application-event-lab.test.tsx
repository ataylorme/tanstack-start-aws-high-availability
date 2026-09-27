import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApplicationEventLab } from '../src/components/ApplicationEventLab'
import { eventEnvelope, eventRequest, oppositeRegion, sameEvent } from '../src/events/lab-client'

afterEach(() => vi.unstubAllGlobals())
const envelope = { id: 'test-ui', type: 'ha.validation.event', version: 1, timestamp: '2026-09-27T00:00:00.000Z', data: { message: 'hello' } }
it('renders an accessible event lab with explicit delivery boundaries', () => {
  const html = renderToStaticMarkup(<ApplicationEventLab />)
  expect(html).toContain('Application event lab')
  expect(html).toContain('type="password"')
  expect(html).toContain('autoComplete="off"')
  expect(html).toContain('Check SQS delivery')
  expect(html).toContain('Test conflicting payload')
  expect(html).toContain('role="status"')
  expect(html).toContain('never delete messages')
  expect(html).toContain('not observed is inconclusive')
  expect(html.match(/<button disabled=""/g)).toHaveLength(4)
})
it('normalizes envelope property order but detects a changed timestamp or payload', () => {
  const normalized = eventEnvelope({ data: envelope.data, timestamp: envelope.timestamp, version: 1, type: envelope.type, id: envelope.id })
  expect(sameEvent(eventEnvelope(envelope), normalized)).toBe(true)
  expect(sameEvent(normalized, { ...normalized, timestamp: '2026-09-28T00:00:00.000Z' })).toBe(false)
  expect(sameEvent(normalized, { ...normalized, data: { message: 'changed' } })).toBe(false)
})
it.each([null, {}, { ...envelope, version: 2 }, { ...envelope, timestamp: 'invalid' }, { ...envelope, data: {} }])('rejects unexpected server envelopes %#', value => {
  expect(() => eventEnvelope(value)).toThrow()
})
it('selects the opposite region for cross-region retries', () => {
  expect(oppositeRegion('us-east-1')).toBe('us-west-2')
  expect(oppositeRegion('us-west-2')).toBe('us-east-1')
})
it('sends token only in authorization and stable event input in the request body', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(envelope, { status: 202, headers: { 'x-served-by-region': 'us-west-2' } }))
  vi.stubGlobal('fetch', fetch)
  const body = { id: 'test-ui', message: 'hello' }
  expect(await eventRequest('private-token', 'us-west-2', body)).toEqual({ status: 202, servedBy: 'us-west-2', data: envelope })
  expect(fetch).toHaveBeenCalledWith('/api/application-events', expect.objectContaining({
    method: 'POST', headers: { authorization: 'Bearer private-token', 'x-ha-region': 'us-west-2', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: expect.any(AbortSignal),
  }))
  fetch.mockResolvedValue(Response.json({ status: 'pending' }))
  await eventRequest('private-token', 'us-east-1', { id: body.id }, true)
  expect(fetch).toHaveBeenLastCalledWith('/api/application-events/delivery', expect.objectContaining({ body: JSON.stringify({ id: body.id }) }))
})
