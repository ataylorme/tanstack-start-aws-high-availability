import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The template uses JSON's YAML-compatible syntax, so no parser dependency is needed.
const source = readFileSync(new URL('../experiments/celld/infra/directory.yaml', import.meta.url), 'utf8')
const template = JSON.parse(source)
const resource = template.Resources.Directory
const properties = resource.Properties

describe('celld MRSC directory template option', () => {
  it('requires explicit table and supported western replica selection', () => {
    expect(template.Parameters.TableName).not.toHaveProperty('Default')
    expect(template.Parameters.WesternReplicaRegion).not.toHaveProperty('Default')
    expect(template.Parameters.WesternReplicaRegion.AllowedValues).toEqual(['us-west-2'])
    expect(properties.TableName).toEqual({ Ref: 'TableName' })
    expect(template.Metadata.TopologyDecision.DeploymentRequirement).toContain('refuse deployment absent explicit DIRECTORY_WEST_REGION=us-west-2')
  })
  it('records the unsupported original topology without silently relocating fleets', () => {
    const decision = template.Metadata.TopologyDecision
    expect(decision.Status).toBe('REQUIRES_EXPLICIT_OPERATOR_SELECTION')
    expect(decision.RequestedWesternFleetRegion).toBe('us-west-1')
    expect(decision.RequestedDirectoryReplicaSupported).toBe(false)
    expect(decision.Reason).toContain('does not move the celld fleet or authorize deployment')
    expect(decision.RegionalLatencyCaveat).toContain('measure the cross-region latency')
    expect(decision.DeploymentRegion).toBe('us-east-1')
  })
  it('defines exactly two MRSC replicas and the independent east2 witness', () => {
    expect(Object.keys(template.Resources)).toEqual(['Directory'])
    expect(resource.Type).toBe('AWS::DynamoDB::GlobalTable')
    expect(properties.MultiRegionConsistency).toBe('STRONG')
    expect(properties.Replicas.map((replica: { Region: unknown }) => replica.Region))
      .toEqual(['us-east-1', { Ref: 'WesternReplicaRegion' }])
    expect(properties.GlobalTableWitnesses).toEqual([{ Region: 'us-east-2' }])
    expect(properties.BillingMode).toBe('PAY_PER_REQUEST')
  })
  it('retains ownership state and enables protection and PITR on both replicas', () => {
    expect(resource.DeletionPolicy).toBe('Retain')
    expect(resource.UpdateReplacePolicy).toBe('Retain')
    for (const replica of properties.Replicas) {
      expect(replica.DeletionProtectionEnabled).toBe(true)
      expect(replica.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true })
    }
  })
  it('uses only the single shardId partition key with no TTL or multi-item assumptions', () => {
    expect(properties.AttributeDefinitions).toEqual([{ AttributeName: 'shardId', AttributeType: 'S' }])
    expect(properties.KeySchema).toEqual([{ AttributeName: 'shardId', KeyType: 'HASH' }])
    for (const absent of ['TimeToLiveSpecification', 'LocalSecondaryIndexes', 'GlobalSecondaryIndexes', 'StreamSpecification']) {
      expect(properties).not.toHaveProperty(absent)
    }
    const contract = template.Metadata.DirectoryContract
    expect(contract.ReadRequirement).toContain('ConsistentRead=true')
    expect(contract.MutationRequirement).toContain('Single-item conditional writes only')
    expect(contract.MutationRequirement).toContain('Never infer an atomic multi-item snapshot')
    expect(contract.ExpiryRequirement).toContain('not DynamoDB TTL')
    expect(contract.ExecutionFence).toContain('not a celld storage/execution fence')
    expect(contract.ExecutionFence).toContain('promotion remains disabled')
  })
  it('outputs exact table references without account IDs, broad IAM grants or seeded state', () => {
    expect(template.Outputs.DirectoryTableArn.Value).toEqual({ 'Fn::GetAtt': ['Directory', 'Arn'] })
    expect(template.Outputs.WesternDirectoryTableArn.Value['Fn::Sub'])
      .toBe('arn:${AWS::Partition}:dynamodb:${WesternReplicaRegion}:${AWS::AccountId}:table/${TableName}')
    expect(source).not.toMatch(/\b\d{12}\b/)
    expect(source).not.toContain('AWS::IAM::')
    expect(source).not.toContain('Custom::')
  })
  it('retains official support and limitations evidence', () => {
    expect(template.Metadata.Sources).toContain('https://aws.amazon.com/about-aws/whats-new/2026/09/dynamodb-mrsc-additional-regions/')
    expect(template.Metadata.Sources).toContain('https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html')
  })
})
