import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { orderedApplicationEventsApi } from '../src/events/ordered.server'
const token = 'a'.repeat(64)
beforeEach(() => { vi.stubEnv('WORKFLOW_TEST_TOKEN', token); vi.stubEnv('TABLE_NAME', 'test') })
afterEach(() => vi.unstubAllEnvs())
function database() {
  const items = new Map<string, any>()
  const send = vi.fn(async (command: any) => {
    const input = command.input; const item = input.Item ?? input.Key; const key = `${item.PK}/${item.SK}`
    if (command instanceof GetCommand) return { Item: structuredClone(items.get(key)) }
    if (!(command instanceof PutCommand)) throw new Error('Unexpected operation')
    const existing = items.get(key)
    if ((input.ConditionExpression === 'attribute_not_exists(PK)' && existing) || (input.ConditionExpression === '#v = :v' && existing?.version !== input.ExpressionAttributeValues[':v'])) throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' })
    items.set(key, structuredClone(item)); return {}
  })
  return { client: { send } as unknown as DynamoDBDocumentClient, items, send }
}
const request = (action: string, extra = {}, auth = token) => new Request('https://test/api/application-events/ordered', { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ runId: 'test-ordered', action, ...extra }) })
it('authenticates and constrains commands before accessing durable storage', async () => {
  const db = database()
  expect((await orderedApplicationEventsApi(request('publish', {}, 'bad'), db.client)).status).toBe(401)
  expect((await orderedApplicationEventsApi(request('resolve'), db.client)).status).toBe(400)
  expect((await orderedApplicationEventsApi(request('publish', { subscriberId: 'production' }), db.client)).status).toBe(400)
  expect((await orderedApplicationEventsApi(request('publish', { runId: '../bad' }), db.client)).status).toBe(400)
  expect((await orderedApplicationEventsApi(request('publish', { data: 'x'.repeat(3000) }), db.client)).status).toBe(413)
  expect(db.send).not.toHaveBeenCalled()
})
it('tests immutable lifecycle, retained-source catchup, duplicate suppression, blocked inspection and safe recovery with real rc.1 implementation', async () => {
  const db = database()
  const invoke = async (action: string) => { const response = await orderedApplicationEventsApi(request(action), db.client); expect(response.status).toBe(200); return response.json() }
  const published = await invoke('publish')
  expect(published.detail.events.map((event: any) => event.ordering.sequence)).toEqual([1, 2, 3, 4])
  expect((await invoke('retry')).detail.identical).toBe(true)
  for (const probe of ['conflict', 'gap', 'wrong-type']) expect((await invoke(probe)).detail.rejected).toBe(true)
  const delivered = await invoke('deliver')
  expect(delivered.normal.cursor.completed).toBe(4)
  expect(delivered.normal.receipts.map((receipt: any) => receipt.event.data.phase)).toEqual([1, 2, 3, 4])
  expect(delivered.transport.receipts).toEqual([null, null, null, null])
  expect((await invoke('duplicate')).normal.receipts).toEqual(delivered.normal.receipts)
  const blocked = await invoke('block')
  expect(blocked.blocked.cursor.completed).toBe(1)
  expect(blocked.blocked.cursor.claim.sequence).toBe(2)
  expect(blocked.blocked.receipts.slice(1)).toEqual([null, null, null])
  expect((await invoke('block')).blocked.cursor.claim.id).toBe(blocked.blocked.cursor.claim.id)
  const recovered = await invoke('recover')
  expect(recovered.blocked.cursor.completed).toBe(4)
  expect(recovered.blocked.cursor.claim).toBeUndefined()
  expect(recovered.blocked.cursor.resolution.outcome).toBe('retry')
  expect(recovered.blocked.receipts.map((receipt: any) => receipt.event.data.phase)).toEqual([1, 2, 3, 4])
  expect((await invoke('inspect')).normal.cursor.completed).toBe(4)
  expect([...db.items.values()].every(item => item.expiresAt === undefined)).toBe(true)
})
it('requires committed source before delivery and does not leak infrastructure errors', async () => {
  const db = database()
  expect((await orderedApplicationEventsApi(request('deliver'), db.client)).status).toBe(409)
  db.send.mockRejectedValue(new Error('private infrastructure details'))
  const response = await orderedApplicationEventsApi(request('inspect'), db.client)
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('private infrastructure')
})
it('never resolves a replacement claim from an in-flight recovery', async () => {
  const db = database()
  await orderedApplicationEventsApi(request('publish'), db.client)
  await orderedApplicationEventsApi(request('block'), db.client)
  const cursor = [...db.items.values()].find(item => item.subscriberId === 'ha-ordered-lab-blocked-v1' && item.SK === 'META')
  const originalClaim = cursor.claim.id
  // A first recover cleared the known failed claim, then acquired a new claim
  // whose awaited receipt is still in flight. Absence of a receipt is NOT proof.
  cursor.claim.id = 'replacement-in-flight-claim'; cursor.version += 2
  const response = await orderedApplicationEventsApi(request('recover'), db.client)
  expect(response.status).toBe(409)
  expect(cursor.claim.id).not.toBe(originalClaim)
  expect(cursor.completed).toBe(1)
})
it('concurrent recovery attempts cannot both clear the same known failed claim', async () => {
  const db = database()
  await orderedApplicationEventsApi(request('publish'), db.client)
  await orderedApplicationEventsApi(request('block'), db.client)
  const responses = await Promise.all([orderedApplicationEventsApi(request('recover'), db.client), orderedApplicationEventsApi(request('recover'), db.client)])
  expect(responses.map(response => response.status).sort()).toEqual([200, 503])
  const state = await (await orderedApplicationEventsApi(request('inspect'), db.client)).json()
  expect(state.blocked.cursor.completed).toBe(4)
})
