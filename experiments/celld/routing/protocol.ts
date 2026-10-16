import { createHash } from 'node:crypto'

/** Changing either value requires an explicit directory/data migration. */
export const ROUTING_VERSION = 'v1' as const
export const SHARD_COUNT = 64 as const

const canonicalPath = /^\/api\/(?:objects\/Counter|workflows\/Validation)\/test-[A-Za-z0-9_-]{1,64}$/

/**
 * Accept a raw pathname, not a decoded/normalized URL. Query strings, fragments,
 * percent escapes, alternate namespaces and path aliases are never routing keys.
 * The ingress must reject routing overrides before extracting the pathname.
 */
export function canonicalKey(pathname: string): string {
  if (typeof pathname !== 'string' || !canonicalPath.test(pathname)) {
    throw new Error('Invalid canonical stateful path')
  }
  return pathname
}

/** The namespace is part of the hash. Health and ownership never change shards. */
export function shardFor(key: string): number {
  const digest = createHash('sha256').update(`${ROUTING_VERSION}\0${canonicalKey(key)}`, 'utf8').digest()
  return digest.readUInt32BE(0) % SHARD_COUNT
}

export interface DirectoryEntry {
  routingVersion: typeof ROUTING_VERSION
  shardCount: typeof SHARD_COUNT
  shardId: string
  status: 'ACTIVE'
  homeRegion: string
  activeRegion: string
  epoch: number
  leaseExpiresAt: number
}

export interface DirectoryValidation {
  /** Explicit clock in Unix milliseconds; do not mix seconds and milliseconds. */
  now: number
  /** Deployment configuration, not regions selected by a client or health probe. */
  regions: readonly [string, string]
  expectedShard: number
}

const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const validShard = (value: unknown): value is number => safeInteger(value) && value >= 0 && value < SHARD_COUNT

/**
 * Fail closed on missing, stale or incompatible directory state. This only
 * validates ingress routing metadata: it is NOT a celld storage/execution fence.
 */
export function validateDirectoryEntry(value: unknown, config: DirectoryValidation): DirectoryEntry {
  const entry = validateActiveMetadata(value, config)
  if (entry.leaseExpiresAt <= config.now) throw new Error('Directory lease expired')
  return entry
}

/** Structural ACTIVE metadata only; NEVER use this to authorize routing. */
export function validateActiveMetadata(value: unknown, config: DirectoryValidation): DirectoryEntry {
  if (!safeInteger(config.now) || config.now < 0 || !validShard(config.expectedShard)
    || !Array.isArray(config.regions) || config.regions.length !== 2
    || config.regions.some((region) => typeof region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))
    || config.regions[0] === config.regions[1]) {
    throw new Error('Invalid directory validation configuration')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Missing or invalid directory entry')
  }
  const entry = value as Record<string, unknown>
  if (entry.routingVersion !== ROUTING_VERSION || entry.shardCount !== SHARD_COUNT
    || entry.shardId !== `v1:${String(config.expectedShard).padStart(2, '0')}`
    || entry.status !== 'ACTIVE'
    || typeof entry.homeRegion !== 'string' || !config.regions.includes(entry.homeRegion)
    || typeof entry.activeRegion !== 'string' || !config.regions.includes(entry.activeRegion)
    || !safeInteger(entry.epoch) || entry.epoch < 1
    || !safeInteger(entry.leaseExpiresAt) || entry.leaseExpiresAt < 0) {
    throw new Error('Directory entry is not valid active ownership')
  }
  // Copy validated fields only; callers cannot accidentally consume unvalidated overrides.
  return {
    routingVersion: ROUTING_VERSION, shardCount: SHARD_COUNT, shardId: entry.shardId as string,
    status: 'ACTIVE', homeRegion: entry.homeRegion, activeRegion: entry.activeRegion, epoch: entry.epoch,
    leaseExpiresAt: entry.leaseExpiresAt,
  }
}
