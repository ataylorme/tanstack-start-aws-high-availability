import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
if(!process.argv.includes('--execute')) {
  console.log('Plan only: create a separate one-shard metadata operator IAM role trusted to the current non-root IAM principal. No celld/edge grant, ACTIVE routing, promotion or native fencing. Requires existing identity-bound directory, explicit --shard=N, AWS_PROFILE and --execute. Account/principal/role details stay ignored.')
  process.exit(0)
}
const profile=process.env.AWS_PROFILE;assert.ok(profile,'Explicit AWS_PROFILE required')
const arg=process.argv.find(value=>value.startsWith('--shard='))?.slice(8),shard=Number(arg)
assert.ok(arg===String(shard)&&Number.isInteger(shard)&&shard>=0&&shard<64,'Explicit canonical --shard=0..63 required')
const shardId=`v1:${String(shard).padStart(2,'0')}`,prefix=process.env.CELLD_STACK_PREFIX??'tanstack-celld-test'
assert.match(prefix,/^tanstack-celld-[a-z0-9-]{1,24}$/)
const work=resolve('.deploy/celld',prefix),name=prefix+'-ownership-writer'
function raw(region:string,service:string,args:string[]) {
  const endpoint=service==='iam'?'https://iam.amazonaws.com':`https://${service}.${region}.amazonaws.com`
  return execFileSync('aws',['--profile',profile!,'--region',region,'--endpoint-url',endpoint,service,...args,'--output','json'],{
    encoding:'utf8',timeout:service==='cloudformation'&&args[0]==='deploy'?20*60_000:120_000,maxBuffer:8*1024*1024,env:{...process.env,AWS_PAGER:'',AWS_MAX_ATTEMPTS:'1',AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true'},
  })
}
const aws=(region:string,service:string,args:string[])=>JSON.parse(raw(region,service,args)||'{}')
const caller=aws('us-east-1','sts',['get-caller-identity']),expected=JSON.parse(readFileSync(resolve(work,'identity.json'),'utf8'))
assert.equal(caller.Account,expected.Account);assert.ok(!caller.Arn.endsWith(':root'))
let principal=caller.Arn
if(principal.includes(':assumed-role/')) {
  const roleName=principal.split(':assumed-role/')[1].split('/')[0]
  principal=aws('us-east-1','iam',['get-role','--role-name',roleName]).Role.Arn
}
assert.ok(new RegExp(`^arn:aws:iam::${caller.Account}:(?:user|role)/[A-Za-z0-9+=,.@_/-]+$`).test(principal),'Expected exact same-account IAM user/role principal, not an STS session')
const tableName=prefix+'-ownership',replicas=JSON.parse(readFileSync(resolve(work,'directory-identities.json'),'utf8'))
for(const region of ['us-east-1','us-west-2']) {
  const table=aws(region,'dynamodb',['describe-table','--table-name',tableName]).Table
  assert.equal(table.TableId,replicas[region].tableId);assert.equal(table.TableArn,replicas[region].tableArn);assert.equal(table.TableStatus,'ACTIVE');assert.equal(table.MultiRegionConsistency,'STRONG')
}
const recordFile=resolve(work,'us-east-1-ownership-writer-stack.json'),configFile=resolve(work,'ownership-writer.json')
if(existsSync(recordFile)) {
  const record=JSON.parse(readFileSync(recordFile,'utf8')),config=JSON.parse(readFileSync(configFile,'utf8'))
  const stack=aws('us-east-1','cloudformation',['describe-stacks','--stack-name',record.StackId]).Stacks[0]
  assert.equal(stack.StackId,record.StackId);assert.equal(stack.StackName,name)
  assert.equal(config.principalArn,principal,'Existing trust differs; review migration instead of changing trust automatically')
  assert.equal(config.shardId,shardId,'Existing key scope differs; review migration rather than silently reassigning')
} else {
  let absent=false
  try {aws('us-east-1','cloudformation',['describe-stacks','--stack-name',name])}
  catch(error) {const value=error as {status?:number;signal?:string|null;stderr?:string};absent=!!value.status&&!value.signal&&!!value.stderr?.includes(`Stack with id ${name} does not exist`)}
  assert.ok(absent,'Unrecorded stack or uncertain existence; reconcile before deployment')
}
const attempt=crypto.randomUUID(),intent=resolve(work,`writer-deployment-${attempt}.json`)
writeFileSync(intent,JSON.stringify({at:new Date().toISOString(),status:'UNKNOWN',stackName:name,principalArn:principal,shardId}),{mode:0o600})
const log=raw('us-east-1','cloudformation',['deploy','--stack-name',name,'--template-file','experiments/celld/infra/ownership-writer.yaml','--capabilities','CAPABILITY_IAM','--no-fail-on-empty-changeset','--parameter-overrides',`TableName=${tableName}`,`OperatorPrincipalArn=${principal}`,`WriterShardId=${shardId}`])
writeFileSync(resolve(work,`writer-deployment-${attempt}.log`),log,{mode:0o600})
const stack=aws('us-east-1','cloudformation',['describe-stacks','--stack-name',name]).Stacks[0]
assert.equal(stack.StackName,name);assert.ok(['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus))
const output=Object.fromEntries(stack.Outputs.map((value:any)=>[value.OutputKey,value.OutputValue]))
assert.equal(output.ShardId,shardId);assert.ok(output.RoleArn.startsWith(`arn:aws:iam::${caller.Account}:role/`))
writeFileSync(recordFile,JSON.stringify(stack),{mode:0o600})
writeFileSync(configFile,JSON.stringify({stackId:stack.StackId,roleArn:output.RoleArn,shardId,principalArn:principal,tableName,account:caller.Account}),{mode:0o600})
writeFileSync(intent,JSON.stringify({at:new Date().toISOString(),status:'CONFIRMED',stackId:stack.StackId,roleArn:output.RoleArn,shardId,scope:'One-shard metadata writer, not native runtime authorization. No directory item changed.'}),{mode:0o600})
console.log('PASS: identity-bound one-shard metadata writer role deployed; private trust/role records saved. No directory mutation, ACTIVE route or native fence.')
