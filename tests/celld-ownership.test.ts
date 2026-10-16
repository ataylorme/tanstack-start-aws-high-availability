import { describe, expect, it } from 'vitest'
import * as protocol from '../experiments/celld/ownership/protocol'

const config = { now: 1_800_000_000_000, expectedShard: 7, regions: ['us-east-1', 'us-west-2'] as const }
const entry = { routingVersion: 'v1', shardCount: 64, shardId: 'v1:07', status: 'ACTIVE', homeRegion: 'us-east-1', activeRegion: 'us-east-1', epoch: 12, leaseExpiresAt: config.now + 1000 }
const seed = { shardId: entry.shardId, homeRegion: entry.homeRegion, transitionId: 'test-transition_1' }
const conditions = 'attribute_exists(#key) AND #version = :version AND #count = :count AND #status = :active AND #epoch = :epoch AND #region = :region AND #home = :home AND #lease = :expectedLease AND #lease > :now'

describe('single-item ownership metadata commands (not runtime fencing)', () => {
  it('initializes only inert FENCING metadata, guarded against overwrite', () => {
    const command = protocol.buildInitialFencing(seed, config)
    expect(command.operation).toBe('put')
    expect(command.key).toEqual({ shardId: 'v1:07' })
    expect(command.conditionExpression).toBe('attribute_not_exists(#key)')
    expect(command.item).toEqual({ ...entry, status: 'FENCING', epoch: 1, leaseExpiresAt: config.now, transitionId: seed.transitionId })
  })
  it('begins fencing only by CAS on the observed active epoch, region and lease', () => {
    const command = protocol.buildBeginFencing(entry, 'test-fence', config)
    expect(command.operation).toBe('update')
    expect(command.conditionExpression).toBe(conditions.replace(' AND #lease > :now', ''))
    expect(command.updateExpression).toBe('SET #status = :fencing, #epoch = :nextEpoch, #lease = :now, #transition = :transition')
    expect(command.expressionAttributeValues).toEqual({ ':version': 'v1', ':count': 64, ':active': 'ACTIVE', ':epoch': 12, ':region': 'us-east-1', ':home': 'us-east-1', ':expectedLease': entry.leaseExpiresAt, ':now': config.now, ':fencing': 'FENCING', ':nextEpoch': 13, ':transition': 'test-fence' })
  })
  it('renews a live lease without granting a new epoch or changing owner/status', () => {
    const command = protocol.buildRenewal(entry, 90_000, config)
    expect(command.conditionExpression).toBe(conditions)
    expect(command.updateExpression).toBe('SET #lease = :nextLease')
    expect(command.expressionAttributeValues?.[':nextLease']).toBe(config.now + 90_000)
    expect(command).not.toHaveProperty('item')
  })
  it.each(['v1:7', 'v1:007', 'v1:64', 'v2:07', 'v1:08', '', '../v1:07', 'v1:07?region=us-west-2'])('rejects invalid/mismatched key %s', shardId => {
    expect(() => protocol.buildInitialFencing({ ...seed, shardId }, config)).toThrow()
    expect(() => protocol.buildBeginFencing({ ...entry, shardId }, 'x', config)).toThrow()
  })
  it.each(['', 'a'.repeat(97), 'a b', 'a/b', 'é', 'a\n'])('rejects invalid transition IDs %#', transitionId => {
    expect(() => protocol.buildInitialFencing({ ...seed, transitionId }, config)).toThrow()
    expect(() => protocol.buildBeginFencing(entry, transitionId, config)).toThrow()
  })
  it.each([
    { epoch: 0 }, { epoch: -1 }, { epoch: 1.5 }, { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'FENCING' }, { status: 'PROMOTING' }, { activeRegion: 'us-west-1' },
    { homeRegion: 'us-east-2' }, { leaseExpiresAt: -1 },
    { leaseExpiresAt: Infinity }, { routingVersion: 'v2' }, { shardCount: 32 },
  ])('rejects invalid/expired expected state %#', override => {
    expect(() => protocol.buildBeginFencing({ ...entry, ...override }, 'x', config)).toThrow()
    expect(() => protocol.buildRenewal({ ...entry, ...override }, 90_000, config)).toThrow()
  })
  it.each([config.now, config.now - 1, 0])('permits expired metadata revocation but never expired renewal (%s)', leaseExpiresAt => {
    const expired = { ...entry, leaseExpiresAt }
    const command = protocol.buildBeginFencing(expired, 'expired-revocation', config)
    expect(command.expressionAttributeValues?.[':expectedLease']).toBe(leaseExpiresAt)
    expect(command.expressionAttributeValues?.[':fencing']).toBe('FENCING')
    expect(command.conditionExpression).not.toContain('#lease > :now')
    expect(() => protocol.buildRenewal(expired, 90_000, config)).toThrow()
  })
  it('fails closed for absent state and epoch exhaustion', () => {
    for (const value of [null, undefined, {}, []]) expect(() => protocol.buildRenewal(value, 90_000, config)).toThrow()
    expect(() => protocol.buildBeginFencing({ ...entry, epoch: Number.MAX_SAFE_INTEGER }, 'x', config)).toThrow()
  })
  it.each([0, -1, 1.5, 90_001, NaN, Infinity])('rejects unbounded lease duration %s', duration => {
    expect(() => protocol.buildRenewal(entry, duration, config)).toThrow()
  })
  it('refuses lease shortening or unsafe expiry arithmetic', () => {
    expect(() => protocol.buildRenewal(entry, 1000, config)).toThrow()
    expect(() => protocol.buildRenewal({ ...entry, leaseExpiresAt: Number.MAX_SAFE_INTEGER }, 90_000, { ...config, now: Number.MAX_SAFE_INTEGER - 1 })).toThrow()
  })
  it.each([{ now: NaN }, { now: -1 }, { now: 1.5 }, { expectedShard: 64 }, { regions: ['us-east-1', 'us-east-1'] }])('rejects invalid explicit clock/config %#', override => {
    expect(() => protocol.buildInitialFencing(seed, { ...config, ...override } as typeof config)).toThrow()
  })
  it('keeps snapshots immutable and binds concurrent renewal changes to CAS', () => {
    const before = JSON.stringify(entry)
    const old = protocol.buildRenewal(entry, 90_000, config)
    const fresh = protocol.buildRenewal({ ...entry, leaseExpiresAt: config.now + 2000 }, 90_000, config)
    expect(old.expressionAttributeValues?.[':expectedLease']).not.toBe(fresh.expressionAttributeValues?.[':expectedLease'])
    expect(JSON.stringify(entry)).toBe(before)
  })
  it('exposes no promotion, acquisition, transaction, TTL, fallback or region-switch API', () => {
    expect(Object.keys(protocol).sort()).toEqual(['MAX_LEASE_MS', 'buildBeginFencing', 'buildInitialFencing', 'buildRenewal'].sort())
    for (const command of [protocol.buildInitialFencing(seed, config), protocol.buildBeginFencing(entry, 'x', config), protocol.buildRenewal(entry, 90_000, config)]) {
      expect(command.key).toEqual({ shardId: entry.shardId })
      expect(command).not.toHaveProperty('transactions')
      expect(command).not.toHaveProperty('fallback')
      expect(Object.values(command.expressionAttributeNames)).not.toContain('ttl')
    }
  })
})
