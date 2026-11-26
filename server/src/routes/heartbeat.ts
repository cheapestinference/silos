// routes/heartbeat.ts — an agent's heartbeat and its control's doors:
//   GET  /api/agents/:id/heartbeat            (owner) the page's row: period, next, sleep, last
//   POST /api/agents/:id/heartbeat/run-now    (owner) a think now — held by the spend cap, never by the ceiling
//   POST /api/agents/:id/heartbeat/wake       (owner) clears the sleep
//   POST /api/agents/<self>/heartbeat/sleep   (bearer, a heartbeat turn) {until, why, turn}
//   POST /api/agents/<self>/considered        (bearer, a heartbeat turn) {idea, decision, why, until?, turn}
//   POST /api/agents/:id/stop                 (owner) {turns?, pause?} — the «Only when told» sheet's Stop / Pause too
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AgentRegistry } from '../agent-registry.js'
import type { AutomationsStore } from '../automations-store.js'
import type { Resident } from '../resident.js'
import type { ChatService } from '../chat-service.js'
import { heartbeatOf, staggeredMinute } from '../control.js'
import { heartbeatAutomationId } from '../heartbeat.js'
import { nextSlot, periodDay } from '../period.js'
import type { HeartbeatStore } from '../heartbeat-store.js'
import { CONSIDERED_PER_TURN, SLEEP_MAX_MS } from '../limits.js'
import { ownCapHold, type OwnTurnsToday } from '../own-turns.js'
import type { Considered } from '../heartbeat-packet.js'
import type { Initiative } from '../initiative.js'

export interface HeartbeatRoutesCtx {
  registry: AgentRegistry
  automations: AutomationsStore
  resident: Resident
  chat: ChatService
  store: HeartbeatStore
  ownToday: (agentId: string, now: number) => OwnTurnsToday | null
  accountResetOf?: (agentId: string) => string | null
  // the live turns of an agent the sheet can stop (Task mode's wakes and the
  // resident's runs), and whether a turn id is one of them
  liveTurnsOf: (agentId: string) => Array<{ turnId: string; what: string }>
  // the proactive mode as the page reads it
  proactiveView?: (agentId: string, now: number) => unknown
  // the ledger of own creations: Decided, Measured, Keep (initiative.ts)
  initiative?: Pick<Initiative, 'decided' | 'measures' | 'keep'> & Partial<Pick<Initiative, 'outsideOf' | 'createdOfRun'>>
}

// the class of the bearer's live turn (live-turns.ts), as the auth
// layer resolved it from `turn` — never what the body declares
type TurnOnRequest = { class: string; turnId: string; agentId: string }
const turnOf = (req: FastifyRequest): TurnOnRequest | null => (req as unknown as { turn?: TurnOnRequest }).turn ?? null

const DECISIONS = new Set(['created', 'proposed', 'dropped', 'later'])

export function heartbeatRoutes(app: FastifyInstance, ctx: HeartbeatRoutesCtx): void {
  const { registry, automations, resident, chat, store } = ctx
  const ownerOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.agentId === undefined) return true
    void reply.code(403).send({ error: `agent ${req.agentId} may not do this — it is the owner's` })
    return false
  }
  const selfOnly = (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): boolean => {
    if (req.agentId === req.params.id) return true
    void reply
      .code(403)
      .send({
        error:
          req.agentId === undefined
            ? "this is an agent's own heartbeat verb — the owner wakes it on its page"
            : `agent ${req.agentId} may not act for ${req.params.id}`,
      })
    return false
  }

  app.get<{ Params: { id: string } }>('/api/agents/:id/heartbeat', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply
    const agent = registry.get(req.params.id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    const hb = heartbeatOf(agent)
    const a = automations.get(heartbeatAutomationId(agent.id))
    const now = new Date()
    let next: string | null = null
    if (a && hb.period) {
      const slot = nextSlot(hb.period, now.getTime())
      next = a.nextRunAt ?? (slot !== null ? new Date(slot).toISOString() : null)
    }
    const runs = a ? automations.listRuns(a.id) : []
    const last = runs.find((r) => r.status !== 'running' && r.status !== 'queued') ?? null
    // the last fire that TOOK a turn («Made its round
    // 14:22 — decided 2 things ›» stays said under a later «Skipped 17:22 …»)
    const lastTurn = runs.find((r) => r.status !== 'running' && r.status !== 'queued' && r.status !== 'skipped') ?? null
    // what a run created: its own record, else the ledger's by its run
    const createdOf = (r: { id: string; heartbeat?: { created?: string[] } }): string[] =>
      (r.heartbeat?.created?.length ? r.heartbeat.created : ctx.initiative?.createdOfRun?.(agent.id, r.id)) ?? []
    // today's skipped fires with their cause (HeartbeatSkip:
    // «Skipped 17:22 — its account is at 88% of its 5-hour window»)
    const day = periodDay(now.getTime())
    const skips = runs
      .filter((r) => r.status === 'skipped' && r.heartbeat?.skipped && periodDay(Date.parse(r.at) || 0) === day)
      .slice(0, 20)
      .map((r) => ({ at: r.at, cause: r.heartbeat!.skipped!, kind: r.heartbeat!.kind, reason: r.reason ?? '' }))
    const sleeping = hb.sleepUntil && Date.parse(hb.sleepUntil) > now.getTime() ? { until: hb.sleepUntil, why: hb.sleepWhy ?? '' } : null
    return {
      // the period in place of the rhythm (null = never)
      period: hb.period,
      next,
      sleeping,
      last: last
        ? {
            at: last.at,
            kind: last.heartbeat?.kind ?? null,
            skipped: last.status === 'skipped' ? (last.reason ?? 'skipped') : null,
            cause: last.status === 'skipped' ? (last.heartbeat?.skipped ?? null) : null,
            // the regime its run SEALED
            tools: last.heartbeat?.tools ?? false,
            readOutside: last.audit?.readOutside ?? [],
            summary: last.summary ?? null,
            created: createdOf(last),
            proposed: last.heartbeat?.proposed ?? [],
            tainted: (last.audit?.readOutside ?? []).length > 0,
          }
        : null,
      lastTurn: lastTurn
        ? {
            at: lastTurn.at,
            kind: lastTurn.heartbeat?.kind ?? null,
            created: createdOf(lastTurn),
            proposed: lastTurn.heartbeat?.proposed ?? [],
          }
        : null,
      // the agent's staggered minute: the anchor the server stamps on
      // a minutes/hours period with no `at` — so the proactive sheet's «≈ 4
      // rounds a day, from 08:22» is the period the server will keep
      staggerMinute: staggeredMinute(agent.id),
      // what it decided on its own (≤ 10, initiatives and recurring work
      // lead; the reactive tail counted apart) and the measure
      decided: ctx.initiative?.decided(agent.id, 10).items ?? [],
      decidedReactive: ctx.initiative?.decided(agent.id, 10).reactive ?? 0,
      measures: ctx.initiative?.measures(agent.id) ?? null,
      // its open tasks added outside Silos: one line on its page
      outside: ctx.initiative?.outsideOf?.(agent.id) ?? [],
      today: ctx.ownToday(agent.id, now.getTime()),
      // its heartbeat's turns today, by class — said apart from the max,
      // which no longer counts them («looked twice today»)
      beats: store.turnsOfDay(agent.id, periodDay(now.getTime())),
      skips,
      // the proactive mode: what q4's switch, sheet and
      // rows read — null when not wired
      proactive: ctx.proactiveView?.(agent.id, now.getTime()) ?? null,
    }
  })

  app.post<{ Params: { id: string } }>('/api/agents/:id/heartbeat/run-now', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply
    const agent = registry.get(req.params.id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    const a = automations.get(heartbeatAutomationId(agent.id))
    if (!a) return reply.code(409).send({ error: `${agent.name} has no heartbeat — set it On its own and pick how often first` })
    // the spend cap holds it (M3-r6: it opens a turn that FABRICATES
    // inferred work, and money is money); the ceiling never does — a
    // heartbeat turn is outside its count («Run
    // now»). «Let it continue today» lifts the cap.
    const today = ctx.ownToday(agent.id, Date.now())
    const hold = today ? ownCapHold(today, { outsideCeiling: true }) : null
    if (hold === 'spend')
      return reply.code(409).send({ error: `${agent.name} spent $${today!.costUsd.toFixed(2)} without you today — its cap; let it continue today first` })
    const reset = ctx.accountResetOf?.(agent.id) ?? null
    // the instant rides apart (`until`): the words stop before it
    if (reset !== null && Date.parse(reset) > Date.now())
      return reply.code(409).send({ error: `${agent.name}'s account is at its usage limit — run it again after`, until: reset })
    const res = await resident.runNowManual(a.id)
    if ('error' in res) return reply.code(res.code).send({ error: res.error })
    return reply.code(202).send({ ok: true, ...(resident.heldWhy(a.id) ? { held: resident.heldWhy(a.id) } : {}) })
  })

  app.post<{ Params: { id: string } }>('/api/agents/:id/heartbeat/wake', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply
    const agent = registry.get(req.params.id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    registry.update(agent.id, { heartbeat: { sleepUntil: undefined, sleepWhy: undefined } })
    return { ok: true }
  })

  app.post<{ Params: { id: string }; Body: { until?: unknown; why?: unknown } | null }>('/api/agents/:id/heartbeat/sleep', async (req, reply) => {
    if (!selfOnly(req, reply)) return reply
    const turn = turnOf(req)
    if (!turn || turn.class !== 'heartbeat') return reply.code(403).send({ error: 'only a heartbeat turn sleeps' })
    const until = typeof req.body?.until === 'string' ? Date.parse(req.body.until) : NaN
    if (Number.isNaN(until) || until <= Date.now() || until - Date.now() > SLEEP_MAX_MS) return reply.code(400).send({ error: 'until must be within 30 days' })
    const why = typeof req.body?.why === 'string' ? req.body.why.trim().slice(0, 300) : ''
    const iso = new Date(until).toISOString()
    registry.update(req.params.id, { heartbeat: { sleepUntil: iso, ...(why ? { sleepWhy: why } : {}) } })
    const run = resident.runOfTurn(turn.turnId)
    if (run) resident.noteSlept(run.runId, iso)
    return { ok: true, until: iso }
  })

  app.post<{ Params: { id: string }; Body: { idea?: unknown; decision?: unknown; why?: unknown; until?: unknown } | null }>(
    '/api/agents/:id/considered',
    async (req, reply) => {
      if (!selfOnly(req, reply)) return reply
      const turn = turnOf(req)
      if (!turn || turn.class !== 'heartbeat') return reply.code(403).send({ error: 'only a heartbeat turn records what it considered' })
      const b = req.body ?? {}
      const idea = typeof b.idea === 'string' ? b.idea.trim() : ''
      if (!idea || idea.length > 200 || /[\r\n]/.test(idea)) return reply.code(400).send({ error: 'idea required (one line)' })
      if (typeof b.decision !== 'string' || !DECISIONS.has(b.decision))
        return reply.code(400).send({ error: 'decision must be created, proposed, dropped or later' })
      const why = typeof b.why === 'string' ? b.why.trim().slice(0, 300) : ''
      let until: string | undefined
      if (b.until !== undefined) {
        const t = typeof b.until === 'string' ? Date.parse(b.until) : NaN
        if (Number.isNaN(t)) return reply.code(400).send({ error: 'until must be a date' })
        until = new Date(t).toISOString()
      }
      const run = resident.runOfTurn(turn.turnId)
      if (run && store.countForRun(req.params.id, run.runId) >= CONSIDERED_PER_TURN)
        return reply.code(429).send({ error: `${CONSIDERED_PER_TURN} considered this heartbeat — decide` })
      const c: Considered = {
        at: new Date().toISOString(),
        ...(run ? { run: run.runId } : {}),
        idea,
        decision: b.decision as Considered['decision'],
        why,
        ...(until ? { until } : {}),
      }
      store.append(req.params.id, c)
      return reply.code(201).send({ considered: c })
    },
  )

  // GET /api/agents/:id/measures (owner) — Measures (renamed from
  // …/initiatives: it returns measures, not initiatives)
  app.get<{ Params: { id: string } }>('/api/agents/:id/measures', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply
    const agent = registry.get(req.params.id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    if (!ctx.initiative) return reply.code(503).send({ error: 'the ledger is not wired' })
    return ctx.initiative.measures(agent.id)
  })

  app.post<{ Params: { id: string }; Body: { turns?: unknown; pause?: unknown; keep?: unknown } | null }>('/api/agents/:id/stop', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply
    const agent = registry.get(req.params.id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    const asked = Array.isArray(req.body?.turns) ? req.body!.turns.filter((x): x is string => typeof x === 'string') : []
    const live = new Set(ctx.liveTurnsOf(agent.id).map((t) => t.turnId))
    const stopped: string[] = []
    // a console is never touched: «your console is yours: Esc stops it there»
    for (const id of asked) if (live.has(id) && (await chat.cancel(id))) stopped.push(id)
    const pauses = Array.isArray(req.body?.pause) ? req.body!.pause.filter((x): x is string => typeof x === 'string') : []
    const paused: string[] = []
    for (const id of pauses) {
      const a = automations.get(id)
      if (!a || a.agentId !== agent.id || a.origin === 'heartbeat') continue
      resident.pause(id)
      paused.push(id)
    }
    // «Keep (it runs under Only when told)» (G6-r6): the owner's gesture,
    // stamped keptAt on the ledger entry — never an acceptedFrom
    const keeps = Array.isArray(req.body?.keep) ? req.body!.keep.filter((x): x is string => typeof x === 'string') : []
    const kept: string[] = []
    for (const id of keeps) {
      const a = automations.get(id)
      if (!a || a.agentId !== agent.id || a.origin !== 'self') continue
      if (ctx.initiative?.keep(id)) kept.push(id)
    }
    return { stopped, paused, kept }
  })
}
