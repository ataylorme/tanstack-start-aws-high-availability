import { describe, expect, it, vi } from 'vitest'
import { runReversibleFault } from '../experiments/celld/operations/reversible-fault.ts'
describe('reversible fleet-fault cleanup', () => {
  it.each(['lost-stop-response', 'unknown-stop-state', 'failed-viewer-assertion'])('still restores both nodes and verifies recovery after %s', kind => {
    const first = vi.fn().mockResolvedValue(undefined), second = vi.fn().mockResolvedValue(undefined), verifyRecovery = vi.fn().mockResolvedValue(undefined)
    return runReversibleFault({ inject: kind === 'failed-viewer-assertion' ? vi.fn().mockResolvedValue(undefined) : vi.fn().mockRejectedValue(new Error(kind)), observe: vi.fn().mockRejectedValue(new Error(kind)), restorations: [first, second], verifyRecovery }).then(result => {
      expect(result.faultError).toBeInstanceOf(Error)
      expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce(); expect(verifyRecovery).toHaveBeenCalledOnce()
      expect(result.recoveryError).toBeUndefined()
    })
  })
  it('first restoration submission throw cannot skip the second node or recovery check', async () => {
    const second = vi.fn().mockResolvedValue(undefined), verifyRecovery = vi.fn().mockResolvedValue(undefined)
    const result = await runReversibleFault({ inject: async () => {}, observe: async () => {}, restorations: [() => { throw new Error('Lost restoration submission') }, second], verifyRecovery })
    expect(result.restorationErrors).toHaveLength(1); expect(second).toHaveBeenCalledOnce(); expect(verifyRecovery).toHaveBeenCalledOnce()
  })
  it('preserves uncertain recovery instead of claiming a completed drill', async () => {
    const result = await runReversibleFault({ inject: async () => {}, observe: async () => {}, restorations: [async () => {}, async () => {}], verifyRecovery: async () => { throw new Error('No healthy targets') } })
    expect(result.recoveryError).toBeInstanceOf(Error)
  })
})
