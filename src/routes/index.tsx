import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { WorkflowLab } from '../components/WorkflowLab'
import { regionInfo } from '../lib/origin'

const getRegion = createServerFn({ method: 'GET' }).handler(() => regionInfo(process.env))
const echoRegion = createServerFn({ method: 'POST' }).handler(() => regionInfo(process.env))

export const Route = createFileRoute('/')({
  loader: () => getRegion(),
  component: Home,
})

function Home() {
  const info = Route.useLoaderData()
  const router = useRouter()
  const [writeResult, setWriteResult] = useState('Not yet invoked')
  const [busy, setBusy] = useState(false)
  async function invokeWrite() {
    setBusy(true)
    try {
      const result = await echoRegion()
      setWriteResult(`POST handled in ${result.region} at ${result.timestamp}`)
    } catch {
      setWriteResult('POST failed. CloudFront does not retry writes in the other region.')
    } finally {
      setBusy(false)
    }
  }
  return <main>
    <p className="eyebrow">TANSTACK START / AWS REFERENCE EXAMPLE</p>
    <h1>Two regions.<br />One application.</h1>
    <p className="intro">Server-rendered React on containerized Lambda, connected by CloudFront and Lambda@Edge.</p>
    <section aria-label="Request details" className="card">
      <span className="badge">THIS REQUEST WAS SERVED BY</span>
      <h2>{info.region}</h2>
      <dl><dt>Release</dt><dd>{info.release}</dd><dt>Server time</dt><dd>{info.timestamp}</dd></dl>
      <button onClick={() => void router.invalidate()}>Refresh server data</button>
    </section>
    <nav className="regions" aria-label="Choose serving region">
      <a href="/?region=us-east-1" aria-current={info.region === 'us-east-1' ? 'true' : undefined}>us-east-1 / Northern Virginia</a>
      <a href="/?region=us-west-2" aria-current={info.region === 'us-west-2' ? 'true' : undefined}>us-west-2 / Oregon</a>
    </nav>
    <section className="details"><h2>Active / active, with honest boundaries</h2>
      <p>Client-IP affinity distributes clients between both regions. If a read fails, CloudFront attempts the other region. Dynamic responses are not cached.</p>
      <p>GET, HEAD, and OPTIONS can fail over. POST and other writes are never automatically replayed. This stateless demo has no shared database or session store.</p>
      <button disabled={busy} onClick={() => void invokeWrite()}>{busy ? 'Invoking…' : 'Test POST server function'}</button>
      <p role="status">{writeResult}</p>
      <a href="/healthz">Inspect this origin’s health response →</a>
    </section>
    <WorkflowLab />
  </main>
}
