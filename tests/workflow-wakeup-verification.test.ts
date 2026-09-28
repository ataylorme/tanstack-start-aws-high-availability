import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const recovery = readFileSync(new URL('../scripts/verify-workflow-recovery.ts', import.meta.url), 'utf8')
const idle = readFileSync(new URL('../scripts/verify-workflow-wakeups.ts', import.meta.url), 'utf8')
describe('workflow wakeup verification safeguards', () => {
  it('pauses queue mappings and restores them after either outcome', () => {
    expect(recovery).toContain("OutputKey=='WakeupMappingId'")
    expect(recovery).toContain("await waitForMapping(pausedRegion, mapping, 'Disabled')")
    expect(recovery).toContain('await setTimeout(65_000)')
    expect(recovery).toMatch(/finally\s*\{[\s\S]*'--enabled'[\s\S]*await waitForMapping\(pausedRegion, mapping, 'Enabled'\)/)
    expect(recovery).not.toContain('disable-rule')
  })
  it('uses read-only idle checks and rejects failures and ongoing polling', () => {
    expect(idle).toContain("rule.State === 'DISABLED'")
    expect(idle).toContain('minute < 15')
    expect(idle).toContain('Failure queue is not empty')
    expect(idle).toContain('metric.invocations === 0')
    expect(idle).not.toMatch(/'update-event-source-mapping'|'disable-rule'|'create-schedule'|'send-message'/)
  })
})

describe('abandoned workflow verification safeguards', () => {
  const source = readFileSync(new URL('../scripts/verify-workflow-wakeup-recovery.ts', import.meta.url), 'utf8')
  it('requires explicit execution and validates account before durable mutations', () => {
    expect(source.indexOf("if (!process.argv.includes('--execute'))")).toBeLessThan(source.indexOf("['sts', 'get-caller-identity']"))
    expect(source.indexOf("'AWS account mismatch'")).toBeLessThan(source.indexOf('await store.createRun'))
    expect(source).toContain("prefix !== 'tanstack-ha'")
    expect(source).toContain('EXPECTED_AWS_ACCOUNT_ID')
    expect(source).toContain('runs.length < 12')
    expect(source).toContain("assert.equal(rule.State, 'DISABLED'")
    expect(source.indexOf("'Legacy polling must be disabled")).toBeLessThan(source.indexOf('await store.createRun'))
    expect(source).toContain('leaseMs: 45_000')
    expect(source).toContain('save() // Persist ownership before the first durable action.')
  })
  it('observes schedules and timers without manually sweeping or deleting fixtures', () => {
    expect(source).toContain("'scheduler', 'get-schedule'")
    expect(source).toContain('current.updatedAt >= run.expiresAt')
    expect(source).toContain('assert.equal(run.timerResolutions, 2')
    expect(source).not.toMatch(/\.sweep\(|deleteRun\(|delete-item/)
  })
})
