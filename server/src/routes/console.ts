// routes/console.ts — the real console and the engines' own surface:
// /api/harnesses + /api/harness(+update), POST /api/console (open or
// reattach the tmux claude), the console scrollbar/send/kill, the
// escalation window and the task-mode routes («Work on this» included),
// moved VERBATIM out of server.ts (split the monoliths
// by domain, behavior unchanged).
import { initiativeNow } from '../initiative.js'
import type { LiveTurn } from '../live-turns.js'
import { basename } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { HarnessBusyError, HarnessUpdateError, type HarnessService } from '../harness.js'
import { describeHarnesses } from '../harness-descriptor.js'
import { genericOpenNew, genericOpenSession } from '../console-open.js'
import { fallbackHarness, harnessById, harnessForId, harnessOf, quotedIds } from '../harnesses/registry.js'
import { consoleOwners, openFactsOf } from '../open-surface.js'
import type { ConsoleOpenInput, HarnessId, HarnessServerHooks, ServerHookContext } from '../harnesses/contract.js'
import { outsideWords, snapStateRead, TASK_MODE_SILO, type TaskModeEngine } from '../task-mode/engine.js'
import type { TaskSnap } from '../task-mode/evaluate.js'
import { makeTaskFeed } from '../task-mode/feed.js'
import { taskThreads, threadMembership, type TaskThreads } from '../task-threads.js'
import { continuableOf, recentTipOf } from '../thread-tools.js'
import { authorOf, UNKNOWN_AUTHOR } from '../author.js'
import { SILOS_AUTHOR } from '../system-author.js'
import type { NativeStore } from '../native-store.js'
import { othersOnTask, type ClaimOther } from '../task-claim.js'
import { claimBriefing } from '../task-mode/briefing.js'
import { mainCheckoutOf } from '../execution-plan-join.js'
import { wakesOfControl, withWakes } from '../conversation-live.js'
import { TASK_VERBS, type ReleaseWait, type TaskGestureArgs, type TaskVerb } from '../silos/actions.js'
import { SILOS_WAIT_PREFIX } from '../silos/task-flow.js'
import { ASK_ACTION_MAX, ASK_ASKED_MAX } from '../limits.js'
import { providerIdError } from '../providers-validate.js'
import { outputStyleError } from '../harnesses/validate.js'
import { MASTER_ID, mungePath, type AgentRegistry } from '../agent-registry.js'
import { knows, mayName, ofProject, reaches, seesAll } from '../project-scope.js'
import type { Agent, SessionMeta } from '../types.js'
import { ConsoleHeldError, ConsoleUnknownError } from '../terminal-service.js'
import { ConsoleDialogError } from '../console-dialog.js'
import { validWindowHours } from '../escalation/store.js'
import { MAX_WINDOW_HOURS, MIN_WINDOW_HOURS } from '../escalation/evaluate.js'
import { PLANS_SILO } from '../plans-floor.js'
import { standingIdsOf } from '../silos/manifest.js'
import type { SessionIndex } from '../session-index.js'
import type { SessionStore } from '../session-store.js'
import type { TerminalService } from '../terminal-service.js'
import type { ChatService } from '../chat-service.js'
import type { ConversationPrefsStore } from '../conversation-prefs.js'
import type { ProvidersStore } from '../providers-store.js'
import type { AgentStateStore } from '../agent-state.js'
import type { PrefsStore } from '../prefs-store.js'
import type { LineageStore } from '../lineage.js'
import type { SiloRegistry } from '../silos/registry.js'
import type { SiloActions } from '../silos/actions.js'
import type { EscalationEngine } from '../escalation/engine.js'
import { OWNER_ANSWERS_WORDS, OWNER_ASKS_WORDS, type TaskAsks } from '../task-asks.js'

// a text cut to n characters (an ask's bound, H5) — what is written is what was kept
const clipText = (s: string, n: number): string => (Array.from(s).length > n ? Array.from(s).slice(0, n).join('').trimEnd() : s)

// a conversation id a claim may name: a Claude Code uuid or an OpenCode
// `ses_…` — never a path (plans-floor.ts' rule)
const CLAIM_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

export interface ConsoleRoutesCtx {
  harness: HarnessService | undefined
  terminals: TerminalService
  chat: ChatService
  escalation: EscalationEngine | undefined
  taskMode: TaskModeEngine | undefined
  // (B2) agent ↔ agent asks — absent: no /api/tasks/ask routes
  taskAsks?: TaskAsks
  // re-read the plans silo now (a claim on a task written a moment ago,
  // before the file watch's window re-read it)
  refreshPlans?: () => void
  // (m4) the task threads' short cache (index.ts threadsOfTasks)
  // is dropped in the same request a claim, a release or a link writes
  invalidateTaskThreads?: () => void
  registry: AgentRegistry
  index: SessionIndex
  store: SessionStore
  convPrefs: ConversationPrefsStore | undefined
  providers: ProvidersStore | undefined
  agentState: AgentStateStore | undefined
  prefs: PrefsStore
  lineage: LineageStore | undefined
  siloRegistry: SiloRegistry | undefined
  siloActions: SiloActions | undefined
  // the third source of a known conversation (a claim's session): Silos'
  // record of the sessions it launched
  native?: Pick<NativeStore, 'get'>
  freshConsoles: Map<string, string>
  consoleKeyFor: (m: SessionMeta) => Promise<string>
  transcriptOnly: (meta: SessionMeta) => Record<string, unknown> | null
  absorbRotations: () => void
  threadRootKey: (m: SessionMeta) => string
  classifyAgentId: (m: SessionMeta) => string
  hooks: (id: HarnessId) => HarnessServerHooks
  hookContext: (id: HarnessId) => ServerHookContext
  broadcast: (msg: unknown) => void
}

export function consoleRoutes(app: FastifyInstance, ctx: ConsoleRoutesCtx): void {
  const {
    harness,
    terminals,
    chat,
    escalation,
    taskMode,
    refreshPlans,
    invalidateTaskThreads,
    registry,
    index,
    convPrefs,
    providers,
    lineage,
    siloRegistry,
    siloActions,
    native,
    consoleKeyFor,
    transcriptOnly,
    absorbRotations,
    threadRootKey,
    classifyAgentId,
    hooks,
    hookContext,
  } = ctx
  const taskFeed = makeTaskFeed(index)
  // An engine older than Silos needs never gets a console:
  // the open is refused with the verdict's one line (what is installed,
  // what is needed, the update command) — harness.ts HarnessService.refusal.
  // A console already running for the session is only reattached (nothing
  // launches), so it is never refused.
  const consoleRefusal = async (h: HarnessId, meta?: SessionMeta): Promise<{ error: string; compat: true } | null> => {
    if (meta && (await terminals.hasConsole(await consoleKeyFor(meta)))) return null
    const line = harness ? await harness.refusal(h, 'console') : null
    return line ? { error: line, compat: true } : null
  }
  // The registered engines as the web sees them (harness-descriptor.ts):
  // always registered — it needs no service. An agent bearer is refused by
  // agentMayRead like for /api/harness (not in its read allow-list).
  app.get('/api/harnesses', async () => ({ harnesses: describeHarnesses() }))

  // The harness: what each engine runs, its compatibility verdict and
  // whether a newer Claude Code is published; POST updates the `claude` on
  // PATH, which runs the consoles and the chats alike (the Agent SDK
  // library moves with Silos). One update at a time.
  if (harness) {
    app.get('/api/harness', async () => harness.status())
    app.post<{ Body: { harness?: unknown } | null }>('/api/harness/update', async (req, reply) => {
      const which = req.body?.harness ?? fallbackHarness().id
      if (typeof which !== 'string' || !harness.updatable().includes(which))
        return reply.code(400).send({ error: `harness must be ${quotedIds(harness.updatable())}` })
      try {
        return await harness.update(which)
      } catch (err) {
        if (err instanceof HarnessBusyError) return reply.code(409).send({ error: err.message })
        if (err instanceof HarnessUpdateError) return reply.code(502).send({ error: err.message, output: err.output })
        throw err
      }
    })
  }

  // The real console: makes sure THIS session's real `claude` is running
  // in its tmux session (durable) and returns the console KEY. Resolves
  // the cwd from the index by session id (the JSONL UUID). The screen is
  // streamed by /ws/console/:key — one tmux client per socket.
  app.post<{ Body: { id?: string; agentId?: string; theme?: string; provider?: string; model?: string; outputStyle?: string; closeHolders?: boolean } }>(
    '/api/console',
    async (req, reply) => {
      const id = typeof req.body?.id === 'string' ? req.body.id : ''
      const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : ''
      // the UI's theme at open time — the console's claude is told to match
      // (see defaultConsoleCommand). Anything but 'light' means the usual dark.
      const theme = req.body?.theme === 'light' ? ('light' as const) : undefined
      // An explicit account/key for THIS console (a new conversation opened
      // on another account, or a reopen after the owner changed the pin).
      // Validated here against the store — the same ids the prefs accept —
      // and persisted as the conversation's `provider` pref so the column
      // and the chat engine see the same truth (two engines, one cascade).
      const pick = typeof req.body?.provider === 'string' ? req.body.provider.trim() : ''
      // a NEW console's model pick (the panel's pending pin) — it names the
      // launch model and pins on the conversation at the seal; never braces
      // (it lands in OpenCode config text), never absurdly long
      const modelPick =
        typeof req.body?.model === 'string' && req.body.model.trim() !== '' && !req.body.model.includes('{') && req.body.model.length <= 200
          ? req.body.model.trim()
          : ''
      if (pick) {
        // …and suit the harness the console runs: the session's (its id says
        // which), else the agent's
        const pickAgent = !id && agentId ? registry.get(agentId) : null
        const pickHarness = id ? harnessForId(id) : pickAgent ? harnessOf(pickAgent) : fallbackHarness().id
        const err = providers ? providerIdError(pick, pickHarness, providers) : `unknown provider: ${pick}`
        if (err) return reply.code(400).send({ error: err })
      }
      // a NEW console's style pick — one the harness offers for the folder
      const stylePick = typeof req.body?.outputStyle === 'string' ? req.body.outputStyle.trim() : ''
      if (stylePick) {
        const styleAgent = !id && agentId ? registry.get(agentId) : null
        const styleHarness = id ? harnessForId(id) : styleAgent ? harnessOf(styleAgent) : fallbackHarness().id
        const err = outputStyleError(styleHarness, stylePick, styleAgent?.folder ?? null)
        if (err) return reply.code(400).send({ error: err })
      }
      // every pick of THIS console lands as the conversation's pin under its
      // key (the session id it is born with) — so the launch reads them through
      // the one cascade (pin › agent) and the column says the same. Without
      // the model here a new conversation opened on the agent's model whatever
      // the owner picked.
      const pinPicks = (cwd: string, key: string): void => {
        if (!convPrefs) return
        const patch = { ...(pick ? { provider: pick } : {}), ...(modelPick ? { model: modelPick } : {}), ...(stylePick ? { outputStyle: stylePick } : {}) }
        if (Object.keys(patch).length > 0) convPrefs.patch(mungePath(cwd), key, patch)
      }
      // what each harness's open hooks take (Harness.server openSession / openNew)
      const input: ConsoleOpenInput = { ...(theme ? { theme } : {}), pick, modelPick, pinPicks }
      try {
        absorbRotations()
        if (id) {
          // the harness's own step before anything is looked up (OpenCode:
          // the registrar sweep — a console born moments ago is sealed first)
          await hooks(harnessForId(id)).beforeOpen?.(id)
          // an existing session → --resume over its cwd. The console gets the
          // owning agent's system-prompt append too, so the agent is the SAME
          // self here as in a chat session (mission, its memory, the platform
          // notes) — without it, the default engine ran a bare claude.
          const meta = index.allSessions().find((m) => m.id === id)
          // an ANCESTOR of a rotated thread never gets a console: the running
          // tmux belongs to the chain's tip (reattaching painted the SAME live
          // console under three sidebar rows), and a --resume
          // here would fork a twin file. 409 → the client shows the transcript.
          if (meta && lineage) {
            // the tip is the most recently ACTIVE of the session and its
            // descendants: a child older than this session (a stale fork) is
            // not where the thread continues, and must not 409 a live console.
            // Measured from the THREAD's root (the console key), not from this
            // session: a stale fork that hangs off the thread has no newer
            // descendant of its own, yet the console it would reattach to
            // (consoleKeyFor walks to the root) belongs to the thread's tip —
            // opening the bug-born SDK twin "hi" painted the live console of
            // "check-in" under both rows. (thread-tools.ts)
            const tip = recentTipOf({ lineage, threadRootKey }, index.allSessions(), meta)
            if (tip !== `${meta.folder}/${meta.id}`) return reply.code(409).send({ error: 'this thread continues in a newer conversation', tip })
          }
          // a run born from an automation, or a nested run, never gets a
          // console — see transcriptOnly (the chat route applies the same rule).
          if (meta) {
            const refused = transcriptOnly(meta)
            if (refused) return reply.code(409).send(refused)
          }
          // a chat turn (the SDK — a message conversation Silos is working, or
          // the owner's own chat) is writing this session right now: a console
          // over it would be a second writer on one transcript
          if (chat.isSessionActive(id)) return reply.code(409).send({ error: 'a conversation is working in it', working: true })
          // the session's harness opens it: reattach to its live console, else
          // relaunch it (Harness.server openSession; generic for a harness whose
          // console takes the id Silos chooses — console-open.ts)
          const h = harnessForId(id)
          const refusedEngine = await consoleRefusal(h, meta)
          if (refusedEngine) return reply.code(409).send(refusedEngine)
          const r = await (hooks(h).openSession ?? ((sid, m, i) => genericOpenSession(hookContext(h), harnessById(h), sid, m, i)))(id, meta, input)
          return reply.code(r.code).send(r.body)
        }
        if (agentId) {
          const agent = registry.get(agentId)
          // an archived agent is out of play and an unknown id is nobody: a
          // NEW conversation (a real process) is never born for either — a
          // stale door (an archived agent's beat) once started one
          if (!agent || agent.archived) return reply.code(404).send({ error: `no agent «${agentId}» here — archived or removed` })
          if (agent.folder === null) return reply.code(400).send({ error: 'the agent has no folder — cannot open console' })
          // a new conversation in the agent's folder, on the agent's harness
          // (Harness.server openNew; generic as above)
          const h = harnessOf(agent)
          const refusedEngine = await consoleRefusal(h)
          if (refusedEngine) return reply.code(409).send(refusedEngine)
          const withFolder = agent as Agent & { folder: string }
          const r = await (hooks(h).openNew ?? ((a, i) => genericOpenNew(hookContext(h), harnessById(h), a, i)))(withFolder, input)
          return reply.code(r.code).send(r.body)
        }
        return reply.code(400).send({ error: 'session id or agentId required' })
      } catch (err) {
        // a claude outside Silos still holds the conversation (rule 2: never
        // a --resume twin). The refusal names who; `closeHolders: true` asks
        // Silos to close it first — the same SIGHUP-then-SIGTERM the trash
        // offers — and open in the same gesture (a message that only said
        // «wait for it to exit» left no door).
        if (err instanceof ConsoleHeldError) {
          if (req.body?.closeHolders === true && id) {
            try {
              await terminals.closeHoldersAndWait(err.resumeId)
              const h = harnessForId(id)
              const meta = index.allSessions().find((m) => m.id === id)
              const r = await (hooks(h).openSession ?? ((sid, m, i) => genericOpenSession(hookContext(h), harnessById(h), sid, m, i)))(id, meta, input)
              return reply.code(r.code).send(r.body)
            } catch (err2) {
              if (err2 instanceof ConsoleHeldError)
                return reply.code(409).send({ error: `${err2.message} — it did not exit when asked`, holders: err2.holders, canClose: false })
              return reply.code(400).send({ error: err2 instanceof Error ? err2.message : String(err2) })
            }
          }
          return reply.code(409).send({ error: `${err.message} — close it to resume here`, holders: err.holders, canClose: true })
        }
        // tmux did not answer whether the console runs: nothing was spawned
        // over it (nor its turn token touched) — the open is retried
        if (err instanceof ConsoleUnknownError) return reply.code(503).send({ error: err.message, retry: true })
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  // ── Task mode (task-mode/engine.ts) ──────────────────────────────────────
  // GET /api/task-mode — whether it runs and who is in it (the web's gate).
  // The escalation (escalation/engine.ts): its one knob —
  // the window between hops, in hours — and the cases open and lately
  // closed. Owner-only: an agent bearer is refused (and agent-authz keeps
  // /api/escalation out of both allow-lists).
  if (escalation) {
    app.get('/api/escalation', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: "the escalation is the owner's" })
      return escalation.view()
    })
    app.put<{ Body: { windowHours?: unknown } | null }>('/api/escalation', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: "the escalation is the owner's" })
      const h = validWindowHours(req.body?.windowHours)
      if (h === null) return reply.code(400).send({ error: `windowHours must be a number of hours from ${MIN_WINDOW_HOURS} to ${MAX_WINDOW_HOURS}` })
      escalation.store.setWindowHours(h)
      return escalation.view()
    })
  }

  // GET /api/tasks/mode?key=<plans task key> — how the task's owner wakes,
  //   its last wakes, and what the task's ONE door opens (`door`).
  // POST /api/tasks/work {key, theme?} — the door, console side («Continue
  //   in X's console ›» / «Start X on this»): a console of the task's agent
  //   owner — ANY agent, bound to Task mode or not — with the
  //   scoped briefing as its first prompt, resuming the
  //   (agent, task) conversation (`claude --resume <id> "…"`, the documented
  //   CLI) or a new one whose id joins conversations[]. A console already
  //   running there is reattached, nothing typed (the owner is in it). A
  //   turn RUNNING in that agent's thread refuses (409, said, with the
  //   conversation to open). The owner's gesture; a person's task has none.
  if (taskMode) {
    // the task threads over the index NOW (task-threads.ts — the rule the
    // wakes and the feed read too): an OpenCode console key and its `ses_…`
    // are one thread (nativeIdOf), and only tipOf filters by continuable
    // (R5: not a run's transcript, the recent tip of its lineage thread)
    const threadsNow = (): { metas: SessionMeta[]; threads: TaskThreads } => {
      absorbRotations()
      const metas = index.allSessions()
      const threads = taskThreads({
        metas,
        lineage: lineage ?? null,
        ownerOf: (m) => classifyAgentId(m),
        nativeIdOf: (id) => terminals.nativeIdOf(id),
        continuable: continuableOf({ transcriptOnly, lineage, threadRootKey }, metas),
      })
      return { metas, threads }
    }
    // what a conversation id is stored as on a task: the native id its
    // engine sealed (OpenCode's `ses_…` for a console key), else itself —
    // the ONE normalization (R3)
    const storedId = (id: string): string => terminals.nativeIdOf(id) ?? id
    // (D16b, J8, J10.15) who may own a task in `folder`: an
    // agent IN PLAY with a folder of the task's project — the one resolver
    // (project-scope.ts ofProject; the task flow reads the same rule, R3:
    // an owner outside it is `owner-outside-project`). An agent of another
    // project is no destination; neither is a person by name.
    const mayOwnIn = (agentId: string, folder: string | null): boolean => {
      const a = registry.list().find((x) => x.id === agentId)
      if (!a || !a.folder || folder === null) return false
      return ofProject(a, folder)
    }
    const ownerOnly = (req: FastifyRequest): boolean => req.agentId === undefined && req.ownerCredential === true && authorOf(req, registry) === 'owner'
    // what the owner's Give does once the task holds what it should (R1):
    // bound → the owner's assign (blessed first — G3-product); told → you go
    // in; yours → nothing to start
    const giveOf = (key: string, owner: string): { queued: boolean; why?: string; held?: string; wakes?: 'task' | 'never' } => {
      if (owner === 'owner') return { queued: false, why: 'it is yours' }
      const agent = registry.get(owner)
      if (!agent || agent.archived) return { queued: false, why: `${owner || 'nobody'} is not an agent in play` }
      if (!taskMode.isBound(agent.id)) return { queued: false, wakes: 'never', why: `${agent.name} waits for you — open its console on it` }
      initiativeNow()?.bless(key, 'give')
      return { ...taskMode.assign(key, Date.now(), { ownerGesture: true }), wakes: 'task' }
    }

    // a run working the thread is read, never opened over (R5 point 8)
    const runWords = (meta: SessionMeta | undefined, agentName: string): string | null => {
      const t = meta ? transcriptOnly(meta) : null
      if (!t) return null
      return t.nested === true
        ? `a nested run of ${agentName} is working this task — read it`
        : `an automation run of ${agentName} is working this task — read it`
    }
    // the agent's continuable tip of the task's CURRENT thread and whether a
    // turn runs in its thread now (a run's turn says readOnly)
    type Running = { sessionId: string; folder: string; readOnly?: true; error?: string }
    const threadOf = (agentId: string, listed: readonly string[]): { tip: { sessionId: string; folder: string } | null; running: Running | null } => {
      const { metas, threads } = threadsNow()
      const tip = threads.tipOf(agentId, listed)
      const runningId = threads.holdersOf(agentId, listed).find((id) => chat.isSessionActive(id)) ?? null
      if (!runningId) return { tip, running: null }
      const runningMeta = metas.find((m) => m.id === runningId)
      const words = runWords(runningMeta, registry.get(agentId)?.name ?? agentId)
      return {
        tip,
        running: { sessionId: runningId, folder: runningMeta?.folder ?? tip?.folder ?? '', ...(words ? { readOnly: true as const, error: words } : {}) },
      }
    }
    // what the task page's ONE door opens: the
    // thread it continues (null → it starts one: «Start X on this…»), a turn
    // running there (the door then only opens it — «Read it ›» for a run),
    // and whether the agent's console takes the briefing (an engine without
    // consoleBriefing: the door defaults to chat)
    // — and where «Open» goes (open-surface.ts): its
    // console when the agent has one in the index, else chat
    const doorOf = (
      key: string,
      agentId: string,
    ): { thread: { sessionId: string; folder: string } | null; running: Running | null; consoleBriefs: boolean; hasConsole: boolean } | null => {
      const t = taskMode.tasks().find((x) => x.key === key)
      const agent = registry.get(agentId)
      if (!t || !agent) return null
      const { tip, running } = threadOf(agentId, t.current)
      const open = openFactsOf(
        agent,
        consoleOwners(index.allSessions(), (m) => classifyAgentId(m)),
      )
      return { thread: tip, running, ...open }
    }
    app.get('/api/task-mode', async () => {
      const entry = siloRegistry?.get(TASK_MODE_SILO) ?? null
      return { silo: TASK_MODE_SILO, installed: entry !== null, active: entry?.status.state === 'active', bound: [...taskMode.boundAgents()] }
    })
    app.get<{ Querystring: { key?: string } }>('/api/tasks/mode', async (req, reply) => {
      const key = typeof req.query.key === 'string' ? req.query.key : ''
      const v = key ? taskMode.view(key) : null
      if (!v) return reply.code(404).send({ error: 'no such task in the plans Silos reads' })
      const isAgent = registry.list().some((a) => a.id === v.owner)
      const wakes = isAgent ? wakesOfControl(taskMode.isBound(v.owner) ? 'own' : 'told') : null
      // (D16a/b) where «Give to… ›» may take it: the agents in
      // play whose fence holds its project (mayOwnIn — the rule `hand` judges
      // by), and you; never its owner now, never a person by name
      const folder = taskMode.tasks().find((x) => x.key === key)?.folder ?? null
      const handTo = [
        ...(v.owner !== 'owner' ? [{ id: 'owner', name: 'You', wakes: null }] : []),
        ...registry
          .list()
          .filter((a) => a.id !== v.owner && mayOwnIn(a.id, folder))
          .map((a) => ({ id: a.id, name: a.name, wakes: wakesOfControl(taskMode.isBound(a.id) ? 'own' : 'told') })),
      ]
      // (R3) no door for an owner of another project: POST /api/tasks/work refuses it too
      return { ...v, wakes, door: isAgent && v.ownerOutside !== true ? doorOf(key, v.owner) : null, handTo }
    })
    // GET /api/tasks/feed?key= — the task feed: the visible reply of every
    // turn the machinery sent for this task, read from the transcripts of its
    // thread — EVERY listed conversation, current or not: the feed is history
    // (owner-only: agent bearers are refused by the read allow-list).
    app.get<{ Querystring: { key?: string } }>('/api/tasks/feed', async (req, reply) => {
      const key = typeof req.query.key === 'string' ? req.query.key : ''
      const t = key !== '' ? (taskMode.tasks().find((x) => x.key === key) ?? null) : null
      if (!t) return reply.code(404).send({ error: 'no such task in the plans Silos reads' })
      absorbRotations()
      const sessions = threadMembership(index.allSessions(), lineage ?? null, { nativeIdOf: (id) => terminals.nativeIdOf(id) }).sessionsOf(t.conversations)
      const items = await taskFeed(sessions, t.ref, (m) => classifyAgentId(m))
      return { items }
    })
    // POST /api/tasks/talk {key} — «Open chat ›»:
    // the chat-lane twin of Work on this. ONE turn with the work briefing on
    // the task's own thread, through the resident lane, for ANY agent owner —
    // bound or not. Answers once the session is known; the turn goes on.
    app.post<{ Body: { key?: unknown } | null }>('/api/tasks/talk', async (req, reply) => {
      const key = typeof req.body?.key === 'string' ? req.body.key : ''
      if (!key) return reply.code(400).send({ error: 'send {key}' })
      const r = await taskMode.openTalk(key)
      if (!r.ok) return reply.code(r.code).send({ error: r.reason })
      const agent = registry.list().find((a) => a.id === r.agent)
      const folder = r.folder ?? (agent?.folder ? mungePath(agent.folder) : null)
      if (!folder) return reply.code(502).send({ error: `${r.agent} has no folder — the turn ran nowhere the index can show` })
      return { folder, sessionId: r.sessionId, isNew: r.isNew, folded: r.folded.length }
    })

    // The task a claim or a release names: {key} or {plan, task(, folder)}
    // — read once more before saying no (a task written a moment ago).
    // Several projects holding plan#task and no folder (#38, E7):
    // the project of the conversation it names wins, when Silos knows it;
    // else the agent's own (its task, or its folders) — 409 only when that
    // still leaves several. What the screen paints names a task too:
    // `<project>#t3` is that project's list's t3 (unless the project has a
    // plan named like it — then the plan wins, as it always did), and the
    // claimant's own project's list wins over a plan of that name in
    // ANOTHER project; `<project>/<plan>#t3` (a plan named like its project)
    // is that plan of that project.
    type TaskBody = { key?: unknown; plan?: unknown; task?: unknown; folder?: unknown }
    // `bound`: the bearer the lookup answers (req.agentId) — it sees only
    // the tasks of its projects (project-scope.ts): a task elsewhere is
    // «no such task», the same answer as for an id that names nothing, and
    // the «N projects have …» 409 counts only its own. The owner and the
    // owner's desk see every project.
    const findTask = (
      b: TaskBody,
      hint: { session?: string | null; agentId?: string; bound?: string } = {},
    ): { t: TaskSnap } | { code: number; body: Record<string, unknown> } => {
      const pm = siloRegistry?.get(PLANS_SILO)?.manifest as Record<string, unknown> | null | undefined
      const standing = pm ? standingIdsOf(pm, 'plan') : new Set<string>()
      const byKey = typeof b.key === 'string' && b.key !== '' ? b.key : null
      if (byKey === null && (typeof b.plan !== 'string' || typeof b.task !== 'string' || b.plan === '' || b.task === ''))
        return {
          code: 400,
          body: { error: "send {key} or {plan, task} (plan = the file's slug, plans/<plan>.plan.json; folder = the project, when several hold that plan)" },
        }
      const folder = typeof b.folder === 'string' && b.folder !== '' ? mainCheckoutOf(b.folder) : null
      const inFolder = (x: TaskSnap): boolean => folder === null || x.folder === folder
      const under = (f: string, dir: string): boolean => f === dir || f.startsWith(`${dir}/`)
      // the claimant's own place: its conversation's project, its agent's folders
      const where = hint.session ? sessionFacts(hint.session, []).cwd : null
      const agent = hint.agentId ? registry.get(hint.agentId) : undefined
      const dirs = agent ? [agent.folder, ...(agent.folders ?? [])].filter((f): f is string => typeof f === 'string' && f !== '') : []
      const inWhere = (x: TaskSnap): boolean => where !== null && x.folder !== null && under(mainCheckoutOf(where), x.folder)
      const inDirs = (x: TaskSnap): boolean => x.folder !== null && dirs.some((d) => under(x.folder!, d) || under(d, x.folder!))
      const inBound = (folder: string | null): boolean => hint.bound === undefined || reaches(hint.bound, folder, registry.list(true))
      const lookup = (): TaskSnap[] => {
        const all = taskMode.tasks().filter((x) => inBound(x.folder))
        if (byKey !== null) {
          return all.filter((x) => x.key === byKey)
        }
        const asked = String(b.plan)
        const id = String(b.task)
        const slash = asked.lastIndexOf('/')
        const base = slash > 0 ? asked.slice(0, slash) : null
        const plan = slash > 0 ? asked.slice(slash + 1) : asked
        const exact = all.filter(
          (x) => x.planId === plan && x.id === id && inFolder(x) && (base === null || (x.folder !== null && basename(x.folder) === base)),
        )
        if (base !== null) return exact
        const shown = all.filter(
          (x) =>
            standing.has(x.planId) &&
            x.id === id &&
            x.folder !== null &&
            basename(x.folder) === plan &&
            inFolder(x) &&
            !all.some((y) => y.folder === x.folder && y.planId === plan),
        )
        const mine = (x: TaskSnap): boolean => inWhere(x) || inDirs(x)
        if (shown.some(mine) && !exact.some(mine)) return shown.filter(mine)
        if (exact.length > 0) return exact
        return shown
      }
      let hits = lookup()
      if (hits.length === 0 && refreshPlans) {
        refreshPlans()
        hits = lookup()
      }
      if (hits.length > 1 && byKey === null && folder === null) {
        const narrow = (keep: (x: TaskSnap) => boolean): boolean => {
          const n = hits.filter(keep)
          if (n.length === 0) return false
          hits = n
          return true
        }
        const narrowed = where !== null && narrow(inWhere)
        if (!narrowed && hint.agentId) {
          if (!narrow((x) => x.owner === hint.agentId)) narrow(inDirs)
          else if (hits.length > 1) narrow(inDirs)
        }
      }
      if (hits.length > 1)
        return {
          code: 409,
          body: { error: `${hits.length} projects have ${String(b.plan)}#${String(b.task)} — send folder too`, keys: hits.map((x) => x.key) },
        }
      const t = hits[0]
      if (!t) {
        // (A1.8) the id IS in a plan file but its task does
        // not build: said with the reader's own why — never «no such task»
        const cut = byKey !== null ? byKey.lastIndexOf('/tasks/') : -1
        const want =
          byKey !== null
            ? cut > 0
              ? { planKey: byKey.slice(0, cut), id: byKey.slice(cut + '/tasks/'.length) }
              : null
            : { plan: String(b.plan).split('/').pop()!, id: String(b.task) }
        const bad =
          want === null
            ? undefined
            : taskMode
                .unreadableTasks()
                .filter(
                  (p) => inBound(p.folder) && ('planKey' in want ? p.key === want.planKey : p.id === want.plan && (folder === null || p.folder === folder)),
                )
                .flatMap((p) => p.tasks)
                .find((x) => x.id === want.id)
        if (bad && want) return { code: 404, body: { error: `${want.id} is in the file but can't be read: ${bad.reason}` } }
        return { code: 404, body: { error: 'no such task in the plans Silos reads' } }
      }
      return { t }
    }
    const nameOf = (id: string): string => registry.get(id)?.name ?? id
    // the bound of a bearer's task verb (project-scope.ts): its projects —
    // none for the owner's credential and the owner's desk
    const boundOf = (req: FastifyRequest): { bound?: string } => (req.agentId !== undefined && !seesAll(req.agentId) ? { bound: req.agentId } : {})
    // a task of its project owned by someone else, as the bearer may hear
    // it: the owner's name only when it knows that agent (an id it wrote
    // itself in its plan is never decorated), and «message its owner» only
    // when it can
    const notYours = (t: TaskSnap, reader: string): { error: string; owner: string } => {
      const known =
        t.owner !== '' && t.owner !== 'owner' && t.owner !== MASTER_ID && mayName(reader, t.owner, registry.list(true)) && registry.get(t.owner) !== null
      return {
        error: known
          ? `${t.ref} is ${nameOf(t.owner)}'s task, not yours — message its owner instead (POST /api/agents/${t.owner}/messages)`
          : t.owner === 'owner' || t.owner === ''
            ? `${t.ref} is ${t.owner === 'owner' ? "the owner's" : "nobody's"} task, not yours — leave a note on it, or ask the owner`
            : `${t.ref} is owned by ${t.owner} — not an agent here; it is not yours — leave a note on it, or ask the owner`,
        owner: t.owner,
      }
    }
    // What Silos knows of a conversation (R3; ONE resolver — m5): KNOWN when
    // it is in the index, in the console records (its key, or the key its
    // native id is bound to), or in the native store under one of `folders`;
    // whose it is (the index's owner, else the console record's agent; null:
    // no owner known) and its working dir when the index has it.
    const sessionFacts = (id: string, folders: readonly string[]): { known: boolean; whose: string | null; cwd: string | null } => {
      const meta = index.allSessions().find((m) => m.id === id)
      if (meta) return { known: true, whose: classifyAgentId(meta), cwd: meta.cwd ?? null }
      const rec = terminals.consoleRecord(terminals.keyOfNativeId(id) ?? id)
      if (rec) {
        const f = rec.agentId ? (registry.get(rec.agentId)?.folder ?? null) : null
        return { known: true, whose: rec.agentId ?? null, cwd: f }
      }
      if (native && folders.some((f) => native.get(f, id) !== null)) return { known: true, whose: null, cwd: null }
      return { known: false, whose: null, cwd: null }
    }
    // …refreshed once (the index may not have read a transcript born a moment ago)
    const factsAfterRefresh = async (id: string, folders: readonly string[]): Promise<{ known: boolean; whose: string | null; cwd: string | null }> => {
      const first = sessionFacts(id, folders)
      if (first.known) return first
      for (const f of folders) {
        try {
          await index.refresh(f, id)
        } catch {
          /* not there */
        }
      }
      return sessionFacts(id, folders)
    }
    // the Plans manifest's verb of that name on plan/task (claim, release)
    const plansVerb = (verb: string): Record<string, unknown> | null => {
      const plans = siloRegistry?.get(PLANS_SILO)?.manifest as Record<string, unknown> | undefined
      const spec = plans && typeof plans.spec === 'object' && plans.spec !== null ? (plans.spec as Record<string, unknown>) : {}
      const a = Array.isArray(spec.actions)
        ? spec.actions.find((x) => typeof x === 'object' && x !== null && (x as Record<string, unknown>).verb === verb)
        : undefined
      return a ? (a as Record<string, unknown>) : null
    }
    const plansName = (): string => {
      const plans = siloRegistry?.get(PLANS_SILO)?.manifest as Record<string, unknown> | undefined
      const meta = plans?.metadata as Record<string, unknown> | undefined
      return typeof meta?.name === 'string' ? meta.name : 'Plans'
    }
    // the agent a claim/release speaks for: its bearer, else the author the
    // request names (X-Silos-Agent — never a permission, only a hint here)
    const speakerOf = (req: FastifyRequest): string | undefined => {
      if (req.agentId !== undefined) return req.agentId
      const a = authorOf(req, registry)
      return a !== 'owner' && a !== UNKNOWN_AUTHOR ? a : undefined
    }
    const foldersOf = (t: TaskSnap, agentId: string | undefined): string[] => {
      const out = new Set<string>()
      if (t.folder) out.add(mungePath(t.folder))
      for (const a of [agentId, t.owner]) {
        const f = a ? registry.get(a)?.folder : null
        if (f) out.add(mungePath(f))
      }
      return [...out]
    }
    // the warnings a link carries (the claim's and the owner's link alike):
    // only when the task is ANOTHER AGENT's — an owner's (or a person's) task
    // has no door or wakes of its own that this conversation could miss
    const linkWarn = (t: TaskSnap, conv: { linked: boolean; whose: string | null }, by: { author: string; agentId: string | undefined }): { warn?: string } => {
      const warns: string[] = []
      const ownerIsAgent = registry.list().some((a) => a.id === t.owner)
      if (conv.linked && conv.whose !== null && t.owner !== '' && conv.whose !== t.owner && ownerIsAgent)
        warns.push(`this conversation is ${nameOf(conv.whose)}'s, not ${nameOf(t.owner)}'s — it's linked, but ${nameOf(t.owner)}'s door and wakes won't see it`)
      if (by.agentId === undefined && by.author !== 'owner' && t.owner !== '' && by.author !== t.owner && ownerIsAgent)
        warns.push(`you (${nameOf(by.author)}) claimed ${nameOf(t.owner)}'s task — ${nameOf(t.owner)} is still its owner`)
      return warns.length > 0 ? { warn: warns.join('; ') } : {}
    }
    const UNKNOWN_WHY =
      "this conversation isn't known to Silos yet (claude -c / --resume without an id gives the startup id) — the task is in_progress; link it from ⌘K"

    // POST /api/tasks/claim {key | plan+task(+folder), session?, takeover?} —
    // the agent's own verb when it takes a task on its own (R3/R4): in ONE write
    // (siloActions.linkAndSet, judged by the silo's `claim` verb) its
    // conversation joins conversations[] — stored as its native id when the
    // engine sealed one — and the task goes in_progress; the answer is the
    // claim briefing and who else worked it. An explained refusal, not a
    // lock: 409 only while ANOTHER conversation of the task's CURRENT thread
    // is live (a turn running, or it moved in the last CLAIM_LIVE_MS), saying
    // who and how long ago; `takeover: true` passes and Silos writes the
    // hand-over note. With an agent bearer the task must be that agent's and
    // a KNOWN session too (another's → 403); without one the caller is the
    // owner, and X-Silos-Agent only names the author (authorOf — never a
    // permission). A session Silos does not know answers 200 linked:false
    // with why, the link unwritten. Judged and written with no await between.
    app.post<{ Body: (TaskBody & { session?: unknown; takeover?: unknown }) | null }>('/api/tasks/claim', async (req, reply) => {
      const b = req.body ?? {}
      if (!siloActions) return reply.code(501).send({ error: 'this server writes no plans' })
      const asked = typeof b.session === 'string' && b.session.trim() !== '' ? b.session.trim() : null
      if (asked !== null && !CLAIM_SESSION_ID.test(asked)) return reply.code(400).send({ error: 'session must be a conversation id ($SILOS_SESSION_ID)' })
      if (b.takeover !== undefined && typeof b.takeover !== 'boolean') return reply.code(400).send({ error: 'takeover must be true or false' })
      const takeover = b.takeover === true
      const found = findTask(b, { session: asked !== null ? storedId(asked) : null, agentId: speakerOf(req), ...boundOf(req) })
      if (!('t' in found)) return reply.code(found.code).send(found.body)
      const t = found.t
      const agentId = req.agentId
      if (agentId !== undefined && t.owner !== agentId) return reply.code(403).send(notYours(t, agentId))
      if (t.state === 'done' || t.state === 'cancelled')
        return reply.code(409).send({ error: `${t.ref} is ${t.state} — more work on it is a new task (or the owner reopens it)`, state: t.state })
      const session = asked !== null ? storedId(asked) : null
      const facts = session !== null ? await factsAfterRefresh(session, foldersOf(t, agentId)) : { known: false, whose: null, cwd: null }
      const known = facts.known
      const whose = known ? facts.whose : null
      if (agentId !== undefined && session !== null && known && whose !== agentId)
        return reply.code(403).send({ error: `conversation ${asked} is not one of yours — claim with your own $SILOS_SESSION_ID` })
      const author = authorOf(req, registry)
      const actor = agentId !== undefined ? { agentId } : {}
      const warn = linkWarn(t, { linked: session !== null && known, whose }, { author, agentId })
      const linking = session !== null && known
      absorbRotations()
      const now = Date.now()
      // a conversation listed on the task is told with its facts (agent,
      // title, folder) only when it is the bearer's own or of an agent it
      // knows — an id it wrote there itself comes back as that id, never
      // decorated (project-scope.ts)
      const all = registry.list(true)
      const factsShown = (o: ClaimOther): boolean =>
        agentId === undefined ||
        seesAll(agentId) ||
        o.agent === '' ||
        o.agent === agentId ||
        knows(
          all.find((a) => a.id === agentId),
          all.find((a) => a.id === o.agent),
        )
      const others = othersOnTask({
        metas: index.allSessions(),
        lineage: lineage ?? null,
        listed: t.current,
        claimant: session,
        ownerOf: (m) => classifyAgentId(m),
        nameOf,
        isRunning: (id) => chat.isSessionActive(id),
        now,
        nativeIdOf: (id) => terminals.nativeIdOf(id),
      }).map((o) =>
        factsShown(o) ? o : { ...o, folder: null, agent: '', title: 'untitled', says: `conversation ${o.sessionId}${o.says.slice(o.says.lastIndexOf(' ('))}` },
      )
      const live = others.filter((o) => o.live)
      const view = (o: ClaimOther) => ({
        sessionId: o.sessionId,
        folder: o.folder,
        agent: o.agent,
        title: o.title,
        at: o.at !== null ? new Date(o.at).toISOString() : null,
        running: o.running,
        live: o.live,
        says: o.says,
      })
      if (live.length > 0 && !takeover) {
        return reply
          .code(409)
          .send({
            error: `${live.map((o) => o.says).join('; ')} ${live.length > 1 ? 'are' : 'is'} working ${t.ref} — don't start it here (and launch no subagent or worktree for it); send takeover:true only if that work is abandoned or yours to take over`,
            live: live.map(view),
          })
      }
      // an unknown conversation is not linked, but the claim's `set` still
      // lands (m6: the verb's own set, not a hard-coded status)
      const claim = plansVerb('claim')
      const claimSet: Array<[string, unknown]> =
        claim && typeof claim.set === 'object' && claim.set !== null ? Object.entries(claim.set as Record<string, unknown>) : [['status', 'in_progress']]
      // the verb's `keep` (plans 0.5.3): a blocked task whose wait is still
      // open (a waitingOn, a dependency not done) is linked and stays
      // blocked; with nothing left to wait on it is claimed as usual — the
      // kernel's rule (claimKept), the same one linkAndSet applies
      const keep = siloActions.claimKept(PLANS_SILO, t.key)
      const kept = keep !== null
      let w: { ok: true } | { ok: false; code: number; reason: string } = { ok: true }
      if (linking) w = siloActions.linkAndSet(PLANS_SILO, t.key, 'conversations', session!, 'status', 'in_progress', { by: author, actor })
      else {
        for (const [f, v] of claimSet) {
          if (f === 'status' && (t.state === v || kept)) continue
          const r = siloActions.setField(PLANS_SILO, t.key, f, v, { by: author })
          if (!r.ok) {
            w = r
            break
          }
        }
      }
      if (!w.ok) return reply.code(w.code).send({ error: w.reason })
      invalidateTaskThreads?.()
      const tookOver = takeover && live.length > 0
      let note: { ok: boolean; reason?: string } | null = null
      if (tookOver) {
        const r = siloActions.appendItem(
          PLANS_SILO,
          t.key,
          'notes',
          {
            text: `Taken over${author !== 'owner' ? ` by ${nameOf(author)}` : ''}${session ? ` in conversation ${session}` : ''} from ${live.map((o) => `${o.says} — ${o.sessionId}`).join('; ')}.`,
          },
          { by: SILOS_AUTHOR },
        )
        note = r.ok ? { ok: true } : { ok: false, reason: r.reason }
      }
      const after = taskMode.tasks().find((x) => x.key === t.key) ?? t
      const shown = tookOver ? live : others
      // the wakes that waited for a bound owner reach it in this answer
      // (via: claim) — only when the conversation is linked
      const bound = taskMode.isBound(t.owner)
      const wakes = bound && linking ? taskMode.claimWakes(t.key, t.owner) : { lines: [], ids: [] }
      const claimedState = kept ? t.state : claimSet.find(([f]) => f === 'status')?.[1]
      const briefing = claimBriefing(
        after,
        shown,
        { linked: linking, tookOver, queued: wakes.lines, bound, state: typeof claimedState === 'string' ? claimedState : 'in_progress', kept },
        (id) => (agentId === undefined || mayName(agentId, id, all) ? nameOf(id) : id),
      )
      if (wakes.ids.length > 0) taskMode.markWorked(wakes.ids, session!, now, 'claim')
      const keptWarn = keep
        ? `${t.ref} stays ${keep.state} — it still waits on ${keep.waits.length > 0 ? keep.waits.join(', ') : 'what it names'}; work toward that, or change what it waits on, then set its status`
        : null
      if (keptWarn) warn.warn = warn.warn ? `${warn.warn}; ${keptWarn}` : keptWarn
      return {
        ok: true,
        key: t.key,
        ref: t.ref,
        title: t.title,
        state: typeof claimedState === 'string' ? claimedState : 'in_progress',
        session,
        linked: linking,
        ...(session !== null && !known ? { why: UNKNOWN_WHY } : {}),
        ...warn,
        tookOver,
        ...(note && !note.ok ? { noteError: note.reason } : {}),
        others: others.map(view),
        briefing,
      }
    })

    // POST /api/tasks/release {key | plan+task(+folder), session, state?} —
    // let one conversation go from a task (R13): its thread
    // becomes history there (no tip, holder or live; still in the feed). The
    // same permissions, authorship and normalization as the claim. With the
    // Plans verb's `dispose` (E4) the task's state goes with the
    // mark, in the SAME write (siloActions.appendRelease): only when the task
    // is in_progress and that thread was its LAST current one — to `state`
    // when sent (one of dispose.allowed, else 400), to dispose.default when
    // not; otherwise the answer says `kept` (another thread still works it,
    // or it was not in progress). A mark already there (written:false)
    // changes nothing: `kept` + `already: released`. 501 while the Plans
    // silo has no `release` (checked here only, m2); 409 when the
    // conversation's thread is not one the task lists — nothing written.
    // Answer: {ok, key, ref, title, session, released, written, state,
    // disposed? | kept?, already?}.
    app.post<{ Body: (TaskBody & { session?: unknown; state?: unknown; wait?: unknown }) | null }>('/api/tasks/release', async (req, reply) => {
      const b = req.body ?? {}
      if (!siloActions) return reply.code(501).send({ error: 'this server writes no plans' })
      const asked = typeof b.session === 'string' && b.session.trim() !== '' ? b.session.trim() : null
      if (asked === null || !CLAIM_SESSION_ID.test(asked)) return reply.code(400).send({ error: 'session must be a conversation id ($SILOS_SESSION_ID)' })
      if (b.state !== undefined && b.state !== null && typeof b.state !== 'string')
        return reply.code(400).send({ error: 'state must be a state name — or omit it' })
      const state = typeof b.state === 'string' && b.state.trim() !== '' ? b.state.trim() : null
      // the wait a «blocked» names rides the
      // release's own write — the OWNER's only (three conditions: the owner's
      // credential, no bearer, no X-Silos-Agent naming an agent); an agent
      // writes its own wait in its plan. On whom and what for, never Silos'
      // `unstick` prefix, bounded like an ask's (H5)
      let wait: ReleaseWait | null = null
      if (b.wait !== undefined && b.wait !== null) {
        if (req.agentId !== undefined || req.ownerCredential !== true || authorOf(req, registry) !== 'owner')
          return reply.code(400).send({ error: "a wait rides only the owner's release — an agent writes waitingOn in its plan, then releases" })
        const w = b.wait as Record<string, unknown>
        if (
          typeof w !== 'object' ||
          typeof w.owner !== 'string' ||
          w.owner.trim() === '' ||
          typeof w.action !== 'string' ||
          w.action.trim() === '' ||
          (w.asked !== undefined && typeof w.asked !== 'string')
        )
          return reply.code(400).send({ error: 'wait is {owner, action, asked?} — on whom and what for' })
        if (state !== 'blocked') return reply.code(400).send({ error: 'a wait goes with state: blocked — what else would it wait on?' })
        if (w.action.trim().startsWith(SILOS_WAIT_PREFIX))
          return reply.code(400).send({ error: `«${SILOS_WAIT_PREFIX.trim()} …» is Silos' own wait — say what it waits for in your words` })
        const asked2 = typeof w.asked === 'string' ? clipText(w.asked.trim(), ASK_ASKED_MAX) : ''
        wait = { owner: w.owner.trim(), action: clipText(w.action.trim(), ASK_ACTION_MAX), ...(asked2 !== '' ? { asked: asked2 } : {}) }
      }
      const found = findTask(b, { session: storedId(asked), agentId: speakerOf(req), ...boundOf(req) })
      if (!('t' in found)) return reply.code(found.code).send(found.body)
      const t = found.t
      const release = plansVerb('release')
      if (!release) return reply.code(501).send({ error: `this ${plansName()} has no release — update it` })
      // whether `state` is one dispose.allowed names is appendRelease's to say
      // (400 in its words) — one source for the rule (B2)
      const agentId = req.agentId
      if (agentId !== undefined && t.owner !== agentId) return reply.code(403).send(notYours(t, agentId))
      const session = storedId(asked)
      if (agentId !== undefined) {
        const facts = sessionFacts(session, foldersOf(t, agentId))
        const whose = facts.known ? facts.whose : null
        if (whose !== null && whose !== agentId)
          return reply.code(403).send({ error: `conversation ${asked} is not one of yours — release with your own $SILOS_SESSION_ID` })
      }
      const { threads } = threadsNow()
      const mine = threads.threadKey(session)
      if (!t.conversations.some((id) => threads.threadKey(id) === mine))
        return reply.code(409).send({ error: `this conversation is not on ${t.ref} — nothing to release` })
      const author = authorOf(req, registry)
      // the disposition rides the mark's write: appendRelease reads the verb's
      // dispose (400 for a state it does not allow); the route passes what was asked
      const opts = { by: author, actor: agentId !== undefined ? { agentId } : {}, ...(state !== null ? { state } : {}), ...(wait ? { wait } : {}) }
      const r = siloActions.appendRelease(PLANS_SILO, t.key, session, true, opts)
      if (!r.ok) return reply.code(r.code).send({ error: r.reason, ...(r.detail !== undefined ? { detail: r.detail } : {}) })
      invalidateTaskThreads?.()
      // what the write said (disposed / kept / already), else what the task reads now
      const v = r.value as typeof r.value & { state?: unknown; disposed?: unknown; kept?: unknown; already?: unknown }
      const after = typeof v.state === 'string' ? v.state : (taskMode.tasks().find((x) => x.key === t.key)?.state ?? t.state)
      const base = { ok: true, key: t.key, ref: t.ref, title: t.title, session, released: true, written: v.written, ...(v.wait ? { wait: v.wait } : {}) }
      if (!v.written) return { ...base, state: after, kept: typeof v.kept === 'string' ? v.kept : after, already: 'released' }
      if (typeof v.disposed === 'string') return { ...base, state: after, disposed: v.disposed }
      if (typeof v.kept === 'string') return { ...base, state: after, kept: v.kept }
      return after !== t.state ? { ...base, state: after, disposed: after } : { ...base, state: after, kept: after }
    })

    // ── the owner's link and the owner's gesture (E3) ──
    // ownerLink: the ONE way the owner links a conversation to a task — ⌘K
    // Link, «Make this a task», and both branches of the door (/work). A
    // pending or in_progress task is claimed (linkAndSet: linked + in
    // progress, one write) — a blocked one nothing holds reads as pending
    // (A1.5) —; a blocked or in_review one only lists it (its
    // state is the agent's disposition — «Linked to «x»»). A closed task is
    // not linked (409). Owner-only. The task is READ AGAIN here, at write
    // time — the door awaits a console between its read and this link, and
    // the agent may have closed the task meanwhile (linkAndSet refuses a
    // terminal state on the file as written too). The answer carries the
    // claim's warnings (linkWarn).
    const ownerLink = (
      snap: TaskSnap,
      sessionId: string,
    ): { ok: true; linked: boolean; state: string; claimed: boolean; warn?: string } | { ok: false; code: number; reason: string } => {
      if (!siloActions) return { ok: false, code: 501, reason: 'this server writes no plans' }
      const all = taskMode.tasks()
      const t = all.find((x) => x.key === snap.key) ?? snap
      if (t.state === 'done' || t.state === 'cancelled')
        return { ok: false, code: 409, reason: `${t.ref} is ${t.state} — more work on it is a new task (or reopen it)` }
      const id = storedId(sessionId)
      const facts = sessionFacts(id, foldersOf(t, undefined))
      const warn = linkWarn(t, { linked: facts.known, whose: facts.known ? facts.whose : null }, { author: 'owner', agentId: undefined })
      // a blocked task nothing holds reads as pending (A1.5): claimed
      const st = snapStateRead(t, all, Date.now())
      if (st === 'pending' || st === 'in_progress') {
        const r = siloActions.linkAndSet(PLANS_SILO, t.key, 'conversations', id, 'status', 'in_progress', { by: 'owner', actor: {} })
        invalidateTaskThreads?.()
        if (!r.ok) return { ok: false, code: r.code, reason: r.reason }
        return { ok: true, linked: r.value.linked || r.value.revived, state: 'in_progress', claimed: true, ...warn }
      }
      const r = siloActions.appendItem(PLANS_SILO, t.key, 'conversations', { session: id })
      invalidateTaskThreads?.()
      if (!r.ok) return { ok: false, code: r.code, reason: r.reason }
      return { ok: true, linked: true, state: t.state, claimed: false, ...warn }
    }

    // POST /api/tasks/link {key, session} — ownerLink over the route (⌘K
    // Link, «Make this a task»). Owner-only: an agent claims instead.
    app.post<{ Body: { key?: unknown; session?: unknown } | null }>('/api/tasks/link', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: "linking is the owner's — an agent claims its own task (POST /api/tasks/claim)" })
      const key = typeof req.body?.key === 'string' ? req.body.key : ''
      const asked = typeof req.body?.session === 'string' ? req.body.session.trim() : ''
      if (!key || !CLAIM_SESSION_ID.test(asked)) return reply.code(400).send({ error: 'send {key, session} (session = a conversation id)' })
      const found = findTask({ key })
      if (!('t' in found)) return reply.code(found.code).send(found.body)
      const r = ownerLink(found.t, asked)
      if (!r.ok) return reply.code(r.code).send({ error: r.reason })
      return {
        ok: true,
        key: found.t.key,
        ref: found.t.ref,
        session: storedId(asked),
        linked: r.linked,
        state: r.state,
        claimed: r.claimed,
        ...(r.warn !== undefined ? { warn: r.warn } : {}),
      }
    })

    // ── hand: give a task to another ──
    // {key, verb: 'hand', to, owner, state, outside}: `owner`, `state` and
    // `outside` are what the task page PAINTED (F4, J5) — required. `to` is
    // you ('owner') or an agent in play whose fence holds the plan's project
    // (mayOwnIn); never a person by name, never the owner now (that is
    // `already`). The guard is the CLAIM's (J2, K6), here in the route, with
    // no await between judging and the write: a current conversation that
    // is not `to`'s and works it by the claim's rule (othersOnTask: a turn
    // running, moved in the last 10 min, or background at work) → 409 naming
    // it; a Task mode turn running or starting on it → 409 naming its
    // conversation, or its agent while it has none. «Is it `to`'s» is ONE
    // reader (sessionFacts); what it keeps and what it judged go to the
    // mutator, which refuses a current one it was not told about. An origin
    // still provisional → 409 (its adoption would undo the blessing, K8); an
    // unknown one only with `outside: true` (J5). Then ONE write
    // (taskGesture 'hand'), and only once it landed: the blessing (whatever
    // the destination's control, said), the creation leaving its creator's
    // open count (K13), and the owner's Give for a bound `to` (`assign`).
    const handTask = (t: TaskSnap, b: Record<string, unknown>, reply: FastifyReply): unknown => {
      const to = typeof b.to === 'string' ? b.to.trim() : ''
      if (to === '') return reply.code(400).send({ error: "hand sends {to}: you ('owner') or an agent" })
      if (typeof b.owner !== 'string') return reply.code(400).send({ error: "hand sends {owner}: the owner you saw ('' when nobody)" })
      if (typeof b.state !== 'string' || b.state.trim() === '') return reply.code(400).send({ error: 'hand sends {state}: the state you saw' })
      if (typeof b.outside !== 'boolean') return reply.code(400).send({ error: 'hand sends {outside}: whether the page showed it was added outside Silos' })
      if (to !== 'owner' && to !== t.owner) {
        const agent = registry.get(to)
        if (!agent)
          return reply.code(400).send({ error: `${to} is no agent here — a task is given to you or an agent; a person's task is theirs to write in its file` })
        if (!mayOwnIn(to, t.folder))
          return reply
            .code(409)
            .send({
              error: agent.archived
                ? `${agent.name} is archived — give it to an agent in play`
                : agent.folder
                  ? `${agent.name} does not work in ${t.folder ? basename(t.folder) : 'its project'} — give it that folder first (its Profile › Runs on)`
                  : `${agent.name} has no folder — it can't work a task in a project`,
            })
      }
      const initiative = initiativeNow()
      const origin = initiative ? initiative.originState(t.key) : 'known'
      if (to !== t.owner) {
        if (origin === 'provisional')
          return reply.code(409).send({ error: 'a turn that may have added it is still running — wait for it to end, then give it' })
        if (origin === 'unknown' && b.outside !== true) return reply.code(409).send({ error: 'its origin is unknown — look at it first' })
      }
      // the guard, judged now — no await until the write
      absorbRotations()
      const folders = foldersOf(t, to === 'owner' ? undefined : to)
      const ofTo = (id: string): boolean => sessionFacts(id, folders).whose === to
      const live = taskMode.view(t.key)?.live ?? null
      if (to !== t.owner && live?.kind === 'running' && live.turns.length > 0) {
        const turn = live.turns[0]!
        const meta = turn.sessionId ? index.allSessions().find((m) => m.id === turn.sessionId) : undefined
        const who = nameOf(turn.agent) || 'An agent'
        const where = turn.sessionId ? ` in «${meta?.title.trim() || 'a conversation'}»` : ''
        return reply
          .code(409)
          .send({ error: `${who}'s turn on it is ${turn.started ? 'running' : 'starting'}${where} — stop it first, then give it`, sessionId: turn.sessionId })
      }
      const now = Date.now()
      const others = othersOnTask({
        metas: index.allSessions(),
        lineage: lineage ?? null,
        listed: t.current,
        claimant: null,
        ownerOf: (m) => classifyAgentId(m),
        nameOf,
        isRunning: (id) => chat.isSessionActive(id),
        now,
        nativeIdOf: (id) => terminals.nativeIdOf(id),
      })
      const working = to !== t.owner ? others.filter((o) => o.live && !ofTo(o.sessionId)) : []
      if (working.length > 0)
        return reply.code(409).send({ error: `${working[0]!.says} is on it now — stop or unlink that conversation first`, sessionId: working[0]!.sessionId })
      const keep = t.current.filter(ofTo)
      const fromWords = t.owner === '' ? 'nobody' : t.owner === 'owner' ? 'you' : (registry.list(true).find((a) => a.id === t.owner)?.name ?? t.owner)
      const toWords = to === 'owner' ? 'you' : nameOf(to)
      const r = siloActions!.taskGesture(PLANS_SILO, t.key, 'hand', {
        to,
        owner: b.owner,
        state: b.state,
        keep,
        judged: [...t.current],
        text: `Handed from ${fromWords} to ${toWords}.`,
      })
      if (!r.ok) return reply.code(r.code).send({ error: r.reason, ...(r.detail !== undefined ? { detail: r.detail } : {}) })
      if (r.value.already) return { ...r.value }
      invalidateTaskThreads?.()
      // only now that it landed (K8): the blessing, the creator's count, the Give
      const blessed = initiative?.bless(t.key, 'give') === true
      initiative?.handed(t.key)
      const assign = giveOf(t.key, to)
      try {
        taskMode.look()
      } catch {
        /* the tick looks again */
      }
      return { ...r.value, assign, ...(blessed ? { blessed: true } : {}) }
    }

    // POST /api/tasks/act {key, verb, …} — the OWNER's gesture on ONE task as
    // ONE write (Part C): answer {text, asked} · approve
    // {text?, asked} · done {state} · drop {state, text?} · reopen · park
    // {until, day?} · resume · remove-dependency {dep}. `asked` and `state`
    // are what the surface PAINTED (F4) — required: the condition is judged
    // against them inside the write (siloActions.taskGesture), never against
    // the file's version (another task of the plan written meanwhile refuses
    // nothing). Only the owner (C13a): the owner's credential, no bearer, no
    // X-Silos-Agent naming an agent — else 403. The answer is set-field's
    // (the record, nowReady with each owner's wakes) plus `already` (F3) and
    // `holds` (what still holds it — F2); a refused condition is 409 in its
    // words with the task as it is now (`detail.task`). Task mode looks now.
    app.post<{ Body: Record<string, unknown> | null }>('/api/tasks/act', async (req, reply) => {
      if (req.agentId !== undefined || req.ownerCredential !== true || authorOf(req, registry) !== 'owner')
        return reply.code(403).send({ error: "a task's gestures are the owner's — an agent moves its own task by writing its plan, or claims and releases it" })
      if (!siloActions) return reply.code(501).send({ error: 'this server writes no plans' })
      const b = req.body ?? {}
      const key = typeof b.key === 'string' ? b.key : ''
      const verb = typeof b.verb === 'string' ? b.verb : ''
      if (key === '' || !(TASK_VERBS as readonly string[]).includes(verb))
        return reply.code(400).send({ error: `send {key, verb} — verb one of ${TASK_VERBS.join(', ')}` })
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
      // what the owner saw rides with the verbs that judge it (F4)
      if ((verb === 'answer' || verb === 'approve') && typeof b.asked !== 'string')
        return reply.code(400).send({ error: `${verb} sends {asked}: the question you saw ('' when it asked none)` })
      if ((verb === 'done' || verb === 'drop') && (typeof b.state !== 'string' || b.state.trim() === ''))
        return reply.code(400).send({ error: `${verb} sends {state}: the state you saw` })
      const found = findTask({ key })
      if (!('t' in found)) {
        if (found.code === 404 && siloActions.rotatedOut(PLANS_SILO, key))
          return reply.code(404).send({ error: 'it rotated out to plans/closed/ with its month — it is read only there; more work on it is a new task' })
        return reply.code(found.code).send(found.body)
      }
      if (verb === 'hand') return handTask(found.t, b, reply)
      const args: TaskGestureArgs = {}
      for (const f of ['text', 'asked', 'state', 'until', 'day', 'dep'] as const) {
        const v = str(b[f])
        if (v !== undefined) args[f] = v
      }
      const r = siloActions.taskGesture(PLANS_SILO, found.t.key, verb as TaskVerb, args)
      if (r.ok && !r.value.already) {
        try {
          taskMode.look()
        } catch {
          /* the tick looks again */
        }
      }
      if (!r.ok) return reply.code(r.code).send({ error: r.reason, ...(r.detail !== undefined ? { detail: r.detail } : {}) })
      const nowReady = r.value.nowReady
        ? withWakes(r.value.nowReady, {
            inPlay: (a) => registry.list().some((x) => x.id === a),
            wakes: (a: string) => wakesOfControl(taskMode.isBound(a) ? 'own' : 'told'),
          })
        : undefined
      return { ...r.value, ...(nowReady ? { nowReady } : {}) }
    })

    // POST /api/tasks/new {folder, plan, title, owner, details?, session?,
    // give?} — a new task in ONE request:
    // the project's list made first when `plan` is it (ensure, with its
    // rotation — the only step outside the one write); a named plan must
    // exist (404). Then ONE write (siloActions.newTask): the id the SERVER
    // assigns from the raw file, the owner's birth stamp (initiative
    // prepareTask, inside the write — refused: nothing registered), the
    // details as its first note, born with it (they wake nobody on a save
    // without Give: D18b), and with `session` that conversation listed and
    // the task in progress (ownerLink's claim, with its warning). `owner`:
    // you, or an agent in play whose territory holds `folder`. With `give`
    // the owner's gesture follows (giveOf). The owner's only (C13a).
    // Answer: {key, ref, id, title, warn?, assign?}.
    app.post<{ Body: Record<string, unknown> | null }>('/api/tasks/new', async (req, reply) => {
      if (!ownerOnly(req)) return reply.code(403).send({ error: "a new task through Silos is the owner's gesture — an agent writes its plan (append-item)" })
      if (!siloActions) return reply.code(501).send({ error: 'this server writes no plans' })
      const b = req.body ?? {}
      const folder = typeof b.folder === 'string' && b.folder.startsWith('/') ? b.folder.replace(/\/+$/, '') : ''
      const plan = typeof b.plan === 'string' ? b.plan.trim() : ''
      const title = typeof b.title === 'string' ? b.title.trim() : ''
      const owner = typeof b.owner === 'string' ? b.owner.trim() : ''
      if (folder === '' || plan === '' || title === '' || owner === '')
        return reply.code(400).send({ error: 'send {folder, plan, title, owner, details?, session?, give?}' })
      if (b.details !== undefined && b.details !== null && typeof b.details !== 'string') return reply.code(400).send({ error: 'details must be text' })
      if (b.give !== undefined && typeof b.give !== 'boolean') return reply.code(400).send({ error: 'give must be true or false' })
      const askedSession = typeof b.session === 'string' && b.session.trim() !== '' ? b.session.trim() : null
      if (askedSession !== null && !CLAIM_SESSION_ID.test(askedSession)) return reply.code(400).send({ error: 'session must be a conversation id' })
      if (owner !== 'owner') {
        const agent = registry.get(owner)
        if (!agent) return reply.code(400).send({ error: `${owner} is no agent here — a task is born yours or an agent's` })
        if (!mayOwnIn(owner, folder))
          return reply
            .code(409)
            .send({
              error: agent.archived
                ? `${agent.name} is archived — give it to an agent in play`
                : agent.folder
                  ? `${agent.name} does not work in ${basename(folder)} — give it that folder first (its Profile › Runs on)`
                  : `${agent.name} has no folder — it can't work a task in a project`,
            })
      }
      const pm = siloRegistry?.get(PLANS_SILO)?.manifest as Record<string, unknown> | null | undefined
      const standing = pm ? standingIdsOf(pm, 'plan') : new Set<string>()
      let planKey = `folder:${folder}/${plan}`
      if (standing.has(plan)) {
        const e = siloActions.ensureRecord(PLANS_SILO, `folder:${folder}`, plan)
        if (!e.ok) return reply.code(e.code).send({ error: e.reason })
        planKey = e.value.key
      }
      const session = askedSession !== null ? storedId(askedSession) : null
      const initiative = initiativeNow()
      const r = siloActions.newTask(PLANS_SILO, planKey, {
        title,
        owner,
        details: typeof b.details === 'string' ? b.details : null,
        session,
        ...(initiative
          ? {
              prepare: (k: string, values: Record<string, unknown>) => {
                const p = initiative.prepareTask({ owner: true }, k, values)
                return p.ok ? { ok: true as const, values: p.values, undo: p.undo } : { ok: false as const, code: p.code, error: p.error }
              },
            }
          : {}),
      })
      if (!r.ok)
        return reply
          .code(r.code === 404 && !standing.has(plan) ? 404 : r.code)
          .send({ error: r.code === 404 && !standing.has(plan) ? `no plan «${plan}» in ${basename(folder)}` : r.reason })
      invalidateTaskThreads?.()
      refreshPlans?.()
      const key = r.value.key
      const t = taskMode.tasks().find((x) => x.key === key)
      // the link's warning (the claim's words): a conversation of ANOTHER agent's
      const facts = session !== null ? sessionFacts(session, [mungePath(folder)]) : null
      const warn = t && facts ? linkWarn(t, { linked: facts.known, whose: facts.known ? facts.whose : null }, { author: 'owner', agentId: undefined }) : {}
      const assign = b.give === true ? giveOf(key, owner) : undefined
      try {
        taskMode.look()
      } catch {
        /* the tick looks again */
      }
      return { ok: true, key, id: r.value.id, ref: t?.ref ?? `${plan}#${r.value.id}`, title, ...warn, ...(assign ? { assign } : {}) }
    })

    // ── agent ↔ agent asks (B2, H1–H11 — task-asks.ts) ──
    // POST /api/tasks/ask {key | plan+task(+folder), to, action, asked?,
    // review?, turn} — the bearer of the task's OWNER asks another agent
    // through Silos: ONE fact in Task mode's store and the plain wait of
    // today in the file (blocked, or in_review with `review`). The request
    // wakes nobody; the answer says whether `to` sees it by itself (its next
    // heartbeat in reach) or the owner relays it. Another's task: 403. The
    // owner's credential: 403 naming the owner's own verb (H11).
    // POST /api/tasks/ask/answer {key | plan+task(+folder), text, turn} — the
    // bearer of the agent ASKED: the note, the wait out, the state in ONE
    // write, judged on the file read now; then the fact is consumed and a
    // bound owner is woken (`answered`). Asked twice: 409.
    const taskAsks = ctx.taskAsks
    if (taskAsks) {
      app.post<{ Body: (TaskBody & { to?: unknown; action?: unknown; asked?: unknown; review?: unknown }) | null }>('/api/tasks/ask', async (req, reply) => {
        if (req.agentId === undefined) return reply.code(403).send({ error: OWNER_ASKS_WORDS })
        const b = req.body ?? {}
        const found = findTask(b, { agentId: req.agentId, ...boundOf(req) })
        if (!('t' in found)) return reply.code(found.code).send(found.body)
        const r = taskAsks.ask({
          agentId: req.agentId,
          turn: (req as unknown as { turn?: LiveTurn }).turn ?? null,
          key: found.t.key,
          to: b.to,
          action: b.action,
          asked: b.asked,
          review: b.review,
        })
        if (!r.ok) return reply.code(r.code).send({ error: r.error })
        return { ok: true, ...r.value }
      })
      app.post<{ Body: (TaskBody & { text?: unknown }) | null }>('/api/tasks/ask/answer', async (req, reply) => {
        if (req.agentId === undefined) return reply.code(403).send({ error: OWNER_ANSWERS_WORDS })
        const b = req.body ?? {}
        const found = findTask(b, { agentId: req.agentId, ...boundOf(req) })
        if (!('t' in found)) return reply.code(found.code).send(found.body)
        const r = taskAsks.answer({ agentId: req.agentId, turn: (req as unknown as { turn?: LiveTurn }).turn ?? null, key: found.t.key, text: b.text })
        if (!r.ok) return reply.code(r.code).send({ error: r.error })
        return { ok: true, ...r.value }
      })
      // GET /api/agents/<self>/asks — what other agents asked it through
      // Silos, linked and open (H7): what inbox.py lists at a start. Its own
      // only (the read allow-list keeps a bearer under /api/agents/<self>);
      // the owner reads anyone's.
      app.get<{ Params: { id: string } }>('/api/agents/:id/asks', async (req, reply) => {
        const id = req.params.id
        if (!registry.list(true).some((a) => a.id === id)) return reply.code(404).send({ error: 'agent not found' })
        if (req.agentId !== undefined && req.agentId !== id) return reply.code(403).send({ error: `agent ${req.agentId} may not read ${id}'s asks` })
        return { asks: taskAsks.asksTo(id) }
      })
    }

    // POST /api/tasks/assign {key | plan+task, turn?} — Give / «Start X ›»
    // The OWNER's assign is a gesture
    // (ownerGesture: it skips the day's ceiling and the throttle, never the
    // live caps — it is queued there, ahead of what Silos inferred). An
    // agent's BEARER starts only ITS OWN task (t.owner === self, whoever gave
    // it), only On its own, through the same pipe under the ceiling and the
    // throttle — a gesture never comes from a bearer.
    // The task is named as claim and release name it — {key}, or {plan, task}
    // (the ref an agent is shown, `<plan>#<id>`, split at the #): ONE
    // resolver, findTask (review D3).
    app.post<{ Body: TaskBody | null }>('/api/tasks/assign', async (req, reply) => {
      const found = findTask(req.body ?? {}, { ...(req.agentId !== undefined ? { agentId: req.agentId } : {}), ...boundOf(req) })
      if ('code' in found) return reply.code(found.code).send(found.body)
      const t = found.t
      const key = t.key
      if (req.agentId !== undefined) {
        if (t.owner !== req.agentId) {
          const other = registry.get(t.owner)
          const why =
            other && mayName(req.agentId, other.id, registry.list(true)) && other.id !== MASTER_ID
              ? `${t.ref} is ${other.name}'s task, not yours — message its owner (POST /api/agents/${other.id}/messages)`
              : t.owner === 'owner' || t.owner === ''
                ? `${t.ref} is the owner's task, not yours — leave a note on it`
                : `${t.ref} is ${t.owner}'s task, not yours — leave a note on it`
          return reply.code(403).send({ error: why })
        }
        if (!taskMode.isBound(req.agentId)) {
          return reply
            .code(409)
            .send({
              error: 'You are Only when told: the owner starts your tasks — claim it to work it here with them, or leave it pending and say so in a note',
            })
        }
        // what appeared outside Silos is no order: unknown,
        // absent from the registries or still provisional ⇒ 409 — with its own
        // truth when the provisional attribution is the CALLER's turn (M6-r6)
        const gate = initiativeNow()?.assignRefusal(key, (req as unknown as { turn?: LiveTurn }).turn ?? null)
        if (gate) return reply.code(gate.code).send({ error: gate.error })
        return { ...taskMode.assign(key, Date.now(), { ownerGesture: false }), wakes: 'task' as const }
      }
      // the owner's Give blesses what appeared outside Silos (G3-product)
      initiativeNow()?.bless(key, 'give')
      const agent = registry.get(t.owner)
      if (!agent || agent.archived) return { queued: false, why: `${t.owner || 'nobody'} is not an agent in play — a person's task is theirs to do` }
      if (!taskMode.isBound(agent.id)) return { queued: false, wakes: 'never' as const, why: `${agent.name} waits for you — open its console on it` }
      return { ...taskMode.assign(key, Date.now(), { ownerGesture: true }), wakes: 'task' as const }
    })

    // GET /api/task-mode/today?agent=<id> — what one agent's task wakes did
    // today (MovesControl's «Woke N times today · ~$X · ceiling C ›», E6):
    // TaskModeEngine.today. Without `agent`: every agent bound to Task mode.
    // Owner-only (not in agent-authz's read allow-list).
    app.get<{ Querystring: { agent?: string } }>('/api/task-mode/today', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: "the wake log is the owner's" })
      const id = typeof req.query.agent === 'string' && req.query.agent !== '' ? req.query.agent : null
      if (id !== null) {
        if (!registry.get(id)) return reply.code(404).send({ error: `no agent «${id}»` })
        return taskMode.today(id)
      }
      return { agents: [...taskMode.boundAgents()].map((a) => taskMode.today(a)) }
    })

    // POST /api/tasks/work {key, theme?, instead?} — the task's door. With
    // `instead` (a conversation current on the task — the column's
    // «Continue in a new conversation ›»): ALWAYS a new conversation
    // of the task's agent, briefed from the task like any new one, linked
    // through ownerLink FIRST and only then the old one released — with the
    // new thread current the release never disposes, so the task's status
    // is the one the link leaves (the owner's gesture: no running-turn
    // refusal, the old conversation keeps its process). Owner-only.
    app.post<{ Body: { key?: unknown; theme?: unknown; instead?: unknown } | null }>('/api/tasks/work', async (req, reply) => {
      const key = typeof req.body?.key === 'string' ? req.body.key : ''
      if (!key) return reply.code(400).send({ error: 'send {key}' })
      const theme = req.body?.theme === 'light' ? ('light' as const) : undefined
      const insteadAsked = req.body?.instead
      if (insteadAsked !== undefined && insteadAsked !== null && (typeof insteadAsked !== 'string' || !CLAIM_SESSION_ID.test(insteadAsked.trim())))
        return reply.code(400).send({ error: 'instead must be a conversation id — or omit it' })
      const instead = typeof insteadAsked === 'string' ? storedId(insteadAsked.trim()) : null
      if (instead !== null && req.agentId !== undefined)
        return reply.code(403).send({ error: "continuing a task in a new conversation is the owner's gesture" })
      const w = taskMode.work(key)
      if (!w) return reply.code(404).send({ error: 'no such task in the plans Silos reads' })
      if (instead !== null) {
        if (!siloActions) return reply.code(501).send({ error: 'this server writes no plans' })
        const { threads } = threadsNow()
        const mine = threads.threadKey(instead)
        if (!w.task.current.some((id) => threads.threadKey(id) === mine))
          return reply.code(409).send({ error: `this conversation is not on ${w.task.ref} — nothing to continue` })
      }
      const agent = registry.get(w.task.owner)
      if (!agent) return reply.code(409).send({ error: `${w.task.owner || 'nobody'} is not an agent — a person's task is theirs to do`, notAgent: true })
      if (agent.archived) return reply.code(409).send({ error: `no agent «${w.task.owner}» in play` })
      if (agent.folder === null) return reply.code(409).send({ error: `${agent.name} has no folder — cannot open its console` })
      // (R3) an agent of another project is never opened on this one's task
      if (w.task.ownerOutside === true) return reply.code(409).send({ error: outsideWords(agent.name) })
      // a turn running in ITS current thread (a wake, a chat turn, the chat
      // door): nothing is opened over it — said, with the conversation to
      // open; a RUN working it (an automation's, a nested one) is read-only.
      // Only this agent's conversations hold it (t2's owner-filtered busy).
      const { running } = instead !== null ? { running: null } : threadOf(agent.id, w.task.current)
      if (running?.readOnly) return reply.code(409).send({ readOnly: true, error: running.error, sessionId: running.sessionId, folder: running.folder })
      if (running)
        return reply
          .code(409)
          .send({
            error: `a turn is running in ${agent.name}'s conversation on this task — open it; your words land there`,
            running: true,
            sessionId: running.sessionId,
            folder: running.folder,
          })
      const input: ConsoleOpenInput = { ...(theme ? { theme } : {}), pick: '', modelPick: '', pinPicks: () => {}, prompt: w.briefing }
      try {
        const { metas, threads } = threadsNow()
        // the (agent, task) conversation: the newest CONTINUABLE of ITS
        // conversations in the task's current thread (task-threads.ts, the
        // rule the engine's wakes and the feed read too) — never a run's
        // transcript; none → a new conversation
        const conv = instead !== null ? null : threads.tipOf(agent.id, w.task.current)
        let meta = conv ? metas.find((m) => m.id === conv.sessionId) : undefined
        // the recent-tip guard, on the neutral route (R5 point 6): an
        // ancestor arriving here resumes its thread's tip
        if (meta && lineage) {
          const tipKey = recentTipOf({ lineage, threadRootKey }, metas, meta)
          const tipMeta = tipKey !== `${meta.folder}/${meta.id}` ? metas.find((m) => `${m.folder}/${m.id}` === tipKey) : undefined
          if (tipMeta && transcriptOnly(tipMeta) === null) meta = tipMeta
        }
        if (meta) {
          const sid = meta.id
          const h = harnessForId(sid)
          const refusedEngine = await consoleRefusal(h, meta)
          if (refusedEngine) return reply.code(409).send(refusedEngine)
          const r = await (hooks(h).openSession ?? ((x, m, i) => genericOpenSession(hookContext(h), harnessById(h), x, m, i)))(sid, meta, input)
          if (r.code !== 201) return reply.code(r.code).send(r.body)
          const briefed = (r.body as { briefed?: unknown }).briefed === true
          if (briefed) taskMode.markWorked(w.folded, sid)
          // the owner opened it to work the task: linked (and claimed when it
          // was pending) — the resumed branch wrote nothing before (E3)
          const link = ownerLink(w.task, sid)
          return {
            mode: 'resumed',
            folder: meta.folder,
            sessionId: sid,
            consoleKey: (r.body as { key: string }).key,
            briefed,
            linked: link.ok && link.linked,
            ...(link.ok ? { state: link.state, ...(link.warn !== undefined ? { warn: link.warn } : {}) } : { linkError: link.reason }),
            ...(briefed
              ? {}
              : {
                  why:
                    harnessById(h).traits.consoleBriefing === true
                      ? 'its console was already open — nothing was typed into it'
                      : `${harnessById(h).label} opens without the briefing — tell it the task`,
                }),
          }
        }
        const h = harnessOf(agent)
        const refusedEngine = await consoleRefusal(h)
        if (refusedEngine) return reply.code(409).send(refusedEngine)
        const r = await (hooks(h).openNew ?? ((a, i) => genericOpenNew(hookContext(h), harnessById(h), a, i)))(agent as Agent & { folder: string }, input)
        if (r.code !== 201) return reply.code(r.code).send(r.body)
        const consoleKey = (r.body as { key: string }).key
        const briefed = (r.body as { briefed?: unknown }).briefed === true
        // the conversation joins the task at once (Silos chose its id) — as
        // its native id when the engine sealed one already (R3) — through
        // ownerLink: a pending task goes in_progress in the same write (E3)
        const link = ownerLink(w.task, consoleKey)
        if (briefed) taskMode.markWorked(w.folded, consoleKey)
        // «Continue in a new conversation»: the old one lets go only once the
        // new one holds the task — a refused link releases nothing
        let released: { released: boolean; releaseError?: string } | null = null
        if (instead !== null && link.ok) {
          const r = siloActions!.appendRelease(PLANS_SILO, w.task.key, instead, true, { by: 'owner', actor: {} })
          invalidateTaskThreads?.()
          released = r.ok ? { released: true } : { released: false, releaseError: r.reason }
        }
        return {
          ...(released ?? {}),
          ...(instead !== null ? { instead } : {}),
          mode: 'new',
          folder: mungePath(agent.folder),
          sessionId: consoleKey,
          consoleKey,
          briefed,
          linked: link.ok && link.linked,
          ...(link.ok ? { state: link.state, ...(link.warn !== undefined ? { warn: link.warn } : {}) } : { linkError: link.reason }),
          ...(briefed ? {} : { why: `${harnessById(h).label} opens without a first prompt — tell it the task` }),
        }
      } catch (err) {
        if (err instanceof ConsoleHeldError)
          return reply.code(409).send({ error: `${err.message} — close it to work the task here`, holders: err.holders, canClose: true })
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  // Closing a console is an explicit act (the durable-by-default tmux never
  // dies on its own): kills the background `claude` AND its tmux session.
  // The conversation itself lives in the JSONL — reopening the console
  // resumes it, so this only reclaims the process, never the history.
  // The console's own scrollbar (the web's ConsoleScrollbar): where tmux's
  // view stands, and moving it — `position` = rows above the bottom, 0 =
  // live. Read after each scroll gesture, written while the thumb is dragged.
  app.get<{ Params: { key: string } }>('/api/console/:key/scroll', async (req, reply) => {
    try {
      return await terminals.consoleScroll(req.params.key)
    } catch {
      return reply.code(404).send({ error: 'console not open' })
    }
  })
  app.post<{ Params: { key: string }; Body: { position?: unknown } }>('/api/console/:key/scroll', async (req, reply) => {
    const position = req.body?.position
    if (typeof position !== 'number' || !Number.isFinite(position)) return reply.code(400).send({ error: 'position must be a number' })
    try {
      return await terminals.consoleScrollTo(req.params.key, position)
    } catch {
      return reply.code(404).send({ error: 'console not open' })
    }
  })

  // The send route's cap: a prompt, not a file dump (and well under argv limits).
  const SEND_TEXT_MAX_BYTES = 100 * 1024
  // Hand a prompt to a running console — ONE route, the server picks the
  // way in: the harness its Silos-owned record names, when that harness has
  // its own (Harness.server sendText — OpenCode's TUI over its HTTP API).
  // Any other console gets tmux keystrokes: the text LITERALLY (`-l`, so a
  // prompt that is a key name is typed), then Enter — unless its screen
  // shows a dialog (409 { dialog }: that Enter would pick an option). `:key`
  // may be the console key or the ses_ id the registrar bound to it.
  // Owner-only (not in agent-authz's write allow-list).
  app.post<{ Params: { key: string }; Body: { text?: unknown } }>('/api/console/:key/send', async (req, reply) => {
    const text = req.body?.text
    if (typeof text !== 'string' || text === '') return reply.code(400).send({ error: 'text must be a non-empty string' })
    if (Buffer.byteLength(text, 'utf8') > SEND_TEXT_MAX_BYTES) return reply.code(413).send({ error: 'text is over 100 KB' })
    const key = terminals.keyOfNativeId(req.params.key) ?? req.params.key
    const rec = terminals.consoleRecord(key)
    const sendText = rec ? hooks(rec.harness).sendText : undefined
    if (rec && sendText) {
      const r = await sendText(key, rec, text)
      return reply.code(r.code).send(r.body)
    }
    // 404 only when tmux SAYS there is no console; a probe that failed goes
    // on to the send, whose own guard answers 503 (ConsoleUnknownError)
    if (!(await terminals.hasConsole(key)) && (await terminals.consoleState(key)) === 'gone') return reply.code(404).send({ error: 'console not open' })
    try {
      await terminals.consoleSendLiteral(key, text)
    } catch (e) {
      if (e instanceof ConsoleUnknownError) return reply.code(503).send({ error: e.message, retry: true })
      // the console shows a dialog: its Enter would have answered it — the
      // owner answers it there first (nothing was typed)
      if (e instanceof ConsoleDialogError) return reply.code(409).send({ error: e.message, dialog: e.dialog })
      // gone between the check and the send → 404; anything else (a tmux
      // error, E2BIG) is not a missing console
      if (e instanceof Error && e.message === 'console not open') return reply.code(404).send({ error: 'console not open' })
      return reply.code(502).send({ error: 'the console did not take the prompt' })
    }
    return { ok: true, key, via: 'keys' as const }
  })

  // AndWait (not fire-and-forget): the restart flow re-ensures right after
  // this returns, and a spawn racing the dying claude is the same class of
  // bug the trash route already dodges (the shutdown hook appends to the
  // JSONL — see killConsoleAndWait).
  app.delete<{ Params: { key: string } }>('/api/console/:key', async (req) => {
    await terminals.killConsoleAndWait(req.params.key)
    return { ok: true }
  })
}
