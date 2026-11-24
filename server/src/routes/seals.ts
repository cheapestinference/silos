// routes/seals.ts — the doors of the seal's rows (seals.ts).
// OWNER ONLY: an agent's bearer reaches none of them — agent-authz.ts
// lists none, so its allow-lists deny by default (reads and writes alike).
//   GET  /api/seals                         rows, page lines, degraded files
//   GET  /api/seals/rows/:id/held           the set-aside copy, to review
//                                           (opening NEVER adopts — G3)
//   POST /api/seals/rows/:id/keep           «Keep the edit»: validate, adopt, re-seal
//   POST /api/seals/rows/:id/discard        «Discard»: the set-aside bytes to the trash
//   POST /api/seals/rows/:id/seen           Seen (rotated token, reset sessions,
//                                           a plugin edited, an engine config changed,
//                                           an unverified file kept as loaded)
//   POST /api/seals/rows/:id/hold           «Hold»: a plugin's edited paths out of load
//   POST /api/seals/rows/:id/put-back {path}  a set-aside plugin file loads again
//   POST /api/seals/rows/:id/delete   {path}  a set-aside plugin file to the trash
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { DoorResult, Seals } from '../seals.js'

export interface SealRoutesCtx {
  seals: Seals
}

function answer(reply: FastifyReply, r: DoorResult): unknown {
  return r.ok ? { ok: true } : reply.code(r.status).send({ error: r.error })
}

export function sealRoutes(app: FastifyInstance, ctx: SealRoutesCtx): void {
  const { seals } = ctx
  app.get('/api/seals', async () => ({
    rows: seals.rows(),
    pageLines: seals.pageLines(),
    degraded: seals.rows().flatMap((r) => (r.kind === 'unverified' && seals.degraded(r.file) ? [r.file] : [])),
  }))
  app.get<{ Params: { id: string } }>('/api/seals/rows/:id/held', async (req, reply) => {
    const h = seals.heldText(req.params.id)
    return h ?? reply.code(404).send({ error: 'nothing set aside for this row' })
  })
  app.post<{ Params: { id: string } }>('/api/seals/rows/:id/keep', async (req, reply) => answer(reply, seals.keep(req.params.id)))
  app.post<{ Params: { id: string } }>('/api/seals/rows/:id/discard', async (req, reply) => answer(reply, seals.discard(req.params.id)))
  app.post<{ Params: { id: string } }>('/api/seals/rows/:id/hold', async (req, reply) => answer(reply, seals.holdPlugin(req.params.id)))
  app.post<{ Params: { id: string } }>('/api/seals/rows/:id/seen', async (req, reply) => answer(reply, seals.seen(req.params.id)))
  app.post<{ Params: { id: string }; Body: { path?: unknown } }>('/api/seals/rows/:id/put-back', async (req, reply) => {
    const path = req.body?.path
    if (typeof path !== 'string' || path === '') return reply.code(400).send({ error: 'path required' })
    return answer(reply, seals.putBack(req.params.id, path))
  })
  app.post<{ Params: { id: string }; Body: { path?: unknown } }>('/api/seals/rows/:id/delete', async (req, reply) => {
    const path = req.body?.path
    if (typeof path !== 'string' || path === '') return reply.code(400).send({ error: 'path required' })
    return answer(reply, seals.deleteHeld(req.params.id, path))
  })
}
