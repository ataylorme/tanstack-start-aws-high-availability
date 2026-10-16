import { createHash } from 'node:crypto'

export interface SourceVersion { Key: string; VersionId: string; Size: number; ETag: string; IsLatest: boolean }
export interface ArchiveObject { source: SourceVersion; archiveKey: string; purpose: 'data-or-artifact' | 'coordination-evidence-only' }
export function planArchive(versions: unknown, snapshotId: string): ArchiveObject[] {
  if (!/^[a-f0-9-]{36}$/.test(snapshotId)) throw new Error('Invalid snapshot ID')
  if (!Array.isArray(versions) || versions.length === 0) throw new Error('Empty version inventory')
  if (versions.some(version => typeof version?.IsLatest !== 'boolean')) throw new Error('Invalid latest-version marker')
  const seen = new Set<string>()
  return versions.filter(version => version?.IsLatest === true).map(version => {
    if (typeof version.Key !== 'string' || !version.Key.startsWith('fleet/') || version.Key.includes('\0')
      || typeof version.VersionId !== 'string' || !version.VersionId || version.VersionId === 'null'
      || !Number.isSafeInteger(version.Size) || version.Size < 0 || typeof version.ETag !== 'string'
      || seen.has(version.Key)) throw new Error('Invalid or ambiguous current version inventory')
    seen.add(version.Key)
    const hash = createHash('sha256').update(JSON.stringify([version.Key, version.VersionId])).digest('hex')
    const authority = /^fleet\/(?:nodes\/|fleet\/|drain\/|probe\/|wake\/waker\.json$)|\/own\.json$/.test(version.Key)
    return { source: { Key: version.Key, VersionId: version.VersionId, Size: version.Size, ETag: version.ETag, IsLatest: true }, archiveKey: `backfill/${snapshotId}/objects/${hash}`, purpose: authority ? 'coordination-evidence-only' : 'data-or-artifact' }
  })
}
export function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
export function verifyArchiveBytes(source: Uint8Array, replica: Uint8Array, expectedSize: number): string {
  if (source.length !== expectedSize || replica.length !== expectedSize || digest(source) !== digest(replica)) throw new Error('Archive byte verification failed')
  return digest(source)
}

export interface ManifestCommitIO {
  read(): { versionId: string; bytes: Uint8Array } | undefined
  create(bytes: Uint8Array): string
}
/** Frozen bytes, conditional creation, fresh read reconciliation, zero write retries. */
export function commitManifest(bytes: Uint8Array, io: ManifestCommitIO): string {
  const verify = (result: { versionId: string; bytes: Uint8Array }) => {
    if (!result.versionId || result.versionId === 'null') throw new Error('Unversioned manifest')
    verifyArchiveBytes(bytes, result.bytes, bytes.length)
    return result.versionId
  }
  const existing = io.read()
  if (existing) return verify(existing)
  let versionId: string
  try { versionId = io.create(bytes) }
  catch (error) {
    const reconciled = io.read()
    if (reconciled) return verify(reconciled)
    throw error // Unknown/absent, not permission to blindly replay.
  }
  const after = io.read()
  if (!after || after.versionId !== versionId) throw new Error('Manifest commit not confirmed')
  return verify(after)
}
