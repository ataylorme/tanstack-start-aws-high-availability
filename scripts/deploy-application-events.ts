import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const prefix = process.env.STACK_PREFIX
if (!prefix || prefix === 'tanstack-ha' || !/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) {
  throw new Error('Application events require an explicit isolated STACK_PREFIX other than tanstack-ha (lowercase, max 40 characters)')
}
if (process.argv.slice(2).some((arg) => !['--execute', '--prepare'].includes(arg))) throw new Error('Supported: --execute --prepare')
const region = 'us-east-1' // One reader only: MRSC replication already delivers events from both writers.
const stack = `${prefix}-application-events`
if (!process.argv.includes('--execute')) {
  console.log(`Application-event deployment plan for ${prefix} (no AWS calls made):
1. Verify existing ${prefix}-workflow MRSC table and NEW_IMAGE or NEW_AND_OLD_IMAGES stream in ${region}.
2. Bundle the PR4 SQS consumer and upload a content-addressed ZIP to the existing bootstrap ArtifactBucket.
3. Deploy ${stack}: private Lambda, standard SQS destination, bounded stream retries, S3 failure archive and alarms.
4. Disable the legacy stream mapping (--prepare); after unified workers deploy, subscribe this retained queue to the east SNS FIFO topic. No west reader is created by this stack.
5. Update BOTH existing regional app stacks with queue URL and receive-only permission, preserving omitted image and secret parameters.
Run with --execute to create/update billable AWS resources. No resources are deleted.`)
  process.exit(0)
}
if (process.argv.includes('--execute') && (!/^\d{12}$/.test(process.env.EXPECTED_AWS_ACCOUNT_ID ?? '') || !process.env.AWS_PROFILE)) throw new Error('Execution requires EXPECTED_AWS_ACCOUNT_ID and AWS_PROFILE')
function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, AWS_PAGER: '' }, maxBuffer: 16 * 1024 * 1024,
  }).trim()
}
function aws(args: string[]): string { return run('aws', ['--region', region, ...args]) }
function output(stackName: string, key: string): string {
  const value = aws(['cloudformation', 'describe-stacks', '--stack-name', stackName,
    '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text'])
  if (!value || value === 'None') throw new Error(`Missing ${stackName} output ${key}`)
  return value
}
if (aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']) !== process.env.EXPECTED_AWS_ACCOUNT_ID) throw new Error('AWS account guard failed')
// Prepare both old workflow readers before the table switches stream view/ARN.
if (process.argv.includes('--prepare')) {
  for (const targetRegion of ['us-east-1', 'us-west-2']) {
    const uuid = run('aws', ['--region', targetRegion, 'cloudformation', 'describe-stacks', '--stack-name', `${prefix}-sweeper`, '--query', "Stacks[0].Outputs[?OutputKey=='StreamMappingId'].OutputValue | [0]", '--output', 'text'])
    if (!uuid || uuid === 'None') throw new Error('Missing existing workflow stream mapping')
    run('aws', ['--region', targetRegion, 'lambda', 'update-event-source-mapping', '--uuid', uuid, '--no-enabled'])
    const deadline = Date.now() + 180_000
    while (true) {
      const state = run('aws', ['--region', targetRegion, 'lambda', 'get-event-source-mapping', '--uuid', uuid, '--query', 'State', '--output', 'text'])
      if (state === 'Disabled') break
      if (Date.now() > deadline || !['Disabling', 'Updating'].includes(state)) throw new Error(`Cannot disable workflow mapping: ${state}`)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
}
const { Table: table } = JSON.parse(aws(['dynamodb', 'describe-table', '--table-name', `${prefix}-workflow`, '--output', 'json']))
if (table?.TableStatus !== 'ACTIVE' || table.MultiRegionConsistency !== 'STRONG' ||
    table.StreamSpecification?.StreamEnabled !== true || !['NEW_IMAGE', 'NEW_AND_OLD_IMAGES'].includes(table.StreamSpecification?.StreamViewType) ||
    typeof table.LatestStreamArn !== 'string' || !table.LatestStreamArn.includes(`:dynamodb:${region}:`)) {
  throw new Error('Expected an ACTIVE MRSC table with an enabled east NEW_IMAGE or NEW_AND_OLD_IMAGES stream')
}
const bucket = output(`${prefix}-bootstrap`, 'ArtifactBucket')
const work = mkdtempSync(resolve(tmpdir(), 'application-events-'))
try {
  // Use installed tools only; never let npx fetch an unpinned build dependency.
  run('node_modules/.bin/esbuild', ['src/events/consumer.ts', '--bundle', '--platform=node',
    '--target=node22', '--format=cjs', `--outfile=${resolve(work, 'handler.js')}`])
  const archive = resolve(work, 'consumer.zip')
  run('zip', ['-j', archive, resolve(work, 'handler.js')])
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
  const key = `application-events/${hash}.zip`
  aws(['s3', 'cp', archive, `s3://${bucket}/${key}`, '--only-show-errors'])
  console.log(aws(['cloudformation', 'deploy', '--stack-name', stack, '--template-file', 'infra/application-events.yaml',
    '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset', '--parameter-overrides',
    ...(process.argv.includes('--prepare') ? [`StreamArn=${table.LatestStreamArn}`] : []), `CodeBucket=${bucket}`, `CodeKey=${key}`, 'LegacyReaderEnabled=false',
    ...(process.argv.includes('--prepare') ? [] : [`ApplicationTopicArn=${output(`${prefix}-sweeper`, 'ApplicationTopicArn')}`])]))
  const uuid = output(stack, 'StreamMappingId')
  const deadline = Date.now() + 180_000
  while (true) {
    const mapping = JSON.parse(aws(['lambda', 'get-event-source-mapping', '--uuid', uuid, '--output', 'json']))
    if (mapping.State === 'Disabled') break
    if (!['Creating', 'Disabling', 'Updating'].includes(mapping.State) || Date.now() > deadline) {
      throw new Error(`Legacy stream mapping not Disabled: ${mapping.State}: ${mapping.StateTransitionReason ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  if (!process.argv.includes('--prepare')) {
  const queueUrl = output(stack, 'QueueUrl')
  const queueArn = output(stack, 'QueueArn')
  for (const appRegion of ['us-east-1', 'us-west-2']) {
    // Require an existing app stack. Never inspect/dump its secret parameters.
    run('aws', ['--region', appRegion, 'cloudformation', 'describe-stacks', '--stack-name', `${prefix}-app`,
      '--query', 'Stacks[0].StackStatus', '--output', 'text'])
    // CloudFormation deploy uses previous values for omitted existing parameters.
    console.log(run('aws', ['--region', appRegion, 'cloudformation', 'deploy', '--stack-name', `${prefix}-app`,
      '--template-file', 'infra/regional.yaml', '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset',
      '--parameter-overrides', `EventTestQueueUrl=${queueUrl}`, `EventTestQueueArn=${queueArn}`]))
  }
  console.log('Legacy stream reader disabled; retained observation queue configured in both regions.')
  } else console.log('All legacy readers disabled. Update the table stream and deploy unified workers, then attach observation subscription.')
} finally {
  rmSync(work, { recursive: true, force: true })
}
