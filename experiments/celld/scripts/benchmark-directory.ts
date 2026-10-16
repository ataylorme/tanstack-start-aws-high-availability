import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Directory } from '../routing/directory.ts'
import { latencySummary } from '../measurements/latency.ts'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: read-only SDK directory benchmark at both MRSC replica endpoints and injected first-endpoint transport failure. Requires an existing local AWS SDK v3 installation, no dependency install. Uses inert FENCING shard 7; no ACTIVE rows, writes, promotion, or real outage. Cached ACTIVE comparisons are synthetic and labeled separately.')
  process.exit(0)
}
const profile = process.env.AWS_PROFILE
if (!profile) throw new Error('Explicit AWS_PROFILE required')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
const work = resolve('.deploy/celld', prefix)
const identity = JSON.parse(readFileSync(resolve(work, 'identity.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(resolve(work, 'deployment.json'), 'utf8'))
const replicas = JSON.parse(readFileSync(resolve(work, 'directory-identities.json'), 'utf8'))
const tableName = `${prefix}-ownership`
assert.equal(manifest.directoryName, tableName)
assert.equal(manifest.directoryWest, 'us-west-2')
function aws(region: string, service: string, args: string[]) {
  return JSON.parse(execFileSync('aws', ['--profile', profile!, '--region', region, '--endpoint-url',
    `https://${service}.${region}.amazonaws.com`, service, ...args, '--output', 'json'], {
    encoding:'utf8', timeout:15_000, env:{...process.env,AWS_PAGER:'',AWS_MAX_ATTEMPTS:'1',AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true'},
  }))
}
const caller = aws('us-east-1', 'sts', ['get-caller-identity'])
assert.equal(caller.Account, identity.Account)
assert.ok(!/:root$/.test(caller.Arn))
for (const region of ['us-east-1', 'us-west-2']) {
  const table = aws(region, 'dynamodb', ['describe-table','--table-name',tableName]).Table
  assert.equal(table.TableId, replicas[region]?.tableId)
  assert.equal(table.TableArn, `arn:aws:dynamodb:${region}:${identity.Account}:table/${tableName}`)
  assert.equal(table.MultiRegionConsistency, 'STRONG')
  assert.equal(table.TableStatus, 'ACTIVE')
}
// Session credentials remain in process memory, never in output/evidence.
const temporary = JSON.parse(execFileSync('aws', ['configure','export-credentials','--profile',profile,'--format','process'], {encoding:'utf8',timeout:15_000}))
assert.ok(temporary.AccessKeyId && temporary.SecretAccessKey && temporary.SessionToken)
const require = createRequire(import.meta.url)
const sdkVersion = require('@aws-sdk/client-dynamodb/package.json').version
// The managed Lambda runtime supplies this JS module's SDK. This optional local
// probe requires an already-installed SDK; it does not change application deps.
// @ts-expect-error JavaScript reader has no declaration; Lambda bundles it separately.
const { createAwsReader } = await import('../routing/aws-reader.js')
const read = createAwsReader(tableName, ['us-east-1','us-west-2'], {
  accessKeyId:temporary.AccessKeyId, secretAccessKey:temporary.SecretAccessKey, sessionToken:temporary.SessionToken,
})
const rows: any[] = []
async function measure(label: string, scope: string, action: () => Promise<void>) {
  const samples: number[] = []
  for (let i=0; i<55; i++) {
    const started = performance.now()
    await action()
    if (i>=5) samples.push(performance.now()-started)
  }
  rows.push({label,scope,warmups:5,concurrency:1,milliseconds:latencySummary(samples),samples})
}
for (const region of ['us-east-1','us-west-2']) {
  await measure(`strong inert read ${region}`, 'actual AWS SDK round trip from this client', async () => {
    const entry = await read(region,'v1:07',AbortSignal.timeout(2000))
    assert.equal(entry?.status,'FENCING'); assert.equal(entry?.shardId,'v1:07')
  })
}
let calls = 0
const client = new Directory({endpoints:['us-east-1','us-west-2'],ownerRegions:['us-east-1','us-west-2'],cacheMs:250,timeoutMs:750},
  async (region,key,signal) => {
    calls++
    if (region==='us-east-1') throw new Error('Injected local transport refusal; no AWS endpoint outage')
    return read(region,key,signal)
  })
await measure('injected first-endpoint failure + strong standby read + FENCING refusal','actual second-endpoint read; first failure synthetic', async () => {
  const before=calls
  await assert.rejects(client.lookup(7), /not valid active ownership/)
  assert.equal(calls-before,2)
})
// Never insert this synthetic entry into DynamoDB or a serving application.
const fixture = {routingVersion:'v1',shardCount:64,shardId:'v1:07',status:'ACTIVE',homeRegion:'us-east-1',activeRegion:'us-east-1',epoch:1,leaseExpiresAt:90_000}
for (const cacheMs of [0,250]) {
  let fixtureCalls=0
  const synthetic = new Directory({endpoints:['us-east-1','us-west-2'],ownerRegions:['us-east-1','us-west-2'],cacheMs,timeoutMs:750},
    async () => {fixtureCalls++;return fixture}, () => 0)
  await measure(`synthetic ACTIVE cacheMs=${cacheMs}`, 'local-only cache overhead; no network or authorization',async () => {await synthetic.lookup(7)})
  assert.equal(fixtureCalls,cacheMs===0?55:1)
  rows.at(-1).readsIncludingWarmups=fixtureCalls
}
const evidence = {observedAt:new Date().toISOString(),node:process.version,sdkVersion,rows,limitations:'Client-local warm sequential samples, not Lambda@Edge or end-to-end stateful latency. No live ACTIVE route/cache measured, no AWS endpoint outage or quorum loss injected, no writable regional promotion. Synthetic cache timings exclude network. Does not measure renewals or regional RPO/RTO.'}
writeFileSync(resolve(work,`directory-benchmark-${randomUUID()}.json`),JSON.stringify(evidence),{mode:0o600})
for (const row of rows) console.log(`${row.label}: p50=${row.milliseconds.p50.toFixed(3)}ms p95=${row.milliseconds.p95.toFixed(3)}ms p99=${row.milliseconds.p99.toFixed(3)}ms (${row.scope})`)
console.log(evidence.limitations)
