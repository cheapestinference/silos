// routes/workspace.ts — the workspace odds: the roster (/api/agents),
// the distinct projects seen in the index, muted folders, the UI prefs
// and the per-folder MCP/plugin capability states, moved VERBATIM out of
// server.ts (split by domain, behavior unchanged).
import type { FastifyInstance } from 'fastify'
import { LoadsSwitchError } from '../harnesses/contract.js'
import type { HarnessService } from '../harness.js'
import { managedFolderOf as managedFolder } from '../managed-folder.js'
import {
  folderLoads,
  machineReach,
  projectFolderLoad,
  switchFolderLoad,
  switchFolderOrigin,
  machineHeadsOf,
  switchMachineHeadOf,
  type FolderConversation,
  type FolderLoadsDeps,
} from '../folder-loads.js'
import type { ResolvedProvider } from '../providers-store.js'
import { folderPersonal, switchFolderPersonal } from '../folder-personal.js'
import { folderInstructionPlaces, switchFolderInstruction } from '../folder-instruction-places.js'
import type { FolderInstructionsDeps } from '../folder-instructions.js'
import { bulkFolderLoads, machineOffAtBirth, onlyAgentLoad, undoFolderBulk, undoViews, type BulkAt, type SkillWant } from '../loads-bulk.js'
import type { ToolHealthLedger } from '../tool-health.js'
import { CheckBusy, CheckRefused, type LoadsChecks } from '../loads-check.js'
import type { AgentStateStore } from '../agent-state.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { Agent } from '../types.js'
import type { SessionIndex } from '../session-index.js'
import type { PrefsStore } from '../prefs-store.js'
import type { LoadsScopesStore } from '../loads-scopes.js'
import { OWN_TURNS_PER_DAY, UNATTENDED_SPEND_USD_DAY } from '../limits.js'
import { agentsOf, seesAll, sharedFolders } from '../project-scope.js'
import { firstSentence } from '../mission.js'

/** The places POST …/loads/switch takes as `scope` (spec scopes §9) — a
 *  new place (a conversation's, T5) joins here and in switchFolderLoad. */
const LOADS_SWITCH_SCOPES = ['project', 'machine', 'agent', 'conversation'] as const

export interface WorkspaceRoutesCtx {
  /** (D6) filled here: a project's birth with what you set up on this
   *  machine off — the agents' routes call it (starting-set.ts machineOff) */
  births?: { machineOff?: (folder: string, engine: string) => void }
  registry: AgentRegistry
  index: SessionIndex
  prefs: PrefsStore
  muted: readonly string[]
  claudeManagedDir: string | undefined
  home: string // the home this server works in (server.ts machineHome)
  agentState?: AgentStateStore // the agents' own servers (folder-loads.ts)
  toolHealth?: ToolHealthLedger // the servers' status readings: the rows' health
  checks?: LoadsChecks // «Check now» / «See what it sends» (loads-check.ts)
  harness?: Pick<HarnessService, 'peekCompatibility' | 'compatibility'> // the engines' installed versions (a switch confirmed on a later one is refused)
  // the provider a login (email) runs under — an account row's projected
  // weight is asked on its own login; null/absent: the machine's own
  providerOfLogin?: (login: string | null) => Promise<ResolvedProvider | null>
  loginDirs?: () => string[] // every login's own directory (personal instructions per project)
  // the logins that follow the machine's own settings file, asked to follow
  // it now — what the «This machine» switch answers (who did, who didn't)
  followMachine?: () => { name: string; followed: boolean; why?: string; file?: string }[]
  loadsScopes?: LoadsScopesStore // what one agent or conversation loads, kept by Silos (loads-scopes.ts)
  // what the engines' instruction lists are read with (memory-service.ts):
  // every Memory row's places (spec memory-places T4)
  instructions?: () => FolderInstructionsDeps
  // Silos' held store of a folder's own skill copies (skill-states.ts): a
  // bulk click on Skills moves them out and back at the project's place
  skillStore?: FolderLoadsDeps['skillStore']
  // ONE conversation's place (spec scopes §6): the session the web holds,
  // resolved by the SERVER to its cwd, its thread (threadIdOf — the one
  // resolver its files use), its agent and the thread's sessions in that
  // cwd; null: no conversation the index knows (not started yet, or gone)
  conversationOf?: (sessionId: string) => { cwd: string | null; thread: string; agent: string | null; sessions: string[] } | null
  // the folder's conversations Silos keeps an entry for: a page's «Also … in»
  threadsHere?: (folder: string) => { thread: string; agent: string | null }[]
  // a conversation's thread from its session id (the server's threadIdOf):
  // a holder's readings and its proof are matched by thread, not session
  threadOf?: (sessionId: string) => string | null
  // the DERIVED control of each agent (control.ts controlOf — an `own`
  // without territory or mission operates as told): what the roster says
  // it does on its own right now. Absent: the roster goes bare.
  controlOf?: (agentId: string) => 'told' | 'own'
  // the three positions the switch and the roster's marker show:
  // told · own · proactive — derived
  positionOf?: (agentId: string) => 'told' | 'own' | 'proactive'
}

export function workspaceRoutes(app: FastifyInstance, ctx: WorkspaceRoutesCtx): void {
  const { registry, index, prefs, muted, claudeManagedDir, home, agentState, toolHealth, checks, controlOf, positionOf, loadsScopes } = ctx
  // the defaults an agent without its own knobs has (the web never
  // hard-codes them, P7); `controlNow` = the derived control
  // A bearer is answered its own projects (project-scope.ts): its own record
  // as the owner reads it, then the agents it knows as roster rows — id,
  // name, emoji, the folders they share with it, its mission's first
  // sentence; nothing else of them (no other folder, no «Never» lines, no
  // knobs). `?all=1` (archived too) is the owner's. The owner and the
  // owner's desk (master) read the whole install.
  app.get<{ Querystring: { all?: string } }>('/api/agents', async (req) => {
    const full = (a: Agent) => (controlOf ? { ...a, controlNow: controlOf(a.id), ...(positionOf ? { positionNow: positionOf(a.id) } : {}) } : a)
    if (!seesAll(req.agentId)) {
      const me = registry.get(req.agentId!)
      const rows = me
        ? agentsOf(me, registry.list()).map((a) => ({
            id: a.id,
            name: a.name,
            emoji: a.emoji,
            folders: sharedFolders(me, a),
            ...(a.mission?.text ? { mission: { text: firstSentence(a.mission.text) } } : {}),
          }))
        : []
      return { agents: [...(me ? [full(me)] : []), ...rows], ownTurnsPerDayDefault: OWN_TURNS_PER_DAY, unattendedSpendPerDayDefault: UNATTENDED_SPEND_USD_DAY }
    }
    return {
      agents: registry.list(req.query.all === '1').map(full),
      ownTurnsPerDayDefault: OWN_TURNS_PER_DAY,
      unattendedSpendPerDayDefault: UNATTENDED_SPEND_USD_DAY,
    }
  })

  // Distinct cwds seen in the index, so master can pick one when opening a
  // new chat (autocomplete for "already-used projects").
  app.get('/api/projects', async () => {
    const byCwd = new Map<string, { sessions: number; lastActivity: number }>()
    for (const m of index.allSessions()) {
      if (m.cwd === null) continue
      const entry = byCwd.get(m.cwd) ?? { sessions: 0, lastActivity: 0 }
      entry.sessions += 1
      entry.lastActivity = Math.max(entry.lastActivity, m.mtime)
      byCwd.set(m.cwd, entry)
    }
    const projects = [...byCwd.entries()].map(([cwd, v]) => ({ cwd, ...v })).sort((a, b) => b.lastActivity - a.lastActivity)
    return { projects }
  })

  // Muted folders — informational (see the `muted` comment in ServerDeps
  // above). Returns muted.json's raw keys as-is (the same format
  // mungePath produces over a real path).
  app.get('/api/muted', async () => ({ muted }))

  // UI preferences for the projects menu (~/.silos/ui.json,
  // via PrefsStore) — the Sidebar's manual order/pinned/collapsed.
  // GET is always 200 (a missing file → {}); PATCH validates each field
  // and does a shallow merge (a field absent from the body keeps its value).
  app.get('/api/prefs', async () => prefs.read())

  app.patch<{ Body: Record<string, unknown> }>('/api/prefs', async (req, reply) => {
    if (typeof req.body !== 'object' || req.body === null) return reply.code(400).send({ error: 'invalid body' })
    const b = req.body as Record<string, unknown>
    const projects = b.projects
    const contextOpen = b.contextOpen
    const notifications = b.notifications
    // each engine console's colours ({ <engine id>: 'silos' | 'own' })
    const consoleTheme = b.consoleTheme
    const terminal = b.terminal
    const collapsedAgents = b.collapsedAgents
    const collapsedAutomations = b.collapsedAutomations
    const contextScope = b.contextScope
    const agentOrder = b.agentOrder
    const conversationOrder = b.conversationOrder
    const conversationSlots = b.conversationSlots
    const detachedChains = b.detachedChains
    const setup = b.setup
    const uses = b.uses
    if (
      projects === undefined &&
      contextOpen === undefined &&
      notifications === undefined &&
      consoleTheme === undefined &&
      terminal === undefined &&
      collapsedAgents === undefined &&
      collapsedAutomations === undefined &&
      contextScope === undefined &&
      agentOrder === undefined &&
      conversationOrder === undefined &&
      conversationSlots === undefined &&
      detachedChains === undefined &&
      setup === undefined &&
      uses === undefined
    ) {
      return reply.code(400).send({
        error: `${['projects', 'contextOpen', 'notifications', 'consoleTheme', 'terminal', 'collapsedAgents', 'collapsedAutomations', 'contextScope', 'agentOrder', 'conversationOrder', 'conversationSlots', 'detachedChains', 'setup'].join(', ')}, or uses required`,
      })
    }
    try {
      // Fields can arrive in the same PATCH or separately — each patch*
      // does its own shallow merge over what's already persisted.
      let out = prefs.read()
      if (projects !== undefined) out = prefs.patchProjects(projects)
      if (contextOpen !== undefined) out = prefs.patchContext(contextOpen)
      if (notifications !== undefined) out = prefs.patchNotifications(notifications)
      if (consoleTheme !== undefined) out = prefs.patchConsoleTheme(consoleTheme)
      if (terminal !== undefined) out = prefs.patchTerminal(terminal)
      if (collapsedAgents !== undefined) out = prefs.patchCollapsedAgents(collapsedAgents)
      if (collapsedAutomations !== undefined) out = prefs.patchCollapsedAutomations(collapsedAutomations)
      if (contextScope !== undefined) out = prefs.patchContextScope(contextScope)
      if (agentOrder !== undefined) out = prefs.patchAgentOrder(agentOrder)
      if (conversationOrder !== undefined) out = prefs.patchConversationOrder(conversationOrder)
      if (conversationSlots !== undefined) out = prefs.patchConversationSlots(conversationSlots)
      if (detachedChains !== undefined) out = prefs.patchDetachedChains(detachedChains)
      if (setup !== undefined) out = prefs.patchSetup(setup)
      if (uses !== undefined) out = prefs.patchUses(uses)
      return out
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // What a folder's conversations load at start (folder-loads.ts over each
  // engine's Harness.loads): one row per thing, its origin, whether this
  // project loads it and what decides it — Project › Tools and Agent ›
  // Tools read it; Project › Tools' switches write through the engine's one
  // writer (POST …/loads/switch). Owner-only: an agent bearer is refused by
  // the agent-authz allow-lists (no /api/folders/:folder/loads entry).
  {
    // SECURITY: the :folder segment resolves ONLY onto a managed folder — a
    // registry agent's folder or one of its extra territories (folders[]).
    // Anything else — an unknown path, an ambiguous munge — is 404: these
    // routes never operate on an arbitrary path from the request.
    // The segment is the folder's exact path (URI-encoded by the web), so
    // proj.one and proj-one never collide; the older munged form still
    // resolves when it names exactly one managed folder (managed-folder.ts,
    // shared with the /api/folders/:folder skill routes).
    const managedFolderOf = (param: string): string | null => managedFolder(registry, param)
    const engineVersion = (id: string): string | null => ctx.harness?.peekCompatibility().find((c) => c.harness === id)?.installed ?? null
    const loadsDeps = (folderLogins: string[] = []): FolderLoadsDeps => ({
      index,
      registry,
      home,
      ...(claudeManagedDir ? { managedDir: claudeManagedDir } : {}),
      ...(agentState ? { agentState } : {}),
      ...(toolHealth ? { toolHealth } : {}),
      ...(loadsScopes ? { loadsScopes } : {}),
      ...(ctx.threadsHere ? { threadsHere: ctx.threadsHere } : {}),
      ...(ctx.threadOf ? { threadOf: ctx.threadOf } : {}),
      ...(ctx.loginDirs ? { configDirs: ctx.loginDirs } : {}),
      ...(ctx.skillStore ? { skillStore: ctx.skillStore } : {}),
      engineVersion,
      folderLogins,
    })
    if (ctx.births) ctx.births.machineOff = (folder, engine) => machineOffAtBirth(loadsDeps(), folder, engine)
    // a session the web names → ITS conversation in this folder (the thread
    // the server resolves); null: none — the caller answers 404. A session
    // of another folder, or one the index does not know, is no conversation
    // of this one.
    const conversationIn = (folder: string, sessionId: unknown): FolderConversation | null => {
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !ctx.conversationOf) return null
      const c = ctx.conversationOf(sessionId)
      if (!c || c.cwd !== folder) return null
      return { thread: c.thread, agent: c.agent, sessions: c.sessions }
    }
    // the logins the folder's agents run on: whose lists of what their
    // account sends the rows read (a project with that origin off can't
    // fetch them itself)
    // the logins that follow the machine's file, asked now after a machine
    // write — one that did not is named (its own file unreadable: never clobbered)
    const followed = (): { followed: string[]; missed: { name: string; why: string; file?: string }[] } => {
      let follow: { name: string; followed: boolean; why?: string; file?: string }[] = []
      try {
        follow = ctx.followMachine?.() ?? []
      } catch (err) {
        console.warn('loads: the logins did not follow the machine:', err instanceof Error ? err.message : String(err))
      }
      return {
        followed: follow.filter((f) => f.followed).map((f) => f.name),
        missed: follow.filter((f) => !f.followed).map((f) => ({ name: f.name, why: f.why ?? 'error', ...(f.file ? { file: f.file } : {}) })),
      }
    }
    const loginsOf = async (folder: string): Promise<string[]> => {
      try {
        return (await checks?.logins(folder)) ?? []
      } catch {
        return []
      }
    }
    // `?agent=`: an agent's page (Agent › Tools) — the rows with the
    // machine's, the project's and THAT agent's lines only; an agent that
    // does not have the folder is 404 (an archived one reads: it has no line of its own)
    const agentOfFolder = (raw: unknown, folder: string): string | null | undefined => {
      if (raw === undefined) return undefined
      if (typeof raw !== 'string' || raw === '' || raw.length > 128) return null
      const a = registry.list(true).find((x) => x.id === raw)
      return a && (a.folder === folder || (a.folders ?? []).includes(folder)) ? a.id : null
    }
    app.get<{ Params: { folder: string }; Querystring: { agent?: string; conversation?: string } }>('/api/folders/:folder/loads', async (req, reply) => {
      const folder = managedFolderOf(req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      // `?conversation=<session id>`: the folder's rows as ONE conversation
      // sees them (its column) — its own line with its switch and where its
      // entries stand; no other conversation's entries. A session that is
      // no conversation of this folder is 404.
      if (req.query.conversation !== undefined) {
        if (req.query.agent !== undefined) return reply.code(400).send({ error: 'an agent or a conversation, not both' })
        const conv = conversationIn(folder, req.query.conversation)
        if (!conv) return reply.code(404).send({ error: 'no conversation of this project' })
        const deps = loadsDeps(await loginsOf(folder))
        let undo: ReturnType<typeof undoViews> = []
        try {
          undo = undoViews(deps, folder, [], conv)
        } catch {
          undo = []
        }
        return { ...folderLoads(deps, folder, { conv }), conversation: { thread: conv.thread, agent: conv.agent }, undo }
      }
      const as = agentOfFolder(req.query.agent, folder)
      if (as === null) return reply.code(404).send({ error: 'not an agent of this project' })
      const deps = loadsDeps(await loginsOf(folder))
      // each place's last bulk click that still holds (loads-bulk.ts): the
      // project's, the machine's clicked here, and the page's agents'
      const agents =
        as !== undefined
          ? [as]
          : registry
              .list()
              .filter((a) => a.folder === folder || (a.folders ?? []).includes(folder))
              .map((a) => a.id)
      let undo: ReturnType<typeof undoViews> = []
      try {
        undo = undoViews(deps, folder, agents)
      } catch {
        undo = []
      }
      return { ...folderLoads(deps, folder, as !== undefined ? { as } : {}), undo }
    })
    // «Check now» (loads-check.ts): the logins the folder's agents run on,
    // each with its cost, whether one runs and when it last ran; the POST
    // runs one — on the owner's click only, one at a time per folder (409),
    // bounded by its engine. Owner-only like the rest (agent-authz).
    // `agent` (?agent= / body): «Check now» on an agent's page — that
    // agent's login, started with ITS launch entries, its reading kept as
    // that agent's (loads-check.ts `as`)
    app.get<{ Params: { folder: string }; Querystring: { agent?: string } }>('/api/folders/:folder/loads/check', async (req, reply) => {
      const folder = managedFolderOf(req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      const as = agentOfFolder(req.query.agent, folder)
      if (as === null) return reply.code(404).send({ error: 'not an agent of this project' })
      if (!checks) return { targets: [], running: null }
      return checks.status(folder, as !== undefined ? { as } : {})
    })
    app.post<{ Params: { folder: string }; Body: { provider?: unknown; withoutLocal?: unknown; agent?: unknown } | null }>(
      '/api/folders/:folder/loads/check',
      async (req, reply) => {
        const folder = managedFolderOf(req.params.folder)
        if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
        const as = agentOfFolder(req.body?.agent, folder)
        if (as === null) return reply.code(404).send({ error: 'not an agent of this project' })
        if (!checks) return reply.code(409).send({ error: 'no check here' })
        const provider = req.body?.provider
        if (provider !== undefined && (typeof provider !== 'string' || provider === '' || provider.length > 128))
          return reply.code(400).send({ error: 'provider must be a provider id' })
        if (req.body?.withoutLocal !== undefined && typeof req.body.withoutLocal !== 'boolean')
          return reply.code(400).send({ error: 'withoutLocal must be a boolean' })
        if (as !== undefined && req.body?.withoutLocal === true)
          return reply.code(400).send({ error: 'what an account sends is read for the project, not one agent' })
        try {
          return await checks.run(folder, {
            ...(provider !== undefined ? { provider } : {}),
            ...(req.body?.withoutLocal === true ? { withoutLocal: true } : {}),
            ...(as !== undefined ? { as } : {}),
          })
        } catch (err) {
          if (err instanceof CheckBusy) return reply.code(409).send({ error: err.message })
          if (err instanceof CheckRefused) return reply.code(err.status).send({ error: err.message })
          return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
        }
      },
    )
    // A plugin row this project does not load, opened: what it would add to
    // every start in its engine's own estimate (folder-loads.ts
    // projectFolderLoad → Harness.loads.projected) — bounded, one at a time,
    // kept per plugin version by the engine. A POST: it starts the engine's
    // CLI, so it needs the owner's identity; an agent bearer is refused by
    // the agent-authz allow-lists (no /api/folders/:folder/loads entry).
    app.post<{ Params: { folder: string }; Body: { key?: unknown } | null }>('/api/folders/:folder/loads/projected', async (req, reply) => {
      const folder = managedFolderOf(req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      const key = req.body?.key
      if (typeof key !== 'string' || key === '' || key.length > 1024) return reply.code(400).send({ error: 'key required' })
      // the engines' versions read now (cached briefly): the figure is read
      // only on a version its line was confirmed on
      try {
        await ctx.harness?.compatibility()
      } catch {
        /* not read: nothing shown */
      }
      try {
        return await projectFolderLoad(loadsDeps(), folder, key, async (login) => (ctx.providerOfLogin ? ctx.providerOfLogin(login) : null))
      } catch (err) {
        if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })
    // a row's switch (`key`), or an account origin's head (`origin`: all of
    // what the account sends — plugins or connectors)
    // `scope` (spec scopes §9) — one of the places (LOADS_SWITCH_SCOPES):
    // absent or 'project' — this project's place, today's callers: the
    // folder's own file, or, for an engine that carries the project at
    // launch (OpenCode), what Silos keeps for the folder (loads-scopes.ts);
    // 'machine' — the user's own settings, written ONLY on this click that
    // names it; the answer then says which logins Silos connects followed it
    // and which did not; 'agent' + `agent` — that agent's launch place
    // (loads-scopes.ts), an agent that does not have the folder is 404;
    // 'conversation' + `conversation` (a session id) — that conversation's
    // launch place, kept under the thread the server resolves; a session
    // that is no conversation of this folder is 404
    // An origin's head (spec scopes T8) takes the same places: 'machine'
    // writes only the head's key in the user's own settings, and its «off»
    // is refused unless `confirmed: true` (the owner said yes to its line's
    // sentence); 'agent' only that agent's head entry.
    type SwitchBody = { key?: unknown; origin?: unknown; to?: unknown; scope?: unknown; agent?: unknown; confirmed?: unknown; conversation?: unknown }
    app.post<{ Params: { folder: string }; Body: SwitchBody | null }>('/api/folders/:folder/loads/switch', async (req, reply) => {
      const folder = managedFolderOf(req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      const key = req.body?.key
      const origin = req.body?.origin
      const to = req.body?.to
      const scope = req.body?.scope
      if (origin !== undefined) {
        if (key !== undefined) return reply.code(400).send({ error: 'a key or an origin, not both' })
        if (origin !== 'plugins' && origin !== 'skills' && origin !== 'connectors')
          return reply.code(400).send({ error: "origin must be 'plugins', 'skills' or 'connectors'" })
      } else if (typeof key !== 'string' || key === '' || key.length > 1024) return reply.code(400).send({ error: 'key required' })
      if (to !== 'on' && to !== 'off') return reply.code(400).send({ error: "to must be 'on' or 'off'" })
      const agentId = req.body?.agent
      const conversationId = req.body?.conversation
      if (scope !== undefined && !(LOADS_SWITCH_SCOPES as readonly unknown[]).includes(scope))
        return reply.code(400).send({ error: `scope must be ${LOADS_SWITCH_SCOPES.map((x) => `'${x}'`).join(', ')}` })
      const confirmed = req.body?.confirmed
      if (confirmed !== undefined && typeof confirmed !== 'boolean') return reply.code(400).send({ error: 'confirmed must be a boolean' })
      if (scope === 'agent') {
        if (typeof agentId !== 'string' || agentId === '' || agentId.length > 128) return reply.code(400).send({ error: 'agent required with scope agent' })
      } else if (agentId !== undefined) return reply.code(400).send({ error: 'an agent goes with scope agent' })
      let conv: FolderConversation | null = null
      if (scope === 'conversation') {
        if (origin !== undefined) return reply.code(400).send({ error: 'an origin switches for this project only, for now' })
        if (typeof conversationId !== 'string' || conversationId === '') return reply.code(400).send({ error: 'conversation required with scope conversation' })
        conv = conversationIn(folder, conversationId)
        if (!conv) return reply.code(404).send({ error: 'no conversation of this project' })
      } else if (conversationId !== undefined) return reply.code(400).send({ error: 'a conversation goes with scope conversation' })
      // the engines' versions read now (cached briefly): a switch confirmed
      // on a later engine than the installed one is refused
      try {
        await ctx.harness?.compatibility()
      } catch {
        /* not read: no gate */
      }
      try {
        const deps = loadsDeps(await loginsOf(folder))
        if (origin === 'plugins' || origin === 'skills' || origin === 'connectors') {
          switchFolderOrigin(
            deps,
            folder,
            origin,
            to,
            scope === 'machine'
              ? { scope: 'machine', confirmed: confirmed === true }
              : scope === 'agent'
                ? { scope: 'agent', agent: agentId as string }
                : undefined,
          )
        } else if (scope === 'machine') switchFolderLoad(deps, folder, key as string, to, { scope: 'machine' })
        else
          switchFolderLoad(
            deps,
            folder,
            key as string,
            to,
            scope === 'agent' ? { scope: 'agent', agent: agentId as string } : conv ? { scope: 'conversation', conversation: conv } : undefined,
          )
      } catch (err) {
        if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      }
      if (scope === 'machine') return { folder, ok: true, logins: followed() }
      // the screen reads the rows again (GET …/loads)
      return { folder, ok: true }
    })
    // All / nothing (loads-bulk.ts, spec scopes §4): «Turn all off / on» on
    // a group's head — or the tab's — at ONE place (`scope`, as the switch's:
    // absent or 'project', 'machine', 'agent' + `agent`). `keys` the rows
    // the head shows, `origins` the account heads it holds (an account row
    // goes by its head). `preview: true` answers what it will change and
    // what it cannot, writing nothing; without it, ONE write at that place
    // and the place's undo set kept (`group`: the head it was clicked on).
    // A machine head's «off» is refused unless `confirmed` (its sentence,
    // said in the preview). Owner-only (agent-authz: no entry).
    // 'conversation' + `conversation` (a session id): that conversation's
    // place, its column's «Turn all off here» (404: no conversation of this
    // project).
    // On Skills (spec scopes §4, T15): `skills` — the head's skills, each
    // `{ name, from }` (from 'account', 'personal' or 'project') — and
    // `origins: ['skills']` for the Claude account's group (its head key);
    // never with tools' `keys` or heads in the same click.
    type BulkBody = {
      skills?: unknown
      keys?: unknown
      origins?: unknown
      to?: unknown
      scope?: unknown
      agent?: unknown
      conversation?: unknown
      confirmed?: unknown
      group?: unknown
      preview?: unknown
    }
    const placeOf = (
      folder: string,
      b: { scope?: unknown; agent?: unknown; conversation?: unknown; confirmed?: unknown } | null | undefined,
    ): BulkAt | string => {
      const scope = b?.scope,
        agent = b?.agent,
        confirmed = b?.confirmed
      if (scope === 'conversation') {
        if (agent !== undefined) return 'an agent goes with scope agent'
        const conv = conversationIn(folder, b?.conversation)
        return conv ? { scope: 'conversation', conversation: conv } : 'no conversation of this project'
      }
      if (b?.conversation !== undefined) return 'a conversation goes with scope conversation'
      if (confirmed !== undefined && typeof confirmed !== 'boolean') return 'confirmed must be a boolean'
      if (scope === undefined || scope === 'project') return agent !== undefined ? 'an agent goes with scope agent' : { scope: 'project' }
      if (scope === 'machine')
        return agent !== undefined ? 'an agent goes with scope agent' : { scope: 'machine', ...(confirmed === true ? { confirmed: true } : {}) }
      if (scope === 'agent')
        return typeof agent === 'string' && agent !== '' && agent.length <= 128 ? { scope: 'agent', agent } : 'agent required with scope agent'
      return "scope must be 'project', 'machine', 'agent' or 'conversation'"
    }
    const groupOf = (g: unknown): string | null => (typeof g === 'string' && g !== '' && g.length <= 128 ? g : null)
    app.post<{ Params: { folder: string }; Body: BulkBody | null }>('/api/folders/:folder/loads/bulk', async (req, reply) => {
      const folder = managedFolderOf(req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      const b = req.body
      const keys = b?.keys ?? [],
        origins = b?.origins ?? []
      if (!Array.isArray(keys) || keys.length > 1000 || !keys.every((k) => typeof k === 'string' && k !== '' && k.length <= 1024))
        return reply.code(400).send({ error: 'keys must be row keys' })
      if (!Array.isArray(origins) || !origins.every((o) => o === 'plugins' || o === 'connectors' || o === 'skills'))
        return reply.code(400).send({ error: "origins must be 'plugins', 'connectors' or 'skills'" })
      const skills = b?.skills ?? []
      const SKILL = /^[\w.:-]{1,128}$/
      if (
        !Array.isArray(skills) ||
        skills.length > 1000 ||
        !skills.every(
          (x) =>
            typeof x === 'object' &&
            x !== null &&
            typeof (x as { name?: unknown }).name === 'string' &&
            SKILL.test((x as { name: string }).name) &&
            !/^\.+$/.test((x as { name: string }).name) &&
            ['account', 'personal', 'project', 'plugin'].includes((x as { from?: unknown }).from as string),
        )
      )
        return reply.code(400).send({ error: "skills must be { name, from: 'account' | 'personal' | 'project' | 'plugin' }" })
      const onSkills = skills.length > 0 || origins.includes('skills')
      if (onSkills && (keys.length > 0 || origins.some((o) => o !== 'skills')))
        return reply.code(400).send({ error: 'a click is on tools or on skills, not both' })
      if (b?.to !== 'on' && b?.to !== 'off') return reply.code(400).send({ error: "to must be 'on' or 'off'" })
      if (b.preview !== undefined && typeof b.preview !== 'boolean') return reply.code(400).send({ error: 'preview must be a boolean' })
      const group = groupOf(b.group)
      if (group === null) return reply.code(400).send({ error: 'group required' })
      const place = placeOf(folder, b)
      if (typeof place === 'string') return reply.code(place.startsWith('no conversation') ? 404 : 400).send({ error: place })
      try {
        await ctx.harness?.compatibility()
      } catch {
        /* not read: no gate */
      }
      try {
        const deps = loadsDeps(await loginsOf(folder))
        const answer = bulkFolderLoads(
          deps,
          folder,
          {
            keys: keys as string[],
            origins: origins as ('plugins' | 'connectors' | 'skills')[],
            skills: (skills as SkillWant[]).map((x) => ({ name: x.name, from: x.from })),
          },
          b.to,
          place,
          { group, apply: b.preview !== true },
        )
        if (b.preview === true) return { folder, preview: answer }
        return { folder, ok: true, done: answer, ...(place.scope === 'machine' ? { logins: followed() } : {}) }
      } catch (err) {
        if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })
    // «Undo» on the head a bulk click was made on: exactly the entries it
    // changed, back — while that place still reads as the click left it
    // (409 otherwise, the set dropped); 404 nothing to undo there.
    app.post<{ Params: { folder: string }; Body: { scope?: unknown; agent?: unknown; conversation?: unknown; confirmed?: unknown; group?: unknown } | null }>(
      '/api/folders/:folder/loads/bulk/undo',
      async (req, reply) => {
        const folder = managedFolderOf(req.params.folder)
        if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
        const group = groupOf(req.body?.group)
        if (group === null) return reply.code(400).send({ error: 'group required' })
        const place = placeOf(folder, req.body)
        if (typeof place === 'string') return reply.code(place.startsWith('no conversation') ? 404 : 400).send({ error: place })
        try {
          undoFolderBulk(loadsDeps(await loginsOf(folder)), folder, place, group)
        } catch (err) {
          if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
          return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
        }
        return { folder, ok: true, ...(place.scope === 'machine' ? { logins: followed() } : {}) }
      },
    )
    // «Only <agent>» on a row's agent line (loads-bulk.ts onlyAgentLoad):
    // the two-sided set for the row's family — `preview: true` says it and
    // writes nothing. An agent that is not the folder's is 404.
    app.post<{ Params: { folder: string }; Body: { key?: unknown; agent?: unknown; preview?: unknown } | null }>(
      '/api/folders/:folder/loads/only',
      async (req, reply) => {
        const folder = managedFolderOf(req.params.folder)
        if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
        const key = req.body?.key,
          agent = req.body?.agent,
          preview = req.body?.preview
        if (typeof key !== 'string' || key === '' || key.length > 1024) return reply.code(400).send({ error: 'key required' })
        if (typeof agent !== 'string' || agent === '' || agent.length > 128) return reply.code(400).send({ error: 'agent required' })
        if (preview !== undefined && typeof preview !== 'boolean') return reply.code(400).send({ error: 'preview must be a boolean' })
        try {
          await ctx.harness?.compatibility()
        } catch {
          /* not read: no gate */
        }
        try {
          const plan = onlyAgentLoad(loadsDeps(await loginsOf(folder)), folder, key, agent, { apply: preview !== true })
          return preview === true ? { folder, preview: plan } : { folder, ok: true, done: plan }
        } catch (err) {
          if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
          return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
        }
      },
    )
    // Each engine's heads of what an account sends, for this whole machine
    // — no folder (Settings › «New projects»): their lines and the machine
    // line's switch. Owner-only like the rest (agent-authz: no entry).
    app.get('/api/loads/machine', async () => {
      try {
        await ctx.harness?.compatibility()
      } catch {
        /* not read: no gate */
      }
      return { engines: machineHeadsOf(loadsDeps()) }
    })
    type MachineBody = { engine?: unknown; origin?: unknown; to?: unknown; confirmed?: unknown }
    app.post<{ Body: MachineBody | null }>('/api/loads/machine', async (req, reply) => {
      const engine = req.body?.engine,
        origin = req.body?.origin,
        to = req.body?.to,
        confirmed = req.body?.confirmed
      if (typeof engine !== 'string' || engine === '' || engine.length > 64) return reply.code(400).send({ error: 'engine required' })
      if (origin !== 'plugins' && origin !== 'skills' && origin !== 'connectors')
        return reply.code(400).send({ error: "origin must be 'plugins', 'skills' or 'connectors'" })
      if (to !== 'on' && to !== 'off') return reply.code(400).send({ error: "to must be 'on' or 'off'" })
      if (confirmed !== undefined && typeof confirmed !== 'boolean') return reply.code(400).send({ error: 'confirmed must be a boolean' })
      try {
        await ctx.harness?.compatibility()
      } catch {
        /* not read: no gate */
      }
      try {
        switchMachineHeadOf(loadsDeps(), engine, origin, to, confirmed === true)
      } catch (err) {
        if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      }
      return { ok: true, logins: followed() }
    })
    // what the machine line's «off» reaches, said before the click: how many
    // projects Silos manages load this row now
    app.get<{ Params: { folder: string }; Querystring: { key?: string } }>('/api/folders/:folder/loads/reach', async (req, reply) => {
      const folder = managedFolderOf(req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      const key = req.query.key
      if (typeof key !== 'string' || key === '' || key.length > 1024) return reply.code(400).send({ error: 'key required' })
      try {
        return machineReach(loadsDeps(), folder, key)
      } catch (err) {
        if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })
    // Your personal instructions in this project (folder-personal.ts over
    // each engine's Harness.personal): Project › Memory's switch on the
    // «Your machine» row. Owner-only like the rest (agent-authz: no entry).
    const personalDeps = () => ({
      registry,
      home,
      ...(claudeManagedDir ? { managedDir: claudeManagedDir } : {}),
      ...(ctx.loginDirs ? { loginDirs: ctx.loginDirs } : {}),
      ...(loadsScopes ? { loadsScopes } : {}),
    })
    // `?agent=`: an agent's page — its own line only among the agents;
    // `?conversation=<session id>`: one conversation's column — its own
    // line too (spec scopes T10). The same 404s as the folder's loads.
    app.get<{ Params: { folder: string }; Querystring: { agent?: string; conversation?: string } }>('/api/folders/:folder/personal', async (req, reply) => {
      const folder = managedFolderOf(req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      if (req.query.conversation !== undefined) {
        if (req.query.agent !== undefined) return reply.code(400).send({ error: 'an agent or a conversation, not both' })
        const conv = conversationIn(folder, req.query.conversation)
        if (!conv) return reply.code(404).send({ error: 'no conversation of this project' })
        return { ...folderPersonal(personalDeps(), folder, { conv }), conversation: { thread: conv.thread, agent: conv.agent } }
      }
      const as = agentOfFolder(req.query.agent, folder)
      if (as === null) return reply.code(404).send({ error: 'not an agent of this project' })
      return folderPersonal(personalDeps(), folder, as !== undefined ? { as } : {})
    })
    // `scope` absent or 'project': the folder's own file, as before;
    // 'agent' (+ `agent`) or 'conversation' (+ `conversation`, a session
    // id whose thread the server resolves): only that place's launches,
    // kept by Silos — nothing under the folder or ~/.claude is written.
    app.post<{ Params: { folder: string }; Body: { to?: unknown; scope?: unknown; agent?: unknown; conversation?: unknown } | null }>(
      '/api/folders/:folder/personal',
      async (req, reply) => {
        const folder = managedFolderOf(req.params.folder)
        if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
        const to = req.body?.to,
          scope = req.body?.scope,
          agent = req.body?.agent,
          conversation = req.body?.conversation
        if (to !== 'on' && to !== 'off') return reply.code(400).send({ error: "to must be 'on' or 'off'" })
        if (scope !== undefined && scope !== 'project' && scope !== 'agent' && scope !== 'conversation')
          return reply.code(400).send({ error: "scope must be 'project', 'agent' or 'conversation'" })
        if (scope === 'agent' && (typeof agent !== 'string' || agent === '' || agent.length > 128))
          return reply.code(400).send({ error: 'agent required with scope agent' })
        if (scope !== 'agent' && agent !== undefined) return reply.code(400).send({ error: 'an agent goes with scope agent' })
        let conv: FolderConversation | null = null
        if (scope === 'conversation') {
          if (typeof conversation !== 'string' || conversation === '') return reply.code(400).send({ error: 'conversation required with scope conversation' })
          conv = conversationIn(folder, conversation)
          if (!conv) return reply.code(404).send({ error: 'no conversation of this project' })
        } else if (conversation !== undefined) return reply.code(400).send({ error: 'a conversation goes with scope conversation' })
        try {
          if (scope === 'agent') switchFolderPersonal(personalDeps(), folder, to, { scope: 'agent', agent: agent as string })
          else if (conv) switchFolderPersonal(personalDeps(), folder, to, { scope: 'conversation', conversation: { thread: conv.thread, agent: conv.agent } })
          else switchFolderPersonal(personalDeps(), folder, to)
        } catch (err) {
          if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
          return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
        }
        if (conv) return { ...folderPersonal(personalDeps(), folder, { conv }), conversation: { thread: conv.thread, agent: conv.agent } }
        return folderPersonal(personalDeps(), folder, scope === 'agent' ? { as: agent as string } : {})
      },
    )
    // Every instruction file's places (folder-instruction-places.ts over
    // each engine's Harness.instructions.places, spec memory-places T4) —
    // the Memory rows' switch and ▾. The same shape as …/personal: GET with
    // `?agent=` (an agent's page) or `?conversation=` (one column); POST
    // with `path` (a row the engines list), `to`, `scope` and its place.
    // Owner-only like the rest (agent-authz: no entry).
    if (ctx.instructions) {
      // the proof's start markers beside the record's own: each process
      // start the turn ledger saw for the conversation's sessions
      const startsOf = (folder: string, sessions: readonly string[]): number[] => {
        const mine = new Set(sessions)
        return (toolHealth?.readings(folder) ?? []).filter((r) => r.conversation !== undefined && mine.has(r.conversation)).map((r) => r.started ?? r.at)
      }
      const instructionsDeps = () => ({ ...ctx.instructions!(), ...(loadsScopes ? { loadsScopes } : {}), startsOf })
      app.get<{ Params: { folder: string }; Querystring: { agent?: string; conversation?: string } }>(
        '/api/folders/:folder/instructions',
        async (req, reply) => {
          const folder = managedFolderOf(req.params.folder)
          if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
          if (req.query.conversation !== undefined) {
            if (req.query.agent !== undefined) return reply.code(400).send({ error: 'an agent or a conversation, not both' })
            const conv = conversationIn(folder, req.query.conversation)
            if (!conv) return reply.code(404).send({ error: 'no conversation of this project' })
            return { ...(await folderInstructionPlaces(instructionsDeps(), folder, { conv })), conversation: { thread: conv.thread, agent: conv.agent } }
          }
          const as = agentOfFolder(req.query.agent, folder)
          if (as === null) return reply.code(404).send({ error: 'not an agent of this project' })
          return folderInstructionPlaces(instructionsDeps(), folder, as !== undefined ? { as } : {})
        },
      )
      app.post<{
        Params: { folder: string }
        Body: { path?: unknown; to?: unknown; scope?: unknown; agent?: unknown; conversation?: unknown; confirmed?: unknown } | null
      }>('/api/folders/:folder/instructions', async (req, reply) => {
        const folder = managedFolderOf(req.params.folder)
        if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
        const { path, to, scope, agent, conversation, confirmed } = req.body ?? {}
        if (typeof path !== 'string' || path === '' || path.length > 4096) return reply.code(400).send({ error: 'path required' })
        if (to !== 'on' && to !== 'off') return reply.code(400).send({ error: "to must be 'on' or 'off'" })
        if (scope !== undefined && scope !== 'project' && scope !== 'machine' && scope !== 'agent' && scope !== 'conversation')
          return reply.code(400).send({ error: "scope must be 'project', 'machine', 'agent' or 'conversation'" })
        if (scope === 'agent' && (typeof agent !== 'string' || agent === '' || agent.length > 128))
          return reply.code(400).send({ error: 'agent required with scope agent' })
        if (scope !== 'agent' && agent !== undefined) return reply.code(400).send({ error: 'an agent goes with scope agent' })
        let conv: FolderConversation | null = null
        if (scope === 'conversation') {
          if (typeof conversation !== 'string' || conversation === '') return reply.code(400).send({ error: 'conversation required with scope conversation' })
          conv = conversationIn(folder, conversation)
          if (!conv) return reply.code(404).send({ error: 'no conversation of this project' })
        } else if (conversation !== undefined) return reply.code(400).send({ error: 'a conversation goes with scope conversation' })
        try {
          await switchFolderInstruction(
            instructionsDeps(),
            folder,
            path,
            to,
            scope === 'agent'
              ? { scope: 'agent', agent: agent as string }
              : conv
                ? { scope: 'conversation', conversation: { thread: conv.thread, agent: conv.agent } }
                : scope === 'machine'
                  ? { scope: 'machine', ...(confirmed === true ? { confirmed: true as const } : {}) }
                  : { scope: 'project' },
          )
        } catch (err) {
          if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
          return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
        }
        // the machine's file: the logins that follow it are asked now
        const logins = scope === 'machine' ? followed() : undefined
        if (conv) return { ...(await folderInstructionPlaces(instructionsDeps(), folder, { conv })), conversation: { thread: conv.thread, agent: conv.agent } }
        return {
          ...(await folderInstructionPlaces(instructionsDeps(), folder, scope === 'agent' ? { as: agent as string } : {})),
          ...(logins ? { logins } : {}),
        }
      })
    }
  }
}
