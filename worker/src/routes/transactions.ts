/**
 * Transaction routes - multi-statement ACID transactions
 *
 * Executes an array of SQL statements atomically wrapped in
 * BEGIN/COMMIT with automatic ROLLBACK on error.
 */

import { Hono } from 'hono'
import { validate } from '@g-a-l-a-c-t-i-c/validation'
import { z } from 'zod'
import type { PostAIBindings } from '../bindings'
import { getPgAdapter, executeTransaction } from '../lib/pg'

type Env = { Bindings: PostAIBindings; Variables: { tenantId: string; userId: string; validated: unknown } }

export const transactionRoutes = new Hono<Env>()

const transactionSchema = z.object({
  statements: z
    .array(
      z.object({
        sql: z.string().min(1),
        params: z.array(z.unknown()).optional().default([]),
      }),
    )
    .min(1),
})

// POST /transaction - execute array of statements atomically
transactionRoutes.post('/', validate('json', transactionSchema), async (c) => {
  const { statements } = c.get('validated') as z.infer<typeof transactionSchema>
  const adapter = getPgAdapter(c.env)
  const results = await executeTransaction(adapter, statements)
  return c.json({ data: results, statementCount: statements.length })
})
