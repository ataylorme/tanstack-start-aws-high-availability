import { continueAsNew, publishWorkflowEvent } from '@ataylorme/tanstack-workflow-aws/workflow-effects'
import { createWorkflow } from '@ataylorme/tanstack-workflow-aws/workflow'

const location = () => ({ region: process.env.AWS_REGION ?? 'local', release: process.env.RELEASE_ID ?? 'development' })

export const validation = createWorkflow({ id: 'validation-v1' }).handler(async ctx => {
  const started = await ctx.step('started', location)
  const retry = await ctx.step('intentional-retry', ({ attempt }) => {
    if (attempt === 1) throw new Error('Intentional test failure; the second attempt succeeds')
    return { attempt, ...location() }
  }, { retry: { maxAttempts: 2, backoff: 'fixed', baseMs: 10 } })
  const signal = await ctx.waitForEvent<{ message: string }>('continue')
  const signaled = await ctx.step('signaled', location)
  const approval = await ctx.approve({ title: 'Approve this test workflow?' })
  if (!approval.approved) return { started, retry, signal, signaled, approved: false }
  await ctx.sleep(1_000)
  const firstWake = await ctx.step('first-wake', location)
  await ctx.sleep(1_000)
  const finished = await ctx.step('finished', location)
  return { started, retry, signal, signaled, approved: true, firstWake, finished }
})

export const timer = createWorkflow({ id: 'timer-v1' }).handler(async ctx => {
  const started = await ctx.step('started', location)
  await ctx.sleep(1_000)
  const firstWake = await ctx.step('first-wake', location)
  await ctx.sleep(1_000)
  return { started, firstWake, finished: await ctx.step('finished', location) }
})

// These fixtures deliberately have bounded histories and no business effects.
export const outbox = createWorkflow({ id: 'outbox-v1' }).handler(async ctx => {
  const event = await publishWorkflowEvent(ctx, 'committed-publication', {
    id: ctx.runId, type: 'ha.validation.event', data: { message: 'Committed workflow outbox', runId: ctx.runId },
  })
  return { eventId: event.id, correlationId: event.correlationId, ...location() }
})

export const continuation = createWorkflow({ id: 'continuation-v1' }).handler(async ctx => {
  const input = ctx.input as { generation?: number }
  const generation = input?.generation ?? 0
  await ctx.step('generation', () => ({ generation, ...location() }))
  // Exactly one successor: never create an unbounded continuation chain.
  if (generation === 0) return continueAsNew(ctx, { generation: 1 })
  return { generation, completed: true, ...location() }
})

export const historyLimit = createWorkflow({ id: 'history-limit-v1' }).handler(async ctx => {
  for (let i = 0; i < 70; i++) await ctx.step(`bounded-step-${i}`, () => i)
  return { unexpected: 'History limit was not reached; check runtime limits' }
})

export const workflows = {
  'validation-v1': { load: async () => validation },
  'timer-v1': { load: async () => timer },
  'outbox-v1': { load: async () => outbox },
  'continuation-v1': { load: async () => continuation },
  'history-limit-v1': { load: async () => historyLimit },
}
