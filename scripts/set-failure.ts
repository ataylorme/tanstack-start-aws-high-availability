import { execFileSync } from 'node:child_process'

const [region, enabled] = process.argv.slice(2)
if ((region !== 'us-east-1' && region !== 'us-west-2') || (enabled !== 'true' && enabled !== 'false')) {
  throw new Error('Usage: node scripts/set-failure.ts us-east-1|us-west-2 true|false [--execute]')
}
const prefix = process.env.STACK_PREFIX ?? 'tanstack-ha'
if (!/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) throw new Error('Invalid STACK_PREFIX')
const stack = `${prefix}-app`
if (!process.argv.includes('--execute')) {
  console.log(`Plan only: set ${stack} SimulateFailure=${enabled} in ${region}. Add --execute to update AWS.`)
  process.exit(0)
}
const targetRegion = region
function aws(args: string[]): string {
  return execFileSync('aws', ['--region', targetRegion, ...args], {
    encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' },
  }).trim()
}
const current = aws(['cloudformation', 'describe-stacks', '--stack-name', stack,
  '--query', "Stacks[0].Parameters[?ParameterKey=='SimulateFailure'].ParameterValue | [0]", '--output', 'text'])
if (current === enabled) {
  console.log('Already in the requested state')
} else {
  const parameters = ['ImageUri', 'OriginSecret', 'ReleaseId'].map((ParameterKey) =>
    ({ ParameterKey, UsePreviousValue: true }))
  aws(['cloudformation', 'update-stack', '--stack-name', stack, '--use-previous-template',
    '--capabilities', 'CAPABILITY_IAM', '--parameters', JSON.stringify([
      ...parameters, { ParameterKey: 'SimulateFailure', ParameterValue: enabled },
    ])])
  aws(['cloudformation', 'wait', 'stack-update-complete', '--stack-name', stack])
  console.log(`${region}: SimulateFailure=${enabled}`)
}
