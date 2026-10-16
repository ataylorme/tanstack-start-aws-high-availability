import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flatUsdQuote, partialRecurringSubtotal } from '../measurements/pricing.ts'

import {albAddressScope,albInterfaceAllocations,verifyAlbAddresses} from '../measurements/alb-addresses.ts'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: identity-bound read-only inventory of both regional fleets/volumes/ALBs plus current AWS On-Demand pricing. Produces a PARTIAL idle subtotal, not a bill or complete cost estimate. No resource changes. --execute requires explicit AWS_PROFILE.')
  process.exit(0)
}
const profile=process.env.AWS_PROFILE
if (!profile) throw new Error('Explicit AWS_PROFILE required')
const prefix=process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
const work=resolve('.deploy/celld',prefix)
const expected=JSON.parse(readFileSync(resolve(work,'identity.json'),'utf8'))
function aws(region: string,service: string,args: string[]) {
  const endpoint=service==='pricing'?'api.pricing':service==='elbv2'?'elasticloadbalancing':service
  return JSON.parse(execFileSync('aws',['--profile',profile!,'--region',region,'--endpoint-url',
    `https://${endpoint}.${region}.amazonaws.com`,service,...args,'--output','json'],{
    encoding:'utf8',timeout:120_000,maxBuffer:32*1024*1024,
    env:{...process.env,AWS_PAGER:'',AWS_MAX_ATTEMPTS:'1',AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true'},
  }) || '{}')
}
const identity=aws('us-east-1','sts',['get-caller-identity'])
assert.equal(identity.Account,expected.Account);assert.ok(!/:root$/.test(identity.Arn))
const rawPrices: object[]=[]
function products(service: string,filters: Record<string,string>) {
  const response=aws('us-east-1','pricing',['get-products','--service-code',service,'--filters',
    JSON.stringify(Object.entries(filters).map(([Field,Value])=>({Type:'TERM_MATCH',Field,Value})))])
  const parsed=response.PriceList.map((value: string)=>JSON.parse(value))
  rawPrices.push({service,filters,products:parsed});return parsed
}
const regions: any[]=[]
for (const region of ['us-east-1','us-west-2']) {
  const recorded=JSON.parse(readFileSync(resolve(work,`${region}-regional-stack.json`),'utf8'))
  const stack=aws(region,'cloudformation',['describe-stacks','--stack-name',recorded.StackId]).Stacks[0]
  assert.equal(stack.StackId,recorded.StackId);assert.equal(stack.StackName,`${prefix}-regional`)
  assert.ok(['CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'].includes(stack.StackStatus))
  const outputs=Object.fromEntries(stack.Outputs.map((entry: any)=>[entry.OutputKey,entry.OutputValue]))
  const resources=aws(region,'cloudformation',['list-stack-resources','--stack-name',stack.StackId]).StackResourceSummaries
  const loadBalancers=resources.filter((resource: any)=>resource.ResourceType==='AWS::ElasticLoadBalancingV2::LoadBalancer')
  assert.equal(loadBalancers.length,1)
  const loadBalancerArn=loadBalancers[0].PhysicalResourceId
  const group=aws(region,'autoscaling',['describe-auto-scaling-groups','--auto-scaling-group-names',outputs.AutoScalingGroupName]).AutoScalingGroups[0]
  assert.equal(group.AutoScalingGroupName,outputs.AutoScalingGroupName)
  assert.ok(group.Instances.length>0)
  const ids=group.Instances.map((instance: any)=>instance.InstanceId)
  const instances=aws(region,'ec2',['describe-instances','--instance-ids',...ids]).Reservations.flatMap((entry: any)=>entry.Instances)
  assert.equal(instances.length,ids.length)
  assert.ok(instances.every((instance: any)=>instance.State.Name==='running' && instance.InstanceType==='t4g.medium'))
  const volumeIds=instances.flatMap((instance: any)=>instance.BlockDeviceMappings.map((device: any)=>device.Ebs.VolumeId))
  const volumes=aws(region,'ec2',['describe-volumes','--volume-ids',...volumeIds]).Volumes
  assert.equal(volumes.length,volumeIds.length)
  assert.ok(volumes.every((volume: any)=>volume.VolumeType==='gp3' && volume.Encrypted && volume.Attachments.every((attachment: any)=>ids.includes(attachment.InstanceId))))
  const loadBalancer=aws(region,'elbv2',['describe-load-balancers','--load-balancer-arns',loadBalancerArn]).LoadBalancers[0]
  assert.equal(loadBalancer.LoadBalancerArn,loadBalancerArn)
  assert.equal(loadBalancer.Type,'application');assert.equal(loadBalancer.State.Code,'active')
  const addressObservationStartedAt=new Date().toISOString()
  const addressScope=albAddressScope(loadBalancer,identity.Account)
  const albInterfaces=aws(region,'ec2',['describe-network-interfaces','--filters',JSON.stringify([
    {Name:'description',Values:[addressScope.description]},{Name:'vpc-id',Values:[addressScope.vpcId]},
  ])])
  const associated=albInterfaceAllocations(addressScope,albInterfaces)
  // A nonempty identity-bound set is mandatory; never broaden to all account ALBs.
  assert.ok(associated.interfaceIds.length>0)
  const albAddresses=aws(region,'ec2',['describe-addresses','--filters',JSON.stringify([
    {Name:'network-interface-id',Values:associated.interfaceIds},
  ])])
  const albAddressInventory=verifyAlbAddresses(addressScope,associated,albAddresses)
  const addressObservationCompletedAt=new Date().toISOString()
  const instancePrice=flatUsdQuote(products('AmazonEC2',{regionCode:region,instanceType:'t4g.medium',operatingSystem:'Linux',tenancy:'Shared',preInstalledSw:'NA',capacitystatus:'Used'}),'Hrs',()=>true)
  const volumePrice=flatUsdQuote(products('AmazonEC2',{regionCode:region,volumeApiName:'gp3'}),'GB-Mo',
    attributes=>attributes.usagetype?.endsWith('EBS:VolumeUsage.gp3') === true)
  const albPrice=flatUsdQuote(products('AWSELB',{regionCode:region,operation:'LoadBalancing:Application',locationType:'AWS Region'}),'Hrs',
    attributes=>attributes.groupDescription==='LoadBalancer hourly usage by Application Load Balancer')
  const ipv4Price=flatUsdQuote(products('AmazonVPC',{regionCode:region,group:'VPCPublicIPv4Address'}),'Hrs',
    attributes=>attributes.usagetype?.endsWith('PublicIPv4:InUseAddress') === true)
  const nodePublicAddresses=instances.filter((instance: any)=>instance.PublicIpAddress).length
  const gp3GiB=volumes.reduce((sum: number,volume: any)=>sum+volume.Size,0)
  const hourly=instances.length*instancePrice.usd+albPrice.usd+(nodePublicAddresses+albAddressInventory.observedAssociatedPublicIpv4)*ipv4Price.usd
  const monthlyStorage=gp3GiB*volumePrice.usd
  regions.push({region,albAddressInventory,albInterfaces,albAddresses,addressObservationStartedAt,addressObservationCompletedAt,stackId:stack.StackId,instances,volumes,loadBalancer,nodePublicAddresses,gp3GiB,
    quotes:{instancePrice,volumePrice,albPrice,ipv4Price},partialRecurringUsdPerHour:hourly,gp3UsdPerMonth:monthlyStorage})
}
const unresolved=[
  'Actual public IPv4 address-hours, unassociated/unattributable service-managed addresses, node secondary interfaces, LCUs and traffic costs',
  'gp3 extra IOPS/throughput and burstable CPU surplus',
  'MRSC replica reads/replicated writes, table and PITR storage; witness storage/writes are not charged',
  'S3 source/archive/version bytes, requests, CRR and inter-region transfer',
  'CloudFront requests/egress and Lambda@Edge invocation/duration',
  'CloudWatch logs, alarms and metrics',
  'Retained resources outside current ASGs/attached volumes; earlier replacements and offline artifacts',
  'Actual resource lifetimes, discounts, credits, taxes and billing reconciliation',
]
const subtotal=partialRecurringSubtotal(regions)
const partialHourly=subtotal.partialRecurringUsdPerHour
const gp3Monthly=subtotal.gp3UsdPerMonth
const result={observedAt:new Date().toISOString(),account:identity.Account,profile,regions,rawPrices,
  partialRecurringUsdPerHour:partialHourly,gp3UsdPerMonth:gp3Monthly,
  illustrative730HourMonthUsd:subtotal.illustrative730HourMonthUsd,unresolved,
  scope:'Partial current-fleet idle subtotal includes observed associated ALB IPv4 allocations plus primary node public addresses. ALB ENI/address cross-check is non-atomic and not historical address-hours; missing or conflicting evidence fails, never zero. Explicit 730-hour illustration, not actual calendar-month allocation, a complete estimate or account bill. Missing categories are UNPRICED, never zero.'}
writeFileSync(resolve(work,`cost-inventory-${randomUUID()}.json`),JSON.stringify(result),{mode:0o600})
console.log(`PARTIAL idle subtotal: $${partialHourly.toFixed(4)}/hour plus $${gp3Monthly.toFixed(2)}/month gp3; illustrative 730-hour subtotal $${result.illustrative730HourMonthUsd.toFixed(2)}. ${unresolved.length} additional categories UNPRICED; not a complete cost estimate or bill.`)
