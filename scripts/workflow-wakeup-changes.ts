export interface WakeupResourceChange {
  Action: string
  LogicalResourceId: string
  ResourceType?: string
  Replacement?: string
  Details?: Array<{
    Target?: { Attribute?: string; Name?: string; RequiresRecreation?: string }
    Evaluation?: string
    ChangeSource?: string
    CausingEntity?: string
  }>
}

export function assertSafeWakeupChange(resource: WakeupResourceChange): void {
  // Adding a Condition to the retained rule makes its ARN a dynamic reference.
  // CloudFormation may recreate only this legacy invoke permission as a result.
  const legacyPermissionReference = resource.LogicalResourceId === 'SweepPermission' &&
    resource.ResourceType === 'AWS::Lambda::Permission' && resource.Action === 'Modify' &&
    resource.Replacement === 'Conditional' && resource.Details?.length === 1 &&
    resource.Details.every((detail) => detail.Target?.Attribute === 'Properties' &&
      detail.Target.Name === 'SourceArn' && detail.Target.RequiresRecreation === 'Always' &&
      detail.Evaluation === 'Dynamic' && detail.ChangeSource === 'ResourceAttribute' &&
      detail.CausingEntity === 'SweepRule.Arn')
  if ((resource.Replacement && resource.Replacement !== 'False' && !legacyPermissionReference) ||
      (resource.Action === 'Remove' && !['SweepRule', 'SweepPermission'].includes(resource.LogicalResourceId))) {
    throw new Error(`Unsafe replacement/removal: ${resource.LogicalResourceId}`)
  }
}
