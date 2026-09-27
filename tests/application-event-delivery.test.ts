import { SQSClient } from '@aws-sdk/client-sqs'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applicationEventDeliveryApi } from '../src/events/delivery.server'

const token = 'a'.repeat(64)
const event = { id: 'test-one', type: 'ha.validation.event', version: 1, timestamp: '2026-09-27T00:00:00.000Z', data: { message: 'hello' } }
const request = (body: unknown = { id: event.id }, auth = token, method = 'POST') => new Request('https://example.test/api/application-events/delivery', {
  method, headers: { authorization: `Bearer ${auth}` }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
})
beforeEach(() => {
  vi.stubEnv('WORKFLOW_TEST_TOKEN', token)
  vi.stubEnv('EVENT_TEST_QUEUE_URL', 'private-queue-url')
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
it('rejects authentication, missing configuration and unsupported methods without AWS', async () => {
  const send = vi.fn()
  expect((await applicationEventDeliveryApi(request({}, 'wrong'), { send })).status).toBe(401)
  const method = await applicationEventDeliveryApi(request({}, token, 'GET'), { send })
  expect(method.status).toBe(405)
  expect(method.headers.get('allow')).toBe('POST')
  vi.stubEnv('EVENT_TEST_QUEUE_URL', '')
  expect((await applicationEventDeliveryApi(request(), { send })).status).toBe(503)
  expect(send).not.toHaveBeenCalled()
})
it.each([null, {}, [], { id: '../bad' }, { id: 'test-one', QueueUrl: 'other' }, { id: 1 }])('rejects invalid input %# before AWS', async body => {
  const send = vi.fn()
  expect((await applicationEventDeliveryApi(request(body), { send })).status).toBe(400)
  expect(send).not.toHaveBeenCalled()
})
it('limits streamed payload bytes and cancels before reading the tail', async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2049)) }, cancel })
  const incoming = new Request('https://example.test/api/application-events/delivery', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: stream, duplex: 'half',
  } as RequestInit)
  const send = vi.fn()
  expect((await applicationEventDeliveryApi(incoming, { send })).status).toBe(413)
  expect(cancel).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled()
})
it('observes only a matching test envelope in one bounded receive and never deletes', async () => {
  const send = vi.fn().mockResolvedValue({ Messages: [
    { Body: 'not JSON' }, { Body: JSON.stringify({ ...event, id: 'test-unrelated' }) },
    { Body: JSON.stringify({ ...event, privateField: 'hidden' }), ReceiptHandle: 'hidden' },
  ] })
  const response = await applicationEventDeliveryApi(request(), { send })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'observed', event })
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]?.[0].constructor.name).toBe('ReceiveMessageCommand')
  expect(send.mock.calls[0]?.[0].input).toEqual({ QueueUrl: 'private-queue-url', MaxNumberOfMessages: 10, WaitTimeSeconds: 2, VisibilityTimeout: 5 })
})
it.each([{}, { Messages: [] }, { Messages: [{ Body: JSON.stringify({ ...event, id: 'test-unrelated' }) }] }, { Messages: [{ Body: JSON.stringify({ id: event.id, secret: 'hidden' }) }] }])('returns inconclusive pending without revealing unrelated messages %#', async result => {
  const response = await applicationEventDeliveryApi(request(), { send: vi.fn().mockResolvedValue(result) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'pending' })
})
it('sanitizes AWS failures', async () => {
  const response = await applicationEventDeliveryApi(request(), { send: vi.fn().mockRejectedValue(new Error('private AWS endpoint/account')) })
  expect(response.status).toBe(503)
  expect(await response.text()).not.toMatch(/private|account|endpoint/)
})

it('grants only optional queue-scoped receive permission and plans both app updates offline', () => {
  const template = readFileSync('infra/regional.yaml', 'utf8')
  expect(template).toContain("HasEventTestQueue: !And")
  expect(template).toContain('EVENT_TEST_QUEUE_URL: !If [HasEventTestQueue, !Ref EventTestQueueUrl, !Ref AWS::NoValue]')
  expect(template).toContain('Action: sqs:ReceiveMessage\n                  Resource: !Ref EventTestQueueArn')
  expect(template).not.toMatch(/sqs:(DeleteMessage|PurgeQueue|SendMessage|\*)/)
  const plan = execFileSync(process.execPath, ['scripts/deploy-application-events.ts'], {
    env: { PATH: '', STACK_PREFIX: 'ui-events-test' }, encoding: 'utf8',
  })
  expect(plan).toContain('no AWS calls made')
  expect(plan).toContain('BOTH existing regional app stacks')
  expect(plan).toContain('preserving omitted image and secret parameters')
})

it.each(['observed', 'pending', 'failure'])('destroys its owned client after %s', async outcome => {
  const send = vi.spyOn(SQSClient.prototype, 'send')
  if (outcome === 'failure') send.mockRejectedValue(new Error('private SDK failure'))
  else send.mockImplementation(async () => outcome === 'observed' ? { Messages: [{ Body: JSON.stringify(event) }] } : {})
  const destroy = vi.spyOn(SQSClient.prototype, 'destroy').mockImplementation(() => {})
  const response = await applicationEventDeliveryApi(request())
  expect(response.status).toBe(outcome === 'failure' ? 503 : 200)
  expect(destroy).toHaveBeenCalledOnce()
})
it('never destroys an injected client', async () => {
  const client = { send: vi.fn().mockResolvedValue({}), destroy: vi.fn() }
  expect((await applicationEventDeliveryApi(request(), client)).status).toBe(200)
  expect(client.destroy).not.toHaveBeenCalled()
})
