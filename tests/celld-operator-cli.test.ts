import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

function runScenario(scenario: string, execute = true, region = 'us-east-1') {
  const root = mkdtempSync(resolve(tmpdir(), 'celld-operator-'))
  try {
    const work = resolve(root, '.deploy/celld/tanstack-celld-test'); mkdirSync(work, { recursive: true })
    const account = '0'.repeat(12)
    const tableArn = `arn:aws:dynamodb:us-east-1:${account}:table/tanstack-celld-test-ownership`
    const writerArn=`arn:aws:iam::${account}:role/fixture-writer`
    const writerStackId=`arn:aws:cloudformation:us-east-1:${account}:stack/tanstack-celld-test-ownership-writer/fixture`
    for (const [file, data] of Object.entries({
      'deployment.json': { directoryName: 'tanstack-celld-test-ownership', directoryWest: 'us-west-2' },
      'identity.json': { Account: account },
      'us-east-1-ownership-writer-stack.json': { StackId: writerStackId },
      'ownership-writer.json': { account, roleArn: writerArn, stackId: writerStackId, shardId: 'v1:07', tableName: 'tanstack-celld-test-ownership', principalArn: `arn:aws:iam::${account}:user/fixture-operator` },
      'directory-live-validation.json': { TableArn: tableArn, TableId: 'fixture-east' },
      'directory-identities.json': { 'us-east-1': { tableArn, tableId: 'fixture-east' }, 'us-west-2': { tableArn:tableArn.replace('us-east-1','us-west-2'), tableId:'fixture-west' } },
    })) writeFileSync(resolve(work, file), JSON.stringify(data))
    const fake = resolve(root, 'aws')
    writeFileSync(fake, `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);const dir=process.env.FAKE_ROOT;fs.appendFileSync(dir+'/calls.jsonl',JSON.stringify(args)+'\\n');const get=name=>args[args.indexOf(name)+1];const service=args.includes('sts')?'sts':args.includes('cloudformation')?'cloudformation':args.includes('iam')?'iam':'dynamodb';const op=args[args.indexOf(service)+1];const scenario=process.env.FAKE_SCENARIO;const account='0'.repeat(12);const endpointRegion=get('--region');const arn='arn:aws:dynamodb:'+endpointRegion+':'+account+':table/tanstack-celld-test-ownership';let output={};if(op==='get-caller-identity')output={Account:scenario==='wrong-account'?'1'.repeat(12):account,Arn:'arn:aws:sts::'+account+':assumed-role/'+(process.env.AWS_ACCESS_KEY_ID==='fixture-access'?(scenario==='wrong-role'?'unexpected':'fixture-writer'):'fixture')+'/session'};if(op==='describe-stacks')output={Stacks:[{StackId:'arn:aws:cloudformation:us-east-1:'+account+':stack/tanstack-celld-test-ownership-writer/fixture',StackName:'tanstack-celld-test-ownership-writer',StackStatus:'CREATE_COMPLETE',Outputs:[{OutputKey:'RoleArn',OutputValue:'arn:aws:iam::'+account+':role/fixture-writer'},{OutputKey:'ShardId',OutputValue:scenario==='wrong-writer-shard'?'v1:08':'v1:07'}]}]};if(service==='iam'&&scenario==='iam-unavailable')process.exit(1);if(op==='get-role')output={Role:{Arn:'arn:aws:iam::'+account+':role/fixture-writer',RoleName:'fixture-writer',MaxSessionDuration:3600,AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{AWS:scenario==='trust-drift'?'*':'arn:aws:iam::'+account+':user/fixture-operator'},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:PrincipalAccount':account}}}]}},};if(op==='list-attached-role-policies')output={AttachedPolicies:scenario==='attached-drift'?[{PolicyArn:'fixture'}]:[],...(scenario==='truncated-policies'?{IsTruncated:true,Marker:'more'}:{})};if(op==='list-role-policies')output={PolicyNames:scenario==='inline-drift'?['OneDirectoryShard','Extra']:['OneDirectoryShard']};if(op==='get-role-policy')output={PolicyDocument:{Version:'2012-10-17',Statement:[{Sid:'DescribeExactReplicas',Effect:'Allow',Action:['dynamodb:DescribeTable'],Resource:['us-east-1','us-west-2'].map(r=>'arn:aws:dynamodb:'+r+':'+account+':table/tanstack-celld-test-ownership')},{Sid:'ReadAndConditionallyWriteOneShard',Effect:'Allow',Action:scenario==='actions-drift'?['dynamodb:*']:['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem'],Resource:['us-east-1','us-west-2'].map(r=>'arn:aws:dynamodb:'+r+':'+account+':table/tanstack-celld-test-ownership'),Condition:{'ForAllValues:StringEquals':{'dynamodb:LeadingKeys':['v1:07']},Null:{'dynamodb:LeadingKeys':'false','dynamodb:EnclosingOperation':'true'}}}]}};if(op==='assume-role'){if(scenario==='role-denied')process.exit(1);output={Credentials:{AccessKeyId:'fixture-access',SecretAccessKey:'fixture-secret',SessionToken:'fixture-token'}};}if(op==='describe-table')output={Table:{TableArn:arn,TableId:scenario==='wrong-table'?'different':(endpointRegion==='us-west-2'?'fixture-west':'fixture-east'),MultiRegionConsistency:'STRONG',TableStatus:'ACTIVE'}};if(op==='put-item'){if(process.env.AWS_ACCESS_KEY_ID!=='fixture-access')process.exit(2);fs.writeFileSync(dir+'/accepted.json',get('--cli-input-json'));if(scenario==='response-lost'||scenario==='unknown'){process.stderr.write('simulated lost response');process.exit(1);}}if(op==='get-item'&&fs.existsSync(dir+'/accepted.json')){if(scenario==='unknown'){process.stderr.write('simulated read failure');process.exit(1);}output={Item:JSON.parse(fs.readFileSync(dir+'/accepted.json')).Item};if(scenario==='mismatch')output.Item.transitionId={S:'different'};}process.stdout.write(JSON.stringify(output));`)
    chmodSync(fake, 0o700)
    let failed = false
    let stdout = ''
    try { stdout = execFileSync(process.execPath, [resolve('experiments/celld/scripts/ownership.ts'), 'initialize-fencing', '--shard=7', '--transition=fixture-init', `--region=${region}`, ...(execute ? ['--execute'] : [])], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${root}:${process.env.PATH}`, AWS_PROFILE: 'fixture-profile', CELLD_STACK_PREFIX: 'tanstack-celld-test', AWS_ENDPOINT_URL: 'https://untrusted.example', FAKE_ROOT: root, FAKE_SCENARIO: scenario },
    }) } catch { failed = true }
    const calls = readFileSync(resolve(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    const evidence = readdirSync(work).filter(name => /^ownership-7-/.test(name)).map(name => JSON.parse(readFileSync(resolve(work, name), 'utf8')))
    return { failed, stdout, calls, evidence }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
describe('operator CLI identity and ambiguous outcomes', () => {
  it.each(['wrong-account', 'wrong-table', 'role-denied', 'wrong-role', 'wrong-writer-shard'])('refuses writes to mismatched deployment %s', scenario => {
    const result = runScenario(scenario)
    expect(result.failed).toBe(true)
    expect(result.calls.some(args => args.includes('put-item'))).toBe(false)
  })
  it.each(['iam-unavailable','trust-drift','attached-drift','inline-drift','actions-drift','truncated-policies'])('rejects live writer drift %s before assuming or writing', scenario => {
    const result=runScenario(scenario)
    expect(result.failed).toBe(true)
    expect(result.calls.some(args=>args.includes('assume-role')||args.includes('put-item'))).toBe(false)
  })
  it('plan mode uses explicit profile/endpoints and performs zero writes', () => {
    const result = runScenario('normal', false)
    expect(result.failed).toBe(false)
    expect(result.evidence[0].outcome).toBe('PLAN_ONLY')
    expect(result.calls.some(args => args.includes('put-item'))).toBe(false)
    for (const args of result.calls) {
      expect(args[args.indexOf('--profile') + 1]).toBe('fixture-profile')
      expect(args[args.indexOf('--endpoint-url') + 1]).toMatch(/^https:\/\/(?:sts|dynamodb)\.us-east-1\.amazonaws\.com$/)
    }
  })
  it('reconciles accepted write with lost response without replay', () => {
    const result = runScenario('response-lost')
    expect(result.failed).toBe(false)
    expect(result.calls.filter(args => args.includes('put-item'))).toHaveLength(1)
    expect(result.evidence[0].outcome).toBe('CONFIRMED_FENCING')
    expect(result.evidence[0].submissionReportedFailure).toBe(true)
  })
  it('exchanges the broad profile for temporary role credentials before writing', () => {
    const result=runScenario('normal')
    expect(result.failed).toBe(false)
    expect(result.calls.filter(args=>args.includes('assume-role'))).toHaveLength(1)
    const writes=result.calls.filter(args=>args.includes('put-item'))
    expect(writes).toHaveLength(1);expect(writes[0]).not.toContain('--profile')
    expect(result.evidence[0].writerRoleArn).toContain('role/fixture-writer')
    expect(JSON.stringify(result.evidence)).not.toContain('fixture-token')
    expect(JSON.stringify(result.evidence)).not.toContain('fixture-secret')
  })
  it('keeps writer-stack control in the east while using the requested western table endpoint', () => {
    const result=runScenario('normal',true,'us-west-2')
    expect(result.failed).toBe(false)
    const stackCall=result.calls.find(args=>args.includes('describe-stacks'))!
    expect(stackCall[stackCall.indexOf('--region')+1]).toBe('us-east-1')
    for(const args of result.calls.filter(args=>args.includes('dynamodb'))) expect(args[args.indexOf('--region')+1]).toBe('us-west-2')
  })
  it('preserves UNKNOWN intent if both submission and reconciliation fail', () => {
    const result = runScenario('unknown')
    expect(result.failed).toBe(true)
    expect(result.calls.filter(args => args.includes('put-item'))).toHaveLength(1)
    expect(result.evidence[0].outcome).toBe('UNKNOWN')
    expect(result.evidence[0].command.item.status).toBe('FENCING')
    expect(result.evidence[0].reconciliationError).toBeTruthy()
  })
  it('never claims a mismatched transition succeeded', () => {
    const result = runScenario('mismatch')
    expect(result.failed).toBe(true)
    expect(result.evidence[0].outcome).toBe('NOT_CONFIRMED')
    expect(result.calls.filter(args => args.includes('put-item'))).toHaveLength(1)
  })
})
