import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import { verifyWriterPolicy } from '../ownership/writer-policy.ts'
if(!process.argv.includes('--execute')) {
  console.log('Plan only: verify recorded metadata-writer stack/policy/trust, read-only IAM simulations and temporary role-authenticated reads. No item mutation, activation or native-fence claim. Requires AWS_PROFILE and --execute.')
  process.exit(0)
}
const profile=process.env.AWS_PROFILE;assert.ok(profile,'Explicit AWS_PROFILE required')
const prefix=process.env.CELLD_STACK_PREFIX??'tanstack-celld-test';assert.match(prefix,/^tanstack-celld-[a-z0-9-]{1,24}$/)
const work=resolve('.deploy/celld',prefix),config=JSON.parse(readFileSync(resolve(work,'ownership-writer.json'),'utf8'))
let roleEnv:NodeJS.ProcessEnv|undefined
function aws(region:string,service:string,operation:string,input:object) {
  const endpoint=service==='iam'?'https://iam.amazonaws.com':`https://${service}.${region}.amazonaws.com`
  return JSON.parse(execFileSync('aws',[...(roleEnv?[]:['--profile',profile!]),'--region',region,'--endpoint-url',endpoint,service,operation,'--cli-input-json',JSON.stringify(input),'--output','json'],{
    encoding:'utf8',timeout:30_000,maxBuffer:8*1024*1024,env:{...(roleEnv??process.env),AWS_PAGER:'',AWS_MAX_ATTEMPTS:'1',AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true'},
  })||'{}')
}
const caller=aws('us-east-1','sts','get-caller-identity',{})
assert.equal(caller.Account,JSON.parse(readFileSync(resolve(work,'identity.json'),'utf8')).Account);assert.equal(caller.Account,config.account);assert.ok(!caller.Arn.endsWith(':root'))
const recorded=JSON.parse(readFileSync(resolve(work,'us-east-1-ownership-writer-stack.json'),'utf8'))
const stack=aws('us-east-1','cloudformation','describe-stacks',{StackName:recorded.StackId}).Stacks[0]
assert.equal(stack.StackId,recorded.StackId);assert.equal(stack.StackId,config.stackId);assert.equal(stack.StackName,prefix+'-ownership-writer');assert.ok(['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus))
const output=Object.fromEntries(stack.Outputs.map((value:any)=>[value.OutputKey,value.OutputValue]));assert.equal(output.RoleArn,config.roleArn);assert.equal(output.ShardId,config.shardId)
const policyPreflight=verifyWriterPolicy(config,(operation,input)=>aws('us-east-1','iam',operation,input))
const roleName=config.roleArn.split('/').at(-1)
const arns=['us-east-1','us-west-2'].map(region=>`arn:aws:dynamodb:${region}:${config.account}:table/${config.tableName}`)
const simulations:any[]=[]
for(const [label,key,enclosing] of [['allowed',config.shardId,undefined],['other-shard',config.shardId==='v1:00'?'v1:01':'v1:00',undefined],['missing-key',undefined,undefined],['transaction',config.shardId,'TransactWriteItems']] as const) {
  const context=[...(key?[{ContextKeyName:'dynamodb:LeadingKeys',ContextKeyValues:[key],ContextKeyType:'stringList'}]:[]),...(enclosing?[{ContextKeyName:'dynamodb:EnclosingOperation',ContextKeyValues:[enclosing],ContextKeyType:'string'}]:[])]
  const result=aws('us-east-1','iam','simulate-principal-policy',{PolicySourceArn:config.roleArn,ActionNames:['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Scan','dynamodb:BatchWriteItem'],ResourceArns:arns,...(context.length?{ContextEntries:context}:{})})
  writeFileSync(resolve(work,`writer-simulation-${label}-${crypto.randomUUID()}.json`),JSON.stringify(result),{mode:0o600})
  const evaluations=result.EvaluationResults.flatMap((value:any)=>value.ResourceSpecificResults?.length?value.ResourceSpecificResults.map((resource:any)=>({EvalActionName:value.EvalActionName,EvalResourceName:resource.EvalResourceName,EvalDecision:resource.EvalResourceDecision})):[value])
  assert.equal(evaluations.length,12);assert.equal(new Set(evaluations.map((value:any)=>value.EvalActionName+' '+value.EvalResourceName)).size,12)
  for(const evaluation of evaluations) {
    assert.ok(arns.includes(evaluation.EvalResourceName))
    const shouldAllow=label==='allowed'&&['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem'].includes(evaluation.EvalActionName)
    assert.equal(evaluation.EvalDecision==='allowed',shouldAllow)
  }
  simulations.push({label,results:result.EvaluationResults})
}
// Never save/print the STS response or credentials; no CLI role-profile cache.
const temporary=aws('us-east-1','sts','assume-role',{RoleArn:config.roleArn,RoleSessionName:`celld-verify-${crypto.randomUUID()}`,DurationSeconds:900}).Credentials
assert.ok(temporary?.AccessKeyId&&temporary.SecretAccessKey&&temporary.SessionToken)
roleEnv={...process.env,AWS_PROFILE:undefined,AWS_DEFAULT_PROFILE:undefined,AWS_SECURITY_TOKEN:undefined,AWS_ACCESS_KEY_ID:temporary.AccessKeyId,AWS_SECRET_ACCESS_KEY:temporary.SecretAccessKey,AWS_SESSION_TOKEN:temporary.SessionToken}
const assumed=aws('us-east-1','sts','get-caller-identity',{});assert.equal(assumed.Account,config.account);assert.ok(assumed.Arn.startsWith(`arn:aws:sts::${config.account}:assumed-role/${roleName}/`))
const reads:any[]=[]
for(const region of ['us-east-1','us-west-2']) {
  const table=aws(region,'dynamodb','describe-table',{TableName:config.tableName}).Table
  const identity=JSON.parse(readFileSync(resolve(work,'directory-identities.json'),'utf8'))[region]
  assert.equal(table.TableArn,identity.tableArn);assert.equal(table.TableId,identity.tableId);assert.equal(table.TableStatus,'ACTIVE');assert.equal(table.MultiRegionConsistency,'STRONG')
  const result=aws(region,'dynamodb','get-item',{TableName:config.tableName,Key:{shardId:{S:config.shardId}},ConsistentRead:true})
  let denied=false
  try{aws(region,'dynamodb','get-item',{TableName:config.tableName,Key:{shardId:{S:config.shardId==='v1:00'?'v1:01':'v1:00'}},ConsistentRead:true})}
  catch(error){const value=error as {status?:number;signal?:string|null;stderr?:string};denied=!!value.status&&!value.signal&&!!value.stderr?.includes('An error occurred (AccessDeniedException) when calling the GetItem operation')}
  assert.ok(denied,'Other-shard read must actually be AccessDenied, not timeout/absence')
  reads.push({region,tableId:table.TableId,selectedShardReadAllowed:true,otherShardReadDenied:true,item:result.Item??null})
}
writeFileSync(resolve(work,`writer-verification-${crypto.randomUUID()}.json`),JSON.stringify({observedAt:new Date().toISOString(),roleArn:config.roleArn,stackId:stack.StackId,shardId:config.shardId,policyPreflight,simulations,reads,scope:'Deployed one-shard identity policy/trust and actual temporary-role read validation. IAM simulations do not prove every SCP/resource-policy interaction; status values/CAS remain application logic, not runtime regional fencing. No item writes performed by verifier.'}),{mode:0o600})
console.log('PASS: deployed single-shard policy/trust, allowed/denied IAM simulations and actual temporary-role reads at both replicas. Other keys denied; no credentials persisted, item writes, ACTIVE route or native-fence claim.')
