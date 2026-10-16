import assert from 'node:assert/strict'

export interface WriterScope {
  account: string
  roleArn: string
  principalArn: string
  tableName: string
  shardId: string
}

// A point-in-time preflight, not an atomic attestation against concurrent IAM
// administrator changes or an audit of table resource policies. No native fence.
export function verifyWriterPolicy(scope: WriterScope, iam: (operation: string, input: object) => any) {
  assert.match(scope.account, /^\d{12}$/)
  assert.match(scope.tableName, /^tanstack-celld-[a-z0-9-]{1,24}-ownership$/)
  assert.match(scope.shardId, /^v1:(0[0-9]|[1-5][0-9]|6[0-3])$/)
  assert.ok(scope.roleArn.startsWith(`arn:aws:iam::${scope.account}:role/`))
  assert.match(scope.principalArn, new RegExp(`^arn:aws:iam::${scope.account}:(user|role)/[A-Za-z0-9_+=,.@/-]+$`))
  const roleName=scope.roleArn.split('/').at(-1)!
  const role=iam('get-role',{RoleName:roleName}).Role
  assert.equal(role.Arn,scope.roleArn)
  assert.equal(role.RoleName,roleName)
  assert.equal(role.MaxSessionDuration,3600)
  assert.equal(role.PermissionsBoundary,undefined,'Unexpected writer permissions boundary')
  assert.deepEqual(role.AssumeRolePolicyDocument,{Version:'2012-10-17',Statement:[{
    Effect:'Allow',Principal:{AWS:scope.principalArn},Action:'sts:AssumeRole',
    Condition:{StringEquals:{'aws:PrincipalAccount':scope.account}},
  }]})
  // CLI auto-pagination stays enabled. A continuation flag/token or missing
  // array is nevertheless rejected rather than accepting a partial inventory.
  const attached=iam('list-attached-role-policies',{RoleName:roleName})
  const inline=iam('list-role-policies',{RoleName:roleName})
  for(const result of [attached,inline]) {
    assert.ok(result.IsTruncated===undefined||result.IsTruncated===false,'Incomplete writer policy inventory')
    assert.ok(!result.Marker&&!result.NextToken,'Incomplete writer policy inventory')
  }
  assert.deepEqual(attached.AttachedPolicies,[])
  assert.deepEqual(inline.PolicyNames,['OneDirectoryShard'])
  const policy=iam('get-role-policy',{RoleName:roleName,PolicyName:'OneDirectoryShard'}).PolicyDocument
  const arns=['us-east-1','us-west-2'].map(region=>`arn:aws:dynamodb:${region}:${scope.account}:table/${scope.tableName}`)
  // AWS may reorder statements/actions/resources; all other fields must match.
  assert.ok(Array.isArray(policy.Statement))
  const normalized={...policy,Statement:policy.Statement.map((statement:any)=>({
    ...statement,
    ...(Array.isArray(statement.Action)?{Action:[...statement.Action].sort()}:{}),
    ...(Array.isArray(statement.Resource)?{Resource:[...statement.Resource].sort()}:{}),
  })).sort((a:any,b:any)=>String(a.Sid).localeCompare(String(b.Sid)))}
  assert.deepEqual(normalized,{Version:'2012-10-17',Statement:[{
    Sid:'DescribeExactReplicas',Effect:'Allow',Action:['dynamodb:DescribeTable'],Resource:[...arns].sort(),
  },{
    Sid:'ReadAndConditionallyWriteOneShard',Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem'],Resource:[...arns].sort(),
    Condition:{'ForAllValues:StringEquals':{'dynamodb:LeadingKeys':[scope.shardId]},Null:{'dynamodb:LeadingKeys':'false','dynamodb:EnclosingOperation':'true'}},
  }]})
  return {roleArn:role.Arn,observedAt:new Date().toISOString()}
}
