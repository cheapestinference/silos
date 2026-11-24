// routes/automations.ts — the automations REST surface, moved VERBATIM out
// of server.ts (split the monoliths by domain, behavior unchanged). buildServer registers it only when both the store and the
// resident were injected, exactly like the old in-place block; checkInbox
// arrives as a thunk because server.ts declares it after this point.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AgentRegistry } from '../agent-registry.js'
import type { AutomationsStore } from '../automations-store.js'
import type { Automation } from '../automations-types.js'
import {
  selfPatchRefusal,
  selfShaped,
  validateAutomationCreate,
  validateAutomationPatch,
  validateSelfAutomation,
  withPatchedPeriodBudget,
  withPeriodBudget,
  type ValidateExtras,
} from '../automations-validate.js'
import { heartbeatOf, selfRecurringRefusal, type Control } from '../control.js'
import { ROUND_RECURRING_PROPOSED } from '../proactive.js'
import { initiativeNow, type Initiative } from '../initiative.js'
import type { LiveTurn } from '../live-turns.js'
import { runOfTurn } from '../live-turns.js'
import type { ProposalsStore } from '../proposals.js'
import { heartbeatBearerRefusal, heartbeatDeleteRefusal, heartbeatPatchRefusal, heartbeatPauseRefusal, isHeartbeat } from '../heartbeat.js'
import { providerIdError } from '../providers-validate.js'
import { harnessOf } from '../harnesses/registry.js'
import type { ProvidersStore } from '../providers-store.js'
import type { Resident } from '../resident.js'
import type { VitalsService } from '../vitals.js'
import { TemplateError, fillTemplate, fromAutomation, templateIdFrom, type AutomationTemplates, type Secret } from '../automation-templates.js'

// A run/automation id as it may appear in a log path — one segment, no
// traversal (same rule as the old module-level const in server.ts).
const RUN_LOG_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface AutomationRoutesCtx {
  automations: AutomationsStore
  resident: Resident
  registry: AgentRegistry
  providers: ProvidersStore | undefined
  // proposals (proposals.ts): a create from the automation editor opened by
  // a proposal's «Review ›» carries its id and resolves it
  proposals?: ProposalsStore
  checkInbox: () => void
  // automation templates (automation-templates.ts) — absent = no routes
  templates?: AutomationTemplates
  // the values a template must never hold (the Vault's, the static token)
  secrets?: () => Secret[]
  // the DERIVED control of an agent (control.ts controlOf) — absent: told
  controlOf?: (agentId: string) => Control
  // the ledger's box (initiative.ts) — absent: the one the server set
  initiative?: Initiative
  // what each automation spent in 30 days (vitals.ts) — the owner's list only
  usage?: Pick<VitalsService, 'automationUsage'>
}

// The only owner-deletes refusal a bearer hears on DELETE
export const DELETE_NOT_OWN = 'only the owner deletes an automation that is not your own'

// THE create path, for other owner-side flows (a role pack's install): the
// same validator, authorization and file-watcher start as POST /api/automations
export interface AutomationCreateApi {
  create(caller: string | undefined, body: unknown): Automation | { code: number; error: string }
  /** the create path's judge alone — what a create would make, or its refusal */
  prepare(
    caller: string | undefined,
    body: unknown,
  ): { input: Omit<Automation, 'id' | 'createdAt'>; generatedSecret?: string } | { code: number; error: string }
  /** an accepted proposal: the SAME path as the owner's create,
   *  stamped with who proposed it — never the self-creation limits */
  createStamped(
    body: unknown,
    stamp: Pick<Automation, 'createdBy' | 'origin' | 'acceptedFrom'>,
  ): { automation: Automation; generatedSecret?: string } | { code: number; error: string }
}

export function automationRoutes(app: FastifyInstance, ctx: AutomationRoutesCtx): AutomationCreateApi {
  const { automations, resident, registry, providers, proposals } = ctx
  const checkInbox = (): void => ctx.checkInbox()
  let createApi: AutomationCreateApi | null = null
  {
    // An agent bearer sees only its OWN automations, and never a webhook's
    // secret: that secret is the whole auth of /api/hooks/:id, so reading
    // another agent's would let it fire that agent's runs. The owner sees
    // everything, secrets included: the API returns the secret (the webhook
    // URL is /api/hooks/:id); the UI shows neither.
    const visibleTo = (req: FastifyRequest, a: Automation): boolean => req.agentId === undefined || a.agentId === req.agentId
    const shownTo = (req: FastifyRequest, a: Automation): Automation => {
      if (req.agentId === undefined || a.trigger.kind !== 'webhook') return a
      const { secret: _secret, ...trigger } = a.trigger
      return { ...a, trigger: trigger as Automation['trigger'] }
    }
    app.get('/api/automations', async (req) => {
      const list = automations
        .list()
        .filter((a) => visibleTo(req, a))
        .map((a) => shownTo(req, a))
      // spend is the owner's read (like Usage): a bearer's list carries none
      if (!ctx.usage || req.agentId !== undefined) return { automations: list }
      const u = await ctx.usage.automationUsage(list)
      return { automations: list.map((a) => ({ ...a, usage30d: u.byId.get(a.id) ?? null })), usageTotals30d: u.totals }
    })

    app.get<{ Params: { id: string } }>('/api/automations/:id', async (req, reply) => {
      const a = automations.get(req.params.id)
      if (!a || !visibleTo(req, a)) return reply.code(404).send({ error: 'automation not found' })
      return { automation: shownTo(req, a) }
    })

    // An automation's runsOn (the pair Run on pins, its runs' turn level):
    // the account must exist and suit the agent's engine — a turn tolerates
    // an unknown id, but a SAVED pin would silently fall back on every run —
    // and only the owner picks which account pays: an agent may choose its
    // runs' model, never the subscription (no silent rotation
    // between accounts).
    const runsOnError = (
      caller: string | undefined,
      agentId: string,
      runsOn: Automation['runsOn'],
      before?: Automation['runsOn'],
    ): { code: number; error: string } | null => {
      // an agent leaves the account as it found it — setting one, changing
      // it, or dropping the owner's choice by sending only a model
      if (caller !== undefined && runsOn?.provider !== before?.provider) return { code: 403, error: 'only the owner picks the account an automation runs on' }
      if (!runsOn?.provider) return null
      const agent = registry.get(agentId)
      if (!agent || !providers) return null
      const err = providerIdError(runsOn.provider, harnessOf(agent), providers)
      return err ? { code: 400, error: err } : null
    }

    // An automation that executes something WITHOUT Claude — a command run
    // or a watch whose
    // check is a shell command — runs as the server's user: the territory
    // fence lives inside Claude and never reaches it. So only the owner
    // creates or edits one; judged on the RAW body (before validation, so a
    // malformed command is a 403 too, never a hint) and on what is stored.
    const execsWithoutClaude = (x: unknown): boolean => {
      if (typeof x !== 'object' || x === null) return false
      const o = x as { run?: unknown; trigger?: unknown }
      const run = o.run as { kind?: unknown } | null | undefined
      const trig = o.trigger as { kind?: unknown; check?: { type?: unknown } | null } | null | undefined
      return (
        (typeof run === 'object' && run !== null && run.kind === 'command') ||
        (typeof trig === 'object' &&
          trig !== null &&
          trig.kind === 'watch' &&
          typeof trig.check === 'object' &&
          trig.check !== null &&
          trig.check.type === 'command')
      )
    }
    const ownerOnlyExec = (caller: string | undefined): string =>
      `agent ${String(caller)} may not create or edit an automation that runs a command — only the owner can (the territory fence does not reach an exec)`
    // A `conversation` trigger on ANOTHER agent's conversations hands that
    // agent's final words to the run (watchers.ts runOnFinished) — reading
    // across territories, which only the owner may set up. An agent watches
    // its own conversations, or none (security review).
    const watchesOthers = (caller: string, x: unknown): boolean => {
      const t = (x as { trigger?: { kind?: unknown; sourceAgentId?: unknown } } | null)?.trigger
      return typeof t === 'object' && t !== null && t.kind === 'conversation' && t.sourceAgentId !== undefined && t.sourceAgentId !== caller
    }
    const watchesOthersError = (caller: string): string => `agent ${caller} may not watch another agent's conversations — only the owner can set that up`
    const agentBodyError = (caller: string, body: unknown, verb = 'create'): string | null => {
      const bodyAgent = (body as { agentId?: unknown } | null)?.agentId
      return bodyAgent !== caller ? `agent ${caller} may not ${verb} automations for ${String(bodyAgent)}` : null
    }

    // THE create path — POST /api/automations and accepting an agent's
    // proposal both go through these two, so a proposal becomes exactly the
    // automation a direct create would have made. `caller` is the agent
    // bearer (undefined = the owner): an agent creates only for itself (the
    // body decides — agent-authz.ts lets the route through), never a command.
    // `generatedSecret`: a webhook secret the validator generated (E10 #16)
    // — the requester's 201 carries it once; shownTo hides it after.
    const prepareCreate = (
      caller: string | undefined,
      body: unknown,
    ): { input: Omit<Automation, 'id' | 'createdAt'>; generatedSecret?: string } | { code: number; error: string } => {
      if (caller !== undefined) {
        const notOwn = agentBodyError(caller, body)
        if (notOwn) return { code: 403, error: notOwn }
        if (execsWithoutClaude(body)) return { code: 403, error: ownerOnlyExec(caller) }
        if (watchesOthers(caller, body)) return { code: 403, error: watchesOthersError(caller) }
      }
      let input: Omit<Automation, 'id' | 'createdAt'>
      const extras: ValidateExtras = {}
      try {
        input = validateAutomationCreate(body, registry, extras)
      } catch (err) {
        return { code: 400, error: err instanceof Error ? err.message : String(err) }
      }
      if (caller !== undefined && execsWithoutClaude(input)) return { code: 403, error: ownerOnlyExec(caller) }
      const bad = runsOnError(caller, input.agentId, input.runsOn)
      if (bad) return bad
      return { input, ...(extras.generatedSecret ? { generatedSecret: extras.generatedSecret } : {}) }
    }
    const once = (generatedSecret: string | undefined): { generatedSecret?: string } => (generatedSecret ? { generatedSecret } : {})
    const createAutomation = (input: Omit<Automation, 'id' | 'createdAt'>, id: string = randomUUID()): Automation => {
      const a = { id, createdAt: new Date().toISOString(), ...input }
      automations.create(a)
      resident.reconcileFileWatchers() // a new `files` automation starts watching RIGHT AWAY, no restart needed
      return a
    }

    createApi = {
      create: (caller, body) => {
        const prepared = prepareCreate(caller, body)
        if ('error' in prepared) return prepared
        const input = caller === undefined ? withPeriodBudget(prepared.input, body) : prepared.input
        try {
          return createAutomation(input)
        } catch (err) {
          return { code: 400, error: err instanceof Error ? err.message : String(err) }
        }
      },
      prepare: (caller, body) => prepareCreate(caller, body),
      createStamped: (body, stamp) => {
        const prepared = prepareCreate(undefined, body)
        if ('error' in prepared) return prepared
        try {
          return { automation: createAutomation({ ...prepared.input, ...stamp }), ...once(prepared.generatedSecret) }
        } catch (err) {
          return { code: 400, error: err instanceof Error ? err.message : String(err) }
        }
      },
    }

    // A bearer's create: ONLY from its heartbeat's
    // think turn (the turn token, never the body), validated «self»
    // and stamped origin:'self'. Any other turn — attended included —
    // hears the 403, forked by control (one source:
    // control.ts selfRecurringRefusal). A console is no owner's approval:
    // the proposal→accept path is one touch.
    const initiative = (): Initiative | null => ctx.initiative ?? initiativeNow()
    // the gate alone: null when the turn is its think (and the ledger is there)
    const bearerGate = (agentId: string, turn: LiveTurn | undefined): string | null => {
      const agent = registry.get(agentId)
      const control = ctx.controlOf?.(agentId) ?? 'told'
      // a heartbeat SEALED with its tools (a round or a proactive
      // think): its own scheduled work is proposed, never created
      if (agent && control === 'own' && turn !== undefined && turn.class === 'heartbeat' && turn.regime?.tools === true) return ROUND_RECURRING_PROPOSED
      const think = turn !== undefined && turn.class === 'heartbeat' && turn.kind === 'think' && turn.unattended
      if (!agent || control !== 'own' || !think || !initiative()) return selfRecurringRefusal(control, agent ? heartbeatOf(agent).period : null)
      return null
    }
    const bearerCreate = (agentId: string, turn: LiveTurn | undefined, body: unknown): { code: number; body: Record<string, unknown> } => {
      const gate = bearerGate(agentId, turn)
      const ledger = initiative()
      if (gate || !ledger || !turn) return { code: 403, body: { error: gate ?? selfRecurringRefusal('told', null) } }
      const selfError = validateSelfAutomation(body, new Date())
      if (selfError) return { code: 400, body: { error: selfError } }
      const prepared = prepareCreate(agentId, body)
      if ('error' in prepared) return { code: prepared.code, body: { error: prepared.error } }
      const o = body as Record<string, unknown>
      const signal = typeof o.signal === 'string' && o.signal.trim() !== '' ? o.signal.trim() : undefined
      const id = randomUUID()
      const refusal = ledger.judgeAutomation(agentId, turn, { signal, title: prepared.input.name, ref: id })
      if (refusal) return { code: refusal.code, body: { error: refusal.error } }
      const missionLine = typeof o.missionLine === 'string' && o.missionLine.trim() !== '' ? o.missionLine.trim().slice(0, 200) : undefined
      try {
        const a = createAutomation(
          {
            ...selfShaped(prepared.input),
            origin: 'self',
            createdBy: agentId,
            createdIn: { run: runOfTurn(turn), session: turn.sessionId ?? '' },
            ...(signal ? { signal } : {}),
            ...(missionLine ? { missionLine } : {}),
          },
          id,
        )
        ledger.recordAutomation(agentId, a, turn)
        setImmediate(() => checkInbox())
        return { code: 201, body: { automation: a } }
      } catch (err) {
        return { code: 400, body: { error: err instanceof Error ? err.message : String(err) } }
      }
    }

    app.post<{ Body: unknown }>('/api/automations', async (req, reply) => {
      if (req.agentId !== undefined) {
        const r = bearerCreate(req.agentId, req.turn, req.body)
        if (r.code === 201 && r.body.automation) return reply.code(201).send({ automation: shownTo(req, r.body.automation as Automation) })
        return reply.code(r.code).send(r.body)
      }
      // the editor a proposal's «Review ›» opened: its create resolves the
      // proposal (S5-r4) — checked first (still pending, this agent's, its
      // input intact: S1-r4), resolved only once the create succeeded
      const fromProposal = (req.body as { proposal?: unknown } | null)?.proposal
      if (fromProposal !== undefined) {
        if (!proposals) return reply.code(400).send({ error: 'invalid proposal id' })
        const r = proposals.reviewable(fromProposal, 'automation', String((req.body as { agentId?: unknown }).agentId))
        if (!r.ok) return reply.code(r.code).send({ error: r.error })
      }
      const prepared = prepareCreate(req.agentId, req.body)
      if ('error' in prepared) return reply.code(prepared.code).send({ error: prepared.error })
      try {
        // the owner's create with a period is born with the budget its
        // period asks — one from a proposal's «Review ›»
        // keeps the default, as the accept would
        const automation = createAutomation(fromProposal === undefined ? withPeriodBudget(prepared.input, req.body) : prepared.input)
        const proposal = typeof fromProposal === 'string' ? (proposals?.resolveReviewed(fromProposal) ?? null) : null
        if (proposal) setImmediate(() => checkInbox())
        return reply.code(201).send({ automation: shownTo(req, automation), ...once(prepared.generatedSecret), ...(proposal ? { proposal } : {}) })
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    app.patch<{ Params: { id: string }; Body: unknown }>('/api/automations/:id', async (req, reply) => {
      const current = automations.get(req.params.id)
      if (!current) return reply.code(404).send({ error: 'automation not found' })
      // An agent edits only its OWN automations, and never the owner's gates
      // on them: whether a run waits for approval, the daily budget, which
      // agent it belongs to. A command automation (stored or asked for) is
      // the owner's to edit; the account is runsOnError's.
      if (req.agentId !== undefined) {
        if (!visibleTo(req, current)) return reply.code(404).send({ error: 'automation not found' })
        // its own heartbeat's period and model are the owner's:
        // naming either is a 403
        const beatNo = heartbeatBearerRefusal(current, req.body, registry.get(current.agentId)?.name ?? current.agentId)
        if (beatNo) return reply.code(403).send({ error: beatNo })
        // its OWN recurring work is an allow-list: only a
        // pause, registered in the ledger with its row in Decided (m7)
        if (current.origin === 'self') {
          const no = selfPatchRefusal(req.body)
          if (no) return reply.code(403).send({ error: no })
          if ((req.body as { paused?: unknown } | null)?.paused !== true || current.paused) return { automation: shownTo(req, current) }
          const updated = automations.update(current.id, { paused: true, autoPaused: undefined })
          resident.reconcileFileWatchers()
          if (req.turn) initiative()?.recordAct(req.agentId, current, 'paused', req.turn)
          setImmediate(() => checkInbox())
          return { automation: shownTo(req, updated) }
        }
        const b = (req.body ?? {}) as Record<string, unknown>
        const gate = (['approval', 'maxRunsPerDay', 'agentId'] as const).find((k) => b[k] !== undefined && b[k] !== current[k])
        if (gate !== undefined) return reply.code(403).send({ error: `only the owner changes an automation's ${gate}` })
        // Un-pausing is the owner's switch too: an agent may pause ITSELF,
        // but a pause set by the owner (or the platform's auto-pause, e.g.
        // the daily budget) must not be undone by the agent it restrains.
        if (b.paused === false && current.paused) return reply.code(403).send({ error: 'only the owner resumes a paused automation' })
        if (execsWithoutClaude(req.body) || execsWithoutClaude(current)) return reply.code(403).send({ error: ownerOnlyExec(req.agentId) })
        if (watchesOthers(req.agentId, req.body)) return reply.code(403).send({ error: watchesOthersError(req.agentId) })
      }
      // a heartbeat's shape is Silos': refused with the
      // door that works, never silently reverted by the next reconcile
      const beatRefusal = heartbeatPatchRefusal(current, req.body, registry.get(current.agentId)?.name ?? current.agentId)
      if (beatRefusal) return reply.code(409).send({ error: beatRefusal })
      try {
        const extras: ValidateExtras = {}
        const validated = validateAutomationPatch(req.body, registry, current, extras)
        // the owner's new period lifts the budget it needs
        const patch = req.agentId === undefined ? withPatchedPeriodBudget(validated, current, req.body) : validated
        // checked against the EFFECTIVE pair and agent: a new agent on another
        // engine can strand the saved account too
        if ('runsOn' in patch || patch.agentId !== undefined) {
          const bad = runsOnError(req.agentId, patch.agentId ?? current.agentId, 'runsOn' in patch ? patch.runsOn : current.runsOn, current.runsOn)
          if (bad) return reply.code(bad.code).send({ error: bad.error })
        }
        // A changed trigger invalidates the scheduled next run: clear nextRunAt
        // so the resident recomputes it from the NEW trigger on the next tick
        // (fireCronIfDue/fireOnceIfDue/fireWatchIfDue only compute it when it's
        // unset). Without this, an edited schedule keeps firing at the OLD time.
        const patch1 = patch.trigger !== undefined ? { ...patch, nextRunAt: undefined } : patch
        // an accepted proposal the OWNER reshapes (its trigger, prompt or
        // run) becomes the owner's own: origin and acceptedFrom go
        const reshaped =
          req.agentId === undefined && current.acceptedFrom !== undefined && (patch.trigger !== undefined || patch.prompt !== undefined || 'run' in patch)
        const patch2 = reshaped ? { ...patch1, origin: undefined, acceptedFrom: undefined, createdBy: undefined } : patch1
        // Setting `paused` by hand — in either direction — hands the switch
        // back to the user: the platform's auto-pause marker is dropped so
        // nothing resumes (or re-pauses) this automation behind their back.
        const updated = automations.update(req.params.id, patch2.paused !== undefined ? { ...patch2, autoPaused: undefined } : patch2)
        resident.reconcileFileWatchers() // if folder/glob/kind/paused changed, the watcher reopens with the new values
        return { automation: shownTo(req, updated), ...once(extras.generatedSecret) }
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    app.delete<{ Params: { id: string } }>('/api/automations/:id', async (req, reply) => {
      const doomed = automations.get(req.params.id)
      if (!doomed) return reply.code(404).send({ error: 'automation not found' })
      // a bearer withdraws only its OWN recurring work: to the trash,
      // registered as «X withdrew: <name>» — the owner's Restore › brings it back
      if (req.agentId !== undefined) {
        if (doomed.origin !== 'self' || doomed.agentId !== req.agentId) return reply.code(403).send({ error: DELETE_NOT_OWN })
        const ledger = initiative()
        if (!ledger || !req.turn) return reply.code(403).send({ error: DELETE_NOT_OWN })
        resident.cancelPendingApprovals(doomed.id)
        ledger.withdraw(doomed, req.turn)
        resident.reconcileFileWatchers()
        setImmediate(() => checkInbox())
        return { ok: true, withdrawn: doomed.id }
      }
      // a heartbeat comes back while its agent thinks (reconcile): its door
      // is the agent's rhythm, never a delete
      const beatRefusal = heartbeatDeleteRefusal(doomed, registry.get(doomed.agentId)?.name ?? doomed.agentId)
      if (beatRefusal) return reply.code(409).send({ error: beatRefusal })
      // Cancels any 'waiting_approval' run for this automation BEFORE
      // deleting it — otherwise it stayed hanging in
      // /api/automations/pending forever (Approve failed with a 404).
      resident.cancelPendingApprovals(req.params.id)
      automations.delete(req.params.id)
      resident.reconcileFileWatchers() // the deleted automation's watcher closes
      return { ok: true }
    })

    // Fire-and-forget, same contract as the webhook — an immediate 202,
    // the real result travels over WS (`ev: 'run'`/'automation'). A run
    // that CANNOT start (one already alive) answers an honest 409.
    app.post<{ Params: { id: string } }>('/api/automations/:id/run-now', async (req, reply) => {
      const res = await resident.runNowManual(req.params.id)
      if ('error' in res) return reply.code(res.code).send({ error: res.error })
      return reply.code(202).send(res)
    })

    app.post<{ Params: { id: string } }>('/api/automations/:id/pause', async (req, reply) => {
      const target = automations.get(req.params.id)
      if (!target) return reply.code(404).send({ error: 'automation not found' })
      // no Pause per agent (R2, G4-r7): a heartbeat stops by its rhythm
      if (isHeartbeat(target)) return reply.code(409).send({ error: heartbeatPauseRefusal(registry.get(target.agentId)?.name ?? target.agentId) })
      return { automation: resident.pause(req.params.id) }
    })

    app.post<{ Params: { id: string } }>('/api/automations/:id/resume', async (req, reply) => {
      if (!automations.get(req.params.id)) return reply.code(404).send({ error: 'automation not found' })
      return { automation: resident.resume(req.params.id) }
    })

    app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/automations/:id/runs', async (req, reply) => {
      const owned = automations.get(req.params.id)
      if (!owned || !visibleTo(req, owned)) return reply.code(404).send({ error: 'automation not found' })
      let limit: number | undefined
      if (req.query.limit !== undefined) {
        // A non-numeric/negative limit used to give
        // Array.prototype.slice(0, NaN) === [] silently (an empty 200)
        // instead of flagging a malformed query.
        limit = Number.parseInt(req.query.limit, 10)
        if (!Number.isFinite(limit) || limit < 0) return reply.code(400).send({ error: 'invalid limit' })
      }
      return { runs: automations.listRuns(req.params.id, limit) }
    })

    // A command run's log (<dataDir>/runs/<id>/<runId>.log, redacted when
    // written — command-run.ts). Owner only: a log is the output of an exec
    // the fence never saw (agent-authz.ts refuses the path too). 404 when
    // the run, or its log, does not exist.
    app.get<{ Params: { id: string; runId: string } }>('/api/automations/:id/runs/:runId/log', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read a command's log` })
      const { id, runId } = req.params
      if (!RUN_LOG_ID.test(id) || !RUN_LOG_ID.test(runId)) return reply.code(400).send({ error: 'invalid id' })
      if (!automations.automationIdsWithRuns().includes(id)) return reply.code(404).send({ error: 'automation not found' })
      if (!automations.listRuns(id).some((r) => r.id === runId)) return reply.code(404).send({ error: 'run not found' })
      const file = automations.runLogPath(id, runId)
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return reply.code(404).send({ error: 'this run left no log' })
      }
      return { log: text }
    })

    // Registration order doesn't matter in Fastify (it uses a route tree,
    // not a linear first-match), but 'pending' never collides with :id
    // because no automation has that id.
    app.get('/api/automations/pending', async (req) => ({
      pending: automations.pendingApprovals().filter((r) => {
        if (req.agentId === undefined) return true
        const a = automations.get(r.automationId)
        return a !== null && a.agentId === req.agentId
      }),
    }))

    // Same criterion — an immediate 202, fire-and-forget.
    app.post<{ Params: { id: string } }>('/api/automations/runs/:id/approve', async (req, reply) => {
      const res = resident.approveRun(req.params.id)
      if ('error' in res) return reply.code(404).send(res)
      return reply.code(202).send(res)
    })

    app.post<{ Params: { id: string } }>('/api/automations/runs/:id/skip', async (req, reply) => {
      const res = resident.skipRun(req.params.id)
      if ('error' in res) return reply.code(404).send(res)
      return res
    })

    // Automation templates.
    // Using one fills its blanks and goes through prepareCreate — the same
    // judge as POST /api/automations, so an agent uses one only for itself
    // and never one that execs. Import, export and delete are the owner's.
    const templates = ctx.templates
    if (templates) {
      const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
      const templateErr = (err: unknown): { error: string; field?: string } =>
        err instanceof TemplateError
          ? { error: err.message, ...(err.field ? { field: err.field } : {}) }
          : { error: err instanceof Error ? err.message : String(err) }
      const ownerOnlyTemplates = (req: FastifyRequest, what: string): string | null =>
        req.agentId !== undefined ? `agent ${req.agentId} may not ${what} — only the owner can` : null
      const filled = (
        req: FastifyRequest<{ Params: { tid: string }; Body: unknown }>,
      ): { code: number; body: Record<string, unknown> } | { input: Omit<Automation, 'id' | 'createdAt'>; generatedSecret?: string } => {
        const t = TEMPLATE_ID.test(req.params.tid) ? templates.get(req.params.tid) : null
        if (!t) return { code: 404, body: { error: 'template not found' } }
        const params = (req.body as { params?: unknown } | null)?.params
        let body: Record<string, unknown>
        try {
          body = fillTemplate(t, params, registry)
        } catch (err) {
          return { code: 400, body: templateErr(err) }
        }
        const prepared = prepareCreate(req.agentId, body)
        if ('error' in prepared) return { code: prepared.code, body: { error: prepared.error } }
        return prepared
      }

      app.get('/api/automations/templates', async () => ({ templates: templates.list() }))

      app.get<{ Params: { tid: string } }>('/api/automations/templates/:tid', async (req, reply) => {
        const t = TEMPLATE_ID.test(req.params.tid) ? templates.get(req.params.tid) : null
        if (!t) return reply.code(404).send({ error: 'template not found' })
        return { template: t }
      })

      // the file as it travels to another Silos: the template alone, no listing marks
      app.get<{ Params: { tid: string } }>('/api/automations/templates/:tid/file', async (req, reply) => {
        const t = TEMPLATE_ID.test(req.params.tid) ? templates.get(req.params.tid) : null
        if (!t) return reply.code(404).send({ error: 'template not found' })
        const { source: _s, ownerOnly: _o, ...file } = t
        reply.header('content-disposition', `attachment; filename="${t.id}.silos-template.json"`)
        return reply.type('application/json').send(JSON.stringify(file, null, 2))
      })

      // what Create would make, validated, without making it
      app.post<{ Params: { tid: string }; Body: unknown }>('/api/automations/templates/:tid/preview', async (req, reply) => {
        const r = filled(req)
        if ('code' in r) return reply.code(r.code).send(r.body)
        // a secret generated for the preview is not the one Create makes
        if (r.generatedSecret && r.input.trigger.kind === 'webhook') {
          const { secret: _secret, ...trigger } = r.input.trigger
          return { automation: { ...r.input, trigger } }
        }
        return { automation: r.input }
      })

      app.post<{ Params: { tid: string }; Body: unknown }>('/api/automations/templates/:tid/use', async (req, reply) => {
        // a bearer's use is its create: the same gate and judge
        if (req.agentId !== undefined) {
          const gate = bearerGate(req.agentId, req.turn)
          if (gate) return reply.code(403).send({ error: gate })
          const t = TEMPLATE_ID.test(req.params.tid) ? templates.get(req.params.tid) : null
          if (!t) return reply.code(404).send({ error: 'template not found' })
          const extra = (req.body ?? {}) as { params?: unknown; signal?: unknown; missionLine?: unknown }
          let body: Record<string, unknown>
          try {
            body = fillTemplate(t, extra.params, registry)
          } catch (err) {
            return reply.code(400).send(templateErr(err))
          }
          const out = bearerCreate(req.agentId, req.turn, {
            ...body,
            ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
            ...(extra.missionLine !== undefined ? { missionLine: extra.missionLine } : {}),
          })
          if (out.code === 201 && out.body.automation) return reply.code(201).send({ automation: shownTo(req, out.body.automation as Automation) })
          return reply.code(out.code).send(out.body)
        }
        const r = filled(req)
        if ('code' in r) return reply.code(r.code).send(r.body)
        try {
          return reply.code(201).send({ automation: shownTo(req, createAutomation(withPeriodBudget(r.input, r.input))), ...once(r.generatedSecret) })
        } catch (err) {
          return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
        }
      })

      // import: { template, replace? }
      app.post<{ Body: unknown }>('/api/automations/templates', async (req, reply) => {
        const no = ownerOnlyTemplates(req, 'import a template')
        if (no) return reply.code(403).send({ error: no })
        const b = (req.body ?? {}) as { template?: unknown; replace?: unknown }
        try {
          return reply.code(201).send({ template: templates.save(b.template, { replace: b.replace === true }) })
        } catch (err) {
          const e = templateErr(err)
          return reply.code(/already exists|comes with Silos/.test(e.error) ? 409 : 400).send(e)
        }
      })

      app.delete<{ Params: { tid: string } }>('/api/automations/templates/:tid', async (req, reply) => {
        const no = ownerOnlyTemplates(req, 'delete a template')
        if (no) return reply.code(403).send({ error: no })
        const r = templates.remove(req.params.tid)
        if (r === 'builtin') return reply.code(409).send({ error: 'this template comes with Silos — it cannot be deleted' })
        if (r === 'not-found') return reply.code(404).send({ error: 'template not found' })
        return { removed: req.params.tid }
      })

      // export: «Save as template» — { name?, description?, replace? }
      app.post<{ Params: { id: string }; Body: unknown }>('/api/automations/:id/template', async (req, reply) => {
        const no = ownerOnlyTemplates(req, 'save an automation as a template')
        if (no) return reply.code(403).send({ error: no })
        const a = automations.get(req.params.id)
        if (!a) return reply.code(404).send({ error: 'automation not found' })
        const b = (req.body ?? {}) as { name?: unknown; description?: unknown }
        const name = typeof b.name === 'string' && b.name.trim() !== '' ? b.name.trim().slice(0, 200) : a.name
        const id = templateIdFrom(name, (x) => templates.get(x) !== null)
        try {
          const t = fromAutomation(
            a,
            { id, name, ...(typeof b.description === 'string' ? { description: b.description.slice(0, 500) } : {}) },
            ctx.secrets?.() ?? [],
          )
          return reply.code(201).send({ template: templates.save(t) })
        } catch (err) {
          return reply.code(400).send(templateErr(err))
        }
      })
    }

    // WITHOUT the global token — the header secret IS the auth (see the
    // whitelist in the onRequest hook above). 401 if missing/incorrect,
    // 202 if it fires the run (the run itself is async — fire-and-forget).
    app.post<{ Params: { id: string }; Body: unknown }>('/api/hooks/:id', async (req, reply) => {
      const secret = req.headers['x-hook-secret']
      if (typeof secret !== 'string' || secret === '') return reply.code(401).send({ error: 'secret required' })
      const result = resident.fireWebhook(req.params.id, secret, req.body)
      if ('error' in result) return reply.code(result.code).send({ error: result.error })
      return reply.code(202).send({ ok: true })
    })
  }
  return createApi!
}
