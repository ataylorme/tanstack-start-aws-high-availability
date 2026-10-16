import { describe, expect, it } from 'vitest'
// @ts-expect-error Workers JS module is bundled by celld.
import { issueSocketTicket, validSocketTicket } from '../experiments/celld/runtime/socket-ticket.js'
const secret = 'a'.repeat(64)
const path = '/api/objects/Counter/test-ticket'
const header = (ticket: string) => `celld-v1, ${ticket}`
describe('pre-allocation WebSocket authentication', () => {
  it('accepts a path-bound ticket only within its short lifetime', async () => {
    const ticket = await issueSocketTicket(path, secret, 1000)
    expect(await validSocketTicket(header(ticket), path, secret, 1000)).toBe(true)
    expect(await validSocketTicket(header(ticket), path, secret, 30_999)).toBe(true)
    expect(await validSocketTicket(header(ticket), path, secret, 31_000)).toBe(false)
  })
  it('rejects another object or another lab secret', async () => {
    const ticket = await issueSocketTicket(path, secret, 0)
    expect(await validSocketTicket(header(ticket), `${path}-other`, secret, 0)).toBe(false)
    expect(await validSocketTicket(header(ticket), path, 'b'.repeat(64), 0)).toBe(false)
  })
  it('rejects tampering and raw unauthenticated handshakes', async () => {
    const ticket = await issueSocketTicket(path, secret, 0)
    expect(await validSocketTicket(header(`${ticket.slice(0, -2)}aa`), path, secret, 0)).toBe(false)
    for (const input of [null, '', 'celld-v1', 'celld-ticket-not-signed', 'a'.repeat(1025)]) {
      expect(await validSocketTicket(input, path, secret, 0)).toBe(false)
    }
  })
  it('requires the negotiated protocol and valid server-side configuration', async () => {
    const ticket = await issueSocketTicket(path, secret, 0)
    expect(await validSocketTicket(ticket, path, secret, 0)).toBe(false)
    expect(await validSocketTicket(header(ticket), path, '', 0)).toBe(false)
  })
})
