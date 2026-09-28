import { useState } from 'react'

type Region = 'us-east-1' | 'us-west-2'
export function WorkflowLab() {
  const [token, setToken] = useState('')
  const [runId, setRunId] = useState('')
  const [region, setRegion] = useState<Region>('us-east-1')
  const [approvalId, setApprovalId] = useState('')
  const [result, setResult] = useState('No workflow request yet.')
  const [busy, setBusy] = useState(false)
  async function invoke(action: 'start' | 'timer' | 'inspect' | 'signal' | 'approve' | 'reject') {
    setBusy(true)
    try {
      const id = runId || `test-${crypto.randomUUID()}`
      setRunId(id)
      const headers = { authorization: `Bearer ${token}`, 'x-ha-region': region, 'content-type': 'application/json' }
      const command = action === 'start' || action === 'timer' ? { action: 'start', runId: id, workflowId: action === 'timer' ? 'timer-v1' : 'validation-v1' } :
        action === 'signal' ? { action, runId: id, signalId: `continue-${id}`, message: 'Hello from the workflow lab' } :
          { action: 'approve', runId: id, approvalId, approved: action === 'approve' }
      const response = await fetch(action === 'inspect' ? `/api/workflows?runId=${encodeURIComponent(id)}` : '/api/workflows', {
        method: action === 'inspect' ? 'GET' : 'POST', headers,
        ...(action === 'inspect' ? {} : { body: JSON.stringify(command) }),
      })
      const data: unknown = await response.json()
      setResult(JSON.stringify({ status: response.status, servedBy: response.headers.get('x-served-by-region'), data }, null, 2))
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
    <pre role="status">{result}</pre>
    <p>The token stays in memory only. Runs contain test data, not business side effects. Timers use on-demand wakeups with minute-level precision.</p>
  </section>
}
