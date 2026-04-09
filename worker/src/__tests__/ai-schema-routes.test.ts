import { describe, it, expect, vi, beforeEach } from 'vitest'
import app from '../index'
import type { PostAIBindings } from '../bindings'

const mockAI = {
  run: vi.fn(),
}

const mockBindings: PostAIBindings = {
  HYPERDRIVE: { connectionString: 'postgres://test' } as any,
  CACHE_KV: {} as any,
  DB: {} as any,
  AI: mockAI as any,
}

describe('AI Schema Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('POST /api/schema/generate', () => {
    it('should generate DDL from natural language description', async () => {
      mockAI.run.mockResolvedValueOnce({
        response: 'CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR(255) NOT NULL);',
      })

      const res = await app.request(
        '/api/schema/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'test-tenant' },
          body: JSON.stringify({ description: 'Create a users table with email' }),
        },
        mockBindings
      )

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toHaveProperty('ddl')
      expect(json.ddl).toContain('CREATE TABLE')
    })

    it('should return 400 for missing description', async () => {
      const res = await app.request(
        '/api/schema/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'test-tenant' },
          body: JSON.stringify({}),
        },
        mockBindings
      )

      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/schema/migrate', () => {
    it('should generate migration scripts from change request', async () => {
      mockAI.run.mockResolvedValueOnce({
        response: JSON.stringify({
          up: 'ALTER TABLE users ADD COLUMN phone VARCHAR(20);',
          down: 'ALTER TABLE users DROP COLUMN phone;',
        }),
      })

      const res = await app.request(
        '/api/schema/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'test-tenant' },
          body: JSON.stringify({
            currentSchema: 'CREATE TABLE users (id UUID PRIMARY KEY);',
            changeRequest: 'Add phone column',
          }),
        },
        mockBindings
      )

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toHaveProperty('up')
      expect(json).toHaveProperty('down')
    })

    it('should include warnings for destructive changes', async () => {
      mockAI.run.mockResolvedValueOnce({
        response: JSON.stringify({
          up: 'ALTER TABLE users DROP COLUMN email;',
          down: 'ALTER TABLE users ADD COLUMN email VARCHAR(255);',
          warnings: ['Data loss: email column will be permanently deleted'],
        }),
      })

      const res = await app.request(
        '/api/schema/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'test-tenant' },
          body: JSON.stringify({
            currentSchema: 'CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR(255));',
            changeRequest: 'Remove email column',
          }),
        },
        mockBindings
      )

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toHaveProperty('warnings')
      expect(json.warnings.length).toBeGreaterThan(0)
    })
  })

  describe('POST /api/query/optimize', () => {
    it('should return optimized query with explanation', async () => {
      mockAI.run.mockResolvedValueOnce({
        response: JSON.stringify({
          optimized: 'SELECT id FROM users WHERE email = $1',
          explanation: 'Use equality check instead of ILIKE for index utilization',
          originalIssues: ['ILIKE prevents index usage'],
          indexRecommendations: ['CREATE INDEX idx_users_email ON users(email)'],
        }),
      })

      const res = await app.request(
        '/api/query/optimize',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'test-tenant' },
          body: JSON.stringify({
            query: "SELECT * FROM users WHERE email ILIKE '%@example.com'",
          }),
        },
        mockBindings
      )

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toHaveProperty('optimized')
      expect(json).toHaveProperty('explanation')
      expect(json).toHaveProperty('indexRecommendations')
    })

    it('should return 400 for missing query', async () => {
      const res = await app.request(
        '/api/query/optimize',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'test-tenant' },
          body: JSON.stringify({}),
        },
        mockBindings
      )

      expect(res.status).toBe(400)
    })
  })
})
