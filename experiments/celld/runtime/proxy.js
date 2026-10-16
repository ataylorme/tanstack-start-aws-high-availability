import { timingSafeEqual } from 'node:crypto'

/** Authenticate the ingress before trusting headers replaced by Lambda@Edge. */
export function originRequest(request, env) {
  if (!env.ORIGIN_SECRET) {
    if (env.DEPLOYMENT_TYPE === 'aws') return { response: new Response('Origin is not configured', { status: 503 }) }
    return { request }
  }
  if (typeof env.ORIGIN_SECRET !== 'string' || !/^[a-f0-9]{64}$/.test(env.ORIGIN_SECRET)) return { response: new Response('Origin is not configured', { status: 503 }) }
  const expected = Buffer.from(env.ORIGIN_SECRET)
  const supplied = Buffer.from(request.headers.get('x-celld-origin-secret') ?? '')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { response: new Response('Forbidden', { status: 403 }) }
  const host = request.headers.get('x-forwarded-host')
  if (!host || !/^[a-z0-9-]+\.cloudfront\.net$/.test(host)) return { response: new Response('Invalid public host', { status: 400 }) }
  const url = new URL(request.url)
  url.protocol = 'https:'
  url.host = host
  url.port = ''
  return { request: new Request(url, request) }
}
