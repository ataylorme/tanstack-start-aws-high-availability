import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const awsMode = process.argv.includes('--aws')
const count = 50
const output = resolve('.deploy/celld/benchmarks')
mkdirSync(output, { recursive: true, mode: 0o700 })
async function measure(label: string, base: string, headers: Record<string, string> = {}) {
  const url = new URL(base)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid benchmark URL')
  const samples: number[] = []
  const sizes: number[] = []
  for (let index = 0; index < count + 5; index++) {
    const started = performance.now()
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    assert.equal(response.status, 200, `${label}: SSR failure`)
    const body = await response.arrayBuffer()
    if (index >= 5) { samples.push(performance.now() - started); sizes.push(body.byteLength) }
  }
  const ordered = [...samples].sort((a, b) => a - b)
  const percentile = (p: number) => ordered[Math.ceil(p * ordered.length) - 1]!
  return { label, requests: count, concurrency: 1, warmupRequests: 5, milliseconds: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), min: ordered[0], max: ordered.at(-1) }, meanResponseBytes: sizes.reduce((a, b) => a + b, 0) / sizes.length, samples }
}
const results: object[] = []
if (awsMode) {
  const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
  if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
  const manifest = JSON.parse(readFileSync(resolve('.deploy/celld', prefix, 'deployment.json'), 'utf8'))
  if (!/^https:\/\/[a-z0-9-]+\.cloudfront\.net$/.test(manifest.SiteUrl)) throw new Error('Unexpected AWS viewer URL')
  results.push(await measure('celld AWS CloudFront dynamic SSR', manifest.SiteUrl))
} else {
  const port = '3188'
  const secret = randomBytes(32).toString('hex')
  const server = spawn(process.execPath, ['.output/server/index.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HOST: '127.0.0.1', PORT: port, ORIGIN_SECRET: secret,
    AWS_REGION: 'us-east-1', AWS_LAMBDA_FUNCTION_NAME: 'benchmark', SIMULATE_FAILURE: 'false', RELEASE_ID: 'benchmark',
  } })
  // Drain bounded child output; never take over or terminate an existing server.
  server.stdout.resume(); server.stderr.resume()
  try {
    let ready = false
    for (let index = 0; index < 100; index++) {
      if (server.exitCode !== null) throw new Error('Owned baseline server exited')
      try { ready = (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) })).ok } catch { /* startup */ }
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, 'Owned baseline server startup failed')
    results.push(await measure('baseline local Nitro dynamic SSR', `http://127.0.0.1:${port}`, { 'x-origin-verify': secret, 'x-forwarded-host': 'example.cloudfront.net' }))
    results.push(await measure('celld local dynamic SSR', process.env.CELLD_LOCAL_URL ?? 'http://127.0.0.1:9877'))
  } finally {
    if (server.exitCode === null && server.signalCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited }
  }
}
const evidence = { observedAt: new Date().toISOString(), node: process.version, results, limitation: 'Small warm sequential SSR sample from this client, different app payloads. Not equivalent workloads, cold-start/throughput/stateful recovery measurements, production sizing, or an apples-to-apples cloud baseline.' }
writeFileSync(resolve(output, awsMode ? 'aws-ssr.json' : 'local-ssr.json'), JSON.stringify(evidence), { mode: 0o600 })
for (const row of results as any[]) console.log(`${row.label}: n=${row.requests}, p50=${row.milliseconds.p50.toFixed(2)}ms, p95=${row.milliseconds.p95.toFixed(2)}ms, p99=${row.milliseconds.p99.toFixed(2)}ms`)
console.log(evidence.limitation)
