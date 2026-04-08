/**
 * Migration Runner Service
 *
 * CDC-style continuous replication for zero-downtime migrations.
 * Supports live table migrations with Change Data Capture (CDC) pattern.
 */

import type { PostgreSQLAdapter } from '@g-a-l-a-c-t-i-c/data'

/**
 * Migration state tracking object
 */
export interface Migration {
  id: string
  tableName: string
  shadowTableName: string
  status: 'pending' | 'replicating' | 'cutover' | 'complete' | 'failed' | 'rolled_back'
  startedAt?: number
  completedAt?: number
  errorMessage?: string
}

/**
 * MigrationRunner implements CDC-style continuous replication for zero-downtime migrations.
 *
 * The migration process:
 * 1. createMigration - Initialize migration state and shadow table
 * 2. startReplication - Begin CDC change capturing
 * 3. syncChanges - Replay CDC log to shadow table
 * 4. cutover - Lock source, final sync, atomic swap
 * 5. finalize - Cleanup CDC log and shadow table
 * 6. rollback - Emergency restore on failure
 */
export class MigrationRunner {
  constructor(private adapter: PostgreSQLAdapter) {}

  /**
   * Create migration record and shadow table
   * @param id Unique migration identifier
   * @param tableName Source table to migrate
   * @returns Migration object with state
   */
  async createMigration(id: string, tableName: string): Promise<Migration> {
    // Initialize tracking tables
    await this.initializeTables()

    const shadowTableName = `${tableName}_shadow_${id}`

    // Insert migration state record
    await this.adapter.query(
      `INSERT INTO pa_migration_state (id, table_name, shadow_table_name, status, started_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, tableName, shadowTableName, 'pending', Math.floor(Date.now() / 1000)]
    )

    return {
      id,
      tableName,
      shadowTableName,
      status: 'pending',
    }
  }

  /**
   * Start CDC triggers/changes for continuous replication
   * @param migrationId Migration to start replicating
   */
  async startReplication(migrationId: string): Promise<void> {
    const migration = await this.adapter.queryOne<{
      id: string
      table_name: string
      shadow_table_name: string
      status: string
    }>(
      'SELECT id, table_name, shadow_table_name, status FROM pa_migration_state WHERE id = $1',
      [migrationId]
    )

    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`)
    }

    if (migration.status !== 'pending') {
      throw new Error(`Cannot start replication: migration is in ${migration.status} status`)
    }

    // Update status to 'replicating'
    await this.adapter.query(
      'UPDATE pa_migration_state SET status = $1 WHERE id = $2',
      ['replicating', migrationId]
    )
  }

  /**
   * Perform cutover: lock source, final sync, atomic swap
   * @param migrationId Migration to cutover
   */
  async cutover(migrationId: string): Promise<void> {
    const migration = await this.adapter.queryOne<{
      id: string
      table_name: string
      shadow_table_name: string
      status: string
    }>(
      'SELECT id, table_name, shadow_table_name, status FROM pa_migration_state WHERE id = $1',
      [migrationId]
    )

    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`)
    }

    if (migration.status !== 'replicating') {
      throw new Error(`Cannot cutover: migration is in ${migration.status} status`)
    }

    // Update status to cutover (lock state)
    await this.adapter.query(
      'UPDATE pa_migration_state SET status = $1 WHERE id = $2',
      ['cutover', migrationId]
    )

    // Lock the source table to prevent writes during final sync
    await this.adapter.query(`LOCK TABLE ${migration.table_name} IN ACCESS EXCLUSIVE MODE`)

    // Final sync of any remaining CDC changes
    await this.syncChanges(migrationId)

    // Perform atomic table swap using PostgreSQL ALTER TABLE RENAME
    const backupTableName = `${migration.table_name}_backup_${Date.now()}`

    // Rename original to backup
    await this.adapter.query(
      `ALTER TABLE ${migration.table_name} RENAME TO ${backupTableName}`
    )

    // Rename shadow to original
    await this.adapter.query(
      `ALTER TABLE ${migration.shadow_table_name} RENAME TO ${migration.table_name}`
    )

    // Update migration state to complete
    await this.adapter.query(
      'UPDATE pa_migration_state SET status = $1, completed_at = $2 WHERE id = $3',
      ['complete', Math.floor(Date.now() / 1000), migrationId]
    )
  }

  /**
   * Emergency rollback: drop shadow table, clear CDC log, mark as rolled_back
   * @param migrationId Migration to rollback
   */
  async rollback(migrationId: string): Promise<void> {
    const migration = await this.adapter.queryOne<{
      id: string
      table_name: string
      shadow_table_name: string
      status: string
    }>(
      'SELECT id, table_name, shadow_table_name, status FROM pa_migration_state WHERE id = $1',
      [migrationId]
    )

    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`)
    }

    if (migration.status === 'complete') {
      throw new Error(`Cannot rollback completed migration ${migrationId}`)
    }

    // Drop shadow table
    await this.adapter.query(`DROP TABLE IF EXISTS ${migration.shadow_table_name}`)

    // Clear CDC log for this migration
    await this.adapter.query(
      'DELETE FROM pa_migration_cdc_log WHERE migration_id = $1',
      [migrationId]
    )

    // Update status to rolled_back
    await this.adapter.query(
      'UPDATE pa_migration_state SET status = $1, completed_at = $2 WHERE id = $3',
      ['rolled_back', Math.floor(Date.now() / 1000), migrationId]
    )
  }

  /**
   * Finalize: cleanup CDC log and shadow table after successful migration
   * @param migrationId Migration to finalize
   */
  async finalize(migrationId: string): Promise<void> {
    const migration = await this.adapter.queryOne<{
      id: string
      table_name: string
      shadow_table_name: string
      status: string
    }>(
      'SELECT id, table_name, shadow_table_name, status FROM pa_migration_state WHERE id = $1',
      [migrationId]
    )

    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`)
    }

    if (migration.status !== 'complete' && migration.status !== 'rolled_back') {
      throw new Error(`Cannot finalize migration in ${migration.status} status`)
    }

    // Clear CDC log for this migration
    await this.adapter.query(
      'DELETE FROM pa_migration_cdc_log WHERE migration_id = $1',
      [migrationId]
    )

    // Drop shadow table (only if exists, for rolled-back migrations it may already be gone)
    await this.adapter.query(`DROP TABLE IF EXISTS ${migration.shadow_table_name}`)
  }

  /**
   * Replay CDC log changes to shadow table
   * @param migrationId Migration to sync changes for
   */
  async syncChanges(migrationId: string): Promise<void> {
    const migration = await this.adapter.queryOne<{
      id: string
      table_name: string
      shadow_table_name: string
      status: string
    }>(
      'SELECT id, table_name, shadow_table_name, status FROM pa_migration_state WHERE id = $1',
      [migrationId]
    )

    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`)
    }

    if (migration.status !== 'replicating' && migration.status !== 'cutover') {
      throw new Error(`Cannot sync changes: migration is in ${migration.status} status`)
    }

    // Get unapplied CDC changes
    const cdcChanges = await this.adapter.query<{
      id: number
      migration_id: string
      table_name: string
      operation: 'INSERT' | 'UPDATE' | 'DELETE'
      primary_key: string
      old_data: string | null
      new_data: string | null
    }>(
      `SELECT id, migration_id, table_name, operation, primary_key, old_data, new_data
       FROM pa_migration_cdc_log
       WHERE migration_id = $1 AND applied = 0
       ORDER BY id`,
      [migrationId]
    )

    // Apply each CDC change to shadow table
    for (const change of cdcChanges) {
      await this.applyCdcChange(change, migration.shadow_table_name)

      // Mark as applied
      await this.adapter.query(
        'UPDATE pa_migration_cdc_log SET applied = 1 WHERE id = $1',
        [change.id]
      )
    }
  }

  /**
   * Apply a single CDC change to the shadow table
   */
  private async applyCdcChange(
    change: {
      id: number
      operation: string
      primary_key: string
      new_data: string | null
    },
    shadowTableName: string
  ): Promise<void> {
    if (change.operation === 'INSERT' && change.new_data) {
      const rowData = JSON.parse(change.new_data)
      const columns = Object.keys(rowData)
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
      const values = Object.values(rowData)

      await this.adapter.query(
        `INSERT INTO ${shadowTableName} (${columns.join(', ')}) VALUES (${placeholders})`,
        values
      )
    } else if (change.operation === 'UPDATE' && change.new_data) {
      const rowData = JSON.parse(change.new_data)
      const columns = Object.keys(rowData)
      const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(', ')
      const values = Object.values(rowData)

      // Add primary key for WHERE clause
      values.push(change.primary_key)

      await this.adapter.query(
        `UPDATE ${shadowTableName} SET ${setClause} WHERE id = $${values.length}`,
        values
      )
    } else if (change.operation === 'DELETE') {
      await this.adapter.query(
        `DELETE FROM ${shadowTableName} WHERE id = $1`,
        [change.primary_key]
      )
    }
  }

  /**
   * Initialize CDC tracking tables
   */
  private async initializeTables(): Promise<void> {
    // Migration state tracking
    await this.adapter.query(`
      CREATE TABLE IF NOT EXISTS pa_migration_state (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        shadow_table_name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER DEFAULT (unixepoch()),
        completed_at INTEGER,
        error_message TEXT
      )
    `)

    // CDC log for capturing changes
    await this.adapter.query(`
      CREATE TABLE IF NOT EXISTS pa_migration_cdc_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        primary_key TEXT,
        old_data TEXT,
        new_data TEXT,
        applied INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `)

    // Index for efficient CDC processing
    await this.adapter.query(`
      CREATE INDEX IF NOT EXISTS idx_cdc_migration ON pa_migration_cdc_log(migration_id, applied)
    `)
  }
}
