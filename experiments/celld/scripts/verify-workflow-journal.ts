import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync,writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deserialize } from 'node:v8'
import { digest } from '../recovery/archive.ts'
import { inspectApprovalJournal,inspectWakePublication } from '../recovery/workflow-journal.ts'
const [snapshot,verification]=process.argv.slice(2)
if (![snapshot,verification].every(value=>value && /^[a-f0-9-]{36}$/.test(value))) throw new Error('Usage: verify-workflow-journal.ts SNAPSHOT_UUID VERIFICATION_UUID')
const prefix=process.env.CELLD_STACK_PREFIX??'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Invalid isolated prefix')
const local=resolve('.deploy/celld',prefix,'snapshots',snapshot!)
const directory=resolve(local,'decoded',verification!)
const sourceBytes=readFileSync(resolve(directory,'verification.json')),source=JSON.parse(sourceBytes.toString())
assert.equal(source.snapshotId,snapshot);assert.equal(source.acknowledgedHistories,1)
const ledger=source.acknowledgementLedger
assert.equal(ledger.scope,'isolated-counter-and-workflow-lab')
const manifestBytes=readFileSync(resolve(local,'frozen-manifest.json')),manifest=JSON.parse(manifestBytes.toString())
const commit=JSON.parse(readFileSync(resolve(local,'commit.json'),'utf8'))
assert.equal(digest(manifestBytes),commit.manifestSha256)
assert.equal(manifest.snapshotId,snapshot);assert.equal(manifest.objectsByteVerified,true)
const verifier=resolve('.omx/local/ltx-verifier/target/debug/celld-lab-ltx-verifier')
const attestation=JSON.parse(readFileSync('.omx/local/ltx-verifier/attestation.json','utf8'))
assert.equal(attestation.sourceCommit,'90b43017241f81189453d326d05948f388b34652')
assert.equal(digest(readFileSync(verifier)),attestation.binarySha256)
assert.equal(digest(readFileSync('experiments/celld/recovery/verify-ltx.rs')),attestation.helperSha256)
const sql=(db: string,query: string)=>JSON.parse(execFileSync('sqlite3',['-readonly','-json',db,query],{encoding:'utf8',timeout:15_000,maxBuffer:4*1024*1024}) || '[]')
const matches: object[]=[]
for (const row of source.restoredCells.filter((value:any)=>value.cell.startsWith('__Workflow.'))) {
  const db=resolve(directory,row.database.split('/').at(-1))
  assert.equal(digest(readFileSync(db)),row.databaseSha256,'Reconstruct with current verifier to record database digest')
  const rows=sql(db,'SELECT scope,k,hex(v) AS encoded FROM _cf_KV;')
  const values=new Map<string,unknown>()
  for (const entry of rows) {
    assert.equal(entry.scope,row.cell);assert.equal(typeof entry.k,'string')
    assert.ok(typeof entry.encoded==='string' && /^[A-F0-9]+$/.test(entry.encoded) && entry.encoded.length<=128*1024 && entry.encoded.length%2===0)
    const bytes=Buffer.from(entry.encoded,'hex')
    assert.equal(bytes[0],255);assert.equal(bytes[1],15,'Only tested pinned V8 wire version 15 supported')
    assert.ok(!values.has(entry.k));values.set(entry.k,deserialize(bytes))
  }
  const meta=values.get('__wf.meta') as {instanceId?:unknown}|undefined
  if(meta?.instanceId!==ledger.id) continue
  const alarms=sql(db,'SELECT at_ms FROM _cf_ALARM;'),wakes=sql(db,'SELECT epoch,CAST(sequence AS TEXT) AS sequence,at_ms FROM _cf_WAKE;')
  assert.equal(alarms.length,1);assert.equal(wakes.length,1)
  const summary=inspectApprovalJournal(values,ledger.id,ledger.commands,alarms[0].at_ms,wakes[0].at_ms)
  const wake=wakes[0]
  assert.match(wake.epoch,/^[a-f0-9]{16}$/);assert.ok(BigInt('0x'+wake.epoch)>0n);assert.match(wake.sequence,/^(0|[1-9][0-9]*)$/)
  const result=execFileSync(verifier,['--wake-key',row.cell,wake.epoch,wake.sequence,String(wake.at_ms)],{encoding:'utf8',timeout:15_000}).trim()
  assert.ok(result.startsWith('WAKE_KEY\t'))
  const key='fleet/'+result.slice('WAKE_KEY\t'.length)
  const entries=manifest.objects.filter((value:any)=>value.source.Key===key)
  assert.equal(entries.length,1,'Exact native wake publication absent from captured archive')
  const entry=entries[0],basename=entry.archiveKey.split('/').at(-1)
  assert.match(basename,/^[a-f0-9]{64}$/)
  const bytes=readFileSync(resolve(local,basename+'.bin'))
  assert.equal(digest(bytes),entry.sha256);assert.equal(bytes.length,entry.source.Size)
  inspectWakePublication(JSON.parse(bytes.toString('utf8')),row.cell,wake.at_ms,key.split('/').at(-1)!)
  matches.push({cell:row.cell,databaseSha256:row.databaseSha256,...summary,wakeKey:key,wakeVersion:entry.source.VersionId,wakeBytesVerified:true,wakeBodyVerified:true})
}
assert.equal(matches.length,1,'Exactly one recovered laboratory Workflow journal must match')
writeFileSync(resolve(directory,'workflow-journal.json'),JSON.stringify({observedAt:new Date().toISOString(),sourceVerificationSha256:digest(sourceBytes),node:process.version,v8:process.versions.v8,attestation,matches,
  scope:'Read-only offline validation of this completed approval lab journal, retention alarm and captured native wake key using tested V8 wire15 values. Not generic runtime value compatibility, Workflow execution/replay, destination import, complete checkpoint, latest wake state, authorization or regional recovery.'}),{mode:0o600})
console.log('PASS: recovered Workflow metadata, four completed steps, consumed approval, exact counter outputs, retention alarm and native wake publication agree. No replay/import/activation.')
