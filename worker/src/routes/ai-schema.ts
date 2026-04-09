/**
 * AI Schema Routes - HTTP endpoints for AI-powered schema operations
 *
 * Provides:
 * - POST /api/schema/generate - Natural language to DDL
 * - POST /api/schema/migrate - Generate migration scripts
 * - POST /api/query/optimize - Query optimization
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { createAISchemaService } from '../lib/ai-schema'
import type { PostAIBindings } from '../bindings'

const app = new Hono<{ Bindings: PostAIBindings; Variables: { tenantId: string } }>()

// Validation schemas
const generateSchemaRequest = z.object({
  description: z.string().min(1, 'Description is required'),
})

const migrateSchemaRequest = z.object({
  currentSchema: z.string().min(1, 'Current schema is required'),
  changeRequest: z.string().min(1, 'Change request is required'),
})

const optimizeQueryRequest = z.object({
  query: z.string().min(1, 'Query is required'),
})

/**
 * POST /api/schema/generate
 * Generate PostgreSQL DDL from natural language description
 */
app.post('/generate', async (c) => {
  const body = await c.req.json()
  const parseResult = generateSchemaRequest.safeParse(body)

  if (!parseResult.success) {
    return c.json(
      {
        error: 'Validation failed',
        details: parseResult.error.errors,
      },
      400
    )
  }

  const { description } = parseResult.data
  const aiService = createAISchemaService(c.env.AI)

  try {
    const ddl = await aiService.generateSchemaFromDescription(description)

    return c.json({
      ddl,
      description,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return c.json({ error: 'Failed to generate schema', details: message }, 500)
  }
})

/**
 * POST /api/schema/migrate
 * Generate safe migration scripts (up/down) from change request
 */
app.post('/migrate', async (c) => {
  const body = await c.req.json()
  const parseResult = migrateSchemaRequest.safeParse(body)

  if (!parseResult.success) {
    return c.json(
      {
        error: 'Validation failed',
        details: parseResult.error.errors,
      },
      400
    )
  }

  const { currentSchema, changeRequest } = parseResult.data
  const aiService = createAISchemaService(c.env.AI)

  try {
    const migration = await aiService.generateMigrationFromDescription(
      currentSchema,
      changeRequest
    )

    return c.json({
      up: migration.up,
      down: migration.down,
      warnings: migration.warnings ?? [],
      currentSchema,
      changeRequest,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return c.json({ error: 'Failed to generate migration', details: message }, 500)
  }
})

/**
 * POST /api/query/optimize
 * Analyze and optimize SQL queries
 */
app.post('/optimize', async (c) => {
  const body = await c.req.json()
  const parseResult = optimizeQueryRequest.safeParse(body)

  if (!parseResult.success) {
    return c.json(
      {
        error: 'Validation failed',
        details: parseResult.error.errors,
      },
      400
    )
  }

  const { query } = parseResult.data
  const aiService = createAISchemaService(c.env.AI)

  try {
    const optimization = await aiService.optimizeQuery(query)

    return c.json({
      original: query,
      optimized: optimization.optimized,
      explanation: optimization.explanation,
      originalIssues: optimization.originalIssues ?? [],
      indexRecommendations: optimization.indexRecommendations ?? [],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return c.json({ error: 'Failed to optimize query', details: message }, 500)
  }
})

export default app
