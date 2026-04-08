/**
 * Migration Runner Service tests
 *
 * Tests CDC-style continuous replication for zero-downtime migrations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MigrationRunner } from '../lib/migration-runner'
import type { PostgreSQLAdapter } from '@g-a-l-a-c-t-i-c/data'

// Mock PostgreSQLAdapter
const mockQuery = vi.fn()
const mockQueryOne = vi.fn()
const mockTransaction = vi.fn()
const MockPostgreSQLAdapter = vi.fn()

vi.mock('@g-a-l-a-c-t-i-c/data', () => ({
  PostgreSQLAdapter: vi.fn().mockImplementation(function() {
    return {
      query: mockQuery,
      queryOne: mockQueryOne,
      transaction: mockTransaction,
    }
  }),
  sanitizeIdentifier: vi.fn((name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_')),
}))

function createMockAdapter(): PostgreSQLAdapter {
  // Return the mock adapter directly instead of trying to instantiate
  return {
    query: mockQuery,
    queryOne: mockQueryOne,
    transaction: mockTransaction,
  } as PostgreSQLAdapter
}

function createMigrationRunner(adapter: PostgreSQLAdapter): MigrationRunner {
  return new MigrationRunner(adapter)
}

describe('MigrationRunner', () => {
  let adapter: PostgreSQLAdapter
  let runner: MigrationRunner

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = createMockAdapter()
    runner = createMigrationRunner(adapter)
  })

  describe('createMigration', () => {
    it('creates state record and shadow table', async () => {
      // ARRANGE: Mock successful insert and table creation
      mockQuery
        .mockResolvedValueOnce([]) // CREATE TABLE pa_migration_state
        .mockResolvedValueOnce([]) // CREATE TABLE pa_migration_cdc_log
        .mockResolvedValueOnce([{ id: 'migration-123' }]) // Only the migration itself
        .mockResolvedValueOnce([]) // CREATE INDEX

      // ACT
      const result = await runner.createMigration('migration-123', 'users')

      // ASSERT: Verify migration record was created with status 'pending'
      expect(result.id).toBe('migration-123')
      expect(result.tableName).toBe('users')
      expect(result.shadowTableName).toBe('users_shadow_migration-123')
      expect(result.status).toBe('pending')

      // Verify state table creation was attempted
      const calls = mockQuery.mock.calls
      expect(calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS pa_migration_state')

      // Verify migration record insert
      const insertCall = calls.find(c => c[0].includes('INSERT INTO pa_migration_state'))
      expect(insertCall).toBeDefined()
      expect(insertCall![1]).toContain('migration-123')
      expect(insertCall![1]).toContain('users')
      expect(insertCall![1]).toContain('pending')
    })
  })

  describe('startReplication', () => {
    it('sets status to replicating', async () => {
      // ARRANGE: Mock migration state lookup and update
      mockQueryOne
        .mockResolvedValueOnce({ // Migration state exists with pending status
          id: 'migration-123',
          table_name: 'users',
          shadow_table_name: 'users_shadow_migration-123',
          status: 'pending',
        })

      mockQuery
        .mockResolvedValueOnce([]) // UPDATE migration status

      // ACT
      await runner.startReplication('migration-123')

      // ASSERT: Verify UPDATE query was called with 'replicating' status
      const calls = mockQuery.mock.calls
      const updateCall = calls.find(c => c[0].includes('UPDATE pa_migration_state'))
      expect(updateCall).toBeDefined()
      expect(updateCall![0]).toContain('status')
      expect(updateCall![0]).toContain('pa_migration_state')
      // Status is passed as parameter $1
      expect(updateCall![1][0]).toBe('replicating')
      expect(updateCall![1][1]).toBe('migration-123')
    })
  })

  describe('syncChanges', () => {
    it('replays INSERT operations to shadow table', async () => {
      // ARRANGE: Mock migration state and pending CDC changes
      mockQueryOne.mockResolvedValueOnce({
        id: 'migration-123',
        table_name: 'users',
        shadow_table_name: 'users_shadow_migration-123',
        status: 'replicating',
      })

      // Mock CDC log with INSERT operations
      const cdcEntries = [
        {
          id: 1,
          migration_id: 'migration-123',
          table_name: 'users',
          operation: 'INSERT',
          primary_key: '1',
          old_data: null,
          new_data: JSON.stringify({ id: 1, name: 'Alice', email: 'alice@example.com' }),
          applied: 0,
        },
        {
          id: 2,
          migration_id: 'migration-123',
          table_name: 'users',
          operation: 'INSERT',
          primary_key: '2',
          old_data: null,
          new_data: JSON.stringify({ id: 2, name: 'Bob', email: 'bob@example.com' }),
          applied: 0,
        },
      ]

      mockQuery
        .mockResolvedValueOnce(cdcEntries) // SELECT unapplied CDC changes
        .mockResolvedValueOnce([]) // INSERT INTO shadow table for Alice
        .mockResolvedValueOnce([]) // INSERT INTO shadow table for Bob
        .mockResolvedValueOnce([]) // UPDATE CDC log as applied
        .mockResolvedValueOnce([]) // UPDATE CDC log as applied

      // ACT
      await runner.syncChanges('migration-123')

      // ASSERT: Verify INSERT statements were executed on shadow table
      const calls = mockQuery.mock.calls
      const shadowInserts = calls.filter(c =>
        c[0].includes('INSERT INTO') && c[0].includes('users_shadow')
      )
      expect(shadowInserts).toHaveLength(2)

      // Verify each shadow insert has the right data
      expect(shadowInserts[0]![1]).toEqual([1, 'Alice', 'alice@example.com'])
      expect(shadowInserts[1]![1]).toEqual([2, 'Bob', 'bob@example.com'])
    })

    it('replays UPDATE operations to shadow table', async () => {
      // ARRANGE
      mockQueryOne.mockResolvedValueOnce({
        id: 'migration-123',
        table_name: 'users',
        shadow_table_name: 'users_shadow_migration-123',
        status: 'replicating',
      })

      const cdcEntries = [
        {
          id: 3,
          migration_id: 'migration-123',
          table_name: 'users',
          operation: 'UPDATE',
          primary_key: '1',
          old_data: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
          new_data: JSON.stringify({ name: 'Alice Smith', email: 'alice.smith@example.com' }),
          applied: 0,
        },
      ]

      mockQuery
        .mockResolvedValueOnce(cdcEntries)
        .mockResolvedValueOnce([]) // UPDATE shadow table
        .mockResolvedValueOnce([]) // Mark applied

      // ACT
      await runner.syncChanges('migration-123')

      // ASSERT: Verify UPDATE statement was executed
      const calls = mockQuery.mock.calls
      const shadowUpdates = calls.filter(c =>
        c[0].includes('UPDATE') && c[0].includes('users_shadow')
      )
      expect(shadowUpdates).toHaveLength(1)
      expect(shadowUpdates[0]![0]).toContain('name')
      expect(shadowUpdates[0]![0]).toContain('email')
      expect(shadowUpdates[0]![1]).toContain('Alice Smith')
    })

    it('replays DELETE operations to shadow table', async () => {
      // ARRANGE
      mockQueryOne.mockResolvedValueOnce({
        id: 'migration-123',
        table_name: 'users',
        shadow_table_name: 'users_shadow_migration-123',
        status: 'replicating',
      })

      const cdcEntries = [
        {
          id: 4,
          migration_id: 'migration-123',
          table_name: 'users',
          operation: 'DELETE',
          primary_key: '2',
          old_data: JSON.stringify({ id: 2, name: 'Bob', email: 'bob@example.com' }),
          new_data: null,
          applied: 0,
        },
      ]

      mockQuery
        .mockResolvedValueOnce(cdcEntries)
        .mockResolvedValueOnce([]) // DELETE FROM shadow table
        .mockResolvedValueOnce([]) // Mark applied

      // ACT
      await runner.syncChanges('migration-123')

      // ASSERT: Verify DELETE statement was executed
      const calls = mockQuery.mock.calls
      const shadowDeletes = calls.filter(c =>
        c[0].includes('DELETE FROM') && c[0].includes('users_shadow')
      )
      expect(shadowDeletes).toHaveLength(1)
      expect(shadowDeletes[0]![0]).toContain('id')
      expect(shadowDeletes[0]![1]).toContain('2')
    })
  })

  describe('cutover', () => {
    it('performs atomic table swap and sets status to complete', async () => {
      // ARRANGE
      mockQueryOne
        .mockResolvedValueOnce({ // Initial lookup
          id: 'migration-123',
          table_name: 'users',
          shadow_table_name: 'users_shadow_migration-123',
          status: 'replicating',
        })
        .mockResolvedValueOnce({ // For syncChanges lookup
          id: 'migration-123',
          table_name: 'users',
          shadow_table_name: 'users_shadow_migration-123',
          status: 'cutover',
        })

      mockQuery
        .mockResolvedValueOnce([]) // UPDATE status to cutover
        .mockResolvedValueOnce([]) // LOCK TABLE users
        .mockResolvedValueOnce([]) // Final syncChanges SELECT CDC
        .mockResolvedValueOnce([]) // ALTER TABLE users RENAME TO users_backup_old
        .mockResolvedValueOnce([]) // ALTER TABLE shadow RENAME TO users
        .mockResolvedValueOnce([]) // UPDATE status to complete with completed_at

      // ACT
      await runner.cutover('migration-123')

      // ASSERT: Verify table swap occurred
      const calls = mockQuery.mock.calls

      // Check for locking the source table
      const lockCall = calls.find(c => c[0].includes('LOCK'))
      expect(lockCall).toBeDefined()

      // Check for RENAME operations (atomic swap)
      const renameCalls = calls.filter(c => c[0].includes('ALTER TABLE') && c[0].includes('RENAME TO'))
      expect(renameCalls.length).toBeGreaterThanOrEqual(2)

      // Verify status updated to complete
      const statusUpdate = calls.find(c =>
        c[0].includes('UPDATE pa_migration_state') &&
        c[1] && c[1][0] === 'complete'
      )
      expect(statusUpdate).toBeDefined()
    })
  })

  describe('rollback', () => {
    it('restores original table and sets status to rolled_back', async () => {
      // ARRANGE
      mockQueryOne.mockResolvedValueOnce({
        id: 'migration-123',
        table_name: 'users',
        shadow_table_name: 'users_shadow_migration-123',
        status: 'replicating',
      })

      mockQuery
        .mockResolvedValueOnce([]) // DROP TABLE shadow
        .mockResolvedValueOnce([]) // DELETE FROM CDC log
        .mockResolvedValueOnce([]) // UPDATE status to rolled_back

      // ACT
      await runner.rollback('migration-123')

      // ASSERT
      const calls = mockQuery.mock.calls

      // Verify shadow table is dropped
      const dropCall = calls.find(c =>
        c[0].includes('DROP TABLE') && c[0].includes('users_shadow')
      )
      expect(dropCall).toBeDefined()

      // Verify CDC log cleared
      const cdcClear = calls.find(c =>
        c[0].includes('DELETE FROM pa_migration_cdc_log')
      )
      expect(cdcClear).toBeDefined()

      // Verify status updated to rolled_back
      const statusUpdate = calls.find(c =>
        c[0].includes('UPDATE pa_migration_state') &&
        c[1] && c[1][0] === 'rolled_back'
      )
      expect(statusUpdate).toBeDefined()
    })
  })

  describe('finalize', () => {
    it('cleans up CDC log and shadow table after successful migration', async () => {
      // ARRANGE
      mockQueryOne.mockResolvedValueOnce({
        id: 'migration-123',
        table_name: 'users',
        shadow_table_name: 'users_shadow_migration-123',
        status: 'complete',
      })

      mockQuery
        .mockResolvedValueOnce([]) // Clear CDC log
        .mockResolvedValueOnce([]) // Drop shadow table

      // ACT
      await runner.finalize('migration-123')

      // ASSERT
      const calls = mockQuery.mock.calls

      // Verify CDC log cleared
      const cdcClear = calls.find(c =>
        c[0].includes('DELETE FROM pa_migration_cdc_log') &&
        c[1] && c[1][0] === 'migration-123'
      )
      expect(cdcClear).toBeDefined()

      // Verify shadow table dropped
      const dropCall = calls.find(c =>
        c[0].includes('DROP TABLE') && c[0].includes('users_shadow')
      )
      expect(dropCall).toBeDefined()
    })
  })
})
