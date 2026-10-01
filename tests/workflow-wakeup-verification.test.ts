import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const recovery = readFileSync(new URL('../scripts/verify-workflow-recovery.ts', import.meta.url), 'utf8')
const idle = readFileSync(new URL('../scripts/verify-workflow-wakeups.ts', import.meta.url), 'utf8')
describe('workflow wakeup verification safeguards', () => {
  it('distinguishes HTTP routing from background execution ownership', () => {
    const workflow = readFileSync('scripts/verify-workflows.ts', 'utf8')
    expect(workflow).toContain("assert.equal(response.headers.get('x-served-by-region'), region)")
    expect(workflow).toContain('regions.includes(object(output.started).region')
    expect(workflow).toContain('regions.includes(object(output.signaled).region')
    expect(workflow).not.toContain('assert.equal(object(output.signaled).region, other)')
    expect(recovery).toContain('regions.includes(object(output.started).region')
    expect(recovery).toContain('assert.equal(object(output.firstWake).region, healthyRegion)')
    expect(recovery).toContain('assert.equal(object(output.finished).region, healthyRegion)')
  })
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

it('guards regional isolation and checkpoints restoration before changing mappings', () => {
  expect(recovery).toContain('Explicit AWS_PROFILE required')
  expect(recovery).toContain('EXPECTED_AWS_ACCOUNT_ID required')
  expect(recovery.indexOf("'AWS account mismatch'")).toBeLessThan(recovery.indexOf("'--no-enabled'"))
  expect(recovery.indexOf('save() // Record the exact mapping')).toBeLessThan(recovery.indexOf("'--no-enabled'"))
  expect(recovery).toContain('attempt.restored = true')
  expect(recovery).toContain('Exactly two committed timer resolutions')
})

it('restores regional mappings after handled termination and retries transient restoration errors', () => {
  expect(recovery).toContain("['SIGINT', 'SIGTERM']")
  expect(recovery).toContain('if (interrupted && !restoring) throw')
  expect(recovery).toMatch(/await setTimeout\(65_000\)\s+checkInterrupted\(\)/)
  expect(recovery).toMatch(/finally\s*\{\s*restoring = true/)
  expect(recovery).toContain('retry < 3')
  expect(recovery).toContain('Restoration failed:')
  expect(recovery).toMatch(/save\(\)\s+restoring = false\s+if \(restorationError\) throw restorationError/)
})
