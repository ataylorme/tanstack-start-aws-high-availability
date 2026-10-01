import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const path = 'scripts/verify-regional-outage.ts'
const source = readFileSync(path, 'utf8')
describe('combined regional outage orchestrator', () => {
  it('defaults to an offline plan with precise simulation boundaries', () => {
    const output = execFileSync(process.execPath, [path], { env: { PATH: '' }, encoding: 'utf8' })
    expect(output).toContain('Offline plan')
    expect(output).toContain('Not a network timeout or actual AWS region shutdown')
    expect(output).toContain('same-ID write retry')
  })
  it('checkpoints original states and starts independent watchdog before mutations', () => {
    expect(source.indexOf('save() // Durable ownership')).toBeLessThan(source.indexOf('await fis.prepare()'))
    expect(source.indexOf('Watchdog failed to start')).toBeLessThan(source.indexOf('await fis.prepare()'))
    expect(source).toContain("'StreamMappingId', 'QueueMappingId', 'ApplicationMappingId', 'OrderedMappingId'")
    expect(source).toContain('await pause(65_000)')
    expect(source).toContain('restoreRegionalResources(manifest, aws)')
    expect(source).toContain('manifest.serviceRestored = restoration.errors.length === 0')
  })
  it('requires actual data-plane failure and real transport, not direct subscriber invocation', () => {
    expect(source).toContain('InternalServerError|InternalFailure|ServiceUnavailable')
    expect(source).toContain('manifest.combinedFaultPassed = true')
    expect(source).toContain("action: 'publish'")
    expect(source).toContain("action: 'inspect'")
    expect(source).not.toContain("action: 'deliver'")
    expect(source).toContain('assert.deepEqual(afterDrain.data.transport.receipts, transportReceipts!)')
    expect(source).toContain('Writes must not be automatically retried by CloudFront')
  })
})
