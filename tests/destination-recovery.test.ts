import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const scriptPath = 'scripts/verify-destination-recovery.ts'
const source = readFileSync(scriptPath, 'utf8')
const run = (args: string[] = [], env: Record<string, string> = {}) => execFileSync(process.execPath, [scriptPath, ...args], {
  env: { PATH: '', STACK_PREFIX: 'pr4-isolated', ...env }, encoding: 'utf8', stdio: 'pipe',
})

describe('destination recovery live drill safety', () => {
  it('is offline by default and documents regional impact and boundaries', () => {
    const output = run()
    for (const text of ['no AWS calls made', 'east router sqs:SendMessage', 'west stays online', 'original unchanged archived record', 'No queue purges', 'Run sequentially']) expect(output).toContain(text)
  })
  it('refuses invalid prefixes, unsupported arguments, and absent execution identity before AWS calls', () => {
    for (const prefix of ['', 'tanstack-ha', '../bad', 'UPPER', 'x'.repeat(41)]) expect(() => run([], { STACK_PREFIX: prefix })).toThrow('explicit isolated STACK_PREFIX')
    expect(() => run(['--force'])).toThrow('Only --execute')
    for (const env of [{}, { AWS_PROFILE: 'fixture' }, { EXPECTED_AWS_ACCOUNT_ID: '123456789012' }, { AWS_PROFILE: 'fixture', EXPECTED_AWS_ACCOUNT_ID: 'invalid' }]) expect(() => run(['--execute'], env)).toThrow('Execution requires AWS_PROFILE and EXPECTED_AWS_ACCOUNT_ID')
  })
  it('writes recovery instructions before mutation and narrowly scopes the temporary denial', () => {
    expect(source.indexOf('save() // Durable recovery instructions')).toBeLessThan(source.indexOf('await setMapping(false)'))
    expect(source).toContain("LogicalResourceId === 'DispatcherRole'")
    expect(source).toContain('Policy collision')
    expect(source).toContain("Effect: 'Deny', Action: 'sqs:SendMessage', Resource: outputs.ApplicationQueueArn")
    expect(source).toContain('await pause(65_000)')
    expect(source).toContain("'--profile', process.env.AWS_PROFILE!")
    expect(source).not.toContain("Resource: '*'")
  })
  it('requires native retries, exact archive replay and region-specific downstream delivery', () => {
    expect(source).toContain('archive.requestContext?.approximateInvokeCount >= 2')
    expect(source).toContain('assert.deepEqual(match.dynamodb.NewImage, item)')
    expect(source).toContain('invoke(archivedRecord) // Exact original archive record')
    expect(source).toContain('assert.deepEqual(envelope, event)')
    expect(source).toContain("s.Condition?.ArnEquals?.['aws:SourceArn'] === outputs.ApplicationTopicArn")
    expect(source).toContain('s.Endpoint === queueAttributes.QueueArn')
    expect(source).toContain('if (envelope?.id !== runId) continue')
    expect(source).not.toContain("'purge-queue'")
    expect(source).not.toContain("'delete-item'")
  })
  it('bounds loops, checks actual alarm evidence, and restores independently with retries on failure/interruption', () => {
    expect(source).toContain('Date.now() + 300_000')
    expect(source).toContain("JSON.parse(h.HistoryData).newState?.stateValue === 'ALARM'")
    expect(source).toContain("['SIGINT', 'SIGTERM']")
    expect(source).toContain('restoring = true')
    expect(source).toContain('attempt < 3')
    expect(source).toContain('await setMapping(originalEnabled)')
    expect(source).toContain("assert.ok(!remaining.includes(policyName), 'Temporary deny still present')")
    expect(source).not.toContain("'set-alarm-state'")
  })
})
