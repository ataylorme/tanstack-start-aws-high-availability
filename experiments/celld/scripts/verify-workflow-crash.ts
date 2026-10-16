import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {openSync,closeSync} from 'node:fs'
import {mkdir,cp,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {gunzipSync} from 'node:zlib'
import {createServer} from 'node:net'
import {observeSocketClose} from '../operations/socket-close.ts'

if(!process.argv.includes('--execute')) {
  console.log('Plan only: isolated local copy, owned celld native-process SIGKILL while Workflow unfinished/socket open, exact process-death barrier, restart same disk, reauthenticate/resync and complete without duplicate effects. No existing dev process, AWS, ACTIVE route, native regional-fence/import or restart-during-retry claim. Requires built lab, installed pinned binary, macOS/Linux and --execute.')
  process.exit(0)
}
assert.ok(['darwin','linux'].includes(process.platform),'Owned-child process inspection requires macOS/Linux')
const port=9878,base=`http://127.0.0.1:${port}`,runId=randomUUID(),id=`test-${runId}`
const root=resolve('.omx/local/workflow-crashes',runId),project=resolve(root,'project'),binary=resolve('.omx/local/celld-bin/celld')
const lock=JSON.parse(await readFile('experiments/celld/celld.lock.json','utf8'))
const archive=await readFile(resolve('.omx/local/celld-bin/celld.gz'))
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
assert.equal(sha(archive),lock.assets[`${process.platform}-${process.arch}`]?.sha256,'Pinned official release archive mismatch')
const binarySha256=sha(await readFile(binary))
assert.equal(binarySha256,sha(gunzipSync(archive)),'Serving binary differs from pinned official release')
const version=execFileSync(binary,['--version'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim().split('\n').at(-1)
assert.equal(version,'celld 0.6.2','Use the pinned stock runtime')
// Only test port availability; never stop another process to acquire it.
await new Promise<void>((resolve,reject)=>{
  const server=createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(error=>error?reject(error):resolve()))
})
await mkdir(project,{recursive:true,mode:0o700})
for(const path of ['runtime','dist','wrangler.jsonc']) await cp(resolve('experiments/celld',path),resolve(project,path),{recursive:true,errorOnExist:true,force:false})
const token=randomBytes(32).toString('hex')
await writeFile(resolve(project,'.dev.vars'),`REGION_MODE=primary\nLAB_TOKEN=${token}\n`,{mode:0o600,flag:'wx'})
const evidence:any={runId,id,version,binarySha256,startedAt:new Date().toISOString(),outcome:'IN_PROGRESS',scope:'Local isolated native process crash with same dev disk/store. No region loss, retry-phase assertion, supported import, complete peer-tail recovery or external exactly-once effect claim.'}
const save=()=>writeFile(resolve(root,'evidence.json'),JSON.stringify(evidence),{mode:0o600})
await save()
let handle:ReturnType<typeof spawn>|undefined,nativePid:number|undefined
const sockets=new Set<WebSocket>()
let closeObservation:ReturnType<typeof observeSocketClose>|undefined
const terminal=()=>!!handle&&(handle.exitCode!==null||handle.signalCode!==null)
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(predicate:()=>boolean,ms:number,message:string) {
  const deadline=Date.now()+ms
  while(!predicate()&&Date.now()<deadline) await sleep(50)
  assert.ok(predicate(),message)
}
function ownedNativePid() {
  assert.ok(handle?.pid&&!terminal(),'Supervisor must still be live')
  const children=execFileSync('pgrep',['-P',String(handle.pid)],{encoding:'utf8'}).trim().split(/\s+/).map(Number)
  const matches=children.filter(pid=>{
    const command=execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'})
    return command.includes(binary)&&command.includes(`--no-control-plane --bucket celld-dev --listen 127.0.0.1:${port}`)
  })
  assert.equal(matches.length,1,'Need exactly one directly owned native node')
  return matches[0]!
}
async function start() {
  const fd=openSync(resolve(root,'runtime.log'),'a',0o600)
  try {handle=spawn(binary,['dev',project,'--no-watch','--logs','--port',String(port)],{env:{...process.env,PATH:`${resolve('node_modules/.bin')}:${process.env.PATH}`},stdio:['ignore',fd,fd]})}
  finally{closeSync(fd)}
  let spawnError:Error|undefined
  handle.once('error',error=>{spawnError=error})
  const deadline=Date.now()+45_000
  while(Date.now()<deadline) {
    if(spawnError) throw spawnError
    assert.ok(!terminal(),'Owned dev supervisor exited before readiness')
    try {const r=await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)});if(r.ok){nativePid=ownedNativePid();return}}
    catch(error){if(error instanceof assert.AssertionError)throw error}
    await sleep(100)
  }
  throw new Error('Owned runtime readiness deadline exceeded')
}
async function call(kind:string,command?:object) {
  const response=await fetch(`${base}/api/${kind}/${id}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(8000),...(command?{method:'POST',body:JSON.stringify(command)}:{})})
  assert.ok(response.ok,`Lab HTTP ${response.status}`)
  return response.json() as Promise<any>
}
async function connect() {
  const response=await fetch(`${base}/api/objects/Counter/${id}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'x-lab-socket-ticket':'request'},signal:AbortSignal.timeout(8000)})
  assert.equal(response.status,200)
  const {ticket}=await response.json() as {ticket:string}
  const socket=new WebSocket(`ws://127.0.0.1:${port}/api/objects/Counter/${id}`,['celld-v1',ticket]);sockets.add(socket)
  const snapshot=await new Promise<any>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Authenticated socket snapshot timeout')),8000)
    socket.onopen=()=>socket.send(JSON.stringify({type:'authenticate',token}))
    socket.onerror=()=>{clearTimeout(timeout);reject(new Error('Authenticated socket error'))}
    socket.onmessage=event=>{clearTimeout(timeout);try{const value=JSON.parse(String(event.data));assert.equal(value.type,'snapshot');resolve(value)}catch(error){reject(error)}}
    socket.onclose=()=>{clearTimeout(timeout);reject(new Error('Socket closed before authentication snapshot'))}
  })
  socket.onmessage=null;socket.onclose=null;socket.onerror=null
  return {socket,snapshot}
}
try {
  await start();evidence.firstNativePid=nativePid;await save()
  assert.deepEqual(await call('objects/Counter'),{sequence:0,value:0})
  await call('workflows/Validation',{action:'start'}) // one submission; never replay on uncertain outcome
  const deadline=Date.now()+20_000
  let before:any
  do {before=await call('workflows/Validation');if(before.status==='waiting')break;assert.ok(!['complete','completed','errored'].includes(before.status));await sleep(100)}while(Date.now()<deadline)
  assert.equal(before.status,'waiting','Workflow must be unfinished; waiting may mean sleep or approval, not a claimed exact journal phase')
  assert.deepEqual(await call('objects/Counter'),{sequence:1,value:1})
  const first=await connect()
  assert.equal(first.snapshot.sequence,1);assert.equal(first.snapshot.value,1)
  closeObservation=observeSocketClose(first.socket,15_000)
  assert.equal(ownedNativePid(),nativePid,'Native child ownership must be fresh immediately before fault')
  evidence.before={status:before.status,counter:{sequence:1,value:1},snapshot:first.snapshot}
  evidence.fault={intentAt:new Date().toISOString(),kind:'SIGKILL',nativePid,outcome:'UNKNOWN'};await save()
  process.kill(nativePid!,'SIGKILL')
  await until(()=>terminal(),15_000,'Supervisor must observe killed native child and terminate before restart')
  // No successful kill submission or HTTP failure alone counts as death.
  assert.throws(()=>process.kill(nativePid!,0),(error:any)=>error?.code==='ESRCH')
  evidence.fault.outcome='NATIVE_PID_ABSENT_AND_SUPERVISOR_TERMINAL';evidence.fault.barrierAt=new Date().toISOString()
  evidence.disconnected=await closeObservation.result;sockets.delete(first.socket);await save()
  evidence.restartSubmittedAt=new Date().toISOString();await save();await start()
  evidence.restartedNativePid=nativePid;assert.notEqual(nativePid,evidence.firstNativePid)
  assert.deepEqual(await call('objects/Counter'),{sequence:1,value:1})
  const pending=await call('workflows/Validation');assert.equal(pending.status,'waiting','Unfinished Workflow retained before approval; no workflow recreation')
  const second=await connect();assert.equal(second.snapshot.sequence,1);assert.equal(second.snapshot.value,1)
  // The first step's operation ID/dedup record must survive abrupt process loss.
  const replay=await call('objects/Counter',{operationId:`${id}-started`,delta:1})
  assert.equal(replay.duplicate,true);assert.equal(replay.conflict,false);assert.equal(replay.sequence,1);assert.equal(replay.value,1)
  await call('workflows/Validation',{action:'approve',approved:true})
  let complete:any
  const finishDeadline=Date.now()+30_000
  do {complete=await call('workflows/Validation');if(['complete','completed','errored'].includes(complete.status))break;await sleep(100)}while(Date.now()<finishDeadline)
  assert.ok(['complete','completed'].includes(complete.status))
  assert.equal(complete.output.started.sequence,1);assert.equal(complete.output.started.value,1)
  assert.equal(complete.output.finished.sequence,2);assert.equal(complete.output.finished.value,2);assert.equal(complete.output.approved,true)
  assert.deepEqual(await call('objects/Counter'),{sequence:2,value:2})
  const third=await connect();assert.equal(third.snapshot.sequence,2);assert.equal(third.snapshot.value,2)
  assert.deepEqual((await call('workflows/Validation')).output,complete.output)
  assert.deepEqual(await call('objects/Counter'),{sequence:2,value:2})
  evidence.after={pendingStatus:pending.status,reauthenticatedSnapshot:second.snapshot,finalSnapshot:third.snapshot,output:complete.output,duplicate:replay,counter:{sequence:2,value:2}}
  evidence.outcome='PASSED';evidence.completedAt=new Date().toISOString();await save()
  console.log('PASS: exact owned native SIGKILL/death barrier, socket disconnected; same-disk restart retained unfinished Workflow/dedup, reauthenticated snapshots resynchronized, approval completed with exactly two effects. No AWS/regional failover or restart-during-retry proof.')
} catch(error) {evidence.outcome='FAILED';evidence.error=String(error);await save();throw error}
finally {
  closeObservation?.cancel()
  for(const socket of sockets) socket.close()
  try {
    if(handle&&!terminal()) {handle.kill('SIGTERM');await until(()=>terminal(),45_000,'Owned restarted supervisor did not stop; inspect local evidence, never kill unrelated processes')}
  } catch(error) {evidence.outcome='FAILED_CLEANUP';evidence.cleanupError=String(error);throw error}
  finally {evidence.cleanup={supervisorTerminal:terminal(),at:new Date().toISOString()};await save()}
}
