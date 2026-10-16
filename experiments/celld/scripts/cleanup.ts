import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateCleanupStacks, validateDeleteConfirmation } from '../operations/cleanup.ts'
import type { CleanupStack } from '../operations/cleanup.ts'

const profile = process.env.AWS_PROFILE
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated experiment prefix')
if (!process.argv.includes('--plan') && !process.argv.includes('--execute')) {
  console.log('Offline only: --plan reads owned stack/resource identities and saves a private cleanup inventory. --execute --confirm-delete=<experiment-prefix> --ack-retained-costs removes ingress/compute/stack records, but RETAINS buckets, MRSC table and edge runtime artifacts. This is destructive and requires explicit user authorization. No calls made.')
  process.exit(0)
}
if (!profile) throw new Error('Explicit AWS_PROFILE required')
const work = resolve('.deploy/celld', prefix)
const expectedIdentity = JSON.parse(readFileSync(resolve(work, 'identity.json'), 'utf8'))
const execute = process.argv.includes('--execute')
if (execute) validateDeleteConfirmation(prefix, { execute, confirmation: process.argv.find(arg => arg.startsWith('--confirm-delete='))?.slice(17), acknowledgedRetainedCosts: process.argv.includes('--ack-retained-costs') })
function aws(region: string, service: string, args: string[]) {
  return JSON.parse(execFileSync('aws', ['--profile', profile!, '--region', region, '--endpoint-url', `https://${service}.${region}.amazonaws.com`, service, ...args, '--output', 'json'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
  }) || '{}')
}
const identity = aws('us-east-1', 'sts', ['get-caller-identity'])
if (identity.Account !== expectedIdentity.Account || /:root$/.test(identity.Arn)) throw new Error('Unexpected deployed account/principal')
const stacks: CleanupStack[] = []
for (const [region, suffix] of [['us-east-1', 'global'], ['us-west-2', 'regional'], ['us-east-1', 'regional'], ['us-east-1', 'ownership-writer'], ['us-east-1', 'directory'], ['us-east-1', 'directory-deployer']] as const) {
  const record = resolve(work, `${region}-${suffix}-stack.json`)
  if (!existsSync(record)) continue // Only resources with local deployment provenance.
  const expected = JSON.parse(readFileSync(record, 'utf8'))
  const live = aws(region, 'cloudformation', ['describe-stacks', '--stack-name', expected.StackId]).Stacks[0]
  if (live.StackId !== expected.StackId || live.StackName !== `${prefix}-${suffix}`) throw new Error('Stack identity differs from deployment record')
  const resources = aws(region, 'cloudformation', ['list-stack-resources', '--stack-name', live.StackId]).StackResourceSummaries
  const body = aws(region, 'cloudformation', ['get-template', '--stack-name', live.StackId, '--template-stage', 'Original']).TemplateBody
  const template = typeof body === 'string' ? JSON.parse(body) : body
  stacks.push({ region, stackName: live.StackName, stackId: live.StackId, status: live.StackStatus, retained: resources.filter((resource: any) => template.Resources[resource.LogicalResourceId]?.DeletionPolicy === 'Retain').map((resource: any) => ({ logicalId: resource.LogicalResourceId, type: resource.ResourceType, physicalId: resource.PhysicalResourceId })) })
}
const plan = validateCleanupStacks(prefix, identity.Account, stacks)
const file = resolve(work, `cleanup-${randomUUID()}.json`)
const evidence: any = { observedAt: new Date().toISOString(), profile, account: identity.Account, plan, mode: execute ? 'AUTHORIZED_DELETE' : 'PLAN_ONLY', results: [], limitations: 'Retained versioned source/archive buckets, MRSC replicas/witness, edge function/versions/role and earlier retained replacement artifacts may continue incurring costs. No S3 version purge, table deletion/protection change or edge replica deletion is performed.' }
writeFileSync(file, JSON.stringify(evidence), { mode: 0o600 })
if (!execute) { console.log(`PLAN ONLY: ${plan.length} identity-bound stack records. No deletions. Private inventory lists retained resources and continuing-cost risks.`); process.exit(0) }
for (const stack of plan) {
  const fresh = aws(stack.region, 'cloudformation', ['describe-stacks', '--stack-name', stack.stackId]).Stacks[0]
  if (fresh.StackStatus !== stack.status || fresh.StackId !== stack.stackId) throw new Error('Stack changed after planning; stop and replan')
  aws(stack.region, 'cloudformation', ['delete-stack', '--stack-name', stack.stackId])
  evidence.results.push({ stackId: stack.stackId, region: stack.region, state: 'DELETE_SUBMITTED' }); writeFileSync(file, JSON.stringify(evidence), { mode: 0o600 })
  // Wait on the exact submitted stack; a wait timeout is not proof of deletion.
  execFileSync('aws', ['--profile', profile, '--region', stack.region, 'cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stack.stackId], { encoding: 'utf8', timeout: 40 * 60_000, env: { ...process.env, AWS_PAGER: '', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' } })
  evidence.results.at(-1).state = 'DELETE_COMPLETE'; writeFileSync(file, JSON.stringify(evidence), { mode: 0o600 })
}
console.log('Owned ingress/compute/stack cleanup complete. Retained storage/directory/edge artifacts were NOT deleted and may remain billable. Review private inventory; this is not zero-cost teardown.')
