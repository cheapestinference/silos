// routes/agents.ts — the agents' own surface: uploaded context files,
// create/patch/archive/unarchive, the bearer-token rotation, Loaded at
// start, started-with (session and agent), the territory (per agent and
// the global switchboard), the autonomy view and its skills install,
// moved VERBATIM out of server.ts (split by
// domain, behavior unchanged). Engine plumbing (hooks/hookContext) and
// the session vocabulary (validParams) stay in buildServer and arrive
// through the ctx.
import { stat } from 'node:fs/promises'
import { slugify } from '../slug.js'
import { join } from 'node:path'
import { PLUGIN_DIR } from '../repo-paths.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { territoriesOf, appliedPrivatePaths } from '../territory.js'
import { ContainmentError } from '../contained-dir.js'
import type { ProposalsStore } from '../proposals.js'
import { fallbackHarness, fencePermissionFor, fenceSummary, harnessById, harnessForId, harnessOf, isHarnessId } from '../harnesses/registry.js'
import { harnessFieldError, outputStyleError } from '../harnesses/validate.js'
import { MASTER_ID, mungePath } from '../agent-registry.js'
import {
  checkControlTransition,
  checkProactive,
  ControlError,
  heartbeatOf,
  noMissionForOwn,
  parseControlPatch,
  positionOf,
  proactiveAtBirth,
  storedControl,
  storedProactive,
  type ControlPatch,
} from '../control.js'
import { birthFolder, parseBirthProject } from '../birth-project.js'
import { noteControlChange } from '../fleet-events.js'
import { missionHeader } from '../mission.js'
import { validateAgentProviderFields } from '../providers-validate.js'
import { managedFolderOf as managedFolder } from '../managed-folder.js'
import { FileError } from '../file-service.js'
import type { LoadedAtStart, LoadsInventory, StartedWith, StartedWithContext, StartedWithFeed, StartedWithReading } from '../harnesses/contract.js'
import { conversationProblems, folderLoads, wouldLoad } from '../folder-loads.js'
import type { ToolHealthLedger } from '../tool-health.js'
import type { StartProblem } from '../start-health.js'
import { sliceLines } from '../jsonl-lines.js'
import { conversationFilePath, conversationTerritory, type ContextScope } from '../context-service.js'
import { queueContextNews, THREAD_ID_RE } from '../context-news.js'
import type { NativeStore } from '../native-store.js'
import type { ThreadIdOf } from '../task-threads.js'
import type { PlanProgress } from '../plans-floor.js'
import type { ProvidersStore } from '../providers-store.js'
import type { TerminalService } from '../terminal-service.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { Agent, SessionMeta } from '../types.js'
import type { SessionIndex } from '../session-index.js'
import type { SessionOwners } from '../session-owner.js'
import type { SessionOriginsStore } from '../session-origins.js'
import type { ContextService } from '../context-service.js'
import type { CompleteService } from '../complete-service.js'
import type { ChatService } from '../chat-service.js'
import type { AgentStateStore } from '../agent-state.js'
import type { AgentTokens } from '../agent-tokens.js'
import type { TerritoryStore } from '../territory-store.js'
import type { HeartbeatClock } from '../heartbeat.js'
import type { AutomationsStore } from '../automations-store.js'
import type { Resident } from '../resident.js'
import type { NeedsYouAcksStore } from '../needs-you-acks.js'
import type { HarnessId, HarnessServerHooks, ServerHookContext } from '../harnesses/contract.js'
import type { FenceOverlay, FenceScope } from '../territory.js'
import type { VaultStore } from '../vault-store.js'
import { AgentTools, AgentToolError } from '../agent-tools.js'
import { applyStartingSet, projectAgents, startingFacts, startingSetFor, type StartingFacts, type StartingSetDeps } from '../starting-set.js'

type SessionParams = { folder: string; id: string }

export interface AgentRoutesCtx {
  registry: AgentRegistry
  /** the servers' status readings (tool-health.ts): a conversation's own
   *  reading, for its start problems */
  toolHealth?: ToolHealthLedger
  index: SessionIndex
  owners: SessionOwners
  origins: SessionOriginsStore | undefined
  context: ContextService | undefined
  native: NativeStore
  // the one «which conversation is this session?» resolver (task-threads.ts)
  threadIdOf: ThreadIdOf
  complete: CompleteService
  chat: ChatService
  agentState: AgentStateStore | undefined
  agentTokens: AgentTokens | undefined
  territory:
    | { fenceFor(agentId: string): FenceOverlay | null; fenceWhenOn?(agentId: string): FenceOverlay | null; scopeWhenOn?(agentId: string): FenceScope | null }
    | undefined
  territoryStore: TerritoryStore | undefined
  heartbeats: Pick<HeartbeatClock, 'reconcileAgent'> | undefined
  // the flip to Only when told: the queued wakes it supersedes
  // and what still runs — the sheet's facts. Absent: nothing to report.
  flipToTold?: (
    agentId: string,
    name: string,
  ) => { running: Array<{ turnId: string; what: string }>; stillRuns: Array<{ id: string; name: string }>; queued: number }
  // proposals (proposals.ts): the mission editor opened by a mission
  // proposal's «Review ›» saves with its id — the save resolves it
  proposals?: ProposalsStore
  automations: AutomationsStore | undefined
  resident: Resident | undefined
  needsYouAcks: NeedsYouAcksStore | undefined
  pluginSkillsDir: string | undefined
  providers: ProvidersStore | undefined
  terminals: TerminalService
  freshConsoles: Map<string, string>
  classifyAgentId: (m: SessionMeta) => string
  planProgressFor: (agentId: string) => (folder: string) => PlanProgress | null
  validParams: (p: SessionParams, reply: FastifyReply) => boolean
  hooks: (id: HarnessId) => HarnessServerHooks
  hookContext: (id: HarnessId) => ServerHookContext
  broadcast: (msg: unknown) => void
  home: string // the home this server works in (server.ts machineHome)
  dataDir: string | undefined
  /** the machine's managed-settings directory as configured (absent: the engine's default) */
  claudeManagedDir?: string | undefined
  // the Vault: which names an own tool's refs find today (agent-tools.ts `needs`)
  vault?: Pick<VaultStore, 'envFor'> | undefined
  /** the user's starting set (platform-settings.ts) — what a folder's first
   *  agent of an engine sets there (starting-set.ts); absent: Recommended */
  startingSettings?: StartingSetDeps['settings']
  /** (D6) the birth's machine class off (workspace.ts fills it) */
  machineOff?: StartingSetDeps['machineOff']
}

export function agentRoutes(app: FastifyInstance, ctx: AgentRoutesCtx): void {
  const {
    registry,
    index,
    owners,
    origins,
    context,
    native,
    threadIdOf,
    complete,
    agentState,
    agentTokens,
    territory,
    territoryStore,
    heartbeats,
    providers,
    terminals,
    freshConsoles,
    classifyAgentId,
    validParams,
    home,
  } = ctx
  // the heartbeat follows the agent's control and rhythm at once
  // (the heartbeat is reconciled in the same request) — isolated: the agent is saved
  const reconcileBeat = (id: string): void => {
    try {
      heartbeats?.reconcileAgent(id)
    } catch (err) {
      console.warn(`heartbeat: could not reconcile ${id}:`, err)
    }
  }
  // Agent context: files you upload for the agent to READ (under
  // <folder>/context/shared|<id>/). Same error criteria as /api/file. The
  // upload travels as base64 inside the JSON (no multipart dependency);
  // that's why the route raises its bodyLimit (a 25 MB file is ~34 MB in
  // base64).
  if (context) {
    const ctxError = (reply: FastifyReply, err: unknown): FastifyReply => {
      if (err instanceof FileError) return reply.code(err.status).send({ error: err.message })
      return reply.code(500).send({ error: 'could not access context' })
    }
    // resolves the agent and its folder; master (folder null) has no context.
    const folderOf = (id: string): { folder: string } | { empty: true } | null => {
      const a = registry.get(id)
      if (!a) return null
      if (!a.folder) return { empty: true }
      return { folder: a.folder }
    }

    // ONE conversation of this agent, named by any session id of it
    // (conversation files): the server resolves its thread ROOT
    // (threadIdOf — the web never names the folder) and the territory its
    // folder lives in (its cwd when that is one of the agent's folders,
    // else the primary). The session must be this agent's: indexed and
    // owned by it, born by Silos for it (a console before its transcript),
    // or a thread whose folder already sits under this agent's context (a
    // conversation gone from the index — its files are still the owner's).
    type Conv = { thread: string; folder: string; cwd: string }
    const conversationOf = (agentId: string, raw: unknown): Conv | { error: string; code: number } => {
      if (typeof raw !== 'string' || raw === '') return { error: 'conversation required', code: 400 }
      const agent = registry.get(agentId)!
      const lands = territoriesOf(agent)
      const meta = index.metaById?.(raw) ?? index.allSessions().find((m) => m.id === raw) ?? null
      let cwd: string | null = null
      if (meta) {
        if (owners.agentIdOf(meta) !== agentId) return { error: "that conversation is not this agent's", code: 403 }
        cwd = meta.cwd
      } else {
        const bornIn = lands.find((f) => native.get(mungePath(f), raw) !== null)
        if (bornIn !== undefined) {
          if (native.get(mungePath(bornIn), raw)!.agentId !== agentId) return { error: "that conversation is not this agent's", code: 403 }
          cwd = bornIn
        }
      }
      const thread = threadIdOf(raw)
      if (!THREAD_ID_RE.test(thread)) return { error: 'invalid conversation id', code: 400 }
      if (!meta && cwd === null) {
        const holds = lands.find((f) => context.conversationThreads(f, agentId).includes(thread))
        if (holds === undefined) return { error: 'conversation not found', code: 404 }
        return { thread, folder: holds, cwd: holds }
      }
      const folder = conversationTerritory(lands, cwd)
      if (folder === null) return { error: 'the agent has no folder', code: 400 }
      return { thread, folder, cwd: cwd ?? folder }
    }

    app.get<{ Params: { id: string }; Querystring: { conversation?: string } }>('/api/agents/:id/context', async (req, reply) => {
      const r = folderOf(req.params.id)
      if (r === null) return reply.code(404).send({ error: 'agent not found' })
      if ('empty' in r) return { shared: [], agent: [], conversation: [] } // master/Anywhere: no folder, no context
      try {
        const lands = territoriesOf(registry.get(req.params.id)!)
        if (req.query.conversation === undefined) return context.list(lands, req.params.id)
        const c = conversationOf(req.params.id, req.query.conversation)
        if ('error' in c) return reply.code(c.code).send({ error: c.error })
        return { ...context.list(lands, req.params.id, { thread: c.thread }), thread: c.thread }
      } catch (err) {
        return ctxError(reply, err)
      }
    })

    // The agent's Files tab, «Given to conversations»: the threads that hold
    // files (one readdir per territory), each with the conversation it is —
    // a title joined from the index, or `gone` when no indexed session of
    // the agent is on that thread any more. Files are read when one opens
    // (GET …/context?conversation=<thread>).
    app.get<{ Params: { id: string } }>('/api/agents/:id/context/conversations', async (req, reply) => {
      const r = folderOf(req.params.id)
      if (r === null) return reply.code(404).send({ error: 'agent not found' })
      if ('empty' in r) return []
      const agentId = req.params.id
      const threads = new Map<string, string>() // thread → territory
      for (const f of territoriesOf(registry.get(agentId)!)) for (const t of context.conversationThreads(f, agentId)) if (!threads.has(t)) threads.set(t, f)
      if (threads.size === 0) return []
      // the newest indexed session of the agent on each thread — asked only
      // of the sessions that run in one of its territories (a walk per
      // session of the whole machine would hold the event loop)
      const lands = territoriesOf(registry.get(agentId)!).map((f) => mungePath(f))
      const tipOf = new Map<string, SessionMeta>()
      for (const m of index.allSessions()) {
        if (!lands.some((l) => m.folder === l || m.folder.startsWith(`${l}--claude-worktrees-`))) continue
        const t = threads.has(m.id) ? m.id : threadIdOf(m.id)
        if (!threads.has(t) || owners.agentIdOf(m) !== agentId) continue
        const prev = tipOf.get(t)
        if (!prev || m.mtime > prev.mtime) tipOf.set(t, m)
      }
      return [...threads].map(([thread, folder]) => {
        const m = tipOf.get(thread)
        return m
          ? { thread, territory: folder, session: { folder: m.folder, id: m.id, title: m.title, mtime: m.mtime }, gone: false }
          : { thread, territory: folder, session: null, gone: true }
      })
    })

    // What the agent produced in its own state folder ($SILOS_AGENT_STATE).
    // verifiedDir: a read never conjures the folder, and a state dir that is
    // itself a link (into another agent's state) lists nothing.
    app.get<{ Params: { id: string } }>('/api/agents/:id/produced', async (req, reply) => {
      if (!registry.get(req.params.id)) return reply.code(404).send({ error: 'agent not found' })
      if (!agentState) return []
      try {
        return context.produced(agentState.verifiedDir(req.params.id))
      } catch (err) {
        return ctxError(reply, err)
      }
    })

    // what the owner gives a conversation is news to it alone: one queued
    // line, the path it opens from where it runs (context-news.ts)
    const tellConversation = (agentId: string, c: Conv, name: string): void => {
      if (ctx.dataDir === undefined) return
      try {
        queueContextNews(ctx.dataDir, c.thread, conversationFilePath({ id: c.thread, folder: c.folder, cwd: c.cwd }, agentId, name))
      } catch (err) {
        console.warn(`context: could not queue the news of ${name} for ${c.thread}:`, err instanceof Error ? err.message : String(err))
      }
    }
    const SCOPES = new Set(['shared', 'agent', 'conversation'])

    app.post<{ Params: { id: string }; Body: { scope?: string; name?: string; contentBase64?: string; conversation?: string } }>(
      '/api/agents/:id/context',
      { bodyLimit: 40 * 1024 * 1024 },
      async (req, reply) => {
        const r = folderOf(req.params.id)
        if (r === null) return reply.code(404).send({ error: 'agent not found' })
        if ('empty' in r) return reply.code(400).send({ error: 'master agent has no folder for context' })
        const { scope, name, contentBase64 } = req.body ?? {}
        if (typeof scope !== 'string' || !SCOPES.has(scope)) return reply.code(400).send({ error: 'scope must be shared, agent or conversation' })
        if (typeof name !== 'string' || name === '') return reply.code(400).send({ error: 'name required' })
        if (typeof contentBase64 !== 'string') return reply.code(400).send({ error: 'contentBase64 required' })
        let buf: Buffer
        try {
          buf = Buffer.from(contentBase64, 'base64')
        } catch {
          return reply.code(400).send({ error: 'invalid contentBase64' })
        }
        try {
          if (scope === 'conversation') {
            const c = conversationOf(req.params.id, req.body?.conversation)
            if ('error' in c) return reply.code(c.code).send({ error: c.error })
            const saved = context.save(c.folder, 'conversation', req.params.id, name, buf, c.thread)
            tellConversation(req.params.id, c, saved.name)
            return saved
          }
          return context.save(r.folder, scope as ContextScope, req.params.id, name, buf)
        } catch (err) {
          return ctxError(reply, err)
        }
      },
    )

    app.delete<{ Params: { id: string }; Querystring: { scope?: string; name?: string; conversation?: string } }>(
      '/api/agents/:id/context',
      async (req, reply) => {
        const r = folderOf(req.params.id)
        if (r === null) return reply.code(404).send({ error: 'agent not found' })
        if ('empty' in r) return reply.code(400).send({ error: 'master agent has no folder for context' })
        const { scope, name } = req.query
        if (typeof scope !== 'string' || !SCOPES.has(scope)) return reply.code(400).send({ error: 'scope must be shared, agent or conversation' })
        if (typeof name !== 'string' || name === '') return reply.code(400).send({ error: 'name required' })
        try {
          if (scope === 'conversation') {
            const c = conversationOf(req.params.id, req.query.conversation)
            if ('error' in c) return reply.code(c.code).send({ error: c.error })
            context.remove(c.folder, 'conversation', req.params.id, name, c.thread)
            return { ok: true }
          }
          context.remove(r.folder, scope as ContextScope, req.params.id, name)
          return { ok: true }
        } catch (err) {
          return ctxError(reply, err)
        }
      },
    )

    // «Give to the agent»: a conversation's file moves up to the agent's
    // top level (in the territory it lives in) — from then on every
    // conversation of the agent is told it exists. Refused (409) when the
    // agent already has that name. Owner-only, like every context write
    // (agent-authz.ts never lets a bearer POST here).
    app.post<{ Params: { id: string }; Body: { conversation?: string; name?: string } }>('/api/agents/:id/context/promote', async (req, reply) => {
      const r = folderOf(req.params.id)
      if (r === null) return reply.code(404).send({ error: 'agent not found' })
      if ('empty' in r) return reply.code(400).send({ error: 'master agent has no folder for context' })
      const name = req.body?.name
      if (typeof name !== 'string' || name === '') return reply.code(400).send({ error: 'name required' })
      const c = conversationOf(req.params.id, req.body?.conversation)
      if ('error' in c) return reply.code(c.code).send({ error: c.error })
      try {
        return context.promote(c.folder, req.params.id, c.thread, name)
      } catch (err) {
        return ctxError(reply, err)
      }
    })

    // the project page's door to the FOLDER's shared files (the project
    // is the house of what the folder shares): the :folder segment
    // is the folder's exact path, URI-encoded, resolved ONLY onto a
    // managed folder (managed-folder.ts) — never through a member agent
    // whose primary folder is elsewhere. Shared scope only (an agent's own
    // files live on its page). Owner-only, like the skill doors.
    const folderParam = (req: FastifyRequest<{ Params: { folder: string } }>, reply: FastifyReply): string | null => {
      if (req.agentId !== undefined) {
        void reply.code(403).send({ error: `agent ${req.agentId} may not use a folder's context door` })
        return null
      }
      const folder = managedFolder(registry, req.params.folder)
      if (folder === null) {
        void reply.code(404).send({ error: 'unknown folder' })
        return null
      }
      return folder
    }
    app.get<{ Params: { folder: string } }>('/api/folders/:folder/context', async (req, reply) => {
      const folder = folderParam(req, reply)
      if (folder === null) return reply
      try {
        return { shared: context.listShared(folder), agent: [] }
      } catch (err) {
        return ctxError(reply, err)
      }
    })
    app.post<{ Params: { folder: string }; Body: { name?: string; contentBase64?: string } }>(
      '/api/folders/:folder/context',
      { bodyLimit: 40 * 1024 * 1024 },
      async (req, reply) => {
        const folder = folderParam(req, reply)
        if (folder === null) return reply
        const { name, contentBase64 } = req.body ?? {}
        if (typeof name !== 'string' || name === '') return reply.code(400).send({ error: 'name required' })
        if (typeof contentBase64 !== 'string') return reply.code(400).send({ error: 'contentBase64 required' })
        try {
          return context.save(folder, 'shared', '', name, Buffer.from(contentBase64, 'base64'))
        } catch (err) {
          return ctxError(reply, err)
        }
      },
    )
    app.delete<{ Params: { folder: string }; Querystring: { name?: string } }>('/api/folders/:folder/context', async (req, reply) => {
      const folder = folderParam(req, reply)
      if (folder === null) return reply
      const { name } = req.query
      if (typeof name !== 'string' || name === '') return reply.code(400).send({ error: 'name required' })
      try {
        context.remove(folder, 'shared', '', name)
        return { ok: true }
      } catch (err) {
        return ctxError(reply, err)
      }
    })
  }

  const agentErrors = async <T>(reply: FastifyReply, fn: () => T): Promise<{ agent: T } | undefined> => {
    try {
      return { agent: fn() }
    } catch (err) {
      void reply.code(err instanceof ControlError ? err.status : 400).send({ error: String(err instanceof Error ? err.message : err) })
      return undefined
    }
  }

  const birthDeps: StartingSetDeps | null = ctx.startingSettings
    ? { registry, home, settings: ctx.startingSettings, ...(ctx.machineOff ? { machineOff: ctx.machineOff } : {}) }
    : null

  // the New agent form's line: what a new agent of `framework` would start
  // with in `folder` — the set (the user's or Recommended), whether the
  // folder exists, and the agents of that engine it would join (a project
  // already: no birth, it loads what that project loads)
  // `facts=1` (the first run's «At start»): also what you set up on this
  // machine, counted, and what each class's origin sends, named when known
  // — read through the engine's inventory for a folder no agent has yet
  const factsOf = (engine: string, folder: string, classes: ReturnType<typeof startingSetFor>): StartingFacts | null => {
    if (classes.length === 0) return null
    try {
      const read = wouldLoad(
        {
          index,
          registry,
          home,
          ...(ctx.claudeManagedDir ? { managedDir: ctx.claudeManagedDir } : {}),
          ...(agentState ? { agentState } : {}),
          ...(ctx.toolHealth ? { toolHealth: ctx.toolHealth } : {}),
        },
        folder,
        engine,
      )
      return read ? startingFacts(classes, read) : null
    } catch (err) {
      console.warn('starting-set: could not read what a new project would load:', err instanceof Error ? err.message : String(err))
      return null
    }
  }
  app.get<{ Querystring: { folder?: string; framework?: string; facts?: string } }>('/api/starting-set', async (req, reply) => {
    if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read /api/starting-set` })
    const engine = isHarnessId(req.query.framework) ? req.query.framework : fallbackHarness().id
    const raw = typeof req.query.folder === 'string' ? req.query.folder.trim() : ''
    const classes = startingSetFor(engine, ctx.startingSettings)
    const facts = req.query.facts === '1' ? factsOf(engine, raw.startsWith('/') ? raw : join(home, 'Silos', '.new'), classes) : null
    const withFacts = facts ? { facts } : {}
    if (raw === '' || !raw.startsWith('/')) return { engine, classes, exists: false, joins: null, ...withFacts }
    let exists = false
    try {
      exists = (await stat(raw)).isDirectory()
    } catch {
      exists = false
    }
    const there = projectAgents(registry.list(true), engine, raw)
    return {
      engine,
      classes,
      exists,
      joins: there.length > 0 ? { agents: there.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name })) } : null,
      ...withFacts,
    }
  })

  app.post<{ Body: Parameters<AgentRegistry['create']>[0] }>('/api/agents', async (req, reply) => {
    const out = await agentErrors(reply, () => {
      // Providers v1: provider/fallback ids must exist at WRITE time
      // (tolerance for ids deleted later is a read-time concern).
      if (providers) validateAgentProviderFields(req.body, providers, isHarnessId(req.body?.framework) ? req.body.framework : fallbackHarness().id)
      const harnessError = harnessFieldError(req.body)
      if (harnessError) throw new Error(harnessError)
      const style = typeof req.body?.outputStyle === 'string' ? req.body.outputStyle.trim() : ''
      if (style !== '') {
        const styleError = outputStyleError(
          isHarnessId(req.body?.framework) ? req.body.framework : fallbackHarness().id,
          style,
          typeof req.body?.folder === 'string' ? req.body.folder : null,
        )
        if (styleError) throw new Error(styleError)
      }
      // born On its own with a mission, Only when told without; the
      // control fields are the registry's to set at birth, never the body's —
      // except two asks, both the owner's words on the New agent form and
      // Welcome: «told» with a mission (less autonomy: the mission then only
      // describes the job) and «proactive» (the ladder's third rung: On its
      // own with Silos' default limits — it needs a mission like own)
      const asked = (req.body as { control?: unknown } | null)?.control
      const askedTold = asked === 'told'
      const askedProactive = asked === 'proactive'
      const {
        control: _c,
        heartbeat: _h,
        ownTurnsPerDay: _o,
        unattendedSpendPerDay: _u,
        ownExemptDay: _e,
        cut: _cut,
        proactive: _p,
        id: _id,
        project: rawProject,
        ...body
      } = req.body as Parameters<AgentRegistry['create']>[0] & Record<string, unknown>
      // creation without decisions: the id comes from the name
      // (the client no longer sends one); the folder is its project's
      // (birth-project.ts): a new project by name, one Silos knows, or —
      // when none was asked — a new project named like the agent
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const id = slugify(name, 32)
      if (id === '') throw new Error('name is required — use letters or digits')
      if (registry.get(id)) throw new ControlError(409, `an agent called ${name} exists — pick another name`)
      const hasMission = body.mission !== undefined && body.mission !== null
      if (askedProactive && !hasMission) throw new ControlError(409, noMissionForOwn(name))
      const project = parseBirthProject(rawProject)
      const folder = birthFolder({ project, folder: typeof body.folder === 'string' ? body.folder.trim() : '', agentId: id, registry, home })
      const made = registry.create({ ...body, id, name, folder, control: !askedTold && hasMission ? 'own' : 'told' })
      return askedProactive ? registry.update(made.id, proactiveAtBirth(made.id, Date.now())) : made
    })
    // Fenced at birth, first thing after the create —
    // nothing later can leave the agent created-but-unfenced. Settings ›
    // Territory keeps the explicit off; a fence that cannot be turned on
    // leaves a legal unfenced agent — Only when told (decision 2), said in `warn`.
    const fenceWarn = out ? territoryStore?.enableAtBirth(out.agent) : undefined
    if (out && fenceWarn && out.agent.control === 'own') out.agent = registry.update(out.agent.id, { control: 'told' })
    // the folder's first agent of this engine: what the project starts
    // with (starting-set.ts) — never blocks, a folder it can't set is said
    const startWarn = out && birthDeps ? applyStartingSet(birthDeps, out.agent, null) : undefined
    if (out) reconcileBeat(out.agent.id)
    if (out) return reply.code(201).send({ ...out, ...(fenceWarn ? { warn: fenceWarn } : {}), ...(startWarn ? { startWarn } : {}) })
  })
  // An archived agent keeps no bearer (agent-tokens.ts revoke). Isolated:
  // archiving already succeeded, and the auth hook refuses an archived
  // agent's bearer even if the file could not be removed.
  const revokeToken = (id: string): void => {
    try {
      agentTokens?.revoke(id)
    } catch (err) {
      console.warn(`agent-tokens: could not revoke the token of the archived agent ${id}:`, err)
    }
  }
  app.patch<{ Params: { id: string }; Body: Parameters<AgentRegistry['update']>[1] }>('/api/agents/:id', async (req, reply) => {
    const before = registry.get(req.params.id)
    // the folders and engine it had (the registry updates in place): a
    // folder or engine this PATCH gives it may be a project's birth
    const hadFolders = before
      ? { id: before.id, folder: before.folder, folders: [...(before.folders ?? [])], framework: before.framework, archived: before.archived }
      : null
    const storedBefore = before ? storedControl(before) : 'told'
    const positionNow = (a: NonNullable<typeof before>): ReturnType<typeof positionOf> => positionOf(a, territoryStore?.isEnabled(a.id) ?? false)
    const positionBefore = before ? positionNow(before) : null
    // a save from a mission proposal's «Review ›»: the
    // proposal is checked first (pending, this agent's, its input intact)
    // and resolved only once the save succeeded; a save without the
    // mission resolves nothing
    const fromProposal = (req.body as { proposal?: unknown } | null)?.proposal
    if (fromProposal !== undefined) {
      if ((req.body as { mission?: unknown }).mission === undefined) return reply.code(400).send({ error: 'a save from a proposal carries the mission' })
      const r = ctx.proposals
        ? ctx.proposals.reviewable(fromProposal, 'mission', req.params.id)
        : { ok: false as const, code: 400 as const, error: 'invalid proposal id' }
      if (!r.ok) return reply.code(r.code).send({ error: r.error })
      delete (req.body as { proposal?: unknown }).proposal
    }
    let cp: ControlPatch = {}
    const out = await agentErrors(reply, () => {
      // the control fields, in their exact words (control.ts): 400s, then
      // decision 2 and the mission rule on the state this PATCH leaves (409s)
      // a period's `since` and staggered minute are stamped here, against
      // the agent's current one
      cp = parseControlPatch(
        req.body,
        before ? { agentId: before.id, prior: heartbeatOf(before).period, now: Date.now(), proactive: storedProactive(before) } : undefined,
      )
      if (before) {
        const raw = (req.body ?? {}) as Record<string, unknown>
        const missionCleared = raw.mission === null
        const missionAfter = raw.mission === undefined ? !!before.mission : !missionCleared
        checkControlTransition({
          name: before.name,
          storedBefore,
          askedOwn: cp.control === 'own',
          controlAfter: cp.control ?? storedBefore,
          missionAfter,
          missionCleared,
          fenceOn: territoryStore?.isEnabled(before.id) ?? false,
        })
        // proactive: judged on the state this
        // PATCH leaves, only when it names proactive, the heartbeat or the
        // control — «Only when told» clears it in the same write
        if (cp.proactive !== undefined || cp.heartbeat !== undefined || cp.control !== undefined) {
          const controlAfter = cp.control ?? storedBefore
          const proactiveAfter = cp.proactive !== undefined ? cp.proactive !== null : controlAfter === 'told' ? false : storedProactive(before) !== null
          checkProactive({
            name: before.name,
            controlAfter,
            proactiveAfter,
            periodAfter: cp.heartbeat !== undefined ? cp.heartbeat.period : heartbeatOf(before).period,
          })
        }
      }
      if (providers) {
        // the harness the agent runs on — checked against the provider and
        // fallback it will END UP with
        const current = registry.get(req.params.id)
        validateAgentProviderFields(
          req.body,
          providers,
          current ? harnessOf(current) : fallbackHarness().id,
          current
            ? { ...(current.provider !== undefined ? { provider: current.provider } : {}), ...(current.fallback ? { fallback: current.fallback } : {}) }
            : undefined,
        )
      }
      const patched = registry.get(req.params.id)
      const harnessError = harnessFieldError(req.body, patched ? harnessOf(patched) : undefined)
      if (harnessError) throw new Error(harnessError)
      // a style must be one the agent's engine offers for its folder
      const style = typeof req.body?.outputStyle === 'string' ? req.body.outputStyle.trim() : ''
      if (style !== '') {
        const current = registry.get(req.params.id)
        const fw = current?.framework ?? req.body?.framework
        const folder = req.body?.folder !== undefined ? req.body.folder : (current?.folder ?? null)
        const styleError = outputStyleError(isHarnessId(fw) ? fw : fallbackHarness().id, style, typeof folder === 'string' ? folder : null)
        if (styleError) throw new Error(styleError)
      }
      const {
        control: _c,
        heartbeat: _h,
        ownTurnsPerDay: _o,
        unattendedSpendPerDay: _u,
        ownExemptDay: _e,
        cut: _cut,
        proactive: _p,
        ...rest
      } = req.body as Record<string, unknown>
      const updated = registry.update(req.params.id, { ...(rest as Parameters<AgentRegistry['update']>[1]), ...cp })
      if (updated.archived) revokeToken(updated.id)
      return updated
    })
    if (!out) return out
    const startWarn = birthDeps ? applyStartingSet(birthDeps, out.agent, hadFolders) : undefined
    const said = startWarn ? { startWarn } : {}
    if (typeof fromProposal === 'string') ctx.proposals?.resolveReviewed(fromProposal)
    // the fleet's control history (fleet-events.ts): the move this PATCH made
    if (positionBefore !== null) noteControlChange(ctx.dataDir, out.agent.id, positionBefore, positionNow(out.agent))
    reconcileBeat(req.params.id)
    // the flip to Only when told: the queued wakes are
    // superseded NOW, and the sheet hears what still runs
    if (storedBefore === 'own' && out.agent.control === 'told' && ctx.flipToTold) {
      const pending = ctx.flipToTold(out.agent.id, out.agent.name)
      if (pending.running.length > 0 || pending.stillRuns.length > 0 || pending.queued > 0) return { ...out, ...said, pending }
    }
    return { ...out, ...said }
  })
  app.post<{ Params: { id: string } }>('/api/agents/:id/archive', async (req, reply) => {
    let consoles: string[] = []
    const out = await agentErrors(reply, () => {
      const result = registry.archive(req.params.id)
      revokeToken(req.params.id)
      // An archived agent stops thinking: its heartbeat goes with it
      // (reconcile — unarchiving brings it back with its control)
      reconcileBeat(req.params.id)
      // tear down the agent's live consoles — the fresh-conversation one plus
      // one per session — so no orphan claude keeps running for an archived agent.
      // ONE tmux listing for all of them (killConsoles): only the consoles
      // that run cost a tmux call, not one per conversation the agent had
      const keys: string[] = []
      const pending = freshConsoles.get(req.params.id)
      if (pending) {
        keys.push(pending)
        freshConsoles.delete(req.params.id)
      }
      for (const m of index.allSessions()) {
        // an OpenCode session's console may live under the key it was born in
        if (classifyAgentId(m) === req.params.id) keys.push(terminals.keyOfNativeId(m.id) ?? m.id)
      }
      consoles = keys
      return result
    })
    if (out) await terminals.killConsoles(consoles)
    return out
  })
  // Owner-only (an agent bearer is refused by agentMayWrite): mint a new
  // bearer for the agent; the old one stops resolving on the next request.
  // Running sessions keep the old value in their env until restarted.
  if (agentTokens) {
    app.post<{ Params: { id: string } }>('/api/agents/:id/token/rotate', async (req, reply) => {
      if (registry.get(req.params.id) === null) return reply.code(404).send({ error: 'unknown agent' })
      // master included: every agent holds a bearer
      agentTokens.rotate(req.params.id)
      return { rotated: true }
    })
  }

  // Knows & can › Loaded at start: what every session of the agent receives
  // before its first message, read from disk by its ENGINE's own reader
  // (Harness.loadedAtStart — never executes a hook, never writes). null = no
  // folder, or an engine that can't say: the page hides the row rather than
  // show another engine's data. Agents may read their own (/api/agents/<self>/**).
  // A short cache per agent: the walk is bounded but not free.
  const loadedCache = new Map<string, { at: number; value: LoadedAtStart | null }>()
  const LOADED_TTL_MS = 20_000
  // The folder's inventory (folder-loads.ts over Harness.loads): the ONE list
  // of what a folder's conversations load. Loaded at start takes its MCP
  // servers from it, and Started with places each part on its row. Cached
  // as briefly as Loaded at start: the settings layers are read on a miss.
  const inventoryCache = new Map<string, { at: number; inv: Pick<LoadsInventory, 'rows' | 'logins'> }>()
  const inventoryOf = (folder: string): Pick<LoadsInventory, 'rows' | 'logins'> => {
    const hit = inventoryCache.get(folder)
    if (hit && Date.now() - hit.at < LOADED_TTL_MS) return hit.inv
    let inv: Pick<LoadsInventory, 'rows' | 'logins'> = { rows: [], logins: [] }
    try {
      const f = folderLoads(
        { index, registry, home, ...(ctx.claudeManagedDir ? { managedDir: ctx.claudeManagedDir } : {}), ...(agentState ? { agentState } : {}) },
        folder,
      )
      inv = { rows: f.rows, logins: f.logins }
    } catch {
      inv = { rows: [], logins: [] }
    }
    inventoryCache.set(folder, { at: Date.now(), inv })
    while (inventoryCache.size > 64) inventoryCache.delete(inventoryCache.keys().next().value!)
    return inv
  }
  // What loads at start for an agent (cached), or null when its engine can't
  // say. Throws when the engine's reader fails. Shared with Started with.
  const loadedFor = (agent: Agent): LoadedAtStart | null => {
    if (!agent.folder) return null
    let engine
    try {
      engine = harnessById(harnessOf(agent))
    } catch {
      return null
    }
    if (!engine.loadedAtStart) return null
    const hit = loadedCache.get(agent.id)
    if (hit && Date.now() - hit.at < LOADED_TTL_MS) return hit.value
    const mine = index
      .allSessions()
      .filter((m) => classifyAgentId(m) === agent.id)
      .sort((a, b) => b.mtime - a.mtime)
    const recentTranscripts: string[] = []
    // conversations only: an automation run starts isolated (no start
    // hooks), and a nested run is not one of its starts. Its own first; then
    // any other conversation started in the same folder — the start hooks
    // are the folder's and the operator's, not the agent's, so another
    // agent's start there is the same evidence.
    const usable = (m: SessionMeta): boolean => index.hasTranscriptFile(m.id) && !origins?.get(`${m.folder}/${m.id}`) && !owners.nestedOf(m)
    const sameFolder = index
      .allSessions()
      .filter((m) => m.cwd === agent.folder && classifyAgentId(m) !== agent.id)
      .sort((a, b) => b.mtime - a.mtime)
    for (const [list, cap] of [
      [mine, 12],
      [sameFolder, 24],
    ] as const) {
      for (const m of list) {
        if (recentTranscripts.length >= cap) break
        if (!usable(m)) continue
        try {
          recentTranscripts.push(index.pathOf(m.folder, m.id))
        } catch {
          /* no file */
        }
      }
    }
    const seenMcp = new Set<string>()
    for (const m of mine) for (const t of index.getContext(m.folder, m.id)?.tools ?? []) if (t.server) seenMcp.add(t.server)
    let agentStateDir: string | null = null
    try {
      agentStateDir = agentState ? agentState.pathFor(agent.id) : null
    } catch {
      /* unsafe id */
    }
    const loads = engine.loads ? inventoryOf(agent.folder) : undefined
    const value = engine.loadedAtStart({
      agent,
      folder: agent.folder,
      home: home,
      agentStateDir,
      recentTranscripts,
      seenMcpServers: [...seenMcp].sort(),
      ...(loads ? { loads } : {}),
    })
    loadedCache.set(agent.id, { at: Date.now(), value })
    return value
  }
  app.get<{ Params: { id: string } }>('/api/agents/:id/loaded', async (req, reply) => {
    const agent = registry.get(req.params.id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    try {
      return loadedFor(agent)
    } catch (err) {
      return reply.code(500).send({ error: `could not read what loads at start: ${err instanceof Error ? err.message : String(err)}` })
    }
  })

  // The agent's OWN MCP servers (agent-tools.ts): its
  // plugin's .mcp.json (active) and Silos' held twin — the same grammar as
  // a folder's Tools. GET is readable by the agent itself (refs only, never a
  // value; agent-authz allows /api/agents/<self>/…); every write is the
  // owner's. `needs`: refs its Vault does not give it today.
  if (agentState) {
    const tools = new AgentTools(agentState)
    const rowsOf = (agent: Agent) => {
      let names: Set<string> | undefined
      try {
        names = ctx.vault ? new Set(Object.keys(ctx.vault.envFor(agent.id, agent.folder ?? null))) : undefined
      } catch {
        names = undefined
      }
      return { rows: tools.list(agent.id, names) }
    }
    const toolsAgent = (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, write: boolean): Agent | null => {
      if (write && req.agentId !== undefined) {
        void reply.code(403).send({ error: `agent ${req.agentId} may not change an agent's tools — they are the owner's` })
        return null
      }
      const agent = registry.get(req.params.id)
      if (!agent || agent.id === MASTER_ID) {
        void reply.code(404).send({ error: 'agent not found' })
        return null
      }
      return agent
    }
    const toolError = (reply: FastifyReply, err: unknown): FastifyReply => {
      if (err instanceof AgentToolError) return reply.code(err.status).send({ error: err.message })
      if (err instanceof ContainmentError) return reply.code(409).send({ error: err.message })
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
    app.get<{ Params: { id: string } }>('/api/agents/:id/tools', async (req, reply) => {
      const agent = toolsAgent(req, reply, false)
      return agent ? rowsOf(agent) : reply
    })
    app.post<{ Params: { id: string }; Body: { name?: unknown; config?: unknown } | null }>('/api/agents/:id/tools', async (req, reply) => {
      const agent = toolsAgent(req, reply, true)
      if (!agent) return reply
      const name = req.body?.name
      if (typeof name !== 'string') return reply.code(400).send({ error: 'name required' })
      try {
        tools.add(agent.id, agent.name, name, req.body?.config)
      } catch (err) {
        return toolError(reply, err)
      }
      return rowsOf(agent)
    })
    for (const action of ['hold', 'activate'] as const) {
      app.post<{ Params: { id: string }; Body: { name?: unknown } | null }>(`/api/agents/:id/tools/${action}`, async (req, reply) => {
        const agent = toolsAgent(req, reply, true)
        if (!agent) return reply
        const name = req.body?.name
        if (typeof name !== 'string' || name === '' || name.length > 256) return reply.code(400).send({ error: 'name required' })
        try {
          tools[action](agent.id, agent.name, name)
        } catch (err) {
          return toolError(reply, err)
        }
        return rowsOf(agent)
      })
    }
    app.delete<{ Params: { id: string; name: string } }>('/api/agents/:id/tools/:name', async (req, reply) => {
      const agent = toolsAgent(req, reply, true)
      if (!agent) return reply
      try {
        tools.remove(agent.id, agent.name, req.params.name)
      } catch (err) {
        return toolError(reply, err)
      }
      return rowsOf(agent)
    })
  }

  // Started with (scope layers): what ONE conversation started
  // with and carries now, measured from its own transcript by its ENGINE
  // (Harness.startedWith — a pure feed; absent = the engine records no such
  // thing, answered null). Read against today's facts about its agent
  // (charter, what loads at start, the skills catalog). The transcript is
  // FOLLOWED, not re-read (a live conversation's 40 MB transcript once was
  // read and parsed whole, synchronously, on every request — its size moves
  // with every tool call): each conversation keeps its feed and the byte
  // offset fed so far; a request feeds only what was appended, in slices
  // with the event loop released between them (jsonl-lines.ts), and the
  // reading is recomputed only when the file changed (size + mtime). A file
  // that shrank or changed without growing is read again from the start.
  // One read per conversation at a time: concurrent requests (the column,
  // its part rows, the agent's medians) share it. Owner-only:
  // /api/sessions/** is not in an agent's read allow-list (agent-authz.ts).
  const SILOS_PLUGIN_DIR = PLUGIN_DIR
  interface Followed {
    feed: StartedWithFeed
    offset: number
    size: number
    mtimeMs: number
    reading: StartedWithReading | null
  }
  const startedCache = new Map<string, Followed>()
  const startedReads = new Map<string, Promise<StartedWithReading | undefined>>()
  // above the medians' scan (STARTED_SCAN): one medians request never evicts
  // what it is about to read again
  const STARTED_CACHE_MAX = 160
  const startedContextFor = async (agent: Agent | null, meta: SessionMeta): Promise<StartedWithContext> => {
    let loaded: LoadedAtStart | null = null
    let catalogList: { name: string; source?: string }[] = []
    if (agent) {
      try {
        loaded = loadedFor(agent)
      } catch {
        loaded = null
      }
      try {
        catalogList = (await complete.skillsCatalog(agent.id)).map((s) => ({ name: s.name, ...(s.source ? { source: s.source } : {}) }))
      } catch {
        catalogList = []
      }
    }
    // the folder it started in: its inventory places each part on its row
    const where = meta.cwd ?? agent?.folder ?? null
    const loads = where && managedFolder(registry, where) !== null ? inventoryOf(where).rows : []
    return {
      charter: agent?.mission ? missionHeader(agent.mission) : null,
      loaded,
      catalog: catalogList,
      silosPluginDir: SILOS_PLUGIN_DIR,
      projectDir: agent?.folder ?? meta.cwd ?? null,
      ...(loads.length ? { loads } : {}),
    }
  }
  // undefined = the engine can't say (or no transcript file); a reading otherwise
  const startedReadingOf = (meta: SessionMeta, ctxFor?: StartedWithContext): Promise<StartedWithReading | undefined> => {
    const key = `${meta.folder}/${meta.id}`
    const running = startedReads.get(key)
    if (running) return running
    const p = followStarted(key, meta, ctxFor).finally(() => {
      if (startedReads.get(key) === p) startedReads.delete(key)
    })
    startedReads.set(key, p)
    return p
  }
  const followStarted = async (key: string, meta: SessionMeta, ctxFor?: StartedWithContext): Promise<StartedWithReading | undefined> => {
    let engine
    try {
      engine = harnessById(harnessForId(meta.id))
    } catch {
      return undefined
    }
    if (!engine.startedWith || !index.hasTranscriptFile(meta.id)) return undefined
    let path: string
    try {
      path = index.pathOf(meta.folder, meta.id)
    } catch {
      return undefined
    }
    const st = await stat(path).catch(() => null)
    if (!st) return undefined
    const hit = startedCache.get(key)
    if (hit?.reading && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      startedCache.delete(key)
      startedCache.set(key, hit) // most recently read
      return hit.reading
    }
    // grown: go on from the offset; shrunk or rewritten in place: from the start
    const f: Followed =
      hit && st.size >= hit.offset && !(st.size === hit.size && st.mtimeMs !== hit.mtimeMs)
        ? hit
        : { feed: engine.startedWith(), offset: 0, size: 0, mtimeMs: 0, reading: null }
    const agent = registry.get(classifyAgentId(meta))
    const ctx = ctxFor ?? (await startedContextFor(agent, meta))
    try {
      await sliceLines(path, f.offset, st.size, (lines, bytes) => {
        f.feed.feed(lines)
        f.offset += bytes
      })
    } catch {
      return undefined // unreadable now: a followed feed stays consistent (offset = what it was fed)
    }
    f.reading = f.feed.reading(ctx)
    f.size = st.size
    f.mtimeMs = st.mtimeMs
    startedCache.delete(key)
    startedCache.set(key, f)
    while (startedCache.size > STARTED_CACHE_MAX) startedCache.delete(startedCache.keys().next().value!)
    return f.reading
  }
  app.get<{ Params: SessionParams }>('/api/sessions/:folder/:id/started-with', async (req, reply) => {
    if (!validParams(req.params, reply)) return
    const meta = index.getMeta(req.params.folder, req.params.id)
    if (!meta) return reply.code(404).send({ error: 'session not found' })
    const reading = await startedReadingOf(meta)
    if (!reading) return null
    // what went wrong at its start, each on the row of the folder's
    // inventory it lands on: the column's alert opens that row by key
    let problems: StartProblem[] = []
    try {
      const where = meta.cwd ?? null
      problems = conversationProblems(
        {
          index,
          registry,
          home,
          ...(ctx.claudeManagedDir ? { managedDir: ctx.claudeManagedDir } : {}),
          ...(agentState ? { agentState } : {}),
          ...(ctx.toolHealth ? { toolHealth: ctx.toolHealth } : {}),
        },
        { folder: meta.folder, id: meta.id, cwd: where },
        where !== null && managedFolder(registry, where) !== null,
      )
    } catch {
      problems = []
    }
    return { ...reading.summary, problems }
  })
  app.get<{ Params: SessionParams & { key: string } }>('/api/sessions/:folder/:id/started-with/part/:key', async (req, reply) => {
    if (!validParams(req.params, reply)) return
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(req.params.key)) return reply.code(400).send({ error: 'invalid part key' })
    const meta = index.getMeta(req.params.folder, req.params.id)
    if (!meta) return reply.code(404).send({ error: 'session not found' })
    const reading = await startedReadingOf(meta)
    const text = reading && Object.hasOwn(reading.texts, req.params.key) ? reading.texts[req.params.key] : undefined
    if (text === undefined) return reply.code(404).send({ error: 'no such part' })
    return { ref: req.params.key, text }
  })

  // The measured weight of each thing a folder loads (spec tools-origin §3,
  // §6 Weight): the tokens its parts took at the NEWEST measured start in
  // the folder — ONE transcript, read through the same follower as Started
  // with — keyed by the inventory row each part was placed on (its `item`).
  // A plugin's own parts (skill and subagent listing lines, its start hook)
  // sit on its row; its servers on theirs. null: no measured start here.
  // Owner-only like the folder's loads (no agent allow-list names it).
  const WEIGHT_SCAN = 24
  app.get<{ Params: { folder: string } }>('/api/folders/:folder/loads/weight', async (req, reply) => {
    const folder = managedFolder(registry, req.params.folder)
    if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
    const here = index
      .allSessions()
      .filter((m) => m.cwd === folder && !owners.nestedOf(m) && index.hasTranscriptFile(m.id))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, WEIGHT_SCAN)
    for (const m of here) {
      const s = (await startedReadingOf(m))?.summary
      if (!s || !s.measured || s.totalTokens === null) continue
      const items: Record<string, { tokens: number; parts: { kind: string; label: string; tokens: number }[] }> = {}
      for (const p of s.parts) {
        if (!p.item) continue
        const it = (items[p.item] ??= { tokens: 0, parts: [] })
        it.tokens += p.tokens
        it.parts.push({ kind: p.kind, label: p.label, tokens: p.tokens })
      }
      return { folder, at: s.at, conversation: { folder: m.folder, id: m.id }, mode: s.mode, total: s.totalTokens, items }
    }
    return null
  })

  // What a NEW conversation of an agent starts with, per mode:
  // console (entrypoint cli), chat (SDK, started by the owner) and run (an
  // automation's — origin.kind automation), never mixed: over its last 10
  // owned, non-nested, measured conversations of each mode, the median
  // total, the median tokens per owner (0 where a conversation had none),
  // the range and n. Modes with none are absent; no mode at all → null.
  // A bounded walk: at most STARTED_SCAN transcripts, newest first.
  const STARTED_PER_MODE = 10
  const STARTED_SCAN = 120
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
  }
  app.get<{ Params: { id: string } }>('/api/agents/:id/started-with', async (req, reply) => {
    const agent = registry.get(req.params.id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    type Mode = 'console' | 'chat' | 'run'
    const buckets: Record<Mode, { meta: SessionMeta; summary: StartedWith }[]> = { console: [], chat: [], run: [] }
    const mine = index
      .allSessions()
      .filter((m) => classifyAgentId(m) === agent.id && !owners.nestedOf(m) && index.hasTranscriptFile(m.id))
      .sort((a, b) => b.mtime - a.mtime)
    let ctx: StartedWithContext | undefined
    let scanned = 0
    for (const m of mine) {
      if (scanned >= STARTED_SCAN) break
      if (buckets.console.length >= STARTED_PER_MODE && buckets.chat.length >= STARTED_PER_MODE && buckets.run.length >= STARTED_PER_MODE) break
      scanned++
      ctx ??= await startedContextFor(agent, m)
      const reading = await startedReadingOf(m, ctx)
      const s = reading?.summary
      if (!s || !s.measured || s.totalTokens === null) continue
      const mode: Mode | null = origins?.get(`${m.folder}/${m.id}`) ? 'run' : s.mode
      if (!mode || buckets[mode].length >= STARTED_PER_MODE) continue
      buckets[mode].push({ meta: m, summary: s })
    }
    const out: Partial<Record<Mode, unknown>> = {}
    for (const mode of ['console', 'chat', 'run'] as const) {
      const list = buckets[mode]
      if (list.length === 0) continue
      const totals = list.map((x) => x.summary.totalTokens!)
      const ownerNames = [...new Set(list.flatMap((x) => x.summary.parts.map((p) => p.owner)))]
      const owners2: Record<string, number> = {}
      for (const o of ownerNames) {
        owners2[o] = median(list.map((x) => x.summary.parts.filter((p) => p.owner === o).reduce((s, p) => s + p.tokens, 0)))
      }
      out[mode] = {
        n: list.length,
        total: median(totals),
        range: [Math.min(...totals), Math.max(...totals)],
        owners: owners2,
        // the newest measured conversation of the mode: its rows open from there
        latest: { folder: list[0]!.meta.folder, id: list[0]!.meta.id },
      }
    }
    return Object.keys(out).length ? out : null
  })

  // Territory, made visible (Task 10). The agent page's Machinery reads its
  // fence from the SAME adapter both engines launch with — every number is
  // the real overlay, never a re-derivation. Agents may read their own
  // (/api/agents/<self>/** is in their read allow-list), never anyone else's.
  if (territory) {
    app.get<{ Params: { id: string } }>('/api/agents/:id/territory', async (req, reply) => {
      const agent = registry.get(req.params.id)
      if (agent === null) return reply.code(404).send({ error: 'unknown agent' })
      // the fence its launches carry: whole when its territory is on, the
      // two always-on groups (other projects, Silos' credentials) when off
      const fence = territory.fenceFor(agent.id)
      const enabled = territoryStore ? territoryStore.isEnabled(agent.id) : fence !== null
      return {
        // its territory is on — the switch, not «carries rules» (an agent
        // whose territory is off carries the always-on groups)
        fenced: fence !== null && enabled,
        // The rollout gate: false = the owner has not enabled this agent yet.
        enabled: territoryStore ? territoryStore.isEnabled(agent.id) : true,
        territories: territoriesOf(agent),
        // APPLIED, from the overlay: a configured path inside or containing
        // one of this agent's territories is not denied, so it isn't counted.
        privatePaths: appliedPrivatePaths(fence, territoryStore?.privatePaths() ?? [], home).length,
        deny: fence?.permissions.deny.length ?? 0,
        // on-disk entries no rule was written for (a glob character in the
        // name — territory.ts globSkipReason): said, never silently open
        skipped: fence?.skipped ?? [],
        // what the fence covers once on, in places (fenceScope) — the agent
        // page shows it whether or not the fence is on yet
        scope: territory.scopeWhenOn?.(agent.id) ?? null,
      }
    })
  }
  // The owner's private-paths list — Settings › Territory. Owner-only: the
  // agent read/write policy (agent-authz.ts) refuses /api/territory to bearers.
  if (territoryStore) {
    // agents: each fenceable agent (not master, has a folder, not archived —
    // the toggles' set) with the harness it runs on and the tool kinds its
    // fence REALLY denies there — computed from the fence it gets once on
    // (fenceWhenOn) mapped the way that harness's launch maps it
    // (fencePermissionFor → fenceSummary). No fence → []. An agent naming an
    // unknown harness is left out rather than guessed.
    const territoryHome = home
    const territoryAgents = () =>
      registry.list().flatMap((a) => {
        if (a.id === MASTER_ID || !a.folder) return []
        let h: HarnessId
        try {
          h = harnessOf(a)
        } catch {
          return []
        }
        const fence = territory ? (territory.fenceWhenOn ? territory.fenceWhenOn(a.id) : territory.fenceFor(a.id)) : null
        let fenced: string[] = []
        try {
          if (fence) fenced = fenceSummary(fencePermissionFor(h, fence, { worktree: a.folder, home: territoryHome }))
        } catch {
          /* unmappable path: nothing claimed */
        }
        let scope: FenceScope | null = null
        try {
          scope = territory?.scopeWhenOn?.(a.id) ?? null
        } catch {
          /* nothing claimed */
        }
        return [{ id: a.id, harness: h, label: harnessById(h).label, fenced, scope }]
      })
    const territorySettings = () => ({ privatePaths: territoryStore.privatePaths(), enabled: territoryStore.enabled(), agents: territoryAgents() })
    app.get('/api/territory', async () => territorySettings())
    // Either field, or both: privatePaths (the list) and enabled (the agent
    // ids fenced and given a token — the rollout gate). Validated before
    // anything is saved.
    app.put<{ Body: { privatePaths?: unknown; enabled?: unknown } }>('/api/territory', async (req, reply) => {
      const rawPaths = req.body?.privatePaths
      const rawEnabled = req.body?.enabled
      if (rawPaths === undefined && rawEnabled === undefined) return reply.code(400).send({ error: 'privatePaths or enabled is required' })
      if (rawPaths !== undefined && !Array.isArray(rawPaths)) return reply.code(400).send({ error: 'privatePaths must be an array of paths' })
      if (rawEnabled !== undefined && !(Array.isArray(rawEnabled) && rawEnabled.every((x) => typeof x === 'string'))) {
        return reply.code(400).send({ error: 'enabled must be an array of agent ids' })
      }
      let enabled: string[] | null = null
      if (Array.isArray(rawEnabled)) {
        enabled = (rawEnabled as string[]).map((x) => x.trim()).filter((x) => x !== '')
        const unknown = enabled.find((id) => id === MASTER_ID || registry.get(id) === null)
        if (unknown !== undefined) return reply.code(400).send({ error: `not an agent that can be fenced: ${unknown}` })
      }
      try {
        if (Array.isArray(rawPaths)) {
          const paths = rawPaths.map((p) => (typeof p === 'string' ? p.trim() : p)).filter((p) => p !== '')
          territoryStore.setPrivatePaths(paths as string[])
        }
        if (enabled !== null) territoryStore.setEnabled(enabled)
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
      return territorySettings()
    })
  }

  app.post<{ Params: { id: string } }>('/api/agents/:id/unarchive', async (req, reply) => {
    const out = await agentErrors(reply, () => registry.unarchive(req.params.id))
    if (out) reconcileBeat(req.params.id)
    return out
  })

  app.get<{ Params: { id: string }; Querystring: { kind?: string; q?: string } }>('/api/agents/:id/complete', async (req, reply) => {
    const { kind } = req.query
    const q = req.query.q ?? ''
    if (kind !== 'files' && kind !== 'skills') return reply.code(400).send({ error: 'invalid kind' })
    try {
      const items = kind === 'files' ? await complete.files(req.params.id, q) : await complete.skills(req.params.id, q)
      return { items }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      const code = message.includes('not found') ? 404 : 400
      return reply.code(code).send({ error: message })
    }
  })
}
