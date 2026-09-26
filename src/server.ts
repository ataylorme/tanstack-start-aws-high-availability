import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { checkOrigin, publicRequest } from './lib/origin'

export default createServerEntry({
  async fetch(request) {
    const response = checkOrigin(request, process.env) ??
      await handler.fetch(publicRequest(request, process.env))
    response.headers.set('x-served-by-region', process.env.AWS_REGION ?? 'local')
    response.headers.set('cache-control', 'no-store')
    return response
  },
})
