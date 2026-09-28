import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

// Read-only AWS calls: run existing verify-workflows.ts separately for live timer scenarios.
if (!process.argv.includes('--idle')) {
  console.log('Read-only idle verification: set isolated STACK_PREFIX and AWS_PROFILE, then pass --idle. Waits for wakeups to drain, observes 15 minutes, and checks invocation metrics. Run verify-workflows.ts separately for timer behavior.')
  process.exit(0)
}
const prefix = process.env.STACK_PREFIX
assert.ok(prefix && /^[a-z][a-z0-9-]{0,39}$/.test(prefix) && prefix !== 'tanstack-ha', 'Explicit isolated STACK_PREFIX required')
const regions = ['us-east-1', 'us-west-2']
function aws(region: string, args: string[]): any {
  return JSON.parse(execFileSync('aws', ['--region', region, ...args, '--output', 'json'], { encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' } }))
}
const targets = regions.map(region => {
  const stack = aws(region, ['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-sweeper`]).Stacks[0]
  const outputs = Object.fromEntries(stack.Outputs.map((entry: { OutputKey: string; OutputValue: string }) => [entry.OutputKey, entry.OutputValue]))
  for (const name of ['WorkerFunctionName', 'DispatcherFunctionName', 'WakeupQueueUrl', 'WakeupDLQUrl', 'SchedulerDLQUrl', 'ScheduleGroupName']) assert.ok(outputs[name], `Missing ${name} in ${region}`)
  return { region, outputs }
})
function drained(): boolean {
  let empty = true
  for (const { region, outputs } of targets) {
    for (const name of ['WakeupQueueUrl', 'WakeupDLQUrl', 'SchedulerDLQUrl']) {
      const attributes = aws(region, ['sqs', 'get-queue-attributes', '--queue-url', outputs[name], '--attribute-names', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesDelayed', 'ApproximateNumberOfMessagesNotVisible']).Attributes
      const count = Object.values(attributes).reduce<number>((sum, value) => sum + Number(value), 0)
      if (name !== 'WakeupQueueUrl') assert.equal(count, 0, `Failure queue is not empty in ${region}`)
      if (count !== 0) empty = false
    }
    const schedules = aws(region, ['scheduler', 'list-schedules', '--group-name', outputs.ScheduleGroupName]).Schedules
    if (schedules.length !== 0) empty = false
    const resources = aws(region, ['cloudformation', 'list-stack-resources', '--stack-name', `${prefix}-sweeper`]).StackResourceSummaries
    const alarmNames = resources.filter((entry: { ResourceType: string }) => entry.ResourceType === 'AWS::CloudWatch::Alarm').map((entry: { PhysicalResourceId: string }) => entry.PhysicalResourceId)
    if (alarmNames.length) {
      const alarms = aws(region, ['cloudwatch', 'describe-alarms', '--alarm-names', ...alarmNames]).MetricAlarms
      assert.ok(alarms.every((alarm: { StateValue: string }) => alarm.StateValue === 'OK'), `Wakeup alarms are not healthy in ${region}`)
    }
    for (const resource of resources.filter((entry: { ResourceType: string }) => entry.ResourceType === 'AWS::Events::Rule')) {
      const rule = aws(region, ['events', 'describe-rule', '--name', resource.PhysicalResourceId])
      assert.ok(!rule.ScheduleExpression || rule.State === 'DISABLED', `Recurring rule remains enabled in ${region}`)
    }
  }
  return empty
}
const drainDeadline = Date.now() + 15 * 60_000
while (!drained()) {
  assert.ok(Date.now() < drainDeadline, 'Wakeups did not drain within 15 minutes')
  await setTimeout(15_000)
}
// Start on a full CloudWatch minute so pre-observation invocations do not contaminate metrics.
await setTimeout(60_000 - Date.now() % 60_000)
const start = new Date()
console.log('Queues and schedules drained; observing 15 idle minutes. Do not submit work during this window.')
for (let minute = 0; minute < 15; minute++) {
  await setTimeout(60_000)
  assert.ok(drained(), 'New wakeup work appeared during the idle window')
}
const end = new Date()
// Lambda metrics may arrive late. Allow publication before querying the fixed observation window.
await setTimeout(3 * 60_000)
const metrics = targets.flatMap(({ region, outputs }) => ['WorkerFunctionName', 'DispatcherFunctionName'].map(name => {
  const result = aws(region, ['cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/Lambda', '--metric-name', 'Invocations', '--dimensions', `Name=FunctionName,Value=${outputs[name]}`, '--start-time', start.toISOString(), '--end-time', end.toISOString(), '--period', '60', '--statistics', 'Sum'])
  const invocations = result.Datapoints.reduce((sum: number, point: { Sum: number }) => sum + point.Sum, 0)
  return { region, role: name, invocations, datapoints: result.Datapoints }
}))
mkdirSync('.deploy', { recursive: true })
const report = `.deploy/workflow-idle-${Date.now()}.json`
writeFileSync(report, JSON.stringify({ start, end, metrics, queuesAndSchedulesDrained: true }, null, 2))
console.log(`Evidence: ${report}`)
assert.ok(metrics.every(metric => metric.invocations === 0), 'Unexpected idle invocations; inspect report')
console.log('PASS: zero worker/dispatcher invocations during 15 idle minutes')
