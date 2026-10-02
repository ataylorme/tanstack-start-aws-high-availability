import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
interface Resource { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string }
const template = JSON.parse(readFileSync('infra/orchestration-poc.yaml', 'utf8')) as { Resources: Record<string, Resource> }
const resources = template.Resources
const raw = JSON.stringify(template)
const ofType = (type: string) => Object.values(resources).filter(resource => resource.Type === `AWS::${type}`)
describe('isolated orchestration infrastructure', () => {
  it('plans offline without credentials or executable tools', () => {
    for (const script of ['deploy', 'cleanup']) {
      const output = execFileSync(process.execPath, [`scripts/${script}-orchestration.ts`], { env: { PATH: '' }, encoding: 'utf8' })
      expect(output).toContain('no AWS calls made')
      expect(output).toContain('devops-orchestration-poc')
    }
  })
  it('rejects execution without fixed deployment identity before invoking tools', () => {
    for (const script of ['deploy', 'cleanup']) {
      expect(() => execFileSync(process.execPath, [`scripts/${script}-orchestration.ts`, '--execute'], { env: { PATH: '' }, stdio: 'pipe' })).toThrow('AWS_PROFILE=ataylorme')
    }
  })
  it('guards image format, credential continuity, and predeployment validation', () => {
    const script = readFileSync('scripts/deploy-orchestration.ts', 'utf8')
    expect(script).toContain("'--provenance=false', '--sbom=false', '--load'")
    expect(script).toContain('refusing credential regeneration')
    expect(script).toContain("execFileSync('npm', ['run', 'check']")
    expect(script).toContain("execFileSync('npm', ['run', 'smoke']")
  })
  it('uses one digest parameter across six image roles with only one public URL', () => {
    const functions = ofType('Lambda::Function')
    expect(functions).toHaveLength(6)
    for (const fn of functions) {
      expect(fn.Properties.Code).toEqual({ ImageUri: { Ref: 'ImageUri' } })
      expect(fn.Properties.PackageType).toBe('Image')
      expect(fn.Properties.Environment).toMatchObject({ Variables: { APP_MODE: 'orchestration', AWS_LWA_PASS_THROUGH_PATH: '/internal/events' } })
    }
    expect(JSON.stringify(resources.HttpFunction)).not.toContain('AWS_LWA_ERROR_STATUS_CODES')
    for (const role of ['Router', 'Worker', 'Executor', 'Relay', 'Sandbox']) expect(resources[`${role}Function`]?.Properties.Environment).toMatchObject({ Variables: { AWS_LWA_ERROR_STATUS_CODES: '400-599' } })
    expect(ofType('Lambda::Url')).toHaveLength(1)
    expect(resources.HttpUrl?.Properties.TargetFunctionArn).toEqual({ Ref: 'HttpFunction' })
    expect(resources.ExecutorFunction?.Properties.ReservedConcurrentExecutions).toBe(1)
    expect(resources.SandboxFunction?.Properties.ReservedConcurrentExecutions).toBe(1)
  })
  it('isolates all storage without imports, replicas, or recurring cloud polls', () => {
    expect(ofType('DynamoDB::Table')).toHaveLength(2)
    expect(resources.WorkflowTable?.Properties.StreamSpecification).toEqual({ StreamViewType: 'NEW_AND_OLD_IMAGES' })
    expect(resources.WorkflowTable?.DeletionPolicy).toBe('Retain')
    expect(resources.OperationsTable?.DeletionPolicy).toBe('Retain')
    for (const forbidden of ['ImportValue', 'GlobalTable', 'tanstack-ha', 'rate(1 minute)']) expect(raw).not.toContain(forbidden)
    expect(ofType('Lambda::EventSourceMapping')).toHaveLength(3)
    expect(ofType('CloudWatch::Alarm').length).toBeGreaterThanOrEqual(10)
    expect(ofType('Logs::LogGroup').every(resource => resource.Properties.RetentionInDays === 14)).toBe(true)
  })
  it('restricts mutations to executor and publishes to independent FIFO observation queue', () => {
    for (const role of ['Http', 'Router', 'Worker', 'Relay', 'Sandbox']) expect(JSON.stringify(resources[`${role}Role`])).not.toContain('lambda:PutFunctionConcurrency')
    const executor = JSON.stringify(resources.ExecutorRole)
    expect(executor).toContain('lambda:PutFunctionConcurrency')
    for (const action of ['dynamodb:Query', 'dynamodb:DeleteItem', 'dynamodb:ConditionCheckItem']) expect(executor).toContain(action)
    expect(JSON.stringify(resources.HttpRole)).not.toContain('OperationsTable')
    expect(executor).toContain('function:devops-orchestration-poc-sandbox')
    expect(resources.ApplicationTopic?.Properties.FifoTopic).toBe(true)
    expect(resources.ObservationQueue?.Properties.FifoQueue).toBe(true)
    expect(resources.ObservationSubscription?.Properties.RawMessageDelivery).toBe(true)
  })
  it('keeps live acceptance opt-in and verifies mapping ownership before pauses', () => {
    const output = execFileSync(process.execPath, ['scripts/verify-orchestration.ts'], { env: { PATH: '' }, encoding: 'utf8' })
    expect(output).toContain('No AWS calls made')
    expect(() => execFileSync(process.execPath, ['scripts/verify-orchestration.ts', '--execute'], { env: { PATH: '' }, stdio: 'pipe' })).toThrow()
    const source = readFileSync('scripts/verify-orchestration.ts', 'utf8')
    expect(source).toContain("tag.Key === 'Project'")
    expect(source).toContain('resources.includes(item.UUID)')
    expect(source).toContain("item.State !== 'Enabled'")
  })

})
