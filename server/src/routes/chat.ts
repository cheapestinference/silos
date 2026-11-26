// routes/chat.ts — the SDK chat lane: the auto-resume helpers (one
// interactive turn + the durable pending-resume record), the
// pending-resumes routes, POST /api/chat (the chat turn itself), its
// cancel/alive, the model catalog routes, output styles, the
// conversation prefs (both prefixes) and PATCH /api/seen, moved VERBATIM
// out of server.ts (the monoliths split by domain, behavior unchanged).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fallbackHarness, harnessById, harnessForId, harnessIds, harnessOf, isHarnessId, quotedIds } from '../harnesses/registry.js'
import { outputStyleError, outputStylesFor } from '../harnesses/validate.js'
import { providerHarnessError, providerIdError } from '../providers-validate.js'
import { validateOverrides, validateTurnOverrides, type CockpitOverrides } from '../cockpit.js'
import { consoleBusyFor, handOverConsoleForChat } from '../console-handover.js'
import { mungePath } from '../agent-registry.js'
import { PARAM, PURE_DOTS } from '../segments.js'
import type { SessionIndex } from '../session-index.js'
import type { SessionStore } from '../session-store.js'
import type { SessionOwners } from '../session-owner.js'
import type { SessionOriginsStore } from '../session-origins.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { NativeStore } from '../native-store.js'
import type { ChatService } from '../chat-service.js'
import type { TerminalService } from '../terminal-service.js'
import type { PrefsStore } from '../prefs-store.js'
import type { SeenStore } from '../seen-store.js'
import type { ConversationPrefsStore } from '../conversation-prefs.js'
import type { ModelCatalog } from '../model-catalog.js'
import type { ProvidersStore } from '../providers-store.js'
import type { PendingResumesStore, PendingResume } from '../pending-resumes-store.js'
import type { GatewayModelsRefresher } from '../gateway-models.js'
import type { AgentStateStore } from '../agent-state.js'
import type { HarnessId, HarnessServerHooks } from '../harnesses/contract.js'
import type { SessionMeta } from '../types.js'

type SessionParams = { folder: string; id: string }

export interface ChatRoutesCtx {
  index: SessionIndex
  store: SessionStore
  registry: AgentRegistry
  native: NativeStore
  chat: ChatService
  terminals: TerminalService
  prefs: PrefsStore
  seen: SeenStore | undefined
  convPrefs: ConversationPrefsStore | undefined
  catalog: ModelCatalog | undefined
  providers: ProvidersStore | undefined
  pendingResumes: PendingResumesStore | undefined
  origins: SessionOriginsStore | undefined
  gatewayModels: GatewayModelsRefresher | undefined
  agentState: AgentStateStore | undefined
  hooks: (id: HarnessId) => HarnessServerHooks
  transcriptOnly: (meta: SessionMeta) => Record<string, unknown> | null
  validParams: (p: SessionParams, reply: FastifyReply) => boolean
  freshConsoles: Map<string, string>
  classifyAgentId: (m: SessionMeta) => string
  consoleKeyFor: (m: SessionMeta) => Promise<string>
  owners: SessionOwners
  broadcast: (msg: unknown) => void
}

export function chatRoutes(app: FastifyInstance, ctx: ChatRoutesCtx): void {
  const {
    index,
    store,
    registry,
    native,
    chat,
    terminals,
    seen,
    convPrefs,
    catalog,
    providers,
    pendingResumes,
    hooks,
    transcriptOnly,
    validParams,
    classifyAgentId,
    consoleKeyFor,
  } = ctx
  const broadcast = (m: unknown): void => ctx.broadcast(m)
  // Auto-resume: runs ONE interactive turn (new or resume), broadcasts its
  // events over WS, and returns what's needed to decide the resume:
  // whether it hit the limit, the resetsAt, whether it finished
  // successfully, and the session (folder/id) to go back to — comes from
  // chat-init (a resume re-emits it with the same id; a new session has no
  // id until that event).
  const runInteractiveTurn = async (
    turnId: string,
    agentId: string,
    text: string,
    resume: { sessionId: string; mode: 'append' | 'fork' } | undefined,
    cwd: string | undefined,
    overrides: CockpitOverrides | undefined,
    title?: string,
  ): Promise<{ rejected: boolean; resetsAt?: string; ok: boolean; sessionId?: string; folder?: string }> => {
    let rejected = false
    let resetsAt: string | undefined
    let ok = false
    let sessionId = resume?.sessionId
    let folder: string | undefined
    try {
      // a session with a live console (an engine with traits.handover): the
      // console hands the session over to the chat engine first (console-handover.ts)
      if (resume) await handOverConsoleForChat(terminals, resume.sessionId)
      for await (const ev of chat.send({ turnId, agentId, text, resume, cwd, ...(overrides !== undefined ? { overrides } : {}) })) {
        // Naming at birth: the owner typed a title BEFORE the session had an
        // id — chat-init is the moment the id exists, so the title lands
        // right here through the same manual-rename path (manual > auto >
        // raw: the titler will never touch it). Applied BEFORE broadcasting
        // chat-init so any refetch the event triggers already sees it.
        if (ev.ev === 'chat-init' && title !== undefined && resume === undefined) {
          store.rename(ev.folder, ev.sessionId, title)
          index
            .refresh(ev.folder, ev.sessionId) // re-emits meta → WS (same contract as the rename route)
            .catch(() => {}) // the JSONL may not be on disk yet; the fs watcher reconciles
        }
        broadcast(ev)
        if (ev.ev === 'chat-init') {
          sessionId = ev.sessionId
          folder = ev.folder
        } else if (ev.ev === 'chat-ratelimit' && ev.status === 'rejected') {
          rejected = true
          resetsAt = ev.resetsAt
        } else if (ev.ev === 'chat-done') ok = ev.subtype === 'success'
      }
    } catch (err) {
      // the harness lock's raw words, mapped to the same courteous sentence
      // the route says up front (a race can still reach the lock)
      const raw = err instanceof Error ? err.message : String(err)
      const said = raw.includes('a turn is already in progress')
        ? 'Silos is working this conversation right now — it finishes on its own. Resend in a moment.'
        : raw
      broadcast({ ev: 'chat-error', turnId, error: said })
    }
    return {
      rejected,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ok,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(folder !== undefined ? { folder } : {}),
    }
  }

  // Auto-resume: arms the durable record for a rate-limited interactive
  // turn that has to WAIT for the reset (the fallback path continues
  // inline above, it never reaches here). resumeAt = the real reset; the
  // resident resends it once it's due. The turnCount/mtime snapshot lets
  // the resident detect the owner resent by hand (the double-send guard).
  const armPendingResume = (agentId: string, folder: string, sessionId: string, text: string, cwd: string | undefined, resetsAt: string | undefined): void => {
    if (!pendingResumes) return
    const now = new Date()
    const effReset = resetsAt ?? new Date(now.getTime() + 3600_000).toISOString()
    const meta = index.getMeta(folder, sessionId)
    const rec: PendingResume = {
      agentId,
      folder,
      sessionId,
      text,
      ...(cwd !== undefined ? { cwd } : {}),
      resetsAt: effReset,
      resumeAt: effReset,
      createdAt: now.toISOString(),
      attempts: 0,
      ...(meta ? { turnCount: meta.turnCount, mtime: meta.mtime } : {}),
    }
    pendingResumes.upsert(rec)
    broadcast({ ev: 'pending-resume', pending: rec })
  }

  if (pendingResumes) {
    // Hydrates state when the UI loads (durable: survives restarts) — the
    // banner needs to know, after a refresh, which conversations have a
    // resume scheduled.
    app.get('/api/pending-resumes', async () => ({ pending: pendingResumes.list() }))

    // Cancel (the banner's "Cancel"): removes the record and notifies over
    // WS so the banner stops promising the resume instantly. 404 if there
    // wasn't one (we don't announce a deletion that didn't happen).
    app.delete<{ Params: SessionParams }>('/api/pending-resumes/:folder/:id', async (req, reply) => {
      if (!validParams(req.params, reply)) return
      const removed = pendingResumes.remove(req.params.folder, req.params.id)
      if (!removed) return reply.code(404).send({ error: 'no resume scheduled for that conversation' })
      broadcast({ ev: 'pending-resume-removed', folder: req.params.folder, id: req.params.id })
      return { ok: true }
    })
  }

  app.post<{ Params: { id: string }; Body: { text?: string; cwd?: string; session?: { folder?: string; id?: string }; overrides?: unknown; title?: string } }>(
    '/api/agents/:id/chat',
    async (req, reply) => {
      const agent = registry.get(req.params.id)
      if (!agent || agent.archived) return reply.code(400).send({ error: 'agent not available for chat' })
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
      if (text === '') return reply.code(400).send({ error: 'text required' })

      // Naming at birth: an optional title for a NEW conversation, applied
      // as the manual rename when chat-init names the session (see
      // runInteractiveTurn). Blank → absent; renaming an existing session
      // has its own endpoint, so a title on a resume is an honest 400.
      const title = typeof req.body?.title === 'string' && req.body.title.trim() !== '' ? req.body.title.trim().slice(0, 120) : undefined

      // Cabin: TURN-LEVEL overrides (one-shot) — strict validation (unknown
      // values → 400, they never pass through to the SDK raw).
      let overrides: CockpitOverrides | undefined
      if (req.body?.overrides !== undefined) {
        try {
          overrides = validateTurnOverrides(req.body.overrides)
        } catch (err) {
          return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
        }
        // a turn's provider must suit the agent's harness (an unknown id
        // stays tolerated, as it always was: the runtime falls back)
        const turnProvider = overrides.provider !== undefined ? providers?.resolve(overrides.provider) : null
        const harnessErr = turnProvider ? providerHarnessError(turnProvider, harnessOf(agent)) : null
        if (harnessErr) return reply.code(400).send({ error: harnessErr })
        // a turn's style: one the agent's engine offers for its folder
        const styleErr =
          overrides.outputStyle !== undefined
            ? outputStyleError(harnessOf(agent), overrides.outputStyle, agent.folder ?? (typeof req.body?.cwd === 'string' ? req.body.cwd : null))
            : null
        if (styleErr) return reply.code(400).send({ error: styleErr })
      }

      const isMaster = agent.folder === null
      const hasCwd = req.body?.cwd !== undefined
      if (!isMaster && hasCwd) return reply.code(400).send({ error: 'cwd only allowed for master' })

      let resume: { sessionId: string; mode: 'append' | 'fork' } | undefined
      let effectiveCwd: string | undefined
      const s = req.body?.session
      if (s?.folder !== undefined || s?.id !== undefined) {
        if (
          typeof s?.folder !== 'string' ||
          typeof s?.id !== 'string' ||
          !PARAM.test(s.folder) ||
          !PARAM.test(s.id) ||
          PURE_DOTS.test(s.folder) ||
          PURE_DOTS.test(s.id)
        ) {
          return reply.code(400).send({ error: 'invalid params' })
        }
        const meta = index.getMeta(s.folder, s.id)
        if (!meta) return reply.code(404).send({ error: 'session not found' })
        // the console route's rule, on the chat engine too (transcriptOnly)
        const refused = transcriptOnly(meta)
        if (refused) return reply.code(409).send(refused)
        if (isMaster) {
          // Master has no folder of its own to compare against: the resume
          // is legitimate if the session classifies to master (same
          // criterion as view(), native-owner override included) — not if
          // it "belongs" to another real agent.
          if (classifyAgentId(meta) !== agent.id) {
            return reply.code(400).send({ error: "the session does not belong to this agent's folder" })
          }
          effectiveCwd = meta.cwd ?? undefined // continuing from master uses THE SESSION's cwd, not the body's
        } else {
          if (meta.folder !== mungePath(agent.folder as string)) {
            return reply.code(400).send({ error: "the session does not belong to this agent's folder" })
          }
        }
        resume = { sessionId: s.id, mode: native.isNative(s.folder, s.id) ? 'append' : 'fork' }
        // its live console is mid-turn: handing over would kill that work
        // (meta.mtime = the transcript's last movement — see consoleBusyFor's
        // staleness rule for a turn left open by a dead claude)
        if (await consoleBusyFor(terminals, s.id, meta.turnOpen, meta.mtime)) {
          return reply.code(409).send({ error: 'The console is still working on this conversation — let it finish (or stop it there), then send from chat.' })
        }
        // a turn of Silos' own is on it (a task wake, a message turn, another
        // chat tab) — said courteously BEFORE the console handover and before
        // the harness lock throws its raw error (never a silent
        // «Send does nothing»)
        const live = chat.liveOn(s.id)
        if (live) {
          return reply
            .code(409)
            .send({
              error: live.unattended
                ? 'Silos is working this conversation right now (a task turn) — it finishes on its own. Resend in a moment, or leave your note on its task.'
                : 'A turn is already running in this conversation — wait for it to finish.',
            })
        }
      }

      if (title !== undefined && resume !== undefined) {
        return reply.code(400).send({ error: 'title only allowed for a new conversation' })
      }

      if (isMaster && !resume) {
        const bodyCwd = typeof req.body?.cwd === 'string' ? req.body.cwd : undefined
        if (bodyCwd === undefined) return reply.code(400).send({ error: 'cwd required for master' })
        if (!isAbsolute(bodyCwd)) return reply.code(400).send({ error: 'invalid cwd' })
        try {
          const st = await stat(bodyCwd)
          if (!st.isDirectory()) return reply.code(400).send({ error: 'invalid cwd' })
        } catch {
          return reply.code(400).send({ error: 'invalid cwd' }) // ENOENT or another stat failure → same 400, never 500
        }
        effectiveCwd = bodyCwd
      }

      const turnId = randomUUID()
      const agentId = req.params.id
      void (async () => {
        const primary = await runInteractiveTurn(turnId, agentId, text, resume, effectiveCwd, overrides, title)
        // Auto-resume: only when the turn was REJECTED for a limit, it
        // didn't finish successfully, and we know which session to go
        // back to (folder+id from chat-init). With no known session (a
        // new chat rejected before init) NOTHING is promised — the banner
        // can't assert an impossible resume.
        if (!pendingResumes || !primary.rejected || primary.ok || primary.sessionId === undefined || primary.folder === undefined) return
        const cwd = isMaster ? effectiveCwd : undefined
        // Was a FALLBACK left armed by this rate limit
        // (ChatService.noteRateLimit, a turn boundary)? Then we continue
        // RIGHT HERE through the fallback — a new (append) turn that goes
        // out through the fallback provider. If it succeeds, the
        // conversation already continued there: NO resume is armed (the
        // banner would tell the wrong truth). If the fallback ALSO gets
        // limited, we fall back to waiting for the reset as without a fallback.
        const fb = chat.fallbackStateOf(agentId)
        if (fb) {
          const second = await runInteractiveTurn(randomUUID(), agentId, text, { sessionId: primary.sessionId, mode: 'append' }, cwd, overrides)
          if (second.ok && !second.rejected) return // continued on the fallback — no resume pending
          armPendingResume(agentId, primary.folder, primary.sessionId, text, cwd, second.resetsAt ?? primary.resetsAt)
          return
        }
        armPendingResume(agentId, primary.folder, primary.sessionId, text, cwd, primary.resetsAt)
      })().catch((err) => {
        // Fire-and-forget: runInteractiveTurn guards chat.send() internally,
        // but the auto-resume arming that runs AFTER it (armPendingResume →
        // pendingResumes.upsert → writeFileSync/renameSync) can throw on a
        // full/read-only disk (a real container-volume scenario). Without
        // this .catch the rejection is unhandled and Node 22 kills the whole
        // process — every live console and in-flight turn with it. Same rule
        // resident.ts already enforces on its tick loop.
        console.error('[chat turn-completion]', err instanceof Error ? err.message : err)
      })
      return reply.code(202).send({ turnId })
    },
  )

  app.post<{ Params: { turnId: string } }>('/api/chat/:turnId/cancel', async (req) => ({ ok: await chat.cancel(req.params.turnId) }))

  // WS resilience: the front consults this on reconnect to know whether a
  // turn left "streaming" in its store is still genuinely alive on the
  // server, or whether chat-done was missed while the WS was down.
  app.get<{ Params: { turnId: string } }>('/api/chat/:turnId/alive', async (req) => ({ alive: chat.isInflight(req.params.turnId) }))

  // ---- cabin: model catalog + per-conversation prefs ---------------

  // An honest catalog: whatever the SDK returned, never a hardcoded list.
  // With no catalog injected (or not refreshed yet) the response is an
  // honest empty one — the UI decides its own fallback (models seen in the
  // corpus + the agent's default + "Custom…").
  //
  // Per harness: `?harness=<id>` is that harness's own list,
  // optionally narrowed by the harness (Harness.server narrowModels — for
  // OpenCode, to the providers one agent or one provider can reach).
  const catalogHarness = (q: unknown): HarnessId | null => {
    const h = (q as { harness?: unknown } | undefined)?.harness
    if (h === undefined || h === '') return fallbackHarness().id
    return isHarnessId(h) ? h : null
  }
  app.get<{ Querystring: { harness?: string; agentId?: string; provider?: string } }>('/api/models', async (req, reply) => {
    const harness = catalogHarness(req.query)
    if (harness === null) return reply.code(400).send({ error: `harness must be ${quotedIds(harnessIds())}` })
    const view = catalog?.viewFor(harness) ?? { models: [], fetchedAt: null }
    const narrow = hooks(harness).narrowModels
    if (!narrow) return view
    const { agentId, provider } = req.query
    const r = narrow(view, { ...(agentId !== undefined ? { agentId } : {}), ...(provider !== undefined ? { provider } : {}) })
    if ('code' in r) return reply.code(r.code).send(r.body)
    return r
  })

  // Manual refresh — the only path that spawns the CLI after boot (see the
  // policy in model-catalog.ts); `?harness=opencode` runs `opencode models`
  // (Settings asks for it when it opens). 502 if the source doesn't respond.
  app.post<{ Querystring: { harness?: string } }>('/api/models/refresh', async (req, reply) => {
    if (!catalog) return reply.code(400).send({ error: 'model catalog not configured' })
    const harness = catalogHarness(req.query)
    if (harness === null) return reply.code(400).send({ error: `harness must be ${quotedIds(harnessIds())}` })
    // a harness that declares no model list has nothing to refresh — the
    // caller's mistake, not a source that failed to answer
    const declared = harnessById(harness)
    if (!declared.models) return reply.code(400).send({ error: `${declared.label} has no model list to refresh` })
    try {
      return await catalog.refresh(harness)
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // A conversation's working folder for what depends on it (a project's
  // own output styles): the indexed session's cwd, else the folder of the
  // agent whose munged folder it is (a new conversation not indexed yet),
  // else none.
  const conversationCwd = (folder: string, id: string): string | null =>
    index.getMeta(folder, id)?.cwd ?? registry.list().find((a) => a.folder !== null && mungePath(a.folder) === folder)?.folder ?? null

  // The output styles an agent's engine offers (the cockpit's outputStyle
  // field): built-ins + the operator's and the folder's own style files,
  // read-only. `?folder=&session=` reads a conversation's cwd (a project's
  // styles); otherwise the agent's folder. 400 for an engine with none.
  app.get<{ Params: { id: string }; Querystring: { folder?: string; session?: string } }>('/api/agents/:id/output-styles', async (req, reply) => {
    const agent = registry.get(req.params.id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    const { folder, session } = req.query
    const known =
      typeof folder === 'string' &&
      typeof session === 'string' &&
      PARAM.test(folder) &&
      PARAM.test(session) &&
      !PURE_DOTS.test(folder) &&
      !PURE_DOTS.test(session)
    const cwd = (known ? index.getMeta(folder, session)?.cwd : null) ?? agent.folder
    const styles = outputStylesFor(harnessOf(agent), cwd)
    if (styles === null) return reply.code(400).send({ error: `${harnessById(harnessOf(agent)).label} has no output styles` })
    return { styles }
  })

  if (convPrefs) {
    // Per-conversation prefs under /api/sessions/:f/:id/prefs — one namespace
    // with the rest of the conversation routes (detail, rename, trash,
    // answer), which key on Claude Code's session id.

    // GET is always 200 with {} if nothing was ever set (same criterion as
    // /api/prefs) — the session isn't required to exist: a NEW conversation
    // (its first turn still in flight) isn't in the index yet and the UI asks.
    const getConvPrefs = async (req: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply): Promise<unknown> => {
      if (!validParams(req.params, reply)) return
      return { prefs: convPrefs.get(req.params.folder, req.params.id) ?? {} }
    }
    app.get<{ Params: SessionParams }>('/api/sessions/:folder/:id/prefs', getConvPrefs)

    const patchConvPrefs = async (req: FastifyRequest<{ Params: SessionParams; Body: unknown }>, reply: FastifyReply): Promise<unknown> => {
      if (!validParams(req.params, reply)) return
      let patch: Record<string, unknown>
      try {
        // allowNull: null on a field DELETES that override (falls back to
        // the agent's default) — see ConversationPrefsStore.patch.
        patch = validateOverrides(req.body, { allowNull: true })
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
      // a provider pin must name an account or key that exists NOW (the
      // runtime tolerates one that disappears later, with a warning) and
      // suit the conversation's harness — its id says which (harnessForId)
      if (typeof patch.provider === 'string') {
        const err = providers ? providerIdError(patch.provider, harnessForId(req.params.id), providers) : `unknown provider: ${patch.provider}`
        if (err) return reply.code(400).send({ error: err })
      }
      // a style pin must be one the conversation's engine offers for its
      // folder — an engine without styles (OpenCode) never takes one
      if (typeof patch.outputStyle === 'string') {
        const err = outputStyleError(harnessForId(req.params.id), patch.outputStyle, conversationCwd(req.params.folder, req.params.id))
        if (err) return reply.code(400).send({ error: err })
      }
      // The PATCH no longer prunes anything — pruning orphans lives in the
      // resident's heartbeat slow sweep (index.ts → prefsSweep), with a
      // grace window for freshly written keys (a new session not yet
      // indexed by the watcher is indistinguishable from a ghost one).
      const prefs = convPrefs.patch(req.params.folder, req.params.id, patch)
      // A model (or account) pick on a conversation with a LIVE console must
      // reach that console — on both engines: a change only in the column,
      // not in the console, is not enough; restarting the console is fine as
      // long as the change takes effect.
      // Each harness says how (Harness.server pushPin — OpenCode settles
      // the TUI's own selection on screen or asks for a restart; Claude
      // types `/model <id>` into its pane); one without a way leaves a
      // live console's pick for the next launch ('next-turn').
      //  The answer is absent when the pick touches no console at all (a
      //  Claude conversation with no live console: the pin simply waits).
      let applied: 'live' | 'restart' | 'next-turn' | null = null
      if (('model' in patch || 'provider' in patch || 'outputStyle' in patch) && terminals) {
        const pushPin = hooks(harnessForId(req.params.id)).pushPin
        // the live console of the THREAD, not of this one session id: after
        // a console's /clear the web holds the rotated id, which tmux never
        // ran under — the console lives under an ancestor's key
        // (consoleKeyFor walks the ancestry against tmux's own listing)
        let key: string | null = terminals.keyOfNativeId(req.params.id)
        if (key === null) {
          const meta = index.getMeta(req.params.folder, req.params.id)
          const candidate = meta ? await consoleKeyFor(meta) : req.params.id
          key = (await terminals.hasConsole(candidate)) ? candidate : null
        }
        applied = pushPin ? await pushPin(req.params.id, key, patch, prefs) : key ? 'next-turn' : null
      }
      // `applied` only when a console was touched (its engine's pushPin, or 'next-turn' for a live console
      // of an engine without one) — a conversation with no live console simply takes its pin on the next turn
      return { prefs, ...(applied !== null ? { applied } : {}) }
    }
    app.patch<{ Params: SessionParams; Body: unknown }>('/api/sessions/:folder/:id/prefs', patchConvPrefs)
  }

  // Durable unread state: mark a conversation seen RIGHT NOW — the UI
  // calls this when opening the conversation (fire-and-forget), and
  // `unread` stops coming back true on the next /api/overview (mtime <=
  // lastSeen). Token-guarded by the global onRequest hook like all of
  // /api/*. folder/id go in the body (not the route) — same sanitizing as
  // validParams: no '..' or dots-only segments.
  if (seen) {
    app.patch<{ Body: { folder?: unknown; id?: unknown } }>('/api/seen', async (req, reply) => {
      const folder = req.body?.folder
      const id = req.body?.id
      if (typeof folder !== 'string' || typeof id !== 'string' || !PARAM.test(folder) || !PARAM.test(id) || PURE_DOTS.test(folder) || PURE_DOTS.test(id)) {
        return reply.code(400).send({ error: 'invalid folder/id' })
      }
      // The session isn't required to exist in the index: a freshly
      // created conversation (its first turn still in flight) might not
      // be indexed by the watcher yet, and marking it seen is legitimate
      // (the sweep's grace period protects its key until it shows up).
      // Same criterion as convPrefs' GET.
      const at = seen.markSeen(folder, id)
      return { ok: true, seen: at }
    })
  }
}
