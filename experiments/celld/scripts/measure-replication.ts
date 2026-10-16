import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs'
import {resolve} from 'node:path'
import {digest} from '../recovery/archive.ts'
import {requireNativeRejection} from '../recovery/native-failure.ts'
import {acknowledgementObservation,exactMarkerHistory,isS3VersionAbsent,markerRestoreHasImage,immutableSqliteArgs} from '../measurements/replication-observation.ts'
if(!process.argv.includes('--execute')) {
  console.log('Plan only: one isolated Counter command via owned eastern SSM node; then READ-ONLY version-pinned native LTX/bundle downloads from source and actual CRR quarantine. Offline reconstruction must match exact command. No manual copy/backfill, recovery-ledger replacement, node fault, serving import or promotion. Timing is controller-observed conservative presence bounds, not guaranteed RPO. Requires explicit AWS_PROFILE and --execute.')
  process.exit(0)
}
const profile=process.env.AWS_PROFILE;assert.ok(profile,'Explicit AWS_PROFILE required')
const prefix=process.env.CELLD_STACK_PREFIX??'tanstack-celld-test';assert.match(prefix,/^tanstack-celld-[a-z0-9-]{1,24}$/)
const work=resolve('.deploy/celld',prefix),runId=crypto.randomUUID(),directory=resolve(work,'replication-observations',runId)
mkdirSync(directory,{recursive:true,mode:0o700})
const save=(name:string,value:unknown)=>writeFileSync(resolve(directory,name+'.json'),JSON.stringify(value),{mode:0o600})
const previousLedgerSha=digest(readFileSync(resolve(work,'acknowledgement-ledger.json')))
const origin=performance.now(),elapsed=()=>performance.now()-origin
let calls=0
function aws(region:string,service:string,args:string[]) {
  const endpoint=service==='s3api'?'s3':service==='elbv2'?'elasticloadbalancing':service
  const bytes=execFileSync('aws',['--profile',profile!,'--region',region,'--endpoint-url',`https://${endpoint}.${region}.amazonaws.com`,service,...args,'--output','json','--cli-connect-timeout','5','--cli-read-timeout','15'],{
    encoding:'utf8',timeout:25_000,maxBuffer:8*1024*1024,env:{...process.env,AWS_PAGER:'',AWS_MAX_ATTEMPTS:'1',AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true'},
  })
  save(`call-${++calls}`,{region,service,args,operation:args[0],response:JSON.parse(bytes||'{}')});return JSON.parse(bytes||'{}')
}
try {
const identity=aws('us-east-1','sts',['get-caller-identity'])
assert.equal(identity.Account,JSON.parse(readFileSync(resolve(work,'identity.json'),'utf8')).Account);assert.ok(!identity.Arn.endsWith(':root'))
const stacks:Record<string,any>={}
for(const region of ['us-east-1','us-west-2']) {
  const recorded=JSON.parse(readFileSync(resolve(work,`${region}-regional-stack.json`),'utf8'))
  const stack=aws(region,'cloudformation',['describe-stacks','--stack-name',recorded.StackId]).Stacks[0]
  assert.equal(stack.StackId,recorded.StackId);assert.equal(stack.StackName,prefix+'-regional');assert.ok(['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus))
  stacks[region]=Object.fromEntries(stack.Outputs.map((value:any)=>[value.OutputKey,value.OutputValue]))
}
const replication=JSON.parse(readFileSync(resolve(work,'replication.json'),'utf8'))
assert.equal(replication.archiveOnly,true);assert.equal(replication.destinationRegion,'us-west-2')
assert.equal(replication.source,stacks['us-east-1'].BucketName);assert.equal(replication.destination,stacks['us-west-2'].ArchiveBucketName)
assert.notEqual(replication.destination,stacks['us-west-2'].BucketName)
for(const [region,bucket] of [['us-east-1',replication.source],['us-west-2',replication.destination]]) aws(region,'s3api',['head-bucket','--bucket',bucket,'--expected-bucket-owner',identity.Account])
const verifier=resolve('.omx/local/ltx-verifier/target/debug/celld-lab-ltx-verifier'),attestation=JSON.parse(readFileSync('.omx/local/ltx-verifier/attestation.json','utf8'))
assert.equal(attestation.sourceCommit,'90b43017241f81189453d326d05948f388b34652');assert.equal(digest(readFileSync(verifier)),attestation.binarySha256);assert.equal(digest(readFileSync('experiments/celld/recovery/verify-ltx.rs')),attestation.helperSha256)
const native=(args:string[])=>execFileSync(verifier,args,{encoding:'utf8',timeout:15_000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}).trim()
const group=aws('us-east-1','autoscaling',['describe-auto-scaling-groups','--auto-scaling-group-names',stacks['us-east-1'].AutoScalingGroupName]).AutoScalingGroups[0]
assert.equal(group.Instances.length,2);assert.equal(new Set(group.Instances.map((value:any)=>value.AvailabilityZone)).size,2)
const health=aws('us-east-1','elbv2',['describe-target-health','--target-group-arn',stacks['us-east-1'].TargetGroupArn]).TargetHealthDescriptions
assert.ok(group.Instances.every((node:any)=>node.LifecycleState==='InService' && health.some((value:any)=>value.Target.Id===node.InstanceId && value.TargetHealth.State==='healthy')))
const instanceId=group.Instances[0].InstanceId,token=readFileSync(resolve(work,'lab-token'),'utf8').trim(),secret=readFileSync(resolve(work,'origin-secret'),'utf8').trim()
assert.ok([token,secret].every(value=>/^[a-f0-9]{64}$/.test(value)))
const id=`test-${runId}`,operationId=crypto.randomUUID(),expected={sequence:1,operationId,delta:7,value:7}
const basePython=`import json,time,urllib.request\nbase='http://127.0.0.1:8080/api/objects/Counter/'+${JSON.stringify(id)}\nheaders={'authorization':'Bearer '+${JSON.stringify(token)},'x-celld-origin-secret':${JSON.stringify(secret)},'x-forwarded-host':'backend-validation.cloudfront.net'}\ndef call(payload=None,extra=None):\n h={**headers,**(extra or {})}\n req=urllib.request.Request(base,data=json.dumps(payload).encode() if payload is not None else None,headers=h,method='POST' if payload else 'GET')\n with urllib.request.urlopen(req,timeout=20) as r:\n  assert r.status==200\n  return json.load(r)\n`
async function remote(phase:string,python:string) {
  const parameters=resolve(directory,phase+'-parameters.json');writeFileSync(parameters,JSON.stringify({commands:["python3 - <<'PY'\n"+basePython+python+'\nPY'],executionTimeout:['60']}),{mode:0o600})
  save(phase+'-intent',{status:'UNKNOWN',instanceId,submittedMs:elapsed()})
  const sent=aws('us-east-1','ssm',['send-command','--instance-ids',instanceId,'--document-name','AWS-RunShellScript','--parameters',`file://${parameters}`,'--timeout-seconds','90'])
  save(phase+'-submission',sent)
  const deadline=performance.now()+120_000
  while(performance.now()<deadline) {
    let result:any
    try{result=aws('us-east-1','ssm',['get-command-invocation','--instance-id',instanceId,'--command-id',sent.Command.CommandId])}catch(error){save(phase+'-observation-error',{error:String(error)});await new Promise(r=>setTimeout(r,1000));continue}
    save(phase+'-result',result)
    if(['Pending','InProgress','Delayed'].includes(result.Status)){await new Promise(r=>setTimeout(r,1000));continue}
    assert.equal(result.Status,'Success','Observe recorded command; never resubmit an UNKNOWN mutation')
    return JSON.parse(result.StandardOutputContent.trim())
  }
  throw new Error('SSM observation deadline: recorded command remains UNKNOWN; do not resubmit')
}
const setup=await remote('setup',"assert call()=={'sequence':0,'value':0}\nprint(json.dumps(call(extra={'x-lab-probe-object':'identity'})))")
assert.match(setup.nativeObjectId,/^[a-f0-9]{64}$/)
const cell='Counter:'+setup.nativeObjectId
function jsonObject(key:string,name:string) {
  const file=resolve(directory,name+'.bin'),meta=aws('us-east-1','s3api',['get-object','--bucket',replication.source,'--key',key,'--expected-bucket-owner',identity.Account,file])
  assert.ok(meta.VersionId && meta.VersionId!=='null');return JSON.parse(readFileSync(file,'utf8'))
}
const owner=jsonObject(`fleet/cells/${cell}/own.json`,'owner-baseline');assert.match(owner.node,/^[A-Za-z0-9_-]{1,128}$/)
const node=jsonObject(`fleet/nodes/${owner.node}.json`,'node-baseline');assert.equal(node.node,owner.node);assert.match(node.ownership_index_generation,/^[A-Za-z0-9_-]{1,128}$/)
const bundlePrefix=`fleet/log/${owner.node}/${node.ownership_index_generation}/bundle/`,cellPrefix=`fleet/cells/${cell}/ltx/`
function list(prefix:string) {
  const response=aws('us-east-1','s3api',['list-objects-v2','--bucket',replication.source,'--prefix',prefix,'--expected-bucket-owner',identity.Account])
  return response.Contents??[]
}
const baselineCells=list(cellPrefix),baselineBundles=list(bundlePrefix)
assert.ok(baselineCells.length+baselineBundles.length<100,'Scope already exceeds observation budget before mutation')
save('baseline',{cell,owner,node,cellObjects:baselineCells,bundleObjects:baselineBundles,scope:'Forensic source metadata, not imported authority or folded-log validation'})
const submittedMs=elapsed()
const mutation=await remote('marker',`start=time.monotonic()\nresult=call({'operationId':${JSON.stringify(operationId)},'delta':7})\nassert result=={'sequence':1,'operationId':${JSON.stringify(operationId)},'delta':7,'value':7,'duplicate':False}\nprint(json.dumps({'command':result,'requestElapsedMs':(time.monotonic()-start)*1000}))`)
const acknowledgedByMs=elapsed();save('acknowledgement',{id,cell,expected,submittedMs,acknowledgedByMs,mutation})
const cache=new Map<string,any>(),candidates=new Map<string,any>()
let downloadedBytes=0
function download(region:string,bucket:string,key:string,version:string,head:any,archive=false) {
  const file=resolve(directory,digest(Buffer.from(JSON.stringify([region,bucket,key,version])))+'.bin')
  assert.ok(!existsSync(file),'Only a verified caller cache may skip a GET')
  const partial=file+'.partial'
  const meta=aws(region,'s3api',['get-object','--bucket',bucket,'--key',key,'--version-id',version,'--expected-bucket-owner',identity.Account,partial])
  assert.equal(meta.VersionId,version);if(archive) assert.equal(meta.ReplicationStatus,'REPLICA')
  assert.equal(meta.ContentLength,head.ContentLength);assert.equal(readFileSync(partial).length,head.ContentLength)
  renameSync(partial,file)
  const bytes=readFileSync(file);assert.equal(bytes.length,head.ContentLength)
  return {file,sha256:digest(bytes),getCompletedMs:elapsed(),replicationStatus:meta.ReplicationStatus}
}
function stage(root:string,epoch:string,level:number,min:string,max:string,file:string) {
  assert.match(epoch,/^[1-9]\d*$/);assert.ok(Number.isInteger(level)&&level>=0&&level<=9);assert.match(min,/^[a-f0-9]{16}$/);assert.match(max,/^[a-f0-9]{16}$/)
  const folder=resolve(root,`e${epoch}`,'ltx',String(level));mkdirSync(folder,{recursive:true,mode:0o700})
  const target=resolve(folder,`${min}-${max}.ltx`),bytes=readFileSync(file)
  if(existsSync(target)) assert.equal(digest(readFileSync(target)),digest(bytes),'Conflicting duplicate native segment')
  else writeFileSync(target,bytes,{mode:0o600})
}
function stageObject(object:any,root:string,phase:string) {
  if(object.key.endsWith('.ltxb')) {
    const folder=resolve(directory,phase+'-'+digest(Buffer.from(JSON.stringify([object.key,object.versionId,object.sha256]))));mkdirSync(folder,{mode:0o700,recursive:true})
    const lines=native(['--bundle',object.file,folder]).split('\n').filter(Boolean)
    let relevant=false
    for(const line of lines) {
      const [kind,index,nativeCell,epoch,min,max,name]=line.split('\t')
      assert.equal(kind,'BUNDLE');assert.equal(name,`entry-${index}.ltx`)
      if(nativeCell===cell) {stage(root,epoch!,0,min!,max!,resolve(folder,name!));relevant=true}
    }
    return relevant
  }
  const coordinates=object.key.slice(cellPrefix.length).match(/^e([1-9]\d*)\/(\d+)\/([a-f0-9]{16})-([a-f0-9]{16})\.ltx$/)
  assert.ok(coordinates)
  const [kind,min,max]=native([object.file]).split('\n')[0]!.split('\t');assert.equal(kind,'HEADER');assert.equal(min,coordinates[3]);assert.equal(max,coordinates[4])
  stage(root,coordinates[1]!,Number(coordinates[2]),min!,max!,object.file);return true
}
let restoreNumber=0
function restoresMarker(root:string,phase:string) {
  if(!existsSync(root)) return undefined
  const db=resolve(directory,`${phase}-${++restoreNumber}.sqlite`)
  let report:string
  try{report=native(['--restore-epochs',root,db])}catch(error){requireNativeRejection(error,'transaction not available');return undefined}
  save(`${phase}-restore-${restoreNumber}`,{report,databaseExists:existsSync(db),observedMs:elapsed()})
  if(!markerRestoreHasImage(report,existsSync(db))) return undefined
  // Native restore produced a complete frozen page image; WAL-mode headers do
  // not imply an external WAL should be replayed. Never use this on live files.
  const databaseDigest=digest(readFileSync(db))
  const inspect=(query:string,json=false)=>execFileSync('sqlite3',immutableSqliteArgs(db,query,json),{encoding:'utf8',timeout:15_000}).trim()
  assert.equal(inspect('PRAGMA integrity_check;'),'ok')
  if(!inspect("SELECT name FROM sqlite_master WHERE type='table' AND name='commands';")) return undefined
  const commands=JSON.parse(inspect('SELECT sequence,operation_id AS operationId,delta,value FROM commands ORDER BY sequence;',true)||'[]')
  assert.equal(digest(readFileSync(db)),databaseDigest,'Frozen image changed during inspection')
  return exactMarkerHistory(commands,expected)?{report,databaseSha256:databaseDigest,immutableSqliteRead:true,commands,verifiedByMs:elapsed()}:undefined
}
const sourceRoot=resolve(directory,'source-epochs'),sourceDeadline=performance.now()+180_000
let sourceProof:any
while(performance.now()<sourceDeadline && !sourceProof) {
  const latestOwner=jsonObject(`fleet/cells/${cell}/own.json`,'owner-observed')
  assert.equal(latestOwner.node,owner.node,'Owner changed: incomplete scoped log observation');assert.equal(latestOwner.epoch,owner.epoch)
  const latestNode=jsonObject(`fleet/nodes/${owner.node}.json`,'node-observed')
  assert.equal(latestNode.ownership_index_generation,node.ownership_index_generation,'Process generation changed: incomplete scoped log observation')
  const objects=[...list(cellPrefix).filter((value:any)=>value.Key.endsWith('.ltx')),...list(bundlePrefix).filter((value:any)=>value.Key.endsWith('.ltxb')).sort((a:any,b:any)=>Date.parse(b.LastModified)-Date.parse(a.LastModified))]
  assert.ok(objects.length<=100,'Candidate window exceeded, not a loss claim')
  for(const object of objects) {
    if(performance.now()>=sourceDeadline) break
    assert.ok(Number.isSafeInteger(object.Size)&&object.Size>=0&&object.Size<=32*1024*1024)
    const head=aws('us-east-1','s3api',['head-object','--bucket',replication.source,'--key',object.Key,'--expected-bucket-owner',identity.Account]);assert.ok(head.VersionId&&head.VersionId!=='null');assert.equal(head.ContentLength,object.Size)
    const cacheKey=JSON.stringify([object.Key,head.VersionId]);if(cache.has(cacheKey)) continue
    downloadedBytes+=object.Size;assert.ok(downloadedBytes<=64*1024*1024,'Download budget exceeded, not a loss claim')
    const captured={key:object.Key,versionId:head.VersionId,head,...download('us-east-1',replication.source,object.Key,head.VersionId,head)};cache.set(cacheKey,captured)
    if(stageObject(captured,sourceRoot,'source')) candidates.set(cacheKey,captured)
    sourceProof=restoresMarker(sourceRoot,'source');if(sourceProof) break
  }
  if(!sourceProof) await new Promise(r=>setTimeout(r,1000))
}
assert.ok(sourceProof,'Marker not proved in bounded source observation; no loss/RPO claim')
sourceProof={...sourceProof,objects:[...candidates.values()],timing:acknowledgementObservation(submittedMs,acknowledgedByMs,sourceProof.verifiedByMs)};save('source-proof',sourceProof)
const archiveRoot=resolve(directory,'archive-epochs'),archiveDeadline=performance.now()+300_000,archived=new Set<string>(),archiveObjects:any[]=[]
let archiveProof:any
while(performance.now()<archiveDeadline && !archiveProof) {
  for(const object of candidates.values()) {
    if(performance.now()>=archiveDeadline) break
    const cacheKey=JSON.stringify([object.key,object.versionId]);if(archived.has(cacheKey)) continue
    try {
      const target=download('us-west-2',replication.destination,object.key,object.versionId,object.head,true)
      assert.equal(target.sha256,object.sha256)
      stageObject({...object,...target},archiveRoot,'archive');archived.add(cacheKey);archiveObjects.push({key:object.key,versionId:object.versionId,...target})
    } catch(error) {if(!isS3VersionAbsent(error)) throw error}
  }
  if(archived.size===candidates.size) {
    let completed=true
    const sourceChecks:any[]=[]
    for(const object of candidates.values()) {
      if(performance.now()>=archiveDeadline) {completed=false;break}
      const meta=aws('us-east-1','s3api',['head-object','--bucket',replication.source,'--key',object.key,'--version-id',object.versionId,'--expected-bucket-owner',identity.Account])
      sourceChecks.push({key:object.key,versionId:object.versionId,status:meta.ReplicationStatus,observedMs:elapsed()})
      assert.notEqual(meta.ReplicationStatus,'FAILED');if(meta.ReplicationStatus!=='COMPLETED') completed=false
    }
    if(completed && performance.now()<archiveDeadline) {const proof=restoresMarker(archiveRoot,'archive');if(proof) archiveProof={...proof,objects:archiveObjects,sourceCompletionChecks:sourceChecks}}
  }
  if(!archiveProof) await new Promise(r=>setTimeout(r,1000))
}
assert.ok(archiveProof,'Marker not proved in bounded CRR observation; no loss/RPO claim')
assert.equal(digest(readFileSync(resolve(work,'acknowledgement-ledger.json'))),previousLedgerSha,'Current recovery ledger changed during measurement')
save('verification',{recoveryLedgerUnchanged:true,observedAt:new Date().toISOString(),id,cell,expected,source:sourceProof,archive:{...archiveProof,timing:acknowledgementObservation(submittedMs,acknowledgedByMs,archiveProof.verifiedByMs)},nativeAttestation:attestation,
 scope:'One acknowledged marker reconstructed from selected pinned source and native CRR bytes, including its operation-ID record. Controller monotonic conservative observation bounds include SSM, polling, downloads, decoding and SQLite validation. Not exact upload/CRR latency, complete/folded-log-authoritative checkpoint, unsent peer coverage, universal RPO, serving import or regional fencing. No manual archive copies, recovery-ledger replacement or destination activation.'})
console.log('PASS: exact acknowledged Counter marker reconstructed from pinned source bytes and byte-identical native CRR versions; source COMPLETED/destination REPLICA checked. Observation bounds include verification overhead, not a guaranteed RPO or writable recovery.')
} catch(error) {save('failure',{at:new Date().toISOString(),elapsedMs:elapsed(),error:String(error),scope:'Partial/UNKNOWN measurement evidence; do not resubmit the marker or infer data loss.'});throw error}
