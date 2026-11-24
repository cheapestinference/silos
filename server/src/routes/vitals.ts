// routes/vitals.ts — GET /api/vitals (vitals.ts): runs a day, executions a
// day and the fleet by control, derived backwards. The owner's read, like
// Usage: an agent's bearer never reads it (agent-authz.ts keeps it out of
// agentMayRead's allow-list — and the route says so too).
import type { FastifyInstance } from 'fastify'
import type { VitalsService } from '../vitals.js'

export function vitalsRoutes(app: FastifyInstance, ctx: { vitals: Pick<VitalsService, 'vitals'> }): void {
  app.get('/api/vitals', async (req, reply) => {
    if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read the vitals — they are the owner's` })
    return ctx.vitals.vitals()
  })
}
