import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { scheduleFixture } from '../scripts/verify-schedule-policies'

describe('schedule policy live verifier safety', () => {
  it('defaults to an offline plan with no credentials', () => {
    const output = execFileSync(process.execPath, ['scripts/verify-schedule-policies.ts'], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    expect(output).toContain('Plan only')
  })
  it('bounds fixture policies and rejects non-test identifiers', () => {
    expect(scheduleFixture('test-schedule-abc-123', 'skip', 1000, 'catch-up', 'skip')).toMatchObject({ enabled: true, maxCatchUp: 2, missedTickPolicy: 'catch-up', overlapPolicy: 'skip', nextFireAt: 1000 })
    expect(() => scheduleFixture('production', 'skip', 1000)).toThrow()
  })
  it('persists recovery information and restores only owned fixtures', () => {
    const source = readFileSync('scripts/verify-schedule-policies.ts', 'utf8')
    expect(source.indexOf("save('prepared')")).toBeLessThan(source.indexOf("for (const missed of"))
    expect(source).toContain('mode: 0o600')
    expect(source).toContain('EXPECTED_AWS_ACCOUNT_ID')
    expect(source).toContain('verifyWorkflowPackage()')
    expect(source).toContain('finally {')
    expect(source).toContain('enabled: false')
    expect(source).toContain("store.deleteRun(runId, 'aborted')")
    expect(source).not.toContain('UpdateEventSourceMapping')
    expect(source).toContain('directClaims: false')
    expect(source).toContain('Old generation ack must not advance newer definition')
  })
})
