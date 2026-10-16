import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:9877')
const vars = await readFile(process.env.LAB_TOKEN_FILE ?? 'experiments/celld/.dev.vars', 'utf8')
const token = vars.match(/^LAB_TOKEN=(.+)$/m)?.[1]?.trim() ?? vars.trim()
assert.ok(token.length >= 32, 'Use a protected local token file')
const id = `test-${crypto.randomUUID()}`
const counter = new URL(`/api/objects/Counter/${id}`, base)
const workflow = new URL(`/api/workflows/Validation/${id}`, base)
const headers = { authorization: `Bearer ${token}` }
const request = (url: URL, command?: object) => fetch(url, {
  headers, ...(command ? { method: 'POST', body: JSON.stringify(command) } : {}),
})
assert.equal((await fetch(counter)).status, 401)
const first = await request(counter, { operationId: 'op1', delta: 3 })
assert.equal(first.status, 200, await first.clone().text())
assert.deepEqual(await first.json(), { sequence: 1, value: 3, operationId: 'op1', delta: 3, duplicate: false })
const duplicates = await Promise.all(Array.from({ length: 5 }, () => request(counter, { operationId: 'op1', delta: 3 })))
for (const result of duplicates) { assert.equal(result.status, 200); assert.equal((await result.json()).duplicate, true) }
assert.equal((await request(counter, { operationId: 'op1', delta: 4 })).status, 409)
assert.deepEqual(await (await request(counter)).json(), { sequence: 1, value: 3 })
for (const command of [{ operationId: 123, delta: 1 }, { operationId: 'bad delta', delta: 1 }, { operationId: 'big', delta: 101 }]) assert.equal((await request(counter, command)).status, 400)
assert.equal((await request(new URL(`${counter}?region=us-west-1`))).status, 400)


const socketUrl = new URL(counter); socketUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
await new Promise<void>((resolve, reject) => {
  const unauthenticated = new WebSocket(socketUrl)
  const timer = setTimeout(() => { unauthenticated.close(); reject(new Error('Unauthenticated handshake did not fail')) }, 5000)
  unauthenticated.onopen = () => { clearTimeout(timer); unauthenticated.close(); reject(new Error('Unauthenticated handshake was accepted')) }
  unauthenticated.onerror = () => { clearTimeout(timer); resolve() }
})
const ticketResponse = await fetch(counter, { method: 'POST', headers: { ...headers, 'x-lab-socket-ticket': 'request' } })
assert.equal(ticketResponse.status, 200)
const ticket = (await ticketResponse.json()).ticket
const socket = new WebSocket(socketUrl, ['celld-v1', ticket])
const snapshot = await new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket snapshot timeout')) }, 10_000)
  socket.onopen = () => socket.send(JSON.stringify({ type: 'authenticate', token }))
  socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')) }
  socket.onmessage = event => { clearTimeout(timer); resolve(JSON.parse(String(event.data))) }
})
assert.equal(snapshot.value, 3)
assert.equal(snapshot.sequence, 1)
socket.close()

const created = await request(workflow, { action: 'start' })
assert.equal(created.status, 201, await created.clone().text())
const approval = await request(workflow, { action: 'approve', approved: true })
assert.equal(approval.status, 200, await approval.clone().text())
const deadline = Date.now() + 60_000
let status: any
while (Date.now() < deadline) {
  const response = await request(workflow)
  assert.equal(response.status, 200, await response.clone().text())
  status = await response.json()
  if (['complete', 'completed', 'errored', 'terminated'].includes(status.status)) break
  await new Promise(resolve => setTimeout(resolve, 500))
}
assert.ok(['complete', 'completed'].includes(status.status), JSON.stringify(status))
assert.equal(status.output.approved, true)
assert.equal(status.output.started.value, 4)
assert.equal(status.output.finished.value, 5)
assert.deepEqual(await (await request(counter)).json(), { sequence: 3, value: 5 })
console.log('PASS: auth, SQLite commands, duplicate/concurrent replay, conflicts, authenticated WebSocket snapshot, workflow durable steps/sleep/event and internal object calls.')

const rejectedWorkflow = new URL(`/api/workflows/Validation/${id}-rejected`, base)
assert.equal((await request(rejectedWorkflow, { action: 'start' })).status, 201)
assert.equal((await request(rejectedWorkflow, { action: 'approve', approved: false })).status, 200)
const rejectedDeadline = Date.now() + 60_000
let rejected: any
while (Date.now() < rejectedDeadline) {
  rejected = await (await request(rejectedWorkflow)).json()
  if (['complete', 'completed', 'errored'].includes(rejected.status)) break
  await new Promise(resolve => setTimeout(resolve, 300))
}
assert.ok(['complete', 'completed'].includes(rejected.status), JSON.stringify(rejected))
assert.equal(rejected.output.approved, false)
assert.equal(rejected.output.finished, undefined)
console.log('PASS: invalid commands/region override rejected, negative approval does not execute final mutation.')
