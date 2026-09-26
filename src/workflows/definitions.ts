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

export const workflows = {
  'validation-v1': { load: async () => validation },
  'timer-v1': { load: async () => timer },
}
