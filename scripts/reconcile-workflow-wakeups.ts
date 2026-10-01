import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const prefix = process.env.STACK_PREFIX
assert.ok(prefix && /^[a-z][a-z0-9-]{0,39}$/.test(prefix) && prefix !== 'tanstack-ha', 'Explicit isolated STACK_PREFIX required')
assert.ok(process.argv.slice(2).every(arg => arg === '--execute'), 'Only --execute is supported')
if (!process.argv.includes('--execute')) {
  console.log('Plan only: consistently scan version-1 workflow, outbox and cleanup metadata in both regions and invoke the router to seed/reconcile outstanding wakeups. Ordered logs and subscriber cursors are excluded. No data is deleted. Requires AWS_PROFILE, EXPECTED_AWS_ACCOUNT_ID, STACK_PREFIX and --execute.')
  process.exit(0)
}
assert.match(process.env.EXPECTED_AWS_ACCOUNT_ID ?? '', /^\d{12}$/)
assert.ok(process.env.AWS_PROFILE, 'Explicit AWS_PROFILE required')
function aws(region: string, args: string[]) {
  return execFileSync('aws', ['--region', region, ...args], { encoding: 'utf8',
    env: { ...process.env, AWS_PAGER: '' }, maxBuffer: 8 * 1024 * 1024 }).trim()
}
assert.equal(aws('us-east-1', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']), process.env.EXPECTED_AWS_ACCOUNT_ID, 'AWS account guard')
execFileSync('git', ['check-ignore', '.deploy/workflow-wakeups/reconcile.json'])
const dir = resolve('.deploy/workflow-wakeups', `reconcile-${Date.now()}`)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const counts: Record<string, number> = {}
for (const region of ['us-east-1', 'us-west-2']) {
  const dispatcher = aws(region, ['cloudformation', 'describe-stacks', '--stack-name', `${prefix}-sweeper`,
    '--query', "Stacks[0].Outputs[?OutputKey=='DispatcherFunctionName'].OutputValue | [0]", '--output', 'text'])
  assert.ok(dispatcher && dispatcher !== 'None', 'Deploy dispatchers before reconciliation')
  let cursor: unknown
  counts[region] = 0
  do {
    const page = JSON.parse(aws(region, ['dynamodb', 'scan', '--table-name', `${prefix}-workflow`, '--consistent-read',
      '--projection-expression', 'PK, SK', '--filter-expression', 'SK = :meta AND schemaVersion = :version',
      '--expression-attribute-values', JSON.stringify({ ':meta': { S: 'META' }, ':version': { N: '1' } }),
      '--limit', '100', '--no-paginate', '--output', 'json', ...(cursor ? ['--exclusive-start-key', JSON.stringify(cursor)] : [])]))
    const keys = page.Items.map((item: { PK: { S: string }; SK: { S: string } }) => ({ PK: item.PK.S, SK: item.SK.S }))
      .filter((item: { PK: string }) => /^(RUN|TIMER|SCHEDULE|EVENT)#/.test(item.PK))
    for (let i = 0; i < keys.length; i += 10) {
      const batch = keys.slice(i, i + 10)
      const responseFile = resolve(dir, `${region}-response.json`)
      const result = JSON.parse(aws(region, ['lambda', 'invoke', '--function-name', dispatcher,
        '--cli-binary-format', 'raw-in-base64-out', '--payload', JSON.stringify({ kind: 'reconcile', keys: batch }),
        '--output', 'json', responseFile]))
      assert.equal(result.FunctionError, undefined, 'Dispatcher failed; safely rerun reconciliation')
      assert.equal(JSON.parse(readFileSync(responseFile, 'utf8')).reconciled, batch.length)
      counts[region] += batch.length
    }
    cursor = page.LastEvaluatedKey
  } while (cursor)
  console.log(`${region}: reconciled ${counts[region]} metadata items`)
}
writeFileSync(resolve(dir, 'result.json'), JSON.stringify({ reconciledAt: new Date().toISOString(), counts }, null, 2), { mode: 0o600 })
