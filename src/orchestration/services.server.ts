import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { GetFunctionConcurrencyCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { createDynamoWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws'
import { defineWorkflowRuntime } from '@ataylorme/tanstack-workflow-aws/runtime'
import { createDynamoApplicationEventPublisher } from '@ataylorme/tanstack-workflow-aws/events'
import { object, parseDecision, parseExecutionResult } from './domain'
import { createExecutor } from './executor'
import { capacityWorkflow } from './workflow'
import { approvedPlan } from './view'
import { WORKFLOW_ID } from './types'
import type { DecisionRecord, DecisionStore } from './api'
export function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
export function documentClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT
  if (endpoint && (process.env.AWS_LAMBDA_FUNCTION_NAME || !['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname))) throw new Error('DynamoDB endpoint override is local-only')
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1', maxAttempts: 3, ...(endpoint ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}), requestHandler: { connectionTimeout: 1000, requestTimeout: 4000, throwOnRequestTimeout: true } }), { marshallOptions: { removeUndefinedValues: true } })
}
// Version-pinned adapter boundary: read the atomic accepted inbox before worker recovery,
// then the committed resolution history. No second approval database write exists.
export function decisionStore(doc: DynamoDBDocumentClient, tableName: string, store: ReturnType<typeof createDynamoWorkflowExecutionStore>): DecisionStore {
  return { async get(taskId): Promise<DecisionRecord | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: tableName, Key: { PK: `RUN#${taskId}`, SK: 'META' }, ConsistentRead: true }))
    const pending = Item?.pending === undefined ? undefined : object(Item.pending)
    let approval: Record<string, unknown> | undefined
    if (pending?.kind === 'approval') approval = object(pending.approval)
    else {
      const events = await store.readEvents({ runId: taskId })
      const event = events.map(item => item.event).reverse().find(item => item.type === 'APPROVAL_RESOLVED')
      if (event?.type === 'APPROVAL_RESOLVED') approval = { approvalId: event.approvalId, approved: event.approved, meta: event.meta }
    }
    if (!approval) return undefined
    const meta = object(approval.meta)
    if (meta.actor !== 'approver-demo') throw new Error('Invalid persisted actor')
    return { ...parseDecision({ approvalId: approval.approvalId, approved: approval.approved, planHash: meta.planHash }), actor: 'approver-demo' }
  } }
}
export function createServices() {
  const tableName = required('WORKFLOW_TABLE_NAME')
  const opsTable = required('OPERATIONS_TABLE_NAME')
  const target = required('SANDBOX_FUNCTION_NAME')
  const doc = documentClient()
  const lambda = new LambdaClient({ maxAttempts: 1, region: process.env.AWS_REGION ?? 'us-east-1', requestHandler: { connectionTimeout: 1000, requestTimeout: 35_000, throwOnRequestTimeout: true } })
  const effectLambda = new LambdaClient({ maxAttempts: 2, region: process.env.AWS_REGION ?? 'us-east-1', requestHandler: { connectionTimeout: 1000, requestTimeout: 4000, throwOnRequestTimeout: true } })
  const store = createDynamoWorkflowExecutionStore({ tableName, client: doc, limits: { maxHistoryEvents: 256, maxHistoryBytes: 1024 * 1024, terminalRetentionMs: 7 * 86_400_000, tombstoneRetentionMs: 30 * 86_400_000 } })
  const local = Boolean(process.env.DYNAMODB_ENDPOINT)
  async function readLocal(): Promise<number> { const result = await doc.send(new GetCommand({ TableName: opsTable, Key: { PK: 'LOCAL_SANDBOX', SK: 'META' }, ConsistentRead: true })); const value: unknown = result.Item?.capacity; return typeof value === 'number' ? value : 1 }
  const executor = createExecutor({ client: effectLambda, doc, tableName: opsTable, target, loadApprovedPlan: id => approvedPlan(store, id), ...(local ? { capacity: { read: readLocal, write: async (value: number) => { await doc.send(new PutCommand({ TableName: opsTable, Item: { PK: 'LOCAL_SANDBOX', SK: 'META', capacity: value } })) } } } : {}) })
  const workflow = capacityWorkflow({ target, readCapacity: async () => local ? readLocal() : (await effectLambda.send(new GetFunctionConcurrencyCommand({ FunctionName: target }))).ReservedConcurrentExecutions ?? null,
    execute: async taskId => {
      if (local) return executor(taskId)
      const response = await lambda.send(new InvokeCommand({ FunctionName: required('EXECUTOR_FUNCTION_NAME'), InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({ taskId })) }))
      if (response.FunctionError || !response.Payload) throw new Error('Executor invocation failed or returned no receipt')
      return parseExecutionResult(JSON.parse(Buffer.from(response.Payload).toString('utf8')))
    },
  })
  const runtime = defineWorkflowRuntime({ store, workflows: { [WORKFLOW_ID]: { version: 'v1', load: async () => workflow } }, defaultLeaseMs: 60_000 })
  return { store, runtime, executor, doc, decisions: decisionStore(doc, tableName, store), publisher: createDynamoApplicationEventPublisher({ tableName, client: doc }) }
}
let singleton: ReturnType<typeof createServices> | undefined
export function services() { return singleton ??= createServices() }
