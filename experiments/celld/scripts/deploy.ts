import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const execute = process.argv.includes('--execute')
const eastOnly = process.argv.includes('--east-only')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Use an isolated tanstack-celld-* prefix')
if (!execute) {
  console.log(`Plan only; no AWS calls.\n1. Build and test the independent celld experiment.\n2. Create regional two-AZ EC2/ALB/storage stacks.\n3. Publish compatible celld artifacts (east primary; west disabled).\n4. Create supported MRSC directory after explicit topology selection.\n5. Deploy read-only Lambda@Edge and CloudFront with stateful caching disabled.\n\nRequires AWS_PROFILE, DIRECTORY_WEST_REGION, and CELLD_WEST_REGION explicitly.\nThe original us-west-1 directory topology is unsupported. No writable promotion\nis implemented. Directory entries are not fabricated automatically: stateful\ningress fails closed until the ownership controller initializes valid entries.\nUse --east-only --execute for the independent eastern prerequisite without selecting\nthe western topology. Run --execute only for the isolated authorized experiment. Resources are billable.`)
  process.exit(0)
}
if (!process.env.AWS_PROFILE) throw new Error('AWS_PROFILE is required')
const directoryWest = process.env.DIRECTORY_WEST_REGION
const fleetWest = process.env.CELLD_WEST_REGION
if (!eastOnly && directoryWest !== 'us-west-2') throw new Error('Explicit DIRECTORY_WEST_REGION=us-west-2 required after topology approval; us-west-1 MRSC is unsupported')
if (!eastOnly && fleetWest !== 'us-west-1' && fleetWest !== 'us-west-2') throw new Error('Explicit CELLD_WEST_REGION is required after topology decision')
const regions: string[] = eastOnly ? ['us-east-1'] : ['us-east-1', fleetWest!]
const work = resolve('.deploy/celld', prefix)
mkdirSync(work, { recursive: true, mode: 0o700 }); chmodSync(work, 0o700)
function run(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync(command, args, { encoding: 'utf8', env: { ...process.env, AWS_PAGER: '', PATH: `${resolve('node_modules/.bin')}:${process.env.PATH}`, ...extraEnv }, maxBuffer: 32 * 1024 * 1024 }).trim()
}
function aws(region: string, args: string[]): any {
  return JSON.parse(run('aws', ['--region', region, ...args, '--output', 'json']) || '{}')
}
const identity = aws('us-east-1', ['sts', 'get-caller-identity'])
if (!/^\d{12}$/.test(identity.Account) || /:root$/.test(identity.Arn)) throw new Error('Expected a non-root sandbox principal')
writeFileSync(resolve(work, 'identity.json'), JSON.stringify(identity), { mode: 0o600 })
// Validate every selected template before ANY resource-creating command.
for (const template of eastOnly ? ['regional'] : ['regional', 'directory-deployer', 'directory', 'global']) {
  const validation = aws('us-east-1', ['cloudformation', 'validate-template', '--template-body', `file://${resolve('experiments/celld/infra', template + '.yaml')}`])
  writeFileSync(resolve(work, `${template}-validation.json`), JSON.stringify(validation), { mode: 0o600 })
}

const originFile = resolve(work, 'origin-secret')
const tokenFile = resolve(work, 'lab-token')
if (!existsSync(originFile) || !existsSync(tokenFile)) {
  for (const region of regions) {
    const stacks = aws(region, ['cloudformation', 'list-stacks']).StackSummaries
    if (stacks.some((stack: any) => stack.StackName.startsWith(prefix) && stack.StackStatus !== 'DELETE_COMPLETE')) throw new Error('Existing experiment found; restore local secrets rather than rotating them')
  }
  writeFileSync(originFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 })
}
const secret = readFileSync(originFile, 'utf8').trim()
const labToken = readFileSync(tokenFile, 'utf8').trim()
if (![secret, labToken].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error('Invalid local secret files')
function deploy(region: string, suffix: string, template: string, values: Record<string, string>, executionRole?: string) {
  const params = resolve(work, `${region}-${suffix}-parameters.json`)
  writeFileSync(params, JSON.stringify(Object.entries(values).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }))), { mode: 0o600 })
  const output = run('aws', ['--region', region, 'cloudformation', 'deploy', '--stack-name', `${prefix}-${suffix}`, '--template-file', template,
    '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset', '--parameter-overrides', `file://${params}`, ...(executionRole ? ['--role-arn', executionRole] : [])])
  writeFileSync(resolve(work, `${region}-${suffix}-deployment.log`), output, { mode: 0o600 })
  const stack = aws(region, ['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-${suffix}`]).Stacks[0]
  writeFileSync(resolve(work, `${region}-${suffix}-stack.json`), JSON.stringify(stack), { mode: 0o600 })
  return Object.fromEntries(stack.Outputs.map((entry: any) => [entry.OutputKey, entry.OutputValue])) as Record<string, string>
}
console.log(run('npx', ['vite', 'build', '--config', 'experiments/celld/vite.config.ts', 'experiments/celld']))
console.log(run('npm', ['run', 'typecheck']))
console.log(run('npm', ['test']))
console.log(run('node', ['experiments/celld/scripts/check-privacy.ts']))
console.log(run('npx', ['tsc', '-p', 'experiments/celld/tsconfig.json', '--noEmit']))
const binary = resolve('.omx/local/celld-bin/celld')
if (!existsSync(binary) || !run(binary, ['--version']).endsWith('celld 0.6.2')) throw new Error('Install pinned celld first with scripts/install.ts')
async function waitForFleet(region: string, targetGroup: string): Promise<void> {
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    const targets = aws(region, ['elbv2', 'describe-target-health', '--target-group-arn', targetGroup]).TargetHealthDescriptions
    const healthy = targets.filter((target: any) => target.TargetHealth.State === 'healthy').map((target: any) => target.Target.Id)
    if (healthy.length >= 2) {
      const reservations = aws(region, ['ec2', 'describe-instances', '--instance-ids', ...healthy]).Reservations
      const zones = new Set(reservations.flatMap((reservation: any) => reservation.Instances.map((instance: any) => instance.Placement.AvailabilityZone)))
      if (zones.size >= 2) {
        writeFileSync(resolve(work, `${region}-readiness.json`), JSON.stringify({ observedAt: new Date().toISOString(), healthyNodes: healthy, availabilityZones: [...zones] }), { mode: 0o600 })
        console.log(`Validated at least two healthy celld nodes across two AZs in ${region}.`)
        return
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
  throw new Error('Fleet did not become healthy across two AZs; inspect ignored deployment logs/SSM before continuing')
}
const origins: Record<string, string> = {}
const buckets: Record<string, string> = {}
const regionalOutputs: Record<string, Record<string, string>> = {}
const prefixLists: Record<string, string> = {}
for (const region of regions) {
  const lists = aws(region, ['ec2', 'describe-managed-prefix-lists', '--filters', 'Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing']).PrefixLists
  if (lists.length !== 1) throw new Error('Missing CloudFront origin-facing prefix list')
  prefixLists[region] = lists[0].PrefixListId
  console.log(`Deploying isolated regional stack in ${region}; details saved locally.`)
  const output = deploy(region, 'regional', 'experiments/celld/infra/regional.yaml', { CloudFrontPrefixListId: lists[0].PrefixListId, OriginSecret: secret, FleetPrefix: 'fleet' })
  regionalOutputs[region] = output
  origins[region] = output.AlbDnsName!
  buckets[region] = output.BucketName!
  const project = resolve(work, region, 'project')
  mkdirSync(project, { recursive: true, mode: 0o700 })
  for (const directory of ['runtime', 'dist']) cpSync(resolve('experiments/celld', directory), resolve(project, directory), { recursive: true })
  const config = JSON.parse(readFileSync('experiments/celld/wrangler.jsonc', 'utf8'))
  config.vars = { REGION_MODE: region === 'us-east-1' ? 'primary' : 'disabled', LAB_TOKEN: labToken, ORIGIN_SECRET: secret, DEPLOYMENT_TYPE: 'aws' }
  writeFileSync(resolve(project, 'wrangler.jsonc'), JSON.stringify(config), { mode: 0o600 })
  // AWS CLI login-session credentials may not be supported by celld's Rust SDK.
  // Export short-lived credentials into this child process only; never persist.
  const credentials = JSON.parse(run('aws', ['configure', 'export-credentials', '--format', 'process']))
  if (!credentials.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) throw new Error('Expected temporary profile credentials')
  const result = run(binary, ['deploy', project, '--bucket', `s3://${buckets[region]}/fleet`, '--region', region], {
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken,
  })
  writeFileSync(resolve(work, `${region}-celld-deploy.log`), result, { mode: 0o600 })
  await waitForFleet(region, output.TargetGroupArn!)
}
if (eastOnly) {
  writeFileSync(resolve(work, 'east-deployment.json'), JSON.stringify({ regions, origins, buckets }), { mode: 0o600 })
  console.log('Eastern fleet deployed; western topology and global routing were not selected or deployed. Runtime health validation is still required.')
  process.exit(0)
}
// Replication is configured only after destination creation. Replicated data and
// source lease records go to a quarantine bucket that no serving node can access.
const sourceOutput = regionalOutputs['us-east-1']!
const destinationOutput = regionalOutputs[fleetWest!]!
if (sourceOutput.BucketName !== buckets['us-east-1'] || !destinationOutput.ArchiveBucketArn) throw new Error('Invalid source/destination stack outputs')
for (const [region, name] of [['us-east-1', sourceOutput.BucketName!], [fleetWest!, destinationOutput.ArchiveBucketName!]] as const) {
  const versioning = aws(region, ['s3api', 'get-bucket-versioning', '--bucket', name!])
  if (versioning.Status !== 'Enabled') throw new Error('Both replication buckets must be versioned')
}
deploy(fleetWest!, 'regional', 'experiments/celld/infra/regional.yaml', {
  CloudFrontPrefixListId: prefixLists[fleetWest!]!, OriginSecret: secret, FleetPrefix: 'fleet',
  ArchiveSourceBucketName: sourceOutput.BucketName!,
})
deploy('us-east-1', 'regional', 'experiments/celld/infra/regional.yaml', {
  CloudFrontPrefixListId: prefixLists['us-east-1']!, OriginSecret: secret, FleetPrefix: 'fleet',
  ReplicationSourceBucketName: sourceOutput.BucketName!, ReplicationDestinationArn: destinationOutput.ArchiveBucketArn!,
})
writeFileSync(resolve(work, 'replication.json'), JSON.stringify({ source: sourceOutput.BucketName, destination: destinationOutput.ArchiveBucketName, destinationRegion: fleetWest, activeServingPrefix: 'fleet', archiveOnly: true, existingObjectsAutomaticallyBackfilled: false }), { mode: 0o600 })
const directoryName = `${prefix}-ownership`
const directoryDeployer = deploy('us-east-1', 'directory-deployer', 'experiments/celld/infra/directory-deployer.yaml', { TableName: directoryName })
deploy('us-east-1', 'directory', 'experiments/celld/infra/directory.yaml', { TableName: directoryName, WesternReplicaRegion: directoryWest! }, directoryDeployer.RoleArn!)
const directoryTable = aws('us-east-1', ['dynamodb', 'describe-table', '--table-name', directoryName]).Table
if (directoryTable.MultiRegionConsistency !== 'STRONG' || directoryTable.TableStatus !== 'ACTIVE'
  || !directoryTable.Replicas?.some((replica: any) => replica.RegionName === directoryWest && replica.ReplicaStatus === 'ACTIVE')
  || !directoryTable.GlobalTableWitnesses?.some((witness: any) => witness.RegionName === 'us-east-2' && witness.WitnessStatus === 'ACTIVE')) throw new Error('Live MRSC topology is not healthy; do not start global ingress')
writeFileSync(resolve(work, 'directory-live-validation.json'), JSON.stringify(directoryTable), { mode: 0o600 })
const directoryIdentities = Object.fromEntries(['us-east-1', directoryWest!].map(region => {
  const table = region === 'us-east-1' ? directoryTable : aws(region, ['dynamodb', 'describe-table', '--table-name', directoryName]).Table
  if (table.TableStatus !== 'ACTIVE' || table.MultiRegionConsistency !== 'STRONG' || !table.TableId
    || table.TableArn !== `arn:aws:dynamodb:${region}:${identity.Account}:table/${directoryName}`) throw new Error('Unexpected directory replica identity')
  return [region, { tableArn: table.TableArn, tableId: table.TableId }]
}))
writeFileSync(resolve(work, 'directory-identities.json'), JSON.stringify(directoryIdentities), { mode: 0o600 })
const edgeDir = resolve(work, 'edge'); mkdirSync(edgeDir, { recursive: true })
const entry = resolve(edgeDir, 'entry.ts')
writeFileSync(entry, `import {Directory} from ${JSON.stringify(resolve('experiments/celld/routing/directory.ts'))};\nimport {createRouter} from ${JSON.stringify(resolve('experiments/celld/routing/router.ts'))};\nimport {createAwsReader} from ${JSON.stringify(resolve('experiments/celld/routing/aws-reader.js'))};\nconst endpoints=${JSON.stringify(['us-east-1', directoryWest])};\nexport const handler=createRouter(${JSON.stringify({ primaryRegion: 'us-east-1', origins })},new Directory({endpoints,ownerRegions:${JSON.stringify(regions)},cacheMs:250,timeoutMs:750},createAwsReader(${JSON.stringify(directoryName)},endpoints)));\n`, { mode: 0o600 })
run('node_modules/.bin/esbuild', [entry, '--bundle', '--platform=node', '--target=node24', '--format=cjs', '--external:@aws-sdk/*', `--outfile=${resolve(edgeDir, 'index.js')}`])
const archive = resolve(edgeDir, 'edge.zip')
run('zip', ['-j', '-q', archive, resolve(edgeDir, 'index.js')])
const contents = readFileSync(archive)
const hex = createHash('sha256').update(contents).digest('hex')
const key = `artifacts/edge-${hex}.zip`
run('aws', ['--region', 'us-east-1', 's3', 'cp', archive, `s3://${buckets['us-east-1']}/${key}`, '--only-show-errors'])
const global = deploy('us-east-1', 'global', 'experiments/celld/infra/global.yaml', {
  EastDomain: origins['us-east-1']!, DirectoryName: directoryName, DirectoryWestRegion: directoryWest!,
  OriginSecret: secret, ArtifactBucket: buckets['us-east-1']!, EdgeCodeKey: key, EdgeCodeSha256: createHash('sha256').update(contents).digest('base64'),
})
writeFileSync(resolve(work, 'deployment.json'), JSON.stringify({ regions, directoryWest, directoryName, origins, buckets, ...global }), { mode: 0o600 })
console.log('Deployment saved in ignored local directory. Stateful ingress remains closed until valid directory entries exist. This is not a successful recovery/fencing validation.')
