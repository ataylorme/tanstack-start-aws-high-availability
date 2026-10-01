import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/pr4-test'
const envelope = {
  id: 'test-consumer', type: 'ha.validation.event', version: 1,
  timestamp: '2026-09-27T00:00:00.000Z', data: { message: 'hello' },
  correlationId: 'test-correlation', causationId: 'test-causation', metadata: { origin: 'test' },
}
function record(sequence = '123') {
  return {
    eventName: 'INSERT',
    dynamodb: {
      SequenceNumber: sequence,
      NewImage: {
        entityType: { S: 'APPLICATION_EVENT' },
        event: { M: {
          id: { S: envelope.id }, type: { S: envelope.type }, version: { N: '1' },
          timestamp: { S: envelope.timestamp }, data: { M: { message: { S: 'hello' } } },
          correlationId: { S: envelope.correlationId }, causationId: { S: envelope.causationId },
          metadata: { M: { origin: { S: 'test' } } },
        } },
      },
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('QUEUE_URL', queueUrl)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('real application-event consumer with mocked SQS transport', () => {
  it('decodes an INSERT and sends the complete envelope to the dedicated queue', async () => {
    const send = vi.spyOn(SQSClient.prototype, 'send').mockResolvedValue({} as never)
    const { handler } = await import('../src/events/consumer')
    expect(await handler({ Records: [record()] })).toEqual({ batchItemFailures: [] })
    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0]![0] as SendMessageCommand
    expect(command).toBeInstanceOf(SendMessageCommand)
    expect(command.input.QueueUrl).toBe(queueUrl)
    expect(JSON.parse(command.input.MessageBody!)).toEqual(envelope)
    expect(command.input.MessageAttributes).toEqual({ eventType: { DataType: 'String', StringValue: envelope.type }, ordered: { DataType: 'String', StringValue: 'false' } })
    expect(command.input.MessageDeduplicationId).toBeUndefined()
  })
  it('ignores internal records and non-INSERT application records', async () => {
    const send = vi.spyOn(SQSClient.prototype, 'send').mockResolvedValue({} as never)
    const { handler } = await import('../src/events/consumer')
    const internal = record()
    internal.dynamodb.NewImage.entityType.S = 'WORKFLOW_EXECUTION'
    expect(await handler({ Records: [internal, { ...record(), eventName: 'MODIFY' }, { eventName: 'REMOVE' }] })).toEqual({ batchItemFailures: [] })
    expect(send).not.toHaveBeenCalled()
  })
  it('returns the failed stream sequence as a partial batch failure and stops the batch', async () => {
    const send = vi.spyOn(SQSClient.prototype, 'send').mockRejectedValue(new Error('SQS unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { handler } = await import('../src/events/consumer')
    expect(await handler({ Records: [record('456'), record('457')] })).toEqual({ batchItemFailures: [{ itemIdentifier: '456' }] })
    expect(send).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('application_event_delivery_failed'))
  })
  it('delivers duplicate records twice: the stream bridge is at-least-once, not exactly-once', async () => {
    const send = vi.spyOn(SQSClient.prototype, 'send').mockResolvedValue({} as never)
    const { handler } = await import('../src/events/consumer')
    const batch = { Records: [record()] }
    expect(await handler(batch)).toEqual({ batchItemFailures: [] })
    expect(await handler(batch)).toEqual({ batchItemFailures: [] })
    expect(send).toHaveBeenCalledTimes(2)
    const bodies = send.mock.calls.map(([command]) => (command as SendMessageCommand).input.MessageBody)
    expect(bodies[0]).toBe(bodies[1])
  })
})
