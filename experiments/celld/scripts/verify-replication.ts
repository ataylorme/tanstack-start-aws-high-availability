import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const execute = process.argv.includes('--execute')
if (!execute) {
  console.log('Plan only: write a unique inert S3 probe under fleet/validation, observe CRR completion and destination bytes. No celld RPO or restore claim; no object deletion. Use --execute for the isolated authorized experiment.')
  process.exit(0)
}
if (!process.env.AWS_PROFILE) throw new Error('Explicit AWS_PROFILE required')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
const work = resolve('.deploy/celld', prefix)
const manifest = JSON.parse(readFileSync(resolve(work, 'replication.json'), 'utf8'))
if (!manifest.archiveOnly || manifest.destinationRegion !== 'us-west-2') throw new Error('Expected quarantine archive in selected topology')
function aws(region: string, args: string[]) {
  return JSON.parse(execFileSync('aws', ['--region', region, ...args, '--output', 'json'], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' },
  }) || '{}')
}
const id = randomUUID()
const key = `fleet/validation/${id}.json`
const file = resolve(work, 'replication-probe.json')
const body = JSON.stringify({ type: 'inert-replication-probe', id })
writeFileSync(file, body, { mode: 0o600 })
const started = Date.now()
const uploaded = aws('us-east-1', ['s3api', 'put-object', '--bucket', manifest.source, '--key', key, '--body', file])
const acknowledged = Date.now()
if (!uploaded.VersionId) throw new Error('Probe source version missing')
let source: any
const deadline = acknowledged + 10 * 60_000
while (Date.now() < deadline) {
  source = aws('us-east-1', ['s3api', 'head-object', '--bucket', manifest.source, '--key', key, '--version-id', uploaded.VersionId])
  if (source.ReplicationStatus === 'FAILED') throw new Error('Probe replication failed; inspect S3 replication failure metrics')
  if (source.ReplicationStatus === 'COMPLETED') break
  await new Promise(resolve => setTimeout(resolve, 5000))
}
if (source?.ReplicationStatus !== 'COMPLETED') throw new Error('Replication probe exceeded observation window; no bounded RPO claim')
const observed = Date.now()
const destinationFile = resolve(work, 'replication-destination.json')
const destination = aws(manifest.destinationRegion, ['s3api', 'get-object', '--bucket', manifest.destination, '--key', key, destinationFile])
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
if (destination.ReplicationStatus !== 'REPLICA' || digest(readFileSync(destinationFile, 'utf8')) !== digest(body)) throw new Error('Destination replica content/status mismatch')
writeFileSync(resolve(work, 'replication-probe-result.json'), JSON.stringify({ sourceBucket: manifest.source, destinationBucket: manifest.destination, key, sourceVersion: uploaded.VersionId, destinationVersion: destination.VersionId, started, acknowledged, observed, observedLagMs: observed - acknowledged, sourceStatus: source.ReplicationStatus, destinationStatus: destination.ReplicationStatus, sha256: digest(body), limitation: 'S3-only probe, polling upper observation bound; not celld acknowledgement RPO, complete-history restore, or backfill evidence' }), { mode: 0o600 })
console.log(`PASS: byte-identical quarantine replica observed ${observed - acknowledged}ms after S3 acknowledgement. This is NOT celld RPO or a complete recovery point.`)
