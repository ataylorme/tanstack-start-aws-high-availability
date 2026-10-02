import { GetFunctionConcurrencyCommand, PutFunctionConcurrencyCommand, type LambdaClient } from '@aws-sdk/client-lambda'
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { CapacityPlan, ExecutionReceipt, ExecutionResult } from './types'

interface Options {
  client: LambdaClient
  doc: DynamoDBDocumentClient
  tableName: string
  target: string
  /** Must only return the immutable, server-authorized approved plan. */
  loadApprovedPlan: (taskId: string) => Promise<CapacityPlan | undefined>
  capacity?: { read: () => Promise<number | null>; write: (value: number) => Promise<void> }
  now?: () => number
}
interface Operation {
  operationId: string
  plan: CapacityPlan
  status: 'applying' | 'succeeded' | 'blocked'
  receipt?: ExecutionReceipt
  reason?: string
}

/** Requires a serialized executor (Lambda reserved concurrency = 1).
 * The durable lock deliberately has no TTL: an uncertain effect must be reconciled,
 * not stolen by a later operation when a timer expires.
 */
export function createExecutor({ client, doc, tableName, target, loadApprovedPlan, capacity, now = Date.now }: Options) {
  const lockKey = { PK: `TARGET#${target}`, SK: 'LOCK' }
  const read = async (Key: Record<string, string>) => (await doc.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))).Item
  return async (taskId: string): Promise<ExecutionResult> => {
    const blocked = (reason: string): ExecutionResult => ({ status: 'blocked', reason })
    if (!taskId || taskId.length > 256) return blocked('Invalid task identifier')
    const plan = await loadApprovedPlan(taskId)
    if (!plan || plan.taskId !== taskId || plan.target !== target || plan.workflowVersion !== 'v1' || !plan.hash ||
      !Number.isInteger(plan.after) || plan.after < 1 || plan.after > 5 ||
      (plan.before !== null && (!Number.isInteger(plan.before) || plan.before < 0)) ||
      !Number.isFinite(Date.parse(plan.executeAt))) return blocked('Missing or invalid approved plan')
    if (Date.parse(plan.executeAt) > now()) return blocked('Approved execution time has not arrived')
    const operationId = `${taskId}:${plan.hash}`
    const key = { PK: `OP#${taskId}`, SK: 'RECEIPT' }
    let operation = await read(key) as Operation | undefined
    let recovering = Boolean(operation)
    if (!operation) {
      operation = { operationId, plan, status: 'applying' }
      try {
        await doc.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: tableName, Item: { ...key, ...operation }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: tableName, Item: { ...lockKey, operationId }, ConditionExpression: 'attribute_not_exists(PK)' } },
        ] }))
      } catch (error) {
        // Read after even an ambiguous transport failure: the transaction may have committed.
        const existing = await read(key) as Operation | undefined
        if (existing) { operation = existing; recovering = true }
        else {
          const lock = await read(lockKey)
          if (lock && lock.operationId !== operationId) return blocked('Another unresolved operation owns this target')
          throw error
        }
      }
    }
    if (operation.operationId !== operationId || operation.plan.hash !== plan.hash ||
      operation.plan.target !== target || operation.plan.before !== plan.before || operation.plan.after !== plan.after ||
      operation.plan.executeAt !== plan.executeAt) return blocked('Stored operation does not match the approved plan')
    if (operation.status === 'succeeded') {
      if (!operation.receipt) throw new Error('Completed operation is missing its receipt')
      return { status: 'succeeded', receipt: operation.receipt }
    }
    if (operation.status === 'blocked') return blocked(operation.reason ?? 'Operation requires manual reconciliation')
    const lock = await read(lockKey)
    if (lock?.operationId !== operationId) return blocked('Operation does not own the target lock')
    const observe = capacity?.read ?? (async () => (await client.send(new GetFunctionConcurrencyCommand({ FunctionName: target }))).ReservedConcurrentExecutions ?? null)
    const finish = async (next: Operation, release: boolean) => {
      await doc.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: tableName, Item: { ...key, ...next },
          ConditionExpression: 'operationId = :id AND #status = :applying',
          ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':id': operationId, ':applying': 'applying' } } },
        release ? { Delete: { TableName: tableName, Key: lockKey, ConditionExpression: 'operationId = :id', ExpressionAttributeValues: { ':id': operationId } } }
          : { ConditionCheck: { TableName: tableName, Key: lockKey, ConditionExpression: 'operationId = :id', ExpressionAttributeValues: { ':id': operationId } } },
      ] }))
    }
    const observed = await observe()
    if (!(recovering && observed === plan.after)) {
      if (observed !== plan.before) {
        const reason = recovering ? 'Uncertain operation outcome; manual reconciliation required' : 'Target changed since planning; request a new plan'
        await finish({ ...operation, status: 'blocked', reason }, !recovering)
        return blocked(reason)
      }
      // Failures intentionally propagate with the applying receipt and lock intact.
      // A later invocation first observes the target before deciding whether to retry.
      if (capacity) await capacity.write(plan.after)
      else await client.send(new PutFunctionConcurrencyCommand({ FunctionName: target, ReservedConcurrentExecutions: plan.after }))
      if (await observe() !== plan.after) {
        const reason = 'Execution verification failed; manual reconciliation required'
        await finish({ ...operation, status: 'blocked', reason }, false)
        return blocked(reason)
      }
    }
    const receipt: ExecutionReceipt = { operationId, taskId, planHash: plan.hash, target, before: plan.before, after: plan.after, completedAt: new Date(now()).toISOString() }
    await finish({ ...operation, status: 'succeeded', receipt }, true)
    return { status: 'succeeded', receipt }
  }
}
