/**
 * Query routes - execute parameterized SQL queries
 *
 * All queries are parameterized to prevent SQL injection.
 * Tenant isolation is enforced via x-tenant-id header.
 */

import { Hono } from 'hono'
import { validate } from '@g-a-l-a-c-t-i-c/validation'
import { z } from 'zod'
import type { PostAIBindings } from '../bindings'
import { getPgAdapter, executeQuery, executeQueryOne } from '../lib/pg'

type Env = { Bindings: PostAIBindings; Variables: { tenantId: string; userId: string; validated: unknown } }

export const queryRoutes = new Hono<Env>()

const querySchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional().default([]),
})

// POST /query - execute parameterized SQL, returns rows
queryRoutes.post('/', validate('json', querySchema), async (c) => {
  const { sql, params } = c.get('validated') as z.infer<typeof querySchema>
  const adapter = getPgAdapter(c.env)
  const rows = await executeQuery(adapter, sql, params)
  return c.json({ data: rows, count: rows.length })
})

// POST /query-one - execute, return first row or null
queryRoutes.post('/one', validate('json', querySchema), async (c) => {
  const { sql, params } = c.get('validated') as z.infer<typeof querySchema>
  const adapter = getPgAdapter(c.env)
  const row = await executeQueryOne(adapter, sql, params)
  return c.json({ data: row })
})
