import type { Context, DynamoDBStreamEvent } from 'aws-lambda'
import { createWorkflowStreamRouter, createWorkflowWorker, createApplicationQueueHandler } from '@ataylorme/tanstack-workflow-aws/wakeups'
import { createAwsWorkflowTransport, createApplicationQueuePublisher } from '@ataylorme/tanstack-workflow-aws/aws'
import { createSnsBridge } from '@ataylorme/tanstack-workflow-aws/bridges/sns'
import { applicationEventGroupId } from '@ataylorme/tanstack-workflow-aws/ordered-events'
import { SNSClient } from '@aws-sdk/client-sns'
import { createTaskApi } from './api'
import { object } from './domain'
import { required, services } from './services.server'
import type { AppRole } from './types'
const roles: readonly AppRole[] = ['http', 'router', 'worker', 'executor', 'relay', 'sandbox']
export function invocationContext(header: string | null, now = Date.now): Context {
  const value = object(JSON.parse(header ?? '{}'))
  if (typeof value.deadline !== 'number' || !Number.isFinite(value.deadline) || typeof value.request_id !== 'string') throw new Error('Missing trusted invocation context')
  const deadline = value.deadline
  return { awsRequestId: value.request_id, getRemainingTimeInMillis: () => Math.max(0, deadline - now()), callbackWaitsForEmptyEventLoop: false, functionName: process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'local', functionVersion: '$LATEST', invokedFunctionArn: '', memoryLimitInMB: '512', logGroupName: '', logStreamName: '', done: () => {}, fail: () => {}, succeed: () => {} }
}
export async function orchestrationEntry(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname
  const role = process.env.APP_ROLE ?? 'http'
  if (!roles.includes(role as AppRole)) return new Response('Invalid application role', { status: 503 })
  if (path === '/readyz' || path === '/healthz') return Response.json({ status: 'ok', role })
  if (role === 'http') {
    if (path.startsWith('/internal/') || (path.startsWith('/api/') && !path.startsWith('/api/tasks'))) return new Response('Not found', { status: 404 })
    if (path.startsWith('/api/tasks')) {
      try { return await createTaskApi({ ...services(), requesterToken: required('REQUESTER_TOKEN'), approverToken: required('APPROVER_TOKEN') })(request) }
      catch (error) { console.error(JSON.stringify({ kind: 'task_api_error', error: error instanceof Error ? error.name : 'UnknownError' })); return Response.json({ error: 'Service temporarily unavailable; retry with the same idempotency key' }, { status: 503 }) }
    }
    return undefined
  }
  // No function URL exists for these roles. Caller-provided HTTP role headers are never used.
  if (path !== '/internal/events' || request.method !== 'POST') return new Response('Not found', { status: 404 })
  try {
    const context = invocationContext(request.headers.get('x-amzn-lambda-context'))
    if (context.getRemainingTimeInMillis() < 5000) throw new Error('Insufficient invocation budget')
    const event: unknown = await request.json()
    if (role === 'sandbox') return Response.json({ ok: true })
    if (role === 'executor') {
      const input = object(event)
      if (Object.keys(input).length !== 1 || typeof input.taskId !== 'string' || !/^task-[a-f0-9]{64}$/.test(input.taskId)) throw new Error('Invalid execution command')
      return Response.json(await services().executor(input.taskId))
    }
    const envelope = object(event)
    if (!Array.isArray(envelope.Records) || envelope.Records.length > 100) throw new Error('Expected bounded event batch')
    for (const record of envelope.Records) {
      const item = object(record)
      if (role === 'router') { const db = object(item.dynamodb); if (item.eventSource !== 'aws:dynamodb' || typeof db.SequenceNumber !== 'string') throw new Error('Invalid stream record') }
      else if (item.eventSource !== 'aws:sqs' || typeof item.messageId !== 'string' || typeof item.body !== 'string') throw new Error('Invalid queue record')
    }
    if (role === 'relay') {
      const relay = createApplicationQueueHandler(createSnsBridge({ topicArn: required('APPLICATION_TOPIC_ARN'), messageGroupId: applicationEventGroupId, client: new SNSClient({ maxAttempts: 2 }) }), { fifo: true })
      return Response.json(await relay(event as Parameters<typeof relay>[0], context))
    }
    const transport = createAwsWorkflowTransport({ tableName: required('WORKFLOW_TABLE_NAME'), queueUrl: required('WAKEUP_QUEUE_URL'), queueArn: required('WAKEUP_QUEUE_ARN'), group: required('SCHEDULE_GROUP'), roleArn: required('SCHEDULER_ROLE_ARN'), dlqArn: required('SCHEDULER_DLQ_ARN') })
    if (role === 'router') {
      const route = createWorkflowStreamRouter({ transport, publishApplicationEvent: createApplicationQueuePublisher({ queueUrl: required('APPLICATION_QUEUE_URL') }) })
      return Response.json(await route(event as DynamoDBStreamEvent, context))
    }
    const worker = createWorkflowWorker({ ...services(), transport, region: required('AWS_REGION') })
    return Response.json(await worker(event as Parameters<typeof worker>[0], context))
  } catch (error) {
    console.error(JSON.stringify({ kind: 'orchestration_invocation_failed', role, error: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : 'Unknown error' }))
    return Response.json({ error: 'Invocation failed' }, { status: 500 })
  }
}
