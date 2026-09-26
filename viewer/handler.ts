// CloudFront JS 2.0 is ES5.1 plus selected features, NOT full ES2022.
// Avoid optional chaining/nullish coalescing. Packaging only strips types.
interface ViewerRequest {
  method: string
  headers: Record<string, { value: string; multiValue?: { value: string }[] }>
}
declare const cf: {
  createRequestOriginGroup(config: {
    originIds: { originId: string }[]
    failoverCriteria: { statusCodes: number[] }
  }): void
}

function handler(event: { request: ViewerRequest }): ViewerRequest {
  const request = event.request
  const hostHeader = request.headers.host
  const host = hostHeader && hostHeader.value
  if (!host) throw new Error('Missing viewer Host')
  request.headers['x-forwarded-host'] = { value: host }
  delete request.headers['x-origin-verify']
  delete request.headers['x-origin-slot']
  // A static origin-group behavior cannot allow write methods. Build a group
  // per read request instead; writes keep the single origin and are never retried.
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    cf.createRequestOriginGroup({
      originIds: [{ originId: 'primary-slot' }, { originId: 'secondary-slot' }],
      failoverCriteria: { statusCodes: [429, 500, 502, 503, 504, 404] },
    })
  }
  return request
}
