export function verifyNativeEpochAdvance(before: unknown, after: unknown) {
  const parse = (value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Missing native owner evidence')
    const record=value as {node?: unknown;epoch?: unknown}
    if (typeof record.node!=='string' || !record.node || !Number.isSafeInteger(record.epoch) || (record.epoch as number)<1) throw new Error('Invalid native owner evidence')
    return {node:record.node,epoch:record.epoch as number}
  }
  const previous=parse(before), current=parse(after)
  if (current.node===previous.node || current.epoch<=previous.epoch) throw new Error('Native takeover epoch/owner advance not proven')
  return {before:previous,after:current,scope:'Native single-bucket cell takeover only; not regional ownership or fencing'}
}

/** Termination submission, shutting-down, absence and API errors are not this proof. */
export function instanceTerminationObserved(response: unknown, instanceId: string): boolean {
  if (!response || typeof response!=='object') return false
  const reservations=(response as {Reservations?: unknown}).Reservations
  if (!Array.isArray(reservations)) return false
  const instances=reservations.flatMap(value=>value && Array.isArray(value.Instances)?value.Instances:[])
    .filter(value=>value?.InstanceId===instanceId)
  return instances.length===1 && instances[0]?.State?.Name==='terminated'
}
