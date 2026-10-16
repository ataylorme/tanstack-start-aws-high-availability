import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:9877')
const vars = await readFile(process.env.LAB_TOKEN_FILE ?? 'experiments/celld/.dev.vars', 'utf8')
const token = vars.match(/^LAB_TOKEN=(.+)$/m)?.[1]?.trim() ?? vars.trim()
assert.ok(token.length >= 32, 'Use a protected token file')
const counter = new URL(`/api/objects/Counter/test-socket-${crypto.randomUUID()}`, base)
const socketUrl = new URL(counter); socketUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
const held = new Set<WebSocket>()
async function connect(authenticate = true): Promise<WebSocket> {
  const response = await fetch(counter, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-lab-socket-ticket': 'request' } })
  assert.equal(response.status, 200)
  const ticket = (await response.json()).ticket
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl, ['celld-v1', ticket]); held.add(socket)
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Socket setup timeout')) }, 8000)
    socket.onerror = () => { clearTimeout(timeout); held.delete(socket); reject(new Error('Socket refused')) }
    socket.onopen = () => {
      if (authenticate) socket.send(JSON.stringify({ type: 'authenticate', token }))
      else { clearTimeout(timeout); resolve(socket) }
    }
    socket.onmessage = event => {
      clearTimeout(timeout)
      try { const snapshot = JSON.parse(String(event.data)); assert.equal(snapshot.type, 'snapshot'); resolve(socket) }
      catch (error) { reject(error) }
    }
  })
}
async function expectClose(socket: WebSocket, code: number, message?: string | Uint8Array<ArrayBuffer>) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Expected server close did not arrive')) }, 8000)
    socket.onclose = event => { clearTimeout(timeout); held.delete(socket); try { assert.equal(event.code, code); resolve() } catch (error) { reject(error) } }
    if (message !== undefined) socket.send(message)
  })
}
async function close(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) { held.delete(socket); return }
  await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, 3000)
    socket.onclose = () => { clearTimeout(timeout); held.delete(socket); resolve() }
    socket.close()
  })
}
try {
  await expectClose(await connect(false), 4001) // bounded frame-auth deadline
  await expectClose(await connect(false), 4001, JSON.stringify({ type: 'authenticate', token: 'invalid' }))
  await expectClose(await connect(), 4001, 'null')
  await expectClose(await connect(), 4001, JSON.stringify({ type: 'mutate', delta: 1 }))
  await expectClose(await connect(), 4009, 'x'.repeat(4097))
  await expectClose(await connect(), 4009, new Uint8Array([1, 2, 3]))
  const capacity: WebSocket[] = []
  for (let index = 0; index < 32; index++) capacity.push(await connect())
  await assert.rejects(connect(), /Socket refused/)
  await Promise.all(capacity.map(close))
  await close(await connect()) // releasing capacity allows fresh reauthentication
  console.log('PASS: signed-ticket sockets enforce frame authentication deadline, invalid/null/mutation/binary/oversized rejection, 32-connection cap and capacity recovery. No regional socket fencing claim.')
} finally {
  await Promise.all([...held].map(close))
}
