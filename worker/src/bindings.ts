/**
 * Post AI Cloudflare Worker bindings
 */
export interface PostAIBindings {
  /** Hyperdrive connection to PostgreSQL (used by @g-a-l-a-c-t-i-c/data PostgreSQLAdapter) */
  HYPERDRIVE: Hyperdrive

  /** D1 database for audit trail storage */
  DB: D1Database

  /** KV namespace for caching */
  CACHE_KV: KVNamespace

  /** Environment identifier */
  ENVIRONMENT?: string
}
