import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  generateSchemaFromDescription,
  generateMigrationFromDescription,
  optimizeQuery,
  createAISchemaService,
} from '../lib/ai-schema'
import type { Ai } from '@cloudflare/workers-types'

describe('AI Schema Service', () => {
  let mockAI: Ai
  let service: ReturnType<typeof createAISchemaService>

  beforeEach(() => {
    mockAI = {
      run: vi.fn(),
    } as unknown as Ai
    service = createAISchemaService(mockAI)
  })

  describe('generateSchemaFromDescription', () => {
    it('should return valid DDL for a simple table description', async () => {
      const mockResponse = {
        response: `CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);`,
      }
      vi.mocked(mockAI.run).mockResolvedValueOnce(mockResponse)

      const result = await service.generateSchemaFromDescription(
        'Create a users table with email, name, and timestamps'
      )

      expect(result).toContain('CREATE TABLE')
      expect(result).toContain('users')
      expect(mockAI.run).toHaveBeenCalledWith(
        '@hf/nousresearch/hermes-2-pro-mistral-7b',
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
            }),
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining('Create a users table'),
            }),
          ]),
        })
      )
    })

    it('should handle AI service errors gracefully', async () => {
      vi.mocked(mockAI.run).mockRejectedValueOnce(new Error('AI service unavailable'))

      await expect(
        service.generateSchemaFromDescription('Create a table')
      ).rejects.toThrow('Failed to generate schema')
    })
  })

  describe('generateMigrationFromDescription', () => {
    it('should create safe up and down migration scripts', async () => {
      const mockResponse = {
        response: JSON.stringify({
          up: `ALTER TABLE users ADD COLUMN phone VARCHAR(20);`,
          down: `ALTER TABLE users DROP COLUMN phone;`,
        }),
      }
      vi.mocked(mockAI.run).mockResolvedValueOnce(mockResponse)

      const result = await service.generateMigrationFromDescription(
        'CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR(255));',
        'Add a phone number column to users table'
      )

      expect(result).toHaveProperty('up')
      expect(result).toHaveProperty('down')
      expect(result.up).toContain('ALTER TABLE')
      expect(result.down).toContain('DROP COLUMN')
    })

    it('should warn about potentially destructive changes', async () => {
      const mockResponse = {
        response: JSON.stringify({
          up: `ALTER TABLE users DROP COLUMN email;`,
          down: `ALTER TABLE users ADD COLUMN email VARCHAR(255);`,
          warnings: ['Data loss: email column will be permanently deleted'],
        }),
      }
      vi.mocked(mockAI.run).mockResolvedValueOnce(mockResponse)

      const result = await service.generateMigrationFromDescription(
        'CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR(255), name VARCHAR(255));',
        'Remove the email column'
      )

      expect(result).toHaveProperty('warnings')
      expect(result.warnings).toContain('Data loss: email column will be permanently deleted')
    })
  })

  describe('optimizeQuery', () => {
    it('should return optimized SQL with explanation', async () => {
      const mockResponse = {
        response: JSON.stringify({
          optimized: `SELECT u.id, u.email FROM users u WHERE u.email = $1`,
          explanation:
            'Added index-friendly equality check instead of ILIKE. Use exact match with functional index if case-insensitivity needed.',
          originalIssues: ['ILIKE prevents index usage', 'Wildcard at start of pattern'],
        }),
      }
      vi.mocked(mockAI.run).mockResolvedValueOnce(mockResponse)

      const result = await service.optimizeQuery(
        "SELECT * FROM users WHERE email ILIKE '%@example.com'"
      )

      expect(result).toHaveProperty('optimized')
      expect(result).toHaveProperty('explanation')
      expect(result.optimized).toContain('SELECT')
      expect(result.explanation.length).toBeGreaterThan(0)
    })

    it('should identify missing indexes', async () => {
      const mockResponse = {
        response: JSON.stringify({
          optimized: `SELECT o.id, o.amount FROM orders o WHERE o.user_id = $1 AND o.created_at > $2`,
          explanation: 'Recommend creating index: CREATE INDEX idx_orders_user_created ON orders(user_id, created_at)',
          indexRecommendations: ['CREATE INDEX idx_orders_user_created ON orders(user_id, created_at)'],
        }),
      }
      vi.mocked(mockAI.run).mockResolvedValueOnce(mockResponse)

      const result = await service.optimizeQuery(
        'SELECT * FROM orders WHERE user_id = 123 AND created_at > NOW() - INTERVAL 30 days'
      )

      expect(result).toHaveProperty('indexRecommendations')
      expect(result.indexRecommendations?.length).toBeGreaterThan(0)
    })
  })
})
