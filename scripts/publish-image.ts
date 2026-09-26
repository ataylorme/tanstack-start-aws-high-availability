import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

function blob(archive: string, digest: string): Buffer {
  assert.match(digest, /^sha256:[a-f0-9]{64}$/)
  const result = execFileSync('tar', ['-xOf', archive, `blobs/sha256/${digest.slice(7)}`], { maxBuffer: 512 * 1024 * 1024 })
  assert.equal(`sha256:${createHash('sha256').update(result).digest('hex')}`, digest)
  return result
}
interface Descriptor { digest: string; size: number }
function descriptor(value: unknown): Descriptor {
  assert.ok(typeof value === 'object' && value !== null && 'digest' in value && typeof value.digest === 'string' && 'size' in value && typeof value.size === 'number')
  assert.match(value.digest, /^sha256:[a-f0-9]{64}$/)
  assert.ok(Number.isSafeInteger(value.size) && value.size > 0)
  return { digest: value.digest, size: value.size }
}
export function publishImage(options: {
  archive: string
  work: string
  region: string
  repository: string
  release: string
  aws: (region: string, args: string[]) => string
}): string {
  const { archive, work, region, repository, release, aws } = options
  let parsed: unknown = JSON.parse(execFileSync('tar', ['-xOf', archive, 'index.json'], { encoding: 'utf8' }))
  let manifest: Buffer | undefined
  let manifestDigest = ''
  for (let depth = 0; depth < 4; depth++) {
    assert.ok(typeof parsed === 'object' && parsed !== null)
    if ('config' in parsed && 'layers' in parsed) break
    assert.ok('manifests' in parsed && Array.isArray(parsed.manifests) && parsed.manifests.length === 1,
      'Expected exactly one image manifest; indexes with attestations/multiple platforms are unsupported')
    const entry = descriptor(parsed.manifests[0])
    manifest = blob(archive, entry.digest)
    assert.equal(manifest.length, entry.size)
    manifestDigest = entry.digest
    parsed = JSON.parse(manifest.toString())
  }
  assert.ok(manifest && typeof parsed === 'object' && parsed !== null &&
    'config' in parsed && 'layers' in parsed && Array.isArray(parsed.layers) && 'mediaType' in parsed)
  const mediaType = parsed.mediaType
  assert.ok(mediaType === 'application/vnd.oci.image.manifest.v1+json' ||
    mediaType === 'application/vnd.docker.distribution.manifest.v2+json')
  const blobs = [descriptor(parsed.config), ...parsed.layers.map(descriptor)]
  // Validate every byte before publishing anything.
  for (const entry of blobs) assert.equal(blob(archive, entry.digest).length, entry.size)
  const manifestFile = resolve(work, 'manifest.json')
  writeFileSync(manifestFile, manifest, { mode: 0o600 })
  for (const entry of blobs) {
    const bytes = blob(archive, entry.digest)
    assert.equal(bytes.length, entry.size)
    const available = aws(region, ['ecr', 'batch-check-layer-availability', '--repository-name', repository, '--layer-digests', entry.digest, '--query', 'layers[0].layerAvailability', '--output', 'text'])
    if (available === 'AVAILABLE') { console.log(`${region} already present ${entry.digest}`); continue }
    const started: unknown = JSON.parse(aws(region, ['ecr', 'initiate-layer-upload', '--repository-name', repository, '--output', 'json']))
    assert.ok(typeof started === 'object' && started !== null && 'uploadId' in started && typeof started.uploadId === 'string' && 'partSize' in started && typeof started.partSize === 'number')
    const uploadId = started.uploadId
    const partSize = Math.min(started.partSize, 20 * 1024 * 1024)
    assert.ok(Number.isSafeInteger(partSize) && partSize >= 5 * 1024 * 1024)
    const file = resolve(work, 'upload-part.bin')
    try {
      for (let offset = 0; offset < bytes.length; offset += partSize) {
        const part = bytes.subarray(offset, offset + partSize)
        writeFileSync(file, part, { mode: 0o600 })
        aws(region, ['ecr', 'upload-layer-part', '--repository-name', repository, '--upload-id', uploadId,
          '--part-first-byte', String(offset), '--part-last-byte', String(offset + part.length - 1), '--layer-part-blob', `fileb://${file}`])
      }
      aws(region, ['ecr', 'complete-layer-upload', '--repository-name', repository, '--upload-id', uploadId, '--layer-digests', entry.digest])
      console.log(`${region} uploaded ${entry.digest}`)
    } finally { rmSync(file, { force: true }) }
  }
  aws(region, ['ecr', 'put-image', '--repository-name', repository, '--image-tag', release,
    '--image-manifest', `file://${manifestFile}`, '--image-manifest-media-type', mediaType, '--image-digest', manifestDigest])
  console.log(`${region}: published ${release} at ${manifestDigest}`)
  return manifestDigest
}
