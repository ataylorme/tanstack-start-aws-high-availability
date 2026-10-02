import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrchestrationDashboard } from '../src/components/OrchestrationDashboard'
import { accessToken, taskRequest } from '../src/orchestration/form'

const now = Date.parse('2026-10-02T12:00:00Z')
describe('orchestration form', () => {
  it('defaults to execution after approval without a datetime input', () => {
    const html = renderToStaticMarkup(<OrchestrationDashboard />)
    expect(html).toMatch(/checked="" value="after-approval"/)
    expect(html).toContain('Schedule for later')
    expect(html).not.toContain('type="datetime-local"')
    expect(html).toContain('not the entire file')
  })
  it('omits any retained date when execution after approval is selected', () => {
    expect(taskRequest(2, 'after-approval', '2026-10-02T13:00:00Z', now)).toEqual({ desiredConcurrency: 2 })
    expect(taskRequest(2, 'after-approval', '', now)).toEqual({ desiredConcurrency: 2 })
  })
  it('sends the chosen schedule as UTC', () => {
    expect(taskRequest(3, 'scheduled', '2026-10-02T08:00:00-07:00', now)).toEqual({ desiredConcurrency: 3, executeAt: '2026-10-02T15:00:00.000Z' })
  })
  it.each(['', 'invalid', '2026-10-02T11:59:00Z', '2026-10-03T12:01:00Z'])('rejects missing or invalid scheduled time %s', date => {
    expect(() => taskRequest(2, 'scheduled', date, now)).toThrow('within the next 24 hours')
  })
  it.each([0, 6, 1.5, NaN])('rejects invalid concurrency %s', desired => {
    expect(() => taskRequest(desired, 'after-approval', '', now)).toThrow('1 to 5')
  })
  it('trims clipboard whitespace from an individual token', () => {
    expect(accessToken('  requester-value\n')).toBe('requester-value')
  })
  it.each(['', '{"requester":"secret","approver":"other"}', '"secret"', 'Bearer secret'])('rejects credential input mistakes without echoing tokens', value => {
    expect(() => accessToken(value)).toThrow('Paste only the requester or approver token value')
    try { accessToken(value) } catch (error) { expect(String(error)).not.toContain('secret') }
  })
})
