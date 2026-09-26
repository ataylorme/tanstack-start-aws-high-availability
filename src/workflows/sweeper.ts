import type { Context } from 'aws-lambda'
import { workflowServices } from './runtime.server'

export async function handler(_event: unknown, context: Context) {
  const { store, runtime } = workflowServices()
  const owner = `${process.env.AWS_REGION}:${context.awsRequestId}`
  const budget = context.getRemainingTimeInMillis() - 2_000
  if (budget <= 0) throw new Error('Insufficient sweep budget')
  const result = await store.withLeaseOwner(owner, () => runtime.sweep({
    leaseOwner: owner, maxDurationMs: budget, limit: 10, includeEvents: false,
  }))
  console.log(JSON.stringify({ region: process.env.AWS_REGION, summary: result.summary,
    diagnostics: [...result.recovered, ...result.scheduled, ...result.timers]
      .flatMap(run => run.events.filter(event => event.type === 'RUN_ERRORED')) }))
  return result
}
