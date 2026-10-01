import assert from 'node:assert/strict'

export type FisAws = (region: string, args: string[]) => any | Promise<any>
export type FisState = {
  roleMayExist?: boolean; alarmMayExist?: boolean; templateId?: string; experimentId?: string
  createToken?: string; startToken?: string; lastExperiment?: any; cleaned?: boolean
}
export type FisOptions = {
  account: string; failedRegion: string; healthyRegion: string; tableName: string; runId: string
  aws: FisAws; state: FisState; checkpoint: () => void | Promise<void>
  sleep?: (ms: number) => Promise<void>
}
const terminal = new Set(['completed', 'stopped', 'failed', 'cancelled'])

/** Exact-table, bounded FIS fault. Caller owns account/resource preflight and heartbeat loop. */
export class RegionalOutageFis {
  readonly options: FisOptions
  readonly roleName: string
  readonly alarmName: string
  readonly roleArn: string
  readonly alarmArn: string
  readonly tableArn: string
  constructor(options: FisOptions) {
    assert.match(options.account, /^\d{12}$/)
    assert.match(options.runId, /^test-outage-[a-z0-9-]{8,40}$/)
    assert.match(options.tableName, /^[a-z][a-z0-9-]+-workflow$/)
    assert.notEqual(options.tableName, 'tanstack-ha-workflow')
    assert.ok(['us-east-1', 'us-west-2'].includes(options.failedRegion))
    assert.ok(['us-east-1', 'us-west-2'].includes(options.healthyRegion))
    assert.notEqual(options.failedRegion, options.healthyRegion)
    this.options = options
    this.roleName = options.runId
    this.alarmName = options.runId
    this.roleArn = `arn:aws:iam::${options.account}:role/${this.roleName}`
    this.alarmArn = `arn:aws:cloudwatch:${options.failedRegion}:${options.account}:alarm:${this.alarmName}`
    this.tableArn = `arn:aws:dynamodb:${options.failedRegion}:${options.account}:table/${options.tableName}`
  }
  private aws(region: string, args: string[]) { return this.options.aws(region, args) }
  private pause(ms: number) { return (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(ms) }
  private save() { return this.options.checkpoint() }
  async health(healthy: boolean) {
    const o = this.options
    await this.aws(o.failedRegion, ['cloudwatch', 'put-metric-data', '--namespace', 'RegionalOutageLab', '--metric-data', JSON.stringify([{
      MetricName: 'Healthy', Dimensions: [{ Name: 'RunId', Value: o.runId }], Value: healthy ? 1 : 0, Unit: 'Count', StorageResolution: 1,
    }])])
  }
  template() {
    return { description: this.options.runId, roleArn: this.roleArn,
      targets: { table: { resourceType: 'aws:dynamodb:global-table', resourceArns: [this.tableArn], selectionMode: 'ALL' } },
      actions: { isolate: { actionId: 'aws:dynamodb:global-table-pause-replication', parameters: { duration: 'PT15M' }, targets: { Tables: 'table' } } },
      stopConditions: [{ source: 'aws:cloudwatch:alarm', value: this.alarmArn }], tags: { RunId: this.options.runId },
    }
  }
  async prepare() {
    const o = this.options, s = o.state
    assert.ok(!s.roleMayExist && !s.alarmMayExist && !s.templateId, 'Prepare cannot overwrite existing resources')
    // IAM create rejects collisions; alarm put does not, so check explicitly before claiming ownership.
    const alarms = await this.aws(o.failedRegion, ['cloudwatch', 'describe-alarms', '--alarm-names', this.alarmName])
    assert.equal(alarms.MetricAlarms.length, 0, 'Alarm collision')
    try { await this.aws(o.failedRegion, ['iam', 'get-role', '--role-name', this.roleName]); throw new Error('Role collision') }
    catch (error) { if (!/NoSuchEntity/.test(String(error))) throw error }
    s.roleMayExist = true; await this.save()
    await this.aws(o.failedRegion, ['iam', 'create-role', '--role-name', this.roleName, '--assume-role-policy-document', JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'fis.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': o.account }, ArnLike: { 'aws:SourceArn': `arn:aws:fis:${o.failedRegion}:${o.account}:experiment/*` } } }] }), '--tags', `Key=RunId,Value=${o.runId}`])
    await this.aws(o.failedRegion, ['iam', 'put-role-policy', '--role-name', this.roleName, '--policy-name', o.runId, '--policy-document', JSON.stringify({ Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['dynamodb:PutResourcePolicy', 'dynamodb:DeleteResourcePolicy', 'dynamodb:GetResourcePolicy', 'dynamodb:DescribeTable'], Resource: [`arn:aws:dynamodb:*:${o.account}:table/${o.tableName}`, `arn:aws:dynamodb:*:${o.account}:table/${o.tableName}/*`] },
      // InjectError has no resource-level authorization (AWS MRSC FIS documentation).
      { Effect: 'Allow', Action: ['dynamodb:InjectError', 'tag:GetResources'], Resource: '*' },
      { Effect: 'Allow', Action: 'cloudwatch:DescribeAlarms', Resource: this.alarmArn },
    ] })])
    s.alarmMayExist = true; await this.save()
    await this.aws(o.failedRegion, ['cloudwatch', 'put-metric-alarm', '--alarm-name', this.alarmName, '--namespace', 'RegionalOutageLab', '--metric-name', 'Healthy', '--dimensions', `Name=RunId,Value=${o.runId}`, '--statistic', 'Minimum', '--period', '30', '--evaluation-periods', '2', '--datapoints-to-alarm', '2', '--threshold', '1', '--comparison-operator', 'LessThanThreshold', '--treat-missing-data', 'breaching', '--tags', `Key=RunId,Value=${o.runId}`])
    let ready = false
    for (let i = 0; i < 30; i++) {
      await this.health(true)
      const a = await this.aws(o.failedRegion, ['cloudwatch', 'describe-alarms', '--alarm-names', this.alarmName])
      if (a.MetricAlarms[0]?.StateValue === 'OK') { ready = true; break }
      await this.pause(5_000)
    }
    assert.ok(ready, 'Safety alarm did not become OK')
    s.createToken = `${o.runId}-template`; await this.save()
    const result = await this.aws(o.failedRegion, ['fis', 'create-experiment-template', '--client-token', s.createToken, '--cli-input-json', JSON.stringify(this.template())])
    s.templateId = result.experimentTemplate.id; await this.save()
  }
  async start() {
    const o = this.options, s = o.state
    assert.ok(s.templateId && !s.experimentId)
    s.startToken = `${o.runId}-start`; await this.save()
    for (let i = 0; i < 12; i++) {
      await this.health(true)
      try {
        const result = await this.aws(o.failedRegion, ['fis', 'start-experiment', '--experiment-template-id', s.templateId, '--client-token', s.startToken])
        s.experimentId = result.experiment.id; s.lastExperiment = result.experiment; await this.save(); return result.experiment
      } catch (error) {
        if (i === 11 || !/assum|propagat|not authorized/i.test(String(error))) throw error
        await this.pause(5_000)
      }
    }
  }
  async get() {
    const o = this.options
    assert.ok(o.state.experimentId)
    const result = await this.aws(o.failedRegion, ['fis', 'get-experiment', '--id', o.state.experimentId])
    o.state.lastExperiment = result.experiment; await this.save(); return result.experiment
  }
  async stop() {
    if (!this.options.state.experimentId) return
    if (terminal.has((await this.get()).state.status)) return
    await this.save()
    await this.aws(this.options.failedRegion, ['fis', 'stop-experiment', '--id', this.options.state.experimentId!])
    for (let i = 0; i < 60; i++) {
      if (terminal.has((await this.get()).state.status)) return
      await this.pause(5_000)
    }
    throw new Error('FIS is still active; retain IAM role and alarm for rollback')
  }
  async cleanup() {
    const o = this.options, s = o.state
    // Reconcile ambiguous creates using stable idempotency tokens before deleting safety resources.
    if (s.createToken && !s.templateId) {
      const r = await this.aws(o.failedRegion, ['fis', 'create-experiment-template', '--client-token', s.createToken, '--cli-input-json', JSON.stringify(this.template())])
      s.templateId = r.experimentTemplate.id; await this.save()
    }
    if (s.startToken && !s.experimentId) {
      const listed = await this.aws(o.failedRegion, ['fis', 'list-experiments'])
      const matching = listed.experiments.filter((e: any) => e.experimentTemplateId === s.templateId)
      assert.ok(matching.length <= 1, 'Multiple experiments for unique template; manual stop required')
      if (matching[0]) { s.experimentId = matching[0].id; await this.save() }
      else throw new Error('Ambiguous experiment start: retain safety resources and reconcile again; never start a fault during cleanup')
    }
    await this.stop()
    async function absentOk(fn: () => Promise<any>) { try { await fn() } catch (e) { if (!/NoSuchEntity|ResourceNotFoundException/.test(String(e))) throw e } }
    if (s.templateId) { await this.save(); await absentOk(() => this.aws(o.failedRegion, ['fis', 'delete-experiment-template', '--id', s.templateId!])); delete s.templateId; await this.save() }
    if (s.alarmMayExist) { await this.save(); await this.aws(o.failedRegion, ['cloudwatch', 'delete-alarms', '--alarm-names', this.alarmName]); s.alarmMayExist = false; await this.save() }
    if (s.roleMayExist) {
      await this.save()
      await absentOk(() => this.aws(o.failedRegion, ['iam', 'delete-role-policy', '--role-name', this.roleName, '--policy-name', o.runId]))
      await absentOk(() => this.aws(o.failedRegion, ['iam', 'delete-role', '--role-name', this.roleName]))
      s.roleMayExist = false; await this.save()
    }
    delete s.createToken; delete s.startToken; s.cleaned = true; await this.save()
  }
}
