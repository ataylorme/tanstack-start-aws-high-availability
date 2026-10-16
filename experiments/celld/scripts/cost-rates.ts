import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {marginalUsdCost,usdSchedule,sumUsdCosts} from '../measurements/pricing.ts'
import type {UsdSchedule} from '../measurements/pricing.ts'
if(!process.argv.includes('--execute')) {
  console.log('Plan only: read-only, identity/stack-bound current regional AWS rate catalog for ALB LCUs, MRSC requests/storage/PITR, S3 storage/requests, CloudWatch alarms/logs. Optional --usage=FILE models explicit billing-unit quantities and existing tier usage; no inferred free allowance, measured-usage claim, resource mutation or complete bill. Requires AWS_PROFILE and --execute.')
  process.exit(0)
}
const profile=process.env.AWS_PROFILE
assert.ok(profile,'Explicit AWS_PROFILE required')
const prefix=process.env.CELLD_STACK_PREFIX??'tanstack-celld-test'
assert.match(prefix,/^tanstack-celld-[a-z0-9-]{1,24}$/)
const work=resolve('.deploy/celld',prefix),directory=resolve(work,'cost-rates',crypto.randomUUID())
mkdirSync(directory,{recursive:true,mode:0o700})
let call=0
function aws(region:string,service:string,args:string[]) {
  const endpoint=service==='pricing'?'api.pricing':service==='cloudwatch'?'monitoring':service
  const bytes=execFileSync('aws',['--profile',profile!,'--region',region,'--endpoint-url',`https://${endpoint}.${region}.amazonaws.com`,service,...args,'--output','json','--cli-connect-timeout','5','--cli-read-timeout','30'],{
    encoding:'utf8',timeout:120_000,maxBuffer:16*1024*1024,env:{...process.env,AWS_PAGER:'',AWS_MAX_ATTEMPTS:'1',AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true'},
  })
  writeFileSync(resolve(directory,`${++call}-${service}-${args[0]}.json`),bytes,{mode:0o600});return JSON.parse(bytes||'{}')
}
const identity=aws('us-east-1','sts',['get-caller-identity'])
assert.equal(identity.Account,JSON.parse(readFileSync(resolve(work,'identity.json'),'utf8')).Account);assert.ok(!identity.Arn.endsWith(':root'))
const rates:Record<string,Record<string,UsdSchedule>>={}
const alarmInventory:any[]=[]
for(const region of ['us-east-1','us-west-2']) {
  const expected=JSON.parse(readFileSync(resolve(work,`${region}-regional-stack.json`),'utf8'))
  const stack=aws(region,'cloudformation',['describe-stacks','--stack-name',expected.StackId]).Stacks[0]
  assert.equal(stack.StackId,expected.StackId);assert.equal(stack.StackName,prefix+'-regional');assert.ok(['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus))
  const products:Record<string,unknown[]>={}
  for(const service of ['AWSELB','AmazonDynamoDB','AmazonS3','AmazonCloudWatch']) {
    const response=aws('us-east-1','pricing',['get-products','--service-code',service,'--filters',JSON.stringify([{Type:'TERM_MATCH',Field:'regionCode',Value:region}])])
    products[service]=response.PriceList.map((value:string)=>JSON.parse(value))
  }
  const selected:Record<string,UsdSchedule>={}
  const quote=(id:string,service:string,unit:string,match:(attributes:Record<string,string>)=>boolean)=> {
    try {selected[id]=usdSchedule(products[service]!,unit,a=>a.regionCode===region && match(a))}
    catch(error) {throw new Error(`Unsupported price selection: ${region}/${id}`,{cause:error})}
  }
  quote('alb-lcu','AWSELB','LCU-Hrs',a=>a.operation==='LoadBalancing:Application' && a.usagetype?.endsWith('LCUUsage')===true && !a.usagetype.includes('Reserved') && !a.usagetype.includes('Outposts'))
  quote('mrsc-read','AmazonDynamoDB','ReadRequestUnits',a=>a.group==='DDB-ReadUnits' && a.operation==='PayPerRequestThroughput')
  quote('mrsc-replicated-write','AmazonDynamoDB','ReplicatedWriteRequestUnits',a=>a.group==='DDB-ReplicatedWriteUnits' && a.operation==='PayPerRequestThroughput')
  quote('ddb-standard-storage','AmazonDynamoDB','GB-Mo',a=>a.volumeType==='Amazon DynamoDB - Indexed DataStore')
  quote('ddb-pitr','AmazonDynamoDB','GB-Mo',a=>a.volumeType==='Amazon DynamoDB - Point-In-Time-Restore (PITR) Backup Storage')
  quote('s3-standard-storage','AmazonS3','GB-Mo',a=>a.volumeType==='Standard' && a.storageClass==='General Purpose' && a.usagetype?.endsWith('TimedStorage-ByteHrs')===true)
  quote('s3-put-copy-post-list','AmazonS3','Requests',a=>a.group==='S3-API-Tier1' && a.groupDescription==='PUT/COPY/POST or LIST requests')
  quote('s3-get-other','AmazonS3','Requests',a=>a.group==='S3-API-Tier2' && a.groupDescription==='GET and all other requests')
  quote('cloudwatch-standard-alarm','AmazonCloudWatch','Alarms',a=>a.group==='Alarm' && a.usagetype?.endsWith('CW:AlarmMonitorUsage')===true)
  quote('cloudwatch-log-storage-current','AmazonCloudWatch','GB-Mo',a=>a.group==='Amazon CloudWatch Standard Storage pricing current')
  quote('cloudwatch-log-ingestion-current','AmazonCloudWatch','GB',a=>a.group==='Ingested Logs' && a.operation==='PutLogEvents' && a.usagetype===`${region==='us-east-1'?'USE1':'USW2'}-DataProcessing-Bytes`)
  rates[region]=selected
  const resources=aws(region,'cloudformation',['list-stack-resources','--stack-name',stack.StackId]).StackResourceSummaries
  const names=resources.filter((value:any)=>value.ResourceType==='AWS::CloudWatch::Alarm' && value.ResourceStatus!=='DELETE_COMPLETE').map((value:any)=>value.PhysicalResourceId)
  assert.ok(names.length>0 && new Set(names).size===names.length)
  const alarms=aws(region,'cloudwatch',['describe-alarms','--alarm-names',...names]).MetricAlarms
  assert.equal(alarms.length,names.length)
  assert.deepEqual([...alarms.map((value:any)=>value.AlarmName)].sort(),[...names].sort())
  assert.ok(alarms.every((value:any)=>!value.Metrics && typeof value.Namespace==='string' && typeof value.MetricName==='string' && Number.isInteger(value.Period) && value.Period>=60),'Only simple single-metric standard alarms may be counted')
  alarmInventory.push({region,stackId:stack.StackId,alarms,standardAlarmMetricCount:alarms.length,
    fullMonthListPriceScenarioUsd:marginalUsdCost(selected['cloudwatch-standard-alarm']!,alarms.length,0),
    scope:'Observed current simple single-metric standard alarm count, modeled for one full month at public list price, before free-tier/credits. Not actual alarm lifetimes or a billed month.'})
}
const usageFile=process.argv.find(value=>value.startsWith('--usage='))?.slice('--usage='.length)
let model:object|undefined
if(usageFile) {
  const bytes=readFileSync(usageFile);assert.ok(bytes.length<=1024*1024)
  const usage=JSON.parse(bytes.toString())
  assert.equal(usage.format,1);assert.equal(typeof usage.label,'string');assert.ok(usage.label.length>0 && usage.label.length<=120)
  assert.ok(Number.isFinite(Date.parse(usage.windowStart)) && Number.isFinite(Date.parse(usage.windowEnd)) && Date.parse(usage.windowEnd)>Date.parse(usage.windowStart))
  assert.ok(Array.isArray(usage.rows) && usage.rows.length>0 && usage.rows.length<=1000)
  assert.ok(Array.isArray(usage.unpriced) && usage.unpriced.length>0 && usage.unpriced.length<=32 && usage.unpriced.every((value:unknown)=>typeof value==='string' && value.length>0 && value.length<=256),'Unpriced categories must remain explicit')
  const seen=new Set<string>()
  const rows=usage.rows.map((row:any)=> {
    const key=`${row.region}/${row.category}`;assert.ok(!seen.has(key));seen.add(key)
    const price=rates[row.region]?.[row.category];assert.ok(price,'Unsupported regional charge category');assert.equal(row.unit,price.unit)
    assert.equal(typeof row.quantity,'number');assert.equal(typeof row.existingUsage,'number')
    return {...row,usd:marginalUsdCost(price,row.quantity,row.existingUsage),quote:price}
  })
  model={scope:'Scenario only: user-supplied billing-unit quantities and existing tier usage, NOT measured usage, allocated free tiers or an account bill. Sum is partial; omitted charges are not zero.',label:usage.label,windowStart:usage.windowStart,windowEnd:usage.windowEnd,rows,partialScenarioUsd:sumUsdCosts(rows.map((row:any)=>row.usd)),unpriced:usage.unpriced}
}
writeFileSync(resolve(directory,'rates.json'),JSON.stringify({observedAt:new Date().toISOString(),rates,alarmInventory,model:model??null,scope:'Current regional public On-Demand schedules. Catalog rates are per stated unit. No private account bill/discount/free-tier allocation inferred; account-wide thresholds require explicit existingUsage. Witness and DynamoDB global-table replication transfer do not add charges per current dedicated AWS billing documentation; S3 CRR/transfer is separate.'}),{mode:0o600})
console.log(`PASS: ${Object.values(rates).reduce((sum,value)=>sum+Object.keys(value).length,0)} current regional price schedules retained with tiers/SKUs/effective dates. ${model?'Explicit partial workload scenario priced.':'No usage quantities supplied; no operating total calculated.'} Current simple alarms are inventoried with a separately labeled full-month list-price scenario. Unmodeled charges remain unpriced; not an account bill.`)
