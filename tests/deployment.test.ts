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
