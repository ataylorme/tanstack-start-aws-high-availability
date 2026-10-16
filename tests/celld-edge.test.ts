import { describe, expect, it, vi } from 'vitest'
import type { CloudFrontRequestEvent, CloudFrontRequest } from 'aws-lambda'
import { createRouter } from '../experiments/celld/routing/router.ts'
const config = { primaryRegion: 'us-east-1', publicHost: 'example.cloudfront.net', origins: {
  'us-east-1': 'east.us-east-1.elb.amazonaws.com', 'us-west-1': 'west.us-west-1.elb.amazonaws.com',
} }
function event(uri = '/api/objects/Counter/test-alpha', method = 'POST'): CloudFrontRequestEvent {
  return { Records: [{ cf: { config: { eventType: 'origin-request', distributionDomainName: 'example.cloudfront.net', distributionId: 'test', requestId: 'test' }, request: {
    uri, method, clientIp: '127.0.0.1', querystring: '', headers: { authorization: [{ key: 'Authorization', value: 'Bearer test' }],
      'x-celld-epoch': [{ key: 'X-Celld-Epoch', value: '9999' }], 'x-ha-region': [{ key: 'X-Ha-Region', value: 'us-west-1' }] },
    origin: { custom: { domainName: config.origins['us-east-1'], customHeaders: {}, port: 80, protocol: 'http', path: '', sslProtocols: ['TLSv1.2'], readTimeout: 30, keepaliveTimeout: 5 } },
  } } }] }
}
describe('celld origin-request router', () => {
  it('routes only from directory ownership and replaces untrusted hint headers', async () => {
    const lookup = vi.fn().mockResolvedValue({ activeRegion: 'us-east-1', epoch: 2 })
    const response = await createRouter(config, { lookup })(event()) as CloudFrontRequest
    expect(lookup).toHaveBeenCalledWith(58)
    expect(response.origin?.custom?.domainName).toBe(config.origins['us-east-1'])
    expect(response.headers['x-celld-epoch']?.[0]?.value).toBe('2')
    expect(response.headers['x-ha-region']).toBeUndefined()
    expect(response.headers.authorization?.[0]?.value).toBe('Bearer test')
  })
  it('routes SSR and assets to configured primary without inventing an object key', async () => {
    const lookup = vi.fn()
    for (const path of ['/', '/assets/app.js', '/_serverFn/example']) {
      const response = await createRouter(config, { lookup })(event(path)) as CloudFrontRequest
      expect(response.origin?.custom?.domainName).toBe(config.origins['us-east-1'])
      expect(response.headers['x-celld-epoch']).toBeUndefined()
    }
    expect(lookup).not.toHaveBeenCalled()
  })
  it('never adds CloudFront-disallowed transport headers', async () => {
    const value = event('/')
    value.Records[0]!.cf.request.headers['x-forwarded-proto'] = [{ key: 'X-Forwarded-Proto', value: 'http' }]
    const response = await createRouter(config, { lookup: vi.fn() })(value) as CloudFrontRequest
    expect(response.headers['x-forwarded-proto']).toBeUndefined()
    expect(response.headers['x-forwarded-host']?.[0]?.value).toBe('example.cloudfront.net')
    for (const name of Object.keys(response.headers)) {
      expect(name).not.toMatch(/^(?:connection|expect|keep-alive|proxy-authenticate|proxy-authorization|proxy-connection|trailer|upgrade|x-accel-.*|x-amz-cf-.*|x-amzn-.*|x-cache|x-edge-.*|x-forwarded-proto|x-real-ip|cloudfront-viewer-cert-pem|client-cert(?:-chain)?)$/)
    }
  })
  it.each(['POST', 'GET', 'PUT', 'DELETE'])('does not choose another owner on directory outage (%s)', async method => {
    const response = await createRouter(config, { lookup: vi.fn().mockRejectedValue(new Error('offline')) })(event(undefined, method))
    expect(response).toHaveProperty('status', '503')
  })
  it('rejects noncanonical IDs and query region overrides', async () => {
    const router = createRouter(config, { lookup: vi.fn() })
    expect(await router(event('/api/objects/Counter/test-%61'))).toHaveProperty('status', '400')
    const value = event(); value.Records[0]!.cf.request.querystring = 'region=us-west-1'
    expect(await router(value)).toHaveProperty('status', '400')
  })
  it('rejects invocation at viewer-request', async () => {
    const value = event(); value.Records[0]!.cf.config = { ...value.Records[0]!.cf.config, eventType: 'viewer-request' }
    expect(await createRouter(config, { lookup: vi.fn() })(value)).toHaveProperty('status', '503')
  })
  it('preserves WebSocket headers while routing to current owner', async () => {
    const value = event(undefined, 'GET'); value.Records[0]!.cf.request.headers.upgrade = [{ key: 'Upgrade', value: 'websocket' }]
    const result = await createRouter(config, { lookup: vi.fn().mockResolvedValue({ activeRegion: 'us-west-1', epoch: 3 }) })(value) as CloudFrontRequest
    expect(result.headers.upgrade?.[0]?.value).toBe('websocket')
    expect(result.origin?.custom?.domainName).toBe(config.origins['us-west-1'])
  })
})
