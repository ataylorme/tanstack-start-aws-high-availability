import {expect,it} from 'vitest'
import {observeLogEvent,observeMetric,sameDimensions} from '../experiments/celld/measurements/telemetry.ts'
const iso=(value:number)=>new Date(value).toISOString()
it('distinguishes missing metrics from an observed zero',()=> {
  expect(observeMetric([],'Sum',0,100,10).status).toBe('MISSING')
  expect(observeMetric([{Timestamp:iso(95),Sum:0}],'Sum',0,100,10)).toMatchObject({status:'FRESH',latest:{value:0}})
})
it('sorts metric timestamps and flags stale rather than healthy data',()=> {
  expect(observeMetric([{Timestamp:iso(90),Minimum:2},{Timestamp:iso(30),Minimum:1}],'Minimum',0,100,5)).toMatchObject({status:'STALE',latest:{at:90,value:2}})
})
it('rejects invalid metric windows, timestamps, duplicates and wrong statistics',()=> {
  for(const points of [[{Timestamp:iso(100),Sum:1}],[{Timestamp:'bad',Sum:1}],[{Timestamp:iso(5),Sum:1},{Timestamp:iso(5),Sum:2}],[{Timestamp:iso(5),Average:1}],[{Timestamp:iso(5),Sum:NaN}]]) {
    expect(()=>observeMetric(points,'Sum',0,100,10)).toThrow()
  }
  expect(()=>observeMetric([],'Sum',100,0,10)).toThrow()
})
it('requires actual recent event and ingestion timestamps, not stream metadata',()=> {
  expect(observeLogEvent(undefined,100,10).status).toBe('MISSING')
  expect(observeLogEvent({timestamp:95,ingestionTime:99},100,10).status).toBe('FRESH')
  expect(observeLogEvent({timestamp:80,ingestionTime:99},100,10).status).toBe('STALE')
})
it('rejects invalid log timestamps',()=> {
  for(const event of [{timestamp:101,ingestionTime:101},{timestamp:95,ingestionTime:94},{timestamp:95},{timestamp:NaN,ingestionTime:99}]) expect(()=>observeLogEvent(event,100,10)).toThrow()
})
it('matches exact unordered dimensions without duplicates or extra series',()=> {
  expect(sameDimensions([{Name:'b',Value:'2'},{Name:'a',Value:'1'}],{a:'1',b:'2'})).toBe(true)
  expect(sameDimensions([{Name:'a',Value:'1'},{Name:'a',Value:'1'}],{a:'1',b:'2'})).toBe(false)
  expect(sameDimensions([{Name:'a',Value:'wrong'}],{a:'1'})).toBe(false)
  expect(sameDimensions([],{a:'1'})).toBe(false)
})
