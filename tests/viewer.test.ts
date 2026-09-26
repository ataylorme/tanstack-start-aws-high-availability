import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { viewerCode } from '../scripts/viewer-code.ts'

describe('deployed CloudFront viewer function', () => {
  function execute(method: string, headers: ViewerRequest['headers']) {
    const createRequestOriginGroup = vi.fn()
    const request = { method, headers, uri: '/_server/echo', querystring: { a: { value: '1' } } }
    const code = viewerCode()
    expect(code.startsWith("import cf from 'cloudfront';\n")).toBe(true)
    const result: unknown = runInNewContext(code.replace("import cf from 'cloudfront';\n", '') + '\nhandler(event)', {
      cf: { createRequestOriginGroup }, event: { request },
    })
    expect(result).toBe(request)
    return { request, createRequestOriginGroup }
  }
  it.each(['GET', 'HEAD', 'OPTIONS'])('creates a failover group only for %s', (method) => {
    const { createRequestOriginGroup } = execute(method, { host: { value: 'example.cloudfront.net' } })
    expect(createRequestOriginGroup).toHaveBeenCalledExactlyOnceWith({
      originIds: [{ originId: 'primary-slot' }, { originId: 'secondary-slot' }],
      failoverCriteria: { statusCodes: [429, 500, 502, 503, 504, 404] },
    })
  })
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('does not enable retry for %s', (method) => {
    const { createRequestOriginGroup, request } = execute(method, { host: { value: 'example.cloudfront.net' } })
    expect(createRequestOriginGroup).not.toHaveBeenCalled()
    expect(request.uri).toBe('/_server/echo')
    expect(request.querystring).toEqual({ a: { value: '1' } })
  })
  it('overwrites spoofed forwarded host and removes viewer origin credentials', () => {
    const { request } = execute('GET', {
      host: { value: 'example.cloudfront.net' },
      'x-forwarded-host': { value: 'evil.test', multiValue: [{ value: 'evil.test' }] },
      'x-origin-verify': { value: 'forged' }, 'x-origin-slot': { value: 'secondary' },
      cookie: { value: 'session=example' }, authorization: { value: 'Bearer example' },
    })
    expect(request.headers).toEqual({
      host: { value: 'example.cloudfront.net' }, 'x-forwarded-host': { value: 'example.cloudfront.net' },
      cookie: { value: 'session=example' }, authorization: { value: 'Bearer example' },
    })
  })
  it('avoids operators unsupported by CloudFront JS 2.0', () => {
    expect(viewerCode()).not.toMatch(/\?\.|\?\?/)
  })
  it('rejects missing host', () => {
    expect(() => execute('GET', {})).toThrow('Missing viewer Host')
  })
  it('keeps the all-method behavior pointed at a single origin (AWS rejects static groups)', () => {
    const template = readFileSync('infra/global.yaml', 'utf8')
    expect(template).toContain('TargetOriginId: primary-slot')
    expect(template).not.toContain('OriginGroups:')
    expect(template).toContain('Runtime: cloudfront-js-2.0')
    expect(template).toContain('FunctionARN: !GetAtt ViewerFunction.FunctionARN')
    expect(template).toContain('EventType: origin-request')
  })
})
