import type { SeenBook, SeenMark } from './task-seen'
import type { HomeSince } from './since'
import type { UsageReport } from './usage'
import type { SystemReport, VitalsReport } from './vitals'
import type { UsagePeriod, UsageView } from '../store/types'
import type {
  AccountLoad,
  PlanUsage,
  DigestBand,
  PushDeviceView,
  StartedWith,
  AgentStartedWith,
  AgentMessage,
  AgentMessageState,
  AgentSummary,
  AgentTerritory,
  AgentView,
  MissionInput,
  LoadedAtStart,
  ArtifactItem,
  Automation,
  AutomationTemplate,
  ControlPending,
  HeartbeatSetting,
  HeartbeatView,
  ProactiveSetting,
  Measures,
  PlanOrigin,
  RolePack,
  RolePackConsequences,
  RolePackReport,
  BoardCard,
  CatalogView,
  ClaudeAccountView,
  ContextFile,
  ContextScope,
  GivenThread,
  ConvPrefs,
  DirEntry,
  ExecResult,
  FileMeta,
  InboxAck,
  InboxRow,
  FolderLoads,
  FolderLoadsWeight,
  OwnToolConfig,
  OwnToolRow,
  MemoryLayers,
  NeedsYouItem,
  OutputStyleInfo,
  SiloBoard,
  Overview,
  PendingResume,
  Prefs,
  ProviderView,
  ProposalDiffLine,
  ProposalView,
  ProjectsPrefs,
  Project,
  Run,
  SessionDetail,
  SearchHit,
  HarnessStatus,
  HarnessUpdate,
  HarnessId,
  HarnessDescriptor,
  SiloConsequences,
  SiloDescriptor,
  SiloMessageResult,
  SiloMakeTaskResult,
  SiloProposalView,
  SiloSubmissionRow,
  SiloUninstalled,
  SiloAvailable,
  SiloRecordDetail,
  SiloRecordsPage,
  SiloSetFieldResult,
  TaskActAnswer,
  TaskActArgs,
  TaskActVerb,
  SkillCatalogEntry,
  TerritorySettings,
  TerritoryEgress,
  AgentEgress,
  EgressRejection,
  FenceRefusedAgent,
  VaultEntry,
  VaultScope,
  VaultBinding,
  BindingAsk,
  BindingResolution,
  SignedCall,
  SkillReadme,
  TasksSession,
  TerminalHandle,
  Trigger,
  Thread,
  Turn,
  UsesColKind,
  UsesPrefs,
  UsesRowKind,
  UsesView,
  SilosSkillOffer,
  TaskModeStatus,
  TaskModeView,
  TaskFeedCard,
  TaskWorkAnswer,
  SessionTaskLine,
  ClosedPlanEntry,
  SiloRelationReading,
  EscalationView,
  AgentTaskWakes,
  TaskModeToday,
  PlatformSettingsView,
  StartingSetPreview,
  ConversationProcess,
  KernelVerbAnswer,
  TrashAnswer,
  EnginePageLine,
  EngineSignInOption,
  EngineSignInState,
  LoadsCheckStatus,
  LoadsCheckAnswer,
  FolderPersonal,
  FolderInstructionPlaces,
  LoadsSwitchAnswer,
  MachineHeads,
  BulkPlace,
  BulkPreview,
  BulkSkill,
  OnlyAgentPlan,
} from './types'
import { descriptorOf } from './harnesses'

const TOKEN_KEY = 'silos-token'

// Google login (opt-in): after exchanging the idToken at POST
// /api/auth/login, the client stores the LOCAL token exactly like the
// URL's ?token= flow (which stays alive as a local escape hatch — see
// AuthGate.tsx).
export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function getToken(): string {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('token')
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl)
    params.delete('token')
    const qs = params.toString()
    const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
    window.history.replaceState(null, '', url)
    return fromUrl
  }
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

// An HTTP error that keeps its status and JSON body, for callers that act
// on WHAT was refused (the console route's 409 for a run: read-only).
// Still an Error with the server's message, so every other caller is as before.
// the dispositions «Unlink…» offers (plans 0.5.2 release.dispose.allowed)
export type ReleaseState = 'pending' | 'in_review' | 'blocked' | 'done'
export interface TaskNewAnswer {
  ok?: boolean
  key: string
  id: string
  ref: string
  title: string
  warn?: string
  assign?: { queued: boolean; why?: string; held?: string; wakes?: string }
}
export interface ReleaseAnswer {
  ok?: boolean
  released?: boolean
  written?: boolean
  kept?: string
  disposed?: string
  already?: string
  warn?: string
  state?: string
  wait?: { owner: string; action: string; asked?: string }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('x-token', getToken())
  if (init?.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(path, { ...init, headers })
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: string }).error : undefined
    throw new ApiError(message ?? `HTTP ${res.status}`, res.status, body)
  }
  return body as T
}

// what POST /api/providers takes, per kind (server providers-validate.ts)
// 'live' = the console switched in place (Claude: /model; OpenCode: its
// recent-models cycle, verified on its screen) · 'restart' = the running
// console cannot reach that model, a relaunch with --model does — the panel
// relaunches at once · 'next-turn' = the next launch takes the pin
export type PrefsApplied = 'live' | 'restart' | 'next-turn'

export type ProviderCreateInput =
  | { kind?: 'anthropic-compatible'; label: string; baseUrl: string; apiKey: string; models?: string[] }
  | { kind: 'harness-provider'; harness: HarnessId; label: string; providerId: string; apiKey: string }
  | { kind: 'harness-native'; harness: HarnessId; label: string; providerId: string }

// the one «Since» reading of this tab (api.home.since)
let sinceOnce: Promise<HomeSince> | null = null

/** The Silos hooks in ~/.claude/settings.json (server settings.ts
 *  HookWiring): installed = wired and its script exists · broken = wired
 *  to a script that is not there · missing = not wired. */
export type HookWiring = 'installed' | 'broken' | 'missing'
export type SilosHooks = { briefing: HookWiring; cronGate: HookWiring }

export const api = {
  // Usage: what the fleet spent in a named period —
  // its range is the server's (its local midnight), never the browser's
  usage(q: { period: UsagePeriod; by: UsageView; agent?: string }): Promise<UsageReport> {
    const qs = new URLSearchParams({ period: q.period, by: q.by, ...(q.agent ? { agent: q.agent } : {}) })
    return req<UsageReport>(`/api/usage?${qs.toString()}`)
  },
  // the machine's vitals: disk/memory from the sampler; the
  // runs, executions and fleet derived backwards (the owner's reads)
  system(): Promise<SystemReport> {
    return req<SystemReport>('/api/system')
  },
  vitals(): Promise<VitalsReport> {
    return req<VitalsReport>('/api/vitals')
  },
  overview(): Promise<Overview> {
    return req<Overview>('/api/overview')
  },
  sessionDetail(folder: string, id: string, since?: number): Promise<SessionDetail> {
    const qs = since !== undefined ? `?since=${since}` : ''
    return req<SessionDetail>(`/api/sessions/${folder}/${id}${qs}`)
  },
  // a subagent's transcript (Agent tool) — the context column requests it
  // when opening a subagent in read-only mode (see ContextColumn.tsx).
  subagentTranscript(folder: string, id: string, agentId: string): Promise<{ turns: Turn[] }> {
    return req<{ turns: Turn[] }>(`/api/sessions/${folder}/${id}/subagents/${agentId}`)
  },
  // what this conversation started with, measured from its transcript
  // (null = an engine that can't say); a part's exact text by its ref
  startedWith(folder: string, id: string): Promise<StartedWith | null> {
    return req<StartedWith | null>(`/api/sessions/${folder}/${id}/started-with`)
  },
  startedWithPart(folder: string, id: string, key: string): Promise<{ ref: string; text: string }> {
    return req<{ ref: string; text: string }>(`/api/sessions/${folder}/${id}/started-with/part/${encodeURIComponent(key)}`)
  },
  // cwd is only sent by master when opening a new chat (see store.send) —
  // JSON.stringify omits the key when cwd is undefined. Cockpit: TURN-LEVEL
  // overrides (one-shot) — the same omission criterion.
  // title: naming at birth — only for a NEW conversation (no session); the
  // server applies it as the manual rename when chat-init names the id.
  // the owner's message into the turn running on that conversation (the
  // server's steer): {steered:true}, or a 409 when there is no turn of
  // theirs to take it — never starts a turn of its own
  steer(agentId: string, text: string, session: { folder: string; id: string }): Promise<{ turnId: string; steered: true }> {
    return req<{ turnId: string; steered: true }>(`/api/agents/${agentId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ text, session, steer: true }),
    })
  },
  chat(
    agentId: string,
    text: string,
    session?: { folder: string; id: string },
    cwd?: string,
    overrides?: ConvPrefs,
    title?: string,
  ): Promise<{ turnId: string }> {
    return req<{ turnId: string }>(`/api/agents/${agentId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ text, session, cwd, overrides, title }),
    })
  },
  // Auto-resume of interactive chats: hydrates on load (durable — survives
  // restarts) and cancels from the banner's "Cancel".
  pendingResumes: {
    async list(): Promise<PendingResume[]> {
      const { pending } = await req<{ pending: PendingResume[] }>('/api/pending-resumes')
      return pending
    },
    cancel(folder: string, id: string): Promise<{ ok: boolean }> {
      return req<{ ok: boolean }>(`/api/pending-resumes/${folder}/${id}`, { method: 'DELETE' })
    },
  },
  // Cockpit: an honest model catalog (GET /api/models, manual refresh) and
  // per-conversation prefs (the cascade's middle level). The PATCH accepts
  // null on a field to DELETE that override (revert to the agent's default).
  // Per harness: `opencode` = `opencode models`, narrowed to what one
  // provider (or one agent: its provider + fallback) can reach.
  models(harness?: HarnessId, scope?: { provider?: string; agentId?: string }): Promise<CatalogView> {
    // the default engine's catalogue is the bare route (no ?harness=)
    if (!harness || descriptorOf(harness).default) return req<CatalogView>('/api/models')
    const q = new URLSearchParams({ harness })
    if (scope?.provider) q.set('provider', scope.provider)
    if (scope?.agentId) q.set('agentId', scope.agentId)
    return req<CatalogView>(`/api/models?${q.toString()}`)
  },
  refreshModels(harness?: HarnessId): Promise<CatalogView> {
    return req<CatalogView>(!harness || descriptorOf(harness).default ? '/api/models/refresh' : `/api/models/refresh?harness=${harness}`, { method: 'POST' })
  },
  conversationPrefs: {
    async get(folder: string, id: string): Promise<ConvPrefs> {
      const { prefs } = await req<{ prefs: ConvPrefs }>(`/api/sessions/${folder}/${id}/prefs`)
      return prefs
    },
    async patch(folder: string, id: string, patch: { [K in keyof ConvPrefs]?: ConvPrefs[K] | null }): Promise<ConvPrefs> {
      const { prefs } = await req<{ prefs: ConvPrefs }>(`/api/sessions/${folder}/${id}/prefs`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      return prefs
    },
    // the same PATCH, with what the server could do about a live OpenCode
    // console: 'live' = the session switched model in place (no restart),
    // 'restart' = the provider is not loaded in that process, 'next-turn' =
    // no console (the next launch takes the pin)
    async patchApplied(
      folder: string,
      id: string,
      patch: { [K in keyof ConvPrefs]?: ConvPrefs[K] | null },
    ): Promise<{ prefs: ConvPrefs; applied: PrefsApplied }> {
      const r = await req<{ prefs: ConvPrefs; applied?: PrefsApplied }>(`/api/sessions/${folder}/${id}/prefs`, { method: 'PATCH', body: JSON.stringify(patch) })
      return { prefs: r.prefs, applied: r.applied ?? 'next-turn' }
    },
  },
  // distinct cwds seen in the index, for master's project selector.
  async projects(): Promise<Project[]> {
    const { projects } = await req<{ projects: Project[] }>('/api/projects')
    return projects
  },
  cancel(turnId: string): Promise<{ ok: boolean }> {
    return req<{ ok: boolean }>(`/api/chat/${turnId}/cancel`, { method: 'POST' })
  },
  // the server's truth for the WS resilience watchdog: whether the turn is
  // still inflight in the ChatService, or whether chat-done was lost on the drop.
  chatAlive(turnId: string): Promise<{ alive: boolean }> {
    return req<{ alive: boolean }>(`/api/chat/${turnId}/alive`)
  },
  exec(agentId: string, command: string): Promise<ExecResult> {
    return req<ExecResult>(`/api/agents/${agentId}/exec`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    })
  },
  async rename(folder: string, id: string, title: string): Promise<void> {
    await req(`/api/sessions/${folder}/${id}/rename`, { method: 'POST', body: JSON.stringify({ title }) })
  },
  // `thread`: bury the whole thread (the tip plus the history folded under
  // it) — what the sidebar's Delete means; Maintenance omits it and buries
  // one session at a time.
  // `thread` buries the whole chain (sidebar); `closeHolders` asks the server
  // to close a claude outside Silos that still holds the conversation (the
  // 409 names it — lib/trash-refusal.ts) and then trash.
  // `stopProcesses`: the owner ticked «Also stop them» in the delete
  // confirmation — never set by default; the answer then says what was
  // stopped (`processes.says`).
  async trash(folder: string, id: string, opts?: { thread?: boolean; closeHolders?: boolean; stopProcesses?: boolean }): Promise<TrashAnswer | undefined> {
    const body: Record<string, boolean> = {}
    if (opts?.thread) body.thread = true
    if (opts?.closeHolders) body.closeHolders = true
    if (opts?.stopProcesses === true) body.stopProcesses = true
    return req<TrashAnswer | undefined>(
      `/api/sessions/${folder}/${id}/trash`,
      Object.keys(body).length > 0 ? { method: 'POST', body: JSON.stringify(body) } : { method: 'POST' },
    )
  },
  // what this conversation's thread left running on the machine (the System
  // silo's `process` records, running or left) — the column's Processes
  // block and the delete confirmation read it
  async processes(folder: string, id: string): Promise<ConversationProcess[]> {
    const r = await req<{ processes?: ConversationProcess[] }>(`/api/sessions/${folder}/${id}/processes`)
    return Array.isArray(r?.processes) ? r.processes : []
  },
  // durable unseen: marks a conversation seen RIGHT NOW (it was just opened).
  // Fire-and-forget from the store (openSession): the durable dot clears
  // optimistically on the client and is confirmed on the next overview.
  // Ignores the result — a network failure must not break opening it.
  async markSeen(folder: string, id: string): Promise<void> {
    await req('/api/seen', { method: 'PATCH', body: JSON.stringify({ folder, id }) })
  },
  // «new to you» on plan tasks: the owner's read marks (lib/task-seen.ts)
  taskSeen: {
    read(): Promise<SeenBook> {
      return req<SeenBook>('/api/task-seen')
    },
    mark(key: string, state: string): Promise<SeenMark & { key: string }> {
      return req('/api/task-seen', { method: 'PATCH', body: JSON.stringify({ key, state }) })
    },
  },
  async complete(agentId: string, kind: 'files' | 'skills', q: string): Promise<string[]> {
    const { items } = await req<{ items: string[] }>(`/api/agents/${agentId}/complete?kind=${kind}&q=${encodeURIComponent(q)}`)
    return items
  },
  // the skills catalog WITH description — AgentPage's Skills tab.
  // `conversation` (a session id): each skill also carries that ONE
  // conversation's line (its column's Knows › Skills); 404: no conversation
  // of this agent's project the server knows
  async skillsCatalog(agentId: string, conversation?: string): Promise<SkillCatalogEntry[]> {
    const { skills } = await req<{ skills: SkillCatalogEntry[] }>(
      `/api/agents/${agentId}/skills-catalog${conversation ? `?conversation=${encodeURIComponent(conversation)}` : ''}`,
    )
    return skills
  },
  // Silos' plugin skills — the inventory (Settings › Skills)
  async silosSkills(): Promise<{ name: string; description?: string }[]> {
    const { skills } = await req<{ skills: { name: string; description?: string }[] }>('/api/silos-skills')
    return skills
  },
  // what the create modal may offer BEFORE the agent exists: exactly what
  // the add route will accept for that engine + folder (the server runs the
  // catalog rule), and the plain reason for each Silos skill it won't
  silosSkillOffer(draft: { framework: string; folder: string }): Promise<SilosSkillOffer> {
    const q = new URLSearchParams({ framework: draft.framework, folder: draft.folder })
    return req<SilosSkillOffer>(`/api/silos-skills?${q.toString()}`)
  },
  // the New agent form's line: what a new agent of that engine would start
  // with in that folder, and whether it joins a project already
  // `facts`: also what you set up here and what each class's origin sends (Welcome's At start)
  startingSet(draft: { framework: string; folder: string; facts?: boolean }): Promise<StartingSetPreview> {
    const q = new URLSearchParams({ framework: draft.framework, folder: draft.folder, ...(draft.facts ? { facts: '1' } : {}) })
    return req<StartingSetPreview>(`/api/starting-set?${q.toString()}`)
  },
  // a catalog skill's full readme — the Skills dimension.
  skillReadme(name: string): Promise<SkillReadme> {
    return req<SkillReadme>(`/api/skills/${encodeURIComponent(name)}`)
  },
  // the global background-work view — see server /api/tasks.
  tasks(): Promise<{ sessions: TasksSession[] }> {
    return req<{ sessions: TasksSession[] }>('/api/tasks')
  },
  // the conversation cards + the inbox Home reads — a server-side pass, see
  // server/src/board.ts and server/src/inbox.ts.
  // `needsYou` is the second, file-borne needs-you source (server/src/needs-you.ts);
  // `inbox` is THE inbox, composed by the server (server/src/inbox.ts).
  board(): Promise<{ cards: BoardCard[]; needsYou: NeedsYouItem[]; inbox: InboxRow[]; silos?: SiloBoard }> {
    return req<{ cards: BoardCard[]; needsYou: NeedsYouItem[]; inbox: InboxRow[]; silos?: SiloBoard }>('/api/board')
  },
  // Home's «Since …» (server home-since.ts): reading
  // it stamps the visit, so a tab reads it ONCE — the band holds while you
  // move around and come back (lib/since.ts paints it)
  home: {
    since(): Promise<HomeSince> {
      sinceOnce ??= req<HomeSince>('/api/home/since').catch((e: unknown) => {
        sinceOnce = null
        throw e
      })
      return sinceOnce
    },
  },
  // the daily digest (server/src/digest-job.ts): the unread ones summed into
  // one band, the owner's hour; Seen marks the newest date shown
  digest: {
    get(): Promise<{ hour: string; band: DigestBand | null }> {
      return req<{ hour: string; band: DigestBand | null }>('/api/digest')
    },
    async seen(through: string): Promise<void> {
      await req('/api/digest/seen', { method: 'POST', body: JSON.stringify({ through }) })
    },
    setHour(hour: string): Promise<{ hour: string }> {
      return req<{ hour: string }>('/api/digest/hour', { method: 'PUT', body: JSON.stringify({ hour }) })
    },
  },
  // the doorbell's devices (server/src/web-push.ts)
  push: {
    get(): Promise<{ publicKey: string; devices: PushDeviceView[] }> {
      return req<{ publicKey: string; devices: PushDeviceView[] }>('/api/push')
    },
    subscribe(subscription: unknown, label: string): Promise<PushDeviceView> {
      return req<PushDeviceView>('/api/push/devices', { method: 'POST', body: JSON.stringify({ subscription, label }) })
    },
    async revoke(id: string): Promise<void> {
      await req(`/api/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    test(id: string): Promise<{ status: number | 'error'; device: PushDeviceView | null }> {
      return req<{ status: number | 'error'; device: PushDeviceView | null }>(`/api/push/devices/${encodeURIComponent(id)}/test`, { method: 'POST' })
    },
  },
  // the seal's doors (server routes/seals.ts), owner-only
  seals: {
    // what the engine changed in its own configuration (the cache's last 50)
    async pageLines(): Promise<EnginePageLine[]> {
      return (await req<{ pageLines?: EnginePageLine[] }>('/api/seals')).pageLines ?? []
    },
    async act(id: string, door: 'keep' | 'discard' | 'seen' | 'hold'): Promise<void> {
      await req(`/api/seals/rows/${encodeURIComponent(id)}/${door}`, { method: 'POST' })
    },
    async file(id: string, door: 'put-back' | 'delete', path: string): Promise<void> {
      await req(`/api/seals/rows/${encodeURIComponent(id)}/${door}`, { method: 'POST', body: JSON.stringify({ path }) })
    },
  },
  needsYou: {
    // the owner's Seen on an inbox row: THAT version (the row's `ack`) leaves
    // the inbox; a changed row shows again. 204, durable
    // (server/src/needs-you-acks.ts).
    async ack(body: InboxAck): Promise<void> {
      await req('/api/needs-you/ack', { method: 'POST', body: JSON.stringify(body) })
    },
  },
  // an OpenCode agent's permission ask, answered by the owner: the reply
  // file the agent's plugin picks up (server/src/asks-store.ts). 404 when
  // the ask is already gone (answered in the TUI, timed out).
  asks: {
    async reply(agentId: string, sessionId: string, permissionId: string, status: 'allow' | 'deny'): Promise<void> {
      const seg = [agentId, sessionId, permissionId].map(encodeURIComponent).join('/')
      await req(`/api/asks/${seg}/reply`, { method: 'POST', body: JSON.stringify({ status }) })
    },
  },
  // the aggregate artifacts list — agent and folder (the project's real path)
  // are optional; with no params, everything indexed. See server/src/artifacts-aggregate.ts.
  artifacts(scope?: { agent?: string; folder?: string }): Promise<{ artifacts: ArtifactItem[]; total: number }> {
    const params = new URLSearchParams()
    if (scope?.agent !== undefined) params.set('agent', scope.agent)
    if (scope?.folder !== undefined) params.set('folder', scope.folder)
    const qs = params.toString()
    return req<{ artifacts: ArtifactItem[]; total: number }>(`/api/artifacts${qs ? `?${qs}` : ''}`)
  },
  // Map › Uses — the usage matrix (server/src/uses.ts). since = days or
  // 'all'; runs=false leaves automation/nested runs out; min = a column must
  // be used by at least that many rows; folder scopes to a project.
  uses(params: { rows: UsesRowKind; cols: UsesColKind; since: string; runs?: boolean; min?: number; folder?: string }): Promise<UsesView> {
    const q = new URLSearchParams({ rows: params.rows, cols: params.cols, since: params.since })
    if (params.runs === false) q.set('runs', '0')
    if (params.min !== undefined && params.min > 1) q.set('min', String(params.min))
    if (params.folder !== undefined) q.set('folder', params.folder)
    return req<UsesView>(`/api/uses?${q.toString()}`)
  },
  // the project page's doors to what the FOLDER owns: its
  // skills and its shared files, asked about the folder itself — never
  // through a member agent whose primary folder is elsewhere. The segment
  // is the folder's exact path (the server resolves it onto a managed
  // folder only, like /api/folders/:folder/loads; 404 otherwise).
  folders: {
    async skillsCatalog(folder: string): Promise<SkillCatalogEntry[]> {
      const { skills } = await req<{ skills: SkillCatalogEntry[] }>(`/api/folders/${encodeURIComponent(folder)}/skills-catalog`)
      return skills
    },
    async skillState(folder: string, name: string, action: 'hold' | 'activate' | 'add'): Promise<SkillCatalogEntry[]> {
      const { skills } = await req<{ skills: SkillCatalogEntry[] }>(`/api/folders/${encodeURIComponent(folder)}/skills/${encodeURIComponent(name)}/${action}`, {
        method: 'POST',
      })
      return skills
    },
    // an account or personal skill's position here (on · name only · off),
    // written in the folder's local settings only
    async skillPosition(folder: string, name: string, from: 'account' | 'personal', to: 'on' | 'name-only' | 'off'): Promise<SkillCatalogEntry[]> {
      const { skills } = await req<{ skills: SkillCatalogEntry[] }>(`/api/folders/${encodeURIComponent(folder)}/skills/${encodeURIComponent(name)}/position`, {
        method: 'POST',
        body: JSON.stringify({ to, from }),
      })
      return skills
    },
    // a skill's position at one place of its «Where it loads» (scopes T9):
    // `machine` the user's own settings (the answer names logins that didn't
    // follow), `agent` only that agent's launches, kept by Silos
    async skillPositionAt(
      folder: string,
      name: string,
      from: 'account' | 'personal' | 'project',
      to: 'on' | 'name-only' | 'off',
      at: { scope: 'machine' } | { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: string },
    ): Promise<{ skills: SkillCatalogEntry[]; logins?: LoadsSwitchAnswer['logins'] }> {
      return req<{ skills: SkillCatalogEntry[]; logins?: LoadsSwitchAnswer['logins'] }>(
        `/api/folders/${encodeURIComponent(folder)}/skills/${encodeURIComponent(name)}/position`,
        { method: 'POST', body: JSON.stringify({ to, from, ...at }) },
      )
    },
    // the head of what the Claude account sends: its skills on or off here
    async skillsOrigin(folder: string, to: 'on' | 'off'): Promise<SkillCatalogEntry[]> {
      const { skills } = await req<{ skills: SkillCatalogEntry[] }>(`/api/folders/${encodeURIComponent(folder)}/skills-origin`, {
        method: 'POST',
        body: JSON.stringify({ to }),
      })
      return skills
    },
    context(folder: string): Promise<{ shared: ContextFile[]; agent: ContextFile[] }> {
      return req<{ shared: ContextFile[]; agent: ContextFile[] }>(`/api/folders/${encodeURIComponent(folder)}/context`)
    },
    uploadShared(folder: string, name: string, contentBase64: string): Promise<ContextFile> {
      return req<ContextFile>(`/api/folders/${encodeURIComponent(folder)}/context`, { method: 'POST', body: JSON.stringify({ name, contentBase64 }) })
    },
    removeShared(folder: string, name: string): Promise<{ ok: boolean }> {
      return req<{ ok: boolean }>(`/api/folders/${encodeURIComponent(folder)}/context?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
    },
    // your personal instructions here: on, or off in this project (the engine's switch)
    // `agent`: an agent's page (its own line only); `conversation` (a session id): its column
    personal(folder: string, as?: { agent: string } | { conversation: string }): Promise<FolderPersonal> {
      const q = as ? ('agent' in as ? `?agent=${encodeURIComponent(as.agent)}` : `?conversation=${encodeURIComponent(as.conversation)}`) : ''
      return req<FolderPersonal>(`/api/folders/${encodeURIComponent(folder)}/personal${q}`)
    },
    personalSwitch(folder: string, to: 'on' | 'off'): Promise<FolderPersonal> {
      return req<FolderPersonal>(`/api/folders/${encodeURIComponent(folder)}/personal`, { method: 'POST', body: JSON.stringify({ to }) })
    },
    // for ONE agent or ONE conversation (spec scopes T10): kept by Silos, carried at launch
    personalSwitchAt(
      folder: string,
      to: 'on' | 'off',
      at: { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: string },
    ): Promise<FolderPersonal> {
      return req<FolderPersonal>(`/api/folders/${encodeURIComponent(folder)}/personal`, { method: 'POST', body: JSON.stringify({ to, ...at }) })
    },
    // every Memory row's places (spec memory-places T4): GET as …/personal;
    // a switch names the row's path, never a kind — the server judges it
    // against the engines' own list
    instructions(folder: string, as?: { agent: string } | { conversation: string }): Promise<FolderInstructionPlaces> {
      const q = as ? ('agent' in as ? `?agent=${encodeURIComponent(as.agent)}` : `?conversation=${encodeURIComponent(as.conversation)}`) : ''
      return req<FolderInstructionPlaces>(`/api/folders/${encodeURIComponent(folder)}/instructions${q}`)
    },
    instructionSwitch(
      folder: string,
      path: string,
      to: 'on' | 'off',
      at:
        { scope: 'project' } | { scope: 'machine'; confirmed?: true } | { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: string } = {
        scope: 'project',
      },
    ): Promise<FolderInstructionPlaces> {
      return req<FolderInstructionPlaces>(`/api/folders/${encodeURIComponent(folder)}/instructions`, {
        method: 'POST',
        body: JSON.stringify({ path, to, ...at }),
      })
    },
    // everything a conversation in the folder loads at start, one row per thing
    // `agent`: an agent's page — the machine's, the project's and THAT agent's lines only;
    // `conversation` (a session id): the rows as that ONE conversation sees
    // them — its own line, its switch, where its entries stand (404: no
    // conversation of this project the server knows)
    loads(folder: string, agent?: string, conversation?: string): Promise<FolderLoads> {
      const q = agent ? `?agent=${encodeURIComponent(agent)}` : conversation ? `?conversation=${encodeURIComponent(conversation)}` : ''
      return req<FolderLoads>(`/api/folders/${encodeURIComponent(folder)}/loads${q}`)
    },
    // what each of those rows took at the newest measured start there (null: none measured)
    loadsWeight(folder: string): Promise<FolderLoadsWeight | null> {
      return req<FolderLoadsWeight | null>(`/api/folders/${encodeURIComponent(folder)}/loads/weight`)
    },
    // «Check now»: the logins it can check, whether one runs, when it last ran
    // `agent`: on an agent's page — its login, and its last check
    loadsCheck(folder: string, agent?: string): Promise<LoadsCheckStatus> {
      return req<LoadsCheckStatus>(`/api/folders/${encodeURIComponent(folder)}/loads/check${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`)
    },
    // starts the engine on that login with no prompt, reads its servers, closes it (≤ 20 s);
    // `agent`: started as that agent's launches are (its kept entries), read as its
    runLoadsCheck(folder: string, provider: string, withoutLocal = false, agent?: string): Promise<LoadsCheckAnswer> {
      return req<LoadsCheckAnswer>(`/api/folders/${encodeURIComponent(folder)}/loads/check`, {
        method: 'POST',
        body: JSON.stringify({ provider, ...(withoutLocal ? { withoutLocal: true } : {}), ...(agent ? { agent } : {}) }),
      })
    },
    // one row on or off for new conversations here (the engine's one writer,
    // the folder's local settings); a refusal says what decides. The screen
    // reads the rows again after.
    // `agent`: that agent's own line («Only <agent>») — kept by Silos and
    // carried into its launches, never a file of the folder
    loadsSwitch(folder: string, key: string, to: 'on' | 'off', agent?: string): Promise<{ folder: string; ok: boolean }> {
      return req<{ folder: string; ok: boolean }>(`/api/folders/${encodeURIComponent(folder)}/loads/switch`, {
        method: 'POST',
        body: JSON.stringify({ key, to, ...(agent ? { scope: 'agent', agent } : {}) }),
      })
    },
    // one row for ONE conversation (its column): kept by Silos under the
    // thread the server resolves from the session id, carried into its next start
    loadsSwitchHere(folder: string, key: string, to: 'on' | 'off', conversation: string): Promise<{ folder: string; ok: boolean }> {
      return req<{ folder: string; ok: boolean }>(`/api/folders/${encodeURIComponent(folder)}/loads/switch`, {
        method: 'POST',
        body: JSON.stringify({ key, to, scope: 'conversation', conversation }),
      })
    },
    // one row on or off at a place of its «Where it loads» — `machine` writes
    // the user's own settings and answers which logins Silos connects followed
    loadsSwitchAt(folder: string, key: string, to: 'on' | 'off', scope: 'project' | 'machine'): Promise<LoadsSwitchAnswer> {
      return req<LoadsSwitchAnswer>(`/api/folders/${encodeURIComponent(folder)}/loads/switch`, { method: 'POST', body: JSON.stringify({ key, to, scope }) })
    },
    // «Turn all off / on» on a head at one place: the preview, or the click (one write) — spec scopes §4
    loadsBulk(
      folder: string,
      body: {
        keys: string[]
        origins: ('plugins' | 'connectors' | 'skills')[]
        skills?: BulkSkill[]
        to: 'on' | 'off'
        group: string
        preview?: boolean
      } & BulkPlace,
    ): Promise<{ folder: string; preview?: BulkPreview; done?: BulkPreview; logins?: LoadsSwitchAnswer['logins'] }> {
      return req(`/api/folders/${encodeURIComponent(folder)}/loads/bulk`, { method: 'POST', body: JSON.stringify(body) })
    },
    // «Undo» on the head that click was made on
    loadsBulkUndo(folder: string, body: { group: string } & BulkPlace): Promise<{ folder: string; ok: boolean }> {
      return req(`/api/folders/${encodeURIComponent(folder)}/loads/bulk/undo`, { method: 'POST', body: JSON.stringify(body) })
    },
    // «Only <agent>» on a row's agent line: the two-sided set, said first (`preview`) then written
    loadsOnly(folder: string, key: string, agent: string, preview: boolean): Promise<{ folder: string; preview?: OnlyAgentPlan; done?: OnlyAgentPlan }> {
      return req(`/api/folders/${encodeURIComponent(folder)}/loads/only`, { method: 'POST', body: JSON.stringify({ key, agent, preview }) })
    },
    // how many projects Silos manages load this row now (the machine line's «off», said first)
    loadsReach(folder: string, key: string): Promise<{ projects: number }> {
      return req<{ projects: number }>(`/api/folders/${encodeURIComponent(folder)}/loads/reach?key=${encodeURIComponent(key)}`)
    },
    // an account origin's head: all the plugins or connectors your Claude
    // account sends, on or off for new conversations here (only its key)
    loadsOrigin(folder: string, origin: 'plugins' | 'skills' | 'connectors', to: 'on' | 'off'): Promise<{ folder: string; ok: boolean }> {
      return req<{ folder: string; ok: boolean }>(`/api/folders/${encodeURIComponent(folder)}/loads/switch`, {
        method: 'POST',
        body: JSON.stringify({ origin, to }),
      })
    },
    // an origin's head at one place of its «Where it loads»: `machine` (its
    // «off» only with `confirmed` — the owner said yes to its sentence) or an agent
    loadsOriginAt(
      folder: string,
      origin: 'plugins' | 'skills' | 'connectors',
      to: 'on' | 'off',
      at: { scope: 'machine'; confirmed?: boolean } | { scope: 'agent'; agent: string } | { scope: 'project' },
    ): Promise<LoadsSwitchAnswer> {
      return req<LoadsSwitchAnswer>(`/api/folders/${encodeURIComponent(folder)}/loads/switch`, { method: 'POST', body: JSON.stringify({ origin, to, ...at }) })
    },
    // each engine's heads for this whole machine, outside any folder (Settings)
    machineHeads(): Promise<MachineHeads> {
      return req<MachineHeads>('/api/loads/machine')
    },
    machineHeadSwitch(
      engine: string,
      origin: 'plugins' | 'skills' | 'connectors',
      to: 'on' | 'off',
      confirmed: boolean,
    ): Promise<{ ok: boolean; logins?: LoadsSwitchAnswer['logins'] }> {
      return req<{ ok: boolean; logins?: LoadsSwitchAnswer['logins'] }>('/api/loads/machine', {
        method: 'POST',
        body: JSON.stringify({ engine, origin, to, confirmed }),
      })
    },
    // a plugin this project does not load, opened: what it would add to every
    // start in its engine's own estimate (tokens null: it can't say)
    loadsProjected(folder: string, key: string): Promise<{ key: string; tokens: number | null; by?: string }> {
      return req<{ key: string; tokens: number | null; by?: string }>(`/api/folders/${encodeURIComponent(folder)}/loads/projected`, {
        method: 'POST',
        body: JSON.stringify({ key }),
      })
    },
  },
  // the Silo Standard's registry and pages (Task 8): descriptors, a kind's
  // records as the list page paints them (server-paginated, counted over the
  // whole set), one record with its journal story, and the v0 owner actions.
  // Task mode: whether it runs and who is in it; a
  // task's wake panel; «Work on this» (a console of its bound owner with the
  // task's briefing — resumed or new)
  taskMode(): Promise<TaskModeStatus> {
    return req<TaskModeStatus>('/api/task-mode')
  },
  // the tasks this conversation works — the inverse of conversations[],
  // closed over rotations by the thread root
  // `closed`: a task of a plan under plans/closed/ — resolved read-only for
  // the reference, never in a list
  // `current`: this conversation is still on it — false once
  // its thread was unlinked (the header says «Worked on ✓»)
  sessionTasks(folder: string, id: string): Promise<{ tasks: SessionTaskLine[] }> {
    return req<{ tasks: SessionTaskLine[] }>(`/api/sessions/${encodeURIComponent(folder)}/${encodeURIComponent(id)}/tasks`)
  },
  // the same reading for every conversation at once (the sidebar's ☑):
  // { [sessionId]: tasks } — the server's sessionTasks, never recomputed here
  // Tasks › Done's Plans strip: the finished plans, newest first (owner-only)
  tasksClosedPlans(): Promise<{ plans: ClosedPlanEntry[] }> {
    return req<{ plans: ClosedPlanEntry[] }>('/api/tasks/closed-plans')
  },
  tasksBySession(session?: string): Promise<Record<string, SessionTaskLine[]>> {
    return req<Record<string, SessionTaskLine[]>>(`/api/tasks/by-session${session ? `?session=${encodeURIComponent(session)}` : ''}`)
  },
  // «Unlink…» (⌘K and the task page): the Plans silo's release
  // verb — the thread turns history. `state` (dispose) is written in the same
  // write only when the task is in_progress and this was its LAST current
  // thread; without it the task goes back to pending. The answer says what
  // happened: `kept` the state it left untouched, `already` the mark was
  // there (nothing written).
  // `wait`: what a «blocked» waits on, written in the release's own write
  tasksRelease(input: {
    key: string
    session: string
    folder?: string
    state?: ReleaseState
    wait?: { owner: string; action: string; asked?: string }
  }): Promise<ReleaseAnswer> {
    return req<ReleaseAnswer>('/api/tasks/release', { method: 'POST', body: JSON.stringify(input) })
  },
  // the owner's ONE link (server ownerLink): pending or
  // in_progress → linked + in_progress (the claim); blocked or in_review →
  // listed, the state left as it is («Linked to»)
  tasksLink(input: { key: string; session: string }): Promise<{ linked?: boolean; state?: string; warn?: string }> {
    return req<{ linked?: boolean; state?: string; warn?: string }>('/api/tasks/link', { method: 'POST', body: JSON.stringify(input) })
  },
  // waking on assignment is a GESTURE: New task after its
  // writes, the task page's «Start X ›» (Give to X). `why`: the server's sentence
  // when nothing was queued (its owner moves another way, a wake is already
  // on its way…)
  // the owner's gesture on ONE task, ONE write (lib/task-gesture.ts act
  // is its one caller): answer · approve · done ·
  // drop · reopen · park · resume · remove-dependency. A refused condition is
  // a 409 in the verb's words («it asks something else now»)
  tasksAct(body: { key: string; verb: TaskActVerb } & TaskActArgs): Promise<TaskActAnswer> {
    return req<TaskActAnswer>('/api/tasks/act', { method: 'POST', body: JSON.stringify(body) })
  },
  // a new task in ONE request: the server makes the
  // project's list when `plan` is it, assigns the id, writes the task with
  // its details as its first note (and the conversation it is born from,
  // in progress), and with `give` does the owner's gesture — `assign` says
  // whether it started or why not
  tasksNew(body: { folder: string; plan: string; title: string; owner: string; details?: string; session?: string; give?: boolean }): Promise<TaskNewAnswer> {
    return req<TaskNewAnswer>('/api/tasks/new', { method: 'POST', body: JSON.stringify(body) })
  },
  tasksAssign(key: string): Promise<{ queued: boolean; why?: string; held?: string; wakes?: string }> {
    return req<{ queued: boolean; why?: string; held?: string; wakes?: string }>('/api/tasks/assign', { method: 'POST', body: JSON.stringify({ key }) })
  },
  // the defaults of an agent's own knobs (GET /api/agents says them)
  async agentDefaults(): Promise<{ turns: number | null; spend: number | null }> {
    const r = await req<{ ownTurnsPerDayDefault?: number; unattendedSpendPerDayDefault?: number }>('/api/agents')
    return { turns: r.ownTurnsPerDayDefault ?? null, spend: r.unattendedSpendPerDayDefault ?? null }
  },
  // its task wakes today, their cost and its ceiling
  async agentTaskWakes(agentId: string): Promise<AgentTaskWakes> {
    const r = await req<TaskModeToday>(`/api/task-mode/today?agent=${encodeURIComponent(agentId)}`)
    return { today: r.woke, costUsd: r.costUsd, ceiling: r.ceiling }
  },
  // «Open chat ›»: one briefed turn on the
  // task's own thread, chat lane, any agent owner — bound or not
  tasksTalk(key: string): Promise<{ folder: string; sessionId: string; isNew: boolean; folded: number }> {
    return req<{ folder: string; sessionId: string; isNew: boolean; folded: number }>('/api/tasks/talk', { method: 'POST', body: JSON.stringify({ key }) })
  },
  taskWakes(key: string): Promise<TaskModeView> {
    return req<TaskModeView>(`/api/tasks/mode?key=${encodeURIComponent(key)}`)
  },
  // the task feed: the visible reply of every turn the machinery sent for
  // this task, read from its thread's transcripts
  tasksFeed(key: string): Promise<{ items: TaskFeedCard[] }> {
    return req<{ items: TaskFeedCard[] }>(`/api/tasks/feed?key=${encodeURIComponent(key)}`)
  },
  // `instead`: a conversation current on the task — the new conversation
  // takes the task and that one is released, status kept
  workOnTask(key: string, theme: 'light' | 'dark', instead?: string): Promise<TaskWorkAnswer> {
    return req<TaskWorkAnswer>('/api/tasks/work', { method: 'POST', body: JSON.stringify({ key, theme, ...(instead !== undefined ? { instead } : {}) }) })
  },
  silos: {
    list(): Promise<{ silos: SiloDescriptor[]; uninstalled?: SiloUninstalled[]; available?: SiloAvailable[] }> {
      return req<{ silos: SiloDescriptor[]; uninstalled?: SiloUninstalled[]; available?: SiloAvailable[] }>('/api/silos')
    },
    // the owner's own switches on an installed silo (operator.json): which
    // slots are off, which needs-you entries do not route
    operator(id: string, patch: { slotsOff?: string[]; audienceOff?: number[]; producers?: string[] }): Promise<unknown> {
      return req<unknown>(`/api/silos/${encodeURIComponent(id)}/operator`, { method: 'PATCH', body: JSON.stringify(patch) })
    },
    // an edge-only silo's relation: the edges the owner drew, and
    // the one edge from `from` set or cleared (to: null) — owner-only
    relation(id: string, name: string): Promise<SiloRelationReading> {
      return req<SiloRelationReading>(`/api/silos/${encodeURIComponent(id)}/relations/${encodeURIComponent(name)}`)
    },
    setRelation(id: string, name: string, from: string, to: string | null): Promise<SiloRelationReading> {
      return req<SiloRelationReading>(`/api/silos/${encodeURIComponent(id)}/relations/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify({ from, to }),
      })
    },
    // the escalation's window (hours) and its cases
    escalation(): Promise<EscalationView> {
      return req<EscalationView>('/api/escalation')
    },
    setEscalationWindow(windowHours: number): Promise<EscalationView> {
      return req<EscalationView>('/api/escalation', { method: 'PUT', body: JSON.stringify({ windowHours }) })
    },
    // the «retire» half of the inventory's promise — non-destructive on the
    // server (the manifest moves aside; records, files and conventions stay)
    uninstall(id: string): Promise<{ uninstalled?: string }> {
      return req<{ uninstalled?: string }>(`/api/silos/${encodeURIComponent(id)}/uninstall`, { method: 'POST', body: '{}' })
    },
    // the owner's door back (Settings › Silos): submit the manifest Silos
    // already holds for this id; a 409 carries the submission already waiting
    resubmit(id: string): Promise<{ submission: { id: string; submittedBy: string; at: string; state: 'pending' } }> {
      return req<{ submission: { id: string; submittedBy: string; at: string; state: 'pending' } }>(`/api/silos/${encodeURIComponent(id)}/resubmit`, {
        method: 'POST',
        body: '{}',
      })
    },
    // installing from the catalog («Available» in Settings › Silos) — the
    // reference manifest goes through the normal submission
    installAvailable(id: string): Promise<{ submission: { id: string } }> {
      return req<{ submission: { id: string } }>(`/api/silos/available/${encodeURIComponent(id)}/submit`, { method: 'POST', body: '{}' })
    },
    // the owner's own manifest (the «Install a silo…» door) — same route an
    // agent's bearer uses, as the owner
    submitManifest(manifest: unknown): Promise<{ submission: { id: string } }> {
      return req<{ submission: { id: string } }>('/api/silos/submissions', { method: 'POST', body: JSON.stringify({ manifest }) })
    },
    records(
      id: string,
      q: {
        kind?: string
        id?: string
        rank?: 'needs-you'
        facets?: Record<string, string>
        folded?: 'include' | 'exclude' | 'only'
        q?: string
        offset?: number
        limit?: number
        values?: boolean
      } = {},
    ): Promise<SiloRecordsPage> {
      const p = new URLSearchParams()
      if (q.kind) p.set('kind', q.kind)
      if (q.values) p.set('values', '1')
      if (q.id) p.set('id', q.id)
      if (q.rank) p.set('rank', q.rank)
      for (const [f, v] of Object.entries(q.facets ?? {})) p.set(`facet.${f}`, v)
      if (q.folded) p.set('folded', q.folded)
      if (q.q && q.q.trim() !== '') p.set('q', q.q.trim())
      if (q.offset !== undefined) p.set('offset', String(q.offset))
      if (q.limit !== undefined) p.set('limit', String(q.limit))
      const qs = p.toString()
      return req<SiloRecordsPage>(`/api/silos/${encodeURIComponent(id)}/records${qs ? `?${qs}` : ''}`)
    },
    record(id: string, key: string): Promise<SiloRecordDetail> {
      return req<SiloRecordDetail>(`/api/silos/${encodeURIComponent(id)}/record?key=${encodeURIComponent(key)}`)
    },
    // the record read from an absolute FILE path (plans: the column's
    // PlanView, the FileViewer know the file, not the key) — a file no
    // location of the silo holds comes back `outside` and read-only
    recordByFile(id: string, file: string): Promise<SiloRecordDetail> {
      return req<SiloRecordDetail>(`/api/silos/${encodeURIComponent(id)}/record?file=${encodeURIComponent(file)}`)
    },
    // set-field carries the CAS token read with the record — a 409 means
    // someone wrote first (the caller re-reads and retries with the new one).
    // a kernel-verb (the closed catalog: stop-process): the owner asks the
    // kernel to act on one record; the answer says what happened in words
    kernelVerb(id: string, body: { key: string; name: string }): Promise<KernelVerbAnswer> {
      return req<KernelVerbAnswer>(`/api/silos/${encodeURIComponent(id)}/record/kernel-verb`, { method: 'POST', body: JSON.stringify(body) })
    },
    setField(id: string, body: { key: string; field: string; value: unknown; version?: string }): Promise<SiloSetFieldResult> {
      return req<SiloSetFieldResult>(`/api/silos/${encodeURIComponent(id)}/record/set-field`, { method: 'POST', body: JSON.stringify(body) })
    },
    // append-item: the owner adds a child (a note) to a declared sub-kind
    append(id: string, body: { key: string; collection: string; values: Record<string, string>; version?: string }): Promise<unknown> {
      return req<unknown>(`/api/silos/${encodeURIComponent(id)}/record/append`, { method: 'POST', body: JSON.stringify(body) })
    },
    // ensure-record: the silo's reserved record in a project exists (plans:
    // the project's list plans/tasks.plan.json, made from the seed when
    // missing, rotated monthly) — its key and its record as read after
    ensure(
      id: string,
      body: { folder: string; id: string },
    ): Promise<{ key: string; created: boolean; rotated: string[]; record: { record: Record<string, unknown> } }> {
      return req<{ key: string; created: boolean; rotated: string[]; record: { record: Record<string, unknown> } }>(
        `/api/silos/${encodeURIComponent(id)}/record/ensure`,
        { method: 'POST', body: JSON.stringify(body) },
      )
    },
    // respond: ONE gesture on a gate of the owner's — the gate closes first
    // (its Done judged on the state you saw — 409 «it changed»), then the
    // text lands as an owner note on each open agent task waiting on it
    // directly; a note that did not land is said
    // (`closed`, `missing`) and sending it again writes only those
    respond(id: string, body: { key: string; text: string; state: string }): Promise<SiloSetFieldResult & { notified: Array<{ key: string; owner: string }> }> {
      return req<SiloSetFieldResult & { notified: Array<{ key: string; owner: string }> }>(`/api/silos/${encodeURIComponent(id)}/record/respond`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    // move-item: a child (<record key>/<collection>/<id>) to a sibling record;
    // `version` is the CAS of the record the owner is looking at (409 = stale)
    move(id: string, childKey: string, to: string, version?: string): Promise<unknown> {
      return req<unknown>(`/api/silos/${encodeURIComponent(id)}/record/move`, {
        method: 'POST',
        body: JSON.stringify({ key: childKey, to, ...(version ? { version } : {}) }),
      })
    },
    ack(id: string, key: string): Promise<unknown> {
      return req<unknown>(`/api/silos/${encodeURIComponent(id)}/record/ack`, { method: 'POST', body: JSON.stringify({ key }) })
    },
    // the message waits in each producer's inbox, read at its next conversation
    message(id: string, key: string, template: number): Promise<SiloMessageResult> {
      return req<SiloMessageResult>(`/api/silos/${encodeURIComponent(id)}/record/message`, { method: 'POST', body: JSON.stringify({ key, template }) })
    },
    // the filled template becomes a task of the producer (owner only):
    // assigned when it is On its own, else the page opens it with it
    makeTask(id: string, key: string, template: number): Promise<SiloMakeTaskResult> {
      return req<SiloMakeTaskResult>(`/api/silos/${encodeURIComponent(id)}/record/make-task`, { method: 'POST', body: JSON.stringify({ key, template }) })
    },
    resolve(id: string, key: string, field: string, choice: 'keep-mine' | 'take-source'): Promise<unknown> {
      return req<unknown>(`/api/silos/${encodeURIComponent(id)}/record/resolve`, { method: 'POST', body: JSON.stringify({ key, field, choice }) })
    },
    async proposals(id: string): Promise<SiloProposalView[]> {
      const { proposals } = await req<{ proposals: SiloProposalView[] }>(`/api/silos/${encodeURIComponent(id)}/proposals`)
      return proposals
    },
    decideProposal(id: string, pid: string, choice: 'approve' | 'reject', reason?: string): Promise<unknown> {
      return req<unknown>(`/api/silos/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/${choice}`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      })
    },
    // installing (server silos/installer.ts): the pending manifests, what
    // approving one would do (derived for the binding being weighed), and
    // the owner's two decisions
    async submissions(): Promise<SiloSubmissionRow[]> {
      const { submissions } = await req<{ submissions: SiloSubmissionRow[] }>('/api/silos/submissions')
      return submissions
    },
    consequences(id: string, producers?: readonly string[]): Promise<SiloConsequences> {
      const qs = producers ? `?producers=${producers.map(encodeURIComponent).join(',')}` : ''
      return req<SiloConsequences>(`/api/silos/submissions/${encodeURIComponent(id)}/consequences${qs}`)
    },
    approve(id: string, body: { producers: string[]; automation: boolean; slotsOff?: string[] }): Promise<{ kind: string; silo: SiloDescriptor | null }> {
      return req<{ kind: string; silo: SiloDescriptor | null }>(`/api/silos/submissions/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    reject(id: string, reason: string | null): Promise<{ rejected: string; reason: string | null }> {
      return req<{ rejected: string; reason: string | null }>(`/api/silos/submissions/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      })
    },
  },
  // muted folders — informational (Settings › Maintenance).
  async muted(): Promise<string[]> {
    const { muted } = await req<{ muted: string[] }>('/api/muted')
    return muted
  },
  // who the machine's own Claude login is (Claude's `claude auth status`);
  // null = signed out. An API-key login has no email nor plan.
  account(): Promise<{ email: string | null; plan: string | null; organizationName: string | null } | null> {
    return req('/api/account')
  },
  // this install's Silos version and whether a newer one is published
  // (server update-check.ts; Settings › About and the date line's chip)
  update(): Promise<{ installed: string; kind: string; latest: string | null; newer: boolean; how: string }> {
    return req('/api/update')
  },
  // Claude Code transcript retention (cleanupPeriodDays) — read, and the
  // only managed setting Silos writes to ~/.claude/settings.json.
  claudeSettings(): Promise<{
    cleanupPeriodDays: number
    explicit: boolean
    agentPushNotifEnabled: boolean
    pushExplicit: boolean
    todoTools: boolean
    hooks: SilosHooks
    path: string
    keepForeverDays: number
  }> {
    return req('/api/claude-settings')
  },
  setCleanupPeriodDays(days: number): Promise<{ view: { cleanupPeriodDays: number; explicit: boolean; path: string }; backup: string | null }> {
    return req('/api/claude-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cleanupPeriodDays: days }) })
  },
  setTodoTools(enabled: boolean): Promise<{ view: { todoTools: boolean }; backup: string | null }> {
    return req('/api/claude-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ todoTools: enabled }) })
  },
  setAgentPushNotif(enabled: boolean): Promise<{ view: { agentPushNotifEnabled: boolean }; backup: string | null }> {
    return req('/api/claude-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPushNotifEnabled: enabled }),
    })
  },
  installClaudeHooks(): Promise<{ view: { hooks: SilosHooks }; backup: string | null }> {
    return req('/api/claude-settings/hooks', { method: 'POST' })
  },
  uninstallClaudeHooks(): Promise<{ view: { hooks: SilosHooks }; backup: string | null }> {
    return req('/api/claude-settings/hooks', { method: 'DELETE' })
  },
  // who is on each Claude account right now (Home's one line under the pulse)
  accountLoad(): Promise<AccountLoad> {
    return req<AccountLoad>('/api/account-load')
  },
  // a Claude account's 5h/weekly windows (the runs-on line's bars)
  planUsage(provider: string): Promise<PlanUsage | null> {
    return req<PlanUsage | null>(`/api/plan-usage?provider=${encodeURIComponent(provider)}`)
  },
  // the harness (Claude Code): versions per engine + `claude update` for
  // the console's binary. 409 while another update runs.
  // the engines the server registered, in registration order (design D.4)
  harnesses(): Promise<{ harnesses: HarnessDescriptor[] }> {
    return req<{ harnesses: HarnessDescriptor[] }>('/api/harnesses')
  },
  harness(): Promise<HarnessStatus> {
    return req<HarnessStatus>('/api/harness')
  },
  // `opencode` runs `opencode upgrade`; default = `claude update`
  updateHarness(harness?: HarnessId): Promise<HarnessUpdate> {
    return req<HarnessUpdate>('/api/harness/update', { method: 'POST', ...(harness ? { body: JSON.stringify({ harness }) } : {}) })
  },
  // UI preferences (projects menu) — GET always 200 (the server returns {}
  // when there's no file yet); PATCH sends only the sub-shape that
  // changed, the server does a shallow merge.
  prefs(): Promise<Prefs> {
    return req<Prefs>('/api/prefs')
  },
  patchPrefsProjects(patch: ProjectsPrefs): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ projects: patch }) })
  },
  // the agent page's contextOpen (ContextColumn) — the same endpoint,
  // a sibling field of `projects`.
  patchPrefsContext(v: boolean): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ contextOpen: v }) })
  },
  // one engine's console colours (prefs.consoleTheme, merged per engine)
  patchPrefsConsoleTheme(harness: string, v: 'silos' | 'own'): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ consoleTheme: { [harness]: v } }) })
  },
  // the terminal panel's height.
  patchPrefsTerminal(height: number): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ terminal: { height } }) })
  },
  // font size (px) of the console/terminal panes — Settings › Appearance.
  patchPrefsTerminalFont(size: number): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ terminal: { fontSize: size } }) })
  },
  // agentIds whose row is collapsed in the Sidebar.
  patchPrefsCollapsedAgents(agentIds: string[]): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ collapsedAgents: agentIds }) })
  },
  // the owner's drag order of agent rows in the Sidebar (global list of agentIds).
  patchPrefsContextScope(scope: string): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ contextScope: scope }) })
  },
  patchPrefsAgentOrder(agentIds: string[]): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ agentOrder: agentIds }) })
  },
  // the owner's order of conversations per agent (chain keys, top first) —
  // a total replacement of the whole map, like agentOrder.
  // per agent: only the agents in `slots` change, the server merges.
  patchPrefsConversationSlots(slots: Record<string, { key: string; at: number }[]>): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ conversationSlots: slots }) })
  },
  // conversations detached from their chain by drag (session keys).
  patchPrefsDetachedChains(keys: string[]): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ detachedChains: keys }) })
  },
  // the context column's "Agent setup" zone (expanded or not).
  patchPrefsSetup(v: boolean): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ setup: v }) })
  },
  // Map › Uses' axes and window.
  patchPrefsUses(p: UsesPrefs): Promise<Prefs> {
    return req<Prefs>('/api/prefs', { method: 'PATCH', body: JSON.stringify({ uses: p }) })
  },
  // the terminal panel's PTYs under the chat — create (by agentId or cwd) and kill.
  terminals: {
    create(input: { agentId?: string; cwd?: string }): Promise<TerminalHandle> {
      return req<TerminalHandle>('/api/terminals', { method: 'POST', body: JSON.stringify(input) })
    },
    async kill(id: string): Promise<void> {
      await req(`/api/terminals/${id}`, { method: 'DELETE' })
    },
  },
  // the real console: makes sure the real `claude` is running in its tmux
  // session. With sessionId it does --resume of that session; with agentId
  // (and no sessionId) it opens a fresh claude in the agent's folder (a
  // new conversation). Returns the console KEY; the screen is streamed by
  // answer an open AskUserQuestion: the server types it into the console
  // when one runs for this conversation ({ engine: 'console' }); otherwise
  // { engine: 'chat' } and the caller sends the label as a normal turn.
  // `answers` (the form: one label list per question) is answered in place
  // by an engine that can ({ engine: 'ask' } — an OpenCode question), else
  // { engine: 'chat' } and the caller sends the composed answers.
  answer(folder: string, id: string, index: number, answers?: string[][]): Promise<{ engine: 'console' | 'chat' | 'ask' }> {
    return req<{ engine: 'console' | 'chat' | 'ask' }>(`/api/sessions/${encodeURIComponent(folder)}/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify(answers ? { index, answers } : { index }),
    })
  },
  // /ws/console/:key (one tmux client per socket, see TerminalView).
  // closes a console for good: kills the background claude + its tmux
  // session (reopening resumes the conversation from its JSONL).
  consoleClose(key: string): Promise<{ ok: true }> {
    return req<{ ok: true }>(`/api/console/${encodeURIComponent(key)}`, { method: 'DELETE' })
  },
  // where the console's tmux view stands: `position` = rows above the
  // bottom (0 = live, at the bottom), `history` = rows of scrollback,
  // `rows` = the pane height. Drawn as the pane's own scrollbar (see
  // ConsoleScrollbar in TerminalPanel.tsx).
  consoleScroll(key: string): Promise<{ position: number; history: number; rows: number }> {
    return req(`/api/console/${encodeURIComponent(key)}/scroll`)
  },
  // moves the tmux view to `position` rows above the bottom (0 leaves
  // copy-mode: back to live). Answers with where it actually landed.
  consoleScrollTo(key: string, position: number): Promise<{ position: number; history: number; rows: number }> {
    return req(`/api/console/${encodeURIComponent(key)}/scroll`, { method: 'POST', body: JSON.stringify({ position }) })
  },
  // `theme`: the UI's theme when opening — the server tells the console's
  // claude to match (its own light/dark), see defaultConsoleCommand.
  // Returns the console's BIRTH theme too: a reused console keeps the theme
  // its claude was spawned with — the pane must render with that one.
  // `provider` pins a NEW console's conversation to an account or key (the
  // server persists it as the conversation's pref); an existing session's
  // pin is read server-side from its prefs.
  // `closeHolders` asks the server to close a claude outside Silos that
  // still holds the conversation (SIGHUP, then SIGTERM) and open in the
  // same gesture — offered only when a refusal came back with canClose.
  console(input: {
    sessionId?: string
    agentId?: string
    theme?: 'light' | 'dark'
    provider?: string
    model?: string
    outputStyle?: string
    closeHolders?: boolean
  }): Promise<{ key: string; theme: 'light' | 'dark' }> {
    return req<{ key: string; theme: 'light' | 'dark' }>('/api/console', {
      method: 'POST',
      body: JSON.stringify({
        id: input.sessionId,
        agentId: input.agentId,
        ...(input.theme ? { theme: input.theme } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.outputStyle ? { outputStyle: input.outputStyle } : {}),
        ...(input.closeHolders ? { closeHolders: true } : {}),
      }),
    })
  },
  // the Agent panel: an omitted folder skips project/autoMemory; agentId
  // additionally requests that agent's "Agent memory" layer.
  memory: {
    list(folder?: string, agentId?: string): Promise<MemoryLayers> {
      const params = new URLSearchParams()
      if (folder !== undefined) params.set('folder', folder)
      if (agentId !== undefined) params.set('agent', agentId)
      const qs = params.toString()
      return req<MemoryLayers>(`/api/memory${qs ? `?${qs}` : ''}`)
    },
    // `folder`: the page's folder — any file the server lists for it opens
    async read(path: string, folder?: string): Promise<string> {
      const { content } = await req<{ content: string }>(
        `/api/memory/file?path=${encodeURIComponent(path)}${folder ? `&folder=${encodeURIComponent(folder)}` : ''}`,
      )
      return content
    },
    // a write is judged against the server's own list (spec memory-places
    // T3): `confirmed` for the machine's files (409 without), `ignoreLine`
    // on a create of the private file, `folder` the page's folder
    write(
      path: string,
      content: string,
      opts: { folder?: string; confirmed?: boolean; ignoreLine?: boolean } = {},
    ): Promise<{ ok: boolean; backup: string | null; ignored?: boolean }> {
      return req<{ ok: boolean; backup: string | null; ignored?: boolean }>('/api/memory/file', {
        method: 'PUT',
        body: JSON.stringify({ path, content, ...opts }),
      })
    },
  },
  // the file viewer/editor: metadata, bytes (text or blob), and saving.
  // Behind the global token like every /api/*. Blobs are requested with
  // fetch+header (no ?token= in the URL): the token never travels in an
  // <img>/<embed>'s URL — it's read from the response as a blob and served
  // via objectURL.
  file: {
    meta(path: string): Promise<FileMeta> {
      return req<FileMeta>(`/api/file?path=${encodeURIComponent(path)}`)
    },
    // text content (markdown/code) for inline render/edit.
    async text(path: string): Promise<string> {
      const res = await fetch(`/api/file/raw?path=${encodeURIComponent(path)}`, { headers: { 'x-token': getToken() } })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status, body)
      }
      return res.text()
    },
    // bytes as a Blob (inline image/pdf, or a download with download=true) —
    // the caller creates/revokes the objectURL. Never puts the token in the URL.
    async blob(path: string, download = false): Promise<Blob> {
      const qs = download ? '&download=1' : ''
      const res = await fetch(`/api/file/raw?path=${encodeURIComponent(path)}${qs}`, { headers: { 'x-token': getToken() } })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status, body)
      }
      return res.blob()
    },
    write(path: string, content: string): Promise<{ ok: boolean; backup: string | null }> {
      return req<{ ok: boolean; backup: string | null }>('/api/file', {
        method: 'PUT',
        body: JSON.stringify({ path, content }),
      })
    },
    // Explorer: lists a folder (folders first). The resolved REAL path comes
    // back in the response (useful for the breadcrumb).
    // opts.optional: a probe by convention — a missing folder resolves to an
    // empty listing (200) instead of a 404 logged red by the browser.
    dir(path: string, opts?: { optional?: boolean }): Promise<{ path: string; entries: DirEntry[] }> {
      const q = `path=${encodeURIComponent(path)}${opts?.optional ? '&optional=1' : ''}`
      return req<{ path: string; entries: DirEntry[] }>(`/api/dir?${q}`)
    },
  },
  // Creates a folder (recursive, idempotent) — how a new project's path
  // comes to exist before the first conversation points at it.
  mkdir(path: string): Promise<{ path: string }> {
    return req<{ path: string }>('/api/mkdir', { method: 'POST', body: JSON.stringify({ path }) })
  },
  // full-text search across conversation transcripts (message text only).
  // unsearchedBy: the unsearched count split by engine id
  search(q: string): Promise<{ hits: SearchHit[]; scanned: number; truncated: boolean; unsearched?: number; unsearchedBy?: Record<string, number> }> {
    return req<{ hits: SearchHit[]; scanned: number; truncated: boolean; unsearched?: number; unsearchedBy?: Record<string, number> }>(
      `/api/search?q=${encodeURIComponent(q)}`,
    )
  },
  // the Vault: env credentials for agent processes. Values arrive MASKED —
  // the real secret never leaves the server.
  vault: {
    async list(): Promise<VaultEntry[]> {
      const { entries } = await req<{ entries: VaultEntry[] }>('/api/vault')
      return entries
    },
    // the live binding asks: what each signature would unblock, said
    // before the gesture — never a value
    async asks(): Promise<BindingAsk[]> {
      const { asks } = await req<{ asks: BindingAsk[] }>('/api/vault/asks')
      return asks
    },
    async create(input: { name: string; value: string; scope: VaultScope; public?: boolean; binding?: VaultBinding }): Promise<VaultEntry> {
      const { entry } = await req<{ entry: VaultEntry }>('/api/vault', { method: 'POST', body: JSON.stringify(input) })
      return entry
    },
    // visibility is editable in place — the value never travels here. A
    // signed entry moved to a wider audience comes back with `warnings`: the
    // agents that would see it without being able to sign.
    async setScope(id: string, scope: VaultScope): Promise<{ entry: VaultEntry; warnings: string[] }> {
      const r = await req<{ entry: VaultEntry; warnings?: string[] }>(`/api/vault/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ scope }),
      })
      return { entry: r.entry, warnings: r.warnings ?? [] }
    },
    // delivered ⇄ signed in place: a binding signs
    // it, null hands it over again — the value never travels here. The
    // server's refusals arrive as the thrown message, its warnings here.
    async setBinding(id: string, binding: VaultBinding | null): Promise<{ entry: VaultEntry; warnings: string[]; resolved?: BindingResolution }> {
      const r = await req<{ entry: VaultEntry; warnings?: string[]; resolved?: BindingResolution }>(`/api/vault/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ binding }),
      })
      return { entry: r.entry, warnings: r.warnings ?? [], ...(r.resolved ? { resolved: r.resolved } : {}) }
    },
    // the signed calls' log, newest first (owner-only): by entry or by agent
    async signedCalls(filter: { entry?: string; agent?: string; limit?: number }): Promise<SignedCall[]> {
      const q = new URLSearchParams()
      if (filter.entry) q.set('entry', filter.entry)
      if (filter.agent) q.set('agent', filter.agent)
      if (filter.limit) q.set('limit', String(filter.limit))
      const { rows } = await req<{ rows: SignedCall[] }>(`/api/vault/signed-calls?${q.toString()}`)
      return rows
    },
    // the owner's judgement, in place: plain configuration (shown in clear,
    // never redacted) or a secret — the value never travels here either.
    async setPublic(id: string, isPublic: boolean): Promise<VaultEntry> {
      const { entry } = await req<{ entry: VaultEntry }>(`/api/vault/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ public: isPublic }),
      })
      return entry
    },
    remove(id: string): Promise<{ ok: true }> {
      return req<{ ok: true }>(`/api/vault/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  },
  // Messages between agents — the server's store (server/src/messages.ts). As the owner (no bearer) this reads any
  // inbox and settles what an agent handed over (needs_owner).
  messages: {
    async list(agentId: string, state?: AgentMessageState): Promise<AgentMessage[]> {
      const { messages } = await req<{ messages: AgentMessage[] }>(`/api/agents/${encodeURIComponent(agentId)}/messages${state ? `?state=${state}` : ''}`)
      return messages
    },
    // what this agent SENT, across every recipient's inbox (live state + answer)
    async sent(agentId: string): Promise<AgentMessage[]> {
      const { messages } = await req<{ messages: AgentMessage[] }>(`/api/agents/${encodeURIComponent(agentId)}/messages/sent`)
      return messages
    },
    // it waits in the inbox and is read at the recipient's next conversation
    send(agentId: string, body: { text: string; replyTo?: string }): Promise<{ message: AgentMessage }> {
      return req<{ message: AgentMessage }>(`/api/agents/${encodeURIComponent(agentId)}/messages`, { method: 'POST', body: JSON.stringify(body) })
    },
    // `answer`: what was done, one paragraph ≤1000 (the agent's close; the
    // owner may leave one too when settling a hand-off)
    async setState(agentId: string, id: string, state: AgentMessageState, answer?: string): Promise<AgentMessage> {
      const { message } = await req<{ message: AgentMessage }>(`/api/agents/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(answer !== undefined ? { state, answer } : { state }),
      })
      return message
    },
  },
  // the agent's context: files you upload for the agent to read. list
  // returns shared (the folder's shared files) + agent (private).
  context: {
    // `conversation`: also the files given to THAT conversation (any session
    // id of it — the server resolves its thread)
    list(agentId: string, conversation?: string): Promise<{ shared: ContextFile[]; agent: ContextFile[]; conversation?: ContextFile[] }> {
      return req<{ shared: ContextFile[]; agent: ContextFile[]; conversation?: ContextFile[] }>(
        `/api/agents/${encodeURIComponent(agentId)}/context${conversation ? `?conversation=${encodeURIComponent(conversation)}` : ''}`,
      )
    },
    // uploads a file: the bytes go in base64 inside the JSON (no multipart).
    upload(agentId: string, scope: ContextScope, name: string, contentBase64: string, conversation?: string): Promise<ContextFile> {
      return req<ContextFile>(`/api/agents/${encodeURIComponent(agentId)}/context`, {
        method: 'POST',
        body: JSON.stringify({ scope, name, contentBase64, ...(conversation ? { conversation } : {}) }),
      })
    },
    // what the agent produced in its own state folder (scope 'own').
    produced(agentId: string): Promise<ContextFile[]> {
      return req<ContextFile[]>(`/api/agents/${encodeURIComponent(agentId)}/produced`)
    },
    remove(agentId: string, scope: ContextScope, name: string, conversation?: string): Promise<{ ok: boolean }> {
      return req<{ ok: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/context?scope=${scope}&name=${encodeURIComponent(name)}${conversation ? `&conversation=${encodeURIComponent(conversation)}` : ''}`,
        { method: 'DELETE' },
      )
    },
    // «Give to the agent»: a conversation's file moves up to the agent's own
    promote(agentId: string, conversation: string, name: string): Promise<ContextFile> {
      return req<ContextFile>(`/api/agents/${encodeURIComponent(agentId)}/context/promote`, { method: 'POST', body: JSON.stringify({ conversation, name }) })
    },
    // the threads holding given files (the agent's Files tab)
    conversations(agentId: string): Promise<GivenThread[]> {
      return req<GivenThread[]>(`/api/agents/${encodeURIComponent(agentId)}/context/conversations`)
    },
  },
  agents: {
    // GET /api/agents returns the raw registry (no sessions/counters);
    // all=1 includes archived ones — used by the Sidebar footer's "Archived" dropdown.
    async list(all?: boolean): Promise<AgentSummary[]> {
      const { agents } = await req<{ agents: AgentSummary[] }>(`/api/agents${all ? '?all=1' : ''}`)
      return agents
    },
    // the new-agent form: the server derives the id from the
    // name and, with no folder chosen, the folder (~/Silos/<id>); `warn` is
    // a territory that could not be turned on (the agent stays Only when told)
    // `startWarn`: a folder whose starting set could not be written (starting-set.ts)
    // `project`: a new one by name or one Silos knows (birth-project.ts); `control`: the two asks a birth takes
    async create(
      input: Partial<Omit<AgentView, 'mission' | 'id' | 'folder' | 'control'>> & {
        name: string
        folder?: string
        project?: { name: string } | { folder: string }
        mission?: MissionInput
        control?: 'told' | 'proactive'
      },
    ): Promise<{ agent: AgentView; warn?: string; startWarn?: string }> {
      return req<{ agent: AgentView; warn?: string; startWarn?: string }>('/api/agents', { method: 'POST', body: JSON.stringify(input) })
    },
    // `mission: null` clears it (the owner's); a null
    // knob goes back to its default, `cut: null` is «Allow again». The flip
    // to Only when told answers what still runs (`pending`, the sheet's).
    // `proactive: null` turns the proactive mode off
    async update(
      id: string,
      patch: Partial<Omit<AgentView, 'mission' | 'heartbeat' | 'ownTurnsPerDay' | 'unattendedSpendPerDay' | 'ownExemptDay' | 'cut' | 'proactive'>> & {
        mission?: MissionInput | null
        heartbeat?: Partial<HeartbeatSetting>
        ownTurnsPerDay?: number | null
        unattendedSpendPerDay?: number | null
        ownExemptDay?: string | null
        cut?: null
        proposal?: string
        proactive?: Partial<ProactiveSetting> | null
      },
    ): Promise<{ pending?: ControlPending; startWarn?: string } | undefined> {
      const r = await req<{ pending?: ControlPending; startWarn?: string } | undefined>(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      if (!r || typeof r !== 'object') return {}
      return { ...(r.pending ? { pending: r.pending } : {}), ...(typeof r.startWarn === 'string' ? { startWarn: r.startWarn } : {}) }
    },
    // the heartbeat's row and doors
    heartbeat(id: string): Promise<HeartbeatView> {
      return req<HeartbeatView>(`/api/agents/${encodeURIComponent(id)}/heartbeat`)
    },
    async heartbeatRunNow(id: string): Promise<void> {
      await req(`/api/agents/${encodeURIComponent(id)}/heartbeat/run-now`, { method: 'POST' })
    },
    async heartbeatWake(id: string): Promise<void> {
      await req(`/api/agents/${encodeURIComponent(id)}/heartbeat/wake`, { method: 'POST' })
    },
    // the «Only when told» sheet: stop its live turns, pause its own recurring
    // work — or Keep it (keptAt on its ledger entry)
    stop(id: string, body: { turns?: string[]; pause?: string[]; keep?: string[] }): Promise<{ stopped: string[]; paused: string[]; kept?: string[] }> {
      return req<{ stopped: string[]; paused: string[]; kept?: string[] }>(`/api/agents/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    async archive(id: string): Promise<void> {
      await req(`/api/agents/${id}/archive`, { method: 'POST' })
    },
    // the output styles the agent's engine offers (built-ins + the
    // operator's and the folder's style files); a conversation's own cwd when
    // `session` names one. Throws on an engine with none (OpenCode).
    async outputStyles(id: string, session?: { folder: string; id: string }): Promise<OutputStyleInfo[]> {
      const q = session ? `?folder=${encodeURIComponent(session.folder)}&session=${encodeURIComponent(session.id)}` : ''
      const { styles } = await req<{ styles: OutputStyleInfo[] }>(`/api/agents/${id}/output-styles${q}`)
      return styles
    },
    async unarchive(id: string): Promise<void> {
      await req(`/api/agents/${id}/unarchive`, { method: 'POST' })
    },
    // Knows & can › Loaded at start: what its sessions receive before the
    // first message, as its engine reads it from disk (null = can't say).
    loaded(id: string): Promise<LoadedAtStart | null> {
      return req<LoadedAtStart | null>(`/api/agents/${encodeURIComponent(id)}/loaded`)
    },
    // its OWN MCP servers: active/held like a folder's,
    // each gesture answering with the refreshed rows
    tools: {
      list(id: string): Promise<{ rows: OwnToolRow[] }> {
        return req<{ rows: OwnToolRow[] }>(`/api/agents/${encodeURIComponent(id)}/tools`)
      },
      add(id: string, name: string, config: OwnToolConfig): Promise<{ rows: OwnToolRow[] }> {
        return req<{ rows: OwnToolRow[] }>(`/api/agents/${encodeURIComponent(id)}/tools`, { method: 'POST', body: JSON.stringify({ name, config }) })
      },
      act(id: string, name: string, action: 'hold' | 'activate'): Promise<{ rows: OwnToolRow[] }> {
        return req<{ rows: OwnToolRow[] }>(`/api/agents/${encodeURIComponent(id)}/tools/${action}`, { method: 'POST', body: JSON.stringify({ name }) })
      },
      remove(id: string, name: string): Promise<{ rows: OwnToolRow[] }> {
        return req<{ rows: OwnToolRow[] }>(`/api/agents/${encodeURIComponent(id)}/tools/${encodeURIComponent(name)}`, { method: 'DELETE' })
      },
    },
    // what a new conversation of the agent starts with, per mode, measured
    // over its recent conversations (null = none measured)
    startedWith(id: string): Promise<AgentStartedWith | null> {
      return req<AgentStartedWith | null>(`/api/agents/${encodeURIComponent(id)}/started-with`)
    },
    // Territory: the agent's fence as the engines launch it (Machinery row).
    territory(id: string): Promise<AgentTerritory> {
      return req<AgentTerritory>(`/api/agents/${id}/territory`)
    },
    // a fresh bearer token; the old one dies at once. A running console
    // keeps the old one until it restarts.
    rotateToken(id: string): Promise<{ rotated: boolean }> {
      return req<{ rotated: boolean }>(`/api/agents/${id}/token/rotate`, { method: 'POST' })
    },
    // Capability states: the three gestures on a (skill, folder) —
    // hold = turn off (the copy moves to Silos' held store, the engine stops
    // seeing it), activate = turn on, add = a real copy of a plugin skill
    // into the folder. Each answers with the refreshed catalog.
    async skillState(id: string, name: string, action: 'hold' | 'activate' | 'add'): Promise<SkillCatalogEntry[]> {
      const { skills } = await req<{ skills: SkillCatalogEntry[] }>(`/api/agents/${id}/skills/${encodeURIComponent(name)}/${action}`, { method: 'POST' })
      return skills
    },
  },
  // the owner's territory settings (Settings › Territory): the
  // private paths every fenced agent is denied unless they hold one of its
  // territories, and `enabled` — the agents fenced (the rollout gate).
  territory: {
    get(): Promise<TerritorySettings> {
      return req<TerritorySettings>('/api/territory')
    },
    set(privatePaths: string[]): Promise<TerritorySettings> {
      return req<TerritorySettings>('/api/territory', { method: 'PUT', body: JSON.stringify({ privatePaths }) })
    },
    setEnabled(enabled: string[]): Promise<TerritorySettings> {
      return req<TerritorySettings>('/api/territory', { method: 'PUT', body: JSON.stringify({ enabled }) })
    },
    // the network surface: each agent's egress policy,
    // its engine's own hosts, and the proxy's refusals (owner-only rows)
    egress(): Promise<TerritoryEgress> {
      return req<TerritoryEgress>('/api/territory/egress')
    },
    async setEgress(agentId: string, change: { mode?: AgentEgress['mode']; hosts?: string[] }): Promise<AgentEgress> {
      const { agent } = await req<{ agent: AgentEgress }>(`/api/territory/egress/${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        body: JSON.stringify(change),
      })
      return agent
    },
    async egressRejections(filter: { agent?: string; limit?: number } = {}): Promise<EgressRejection[]> {
      const q = new URLSearchParams()
      if (filter.agent) q.set('agent', filter.agent)
      if (filter.limit) q.set('limit', String(filter.limit))
      const { rows } = await req<{ rows: EgressRejection[] }>(`/api/territory/egress/rejections?${q.toString()}`)
      return rows
    },
    // the file fence's refusals today, per agent and project (owner only)
    async refused(): Promise<FenceRefusedAgent[]> {
      const { agents } = await req<{ agents: FenceRefusedAgent[] }>('/api/territory/refused')
      return agents
    },
  },
  // the install's settings: the unattended provider —
  // what heartbeats, task wakes and automations run on (null: each agent's
  // own account) — and the engines that keep their own account under it
  platformSettings: {
    get(): Promise<PlatformSettingsView> {
      return req<PlatformSettingsView>('/api/settings')
    },
    setUnattendedProvider(id: string | null): Promise<PlatformSettingsView> {
      return req<PlatformSettingsView>('/api/settings', { method: 'PATCH', body: JSON.stringify({ unattendedProvider: id }) })
    },
    // what a new project starts with: per engine, per class — a boolean, or null back to Recommended
    setStartingSet(patch: Record<string, Record<string, boolean | null>>): Promise<PlatformSettingsView> {
      return req<PlatformSettingsView>('/api/settings', { method: 'PATCH', body: JSON.stringify({ startingSet: patch }) })
    },
    // where the next new project is born: a folder's absolute path, or null back to ~/Silos — moves nothing
    setProjectsDir(path: string | null): Promise<PlatformSettingsView> {
      return req<PlatformSettingsView>('/api/settings', { method: 'PATCH', body: JSON.stringify({ projectsDir: path }) })
    },
  },
  // Providers v1: inference providers (Settings › Accounts & providers and the
  // per-agent selector). Keys travel whole only TOWARD the server
  // (create/update); every response comes back masked.
  providers: {
    async list(): Promise<ProviderView[]> {
      const { providers } = await req<{ providers: ProviderView[] }>('/api/providers')
      return providers
    },
    async create(input: ProviderCreateInput): Promise<ProviderView> {
      const { provider } = await req<{ provider: ProviderView }>('/api/providers', { method: 'POST', body: JSON.stringify(input) })
      return provider
    },
    // an engine's own logins, by the routes its descriptor names
    // (ui.loginImport) — ids only, never a key; an engine with none has no
    // logins to list. importLogin copies ONE login's key into a new
    // harness-provider (server-side)
    async engineLogins(d: HarnessDescriptor): Promise<string[]> {
      if (!d.ui.loginImport) return []
      const { ids } = await req<{ ids: string[] }>(d.ui.loginImport.list)
      return ids
    },
    // the engine's own sign-in by link (descriptor ui.signIn): what it can
    // sign in to, start one (its link + code), its state, cancel
    async signInOptions(d: HarnessDescriptor): Promise<EngineSignInOption[]> {
      if (!d.ui.signIn) return []
      const { options } = await req<{ options: EngineSignInOption[] }>(d.ui.signIn.path)
      return options
    },
    signInStart(d: HarnessDescriptor, providerId: string): Promise<{ id: string; url: string; instructions: string }> {
      if (!d.ui.signIn) throw new Error(`${d.label} has no sign-in`)
      return req(d.ui.signIn.path, { method: 'POST', body: JSON.stringify({ providerId }) })
    },
    signInStatus(d: HarnessDescriptor, id: string): Promise<EngineSignInState> {
      if (!d.ui.signIn) throw new Error(`${d.label} has no sign-in`)
      return req<EngineSignInState>(`${d.ui.signIn.path}/${encodeURIComponent(id)}`)
    },
    async signInCancel(d: HarnessDescriptor, id: string): Promise<void> {
      if (!d.ui.signIn) return
      await req(`${d.ui.signIn.path}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    async importLogin(d: HarnessDescriptor, providerId: string, label: string): Promise<ProviderView> {
      if (!d.ui.loginImport) throw new Error(`${d.label} has no logins to import`)
      const { provider } = await req<{ provider: ProviderView }>(d.ui.loginImport.import, { method: 'POST', body: JSON.stringify({ providerId, label }) })
      return provider
    },
    // "Copy config": the provider as an opencode.json fragment or a Claude
    // env block — never with the key
    // target = the engine descriptor's ui.providerExport.target
    async exportConfig(id: string, target: string): Promise<string> {
      const { snippet } = await req<{ snippet: string }>(`/api/providers/${id}/export?target=${target}`)
      return snippet
    },
    async update(id: string, patch: Partial<{ label: string; baseUrl: string; apiKey: string; providerId: string; models: string[] }>): Promise<ProviderView> {
      const { provider } = await req<{ provider: ProviderView }>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      return provider
    },
    async delete(id: string): Promise<void> {
      await req(`/api/providers/${id}`, { method: 'DELETE' })
    },
    // "Connect": the server verifies the key against the endpoint FIRST and
    // stores only what works (the same key for the same endpoint = the same
    // row); the row comes back named after the models the key reaches
    async connect(input: { label: string; baseUrl: string; apiKey: string }): Promise<{ provider: ProviderView; models: string[] }> {
      return req<{ provider: ProviderView; models: string[] }>('/api/providers/connect', { method: 'POST', body: JSON.stringify(input) })
    },
    // re-read every key's listing now (the server does it at boot and every 6 h)
    async refreshModels(): Promise<Array<{ id: string; label: string; changed: boolean; models: string[] | null }>> {
      const { refreshed } = await req<{ refreshed: Array<{ id: string; label: string; changed: boolean; models: string[] | null }> }>(
        '/api/providers/refresh-models',
        { method: 'POST', body: JSON.stringify({}) },
      )
      return refreshed
    },
    // "which models does this key reach?" — the server asks the gateway's
    // /v1/models with the stored key and persists the ids (provider.models)
    discoverModels(id: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
      return req<{ ok: boolean; models: string[]; error?: string }>(`/api/providers/${id}/models`, { method: 'POST', body: JSON.stringify({}) })
    },
    // verify = the gateway lists the key's models (persisted) and one ping
    // with the first of them; `models` comes back when the listing worked
    verify(id: string, model?: string): Promise<{ ok: boolean; error?: string; models?: string[] }> {
      return req<{ ok: boolean; error?: string; models?: string[] }>(`/api/providers/${id}/verify`, {
        method: 'POST',
        body: JSON.stringify(model ? { model } : {}),
      })
    },
  },
  // Providers v1: Claude accounts (default + ~/.silos/claude-accounts/).
  accounts: {
    async list(): Promise<ClaudeAccountView[]> {
      const { accounts } = await req<{ accounts: ClaudeAccountView[] }>('/api/accounts')
      return accounts
    },
    create(name: string): Promise<{ name: string; configDir: string; command: string }> {
      return req('/api/accounts', { method: 'POST', body: JSON.stringify({ name }) })
    },
    async verify(name: string): Promise<ClaudeAccountView> {
      const { account } = await req<{ account: ClaudeAccountView }>(`/api/accounts/${name}/verify`, { method: 'POST', body: JSON.stringify({}) })
      return account
    },
    // Claude's own sign-in (`claude auth login` under the account's dir) in
    // a terminal the browser attaches to at /ws/terminal/:id.
    login(name: string): Promise<{ terminal: TerminalHandle }> {
      return req(`/api/accounts/${name}/login`, { method: 'POST', body: JSON.stringify({}) })
    },
  },
  // a session name (`silos-35`) or id → the conversation it names (title)
  async conversationRefs(names: string[], ids: string[]): Promise<Record<string, import('./conversation-refs').ConversationRef>> {
    const q = new URLSearchParams()
    if (names.length) q.set('names', names.join(','))
    if (ids.length) q.set('ids', ids.join(','))
    const { refs } = await req<{ refs: Record<string, import('./conversation-refs').ConversationRef> }>(`/api/conversation-refs?${q}`)
    return refs
  },

  // role packs — server/src/routes/role-packs.ts (owner only)
  rolePacks: {
    async folderSkills(agentId: string): Promise<{ name: string; description: string; from: 'folder' | 'personal' }[]> {
      const { skills } = await req<{ skills: { name: string; description: string; from: 'folder' | 'personal' }[] }>(
        `/api/agents/${encodeURIComponent(agentId)}/role-pack/folder-skills`,
      )
      return skills
    },
    async export(agentId: string, folderSkills: string[] = []): Promise<{ pack: RolePack; skipped: string[] }> {
      const params = new URLSearchParams()
      if (folderSkills.length) params.set('folderSkills', folderSkills.join(','))
      const q = params.size ? `?${params}` : ''
      return req<{ pack: RolePack; skipped: string[] }>(`/api/agents/${encodeURIComponent(agentId)}/role-pack${q}`)
    },
    async preview(pack: unknown, target: { id: string; name?: string; folder: string }): Promise<RolePackConsequences> {
      const { consequences } = await req<{ consequences: RolePackConsequences }>('/api/role-packs/preview', {
        method: 'POST',
        body: JSON.stringify({ pack, target }),
      })
      return consequences
    },
    async install(
      pack: unknown,
      target: { id: string; name?: string; folder: string },
      automations: string[],
      secrets: Record<string, string>,
      confirmCommands: string[] = [],
    ): Promise<{ agent: AgentView; report: RolePackReport; startWarn?: string }> {
      return req<{ agent: AgentView; report: RolePackReport; startWarn?: string }>('/api/role-packs/install', {
        method: 'POST',
        body: JSON.stringify({ pack, target, automations, secrets, confirmCommands }),
      })
    },
  },

  // automation templates — server/src/routes/automations.ts (/api/automations/templates)
  automationTemplates: {
    async list(): Promise<AutomationTemplate[]> {
      const { templates } = await req<{ templates: AutomationTemplate[] }>('/api/automations/templates')
      return templates
    },
    // what Create would make, validated by the server, without making it
    async preview(id: string, params: Record<string, string>): Promise<Omit<Automation, 'id' | 'createdAt'>> {
      const { automation } = await req<{ automation: Omit<Automation, 'id' | 'createdAt'> }>(`/api/automations/templates/${encodeURIComponent(id)}/preview`, {
        method: 'POST',
        body: JSON.stringify({ params }),
      })
      return automation
    },
    async use(id: string, params: Record<string, string>): Promise<Automation> {
      const { automation } = await req<{ automation: Automation }>(`/api/automations/templates/${encodeURIComponent(id)}/use`, {
        method: 'POST',
        body: JSON.stringify({ params }),
      })
      return automation
    },
    async import(template: unknown, replace = false): Promise<AutomationTemplate> {
      const { template: saved } = await req<{ template: AutomationTemplate }>('/api/automations/templates', {
        method: 'POST',
        body: JSON.stringify({ template, replace }),
      })
      return saved
    },
    async remove(id: string): Promise<void> {
      await req(`/api/automations/templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    // «Save as template» on an automation's page
    async fromAutomation(automationId: string, name?: string): Promise<AutomationTemplate> {
      const { template } = await req<{ template: AutomationTemplate }>(`/api/automations/${encodeURIComponent(automationId)}/template`, {
        method: 'POST',
        body: JSON.stringify(name ? { name } : {}),
      })
      return template
    },
    // the file as it travels to another Silos
    async file(id: string): Promise<string> {
      const res = await fetch(`/api/automations/templates/${encodeURIComponent(id)}/file`, { headers: { 'x-token': getToken() } })
      if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status, null)
      return res.text()
    },
  },

  // the automations resident (server-side) — see server/src/server.ts
  // (the /api/automations* routes) and automations-types.ts.
  automations: {
    async list(): Promise<Automation[]> {
      const { automations } = await req<{ automations: Automation[] }>('/api/automations')
      return automations
    },
    async get(id: string): Promise<Automation> {
      const { automation } = await req<{ automation: Automation }>(`/api/automations/${id}`)
      return automation
    },
    async create(input: {
      name: string
      agentId: string
      prompt: string
      trigger: Trigger
      thread?: Thread
      approval?: boolean
      keepAlive?: boolean
      maxRunsPerDay?: number
      runsOn?: Automation['runsOn']
      run?: Automation['run']
      // the proposal whose «Review ›» opened this editor: the create resolves it
      proposal?: string
    }): Promise<Automation> {
      const { automation } = await req<{ automation: Automation }>('/api/automations', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      return automation
    },
    async update(id: string, patch: Partial<Omit<Automation, 'id' | 'createdAt' | 'runsOn'>> & { runsOn?: Automation['runsOn'] | null }): Promise<Automation> {
      const { automation } = await req<{ automation: Automation }>(`/api/automations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      return automation
    },
    async delete(id: string): Promise<void> {
      await req(`/api/automations/${id}`, { method: 'DELETE' })
    },
    runNow(id: string): Promise<{ ok: true }> {
      return req<{ ok: true }>(`/api/automations/${id}/run-now`, { method: 'POST' })
    },
    async pause(id: string): Promise<Automation> {
      const { automation } = await req<{ automation: Automation }>(`/api/automations/${id}/pause`, { method: 'POST' })
      return automation
    },
    async resume(id: string): Promise<Automation> {
      const { automation } = await req<{ automation: Automation }>(`/api/automations/${id}/resume`, { method: 'POST' })
      return automation
    },
    async runs(id: string, limit?: number): Promise<Run[]> {
      const qs = limit !== undefined ? `?limit=${limit}` : ''
      const { runs } = await req<{ runs: Run[] }>(`/api/automations/${id}/runs${qs}`)
      return runs
    },
    // a command run's log (owner only; redacted when written) — null when
    // the run left none (an agent run, or one that never started)
    async runLog(id: string, runId: string): Promise<string | null> {
      try {
        const { log } = await req<{ log: string }>(`/api/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/log`)
        return log
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    async pending(): Promise<Run[]> {
      const { pending } = await req<{ pending: Run[] }>('/api/automations/pending')
      return pending
    },
    approve(runId: string): Promise<{ ok: true }> {
      return req<{ ok: true }>(`/api/automations/runs/${runId}/approve`, { method: 'POST' })
    },
    skip(runId: string): Promise<{ ok: true }> {
      return req<{ ok: true }>(`/api/automations/runs/${runId}/skip`, { method: 'POST' })
    },
  },
  // what the agents propose (server routes/proposals.ts): the owner reads
  // them whole, accepts (an automation or a skill —
  // `inputHash`: the one the sheet painted), or dismisses with a reason the
  // agent hears; a mission and a command are reviewed in their editor
  proposals: {
    async list(): Promise<ProposalView[]> {
      const { proposals } = await req<{ proposals: ProposalView[] }>('/api/proposals')
      return proposals
    },
    // what was proposed in ONE conversation (any session of it) — its column
    async ofConversation(sessionId: string): Promise<ProposalView[]> {
      const { proposals } = await req<{ proposals: ProposalView[] }>(`/api/proposals?conversation=${encodeURIComponent(sessionId)}`)
      return proposals
    },
    async accept(id: string, inputHash?: string): Promise<{ automation?: Automation; skill?: string }> {
      return req<{ automation?: Automation; skill?: string }>(`/api/proposals/${encodeURIComponent(id)}/accept`, {
        method: 'POST',
        body: JSON.stringify(inputHash ? { inputHash } : {}),
      })
    },
    async dismiss(id: string, reason?: string): Promise<void> {
      await req(`/api/proposals/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) })
    },
    // `diff`: a change to a project's skill — the file against the project's copy
    file(id: string, path: string): Promise<{ text: string | null; diff?: ProposalDiffLine[] }> {
      return req<{ text: string | null; diff?: ProposalDiffLine[] }>(`/api/proposals/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`)
    },
  },
  // what agents create on their own (server routes/initiative.ts): the
  // owner's doors on it
  initiative: {
    measures(agentId: string): Promise<Measures> {
      return req<Measures>(`/api/agents/${encodeURIComponent(agentId)}/measures`)
    },
    // «Undo»: a task is cancelled, an automation goes to the trash — what it
    // already did stays done
    undo(what: { task: string } | { automation: string }): Promise<{ undone: 'task' | 'automation'; stopped: boolean }> {
      return req<{ undone: 'task' | 'automation'; stopped: boolean }>('/api/creations/undo', { method: 'POST', body: JSON.stringify(what) })
    },
    // «Restore ›» of a withdrawal: back from the trash
    restore(automationId: string): Promise<{ restored: string }> {
      return req<{ restored: string }>(`/api/automations/withdrawn/${encodeURIComponent(automationId)}/restore`, { method: 'POST' })
    },
    // reading an origin NEVER blesses it — only keep() does
    origin(key: string): Promise<PlanOrigin> {
      return req<PlanOrigin>(`/api/plans/origin?key=${encodeURIComponent(key)}`)
    },
    // «Keep it — it's mine»
    keep(key: string): Promise<{ blessed: boolean }> {
      return req<{ blessed: boolean }>('/api/plans/origin/keep', { method: 'POST', body: JSON.stringify({ key }) })
    },
    // «Keep them all ›»: the baseline of a folder, but the ones left out
    keepAll(folder: string, exclude: string[] = []): Promise<{ kept: number }> {
      return req<{ kept: number }>('/api/plans/baseline/keep-all', {
        method: 'POST',
        body: JSON.stringify({ folder, ...(exclude.length > 0 ? { exclude } : {}) }),
      })
    },
  },
}
