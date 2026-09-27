import { ApplicationEventConflictError, createDynamoApplicationEventPublisher, type ApplicationEventPublisher } from '@ataylorme/tanstack-workflow-aws/events'
import candidate from './package-provenance.json'
import { authorized, validRunId } from '../workflows/api.server'

export function parseEvent(value: unknown) {
  if (!value || typeof value !== 'object' || !('id' in value) || !validRunId(value.id) ||
      !('message' in value) || typeof value.message !== 'string' || value.message.length > 200 ||
      Object.keys(value).some(key => !['id', 'message'].includes(key))) throw new Error('Invalid test event')
  return { id: value.id, type: 'ha.validation.event', version: 1, data: { message: value.message } }
}

// Publication acknowledges durable storage only, not asynchronous consumer delivery.
export async function applicationEventsApi(request: Request, publisher?: ApplicationEventPublisher): Promise<Response> {
  if (!authorized(request, process.env.WORKFLOW_TEST_TOKEN)) return Response.json({ error: 'Test token required' }, { status: 401 })
  if (!process.env.TABLE_NAME) return Response.json({ error: 'Events not configured' }, { status: 503 })
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } })
  let input: ReturnType<typeof parseEvent>
  try {
    const reader = request.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2048) {
          await reader.cancel()
          return Response.json({ error: 'Payload too large' }, { status: 413 })
        }
        chunks.push(value)
      }
    }
    input = parseEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch { return Response.json({ error: 'Invalid test event' }, { status: 400 }) }
  try {
    const event = await (publisher ?? createDynamoApplicationEventPublisher({ tableName: process.env.TABLE_NAME })).publish(input)
    return Response.json(event, { status: 202, headers: { 'x-event-candidate': candidate.commit, 'x-event-artifact': candidate.sha256, 'x-event-release': process.env.RELEASE_ID ?? 'local' } })
  } catch (error) {
    if (error instanceof ApplicationEventConflictError) return Response.json({ error: 'Event ID conflict' }, { status: 409 })
    // A write may have committed despite a response failure: callers retry the SAME ID.
    return Response.json({ error: 'Publication unavailable; retry the same event ID' }, { status: 503 })
  }
}
