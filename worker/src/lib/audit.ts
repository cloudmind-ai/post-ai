/**
 * Audit trail operations via @g-a-l-a-c-t-i-c/data
 *
 * Stores audit entries in D1 with hash-chained integrity verification.
 * Every write operation through Post AI gets an audit record.
 */

import { D1RelationalStore, createAuditEntry, verifyAuditChain } from '@g-a-l-a-c-t-i-c/data'
import type { AuditEntry } from '@g-a-l-a-c-t-i-c/data'
import type { AuditEntryRecord, AuditVerifyResult } from '../types'

export interface AuditDeps {
  db: D1Database
  tenantId: string
  userId: string
}

/**
 * Initialize the audit trail table if it does not exist.
 */
export async function initAuditTable(db: D1Database): Promise<void> {
  const store = new D1RelationalStore(db)
  await store.query(
    `CREATE TABLE IF NOT EXISTS _audit_trail (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      data TEXT NOT NULL,
      previous_checksum TEXT,
      checksum TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      actor TEXT,
      tenant_id TEXT NOT NULL
    )`,
  )
}

/**
 * Record an audit entry for a write operation.
 */
export async function recordAudit(
  deps: AuditDeps,
  entityType: string,
  entityId: string,
  action: 'INSERT' | 'UPDATE' | 'DELETE',
  data: Record<string, unknown>,
): Promise<AuditEntry> {
  const store = new D1RelationalStore(deps.db)

  // Get the last entry to chain checksums
  const lastRow = await store.queryOne<{ checksum: string }>(
    `SELECT checksum FROM _audit_trail WHERE entity_type = ? AND entity_id = ? AND tenant_id = ? ORDER BY timestamp DESC LIMIT 1`,
    [entityType, entityId, deps.tenantId],
  )

  const entry = await createAuditEntry({
    id: crypto.randomUUID(),
    entityType,
    entityId,
    action,
    data,
    previousChecksum: lastRow?.checksum ?? null,
    actor: deps.userId || undefined,
  })

  await store.insert('_audit_trail', {
    id: entry.id,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    action: entry.action,
    data: entry.data,
    previous_checksum: entry.previousChecksum,
    checksum: entry.checksum,
    timestamp: entry.timestamp,
    actor: entry.actor ?? null,
    tenant_id: deps.tenantId,
  })

  return entry
}

/**
 * Get audit history for an entity, scoped to tenant.
 */
export async function getAuditHistory(
  db: D1Database,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<AuditEntryRecord[]> {
  const store = new D1RelationalStore(db)
  return store.query<AuditEntryRecord>(
    `SELECT * FROM _audit_trail WHERE entity_type = ? AND entity_id = ? AND tenant_id = ? ORDER BY timestamp ASC`,
    [entityType, entityId, tenantId],
  )
}

/**
 * Verify the integrity of an entity's audit chain.
 */
export async function verifyEntityAuditChain(
  db: D1Database,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<AuditVerifyResult> {
  const rows = await getAuditHistory(db, tenantId, entityType, entityId)

  if (rows.length === 0) {
    return { valid: true, totalEntries: 0 }
  }

  // Convert DB rows to AuditEntry format for verification
  const entries: AuditEntry[] = rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    data: row.data,
    previousChecksum: row.previous_checksum,
    checksum: row.checksum,
    timestamp: row.timestamp,
    actor: row.actor ?? undefined,
  }))

  const result = await verifyAuditChain(entries)

  return {
    valid: result.valid,
    brokenAt: result.brokenAt,
    totalEntries: entries.length,
  }
}
