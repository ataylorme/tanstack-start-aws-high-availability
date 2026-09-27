import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const template = readFileSync('infra/application-events.yaml', 'utf8')
describe('application-event deployment safety', () => {
  it('plans offline with no executable tools available', () => {
    const output = execFileSync(process.execPath, ['scripts/deploy-application-events.ts'], {
      env: { PATH: '', STACK_PREFIX: 'pr4-test' }, encoding: 'utf8',
    })
    expect(output).toContain('no AWS calls made')
    expect(output).toContain('pr4-test-workflow')
    expect(output).toContain('No west reader')
  })
  it('rejects missing, shared and malformed prefixes before AWS calls', () => {
    for (const prefix of [undefined, '', 'tanstack-ha', '../unsafe', 'CAPITAL', 'x'.repeat(41)]) {
      for (const args of [[], ['--execute']]) {
        expect(() => execFileSync(process.execPath, ['scripts/deploy-application-events.ts', ...args], {
          env: { PATH: '', ...(prefix === undefined ? {} : { STACK_PREFIX: prefix }) }, stdio: 'pipe',
        })).toThrow('explicit isolated STACK_PREFIX')
      }
    }
  })
  it('provisions one private reader and a standard queue with bounded delivery retries', () => {
    expect(template.match(/Type: AWS::Lambda::EventSourceMapping/g)).toHaveLength(1)
    expect(template).not.toContain('AWS::Lambda::Url')
    expect(template).not.toContain('FifoQueue')
    expect(template).toContain('Type: AWS::SQS::Queue')
    expect(template).toContain('MaximumRetryAttempts: 5')
    expect(template).toContain('MaximumRecordAgeInSeconds: 3600')
    expect(template).toContain('FunctionResponseTypes: [ReportBatchItemFailures]')
    expect(template).toContain('"eventName":["INSERT"]')
    expect(template).toContain('"APPLICATION_EVENT"')
  })
  it('retains a private encrypted failure archive and exposes operational alarms', () => {
    expect(template).toContain('OnFailure: { Destination: !GetAtt FailureArchive.Arn }')
    expect(template).toContain('BlockPublicPolicy: true')
    expect(template).toContain('SSEAlgorithm: AES256')
    expect(template.match(/Type: AWS::CloudWatch::Alarm/g)).toHaveLength(4)
    expect(template).toContain('application_event_delivery_failed')
    expect(template).toContain('DeletionPolicy: Retain')
  })
})


describe('application-event verification and candidate packaging', () => {
  it('plans live verification offline without credentials, site, or CLI access', () => {
    const output = execFileSync(process.execPath, ['scripts/verify-application-events.ts'], {
      env: { PATH: '' }, encoding: 'utf8',
    })
    expect(output).toContain('Plan only')
    expect(output).toContain('HTTP publication in both AWS Regions')
    expect(output).toContain('stream-to-SQS delivery')
    expect(output).toContain('deletes only matching test messages')
  })
  it('pins the PR4 candidate and verifies both manifest and npm integrity hashes', () => {
    const manifest = JSON.parse(readFileSync('vendor/application-events-candidate.json', 'utf8'))
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
    expect(manifest.repository).toBe('https://github.com/ataylorme/tanstack-workflow-aws')
    expect(manifest.pullRequest).toBe(4)
    expect(manifest.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(manifest.tarball).toMatch(/^[a-zA-Z0-9.-]+\.tgz$/)
    const bytes = readFileSync(`vendor/${manifest.tarball}`)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256)
    const dependency = '@ataylorme/tanstack-workflow-aws'
    const specifier = `file:vendor/${manifest.tarball}`
    expect(pkg.dependencies[dependency]).toBe(specifier)
    expect(lock.packages[''].dependencies[dependency]).toBe(specifier)
    expect(lock.packages[`node_modules/${dependency}`].resolved).toBe(specifier)
    expect(lock.packages[`node_modules/${dependency}`].version).toBe(manifest.version)
    expect(lock.packages[`node_modules/${dependency}`].integrity).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`)
  })
  it('makes vendored candidate available before Docker npm ci', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')
    const copy = dockerfile.indexOf('COPY vendor/ ./vendor/')
    expect(copy).toBeGreaterThan(-1)
    expect(copy).toBeLessThan(dockerfile.indexOf('npm ci'))
    const ignored = readFileSync('.dockerignore', 'utf8').split('\n').map(line => line.trim())
    expect(ignored).not.toContain('vendor')
    expect(ignored).not.toContain('vendor/')
    expect(ignored).not.toContain('*.tgz')
  })
})
