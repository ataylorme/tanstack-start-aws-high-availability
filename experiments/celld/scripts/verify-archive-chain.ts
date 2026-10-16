import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { digest } from '../recovery/archive.ts'

const snapshotId = process.argv[2]
if (!snapshotId || !/^[a-f0-9-]{36}$/.test(snapshotId)) throw new Error('Provide a locally committed archive snapshot UUID')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
const local = resolve('.deploy/celld', prefix, 'snapshots', snapshotId)
const manifest = JSON.parse(readFileSync(resolve(local, 'manifest.json'), 'utf8'))
const commit = JSON.parse(readFileSync(resolve(local, 'commit.json'), 'utf8'))
if (manifest.snapshotId !== snapshotId || !manifest.objectsByteVerified || digest(readFileSync(resolve(local, 'manifest.json'))) !== commit.manifestSha256) throw new Error('Archive commit evidence mismatch')
const objects = new Map<string, { bytes: Buffer; etag: string }>()
for (const object of manifest.objects) {
  const bytes = readFileSync(resolve(local, object.archiveKey.split('/').at(-1) + '.bin'))
  if (bytes.length !== object.source.Size || digest(bytes) !== object.sha256) throw new Error('Local version bytes differ from verified archive')
  // This fixture exposes cell history only, never deployment secrets or peers.
  if (object.source.Key.startsWith('fleet/cells/')) objects.set(object.source.Key, { bytes, etag: object.source.ETag })
}
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const omitLtx = process.argv.includes('--omit-ltx')
let omittedKey: string | undefined
let corruptedKey: string | undefined
if (omitLtx) {
  omittedKey = [...objects.keys()].find(key => key.includes('/ltx/') && key.endsWith('.ltx'))
  if (!omittedKey) throw new Error('No LTX segment available for the incomplete-history fixture')
  objects.delete(omittedKey) // Fixture only; the real archive is untouched.
}
if (process.argv.includes('--corrupt-ltx')) {
  corruptedKey = [...objects.keys()].find(key => key.includes('/ltx/') && key.endsWith('.ltx'))
  if (!corruptedKey) throw new Error('No LTX segment available for corruption fixture')
  const object = objects.get(corruptedKey)!
  const bytes = Buffer.from(object.bytes); bytes[0] = bytes[0]! ^ 255
  objects.set(corruptedKey, { ...object, bytes }) // Same key/size/ETag, corrupt payload.
}
let deniedMutations = 0, reads = 0
const chainScopes = new Set<string>()
// A loopback read-only S3 view. No production credentials, native server,
// actor activation, metadata writes, object deletion, or epoch import.
const server = createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) { deniedMutations++; response.writeHead(405); response.end(); return }
  reads++
  const url = new URL(request.url!, 'http://localhost')
  const key = decodeURIComponent(url.pathname.replace(/^\/snapshot\/?/, ''))
  const scope = (key || url.searchParams.get('prefix') || '').match(/^fleet\/cells\/([^/]+)\//)?.[1]
  if (scope) chainScopes.add(scope)
  if (url.searchParams.has('list-type')) {
    const filter = url.searchParams.get('prefix') ?? ''
    const delimiter = url.searchParams.get('delimiter')
    const prefixes = new Set<string>()
    const entries: string[] = []
    if (url.searchParams.has('continuation-token') || objects.size > 1000) { response.writeHead(400); response.end(); return }
    const startAfter = url.searchParams.get('start-after') ?? ''
    for (const [name, object] of [...objects].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      if (!name.startsWith(filter)) continue
      if (name <= startAfter) continue
      const suffix = name.slice(filter.length)
      if (delimiter && suffix.includes(delimiter)) { prefixes.add(filter + suffix.split(delimiter)[0] + delimiter); continue }
      entries.push(`<Contents><Key>${escape(name)}</Key><LastModified>${manifest.inventoryObservedAt}</LastModified><ETag>${escape(object.etag)}</ETag><Size>${object.bytes.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
    }
    response.writeHead(200, { 'content-type': 'application/xml' })
    response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>snapshot</Name><Prefix>${escape(filter)}</Prefix><KeyCount>${entries.length + prefixes.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${entries.join('')}${[...prefixes].map(name => `<CommonPrefixes><Prefix>${escape(name)}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`)
    return
  }
  const object = objects.get(key)
  if (!object) { response.writeHead(404, { 'content-type': 'application/xml' }); response.end('<Error><Code>NoSuchKey</Code></Error>'); return }
  let bytes = object.bytes
  const headers: Record<string, string | number> = { etag: object.etag, 'content-length': bytes.length, 'last-modified': new Date(manifest.inventoryObservedAt).toUTCString() }
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
  let status = 200
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(bytes.length - 1, Number(range[2])) : bytes.length - 1
    if (start > end || start >= bytes.length) { response.writeHead(416); response.end(); return }
    bytes = bytes.subarray(start, end + 1); headers['content-length'] = bytes.length; headers['content-range'] = `bytes ${start}-${end}/${object.bytes.length}`; status = 206
  }
  response.writeHead(status, headers); response.end(request.method === 'HEAD' ? undefined : bytes)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Loopback fixture did not bind')
try {
  const child = spawn(resolve('.omx/local/celld-bin/celld'), ['cell', 'gc', '--dry-run', '--all', '--json', '--bucket', 's3://snapshot/fleet', '--endpoint', `http://127.0.0.1:${address.port}`, '--region', 'us-east-1'], {
    env: { ...process.env, AWS_ACCESS_KEY_ID: 'local-fixture', AWS_SECRET_ACCESS_KEY: 'local-fixture', AWS_SESSION_TOKEN: '', AWS_EC2_METADATA_DISABLED: 'true', S3_ENDPOINT: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += String(data) }); child.stderr.on('data', data => { stderr += String(data) })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const [code] = await once(child, 'exit'); clearTimeout(timeout)
  writeFileSync(resolve(local, omitLtx ? 'native-incomplete-history-report.json' : corruptedKey ? 'native-corrupt-history-report.json' : 'native-chain-report.json'), JSON.stringify({ code, stdout, stderr, reads, deniedMutations, omittedKey, corruptedKey, restorePlanValidated: false, scope: 'pinned native GC inventory observation only; CLI can swallow restore-plan errors. No activation/hydration/complete-chain validation or execution fence' }), { mode: 0o600 })
  if (code !== 0 || deniedMutations) throw new Error('Native read-only chain check failed; inspect ignored report')
  // GC prints deletion candidates, not every inspected cell; zero candidates
  // legitimately produces no stdout. Assert actual per-cell reads instead.
  const expectedScopes = new Set([...objects.keys()].map(key => key.match(/^fleet\/cells\/([^/]+)\//)?.[1]).filter(Boolean))
  if (!expectedScopes.size || [...expectedScopes].some(scope => !chainScopes.has(scope!))) throw new Error('Native check did not inspect every archived cell')
  console.log(`OBSERVED: pinned native GC returned success after reading ${chainScopes.size} archived cell histories${omitLtx ? ' despite intentionally omitted LTX history' : corruptedKey ? ' despite intentionally corrupted LTX bytes' : ''}. This CLI suppresses restore-plan failures and is NOT a recovery-chain validator. No hydration or epoch import proved.`)
} finally { await new Promise<void>(resolve => server.close(() => resolve())) }
