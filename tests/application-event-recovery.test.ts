import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('application-event recovery validation safety', () => {
  it('defaults to an offline, explicitly limited recovery plan', () => {
    const output = execFileSync(process.execPath, ['scripts/verify-application-event-recovery.ts'], {
      env: { PATH: '', STACK_PREFIX: 'pr4-isolated' }, encoding: 'utf8',
    })
    expect(output).toContain('no AWS calls made')
    expect(output).toContain('pr4-isolated')
    expect(output).toContain('5-minute S3 failure archive')
    expect(output).toContain('NOT destination-outage replay')
    expect(output).toContain('FIFO → SNS → observation SQS')
    expect(output).toContain('replicated to both regions')
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
  it('requires explicit account and profile before external commands', () => {
    for (const environment of [{}, { AWS_PROFILE: 'fixture' }, { EXPECTED_AWS_ACCOUNT_ID: '123456789012' }, { AWS_PROFILE: 'fixture', EXPECTED_AWS_ACCOUNT_ID: 'invalid' }]) {
      expect(() => execFileSync(process.execPath, ['scripts/verify-application-event-recovery.ts', '--execute'], {
        env: { PATH: '', STACK_PREFIX: 'pr4-isolated', ...environment }, stdio: 'pipe',
      })).toThrow('Execution requires AWS_PROFILE and EXPECTED_AWS_ACCOUNT_ID')
    }
  })
  it('targets the unified router and uses a non-legacy poison fixture without modifying the original', () => {
    const script = readFileSync('scripts/verify-application-event-recovery.ts', 'utf8')
    expect(script).toContain('`${prefix}-sweeper`')
    expect(script).toContain('`${prefix}-application-events`')
    expect(script).toContain("schemaVersion: { N: '1' }")
    expect(script).toContain('outputs.DispatcherFunctionName')
    expect(script).toContain('mapping.BatchSize, 10')
    expect(script).toContain('mapping.MaximumRetryAttempts <= 10')
    expect(script).toContain('Date.now() + 300_000')
    expect(script).toContain('const replay = structuredClone(archivedRecord)')
    expect(script).not.toContain('Legacy application-event recovery runner is disabled')
    expect(script).not.toContain("'delete-item'")
  })
  it('rejects unsupported arguments before any external commands', () => {
    expect(() => execFileSync(process.execPath, ['scripts/verify-application-event-recovery.ts', '--force'], {
      env: { PATH: '', STACK_PREFIX: 'pr4-isolated' }, stdio: 'pipe',
    })).toThrow('Only --execute is supported')
  })
})
