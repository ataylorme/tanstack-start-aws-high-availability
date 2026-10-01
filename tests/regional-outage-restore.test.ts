import { describe, expect, it } from 'vitest'
import { restoreRegionalResources, validateManifest, type RegionalOutageManifest, type RestoreAws } from '../scripts/regional-outage-restore'
const fixture = (): RegionalOutageManifest => ({ prefix: 'tanstack-events-test', profile: 'ataylorme', accountId: '123456789012', region: 'us-east-1', appFunctionName: 'tanstack-events-test-app-abc', originalConcurrency: null, mappings: [1, 2, 3, 4].map(n => ({ uuid: `00000000-0000-0000-0000-00000000000${n}`, originalState: 'Enabled' })), deadline: Date.now() + 1500000, restored: false })
function clock() { let now = 0; return { now: () => now, sleep: async (ms: number) => { now += ms }, fisTimeoutMs: 10000, mappingTimeoutMs: 10000 } }
describe('regional outage restoration', () => {
  it('rejects unscoped targets and malformed identity', () => {
    for (const patch of [{ prefix: 'tanstack-ha' }, { accountId: 'oops' }, { region: 'us-east-2' }, { appFunctionName: 'other-app' }, { originalConcurrency: -1 }, { mappings: [] }, { profile: '--bad profile' }]) expect(() => validateManifest({ ...fixture(), ...patch })).toThrow()
    expect(validateManifest(fixture()).mappings).toHaveLength(4)
  })
  it('stops FIS before restoring concurrency and independently restores all mappings', async () => {
    const manifest = { ...fixture(), experimentId: 'EXP123' }
    const calls: string[][] = []; let stopped = false
    const states = new Map(manifest.mappings.map(m => [m.uuid, 'Disabled']))
    const aws: RestoreAws = async (_region, args) => {
      calls.push(args)
      if (args[1] === 'get-experiment') return { experiment: { state: { status: stopped ? 'stopped' : 'running' } } }
      if (args[1] === 'stop-experiment') { stopped = true; return {} }
      if (args[1] === 'get-event-source-mapping') return { State: states.get(args[3]!) }
      if (args[1] === 'update-event-source-mapping') states.set(args[3]!, 'Enabled')
      return {}
    }
    const result = await restoreRegionalResources(manifest, aws, clock())
    expect(result.restored).toBe(true)
    expect(calls.findIndex(c => c[1] === 'stop-experiment')).toBeLessThan(calls.findIndex(c => c[1] === 'delete-function-concurrency'))
    expect([...states.values()]).toEqual(['Enabled', 'Enabled', 'Enabled', 'Enabled'])
  })
  it('reports FIS and app failures but still restores every mapping', async () => {
    const calls: string[][] = []
    const result = await restoreRegionalResources({ ...fixture(), experimentId: 'EXP123' }, async (_region, args) => {
      calls.push(args)
      if (args[0] === 'fis') throw new Error('FIS unavailable')
      if (args[1] === 'delete-function-concurrency') throw new Error('app unavailable')
      return { State: 'Enabled' }
    }, clock())
    expect(result.restored).toBe(false)
    expect(result.errors).toHaveLength(2)
    expect(calls.filter(c => c[1] === 'get-event-source-mapping')).toHaveLength(4)
  })
  it('preserves pre-existing concurrency and retries transient errors', async () => {
    let attempts = 0
    const result = await restoreRegionalResources({ ...fixture(), originalConcurrency: 7 }, async (_region, args) => {
      if (args[1] === 'put-function-concurrency') { expect(args.at(-1)).toBe('7'); if (++attempts === 1) throw new Error('transient') }
      return { State: 'Enabled', ReservedConcurrentExecutions: 7 }
    }, clock())
    expect(result.restored).toBe(true); expect(attempts).toBe(2)
  })
  it('bounds nonterminal FIS waiting and continues restoration', async () => {
    let appRestored = false
    const timer = clock()
    const result = await restoreRegionalResources({ ...fixture(), experimentId: 'EXP123' }, async (_region, args) => {
      if (args[0] === 'fis') return { experiment: { state: { status: 'running' } } }
      if (args[1] === 'delete-function-concurrency') appRestored = true
      return { State: 'Enabled' }
    }, timer)
    expect(result.restored).toBe(false); expect(appRestored).toBe(true)
    expect(timer.now()).toBeLessThan(20000)
  })
})
