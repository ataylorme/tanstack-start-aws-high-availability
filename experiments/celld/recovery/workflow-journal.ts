import assert from 'node:assert/strict'
export interface LabCommand { sequence: number; operationId: string; delta: number; value: number }
function record(value: unknown): Record<string, any> {
  assert.ok(value && typeof value==='object' && !Array.isArray(value),'Invalid Workflow record')
  return value as Record<string, any>
}
/** Only the selected approval laboratory, not a generic native import validator. */
export function inspectApprovalJournal(values: Map<string,unknown>, instanceId: string, commands: readonly LabCommand[], alarmAt: unknown, wakeAt: unknown) {
  assert.equal(commands.length,3)
  const meta=record(values.get('__wf.meta'))
  assert.equal(meta.instanceId,instanceId);assert.equal(meta.workflowName,'validation');assert.equal(meta.status,'complete')
  assert.match(meta.generation,/^[a-f0-9-]{36}$/)
  for (const field of ['createdMs','endedMs','expiresMs']) assert.ok(Number.isSafeInteger(meta[field]) && meta[field]>=0)
  assert.ok(meta.endedMs>=meta.createdMs && meta.expiresMs>meta.endedMs)
  assert.equal(alarmAt,meta.expiresMs);assert.equal(wakeAt,meta.expiresMs)
  const prefix=`__wf.${meta.generation}.`
  const expectedSteps=['started','durable-sleep','approval','finished'].map(name=>prefix+'step.1.'+name)
  assert.deepEqual([...values.keys()].filter(key=>key.startsWith(prefix+'step.')).sort(),expectedSteps.sort(),'Unexpected journal step')
  const step=(name: string,kind: string,ordinal: number) => {
    const value=record(values.get(prefix+'step.1.'+name))
    assert.equal(value.kind,kind);assert.equal(value.status,'completed');assert.equal(value.ordinal,ordinal)
    return value
  }
  const started=step('started','do',1), sleep=step('durable-sleep','sleep',2)
  const approval=step('approval','event',3), finished=step('finished','do',4)
  assert.equal(record(approval.value).type,'approval');assert.equal(record(approval.value.payload).approved,true)
  const output=record(meta.output);assert.equal(output.approved,true)
  const commandMatches=(value: unknown,expected: LabCommand) => {
    const actual=record(value)
    for (const field of ['sequence','operationId','delta','value'] as const) assert.equal(actual[field],expected[field])
  }
  commandMatches(started.value,commands[1]!);commandMatches(finished.value,commands[2]!)
  commandMatches(output.started,commands[1]!);commandMatches(output.finished,commands[2]!)
  assert.ok(Number.isSafeInteger(values.get(prefix+'eventSeq')) && (values.get(prefix+'eventSeq') as number)>=1)
  assert.ok(![...values.keys()].some(key=>key.startsWith(prefix+'event.')),'Unconsumed event remains')
  // Never return params/tokens or entire serialized metadata.
  return {status:'complete',completedSteps:[started,sleep,approval,finished].map(value=>({kind:value.kind,ordinal:value.ordinal})),
    approvalConsumed:true,logicalCommandsMatched:true,retentionAlarmMs:meta.expiresMs as number}
}

/** Pinned native wake v2 body, not merely its minute-bucket object key. */
export function inspectWakePublication(value: unknown, cell: string, dueMs: number, identity: string) {
  const body=record(value)
  assert.equal(body.format,2);assert.equal(body.cell,cell)
  assert.equal(body.due_ms,dueMs);assert.equal(body.identity,identity)
}
