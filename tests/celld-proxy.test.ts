import { describe, expect, it } from 'vitest'
// @ts-expect-error Workers JS module is deliberately bundled without Node-only typings.
import { originRequest } from '../experiments/celld/runtime/proxy.js'
const secret = 'a'.repeat(64)
function request(extra: Record<string, string> = {}) {
  return new Request('http://internal.example:8080/path?key=value', { method: 'POST', body: 'payload', headers: extra })
}
describe('celld public ingress URL reconstruction', () => {
  it('does not trust proxy headers in local mode', () => {
    const input = request({ 'x-forwarded-host': 'attacker.example' })
    expect(originRequest(input, {}).request).toBe(input)
  })
  it('fails closed if AWS origin credentials are missing', () => {
    expect(originRequest(request(), { DEPLOYMENT_TYPE: 'aws' }).response.status).toBe(503)
  })
  it.each(['', 'b'.repeat(64), 'short'])('rejects forged origin credentials', supplied => {
    expect(originRequest(request({ 'x-celld-origin-secret': supplied }), { ORIGIN_SECRET: secret }).response.status).toBe(403)
  })
  it.each(['attacker.example', 'example.cloudfront.net:443', 'example.cloudfront.net@attacker.example', 'EXAMPLE.cloudfront.net'])('rejects arbitrary public hosts', host => {
    expect(originRequest(request({ 'x-celld-origin-secret': secret, 'x-forwarded-host': host }), { ORIGIN_SECRET: secret }).response.status).toBe(400)
  })
  it('reconstructs authenticated viewer HTTPS even when the ALB HTTP leg reports http', async () => {
    const output = originRequest(request({ 'x-celld-origin-secret': secret, 'x-forwarded-host': 'example.cloudfront.net', 'x-forwarded-proto': 'http' }), { ORIGIN_SECRET: secret })
    expect(output.request.url).toBe('https://example.cloudfront.net/path?key=value')
    expect(output.request.method).toBe('POST')
    expect(await output.request.text()).toBe('payload')
  })
})
