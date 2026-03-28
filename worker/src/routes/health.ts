/**
 * Health check route - verifies PostgreSQL connectivity
 */

import { Hono } from 'hono'
import type { PostAIBindings } from '../bindings'
import { getPgAdapter } from '../lib/pg'

type Env = { Bindings: PostAIBindings; Variables: { tenantId: string; userId: string } }

export const healthRoutes = new Hono<Env>()

healthRoutes.get('/health', async (c) => {
  const pgStatus = { connected: false, error: undefined as string | undefined }

  try {
    const adapter = getPgAdapter(c.env)
    await adapter.query('SELECT 1 as ok')
    pgStatus.connected = true
  } catch (error) {
    pgStatus.error = String(error)
  }

  const status = pgStatus.connected ? 'ok' : 'degraded'
  return c.json({
    status,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    services: {
      postgresql: pgStatus.connected ? 'connected' : 'unavailable',
    },
  }, 200)
})
