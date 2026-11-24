// routes/initiative.ts — the owner's doors on what agents create on their
// own:
//
//   POST /api/creations/undo            (owner) { task?: key; automation?: id } → { undone, stopped }
//   GET  /api/plans/origin?key=<k>      the origin of a task («added outside Silos ›» — reading never blesses)
//   POST /api/plans/origin/keep         (owner) { key } — «Keep it — it's mine» (the ONLY blessing besides Give)
//   GET  /api/plans/baseline            the baseline rows: one per folder (M13-r6)
//   POST /api/plans/baseline/keep-all   (owner) { folder, exclude?: key[] } — «Keep them all»
//   POST /api/automations/withdrawn/:id/restore (owner) — «Restore ›» of a withdrawal (m4-r7)
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AutomationsStore } from '../automations-store.js'
import type { Initiative } from '../initiative.js'
import type { PlansOrigins } from '../plans-origins.js'

export interface InitiativeRoutesCtx {
  initiative: Initiative
  origins: PlansOrigins
  automations: Pick<AutomationsStore, 'get' | 'create'>
}

export function initiativeRoutes(app: FastifyInstance, ctx: InitiativeRoutesCtx): void {
  const ownerOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.agentId === undefined) return true
    void reply.code(403).send({ error: `agent ${req.agentId} may not do this — it is the owner's` })
    return false
  }

  app.post<{ Body: { task?: unknown; automation?: unknown } | null }>('/api/creations/undo', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply
    const b = req.body ?? {}
    const r = ctx.initiative.undo({
      ...(typeof b.task === 'string' ? { task: b.task } : {}),
      ...(typeof b.automation === 'string' ? { automation: b.automation } : {}),
    })
    if (!r.ok) return reply.code(r.code).send({ error: r.error })
    return { undone: r.undone, stopped: r.stopped }
  })

  app.get<{ Querystring: { key?: string } }>('/api/plans/origin', async (req, reply) => {
    const key = req.query.key
    if (typeof key !== 'string' || key === '') return reply.code(400).send({ error: 'send ?key=<task key>' })
    const o = ctx.origins.get(key)
    // absent from the registry: unknown until the stamper registers it (B1-r7)
    return { key, by: o?.provisional ? 'unknown' : (o?.by ?? 'unknown'), how: o?.how ?? null, outside: !o || o.by === 'unknown' || o.provisional !== undefined }
  })

  app.post<{ Body: { key?: unknown } | null }>('/api/plans/origin/keep', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply
    const key = req.body?.key
    if (typeof key !== 'string' || key === '') return reply.code(400).send({ error: 'send {key}' })
    return { blessed: ctx.initiative.bless(key, 'keep') }
  })

  app.get('/api/plans/baseline', async () => ({ rows: ctx.initiative.baseline() }))

  app.post<{ Body: { folder?: unknown; exclude?: unknown } | null }>('/api/plans/baseline/keep-all', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply
    const folder = req.body?.folder
    if (typeof folder !== 'string' || folder === '') return reply.code(400).send({ error: 'send {folder, exclude?}' })
    const exclude = Array.isArray(req.body?.exclude) ? req.body!.exclude.filter((x): x is string => typeof x === 'string') : []
    return { kept: ctx.initiative.keepAll(folder, exclude) }
  })

  app.post<{ Params: { id: string } }>('/api/automations/withdrawn/:id/restore', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply
    if (ctx.automations.get(req.params.id)) return reply.code(409).send({ error: 'it is not withdrawn — it is in Automations' })
    const a = ctx.initiative.trashed(req.params.id)
    if (!a) return reply.code(404).send({ error: 'no such withdrawn automation' })
    return { restored: ctx.automations.create(a).id }
  })
}
