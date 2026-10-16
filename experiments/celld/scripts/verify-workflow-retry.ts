import assert from 'node:assert/strict'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// Use an authenticated local/direct-backend endpoint. Do not open ACTIVE ingress
// or overwrite the recovery acknowledgement ledger for this independent probe.
const base=new URL(process.argv[2]??'http://127.0.0.1:9877')
assert.ok(['http:','https:'].includes(base.protocol) && !base.username && !base.password)
assert.ok(['127.0.0.1','localhost','[::1]'].includes(base.hostname),'Local probe only: do not send the lab token to a remote URL')
const vars=await readFile(process.env.LAB_TOKEN_FILE??'experiments/celld/.dev.vars','utf8')
const token=vars.match(/^LAB_TOKEN=(.+)$/m)?.[1]?.trim()??vars.trim()
assert.ok(token.length>=32)
const runId=crypto.randomUUID(),id=`test-${runId}`
const call=async(kind: string,command?: object)=> {
  const response=await fetch(new URL(`/api/${kind}/${id}`,base),{
    headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10_000),
    ...(command ? {method:'POST',body:JSON.stringify(command)} : {}),
  })
  return {code:response.status,value:await response.json() as any}
}
const workflow='workflows/Validation',counter='objects/Counter'
assert.equal((await call(workflow,{action:'start',retryFirstStep:'true'})).code,400)
assert.equal((await call(workflow,{action:'start',retryFirstStep:true})).code,201)
// Submit approval early; request timing alone does not prove native buffering order.
assert.equal((await call(workflow,{action:'approve',approved:true})).code,200)
const deadline=Date.now()+60_000
const observed: string[]=[]
let result: any
while(Date.now()<deadline) {
  const response=await call(workflow)
  assert.equal(response.code,200)
  result=response.value;observed.push(result.status)
  if(['complete','completed','errored','terminated'].includes(result.status)) break
  await new Promise(resolve=>setTimeout(resolve,100))
}
assert.ok(['complete','completed'].includes(result?.status),'Native retry lab did not complete')
const expectedStart={sequence:1,operationId:`${id}-started`,delta:1,value:1,duplicate:true,conflict:false,attempt:2}
const expectedFinish={sequence:2,operationId:`${id}-finished`,delta:1,value:2,duplicate:false}
assert.deepEqual(result.output,{started:expectedStart,finished:expectedFinish,approved:true})
const state=await call(counter)
assert.equal(state.code,200);assert.deepEqual(state.value,{sequence:2,value:2})
// Inspecting status again must not rerun the committed effects.
assert.deepEqual((await call(workflow)).value.output,result.output)
assert.deepEqual((await call(counter)).value,{sequence:2,value:2})
const directory=resolve('.omx/local/workflow-retries')
await mkdir(directory,{recursive:true,mode:0o700})
await writeFile(resolve(directory,`${runId}.json`),JSON.stringify({runId,id,observedAt:new Date().toISOString(),endpoint:base.origin,observed,
  result:result.output,state:state.value,scope:'Native retry after deliberate failed callback with acknowledged idempotent DO effect, early approval submission and sleep; buffering order not established. Not region fencing, restart-during-retry, external exactly-once effects or regional recovery.'}),{mode:0o600})
console.log('PASS: native Workflow retried the failed callback, deduplicated its acknowledged DO effect, consumed approval submitted early and completed with exactly two counter commands. Recovery ledger unchanged.')
