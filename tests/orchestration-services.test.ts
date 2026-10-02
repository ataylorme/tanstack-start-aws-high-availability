import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { mockClient } from 'aws-sdk-client-mock'
import { createDynamoWorkflowExecutionStore } from '@ataylorme/tanstack-workflow-aws'
import { decisionStore, documentClient } from '../src/orchestration/services.server'
const mock = mockClient(DynamoDBDocumentClient)
const planHash = 'a'.repeat(64)
function fixture() {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const store = createDynamoWorkflowExecutionStore({ tableName: 'workflow', client: doc })
  const events = vi.spyOn(store, 'readEvents').mockResolvedValue([])
  return { reader: decisionStore(doc, 'workflow', store), events }
}
beforeEach(() => mock.reset())
afterEach(() => vi.unstubAllEnvs())
describe('authoritative atomic decision reader', () => {
  it('reads accepted inbox with strong consistency before consulting history', async () => {
    mock.on(GetCommand).resolves({ Item: { pending: { kind: 'approval', approval: { approvalId: 'approve-1', approved: true, meta: { actor: 'approver-demo', planHash } } } } })
    const f = fixture()
    expect(await f.reader.get('task-1')).toEqual({ approvalId: 'approve-1', approved: true, planHash, actor: 'approver-demo' })
    expect(f.events).not.toHaveBeenCalled()
    expect(mock.commandCalls(GetCommand)[0]!.args[0].input).toEqual({ TableName: 'workflow', Key: { PK: 'RUN#task-1', SK: 'META' }, ConsistentRead: true })
  })
  it('reads committed resolution after pending inbox has cleared', async () => {
    mock.on(GetCommand).resolves({ Item: {} })
    const f = fixture()
    f.events.mockResolvedValue([{ runId: 'task-1', createdAt: 1, eventIndex: 1, eventType: 'APPROVAL_RESOLVED', event: { type: 'APPROVAL_RESOLVED', stepId: 'approve', ts: 1, approvalId: 'approve-1', approved: false, meta: { actor: 'approver-demo', planHash } } }])
    expect(await f.reader.get('task-1')).toEqual({ approvalId: 'approve-1', approved: false, planHash, actor: 'approver-demo' })
  })
  it('has no decision before atomic acceptance', async () => {
    mock.on(GetCommand).resolves({ Item: {} })
    expect(await fixture().reader.get('task-1')).toBeUndefined()
  })
  it.each([
    { actor: 'requester-demo', planHash }, { actor: 'approver-demo', planHash: 'invalid' }, null,
  ])('fails closed on malformed stored metadata %#', async meta => {
    mock.on(GetCommand).resolves({ Item: { pending: { kind: 'approval', approval: { approvalId: 'approve-1', approved: true, meta } } } })
    await expect(fixture().reader.get('task-1')).rejects.toThrow()
  })
  it('does not treat transient read failure as no prior decision', async () => {
    mock.on(GetCommand).rejects(new Error('timeout'))
    await expect(fixture().reader.get('task-1')).rejects.toThrow('timeout')
  })
})
describe('local endpoint safety', () => {
  it('rejects remote overrides and all overrides inside Lambda', () => {
    vi.stubEnv('DYNAMODB_ENDPOINT', 'https://remote.example')
    expect(() => documentClient()).toThrow('local-only')
    vi.stubEnv('DYNAMODB_ENDPOINT', 'http://localhost:8000')
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'deployed-http')
    expect(() => documentClient()).toThrow('local-only')
  })
})
