import { describe, expect, it } from 'vitest'
import { commitManifest, planArchive, verifyArchiveBytes } from '../experiments/celld/recovery/archive.ts'
const id = '12345678-1234-1234-1234-123456789abc'
const source = { Key: 'fleet/cells/Counter:test/ltx/e1/0/segment.ltx', VersionId: 'version-a', Size: 3, ETag: 'etag', IsLatest: true }
describe('quarantine-only version-pinned archive', () => {
  it('uses unique immutable archive keys per source key/version, never serving prefixes', () => {
    const first = planArchive([source, { ...source, IsLatest: false }], id)
    expect(first).toHaveLength(1)
    expect(first[0]!.archiveKey).toMatch(/^backfill\/[a-f0-9-]+\/objects\/[a-f0-9]{64}$/)
    expect(first[0]!.purpose).toBe('data-or-artifact')
    expect(planArchive([{ ...source, VersionId: 'version-b' }], id)[0]!.archiveKey).not.toBe(first[0]!.archiveKey)
  })
  it.each(['fleet/cells/Counter:test/own.json', 'fleet/nodes/node.json', 'fleet/wake/waker.json', 'fleet/fleet/peer-auth.json', 'fleet/drain/token.json'])('marks copied authority as evidence only (%s)', Key => {
    expect(planArchive([{ ...source, Key }], id)[0]!.purpose).toBe('coordination-evidence-only')
  })
  it.each([{ VersionId: 'null' }, { VersionId: '' }, { Key: 'serving/cell.ltx' }, { Size: -1 }, { Size: 1.5 }, { ETag: null }])('rejects ambiguous/unversioned inventory %#', override => {
    expect(() => planArchive([{ ...source, ...override }], id)).toThrow()
  })
  it('rejects duplicate current keys and invalid manifests', () => {
    expect(() => planArchive([source, source], id)).toThrow()
    expect(() => planArchive([], id)).toThrow()
    expect(() => planArchive([source], '../active')).toThrow()
    expect(() => planArchive([{ ...source, IsLatest: 'true' }], id)).toThrow()
  })
  it('keeps alarm discovery entries as recovery data, not copied waker authority', () => {
    expect(planArchive([{ ...source, Key: 'fleet/wake/entries/scheduled/cell/identity' }], id)[0]!.purpose).toBe('data-or-artifact')
  })
  it('verifies exact bytes and sizes, not just ETags or counts', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(verifyArchiveBytes(bytes, bytes, 3)).toMatch(/^[a-f0-9]{64}$/)
    expect(() => verifyArchiveBytes(bytes, new Uint8Array([1, 2, 4]), 3)).toThrow()
    expect(() => verifyArchiveBytes(bytes, bytes, 4)).toThrow()
  })
  it('reconciles a lost commit response without another write', () => {
    const bytes = new Uint8Array([1, 2, 3]); let remote: { versionId: string; bytes: Uint8Array } | undefined
    let writes = 0
    expect(commitManifest(bytes, { read: () => remote, create: () => { writes++; remote = { versionId: 'manifest-v1', bytes }; throw new Error('Lost response') } })).toBe('manifest-v1')
    expect(writes).toBe(1)
    expect(commitManifest(bytes, { read: () => remote, create: () => { throw new Error('Must not write') } })).toBe('manifest-v1')
  })
  it('rejects conflicting frozen bytes and never retries an unknown outcome', () => {
    const bytes = new Uint8Array([1, 2, 3]); let writes = 0
    expect(() => commitManifest(bytes, { read: () => undefined, create: () => { writes++; throw new Error('Unknown') } })).toThrow('Unknown')
    expect(writes).toBe(1)
    expect(() => commitManifest(bytes, { read: () => ({ versionId: 'other', bytes: new Uint8Array([1, 2, 4]) }), create: () => { throw new Error('Must not write') } })).toThrow()
  })
})
