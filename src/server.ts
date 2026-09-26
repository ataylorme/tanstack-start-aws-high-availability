import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { checkOrigin, publicRequest, regionSelectionCookie } from './lib/origin'

export default createServerEntry({
  async fetch(request) {
    const response = checkOrigin(request, process.env) ??
      await handler.fetch(publicRequest(request, process.env))
    const cookie = response.ok ? regionSelectionCookie(request) : undefined
    if (cookie) response.headers.append('set-cookie', cookie)
    response.headers.set('x-served-by-region', process.env.AWS_REGION ?? 'local')
    response.headers.set('cache-control', 'no-store')
    return response
  },
})
