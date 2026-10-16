import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { digest } from '../recovery/archive.ts'
import { requireNativeRejection } from '../recovery/native-failure.ts'

const snapshotId = process.argv[2]
if (!snapshotId || !/^[a-f0-9-]{36}$/.test(snapshotId)) throw new Error('Provide a committed archive snapshot UUID')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
const local = resolve('.deploy/celld', prefix, 'snapshots', snapshotId)
const manifestFile = existsSync(resolve(local, 'frozen-manifest.json')) ? resolve(local, 'frozen-manifest.json') : resolve(local, 'manifest.json')
const manifestBytes = readFileSync(manifestFile)
const manifest = JSON.parse(manifestBytes.toString())
const commit = JSON.parse(readFileSync(resolve(local, 'commit.json'), 'utf8'))
if (!manifest.objectsByteVerified || manifest.snapshotId !== snapshotId || digest(manifestBytes) !== commit.manifestSha256) throw new Error('Commit evidence mismatch')
const verifier = resolve('.omx/local/ltx-verifier/target/debug/celld-lab-ltx-verifier')
const attestation = JSON.parse(readFileSync('.omx/local/ltx-verifier/attestation.json', 'utf8'))
if (attestation.sourceCommit !== '90b43017241f81189453d326d05948f388b34652' || digest(readFileSync(verifier)) !== attestation.binarySha256
  || digest(readFileSync('experiments/celld/recovery/verify-ltx.rs')) !== attestation.helperSha256) throw new Error('Offline decoder does not match pinned build evidence')
const output = resolve(local, 'decoded', randomUUID()); mkdirSync(output, { recursive: true, mode: 0o700 })
const verificationStarted = performance.now()
const ledger = JSON.parse(readFileSync(resolve('.deploy/celld', prefix, 'acknowledgement-ledger.json'), 'utf8'))
if (ledger.scope !== 'isolated-counter-and-workflow-lab' || !Array.isArray(ledger.commands) || ledger.commands.length !== 3) throw new Error('Requires the verified cross-node laboratory acknowledgement ledger')
const rows: object[] = []
const cells = new Map<string, string>()
function stage(cell: string, epoch: string, level: number, min: string, max: string, file: string) {
  if (!cell || !/^[1-9]\d*$/.test(epoch) || !Number.isInteger(level) || level < 0 || level > 9 || !/^[a-f0-9]{16}$/.test(min) || !/^[a-f0-9]{16}$/.test(max)) throw new Error('Invalid recovery segment coordinates')
  const root = resolve(output, 'epochs', digest(Buffer.from(cell)))
  const directory = resolve(root, `e${epoch}`, 'ltx', String(level)); mkdirSync(directory, { recursive: true, mode: 0o700 })
  const target = resolve(directory, `${min}-${max}.ltx`)
  const bytes = readFileSync(file)
  if (existsSync(target)) { if (digest(readFileSync(target)) !== digest(bytes)) throw new Error('Conflicting duplicate segment'); }
  else writeFileSync(target, bytes, { mode: 0o600 })
  cells.set(cell, root)
}
const run = (args: string[]) => execFileSync(verifier, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let corruptionsRejected = 0
let acknowledgedHistories = 0
for (const object of manifest.objects.filter((row: any) => row.source.Key.includes('/ltx/') && row.source.Key.endsWith('.ltx'))) {
  const basename = object.archiveKey.split('/').at(-1)
  if (!/^[a-f0-9]{64}$/.test(basename)) throw new Error('Invalid archive object basename')
  const file = resolve(local, basename + '.bin')
  const bytes = readFileSync(file)
  if (digest(bytes) !== object.sha256 || bytes.length !== object.source.Size) throw new Error('Archived bytes differ from commit evidence')
  const header = run([file]).split('\n')[0]!.split('\t')
  const filename = object.source.Key.match(/([a-f0-9]{16})-([a-f0-9]{16})\.ltx$/)
  if (!filename || header[0] !== 'HEADER' || header[1] !== filename[1] || header[2] !== filename[2]) throw new Error('LTX payload header disagrees with archived range filename')
  const corrupted = Buffer.from(bytes); corrupted[Math.floor(bytes.length / 2)] = corrupted[Math.floor(bytes.length / 2)]! ^ 255
  const corruptFile = resolve(output, basename + '-corrupt.ltx'); writeFileSync(corruptFile, corrupted, { mode: 0o600 })
  let rejected = false
  try { run([corruptFile]) } catch (error) { requireNativeRejection(error); rejected = true }
  if (!rejected) throw new Error('Decoder accepted deliberately corrupted payload')
  corruptionsRejected++
  const coordinates = object.source.Key.match(/^fleet\/cells\/([^/]+)\/ltx\/e([1-9]\d*)\/(\d+)\//)
  if (!coordinates) throw new Error('Invalid per-cell LTX key')
  stage(coordinates[1]!, coordinates[2]!, Number(coordinates[3]), header[1]!, header[2]!, file)
  const row: any = { sourceKey: object.source.Key, sourceVersion: object.source.VersionId, minTxid: header[1], maxTxid: header[2], pageSize: Number(header[3]), commitPages: Number(header[4]), snapshot: header[5] === 'true', fullLtxPayloadValidated: true }
  if (row.snapshot) {
    const database = resolve(output, basename + '.sqlite')
    run([file, database]) // New isolated file only, never a celld serving volume.
    const integrity = execFileSync('sqlite3', [database, 'PRAGMA integrity_check;'], { encoding: 'utf8', timeout: 15_000 }).trim()
    if (integrity !== 'ok') throw new Error('Reconstructed SQLite image failed integrity_check')
    row.sqliteIntegrity = integrity
    if (object.source.Key.startsWith('fleet/cells/Counter:')) {
      const commands = JSON.parse(execFileSync('sqlite3', ['-json', database, 'SELECT sequence, operation_id AS operationId, delta, value FROM commands ORDER BY sequence;'], { encoding: 'utf8' }))
      row.applicationCommandHistory = commands
    }
    row.database = database
  }
  rows.push(row)
}
for (const object of manifest.objects.filter((row: any) => row.source.Key.endsWith('.ltxb'))) {
  const basename = object.archiveKey.split('/').at(-1)
  if (!/^[a-f0-9]{64}$/.test(basename)) throw new Error('Invalid bundle basename')
  const file = resolve(local, basename + '.bin'), bytes = readFileSync(file)
  if (digest(bytes) !== object.sha256 || bytes.length !== object.source.Size) throw new Error('Bundle differs from archive evidence')
  const bundleDirectory = resolve(output, 'bundles', basename); mkdirSync(bundleDirectory, { recursive: true, mode: 0o700 })
  const entries = run(['--bundle', file, bundleDirectory]).split('\n').filter(Boolean)
  for (const line of entries) {
    const [kind, index, cell, epoch, min, max, name] = line.split('\t')
    if (kind !== 'BUNDLE' || !cell || !epoch || !min || !max || !name || name !== `entry-${index}.ltx`) throw new Error('Invalid decoded bundle row')
    const payloadFile = resolve(bundleDirectory, name)
    stage(cell, epoch, 0, min, max, payloadFile)
    const corrupted = readFileSync(payloadFile); corrupted[Math.floor(corrupted.length / 2)] = corrupted[Math.floor(corrupted.length / 2)]! ^ 255
    const corruptFile = resolve(bundleDirectory, `entry-${index}-corrupt.ltx`); writeFileSync(corruptFile, corrupted, { mode: 0o600 })
    let rejected = false; try { run([corruptFile]) } catch (error) { requireNativeRejection(error); rejected = true }
    if (!rejected) throw new Error('Decoder accepted corrupted bundle payload')
    corruptionsRejected++
    rows.push({ sourceBundleKey: object.source.Key, sourceBundleVersion: object.source.VersionId, cell, epoch, minTxid: min, maxTxid: max, fullLtxPayloadValidated: true })
  }
}
const restoredCells: object[] = []
const negativeFixtures: object[] = []
for (const [cell, root] of cells) {
  const database = resolve(output, digest(Buffer.from(cell)) + '-restored.sqlite')
  const restoreStarted = performance.now()
  const restoreReport = run(['--restore-epochs', root, database])
  const restoreElapsedMs = performance.now() - restoreStarted
  if (!restoreReport.startsWith('RESTORED\t')) throw new Error('No native restore completion report')
  const integrity = execFileSync('sqlite3', [database, 'PRAGMA integrity_check;'], { encoding: 'utf8', timeout: 15_000 }).trim()
  if (integrity !== 'ok') throw new Error('Epoch-chain reconstruction failed SQLite integrity')
  const row: any = { cell, restoreReport, restoreElapsedMs, sqliteIntegrity: integrity, database, databaseSha256: digest(readFileSync(database)) }
  if (cell.startsWith('Counter:')) {
    const commands = JSON.parse(execFileSync('sqlite3', ['-json', database, 'SELECT sequence, operation_id AS operationId, delta, value FROM commands ORDER BY sequence;'], { encoding: 'utf8' }))
    row.commands = commands
    if (commands.some((value: any) => value.operationId === ledger.commands[0].operationId)) {
      if (JSON.stringify(commands) !== JSON.stringify(ledger.commands)) throw new Error('Recovered bundle+LTX command history disagrees with external acknowledgements')
      acknowledgedHistories++; row.externalAcknowledgementLedgerMatched = true
      // The controlled ledger dataset is three single-TXID L0 segments. Remove
      // indispensable files only in NEW local copies, never in the archive.
      const level = resolve(root, 'e1', 'ltx', '0')
      const segments = existsSync(level) ? readdirSync(level).filter(name => name.endsWith('.ltx')).sort() : []
      const levelRoot = resolve(root, 'e1', 'ltx')
      const isolatedThreeSegmentLayout = readdirSync(root).length === 1 && existsSync(levelRoot)
        && readdirSync(levelRoot).length === 1 && readdirSync(levelRoot)[0] === '0'
      if (isolatedThreeSegmentLayout && segments.length === 3 && segments.every((name, index) => name === `${String(index + 1).padStart(16, '0')}-${String(index + 1).padStart(16, '0')}.ltx`)) {
        for (const [index, label] of ['missing-base', 'missing-middle', 'missing-newest-tail'].entries()) {
          const fixture = resolve(output, 'negative', label); cpSync(root, fixture, { recursive: true })
          unlinkSync(resolve(fixture, 'e1', 'ltx', '0', segments[index]!))
          const target = resolve(output, `${label}.sqlite`)
          let result: string | undefined
          try { result = run(['--restore-epochs', fixture, target]) } catch (error) { requireNativeRejection(error, 'transaction not available') }
          if (index < 2) {
            if (result) throw new Error(`Offline native restore accepted ${label}`)
            negativeFixtures.push({ label, nativeRestoreRejected: true })
          } else {
            if (!result) throw new Error('Expected a structurally continuous but stale tail fixture')
            const recovered = JSON.parse(execFileSync('sqlite3', ['-json', target, 'SELECT sequence, operation_id AS operationId, delta, value FROM commands ORDER BY sequence;'], { encoding: 'utf8' }))
            if (JSON.stringify(recovered) === JSON.stringify(ledger.commands)) throw new Error('Missing-tail fixture was not detected by ledger')
            negativeFixtures.push({ label, nativeRestoreSucceeded: true, externalLedgerDetectedMissingAcknowledgements: true, recovered })
          }
        }
      } else negativeFixtures.push({
        label: 'epoch-1-three-segment-fixtures-not-applicable',
        executed: false,
        reason: 'This acknowledged dataset is not three indispensable epoch-1 L0 files. Do not treat redundant snapshots or actual takeover history as that synthetic fixture; native reconstruction and exact ledger comparison remain required.',
      })
    }
  }
  restoredCells.push(row)
}
if (rows.length === 0) throw new Error('No LTX payload verified')
const expectMissing = process.argv.includes('--expect-missing-acknowledgements')
if (expectMissing ? acknowledgedHistories !== 0 : acknowledgedHistories !== 1) throw new Error('Archive acknowledgement coverage did not match the requested positive/negative probe; no recovery claim')
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({ observedAt: new Date().toISOString(), sourceCommit: attestation.sourceCommit, snapshotId, rows, restoredCells, negativeFixtures, totalVerificationElapsedMs: performance.now() - verificationStarted, corruptionsRejected, acknowledgedHistories, expectMissing, acknowledgementLedger: ledger, scope: 'Offline pinned decoder checksum/page/index validation and snapshot SQLite reconstruction; timings include local child-process launch/IO, NOT regional RTO, native epoch import, global consistency, unsent peerlog coverage, application side-effect reconciliation, or regional authorization' }), { mode: 0o600 })
if (expectMissing) {
  console.log('OBSERVED: checksum-valid archived databases are missing the newer acknowledged laboratory history. Stale checkpoint detected; native import/promotion remains unauthorized. This is not a measured CRR-loss window.')
  process.exit(0)
}
console.log(`PASS: ${rows.length} full LTX payloads validated; ${corruptionsRejected} corrupted fixtures rejected. ${restoredCells.length} cell images restored from snapshots/bundles passed SQLite integrity; one counter/dedup history exactly matched the external acknowledgement ledger. No serving writes, epoch import or promotion.`)
