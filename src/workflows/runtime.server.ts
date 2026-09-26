import { randomUUID } from 'node:crypto'
import { createDynamoWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws'
import { defineWorkflowRuntime } from '@ataylorme/tanstack-workflow-aws/runtime'
import { workflows } from './definitions'

export function createWorkflowServices(tableName: string) {
  const store = createDynamoWorkflowExecutionStore({ tableName })
  const runtime = defineWorkflowRuntime({ store, workflows, defaultLeaseMs: 60_000 })
  return { store, runtime }
}
let services: ReturnType<typeof createWorkflowServices> | undefined
export function workflowServices() {
  const tableName = process.env.TABLE_NAME
  if (!tableName) throw new Error('Workflow test deployment is not configured')
  return services ??= createWorkflowServices(tableName)
}
export function requestOwner(): string {
  return `${process.env.AWS_REGION ?? 'local'}:${randomUUID()}`
}
