import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const text = readFileSync(new URL('../experiments/celld/infra/directory-deployer.yaml', import.meta.url), 'utf8')
const template = JSON.parse(text)
const role = template.Resources.DeploymentRole
const statements = role.Properties.Policies[0].PolicyDocument.Statement

describe('MRSC directory CloudFormation execution role', () => {
  it('trusts only CloudFormation, with no runtime principals or attachments', () => {
    expect(Object.keys(template.Resources)).toEqual(['DeploymentRole'])
    expect(role.Type).toBe('AWS::IAM::Role')
    expect(role.Properties.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    })
    expect(role.Properties).not.toHaveProperty('ManagedPolicyArns')
    expect(role.Properties).not.toHaveProperty('RoleName')
    expect(template.Metadata.Scope).toContain('Never attach this role to celld, edge, or an ownership writer')
  })
  it('limits DynamoDB permissions to the exact parameterized table in three selected regions', () => {
    expect(template.Parameters.TableName).not.toHaveProperty('Default')
    expect(template.Parameters.TableName.AllowedPattern).toBe('[a-zA-Z0-9_.-]{3,255}')
    expect(statements).toHaveLength(2)
    expect(statements[0].Resource).toEqual(['us-east-1', 'us-west-2', 'us-east-2'].map(region => ({
      'Fn::Sub': `arn:\${AWS::Partition}:dynamodb:${region}:\${AWS::AccountId}:table/\${TableName}`,
    })))
    expect(statements[0].Action.every((action: string) => action.startsWith('dynamodb:') && !action.includes('*'))).toBe(true)
    expect(text).not.toMatch(/\b\d{12}\b/)
  })
  it('authorizes MRSC creation, asynchronous inspection, PITR, and resource rollback', () => {
    for (const action of ['CreateTable', 'CreateTableReplica', 'CreateGlobalTableWitness', 'DescribeTable', 'UpdateTable', 'UpdateContinuousBackups', 'DescribeContinuousBackups', 'TagResource', 'ListTagsOfResource', 'DeleteTableReplica', 'DeleteGlobalTableWitness']) {
      expect(statements[0].Action).toContain(`dynamodb:${action}`)
    }
    expect(template.Metadata.AsyncLifetime).toContain('until asynchronous replica and witness operations')
    expect(text).not.toContain('aws:SourceIp')
  })
  it('documents required replica-provisioning item actions without granting role assumption to writers', () => {
    for (const action of ['Query', 'Scan', 'GetItem', 'PutItem', 'UpdateItem', 'DeleteItem', 'BatchWriteItem']) {
      expect(statements[0].Action).toContain(`dynamodb:${action}`)
    }
    expect(template.Metadata.ProvisioningDataPermissions).toContain('not runtime ownership-writer authorization')
    expect(template.Metadata.Deployment).toContain('Caller needs separately controlled iam:PassRole')
    expect(statements.flatMap((statement: { Action: string[] }) => statement.Action)).not.toContain('iam:PassRole')
  })
  it('restricts service-linked role creation to the documented DynamoDB replication role', () => {
    expect(statements[1]).toEqual({
      Sid: 'CreateOnlyDynamoDBReplicationServiceRole', Effect: 'Allow', Action: ['iam:CreateServiceLinkedRole'],
      Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/aws-service-role/replication.dynamodb.amazonaws.com/AWSServiceRoleForDynamoDBReplication' },
      Condition: { StringEquals: { 'iam:AWSServiceName': 'replication.dynamodb.amazonaws.com' } },
    })
  })
  it('does not grant unused autoscaling, customer-key, TTL, stream, or general IAM permissions', () => {
    const actions = statements.flatMap((statement: { Action: string[] }) => statement.Action)
    for (const action of ['dynamodb:UpdateTimeToLive', 'dynamodb:EnableKinesisStreamingDestination', 'dynamodb:PutResourcePolicy', 'iam:CreateRole', 'iam:PutRolePolicy']) expect(actions).not.toContain(action)
    expect(actions.some((action: string) => /^(kms|application-autoscaling):/.test(action))).toBe(false)
    expect(template.Metadata.FeatureBoundary).toContain('Review permissions before adding those features')
  })
  it('exports the role ARN and retains the official permission sources', () => {
    expect(template.Outputs.RoleArn.Value).toEqual({ 'Fn::GetAtt': ['DeploymentRole', 'Arn'] })
    expect(template.Metadata.Sources).toContain('https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/globaltables-security.html')
  })
})
