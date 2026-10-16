import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {observeLogEvent,observeMetric,sameDimensions} from '../measurements/telemetry.ts'
if(!process.argv.includes('--execute')) {
  console.log('Plan only: identity-bound READ-ONLY check of both regional stacks, four current nodes, actual latest log events, alarm configuration and metric samples. Missing/stale telemetry is reported, never treated as zero/OK. No log injection, SSM, alarm changes, notification test, promotion or recovery claim. Explicit AWS_PROFILE and --execute required.')
  process.exit(0)
}
const profile=process.env.AWS_PROFILE
assert.ok(profile,'Explicit AWS_PROFILE required')
const prefix=process.env.CELLD_STACK_PREFIX??'tanstack-celld-test'
assert.match(prefix,/^tanstack-celld-[a-z0-9-]{1,24}$/)
const work=resolve('.deploy/celld',prefix),directory=resolve(work,'observability',crypto.randomUUID())
mkdirSync(directory,{recursive:true,mode:0o700})
let callNumber=0
function aws(region:string,service:string,args:string[]) {
  const endpoint=service==='cloudwatch'?'monitoring':service==='elbv2'?'elasticloadbalancing':service
  const bytes=execFileSync('aws',['--profile',profile!,'--region',region,'--endpoint-url',`https://${endpoint}.${region}.amazonaws.com`,service,...args,'--output','json','--cli-connect-timeout','5','--cli-read-timeout','15'],{
    encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024,env:{...process.env,AWS_PAGER:'',AWS_MAX_ATTEMPTS:'1',AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true'},
  })
  writeFileSync(resolve(directory,`${String(++callNumber).padStart(3,'0')}-${region}-${service}-${args[0]}.json`),bytes,{mode:0o600})
  return JSON.parse(bytes||'{}')
}
try {
const identity=aws('us-east-1','sts',['get-caller-identity'])
assert.equal(identity.Account,JSON.parse(readFileSync(resolve(work,'identity.json'),'utf8')).Account)
assert.ok(!identity.Arn.endsWith(':root'))
const end=Date.now(),start=Math.floor(end/300_000)*300_000-30*60_000,maximumAgeMs=15*60_000
const regions:any[]=[],gaps:string[]=[],warnings:string[]=[]
function metric(region:string,namespace:string,name:string,dimensions:Record<string,string>,statistic:string,period:number,required:boolean) {
  const result=aws(region,'cloudwatch',['get-metric-statistics','--namespace',namespace,'--metric-name',name,'--dimensions',JSON.stringify(Object.entries(dimensions).map(([Name,Value])=>({Name,Value}))),
    '--start-time',new Date(start).toISOString(),'--end-time',new Date(end).toISOString(),'--period',String(period),'--statistics',statistic])
  const observation=observeMetric(result.Datapoints,statistic,start,end,maximumAgeMs)
  if(required && observation.status!=='FRESH') gaps.push(`${region} ${name}: ${observation.status}`)
  return {namespace,name,dimensions,statistic,period,required,...observation}
}
for(const region of ['us-east-1','us-west-2']) {
  const expected=JSON.parse(readFileSync(resolve(work,`${region}-regional-stack.json`),'utf8'))
  const stack=aws(region,'cloudformation',['describe-stacks','--stack-name',expected.StackId]).Stacks[0]
  assert.equal(stack.StackId,expected.StackId);assert.equal(stack.StackName,`${prefix}-regional`)
  assert.ok(['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus))
  const output=Object.fromEntries(stack.Outputs.map((value:any)=>[value.OutputKey,value.OutputValue]))
  const parameters=Object.fromEntries(stack.Parameters.map((value:any)=>[value.ParameterKey,value.ParameterValue]))
  const resources=aws(region,'cloudformation',['list-stack-resources','--stack-name',stack.StackId]).StackResourceSummaries
  const resource=(name:string)=> {const rows=resources.filter((value:any)=>value.LogicalResourceId===name);assert.equal(rows.length,1);return rows[0].PhysicalResourceId as string}
  const group=aws(region,'autoscaling',['describe-auto-scaling-groups','--auto-scaling-group-names',output.AutoScalingGroupName]).AutoScalingGroups[0]
  assert.equal(group.AutoScalingGroupName,resource('Fleet'));assert.equal(group.Instances.length,2)
  assert.ok(group.Instances.every((value:any)=>value.LifecycleState==='InService'))
  assert.equal(new Set(group.Instances.map((value:any)=>value.AvailabilityZone)).size,2)
  const health=aws(region,'elbv2',['describe-target-health','--target-group-arn',output.TargetGroupArn]).TargetHealthDescriptions
  for(const node of group.Instances) assert.ok(health.some((value:any)=>value.Target.Id===node.InstanceId && value.TargetHealth.State==='healthy'))
  const logGroup=resource('NodeLogGroup'),nodes:any[]=[]
  for(const node of group.Instances) {
    // Use actual bounded events, not eventually consistent stream timestamps.
    // Empty pages are not exhaustion; follow the backward token to a fixed point.
    let event:any,token:string|undefined,complete=false
    const logEnd=Date.now(),logStart=logEnd-maximumAgeMs
    for(let page=0;page<10;page++) {
      const data=aws(region,'logs',['get-log-events','--log-group-name',logGroup,'--log-stream-name',node.InstanceId,'--limit','1','--no-start-from-head','--no-paginate',
        '--start-time',String(logStart),'--end-time',String(logEnd),...(token?['--next-token',token]:[])])
      assert.ok(data.events.length<=1)
      if(data.events.length) {event=data.events[0];complete=true;break}
      if(data.nextBackwardToken===token) {complete=true;break}
      assert.equal(typeof data.nextBackwardToken,'string');token=data.nextBackwardToken
    }
    const log=complete?observeLogEvent(event,Date.now(),maximumAgeMs):{status:'UNKNOWN_PAGE_LIMIT',eventAgeMs:null,ingestionAgeMs:null}
    if(log.status!=='FRESH') gaps.push(`${region} current node log: ${log.status}`)
    const cpu=metric(region,'AWS/EC2','CPUUtilization',{InstanceId:node.InstanceId},'Average',300,true)
    nodes.push({instanceId:node.InstanceId,availabilityZone:node.AvailabilityZone,log:{...log,eventTimestamp:event?.timestamp??null,ingestionTime:event?.ingestionTime??null,messageSha256:event?createHash('sha256').update(event.message).digest('hex'):null},cpu})
  }
  const alarms:any[]=[]
  const expectedAlarms=[
    {logical:'HealthyNodesAlarm',namespace:'AWS/ApplicationELB',name:'HealthyHostCount',dimensions:{LoadBalancer:resource('Alb').split(':').at(-1)!.replace(/^loadbalancer\//,''),TargetGroup:output.TargetGroupArn.split(':').at(-1)},statistic:'Minimum',period:60,threshold:2,comparison:'LessThanThreshold',evaluationPeriods:3,missing:'breaching',required:true},
    {logical:'FleetCapacityAlarm',namespace:'AWS/AutoScaling',name:'GroupInServiceInstances',dimensions:{AutoScalingGroupName:group.AutoScalingGroupName},statistic:'Minimum',period:60,threshold:2,comparison:'LessThanThreshold',evaluationPeriods:3,missing:'breaching',required:true},
    {logical:'HighCpuAlarm',namespace:'AWS/EC2',name:'CPUUtilization',dimensions:{AutoScalingGroupName:group.AutoScalingGroupName},statistic:'Average',period:300,threshold:85,comparison:'GreaterThanThreshold',evaluationPeriods:3,missing:'breaching',required:true},
  ] as any[]
  if(parameters.ReplicationDestinationArn) expectedAlarms.push({logical:'ReplicationFailuresAlarm',namespace:'AWS/S3',name:'OperationsFailedReplication',dimensions:{SourceBucket:parameters.ReplicationSourceBucketName,DestinationBucket:parameters.ReplicationDestinationArn.split(':').at(-1),RuleId:'FleetRecoveryArchive'},statistic:'Sum',period:60,threshold:0,comparison:'GreaterThanThreshold',evaluationPeriods:1,missing:'ignore',required:false})
  if(parameters.ArchiveSourceBucketName) expectedAlarms.push({logical:'ArchiveBacklogAlarm',namespace:'AWS/S3',name:'BytesPendingReplication',dimensions:{SourceBucket:parameters.ArchiveSourceBucketName,DestinationBucket:output.ArchiveBucketName,RuleId:'FleetRecoveryArchive'},statistic:'Maximum',period:60,threshold:0,comparison:'GreaterThanThreshold',evaluationPeriods:1,missing:'ignore',required:false})
  for(const expectedAlarm of expectedAlarms) {
    const alarmName=resource(expectedAlarm.logical)
    const response=aws(region,'cloudwatch',['describe-alarms','--alarm-names',alarmName])
    assert.equal(response.MetricAlarms.length,1)
    const alarm=response.MetricAlarms[0]
    assert.equal(alarm.AlarmName,alarmName);assert.equal(alarm.Namespace,expectedAlarm.namespace);assert.equal(alarm.MetricName,expectedAlarm.name)
    assert.ok(sameDimensions(alarm.Dimensions,expectedAlarm.dimensions));assert.equal(alarm.Statistic,expectedAlarm.statistic);assert.equal(alarm.Period,expectedAlarm.period)
    assert.equal(alarm.Threshold,expectedAlarm.threshold);assert.equal(alarm.ComparisonOperator,expectedAlarm.comparison);assert.equal(alarm.EvaluationPeriods,expectedAlarm.evaluationPeriods);assert.equal(alarm.TreatMissingData,expectedAlarm.missing)
    assert.equal(alarm.DatapointsToAlarm??alarm.EvaluationPeriods,expectedAlarm.evaluationPeriods)
    assert.equal(alarm.ExtendedStatistic,undefined);assert.equal(alarm.Metrics,undefined)
    assert.deepEqual(alarm.AlarmActions,[]);assert.deepEqual(alarm.OKActions,[]);assert.deepEqual(alarm.InsufficientDataActions,[])
    const samples=metric(region,expectedAlarm.namespace,expectedAlarm.name,expectedAlarm.dimensions,expectedAlarm.statistic,expectedAlarm.period,expectedAlarm.required)
    if(expectedAlarm.required && alarm.StateValue!=='OK') gaps.push(`${region} ${expectedAlarm.logical}: ${alarm.StateValue}`)
    if(!expectedAlarm.required && (alarm.StateValue!=='OK' || samples.status!=='FRESH')) warnings.push(`${region} ${expectedAlarm.logical}: alarm ${alarm.StateValue}, samples ${samples.status}; recovery completeness unknown`)
    alarms.push({logical:expectedAlarm.logical,name:alarmName,state:alarm.StateValue,stateUpdatedAt:alarm.StateUpdatedTimestamp,notificationActions:0,samples})
  }
  regions.push({region,stackId:stack.StackId,logGroup,nodes,alarms})
}
writeFileSync(resolve(directory,'verification.json'),JSON.stringify({observedAt:new Date().toISOString(),window:{start,end,maximumAgeMs},regions,gaps,warnings,
 scope:'Read-only point-in-time delivery and configured alarm/metric observations. Empty S3 series stay unknown, not zero. No injected log, alarm firing, notification delivery, completeness/continuity guarantee, RPO or regional recovery.'}),{mode:0o600})
const nodeCount=regions.reduce((sum,row)=>sum+row.nodes.length,0),alarmCount=regions.reduce((sum,row)=>sum+row.alarms.length,0)
console.log(`Observed ${nodeCount} current nodes and ${alarmCount} configured alarms; ${gaps.length} required freshness/state gaps. No alarm notification targets; sparse S3 series are not assumed zero.`)
for(const warning of warnings) console.log(`WARNING: ${warning}`)
assert.equal(gaps.length,0,'Required telemetry gaps retained in private verification report; no health claim')
console.log('PASS: current four-node log events/CPU and required alarm metrics are fresh, with exact stack-bound dimensions/configuration. No alarm firing or regional-recovery proof.')

} catch(error) {
  writeFileSync(resolve(directory,'failure.json'),JSON.stringify({observedAt:new Date().toISOString(),error:String(error),scope:'Read-only observation failed; retained completed call evidence is partial, not a health proof.'}),{mode:0o600})
  throw error
}
