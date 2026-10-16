import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { commitManifest, digest, planArchive, verifyArchiveBytes } from '../recovery/archive.ts'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: capture current source versions and byte-verify immutable objects plus manifest in QUARANTINE backfill/<UUID>/. Never writes to a serving bucket/prefix, imports epochs, or grants ownership. Non-atomic inventory is NOT a consistent celld recovery point. Explicit --execute required.')
  process.exit(0)
}
const profile = process.env.AWS_PROFILE
if (!profile) throw new Error('Explicit AWS_PROFILE required')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
const work = resolve('.deploy/celld', prefix)
const replication = JSON.parse(readFileSync(resolve(work, 'replication.json'), 'utf8'))
const deployment = JSON.parse(readFileSync(resolve(work, 'deployment.json'), 'utf8'))
const identity = JSON.parse(readFileSync(resolve(work, 'identity.json'), 'utf8'))
if (!replication.archiveOnly || replication.destinationRegion !== 'us-west-2' || replication.source !== deployment.buckets['us-east-1']
  || Object.values(deployment.buckets).includes(replication.destination)) throw new Error('Must target the separate quarantine archive, never serving storage')
function aws(region: string, service: string, args: string[]) {
  return JSON.parse(execFileSync('aws', ['--profile', profile!, '--region', region, ...(service === 's3api' ? [] : ['--endpoint-url', `https://${service}.${region}.amazonaws.com`]), service, ...args, '--output', 'json'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
  }) || '{}')
}
const caller = aws('us-east-1', 'sts', ['get-caller-identity'])
if (!/^\d{12}$/.test(identity.Account) || caller.Account !== identity.Account || /:root$/.test(caller.Arn)) throw new Error('Wrong deployed account')
const westStack = JSON.parse(readFileSync(resolve(work, 'us-west-2-regional-stack.json'), 'utf8'))
if (!westStack.Outputs.some((output: any) => output.OutputKey === 'ArchiveBucketName' && output.OutputValue === replication.destination)) throw new Error('Destination does not match archive stack evidence')
const startedAt = new Date().toISOString()
const resume = process.argv.find(arg => arg.startsWith('--resume='))?.slice(9)
if (resume && !/^[a-f0-9-]{36}$/.test(resume)) throw new Error('Invalid resume snapshot ID')
const snapshotId = resume ?? randomUUID()
const inventory = resume ? JSON.parse(readFileSync(resolve(work, 'snapshots', snapshotId, 'inventory.json'), 'utf8'))
  // Keep automatic service pagination enabled. JSON output applies this query
  // to the complete result, avoiding unbounded historical-version stdout while
  // retaining current version IDs and latest deletion evidence. Still non-atomic.
  : aws('us-east-1', 's3api', ['list-object-versions', '--bucket', replication.source, '--prefix', 'fleet/', '--expected-bucket-owner', identity.Account,
    '--query', '{Versions: Versions[?IsLatest], DeleteMarkers: DeleteMarkers[?IsLatest]}'])
const plan = planArchive(inventory.Versions, snapshotId)
const total = plan.reduce((sum, object) => sum + object.source.Size, 0)
if (plan.length === 0 || plan.length > 1000 || total > 32 * 1024 * 1024) throw new Error('Snapshot exceeds bounded lab archive window; review before writing')
const local = resolve(work, 'snapshots', snapshotId)
if (resume && existsSync(resolve(local, 'commit.json'))) throw new Error('Snapshot already committed; verify it instead of replaying writes')
mkdirSync(local, { recursive: true, mode: 0o700 })
const evidenceFile = resolve(local, 'manifest.json')
const manifest: any = resume ? JSON.parse(readFileSync(evidenceFile, 'utf8')) : { format: 1, snapshotId, startedAt, inventoryObservedAt: new Date().toISOString(), sourceBucket: replication.source, archiveBucket: replication.destination, latestDeleteMarkers: (inventory.DeleteMarkers ?? []).filter((value: any) => value.IsLatest), objects: [], committed: false, cellConsistentRecoveryPointProven: false, importAuthorized: false, limitation: 'Byte-verified version-pinned object archive from NON-ATOMIC live listing. Does not cover unsent peer disk logs or prove a consistent native restore chain/epoch bootstrap. Copied authority is forensic only, never destination authorization.' }
if (manifest.sourceBucket !== replication.source || manifest.archiveBucket !== replication.destination || manifest.snapshotId !== snapshotId || manifest.committed) throw new Error('Resume manifest identity/state mismatch')
writeFileSync(resolve(local, 'inventory.json'), JSON.stringify(inventory), { mode: 0o600 })
const save = () => writeFileSync(evidenceFile, JSON.stringify(manifest), { mode: 0o600 })
save()
const frozenFile = resolve(local, 'frozen-manifest.json')
if (!existsSync(frozenFile)) for (const object of plan) {
  const sourceFile = resolve(local, object.archiveKey.split('/').at(-1)! + '.bin'), replicaFile = resolve(local, 'replica.bin')
  const source = aws('us-east-1', 's3api', ['get-object', '--bucket', replication.source, '--key', object.source.Key, '--version-id', object.source.VersionId, '--expected-bucket-owner', identity.Account, sourceFile])
  if (source.VersionId !== object.source.VersionId || source.ETag !== object.source.ETag) throw new Error('Pinned source version mismatch')
  const bytes = readFileSync(sourceFile)
  if (bytes.length !== object.source.Size) throw new Error('Pinned source length mismatch')
  const sha256 = digest(bytes)
  manifest.pending = { ...object, sha256, outcome: 'UNKNOWN' }; save()
  let put: any
  if (resume) {
    try { put = aws('us-west-2', 's3api', ['head-object', '--bucket', replication.destination, '--key', object.archiveKey, '--expected-bucket-owner', identity.Account]) }
    catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? ''
      if (!/\(404\)|\(NotFound\)/.test(stderr)) throw error // unavailable != absent
    }
  }
  if (!put) put = aws('us-west-2', 's3api', ['put-object', '--bucket', replication.destination, '--key', object.archiveKey, '--body', sourceFile, '--if-none-match', '*', '--server-side-encryption', 'AES256', '--expected-bucket-owner', identity.Account, '--checksum-algorithm', 'SHA256', '--checksum-sha256', Buffer.from(sha256, 'hex').toString('base64')])
  if (!put.VersionId) throw new Error('Archive is not versioned')
  const copied = aws('us-west-2', 's3api', ['get-object', '--bucket', replication.destination, '--key', object.archiveKey, '--version-id', put.VersionId, '--expected-bucket-owner', identity.Account, replicaFile])
  if (copied.VersionId !== put.VersionId) throw new Error('Archive version mismatch')
  verifyArchiveBytes(bytes, readFileSync(replicaFile), object.source.Size)
  manifest.objects = manifest.objects.filter((row: any) => row.archiveKey !== object.archiveKey)
  manifest.objects.push({ ...object, archiveVersionId: put.VersionId, sha256, verifiedAt: new Date().toISOString() }); delete manifest.pending; save()
}
if (!existsSync(frozenFile)) {
  manifest.objectsByteVerified = true; manifest.completedAt = new Date().toISOString(); save()
  writeFileSync(frozenFile, readFileSync(evidenceFile), { mode: 0o600 })
}
const manifestKey = `backfill/${snapshotId}/manifest.json`
const manifestBytes = readFileSync(frozenFile)
const frozen = JSON.parse(manifestBytes.toString())
if (frozen.snapshotId !== snapshotId || frozen.sourceBucket !== replication.source || frozen.archiveBucket !== replication.destination || !frozen.objectsByteVerified) throw new Error('Frozen manifest identity mismatch')
const sha256 = digest(manifestBytes)
const commitFile = resolve(local, 'commit.json')
writeFileSync(resolve(local, 'commit-intent.json'), JSON.stringify({ manifestKey, manifestSha256: sha256, outcome: 'UNKNOWN', observedAt: new Date().toISOString() }), { mode: 0o600 })
const remoteManifestFile = resolve(local, 'remote-manifest.json')
const version = commitManifest(manifestBytes, {
  read() {
    let head: any
    try { head = aws('us-west-2', 's3api', ['head-object', '--bucket', replication.destination, '--key', manifestKey, '--expected-bucket-owner', identity.Account]) }
    catch (error) { if (/\(404\)|\(NotFound\)/.test((error as { stderr?: string }).stderr ?? '')) return undefined; throw error }
    if (!head.VersionId) throw new Error('Manifest version missing')
    aws('us-west-2', 's3api', ['get-object', '--bucket', replication.destination, '--key', manifestKey, '--version-id', head.VersionId, '--expected-bucket-owner', identity.Account, remoteManifestFile])
    return { versionId: head.VersionId, bytes: readFileSync(remoteManifestFile) }
  },
  create() {
    const put = aws('us-west-2', 's3api', ['put-object', '--bucket', replication.destination, '--key', manifestKey, '--body', frozenFile, '--if-none-match', '*', '--server-side-encryption', 'AES256', '--expected-bucket-owner', identity.Account, '--checksum-algorithm', 'SHA256', '--checksum-sha256', Buffer.from(sha256, 'hex').toString('base64')])
    return put.VersionId
  },
})
writeFileSync(commitFile, JSON.stringify({ manifestKey, manifestVersion: version, manifestSha256: sha256, verifiedAt: new Date().toISOString() }), { mode: 0o600 })
console.log(`PASS: ${frozen.objects.length} current source-version objects (${total} bytes) and commit manifest byte-verified in isolated quarantine snapshot. No native checkpoint consistency, hydrate, regional authorization or promotion claimed.`)
