import { publishImage } from './publish-image.ts'
import { viewerCode } from './viewer-code.ts'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const regions = ['us-east-1', 'us-west-2'] as const
const prefix = process.env.STACK_PREFIX ?? 'tanstack-ha'
if (!/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) throw new Error('Invalid STACK_PREFIX (lowercase, max 40 characters)')
const workflowMode = process.env.ENABLE_WORKFLOW_TESTS ?? 'false'
if (!['true', 'false'].includes(workflowMode)) throw new Error('Invalid ENABLE_WORKFLOW_TESTS')
const workflow = workflowMode === 'true'
if (workflow && (!process.env.STACK_PREFIX || prefix === 'tanstack-ha')) {
  throw new Error('Workflow tests require an explicit isolated STACK_PREFIX other than tanstack-ha')
}
const uploadMode = process.env.ECR_UPLOAD_MODE ?? 'docker'
if (!['docker', 'api'].includes(uploadMode)) throw new Error('Invalid ECR_UPLOAD_MODE (docker or api)')
if (!process.argv.includes('--execute')) {
  console.log(`Deployment plan for ${prefix} (no AWS calls made):
1. Validate locally; create CloudFormation bootstrap stacks in both regions.
2. Build ONE linux/amd64 Docker image; push it to both regional ECR repositories.
3. Deploy digest-pinned regional Lambda stacks with the same origin secret.
4. Bundle typed Lambda@Edge routing code with the two Function URL domains.
5. Deploy the global stack in us-east-1; wait for CloudFront propagation.

Run node scripts/deploy.ts --execute to create/update billable AWS resources.
Requires Node 24+, AWS CLI v2 credentials, Docker buildx, zip, npm ci, and NODE_AUTH_TOKEN with package read access.
No resources are deleted by this script.
${workflow ? 'Workflow tests enabled: deploy one MRSC table with east/west replicas and an Ohio witness, plus native sweepers in both regions.' : 'Workflow tests disabled.'}
ECR upload mode: ${uploadMode}.`)
  process.exit(0)
}

function run(command: string, args: string[], input?: string): string {
  return execFileSync(command, args, {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
    ...(input === undefined ? {} : { input }),
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '' },
  }).trim()
}
function aws(region: string, args: string[]): string {
  return run('aws', ['--region', region, ...args])
}
function output(region: string, stack: string, key: string): string {
  const value = aws(region, ['cloudformation', 'describe-stacks', '--stack-name', stack,
    '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text'])
  if (!value || value === 'None') throw new Error(`Missing ${stack} output ${key}`)
  return value
}

if (!process.env.NODE_AUTH_TOKEN?.trim()) throw new Error('NODE_AUTH_TOKEN with GitHub Packages read access is required')
run('docker', ['info'])
run('zip', ['-v'])
console.log(run('npm', ['run', 'check']))
console.log(run('npm', ['run', 'smoke']))
const account = aws('us-east-1', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'])
if (!/^\d{12}$/.test(account)) throw new Error('Expected commercial AWS account ID')
const work = resolve('.deploy', `${account}-${prefix}`)
mkdirSync(work, { recursive: true, mode: 0o700 })
chmodSync(work, 0o700)
const secretFile = resolve(work, 'origin-secret')
// Never silently rotate an existing deployment's key if local state was lost.
if (!existsSync(secretFile)) {
  for (const region of regions) {
    const names: unknown = JSON.parse(aws(region, ['cloudformation', 'list-stacks',
      '--query', "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName", '--output', 'json']))
    if (!Array.isArray(names)) throw new Error('Unexpected stack list')
    if (names.includes(`${prefix}-app`) || names.includes(`${prefix}-global`)) {
      throw new Error(`Restore ${secretFile} before updating existing stacks; refusing secret rotation`)
    }
  }
  writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 })
}
chmodSync(secretFile, 0o600)
const secret = readFileSync(secretFile, 'utf8').trim()
if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Origin secret must be 64 lowercase hex characters')

let workflowToken = ''
const workflowTable = `${prefix}-workflow`
if (workflow) {
  const tokenFile = resolve(work, 'workflow-test-token')
  if (!existsSync(tokenFile)) {
    for (const region of regions) {
      const names: unknown = JSON.parse(aws(region, ['cloudformation', 'list-stacks',
        '--query', "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName", '--output', 'json']))
      if (!Array.isArray(names)) throw new Error('Unexpected stack list')
      if (names.includes(`${prefix}-app`)) {
        throw new Error(`Restore ${tokenFile} before updating existing apps; refusing token rotation`)
      }
    }
    writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  chmodSync(tokenFile, 0o600)
  workflowToken = readFileSync(tokenFile, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(workflowToken)) throw new Error('Workflow test token must be 64 lowercase hex characters')
}

function deploy(region: string, stack: string, template: string, parameters: Record<string, string> = {}, roleArn?: string): void {
  console.log(`Deploying ${stack} in ${region}`)
  const file = resolve(work, `${region}-${stack}-parameters.json`)
  // Parameter values (including secret) never appear in CLI arguments or logs.
  writeFileSync(file, JSON.stringify(Object.entries(parameters).map(([ParameterKey, ParameterValue]) =>
    ({ ParameterKey, ParameterValue }))), { mode: 0o600 })
  try {
    console.log(aws(region, ['cloudformation', 'deploy', '--stack-name', stack,
      '--template-file', template, '--capabilities', 'CAPABILITY_IAM',
      '--no-fail-on-empty-changeset', '--parameter-overrides', `file://${file}`,
      ...(roleArn ? ['--role-arn', roleArn] : [])]))
  } finally {
    rmSync(file)
  }
}

for (const region of regions) deploy(region, `${prefix}-bootstrap`, 'infra/bootstrap.yaml')
if (workflow) {
  deploy('us-west-2', `${prefix}-workflow-deployer`, 'infra/workflow-deployer.yaml', { TableName: workflowTable })
  const tableRole = output('us-west-2', `${prefix}-workflow-deployer`, 'RoleArn')
  deploy('us-west-2', `${prefix}-workflow-table`, 'infra/workflow-table.yaml', { TableName: workflowTable }, tableRole)
  for (const region of regions) aws(region, ['dynamodb', 'wait', 'table-exists', '--table-name', workflowTable])
}
const release = `${run('git', ['rev-parse', '--short', 'HEAD'])}-${Date.now()}`
const image = `${prefix}:${release}`
// Lambda requires a single-architecture manifest, not a provenance/index manifest.
console.log(run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--provenance=false',
  '--sbom=false', '--load', '--secret', 'id=node_auth_token,env=NODE_AUTH_TOKEN', '--tag', image, '.']))
const archive = resolve(work, 'image.tar')
if (uploadMode === 'api') run('docker', ['save', '--output', archive, image])
let expectedDigest: string | undefined
const domains = new Map<string, string>()
for (const region of regions) {
  const repository = output(region, `${prefix}-bootstrap`, 'RepositoryUri')
  const repositoryName = output(region, `${prefix}-bootstrap`, 'RepositoryName')
  const registry = repository.split('/')[0]
  if (!registry) throw new Error('Invalid repository URI')
  const uploadedDigest = uploadMode === 'api'
    ? publishImage({ archive, work, region, repository: repositoryName, release, aws })
    : undefined
  if (uploadMode === 'docker') {
    const password = aws(region, ['ecr', 'get-login-password'])
    run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], password)
    run('docker', ['tag', image, `${repository}:${release}`])
    console.log(run('docker', ['push', `${repository}:${release}`]))
  }
  const digest = aws(region, ['ecr', 'describe-images', '--repository-name', repositoryName,
    '--image-ids', `imageTag=${release}`, '--query', 'imageDetails[0].imageDigest', '--output', 'text'])
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid ECR digest')
  if (uploadedDigest && digest !== uploadedDigest) throw new Error('Published manifest digest mismatch')
  if (expectedDigest && expectedDigest !== digest) throw new Error('Regional image digests differ')
  expectedDigest = digest
  deploy(region, `${prefix}-app`, 'infra/regional.yaml', {
    ImageUri: `${repository}@${digest}`, OriginSecret: secret, ReleaseId: release,
    SimulateFailure: 'false',
    ...(workflow ? { WorkflowTableName: workflowTable, WorkflowTestToken: workflowToken } : {}),
  })
  domains.set(region, new URL(output(region, `${prefix}-app`, 'FunctionUrl')).hostname)
}
if (workflow) {
  const sweeperZip = resolve(work, 'workflow-sweeper.zip')
  rmSync(sweeperZip, { force: true })
  run('zip', ['-j', '-X', sweeperZip, 'dist/sweeper/sweeper.js', 'dist/sweeper/dispatcher.js'])
  const sweeperHash = createHash('sha256').update(readFileSync(sweeperZip)).digest('hex')
  const sweeperKey = `workflow-sweeper/${sweeperHash}.zip`
  for (const region of regions) {
    const localBucket = output(region, `${prefix}-bootstrap`, 'ArtifactBucket')
    aws(region, ['s3', 'cp', sweeperZip, `s3://${localBucket}/${sweeperKey}`])
    const streamArn = aws(region, ['dynamodb', 'describe-table', '--table-name', workflowTable,
      '--query', 'Table.LatestStreamArn', '--output', 'text'])
    if (!streamArn.includes(`:dynamodb:${region}:`)) throw new Error('Missing regional workflow stream')
    const stacks: string[] = JSON.parse(aws(region, ['cloudformation', 'list-stacks',
      '--query', "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName", '--output', 'json']))
    // Ordinary app deployments must not accidentally cut over an existing legacy
    // stack before reconciliation. Dedicated deployment performs that migration.
    let legacy = 'removed'
    if (stacks.includes(`${prefix}-sweeper`)) {
      legacy = aws(region, ['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-sweeper`,
        '--query', "Stacks[0].Parameters[?ParameterKey=='LegacyScheduleMode'].ParameterValue | [0]", '--output', 'text'])
      if (legacy === 'None') legacy = 'enabled'
      if (!['enabled', 'disabled', 'removed'].includes(legacy)) throw new Error('Unexpected legacy schedule mode')
    }
    deploy(region, `${prefix}-sweeper`, 'infra/workflow-sweeper.yaml', {
      TableName: workflowTable, CodeBucket: localBucket, CodeKey: sweeperKey,
      StreamArn: streamArn, LegacyScheduleMode: legacy,
    })
  }
}
const eastDomain = domains.get('us-east-1')
const westDomain = domains.get('us-west-2')
if (!eastDomain || !westDomain) throw new Error('Both regional deployments must succeed')
writeFileSync('dist/edge/config.json', JSON.stringify({ eastDomain, westDomain }))
const zipFile = resolve(work, 'edge.zip')
rmSync(zipFile, { force: true })
run('zip', ['-j', '-X', zipFile, 'dist/edge/index.js', 'dist/edge/router.js', 'dist/edge/config.json'])
const zip = readFileSync(zipFile)
const hash = createHash('sha256').update(zip).digest()
const key = `edge/${hash.toString('hex')}.zip`
const bucket = output('us-east-1', `${prefix}-bootstrap`, 'ArtifactBucket')
aws('us-east-1', ['s3', 'cp', zipFile, `s3://${bucket}/${key}`])
deploy('us-east-1', `${prefix}-global`, 'infra/global.yaml', {
  EastDomain: eastDomain, WestDomain: westDomain, OriginSecret: secret,
  ViewerFunctionCode: viewerCode(),
  ArtifactBucket: bucket, EdgeCodeKey: key, EdgeCodeSha256: hash.toString('base64'),
})
const distribution = output('us-east-1', `${prefix}-global`, 'DistributionId')
aws('us-east-1', ['cloudfront', 'wait', 'distribution-deployed', '--id', distribution])
const site = output('us-east-1', `${prefix}-global`, 'SiteUrl')
console.log(`Deployed ${site}. Verifying both preferred regions…`)
console.log(run('node', ['scripts/verify-deployment.ts', site]))
