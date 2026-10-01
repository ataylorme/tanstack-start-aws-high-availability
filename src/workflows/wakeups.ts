// The package owns the versioned metadata contract and durable continuation logic.
export { dueKinds, dueWakeup, itemWakeups, parseKey, parseWakeup, dispatchKey, processWakeup } from '@ataylorme/tanstack-workflow-aws/wakeups'
export type { ItemKey, DueWakeup, Wakeup, WakeupIO } from '@ataylorme/tanstack-workflow-aws/wakeups'
import { createAwsWorkflowTransport } from '@ataylorme/tanstack-workflow-aws/aws'
export const createWakeupIO = createAwsWorkflowTransport
export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
let transport: ReturnType<typeof createAwsWorkflowTransport> | undefined
export function wakeupIO() {
  return transport ??= createAwsWorkflowTransport({ tableName: required('TABLE_NAME'),
    queueUrl: required('WAKEUP_QUEUE_URL'), queueArn: required('WAKEUP_QUEUE_ARN'),
    group: required('SCHEDULE_GROUP'), roleArn: required('SCHEDULER_ROLE_ARN'), dlqArn: required('SCHEDULER_DLQ_ARN') })
}
