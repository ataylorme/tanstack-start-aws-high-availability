import assert from 'node:assert/strict'

// This probes the built application on celld. It is not a hydration/E2E test.
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:9876')
const page = await fetch(base)
assert.equal(page.status, 200, 'SSR must succeed')
assert.match(page.headers.get('content-type') ?? '', /text\/html/)
const html = await page.text()
assert.match(html, /TanStack Start server function executed/, 'GET server function must run during SSR')
const assets = [...html.matchAll(/href="(\/assets\/[^" ]+\.js)"/g)].map(match => match[1]!)
assert.ok(assets.length >= 2, 'SSR must include entry and route assets')
let routeModule = ''
for (const asset of new Set(assets)) {
  const response = await fetch(new URL(asset, base))
  assert.equal(response.status, 200, `Asset must load: ${asset}`)
  assert.match(response.headers.get('content-type') ?? '', /javascript/)
  const code = await response.text()
  if (code.includes('POST server function executed') || code.includes('Test POST server function')) routeModule = code
}
// The initial probe has exactly one browser-callable server function. Revisit
// this discovery contract when adding more functions instead of guessing IDs.
const ids = [...new Set(routeModule.match(/[a-f0-9]{64}/g))]
assert.equal(ids.length, 1, 'Expected one POST server function in the probe route')
const response = await fetch(new URL(`/_serverFn/${ids[0]}`, base), {
  method: 'POST',
  headers: { origin: base.origin, 'x-tsr-serverFn': 'true' },
})
assert.equal(response.status, 200, 'POST server function must succeed')
assert.match(await response.text(), /POST server function executed/)
console.log('PASS: celld SSR, GET/POST server functions, and JavaScript assets. Hydration remains a browser check.')

const cookieResponse = await fetch(new URL('/compat/cookie', base))
assert.equal(cookieResponse.status, 200)
const cookie = cookieResponse.headers.get('set-cookie')
assert.match(cookie ?? '', /celld-lab=probe; Path=\/; HttpOnly; SameSite=Lax/)
if (base.protocol === 'https:') assert.match(cookie ?? '', /Secure/)
const cookieInspection = await fetch(new URL('/compat/cookie/inspect', base), { headers: { cookie: 'celld-lab=probe' } })
assert.equal((await cookieInspection.json()).present, true)
const redirected = await fetch(new URL('/compat/redirect', base), { redirect: 'manual' })
assert.equal(redirected.status, 302)
assert.equal(redirected.headers.get('location'), '/')
const apis = await (await fetch(new URL('/compat/apis', base))).json()
assert.match(apis.uuid, /^[a-f0-9-]{36}$/)
assert.equal(apis.encodedBytes, 5)
assert.deepEqual(apis.bindings, { counter: true, workflow: true, assets: true })
const stream = await fetch(new URL('/compat/stream', base))
assert.equal(stream.status, 200)
const reader = stream.body!.getReader()
const first = await reader.read()
const firstText = new TextDecoder().decode(first.value)
assert.equal(firstText, 'first\n', 'Incremental stream first chunk must arrive before completion')
let tail = ''
while (true) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value) }
assert.equal(tail, 'second\n')
console.log('PASS: cookies, fixed redirect, runtime APIs/bindings, and incremental streaming.')
