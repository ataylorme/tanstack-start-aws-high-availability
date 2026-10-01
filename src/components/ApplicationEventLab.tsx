import { OrderedEventLab } from './OrderedEventLab'
import { useState } from 'react'
import { eventEnvelope, eventRequest, oppositeRegion, sameEvent, type EventRegion, type TestEventInput, type TestEventEnvelope } from '../events/lab-client'

export function ApplicationEventLab() {
  const [token, setToken] = useState('')
  const [region, setRegion] = useState<EventRegion>('us-east-1')
  const [message, setMessage] = useState('Hello from the application event lab')
  const [command, setCommand] = useState<TestEventInput>()
  const [published, setPublished] = useState<TestEventEnvelope>()
  const [publishedRegion, setPublishedRegion] = useState<EventRegion>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('Paste the test token, then publish an event.')
  const [result, setResult] = useState('No application-event request yet.')
  const [retry, setRetry] = useState('Not tested')
  const [conflict, setConflict] = useState('Not tested')
  const [delivery, setDelivery] = useState('Not checked')
  const [observed, setObserved] = useState(false)

  async function invoke(action: 'publish' | 'retry' | 'conflict' | 'delivery') {
    setBusy(true)
    setNotice('Sending request…')
    try {
      const input = command ?? { id: `test-${crypto.randomUUID()}`, message }
      setCommand(input) // Preserve the ID and payload even if the response is lost.
      const requestRegion = action === 'retry' ? oppositeRegion(publishedRegion ?? region) : region
      const payload = action === 'delivery' ? { id: input.id } : action === 'conflict'
        ? { ...input, message: input.message === 'Conflict probe' ? 'Different conflict probe' : 'Conflict probe' } : input
      const response = await eventRequest(token, requestRegion, payload, action === 'delivery')
      setResult(JSON.stringify(response, null, 2))
      if ([200, 202, 409].includes(response.status) && response.servedBy !== requestRegion) throw new Error('The response was not served by the requested region; this is not a regional pass.')
      if (action === 'conflict') {
        if (response.status !== 409) { setConflict('Failed — expected HTTP 409'); throw new Error(`Expected conflict rejection (409), received ${response.status}.`) }
        setConflict('Passed — changed payload rejected (409)')
        setNotice('The same ID with different content was rejected. The original event is unchanged.')
        return
      }
      if (response.status !== (action === 'delivery' ? 200 : 202)) {
        throw new Error(`Request returned HTTP ${response.status}. ${response.status === 401 ? 'Check the test token.' : 'See the response below. Retry the same event ID after an uncertain failure.'}`)
      }
      if (action === 'delivery') {
        const data = response.data
        if (data && typeof data === 'object' && 'status' in data && data.status === 'pending') {
          if (!observed) setDelivery('Not observed yet — check again')
          setNotice('No matching message in this queue sample. This is inconclusive, not a delivery failure. Wait a few seconds and check again.')
        } else if (data && typeof data === 'object' && 'status' in data && data.status === 'observed' && 'event' in data) {
          const observed = eventEnvelope(data.event)
          if (!published || !sameEvent(published, observed)) throw new Error('The queue envelope does not match the published event.')
          setObserved(true)
          setDelivery('Passed — matching full envelope observed in SQS')
          setNotice('The real stream consumer delivered the matching event to SQS. This proves delivery, not exactly-once business processing.')
        } else throw new Error('Unexpected delivery response.')
        return
      }
      const envelope = eventEnvelope(response.data)
      if (envelope.id !== input.id || envelope.data.message !== input.message) throw new Error('The published envelope does not match the submitted event.')
      if (published && !sameEvent(published, envelope)) { setRetry('Failed — envelope changed'); throw new Error('Retry changed the committed envelope or timestamp.') }
      if (!published) setPublishedRegion(requestRegion)
      setPublished(envelope)
      if (action === 'retry' && published) {
        setRetry(`Passed — original envelope returned from ${requestRegion}`)
        setNotice('Cross-region retry preserved the original ID, payload, and timestamp. It does not create a second stream INSERT.')
      } else setNotice(`Stored in ${requestRegion} (202). Now check SQS delivery; publication alone does not prove delivery.`)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Request failed'
      if (action === 'delivery' && !observed) setDelivery('Check failed — retry or inspect response')
      if (action === 'retry') setRetry('Check failed — retry or inspect response')
      setNotice(text)
    } finally { setBusy(false) }
  }
  function reset() {
    setObserved(false); setCommand(undefined); setPublished(undefined); setPublishedRegion(undefined); setRetry('Not tested'); setConflict('Not tested'); setDelivery('Not checked')
    setResult('No application-event request yet.'); setNotice('Ready for a new event. Previous test data is retained.')
  }
  return <section className="details workflow-lab event-lab" aria-labelledby="event-lab-title">
    <p className="eyebrow">APPLICATION EVENTS / PR #4</p>
    <h2 id="event-lab-title">Application event lab</h2>
    <p>Publish a fact in one region, retry it in the other, and observe the matching envelope after the real DynamoDB Stream consumer sends it to SQS.</p>
    <ol className="event-steps"><li>Publish an event</li><li>Test retry and conflict</li><li>Check SQS delivery</li></ol>
    <label>Application event test token <input type="password" autoComplete="off" spellCheck={false} value={token} disabled={busy} onChange={event => setToken(event.target.value)} /></label>
    <p className="event-help">Use the same sandbox token as the workflow lab. It stays in memory only and is cleared on reload.</p>
    <label>Publish region <select value={region} disabled={busy || !!command} onChange={event => {
      if (event.target.value === 'us-east-1' || event.target.value === 'us-west-2') setRegion(event.target.value)
    }}><option value="us-east-1">us-east-1</option><option value="us-west-2">us-west-2</option></select></label>
    <label>Event message <input value={message} maxLength={200} disabled={busy || !!command} onChange={event => setMessage(event.target.value)} /></label>
    <p className="event-help">The payload and initial region are locked after the first attempt so retries are safe. Choose New event to edit it.</p>
    <dl><dt>Event ID</dt><dd>{command?.id ?? 'Generated when you publish'}</dd><dt>Publication</dt><dd>{published ? `Stored at ${published.timestamp}` : command ? 'Unconfirmed — retry the same ID' : 'Not published'}</dd><dt>Retry</dt><dd>{retry}</dd><dt>Conflict</dt><dd>{conflict}</dd><dt>SQS delivery</dt><dd>{delivery}</dd></dl>
    <div className="workflow-actions">
      <button disabled={busy || !token} onClick={() => void invoke('publish')}>{command ? 'Retry same ID in selected region' : 'Publish event'}</button>
      <button disabled={busy || !token || !command} onClick={() => void invoke('retry')}>Retry same ID in {oppositeRegion(publishedRegion ?? region)}</button>
      <button disabled={busy || !token || !published} onClick={() => void invoke('conflict')}>Test conflicting payload</button>
      <button disabled={busy || !token || !published} onClick={() => void invoke('delivery')}>Check SQS delivery</button>
      <button disabled={busy} onClick={reset}>New event</button>
    </div>
    <p role="status" aria-live="polite" aria-atomic="true">{notice}</p>
    <details><summary>Latest response (status, serving region, envelope)</summary><pre>{result}</pre></details>
    <p className="event-help">Delivery checks sample up to ten messages in the dedicated test queue and may hide them for five seconds. They never delete messages. Another test runner may already have consumed an event; not observed is inconclusive. Delivery is at least once. No fault injection or business side effects are triggered here.</p>
    <OrderedEventLab token={token} region={region} />
  </section>
}
