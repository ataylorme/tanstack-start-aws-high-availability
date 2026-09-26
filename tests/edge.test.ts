import type { CloudFrontRequest, CloudFrontRequestEvent } from 'aws-lambda'
import { describe, expect, it } from 'vitest'
import { parseConfig, preferredRegion, routeRequest } from '../edge/router.ts'

const config = {
  eastDomain: 'east123.lambda-url.us-east-1.on.aws',
  westDomain: 'west456.lambda-url.us-west-2.on.aws',
}

function request(slot = 'primary', clientIp = '192.0.2.1'): CloudFrontRequest {
  return {
    clientIp, method: 'POST', uri: '/api/example', querystring: 'a=1&a=2&encoded=%2F',
    headers: {
      host: [{ key: 'Host', value: 'example.cloudfront.net' }],
      cookie: [{ key: 'Cookie', value: 'session=example' }],
      authorization: [{ key: 'Authorization', value: 'Bearer example' }],
    },
    body: { action: 'read-only', data: 'payload', encoding: 'text', inputTruncated: false },
    origin: { custom: {
      domainName: config.eastDomain, port: 443, protocol: 'https', path: '',
      keepaliveTimeout: 5, readTimeout: 30, sslProtocols: ['TLSv1.2'],
      customHeaders: {
        'x-origin-slot': [{ key: 'X-Origin-Slot', value: slot }],
        'x-origin-verify': [{ key: 'X-Origin-Verify', value: 'secret' }],
      },
    } },
  }
}

function event(input: CloudFrontRequest, eventType: 'origin-request' | 'viewer-request' | 'origin-response' = 'origin-request'): CloudFrontRequestEvent {
  return { Records: [{ cf: {
    config: { distributionDomainName: 'example.cloudfront.net', distributionId: 'EXAMPLE', eventType, requestId: 'request-id' },
    request: input,
  } }] }
}

describe('routing configuration', () => {
  it('accepts only the two expected regional Function URL domains', () => {
    expect(parseConfig(config)).toEqual(config)
  })

  it.each([null, undefined, [], {}, { ...config, eastDomain: 42 },
    { ...config, eastDomain: 'https://east123.lambda-url.us-east-1.on.aws' },
    { ...config, eastDomain: config.westDomain },
    { ...config, westDomain: 'west456.lambda-url.us-west-2.on.aws.attacker.test' },
  ])('rejects invalid configuration %#', (value) => {
    expect(() => parseConfig(value)).toThrow('Expected Lambda Function URL domains')
  })
})

describe('active/active origin selection', () => {
  it.each([
    ['primary', 'us-east-1', config.eastDomain],
    ['secondary', 'us-east-1', config.westDomain],
    ['primary', 'us-west-2', config.westDomain],
    ['secondary', 'us-west-2', config.eastDomain],
  ])('routes %s with preference %s to %s', (slot, preference, domain) => {
    const input = request(slot)
    input.headers['x-ha-region'] = [{ value: preference }]
    input.headers['x-origin-slot'] = [{ value: slot === 'primary' ? 'secondary' : 'primary' }]
    const before = structuredClone(input)
    const result = routeRequest(event(input), config)
    expect(result).toBe(input)
    expect(result.origin?.custom?.domainName).toBe(domain)
    expect(result.headers.host).toEqual([{ key: 'Host', value: domain }])
    expect(result).toMatchObject({ method: before.method, uri: before.uri, querystring: before.querystring, body: before.body })
    expect(result.headers.cookie).toEqual(before.headers.cookie)
    expect(result.headers.authorization).toEqual(before.headers.authorization)
    expect(result.origin?.custom?.customHeaders).toEqual(before.origin?.custom?.customHeaders)
  })

  it('uses stable IP affinity reaching both regions and ignores invalid overrides', () => {
    const regions = new Set<string>()
    for (let index = 1; index <= 100; index += 1) {
      const input = request('primary', `192.0.2.${index}`)
      const selected = preferredRegion(input)
      expect(preferredRegion(structuredClone(input))).toBe(selected)
      input.headers['x-ha-region'] = [{ value: 'attacker.test' }]
      expect(preferredRegion(input)).toBe(selected)
      regions.add(selected)
    }
    expect(regions).toEqual(new Set(['us-east-1', 'us-west-2']))
  })

  it('fails closed on absent event, origin, or slot', () => {
    expect(() => routeRequest({ Records: [] }, config)).toThrow('Missing CloudFront event')
    const input = request()
    delete input.origin
    expect(() => routeRequest(event(input), config)).toThrow('Expected custom origin')
    expect(() => routeRequest(event(request('invalid')), config)).toThrow('Missing origin slot')
    const missingSlot = request()
    if (!missingSlot.origin?.custom) throw new Error('Invalid test fixture')
    delete missingSlot.origin.custom.customHeaders['x-origin-slot']
    missingSlot.headers['x-origin-slot'] = [{ value: 'primary' }]
    expect(() => routeRequest(event(missingSlot), config)).toThrow('Missing origin slot')
    expect(() => routeRequest(event(request(), 'origin-response'), config)).toThrow('Unsupported event type')
  })
})
