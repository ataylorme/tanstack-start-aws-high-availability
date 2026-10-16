import start from '../dist/server/server.js'
import { originRequest } from './proxy.js'
import { issueSocketTicket, validSocketTicket } from './socket-ticket.js'
import { WorkflowEntrypoint } from 'cloudflare:workers'

const ID = /^test-[A-Za-z0-9_-]{1,64}$/
const OP = /^[A-Za-z0-9_-]{1,96}$/
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const authorized = (request, env) => typeof env.LAB_TOKEN === 'string' && env.LAB_TOKEN.length >= 32 && request.headers.get('authorization') === `Bearer ${env.LAB_TOKEN}`
// This is a deployment interlock, NOT regional fencing. No promotion API exists.
const primary = env => env.REGION_MODE === 'primary'

async function body(request) {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing body')
  let length = 0
  const chunks = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > 4096) { await reader.cancel(); throw new Error('Body too large') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export class Counter {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.pending = new Set()
    this.sql = ctx.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS commands (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, delta INTEGER NOT NULL, value INTEGER NOT NULL)')
  }
  snapshot() {
    return [...this.sql.exec('SELECT sequence, value FROM commands ORDER BY sequence DESC LIMIT 1')][0] ?? { sequence: 0, value: 0 }
  }
  async fetch(request) {
    if (!primary(this.env)) return json({ error: 'Standby is not authorized' }, 503)
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (request.headers.get('x-celld-validated-socket') !== 'true') return json({ error: 'Unauthorized socket' }, 401)
      if (this.ctx.getWebSockets().length >= 32) return json({ error: 'Socket capacity reached' }, 429)
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      pair[1].serializeAttachment({ authenticatedUntil: 0, authenticateBefore: Date.now() + 5000 })
      // Persist the deadline and inspect current handles across hibernation.
      const currentAlarm = await this.ctx.storage.getAlarm()
      const deadline = pair[1].deserializeAttachment().authenticateBefore
      if (currentAlarm === null || currentAlarm > deadline) await this.ctx.storage.setAlarm(deadline)
      // A reconnect must authenticate again. No long-lived token in URLs or
      // protocols; the protocol ticket is a short-lived path-bound credential.
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'sec-websocket-protocol': 'celld-v1' } })
    }
    if (!authorized(request, this.env)) return json({ error: 'Unauthorized' }, 401)
    if (request.method === 'GET') {
      if (request.headers.get('x-lab-probe-object') === 'identity') return json({ nativeObjectId: this.ctx.id.toString() })
      const probe = request.headers.get('x-lab-probe-operation')
      return probe ? json({ handlerEntered: this.pending.has(probe) }) : json(this.snapshot())
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    let command
    try { command = await body(request) } catch { return json({ error: 'Invalid command' }, 400) }
    if (!command || typeof command.operationId !== 'string' || !OP.test(command.operationId) || !Number.isSafeInteger(command.delta) || Math.abs(command.delta) > 100) return json({ error: 'Invalid command' }, 400)
    // Bounded laboratory hook for an already-accepted mutation during a pause.
    // Delay happens BEFORE its transaction; it is not an application side effect.
    if (command.delayMs !== undefined) {
      if (!Number.isSafeInteger(command.delayMs) || command.delayMs < 0 || command.delayMs > 15_000) return json({ error: 'Invalid delay' }, 400)
      this.pending.add(command.operationId)
      try { await new Promise(resolve => setTimeout(resolve, command.delayMs)) } finally { this.pending.delete(command.operationId) }
    }
    let result
    this.ctx.storage.transactionSync(() => {
      const prior = [...this.sql.exec('SELECT sequence, operation_id AS operationId, delta, value FROM commands WHERE operation_id = ?', command.operationId)][0]
      if (prior) { result = { ...prior, duplicate: true, conflict: prior.delta !== command.delta }; return }
      const value = this.snapshot().value + command.delta
      if (!Number.isSafeInteger(value)) { result = { conflict: true }; return }
      this.sql.exec('INSERT INTO commands(operation_id, delta, value) VALUES (?, ?, ?)', command.operationId, command.delta, value)
      result = { ...this.snapshot(), operationId: command.operationId, delta: command.delta, duplicate: false }
    })
    if (result.conflict) return json({ error: 'Operation conflict' }, 409)
    // celld's output gate must establish durability before releasing this output.
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.authenticatedUntil > Date.now()) {
        try { socket.send(JSON.stringify({ type: 'snapshot', ...this.snapshot() })) } catch { /* Disconnected clients resynchronize. */ }
      }
    }
    return json(result)
  }
  webSocketMessage(socket, message) {
    // Pinned celld applies WHATWG close-code restrictions to inbound sockets:
    // application codes 4001/4009/4013 are permitted, reserved 1008/1009 are not.
    if (!primary(this.env)) { socket.close(4013, 'Standby'); return }
    if (typeof message !== 'string' || message.length > 4096) { socket.close(4009, 'Message too large'); return }
    let input
    try { input = JSON.parse(typeof message === 'string' ? message : '') } catch { socket.close(4001, 'Invalid message'); return }
    if (!input || typeof input !== 'object') { socket.close(4001, 'Invalid message'); return }
    if (input.type === 'authenticate') {
      if (socket.deserializeAttachment()?.authenticateBefore && Date.now() >= socket.deserializeAttachment().authenticateBefore) { socket.close(4001, 'Authentication timeout'); return }
      if (!this.env.LAB_TOKEN || this.env.LAB_TOKEN.length < 32 || input.token !== this.env.LAB_TOKEN) { socket.close(4001, 'Unauthorized'); return }
      socket.serializeAttachment({ authenticatedUntil: Date.now() + 300_000 })
    } else if (!(socket.deserializeAttachment()?.authenticatedUntil > Date.now())) { socket.close(4001, 'Reauthenticate'); return }
    if (!['authenticate', 'resync'].includes(input.type)) { socket.close(4001, 'Read-only socket'); return }
    socket.send(JSON.stringify({ type: 'snapshot', ...this.snapshot(), recovery: 'snapshot-only; missing replicated history is not recovered' }))
  }
  async alarm() {
    const now = Date.now()
    let next = Infinity
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment()
      const deadline = attachment?.authenticatedUntil || attachment?.authenticateBefore || 0
      if (!primary(this.env)) socket.close(4013, 'Standby')
      else if (deadline <= now) socket.close(4001, 'Authentication timeout')
      else next = Math.min(next, deadline)
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next)
  }
}

export class Validation extends WorkflowEntrypoint {
  async run(event, step) {
    if (!primary(this.env)) throw new Error('Standby workflow execution disabled')
    const id = event.payload.objectId
    if (!ID.test(id ?? '')) throw new Error('Invalid object ID')
    const mutate = async (name, delta) => {
      if (!primary(this.env)) throw new Error('Standby workflow execution disabled')
      const counter = this.env.COUNTERS.get(this.env.COUNTERS.idFromName(id))
      const response = await counter.fetch('https://cell.internal/', {
        method: 'POST', headers: { authorization: `Bearer ${this.env.LAB_TOKEN}` },
        body: JSON.stringify({ operationId: `${event.instanceId}-${name}`, delta }),
      })
      if (!response.ok) throw new Error(`Counter returned ${response.status}`)
      return response.json()
    }
    // Test-only retry mode demonstrates the non-atomic boundary between an
    // external DO effect and committing the Workflow step result. The stable
    // operation ID makes the retried effect return its original result.
    const start = async context => {
      const result = await mutate('started', 1)
      if (event.payload.retryFirstStep === true && context.attempt === 1) {
        throw new Error('Deliberate lab failure after acknowledged idempotent effect')
      }
      return event.payload.retryFirstStep === true ? { ...result, attempt: context.attempt } : result
    }
    const started = event.payload.retryFirstStep === true
      ? await step.do('started', { retries: { limit: 1, delay: '1 second', backoff: 'constant' }, timeout: '30 seconds' }, start)
      : await step.do('started', start)
    await step.sleep('durable-sleep', '1 second')
    const signal = await step.waitForEvent('approval', { type: 'approval', timeout: '10 minutes' })
    if (signal.payload?.approved !== true) return { started, approved: false }
    const finished = await step.do('finished', () => mutate('finished', 1))
    return { started, finished, approved: signal.payload?.approved === true }
  }
}

export default {
  async fetch(request, env) {
    const ingress = originRequest(request, env)
    if (ingress.response) return ingress.response
    request = ingress.request
    const url = new URL(request.url)
    if (url.pathname === '/healthz') return json({ runtime: 'celld', mode: env.REGION_MODE ?? 'disabled' })
    if (url.pathname.startsWith('/compat/')) {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
      if (url.pathname === '/compat/cookie') {
        return Response.json({ set: true }, { headers: { 'cache-control': 'no-store', 'set-cookie': `celld-lab=probe; Path=/; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}` } })
      }
      if (url.pathname === '/compat/cookie/inspect') return json({ present: /(?:^|;\s*)celld-lab=probe(?:;|$)/.test(request.headers.get('cookie') ?? '') })
      if (url.pathname === '/compat/redirect') return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } })
      if (url.pathname === '/compat/stream') {
        const encoder = new TextEncoder()
        return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode('first\n'))
            await new Promise(resolve => setTimeout(resolve, 100))
            controller.enqueue(encoder.encode('second\n'))
            controller.close()
          },
        }), { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
      }
      if (url.pathname === '/compat/apis') return json({ uuid: crypto.randomUUID(), url: new URL('/probe', request.url).pathname, encodedBytes: new TextEncoder().encode('celld').length, bindings: { counter: !!env.COUNTERS, workflow: !!env.VALIDATIONS, assets: !!env.ASSETS } })
      return json({ error: 'Not found' }, 404)
    }

    if (!url.pathname.startsWith('/api/')) return start.fetch(request)
    if (url.search) return json({ error: 'Query overrides are not accepted' }, 400)
    if (!primary(env)) return json({ error: 'Standby is not authorized' }, 503)
    const match = /^\/api\/(objects\/Counter|workflows\/Validation)\/(test-[A-Za-z0-9_-]{1,64})$/.exec(url.pathname)
    if (!match) return json({ error: 'Invalid canonical object path' }, 400)
    const [, kind, id] = match
    const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    if (!upgrade && !authorized(request, env)) return json({ error: 'Unauthorized' }, 401)
    if (kind === 'objects/Counter') {
      if (upgrade) {
        if (!(await validSocketTicket(request.headers.get('sec-websocket-protocol'), url.pathname, env.LAB_TOKEN))) return json({ error: 'Unauthorized socket' }, 401)
        const headers = new Headers(request.headers)
        headers.set('x-celld-validated-socket', 'true')
        request = new Request(request, { headers })
      } else if (request.method === 'POST' && request.headers.get('x-lab-socket-ticket') === 'request') {
        return json({ ticket: await issueSocketTicket(url.pathname, env.LAB_TOKEN) })
      }
      return env.COUNTERS.get(env.COUNTERS.idFromName(id)).fetch(request)
    }
    if (upgrade) return json({ error: 'Workflow sockets are not supported' }, 400)
    try {
      if (request.method === 'GET') return json(await (await env.VALIDATIONS.get(id)).status())
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
      const command = await body(request)
      if (command.action === 'start') {
        if (command.retryFirstStep !== undefined && typeof command.retryFirstStep !== 'boolean') return json({ error: 'Invalid retry option' }, 400)
        await env.VALIDATIONS.create({ id, params: { objectId: id, ...(command.retryFirstStep === true ? { retryFirstStep: true } : {}) } })
        return json({ id }, 201)
      }
      if (command.action === 'approve' && typeof command.approved === 'boolean') {
        await (await env.VALIDATIONS.get(id)).sendEvent({ type: 'approval', payload: { approved: command.approved } })
        return json({ id, sent: true })
      }
      return json({ error: 'Invalid workflow command' }, 400)
    } catch (error) {
      // No automatic replay of ambiguous commands. Inspect the same ID first.
      console.error('Workflow command failed', error)
      return json({ error: 'Workflow command failed; inspect the same ID before retrying' }, 409)
    }
  },
}
