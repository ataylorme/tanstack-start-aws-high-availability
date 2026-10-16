import { describe, expect, it } from 'vitest'
import { validateCleanupStacks, validateDeleteConfirmation } from '../experiments/celld/operations/cleanup.ts'
const account = '0'.repeat(12), prefix = 'tanstack-celld-fixture'
const stack = (suffix: string, region: 'us-east-1' | 'us-west-2' = 'us-east-1') => ({ region, stackName: `${prefix}-${suffix}`, stackId: `arn:aws:cloudformation:${region}:${account}:stack/${prefix}-${suffix}/fixture-uuid`, status: 'CREATE_COMPLETE', retained: [] })
describe('isolated destructive-cleanup gates', () => {
  it('orders ingress before compute and directory before its execution role', () => {
    const plan = validateCleanupStacks(prefix, account, [stack('directory-deployer'), stack('ownership-writer'), stack('regional'), stack('directory'), stack('global'), stack('regional', 'us-west-2')])
    expect(plan.map(item => [item.region, item.stackName])).toEqual([['us-east-1', `${prefix}-global`], ['us-west-2', `${prefix}-regional`], ['us-east-1', `${prefix}-regional`], ['us-east-1', `${prefix}-ownership-writer`], ['us-east-1', `${prefix}-directory`], ['us-east-1', `${prefix}-directory-deployer`]])
  })
  it.each([{ stackName: 'baseline-regional' }, { region: 'us-east-2' }, { stackId: 'arn:foreign' }, { status: 'UPDATE_IN_PROGRESS' }, { stackName: `${prefix}-unknown` }])('rejects foreign/ambiguous scope %#', override => {
    expect(() => validateCleanupStacks(prefix, account, [{ ...stack('regional'), ...override } as any])).toThrow()
  })
  it('rejects duplicates, unsupported regional stacks and empty plans', () => {
    expect(() => validateCleanupStacks(prefix, account, [stack('regional'), stack('regional')])).toThrow()
    expect(() => validateCleanupStacks(prefix, account, [stack('global', 'us-west-2')])).toThrow()
    expect(() => validateCleanupStacks(prefix, account, [])).toThrow()
    expect(() => validateCleanupStacks('baseline', account, [stack('regional')])).toThrow()
  })
  it('requires all destructive flags, not a plan or generic execute switch', () => {
    for (const input of [{ execute: false, confirmation: prefix, acknowledgedRetainedCosts: true }, { execute: true, acknowledgedRetainedCosts: true }, { execute: true, confirmation: 'other', acknowledgedRetainedCosts: true }, { execute: true, confirmation: prefix, acknowledgedRetainedCosts: false }]) expect(() => validateDeleteConfirmation(prefix, input)).toThrow()
    expect(() => validateDeleteConfirmation(prefix, { execute: true, confirmation: prefix, acknowledgedRetainedCosts: true })).not.toThrow()
  })
})
