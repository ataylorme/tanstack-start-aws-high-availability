export interface MetricPoint { Timestamp: string; [statistic: string]: unknown }
/** Interpret observed samples, never turn an absent series into zero/healthy. */
export function observeMetric(points: readonly MetricPoint[], statistic: string, start: number, end: number, maximumAgeMs: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start>=end || !Number.isFinite(maximumAgeMs) || maximumAgeMs<=0) throw new Error('Invalid telemetry observation window')
  const seen=new Set<number>()
  const samples=points.map(point=> {
    const at=Date.parse(point.Timestamp),value=point[statistic]
    if (!Number.isFinite(at) || at<start || at>=end || seen.has(at) || typeof value!=='number' || !Number.isFinite(value)) throw new Error('Invalid or duplicate metric sample')
    seen.add(at);return {at,value}
  }).sort((a,b)=>a.at-b.at)
  const latest=samples.at(-1)
  return {status:!latest?'MISSING':end-latest.at>maximumAgeMs?'STALE':'FRESH',count:samples.length,latest:latest??null}
}
export function observeLogEvent(event: {timestamp?:unknown;ingestionTime?:unknown}|undefined, now: number, maximumAgeMs: number) {
  if (!Number.isFinite(now) || !Number.isFinite(maximumAgeMs) || maximumAgeMs<=0) throw new Error('Invalid log observation window')
  if (!event) return {status:'MISSING',eventAgeMs:null,ingestionAgeMs:null}
  if (typeof event.timestamp!=='number' || !Number.isSafeInteger(event.timestamp) || event.timestamp<0 || event.timestamp>now
    || typeof event.ingestionTime!=='number' || !Number.isSafeInteger(event.ingestionTime) || event.ingestionTime<event.timestamp || event.ingestionTime>now) throw new Error('Invalid log event timestamps')
  const eventAgeMs=now-event.timestamp,ingestionAgeMs=now-event.ingestionTime
  return {status:eventAgeMs>maximumAgeMs || ingestionAgeMs>maximumAgeMs?'STALE':'FRESH',eventAgeMs,ingestionAgeMs}
}
export function sameDimensions(actual: readonly {Name:string;Value:string}[],expected: Record<string,string>) {
  if (actual.length!==Object.keys(expected).length || new Set(actual.map(value=>value.Name)).size!==actual.length) return false
  return actual.every(value=>expected[value.Name]===value.Value)
}
