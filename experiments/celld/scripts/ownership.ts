import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { matchesFencingOutcome, planOperation, writeInput } from '../ownership/operator.ts'

import { verifyWriterPolicy } from '../ownership/writer-policy.ts'

// No activation, automatic renewal, promotion, batch writes, or blind retries.
const action = process.argv[2]
if (!['inspect', 'initialize-fencing', 'begin-fencing'].includes(action ?? '')) throw new Error('Usage: ownership.ts inspect|initialize-fencing|begin-fencing --shard=N [--transition=ID] [--execute]')
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const shard = Number(arg('shard'))
if (!Number.isInteger(shard) || shard < 0 || shard >= 64 || arg('shard') !== String(shard)) throw new Error('Explicit canonical --shard=0..63 required')
const profile = process.env.AWS_PROFILE
if (!profile) throw new Error('Explicit AWS_PROFILE required')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated experiment prefix')
const work = resolve('.deploy/celld', prefix)
const deployment = JSON.parse(readFileSync(resolve(work, 'deployment.json'), 'utf8'))
const identity = JSON.parse(readFileSync(resolve(work, 'identity.json'), 'utf8'))
const expectedTable = JSON.parse(readFileSync(resolve(work, 'directory-live-validation.json'), 'utf8'))
const replicaIdentities = JSON.parse(readFileSync(resolve(work, 'directory-identities.json'), 'utf8'))
const tableName = `${prefix}-ownership`
if (deployment.directoryName !== tableName || deployment.directoryWest !== 'us-west-2') throw new Error('Unexpected directory topology')
const region = arg('region') ?? 'us-east-1'
if (!['us-east-1', 'us-west-2'].includes(region)) throw new Error('Use a replica endpoint, never witness')
const shardId = `v1:${String(shard).padStart(2, '0')}`
let roleEnvironment: NodeJS.ProcessEnv | undefined
function aws(service: 'dynamodb' | 'sts' | 'cloudformation' | 'iam', operation: string, input: object) {
  const requestRegion = service === 'cloudformation' || service === 'iam' ? 'us-east-1' : region
  return JSON.parse(execFileSync('aws', [...(roleEnvironment ? [] : ['--profile', profile!]), '--region', requestRegion, '--endpoint-url', service === 'iam' ? 'https://iam.amazonaws.com' : `https://${service}.${requestRegion}.amazonaws.com`, service, operation, '--cli-input-json', JSON.stringify(input), '--output', 'json'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...(roleEnvironment ?? process.env), AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
  }) || '{}')
}
const caller = aws('sts', 'get-caller-identity', {})
if (!/^\d{12}$/.test(identity.Account) || caller.Account !== identity.Account || /:root$/.test(caller.Arn)) throw new Error('Profile does not match the deployed non-root account')
// Write flows must exchange the broad caller for the deployed one-shard role.
// STS credentials are held only in memory/child environment, never saved or logged.
let writerRoleArn: string | undefined
let writerPolicyPreflight: ReturnType<typeof verifyWriterPolicy> | undefined
if (action !== 'inspect' && process.argv.includes('--execute')) {
  const record = JSON.parse(readFileSync(resolve(work, 'us-east-1-ownership-writer-stack.json'), 'utf8'))
  const writer = JSON.parse(readFileSync(resolve(work, 'ownership-writer.json'), 'utf8'))
  const stack = aws('cloudformation', 'describe-stacks', { StackName: record.StackId }).Stacks[0]
  if (stack.StackId !== record.StackId || stack.StackName !== `${prefix}-ownership-writer` || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) throw new Error('Writer stack identity/state mismatch')
  const outputs = Object.fromEntries(stack.Outputs.map((value: any) => [value.OutputKey, value.OutputValue]))
  writerRoleArn = outputs.RoleArn
  if (writer.account !== identity.Account || writer.tableName !== tableName || writer.stackId !== stack.StackId || writer.shardId !== shardId || outputs.ShardId !== shardId
    || writer.roleArn !== writerRoleArn || !writerRoleArn?.startsWith(`arn:aws:iam::${identity.Account}:role/`)) throw new Error('Writer scope differs; no mutation')
  writerPolicyPreflight = verifyWriterPolicy(writer, (operation,input) => aws('iam',operation,input))
  const session = aws('sts', 'assume-role', { RoleArn: writerRoleArn, RoleSessionName: `celld-metadata-${randomUUID()}`, DurationSeconds: 900 })
  const credentials = session.Credentials
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) throw new Error('Missing temporary writer credentials')
  roleEnvironment = { ...process.env, AWS_PROFILE: undefined, AWS_DEFAULT_PROFILE: undefined, AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken, AWS_SECURITY_TOKEN: undefined }
  const assumed = aws('sts', 'get-caller-identity', {})
  if (assumed.Account !== identity.Account || !assumed.Arn.startsWith(`arn:aws:sts::${identity.Account}:assumed-role/${writerRoleArn.split('/').at(-1)}/`)) throw new Error('Unexpected assumed writer identity')
}
const table = aws('dynamodb', 'describe-table', { TableName: tableName }).Table
// Each regional replica has its own immutable table ID, captured at deployment.
const expectedArn = `arn:aws:dynamodb:${region}:${identity.Account}:table/${tableName}`
if (table?.TableArn !== expectedArn || expectedTable.TableArn !== `arn:aws:dynamodb:us-east-1:${identity.Account}:table/${tableName}`
  || !replicaIdentities[region]?.tableId || table.TableId !== replicaIdentities[region].tableId || table.TableArn !== replicaIdentities[region].tableArn
  || table.MultiRegionConsistency !== 'STRONG' || table.TableStatus !== 'ACTIVE') throw new Error('Live table identity/consistency does not match deployment evidence')
function read() {
  const result = aws('dynamodb', 'get-item', { TableName: tableName, Key: { shardId: { S: shardId } }, ConsistentRead: true })
  if (!result.Item) return undefined
  return Object.fromEntries(Object.entries(result.Item).map(([key, value]: [string, any]) => [key, value.S ?? (value.N !== undefined ? Number(value.N) : undefined)]))
}
const attempt = randomUUID()
const evidenceFile = resolve(work, `ownership-${shard}-${attempt}.json`)
const evidence: Record<string, unknown> = { attempt, action, shardId, writerRoleArn, writerPolicyPreflight, tableArn: table.TableArn, tableId: table.TableId, region, observedAt: new Date().toISOString() }
const save = () => writeFileSync(evidenceFile, JSON.stringify(evidence), { mode: 0o600 })
const observed = read()
evidence.before = observed
if (action === 'inspect') {
  evidence.outcome = 'INSPECTED'; save()
  console.log(`Strong read saved locally. Shard ${shardId}: ${observed ? 'metadata present' : 'absent'}. No runtime fencing claim.`)
  process.exit(0)
}
const started = performance.now()
const command = planOperation({ action: action as 'initialize-fencing' | 'begin-fencing', shardId, homeRegion: arg('home') ?? 'us-east-1', transitionId: arg('transition') ?? '' }, observed, { now: Date.now(), expectedShard: shard, regions: ['us-east-1', 'us-west-2'] })
const input = writeInput(tableName, command)
evidence.command = command
if (!process.argv.includes('--execute')) {
  evidence.outcome = 'PLAN_ONLY'; save()
  console.log(`PLAN ONLY: ${action} on ${shardId}; no writes. No runtime fence or promotion. Explicit --execute required.`)
  process.exit(0)
}
evidence.outcome = 'UNKNOWN'; evidence.submittedAt = new Date().toISOString(); save()
if (performance.now() - started > 1000) throw new Error('Stale command; reread and replan, do not replay')
try { aws('dynamodb', command.operation === 'put' ? 'put-item' : 'update-item', input) }
catch (error) { evidence.submissionReportedFailure = true; evidence.submissionError = String(error); save() }
// Preserve UNKNOWN even when the reconciliation read also fails. NEVER write retry.
let after: unknown
try { after = read() } catch (error) { evidence.reconciliationError = String(error); save(); throw new Error('UNKNOWN outcome saved locally. Reread; no retry was performed.') }
evidence.after = after
const confirmed = matchesFencingOutcome(command, after)
evidence.outcome = confirmed ? 'CONFIRMED_FENCING' : 'NOT_CONFIRMED'; evidence.reconciledAt = new Date().toISOString(); save()
if (!confirmed) throw new Error('Metadata outcome not confirmed; inspect local evidence and reread. No retry was performed.')
console.log(`Confirmed FENCING metadata for ${shardId}. Stateful routing stays closed. Existing celld work is NOT fenced by this command.`)
