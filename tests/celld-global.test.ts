import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const template = JSON.parse(readFileSync('experiments/celld/infra/global.yaml', 'utf8'))
const resources = template.Resources
describe('celld CloudFront security contract', () => {
  it('gives edge only GetItem access to the two explicit directory replicas', () => {
    const statements = resources.EdgeRole.Properties.Policies[0].PolicyDocument.Statement
    const dynamodb = statements.filter((entry: any) => entry.Action.some((action: string) => action.startsWith('dynamodb:')))
    expect(dynamodb).toHaveLength(1)
    expect(dynamodb[0].Action).toEqual(['dynamodb:GetItem'])
    expect(dynamodb[0].Resource).toHaveLength(2)
    expect(JSON.stringify(dynamodb)).not.toContain('dynamodb:*')
  })
  it('uses numbered origin-request Lambda version, not viewer origin mutation', () => {
    const behavior = resources.Distribution.Properties.DistributionConfig.DefaultCacheBehavior
    expect(behavior.LambdaFunctionAssociations).toEqual([{ EventType: 'origin-request', IncludeBody: false, LambdaFunctionARN: { Ref: 'EdgeVersion' } }])
    expect(resources.EdgeRouter.Properties.Environment).toBeUndefined()
    expect(resources.EdgeRouter.Properties.Architectures).toEqual(['x86_64'])
  })
  it('disables caching and does not configure health-driven origin failover', () => {
    const distribution = resources.Distribution.Properties.DistributionConfig
    expect(distribution.DefaultCacheBehavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad')
    expect(distribution.OriginGroups).toBeUndefined()
    expect(distribution.DefaultCacheBehavior.AllowedMethods).toContain('POST')
    expect(distribution.CustomErrorResponses.every((entry: any) => entry.ErrorCachingMinTTL === 0)).toBe(true)
  })
  it('forwards cookies/auth/socket headers and keeps origin secret NoEcho', () => {
    expect(resources.ForwardViewer.Properties.OriginRequestPolicyConfig.HeadersConfig.HeaderBehavior).toBe('allViewer')
    expect(template.Parameters.OriginSecret.NoEcho).toBe(true)
    expect(resources.Distribution.Properties.DistributionConfig.Origins[0].OriginCustomHeaders).toEqual([{ HeaderName: 'x-celld-origin-secret', HeaderValue: { Ref: 'OriginSecret' } }])
  })
})
