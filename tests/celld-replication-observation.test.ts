import {expect,it} from 'vitest'
import {execFileSync} from 'node:child_process'
import {acknowledgementObservation,exactMarkerHistory,isS3VersionAbsent,markerRestoreHasImage,immutableSqliteArgs} from '../experiments/celld/measurements/replication-observation.ts'
it('keeps remote acknowledgement uncertainty and conservative proof bounds explicit',()=> {
  expect(acknowledgementObservation(10,30,60)).toEqual({acknowledgementIntervalMs:[10,30],acknowledgementUncertaintyMs:20,acknowledgementToVerifiedPresenceMs:{lower:0,upper:50},afterAckObservationMs:30})
})
it('rejects cross-clock or invalid ordering rather than reporting negative lag',()=> {
  for(const values of [[30,10,60],[10,60,30],[NaN,30,60],[-1,30,60]]) expect(()=>acknowledgementObservation(values[0]!,values[1]!,values[2]!)).toThrow()
})
it('requires exactly the single acknowledged operation, not just its final value',()=> {
  const expected={sequence:1,operationId:'fixture',delta:7,value:7}
  expect(exactMarkerHistory([expected],expected)).toBe(true)
  for(const actual of [[],[expected,expected],[{...expected,operationId:'other'}],[{...expected,sequence:2}],[{...expected,delta:8}],null]) expect(exactMarkerHistory(actual,expected)).toBe(false)
})
it('does not confuse missing versions with access denial, timeouts or killed clients',()=> {
  const stderr='An error occurred (NoSuchVersion) when calling the GetObject operation: missing'
  expect(isS3VersionAbsent({status:254,signal:null,stderr})).toBe(true)
  expect(isS3VersionAbsent({status:null,signal:'SIGTERM',stderr})).toBe(false)
  expect(isS3VersionAbsent({stderr})).toBe(false)
  expect(isS3VersionAbsent({status:0,signal:null,stderr})).toBe(false)
  expect(isS3VersionAbsent({status:254,signal:null,stderr:stderr.replace('NoSuchVersion','AccessDenied')})).toBe(false)
  expect(isS3VersionAbsent({status:254,signal:null,stderr:'Read timeout'})).toBe(false)
})

it('treats a native empty plan as not-yet-proven rather than a restored image',()=> {
  expect(markerRestoreHasImage('RESTORED\t0\t0\t0000000000000000\nSPANS',false)).toBe(false)
  const full='RESTORED\t2\t2977\t0000000000000002\nSPANS\t1:0000000000000001'
  expect(markerRestoreHasImage(full,true)).toBe(true)
  expect(()=>markerRestoreHasImage(full,false)).toThrow()
  expect(()=>markerRestoreHasImage('RESTORED\tgarbage',true)).toThrow()
})

it('keeps the marker mutation behind explicit execution and profile gates',()=> {
  const script='experiments/celld/scripts/measure-replication.ts'
  expect(execFileSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,AWS_PROFILE:''}})).toContain('Plan only: one isolated Counter command')
  expect(()=>execFileSync(process.execPath,[script,'--execute'],{stdio:'pipe',env:{...process.env,AWS_PROFILE:''}})).toThrow(/Explicit AWS_PROFILE required/)
})

it('routes every frozen-image query through escaped immutable read-only URI arguments',()=> {
  for(const json of [true,false]) {
    const args=immutableSqliteArgs('/tmp/frozen data#.sqlite','SELECT 1;',json)
    expect(args).toContain('file:///tmp/frozen%20data%23.sqlite?immutable=1&mode=ro')
    expect(args[0]).toBe('-readonly');expect(args.includes('-json')).toBe(json)
    expect(args.at(-1)).toBe('SELECT 1;')
  }
})
