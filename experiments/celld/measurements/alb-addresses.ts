import assert from 'node:assert/strict'
import {isIPv4} from 'node:net'

/** Current associated allocations only, not an atomic or historical usage meter. */
export function albAddressScope(alb:any,account:string) {
  assert.match(account,/^\d{12}$/)
  assert.match(alb.LoadBalancerArn,new RegExp(`^arn:aws:elasticloadbalancing:(us-east-1|us-west-2):${account}:loadbalancer/app/[^/]+/[^/]+$`))
  assert.equal(alb.Type,'application');assert.equal(alb.Scheme,'internet-facing')
  assert.equal(alb.State.Code,'active')
  // Deliberately fail rather than treating an unsupported address mode as zero.
  assert.equal(alb.IpAddressType,'ipv4','This inventory qualifies only IPv4 ALBs')
  assert.ok(typeof alb.VpcId==='string'&&alb.VpcId)
  assert.ok(Array.isArray(alb.AvailabilityZones)&&alb.AvailabilityZones.length>=2)
  const subnets=new Map<string,string>(alb.AvailabilityZones.map((zone:any)=>{
    assert.ok(typeof zone.SubnetId==='string'&&zone.SubnetId&&typeof zone.ZoneName==='string'&&zone.ZoneName)
    return [zone.SubnetId,zone.ZoneName]
  }))
  assert.equal(subnets.size,alb.AvailabilityZones.length)
  return {description:'ELB '+alb.LoadBalancerArn.split(':loadbalancer/')[1],vpcId:alb.VpcId as string,subnets,account}
}
export function albInterfaceAllocations(scope:ReturnType<typeof albAddressScope>,response:any) {
  assert.ok(!response.NextToken,'Incomplete ALB interface inventory')
  assert.ok(Array.isArray(response.NetworkInterfaces)&&response.NetworkInterfaces.length>0,'Missing ALB interfaces; never issue an unfiltered address query')
  const interfaces=response.NetworkInterfaces,ids=new Set<string>(),seenSubnets=new Set<string>()
  const allocations=new Map<string,{allocationId:string;publicIp:string;associationId:string;networkInterfaceId:string}>()
  for(const eni of interfaces) {
    assert.ok(typeof eni.NetworkInterfaceId==='string'&&eni.NetworkInterfaceId&&!ids.has(eni.NetworkInterfaceId),'Duplicate or missing ENI identity')
    ids.add(eni.NetworkInterfaceId)
    assert.equal(eni.Description,scope.description);assert.equal(eni.VpcId,scope.vpcId);assert.equal(eni.OwnerId,scope.account)
    assert.equal(eni.Status,'in-use');assert.equal(eni.RequesterManaged,true)
    assert.ok(scope.subnets.has(eni.SubnetId));assert.equal(eni.AvailabilityZone,scope.subnets.get(eni.SubnetId));seenSubnets.add(eni.SubnetId)
    const associations=[eni.Association,...(eni.PrivateIpAddresses??[]).map((value:any)=>value.Association)].filter(Boolean)
    assert.ok(associations.length>0,'Missing public ALB association evidence')
    for(const association of associations) {
      assert.ok(typeof association.PublicIp==='string'&&isIPv4(association.PublicIp))
      assert.ok(typeof association.AllocationId==='string'&&association.AllocationId)
      assert.ok(typeof association.AssociationId==='string'&&association.AssociationId)
      const item={allocationId:association.AllocationId,publicIp:association.PublicIp,associationId:association.AssociationId,networkInterfaceId:eni.NetworkInterfaceId}
      const previous=allocations.get(item.allocationId)
      if(previous) assert.deepEqual(item,previous,'Allocation identities disagree across ALB associations')
      else allocations.set(item.allocationId,item)
    }
    // Ipv4Prefixes are private delegated ranges, not public allocations.
  }
  assert.equal(seenSubnets.size,scope.subnets.size,'Incomplete configured ALB subnet coverage')
  assert.equal(new Set([...allocations.values()].map(value=>value.publicIp)).size,allocations.size,'Public IP reused across allocation identities')
  return {interfaceIds:[...ids],allocations:[...allocations.values()]}
}
export function verifyAlbAddresses(scope:ReturnType<typeof albAddressScope>,inventory:ReturnType<typeof albInterfaceAllocations>,response:any) {
  assert.ok(!response.NextToken,'Incomplete public address inventory')
  assert.ok(Array.isArray(response.Addresses))
  assert.equal(response.Addresses.length,inventory.allocations.length,'ALB ENI/address inventories differ; rerun observation, never assume zero')
  const seen=new Set<string>()
  for(const address of response.Addresses) {
    assert.equal(address.ServiceManaged,'alb');assert.equal(address.Domain,'vpc');assert.equal(address.NetworkInterfaceOwnerId,scope.account)
    const expected=inventory.allocations.find(value=>value.allocationId===address.AllocationId)
    assert.ok(expected&&!seen.has(address.AllocationId),'Unattributed or duplicate ALB allocation')
    seen.add(address.AllocationId)
    assert.equal(address.PublicIp,expected.publicIp);assert.equal(address.NetworkInterfaceId,expected.networkInterfaceId);assert.equal(address.AssociationId,expected.associationId)
  }
  return {observedAssociatedPublicIpv4:seen.size,interfaceCount:inventory.interfaceIds.length}
}
