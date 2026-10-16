export function latencySummary(samples: readonly number[]) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Need finite nonnegative latency samples')
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!
  return { count: samples.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), min: sorted[0]!, max: sorted.at(-1)! }
}
