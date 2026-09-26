import assert from 'node:assert/strict'

const input = process.argv[2]
if (!input) throw new Error('Usage: node scripts/verify-deployment.ts https://distribution.cloudfront.net [failed-region]')
const base = new URL(input)
if (base.protocol !== 'https:') throw new Error('Use HTTPS for deployment verification')
const failedRegion = process.argv[3]
if (failedRegion && failedRegion !== 'us-east-1' && failedRegion !== 'us-west-2') {
  throw new Error('failed-region must be us-east-1 or us-west-2')
}
for (const preferred of ['us-east-1', 'us-west-2'] as const) {
  const expected = failedRegion === preferred ?
    preferred === 'us-east-1' ? 'us-west-2' : 'us-east-1' : preferred
  for (const path of ['/', '/healthz']) {
    const response = await fetch(new URL(path, base), {
      headers: { 'x-ha-region': preferred }, signal: AbortSignal.timeout(60000),
    })
    assert.equal(response.status, 200, `${preferred} ${path}: ${await response.clone().text()}`)
    assert.equal(response.headers.get('x-served-by-region'), expected)
    if (path === '/') assert.match(await response.text(), /Two regions/)
    else {
      const body: unknown = await response.json()
      assert.ok(typeof body === 'object' && body !== null && 'region' in body && body.region === expected)
    }
    console.log(`${preferred} preference ${path} -> ${expected}: OK`)
  }
  for (const method of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const isRead = method === 'HEAD' || method === 'OPTIONS'
    const expectedStatus = !isRead && failedRegion === preferred ? 503 : 200
    const expectedRegion = isRead ? expected : preferred
    // /healthz has no side effects; never exercise real writes during a drill.
    const response = await fetch(new URL('/healthz', base), {
      method, headers: { 'x-ha-region': preferred }, signal: AbortSignal.timeout(60000),
    })
    assert.equal(response.status, expectedStatus, `${preferred} ${method} /healthz`)
    assert.equal(response.headers.get('x-served-by-region'), expectedRegion)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    await response.arrayBuffer()
    console.log(`${preferred} preference ${method} /healthz -> ${expectedRegion} (${expectedStatus}): OK`)
  }
}
