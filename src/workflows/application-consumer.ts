import { applicationEventGroupId } from '@ataylorme/tanstack-workflow-aws/ordered-events'
import { SNSClient } from '@aws-sdk/client-sns'
import { createApplicationQueueHandler } from '@ataylorme/tanstack-workflow-aws/wakeups'
import { createSnsBridge } from '@ataylorme/tanstack-workflow-aws/bridges/sns'
export const handler = createApplicationQueueHandler(createSnsBridge({ topicArn: process.env.APPLICATION_TOPIC_ARN!, messageGroupId: applicationEventGroupId,
  client: new SNSClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 4_000, throwOnRequestTimeout: true } }),
}), { fifo: true })
