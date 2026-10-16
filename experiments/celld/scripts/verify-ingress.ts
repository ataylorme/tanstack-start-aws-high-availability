import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shardFor } from '../routing/protocol.ts'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: verify viewer HTTPS, primary SSR, and fail-closed missing/FENCING directory routing. No ACTIVE rows or writable promotion. Use --execute after isolated deployment.')
  process.exit(0)
}
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
const work = resolve('.deploy/celld', prefix)
const manifest = JSON.parse(readFileSync(resolve(work, 'deployment.json'), 'utf8'))
const base = new URL(manifest.SiteUrl)
if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudfront\.net$/.test(base.hostname)) throw new Error('Unexpected viewer origin')
const results: object[] = []
async function probe(path: string, expected: number, options?: RequestInit) {
  const response = await fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, expected, `Unexpected status for ${path}`)
  const body = await response.text()
  results.push({ path, method: options?.method ?? 'GET', status: response.status, cacheControl: response.headers.get('cache-control') })
  return { response, body }
}
assert.match((await probe('/', 200)).body, /TanStack Start server function executed/)
const redirect = await fetch(new URL('/', base).href.replace('https:', 'http:'), { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
assert.equal(redirect.status, 301)
assert.equal(redirect.headers.get('location'), base.href)
await probe('/?region=us-west-2', 400)
await probe('/api/objects/Counter/test-%61', 400)
await probe('/api/objects/Counter/test-ingress?region=us-west-2', 400)
// Locate a deterministic canonical ID for the operator's inert shard-7 row.
let fencingPath: string | undefined
for (let index = 0; index < 10000; index++) {
  const candidate = `/api/objects/Counter/test-inert-${index}`
  if (shardFor(candidate) === 7) { fencingPath = candidate; break }
}
assert.ok(fencingPath)
for (const path of ['/api/objects/Counter/test-alpha', fencingPath]) {
  for (const method of ['GET', 'POST']) {
    const { body, response } = await probe(path, 503, { method, headers: {
      'x-celld-epoch': '9999', 'x-celld-region': 'us-west-2', 'x-ha-region': 'us-west-2',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    }, ...(method === 'POST' ? { body: JSON.stringify({ operationId: 'test-failclosed-command', delta: 1 }) } : {}) })
    assert.equal(body, 'Ownership unavailable; mutations are not replayed')
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
}
writeFileSync(resolve(work, 'ingress-validation.json'), JSON.stringify({ observedAt: new Date().toISOString(), results, limitation: 'Missing/inert ownership only; no ACTIVE routing, authenticated stateful ingress, native MRSC fence or regional promotion demonstrated' }), { mode: 0o600 })
console.log('PASS: HTTPS viewer redirect, primary SSR, invalid key/region rejection, missing and FENCING GET/POST fail closed despite spoofed hints. No mutation replay or fallback owner.')
