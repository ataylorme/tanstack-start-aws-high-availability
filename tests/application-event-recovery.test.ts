import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('application-event recovery validation safety', () => {
  it('defaults to an offline, explicitly limited recovery plan', () => {
    const output = execFileSync(process.execPath, ['scripts/verify-application-event-recovery.ts'], {
      env: { PATH: '', STACK_PREFIX: 'pr4-isolated' }, encoding: 'utf8',
    })
    expect(output).toContain('no AWS calls made')
    expect(output).toContain('pr4-isolated')
    expect(output).toContain('3-minute S3 failure archive')
    expect(output).toContain('NOT destination-outage replay')
    expect(output).toContain('deletes only matching SQS messages')
  })
  it('refuses missing, shared, malformed prefixes even with explicit execution', () => {
    for (const prefix of [undefined, '', 'tanstack-ha', '../bad', 'UPPER', 'x'.repeat(41)]) {
      for (const args of [[], ['--execute']]) {
        expect(() => execFileSync(process.execPath, ['scripts/verify-application-event-recovery.ts', ...args], {
          env: { PATH: '', ...(prefix === undefined ? {} : { STACK_PREFIX: prefix }) }, stdio: 'pipe',
        })).toThrow('explicit isolated STACK_PREFIX')
      }
    }
  })
  it('rejects unsupported arguments before any external commands', () => {
    expect(() => execFileSync(process.execPath, ['scripts/verify-application-event-recovery.ts', '--force'], {
      env: { PATH: '', STACK_PREFIX: 'pr4-isolated' }, stdio: 'pipe',
    })).toThrow('Only --execute is supported')
  })
})
