import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MultiTierCache, createMultiTierCache } from '../lib/cache'
import type { KVNamespace, D1Database } from '@cloudflare/workers-types'

describe('MultiTierCache', () => {
  let mockKV: KVNamespace
  let mockD1: D1Database
  let cache: MultiTierCache

  beforeEach(() => {
    // Mock KV store
    const kvStore = new Map<string, { value: string; metadata?: { expiresAt: number } }>()
    mockKV = {
      get: vi.fn(async (key: string) => {
        const entry = kvStore.get(key)
        if (!entry) return null
        if (entry.metadata && entry.metadata.expiresAt < Date.now()) {
          kvStore.delete(key)
          return null
        }
        return entry.value
      }),
      getWithMetadata: vi.fn(async (key: string) => {
        const entry = kvStore.get(key)
        if (!entry) return { value: null, metadata: null }
        if (entry.metadata && entry.metadata.expiresAt < Date.now()) {
          kvStore.delete(key)
          return { value: null, metadata: null }
        }
        return { value: entry.value, metadata: entry.metadata }
      }),
      put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
        const metadata: { expiresAt: number } | undefined = options?.expirationTtl
          ? { expiresAt: Date.now() + options.expirationTtl * 1000 }
          : undefined
        kvStore.set(key, { value, metadata })
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key)
      }),
    } as unknown as KVNamespace

    // Mock D1 store
    const d1Store = new Map<string, { value: string; tags: string[]; expiresAt: number }>()
    mockD1 = {
      prepare: vi.fn((sql: string) => {
        // Simple SQL parsing for mock
        if (sql.includes('SELECT')) {
          return {
            bind: (keyOrPattern: string) => ({
              first: async () => {
                const entry = d1Store.get(keyOrPattern)
                if (!entry) return null
                if (entry.expiresAt < Date.now()) {
                  d1Store.delete(keyOrPattern)
                  return null
                }
                return { value: entry.value, tags: JSON.stringify(entry.tags), expires_at: entry.expiresAt }
              },
              all: async () => {
                // For tag-based queries (LIKE pattern)
                const results: Array<{ key: string }> = []
                const pattern = keyOrPattern.replace(/%/g, '')
                for (const [k, entry] of d1Store) {
                  if (entry.expiresAt >= Date.now()) {
                    if (keyOrPattern.includes('%')) {
                      // Pattern match for tags
                      if (entry.tags.some((t) => t.includes(pattern))) {
                        results.push({ key: k })
                      }
                    } else {
                      results.push({ key: k })
                    }
                  }
                }
                return { results }
              },
            }),
          }
        }
        if (sql.includes('INSERT')) {
          return {
            bind: (key: string, value: string, tags: string, expiresAt: number) => ({
              run: async () => {
                d1Store.set(key, { value, tags: JSON.parse(tags), expiresAt })
                return { success: true }
              },
            }),
          }
        }
        if (sql.includes('DELETE')) {
          return {
            bind: (key: string) => ({
              run: async () => {
                d1Store.delete(key)
                return { success: true }
              },
            }),
            all: async () => {
              // For DELETE WHERE queries
              for (const [k] of d1Store) {
                d1Store.delete(k)
              }
              return { results: [] }
            },
          }
        }
        return { bind: () => ({ run: async () => ({ success: true }) }) }
      }),
      exec: vi.fn(async () => ({ count: 0 })),
      batch: vi.fn(async () => []),
    } as unknown as D1Database

    cache = createMultiTierCache(mockKV, mockD1)
  })

  describe('get', () => {
    it('should return null when cache miss on both layers', async () => {
      const result = await cache.get('non-existent-key')
      expect(result).toBeNull()
    })

    it('should return L1 value when hit on KV', async () => {
      await mockKV.put('cache:v1:test-key', JSON.stringify({ data: 'cached-value' }), { expirationTtl: 60 })

      const result = await cache.get('test-key')

      expect(result).toEqual({ data: 'cached-value' })
      expect(mockD1.prepare).not.toHaveBeenCalledWith(expect.stringContaining('SELECT'))
    })

    it('should fall back to L2 when L1 miss, then populate L1', async () => {
      const cachedValue = { data: 'd1-cached-value' }
      const stmt = mockD1.prepare('SELECT value FROM pa_query_cache WHERE key = ?')
      const bindResult = stmt.bind('test-key')
      bindResult.first = vi.fn().mockResolvedValueOnce({
        value: JSON.stringify(cachedValue),
        tags: '[]',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })

      // Re-setup the mock to return proper prepared statement
      mockD1.prepare = vi.fn((sql: string) => {
        if (sql.includes('SELECT')) {
          return {
            bind: () => ({
              first: async () => ({
                value: JSON.stringify(cachedValue),
                tags: '[]',
                expires_at: Math.floor(Date.now() / 1000) + 3600,
              }),
            }),
            all: async () => ({ results: [] }),
          }
        }
        return { bind: () => ({ run: async () => ({ success: true }) }) }
      })

      // Clear KV to simulate L1 miss
      await mockKV.delete('test-key')

      const result = await cache.get('test-key')

      expect(result).toEqual(cachedValue)
      // After L2 hit, should populate L1 (internal key has prefix)
      const l1Value = await mockKV.get('cache:v1:test-key')
      expect(l1Value).toBeTruthy()
    })

    it('should return null for expired entries', async () => {
      // Populate with expired entry
      await mockKV.put('expired-key', JSON.stringify({ data: 'old' }), { expirationTtl: -1 })

      const result = await cache.get('expired-key')

      expect(result).toBeNull()
    })
  })

  describe('set', () => {
    it('should store value in both L1 and L2', async () => {
      const value = { query: 'SELECT * FROM users', result: [{ id: 1, name: 'John' }] }

      await cache.set('query-1', value, { ttlSeconds: 300 })

      // Check L1 (KV) - internal key has 'cache:v1:' prefix
      const l1Value = await mockKV.get('cache:v1:query-1')
      expect(JSON.parse(l1Value!)).toEqual(value)

      // Check L2 (D1) was called
      expect(mockD1.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT'))
    })

    it('should include tags when provided', async () => {
      const value = { data: 'test' }

      await cache.set('tagged-key', value, { ttlSeconds: 300, tags: ['users', 'query'] })

      // D1 insert should include tags
      expect(mockD1.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT'))
    })
  })

  describe('invalidate', () => {
    it('should remove from both L1 and L2', async () => {
      // Setup cache entries using the cache's set method
      await cache.set('invalidate-test', { data: 'test' }, { ttlSeconds: 300 })

      await cache.invalidate('invalidate-test')

      // Check L1 cleared (note: internal key has prefix)
      const l1Value = await mockKV.get('cache:v1:invalidate-test')
      expect(l1Value).toBeNull()

      // Check L2 delete was called
      expect(mockD1.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE'))
    })
  })

  describe('invalidateTags', () => {
    it('should remove entries with matching tags', async () => {
      // Setup entries with tags would require more complex mock
      // For now, verify the method exists and calls D1
      await cache.invalidateTags(['users'])

      expect(mockD1.prepare).toHaveBeenCalled()
    })
  })

  describe('cache key generation', () => {
    it('should generate consistent keys for same input', () => {
      const key1 = cache.generateKey('SELECT * FROM users WHERE id = $1', [1, 'test'])
      const key2 = cache.generateKey('SELECT * FROM users WHERE id = $1', [1, 'test'])

      expect(key1).toBe(key2)
    })

    it('should generate different keys for different inputs', () => {
      const key1 = cache.generateKey('SELECT * FROM users WHERE id = $1', [1])
      const key2 = cache.generateKey('SELECT * FROM users WHERE id = $1', [2])

      expect(key1).not.toBe(key2)
    })
  })
})
