import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { createDynamoWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws'
import { defineWorkflowRuntime, type UpsertScheduleArgs, type ScheduleBucket } from '@ataylorme/tanstack-workflow-aws/runtime'
import { workflows } from '../src/workflows/definitions.ts'
import { verifyWorkflowPackage } from './workflow-package.ts'

export function scheduleFixture(prefix: string, name: string, now: number, missedTickPolicy: 'skip' | 'run-once' | 'catch-up' = 'run-once', overlapPolicy: 'skip' | 'allow' = 'allow'): UpsertScheduleArgs {
  assert.match(prefix, /^test-schedule-[a-f0-9-]+$/)
  return { scheduleId: `${prefix}-${name}`, workflowId: 'validation-v1', schedule: { kind: 'interval', everyMs: 60_000 }, nextFireAt: now, now, enabled: true, missedTickPolicy, overlapPolicy, maxCatchUp: 2, input: {} }
}

export async function main() {
  if (!process.argv.includes('--execute')) {
    console.log('Plan only: --execute, AWS_PROFILE, STACK_PREFIX, EXPECTED_AWS_ACCOUNT_ID required. Unique future-dated fixtures; direct public store APIs with synthetic now test live Dynamo missed ticks, overlap and generation fencing. Includes fixture-seeded overdue ticks processed by background workers; not a real clock outage drill. Finally disable schedules and abort fixture runs. No shared mappings changed.')
    return
  }
  const profile = process.env.AWS_PROFILE
  const prefix = process.env.STACK_PREFIX
  const account = process.env.EXPECTED_AWS_ACCOUNT_ID
  assert.ok(profile, 'Explicit AWS_PROFILE required')
  assert.ok(prefix && prefix !== 'tanstack-ha' && /^[a-z][a-z0-9-]{0,39}$/.test(prefix), 'Explicit lab STACK_PREFIX required')
  assert.ok(account && /^\d{12}$/.test(account), 'Explicit EXPECTED_AWS_ACCOUNT_ID required')
  const tableName = process.env.TABLE_NAME ?? `${prefix}-workflow`
  assert.equal(tableName, `${prefix}-workflow`)
  const artifact = verifyWorkflowPackage()
  const aws = (...args: string[]) => JSON.parse(execFileSync('aws', ['--profile', profile, ...args], { encoding: 'utf8', timeout: 45_000, env: { ...process.env, AWS_PAGER: '' } }))
  assert.equal(aws('sts', 'get-caller-identity', '--output', 'json').Account, account)
  const credentials = aws('configure', 'export-credentials', '--format', 'process')
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', maxAttempts: 3, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000, throwOnRequestTimeout: true }, credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken } }), { marshallOptions: { removeUndefinedValues: true } })
  const store = createDynamoWorkflowExecutionStore({ tableName, client })
  const runtime = defineWorkflowRuntime({ store, workflows })
  const fixturePrefix = `test-schedule-${randomUUID()}`
  // Future wall-clock deadlines prevent shared background workers racing synthetic-clock claims.
  const firstTick = Math.ceil((Date.now() + 86_400_000) / 60_000) * 60_000
  const syntheticNow = firstTick + 5 * 60_000
  const owner = `${fixturePrefix}-owner`
  const fixtures: UpsertScheduleArgs[] = []
  const runs = new Set<string>()
  const pending = new Map<string, ScheduleBucket>()
  const evidence: unknown[] = []
  mkdirSync('.deploy', { recursive: true })
  const report = `.deploy/schedule-policies-${fixturePrefix}.json`
  const save = (status: string, error?: unknown) => writeFileSync(report, JSON.stringify({ status, error: error && String(error), account, tableName, artifact, fixturePrefix, firstTick, syntheticNow, scope: 'live Dynamo public APIs; synthetic schedule clock, real registered workflow executions', fixtures, runs: [...runs], pending: [...pending.values()], evidence }, null, 2), { mode: 0o600 })
  const read = async (scheduleId: string) => (await client.send(new GetCommand({ TableName: tableName, Key: { PK: `SCHEDULE#${scheduleId}`, SK: 'META' }, ConsistentRead: true }))).Item!
  const register = async (fixture: UpsertScheduleArgs) => { fixtures.push(fixture); save('running'); await store.upsertSchedule(fixture) }
  const claim = async (fixture: UpsertScheduleArgs, now: number) => {
    const bucket = await store.claimScheduleBucket({ scheduleId: fixture.scheduleId, now, leaseOwner: owner, leaseMs: 60_000 })
    if (bucket) { pending.set(fixture.scheduleId, bucket); runs.add(bucket.runId); save('running') }
    return bucket
  }
  const acknowledge = async (bucket: ScheduleBucket, now: number) => {
    await store.withLeaseOwner(owner, () => store.markScheduleBucketStarted({ ...bucket, now }))
    pending.delete(bucket.scheduleId)
    save('running')
  }
  const start = async (bucket: ScheduleBucket) => {
    await store.withLeaseOwner(owner, () => runtime.startRun({ runId: bucket.runId, workflowId: bucket.workflowId, input: {}, leaseOwner: owner }))
    assert.ok(await store.loadRun(bucket.runId), 'Scheduled run exists')
  }
  let failure: unknown
  save('prepared') // Durable private recovery manifest before the first AWS mutation.
  try {
    for (const missed of ['skip', 'run-once', 'catch-up'] as const) {
      const fixture = scheduleFixture(fixturePrefix, missed, firstTick, missed)
      await register(fixture)
      let count = 0
      for (let attempt = 0; attempt < 4; attempt++) {
        const bucket = await claim(fixture, syntheticNow)
        if (!bucket) break
        await start(bucket)
        await acknowledge(bucket, syntheticNow)
        count++
      }
      assert.equal(count, missed === 'skip' ? 0 : missed === 'run-once' ? 1 : 2)
      const schedule = await read(fixture.scheduleId)
      assert.ok(schedule.nextFireAt > syntheticNow)
      evidence.push({ missed, count, schedule })
    }
    for (const overlap of ['skip', 'allow'] as const) {
      const fixture = scheduleFixture(fixturePrefix, `overlap-${overlap}`, firstTick, 'run-once', overlap)
      await register(fixture)
      const first = await claim(fixture, firstTick)
      assert.ok(first)
      await start(first)
      await acknowledge(first, firstTick)
      const active = await store.loadRun(first.runId)
      assert.ok(active && !['finished', 'errored', 'aborted'].includes(active.status))
      const second = await claim(fixture, firstTick + 60_000)
      assert.equal(Boolean(second), overlap === 'allow')
      if (second) { await start(second); await acknowledge(second, firstTick + 60_000) }
      assert.ok((await read(fixture.scheduleId)).nextFireAt > firstTick + 60_000)
      evidence.push({ overlap, activeStatus: active.status, secondBucket: second ?? null })
    }
    // Fixture-only overdue registration lets the deployed demand-driven worker process real backlog.
    // Long cadence bounds the drill; disable as soon as it has advanced beyond wall-clock now.
    for (const missed of ['skip', 'run-once', 'catch-up'] as const) {
      let interval = 600_000
      while ((Math.floor(Date.now() / interval) + 1) * interval - Date.now() < 420_000) interval *= 2
      const currentBoundary = Math.floor(Date.now() / interval) * interval
      const overdue = currentBoundary - 2 * interval
      const fixture: UpsertScheduleArgs = { ...scheduleFixture(fixturePrefix, `background-${missed}`, overdue, missed), workflowId: 'continuation-v1', input: { generation: 1 }, schedule: { kind: 'interval', everyMs: interval } }
      // Record every possible overdue run before registration, including unexpected ones for cleanup.
      const expectedIds = [0, 1, 2].map(i => `continuation-v1:${fixture.scheduleId}:1:${overdue + i * interval}`)
      for (const id of expectedIds) runs.add(id)
      await register(fixture)
      const deadline = Date.now() + 360_000
      let state = await read(fixture.scheduleId)
      while (state.nextFireAt <= Date.now() || state.pendingBucket) {
        assert.ok(Date.now() < deadline, `Background ${missed} did not advance`)
        await setTimeout(2000)
        state = await read(fixture.scheduleId)
      }
      await store.upsertSchedule({ ...fixture, enabled: false, now: Date.now() })
      const observed = []
      for (const runId of expectedIds) {
        let run = await store.loadRun(runId)
        while (run && !['finished', 'errored', 'aborted'].includes(run.status)) {
          assert.ok(Date.now() < deadline, `Background run ${runId} did not finish`)
          await setTimeout(1000)
          run = await store.loadRun(runId)
        }
        if (run) { assert.equal(run.status, 'finished'); observed.push(run) }
      }
      assert.equal(observed.length, missed === 'skip' ? 0 : missed === 'run-once' ? 1 : 2)
      evidence.push({ backgroundMissed: missed, overdue, state, observed, fixtureBacklogSeeded: true, directClaims: false })
      save('running')
    }
    const fixture = scheduleFixture(fixturePrefix, 'generation', firstTick)
    await register(fixture)
    const accepted = await claim(fixture, firstTick)
    assert.ok(accepted)
    const updated = { ...fixture, overlapPolicy: 'skip' as const, now: firstTick + 1, nextFireAt: firstTick + 600_000 }
    await store.upsertSchedule(updated)
    const before = await read(fixture.scheduleId)
    await start(accepted)
    await acknowledge(accepted, firstTick + 60_000)
    const after = await read(fixture.scheduleId)
    assert.equal(after.generation, before.generation)
    assert.equal(after.nextFireAt, updated.nextFireAt, 'Old generation ack must not advance newer definition')
    await store.upsertSchedule(fixture)
    assert.equal((await read(fixture.scheduleId)).generation, after.generation, 'Stale definition cannot roll back generation')
    evidence.push({ generationFencing: { before, after } })
  } catch (error) { failure = error; save('failed', error) }
  finally {
    const cleanupErrors: string[] = []
    for (const fixture of fixtures) {
      try {
        await store.upsertSchedule({ ...fixture, enabled: false, now: syntheticNow + 86_400_000 })
        const bucket = pending.get(fixture.scheduleId)
        if (bucket) await acknowledge(bucket, syntheticNow)
        const state = await read(fixture.scheduleId)
        assert.equal(state.enabled, false)
        assert.equal(state.pendingBucket, undefined)
      } catch (error) { cleanupErrors.push(`${fixture.scheduleId}: ${error}`) }
    }
    for (const runId of runs) {
      try {
        const deadline = Date.now() + 90_000
        while (true) {
          const run = await store.loadRun(runId)
          if (!run || ['finished', 'errored', 'aborted'].includes(run.status)) break
          if (!run.lease) { await store.deleteRun(runId, 'aborted'); assert.equal(await store.loadRun(runId), undefined); break }
          assert.ok(Date.now() < deadline, `Timed out settling ${runId}`)
          await setTimeout(1000)
        }
      } catch (error) { cleanupErrors.push(`${runId}: ${error}`) }
    }
    evidence.push({ cleanupErrors, allSchedulesDisabled: cleanupErrors.length === 0 })
    if (cleanupErrors.length) failure = new AggregateError([failure, ...cleanupErrors], 'Fixture cleanup failed; inspect manifest')
    save(failure ? 'failed' : 'passed', failure)
    client.destroy()
  }
  if (failure) throw failure
  console.log(`Schedule policy verification passed: ${report}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
