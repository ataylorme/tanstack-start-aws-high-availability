import { useState } from 'react'
import { oppositeRegion, type EventRegion } from '../events/lab-client'
export function OrderedEventLab({ token, region }: { token: string; region: EventRegion }) {
  const [runId, setRunId] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('Publish a lifecycle to begin.')
  async function invoke(action: string) {
    setBusy(true)
    const id = runId || `test-ordered-${crypto.randomUUID()}`; setRunId(id)
    const requestedRegion = action === 'retry' || action === 'recover' ? oppositeRegion(region) : region
    try {
      const response = await fetch('/api/application-events/ordered', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ha-region': requestedRegion }, body: JSON.stringify({ runId: id, action }), signal: AbortSignal.timeout(60_000) })
      const data = await response.json()
      setResult(JSON.stringify({ status: response.status, requestedRegion, servedBy: response.headers.get('x-served-by-region'), regionalMatch: response.headers.get('x-served-by-region') === requestedRegion, ...data }, null, 2))
    } catch (error) { setResult(`${error instanceof Error ? error.message : 'Request failed'}. Retry the same run ID; retained state is not reset.`) }
    finally { setBusy(false) }
  }
  return <section aria-labelledby="ordered-lab-title">
    <h3 id="ordered-lab-title">Ordered lifecycle / rc.1</h3>
    <p>Requested → approved → started → completed. Run the probes, deliver notification 4 first, then replay 1. Durable receipts show retained-source payloads and independent subscriber cursors. Retry and recovery use the opposite region.</p>
    <p>Run ID: {runId || 'Generated on first request'}</p>
    <div className="workflow-actions">{[['publish', 'Publish four phases'], ['retry', 'Cross-region identical retry'], ['gap', 'Reject sequence gap'], ['wrong-type', 'Reject wrong phase type'], ['conflict', 'Reject changed payload'], ['deliver', 'Deliver 4 first (forged notification payload)'], ['duplicate', 'Replay old notification 1'], ['block', 'Block synthetic subscriber at 2'], ['recover', 'Safely retry blocked synthetic effect'], ['inspect', 'Inspect cursors and transport receipts']].map(([action, label]) => <button key={action} disabled={busy || !token || (!runId && action !== 'publish')} onClick={() => void invoke(action!)}>{label}</button>)}<button disabled={busy} onClick={() => { setRunId(''); setResult('Ready. Prior streams and receipts remain retained.') }}>New ordered stream</button></div>
    <p>Recovery is restricted to a dedicated synthetic handler that throws before any effect. This is not a general operator resolution endpoint. Claims never expire automatically. Receipt creation is idempotent; no exactly-once guarantee is made for external systems.</p>
    <details open><summary>Ordered results, durable cursors, receipts and serving region</summary><pre role="status">{result}</pre></details>
  </section>
}
