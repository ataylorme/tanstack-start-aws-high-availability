import { publishImage } from './publish-image.ts'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const prefix = 'devops-orchestration-poc'
const region = 'us-east-1'
const account = '963564733329'
const args = process.argv.slice(2)
if (args.some(arg => arg !== '--execute')) throw new Error('Supported argument: --execute')
if (!args.includes('--execute')) {
  console.log(`Plan only: no AWS calls made. Deploy isolated ${prefix}-bootstrap and ${prefix} in ${region}, account ${account}. Build one digest-pinned image for six roles, preview guarded change sets, preserve existing resources. Execution requires AWS_PROFILE=ataylorme EXPECTED_AWS_ACCOUNT_ID=${account} AWS_REGION=${region}. Credentials and evidence remain in ignored .deploy/${prefix}.`)
  process.exit(0)
}
if (process.env.AWS_PROFILE !== 'ataylorme' || process.env.EXPECTED_AWS_ACCOUNT_ID !== account || process.env.AWS_REGION !== region) throw new Error('Execution requires AWS_PROFILE=ataylorme EXPECTED_AWS_ACCOUNT_ID=963564733329 AWS_REGION=us-east-1')
function run(command: string, args: string[], input?: string): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...(input === undefined ? {} : { input }), env: { ...process.env, AWS_PAGER: '' }, maxBuffer: 32 * 1024 * 1024 }).trim()
}
function aws(args: string[]): string { return run('aws', ['--profile', 'ataylorme', '--region', region, ...args]) }
if (aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']) !== account) throw new Error('AWS account guard failed')
const limits = JSON.parse(aws(['lambda', 'get-account-settings', '--output', 'json'])) as { AccountLimit: { UnreservedConcurrentExecutions: number } }
if (limits.AccountLimit.UnreservedConcurrentExecutions < 106) throw new Error('At least 106 unreserved concurrency required for POC safety')
run('git', ['check-ignore', `.deploy/${prefix}/credentials.json`])
const directory = resolve('.deploy', prefix)
mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700)
function save(name: string, value: unknown): string {
  const path = resolve(directory, name)
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 }); chmodSync(path, 0o600)
  return path
}
interface Stack { StackName: string; StackStatus: string; Outputs?: Array<{ OutputKey: string; OutputValue: string }>; Tags?: Array<{ Key: string; Value: string }> }
function findStack(name: string): Stack | undefined {
  const result = JSON.parse(aws(['cloudformation', 'describe-stacks', '--output', 'json'])) as { Stacks: Stack[] }
  return result.Stacks.find(stack => stack.StackName === name)
}
interface ChangeSet { Status: string; StatusReason?: string; Changes?: Array<{ ResourceChange: { Action: string; Replacement?: string; LogicalResourceId: string } }> }
async function deploy(name: string, template: string, parameters: Record<string, string>): Promise<Stack> {
  const old = findStack(name)
  if (old && old.StackStatus !== 'REVIEW_IN_PROGRESS' && !old.Tags?.some(tag => tag.Key === 'Project' && tag.Value === prefix)) throw new Error(`Refusing unowned stack ${name}`)
  if (old && old.StackStatus !== 'REVIEW_IN_PROGRESS') {
    save(`${name}-previous-template.json`, JSON.parse(aws(['cloudformation', 'get-template', '--stack-name', name, '--output', 'json'])))
  }
  const kind = !old || old.StackStatus === 'REVIEW_IN_PROGRESS' ? 'CREATE' : 'UPDATE'
  const parameterFile = save(`${name}-parameters.json`, Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })))
  const changeName = `poc-${Date.now()}`
  aws(['cloudformation', 'create-change-set', '--stack-name', name, '--change-set-name', changeName, '--change-set-type', kind, '--template-body', `file://${template}`, '--capabilities', 'CAPABILITY_IAM', '--tags', `Key=Project,Value=${prefix}`, '--parameters', `file://${parameterFile}`])
  let change: ChangeSet = { Status: 'CREATE_PENDING' }
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    change = JSON.parse(aws(['cloudformation', 'describe-change-set', '--stack-name', name, '--change-set-name', changeName, '--output', 'json'])) as ChangeSet
    if (!['CREATE_PENDING', 'CREATE_IN_PROGRESS'].includes(change.Status)) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  save(`${name}-changeset.json`, change)
  if (change.Status === 'FAILED' && /didn.t contain changes|No updates/i.test(change.StatusReason ?? '') && old) return old
  if (change.Status !== 'CREATE_COMPLETE') throw new Error(`Change set failed: ${change.StatusReason ?? change.Status}`)
  for (const { ResourceChange: resource } of change.Changes ?? []) {
    if (kind === 'UPDATE' && (resource.Action === 'Remove' || (resource.Replacement && resource.Replacement !== 'False'))) throw new Error(`Unsafe change refused: ${resource.LogicalResourceId}`)
  }
  console.log(`${name}: reviewed ${change.Changes?.length ?? 0} non-destructive changes`)
  aws(['cloudformation', 'execute-change-set', '--stack-name', name, '--change-set-name', changeName])
  aws(['cloudformation', 'wait', kind === 'CREATE' ? 'stack-create-complete' : 'stack-update-complete', '--stack-name', name])
  const stack = findStack(name)
  if (!stack) throw new Error('Deployed stack missing')
  save(`${name}-outputs.json`, stack.Outputs)
  return stack
}
const credentialPath = resolve(directory, 'credentials.json')
if (!existsSync(credentialPath) && findStack(prefix)) throw new Error('Existing application stack requires its original local credentials; refusing credential regeneration')
const credentials = existsSync(credentialPath)
  ? JSON.parse(readFileSync(credentialPath, 'utf8')) as { requester: string; approver: string }
  : { requester: randomBytes(32).toString('hex'), approver: randomBytes(32).toString('hex') }
if (!/^[a-f0-9]{64}$/.test(credentials.requester) || !/^[a-f0-9]{64}$/.test(credentials.approver) || credentials.requester === credentials.approver) throw new Error('Invalid stored credentials')
save('credentials.json', credentials)
// All local validation must pass before creating or updating AWS resources.
execFileSync('npm', ['run', 'check'], { stdio: 'inherit' })
execFileSync('npm', ['run', 'smoke'], { stdio: 'inherit' })
const bootstrap = await deploy(`${prefix}-bootstrap`, 'infra/orchestration-bootstrap.yaml', {})
const repository = bootstrap.Outputs?.find(output => output.OutputKey === 'RepositoryUri')?.OutputValue
if (!repository?.startsWith(`${account}.dkr.ecr.${region}.amazonaws.com/${prefix}`)) throw new Error('Unexpected ECR repository')
const tag = `poc-${Date.now()}`
let imageUri = process.env.POC_IMAGE_URI ?? ''
if (imageUri) {
  if (!imageUri.startsWith(`${repository}@sha256:`) || !/^sha256:[a-f0-9]{64}$/.test(imageUri.split('@')[1] ?? '')) throw new Error('POC_IMAGE_URI must be an immutable digest in this POC repository')
} else {
const token = process.env.NODE_AUTH_TOKEN || run('gh', ['auth', 'token'])
if (!token) throw new Error('NODE_AUTH_TOKEN or gh auth required for package install')
const image = `${repository}:${tag}`
// BuildKit receives the package token through an environment-backed secret, never an ARG or log.
execFileSync('docker', ['buildx', 'build', '--provenance=false', '--sbom=false', '--load', '--platform', 'linux/amd64', '--secret', 'id=node_auth_token,env=NODE_AUTH_TOKEN', '-t', image, '.'], { stdio: 'inherit', env: { ...process.env, NODE_AUTH_TOKEN: token } })
const password = aws(['ecr', 'get-login-password'])
run('docker', ['login', '--username', 'AWS', '--password-stdin', `${account}.dkr.ecr.${region}.amazonaws.com`], password)
if (process.env.ECR_UPLOAD_MODE === 'api') {
  const archive = resolve(directory, 'image.tar')
  run('docker', ['save', '--output', archive, image])
  publishImage({ archive, work: directory, region, repository: prefix, release: tag, aws: (_region, args) => aws(args) })
} else run('docker', ['push', image])
const digest = aws(['ecr', 'describe-images', '--repository-name', prefix, '--image-ids', `imageTag=${tag}`, '--query', 'imageDetails[0].imageDigest', '--output', 'text'])
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Missing immutable image digest')
imageUri = `${repository}@${digest}`

}
save('image.json', { imageUri, tag, source: run('git', ['rev-parse', 'HEAD']) })
const stack = await deploy(prefix, 'infra/orchestration-poc.yaml', { ImageUri: imageUri, RequesterToken: credentials.requester, ApproverToken: credentials.approver })
for (const role of ['http', 'router', 'worker', 'executor', 'relay', 'sandbox']) {
  const deployed = aws(['lambda', 'get-function', '--function-name', `${prefix}-${role}`, '--query', 'Code.ResolvedImageUri', '--output', 'text'])
  if (deployed !== imageUri) throw new Error(`Image mismatch for ${role}`)
}
console.log(`Verified six identical image digests. URL: ${stack.Outputs?.find(output => output.OutputKey === 'Url')?.OutputValue}. Credentials: ${credentialPath} (not printed).`)
