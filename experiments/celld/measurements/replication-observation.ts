import {pathToFileURL} from 'node:url'
/** Controller-monotonic observation bounds; never compare clocks across hosts. */
export function acknowledgementObservation(submittedMs:number,acknowledgedByMs:number,verifiedByMs:number) {
  if([submittedMs,acknowledgedByMs,verifiedByMs].some(value=>!Number.isFinite(value)||value<0) || submittedMs>acknowledgedByMs || acknowledgedByMs>verifiedByMs) throw new Error('Invalid acknowledgement observation ordering')
  return {acknowledgementIntervalMs:[submittedMs,acknowledgedByMs],acknowledgementUncertaintyMs:acknowledgedByMs-submittedMs,
    acknowledgementToVerifiedPresenceMs:{lower:0,upper:verifiedByMs-submittedMs},afterAckObservationMs:verifiedByMs-acknowledgedByMs}
}
export function exactMarkerHistory(actual:unknown,expected:{sequence:number;operationId:string;delta:number;value:number}) {
  if(!Array.isArray(actual) || actual.length!==1) return false
  const row=actual[0]
  return !!row && ['sequence','operationId','delta','value'].every(key=>row[key]===expected[key as keyof typeof expected])
}
/** Only explicit S3 not-found diagnostics mean absence; transport/auth errors do not. */
export function isS3VersionAbsent(error:unknown) {
  if(!error || typeof error!=='object') return false
  const value=error as {status?:unknown;signal?:unknown;stderr?:unknown}
  return typeof value.status==='number' && Number.isInteger(value.status) && value.status>0 && value.signal==null && typeof value.stderr==='string' && /An error occurred \((?:404|NoSuchKey|NoSuchVersion|NotFound)\) when calling the (?:GetObject|HeadObject) operation/.test(value.stderr)
}

/** Native EpochChain can return an empty plan while a required base is absent. */
export function markerRestoreHasImage(report:string,databaseExists:boolean) {
  const lines=report.split('\n'),fields=lines[0]?.split('\t')??[]
  if(lines.length!==2 || fields.length!==4 || fields[0]!=='RESTORED' || !/^(0|[1-9]\d*)$/.test(fields[1]!) || !/^(0|[1-9]\d*)$/.test(fields[2]!) || !/^[a-f0-9]{16}$/.test(fields[3]!) || !/^SPANS(?:\t.*)?$/.test(lines[1]!)) throw new Error('Invalid native restore report')
  if(fields[1]==='0' && fields[2]==='0' && fields[3]==='0000000000000000' && !databaseExists) return false
  if(!databaseExists || fields[1]==='0' || fields[2]==='0' || fields[3]==='0000000000000000') throw new Error('Native restore report/image mismatch')
  return true
}

/** Only finalized native page images, never a live main file missing its WAL. */
export function immutableSqliteArgs(database:string,query:string,json=false) {
  const uri=pathToFileURL(database);uri.searchParams.set('immutable','1');uri.searchParams.set('mode','ro')
  return ['-readonly',...(json?['-json']:[]),uri.href,query]
}
