import type { TaskRequest } from './types'

export type ExecutionMode = 'after-approval' | 'scheduled'

export function accessToken(value: string): string {
  const token = value.trim()
  if (!token || /[\s{}"\[\]]/.test(token)) throw new Error('Paste only the requester or approver token value, without JSON, quotes, or a Bearer prefix.')
  return token
}

export function taskRequest(desiredConcurrency: number, mode: ExecutionMode, executeAt: string, now = Date.now()): TaskRequest {
  if (!Number.isInteger(desiredConcurrency) || desiredConcurrency < 1 || desiredConcurrency > 5) throw new Error('Choose concurrency from 1 to 5.')
  if (mode === 'after-approval') return { desiredConcurrency }
  const at = new Date(executeAt).getTime()
  if (!Number.isFinite(at) || at <= now || at > now + 86_400_000) throw new Error('Choose a scheduled time within the next 24 hours.')
  return { desiredConcurrency, executeAt: new Date(at).toISOString() }
}
