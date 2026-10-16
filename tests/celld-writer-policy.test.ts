import {describe,it,expect} from 'vitest'
import {verifyWriterPolicy} from '../experiments/celld/ownership/writer-policy.ts'

const account='0'.repeat(12)
const scope={account,roleArn:`arn:aws:iam::${account}:role/fixture-writer`,principalArn:`arn:aws:iam::${account}:user/fixture-operator`,tableName:'tanstack-celld-test-ownership',shardId:'v1:07'}
function fixture() {
  const resources=['us-east-1','us-west-2'].map(r=>`arn:aws:dynamodb:${r}:${account}:table/${scope.tableName}`)
  return {
    'get-role':{Role:{Arn:scope.roleArn,RoleName:'fixture-writer',MaxSessionDuration:3600,AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{AWS:scope.principalArn},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:PrincipalAccount':account}}}]}}},
    'list-attached-role-policies':{AttachedPolicies:[]},
    'list-role-policies':{PolicyNames:['OneDirectoryShard']},
    'get-role-policy':{PolicyDocument:{Version:'2012-10-17',Statement:[
      {Sid:'DescribeExactReplicas',Effect:'Allow',Action:['dynamodb:DescribeTable'],Resource:resources},
      {Sid:'ReadAndConditionallyWriteOneShard',Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem'],Resource:resources,Condition:{'ForAllValues:StringEquals':{'dynamodb:LeadingKeys':['v1:07']},Null:{'dynamodb:LeadingKeys':'false','dynamodb:EnclosingOperation':'true'}}},
    ]}},
  }
}
function verify(data:any) {return verifyWriterPolicy(scope,(op)=>data[op])}
describe('live metadata writer policy preflight',()=>{
  it('accepts exact live documents with reordered action/resource/statement arrays',()=>{
    const data=fixture()
    for(const statement of data['get-role-policy'].PolicyDocument.Statement){statement.Action.reverse();statement.Resource.reverse()}
    data['get-role-policy'].PolicyDocument.Statement.reverse()
    expect(verify(data).roleArn).toBe(scope.roleArn)
  })
  it.each([
    ['trust version',(d:any)=>{d['get-role'].Role.AssumeRolePolicyDocument.Version='2008-10-17'}],
    ['extra trust field',(d:any)=>{d['get-role'].Role.AssumeRolePolicyDocument.Statement[0].NotPrincipal={AWS:'*'}}],
    ['unexpected boundary',(d:any)=>{d['get-role'].Role.PermissionsBoundary={PermissionsBoundaryArn:'fixture'}}],
    ['wrong role name',(d:any)=>{d['get-role'].Role.RoleName='unexpected'}],
    ['missing attached list',(d:any)=>{delete d['list-attached-role-policies'].AttachedPolicies}],
    ['missing inline list',(d:any)=>{delete d['list-role-policies'].PolicyNames}],
    ['truncated inline',(d:any)=>{d['list-role-policies'].IsTruncated=true}],
    ['inline marker',(d:any)=>{d['list-role-policies'].Marker='more'}],
    ['attached token',(d:any)=>{d['list-attached-role-policies'].NextToken='more'}],
    ['policy version',(d:any)=>{d['get-role-policy'].PolicyDocument.Version='2008-10-17'}],
    ['extra allow',(d:any)=>{d['get-role-policy'].PolicyDocument.Statement.push({Effect:'Allow',Action:'*',Resource:'*'})}],
    ['extra statement field',(d:any)=>{d['get-role-policy'].PolicyDocument.Statement[1].NotAction=['dynamodb:DeleteItem']}],
    ['extra policy field',(d:any)=>{d['get-role-policy'].PolicyDocument.Unexpected=true}],
    ['broader resources',(d:any)=>{d['get-role-policy'].PolicyDocument.Statement[1].Resource=['*']}],
    ['missing key presence',(d:any)=>{delete d['get-role-policy'].PolicyDocument.Statement[1].Condition.Null['dynamodb:LeadingKeys']}],
    ['transaction grant',(d:any)=>{delete d['get-role-policy'].PolicyDocument.Statement[1].Condition.Null['dynamodb:EnclosingOperation']}],
    ['wrong key',(d:any)=>{d['get-role-policy'].PolicyDocument.Statement[1].Condition['ForAllValues:StringEquals']['dynamodb:LeadingKeys']=['v1:08']}],
  ] as const)('rejects %s',(label,mutate)=>{
    const data=fixture();mutate(data)
    expect(()=>verify(data),label).toThrow()
  })
})
