import type { CloudFrontRequest, CloudFrontRequestEvent, CloudFrontResultResponse } from 'aws-lambda'
import { canonicalKey, shardFor } from './protocol.ts'
import type { Directory } from './directory.ts'

export interface RouterConfig {
  primaryRegion: string
  origins: Record<string, string>
  // Only this published CloudFront host is accepted; never trust viewer overrides.
  publicHost?: string
}
const reject = (status: number, message: string): CloudFrontResultResponse => ({
  status: String(status), body: message,
  headers: { 'cache-control': [{ key: 'Cache-Control', value: 'no-store' }], 'content-type': [{ key: 'Content-Type', value: 'text/plain' }] },
})
export function createRouter(config: RouterConfig, directory: Pick<Directory, 'lookup'>) {
  if ((config.publicHost !== undefined && !/^[a-z0-9-]+\.cloudfront\.net$/.test(config.publicHost)) || !config.origins[config.primaryRegion]) throw new Error('Invalid router configuration')
  return async (event: CloudFrontRequestEvent): Promise<CloudFrontRequest | CloudFrontResultResponse> => {
    const cf = event.Records[0]?.cf
    if (!cf || cf.config.eventType !== 'origin-request' || !cf.request.origin?.custom) return reject(503, 'Invalid origin-request configuration')
    const publicHost = config.publicHost ?? cf.config.distributionDomainName
    if (!/^[a-z0-9-]+\.cloudfront\.net$/.test(publicHost)) return reject(503, 'Invalid public host')
    const request = cf.request
    let region = config.primaryRegion
    let epoch: number | undefined
    let shard: number | undefined
    // These are never accepted as authority from clients or previous routing hops.
    for (const key of ['x-celld-epoch', 'x-celld-shard', 'x-celld-region', 'x-ha-region', 'x-forwarded-host', 'x-forwarded-proto']) delete request.headers[key]
    if (request.uri.startsWith('/api/')) {
      if (request.querystring) return reject(400, 'Stateful query overrides are not accepted')
      try { shard = shardFor(canonicalKey(request.uri)) } catch { return reject(400, 'Invalid canonical object path') }
      try {
        const entry = await directory.lookup(shard)
        region = entry.activeRegion
        epoch = entry.epoch
      } catch { return reject(503, 'Ownership unavailable; mutations are not replayed') }
    } else if (new URLSearchParams(request.querystring).has('region')) return reject(400, 'Region overrides are disabled')
    const domain = config.origins[region]
    if (!domain || !/^[a-zA-Z0-9.-]+\.elb\.amazonaws\.com$/.test(domain)) return reject(503, 'Unknown regional origin')
    request.origin!.custom!.domainName = domain
    request.headers.host = [{ key: 'Host', value: domain }]
    request.headers['x-forwarded-host'] = [{ key: 'X-Forwarded-Host', value: publicHost }]
    // X-Forwarded-Proto is disallowed by Lambda@Edge. The authenticated
    // worker proxy reconstructs HTTPS independently of ALB transport headers.
    request.headers['x-celld-region'] = [{ key: 'X-Celld-Region', value: region }]
    if (epoch !== undefined) request.headers['x-celld-epoch'] = [{ key: 'X-Celld-Epoch', value: String(epoch) }]
    if (shard !== undefined) request.headers['x-celld-shard'] = [{ key: 'X-Celld-Shard', value: String(shard) }]
    return request
  }
}
