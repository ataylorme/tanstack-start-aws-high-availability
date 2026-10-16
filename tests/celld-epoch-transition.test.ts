import { expect, it } from 'vitest'
import { verifyNativeEpochAdvance } from '../experiments/celld/recovery/epoch-transition.ts'
const before={node:'fixture-old',epoch:1}
it('requires both a different owner and a strictly greater epoch',()=> {
  expect(verifyNativeEpochAdvance(before,{node:'fixture-new',epoch:2}).after.epoch).toBe(2)
  expect(()=>verifyNativeEpochAdvance(before,{node:'fixture-old',epoch:2})).toThrow()
  expect(()=>verifyNativeEpochAdvance(before,{node:'fixture-new',epoch:1})).toThrow()
})
it.each([null,{node:'',epoch:2},{node:'fixture-new',epoch:0},{node:'fixture-new',epoch:1.5},{node:'fixture-new',epoch:Infinity}])('rejects missing or malformed evidence %j',record=> {
  expect(()=>verifyNativeEpochAdvance(before,record)).toThrow()
})

it('requires an exact terminated-instance observation, not termination submission or drain', async()=> {
  const { instanceTerminationObserved }=await import('../experiments/celld/recovery/epoch-transition.ts')
  const response=(state:string,id='fixture-target')=>({Reservations:[{Instances:[{InstanceId:id,State:{Name:state}}]}]})
  expect(instanceTerminationObserved(response('terminated'),'fixture-target')).toBe(true)
  for (const state of ['running','shutting-down','stopping','stopped','pending']) {
    expect(instanceTerminationObserved(response(state),'fixture-target')).toBe(false)
  }
  for (const value of [null,{}, {Reservations:[]}, response('terminated','fixture-other'), {Activity:{StatusCode:'InProgress'}},
    {Reservations:[{Instances:[...response('terminated').Reservations[0]!.Instances,...response('terminated').Reservations[0]!.Instances]}]}]) {
    expect(instanceTerminationObserved(value,'fixture-target')).toBe(false)
  }
})
