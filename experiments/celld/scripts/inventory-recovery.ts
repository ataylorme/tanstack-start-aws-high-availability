import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: inventory versioned source/QUARANTINE archive keys. Read-only, non-atomic observation; no hydrate/restore/lease import/promotion. Use --execute after deployment.')
  process.exit(0)
}
const profile = process.env.AWS_PROFILE
if (!profile) throw new Error('Explicit AWS_PROFILE required')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
const work = resolve('.deploy/celld', prefix)
const replication = JSON.parse(readFileSync(resolve(work, 'replication.json'), 'utf8'))
if (!replication.archiveOnly || replication.destinationRegion !== 'us-west-2') throw new Error('Expected quarantine archive')
function list(region: string, bucket: string) {
  return JSON.parse(execFileSync('aws', ['--profile', profile!, '--region', region, '--endpoint-url', `https://s3.${region}.amazonaws.com`, 's3api', 'list-object-versions', '--bucket', bucket, '--prefix', 'fleet/', '--output', 'json'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
  }))
}
const startedAt = new Date().toISOString()
const source = list('us-east-1', replication.source)
const archive = list(replication.destinationRegion, replication.destination)
function category(key: string): string {
  if (/\/cells\/.*\/(?:own\.json|waker\.json)$|\/nodes\/|\/wake\//.test(key)) return 'native-authority-or-mixed-lease-log-metadata-DO-NOT-AUTHORIZE-FROM-COPY'
  if (/\/cells\/.*\/(?:ltx\/|retired\.json)/.test(key)) return 'cell-history-and-epoch-provenance'
  if (/\/log\//.test(key)) return 'recovery-log-and-loss-records'
  if (/\/deploy(?:-blobs)?\//.test(key)) return 'deployment-modules-assets-and-pointers'
  if (/\/validation\//.test(key)) return 'inert-validation-probes'
  return 'unclassified-review-required'
}
// ETag/size matching is an inventory heuristic, NOT a content/complete-history proof.
const signature = (version: any) => JSON.stringify([version.Key, version.ETag, version.Size])
const candidates = new Map<string, number>()
for (const version of archive.Versions ?? []) candidates.set(signature(version), (candidates.get(signature(version)) ?? 0) + 1)
const unmatched: any[] = []
for (const version of source.Versions ?? []) {
  const key = signature(version), count = candidates.get(key) ?? 0
  if (count > 0) candidates.set(key, count - 1)
  else unmatched.push({ ...version, category: category(version.Key) })
}
const counts: Record<string, number> = {}
for (const version of source.Versions ?? []) counts[category(version.Key)] = (counts[category(version.Key)] ?? 0) + 1
writeFileSync(resolve(work, 'recovery-inventory.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), sourceBucket: replication.source, archiveBucket: replication.destination, source, archive, counts, unmatched, limitation: 'Non-atomic live listings and ETag/size heuristic. Not byte verification, atomic recovery point, disk-peerlog coverage, acknowledgement RPO, backfill completion, or native epoch import proof. Serving nodes must never receive copied own/node/waker authority.' }), { mode: 0o600 })
console.log(`Source versions: ${source.Versions?.length ?? 0}; archive versions: ${archive.Versions?.length ?? 0}; unmatched source-version candidates: ${unmatched.length}.`)
console.log('Read-only inventory saved locally. No complete recovery point or writable promotion demonstrated.')
