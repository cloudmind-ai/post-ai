/**
 * Migration runner for PostgreSQL via @g-a-l-a-c-t-i-c/data PostgreSQLAdapter
 *
 * Uses the platform's PostgreSQLAdapter for running migrations against PostgreSQL.
 */

import type { PostgreSQLAdapter } from '@g-a-l-a-c-t-i-c/data'
import type { MigrationDefinition, MigrationStatusResponse } from '../types'

/**
 * Ensure the migrations tracking table exists.
 */
export async function initMigrationsTable(adapter: PostgreSQLAdapter): Promise<void> {
  await adapter.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  )
}

/**
 * Apply pending migrations in version order.
 */
export async function applyMigrations(
  adapter: PostgreSQLAdapter,
  migrations: MigrationDefinition[],
): Promise<{ applied: number[] }> {
  await initMigrationsTable(adapter)

  const appliedRows = await adapter.query<{ version: number }>(`SELECT version FROM _migrations ORDER BY version`)
  const appliedSet = new Set(appliedRows.map((r) => r.version))
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  const newlyApplied: number[] = []

  for (const m of sorted) {
    if (appliedSet.has(m.version)) continue

    await adapter.query(m.sql)
    await adapter.query(
      `INSERT INTO _migrations (version, name, applied_at) VALUES ($1, $2, $3)`,
      [m.version, m.name, new Date().toISOString()],
    )

    newlyApplied.push(m.version)
  }

  return { applied: newlyApplied }
}

/**
 * Get migration status: which are applied and which are pending.
 */
export async function getMigrationStatus(
  adapter: PostgreSQLAdapter,
  migrations: MigrationDefinition[],
): Promise<MigrationStatusResponse> {
  await initMigrationsTable(adapter)

  const appliedRows = await adapter.query<{ version: number; name: string; applied_at: string }>(
    `SELECT version, name, applied_at FROM _migrations ORDER BY version`,
  )

  const appliedVersions = new Set(appliedRows.map((r) => r.version))
  const pending = migrations.filter((m) => !appliedVersions.has(m.version))

  return {
    applied: appliedRows,
    pending,
  }
}
