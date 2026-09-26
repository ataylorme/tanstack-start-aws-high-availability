import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishImage } from '../scripts/publish-image.ts'

const directories: string[] = []
afterEach(() => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })
function fixture(corrupt = false) {
  const work = mkdtempSync(join(tmpdir(), 'workflow-oci-test-'))
  directories.push(work)
  const files = join(work, 'files')
  mkdirSync(join(files, 'blobs/sha256'), { recursive: true })
  function blob(contents: string) {
    const bytes = Buffer.from(contents)
    const hex = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(files, 'blobs/sha256', hex), bytes)
    return { digest: `sha256:${hex}`, size: bytes.length }
  }
  const config = blob('{"architecture":"amd64","os":"linux"}')
  const layer = blob('test layer')
  const manifest = blob(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config, layers: [layer] }))
  writeFileSync(join(files, 'index.json'), JSON.stringify({ manifests: [manifest] }))
  if (corrupt) writeFileSync(join(files, 'blobs/sha256', layer.digest.slice(7)), 'changed')
  const archive = join(work, 'image.tar')
  execFileSync('tar', ['-cf', archive, '-C', files, 'index.json', 'blobs'])
  return { work, archive, digest: manifest.digest }
}
describe('host ECR publishing safety', () => {
  it('resumes an already published identical immutable tag without writes', () => {
    const f = fixture()
    const aws = vi.fn(() => f.digest)
    expect(publishImage({ ...f, region: 'us-east-1', repository: 'test', release: 'same', aws })).toBe(f.digest)
    expect(aws).toHaveBeenCalledTimes(1)
    expect(aws.mock.calls[0]).toEqual(['us-east-1', expect.arrayContaining(['batch-get-image'])])
  })
  it('rejects corrupted OCI bytes before any AWS call', () => {
    const f = fixture(true)
    const aws = vi.fn(() => 'None')
    expect(() => publishImage({ ...f, region: 'us-east-1', repository: 'test', release: 'same', aws })).toThrow()
    expect(aws).not.toHaveBeenCalled()
  })
  it('refuses to replace an immutable release with different content', () => {
    const f = fixture()
    const aws = vi.fn(() => `sha256:${'0'.repeat(64)}`)
    expect(() => publishImage({ ...f, region: 'us-east-1', repository: 'test', release: 'same', aws })).toThrow('different digest')
    expect(aws).toHaveBeenCalledTimes(1)
  })
})
