import { useState } from 'react'

type Region = 'us-east-1' | 'us-west-2'
export function WorkflowLab() {
  const [token, setToken] = useState('')
  const [runId, setRunId] = useState('')
  const [region, setRegion] = useState<Region>('us-east-1')
  const [approvalId, setApprovalId] = useState('')
  const [result, setResult] = useState('No workflow request yet.')
  const [scenario, setScenario] = useState('outbox-v1')
  const [timing, setTiming] = useState('interval')
  const [overlap, setOverlap] = useState('skip')
  const [missed, setMissed] = useState('run-once')
  const [successor, setSuccessor] = useState('')
  const [busy, setBusy] = useState(false)
  async function invoke(action: 'start' | 'timer' | 'inspect' | 'signal' | 'approve' | 'reject' | 'feature' | 'schedule' | 'disable' | 'inspect-schedule') {
    setBusy(true)
    try {
      const id = runId || `test-${crypto.randomUUID()}`
      setRunId(id)
      const headers = { authorization: `Bearer ${token}`, 'x-ha-region': region, 'content-type': 'application/json' }
      const command = action === 'feature' ? { action: 'start', runId: id, workflowId: scenario } :
        action === 'schedule' || action === 'disable' ? { action: 'schedule', runId: id, enabled: action === 'schedule', timing, overlap, missed } :
        action === 'start' || action === 'timer' ? { action: 'start', runId: id, workflowId: action === 'timer' ? 'timer-v1' : 'validation-v1' } :
        action === 'signal' ? { action, runId: id, signalId: `continue-${id}`, message: 'Hello from the workflow lab' } :
          { action: 'approve', runId: id, approvalId, approved: action === 'approve' }
      const inspecting = action === 'inspect' || action === 'inspect-schedule'
      const response = await fetch(inspecting ? `/api/workflows?${action === 'inspect-schedule' ? 'scheduleId' : 'runId'}=${encodeURIComponent(id)}` : '/api/workflows', {
        method: inspecting ? 'GET' : 'POST', headers,
        ...(inspecting ? {} : { body: JSON.stringify(command) }),
      })
      const data: unknown = await response.json()
      setResult(JSON.stringify({ status: response.status, servedBy: response.headers.get('x-served-by-region'), data }, null, 2))
      const run = data && typeof data === 'object' && 'run' in data ? data.run : undefined
      const output = run && typeof run === 'object' && 'output' in run ? run.output : undefined
      setSuccessor(output && typeof output === 'object' && '$workflowEffect' in output && output.$workflowEffect === 'continue' && 'runId' in output && typeof output.runId === 'string' ? output.runId : '')
      if (action === 'inspect') setApprovalId(data && typeof data === 'object' && 'approvalId' in data && typeof data.approvalId === 'string' ? data.approvalId : '')
    } catch (error) { setResult(error instanceof Error ? error.message : 'Workflow request failed') }
    finally { setBusy(false) }
  }
  return <section className="details workflow-lab" aria-label="Workflow integration lab">
    <h2>TanStack Workflow AWS integration lab</h2>
    <p>Experimental, token-protected test environment. Start → signal → inspect → approve → wait for the demand-driven wakeup → inspect. Change the request region between steps to test shared durable state.</p>
    <label>Test token <input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label>
    <label>Run ID <input value={runId} placeholder="Generated on first request" onChange={event => setRunId(event.target.value)} /></label>
    <label>Request region <select value={region} onChange={event => {
      if (event.target.value === 'us-east-1' || event.target.value === 'us-west-2') setRegion(event.target.value)
    }}><option value="us-east-1">us-east-1</option><option value="us-west-2">us-west-2</option></select></label>
    <div className="workflow-actions">
      <button disabled={busy || !token} onClick={() => void invoke('start')}>Start validation workflow</button>
      <button disabled={busy || !token} onClick={() => void invoke('timer')}>Start timer workflow</button>
      <button disabled={busy || !token || !runId} onClick={() => void invoke('signal')}>Send signal</button>
      <button disabled={busy || !token || !runId} onClick={() => void invoke('inspect')}>Inspect run</button>
      <button disabled={busy || !token || !approvalId} onClick={() => void invoke('approve')}>Approve</button>
      <button disabled={busy || !token || !approvalId} onClick={() => void invoke('reject')}>Reject</button>
      <button disabled={busy} onClick={() => { setRunId(''); setApprovalId(''); setResult('Ready for a new run.') }}>New run</button>
    </div>
    <h3>0.2 lifecycle fixtures</h3>
    <label>Scenario <select value={scenario} onChange={event => setScenario(event.target.value)}>
      <option value="outbox-v1">Committed event outbox</option>
      <option value="continuation-v1">Continue as new (one successor)</option>
      <option value="history-limit-v1">History limit (expected error)</option>
    </select></label>
    <button disabled={busy || !token} onClick={() => void invoke('feature')}>Start lifecycle fixture</button>
    <button disabled={busy || !successor} onClick={() => { setRunId(successor); setSuccessor('') }}>Follow successor run</button>
    <p>Use a new run ID per fixture. Outbox delivery is asynchronous; inspect the event consumer receipt using the output eventId. Continue-as-new returns an intent, not a final business result. Follow the successor then inspect its fresh history. The history-limit fixture must end errored.</p>
    <h3>Recurring schedules</h3>
    <label>Timing <select value={timing} onChange={event => setTiming(event.target.value)}><option value="interval">5-minute UTC interval</option><option value="cron">5-minute cron, America/Los_Angeles</option></select></label>
    <label>Overlap <select value={overlap} onChange={event => setOverlap(event.target.value)}><option>skip</option><option>allow</option></select></label>
    <label>Missed ticks <select value={missed} onChange={event => setMissed(event.target.value)}><option>skip</option><option>run-once</option><option>catch-up</option></select></label>
    <button disabled={busy || !token} onClick={() => void invoke('schedule')}>Materialize / update schedule</button>
    <button disabled={busy || !token || !runId} onClick={() => void invoke('disable')}>Disable schedule</button>
    <button disabled={busy || !token || !runId} onClick={() => void invoke('inspect-schedule')}>Inspect schedule generation</button>
    <p>Run ID doubles as schedule ID. Identical registration is idempotent; changed policies create a new generation. Catch-up is capped at two. Schedules repeat until disabled: disable after testing. Production-safe retention preserves terminal runs for seven days and tombstones for thirty days; cleanup is demand-driven, not TTL.</p>
    <pre role="status">{result}</pre>
    <p>The token stays in memory only. Runs contain test data, not business side effects. Timers use on-demand wakeups with minute-level precision.</p>
  </section>
}
