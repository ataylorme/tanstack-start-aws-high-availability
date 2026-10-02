import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb'
import { build } from 'esbuild'
import type { createServices } from '../src/orchestration/services.server'

export const LOCAL_REQUESTER_TOKEN = 'local-requester-development-only-00000001'
export const LOCAL_APPROVER_TOKEN = 'local-approver-development-only-000000002'

export function localEndpoint(value = 'http://127.0.0.1:8000'): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '8000' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Local harness requires http://127.0.0.1:8000 or http://localhost:8000; AWS endpoints are forbidden')
  }
  return url.origin
}

export function configureLocalEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('Local harness cannot run inside Lambda')
  const endpoint = localEndpoint(env.DYNAMODB_LOCAL_ENDPOINT ?? env.DYNAMODB_ENDPOINT)
  env.DYNAMODB_ENDPOINT = endpoint
  env.AWS_REGION = 'us-east-1'
  env.AWS_ACCESS_KEY_ID = 'local'
  env.AWS_SECRET_ACCESS_KEY = 'local'
  delete env.AWS_SESSION_TOKEN
  env.AWS_EC2_METADATA_DISABLED = 'true'
  env.APP_MODE = 'orchestration'
  env.APP_ROLE = 'http'
  env.SANDBOX_FUNCTION_NAME = 'sandbox-local'
  env.WORKFLOW_TABLE_NAME ??= 'orchestration-local-workflows'
  env.OPERATIONS_TABLE_NAME ??= 'orchestration-local-operations'
  env.REQUESTER_TOKEN ??= LOCAL_REQUESTER_TOKEN
  env.APPROVER_TOKEN ??= LOCAL_APPROVER_TOKEN
  if (env.REQUESTER_TOKEN.length < 32 || env.APPROVER_TOKEN.length < 32 || env.REQUESTER_TOKEN === env.APPROVER_TOKEN) throw new Error('Local credentials must be distinct and at least 32 characters')
  return endpoint
}

export async function provisionLocalTables(endpoint: string, workflowTable: string, operationsTable: string) {
  if (workflowTable === operationsTable) throw new Error('Workflow and operations tables must be isolated')
  const client = new DynamoDBClient({ endpoint: localEndpoint(endpoint), region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, maxAttempts: 2 })
  try {
    for (const [TableName, workflow] of [[workflowTable, true], [operationsTable, false]] as const) {
      try { await client.send(new DescribeTableCommand({ TableName })); continue }
      catch (error) { if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error }
      try {
        await client.send(new CreateTableCommand({
          TableName, BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }, ...(workflow ? [{ AttributeName: 'duePK', AttributeType: 'S' as const }, { AttributeName: 'dueSK', AttributeType: 'N' as const }] : [])],
          KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
          ...(workflow ? { GlobalSecondaryIndexes: [{ IndexName: 'DueIndex', KeySchema: [{ AttributeName: 'duePK', KeyType: 'HASH' as const }, { AttributeName: 'dueSK', KeyType: 'RANGE' as const }], Projection: { ProjectionType: 'ALL' as const } }] } : {}),
        }))
      } catch (error) { if (!(error instanceof Error) || error.name !== 'ResourceInUseException') throw error }
      await waitUntilTableExists({ client, maxWaitTime: 30, minDelay: 1, maxDelay: 2 }, { TableName })
    }
  } finally { client.destroy() }
}

export async function localWorkerTick(services: ReturnType<typeof createServices>, owner = `local-${process.pid}-${crypto.randomUUID()}`) {
  const result = await services.store.withLeaseOwner(owner, () => services.runtime.sweep({ leaseOwner: owner, limit: 25, maxDurationMs: 20_000, includeEvents: false }))
  // Include terminal runs: a crash after completion but before publishing must remain recoverable.
  let effects = 0
  for (let offset = 0; ; offset += 100) {
    const runs = await services.store.listRuns({ limit: 100, cursor: String(offset) })
    for (const run of runs) effects += await services.store.drainEffects(run.runId, services.publisher, 10)
    if (runs.length < 100) break
  }
  return { summary: result.summary, effects }
}

async function command(program: string, args: string[]) {
  await new Promise<void>((done, reject) => {
    const child = spawn(program, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? done() : reject(new Error(`${program} exited with ${code}`)))
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some(arg => !['--init-only', '--worker-only'].includes(arg))) throw new Error('Usage: orchestration-local.ts [--init-only | --worker-only]')
  const endpoint = configureLocalEnvironment()
  if (!args.includes('--worker-only')) await command('docker', ['compose', '-f', 'compose.orchestration.yaml', 'up', '-d'])
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await provisionLocalTables(endpoint, process.env.WORKFLOW_TABLE_NAME!, process.env.OPERATIONS_TABLE_NAME!); ready = true; break }
    catch (error) { if (attempt === 29) throw error; await delay(1000) }
  }
  if (!ready) throw new Error('DynamoDB Local did not become ready')
  console.log('DynamoDB Local ready; tables and volume persist across restarts. No AWS resources or SNS are used.')
  if (args.includes('--init-only')) return
  await mkdir('.omx/local', { recursive: true })
  const bundle = resolve(`.omx/local/orchestration-services-${process.pid}.mjs`)
  await build({ entryPoints: ['src/orchestration/services.server.ts'], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external' })
  const module = await import(pathToFileURL(bundle).href) as { createServices: typeof createServices }
  const services = module.createServices()
  const web = args.includes('--worker-only') ? undefined : spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '3000', '--strictPort'], { stdio: 'inherit', env: process.env })
  const stop = new AbortController()
  function shutdown() { stop.abort(); web?.kill('SIGTERM') }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  web?.on('error', error => { console.error(error.message); process.exitCode = 1; shutdown() })
  web?.on('exit', code => { if (!stop.signal.aborted && code) process.exitCode = code; shutdown() })
  console.log('Local worker started. Run only ONE local worker per table pair; the local capacity adapter is a simulator, not an AWS isolation test. Restart after workflow changes. Dashboard: http://127.0.0.1:3000')
  try {
    while (!stop.signal.aborted) {
      try { await localWorkerTick(services) }
      catch (error) { console.error('Local worker tick failed; retrying:', error instanceof Error ? error.message : 'Unknown failure') }
      await delay(1000, undefined, { signal: stop.signal }).catch(() => {})
    }
  } finally {
    shutdown()
    services.doc.destroy()
    await rm(bundle, { force: true })
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
    if (web && web.exitCode === null && web.signalCode === null) {
      await Promise.race([new Promise<void>(done => web.once('exit', () => done())), delay(5000)])
      if (web.exitCode === null && web.signalCode === null) web.kill('SIGKILL')
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Local harness failed'); process.exitCode = 1 })
}
