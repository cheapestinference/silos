// routes/usage.ts — Usage:
//   GET /api/usage?period=today|7d|30d&by=agent|kind|task|automation|conversation|account[&agent=]
//   (or from=&to= for any range) — a named period's range is the SERVER's:
//   its local midnight, the one every row, bar and cap counts by.
// The owner's read. An agent's bearer never reads it (agent-authz.ts keeps
// /api/usage out of agentMayRead's allow-list) — and the route says so too.
import type { FastifyInstance } from 'fastify'
import { USAGE_BY, USAGE_PERIODS, periodRange, type UsageBy, type UsagePeriod, type UsageService } from '../usage.js'

/** The longest range one read covers (the page's longest view is 30 days). */
export const USAGE_RANGE_MAX_MS = 92 * 24 * 3600_000

const timeOf = (v: unknown): number | null => {
  if (typeof v !== 'string' || v === '') return null
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  return Number.isFinite(n) ? n : null
}

export function usageRoutes(app: FastifyInstance, ctx: { usage: Pick<UsageService, 'report'>; now?: () => number }): void {
  app.get<{ Querystring: { period?: string; from?: string; to?: string; by?: string; agent?: string } }>('/api/usage', async (req, reply) => {
    if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read Usage — it is the owner's` })
    const now = ctx.now?.() ?? Date.now()
    const period = req.query.period
    if (period !== undefined && !(USAGE_PERIODS as readonly string[]).includes(period))
      return reply.code(400).send({ error: `period must be ${USAGE_PERIODS.join(', ')}` })
    const named = periodRange((period ?? 'today') as UsagePeriod, now)
    const from = period !== undefined ? named.from : (timeOf(req.query.from) ?? named.from)
    const to = period !== undefined ? named.to : (timeOf(req.query.to) ?? now)
    if (to <= from) return reply.code(400).send({ error: 'to must be after from' })
    if (to - from > USAGE_RANGE_MAX_MS) return reply.code(400).send({ error: 'a Usage read covers 92 days at most' })
    const by = (req.query.by ?? 'agent') as UsageBy
    if (!USAGE_BY.includes(by)) return reply.code(400).send({ error: `by must be ${USAGE_BY.join(', ')}` })
    const agent = typeof req.query.agent === 'string' && req.query.agent !== '' ? req.query.agent : null
    return ctx.usage.report({ from, to, by, agent })
  })
}
