import { validateDirectoryEntry, type DirectoryEntry } from './protocol.ts'

export interface DirectoryConfig {
  endpoints: readonly [string, string]
  ownerRegions: readonly [string, string]
  cacheMs: number
  timeoutMs: number
}
export type ReadItem = (region: string, shardId: string, signal: AbortSignal) => Promise<unknown>

/** Read-only routing hints. Never an authorization service or promotion writer. */
export class Directory {
  private cache = new Map<number, { entry: DirectoryEntry; expiresAt: number }>()
  private config: DirectoryConfig
  private read: ReadItem
  private now: () => number
  constructor(config: DirectoryConfig, read: ReadItem, now = Date.now) {
    this.config = config
    this.read = read
    this.now = now
    if (!Number.isInteger(config.cacheMs) || config.cacheMs < 0 || config.cacheMs > 1000
      || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2000
      || config.endpoints.length !== 2 || config.endpoints[0] === config.endpoints[1]) throw new Error('Invalid directory client configuration')
  }
  async lookup(shard: number): Promise<DirectoryEntry> {
    const cached = this.cache.get(shard)
    if (cached && this.now() < cached.expiresAt) return { ...cached.entry }
    this.cache.delete(shard)
    for (const region of this.config.endpoints) {
      let raw: unknown
      try {
        const signal = AbortSignal.timeout(this.config.timeoutMs)
        // Race explicitly: an injected transport must not defeat the total bound.
        raw = await Promise.race([
          this.read(region, `v1:${String(shard).padStart(2, '0')}`, signal),
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
        ])
      } catch { continue }
      // A successful strongly consistent read of missing/invalid ownership is
      // authoritative failure, not a reason to shop for another answer.
      const entry = validateDirectoryEntry(raw, { now: this.now(), expectedShard: shard, regions: this.config.ownerRegions })
      const expiresAt = Math.min(this.now() + this.config.cacheMs, entry.leaseExpiresAt)
      this.cache.set(shard, { entry, expiresAt })
      return { ...entry }
    }
    throw new Error('Ownership directory unavailable; no fallback owner')
  }
}
