import type { Context, DynamoDBStreamEvent } from 'aws-lambda'
import { createWorkflowStreamRouter } from '@ataylorme/tanstack-workflow-aws/wakeups'
import { createApplicationQueuePublisher } from '@ataylorme/tanstack-workflow-aws/aws'
import { dispatchKey, parseKey, required, wakeupIO } from './wakeups'
// rc.0 settled rows predate schemaVersion. Preserve them unchanged during
// stream replay; never relabel old data or silently discard active obligations.
export function isSettledLegacyRecord(record: DynamoDBStreamEvent['Records'][number]): boolean {
  const image = record.dynamodb?.NewImage
  if (!image || image.schemaVersion || image.duePK || image.cleanupAt || image.outboxEnd) return false
  const pk = image.PK?.S ?? record.dynamodb?.Keys?.PK?.S ?? ''
  if (pk.startsWith('EVENT#') && image.entityType?.S === 'APPLICATION_EVENT') return true
  return pk.startsWith('RUN#') && ['finished', 'errored', 'aborted'].includes(image.run?.M?.status?.S ?? '')
}
let route: ReturnType<typeof createWorkflowStreamRouter> | undefined
export async function handler(event: DynamoDBStreamEvent | { kind: 'reconcile'; keys: unknown[] }, context: Context) {
  const transport = wakeupIO()
  if ('kind' in event && event.kind === 'reconcile') {
    if (!Array.isArray(event.keys) || event.keys.length > 25) throw new Error('Reconcile at most 25 keys per invocation')
    for (const key of event.keys) {
      if (context.getRemainingTimeInMillis() < 15_000) throw new Error('Insufficient reconciliation budget; retry batch')
      await dispatchKey(parseKey(key), transport)
    }
    return { reconciled: event.keys.length }
  }
  if (!('Records' in event) || !Array.isArray(event.Records)) throw new Error('Invalid dispatcher event')
  route ??= createWorkflowStreamRouter({ transport,
    publishApplicationEvent: createApplicationQueuePublisher({ queueUrl: required('APPLICATION_QUEUE_URL') }),
    onMetrics: metrics => console.log(JSON.stringify({ kind: 'workflow_router_metrics', ...metrics })),
  })
  const Records = event.Records.filter(record => !isSettledLegacyRecord(record))
  if (Records.length !== event.Records.length) console.log(JSON.stringify({ kind: 'legacy_settled_records_preserved', count: event.Records.length - Records.length }))
  return route({ Records }, context)
}
