import { ROUTING_VERSION, SHARD_COUNT, validateDirectoryEntry, validateActiveMetadata } from '../routing/protocol.ts'
import type { DirectoryEntry, DirectoryValidation } from '../routing/protocol.ts'

/** Routing metadata commands only: NOT a celld execution/storage fence. */
export const MAX_LEASE_MS = 90_000
export type OwnershipConfig = DirectoryValidation
export interface OwnershipCommand {
  operation: 'put' | 'update'
  key: { shardId: string }
  item?: Record<string, string | number>
  updateExpression?: string
  conditionExpression: string
  expressionAttributeNames: Record<string, string>
  expressionAttributeValues?: Record<string, string | number>
}

function transition(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) throw new Error('Invalid transition ID')
  return value
}

function increment(epoch: number): number {
  if (!Number.isSafeInteger(epoch + 1)) throw new Error('Epoch exhausted')
  return epoch + 1
}

/** Create only inert FENCING metadata. Existing rows may never be overwritten. */
export function buildInitialFencing(
  input: { shardId: string; homeRegion: string; transitionId: string },
  config: OwnershipConfig,
): OwnershipCommand {
  // Reuse routing's exact shard, region-pair and explicit clock validation.
  const probe = validateDirectoryEntry({
    routingVersion: ROUTING_VERSION, shardCount: SHARD_COUNT, shardId: input.shardId,
    homeRegion: input.homeRegion, activeRegion: input.homeRegion,
    status: 'ACTIVE', epoch: 1, leaseExpiresAt: config.now + 1,
  }, config)
  return {
    operation: 'put', key: { shardId: probe.shardId },
    item: { ...probe, status: 'FENCING', leaseExpiresAt: config.now, transitionId: transition(input.transitionId) },
    conditionExpression: 'attribute_not_exists(#key)', expressionAttributeNames: { '#key': 'shardId' },
  }
}

function expectedCommand(expected: unknown, config: OwnershipConfig, requireLiveLease = true): { entry: DirectoryEntry; command: OwnershipCommand } {
  const entry = requireLiveLease ? validateDirectoryEntry(expected, config) : validateActiveMetadata(expected, config)
  return {
    entry,
    command: {
      operation: 'update', key: { shardId: entry.shardId },
      // Match the observed lease too: a concurrent renewal makes this command
      // stale, not a permission to overwrite the newly observed owner state.
      conditionExpression: 'attribute_exists(#key) AND #version = :version AND #count = :count AND #status = :active AND #epoch = :epoch AND #region = :region AND #home = :home AND #lease = :expectedLease' + (requireLiveLease ? ' AND #lease > :now' : ''),
      expressionAttributeNames: {
        '#key': 'shardId', '#version': 'routingVersion', '#count': 'shardCount',
        '#status': 'status', '#epoch': 'epoch', '#region': 'activeRegion', '#home': 'homeRegion', '#lease': 'leaseExpiresAt',
      },
      expressionAttributeValues: {
        ':version': ROUTING_VERSION, ':count': SHARD_COUNT, ':active': 'ACTIVE', ':epoch': entry.epoch,
        ':region': entry.activeRegion, ':home': entry.homeRegion, ':expectedLease': entry.leaseExpiresAt, ':now': config.now,
      },
    },
  }
}

/** Invalidate routing ownership; this does not stop old runtime/background work. */
export function buildBeginFencing(expected: unknown, transitionId: string, config: OwnershipConfig): OwnershipCommand {
  // Revocation may remove an expired owner, but must still CAS the exact row.
  const { entry, command } = expectedCommand(expected, config, false)
  return {
    ...command,
    updateExpression: 'SET #status = :fencing, #epoch = :nextEpoch, #lease = :now, #transition = :transition',
    expressionAttributeNames: { ...command.expressionAttributeNames, '#transition': 'transitionId' },
    expressionAttributeValues: {
      ...command.expressionAttributeValues, ':fencing': 'FENCING', ':nextEpoch': increment(entry.epoch), ':transition': transition(transitionId),
    },
  }
}

/** Renew only an existing, unexpired ACTIVE row; never change region or epoch. */
export function buildRenewal(expected: unknown, leaseMs: number, config: OwnershipConfig): OwnershipCommand {
  const { entry, command } = expectedCommand(expected, config)
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) throw new Error('Invalid lease duration')
  const expiry = config.now + leaseMs
  if (!Number.isSafeInteger(expiry) || expiry <= entry.leaseExpiresAt) throw new Error('Renewal must extend the existing lease safely')
  return {
    ...command, updateExpression: 'SET #lease = :nextLease',
    expressionAttributeValues: { ...command.expressionAttributeValues, ':nextLease': expiry },
  }
}

// Intentionally no promote, acquire, activate, fallback, or multi-item operation.
// Builders have no clock or I/O. Execute promptly with a freshly supplied clock;
// DynamoDB evaluates :now as a literal, not as server time. Do not queue commands
// for later replay. Conditional failure requires a new strongly consistent read
// and explicit policy decision, never an unconditional retry.
