export type EventRegion = 'us-east-1' | 'us-west-2'
export interface TestEventInput { id: string; message: string }
export interface TestEventEnvelope { id: string; type: string; version: number; timestamp: string; data: { message: string } }
export function oppositeRegion(region: EventRegion): EventRegion {
  return region === 'us-east-1' ? 'us-west-2' : 'us-east-1'
}
export function eventEnvelope(value: unknown): TestEventEnvelope {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' ||
    !('type' in value) || value.type !== 'ha.validation.event' || !('version' in value) || value.version !== 1 ||
    !('timestamp' in value) || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp)) ||
    !('data' in value) || !value.data || typeof value.data !== 'object' || !('message' in value.data) || typeof value.data.message !== 'string') {
    throw new Error('Unexpected event envelope returned by the server')
  }
  return { id: value.id, type: value.type, version: value.version, timestamp: value.timestamp, data: { message: value.data.message } }
}
export function sameEvent(left: TestEventEnvelope, right: TestEventEnvelope) {
  return left.id === right.id && left.type === right.type && left.version === right.version &&
    left.timestamp === right.timestamp && left.data.message === right.data.message
}
export async function eventRequest(token: string, region: EventRegion, command: TestEventInput | { id: string }, delivery = false) {
  const response = await fetch(`/api/application-events${delivery ? '/delivery' : ''}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-ha-region': region, 'content-type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(60_000),
  })
  const data: unknown = await response.json()
  return { status: response.status, servedBy: response.headers.get('x-served-by-region'), data }
}
