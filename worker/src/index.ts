/**
 * Post AI - Managed PostgreSQL Data Service
 *
 * Provides ACID transactions, schema management, audit trail,
 * and financial-grade query API via @g-a-l-a-c-t-i-c/data PostgreSQL adapter.
 *
 * Other products call Post AI via service binding instead of
 * managing their own Hyperdrive connections.
 */

import { Hono } from 'hono'
import { errorHandler } from '@g-a-l-a-c-t-i-c/errors'
import type { PostAIBindings } from './bindings'

import { queryRoutes } from './routes/query'
import { transactionRoutes } from './routes/transactions'
import { migrationRoutes } from './routes/migrations'
import { auditRoutes } from './routes/audit'
import { healthRoutes } from './routes/health'
import aiSchemaRoutes from './routes/ai-schema'

const app = new Hono<{ Bindings: PostAIBindings; Variables: { tenantId: string; userId: string } }>()

app.onError(errorHandler)

// Extract tenant/user context from dispatch headers
app.use('*', async (c, next) => {
  c.set('tenantId', c.req.header('x-tenant-id') ?? '')
  c.set('userId', c.req.header('x-user-id') ?? '')
  await next()
})

app.route('/query', queryRoutes)
app.route('/transaction', transactionRoutes)
app.route('/migrations', migrationRoutes)
app.route('/audit', auditRoutes)
app.route('/', healthRoutes)

export default app
