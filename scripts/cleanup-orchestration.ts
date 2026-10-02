import { execFileSync } from 'node:child_process'
const prefix = 'devops-orchestration-poc'
const account = process.env.EXPECTED_AWS_ACCOUNT_ID ?? ''
const profile = process.env.AWS_PROFILE ?? ''
const args = process.argv.slice(2)
if (args.some(arg => !['--execute', '--inventory', `--confirm=${prefix}`].includes(arg))) throw new Error('Supported: --inventory or --execute --confirm=devops-orchestration-poc')
if (!args.includes('--execute') && !args.includes('--inventory')) {
  console.log(`Plan only: no AWS calls made. Inventory only ${prefix} and ${prefix}-bootstrap with --inventory. --execute --confirm=${prefix} deletes those stacks and their one-time schedules. DynamoDB tables, ECR images and log groups are retained and must be reviewed separately; no data purge is implemented. HA lab resources are never selected.`)
  process.exit(0)
}
if (!profile.trim() || !/^\d{12}$/.test(account) || process.env.AWS_REGION !== 'us-east-1') throw new Error('Explicit AWS_PROFILE, 12-digit EXPECTED_AWS_ACCOUNT_ID, and AWS_REGION=us-east-1 required')
if (args.includes('--execute') && !args.includes(`--confirm=${prefix}`)) throw new Error(`Destructive cleanup requires --confirm=${prefix}`)
function aws(args: string[]): string { return execFileSync('aws', ['--profile', profile, '--region', 'us-east-1', ...args], { encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' } }).trim() }
if (aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']) !== account) throw new Error('AWS account guard failed')
interface Stack { StackName: string; Tags?: Array<{ Key: string; Value: string }> }
const all = (JSON.parse(aws(['cloudformation', 'describe-stacks', '--output', 'json'])) as { Stacks: Stack[] }).Stacks
for (const name of [prefix, `${prefix}-bootstrap`]) {
  const stack = all.find(stack => stack.StackName === name)
  if (!stack) { console.log(`${name}: absent`); continue }
  if (!stack.Tags?.some(tag => tag.Key === 'Project' && tag.Value === prefix)) throw new Error(`Refusing unowned stack ${name}`)
  console.log(aws(['cloudformation', 'list-stack-resources', '--stack-name', name, '--query', 'StackResourceSummaries[].{Type:ResourceType,Id:PhysicalResourceId}', '--output', 'json']))
  if (args.includes('--execute')) {
    if (name === prefix) {
      const groups = JSON.parse(aws(['scheduler', 'list-schedule-groups', '--output', 'json'])) as { ScheduleGroups: Array<{ Name: string }> }
      if (groups.ScheduleGroups.some(group => group.Name === prefix)) {
        const schedules = JSON.parse(aws(['scheduler', 'list-schedules', '--group-name', prefix, '--output', 'json'])) as { Schedules: Array<{ Name: string }> }
        for (const schedule of schedules.Schedules) aws(['scheduler', 'delete-schedule', '--group-name', prefix, '--name', schedule.Name])
      }
    }
    aws(['cloudformation', 'delete-stack', '--stack-name', name])
    aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', name])
  }
}
console.log('Retained: devops-orchestration-poc-workflow, devops-orchestration-poc-operations, ECR repository devops-orchestration-poc, /aws/lambda/devops-orchestration-poc-* logs. No retained data was deleted.')
