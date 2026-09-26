import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: pause ONE isolated workflow test schedule, start a timer there, prove the other scheduled worker completes it, restore in finally, then reverse. Requires STACK_PREFIX, WORKFLOW_TEST_TOKEN_FILE, HTTPS site and --execute. Never runs on tanstack-ha.')
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
const rules = new Map<string, string>()
for (const region of regions) {
  const rule = aws(region, ['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-sweeper`, '--query', "Stacks[0].Outputs[?OutputKey=='SweepRuleName'].OutputValue | [0]", '--output', 'text'])
  assert.ok(rule && rule !== 'None')
  assert.equal(aws(region, ['events', 'describe-rule', '--name', rule, '--query', 'State', '--output', 'text']), 'ENABLED')
  rules.set(region, rule)
}
const outcomes: { pausedRegion: string; runId: string; output: Record<string, unknown> }[] = []
for (const pausedRegion of regions) {
  const healthyRegion = pausedRegion === 'us-east-1' ? 'us-west-2' : 'us-east-1'
  const rule = rules.get(pausedRegion)
  assert.ok(rule)
  const runId = `test-recovery-${randomUUID()}`
  try {
    aws(pausedRegion, ['events', 'disable-rule', '--name', rule])
    // Let already-delivered short sweeps settle before creating new work.
    await setTimeout(5000)
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
    assert.ok(output, `Other-region EventBridge recovery timed out: ${runId}`)
    assert.equal(object(output.started).region, pausedRegion)
    assert.equal(object(output.firstWake).region, healthyRegion)
    assert.equal(object(output.finished).region, healthyRegion)
    outcomes.push({ pausedRegion, runId, output })
    console.log(`${pausedRegion} schedule paused; ${healthyRegion} completed both sleeps: ${runId}`)
  } finally {
    aws(pausedRegion, ['events', 'enable-rule', '--name', rule])
    assert.equal(aws(pausedRegion, ['events', 'describe-rule', '--name', rule, '--query', 'State', '--output', 'text']), 'ENABLED')
  }
}
const report = `.deploy/workflow-recovery-${Date.now()}.json`
writeFileSync(report, JSON.stringify({ site: site.origin, testedAt: new Date().toISOString(), outcomes, bothSchedulesRestored: true }, null, 2))
console.log(`Evidence: ${report}`)
