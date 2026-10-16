import { useEffect, useRef, useState } from 'react'

export function StatefulLab() {
  const [token, setToken] = useState('')
  const [id, setId] = useState('test-browser')
  const [operationId, setOperationId] = useState('')
  const [result, setResult] = useState('No stateful request yet')
  const [live, setLive] = useState(false)
  const [socketStatus, setSocketStatus] = useState('Disconnected')
  const sequence = useRef(0)
  const historyLost = useRef(false)
  useEffect(() => {
    if (!live || token.length < 32 || !/^test-[A-Za-z0-9_-]{1,64}$/.test(id)) return
    let disposed = false
    let attempt = 0
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    sequence.current = 0
    historyLost.current = false
    async function connect() {
      let ticket: string
      try {
        const response = await fetch(`/api/objects/Counter/${id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-lab-socket-ticket': 'request' } })
        if (!response.ok) throw new Error('Ticket refused')
        ticket = (await response.json()).ticket
      } catch {
        if (disposed) return
        if (attempt >= 5) { setSocketStatus('Authentication/reconnect limit reached. Reconnect manually.'); return }
        timer = setTimeout(() => void connect(), Math.min(15_000, 500 * 2 ** attempt++) * (0.75 + Math.random() * 0.5))
        setSocketStatus('Ticket request failed; reconnecting')
        return
      }
      if (disposed) return
      const url = new URL(`/api/objects/Counter/${id}`, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url, ['celld-v1', ticket])
      setSocketStatus('Connecting')
      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'authenticate', token }))
        heartbeat = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resync' })) }, 30_000)
      }
      socket.onmessage = event => {
        try {
          const snapshot = JSON.parse(String(event.data))
          const previous = sequence.current
          if (snapshot.sequence < previous) historyLost.current = true
          sequence.current = Math.max(previous, snapshot.sequence)
          const recovery = historyLost.current ? 'History regressed: acknowledged data may be missing.'
            : snapshot.sequence > previous + 1 ? 'Sequence gap: replaced local view with full snapshot.' : 'Snapshot synchronized.'
          setSocketStatus(`${recovery} Sequence ${snapshot.sequence}; value ${snapshot.value}`)
          attempt = 0
        } catch { setSocketStatus('Invalid server snapshot') }
      }
      socket.onclose = () => {
        clearInterval(heartbeat)
        if (disposed) return
        if (attempt >= 5) { setSocketStatus('Reconnect limit reached. Disconnect and reconnect manually.'); return }
        const delay = Math.min(15_000, 500 * 2 ** attempt++) * (0.75 + Math.random() * 0.5)
        setSocketStatus('Disconnected; reconnecting with reauthentication')
        timer = setTimeout(() => void connect(), delay)
      }
    }
    void connect()
    return () => { disposed = true; clearTimeout(timer); clearInterval(heartbeat); socket?.close() }
  }, [id, token, live])

  async function request(kind: 'objects/Counter' | 'workflows/Validation', command?: object) {
    if (!/^test-[A-Za-z0-9_-]{1,64}$/.test(id) || token.length < 32) { setResult('Enter a valid test ID and lab token.'); return }
    try {
      const response = await fetch(`/api/${kind}/${id}`, {
        headers: { authorization: `Bearer ${token}` },
        ...(command ? { method: 'POST', body: JSON.stringify(command) } : {}),
      })
      const content = response.headers.get('content-type')?.includes('application/json')
        ? JSON.stringify(await response.json()) : await response.text()
      setResult(`${response.status}: ${content}`)
    } catch { setResult('Ambiguous failure. Inspect state, then retry the SAME operation ID; do not blindly create a new command.') }
  }
  return <section aria-label="Stateful laboratory">
    <h2>Durable Objects and Cloudflare-compatible Workflows</h2>
    <p>Token remains in component memory only. This sandbox has no business effects.</p>
    <label>Lab token <input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label><br />
    <label>Object and workflow ID <input value={id} onChange={event => setId(event.target.value)} /></label><br />
    <label>Operation ID <input value={operationId} onChange={event => setOperationId(event.target.value)} /></label>
    <button onClick={() => setOperationId(crypto.randomUUID())}>New operation ID</button>
    <button disabled={!operationId} onClick={() => void request('objects/Counter', { operationId, delta: 1 })}>Increment (same ID deduplicates)</button>
    <button onClick={() => void request('objects/Counter')}>Inspect counter</button><br />
    <button onClick={() => void request('workflows/Validation', { action: 'start' })}>Start workflow</button>
    <button onClick={() => void request('workflows/Validation', { action: 'approve', approved: true })}>Approve workflow</button>
    <button onClick={() => void request('workflows/Validation')}>Inspect workflow</button><br />
    <button onClick={() => setLive(value => !value)}>{live ? 'Disconnect updates' : 'Connect updates'}</button>
    <p aria-live="polite">{socketStatus}</p>
    <pre aria-live="polite" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result}</pre>
    <p>Sequence gaps can be detected, not recovered automatically. Replication can lose operation IDs too.</p>
  </section>
}
