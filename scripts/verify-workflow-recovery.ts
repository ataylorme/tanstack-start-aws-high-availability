import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: pause ONE isolated workflow wakeup queue mapping, start a timer there, prove the other regional worker completes it, restore in finally, then reverse. Requires STACK_PREFIX, WORKFLOW_TEST_TOKEN_FILE, HTTPS site and --execute. Never runs on tanstack-ha.')
  process.exit(0)
}
const prefix = process.env.STACK_PREFIX
assert.ok(prefix && /^[a-z][a-z0-9-]{0,39}$/.test(prefix) && prefix !== 'tanstack-ha', 'Explicit isolated STACK_PREFIX required')
const site = new URL(process.argv[2] ?? '')
assert.equal(site.protocol, 'https:')
const tokenFile = process.env.WORKFLOW_TEST_TOKEN_FILE
assert.ok(tokenFile)
const token = readFileSync(tokenFile, 'utf8').trim()
assert.match(token, /^[a-f0-9]{64}$/)
const regions = ['us-east-1', 'us-west-2'] as const
function aws(region: string, args: string[]) {
  return execFileSync('aws', ['--region', region, ...args], { encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' } }).trim()
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
async function waitForMapping(region: string, uuid: string, expected: string) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const state = aws(region, ['lambda', 'get-event-source-mapping', '--uuid', uuid, '--query', 'State', '--output', 'text'])
    if (state === expected) return
    await setTimeout(3000)
  }
  throw new Error(`Mapping did not reach ${expected} in ${region}`)
}
const mappings = new Map<string, string>()
for (const region of regions) {
  const mapping = aws(region, ['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-sweeper`, '--query', "Stacks[0].Outputs[?OutputKey=='WakeupMappingId'].OutputValue | [0]", '--output', 'text'])
  assert.ok(mapping && mapping !== 'None')
  assert.equal(aws(region, ['lambda', 'get-event-source-mapping', '--uuid', mapping, '--query', 'State', '--output', 'text']), 'Enabled')
  mappings.set(region, mapping)
}
const outcomes: { pausedRegion: string; runId: string; output: Record<string, unknown> }[] = []
for (const pausedRegion of regions) {
  const healthyRegion = pausedRegion === 'us-east-1' ? 'us-west-2' : 'us-east-1'
  const mapping = mappings.get(pausedRegion)
  assert.ok(mapping)
  const runId = `test-recovery-${randomUUID()}`
  try {
    aws(pausedRegion, ['lambda', 'update-event-source-mapping', '--uuid', mapping, '--no-enabled'])
    await waitForMapping(pausedRegion, mapping, 'Disabled')
    // Allow in-flight Lambda invocations to exceed the worker timeout before new work.
    await setTimeout(65_000)
    const started = await fetch(new URL('/api/workflows', site), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ha-region': pausedRegion },
      body: JSON.stringify({ action: 'start', workflowId: 'timer-v1', runId }), signal: AbortSignal.timeout(60000),
    })
    assert.equal(started.status, 202, await started.text())
    const deadline = Date.now() + 240_000
    let output: Record<string, unknown> | undefined
    while (Date.now() < deadline) {
      const response = await fetch(new URL(`/api/workflows?runId=${runId}`, site), {
        headers: { authorization: `Bearer ${token}`, 'x-ha-region': healthyRegion }, signal: AbortSignal.timeout(60000),
      })
      assert.equal(response.status, 200)
      const value: unknown = await response.json()
      const run = object(object(value).run)
      assert.notEqual(run.status, 'errored', JSON.stringify(run.error))
      if (run.status === 'finished') { output = object(run.output); break }
      await setTimeout(5000)
    }
    assert.ok(output, `Other-region demand-driven recovery timed out: ${runId}`)
    // Starting the run also wakes the healthy region; either region can claim it.
    assert.ok(regions.includes(object(output.started).region as typeof regions[number]))
    assert.equal(object(output.firstWake).region, healthyRegion)
    assert.equal(object(output.finished).region, healthyRegion)
    outcomes.push({ pausedRegion, runId, output })
    console.log(`${pausedRegion} wakeup mapping paused; ${healthyRegion} completed both sleeps: ${runId}`)
  } finally {
    aws(pausedRegion, ['lambda', 'update-event-source-mapping', '--uuid', mapping, '--enabled'])
    await waitForMapping(pausedRegion, mapping, 'Enabled')
  }
}
mkdirSync('.deploy', { recursive: true })
const report = `.deploy/workflow-recovery-${Date.now()}.json`
writeFileSync(report, JSON.stringify({ site: site.origin, testedAt: new Date().toISOString(), outcomes, bothMappingsRestored: true }, null, 2))
console.log(`Evidence: ${report}`)
