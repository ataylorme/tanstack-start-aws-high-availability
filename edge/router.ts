import { createHash } from 'node:crypto'
import type { CloudFrontRequest, CloudFrontRequestEvent } from 'aws-lambda'

export type Region = 'us-east-1' | 'us-west-2'
export interface RoutingConfig {
  eastDomain: string
  westDomain: string
}

export function parseConfig(value: unknown): RoutingConfig {
  if (typeof value !== 'object' || value === null ||
      !('eastDomain' in value) || !('westDomain' in value) ||
      typeof value.eastDomain !== 'string' || typeof value.westDomain !== 'string' ||
      !/^[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws$/.test(value.eastDomain) ||
      !/^[a-z0-9]+\.lambda-url\.us-west-2\.on\.aws$/.test(value.westDomain)) {
    throw new Error('Expected Lambda Function URL domains in us-east-1 and us-west-2')
  }
  return { eastDomain: value.eastDomain, westDomain: value.westDomain }
}

export function preferredRegion(request: CloudFrontRequest): Region {
  // An intentional, public demo override. It selects only these two origins.
  const override = request.headers['x-ha-region']?.[0]?.value
  if (override === 'us-east-1' || override === 'us-west-2') return override
  // Stable across the two origin attempts; not a promise of equal request volume.
  const byte = createHash('sha256').update(request.clientIp).digest().readUInt8(0)
  return byte < 128 ? 'us-east-1' : 'us-west-2'
}

export function routeRequest(event: CloudFrontRequestEvent, config: RoutingConfig): CloudFrontRequest {
  const cf = event.Records[0]?.cf
  if (!cf) throw new Error('Missing CloudFront event')
  const request = cf.request
  if (cf.config.eventType !== 'origin-request') throw new Error('Unsupported event type')
  const origin = request.origin?.custom
  if (!origin) throw new Error('Expected custom origin')
  // Read CloudFront configuration, NEVER the viewer-supplied request header.
  const slot = origin.customHeaders['x-origin-slot']?.[0]?.value
  if (slot !== 'primary' && slot !== 'secondary') throw new Error('Missing origin slot')
  const preferred = preferredRegion(request)
  const region = slot === 'primary' ? preferred :
    preferred === 'us-east-1' ? 'us-west-2' : 'us-east-1'
  const domain = region === 'us-east-1' ? config.eastDomain : config.westDomain
  origin.domainName = domain
  request.headers.host = [{ key: 'Host', value: domain }]
  return request
}
