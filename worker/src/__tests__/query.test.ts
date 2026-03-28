/**
 * Query route tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import app from '../index'

// Mock PostgreSQLAdapter
const mockQuery = vi.fn()
const mockQueryOne = vi.fn()
const mockTransaction = vi.fn()

vi.mock('@g-a-l-a-c-t-i-c/data', () => ({
  PostgreSQLAdapter: vi.fn().mockImplementation(() => ({
    query: mockQuery,
    queryOne: mockQueryOne,
    transaction: mockTransaction,
  })),
  D1RelationalStore: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue({}),
  })),
  sanitizeIdentifier: vi.fn((name: string) => name),
  createAuditEntry: vi.fn(),
  verifyAuditChain: vi.fn(),
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

// Mock Hyperdrive binding
function createMockEnv() {
  return {
    HYPERDRIVE: { connectionString: 'postgresql://localhost:5432/test' },
    DB: createMockDB(),
    CACHE_KV: {},
  }
}

function createMockDB() {
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true }),
  }
  return {
    prepare: vi.fn().mockReturnValue(mockStmt),
    batch: vi.fn().mockResolvedValue([]),
    _stmt: mockStmt,
  }
}

describe('Query Routes', () => {
  let env: ReturnType<typeof createMockEnv>

  beforeEach(() => {
    vi.clearAllMocks()
    env = createMockEnv()
  })

  it('POST /query executes SQL and returns rows', async () => {
    const rows = [
      { id: 1, name: 'Alice', balance_cents: 100000 },
      { id: 2, name: 'Bob', balance_cents: 250000 },
    ]
    mockQuery.mockResolvedValueOnce(rows)

    const req = makeRequest('POST', '/query', {
      sql: 'SELECT * FROM accounts WHERE tenant_id = $1',
      params: ['tenant_123'],
    })
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.data).toHaveLength(2)
    expect(json.count).toBe(2)
    expect(json.data[0].balance_cents).toBe(100000)
  })

  it('POST /query/one returns single row or null', async () => {
    const row = { id: 1, name: 'Alice', balance_cents: 100000 }
    mockQueryOne.mockResolvedValueOnce(row)

    const req = makeRequest('POST', '/query/one', {
      sql: 'SELECT * FROM accounts WHERE id = $1',
      params: [1],
    })
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.data).toEqual(row)
  })

  it('POST /query/one returns null when no row found', async () => {
    mockQueryOne.mockResolvedValueOnce(null)

    const req = makeRequest('POST', '/query/one', {
      sql: 'SELECT * FROM accounts WHERE id = $1',
      params: [999],
    })
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.data).toBeNull()
  })

  it('POST /query validates that sql is required', async () => {
    const req = makeRequest('POST', '/query', { params: [] })
    const res = await app.fetch(req, env)
    expect(res.status).toBe(422)
  })

  it('POST /query defaults params to empty array', async () => {
    mockQuery.mockResolvedValueOnce([])

    const req = makeRequest('POST', '/query', { sql: 'SELECT 1' })
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    expect(mockQuery).toHaveBeenCalledWith('SELECT 1', [])
  })
})
