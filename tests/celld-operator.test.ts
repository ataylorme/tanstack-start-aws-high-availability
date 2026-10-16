import { describe, it, expect } from 'vitest'
import { attributes, matchesFencingOutcome, planOperation, writeInput } from '../experiments/celld/ownership/operator.ts'
const config = { now: 1000, expectedShard: 7, regions: ['us-east-1', 'us-west-2'] as const }
const input = { action: 'initialize-fencing' as const, shardId: 'v1:07', homeRegion: 'us-east-1', transitionId: 'test-init' }
const active = { routingVersion: 'v1', shardCount: 64, shardId: 'v1:07', status: 'ACTIVE', epoch: 1, homeRegion: 'us-east-1', activeRegion: 'us-east-1', leaseExpiresAt: 0 }
describe('inert single-shard operator', () => {
  it('creates only conditional FENCING input for an absent item', () => {
    const command = planOperation(input, undefined, config)
    const request = writeInput('tanstack-celld-test-ownership', command)
    expect(request.ConditionExpression).toBe('attribute_not_exists(#key)')
    expect(request).toHaveProperty('Item.status.S', 'FENCING')
    expect(request).not.toHaveProperty('TransactItems')
    expect(matchesFencingOutcome(command, command.item)).toBe(true)
    expect(() => planOperation(input, active, config)).toThrow()
  })
  it('revokes expired ACTIVE metadata with exact observed state CAS', () => {
    const command = planOperation({ ...input, action: 'begin-fencing' }, active, config)
    const result = { ...active, status: 'FENCING', epoch: 2, leaseExpiresAt: 1000, transitionId: input.transitionId }
    expect(matchesFencingOutcome(command, result)).toBe(true)
    for (const override of [{ epoch: 3 }, { transitionId: 'other' }, { activeRegion: 'us-west-2' }, { status: 'ACTIVE' }, { leaseExpiresAt: 999 }, { shardId: 'v1:08' }]) expect(matchesFencingOutcome(command, { ...result, ...override })).toBe(false)
    expect(matchesFencingOutcome(command, null)).toBe(false)
  })
  it('rejects activation, mismatched shard/home and non-experiment tables', () => {
    expect(() => planOperation({ ...input, action: 'activate' } as any, active, config)).toThrow()
    expect(() => planOperation({ ...input, shardId: 'v1:08' }, undefined, config)).toThrow()
    expect(() => planOperation({ ...input, action: 'begin-fencing', homeRegion: 'us-west-2' }, active, config)).toThrow()
    expect(() => writeInput('production', planOperation(input, undefined, config))).toThrow()
  })
  it('serializes only safe string/integer attributes', () => {
    expect(attributes({ key: 'x', epoch: 2 })).toEqual({ key: { S: 'x' }, epoch: { N: '2' } })
    expect(() => attributes({ epoch: Infinity })).toThrow()
    expect(() => attributes({ epoch: 1.5 })).toThrow()
  })
})
