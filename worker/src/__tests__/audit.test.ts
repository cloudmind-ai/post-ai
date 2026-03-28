/**
 * Audit route tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import app from '../index'

// Mock @g-a-l-a-c-t-i-c/data audit functions and D1RelationalStore
const mockCreateAuditEntry = vi.fn()
const mockVerifyAuditChain = vi.fn()
const mockD1Query = vi.fn()
const mockD1QueryOne = vi.fn()
const mockD1Insert = vi.fn()

vi.mock('@g-a-l-a-c-t-i-c/data', () => ({
  PostgreSQLAdapter: vi.fn().mockImplementation(() => ({
    query: vi.fn(),
    queryOne: vi.fn(),
    transaction: vi.fn(),
  })),
  D1RelationalStore: vi.fn().mockImplementation(() => ({
    query: mockD1Query,
    queryOne: mockD1QueryOne,
    insert: mockD1Insert,
  })),
  sanitizeIdentifier: vi.fn((name: string) => name),
  createAuditEntry: (...args: unknown[]) => mockCreateAuditEntry(...args),
  verifyAuditChain: (...args: unknown[]) => mockVerifyAuditChain(...args),
}))

function makeRequest(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const init: RequestInit = {
    method,
    headers: { 'x-tenant-id': 'tenant_123', 'x-user-id': 'user_456', ...headers },
  }
  if (body) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  return new Request(`http://localhost${path}`, init)
}

function createMockEnv() {
  return {
    HYPERDRIVE: { connectionString: 'postgresql://localhost:5432/test' },
    DB: {},
    CACHE_KV: {},
  }
}

describe('Audit Routes', () => {
  let env: ReturnType<typeof createMockEnv>

  beforeEach(() => {
    vi.clearAllMocks()
    env = createMockEnv()
    // Default: initAuditTable query succeeds
    mockD1Query.mockResolvedValue([])
  })

  it('GET /audit/:entityType/:entityId returns audit history', async () => {
    const auditRows = [
      {
        id: 'aud_1',
        entity_type: 'account',
        entity_id: 'acc_1',
        action: 'INSERT',
        data: '{"balance_cents":0}',
        previous_checksum: null,
        checksum: 'abc123',
        timestamp: '2026-01-01T00:00:00.000Z',
        actor: 'user_456',
        tenant_id: 'tenant_123',
      },
      {
        id: 'aud_2',
        entity_type: 'account',
        entity_id: 'acc_1',
        action: 'UPDATE',
        data: '{"balance_cents":50000}',
        previous_checksum: 'abc123',
        checksum: 'def456',
        timestamp: '2026-01-02T00:00:00.000Z',
        actor: 'user_456',
        tenant_id: 'tenant_123',
      },
    ]

    // First call: initAuditTable CREATE TABLE, second call: SELECT audit history
    mockD1Query
      .mockResolvedValueOnce([])         // initAuditTable
      .mockResolvedValueOnce(auditRows)  // getAuditHistory

    const req = makeRequest('GET', '/audit/account/acc_1')
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.data).toHaveLength(2)
    expect(json.count).toBe(2)
    expect(json.data[0].action).toBe('INSERT')
    expect(json.data[1].action).toBe('UPDATE')
  })

  it('GET /audit/:entityType/:entityId returns empty for unknown entity', async () => {
    mockD1Query
      .mockResolvedValueOnce([])  // initAuditTable
      .mockResolvedValueOnce([])  // getAuditHistory

    const req = makeRequest('GET', '/audit/account/acc_unknown')
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.data).toHaveLength(0)
    expect(json.count).toBe(0)
  })

  it('GET /audit/verify/:entityType/:entityId verifies valid audit chain', async () => {
    const auditRows = [
      {
        id: 'aud_1',
        entity_type: 'payment',
        entity_id: 'pay_1',
        action: 'INSERT',
        data: '{"amount_cents":10000}',
        previous_checksum: null,
        checksum: 'aaa',
        timestamp: '2026-01-01T00:00:00.000Z',
        actor: 'user_456',
        tenant_id: 'tenant_123',
      },
    ]

    mockD1Query
      .mockResolvedValueOnce([])         // initAuditTable
      .mockResolvedValueOnce(auditRows)  // getAuditHistory
    mockVerifyAuditChain.mockResolvedValueOnce({ valid: true })

    const req = makeRequest('GET', '/audit/verify/payment/pay_1')
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.data.valid).toBe(true)
    expect(json.data.totalEntries).toBe(1)
  })

  it('GET /audit/verify/:entityType/:entityId detects broken chain', async () => {
    const auditRows = [
      {
        id: 'aud_1',
        entity_type: 'payment',
        entity_id: 'pay_1',
        action: 'INSERT',
        data: '{"amount_cents":10000}',
        previous_checksum: null,
        checksum: 'aaa',
        timestamp: '2026-01-01T00:00:00.000Z',
        actor: 'user_456',
        tenant_id: 'tenant_123',
      },
      {
        id: 'aud_2',
        entity_type: 'payment',
        entity_id: 'pay_1',
        action: 'UPDATE',
        data: '{"amount_cents":20000}',
        previous_checksum: 'TAMPERED',
        checksum: 'bbb',
        timestamp: '2026-01-02T00:00:00.000Z',
        actor: 'user_456',
        tenant_id: 'tenant_123',
      },
    ]

    mockD1Query
      .mockResolvedValueOnce([])         // initAuditTable
      .mockResolvedValueOnce(auditRows)  // getAuditHistory
    mockVerifyAuditChain.mockResolvedValueOnce({ valid: false, brokenAt: 1 })

    const req = makeRequest('GET', '/audit/verify/payment/pay_1')
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.data.valid).toBe(false)
    expect(json.data.brokenAt).toBe(1)
    expect(json.data.totalEntries).toBe(2)
  })

  it('GET /audit/verify returns valid for empty chain', async () => {
    mockD1Query
      .mockResolvedValueOnce([])  // initAuditTable
      .mockResolvedValueOnce([])  // getAuditHistory

    const req = makeRequest('GET', '/audit/verify/payment/pay_nonexistent')
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.data.valid).toBe(true)
    expect(json.data.totalEntries).toBe(0)
  })
})
