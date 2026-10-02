import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { defineWorkflowRuntime } from '@ataylorme/tanstack-workflow-aws/runtime'
import { createWorkflow } from '@ataylorme/tanstack-workflow-aws/workflow'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configureLocalEnvironment, localEndpoint, localWorkerTick, LOCAL_APPROVER_TOKEN, LOCAL_REQUESTER_TOKEN, provisionLocalTables } from '../scripts/orchestration-local'
import { createServices } from '../src/orchestration/services.server'
import { createTaskApi } from '../src/orchestration/api'
import { taskView } from '../src/orchestration/view'
import { WORKFLOW_ID, type TaskView } from '../src/orchestration/types'

it.each(['https://dynamodb.us-east-1.amazonaws.com', 'http://evil.test:8000', 'http://localhost:8001', 'http://localhost:8000/path', 'http://user:pass@localhost:8000', 'http://localhost:8000/?proxy=aws'])('rejects nonlocal or ambiguous endpoint %s', value => {
  expect(() => localEndpoint(value)).toThrow('Local harness requires')
})
it('sets safe local defaults without inheriting AWS execution credentials', () => {
  const env: NodeJS.ProcessEnv = { AWS_ACCESS_KEY_ID: 'real', AWS_SECRET_ACCESS_KEY: 'real', AWS_SESSION_TOKEN: 'real' }
  expect(configureLocalEnvironment(env)).toBe('http://127.0.0.1:8000')
  expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', APP_MODE: 'orchestration', APP_ROLE: 'http', SANDBOX_FUNCTION_NAME: 'sandbox-local' })
  expect(env.AWS_SESSION_TOKEN).toBeUndefined()
  expect(env.REQUESTER_TOKEN).not.toBe(env.APPROVER_TOKEN)
})
it('refuses to run inside Lambda or with identical credentials', () => {
  expect(() => configureLocalEnvironment({ AWS_LAMBDA_FUNCTION_NAME: 'production' })).toThrow('inside Lambda')
  expect(() => configureLocalEnvironment({ REQUESTER_TOKEN: LOCAL_REQUESTER_TOKEN, APPROVER_TOKEN: LOCAL_REQUESTER_TOKEN })).toThrow('distinct')
})

const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT

describe.skipIf(!endpoint)('persistent DynamoDB Local orchestration', () => {
  const suffix = randomUUID()
  const workflowTable = `orchestration-test-workflows-${suffix}`
  const operationsTable = `orchestration-test-operations-${suffix}`
  let services: ReturnType<typeof createServices>
  let replacement: ReturnType<typeof createServices> | undefined
  let client: DynamoDBClient
  const apiFor = (current: Pick<ReturnType<typeof createServices>, 'store' | 'decisions'>) => createTaskApi({ ...current, requesterToken: LOCAL_REQUESTER_TOKEN, approverToken: LOCAL_APPROVER_TOKEN })
  function request(path: string, body?: unknown, approver = false, key = randomUUID()) {
    return new Request(`http://localhost/api/tasks${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${approver ? LOCAL_APPROVER_TOKEN : LOCAL_REQUESTER_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  async function sweepUntil(current: { store: ReturnType<typeof createServices>['store']; runtime: Pick<ReturnType<typeof createServices>['runtime'], 'sweep'> }, id: string, status: TaskView['status']) {
    for (let attempt = 0; attempt < 30; attempt++) {
      {
        const owner = `test-${randomUUID()}`
        await current.store.withLeaseOwner(owner, () => current.runtime.sweep({ leaseOwner: owner, limit: 25, maxDurationMs: 10_000 }))
      }
      const view = await taskView(current.store, id)
      if (view?.status === status) return view
      if (view?.status === 'failed') throw new Error(view.error)
      await delay(100)
    }
    throw new Error(`Did not reach ${status}: ${JSON.stringify(await taskView(current.store, id))}`)
  }

  beforeAll(async () => {
    const url = localEndpoint(endpoint!)
    for (const [key, value] of Object.entries({ DYNAMODB_ENDPOINT: url, AWS_REGION: 'us-east-1', WORKFLOW_TABLE_NAME: workflowTable, OPERATIONS_TABLE_NAME: operationsTable, SANDBOX_FUNCTION_NAME: 'sandbox-local' })) vi.stubEnv(key, value)
    client = new DynamoDBClient({ endpoint: url, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } })
    await provisionLocalTables(url, workflowTable, operationsTable)
    services = createServices()
  }, 60_000)

  afterAll(async () => {
    services?.doc.destroy()
    replacement?.doc.destroy()
    if (client) {
      for (const TableName of [workflowTable, operationsTable]) await client.send(new DeleteTableCommand({ TableName })).catch(() => {})
      client.destroy()
    }
    vi.unstubAllEnvs()
  })

  it('allows one of two concurrent owners to claim a queued run', async () => {
    const runId = `claim-${randomUUID()}`
    await services.store.createRun({ runId, workflowId: 'claim-only', workflowVersion: 'v1', input: {}, now: Date.now() })
    const args = { runId, now: Date.now(), leaseMs: 60_000 }
    const results = await Promise.all([
      services.store.claimRun({ ...args, leaseOwner: 'contender-a' }),
      services.store.claimRun({ ...args, leaseOwner: 'contender-b' }),
    ])
    expect(results.map(result => result.kind).sort()).toEqual(['claimed', 'not-claimable'])
    const claimed = results.find(result => result.kind === 'claimed')
    if (claimed?.kind !== 'claimed') throw new Error('No lease winner')
    const owner = claimed.run.lease!.owner
    await services.store.withLeaseOwner(owner, () => services.store.markRunFinished({ runId, output: {}, now: Date.now() }))
  })

  it('persists approval across fresh runtimes and recovers a committed outbox after restart', async () => {
    const createRequest = { desiredConcurrency: 3 }
    const key = randomUUID()
    const created = await apiFor(services)(request('', createRequest, false, key))
    expect(created.status).toBe(202)
    const queued = await created.json() as TaskView
    expect(queued.status).toBe('queued')
    const replay = await apiFor(services)(request('', createRequest, false, key))
    expect(replay.status).toBe(200)
    expect((await replay.json() as TaskView).id).toBe(queued.id)
    const plan = await sweepUntil(services, queued.id, 'awaiting_approval')
    expect(plan.plan).toMatchObject({ before: 1, after: 3, target: 'sandbox-local' })
    expect(plan.approvalId).toBeTruthy()

    services.doc.destroy()
    replacement = createServices()
    const reloaded = await apiFor(replacement)(request(`/${queued.id}`))
    expect((await reloaded.json() as TaskView).plan?.hash).toBe(plan.plan!.hash)
    const decision = { approvalId: plan.approvalId!, planHash: plan.plan!.hash, approved: true }
    expect((await apiFor(replacement)(request(`/${queued.id}/decision`, decision))).status).toBe(403)
    expect((await apiFor(replacement)(request(`/${queued.id}/decision`, decision, true))).status).toBe(202)
    expect(await replacement.decisions.get(queued.id)).toMatchObject({ ...decision, actor: 'approver-demo' })

    replacement.doc.destroy()
    replacement = createServices()
    const finished = await sweepUntil(replacement, queued.id, 'succeeded')
    expect(finished.receipt).toMatchObject({ taskId: queued.id, planHash: plan.plan!.hash, after: 3 })
    const eventKey = { PK: `EVENT#success-${queued.id}`, SK: 'META' }
    expect((await replacement.doc.send(new GetCommand({ TableName: workflowTable, Key: eventKey, ConsistentRead: true }))).Item).toBeUndefined()

    replacement.doc.destroy()
    replacement = createServices()
    const drained = await localWorkerTick(replacement)
    expect(drained.effects).toBe(1)
    const event = (await replacement.doc.send(new GetCommand({ TableName: workflowTable, Key: eventKey, ConsistentRead: true }))).Item
    expect(event).toBeDefined()
    expect(JSON.stringify(event)).toContain('devops.task.succeeded.v1')
    expect((await localWorkerTick(replacement)).effects).toBe(0)
    expect((await replacement.doc.send(new GetCommand({ TableName: operationsTable, Key: { PK: 'LOCAL_SANDBOX', SK: 'META' }, ConsistentRead: true }))).Item?.capacity).toBe(3)
    expect((await replacement.store.loadRun(queued.id))?.workflowId).toBe(WORKFLOW_ID)
  }, 30_000)

  it('resumes a paused v1 run with its original definition after the registration upgrades to v2', async () => {
    const oldProcess = createServices()
    const upgradedProcess = createServices()
    try {
      const response = await apiFor(oldProcess)(request('', { desiredConcurrency: 4 }))
      expect(response.status).toBe(202)
      const task = await response.json() as TaskView
      const paused = await sweepUntil(oldProcess, task.id, 'awaiting_approval')
      expect((await oldProcess.store.loadRun(task.id))?.workflowVersion).toBe('v1')
      oldProcess.doc.destroy()

      const v2Handler = vi.fn(async () => { throw new Error('A persisted v1 task must not execute the incompatible v2 handler') })
      const v2 = createWorkflow({ id: WORKFLOW_ID, version: 'v2' }).handler(v2Handler)
      const v1Loader = vi.fn(upgradedProcess.runtime.workflows[WORKFLOW_ID]!.load)
      const runtime = defineWorkflowRuntime({
        store: upgradedProcess.store,
        workflows: { [WORKFLOW_ID]: { version: 'v2', load: async () => v2, previousVersions: { v1: v1Loader } } },
        defaultLeaseMs: 60_000,
      })
      const upgraded = { ...upgradedProcess, runtime }
      const decision = { approvalId: paused.approvalId!, planHash: paused.plan!.hash, approved: true }
      expect((await apiFor(upgraded)(request(`/${task.id}/decision`, decision, true))).status).toBe(202)
      const finished = await sweepUntil(upgraded, task.id, 'succeeded')
      expect(v1Loader).toHaveBeenCalled()
      expect(v2Handler).not.toHaveBeenCalled()
      expect(finished.plan).toEqual(paused.plan)
      expect(finished.receipt).toMatchObject({ taskId: task.id, planHash: paused.plan!.hash, after: 4 })
      expect((await upgraded.store.loadRun(task.id))?.workflowVersion).toBe('v1')
      const events = await upgraded.store.readEvents({ runId: task.id })
      expect(events.filter(({ event }) => event.type === 'STEP_FINISHED' && event.stepId === 'plan')).toHaveLength(1)
    } finally {
      oldProcess.doc.destroy()
      upgradedProcess.doc.destroy()
    }
  }, 30_000)

  it('atomically accepts one of two concurrent contradictory approval decisions', async () => {
    const current = createServices()
    try {
      const response = await apiFor(current)(request('', { desiredConcurrency: 5 }))
      expect(response.status).toBe(202)
      const task = await response.json() as TaskView
      const paused = await sweepUntil(current, task.id, 'awaiting_approval')
      const common = { approvalId: paused.approvalId!, planHash: paused.plan!.hash }
      const responses = await Promise.all([true, false].map(approved => apiFor(current)(request(`/${task.id}/decision`, { ...common, approved }, true))))
      expect(responses.map(result => result.status).sort()).toEqual([202, 409])
      const winner = responses[0]!.status === 202
      expect(await current.decisions.get(task.id)).toEqual({ ...common, approved: winner, actor: 'approver-demo' })
      const resolved = await sweepUntil(current, task.id, winner ? 'succeeded' : 'rejected')
      expect(resolved.decision).toEqual({ approved: winner, actor: 'approver-demo' })
      expect(await current.decisions.get(task.id)).toEqual({ ...common, approved: winner, actor: 'approver-demo' })
      expect((await apiFor(current)(request(`/${task.id}/decision`, { ...common, approved: !winner }, true))).status).toBe(409)
      const events = await current.store.readEvents({ runId: task.id })
      expect(events.filter(({ event }) => event.type === 'APPROVAL_RESOLVED')).toHaveLength(1)
    } finally { current.doc.destroy() }
  }, 30_000)

})
