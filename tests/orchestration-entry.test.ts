import { afterEach, describe, expect, it, vi } from 'vitest'
import { invocationContext, orchestrationEntry } from '../src/orchestration/entry.server'
afterEach(() => vi.unstubAllEnvs())
describe('orchestration role and invocation boundary', () => {
  it('rejects forged worker routes and disables lab APIs in HTTP mode', async () => {
    vi.stubEnv('APP_ROLE', 'http')
    for (const path of ['/internal/events', '/api/workflows', '/api/application-events']) {
      const response = await orchestrationEntry(new Request(`http://local${path}`, { method: 'POST', headers: { 'x-amzn-lambda-context': JSON.stringify({ deadline: Date.now() + 100000, request_id: 'forged' }), 'x-app-role': 'executor' }, body: '{}' }))
      expect(response?.status).toBe(404)
    }
  })
  it('fails closed for unknown role and private routes', async () => {
    vi.stubEnv('APP_ROLE', 'invalid'); expect((await orchestrationEntry(new Request('http://local/')))?.status).toBe(503)
    vi.stubEnv('APP_ROLE', 'executor'); expect((await orchestrationEntry(new Request('http://local/api/tasks')))?.status).toBe(404)
  })
  it('requires a valid invocation deadline and rejects exhausted budgets', async () => {
    expect(() => invocationContext('{}')).toThrow()
    expect(invocationContext(JSON.stringify({ deadline: 2000, request_id: 'r' }), () => 1500).getRemainingTimeInMillis()).toBe(500)
    vi.stubEnv('APP_ROLE', 'sandbox')
    const response = await orchestrationEntry(new Request('http://local/internal/events', { method: 'POST', headers: { 'x-amzn-lambda-context': JSON.stringify({ deadline: 1, request_id: 'r' }) }, body: '{}' }))
    expect(response?.status).toBe(500)
  })
  it('returns direct JSON for pass-through sandbox invocation', async () => {
    vi.stubEnv('APP_ROLE', 'sandbox')
    const response = await orchestrationEntry(new Request('http://local/internal/events', { method: 'POST', headers: { 'x-amzn-lambda-context': JSON.stringify({ deadline: Date.now() + 100000, request_id: 'r' }) }, body: '{}' }))
    expect(await response?.json()).toEqual({ ok: true })
  })
  it('preserves direct partial-batch failures for malformed SQS work', async () => {
    for (const name of ['WORKFLOW_TABLE_NAME', 'OPERATIONS_TABLE_NAME', 'SANDBOX_FUNCTION_NAME', 'WAKEUP_QUEUE_URL', 'WAKEUP_QUEUE_ARN', 'SCHEDULE_GROUP', 'SCHEDULER_ROLE_ARN', 'SCHEDULER_DLQ_ARN']) vi.stubEnv(name, `test-${name}`)
    vi.stubEnv('AWS_REGION', 'us-east-1'); vi.stubEnv('APP_ROLE', 'worker')
    const response = await orchestrationEntry(new Request('http://local/internal/events', { method: 'POST', headers: { 'x-amzn-lambda-context': JSON.stringify({ deadline: Date.now() + 60000, request_id: 'batch' }) }, body: JSON.stringify({ Records: [{ eventSource: 'aws:sqs', messageId: 'bad-record', body: '{' }] }) }))
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad-record' }] })
  })

})
