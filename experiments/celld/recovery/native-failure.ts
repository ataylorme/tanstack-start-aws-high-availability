/** A crashed/timed-out/missing tool is not evidence that native validation rejected data. */
export function requireNativeRejection(error: unknown, expectedMessage?: string): string {
  const result=error as {status?: unknown;signal?: unknown;stderr?: unknown}
  if (!result || result.status!==1 || (result.signal!==null && result.signal!==undefined)
    || typeof result.stderr!=='string') throw new Error('Native validator did not report a normal rejection')
  const message=result.stderr.trim()
  const prefix='LTX verification failed: '
  if (!message.startsWith(prefix) || message.length===prefix.length
    || (expectedMessage!==undefined && message!==prefix+expectedMessage)) {
    throw new Error('Unexpected native rejection diagnostic')
  }
  return message
}
