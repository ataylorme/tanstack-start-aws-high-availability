import { assertSafeWakeupChange, type WakeupResourceChange } from '../scripts/workflow-wakeup-changes'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const template = readFileSync('infra/workflow-sweeper.yaml', 'utf8')
describe('demand-driven workflow infrastructure', () => {
  it('plans offline with explicit migration phases', () => {
    const output = execFileSync(process.execPath, ['scripts/deploy-workflow-wakeups.ts'], { env: { PATH: '', STACK_PREFIX: 'isolated-test' }, encoding: 'utf8' })
    expect(output).toContain('no AWS calls made')
    expect(output).toContain('--legacy=enabled, reconcile, --legacy=disabled')
  })
  it('rejects unsafe targeting and missing account guard before execution', () => {
    for (const prefix of ['', 'tanstack-ha', '../bad']) expect(() => execFileSync(process.execPath, ['scripts/deploy-workflow-wakeups.ts'], { env: { PATH: '', STACK_PREFIX: prefix }, stdio: 'pipe' })).toThrow('explicit isolated STACK_PREFIX')
    expect(() => execFileSync(process.execPath, ['scripts/deploy-workflow-wakeups.ts', '--execute'], { env: { PATH: '', STACK_PREFIX: 'isolated-test' }, stdio: 'pipe' })).toThrow('EXPECTED_AWS_ACCOUNT_ID')
  })
  it('fans out through one regional stream mapping into isolated FIFO transports', () => {
    expect(template.match(/EventSourceArn: !Ref StreamArn/g)).toHaveLength(1)
    expect(template).toContain('APPLICATION_QUEUE_URL: !Ref ApplicationQueue')
    expect(template).toContain('FifoTopic: true')
    expect(template.match(/FifoQueue: true/g)).toHaveLength(4)
    expect(template).toContain('Handler: application-consumer.handler')
    expect(template).toContain('Handler: ordered-subscriber.handler')
    expect(template).toContain("FilterPolicy: { ordered: ['true'] }")
    expect(template).toContain('SUBSCRIBER_ID: ha-ordered-lab-transport-v1')
    expect(template).toContain('RawMessageDelivery: true')
    expect(readFileSync('infra/workflow-table.yaml', 'utf8')).toContain('StreamViewType: NEW_AND_OLD_IMAGES')
  })
  it('retains the legacy observation queue without a second active stream reader', () => {
    const observation = readFileSync('infra/application-events.yaml', 'utf8')
    expect(observation).toContain("LegacyReaderEnabled: { Type: String, Default: 'false'")
    expect(observation).toContain('Enabled: !If [EnableLegacyReader, true, false]')
    expect(observation).toContain('ObservationSubscription:')
    expect(observation).toContain("'aws:SourceArn': !Ref ApplicationTopicArn")
  })
  it('defaults to no recurring polling and preserves reversible migration', () => {
    expect(template).toContain('Default: removed')
    expect(template).toContain('AllowedValues: [enabled, disabled, removed]')
    expect(template.match(/Condition: KeepLegacySchedule/g)).toHaveLength(3)
  })
  it('clears the queue concurrency cap to allow low-traffic polling optimization', () => {
    const queueMapping = template.split('  QueueMapping:')[1]!.split('  IteratorAgeAlarm:')[0]!
    expect(queueMapping).toContain('ScalingConfig: {}')
    expect(queueMapping).not.toContain('MaximumConcurrency')
    expect(template).not.toContain('ReservedConcurrentExecutions')
    expect(queueMapping).not.toContain('ProvisionedPollerConfig')
  })
  it('provides durable regional wakeups with scoped IAM and bounded retries', () => {
    expect(template).toContain('VisibilityTimeout: 360')
    expect(template).toContain('Handler: dispatcher.handler')
    expect(template).toContain('Handler: sweeper.handler')
    expect(template).toContain('scheduler:CreateSchedule, scheduler:GetSchedule')
    expect(template).toContain("'iam:PassedToService': scheduler.amazonaws.com")
    expect(template).toContain('"SK":{"S":["META"]}')
    expect(template).toContain('MaximumRecordAgeInSeconds: 82800')
    expect(template).toContain('OnFailure: { Destination: !GetAtt FailureArchive.Arn }')
    expect(template.match(/FunctionResponseTypes: \[ReportBatchItemFailures\]/g)).toHaveLength(4)
    expect(template.match(/Type: AWS::CloudWatch::Alarm/g)).toHaveLength(18)
  })
})


describe('workflow change-set replacement guard', () => {
  const permission: WakeupResourceChange = {
    Action: 'Modify', LogicalResourceId: 'SweepPermission', ResourceType: 'AWS::Lambda::Permission', Replacement: 'Conditional',
    Details: [{ Target: { Attribute: 'Properties', Name: 'SourceArn', RequiresRecreation: 'Always' },
      Evaluation: 'Dynamic', ChangeSource: 'ResourceAttribute', CausingEntity: 'SweepRule.Arn' }],
  }
  it('allows only the conditional legacy permission ARN recreation', () => {
    expect(() => assertSafeWakeupChange(permission)).not.toThrow()
    for (const change of [
      { ...permission, Replacement: 'True' }, { ...permission, LogicalResourceId: 'Worker' },
      { ...permission, ResourceType: 'AWS::IAM::Role' }, { ...permission, Details: [] },
      { ...permission, Details: [{ ...permission.Details![0], CausingEntity: 'Worker.Arn' }] },
      { ...permission, Details: [{ ...permission.Details![0], Target: { Attribute: 'Properties', Name: 'FunctionName', RequiresRecreation: 'Always' } }] },
      { ...permission, Details: [...permission.Details!, ...permission.Details!] },
    ]) expect(() => assertSafeWakeupChange(change)).toThrow('Unsafe replacement/removal')
  })
  it('allows normal additions/modifications and only legacy deletions', () => {
    for (const Action of ['Add', 'Modify']) expect(() => assertSafeWakeupChange({ Action, LogicalResourceId: 'Worker', Replacement: 'False' })).not.toThrow()
    expect(() => assertSafeWakeupChange({ Action: 'Remove', LogicalResourceId: 'SweepRule' })).not.toThrow()
    expect(() => assertSafeWakeupChange({ Action: 'Remove', LogicalResourceId: 'Worker' })).toThrow()
  })
})
