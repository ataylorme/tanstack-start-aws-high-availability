import { assertSafeWakeupChange, type WakeupResourceChange } from './workflow-wakeup-changes.ts'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const prefix = process.env.STACK_PREFIX
if (!prefix || prefix === 'tanstack-ha' || !/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) {
  throw new Error('Workflow wakeups require an explicit isolated STACK_PREFIX other than tanstack-ha')
}
const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--execute' && !/^--legacy=(enabled|disabled|removed)$/.test(arg)) || args.filter((arg) => arg.startsWith('--legacy=')).length > 1) {
  throw new Error('Supported arguments: --execute --legacy=enabled|disabled|removed')
}
const legacy = args.find((arg) => arg.startsWith('--legacy='))?.split('=')[1] ?? 'removed'
if (!args.includes('--execute')) {
  console.log(`Workflow wakeup deployment plan (no AWS calls made):\nVerify existing ${prefix}-workflow and bootstrap/sweeper stacks in us-east-1 and us-west-2.\nRequire NEW_AND_OLD_IMAGES and disable the legacy application-event stream mapping first.\nBundle unified dispatcher, targeted worker, FIFO relay and ordered subscriber; upload content-addressed ZIPs. Save rollback evidence under ignored .deploy.\nPreview guarded CloudFormation change sets; deploy with legacy schedule ${legacy}.\nFor migration: --legacy=enabled, reconcile, --legacy=disabled, validate, then --legacy=removed.\nExecution requires EXPECTED_AWS_ACCOUNT_ID and AWS_PROFILE.`)
  process.exit(0)
}
if (!/^\d{12}$/.test(process.env.EXPECTED_AWS_ACCOUNT_ID ?? '') || !process.env.AWS_PROFILE) {
  throw new Error('Execution requires EXPECTED_AWS_ACCOUNT_ID and AWS_PROFILE')
}
function run(command: string, commandArgs: string[]): string {
  return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, AWS_PAGER: '' }, maxBuffer: 32 * 1024 * 1024 }).trim()
}
function aws(region: string, commandArgs: string[]): string { return run('aws', ['--region', region, ...commandArgs]) }
const account = aws('us-east-1', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'])
if (account !== process.env.EXPECTED_AWS_ACCOUNT_ID) throw new Error('AWS account guard failed')
// Refuse to save potentially sensitive deployment evidence unless Git ignores it.
run('git', ['check-ignore', '.deploy/workflow-wakeups/evidence.json'])
const evidence = resolve('.deploy/workflow-wakeups', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(evidence, { recursive: true, mode: 0o700 })
function save(name: string, data: unknown) { writeFileSync(resolve(evidence, name), JSON.stringify(data, null, 2), { mode: 0o600 }) }
const work = mkdtempSync(resolve(tmpdir(), 'workflow-wakeups-'))
try {
  run('node_modules/.bin/esbuild', ['src/workflows/dispatcher.ts', 'src/workflows/sweeper.ts', 'src/workflows/application-consumer.ts', 'src/events/ordered-subscriber.ts', '--bundle', '--platform=node', '--target=node22', '--format=cjs', '--entry-names=[name]', `--outdir=${work}`])
  const archive = resolve(work, 'wakeups.zip')
  // ZIP stores DOS local timestamps: fix both file times and zip's timezone.
  const fixedTime = new Date('2000-01-01T00:00:00Z')
  for (const name of ['dispatcher.js', 'sweeper.js', 'application-consumer.js', 'ordered-subscriber.js']) utimesSync(resolve(work, name), fixedTime, fixedTime)
  execFileSync('zip', ['-X', '-j', archive, resolve(work, 'dispatcher.js'), resolve(work, 'sweeper.js'), resolve(work, 'application-consumer.js'), resolve(work, 'ordered-subscriber.js')],
    { env: { ...process.env, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'inherit'] })
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
  const key = `workflow-wakeups/${hash}.zip`
  for (const region of ['us-east-1', 'us-west-2']) {
    const stack = `${prefix}-sweeper`
    const previous = JSON.parse(aws(region, ['cloudformation', 'describe-stacks', '--stack-name', stack, '--output', 'json'])).Stacks[0]
    const template = JSON.parse(aws(region, ['cloudformation', 'get-template', '--stack-name', stack, '--template-stage', 'Original', '--output', 'json']))
    // Sweeper parameters contain infrastructure identifiers only; never dump app stack secrets.
    const safeParameters = previous.Parameters.filter((p: { ParameterKey: string }) => ['TableName', 'CodeBucket', 'CodeKey', 'StreamArn', 'LegacyScheduleMode'].includes(p.ParameterKey))
    save(`${region}-rollback.json`, { template: template.TemplateBody, parameters: safeParameters })
    const { Table: table } = JSON.parse(aws(region, ['dynamodb', 'describe-table', '--table-name', `${prefix}-workflow`, '--output', 'json']))
    if (table.TableStatus !== 'ACTIVE' || table.MultiRegionConsistency !== 'STRONG' || !table.StreamSpecification?.StreamEnabled || table.StreamSpecification.StreamViewType !== 'NEW_AND_OLD_IMAGES' || !table.LatestStreamArn?.includes(`:dynamodb:${region}:`)) throw new Error('Expected ACTIVE MRSC table with regional NEW_AND_OLD_IMAGES stream')
    const bucket = aws(region, ['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-bootstrap`, '--query', "Stacks[0].Outputs[?OutputKey=='ArtifactBucket'].OutputValue | [0]", '--output', 'text'])
    if (!bucket || bucket === 'None') throw new Error('Missing regional ArtifactBucket')
    aws(region, ['s3', 'cp', archive, `s3://${bucket}/${key}`, '--only-show-errors'])
    const parameters = Object.entries({ TableName: table.TableName, StreamArn: table.LatestStreamArn, CodeBucket: bucket, CodeKey: key, LegacyScheduleMode: legacy }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }))
    save(`${region}-artifact.json`, { hash, key, bucket, parameters })
    const changeSet = `wakeups-${Date.now()}`
    aws(region, ['cloudformation', 'create-change-set', '--stack-name', stack, '--change-set-name', changeSet, '--change-set-type', 'UPDATE', '--template-body', 'file://infra/workflow-sweeper.yaml', '--capabilities', 'CAPABILITY_IAM', '--parameters', JSON.stringify(parameters)])
    let change: { Status: string; StatusReason?: string; Changes?: Array<{ ResourceChange: WakeupResourceChange }> }
    const deadline = Date.now() + 180_000
    do {
      change = JSON.parse(aws(region, ['cloudformation', 'describe-change-set', '--stack-name', stack, '--change-set-name', changeSet, '--output', 'json']))
      if (change.Status === 'CREATE_PENDING' || change.Status === 'CREATE_IN_PROGRESS') await new Promise((done) => setTimeout(done, 2_000))
      else break
    } while (Date.now() < deadline)
    save(`${region}-changeset.json`, change)
    if (change.Status === 'FAILED' && /didn.t contain changes|No updates/i.test(change.StatusReason ?? '')) {
      console.log(`${region}: no template changes; verifying live mappings`)
    } else {
      if (change.Status !== 'CREATE_COMPLETE') throw new Error(`Change set not ready: ${change.Status}`)
      for (const { ResourceChange: resource } of change.Changes ?? []) {
        if (resource.LogicalResourceId === 'StreamMapping' && resource.Action === 'Modify' && resource.Replacement === 'True') {
          // Stream view migration necessarily replaces the mapping. Never replace a
          // live reader: --prepare must have disabled it before changing the ARN.
          const oldId = previous.Outputs.find((item: { OutputKey: string }) => item.OutputKey === 'StreamMappingId')?.OutputValue
          if (!oldId) throw new Error('Missing old stream mapping evidence')
          const old = JSON.parse(aws(region, ['lambda', 'get-event-source-mapping', '--uuid', oldId, '--output', 'json']))
          if (old.State !== 'Disabled' || old.EventSourceArn === table.LatestStreamArn ||
              !resource.Details?.some(detail => detail.Target?.Name === 'EventSourceArn') ||
              !resource.Details?.every(detail => ['EventSourceArn', 'FilterCriteria'].includes(detail.Target?.Name ?? ''))) throw new Error('Stream replacement requires disabled old reader and only expected ARN/filter changes')
          save(`${region}-retired-mapping.json`, old)
        } else assertSafeWakeupChange(resource)
      }
      console.log(`${region}: reviewed ${change.Changes?.length ?? 0} changes; deploying legacy=${legacy}`)
      aws(region, ['cloudformation', 'execute-change-set', '--stack-name', stack, '--change-set-name', changeSet])
      aws(region, ['cloudformation', 'wait', 'stack-update-complete', '--stack-name', stack])
    }
    const deployed = JSON.parse(aws(region, ['cloudformation', 'describe-stacks', '--stack-name', stack, '--output', 'json'])).Stacks[0]
    save(`${region}-deployed.json`, { status: deployed.StackStatus, outputs: deployed.Outputs })
    for (const output of ['StreamMappingId', 'QueueMappingId', 'ApplicationMappingId', 'OrderedMappingId']) {
      const uuid = deployed.Outputs.find((item: { OutputKey: string }) => item.OutputKey === output)?.OutputValue
      if (!uuid) throw new Error(`Missing ${output}`)
      const mappingDeadline = Date.now() + 180_000
      while (true) {
        const mapping = JSON.parse(aws(region, ['lambda', 'get-event-source-mapping', '--uuid', uuid, '--output', 'json']))
        if (mapping.State === 'Enabled') break
        // A retried prepare can disable an unchanged mapping out-of-band. Only
        // restore the verified current stream; never revive the retired reader.
        if (output === 'StreamMappingId' && mapping.State === 'Disabled' && mapping.EventSourceArn === table.LatestStreamArn) {
          aws(region, ['lambda', 'update-event-source-mapping', '--uuid', uuid, '--enabled'])
          continue
        }
        if (!['Creating', 'Enabling', 'Updating'].includes(mapping.State) || Date.now() > mappingDeadline) throw new Error(`Mapping not enabled: ${output}: ${mapping.State}`)
        await new Promise((done) => setTimeout(done, 3_000))
      }
    }
  }
  console.log('Both regional stacks updated. Reconciliation and live validation are separate required cutover steps.')
} finally { rmSync(work, { recursive: true, force: true }) }
