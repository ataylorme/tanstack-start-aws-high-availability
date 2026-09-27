import { SQSClient } from '@aws-sdk/client-sqs'
import { createSqsBridge } from '@ataylorme/tanstack-workflow-aws/bridges/sqs'
import { createApplicationStreamHandler } from '@ataylorme/tanstack-workflow-aws/event-stream'

const queueUrl = process.env.QUEUE_URL
if (!queueUrl) throw new Error('QUEUE_URL is required')

// Bound SDK retries beneath Lambda's deadline; the stream owns delivery retries.
const client = new SQSClient({
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1_000, requestTimeout: 4_000, throwOnRequestTimeout: true },
})
export const handler = createApplicationStreamHandler(
  createSqsBridge({ client, queueUrl }),
  { minRemainingTimeMs: 15_000 },
)
