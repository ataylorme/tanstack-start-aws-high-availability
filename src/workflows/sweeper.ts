import type { Context, SQSEvent, SQSBatchResponse } from 'aws-lambda'
import { workflowServices } from './runtime.server'
import { required, wakeupIO } from './wakeups'
import { createWorkflowWorker } from '@ataylorme/tanstack-workflow-aws/wakeups'
import { createDynamoApplicationEventPublisher } from '@ataylorme/tanstack-workflow-aws/events'

export async function sweep(context: Context) {
  const { store, runtime } = workflowServices()
  const owner = `${process.env.AWS_REGION}:${context.awsRequestId}`
  const budget = context.getRemainingTimeInMillis() - 15_000
  if (budget <= 0) throw new Error('Insufficient sweep budget')
  const result = await store.withLeaseOwner(owner, () => runtime.sweep({
    leaseOwner: owner, maxDurationMs: budget, limit: 10, includeEvents: false,
  }))
  console.log(JSON.stringify({ region: process.env.AWS_REGION, summary: result.summary,
    diagnostics: [...result.recovered, ...result.scheduled, ...result.timers]
      .flatMap(run => run.events.filter(event => event.type === 'RUN_ERRORED')) }))
  return result
}

let worker: ReturnType<typeof createWorkflowWorker> | undefined
export async function handler(event: unknown, context: Context) {
  // Operator-only sweep retained for rollback. Legacy drain messages are safe to
  // consume during upgrade, but all new keyed work uses direct claims, not GSI.
  if (event && typeof event === 'object' && 'kind' in event && event.kind === 'sweep') return sweep(context)
  if (!event || typeof event !== 'object' || !('Records' in event) || !Array.isArray(event.Records)) throw new Error('Expected an SQS wakeup batch')
  worker ??= createWorkflowWorker({ ...workflowServices(), transport: wakeupIO(),
    publisher: createDynamoApplicationEventPublisher({ tableName: required('TABLE_NAME') }), region: required('AWS_REGION') })
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = []
  for (const message of (event as SQSEvent).Records) {
    try {
      const body = JSON.parse(message.body)
      if (body.version === 1 && body.kind === 'drain') { await sweep(context); continue }
      const result = await worker({ Records: [message] }, context)
      batchItemFailures.push(...result.batchItemFailures)
    } catch (error) {
      console.error(JSON.stringify({ kind: 'workflow_wakeup_failed', error: error instanceof Error ? error.name : 'UnknownError' }))
      batchItemFailures.push({ itemIdentifier: message.messageId })
    }
  }
  return { batchItemFailures }
}
