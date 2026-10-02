import type { DecisionRequest, TaskRequest, TaskView } from './types'

export function createOrchestrationClient(token: string, baseUrl = '') {
  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${baseUrl}/api/tasks${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
      cache: 'no-store',
    })
    const text = await response.text()
    let body: unknown
    try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
    if (!response.ok) {
      const detail = body && typeof body === 'object'
        ? ('error' in body && typeof body.error === 'string' ? body.error : 'message' in body && typeof body.message === 'string' ? body.message : undefined)
        : undefined
      throw new Error(`Request failed (${response.status})${detail ? `: ${detail}` : ''}`)
    }
    if (body === undefined) throw new Error('Server returned an invalid JSON response')
    return body as T
  }
  return {
    list: (signal?: AbortSignal) => request<{ tasks: TaskView[] }>('', { signal: signal ?? null }),
    get: (id: string, signal?: AbortSignal) => request<TaskView>(`/${encodeURIComponent(id)}`, { signal: signal ?? null }),
    create: (input: TaskRequest, idempotencyKey: string, signal?: AbortSignal) => request<TaskView>('', {
      method: 'POST', body: JSON.stringify(input), headers: { 'Idempotency-Key': idempotencyKey }, signal: signal ?? null,
    }),
    decide: (id: string, decision: DecisionRequest, signal?: AbortSignal) => request<TaskView>(`/${encodeURIComponent(id)}/decision`, {
      method: 'POST', body: JSON.stringify(decision), signal: signal ?? null,
    }),
  }
}
