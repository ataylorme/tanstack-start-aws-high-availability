import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('deployment safety', () => {
  // Empty PATH proves plan mode cannot accidentally require/call AWS or Docker.
  const env = { PATH: '', STACK_PREFIX: 'unit-test' }
  it('defaults to a no-side-effects plan', () => {
    const output = execFileSync(process.execPath, ['scripts/deploy.ts'], { env, encoding: 'utf8' })
    expect(output).toContain('no AWS calls made')
    expect(output).toContain('unit-test')
  })
  it('refuses malformed stack names before any subprocess call', () => {
    expect(() => execFileSync(process.execPath, ['scripts/deploy.ts'], {
      env: { ...env, STACK_PREFIX: '../unsafe' }, stdio: 'pipe',
    })).toThrow()
  })
  it('plans isolated workflow infrastructure without AWS calls', () => {
    const output = execFileSync(process.execPath, ['scripts/deploy.ts'], {
      env: { ...env, ENABLE_WORKFLOW_TESTS: 'true', ECR_UPLOAD_MODE: 'api' }, encoding: 'utf8',
    })
    expect(output).toContain('MRSC')
    expect(output).toContain('Ohio witness')
    expect(output).toContain('native sweepers')
    expect(output).toContain('ECR upload mode: api')
  })
  it('rejects invalid modes and unsafe workflow prefixes offline', () => {
    for (const overrides of [
      { ENABLE_WORKFLOW_TESTS: 'yes' },
      { ECR_UPLOAD_MODE: 'unknown' },
      { ENABLE_WORKFLOW_TESTS: 'true', STACK_PREFIX: 'tanstack-ha' },
      { ENABLE_WORKFLOW_TESTS: 'true', STACK_PREFIX: '' },
    ]) {
      expect(() => execFileSync(process.execPath, ['scripts/deploy.ts'], {
        env: { ...env, ...overrides }, stdio: 'pipe',
      })).toThrow()
    }
    expect(() => execFileSync(process.execPath, ['scripts/deploy.ts'], {
      env: { PATH: '', ENABLE_WORKFLOW_TESTS: 'true' }, stdio: 'pipe',
    })).toThrow()
  })
  it('requires explicit execution for a failure drill', () => {
    const output = execFileSync(process.execPath, ['scripts/set-failure.ts', 'us-west-2', 'true'], {
      env, encoding: 'utf8',
    })
    expect(output).toContain('Plan only')
    expect(output).toContain('us-west-2')
  })
  it('rejects unexpected regions and failure values', () => {
    for (const args of [['eu-west-1', 'true'], ['us-east-1', 'yes']]) {
      expect(() => execFileSync(process.execPath, ['scripts/set-failure.ts', ...args], {
        env, stdio: 'pipe',
      })).toThrow()
    }
  })
})
