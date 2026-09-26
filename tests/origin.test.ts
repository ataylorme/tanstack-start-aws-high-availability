import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkOrigin, publicRequest, regionInfo } from '../src/lib/origin'

function request(path = '/', secret?: string): Request {
  return new Request(`https://example.lambda-url.us-east-1.on.aws${path}`, {
    headers: secret === undefined ? {} : { 'x-origin-verify': secret },
  })
}

afterEach(() => vi.useRealTimers())

describe('origin authentication', () => {
  it('fails closed when a deployed Lambda has no secret', async () => {
    const result = checkOrigin(request(), { AWS_LAMBDA_FUNCTION_NAME: 'example' })
    expect(result?.status).toBe(503)
    expect(await result?.text()).toBe('Origin is not configured')
  })

  it.each([undefined, '', 'wrong', 'same-length!', 'éééééé'])('rejects missing or incorrect secret %# without throwing', (supplied) => {
    expect(checkOrigin(request('/', supplied), { ORIGIN_SECRET: 'secret-value' })?.status).toBe(403)
  })

  it('compares byte lengths safely for multibyte secrets', () => {
    expect(checkOrigin(request('/', 'é'), { ORIGIN_SECRET: 'e' })?.status).toBe(403)
    expect(checkOrigin(request('/', 'é'), { ORIGIN_SECRET: 'ab' })?.status).toBe(403)
    expect(checkOrigin(request('/', 'é'), { ORIGIN_SECRET: 'é' })).toBeUndefined()
  })

  it('accepts authenticated application requests and unauthenticated local development', () => {
    expect(checkOrigin(request('/', 'secret'), { ORIGIN_SECRET: 'secret' })).toBeUndefined()
    expect(checkOrigin(request(), {})).toBeUndefined()
  })

  it('keeps readiness independent of credentials and simulated outages', async () => {
    const result = checkOrigin(request('/readyz'), {
      AWS_LAMBDA_FUNCTION_NAME: 'example', SIMULATE_FAILURE: 'true',
    })
    expect(result?.status).toBe(200)
    expect(await result?.text()).toBe('ready')
    expect(checkOrigin(request('/readyz/'), { ORIGIN_SECRET: 'secret' })?.status).toBe(403)
  })

  it('simulates failure only after authentication, including health checks', async () => {
    const env = { ORIGIN_SECRET: 'secret', SIMULATE_FAILURE: 'true' }
    expect(checkOrigin(request('/healthz'), env)?.status).toBe(403)
    const result = checkOrigin(request('/healthz', 'secret'), env)
    expect(result?.status).toBe(503)
    expect(await result?.text()).toBe('Simulated regional outage')
    expect(checkOrigin(request('/', 'secret'), { ...env, SIMULATE_FAILURE: 'false' })).toBeUndefined()
  })

  it('returns regional health metadata and local defaults', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
    const result = checkOrigin(request('/healthz', 'secret'), {
      ORIGIN_SECRET: 'secret', AWS_REGION: 'us-west-2', RELEASE_ID: 'release-123',
    })
    expect(result?.status).toBe(200)
    expect(result?.headers.get('content-type')).toContain('application/json')
    expect(await result?.json()).toEqual({ status: 'ok', region: 'us-west-2', release: 'release-123', timestamp: '2026-01-02T03:04:05.000Z' })
    expect(regionInfo({})).toEqual({ region: 'local', release: 'development', timestamp: '2026-01-02T03:04:05.000Z' })
  })
})

describe('public URL reconstruction', () => {
  it('preserves path, query, headers, method and POST body while restoring HTTPS host', async () => {
    const input = new Request('http://localhost:3000/api/save?a=1&a=2&encoded=%2F', {
      method: 'POST', body: JSON.stringify({ message: 'hello' }),
      headers: { 'x-forwarded-host': 'example.cloudfront.net', 'x-forwarded-proto': 'http', 'content-type': 'application/json', cookie: 'session=example' },
    })
    const result = publicRequest(input, { ORIGIN_SECRET: 'secret' })
    expect(result.url).toBe('https://example.cloudfront.net/api/save?a=1&a=2&encoded=%2F')
    expect(result.method).toBe('POST')
    expect(result.headers.get('cookie')).toBe('session=example')
    expect(result.headers.get('content-type')).toBe('application/json')
    expect(await result.json()).toEqual({ message: 'hello' })
  })

  it('does not trust forwarded hosts without an origin secret', () => {
    const input = new Request('http://localhost:3000/', { headers: { 'x-forwarded-host': 'attacker.test' } })
    expect(publicRequest(input, {})).toBe(input)
  })

  it.each([undefined, '', 'https://attacker.test', 'user@attacker.test', 'example.com/path', 'example.com,attacker.test'])('ignores missing or malformed forwarded host %#', (host) => {
    const input = new Request('http://localhost:3000/', { headers: host === undefined ? {} : { 'x-forwarded-host': host } })
    expect(publicRequest(input, { ORIGIN_SECRET: 'secret' })).toBe(input)
  })
})
