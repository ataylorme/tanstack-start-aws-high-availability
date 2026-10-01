import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'

export interface RegionalOutageManifest {
  prefix: string
  profile: string
  accountId: string
  region: 'us-east-1' | 'us-west-2'
  appFunctionName: string
  originalConcurrency: number | null
  mappings: { uuid: string; originalState: 'Enabled' }[]
  deadline: number
  restored: boolean
  experimentId?: string
  restoration?: { restored: boolean; errors: string[]; finishedAt: string }
}
export type RestoreAws = (region: string, args: string[]) => unknown | Promise<unknown>
export function validateManifest(value: unknown): RegionalOutageManifest {
  assert.ok(value && typeof value === 'object')
  const m = value as RegionalOutageManifest
  assert.match(m.prefix, /^[a-z][a-z0-9-]{0,39}$/)
  assert.notEqual(m.prefix, 'tanstack-ha')
  assert.match(m.profile, /^[a-zA-Z0-9_.@-]{1,128}$/)
  assert.match(m.accountId, /^\d{12}$/)
  assert.ok(m.region === 'us-east-1' || m.region === 'us-west-2')
  assert.ok(typeof m.appFunctionName === 'string' && m.appFunctionName.startsWith(`${m.prefix}-`) && /^[a-zA-Z0-9-_]{1,64}$/.test(m.appFunctionName))
  assert.ok(m.originalConcurrency === null || Number.isSafeInteger(m.originalConcurrency) && m.originalConcurrency >= 0)
  assert.ok(Array.isArray(m.mappings) && m.mappings.length === 4)
  for (const mapping of m.mappings) {
    assert.match(mapping.uuid, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
    assert.equal(mapping.originalState, 'Enabled')
  }
  assert.equal(new Set(m.mappings.map(x => x.uuid)).size, 4)
  assert.ok(Number.isSafeInteger(m.deadline) && m.deadline > 0)
  assert.equal(typeof m.restored, 'boolean')
  if (m.experimentId !== undefined) assert.match(m.experimentId, /^[a-zA-Z0-9-]{1,128}$/)
  return m
}
function object(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === 'object')
  return value as Record<string, any>
}
export async function restoreRegionalResources(manifest: RegionalOutageManifest, aws: RestoreAws,
  timing = { sleep: (ms: number) => setTimeout(ms), now: () => Date.now(), fisTimeoutMs: 600_000, mappingTimeoutMs: 180_000 }) {
  const m = validateManifest(manifest)
  const errors: string[] = []
  async function restore(name: string, action: () => Promise<void>) {
    let last: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await action(); return } catch (error) { last = error; if (attempt < 2) await timing.sleep(3000) }
    }
    errors.push(`${name}: ${last instanceof Error ? last.message : String(last)}`)
  }
  // Stop faults before restoring service. Other restorations still run if FIS fails.
  const fisDeadline = timing.now() + timing.fisTimeoutMs
  if (m.experimentId) await restore('FIS stop', async () => {
    const args = ['--id', m.experimentId!]
    const terminal = new Set(['completed', 'stopped', 'failed', 'cancelled'])
    let state = object(object(await aws(m.region, ['fis', 'get-experiment', ...args])).experiment).state.status
    if (!terminal.has(state)) await aws(m.region, ['fis', 'stop-experiment', ...args])
    const deadline = fisDeadline
    while (!terminal.has(state)) {
      if (timing.now() >= deadline) throw new Error('Experiment did not reach terminal state')
      await timing.sleep(5000)
      state = object(object(await aws(m.region, ['fis', 'get-experiment', ...args])).experiment).state.status
    }
  })
  await restore('app concurrency', async () => {
    await aws(m.region, ['lambda', m.originalConcurrency === null ? 'delete-function-concurrency' : 'put-function-concurrency', '--function-name', m.appFunctionName,
      ...(m.originalConcurrency === null ? [] : ['--reserved-concurrent-executions', String(m.originalConcurrency)])])
    const result = object(await aws(m.region, ['lambda', 'get-function-concurrency', '--function-name', m.appFunctionName]))
    assert.equal(result.ReservedConcurrentExecutions ?? null, m.originalConcurrency)
  })
  for (const mapping of m.mappings) await restore(`mapping ${mapping.uuid}`, async () => {
    let state = object(await aws(m.region, ['lambda', 'get-event-source-mapping', '--uuid', mapping.uuid])).State
    const deadline = timing.now() + timing.mappingTimeoutMs
    while (state !== 'Enabled') {
      if (state === 'Disabled') await aws(m.region, ['lambda', 'update-event-source-mapping', '--uuid', mapping.uuid, '--enabled'])
      if (timing.now() >= deadline) throw new Error('Mapping did not become Enabled')
      await timing.sleep(3000)
      state = object(await aws(m.region, ['lambda', 'get-event-source-mapping', '--uuid', mapping.uuid])).State
    }
  })
  return { restored: errors.length === 0, errors, finishedAt: new Date().toISOString() }
}
export async function main(args: string[]) {
  const [mode, filename] = args
  assert.ok((mode === '--watchdog' || mode === '--restore') && filename && args.length === 2, 'Usage: --watchdog|--restore <manifest.json>')
  const file = resolve(filename)
  let manifest = validateManifest(JSON.parse(readFileSync(file, 'utf8')))
  const aws: RestoreAws = (region, argv) => {
    const output = execFileSync('aws', ['--profile', manifest.profile, '--region', region, ...argv, '--output', 'json'], { encoding: 'utf8', timeout: 45_000, env: { ...process.env, AWS_PAGER: '' } }).trim()
    return output ? JSON.parse(output) : {}
  }
  assert.equal(object(await aws(manifest.region, ['sts', 'get-caller-identity'])).Account, manifest.accountId, 'AWS account mismatch')
  if (mode === '--watchdog') writeFileSync(`${file}.watchdog-ready`, String(process.pid), { mode: 0o600 })
  const identity = JSON.stringify([manifest.prefix, manifest.profile, manifest.accountId, manifest.region, manifest.appFunctionName, manifest.originalConcurrency, manifest.mappings, manifest.deadline])
  while (mode === '--watchdog' && !manifest.restored && Date.now() < manifest.deadline) {
    await setTimeout(Math.min(3000, manifest.deadline - Date.now()))
    manifest = validateManifest(JSON.parse(readFileSync(file, 'utf8')))
    assert.equal(JSON.stringify([manifest.prefix, manifest.profile, manifest.accountId, manifest.region, manifest.appFunctionName, manifest.originalConcurrency, manifest.mappings, manifest.deadline]), identity, 'Restoration targets changed')
  }
  if (manifest.restored) return
  const restoration = await restoreRegionalResources(manifest, aws)
  // Preserve orchestrator evidence added while restoration was running.
  const latest = JSON.parse(readFileSync(file, 'utf8'))
  const temporary = `${file}.restore-${process.pid}`
  writeFileSync(temporary, JSON.stringify({ ...latest, restored: restoration.restored, restoration }, null, 2), { mode: 0o600 })
  chmodSync(temporary, 0o600); renameSync(temporary, file)
  console.log(`Restoration ${restoration.restored ? 'passed' : 'failed'}; evidence saved to manifest`)
  if (!restoration.restored) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
