import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'

const port = process.env.SMOKE_PORT ?? '3187'
const base = `http://127.0.0.1:${port}`
const secret = 'smoke-test-origin-secret'
async function smoke(failed: boolean): Promise<void> {
  const server = spawn(process.execPath, ['.output/server/index.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: port, ORIGIN_SECRET: secret,
      AWS_REGION: 'us-east-1', AWS_LAMBDA_FUNCTION_NAME: 'smoke',
      SIMULATE_FAILURE: String(failed), RELEASE_ID: 'smoke' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  server.stdout.on('data', (data: Buffer) => { log += data.toString() })
  server.stderr.on('data', (data: Buffer) => { log += data.toString() })
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${log}`)
      try { ready = (await fetch(`${base}/readyz`)).ok } catch { /* startup */ }
      if (ready) break
      await setTimeout(100)
    }
    assert.ok(ready, `Server did not become ready: ${log}`)
    assert.equal((await fetch(`${base}/`)).status, 403)
    const headers = { 'x-origin-verify': secret, 'x-forwarded-host': 'example.cloudfront.net' }
    const health = await fetch(`${base}/healthz`, { headers })
    assert.equal(health.status, failed ? 503 : 200)
    assert.equal(health.headers.get('x-served-by-region'), 'us-east-1')
    const page = await fetch(base, { headers })
    assert.equal(page.status, failed ? 503 : 200)
    if (!failed) {
      const html = await page.text()
      assert.match(html, /Two regions/)
      assert.match(html, /us-east-1/)
      const asset = html.match(/(?:src|href)="([^" ]+\/assets\/[^" ]+|\/assets\/[^" ]+)"/)?.[1]
      assert.ok(asset, 'SSR page should reference a built client asset')
      assert.equal((await fetch(new URL(asset, base))).status, 200)
      assert.equal(page.headers.get('cache-control'), 'no-store')
    }
    console.log(`Production server smoke (${failed ? 'simulated failure' : 'healthy'}): passed`)
  } finally {
    if (server.exitCode === null) {
      const exit = once(server, 'exit')
      server.kill('SIGTERM')
      await exit
    }
  }
}
await smoke(false)
await smoke(true)
