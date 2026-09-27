import { ReceiveMessageCommand, SQSClient, type ReceiveMessageCommandOutput } from '@aws-sdk/client-sqs'
import { authorized, validRunId } from '../workflows/api.server'

export interface EventDeliveryClient {
  send(command: ReceiveMessageCommand): Promise<Pick<ReceiveMessageCommandOutput, 'Messages'>>
}

// A bounded, non-destructive queue peek. Pending is inconclusive: SQS may return
// an empty/subset batch, and another observer may temporarily hide a message.
export async function applicationEventDeliveryApi(request: Request, client?: EventDeliveryClient): Promise<Response> {
  if (!authorized(request, process.env.WORKFLOW_TEST_TOKEN)) return Response.json({ error: 'Test token required' }, { status: 401 })
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } })
  const queueUrl = process.env.EVENT_TEST_QUEUE_URL
  if (!queueUrl) return Response.json({ error: 'Event delivery observation not configured' }, { status: 503 })
  let id: string
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
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!input || typeof input !== 'object' || !('id' in input) || !validRunId(input.id) || Object.keys(input).length !== 1) {
      throw new Error('Invalid ID')
    }
    id = input.id
  } catch { return Response.json({ error: 'Invalid test event ID' }, { status: 400 }) }
  let ownedClient: SQSClient | undefined
  try {
    const sqs = client ?? (ownedClient = new SQSClient({
      region: 'us-east-1', maxAttempts: 1, // A single peek must not hide a second batch on retry.
      requestHandler: { connectionTimeout: 1_000, requestTimeout: 4_000, throwOnRequestTimeout: true },
    }))
    const result = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, VisibilityTimeout: 5,
    }))
    for (const message of result.Messages ?? []) {
      let event
      try { event = JSON.parse(message.Body ?? '') } catch { continue }
      if (event?.id === id && event.type === 'ha.validation.event' && event.version === 1 &&
          typeof event.timestamp === 'string' && typeof event.data?.message === 'string' && event.data.message.length <= 200) {
        // Return only the public test envelope, never SQS metadata or extra fields.
        return Response.json({ status: 'observed', event: {
          id, type: event.type, version: event.version, timestamp: event.timestamp, data: { message: event.data.message },
        } })
      }
    }
    return Response.json({ status: 'pending' })
  } catch { return Response.json({ error: 'Event delivery observation unavailable; retry later' }, { status: 503 }) }
  finally { ownedClient?.destroy() }
}
