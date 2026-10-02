import { createHash } from 'node:crypto'
import type { CapacityPlan, DecisionRequest, ExecutionResult, TaskInput, TaskRequest } from './types'
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
export function capacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw new Error('Capacity must be an integer from 1 to 5')
  return value
}
export function parseRequest(value: unknown): TaskRequest {
  const input = object(value)
  if (Object.keys(input).some(key => !['desiredConcurrency', 'executeAt'].includes(key))) throw new Error('Unknown task field')
  const desiredConcurrency = capacity(input.desiredConcurrency)
  if (input.executeAt === undefined) return { desiredConcurrency }
  if (typeof input.executeAt !== 'string' || !Number.isFinite(Date.parse(input.executeAt)) || !/Z$|[+-]\d{2}:\d{2}$/.test(input.executeAt)) throw new Error('executeAt must include a timezone')
  return { desiredConcurrency, executeAt: new Date(input.executeAt).toISOString() }
}
export function parseInput(value: unknown): TaskInput {
  const input = object(value)
  for (const key of ['executeAt', 'requester', 'requestedAt', 'requestHash']) if (typeof input[key] !== 'string') throw new Error(`Invalid ${key}`)
  if (!Number.isFinite(Date.parse(String(input.executeAt)))) throw new Error('Invalid execution time')
  return { desiredConcurrency: capacity(input.desiredConcurrency), executeAt: String(input.executeAt), requester: String(input.requester), requestedAt: String(input.requestedAt), requestHash: String(input.requestHash) }
}
export function parseDecision(value: unknown): DecisionRequest {
  const input = object(value)
  if (Object.keys(input).some(key => !['approvalId', 'planHash', 'approved'].includes(key)) || typeof input.approvalId !== 'string' || input.approvalId.length < 1 || input.approvalId.length > 256 || typeof input.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.planHash) || typeof input.approved !== 'boolean') throw new Error('Invalid decision')
  return { approvalId: input.approvalId, planHash: input.planHash, approved: input.approved }
}
export function parsePlan(value: unknown): CapacityPlan {
  const plan = object(value)
  if (typeof plan.taskId !== 'string' || typeof plan.target !== 'string' || typeof plan.executeAt !== 'string' || !Number.isFinite(Date.parse(plan.executeAt)) || plan.workflowVersion !== 'v1' || typeof plan.hash !== 'string' || (plan.before !== null && (typeof plan.before !== 'number' || !Number.isInteger(plan.before)))) throw new Error('Invalid plan')
  const result = { taskId: plan.taskId, target: plan.target, before: plan.before, after: capacity(plan.after), executeAt: plan.executeAt, workflowVersion: 'v1' as const }
  if (hash(result) !== plan.hash) throw new Error('Plan hash mismatch')
  return { ...result, hash: plan.hash }
}
export function parseExecutionResult(value: unknown): ExecutionResult {
  const result = object(value)
  if (result.status === 'blocked' && typeof result.reason === 'string') return { status: 'blocked', reason: result.reason }
  const receipt = object(result.receipt)
  for (const key of ['operationId', 'taskId', 'planHash', 'target', 'completedAt']) if (typeof receipt[key] !== 'string') throw new Error('Invalid execution receipt')
  if (result.status !== 'succeeded' || (receipt.before !== null && typeof receipt.before !== 'number') || !Number.isFinite(Date.parse(String(receipt.completedAt)))) throw new Error('Invalid executor response')
  return { status: 'succeeded', receipt: { operationId: String(receipt.operationId), taskId: String(receipt.taskId), planHash: String(receipt.planHash), target: String(receipt.target), before: receipt.before, after: capacity(receipt.after), completedAt: String(receipt.completedAt) } }
}
