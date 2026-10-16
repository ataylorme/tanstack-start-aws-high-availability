import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const template = JSON.parse(readFileSync(new URL('../experiments/celld/infra/ownership-writer.yaml', import.meta.url), 'utf8'))
const role = template.Resources.OwnershipWriterRole.Properties
const statements = role.Policies[0].PolicyDocument.Statement
const replicas = ['us-east-1', 'us-west-2'].map(region => ({ 'Fn::Sub': `arn:\${AWS::Partition}:dynamodb:${region}:\${AWS::AccountId}:table/\${TableName}` }))

describe('single-shard operator writer role', () => {
  it('trusts exactly the supplied IAM principal within the stack account', () => {
    expect(template.Parameters.OperatorPrincipalArn.NoEcho).toBe(true)
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: 'Allow', Principal: { AWS: { Ref: 'OperatorPrincipalArn' } }, Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'aws:PrincipalAccount': { Ref: 'AWS::AccountId' } } },
    }])
    expect(role.MaxSessionDuration).toBe(3600)
    const pattern = new RegExp(`^(?:${template.Parameters.OperatorPrincipalArn.AllowedPattern})$`)
    // Construct fixture digits rather than storing any account-like identifier.
    const fixtureAccount = '1'.repeat(12)
    for (const type of ['user', 'role']) expect(pattern.test(`arn:aws:iam::${fixtureAccount}:${type}/fixture/path`)).toBe(true)
    expect(pattern.test(`arn:aws:sts::${fixtureAccount}:assumed-role/fixture/session`)).toBe(false)
    expect(pattern.test('*')).toBe(false)
  })
  it('requires a single canonical shard and isolated table without defaults', () => {
    const shard = template.Parameters.WriterShardId
    expect(shard.Default).toBeUndefined()
    expect(template.Parameters.OperatorPrincipalArn.Default).toBeUndefined()
    expect(template.Parameters.TableName.Default).toBeUndefined()
    const pattern = new RegExp(`^(?:${shard.AllowedPattern})$`)
    for (let i = 0; i < 64; i++) expect(pattern.test(`v1:${String(i).padStart(2, '0')}`)).toBe(true)
    for (const bad of ['v1:64', 'v1:7', 'v2:07', '*', 'v1:00\nv1:01']) expect(pattern.test(bad)).toBe(false)
    expect(new RegExp(`^${template.Parameters.TableName.AllowedPattern}$`).test('unrelated-table')).toBe(false)
  })
  it('separates table discovery from item actions and enforces present leading keys', () => {
    expect(statements).toEqual([
      { Sid: 'DescribeExactReplicas', Effect: 'Allow', Action: ['dynamodb:DescribeTable'], Resource: replicas },
      { Sid: 'ReadAndConditionallyWriteOneShard', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], Resource: replicas,
        Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [{ Ref: 'WriterShardId' }] }, Null: { 'dynamodb:LeadingKeys': 'false', 'dynamodb:EnclosingOperation': 'true' } } },
    ])
    expect(role.ManagedPolicyArns).toBeUndefined()
    expect(JSON.stringify(role)).not.toMatch(/dynamodb:(Scan|Batch|Transact|Delete)|iam:PassRole|"\*"/)
    expect(statements).toHaveLength(2)
  })
  it('documents the attribute-value limitation and exports no trusted principal', () => {
    expect(template.Metadata.SecurityBoundary).toContain('cannot constrain status attribute values')
    expect(template.Metadata.SecurityBoundary).toContain('NOT a regional execution/storage fence')
    expect(template.Outputs).toEqual({ RoleArn: { Value: { 'Fn::GetAtt': ['OwnershipWriterRole', 'Arn'] } }, ShardId: { Value: { Ref: 'WriterShardId' } } })
  })
})
