import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { StatefulLab } from '../StatefulLab'

const inspectRuntime = createServerFn({ method: 'GET' }).handler(() => ({
  timestamp: new Date().toISOString(),
  message: 'TanStack Start server function executed',
}))
const invokeMutation = createServerFn({ method: 'POST' }).handler(() => ({
  message: 'POST server function executed', timestamp: new Date().toISOString(),
}))

export const Route = createFileRoute('/')({ loader: () => inspectRuntime(), component: Lab })

function Lab() {
  const initial = Route.useLoaderData()
  const [result, setResult] = useState('Not invoked')
  const [busy, setBusy] = useState(false)
  async function invoke() {
    setBusy(true)
    try { const value = await invokeMutation(); setResult(`${value.message} at ${value.timestamp}`) }
    catch { setResult('Server function failed; no automatic mutation replay.') }
    finally { setBusy(false) }
  }
  async function inspectCompatibility() {
    try {
      await fetch('/compat/cookie')
      const cookie = await (await fetch('/compat/cookie/inspect')).json()
      const redirected = await fetch('/compat/redirect')
      const apis = await (await fetch('/compat/apis')).json()
      setResult(`Cookie: ${cookie.present}; redirect followed: ${redirected.redirected}; bindings: ${JSON.stringify(apis.bindings)}`)
    } catch { setResult('Compatibility probe failed') }
  }
  return <main>
    <h1>TanStack Start on celld</h1>
    <p>Independent AWS runtime and regional recovery experiment.</p>
    <section aria-label="Runtime compatibility">
      <h2>SSR and server functions</h2>
      <p>{initial.message} at <time>{initial.timestamp}</time></p>
      <button disabled={busy} onClick={() => void invoke()}>Test POST server function</button>
      <button onClick={() => void inspectCompatibility()}>Test cookies, redirect and bindings</button>
      <p role="status">{result}</p>
    </section>
    <StatefulLab />
    <p>Automatic writable regional promotion is disabled until fencing is proven.</p>
  </main>
}
