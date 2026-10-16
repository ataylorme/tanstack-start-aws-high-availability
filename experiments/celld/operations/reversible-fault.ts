export interface ReversibleFault {
  inject(): Promise<void>
  observe(): Promise<void>
  restorations: [() => Promise<void>, () => Promise<void>]
  verifyRecovery(): Promise<void>
}
/** Always attempt both restorations and recovery verification, even on lost
 * responses or failed assertions. Fallback timers are intentionally not cancelled. */
export async function runReversibleFault(operations: ReversibleFault) {
  let faultError: unknown, recoveryError: unknown
  try { await operations.inject(); await operations.observe() } catch (error) { faultError = error }
  const restorationResults = await Promise.allSettled(operations.restorations.map(restore => Promise.resolve().then(restore)))
  const restorationErrors = restorationResults.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  try { await operations.verifyRecovery() } catch (error) { recoveryError = error }
  return { faultError, restorationErrors, recoveryError }
}
