import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { checkOrigin, publicRequest, regionSelectionCookie } from './lib/origin'

export default createServerEntry({
  async fetch(request) {
    if (process.env.APP_MODE === 'orchestration') {
      const { orchestrationEntry } = await import('./orchestration/entry.server')
      const result = await orchestrationEntry(request)
      const response = result ?? await handler.fetch(request)
      response.headers.set('cache-control', 'no-store')
      return response
    }
    const response = checkOrigin(request, process.env) ??
      await (new URL(request.url).pathname === '/api/workflows'
        ? (await import('./workflows/api.server')).workflowApi(request)
        : new URL(request.url).pathname === '/api/application-events'
          ? (await import('./events/api.server')).applicationEventsApi(request)
          : new URL(request.url).pathname === '/api/application-events/delivery'
            ? (await import('./events/delivery.server')).applicationEventDeliveryApi(request)
            : new URL(request.url).pathname === '/api/application-events/ordered'
              ? (await import('./events/ordered.server')).orderedApplicationEventsApi(request)
              : handler.fetch(publicRequest(request, process.env)))
    const cookie = response.ok ? regionSelectionCookie(request) : undefined
    if (cookie) response.headers.append('set-cookie', cookie)
    response.headers.set('x-served-by-region', process.env.AWS_REGION ?? 'local')
    response.headers.set('cache-control', 'no-store')
    return response
  },
})
