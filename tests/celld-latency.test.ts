import { expect, it } from 'vitest'
import { latencySummary } from '../experiments/celld/measurements/latency.ts'
it('reports nearest-rank percentiles without modifying the input', () => {
  const values = [3, 1, 2, 100]
  expect(latencySummary(values)).toEqual({ count: 4, p50: 2, p95: 100, p99: 100, min: 1, max: 100 })
  expect(values).toEqual([3, 1, 2, 100])
})
it('uses correct ranks over one hundred samples', () => {
  expect(latencySummary(Array.from({length: 100}, (_, i) => i + 1))).toEqual({count:100,p50:50,p95:95,p99:99,min:1,max:100})
})
it.each([{values:[]}, {values:[-1]}, {values:[NaN]}, {values:[Infinity]}])('rejects invalid measurements', ({values}) => {
  expect(() => latencySummary(values)).toThrow()
})
