import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDynamoWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: create and abandon 12 claimed timer workflows, observe one-time schedules in both regions, verify lease fencing and two timer resolutions each. Requires AWS_PROFILE, EXPECTED_AWS_ACCOUNT_ID, isolated STACK_PREFIX, and --execute. No manual sweeps or data deletion.')
  process.exit(0)
}
const profile = process.env.AWS_PROFILE
const expectedAccount = process.env.EXPECTED_AWS_ACCOUNT_ID
const prefix = process.env.STACK_PREFIX
assert.ok(profile, 'Explicit AWS_PROFILE required')
assert.match(expectedAccount ?? '', /^\d{12}$/, 'EXPECTED_AWS_ACCOUNT_ID required')
assert.ok(prefix && /^[a-z][a-z0-9-]{0,39}$/.test(prefix) && prefix !== 'tanstack-ha', 'Explicit isolated STACK_PREFIX required')
const regions = ['us-east-1', 'us-west-2'] as const
const exec = promisify(execFile)
async function aws(region: string, args: string[]) {
  const result = await exec('aws', ['--profile', profile!, '--region', region, ...args, '--output', 'json'], { env: { ...process.env, AWS_PAGER: '' }, maxBuffer: 10 * 1024 * 1024 })
  return JSON.parse(result.stdout)
}
assert.equal((await aws(regions[0], ['sts', 'get-caller-identity'])).Account, expectedAccount, 'AWS account mismatch')
// Export only into process memory: supports CLI login credentials without writing credentials to disk.
const credentialResult = await exec('aws', ['configure', 'export-credentials', '--profile', profile, '--format', 'process'], { env: { ...process.env, AWS_PAGER: '' } })
const credentials = JSON.parse(credentialResult.stdout)
const targets = await Promise.all(regions.map(async region => {
  const stack = (await aws(region, ['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-sweeper`])).Stacks[0]
  const legacyRule = stack.Outputs.find((entry: { OutputKey: string }) => entry.OutputKey === 'SweepRuleName')?.OutputValue
  if (legacyRule) {
    const rule = await aws(region, ['events', 'describe-rule', '--name', legacyRule])
    assert.equal(rule.State, 'DISABLED', 'Legacy polling must be disabled before wakeup recovery verification')
  }
  const tableName = stack.Parameters.find((entry: { ParameterKey: string }) => entry.ParameterKey === 'TableName')?.ParameterValue
  const group = stack.Outputs.find((entry: { OutputKey: string }) => entry.OutputKey === 'ScheduleGroupName')?.OutputValue
  assert.ok(tableName && group, 'Missing wakeup stack table/group configuration')
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region,
    credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken },
    maxAttempts: 3,
  }), { marshallOptions: { removeUndefinedValues: true } })
  return { region, group, tableName, store: createDynamoWorkflowExecutionStore({ tableName, client }) }
}))
assert.equal(targets[0]?.tableName, targets[1]?.tableName, 'Regional stacks must use the same global table')
const store = targets[0]!.store
const attemptedRuns: string[] = []
const runs: { runId: string; expiresAt: number; finishedAt?: number; timerResolutions?: number }[] = []
const observedSchedules: Record<string, string[]> = Object.fromEntries(regions.map(region => [region, []]))
mkdirSync('.deploy', { recursive: true })
const report = `.deploy/workflow-wakeup-recovery-${Date.now()}.json`
function save(extra: Record<string, unknown> = {}) {
  writeFileSync(report, JSON.stringify({ attemptedRuns, runs, observedSchedules, ...extra }, null, 2), { mode: 0o600 })
}
save()
try {
  // CreateRun + claimRun are public store APIs. A rare stream-worker race uses a fresh ID.
  for (let attempt = 0; runs.length < 12 && attempt < 24; attempt++) {
    const runId = `test-wakeup-recovery-${randomUUID()}`
    attemptedRuns.push(runId)
    save() // Persist ownership before the first durable action.
    assert.equal((await store.createRun({ runId, workflowId: 'timer-v1', input: {}, now: Date.now() })).kind, 'created')
    const claimed = await store.claimRun({ runId, leaseOwner: `abandoned-test:${runId}`, leaseMs: 45_000, now: Date.now() })
    if (claimed.kind !== 'claimed') continue
    assert.ok(claimed.run.lease)
    runs.push({ runId, expiresAt: claimed.run.lease.expiresAt })
    save()
  }
  assert.equal(runs.length, 12, 'Could not acquire 12 abandoned-run fixtures')
  const expectedKeys = new Set(runs.map(run => `RUN#${run.runId}`))
  const deadline = Math.max(...runs.map(run => run.expiresAt)) + 240_000
  while (Date.now() < deadline) {
    await Promise.all(targets.map(async target => {
      if (observedSchedules[target.region]!.length) return
      const schedules = (await aws(target.region, ['scheduler', 'list-schedules', '--group-name', target.group])).Schedules
      await Promise.all(schedules.map(async (schedule: { Name: string }) => {
        const detail = await aws(target.region, ['scheduler', 'get-schedule', '--group-name', target.group, '--name', schedule.Name]).catch(() => undefined)
        if (!detail?.Target?.Input) return // Automatic deletion can race inspection.
        const envelope = JSON.parse(detail.Target.Input)
        if (expectedKeys.has(envelope.key?.PK)) observedSchedules[target.region]!.push(envelope.key.PK)
      }))
    }))
    for (const run of runs) {
      if (run.finishedAt) continue
      const current = await store.loadRun(run.runId)
      assert.ok(current, 'Claimed fixture disappeared')
      assert.notEqual(current.status, 'errored', `Recovered run errored: ${run.runId}`)
      if (Date.now() < run.expiresAt) assert.notEqual(current.status, 'finished', 'Worker violated the initial execution lease')
      if (current.status === 'finished') {
        assert.ok(current.updatedAt >= run.expiresAt, 'Run finished before its abandoned lease expired')
        const events = await store.readEvents({ runId: run.runId })
        run.timerResolutions = events.filter(event => event.eventType === 'SIGNAL_RESOLVED').length
        assert.equal(run.timerResolutions, 2, 'Exactly two durable timer resolutions expected')
        run.finishedAt = current.updatedAt
      }
    }
    save()
    if (runs.every(run => run.finishedAt)) break
    await setTimeout(2000)
  }
  assert.ok(runs.every(run => run.finishedAt), 'Abandoned workflows did not recover within deadline')
  for (const region of regions) assert.ok(observedSchedules[region]!.length, `No one-time fixture schedules observed in ${region}`)
  save({ passed: true, testedAt: new Date().toISOString() })
  console.log(`PASS: 12 abandoned claims recovered, both schedule groups observed, two timers per run. Evidence: ${report}`)
} catch (error) {
  save({ passed: false, error: error instanceof Error ? error.message : String(error) })
  throw error
}
