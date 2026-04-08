# POST AI Core Features Implementation Plan

## Overview
Implement three core features for POST AI using TDD:
1. AI Schema Agent - Natural language to PostgreSQL DDL
2. Multi-tier Caching - L1 (KV) + L2 (D1) cache layers
3. Zero-downtime Migration Tool - Debezium CDC pattern

## Test Command
`npm test` (from worker/package.json)

## Table Prefix
`pa_` (Post AI)

---

## Feature 1: AI Schema Agent

### Task 1.1: Create AI Schema Service (lib/ai-schema.ts)
**Description:** Create a service module that uses `@g-a-l-a-c-t-i-c/ai` to convert natural language to PostgreSQL DDL statements.

**Files to create/modify:**
- `worker/src/lib/ai-schema.ts` (new)
- `worker/src/__tests__/ai-schema.test.ts` (new)

**Implementation:**
- Import `generateText` from `@g-a-l-a-c-t-i-c/ai`
- Function `generateSchemaFromDescription(description: string): Promise<string>`
- Function `generateMigrationFromDescription(currentSchema: string, changeRequest: string): Promise<{ up: string; down: string }>`
- Function `optimizeQuery(query: string): Promise<{ optimized: string; explanation: string }>`

**TDD Steps:**
1. Test: generateSchemaFromDescription returns valid DDL for simple table
2. Test: generateMigrationFromDescription creates safe up/down scripts
3. Test: optimizeQuery returns optimized SQL with explanation

---

### Task 1.2: Create AI Schema Routes (routes/ai-schema.ts)
**Description:** Add HTTP endpoints for AI Schema Agent operations.

**Files to create/modify:**
- `worker/src/routes/ai-schema.ts` (new)
- `worker/src/index.ts` (mount routes)
- `worker/src/__tests__/ai-schema-routes.test.ts` (new)

**Endpoints:**
- `POST /api/schema/generate` - Generate DDL from natural language
- `POST /api/schema/migrate` - Generate migration from change request
- `POST /api/query/optimize` - Optimize a SQL query

**TDD Steps:**
1. Test: POST /api/schema/generate returns valid response
2. Test: POST /api/schema/migrate returns up/down scripts
3. Test: POST /api/query/optimize returns optimized query
4. Test: Validation errors return 400

**Dependencies:** Task 1.1

---

## Feature 2: Multi-tier Caching

### Task 2.1: Create Cache Layer (lib/cache.ts)
**Description:** Implement L1 (KV) and L2 (D1) caching with automatic fallback and invalidation.

**Files to create/modify:**
- `worker/src/lib/cache.ts` (new)
- `worker/src/__tests__/cache.test.ts` (new)

**Implementation:**
- Import `CloudflareKVStore` and `D1RelationalStore` from `@g-a-l-a-c-t-i-c/data`
- Class `MultiTierCache` with:
  - `get(key: string): Promise<T | null>` - Check L1 → L2 → null
  - `set(key: string, value: T, options: CacheOptions): Promise<void>` - Write to L1 and L2
  - `invalidate(key: string): Promise<void>` - Remove from L1 and L2
  - `invalidatePattern(pattern: string): Promise<void>` - Remove matching keys

**DB Schema (migration):**
```sql
CREATE TABLE pa_query_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_pa_cache_expires ON pa_query_cache(expires_at);
```

**TDD Steps:**
1. Test: get returns null when cache miss
2. Test: set stores value in both L1 and L2
3. Test: get returns L1 value when hit
4. Test: get falls back to L2 when L1 miss
5. Test: invalidate removes from both layers
6. Test: expired entries are not returned

---

### Task 2.2: Integrate Cache with Query Routes
**Description:** Add caching layer to existing query and transactions routes.

**Files to create/modify:**
- `worker/src/routes/query.ts` (modify)
- `worker/src/routes/transactions.ts` (modify)
- `worker/src/__tests__/query-cached.test.ts` (new)
- `worker/src/migrations/0002_cache.sql` (new)

**Implementation:**
- Cache read queries in query routes
- Invalidate cache on write operations
- Skip cache for queries with specific hints (/* NO_CACHE */)

**TDD Steps:**
1. Test: GET /api/query returns cached result on second call
2. Test: POST /api/query invalidates relevant cache keys
3. Test: Query with /* NO_CACHE */ hint bypasses cache
4. Test: Transactions invalidate affected tables

**Dependencies:** Task 2.1

---

## Feature 3: Zero-downtime Migration Tool

### Task 3.1: Create Migration Runner Service (lib/migration-runner.ts)
**Description:** Build a migration runner that supports CDC-style continuous replication.

**Files to create/modify:**
- `worker/src/lib/migration-runner.ts` (new)
- `worker/src/__tests__/migration-runner.test.ts` (new)

**Implementation:**
- Class `MigrationRunner` with:
  - `createShadowTable(tableName: string): Promise<void>` - Create shadow copy
  - `setupReplication(sourceTable: string, shadowTable: string): Promise<void>` - CDC triggers
  - `cutover(shadowTable: string, sourceTable: string): Promise<void>` - Atomic rename
  - `rollback(tableName: string): Promise<void>` - Emergency rollback

**DB Schema (migration):**
```sql
CREATE TABLE pa_migration_state (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  shadow_table_name TEXT NOT NULL,
  status TEXT NOT NULL, -- 'replicating', 'cutover', 'complete', 'failed'
  started_at INTEGER DEFAULT (unixepoch()),
  completed_at INTEGER,
  error_message TEXT
);

CREATE TABLE pa_migration_cdc_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
  old_data TEXT,
  new_data TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
```

**TDD Steps:**
1. Test: createShadowTable copies schema without data
2. Test: setupReplication creates CDC triggers
3. Test: CDC log captures INSERT operations
4. Test: CDC log captures UPDATE operations
5. Test: CDC log captures DELETE operations
6. Test: cutover performs atomic table swap
7. Test: rollback restores original table

---

### Task 3.2: Create Migration Routes
**Description:** Add HTTP endpoints for zero-downtime migration operations.

**Files to create/modify:**
- `worker/src/routes/migrations.ts` (modify - currently exists but basic)
- `worker/src/__tests__/migration-routes.test.ts` (new)
- `worker/src/migrations/0003_migration_tool.sql` (new)

**Endpoints:**
- `POST /api/migrations/cdc/start` - Start CDC-based migration
- `GET /api/migrations/:id/status` - Check migration status
- `POST /api/migrations/:id/cutover` - Perform cutover
- `POST /api/migrations/:id/rollback` - Emergency rollback

**TDD Steps:**
1. Test: POST /api/migrations/cdc/start creates migration record
2. Test: GET /api/migrations/:id/status returns current state
3. Test: POST /api/migrations/:id/cutover performs atomic swap
4. Test: POST /api/migrations/:id/rollback restores original
5. Test: Cannot start migration on non-existent table

**Dependencies:** Task 3.1

---

### Task 3.3: Integration Tests for End-to-End Migration Flow
**Description:** Full integration test covering the complete zero-downtime migration.

**Files to create/modify:**
- `worker/src/__tests__/migration-e2e.test.ts` (new)

**TDD Steps:**
1. Test: Complete flow - start → CDC replication → cutover → verify
2. Test: Data consistency during migration (writes while replicating)
3. Test: Rollback during cutover phase

**Dependencies:** Task 3.2

---

## Execution Order

### Batch 1 (Parallel - No dependencies)
- Task 1.1: AI Schema Service
- Task 2.1: Cache Layer
- Task 3.1: Migration Runner Service

### Batch 2 (Parallel - Depends on Batch 1)
- Task 1.2: AI Schema Routes (depends on 1.1)
- Task 2.2: Cache Integration (depends on 2.1)
- Task 3.2: Migration Routes (depends on 3.1)

### Batch 3 (Sequential - Depends on Batch 2)
- Task 3.3: Migration E2E Tests (depends on 3.2)

---

## Database Migrations (apply after all tasks)

Create combined migration file:
- `0002_core_features.sql` - Contains all schema changes
