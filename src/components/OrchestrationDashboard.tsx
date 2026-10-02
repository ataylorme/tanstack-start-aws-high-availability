import { useEffect, useRef, useState } from 'react'
import { createOrchestrationClient } from '../orchestration/client'
import type { TaskView } from '../orchestration/types'

export function OrchestrationDashboard() {
  const [token, setToken] = useState('')
  const [session, setSession] = useState('')
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [desired, setDesired] = useState(1)
  const [executeAt, setExecuteAt] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('Connect to load tasks.')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(Date.now())
  const generation = useRef(0)
  const mutation = useRef<AbortController | null>(null)
  const submission = useRef<{ body: string; key: string } | null>(null)

  useEffect(() => () => { generation.current++; mutation.current?.abort() }, [])
  useEffect(() => {
    const version = ++generation.current
    if (!session || busy) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const result = await createOrchestrationClient(session).list(controller.signal)
        if (version !== generation.current || controller.signal.aborted) return
        setTasks(result.tasks)
        setNow(Date.now())
        setLoadError('')
        setNotice('Tasks refreshed. Updates poll every 5 seconds.')
      } catch (caught) {
        if (version !== generation.current || controller.signal.aborted) return
        setLoadError(caught instanceof Error ? caught.message : 'Unable to load tasks')
      } finally {
        if (version === generation.current && !controller.signal.aborted) timer = setTimeout(() => void poll(), 5000)
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [session, busy, refresh])

  async function mutate(action: (client: ReturnType<typeof createOrchestrationClient>, signal: AbortSignal) => Promise<TaskView>, created = false) {
    if (busy || mutation.current || !session) return
    ++generation.current
    const controller = new AbortController()
    mutation.current = controller
    setBusy(true)
    setError('')
    try {
      const task = await action(createOrchestrationClient(session), controller.signal)
      if (controller.signal.aborted) return
      setTasks(current => [task, ...current.filter(item => item.id !== task.id)])
      setNotice(`Task ${task.id}: ${task.status.replaceAll('_', ' ')}`)
      if (created) submission.current = null
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Request failed')
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) { setBusy(false); setRefresh(value => value + 1) }
    }
  }

  function submit() {
    const date = executeAt ? new Date(executeAt) : undefined
    if (!Number.isInteger(desired) || desired < 1 || desired > 5 || (date && !Number.isFinite(date.getTime()))) {
      setError('Choose concurrency from 1 to 5 and a valid execution time.'); return
    }
    const input = { desiredConcurrency: desired, ...(date ? { executeAt: date.toISOString() } : {}) }
    const body = JSON.stringify(input)
    if (submission.current?.body !== body) submission.current = { body, key: crypto.randomUUID() }
    const key = submission.current.key
    void mutate((client, signal) => client.create(input, key, signal), true)
  }

  return <main>
    <p className="eyebrow">DEVOPS ORCHESTRATION / SANDBOX POC</p>
    <h1>Plan. Approve. Execute.</h1>
    <p className="intro">Change sandbox Lambda reserved concurrency. Processing and approvals stay in the control plane; execution is isolated in the data plane.</p>
    <section className="details workflow-lab" aria-label="Access">
      <h2>Access</h2>
      <p>Use a requester or approver token. Permissions are enforced by the server. Tokens stay in memory only.</p>
      <label>Access token <input type="password" autoComplete="off" value={token} onChange={event => {
        ++generation.current; mutation.current?.abort(); mutation.current = null; setLoadError(''); setBusy(false); setSession(''); setTasks([]); setError(''); submission.current = null; setToken(event.target.value)
      }} /></label>
      <button disabled={!token || busy} onClick={() => { setSession(token); setRefresh(value => value + 1) }}>Connect / refresh</button>
      <button disabled={!token} onClick={() => {
        ++generation.current; mutation.current?.abort(); mutation.current = null; setLoadError(''); setToken(''); setSession(''); setTasks([]); setBusy(false); setError(''); setNotice('Disconnected.'); submission.current = null
      }}>Disconnect</button>
    </section>
    <section className="details workflow-lab" aria-label="Request capacity change">
      <h2>Request capacity change</h2>
      <form onSubmit={event => { event.preventDefault(); submit() }}>
        <label>Desired concurrency (1–5) <input type="number" required min={1} max={5} step={1} value={desired} onChange={event => setDesired(Number(event.target.value))} /></label>
        <label>Execute at (your local time, optional) <input type="datetime-local" value={executeAt} onChange={event => setExecuteAt(event.target.value)} /></label>
        <p>Leave the time blank to execute after approval. A selected time is sent as UTC. Retrying an unchanged failed submission reuses its idempotency key.</p>
        <button disabled={!session || busy} type="submit">{busy ? 'Submitting…' : 'Create task'}</button>
      </form>
    </section>
    {error && <p role="alert">{error}</p>}
    {loadError && <p role="alert">{loadError}</p>}
    <p role="status">{notice}</p>
    <section className="details" aria-label="Tasks">
      <h2>Tasks</h2>
      {!tasks.length && <p>{session ? 'No tasks loaded.' : 'Connect to see tasks.'}</p>}
      {tasks.map(task => <article className="card" key={task.id} aria-label={`Task ${task.id}`}>
        <h3 style={{ overflowWrap: 'anywhere' }}>{task.id}</h3>
        <p><strong>{task.status.replaceAll('_', ' ')}</strong> — {task.reason || 'Waiting for the next processing step.'}</p>
        {['scheduled', 'awaiting_approval'].includes(task.status) && Date.parse(task.input.executeAt) < now && <p>Requested execution time has passed; waiting for approval or processing. Late approval executes as soon as possible.</p>}
        {task.error && <p>Error: {task.error}</p>}
        <dl><dt>Requester</dt><dd>{task.input.requester}</dd><dt>Execution time (UTC)</dt><dd>{task.input.executeAt}</dd><dt>Release</dt><dd style={{ overflowWrap: 'anywhere' }}>{task.release}</dd></dl>
        {task.plan && <><h4>Plan</h4><dl><dt>Target</dt><dd style={{ overflowWrap: 'anywhere' }}>{task.plan.target}</dd><dt>Before → after</dt><dd>{task.plan.before ?? 'Unreserved'} → {task.plan.after}</dd><dt>Plan hash</dt><dd style={{ overflowWrap: 'anywhere' }}>{task.plan.hash}</dd></dl></>}
        {task.status === 'awaiting_approval' && task.plan && task.approvalId && <div className="workflow-actions">
          <button disabled={!session || busy} onClick={() => void mutate((client, signal) => client.decide(task.id, { approvalId: task.approvalId!, planHash: task.plan!.hash, approved: true }, signal))}>Approve plan</button>
          <button disabled={!session || busy} onClick={() => void mutate((client, signal) => client.decide(task.id, { approvalId: task.approvalId!, planHash: task.plan!.hash, approved: false }, signal))}>Reject plan</button>
        </div>}
        {task.decision && <p>{task.decision.approved ? 'Approved' : 'Rejected'} by {task.decision.actor}</p>}
        <h4>Timeline</h4>
        <ol>{task.timeline.map((event, index) => <li key={`${event.at}-${index}`}><time dateTime={event.at}>{event.at}</time> — {event.type}{event.step ? ` (${event.step})` : ''}</li>)}</ol>
      </article>)}
    </section>
  </main>
}
