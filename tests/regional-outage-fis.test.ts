import { describe, expect, it } from 'vitest'
import { RegionalOutageFis, type FisState } from '../scripts/regional-outage-fis.ts'
function fixture() {
  const state: FisState = {}, calls: { region: string; args: string[] }[] = [], snapshots: FisState[] = []
  let alarm = false, status = 'running'
  const helper = new RegionalOutageFis({ account: '123456789012', failedRegion: 'us-east-1', healthyRegion: 'us-west-2', tableName: 'test-lab-workflow', runId: 'test-outage-12345678', state,
    checkpoint: () => { snapshots.push(structuredClone(state)) }, sleep: async () => {},
    aws: async (region, args) => {
      calls.push({ region, args })
      switch (args.slice(0, 2).join(' ')) {
        case 'iam get-role': throw new Error('NoSuchEntity')
        case 'cloudwatch describe-alarms': return { MetricAlarms: alarm ? [{ StateValue: 'OK' }] : [] }
        case 'cloudwatch put-metric-alarm': alarm = true; break
        case 'fis create-experiment-template': return { experimentTemplate: { id: 'EXT123' } }
        case 'fis start-experiment': return { experiment: { id: 'EXP123', state: { status } } }
        case 'fis get-experiment': return { experiment: { id: 'EXP123', state: { status } } }
        case 'fis stop-experiment': status = 'stopped'; break
        case 'fis list-experiments': return { experiments: [] }
      }
      return {}
    },
  })
  return { helper, state, calls, snapshots }
}
describe('regional-outage FIS safety helper', () => {
  it('targets exact failed replica, bounded duration, native stop alarm', () => {
    const { helper } = fixture(), t = helper.template()
    expect(t.targets.table.resourceArns).toEqual(['arn:aws:dynamodb:us-east-1:123456789012:table/test-lab-workflow'])
    expect(t.actions.isolate.parameters.duration).toBe('PT15M')
    expect(t.stopConditions[0]?.value).toContain(':us-east-1:')
  })
  it('checkpoints ownership before mutations and scopes role trust', async () => {
    const { helper, calls, snapshots } = fixture()
    await helper.prepare()
    expect(snapshots[0]?.roleMayExist).toBe(true)
    expect(snapshots.some(s => s.alarmMayExist && !s.templateId)).toBe(true)
    const create = calls.find(c => c.args[1] === 'create-role')!.args
    const trust = JSON.parse(create[create.indexOf('--assume-role-policy-document') + 1]!)
    expect(trust.Statement[0].Condition.StringEquals['aws:SourceAccount']).toBe('123456789012')
    expect(trust.Statement[0].Condition.ArnLike['aws:SourceArn']).toBe('arn:aws:fis:us-east-1:123456789012:experiment/*')
    const alarm = calls.find(c => c.args[1] === 'put-metric-alarm')!.args
    expect(alarm[alarm.indexOf('--treat-missing-data') + 1]).toBe('breaching')
    expect(calls.findIndex(c => c.args[1] === 'put-metric-data')).toBeLessThan(calls.findIndex(c => c.args[1] === 'create-experiment-template'))
  })
  it('stops experiment before deleting its safety resources', async () => {
    const { helper, calls, state } = fixture()
    await helper.prepare(); await helper.start(); await helper.cleanup()
    expect(state.cleaned).toBe(true)
    expect(calls.findIndex(c => c.args[1] === 'stop-experiment')).toBeLessThan(calls.findIndex(c => c.args[1] === 'delete-role'))
    expect(calls.filter(c => c.args[1] === 'start-experiment')).toHaveLength(1)
  })
  it('does not start an experiment when recovering ambiguous start', async () => {
    const { helper, state, calls } = fixture()
    state.startToken = 'unknown'; state.templateId = 'EXT123'
    await expect(helper.cleanup()).rejects.toThrow('Ambiguous experiment start')
    expect(calls.some(c => c.args[1] === 'start-experiment' || c.args[1] === 'delete-role')).toBe(false)
  })
  it('emits zero for unhealthy probe rather than synthetically setting alarm state', async () => {
    const { helper, calls } = fixture()
    await helper.health(false)
    const args = calls[0]!.args
    expect(JSON.parse(args[args.indexOf('--metric-data') + 1]!)[0].Value).toBe(0)
    expect(args).not.toContain('set-alarm-state')
  })
})
