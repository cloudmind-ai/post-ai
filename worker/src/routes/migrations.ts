/**
 * Migration routes - schema management
 *
 * Apply, check status of PostgreSQL migrations.
 */

import { Hono } from 'hono'
import { validate } from '@g-a-l-a-c-t-i-c/validation'
import { z } from 'zod'
import type { PostAIBindings } from '../bindings'
import { getPgAdapter } from '../lib/pg'
import { applyMigrations, getMigrationStatus } from '../lib/migrations'

type Env = { Bindings: PostAIBindings; Variables: { tenantId: string; userId: string; validated: unknown } }

export const migrationRoutes = new Hono<Env>()

const migrationSchema = z.object({
  migrations: z
    .array(
      z.object({
        version: z.number().int().positive(),
        name: z.string().min(1),
        sql: z.string().min(1),
      }),
    )
    .min(1),
})

const statusQuerySchema = z.object({
  migrations: z.string().optional(),
})

// POST /migrations/apply - apply pending migrations
migrationRoutes.post('/apply', validate('json', migrationSchema), async (c) => {
  const { migrations } = c.get('validated') as z.infer<typeof migrationSchema>
  const adapter = getPgAdapter(c.env)
  const result = await applyMigrations(adapter, migrations)
  return c.json({ data: result })
})

// GET /migrations/status - list applied + pending
migrationRoutes.get('/status', async (c) => {
  const adapter = getPgAdapter(c.env)
  // Caller can pass known migrations as JSON query param to see pending
  const migrationsParam = c.req.query('migrations')
  const knownMigrations = migrationsParam ? JSON.parse(migrationsParam) : []
  const status = await getMigrationStatus(adapter, knownMigrations)
  return c.json({ data: status })
})
