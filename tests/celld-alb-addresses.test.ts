import {describe,it,expect} from 'vitest'
import {albAddressScope,albInterfaceAllocations,verifyAlbAddresses} from '../experiments/celld/measurements/alb-addresses.ts'
const account='0'.repeat(12)
function fixture() {
  const alb={LoadBalancerArn:`arn:aws:elasticloadbalancing:us-east-1:${account}:loadbalancer/app/fixture/identity`,Type:'application',Scheme:'internet-facing',State:{Code:'active'},IpAddressType:'ipv4',VpcId:'vpc-fixture',AvailabilityZones:[{SubnetId:'subnet-a',ZoneName:'us-east-1a'},{SubnetId:'subnet-b',ZoneName:'us-east-1b'}]}
  const scope=albAddressScope(alb,account)
  const enis={NetworkInterfaces:['a','b'].map((suffix,index)=>{
    const association={PublicIp:`192.0.2.${index+10}`,AllocationId:`eipalloc-${suffix}`,AssociationId:`eipassoc-${suffix}`}
    return {NetworkInterfaceId:`eni-fixture-${suffix}`,Description:scope.description,VpcId:'vpc-fixture',OwnerId:account,Status:'in-use',RequesterManaged:true,SubnetId:`subnet-${suffix}`,AvailabilityZone:`us-east-1${suffix}`,Association:association,PrivateIpAddresses:[{Association:{...association}}],Ipv4Prefixes:[{Ipv4Prefix:'10.0.0.0/28'}]}
  })}
  const addresses={Addresses:enis.NetworkInterfaces.map(eni=>({ServiceManaged:'alb',Domain:'vpc',NetworkInterfaceOwnerId:account,NetworkInterfaceId:eni.NetworkInterfaceId,...eni.Association}))}
  return {alb,scope,enis,addresses}
}
function verify(data:ReturnType<typeof fixture>) {return verifyAlbAddresses(data.scope,albInterfaceAllocations(data.scope,data.enis),data.addresses)}
describe('current ALB associated public IPv4 allocations',()=>{
  it('deduplicates primary/private associations, not private delegated prefixes',()=>{
    expect(verify(fixture())).toEqual({observedAssociatedPublicIpv4:2,interfaceCount:2})
  })
  it('counts additional actual allocations, not a two-AZ minimum',()=>{
    const d=fixture(),extra={PublicIp:'192.0.2.12',AllocationId:'eipalloc-c',AssociationId:'eipassoc-c'}
    d.enis.NetworkInterfaces[0]!.PrivateIpAddresses.push({Association:extra})
    d.addresses.Addresses.push({...d.addresses.Addresses[0]!,...extra})
    expect(verify(d).observedAssociatedPublicIpv4).toBe(3)
  })
  it.each([
    ['empty ENIs',(d:any)=>{d.enis.NetworkInterfaces=[]}],
    ['incomplete subnet coverage',(d:any)=>{d.enis.NetworkInterfaces.pop();d.addresses.Addresses.pop()}],
    ['truncated ENIs',(d:any)=>{d.enis.NextToken='more'}],
    ['wrong description',(d:any)=>{d.enis.NetworkInterfaces[0].Description='ELB unrelated'}],
    ['wrong VPC',(d:any)=>{d.enis.NetworkInterfaces[0].VpcId='other'}],
    ['wrong owner',(d:any)=>{d.enis.NetworkInterfaces[0].OwnerId='1'.repeat(12)}],
    ['wrong subnet',(d:any)=>{d.enis.NetworkInterfaces[0].SubnetId='other'}],
    ['non-managed ENI',(d:any)=>{d.enis.NetworkInterfaces[0].RequesterManaged=false}],
    ['inactive ENI',(d:any)=>{d.enis.NetworkInterfaces[0].Status='available'}],
    ['duplicate ENIs',(d:any)=>{d.enis.NetworkInterfaces.push(d.enis.NetworkInterfaces[0])}],
    ['missing association',(d:any)=>{delete d.enis.NetworkInterfaces[0].Association;d.enis.NetworkInterfaces[0].PrivateIpAddresses=[]}],
    ['invalid public IP',(d:any)=>{d.enis.NetworkInterfaces[0].Association.PublicIp='invalid'}],
    ['conflicting association',(d:any)=>{d.enis.NetworkInterfaces[0].PrivateIpAddresses[0].Association.PublicIp='192.0.2.99'}],
    ['missing address list',(d:any)=>{delete d.addresses.Addresses}],
    ['truncated addresses',(d:any)=>{d.addresses.NextToken='more'}],
    ['missing allocated address',(d:any)=>{d.addresses.Addresses.pop()}],
    ['unattributable address',(d:any)=>{d.addresses.Addresses[0].NetworkInterfaceId='eni-other'}],
    ['duplicate address',(d:any)=>{d.addresses.Addresses[1]=d.addresses.Addresses[0]}],
    ['missing service attribution',(d:any)=>{delete d.addresses.Addresses[0].ServiceManaged}],
    ['wrong service',(d:any)=>{d.addresses.Addresses[0].ServiceManaged='nlb'}],
    ['address mismatch',(d:any)=>{d.addresses.Addresses[0].PublicIp='192.0.2.99'}],
  ] as const)('rejects %s rather than treating uncertainty as zero',(label,mutate)=>{
    const d=fixture();mutate(d);expect(()=>verify(d),label).toThrow()
  })
  it.each(['internal','dualstack','dualstack-without-public-ipv4'])('rejects unsupported scheme/address type %s',value=>{
    const d=fixture();if(value==='internal')d.alb.Scheme=value;else d.alb.IpAddressType=value
    expect(()=>albAddressScope(d.alb,account)).toThrow()
  })
})
