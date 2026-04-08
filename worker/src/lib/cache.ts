/**
 * Multi-tier Cache Service - L1 (KV) + L2 (D1) caching with automatic fallback
 *
 * Provides fast in-memory-like caching via Cloudflare KV (L1) and persistent
 * caching via Cloudflare D1 (L2) for larger datasets and cross-request consistency.
 */

import type { KVNamespace, D1Database } from '@cloudflare/workers-types'

export interface CacheOptions {
  /** Time to live in seconds */
  ttlSeconds: number
  /** Optional tags for cache invalidation by category */
  tags?: string[]
}

export interface CacheEntry<T> {
  value: T
  expiresAt: number
  tags: string[]
}

/**
 * Multi-tier cache using KV (L1) and D1 (L2)
 *
 * L1 (KV): Fast, edge-distributed, eventual consistency
 * L2 (D1): Persistent, SQL-queryable, strong consistency
 */
export class MultiTierCache {
  private readonly L1_PREFIX = 'cache:v1:'
  private readonly L2_TABLE = 'pa_query_cache'

  constructor(
    private kv: KVNamespace,
    private d1: D1Database,
    options?: { tablePrefix?: string }
  ) {
    if (options?.tablePrefix) {
      this.L2_TABLE = `${options.tablePrefix}_query_cache`
    }
  }

  /**
   * Initialize the L2 cache table in D1
   * Call this once during worker startup or as a migration
   */
  async initialize(): Promise<void> {
    await this.d1.exec(`
      CREATE TABLE IF NOT EXISTS ${this.L2_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        expires_at INTEGER NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_${this.L2_TABLE}_expires ON ${this.L2_TABLE}(expires_at);
      CREATE INDEX IF NOT EXISTS idx_${this.L2_TABLE}_tags ON ${this.L2_TABLE}(tags);
    `)
  }

  /**
   * Get value from cache (L1 first, then L2)
   * @returns Cached value or null if not found/expired
   */
  async get<T>(key: string): Promise<T | null> {
    // Try L1 (KV) first
    const l1Result = await this.kv.getWithMetadata<{ expiresAt: number }>(this.L1_KEY(key))

    if (l1Result.value) {
      // Check if expired
      if (l1Result.metadata && l1Result.metadata.expiresAt < Date.now()) {
        await this.kv.delete(this.L1_KEY(key))
      } else {
        try {
          return JSON.parse(l1Result.value) as T
        } catch {
          // Invalid JSON, treat as miss
          await this.kv.delete(this.L1_KEY(key))
        }
      }
    }

    // Try L2 (D1)
    const row = await this.d1
      .prepare(`SELECT value, tags, expires_at FROM ${this.L2_TABLE} WHERE key = ?`)
      .bind(key)
      .first<{ value: string; tags: string; expires_at: number }>()

    if (row) {
      const expiresAt = row.expires_at * 1000 // Convert to ms
      if (expiresAt < Date.now()) {
        // Expired, delete and return null
        await this.d1.prepare(`DELETE FROM ${this.L2_TABLE} WHERE key = ?`).bind(key).run()
        return null
      }

      // L2 hit - populate L1 for next time
      try {
        const value = JSON.parse(row.value) as T
        const l1Ttl = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))
        await this.kv.put(this.L1_KEY(key), row.value, {
          expirationTtl: Math.min(l1Ttl, 86400), // Max 1 day for L1
          metadata: { expiresAt },
        })
        return value
      } catch {
        // Invalid JSON in L2
        await this.d1.prepare(`DELETE FROM ${this.L2_TABLE} WHERE key = ?`).bind(key).run()
      }
    }

    return null
  }

  /**
   * Store value in both L1 and L2 cache
   */
  async set<T>(key: string, value: T, options: CacheOptions): Promise<void> {
    const serialized = JSON.stringify(value)
    const expiresAt = Date.now() + options.ttlSeconds * 1000
    const tags = options.tags ?? []

    // Write to L1 (KV) - shorter TTL for edge cache
    const l1Ttl = Math.min(options.ttlSeconds, 86400) // Max 1 day
    await this.kv.put(this.L1_KEY(key), serialized, {
      expirationTtl: l1Ttl,
      metadata: { expiresAt },
    })

    // Write to L2 (D1) - full TTL
    await this.d1
      .prepare(
        `INSERT OR REPLACE INTO ${this.L2_TABLE} (key, value, tags, expires_at) VALUES (?, ?, ?, ?)`
      )
      .bind(key, serialized, JSON.stringify(tags), Math.floor(expiresAt / 1000))
      .run()
  }

  /**
   * Invalidate a specific cache key
   */
  async invalidate(key: string): Promise<void> {
    await Promise.all([
      this.kv.delete(this.L1_KEY(key)),
      this.d1.prepare(`DELETE FROM ${this.L2_TABLE} WHERE key = ?`).bind(key).run(),
    ])
  }

  /**
   * Invalidate cache entries matching a key pattern
   * Note: This is expensive for large caches - prefer invalidateTags
   */
  async invalidatePattern(pattern: string): Promise<void> {
    // D1 does not support LIKE with wildcards in DELETE, so we need to query first
    const rows = await this.d1
      .prepare(`SELECT key FROM ${this.L2_TABLE} WHERE key LIKE ?`)
      .bind(`%${pattern}%`)
      .all<{ key: string }>()

    const keys = rows.results ?? []

    await Promise.all([
      // Delete from L1
      ...keys.map((row) => this.kv.delete(this.L1_KEY(row.key))),
      // Delete from L2
      this.d1.prepare(`DELETE FROM ${this.L2_TABLE} WHERE key LIKE ?`).bind(`%${pattern}%`).run(),
    ])
  }

  /**
   * Invalidate cache entries by tag(s)
   */
  async invalidateTags(tags: string[]): Promise<void> {
    for (const tag of tags) {
      // Find all keys with this tag
      const rows = await this.d1
        .prepare(`SELECT key FROM ${this.L2_TABLE} WHERE tags LIKE ?`)
        .bind(`%${tag}%`)
        .all<{ key: string }>()

      const keys = rows.results ?? []

      await Promise.all([
        // Delete from L1
        ...keys.map((row) => this.kv.delete(this.L1_KEY(row.key))),
        // Delete from L2
        this.d1.prepare(`DELETE FROM ${this.L2_TABLE} WHERE tags LIKE ?`).bind(`%${tag}%`).run(),
      ])
    }
  }

  /**
   * Generate a consistent cache key from SQL query and parameters
   */
  generateKey(sql: string, params: unknown[]): string {
    // Normalize SQL (remove extra whitespace)
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    // Hash params for consistency
    const paramsHash = this.hashParams(params)
    return `q:${normalized}:${paramsHash}`
  }

  /**
   * Check if a query should be cached (skippable hints)
   */
  shouldCacheQuery(sql: string): boolean {
    const upper = sql.toUpperCase()
    // Skip caching for explicit no-cache hints
    if (upper.includes('/* NO_CACHE */') || upper.includes('/*! NO_CACHE */')) {
      return false
    }
    // Only cache SELECT statements
    if (!upper.trim().startsWith('SELECT')) {
      return false
    }
    // Skip caching for queries with non-deterministic functions
    const nonDeterministic = ['NOW()', 'RANDOM()', 'UUID_GENERATE_V4()', 'CURRENT_TIMESTAMP']
    for (const fn of nonDeterministic) {
      if (upper.includes(fn)) {
        return false
      }
    }
    return true
  }

  /**
   * Extract table names from a query for tag-based invalidation
   */
  extractTables(sql: string): string[] {
    const tables: string[] = []
    const upper = sql.toUpperCase()

    // Match table names after FROM and JOIN
    const fromMatches = upper.match(/FROM\s+(\w+)/gi)
    const joinMatches = upper.match(/JOIN\s+(\w+)/gi)

    if (fromMatches) {
      for (const match of fromMatches) {
        const table = match.replace(/FROM\s+/i, '').trim().toLowerCase()
        if (!tables.includes(table)) tables.push(table)
      }
    }

    if (joinMatches) {
      for (const match of joinMatches) {
        const table = match.replace(/JOIN\s+/i, '').trim().toLowerCase()
        if (!tables.includes(table)) tables.push(table)
      }
    }

    return tables
  }

  private L1_KEY(key: string): string {
    return `${this.L1_PREFIX}${key}`
  }

  private hashParams(params: unknown[]): string {
    // Simple hash for cache key
    const str = JSON.stringify(params)
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32bit integer
    }
    return hash.toString(36)
  }
}

/**
 * Factory function to create a MultiTierCache instance
 */
export function createMultiTierCache(kv: KVNamespace, d1: D1Database): MultiTierCache {
  return new MultiTierCache(kv, d1)
}
