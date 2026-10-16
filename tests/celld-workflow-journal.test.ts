import { expect, it } from 'vitest'
import { inspectApprovalJournal,inspectWakePublication } from '../experiments/celld/recovery/workflow-journal.ts'
const generation='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const commands=[{sequence:1,operationId:'fixture-client',delta:3,value:3},{sequence:2,operationId:'fixture-started',delta:1,value:4},{sequence:3,operationId:'fixture-finished',delta:1,value:5}]
const prefix=`__wf.${generation}.`
function fixture() {
  return new Map<string,unknown>([
    ['__wf.meta',{workflowName:'validation',instanceId:'fixture',generation,createdMs:10,endedMs:20,expiresMs:30,status:'complete',params:{token:'must-not-export'},output:{started:commands[1],finished:commands[2],approved:true}}],
    [prefix+'step.1.started',{kind:'do',status:'completed',ordinal:1,value:commands[1]}],
    [prefix+'step.1.durable-sleep',{kind:'sleep',status:'completed',ordinal:2}],
    [prefix+'step.1.approval',{kind:'event',status:'completed',ordinal:3,value:{type:'approval',payload:{approved:true}}}],
    [prefix+'step.1.finished',{kind:'do',status:'completed',ordinal:4,value:commands[2]}],
    [prefix+'eventSeq',1],
  ])
}
const inspect=(values: Map<string,unknown>,alarm: unknown=30,wake: unknown=30)=>inspectApprovalJournal(values,'fixture',commands,alarm,wake)
it('validates the lab journal without exporting secret params',()=> {
  const result=inspect(fixture())
  expect(result.completedSteps).toHaveLength(4)
  expect(JSON.stringify(result)).not.toContain('must-not-export')
})
it('rejects missing steps rather than trusting terminal status',()=> {
  const values=fixture();values.delete(prefix+'step.1.finished')
  expect(()=>inspect(values)).toThrow()
})
it('rejects a wrong journal operation record',()=> {
  const values=fixture();values.set(prefix+'step.1.finished',{kind:'do',status:'completed',ordinal:4,value:{...commands[2],value:99}})
  expect(()=>inspect(values)).toThrow()
})
it('rejects lost or mismatched alarm/wake state',()=> {
  expect(()=>inspect(fixture(),undefined,null)).toThrow()
  expect(()=>inspect(fixture(),29,30)).toThrow()
  expect(()=>inspect(fixture(),30,31)).toThrow()
})
it('rejects unconsumed approval events',()=> {
  const values=fixture();values.set(prefix+'event.000000001',{})
  expect(()=>inspect(values)).toThrow()
})
it('does not require a replayed idempotent step to report duplicate=false',()=> {
  const values=fixture();values.set(prefix+'step.1.started',{kind:'do',status:'completed',ordinal:1,value:{...commands[1],duplicate:true}})
  expect(()=>inspect(values)).not.toThrow()
})

it('requires the configured Workflow name, not its class name',()=> {
  const values=fixture()
  values.set('__wf.meta',{...(values.get('__wf.meta') as object),workflowName:'Validation'})
  expect(()=>inspect(values)).toThrow()
})

it('rejects extra current-generation journal steps',()=> {
  const values=fixture();values.set(prefix+'step.1.unexpected',{kind:'do',status:'completed',ordinal:1})
  expect(()=>inspect(values)).toThrow()
})
it('checks every pinned wake body field, including exact rather than minute-level deadline',()=> {
  const body={format:2,cell:'fixture-cell',due_ms:30,identity:'fixture-identity'}
  expect(()=>inspectWakePublication(body,'fixture-cell',30,'fixture-identity')).not.toThrow()
  for(const patch of [{format:1},{cell:'other'},{due_ms:31},{identity:'other'}]) {
    expect(()=>inspectWakePublication({...body,...patch},'fixture-cell',30,'fixture-identity')).toThrow()
  }
})
