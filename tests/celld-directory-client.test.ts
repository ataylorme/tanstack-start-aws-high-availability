import { describe, expect, it, vi } from 'vitest'
import { Directory } from '../experiments/celld/routing/directory.ts'
const config = { endpoints: ['us-east-1', 'us-west-2'] as const, ownerRegions: ['us-east-1', 'us-west-1'] as const, cacheMs: 100, timeoutMs: 10 }
const entry = { routingVersion: 'v1', shardCount: 64, shardId: 'v1:03', homeRegion: 'us-east-1', activeRegion: 'us-east-1', epoch: 1, leaseExpiresAt: 1000, status: 'ACTIVE' }
describe('celld directory routing hints', () => {
  it('caches briefly then refreshes; never lets caller mutate cached ownership', async () => {
    let now = 0
    const read = vi.fn().mockResolvedValue(entry)
    const client = new Directory(config, read, () => now)
    const first = await client.lookup(3); first.epoch = 55
    now = 99
    expect((await client.lookup(3)).epoch).toBe(1)
    expect(read).toHaveBeenCalledTimes(1)
    now = 100; await client.lookup(3)
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('fails over transport errors to explicit regional endpoints', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('endpoint unavailable')).mockResolvedValueOnce(entry)
    expect((await new Directory(config, read, () => 0).lookup(3)).activeRegion).toBe('us-east-1')
    expect(read.mock.calls.map(call => call[0])).toEqual(config.endpoints)
  })
  it('fails closed after both endpoint failures', async () => {
    const client = new Directory(config, vi.fn().mockRejectedValue(new Error('quorum')), () => 0)
    await expect(client.lookup(3)).rejects.toThrow('no fallback owner')
  })
  it.each([null, { ...entry, status: 'FENCING' }, { ...entry, epoch: 0 }, { ...entry, leaseExpiresAt: 0 }])('does not fail over authoritative invalid ownership', async value => {
    const read = vi.fn().mockResolvedValue(value)
    await expect(new Directory(config, read, () => 0).lookup(3)).rejects.toThrow()
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('never serves stale cache during directory outage', async () => {
    let now = 0
    const read = vi.fn().mockResolvedValueOnce(entry).mockRejectedValue(new Error('offline'))
    const client = new Directory(config, read, () => now)
    await client.lookup(3); now = 100
    await expect(client.lookup(3)).rejects.toThrow('unavailable')
  })
  it('expires cache at lease boundary even if cache TTL remains', async () => {
    let now = 950
    const read = vi.fn().mockResolvedValue(entry)
    const client = new Directory(config, read, () => now)
    await client.lookup(3); now = 1000
    await expect(client.lookup(3)).rejects.toThrow()
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('bounds even a hanging transport before endpoint failover', async () => {
    const read = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(entry)
    expect((await new Directory(config, read, () => 0).lookup(3)).epoch).toBe(1)
  })
  it('rejects unbounded caching', () => {
    expect(() => new Directory({ ...config, cacheMs: 10_000 }, vi.fn())).toThrow()
  })
})
