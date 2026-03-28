/**
 * Transaction route tests
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

describe('Transaction Routes', () => {
  let env: ReturnType<typeof createMockEnv>

  beforeEach(() => {
    vi.clearAllMocks()
    env = createMockEnv()
  })

  it('POST /transaction wraps statements in BEGIN/COMMIT', async () => {
    // The adapter.transaction handles BEGIN/COMMIT internally
    mockTransaction.mockImplementationOnce(async (fn: Function) => {
      const tx = {
        query: vi.fn().mockResolvedValue([]),
      }
      return fn(tx)
    })

    const req = makeRequest('POST', '/transaction', {
      statements: [
        { sql: 'UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2', params: [5000, 'acc_1'] },
        { sql: 'UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2', params: [5000, 'acc_2'] },
      ],
    })
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.statementCount).toBe(2)
    expect(mockTransaction).toHaveBeenCalled()
  })

  it('POST /transaction rolls back on error', async () => {
    mockTransaction.mockRejectedValueOnce(new Error('constraint violation'))

    const req = makeRequest('POST', '/transaction', {
      statements: [
        { sql: 'INSERT INTO accounts (id, balance_cents) VALUES ($1, $2)', params: ['acc_dup', 0] },
      ],
    })
    const res = await app.fetch(req, env)

    // errorHandler catches and returns 500
    expect(res.status).toBe(500)
  })

  it('POST /transaction validates statements are required', async () => {
    const req = makeRequest('POST', '/transaction', { statements: [] })
    const res = await app.fetch(req, env)
    expect(res.status).toBe(422)
  })

  it('POST /transaction validates each statement has sql', async () => {
    const req = makeRequest('POST', '/transaction', {
      statements: [{ params: [1] }],
    })
    const res = await app.fetch(req, env)
    expect(res.status).toBe(422)
  })

  it('POST /transaction executes multiple statements in order', async () => {
    const executedQueries: string[] = []
    mockTransaction.mockImplementationOnce(async (fn: Function) => {
      const tx = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          executedQueries.push(sql)
          return []
        }),
      }
      return fn(tx)
    })

    const req = makeRequest('POST', '/transaction', {
      statements: [
        { sql: 'INSERT INTO ledger (entry) VALUES ($1)', params: ['debit'] },
        { sql: 'INSERT INTO ledger (entry) VALUES ($1)', params: ['credit'] },
        { sql: 'UPDATE balances SET updated_at = NOW()' },
      ],
    })
    const res = await app.fetch(req, env)

    expect(res.status).toBe(200)
    expect(executedQueries).toEqual([
      'INSERT INTO ledger (entry) VALUES ($1)',
      'INSERT INTO ledger (entry) VALUES ($1)',
      'UPDATE balances SET updated_at = NOW()',
    ])
  })
})
