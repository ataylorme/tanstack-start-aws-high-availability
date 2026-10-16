import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { digest } from '../recovery/archive.ts'
const [snapshotId, verificationId]=process.argv.slice(2)
const uuid=/^[a-f0-9-]{36}$/
if (!snapshotId || !verificationId || !uuid.test(snapshotId) || !uuid.test(verificationId)) throw new Error('Usage: verify-cross-epoch.ts SNAPSHOT_UUID POSITIVE_VERIFICATION_UUID (offline fixtures only)')
const prefix=process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Invalid isolated prefix')
const base=resolve('.deploy/celld',prefix,'snapshots',snapshotId,'decoded',verificationId)
const positiveBytes=readFileSync(resolve(base,'verification.json'))
const positive=JSON.parse(positiveBytes.toString())
assert.equal(positive.snapshotId,snapshotId);assert.equal(positive.acknowledgedHistories,1)
const ledger=positive.acknowledgementLedger
assert.equal(ledger.scope,'isolated-counter-and-workflow-lab');assert.equal(ledger.commands.length,3)
const cell=positive.restoredCells.find((row: any)=>row.externalAcknowledgementLedgerMatched===true)?.cell
assert.ok(typeof cell==='string' && cell.startsWith('Counter:'))
const verifier=resolve('.omx/local/ltx-verifier/target/debug/celld-lab-ltx-verifier')
const attestation=JSON.parse(readFileSync('.omx/local/ltx-verifier/attestation.json','utf8'))
assert.equal(attestation.sourceCommit,'90b43017241f81189453d326d05948f388b34652')
assert.equal(attestation.binarySha256,digest(readFileSync(verifier)))
assert.equal(attestation.helperSha256,digest(readFileSync('experiments/celld/recovery/verify-ltx.rs')))
assert.equal(attestation.lockSha256,digest(readFileSync('.omx/local/ltx-verifier/Cargo.lock')))
const segmentName=(txid: number)=>{const hex=txid.toString(16).padStart(16,'0');return `${hex}-${hex}.ltx`}
const local=resolve('.deploy/celld',prefix,'snapshots',snapshotId)
const manifestBytes=readFileSync(resolve(local,'frozen-manifest.json'))
const manifest=JSON.parse(manifestBytes.toString())
const commit=JSON.parse(readFileSync(resolve(local,'commit.json'),'utf8'))
assert.equal(manifest.snapshotId,snapshotId);assert.equal(manifest.objectsByteVerified,true)
assert.equal(digest(manifestBytes),commit.manifestSha256)
const output=resolve(base,'cross-epoch',randomUUID());mkdirSync(output,{recursive:true,mode:0o700})
// Re-extract from committed original bundle bytes, not trusted mutable staging.
const segments=new Map<number,Buffer>()
for (const object of manifest.objects.filter((row: any)=>row.source.Key.endsWith('.ltxb'))) {
  const basename=object.archiveKey.split('/').at(-1)
  assert.match(basename,/^[a-f0-9]{64}$/)
  const file=resolve(local,basename+'.bin'), data=readFileSync(file)
  assert.equal(digest(data),object.sha256);assert.equal(data.length,object.source.Size)
  const extraction=resolve(output,'bundles',basename);mkdirSync(extraction,{recursive:true,mode:0o700})
  const decoded=execFileSync(verifier,['--bundle',file,extraction],{encoding:'utf8',timeout:15_000}).trim()
  for (const line of decoded.split('\n').filter(Boolean)) {
    const [kind,index,rowCell,epoch,min,max,name]=line.split('\t')
    assert.equal(kind,'BUNDLE');assert.equal(name,`entry-${index}.ltx`)
    if (rowCell!==cell || epoch!=='1' || min!==max || !min || !/^[a-f0-9]{16}$/.test(min)) continue
    const txid=Number.parseInt(min,16)
    if (txid<1 || txid>3) continue
    const payload=readFileSync(resolve(extraction,name!))
    if (segments.has(txid)) assert.equal(digest(segments.get(txid)!),digest(payload),'Conflicting source segment')
    segments.set(txid,payload)
  }
}
assert.equal(segments.size,3,'Need three verified original bundled payloads')
const bytes=[1,2,3].map(txid=>segments.get(txid)!)
const fixtures=[
  {name:'three-continued-epochs',layout:[[1,[1]],[2,[2]],[3,[3]]],spans:'1:0000000000000001,2:0000000000000002,3:0000000000000003',outcome:'exact'},
  {name:'skip-incomplete-intermediate',layout:[[1,[1,2]],[2,[1]],[3,[3]]],spans:'1:0000000000000001,3:0000000000000003',outcome:'exact'},
  {name:'clip-old-epoch-tail',layout:[[1,[1,2,3]],[3,[3]]],spans:'1:0000000000000001,3:0000000000000003',outcome:'exact'},
  {name:'missing-base',layout:[[2,[2]],[3,[3]]],outcome:'reject'},
  {name:'missing-link',layout:[[1,[1]],[3,[3]]],outcome:'reject'},
  {name:'missing-newest-epoch',layout:[[1,[1,2]]],spans:'1:0000000000000001',outcome:'stale'},
] as const
const rows: object[]=[]
for (const fixture of fixtures) {
  const root=resolve(output,fixture.name);mkdirSync(root,{recursive:true,mode:0o700})
  for (const [epoch,txids] of fixture.layout) {
    const directory=resolve(root,`e${epoch}`,'ltx','0');mkdirSync(directory,{recursive:true,mode:0o700})
    for (const txid of txids) {
      const file=resolve(directory,segmentName(txid));writeFileSync(file,bytes[txid-1]!,{mode:0o600})
      const header=execFileSync(verifier,[file],{encoding:'utf8',timeout:15_000}).trim().split('\t')
      assert.equal(header[0],'HEADER');assert.equal(header[1],txid.toString(16).padStart(16,'0'));assert.equal(header[2],header[1])
    }
  }
  const database=resolve(output,`${fixture.name}.sqlite`)
  let report: string|undefined
  let rejection: string|undefined
  const started=performance.now()
  try {report=execFileSync(verifier,['--restore-epochs',root,database],{encoding:'utf8',timeout:15_000,stdio:['ignore','pipe','pipe']})} catch (error) {
    const failure=error as {status?:number;signal?:string|null;stderr?:string}
    assert.equal(failure.status,1);assert.ok(!failure.signal)
    assert.equal(failure.stderr?.trim(),'LTX verification failed: transaction not available')
    rejection=failure.stderr!.trim()
  }
  const milliseconds=performance.now()-started
  if (fixture.outcome==='reject') {
    assert.equal(report,undefined,`${fixture.name} unexpectedly restored`)
    rows.push({fixture:fixture.name,nativeRestoreRejected:true,rejection,milliseconds});continue
  }
  assert.ok(report && report.startsWith('RESTORED\t'))
  const reportLines=report.trim().split('\n')
  assert.equal(reportLines.length,2)
  assert.match(reportLines[0]!,/^RESTORED\t\d+\t\d+\t[a-f0-9]{16}$/)
  assert.equal(reportLines[1],`SPANS\t${fixture.spans}`)
  assert.equal(execFileSync('sqlite3',[database,'PRAGMA integrity_check;'],{encoding:'utf8',timeout:15_000}).trim(),'ok')
  const commands=JSON.parse(execFileSync('sqlite3',['-json',database,'SELECT sequence, operation_id AS operationId, delta, value FROM commands ORDER BY sequence;'],{encoding:'utf8',timeout:15_000}))
  const matches=JSON.stringify(commands)===JSON.stringify(ledger.commands)
  assert.equal(matches,fixture.outcome==='exact')
  if (fixture.outcome==='stale') assert.deepEqual(commands,ledger.commands.slice(0,2),'Missing newest epoch must lose exactly the final acknowledged command')
  rows.push({fixture:fixture.name,nativeRestoreRejected:false,historicalAcknowledgementsMatched:matches,commands,report,milliseconds})
}
writeFileSync(resolve(output,'results.json'),JSON.stringify({observedAt:new Date().toISOString(),snapshotId,verificationId,attestation,
  sourceVerificationSha256:digest(positiveBytes),sourceSegmentSha256:bytes.map(value=>digest(value)),historicalAcknowledgementLedger:ledger,rows,
  scope:'Synthetic offline epoch placements of three archived lab LTX payloads. Uses actual pinned EpochChain and SQLite restore. Historical ledger, NOT latest acknowledgements, actual deployed cross-epoch history, retirement provenance, region hydration/RTO, import or authority. No AWS calls, actors or serving records.'}),{mode:0o600})
console.log('PASS: 3 synthetic cross-epoch layouts restored exact historical commands; 2 incomplete chains rejected; 1 structurally valid stale tail detected. NOT deployed cross-epoch or retirement/import/fencing proof.')
