import { describe, expect, it } from 'vitest'
import { canonicalKey, shardFor, validateDirectoryEntry } from '../experiments/celld/routing/protocol'

const path = '/api/objects/Counter/test-alpha'
const config = { now: 1_800_000_000_000, regions: ['us-east-1', 'us-west-1'] as const, expectedShard: 58 }
const entry = {
  routingVersion: 'v1', shardCount: 64, shardId: 'v1:58', status: 'ACTIVE',
  homeRegion: 'us-east-1', activeRegion: 'us-east-1', epoch: 1,
  leaseExpiresAt: config.now + 10_000,
}

describe('celld routing protocol v1', () => {
  it('accepts only exact namespaced IDs within the ASCII bound', () => {
    expect(canonicalKey(path)).toBe(path)
    expect(canonicalKey('/api/workflows/Validation/test-A_9-z')).toContain('/workflows/Validation/')
    expect(canonicalKey(`/api/objects/Counter/test-${'a'.repeat(64)}`)).toBeTruthy()
  })
  it.each([
    '/api/objects/Counter/test-', `/api/objects/Counter/test-${'a'.repeat(65)}`,
    '/api/objects/Other/test-alpha', '/api/workflows/Counter/test-alpha',
    '/api/objects/counter/test-alpha', '/api/objects/Counter/alpha',
    '/api/objects/Counter/test-☃', '/api/objects/Counter/test-a.b',
    '/api/objects/Counter/test-a%2Fb', '/api/objects/Counter/test-%61',
    '/api/objects/Counter/test-%252e%252e', '/api/objects/Counter/../test-alpha',
    '/api/objects/Counter//test-alpha', `${path}/`, `${path}\n`,
    `${path}?region=us-west-1`, `${path}?activeRegion=us-west-1`, `${path}#us-west-1`,
    `https://example.com${path}`, `${path}\\evil`, '',
  ])('rejects noncanonical input %s', (value) => {
    expect(() => canonicalKey(value)).toThrow()
    expect(() => shardFor(value)).toThrow()
  })
  it('locks deterministic hashing vectors including namespace', () => {
    expect(shardFor(path)).toBe(58)
    expect(shardFor('/api/workflows/Validation/test-alpha')).toBe(20)
    for (let i = 0; i < 100; i++) {
      const shard = shardFor(`/api/objects/Counter/test-${i}`)
      expect(shard).toBeGreaterThanOrEqual(0)
      expect(shard).toBeLessThan(64)
    }
  })
  it('does not remap a shard when owner or health changes', () => {
    for (const activeRegion of config.regions) {
      const validated = validateDirectoryEntry({ ...entry, activeRegion, healthyRegions: [] }, config)
      expect(validated.activeRegion).toBe(activeRegion)
      expect(shardFor(path)).toBe(58)
      expect(validated).not.toHaveProperty('healthyRegions')
    }
  })
})

describe('celld directory fail-closed validation', () => {
  it('copies only valid ownership fields', () => {
    expect(validateDirectoryEntry(entry, config)).toEqual(entry)
    expect(validateDirectoryEntry(entry, config)).not.toBe(entry)
  })
  it.each([undefined, null, [], 'ACTIVE', {}])('rejects absent or malformed state %#', (value) => {
    expect(() => validateDirectoryEntry(value, config)).toThrow()
  })
  it.each([
    { status: 'PROMOTING' }, { status: 'FENCED' }, { status: 'active' },
    { epoch: 0 }, { epoch: -1 }, { epoch: 1.5 }, { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { epoch: '1' }, { epoch: NaN }, { leaseExpiresAt: config.now },
    { leaseExpiresAt: config.now - 1 }, { leaseExpiresAt: Infinity },
    { leaseExpiresAt: String(config.now + 100) }, { leaseExpiresAt: 1_800_000_010 },
    { routingVersion: 'v2' }, { shardCount: 128 }, { shardId: 'v1:59' },
    { shardId: 'v1:058' }, { shardId: 58 }, { homeRegion: 'us-east-2' },
    { activeRegion: 'us-east-2' }, { activeRegion: '' },
  ])('rejects invalid, expired or incompatible ownership %#', (override) => {
    expect(() => validateDirectoryEntry({ ...entry, ...override }, config)).toThrow()
  })
  it.each(Object.keys(entry))('requires field %s', (field) => {
    const incomplete: Record<string, unknown> = { ...entry }
    delete incomplete[field]
    expect(() => validateDirectoryEntry(incomplete, config)).toThrow()
  })
  it.each([
    { now: NaN }, { now: -1 }, { now: 1.5 }, { expectedShard: 64 },
    { expectedShard: -1 }, { expectedShard: 1.5 },
    { regions: ['us-east-1', 'us-east-1'] }, { regions: ['us-east-1'] },
    { regions: ['us-east-1', 'us-west-1', 'us-east-2'] },
    { regions: ['us-east-1', 'arbitrary'] },
  ])('rejects malformed deployment config %#', (override) => {
    expect(() => validateDirectoryEntry(entry, { ...config, ...override } as typeof config)).toThrow()
  })
})
