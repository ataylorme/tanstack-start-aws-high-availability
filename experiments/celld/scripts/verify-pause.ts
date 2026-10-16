import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

if (!process.argv.includes('--execute')) {
  console.log('Local-only drill: start owned celld dev, pause its native node for 15 seconds during a delayed mutation, require self-fencing, restart and reconcile. Stop your existing celld dev first, then add --execute. This does not prove regional fencing.')
  process.exit(0)
}
const base = 'http://127.0.0.1:9877'
try { await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }); throw new Error('Stop existing local celld dev before this owned-process drill') }
catch (error) { if (error instanceof Error && error.message.includes('Stop existing')) throw error }
const token = (await readFile('experiments/celld/.dev.vars', 'utf8')).match(/^LAB_TOKEN=(.+)$/m)?.[1]?.trim()
assert.ok(token && token.length >= 32, 'Configure a local lab token')
const id = `test-${crypto.randomUUID()}`
const counter = `${base}/api/objects/Counter/${id}`
const operationId = crypto.randomUUID()
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const logPath = resolve('.omx/local/celld-pause.log')
let processHandle: ReturnType<typeof spawn> | undefined
let nativePid: number | undefined
let nativePaused = false
const terminated = () => !!processHandle && (processHandle.exitCode !== null || processHandle.signalCode !== null)
let initialLogLength = 0
try { initialLogLength = (await readFile(logPath, 'utf8')).length } catch { /* New log */ }
async function start() {
  const fd = openSync(logPath, 'a', 0o600)
  processHandle = spawn(resolve('.omx/local/celld-bin/celld'), ['dev', 'experiments/celld', '--no-watch', '--logs', '--port', '9877'], {
    env: { ...process.env, PATH: `${resolve('node_modules/.bin')}:${process.env.PATH}` }, stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (terminated()) throw new Error('Owned celld process exited before readiness')
    try { const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) }); if (response.ok) return } catch { /* Startup */ }
    await sleep(100)
  }
  throw new Error('Local readiness timeout')
}
async function stop() {
  if (!processHandle || terminated()) return
  processHandle.kill('SIGTERM')
  const deadline = Date.now() + 10_000
  while (!terminated() && Date.now() < deadline) await sleep(100)
  if (!terminated()) throw new Error('Owned process did not stop; refusing another process on same state')
}
const command = (value: object) => fetch(counter, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(value), signal: AbortSignal.timeout(30_000) })
try {
  await start()
  const initialized = await command({ operationId: 'seed', delta: 2 }); assert.equal(initialized.status, 200)
  // macOS process inventory, scoped strictly to the child we just spawned.
  const children = execFileSync('pgrep', ['-P', String(processHandle!.pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
  const matches = children.filter(pid => execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes('--no-control-plane --bucket celld-dev --listen 127.0.0.1:9877'))
  assert.equal(matches.length, 1, 'Must prove exact owned native node before signalling')
  nativePid = matches[0]!
  const outstanding = command({ operationId, delta: 7, delayMs: 10_000 }).then(response => response.status).catch(() => 0)
  const enteredDeadline = Date.now() + 5000
  let entered = false
  while (Date.now() < enteredDeadline) {
    const probe = await fetch(counter, { headers: { authorization: `Bearer ${token}`, 'x-lab-probe-operation': operationId } })
    entered = (await probe.json()).handlerEntered === true
    if (entered) break
    await sleep(50)
  }
  assert.ok(entered, 'Delayed mutation handler must be entered BEFORE pausing')
  process.kill(nativePid, 'SIGSTOP')
  nativePaused = true
  await sleep(15_000)
  process.kill(nativePid, 'SIGCONT')
  nativePaused = false
  const status = await outstanding
  assert.ok(status === 0 || status >= 500, `Paused old node must not acknowledge mutation successfully (${status})`)
  const deadline = Date.now() + 10_000
  while (!terminated() && Date.now() < deadline) await sleep(100)
  assert.ok(terminated(), 'Expired native node must exit, not resume normal writes')
  const logs = await readFile(logPath, 'utf8')
  assert.match(logs.slice(initialLogLength), /SELF-FENCE|node_lease_watchdog_fence/)
  await start()
  const response = await fetch(counter, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  const recovered = await response.json() as { sequence: number; value: number }
  assert.deepEqual(recovered, { sequence: 1, value: 2 }, 'Delayed transaction must not enter recovered history')
  const retry = await command({ operationId, delta: 7 })
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).value, 9)
  await writeFile('.omx/local/celld-pause-result.json', JSON.stringify({ observedAt: new Date().toISOString(), scope: 'local-single-bucket-native-node-only', pauseMs: 15_000, outstandingStatus: status, recovered, sameOperationRetryValue: 9, regionalFencingProven: false }), { mode: 0o600 })
  console.log('PASS: paused native owner self-fenced, outstanding mutation had no success acknowledgement or recovered commit; retry with original operation ID succeeded after restart. Regional fencing remains unproven.')
} finally {
  if (nativePid && nativePaused) { try { process.kill(nativePid, 'SIGCONT') } catch { /* Already stopped */ } }
  await stop()
}
