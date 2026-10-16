import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const template = JSON.parse(readFileSync(new URL('../experiments/celld/infra/regional.yaml', import.meta.url), 'utf8'))
const resources = template.Resources
const userData = resources.NodeLaunchTemplate.Properties.LaunchTemplateData.UserData['Fn::Base64']['Fn::Sub'] as string

describe('celld regional infrastructure safety contract', () => {
  it('isolates a two-AZ fleet with at least two nodes and no SSH ingress', () => {
    expect(resources.Fleet.Properties).toMatchObject({ MinSize: '2', DesiredCapacity: '2', VPCZoneIdentifier: [{ Ref: 'Subnet1' }, { Ref: 'Subnet2' }] })
    expect(resources.Subnet1.Properties.AvailabilityZone).not.toEqual(resources.Subnet2.Properties.AvailabilityZone)
    const ingress = resources.NodeSecurityGroup.Properties.SecurityGroupIngress
    expect(ingress).toEqual([{ IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, SourceSecurityGroupId: { Ref: 'AlbSecurityGroup' } }])
    expect(resources.FleetPeerIngress.Properties).toMatchObject({ FromPort: 8081, ToPort: 8081, SourceSecurityGroupId: { Ref: 'NodeSecurityGroup' } })
    expect(userData).toContain('CELLD_INTERNAL_ADDR=$PRIVATE_IP:8081')
    expect(userData).toContain('CELLD_ADVERTISE=$PRIVATE_IP:8081')
    expect(userData).not.toContain('unsafe-public-advertise')
  })
  it('gates origin requests with both CloudFront prefix list and a private header', () => {
    expect(resources.AlbSecurityGroup.Properties.SecurityGroupIngress).toEqual([{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourcePrefixListId: { Ref: 'CloudFrontPrefixListId' } }])
    expect(template.Parameters.OriginSecret).toMatchObject({ NoEcho: true, MinLength: 32 })
    expect(resources.Listener.Properties.DefaultActions[0].FixedResponseConfig.StatusCode).toBe('403')
    expect(resources.OriginRule.Properties.Conditions[0].HttpHeaderConfig).toEqual({ HttpHeaderName: 'x-celld-origin-secret', Values: [{ Ref: 'OriginSecret' }] })
    expect(JSON.stringify(template.Outputs)).not.toContain('OriginSecret')
    expect(template.Metadata.SecurityAndOperations.TransportGap).toContain('HTTP')
  })
  it('pins verified arm64 celld, uses real v0.6.2 options and IAM credentials', () => {
    expect(userData).toContain('/v0.6.2/celld-aarch64-unknown-linux-gnu.gz')
    expect(userData).toContain('4eca87c6797590000a344c1b768364e9696e8817f5fbc16193f459d2edac7cd0')
    expect(userData.indexOf('sha256sum --check -')).toBeLessThan(userData.indexOf('gzip -dc'))
    expect(userData).toContain('ExecStart=/usr/local/bin/celld --trust-forwarded-headers\n')
    expect(userData).toContain('CELLD_WATCH=/var/lib/celld')
    expect(userData).toContain('CELLD_DURABILITY=fleet')
    expect(userData).toContain('CELLD_BUCKET=s3://${FleetBucket}/${FleetPrefix}')
    expect(userData).not.toMatch(/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)|CELLD_DATA_DIR|npm /)
    const launch = resources.NodeLaunchTemplate.Properties.LaunchTemplateData
    expect(launch.MetadataOptions.HttpTokens).toBe('required')
    expect(launch.InstanceType).toBe('t4g.medium')
    expect(launch.BlockDeviceMappings[0].Ebs).toMatchObject({ Encrypted: true, VolumeSize: 50, VolumeType: 'gp3' })
  })
  it('retains private encrypted versioned fleet history and limits node storage privileges', () => {
    expect(resources.FleetBucket).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: { VersioningConfiguration: { Status: 'Enabled' }, BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } } })
    expect(Object.values(resources.FleetBucket.Properties.PublicAccessBlockConfiguration)).toEqual([true, true, true, true])
    expect(resources.FleetBucket.Properties.LifecycleConfiguration).toBeUndefined()
    expect(resources.BucketPolicy.Properties.PolicyDocument.Statement[0].Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } })
    const policy = resources.NodeRole.Properties.Policies[0].PolicyDocument.Statement
    expect(policy[2].Resource).toEqual({ 'Fn::Sub': '${FleetBucket.Arn}/${FleetPrefix}/*' })
    expect(JSON.stringify(policy)).not.toContain('s3:*')
  })
  it('ships bounded-retention node logs with scoped IAM and rotation', () => {
    expect(resources.NodeLogGroup.Properties.RetentionInDays).toBe(14)
    expect(resources.NodeRole.Properties.Policies[1].PolicyDocument.Statement).toEqual([{
      Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: { 'Fn::GetAtt': ['NodeLogGroup', 'Arn'] },
    }])
    expect(userData).toContain('dnf install -y gzip amazon-cloudwatch-agent logrotate')
    expect(userData).toContain('StandardOutput=append:/var/log/celld.log')
    expect(userData).toContain('StandardError=append:/var/log/celld.log')
    expect(userData).toContain('"log_group_name":"${NodeLogGroup}"')
    expect(userData).toContain('"log_stream_name":"{instance_id}"')
    expect(userData).toContain('maxsize 100M')
    expect(template.Metadata.SecurityAndOperations.ForwardedHeaders).toContain('edge must replace')
  })
  it('quarantines recovery archives away from runtime with retained private history', () => {
    expect(resources.ArchiveBucket).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    } })
    expect(Object.values(resources.ArchiveBucket.Properties.PublicAccessBlockConfiguration)).toEqual([true, true, true, true])
    expect(resources.ArchiveBucket.Properties.LifecycleConfiguration).toBeUndefined()
    expect(resources.ArchiveBucket.Properties.ReplicationConfiguration).toBeUndefined()
    expect(resources.ArchiveBucketPolicy.Properties.PolicyDocument.Statement[0].Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } })
    expect(resources.NodeRole.Properties.Policies[2].PolicyDocument.Statement[0]).toEqual({
      Effect: 'Deny', Action: 's3:*', Resource: [{ 'Fn::GetAtt': ['ArchiveBucket', 'Arn'] }, { 'Fn::Sub': '${ArchiveBucket.Arn}/*' }],
    })
    expect(userData).not.toContain('ArchiveBucket')
    expect(template.Metadata.SecurityAndOperations.RecoveryArchive).toContain('validated epoch bootstrap')
  })
  it('enables prefix-preserving archive replication only with both parameters', () => {
    expect(template.Parameters.ReplicationDestinationArn.Default).toBe('')
    expect(template.Parameters.ReplicationSourceBucketName.Default).toBe('')
    expect(template.Conditions.ReplicationEnabled['Fn::And']).toHaveLength(2)
    expect(template.Rules.ReplicationParametersTogether.Assertions).toHaveLength(1)
    expect(template.Rules.ReplicationParametersTogether.Assertions[0].Assert['Fn::Or']).toHaveLength(2)
    // Fn::Equals operands must be strings, not nested boolean results.
    for (const branch of template.Rules.ReplicationParametersTogether.Assertions[0].Assert['Fn::Or']) {
      for (const operand of branch['Fn::And']) {
        const equals = operand['Fn::Equals'] ?? operand['Fn::Not'][0]['Fn::Equals']
        expect(equals[1]).toBe('')
        expect(equals[0]).toHaveProperty('Ref')
      }
    }
    const conditional = resources.FleetBucket.Properties.ReplicationConfiguration['Fn::If']
    expect(conditional[0]).toBe('ReplicationEnabled')
    expect(conditional[2]).toEqual({ Ref: 'AWS::NoValue' })
    const rule = conditional[1].Rules[0]
    expect(rule.Filter).toEqual({ Prefix: { 'Fn::Sub': '${FleetPrefix}/' } })
    expect(rule.DeleteMarkerReplication.Status).toBe('Disabled')
    expect(rule.Destination.Bucket).toEqual({ Ref: 'ReplicationDestinationArn' })
    expect(rule.Destination.Metrics.Status).toBe('Enabled')
    expect(rule.Destination.ReplicationTime).toBeUndefined()
    expect(rule.Destination.Metrics.EventThreshold).toBeUndefined()
    expect(resources.ReplicationRole.Condition).toBe('ReplicationEnabled')
    const policy = resources.ReplicationRole.Properties.Policies[0].PolicyDocument.Statement
    expect(policy[0].Resource).toEqual({ 'Fn::Sub': 'arn:${AWS::Partition}:s3:::${ReplicationSourceBucketName}' })
    expect(policy[1].Action).toEqual(['s3:GetObjectVersionForReplication', 's3:GetObjectVersionAcl', 's3:GetObjectVersionTagging'])
    expect(policy[2]).toEqual({ Effect: 'Allow', Action: ['s3:ReplicateObject', 's3:ReplicateTags'], Resource: { 'Fn::Sub': '${ReplicationDestinationArn}/${FleetPrefix}/*' } })
    expect(JSON.stringify(resources.ReplicationRole)).not.toContain('FleetBucket')
  })
  it('places replication warnings in the correct publishing regions with exact bucket scopes', () => {
    const failure = resources.ReplicationFailuresAlarm
    expect(failure.Condition).toBe('ReplicationEnabled')
    expect(failure.Properties).toMatchObject({ Namespace: 'AWS/S3', MetricName: 'OperationsFailedReplication', Statistic: 'Sum', Threshold: 0, TreatMissingData: 'ignore' })
    expect(failure.Properties.Dimensions).toEqual([
      { Name: 'SourceBucket', Value: { Ref: 'ReplicationSourceBucketName' } },
      { Name: 'DestinationBucket', Value: { 'Fn::Select': [5, { 'Fn::Split': [':', { Ref: 'ReplicationDestinationArn' }] }] } },
      { Name: 'RuleId', Value: 'FleetRecoveryArchive' },
    ])
    expect(resources.ReplicationRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource).toEqual({ 'Fn::Sub': 'arn:${AWS::Partition}:s3:::${ReplicationSourceBucketName}' })
    const backlog = resources.ArchiveBacklogAlarm
    expect(backlog.Condition).toBe('ArchiveMonitoringEnabled')
    expect(template.Parameters.ArchiveSourceBucketName.Default).toBe('')
    expect(template.Conditions.ArchiveMonitoringEnabled).toEqual({ 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'ArchiveSourceBucketName' }, ''] }] })
    expect(backlog.Properties).toMatchObject({ Namespace: 'AWS/S3', MetricName: 'BytesPendingReplication', Statistic: 'Maximum', Threshold: 0, TreatMissingData: 'ignore' })
    expect(backlog.Properties.Dimensions).toEqual([
      { Name: 'SourceBucket', Value: { Ref: 'ArchiveSourceBucketName' } },
      { Name: 'DestinationBucket', Value: { Ref: 'ArchiveBucket' } },
      { Name: 'RuleId', Value: 'FleetRecoveryArchive' },
    ])
    expect(backlog.Properties.AlarmDescription).toContain('not proof of data loss')
    expect(template.Metadata.SecurityAndOperations.ReplicationMonitoring).toContain('RTC remains disabled')
  })
  it('checks native readiness and exposes alarms without claiming deployed validation', () => {
    expect(resources.TargetGroup.Properties.HealthCheckPath).toBe('/.well-known/celld/health')
    for (const name of ['HealthyNodesAlarm', 'FleetCapacityAlarm', 'HighCpuAlarm']) expect(resources[name].Type).toBe('AWS::CloudWatch::Alarm')
    expect(resources.Fleet.Properties.HealthCheckType).toBe('EC2')
    expect(resources.HighCpuAlarm.Properties.Period).toBe(300)
    expect(resources.Alb.DependsOn).toEqual(['InternetRoute', 'Subnet1Route', 'Subnet2Route'])
    expect(template.Metadata.SecurityAndOperations.Health).toContain('NOT runtime readiness')
    expect(template.Metadata.SecurityAndOperations.Storage).toContain('No regional writable promotion')
    expect(Object.keys(template.Outputs)).toEqual(['BucketName', 'AlbDnsName', 'AutoScalingGroupName', 'NodeRoleArn', 'TargetGroupArn', 'ArchiveBucketName', 'ArchiveBucketArn'])
  })
})
