import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

const phase = process.argv[2]
assert.ok(phase === 'seed' || phase === 'recover', 'Specify seed or recover; restart celld between phases')
const base = process.argv[3] ?? 'http://127.0.0.1:9877'
const vars = await readFile(process.env.LAB_TOKEN_FILE ?? 'experiments/celld/.dev.vars', 'utf8')
const token = vars.match(/^LAB_TOKEN=(.+)$/m)?.[1]?.trim() ?? vars.trim()
const fixture = '.omx/local/celld-restart-fixture.json'
const state = phase === 'seed' ? { id: `test-${crypto.randomUUID()}`, operationId: crypto.randomUUID() }
  : JSON.parse(await readFile(fixture, 'utf8'))
async function request(kind: string, command?: object) {
  const response = await fetch(`${base}/api/${kind}/${state.id}`, {
    headers: { authorization: `Bearer ${token}` },
    ...(command ? { method: 'POST', body: JSON.stringify(command) } : {}),
  })
  assert.ok(response.ok, await response.clone().text())
  return response.json() as Promise<any>
}
if (phase === 'seed') {
  assert.equal((await request('objects/Counter', { operationId: state.operationId, delta: 10 })).value, 10)
  await request('workflows/Validation', { action: 'start' })
  const deadline = Date.now() + 20_000
  let snapshot
  do {
    snapshot = await request('objects/Counter')
    if (snapshot.value === 11) break
    await new Promise(resolve => setTimeout(resolve, 200))
  } while (Date.now() < deadline)
  assert.equal(snapshot.value, 11, 'Workflow first step must be committed before restart')
  await writeFile(fixture, JSON.stringify(state), { mode: 0o600 })
  console.log('Seed committed; restart celld without --clean, then run recover.')
} else {
  assert.deepEqual(await request('objects/Counter'), { sequence: 2, value: 11 })
  const duplicate = await request('objects/Counter', { operationId: state.operationId, delta: 10 })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.value, 10, 'Duplicate returns original operation result')
  await request('workflows/Validation', { action: 'approve', approved: true })
  const deadline = Date.now() + 60_000
  let status
  do {
    status = await request('workflows/Validation')
    if (['complete', 'completed', 'errored'].includes(status.status)) break
    await new Promise(resolve => setTimeout(resolve, 300))
  } while (Date.now() < deadline)
  assert.ok(['complete', 'completed'].includes(status.status), JSON.stringify(status))
  assert.equal(status.output.started.value, 11)
  assert.equal(status.output.finished.value, 12)
  assert.deepEqual(await request('objects/Counter'), { sequence: 3, value: 12 })
  console.log('PASS: process restart retained SQLite state, operation deduplication and workflow history; waiting workflow resumed without repeating its committed first step.')
}
