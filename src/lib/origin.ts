import { timingSafeEqual } from 'node:crypto'

export interface OriginEnvironment {
  AWS_LAMBDA_FUNCTION_NAME?: string
  AWS_REGION?: string
  ORIGIN_SECRET?: string
  RELEASE_ID?: string
  SIMULATE_FAILURE?: string
}

export function regionInfo(env: OriginEnvironment) {
  return {
    region: env.AWS_REGION ?? 'local',
    release: env.RELEASE_ID ?? 'development',
    timestamp: new Date().toISOString(),
  }
}

export function checkOrigin(request: Request, env: OriginEnvironment): Response | undefined {
  const pathname = new URL(request.url).pathname
  // Adapter readiness is deliberately independent of simulated origin failure.
  // No application data is exposed by this unauthenticated endpoint.
  if (pathname === '/readyz') return new Response('ready')
  const secret = env.ORIGIN_SECRET
  if (env.AWS_LAMBDA_FUNCTION_NAME && !secret) {
    return new Response('Origin is not configured', { status: 503 })
  }
  if (secret) {
    const supplied = Buffer.from(request.headers.get('x-origin-verify') ?? '')
    const expected = Buffer.from(secret)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return new Response('Forbidden', { status: 403 })
    }
  }
  if (env.SIMULATE_FAILURE === 'true') return new Response('Simulated regional outage', { status: 503 })
  if (pathname === '/healthz') return Response.json({ status: 'ok', ...regionInfo(env) })
  return undefined
}

export function publicRequest(request: Request, env: OriginEnvironment): Request {
  // Only trust forwarded headers after checkOrigin authenticated the edge path.
  if (!env.ORIGIN_SECRET) return request
  const host = request.headers.get('x-forwarded-host')
  if (!host || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) return request
  const url = new URL(request.url)
  url.port = ''
  url.host = host
  url.protocol = 'https:'
  return new Request(url, request)
}

/** Persist only an explicit, valid region choice made by a page link. */
export function regionSelectionCookie(request: Request): string | undefined {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.pathname !== '/') return undefined
  const region = url.searchParams.get('region')
  if (region !== 'us-east-1' && region !== 'us-west-2') return undefined
  return `ha-region=${region}; Path=/; HttpOnly; Secure; SameSite=Lax`
}
