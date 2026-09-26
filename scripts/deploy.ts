import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const regions = ['us-east-1', 'us-west-2'] as const
const prefix = process.env.STACK_PREFIX ?? 'tanstack-ha'
if (!/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) throw new Error('Invalid STACK_PREFIX (lowercase, max 40 characters)')
if (!process.argv.includes('--execute')) {
  console.log(`Deployment plan for ${prefix} (no AWS calls made):
1. Validate locally; create CloudFormation bootstrap stacks in both regions.
2. Build ONE linux/amd64 Docker image; push it to both regional ECR repositories.
3. Deploy digest-pinned regional Lambda stacks with the same origin secret.
4. Bundle typed Lambda@Edge routing code with the two Function URL domains.
5. Deploy the global stack in us-east-1; wait for CloudFront propagation.

Run node scripts/deploy.ts --execute to create/update billable AWS resources.
Requires Node 24+, AWS CLI v2 credentials, Docker buildx, zip, and npm ci.
No resources are deleted by this script.`)
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

function deploy(region: string, stack: string, template: string, parameters: Record<string, string> = {}): void {
  console.log(`Deploying ${stack} in ${region}`)
  const file = resolve(work, `${region}-${stack}-parameters.json`)
  // Parameter values (including secret) never appear in CLI arguments or logs.
  writeFileSync(file, JSON.stringify(Object.entries(parameters).map(([ParameterKey, ParameterValue]) =>
    ({ ParameterKey, ParameterValue }))), { mode: 0o600 })
  try {
    console.log(aws(region, ['cloudformation', 'deploy', '--stack-name', stack,
      '--template-file', template, '--capabilities', 'CAPABILITY_IAM',
      '--no-fail-on-empty-changeset', '--parameter-overrides', `file://${file}`]))
  } finally {
    rmSync(file)
  }
}

for (const region of regions) deploy(region, `${prefix}-bootstrap`, 'infra/bootstrap.yaml')
const release = `${run('git', ['rev-parse', '--short', 'HEAD'])}-${Date.now()}`
const image = `${prefix}:${release}`
// Lambda requires a single-architecture manifest, not a provenance/index manifest.
console.log(run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--provenance=false',
  '--sbom=false', '--load', '--tag', image, '.']))
const domains = new Map<string, string>()
for (const region of regions) {
  const repository = output(region, `${prefix}-bootstrap`, 'RepositoryUri')
  const repositoryName = output(region, `${prefix}-bootstrap`, 'RepositoryName')
  const registry = repository.split('/')[0]
  if (!registry) throw new Error('Invalid repository URI')
  const password = aws(region, ['ecr', 'get-login-password'])
  run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], password)
  run('docker', ['tag', image, `${repository}:${release}`])
  console.log(run('docker', ['push', `${repository}:${release}`]))
  const digest = aws(region, ['ecr', 'describe-images', '--repository-name', repositoryName,
    '--image-ids', `imageTag=${release}`, '--query', 'imageDetails[0].imageDigest', '--output', 'text'])
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid ECR digest')
  deploy(region, `${prefix}-app`, 'infra/regional.yaml', {
    ImageUri: `${repository}@${digest}`, OriginSecret: secret, ReleaseId: release,
    SimulateFailure: 'false',
  })
  domains.set(region, new URL(output(region, `${prefix}-app`, 'FunctionUrl')).hostname)
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
  ArtifactBucket: bucket, EdgeCodeKey: key, EdgeCodeSha256: hash.toString('base64'),
})
const distribution = output('us-east-1', `${prefix}-global`, 'DistributionId')
aws('us-east-1', ['cloudfront', 'wait', 'distribution-deployed', '--id', distribution])
const site = output('us-east-1', `${prefix}-global`, 'SiteUrl')
console.log(`Deployed ${site}. Verifying both preferred regions…`)
console.log(run('node', ['scripts/verify-deployment.ts', site]))
