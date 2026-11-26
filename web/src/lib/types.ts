import type { Period } from './period'
import type { MachineryScope } from './automations'
// types.ts — a mirror of the server types that travel over HTTP/WS.
// Multimedia: METADATA for a transcript image — the base64 never travels in
// the turn; `ref` is resolved against /api/sessions/.../media/ (see
// MediaImage.tsx). w/h are present when the server could read them (the
// PNG's IHDR or toolUseResult.dimensions) — the UI reserves the exact slot with them.
export interface TurnImage {
  ref: string
  mediaType: string
  bytes: number
  w?: number
  h?: number
}
export interface ToolUseDetail {
  name: string
  skill: string | null
  input: string
  result: string | null
  images?: TurnImage[]
  isError?: boolean
  plan?: PlanProposal
}
// ExitPlanMode's plan (see server types.ts PlanProposal)
export interface PlanProposal {
  text: string
  state: 'proposed' | 'approved' | 'not_approved'
  file?: string
}
export interface Turn {
  index: number
  role: 'user' | 'assistant'
  text: string
  tools: string[]
  ts: string | null
  thinking?: string
  toolUses?: ToolUseDetail[]
  outputTokens?: number
  interjection?: boolean // rescued from inside a tool_result — a message sent while a turn was in progress
  compact?: boolean // a compaction marker-turn (entry isCompactSummary:true), text always ''
  synthetic?: boolean // a harness notice (message.model="<synthetic>") — a system band, not prose
  durationMs?: number // a receipt marker-turn (the CLI's system/turn_duration entry), text always ''
  turnEnded?: boolean // Working != live: message.stop_reason === "end_turn" — an honest close, even for SDK sessions with no marker
  // a message from ANOTHER session (a peer) — a third voice, never the owner's own bubble.
  // `agentId` is present when the sender resolves to a known agent → the band links to
  // its dossier (the sender), not the exact thread.
  interSession?: { from: string; agentId?: string }
  images?: TurnImage[] // multimedia: images the user pasted into this turn (metadata only)
}
export interface SessionView {
  id: string
  folder: string
  title: string
  skills: string[]
  cwd: string | null
  mtime: number
  size: number
  turnCount: number
  live: boolean
  worktree: boolean
  native: boolean
  agentId: string
  harness?: HarnessId // which agent harness wrote the session (absent = the default engine)
  // auto-titles: where `title` came from (a manual rename, synthesized, the
  // parser's first sentence). Optional in this mirror: the UI doesn't need
  // it for anything today (the title arrives already resolved) — informational only.
  titleOrigin?: 'manual' | 'auto' | 'raw'
  contextTokens?: number // input+cache_creation+cache_read from the last assistant usage seen
  model?: string // message.model from the last assistant usage seen
  // an engine whose console pins the model (today OpenCode: provider/model): what the last user message asked for — what the console runs next
  requestedModel?: string
  queue?: string[] // an external queue (queue-operation), present only when non-empty
  // chains: the immediate parent ("folder/id"), if this session was born
  // from another (a "Continue in Silos" fork, or a keep thread's rotation).
  parentKey?: string
  // 'clear' when this session was STARTED by a console `/clear` of its
  // parent — a new conversation (its own sidebar row) whose console is
  // still the thread's. Absent = it continues its parent.
  parentKind?: 'clear'
  // cross-session address: the name Claude Code's ListAgents/SendMessage
  // use to reach this conversation's RUNNING process ("silos-1f"). Absent
  // when no live process holds the session.
  peer?: { name: string; status?: string }
  // birth: present ONLY on a conversation an automation run opened (the
  // server's session-origins). The sidebar never lists these (runs live on
  // the Automations page) — an automation's KEPT thread (⚡ mark) is a row
  // only while open or searched (lib/sidebar-show.ts); Home, ⌘K and the
  // agent page keep seeing them. Absent = the owner's own.
  // A NESTED run (births, plugin 0.7.0) is the other birth that is not the
  // owner's: a `claude -p` an agent launched from Bash — it presented
  // itself at start and Silos never launched it. `parent` is the
  // conversation whose claude ran it (null: unknown — it belongs to the
  // agent). Never a sidebar row, never a console: the parent's context
  // column lists it, a loose one is counted on the agent page's Now.
  // A MESSAGE conversation is the third — HISTORY only (no message wakes
  // anyone, so none is opened any more): Silos once
  // opened it to work one message (`messageId`, sent by `from` — 'owner' or
  // an agent id; `gist` its first line). Saved records still carry it.
  // Unlike a run it stays continuable and is a sidebar row while open or
  // searched (✉ mark), but it is not one of the owner's conversations:
  // never unread, never «replied», never counted in the owner's counts.
  origin?:
    | { kind: 'automation'; automationId: string; runId: string }
    | { kind: 'nested'; parent: string | null; agentId: string }
    | { kind: 'message'; messageId: string; from: string; gist: string }
    | { kind: 'task'; task: string; ref: string }
  // why the run working in this conversation right now was started
  // (server run-cause.ts). Absent when no caused run is in flight.
  runCause?: string
  // durable unseen: this conversation is "unanswered" — the agent replied
  // and you haven't opened it since. Computed by the server (mtime + the
  // last turn's role + seen.json); SURVIVES closing your machine, unlike
  // the in-memory unseen count (store.unreadCount, the live Pulse).
  // Always present (the server never omits it); optional in the type only
  // for tolerance to old test snapshots.
  unread?: boolean
  // the role of the last conversational turn (server, parser lastRole):
  // 'user' = it's the agent's turn (working, or about to); 'assistant' =
  // it's yours. Absent when the session has no real turn yet.
  lastRole?: 'user' | 'assistant'
  // the agent's turn is still open (no CLI receipt / end_turn yet) — the
  // dot's blink input; intermediate assistant messages don't close it.
  turnOpen?: boolean
  // an AskUserQuestion is open (asked, unanswered): the agent waits on YOU
  // — the dot goes solid even mid-turn. Present only when true.
  pendingAsk?: boolean
  // ms of the assistant tool_use still waiting for its result (open turn
  // only): a long tool writes nothing, this keeps the row working.
  toolSince?: number
  // newest subagent transcript mtime — fresh with the turn CLOSED means a
  // background agent still works for this conversation (live.ts)
  subMtime?: number
  // newest tool still in flight in a subagent transcript (any depth) — a
  // background agent silent inside a long command still works (live.ts)
  subToolSince?: number
  // ms the newest background command it awaits started (server: SessionMeta.shellSince)
  shellSince?: number
  // transcript birthtime ms — when this conversation started (baseline for
  // "new in this conversation"). Absent when the filesystem reports none.
  startedAt?: number
}
// Mirror of server/src/harnesses/contract.ts HarnessId: an open set — the
// engines are whatever the server registered (GET /api/harnesses).
export type HarnessId = string

// Mirror of server/src/harness-descriptor.ts (design D.4): what the web knows
// about one registered engine. lib/harnesses.ts is the only module that reads it.
export interface HarnessCaps {
  compaction: boolean
  subagents: boolean
  skills: boolean
  thinking: boolean
  costFromHarness: boolean
  permissionsAsEvents: boolean
  sendToConsole: boolean
  outputStyles: boolean
  /** memory per agent: the engine's launches read the agent's own auto-memory dir */
  agentAutoMemory: boolean
}
export type ProviderKind = ProviderView['kind']
export interface HarnessUiFacts {
  contextPercent: boolean
  models: 'catalog' | 'provider-model' | 'none'
  ownLogin: boolean
  territoryFenced: boolean
  territoryNote: string | null
  settingsAbout: string | null
  loginImport: { list: string; import: string } | null
  signIn?: { path: string } | null
  providerExport: { target: string; label: string } | null
  // optional (absent = neutral wording / none) — server contract.ts HarnessUiFacts
  updateLabel?: string | null
  consoleColours?: boolean
  consoleColoursHint?: string | null
  providersAbout?: string | null
  providerIdPlaceholder?: string | null
  loginCommand?: string | null
  givenFilesNote?: string | null // the engine is not told of files given to one conversation
}
export interface HarnessDescriptor {
  id: HarnessId
  label: string
  default: boolean
  caps: HarnessCaps
  providerKinds: ProviderKind[]
  modeSwitch: boolean
  ui: HarnessUiFacts
}

// The control (server/src/control.ts): the ONE
// setting that decides whether something happens without the owner, and —
// On its own — the period its heartbeat beats at (free; null = never).
export type Control = 'told' | 'own'
export interface HeartbeatSetting {
  period: Period | null
  sleepUntil?: string
  sleepWhy?: string
}
// GET /api/agents/:id/heartbeat — the page's row (routes/heartbeat.ts)
export interface HeartbeatView {
  period: Period | null
  next: string | null
  sleeping: { until: string; why: string } | null
  // `cause`: a skip's cause (HeartbeatSkip); `tools`: the regime its run
  // sealed; `readOutside`: what it read outside
  last: {
    at: string
    kind: HeartbeatKind | null
    skipped: string | null
    cause?: HeartbeatSkip | null
    tools?: boolean
    readOutside?: string[]
    summary: string | null
    created: string[]
    proposed: string[]
    tainted: boolean
  } | null
  // the last fire that took a turn («Made its round 14:22 — …»)
  lastTurn?: { at: string; kind: HeartbeatKind | null; created: string[]; proposed: string[] } | null
  // the agent's staggered minute — the anchor the server stamps
  staggerMinute?: number
  // today's skipped fires with their cause and words
  // `until`: the instant a skip names (its words end before the time) —
  // optional, said in the row's own hour format when present
  skips?: Array<{ at: string; cause: HeartbeatSkip; kind?: HeartbeatKind; reason: string; until?: string }>
  // the proactive mode as the page reads it (server index.ts proactiveViewOf)
  proactive?: ProactiveView | null
  // what it decided on its own (≤ 10: initiatives, recurring work and its
  // lone acts lead), the reactive tail counted apart, the measure
  decided: Creation[]
  decidedReactive: number
  measures: Measures | null
  // its day on its own (own-turns.ts): «Started N times today · max C»
  // priced: its unattended turns run on a provider that prices them — else
  // the $ cap «applies when its provider prices turns»
  today: { used: number; costUsd: number; unpriced: number; ceiling: number; spendCap: number; exempt: boolean; priced?: boolean } | null
  // its heartbeat's turns today by class — said apart from the max, which
  // never counts them («looked twice today»)
  beats?: { looks: number; thinks: number; rounds?: number }
  // its open tasks added outside Silos: one line on its page,
  // each a door to the task — where «Keep it — it's mine» is
  outside?: Array<{ key: string; title: string }>
}
// a heartbeat's class and why one was skipped
export type HeartbeatKind = 'look' | 'think' | 'round'
export type HeartbeatSkip = 'sleeping' | 'busy' | 'spend' | 'share' | 'account' | 'headroom' | 'engine' | 'empty' | 'quota'
// The proactive mode: On its own plus a setting —
// never a third control; the three positions are derived
export interface ProactiveSetting {
  perDay: number
  tools: boolean
}
export type Position = 'told' | 'own' | 'proactive'
// what holds its rounds: its spend cap, its account's margin,
// or a count when the provider can't be measured
export type ProactiveHolds =
  | { kind: 'spend'; spendPerDay: number | null; sharePercent: number }
  | { kind: 'account'; account: string; headroomPercent: number }
  | { kind: 'unmeasured'; account: string; roundsPerDay: number }
export interface ProactiveView {
  position: Position
  setting: ProactiveSetting | null
  effective: boolean
  // why a set proactive does no rounds now
  off: 'cut' | 'told' | 'never' | null
  today: { made: number; perDay: number | null; left: number | null; open: number; openMax: number }
  roundsPerDay: number
  holds: ProactiveHolds
  // the connectors a round WITH its tools would have (the owner's holds out)
  connectors: Array<{ name: string; kind: 'mcp' | 'plugin'; scope: 'agent' | 'project' | 'user' }>
  connectorsNote?: string
}
// The ledger of an agent's OWN creations — a mirror of Creation in
// server/src/creations.ts: what it created in an
// unattended turn, and its lone acts on its recurring work (withdrew, paused).
export interface Creation {
  id: string
  kind: 'task' | 'automation'
  // a task: its plans record key; an automation: its id
  ref: string
  title: string
  createdAt: string
  run?: string
  signal?: string
  by: string
  action?: 'withdrew' | 'paused'
  readOutside?: string[]
  undoneAt?: string
  undoneBy?: string
  keptAt?: string
  rejected?: { at: string; why: string }
  adopted?: { at: string; label: 'kept by the owner' | 'restored in an attended conversation' }
}
// GET /api/agents/:id/measures — 30 sliding days (server initiative.ts)
export interface Measures {
  initiatives: { created: number; kept: number; undone: number }
  reactive: { created: number; kept: number; undone: number }
  rejected: number
  tainted: number
}
// GET /api/plans/origin — who added a task: `outside` paints
// «added outside Silos ›» until the owner keeps it
export interface PlanOrigin {
  key: string
  by: string
  how: string | null
  outside: boolean
}
// PATCH /api/agents/:id to Only when told: what still runs, for the sheet
export interface ControlPending {
  running: Array<{ turnId: string; what: string }>
  stillRuns: Array<{ id: string; name: string }>
  queued: number
}

// The agent's mission (server/src/mission.ts): why it
// acts, in the owner's words — its text and the «Never» lines it always asks
// about first. It replaced role and the charter.
export interface Mission {
  text: string
  never: string[]
  updatedAt: string
}
// what the API takes: the owner's text and lines (the server trims and stamps)
export type MissionInput = { text: string; never: string[] }

export interface AgentView {
  id: string
  name: string
  emoji: string
  folder: string | null
  // Extra territories (absolute paths): a declared folder is membership of
  // that project. lib/territory.ts territoriesOf is the single reader.
  folders?: string[]
  skills: string[]
  model?: string
  mission?: Mission
  default?: boolean
  archived?: boolean
  // the v1→v2 contract — see Agent.framework/provider in server/src/types.ts.
  // The harness: chosen at creation, never changed afterwards.
  framework?: HarnessId
  provider?: string
  // Providers v1: the ordered fallback chain (provider ids).
  fallback?: string[]
  // The cockpit's output style at the agent level (server Agent.outputStyle):
  // a style's exact name; absent = the operator's own Claude Code setting.
  outputStyle?: string
  // the control and its heartbeat: stored as the
  // owner set it — an `own` without territory or mission operates as told
  // (the server's controlNow says the effective one)
  control?: Control
  heartbeat?: HeartbeatSetting
  // the owner's two knobs: absent = the server's defaults
  ownTurnsPerDay?: number
  unattendedSpendPerDay?: number
  // «Let it continue today»
  ownExemptDay?: string
  // Silos cut its capability of creating work on its own
  cut?: { at: string; why: string; run?: string }
  // the proactive setting as stored: present ⇒ the
  // owner chose it; whether it does rounds now is positionNow's
  proactive?: ProactiveSetting
  // GET /api/agents and /api/overview: the DERIVED control right now
  controlNow?: Control
  // …and the derived position of the three-way switch
  positionNow?: Position
  // /api/overview: where «Open» goes (server open-surface.ts) — a console
  // of it in the index, and whether its
  // engine's console takes the briefing
  open?: { hasConsole: boolean; consoleBriefs: boolean }
  // Providers v1: present when the agent is running on fallback after a
  // rate limit on its primary — the "on fallback · resumes HH:MM" badge.
  // `from` names the provider that hit the limit — only conversations whose
  // primary is that provider are diverted (a pinned account keeps running).
  onFallback?: { providerId: string; from: string; until: string }
  sessions: SessionView[]
  liveCount: number
  // conversations + runs, uncapped (the same total as counts)
  sessionCount: number
  // the server's UNCAPPED totals (server/src/session-counts.ts) — `sessions`
  // is capped, so every printed count reads these (lib/counts.ts countsOf).
  // Optional only for payloads from before counts existed.
  counts?: SessionCounts
  // what waits in its inbox (server messages.ts inboxCounts): `new` unread.
  // Absent when the server has no MessageStore.
  inbox?: { new: number }
}
// "conversations" = the owner's own (no automation origin); runs = sessions
// an automation opened. byCwd: '' = no cwd.
export interface SessionCounts {
  conversations: number
  runs: number
  runsByAutomation: Record<string, number>
  byCwd: Record<string, { conversations: number; runs: number }>
  // nested runs with no indexed parent conversation to fold under — the
  // agent page's "N nested runs" (server session-counts.ts). Nested runs are
  // neither conversations nor automation runs. Absent at zero.
  nestedLoose?: number
  // conversations Silos once opened to work a message (origin kind
  // 'message', history only) — neither the owner's conversations nor runs.
  // Absent at zero.
  messageConversations?: number
}
// `build`: the id of the dist the server is serving (dist/build-id.json,
// stamped by vite.config.ts) — the stale-tab banner compares it against
// the bundle's own id (lib/build.ts). Absent on old builds.
export interface Overview {
  agents: AgentView[]
  now: number
  warming: boolean
  home?: string
  build?: string
}
// AgentSummary — what GET /api/agents returns (the raw registry, no
// sessions/counters: only /api/overview computes those). Used by the
// Sidebar footer's archived list.
export type AgentSummary = Pick<
  AgentView,
  'id' | 'name' | 'emoji' | 'folder' | 'skills' | 'model' | 'mission' | 'default' | 'archived' | 'framework' | 'provider' | 'fallback'
> & {
  // the DERIVED control right now (server control.ts controlOf)
  controlNow?: Control
  // the derived position (told · own · proactive — control.ts positionOf)
  positionNow?: Position
}
// GET /api/agents/:id/task-wakes: its task wakes today, their
// cost from each turn's usage (model-prices.ts; null = unpriced) and its
// daily ceiling (Agent.taskWakesPerDay, 30 by default)
export interface AgentTaskWakes {
  today: number
  costUsd: number | null
  ceiling: number
}
// the server's answer (GET /api/task-mode/today?agent=), mapped onto AgentTaskWakes
export interface TaskModeToday {
  agent: string
  day: string
  woke: number
  costUsd: number | null
  unpriced?: number
  running?: number
  ceiling: number
  heldByCeiling?: number
}
// one task a taskLine names (its `says`: its wait in words, comingToYou)
export interface TaskLineItem {
  key: string
  ref: string
  title: string
  owner: string
  says?: string
}
// a mirror of PlanTask/SubagentRef/SessionContext in server/src/types.ts —
// "conversation context" derived from the same turns JSONL, via a second
// accumulator (server/src/context.ts). Type only: no UI yet.
export interface PlanTask {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  createdAt: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  agents: string[]
}
export interface SubagentRef {
  id: string
  description: string
  type: string
  model?: string
  background: boolean
  startedAt: string
  endedAt?: string
  taskId?: string
}
export interface SessionContext {
  plan: { tasks: PlanTask[]; done: number; total: number } | null
  agents: SubagentRef[]
  pending: {
    question: string
    header?: string
    options: { label: string; description?: string }[]
    // the first question takes several answers (AskUserQuestion multiSelect)
    multiSelect?: boolean
    // questions 2..n of the same AskUserQuestion call — the fields above are
    // the first one, so every reader that knows one question keeps working
    more?: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[]
    askedAt: string
  } | null
  links: {
    prs: { number: number; url: string; repo: string; ts: string }[]
    artifacts: { path: string; url: string; ts: string; title?: string }[] // one per URL; title = the published page's title when known
    worktree: { path: string; name: string } | null
  }
  events: { ts: string; kind: 'model' | 'refusal' | 'compact' | 'loop' | 'remote' | 'info'; text: string }[]
  files: { path: string; edits: number; writes: number; reads: number; sent?: number; disk?: number }[] // disk = a plan path cited in a tool's input (server context.ts attributePlanMentions) — activity, never authorship
  tools: { name: string; server: string | null; count: number }[]
  flags: { remote: boolean; permissionMode: string | null; gitBranch: string | null; effort: string | null; model: string | null; accountEmail?: string | null }
  waiting: { kind: 'monitor' | 'wakeup' | 'workflow'; since: string; label: string } | null
  // background commands it still awaits (server SessionContext.background):
  // the «In the background» rows beside the OS processes
  background?: { id: string; since: string; label: string }[]
  // what this conversation sent to OTHERS and may still be waiting on (proof
  // of life): 'session' = an outbound SendMessage nothing
  // answered yet; 'message' = a message POSTed to an agent's inbox, whose
  // live state/answer the server joins at read time ('gone' = pruned).
  outbound?: {
    kind: 'session' | 'message'
    to: string
    summary: string
    since: string
    messageId?: string
    state?: 'new' | 'read' | 'answered' | 'needs_owner' | 'gone'
    answer?: string
  }[]
  // the CLI's cumulative cost-state (see server types.ts): USD at API list
  // prices — notional under a subscription; label as "~$X at API price".
  // planPriced: the harness reported $0 for every assistant message (OpenCode on a plan) — a subscription priced it, not free.
  cost?: {
    totalUsd: number
    unknownModels: boolean
    unpricedModels?: string[]
    planPriced?: true
    byModel: { model: string; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }[]
  } | null
  // documents pasted into the conversation — type/size/when (the real
  // transcript shape carries no filename). See server types.ts.
  documents?: { mediaType: string; bytes: number; ts: string }[]
  // /rewind checkpoints grouped per file — see server types.ts.
  fileHistory?: { path: string; versions: number; lastAt: string }[]
  // the conversation's latest plan-mode plan — see server types.ts
  planMode?: { state: 'proposed' | 'approved' | 'not_approved'; title: string; at: string; file?: string; toolUseId?: string } // toolUseId: only while proposed (the result it waits on)
}
// GET /api/agents/:id/territory — the fence the engines launch this agent
// with (server territory.ts fenceFor): deny = how many rules it carries.
// enabled: the owner's rollout gate (Settings › Territory) — false = this
// agent is not fenced YET. privatePaths = the
// paths actually denied for this agent, never the configured count.
// mirror of server territory.ts FenceScope — the fence read back as places
export interface FenceScope {
  works: string[]
  state: string | null
  readOnly: string[]
  /** what its engine loads, readable but never changed by it */
  noChange?: string[]
  /** `projects`: other projects' folders, their conversations and memory —
   *  closed whether its territory is on or off */
  blocked: { kind: 'projects' | 'silos' | 'claude' | 'agents' | 'private'; paths: string[] }[]
  /** what the fence could not close, or closed only partly, with why */
  open?: { path: string; reason: string }[]
}
export interface AgentTerritory {
  fenced: boolean
  enabled?: boolean
  territories: string[]
  privatePaths: number
  deny: number
  skipped?: { path: string; reason: string }[]
  scope?: FenceScope | null
}
// GET/PUT /api/territory — the owner's private paths + the agents fenced,
// and per fenceable agent the harness it runs on and the tool kinds the
// fence covers there (server harnesses/index.ts fenceSummary).
export interface TerritoryAgent {
  id: string
  harness: string
  label: string
  fenced: string[]
  scope?: FenceScope | null
}
export interface TerritorySettings {
  privatePaths: string[]
  enabled?: string[]
  agents?: TerritoryAgent[]
}
// the network surface — mirrors of routes/territory-egress.ts
export interface EngineHost {
  host: string
  optional?: true
  reason: string
}
export interface AgentEgress {
  id: string
  name: string
  mode: 'open' | 'allowlist'
  hosts: string[]
  engine: { source: string; hosts: EngineHost[] } | null
}
export interface TerritoryEgress {
  proxyPort: number | null
  agents: AgentEgress[]
}
// one refused CONNECT/forward (egress-log.ts EgressRejectRow): never a path
export interface EgressRejection {
  at: string
  agentId: string
  host: string
  port: number
  reason: string
}
// GET /api/territory/refused — the file fence's refusals today (server
// fence-refusals.ts): per agent, per project of the refused path (null =
// elsewhere), with the conversations where they happened
export interface FenceRefusedAgent {
  agentId: string
  total: number
  buckets: Array<{ project: string | null; count: number; conversations: Array<{ folder: string; id: string; count: number; lastAt: string }> }>
}
// mirror of server DiskSubagent — one transcript under the session's
// subagents dir; the ONLY complete census of background work (a
// backgrounded skill's children never write to the main transcript).
// alive/finished is derived client-side from mtime, like conversations.
export interface DiskSubagent {
  id: string
  description: string | null
  type: string | null
  model?: string
  skill?: string
  effort?: string
  parentId?: string
  depth?: number
  mtime: number
  startedAt?: number
  toolSince?: number // its tool_use still waiting for a result — at work while silent (live.ts agentAtWork)
  lastTool?: string
  lastToolDetail?: string
  // the agent's token bill (summed from its transcript); usd null = some
  // model unpriced, never a lying partial figure
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; usd: number | null }
}
// a claude holding the conversation open right now, and the account its
// live process really spends (providerId null = a config dir Silos doesn't know)
export interface SessionRunning {
  pid: number
  providerId: string | null
  configDir: string | null
  silos: boolean
  tmux: string | null
}
// executionTask: the plan task the execution hangs from —
// its plans record key, plan#id, and which edge hung it
export interface SessionDetail {
  meta: SessionView
  turns: Turn[]
  total: number
  context?: SessionContext
  subagents?: DiskSubagent[]
  execution?: ExecutionRecord | null
  executionTask?: { key: string; ref: string; edge: 'conversation' | 'document' } | null
  running?: SessionRunning[]
  // the provider the install's unattended switch ran this conversation's last
  // unattended turn on — null/absent: none did
  unattendedOn?: string | null
  // its branch judged by the worktree record it works in (server
  // silos/worktrees.ts branchStateOf): is its work in the default branch?
  // null/absent: no record — the header shows the branch alone
  branchState?: BranchState | null
}
export interface BranchState {
  branch: string
  base: string
  merged: boolean
  missing: number
  commits: number
  changes: number
  record: string
}
// GET/PATCH /api/settings
/** one class of what a new project starts with (Harness.loads.startingSet) */
export interface StartingSetClass {
  id: string
  what: string
  from: string
  recommended: boolean
  /** what of a project's lists it is: the account's plugins or connectors (Tools), or its skills (Skills);
   *  `machine` — what you set up on this machine (both lists; D6) */
  covers?: 'plugin' | 'connector' | 'skill' | 'machine'
  /** the account origin whose head is this class's key (GET /api/loads/machine) */
  origin?: 'plugins' | 'skills' | 'connectors'
}
/** GET /api/starting-set?facts=1 — the first run's «At start» facts */
export interface StartingFacts {
  /** what you set up on this machine: per kind what a new project loads (n), and what this machine keeps off (off, named) */
  machine: { what: string; n: number; off?: string[] }[]
  /** per class, the names its origin sends when read ([]: not known yet) */
  sends: Record<string, string[]>
}
export interface PlatformSettingsView {
  unattendedProvider: string | null
  keepOwnAccount: string[]
  /** per engine that declares classes: each with what this install chose (absent: Recommended) */
  startingSet?: Record<string, (StartingSetClass & { chosen?: boolean })[]>
  /** the Projects folder: where the next new project is born (`shown` is
   *  `~/…` under the home; `chosen` false = the default, ~/Silos) */
  projectsDir?: { path: string; shown: string; chosen: boolean }
}
/** GET /api/starting-set — the New agent form's line */
export interface StartingSetPreview {
  engine: string
  classes: (StartingSetClass & { on: boolean })[]
  /** the folder is there already (a directory the owner pointed at) */
  exists: boolean
  /** agents of this engine already have (or had) it: no birth, it joins that project */
  joins: { agents: { id: string; name: string }[] } | null
  facts?: StartingFacts
}

// mirror of ExecutionRecord in server/src/types.ts — the SDD ledger + plan
// document a session executes, read live or from Silos' copy (`gone`).
export type ExecutionTaskState = 'complete' | 'fixing' | 'pending'
export interface ExecutionRecordTask {
  n: number
  title: string | null
  state: ExecutionTaskState
  round?: number
  detail?: string
}
export interface ExecutionRecord {
  ledgerPath: string
  planPath: string | null // absolute when the document resolved (inside the repo or a session cwd, markdown, within the size cap); null otherwise — unresolved, unreadable, or a legacy header
  planTitle: string | null // the document's first `# ` heading
  tasks: ExecutionRecordTask[] // ascending by n; union of the document's tasks and the ledger's lines
  done: number // tasks in state 'complete' — with a document, only those it names
  total: number | null // the document's task count; null without a document
  updatedAt: number // the ledger file's mtime (ms)
  gone: boolean // the ledger no longer exists on disk — this is Silos' copy
}

// one conversation's background work in the GLOBAL Tasks view —
// GET /api/tasks; the per-session census is the same listSubagents the
// context column trusts.
export interface TasksSession {
  folder: string
  id: string
  title: string
  agentId: string
  cwd: string | null
  mtime: number
  subagents: DiskSubagent[]
}
// the file viewer/editor: the metadata GET /api/file returns — a mirror of
// FileMeta in server/src/file-service.ts. The UI decides how to render by
// `kind`; `tooLarge` (text/markdown only) => download only; `editable`
// (markdown under the cap only) => a view/edit toggle.
export type FileKind = 'markdown' | 'pdf' | 'image' | 'text' | 'binary'
export interface FileMeta {
  path: string
  name: string
  ext: string
  kind: FileKind
  mime: string
  size: number
  tooLarge: boolean
  editable: boolean
}
// the agent's context — a mirror of ContextFile in
// server/src/context-service.ts. shared = shared by the folder's agents;
// agent = private to that agent.
// the file explorer — a mirror of DirEntry in file-service.ts.
export interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
}
// transcript search — a mirror of SearchHit in server/src/search.ts.
export interface SearchHit {
  folder: string
  id: string
  role: 'user' | 'assistant'
  snippet: string
  count: number
  mtime: number
}
// the Vault — a mirror of VaultEntry in server/src/vault-store.ts. Values
// arrive MASKED (sk-…last4): the real secret never leaves the server.
export type VaultScope = { type: 'global' } | { type: 'folder'; folder: string } | { type: 'agents'; agentIds: string[] } // visibility list — the server normalizes the legacy {type:'agent'} to this
// public: the owner judged it plain configuration — shown in clear, never redacted (vault-store.ts)
// binding: SIGNED by Silos instead of handed over — the
// entry leaves every env; Silos adds `header: format(value)` to the agent's
// calls to baseUrl through /api/egress/<NAME>/…. Absent = in its environment.
export interface VaultBinding {
  baseUrl: string
  inject: { header: string; format: string }
}
// a binding an agent proposes on its ask to the owner (GET /api/vault,
// /api/vault/asks — server/src/binding-asks.ts BindingAsk). Never a value:
// host, header and format, in clear. `problem` set = a broken ask (never a
// prefilled editor); `owner`/`ref` are provenance — informative, a plan file
// is unsigned.
export interface BindingAsk {
  key: string
  ref: string
  title: string
  owner: string
  folder: string | null
  asked: string | null
  entry: string
  baseUrl: string | null
  inject: { header: string; format: string } | null
  host: string | null
  registrable: string | null
  neverSeen: boolean
  entryId: string | null
  current: VaultBinding | null
  problem: string | null
}
// what a successful binding save answered (PATCH/POST /api/vault)
export interface BindingResolution {
  resolved: Array<{ key: string; ref: string; owner: string; unblocked: boolean }>
  failed: Array<{ key: string; ref: string; reason: string }>
}
export interface VaultEntry {
  id: string
  name: string
  value: string
  scope: VaultScope
  createdAt: string
  createdBy?: string
  public?: true
  binding?: VaultBinding
}
// one signed call (GET /api/vault/signed-calls, owner-only) — a mirror of
// EgressRow in server/src/egress-log.ts: never the query, never a body
export interface SignedCall {
  at: string
  agent: string | null
  by: 'agent' | 'owner'
  entry: string
  entryId: string
  method: string
  host: string
  path: string
  status: number
  ms: number
  error?: string
}
// 'conversation' = given to ONE conversation (its whole thread) — the server
// names its folder from the session id it is handed
export type ContextScope = 'shared' | 'agent' | 'conversation'
// 'own' = the agent's own state folder (what it produced) — never an upload target.
export type ContextFileScope = ContextScope | 'own'
export interface ContextFile {
  name: string // the basename
  rel: string // relative to the scope root, e.g. analysis/16-audit.md
  path: string
  folder: string // the territory — or the state folder for 'own'
  scope: ContextFileScope
  size: number
  mtime: number
  kind: FileKind
}
// GET /api/agents/:id/context/conversations — the threads that hold given
// files, each with its newest indexed session (null = no longer listed)
export interface GivenThread {
  thread: string
  territory: string
  session: { folder: string; id: string; title: string; mtime: number } | null
  gone: boolean
}
// a conversation card (GET /api/board) — a mirror of BoardCard in
// server/src/types.ts. Home reads it: the waiting ones in Working now, the
// finished-today ones in the digest's sheet, per-agent rows in the fleet.
export type BoardState = 'needs_you' | 'working' | 'waiting' | 'done_today' | 'idle'
export interface BoardCard {
  folder: string
  id: string
  title: string
  agentId: string
  cwd: string | null
  state: BoardState
  // only on a 'waiting' card: what it waits on (the context column's words)
  waiting?: { kind: 'monitor' | 'wakeup' | 'workflow'; since: string; label: string }
  planDone?: number
  planTotal?: number
  mtime: number
  // FacetFilter: tool names seen in the session (ctx.tools) — present only
  // when there are some; feeds the "tool" facet (facet-surfaces.ts).
  tools?: string[]
}
// the Board dimension's SECOND needs-you source (GET /api/board) — a
// mirror of NeedsYouItem in server/src/needs-you.ts. File-borne signals
// (an agent that escalated, a message, an active silo's rows — a plan's
// tasks among them) that surface alongside each card's own context.pending,
// since the console engine never sets pending (it answers AskUserQuestion
// inline in the transcript).
// what a Done/Drop on a plan task handed to an agent (the plans silo's
// set-field `nowReady`, lib/plan-record.ts handoffOf): `now` — it watches its
// plans and was just woken · `beat` — its standing beat will find it ·
// `never` — it moves only when someone talks to it
export interface PlanHandoff {
  agentId: string
  agentName: string
  taskId: string
  title: string
  wakes: 'task' | 'never'
}

export interface EscalatedNeedsYou {
  kind: 'escalated'
  agentId: string
  summary: string
  at: string
}
// the Board dimension's FOURTH needs-you source — a message between agents
// its recipient handed to the owner (state needs_owner). agentId is the
// recipient, from the sender. A mirror of MessageNeedsYou in
// server/src/needs-you.ts.
export interface MessageNeedsYou {
  kind: 'message'
  agentId: string
  from: string
  messageId: string
  text: string
  at: string
}
// the FIFTH needs-you source — an OpenCode agent waiting on a permission
// (the plugin's asks/<session>/<id>.json), answered from Home with Allow /
// Deny (POST /api/asks/…/reply). `folder` is the conversation's folder key,
// `title` the plain line when there is no pattern. A mirror of AskNeedsYou
// in server/src/needs-you.ts.
export interface AskNeedsYou {
  kind: 'ask'
  agentId: string
  sessionId: string
  folder: string
  id: string
  title: string
  pattern: string | null
  type: string
  at: string
}
// the SIXTH source — an ACTIVE silo's needs-you entry, overlay conflict or
// pending proposal (server/src/silos/surfaces.ts). `text` is the exact row
// Silos says; `folded` entries are counted, not listed.
export interface SiloNeedsYou {
  kind: 'silo'
  // submission: a manifest waiting for the approval click (key 'submission',
  // recordKind 'silo') — the one row that exists before a silo is active
  // escalation: a task whose one wake changed nothing
  // and whose chain did not move it — the owner's, blocking
  reason: 'entry' | 'conflict' | 'proposal' | 'submission' | 'escalation'
  silo: string
  siloName: string
  key: string
  recordKind: string
  urgency: 'blocking' | 'due' | 'routine'
  text: string
  at: string
  agentId?: string
  folder?: string
  file: string | null
  entry?: number
  clears?: string
  actions?: string[]
  folded?: boolean
  // a sub-kind's row (a plan's task): the record it lives in. Home groups
  // such rows by parent («Yours to do», server silos/surfaces.ts)
  parent?: { key: string; kind: string; identity: string; at: string; standingList?: true }
  identity?: string // the record's own identity (the row's words without its state)
  // how the owner settles a sub-kind's row in place: set-field `field` to
  // `done`; `note`: the appendOnly collection a Drop's note goes to
  resolve?: { field: string; done: string; drop?: string; note?: string }
  // a sub-kind's row: its state as the server read it when it composed the
  // row — what Done / Drop send back as «the state you saw»
  state?: string
  conflict?: { field: string; owner: unknown; base: unknown; source: unknown; seenAt: string }
  proposal?: { id: string; by: string; verb: string; field: string; from: unknown; to: unknown }
  submission?: { kind: SiloInstallKind; from: string | null; to: string | null; submittedBy: string; source: 'body' | 'draft' }
  // it rose to the owner (escalation/): since when, who was asked, whose it was
  escalated?: { since: string; asked: string[]; with?: string }
}
// what the active silos add to the pulse and to Done today (GET /api/board
// `silos`, absent while no silo is active)
export interface SiloPulseTerm {
  silo: string
  siloName: string
  term: string
}
// `drop`: closed without being done (a terminal state other than the kind's first — plans: dropped)
export interface SiloDoneItem {
  silo: string
  siloName: string
  key: string
  recordKind: string
  identity: string
  to: string
  toLabel: string
  drop?: true
  at: string
  agentId?: string
  folder?: string
}
// growth: an UNINSTALLED silo whose files keep being written (installer.ts growth)
export interface SiloGrowthTerm {
  silo: string
  siloName: string
  records: number
  since: string
  term: string
}
// a needs-you entry the operator routed to the producer (audience:
// producer-agent): its rows never reach the owner's inbox — Home says one line
export interface SiloWithProducer {
  silo: string
  siloName: string
  agentId: string
  recordKind: string
  entry: number
  count: number
  oldest: string
  escalated?: number
}
export interface SiloBoard {
  pulse: SiloPulseTerm[]
  done: SiloDoneItem[]
  growth?: SiloGrowthTerm[]
  withProducer?: SiloWithProducer[]
}
export type NeedsYouItem = EscalatedNeedsYou | MessageNeedsYou | AskNeedsYou | SiloNeedsYou

// The daily digest band (GET /api/digest) — a mirror of DigestBand in
// server/src/digest.ts: every unread digest summed. `waits` and `coming` are
// the newest digest's (a snapshot never sums); `happened` adds up.
export interface DigestRunsView {
  agentId: string
  name: string
  runs: number
  acted: number
  noNews: number
  ok: number
  failed: number
  recovered: number
}
export interface DigestBand {
  dates: string[]
  through: string
  hour: string
  from: string
  to: string
  // `lines`: the task lines at the hour («Coming to you · 15»), each by its
  // count and in the server's voice — never one of the waits
  waits: {
    blocking: number
    due: number
    routine: number
    oldest: { at: string; kind: string; voice: string } | null
    lines?: Array<{ line: string; count: number; voice: string }>
  }
  happened: {
    conversations: { agentId: string; name: string; count: number }[]
    // agents that worked messages in conversations of their own (origin
    // message) — never counted in `conversations`. HISTORY: saved digests
    // only, no longer produced (no message wakes anyone).
    messages?: { agentId: string; name: string; count: number }[]
    runs: DigestRunsView[]
    planTasksDone: number | null
    silos: { silo: string; siloName: string; to: string; label: string; count: number }[]
  }
  coming: { silo: string; siloName: string; kind: string; count: number; firstDue: string }[] | null
}

// a device the doorbell rings (GET /api/push — server/src/web-push.ts)
export interface PushDeviceView {
  id: string
  label: string
  endpoint: string
  createdAt: string
  lastAcceptedAt?: string
  lastError?: { at: string; status: number }
}

// THE inbox, composed by the server (GET /api/board `inbox`) — a mirror of
// InboxRow in server/src/inbox.ts. Every row speaks the
// silo standard's urgency; a row that can be Seen carries `ack`, posted back
// as is (POST /api/needs-you/ack) — Seen means «this version».
export type InboxUrgency = 'blocking' | 'due' | 'routine'
export type InboxAckKind = 'escalated' | 'run' | 'mission' | 'message' | 'limit' | 'tasksStalled' | 'ownTurns' | 'cut' | 'audit' | 'spend' | 'consoleIdle'
export interface InboxAck {
  kind: InboxAckKind
  key: string
  version: string
}
export interface InboxAutomationRef {
  id: string
  name: string
  agentId: string
}
// a failure's class: the server's one reading (server/src/run-failure.ts)
export type { RunFailureClass } from '../../../server/src/run-failure'
import type { RunFailureClass } from '../../../server/src/run-failure'
// what kept an agent's heartbeat from reading its messages at its next
// chance (server inbox.ts UnreadWhy)
// noProject: held — its sender is an agent the recipient does not know
export type UnreadWhy = 'sleeping' | 'busy' | 'engine' | 'spend' | 'account' | 'failed' | 'noProject'
interface InboxRowBase {
  key: string
  urgency: InboxUrgency
  at: number
  voice: string
  clears: string
  ack?: InboxAck
}
export type InboxRow = InboxRowBase &
  (
    | {
        kind: 'ask'
        agentId: string
        folder: string
        id: string
        title: string
        cwd: string | null
        permission?: { id: string; type: string; pattern: string | null }
      }
    | { kind: 'approval'; agentId: string | null; run: Run; automation: InboxAutomationRef | null }
    // what an agent proposed (server proposals.ts + proposals-view.ts):
    // Accept · Dismiss, or — every mission, an
    // automation with a command — «Review ›» · Dismiss. The words are the
    // server's: `title`, the provider's `brake`, `territoryOff`, `readOutside`.
    | ({
        kind: 'proposal'
        agentId: string
        proposalId: string
        proposalKind: ProposalKind
        reason: string
        review: boolean
        inputHash: string
      } & ProposalWords)
    // an agent's proposals past its inbox budget, as one line
    | { kind: 'proposalSummary'; agentId: string; count: number; proposalIds: string[] }
    | { kind: 'escalated'; agentId: string; item: EscalatedNeedsYou }
    | { kind: 'message'; agentId: string; item: MessageNeedsYou }
    // readOutside: the server's words «asked after reading the web (<tool>)» —
    // a plan task's question asked by an unattended run that read outside (m15)
    | { kind: 'silo'; item: SiloNeedsYou; readOutside?: string }
    // `noun`: the kind's count noun when the manifest says it (support: «13
    // support tickets wait on you»)
    | {
        kind: 'siloSummary'
        silo: string
        siloName: string
        count: number
        agentIds: string[]
        folders: string[]
        noun?: { one: string; many: string }
        byAgent?: Record<string, number>
      }
    | { kind: 'failedRun'; agentId: string; automation: InboxAutomationRef; runId: string; failure: { class: RunFailureClass; text: string }; streak: number }
    // a usage limit is the ACCOUNT's: every automation it stopped, one row
    | {
        kind: 'accountLimit'
        provider: string
        account: string
        window: { label: string; percent: number; resetsAt: string | null } | null
        automations: InboxAutomationRef[]
        agentIds: string[]
      }
    | { kind: 'missedRetry'; agentId: string; automation: InboxAutomationRef; runId: string; dueAt: string }
    // an own agent whose territory turned off; Silos cut
    // its capability of creating work on its own
    | { kind: 'territoryOff'; agentId: string }
    // an agent's folder that breaks the project folder rule (server
    // project-folder.ts): `reason` the check's words; door its Profile
    | { kind: 'folderRefused'; agentId: string; folder: string; reason: string }
    // a file right in the Projects folder an engine loads into every project
    // in it (server project-folder.ts): door a project's Memory, where it
    // shows with its off switch
    | { kind: 'projectsFolderFile'; path: string; projectsFolder: string; projects: string[] }
    | { kind: 'cut'; agentId: string; why: string }
    // turns of its day without a price — counted, never held
    | { kind: 'spend'; agentId: string; day: string; unpriced: number; models: string[] }
    // (fail closed) Silos could not read an unattended run's transcript
    // a run hangs from its automation; a task turn from its task
    | {
        kind: 'auditUnreadable'
        agentId: string
        heartbeat: boolean
        automation?: InboxAutomationRef
        runId?: string
        task?: { key: string; ref: string; title: string; session: string; turnId: string }
      }
    // messages from one sender (`from`: an agent id or
    // 'owner') its recipient (`agentId`) has not read past its next chance —
    // one row per recipient·sender; `why` what kept its heartbeat from
    // looking; `readOutside` the server's words «sent after reading the web (…)»
    | { kind: 'unreadMessages'; agentId: string; from: string; count: number; messageIds: string[]; why?: UnreadWhy; readOutside?: string }
    | { kind: 'agentSummary'; agentId: string; count: number; newest: string; runsOnly: boolean }
    // (server inbox.ts from inbox-source taskFlows) a quiet
    // line, never a Needs-you row — `waitsStart` and `comingToYou` live in
    // Yours to do, `idle` closes the Working now sheet. `door`: the app path
    // it opens (/tasks?view=idle). Routine, no ack.
    | { kind: 'taskLine'; line: 'waitsStart' | 'comingToYou' | 'idle'; count: number; keys: string[]; door: string; items: TaskLineItem[]; agentId?: string }
    // the stalls of agents Silos does NOT wake, one `due` row
    // («N tasks stalled — nobody is moving them ›» → /tasks?view=untouched)
    | { kind: 'tasksStalled'; count: number; keys: string[]; door?: string; agentIds?: string[]; agentId?: string }
    // a conversation whose open console holds task wakes
    // while nobody uses it — one `due` row per conversation, its door it
    | {
        kind: 'consoleIdle'
        agentId: string
        session: { id: string; folder: string | null; title: string | null }
        count: number
        keys: string[]
        heldSince: string
      }
    // a task waiting on an agent Silos does not
    // carry the question to (no linked ask in reach): the owner relays it — one
    // `due` row per task, door the task
    | {
        kind: 'waitsOnRelay'
        task: { key: string; ref: string; title: string; owner: string }
        on: string
        action: string
        agentIds: string[]
        agentId?: string
      }
    // closed plans still holding open tasks — ONE routine row, a door per plan
    | {
        kind: 'closedPlansOpen'
        count: number
        plans: Array<{ key: string; title: string; folder: string | null; file: string; open: number }>
        agentId?: string
      }
    // a plan's tasks its file holds that can't be read — one `due` row per plan
    | {
        kind: 'tasksUnreadable'
        plan: { key: string; id: string; title: string; folder: string | null; file: string }
        count: number
        reason: string
        first?: string
        agentId?: string
      }
    // an agent's own starts (task wakes, runs of its own
    // automations — never its heartbeat) at its day's
    // ceiling — or its spend cap: what waits, waits for tomorrow. `why`: the
    // server's line under the head (what the count or the money was made of)
    | {
        kind: 'ownTurnsCeiling'
        agentId: string
        used: number
        perDay: number
        waiting?: number
        day: string
        until?: string
        cap?: 'ceiling' | 'spend'
        spentUsd?: number
        why?: string
        starts?: { wakes: number; self: number }
        spent?: { wakes: number; heartbeat: number; self: number }
      }
    // the engines in use that Silos refuses or must catch up with (server
    // inbox.ts engineCompatRow): ONE row, each verdict with its agents; the
    // door is Settings › Engines, where each engine's Update is
    | { kind: 'engineCompat'; engines: Array<EngineCompat & { agentIds: string[] }>; agentIds: string[] }
    // the reserve engine runs agents but its Silos hooks are not installed
    // (inbox.ts engineUnwiredRow): one routine row, door Settings › Engines
    | { kind: 'engineUnwired'; engine: string; agentIds: string[] }
    // a newer Silos is published (inbox.ts silosUpdateRow): one routine row,
    // the date line's quiet chip, door Settings › About
    | { kind: 'silosUpdate'; installed: string; latest: string; installKind: string; how: string }
    // the seal: a control file changed outside Silos,
    // its plugin, its engine's config — each leaves by its own door
    | { kind: 'integrity'; seal: SealRowView; doors: string[]; agentId: string | null }
    // the tasks that existed before Silos watched a folder:
    // one row per folder, «Keep them all ›» — its sheet lists them, some can
    // be left out (they stay «added outside Silos», one by one)
    | { kind: 'plansBaseline'; folder: string; tasks: Array<{ key: string; title: string }> }
  )

// ── the Silo Standard's pages (Task 8) ──────────────────────────────────────
// GET /api/silos — a mirror of SiloDescriptor (server/src/silos/registry.ts):
// everything the web paints without asking a silo by name.
export type SiloPageState = 'pending' | 'active' | 'disabled' | 'error'
export interface SiloDescriptor {
  id: string
  name: string | null
  description: string | null
  icon?: string | null // the standard's icon catalog name; absent = the silo glyph
  // spec.theme of an ACTIVE silo, in the standard's words (catalogs.md
  // «Theme tokens»), checked by the kernel (conformance) and with
  // accent-soft filled — lib/themes.ts siloTheme maps it; null = none
  theme?: { name: string; light: Record<string, string>; dark: Record<string, string> } | null
  version: string | null
  apiVersion: string | null
  state: SiloPageState
  reason: string
  conventions: Array<{ source: string; convention: string }>
  wants: string[]
  kinds: string[] // qualified: invoices/invoice
  producer: { role: string; sync: string | null } | null
  // a kernel source (Silo Standard): the kernel kind it presents and
  // what that reads, in the catalog's words — said instead of a producer
  kernel?: { kind: string; reads: string } | null
  // its `list` views over its top-level kinds, in the manifest's order: the
  // first is its page's default; several are what the page switches between
  lists?: Array<{ id: string; kind: string; label: string | null }>
  records: { parsed: number; failed: number }
  lastWrite: string | null
  freshness: { stale: boolean; term: string | null } | null
  slots: { requested: string[]; granted: string[]; off: string[] }
  observedAt: string
  // the agents the owner bound to the producer role at approval (operator.json);
  // null = never bound through the dialog, [] = bound to none
  producers?: string[] | null
  // needs-you entries routed to the producer (audience: producer-agent,
  // operator-granted): `entries` of the manifest's `of`, going to `to`
  routing?: { to: string[]; entries: number[]; of: number } | null
  // with the installer (Settings › Silos): the submission of this id waiting
  // for the owner, and the sync automation created at approval
  submission?: SiloPendingSubmission | null
  automation?: SiloAutomationState | null
  // how it came (server silos/native.ts): 'builtin' = it comes with Silos
  provenance?: 'builtin' | null
  // where it stands in what Silos ships (server catalog.ts shippedLineup):
  // recommended, optional, or null = a silo of the owner's own
  lineup?: SiloLineup | null
  // a recommended silo: what uninstalling it gives up, in one sentence
  loses?: string | null
  // the server's words refusing any submission of this id — a dimension
  // Silos still serves natively; the page then offers no door
  native?: string | null
  // edge-only silos: the relations it declares, its tree view and
  // its lens (server registry.ts describeEntry) — absent when it declares none
  relations?: SiloRelationDecl[]
  tree?: { view: string; relation: string } | null
  lens?: { over: string; label: string | null; relation: string; by: string } | null
}
export interface SiloRelationDecl {
  name: string
  from: string
  to: string
  acyclic: boolean
}
// GET /api/silos/:id/relations/:name — the edges the owner drew; `note`: an
// end archived or deleted since (kept in the file, out of every chain)
export interface SiloRelationEdge {
  from: string
  to: string
  note?: 'archived' | 'gone' | 'apart'
}
export interface SiloRelationReading {
  silo: string
  relation: SiloRelationDecl
  edges: SiloRelationEdge[]
}
// GET /api/escalation — the window between hops, the cases open and lately closed
export interface EscalationCase {
  id: string
  kind: 'task' | 'row'
  key: string
  ref: string
  title: string
  who: string
  cause: string
  since: string
  openedAt: string
  hops: Array<{ to: string; at: string }>
  silo?: string
  siloName?: string
  closedAt?: string
  baseline?: true
}
export interface EscalationView {
  windowHours: number
  open: EscalationCase[]
  closed: EscalationCase[]
}
export interface SiloPendingSubmission {
  at: string
  submittedBy: string
  version: string | null
}
export interface SiloAutomationState {
  id: string
  name: string
  paused: boolean
}
// GET /api/silos `uninstalled` — a mirror of UninstalledSilo
// (server/src/silos/installer.ts): what stayed on disk, whether its producers
// kept writing, and whether a manifest was kept to reinstall from.
// a silo this Silos distributes but holds nowhere yet (the standard's
// reference manifests) — Settings › Silos lists it under «Available»
export interface SiloAvailable {
  id: string
  name: string | null
  description: string | null
  version: string | null
  producerRole?: string | null
}

export interface SiloUninstalled {
  id: string
  name: string
  uninstalledAt: string | null
  producers: string[]
  kept: { files: number; records: number | null; conventions: string[]; overlayAndJournal: string[] }
  grown: number
  manifest: { version: string | null; keptAt: string } | null
  automation: SiloAutomationState | null
  submission: SiloPendingSubmission | null
  // the server's refusal of a reinstall (a natively served dimension) — no Reinstall… then
  native?: string | null
  provenance?: 'builtin' | null // it came with Silos
  lineup?: SiloLineup | null
  loses?: string | null
}
export type SiloLineup = 'recommended' | 'optional'
// GET /api/silos/:id/records — mirrors of silos/views.ts (the list page).
export interface SiloStateWord {
  value: string
  one: string
  many: string
  terminal: boolean
}
export interface SiloKindDescriptor {
  name: string
  states: SiloStateWord[]
  columns: string[]
  columnTypes?: Record<string, string> // a typed column's declared type ('money'…)
  columnLabels?: Record<string, string> // a column's declared words (fieldSpec `label`)
  groupBy?: { field: string; label: string } | null // the list view's group dimension: rows carry `group`
  facets: Array<{ name: string; values: Array<{ value: string; label: string; count: number }> }>
  // the state is owner-settable (a set-field lists its field): a select on every row
  stateEdit?: { field: string; values: string[] } | null
  // a kind presenting kernel data: what the kernel reads for it, in the catalog's words
  reads?: string
  // the kernel-verbs declared on this kind (catalogs.md «Kernel-verbs»): the
  // catalog's word for the door, its word while the kernel works
  // («Stopping…»), and the guard field the kernel writes
  verbs?: Array<{ name: string; says: string; pending?: string; guard: string }>
  // the list view's fold: what the folded records are (`label`), or null
  // when it folds without saying; null/absent = the view folds nothing
  fold?: { label: string | null } | null
}
export interface SiloRecordRow {
  key: string
  id: string
  identity: string
  state: string | null
  stateLabel: string
  at: string | null
  anchors: Record<string, unknown>
  cells: Array<{ column: string; text: string }>
  row: string
  folded: boolean
  first?: boolean // the view's `first` holds: it comes first and draws the eye
  // the view's group: its value (null = none, the last group), its words and
  // how many matching records it holds over the WHOLE set
  // `opens`: what its heading opens (an agent, a folder, a conversation
  // `<folder>/<id>`) — absent: words only
  group?: { value: string | null; label: string; count: number; opens?: { hub: 'agent' | 'folder' | 'conversation'; value: string } }
  needsYou?: boolean // a needs-you entry holds for it right now
  overlay: boolean
  conflict: boolean
  remarks: string[]
  file: string | null
  // a sub-kind's row (a plan's task): the record it lives in. `standingList`:
  // that record is the kind's project list (the manifest's ensure-record id
  // — plans/tasks.plan.json), which has no name on screen
  parent?: { key: string; identity: string; at: string | null; standingList?: true }
  // the record itself is its kind's project list, when said
  standingList?: true
  // a task row's label (server views.ts taskLabelOf): what the
  // row paints — `<project>#t3` on the project's list, `<plan>#t3` else
  label?: string
  // the kernel's task flow (server silos/task-flow.ts), when the kind
  // declares roles.task — computed at request time with the live facts
  flow?: SiloTaskFlow
  // whose turn it is, in the server's one sentence (silos/turn.ts, s1)
  turn?: SiloTaskTurn
  // ?values=1: the record as read, and the last moment the journal saw it move
  value?: Record<string, unknown>
  moved?: string | null
  // the kernel-verbs whose `when` holds for this record now (names)
  verbs?: string[]
}
// A plan task's note as the server's task views carry it — every note of
// every task in a plans record's `value` (records ?values=1: value.notes[];
// a plan's record detail: value.tasks[].notes[]). `by` is whatever the file
// says (an agent can sign "owner"); `fromOwner` is true only when Silos
// recorded the owner writing that exact note (server task-mode/owner-notes.ts,
// the check task mode wakes on) — the only ground for painting «You».
export interface PlanTaskNoteWire {
  at: string
  by: string
  text: string
  fromOwner?: boolean
}
// `idle`: ready, its owner an agent Silos wakes, nobody on it
// and no wake on the way; `start`: its owner waits for you to start it.
// Kinds a newer server adds are read as their sentence (never dropped).
export type SiloTurnKind = 'done' | 'waiting' | 'parked' | 'stalled' | 'yours' | 'theirs' | 'idle' | 'start'
export interface SiloTaskTurn {
  kind: SiloTurnKind
  sentence: string
}
// the ten causes — the server's STALLED_CAUSES
export type SiloStalledCause =
  | 'unowned'
  | 'blocked-on-nothing'
  | 'blocker-missing'
  | 'blocker-cycle'
  | 'blocker-parked'
  | 'blocker-cancelled'
  | 'owner-cannot-run'
  | 'review-without-reviewer'
  | 'in-progress-nothing-live'
  | 'owner-outside-project'
export interface SiloTaskFlow {
  waiting: boolean
  gate: boolean
  unblocks: Array<{ id: string; owner: string }>
  stalled: boolean
  stalledCause: SiloStalledCause | null
  stalledBy: string | null
  // the seat of the stall: the task whose own situation is the cause —
  // itself, or the one down its chain; null when not stalled
  stalledAt?: string | null
  // the listed conversations still current on the task (plans 0.5.1 — a
  // released thread is history)
  currentConversations?: string[]
  // (server task-flow.ts TASK_FLOW_NAMES) `idle` ready and nobody
  // on it, its owner an agent Silos wakes, no wake on the way;
  // `waitsStart` its owner only moves when you start it.
  idle?: boolean
  waitsStart?: boolean
  // the wait, as the kernel read it — `asked` the agent's question verbatim,
  // `options` its closed choices (1–4 strings of ≤40 chars)
  waitsOn?: { owner: string; action: string; asked?: string; options?: string[] } | null
  waitsOnHuman?: boolean
  // the wait names an agent Silos does not carry it to: the owner relays it
  waitsOnRelay?: boolean
  // the ask Silos carries to the agent the wait names — linked, its
  // next heartbeat (seenBy, ms) in reach: a guard, no relay row
  asked?: { to: string; at: string; seenBy: number } | null
}
export interface SiloRecordsPage {
  silo: { id: string; name: string | null; state: SiloPageState; freshness: string | null }
  kind: SiloKindDescriptor
  total: number
  matching: number
  offset: number
  limit: number
  said: string | null
  unreadable: { count: number; items: Array<{ file: string; rel: string; reason: string }> }
  records: SiloRecordRow[]
}
// GET /api/silos/:id/record?key= — the record page (silos/views.ts recordDetail).
export interface SiloOverlayField {
  value: unknown
  base: unknown
  at: string
  by: string
  conflict?: { sourceValue: unknown; seenAt: string }
}
export interface SiloJournalLine {
  at: string
  event: 'opened' | 'baseline' | 'appeared' | 'transition' | 'removed'
  key?: string
  kind?: string
  from?: string | null
  to?: string | null
  fromTerminal?: boolean
  toTerminal?: boolean
  prevSeenAt?: string
  fileWrittenAt?: string
}
export interface SiloEventView {
  at: string
  silo: string
  key?: string
  verb: string
  by: string
  text: string
  detail?: Record<string, unknown>
}
// a kernel-verb carries its catalog name, its door's word, its guard field
// and whether its `when` holds for the record read (`applies`)
export interface SiloActionDescriptor {
  verb: string
  fields?: Array<{ name: string; values?: string[]; clearable?: boolean }>
  templates?: string[]
  name?: string
  says?: string
  pending?: string
  guard?: string
  applies?: boolean
}
// POST …/record/kernel-verb — what the kernel did, in words
export interface KernelVerbAnswer {
  says: string
  name: string
  key: string
  outcome?: 'stopped' | 'gone' | 'partial' | 'removed'
}
// GET /api/sessions/:folder/:id/processes — one record of the conversation's
// thread (running or left), its numbers at most one scan old
export interface ConversationProcess {
  id: string
  key: string // the System silo record's key — its page
  state: string
  stateLabel: string
  command: string
  startedAt: string
  origin: string
  stoppable: boolean
  pid?: number
  ports?: string
  cpu?: number // absent until two scans
  memoryMb?: number
  processes?: number
  session?: string
  conversation?: string
  why?: string
}
// POST …/trash's answer; `processes` only when «Also stop them» was asked
export interface TrashAnswer {
  ok?: boolean
  hidden?: boolean
  processes?: {
    stopped: Array<{ id: string; key: string; command: string; outcome: string; says: string }>
    notStopped: Array<{ id: string; key: string; command: string; why: string }>
    says: string
  }
}
export interface SiloRecordDetail {
  silo: { id: string; name: string | null; state: SiloPageState }
  kind: { name: string; states: SiloStateWord[] }
  record: SiloRecordRow
  version: string | null // the CAS token for set-field
  fields: Array<{ name: string; label?: string; type: string; value: unknown; text: string }>
  extra: Record<string, unknown>
  // url: the child's own link (its identity links there); by: who wrote it;
  // append / move: the owner's verbs on that sub-kind, when declared
  children: Array<{
    kind: string
    collection: string
    rows: Array<{ id: string; identity: string; stateLabel: string; at: string | null; url?: string; by?: string }>
    append?: { fields: Array<{ name: string; required: boolean; max: number | null }> }
    move?: { targets: Array<{ key: string; label: string }> }
  }>
  overlay: Record<string, SiloOverlayField> | null
  needsYou: Array<{ entry: number; urgency: string; clears: string | null; actions: string[] }>
  actions: SiloActionDescriptor[]
  history: SiloJournalLine[]
  events: SiloEventView[]
  // the record as the kernel reads it (envelope, fields, children lifted and
  // nested, computed values) — what lib/plan-record.ts draws a plan from
  value?: Record<string, unknown>
  // read by its path outside every location the silo reads: said, never written
  outside?: true
  // read from plans/closed/ by the key it had while open: outside too — a
  // finished plan's task, read only
  closed?: true
  // a sub-kind's record: the record it lives in (version is that file's)
  parent?: { key: string; kind: string; identity: string; at: string | null; standingList?: true }
  flow?: SiloTaskFlow
  // the conversations whose transcripts wrote the record's file, newest first
  writtenBy?: Array<{ folder: string; id: string; agentId: string; title: string; mtime: number }>
}
// set-field's answer: the record as written; on a task, the sibling tasks it
// made ready, each agent owner said with whether it will move
export interface SiloSetFieldResult {
  nowReady?: Array<{ key: string; id: string; identity: string; owner: string; wakes?: 'task' | 'never' }>
}
// POST /api/tasks/act — the owner's gesture on ONE task, one write (server
// silos/actions.ts taskGesture)
export type TaskActVerb = 'answer' | 'approve' | 'done' | 'drop' | 'reopen' | 'park' | 'resume' | 'remove-dependency' | 'hand'
// hand: `to` ('owner' — you), the owner and state the
// page painted, and whether it showed the task was added outside Silos
export interface TaskActArgs {
  text?: string
  asked?: string
  state?: string
  until?: string
  day?: string
  dep?: string
  to?: string
  owner?: string
  outside?: boolean
}
// the record as written (or as it is, `already`), what the gesture made
// ready, and what still holds the task (`holds`: dependency ids, a wait, a check)
// hand adds what it let go (`released`), the owner's Give that followed
// (`assign`: started, or why not) and whether it blessed an unknown origin
export interface TaskActAnswer extends SiloSetFieldResult {
  key: string
  record: Record<string, unknown>
  already: boolean
  holds: string[]
  released?: string[]
  assign?: { queued: boolean; why?: string; held?: string; wakes?: string }
  blessed?: boolean
}
// ── installing (server silos/installer.ts) ──────────────────────────────────
export type SiloInstallKind = 'install' | 'update' | 'reinstall'
// GET /api/silos/submissions — one row per pending manifest
export interface SiloSubmissionRow {
  id: string
  submittedBy: string
  at: string
  source: 'body' | 'draft'
  draftPath?: string
  name: string | null
  version: string | null
  update: boolean
}
// GET /api/silos/submissions/:id/consequences — everything the dialog shows.
// authorSays is the author's prose (a quote, never authority); derived is
// what Silos computed (the authority). The dialog derives nothing itself.
export interface SiloConsequences {
  id: string
  name: string | null
  submittedBy: string
  at: string
  source: 'body' | 'draft'
  draftPath?: string
  kind: SiloInstallKind
  version: { from: string | null; to: string | null }
  authorSays: {
    name: unknown
    description: unknown
    summary: unknown
    protocol: unknown[]
    sync: { service: unknown; contract: unknown; stateMap: unknown } | null
  }
  derived: {
    producerRole: string | null
    // 'protocol': Silos keeps its records about the agents bound here (Task
    // mode) — binding hands them instructions, they write nothing in it
    bindsTo?: 'protocol' | null
    proposedProducers: string[]
    forProducers: string[]
    reads: Array<{
      source: string
      root: string
      glob: string
      parser: string
      convention: string | null
      locations: Array<{ location: string; path: string; exists: boolean; files: number }>
      truncated?: unknown
      // a kernel source (root 'kernel'): no paths — the kernel kind, what it
      // reads in the catalog's words, and how many records Silos holds now
      kind?: string
      says?: string
      records?: number
    }>
    slots: Array<{ slot: string; says: string | null; off?: boolean }> // off: approving starts it switched off
    preview: {
      from: 'records' | 'examples'
      basis: string
      pulse: string | null
      needsYou: Array<{ urgency: string; matches: number; row: string | null; sample: string | null; audience?: 'producer-agent' }>
      list: string | null
    } | null
    requirements: Array<{ what: string; agentId: string | null; met: boolean | null }>
    wants: string[]
    notes: string[]
    errors: Array<{ check: number; where: string; message: string }>
    // off: the owner turned the silo off — an update keeps it off, and
    // `says` is the dialog's line for it («stays off — turn it on from its page»)
    update: { from: string | null; lines: string[]; loosening: string[]; off?: boolean; says?: string } | null
    proposedAutomation: { agentId: string | null; name: string; cadence: string; cron: string | null; says: string; prompt: string } | null
    // the look it brings (spec.theme), resolved by the kernel; `change`: what
    // an update does to it (null on an install, or when it stays the same).
    // name/light/dark null = an update that drops the look
    look?: { name: string | null; light: Record<string, string> | null; dark: Record<string, string> | null; says: string; change: string | null } | null
  }
}
// POST /api/silos/:id/record/message — the message waits in each producer's
// inbox and is read at its next conversation (no message wakes anyone)
export interface SiloMessageResult {
  messageIds: string[]
  to: string[]
  text: string
}
// POST /api/silos/:id/record/make-task (owner only):
// the filled template becomes a task of the producer `to` in its project's
// list — `assigned` when it is On its own (control 'own'; `why` when the
// assign failed); Only when told (control 'told'): the page opens it with it
export interface SiloMakeTaskResult {
  to: string
  taskKey: string
  ref: string
  title: string
  assigned: boolean
  control: 'own' | 'told'
  assign?: unknown
  why?: string
}

// GET /api/silos/:id/proposals — a producer's pending owner-field change.
export interface SiloProposalView {
  id: string
  silo: string
  key: string
  verb: string
  field: string
  from: unknown
  to: unknown
  by: string
  note: string | null
  at: string
  status: 'pending' | 'approved' | 'rejected' | 'failed'
  decidedAt?: string
  reason?: string
}

// a message between agents — a mirror of AgentMessage in
// server/src/types.ts (GET/POST/PATCH /api/agents/:id/messages…).
// `from` is an agent id or 'owner'.
export type AgentMessageState = 'new' | 'read' | 'answered' | 'needs_owner'
export interface AgentMessage {
  id: string
  from: string
  to: string
  at: string
  text: string
  state: AgentMessageState
  replyTo?: string
  // what the recipient said when it closed it (PATCH state + answer, ≤1000)
  answer?: string
  // the sender's turn, stamped by the server from the turn token
  run?: string
  // the tools from outside that turn used
  readOutside?: string[]
}
// the harness (server/src/harness.ts): ONE Claude Code — the `claude` on
// PATH runs consoles and chat turns alike (what Update touches) — the Agent
// SDK library Silos ships and the Claude Code release it is paired with
// (moves only with Silos), npm's latest, and every engine's verdict.
export interface HarnessStatus {
  harness: HarnessId
  name: string
  console: { version: string | null; path: string | null }
  library?: { name: string; version: string | null; pairedWith: string | null } | null
  latest: string | null
  checkedAt: string
  // the other harnesses Silos drives (OpenCode): version null = not installed
  others?: OtherHarnessStatus[]
  compat?: EngineCompat[]
}
// an engine's compatibility verdict — a mirror of EngineCompat in
// server/src/harness-run.ts. `refuses`: what Silos won't start on it;
// `message`: the one line said wherever it shows (null when ok).
export interface EngineCompat {
  harness: HarnessId
  name: string
  state: 'ok' | 'outdated' | 'missing' | 'ahead'
  installed: string | null
  needed: string
  update: string | null
  refuses: Array<'console' | 'chat'>
  message: string | null
}
export interface OtherHarnessStatus {
  harness: HarnessId
  name: string
  version: string | null
  path: string | null
  latest: null
}
export interface HarnessUpdate {
  before: string | null
  after: string | null
  output: string
}

// the Tools dimension's row (GET /api/tools) — a mirror of ToolAgg.
export interface ToolAgg {
  name: string
  server: string | null
  count: number
  agentIds: string[]
}

// the aggregate artifacts list (GET /api/artifacts) — a mirror of
// ArtifactItem in server/src/types.ts. title = the parsed path's last segment.
export interface ArtifactItem {
  title: string
  url: string
  path: string
  ts: string
  sessionKey: string // "folder/id" of the session that produced it
  sessionTitle: string
  agentId: string
}
// a catalog skill's full readme (GET /api/skills/:name).
export interface SkillReadme {
  name: string
  description?: string
  body: string
}
// GET /api/projects — distinct cwds seen in the index, so master can pick
// one when opening a new chat.
export interface Project {
  cwd: string
  sessions: number
  lastActivity: number
}
export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  ms: number
  truncated: boolean
}
// GET /api/agents/:id/skills-catalog — every skill visible to the agent
// (never capped) WITH description (its own SKILL.md's frontmatter). source:
// where that SKILL.md lives — the agent's folder, ~/.claude/skills or an
// enabled plugin (`plugin:skill`); absent = known only by name (a built-in,
// or seen in a transcript / declared on an agent).
// state (capability states): active = the folder loads it · held =
// moved to Silos' held store, the engine no longer sees it · available =
// EXACTLY what Add can do: one of Silos' plugin skills (source 'silos') the
// folder neither loads nor holds · seen = known from elsewhere (`seen` says
// where), never addable.
export type SkillSeen = 'other-folder' | 'plugin-off' | 'name-only'
// engines (a mixed folder's catalog only): one plain sentence per other
// engine starting there that sees the row differently («OpenCode agents
// here load it from Silos at launch») — the row is the folder copy's truth
// stillLoads (held only): the operator's personal copy of the same name
// still loads in this agent's engine — the folder copy is off, the name isn't
export interface SkillCatalogEntry {
  name: string
  description?: string
  source?: 'project' | 'user' | 'plugin' | 'silos' | 'account'
  shadowed?: string
  state?: 'active' | 'held' | 'available' | 'seen'
  plugin?: string
  seen?: SkillSeen
  stillLoads?: 'personal'
  engines?: string[]
  /** source 'account': the login whose Claude account sends it (null: Silos can't say which; unmatched: no recorded start matches its batch) */
  account?: { login: string | null; unmatched?: true }
  /** an account or personal skill's position in this folder, as found — absent = on; any value other than on · name-only · off was set by hand and is kept */
  position?: string
  /** the three positions can be written here (the folder's local settings decide it) */
  switches?: true
  /** what decides it instead: another settings file (named), or 'home' — the folder's settings dir is Claude Code's own */
  decidedBy?: { file: string; key: string } | 'home'
  /** a personal skill and an account skill share this name: one position reaches both */
  sameName?: true
  /** source 'account': whether this project loads what the account sends (the group's head) */
  origin?: { on: boolean; switches?: true; decidedBy?: { file: string; key: string } | 'home' }
  /** «Where it loads» (spec scopes T9): one line per place, broadest first — absent where the engine declares none */
  at?: SkillLine[]
}
export type SkillPosition = 'on' | 'name-only' | 'off'
/** A skill's copy, by where it comes from (a mirror of LoadsSkillCopy). */
export type SkillCopy = 'personal' | 'account' | 'project'
/** One line of a skill's «Where it loads» (a mirror of the server's LoadsSkillLine): LoadsLine's grammar with three positions. */
export interface SkillLine {
  place: LoadsScopeId | 'fact'
  /** an agent line: whose — a conversation line: its agent (the line it follows) */
  agent?: string
  /** a conversation line: its thread */
  conversation?: string
  agentName?: string
  fact?: { who: 'organization' | 'repository'; file: string; key: string }
  keptIn?: string
  door?: { word: string; where: string; url?: string; login?: string | null }
  /** this place's own position as found; absent: it follows the line above */
  entry?: string
  /** what loads there, every line above counted */
  result: string
  locked?: { why: 'organization' | 'wider' | 'engine'; at?: LoadsScopeId | 'fact'; reason?: 'plugin' | 'reserved' }
  /** the positions a click may pick here (absent: the line reads) */
  positions?: SkillPosition[]
  /** a folder copy's project line: switched by moving it out of the folder and back */
  store?: true
  refused?: { why: 'home' }
  /** a shared name: the copies this place's entry reaches, and those whose reach is not measured */
  reaches?: SkillCopy[]
  unmeasured?: SkillCopy[]
}
// GET /api/silos-skills?framework=&folder= — the create modal's offer (a
// mirror of SilosSkillOffer in server/src/complete-service.ts)
export interface SilosSkillOffer {
  skills: { name: string; description?: string }[]
  notOffered: { name: string; why: string }[]
}
// GET/PATCH /api/prefs — UI preferences persisted server-side
// (~/.silos/ui.json). A mirror of Prefs/ProjectsPrefs in
// server/src/prefs-store.ts.
// Multi-source pins: a pinned item from any source. `ref` is source-specific
// (claude: "folder/id"). A pin whose source is gone resolves to null.
export interface PinRef {
  source: string
  ref: string
}
export interface ProjectsPrefs {
  order?: string[]
  collapsed?: string[]
  pinned?: string[]
  inPool?: string[]
  pins?: PinRef[]
}
// the terminal panel's height (px) under the chat — a mirror of
// TerminalPrefs in server/src/prefs-store.ts.
export interface TerminalPrefs {
  height?: number
  fontSize?: number
}
// contextOpen/notifications — loose booleans (no sub-shape).
// collapsedAgents — a loose array (agentIds whose row is collapsed in
// the Sidebar), a mirror of PrefsStore.
// `setup` — the context column's "Agent setup" zone, expanded or not
// (absent = collapsed, the default).
export interface Prefs {
  projects?: ProjectsPrefs
  contextOpen?: boolean
  notifications?: boolean
  consoleTheme?: Record<string, 'silos' | 'own'>
  terminal?: TerminalPrefs
  collapsedAgents?: string[]
  collapsedAutomations?: string[]
  contextScope?: MachineryScope
  agentOrder?: string[]
  conversationSlots?: Record<string, { key: string; at: number }[]>
  detachedChains?: string[]
  setup?: boolean
  uses?: UsesPrefs
}
// POST /api/terminals — a mirror of TerminalHandle in server/src/terminal-service.ts.
export interface TerminalHandle {
  id: string
  agentId: string | null
  cwd: string
}
// the Memory panel — a mirror of MemoryFileInfo/MemoryLayers in
// server/src/memory-service.ts. `scope` = the layer the entry came from
// (autoMemory → 'auto'), stamped by the server on every entry.
export type MemoryScope = 'global' | 'project' | 'auto' | 'agent'
export interface MemoryFileInfo {
  name: string
  path: string
  scope: MemoryScope
  description?: string
  type?: string
  mtime: number
  exists: boolean
  /** bytes on disk */
  size?: number
  /** auto notes: the conversation that wrote it */
  origin?: string
  /** auto notes: whether MEMORY.md links it (absent = no index to ask) */
  inIndex?: boolean
  /** the MEMORY index: its line count (Claude Code loads the first 200) */
  lines?: number
  /** auto notes: when the note says it was written (metadata.modified) */
  writtenAt?: number
  /** auto notes: the agent whose conversation wrote it */
  author?: string
}
export interface MemoryLayers {
  global: MemoryFileInfo
  project: MemoryFileInfo | null
  autoMemory: MemoryFileInfo[]
  /** the directory the auto layer lists — the agent's own when an agentId
   *  was asked and its engine reads one (memory per agent), else the
   *  folder's; where a new note goes. `autoScope` says which. */
  autoDir?: string
  autoScope?: 'agent' | 'folder'
  // the agent's own memory (~/.silos/agents/<id>/memory.md) — present only
  // when the request carried an agentId (see api.memory.list).
  agent: MemoryFileInfo | null
  /** every instruction file a conversation in the folder loads (spec
   *  memory-places T2), the engine's load order, the agent's own last */
  rows?: MemoryRow[]
  /** where a new file may be created (T3's fixed places) */
  places?: MemoryPlace[]
  /** the folder's own engine-config dir is a login's: only its top file is the project's */
  homeFolder?: true
  /** the agent's other folders: their instruction files do not load */
  alsoWorksIn?: string[]
  notes?: string[]
}
// a mirror of InstructionRow / InstructionPlace in server/src/harnesses/contract.ts
// (the server supplies origin, reach, when and weight; the web says them)
export type MemoryOrigin = 'organization' | 'machine' | 'above' | 'project' | 'private' | 'auto' | 'agent'
export type MemoryRowKind =
  | 'managed'
  | 'personal'
  | 'personal-rule'
  | 'above'
  | 'project'
  | 'project-rule'
  | 'private'
  | 'subfolder'
  | 'import'
  | 'agents'
  | 'auto-index'
  | 'auto-note'
  | 'launch'
  | 'agent'
export type MemoryLaunch = 'console' | 'chat' | 'wake' | 'run' | 'run-inherits' | 'run-no-folder'
export interface MemoryReach {
  scope: 'organization' | 'machine' | 'under' | 'project' | 'agent'
  under?: string
  launches: MemoryLaunch[]
  paths?: string
  /** login config dirs that do not load it (one that keeps its own) */
  notOn?: string[]
}
export interface MemoryRow {
  path: string
  real: string
  rel: string
  origin: MemoryOrigin
  kind: MemoryRowKind
  engineType: string | null
  engine: string | null
  reach: MemoryReach
  when: { at: 'start' | 'on-demand'; under?: string }
  weight: { chars: number; tokens: number; as: 'loaded' | 'disk'; at?: string }
  bytes: number
  mtime: number
  editable: boolean
  readOnly?: string
  /** a write needs confirmed: true (the machine's files) */
  confirm?: true
  importedBy?: string
  through?: 'import' | 'alone'
  movedBy?: string
  inIndex?: boolean
  fromRecord?: true
}
export interface MemoryPlace {
  path: string
  shape: 'file' | 'dir'
  origin: MemoryOrigin
  kind: MemoryRowKind
  reach: MemoryReach
  engine: string | null
  confirm?: true
  exists?: true
  ignoreLine?: { file: string; line: string }
  ignoreElsewhere?: true
}
// the automations resident's model — a mirror of
// server/src/automations-types.ts. Type only: the UI lives elsewhere.
export interface OnceTrigger {
  kind: 'once'
  at: string
}
export interface CronTrigger {
  kind: 'cron'
  expr: string
  tz?: string
}
export interface WebhookTrigger {
  kind: 'webhook'
  secret: string
}
export interface FilesTrigger {
  kind: 'files'
  folder: string
  glob: string
  debounceMs?: number
}
export interface ConversationTrigger {
  kind: 'conversation'
  when: 'finished' | 'needs_you'
  sourceAgentId?: string
}
export interface WatchCheckHttp {
  type: 'http'
  url: string
  method?: string
  headers?: Record<string, string>
}
export interface WatchCheckCommand {
  type: 'command'
  cwd: string
  command: string
}
export interface WatchCheckPath {
  type: 'path'
  path: string
}
export type WatchCheck = WatchCheckHttp | WatchCheckCommand | WatchCheckPath
export interface WatchTrigger {
  kind: 'watch'
  every: string
  check: WatchCheck
  runWhen: 'changed' | 'nonzero' | 'zero' | 'matches'
  pattern?: string
}
// the free period — its words and slots are period.ts's
export interface PeriodTrigger {
  kind: 'period'
  period: Period
}
export type Trigger = OnceTrigger | CronTrigger | WebhookTrigger | FilesTrigger | ConversationTrigger | WatchTrigger | PeriodTrigger
export interface ThreadKeep {
  mode: 'keep'
  folder?: string
  sessionId?: string
}
export interface ThreadNew {
  mode: 'new'
}
export type Thread = ThreadKeep | ThreadNew
export type RunStatus = 'queued' | 'waiting_approval' | 'running' | 'ok' | 'failed' | 'skipped' | 'waiting_reset'
// what an ok run said it did (its OUTCOME line) — absent = unclassified
export type RunOutcome = 'nothing' | 'acted'
export interface AutomationLastRun {
  at: string
  status: RunStatus
  durationMs: number
  sessionKey?: string
  summary?: string
  outcome?: RunOutcome
  exitCode?: number // a command run's
}
// what its runs execute — an agent turn (absent) or a command run without
// Claude. Owner-only.
export interface CommandRun {
  kind: 'command'
  argv: string[] // exec'd directly, no shell; $SILOS_AGENT_STATE expands
  cwd?: string // default the agent's folder
  timeoutMs?: number // default 10 min, at most 60
  onFailure: 'inbox' | 'agent'
  okCodes?: number[] // default [0]
}
export type AutomationRun = { kind: 'agent' } | CommandRun
// the command leg of a command run
export interface CommandLeg {
  exitCode?: number
  timedOut?: boolean
  error?: string
  durationMs: number
  lastLine?: string
  logBytes: number
}
export interface Automation {
  id: string
  name: string
  agentId: string
  prompt: string
  trigger: Trigger
  thread: Thread
  approval: boolean
  keepAlive: boolean
  paused: boolean
  createdAt: string
  nextRunAt?: string
  lastRun?: AutomationLastRun
  maxRunsPerDay?: number
  inheritHooks?: boolean
  projectSettings?: boolean
  lastFingerprint?: string
  lastRunError?: string
  // paused by the platform (not by a person) — see Automation.autoPaused
  autoPaused?: boolean
  // materialized from an agent's responsibility, not created by a person
  origin?: 'agent'
  // what its runs run on — the pair Run on pins (provider '' never travels:
  // absent = the agent's own); absent = the agent's default
  runsOn?: { provider?: string; model?: string }
  // absent = an agent turn
  run?: AutomationRun
  // what it spent in its last 30 days (GET /api/automations, the owner's
  // read — server/src/vitals.ts): null = a command (it runs no turn);
  // absent = not served (an agent's bearer, or an answer of one automation)
  usage30d?: AutomationUsage | null
}
/** An automation's last 30 days (server/src/vitals.ts AutomationUsage). */
export interface AutomationUsage {
  tokens: number
  cost: number
  unpricedTokens: number
  /** 30 local days, ascending, zeros included */
  days: Array<{ date: string; tokens: number }>
  /** the finished runs the figure holds (a run not read yet is not in it) */
  runsCounted: number
  /** some of its tokens ran on a plan: no dollars for them */
  plan: boolean
}
export interface Run {
  id: string
  automationId: string
  at: string
  status: RunStatus
  startedAt?: string
  endedAt?: string
  durationMs?: number
  sessionKey?: string
  error?: string
  summary?: string
  outcome?: RunOutcome
  reason?: string
  resetsAt?: string
  promptOverride?: string
  // why the run was started: a standing wake's causes (saved runs may
  // still say 'message:<id>:<from>' — history, no message wakes anyone)
  cause?: string
  // a command run: its exit code, its leg, and whether its failure was
  // handed to the agent (status/summary/sessionKey are then that turn's)
  exitCode?: number
  command?: CommandLeg
  handover?: boolean
}
// Providers v1 — a mirror of the /api/providers* and /api/accounts* routes.
// A keyed provider's apiKey ALWAYS arrives masked (sk-…last4).
export interface RateWindow {
  status: string
  resetsAt?: string
  kind?: string
  utilization?: number
  at: string
}
export interface ClaudeAccountView {
  name: string
  configDir: string | null
  providerId: string
  // Claude's own answer (`claude auth status`); an API-key login is signed
  // in with no email nor plan
  loggedIn: boolean
  email: string | null
  plan: string | null
  // its transcripts land where the index reads (projects/ linked to the
  // machine account's); false = the account dir holds its own, invisible
  shared: boolean
  window?: RateWindow | null
}
export type ProviderView =
  | { id: string; kind: 'claude-account'; label: string; account: ClaudeAccountView; window: RateWindow | null }
  // models: the ids its key reaches (server provider-models.ts — asked once at
  // `<root>/v1/models`); absent/empty = unknown, the picker takes a typed id
  // modelLimits: context/output tokens the gateway publishes per model;
  // modelsAt: when Silos last read the listing (the server re-reads it at
  // boot and every 6 h — gateway-models.ts)
  | {
      id: string
      kind: 'anthropic-compatible'
      label: string
      baseUrl: string
      apiKey: string
      models?: string[]
      modelLimits?: Record<string, { context?: number; output?: number }>
      modelsAt?: string
      createdAt: string
      window: RateWindow | null
    }
  // an engine's own providers (server providers-store.ts; `harness` names the
  // engine — today OpenCode): a key for a provider the engine catalogues
  // (apiKey masked), or a passthrough to the engine's own login
  | {
      id: string
      kind: 'harness-provider'
      label: string
      harness: HarnessId
      providerId: string
      apiKey: string
      createdAt: string
      window: RateWindow | null
    }
  | { id: string; kind: 'harness-native'; label: string; harness: HarnessId; providerId: string; createdAt: string; window: RateWindow | null }

// the cockpit's selectors — a mirror of CockpitOverrides/ModelInfo in
// server/src/cockpit.ts and server/src/model-catalog.ts. The catalog
// ALWAYS comes from the SDK via the server (proof-of-life rule: never a
// hardcoded list in the UI).
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type CockpitPermissionMode = 'bypassPermissions' | 'plan' | 'acceptEdits'
export interface ConvPrefs {
  model?: string
  effort?: EffortLevel
  permissionMode?: CockpitPermissionMode
  fastMode?: boolean
  // which Claude account or key this conversation runs on (a provider id:
  // 'default' · 'account:<name>' · a key id); absent = the agent's own.
  provider?: string
  // the voice it answers in (an output style's exact name); absent = the
  // agent's own, else the operator's Claude Code setting
  outputStyle?: string
}
// One output style an engine offers (GET /api/agents/:id/output-styles).
export interface OutputStyleInfo {
  id: string
  description: string
  source: 'built-in' | 'user' | 'project'
}
export interface ModelInfo {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: EffortLevel[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}
export interface CatalogView {
  models: ModelInfo[]
  fetchedAt: string | null
}

// What a folder's conversations load at start — a mirror of the server's
// LoadsRow (harnesses/contract.ts, GET /api/folders/:folder/loads): one row
// per plugin, MCP server and connector, with its origin (an owner of
// lib/owners.ts and what carries it), whether this project loads it
// (active · held — yours or the project's, off here · available — the
// Claude account's, not added here), the file that decides it when it is
// not the project's local file, and its switch (or why it has none).
export interface LoadsCarries {
  skills: string[]
  commands: string[]
  agents: string[]
  hooks: { count: number; events: string[] }
  mcp: number
  placeholders: number
  lsp: string[]
  outputStyles: string[]
}
/** A place a loading choice is kept at — a mirror of server/src/harnesses/contract.ts */
export type LoadsScopeId = 'account' | 'machine' | 'project' | 'agent' | 'conversation'
export interface LoadsScope {
  id: LoadsScopeId
  carrier: 'file' | 'launch' | 'door'
  keptIn?: string
}
/** One line of a row's «Where it loads» (a mirror of the server's LoadsLine). */
export interface LoadsLine {
  place: LoadsScopeId | 'fact'
  /** an agent line: whose — a conversation line: its agent (the line it follows) */
  agent?: string
  /** a conversation line: its thread id */
  conversation?: string
  /** ONE conversation's own entry, where it stands: pending until a start of
   *  its thread after it; then in effect, or it didn't take */
  here?: { state: 'pending' | 'in-effect' | 'didnt-take'; since: number; read?: number }
  agentName?: string
  /** the project line of one agent's read: every agent of the project it reaches, by name */
  agents?: string[]
  fact?: { who: 'organization' | 'repository' | 'engine' | 'default'; file: string; key: string }
  entry?: 'on' | 'off'
  result: 'on' | 'off'
  keptIn?: string
  /** `head`: what keeps it off there is its origin's head (all the account sends of the kind) */
  /** `parent`: an imported file whose importing file (its shown name) is off at `at` */
  locked?: { why: 'wider' | 'organization' | 'provided'; at?: LoadsScopeId | 'fact'; head?: true; parent?: string }
  door?: { word: string; where: string; url?: string; login?: string | null }
  /** this place's own «off» is its origin's head: «on» here adds this one and holds the others (rule 4) */
  headOff?: true
  /** what the line's switch says before it acts, in the engine's words: the click waits for a yes */
  asks?: string
  /** a line's own switch (machine, project, an agent's): the exact names its entry writes, and the other rows they reach */
  switch?: { names: string[]; reaches?: string[] }
  /** its switch refused: the engine is older than the version its key was
   *  confirmed on, or the file its entry is kept in is one the engine's
   *  writer won't rewrite (`reason` names it and says why) */
  refused?: { why: 'engine'; needs: string } | { why: 'file'; reason: string }
  /** this place's own entry didn't take (server/src/switch-proof.ts withPlaceProof):
   *  the newest reading it reaches, after the entry, still lists an «off» (`name`)
   *  or lists none of an «on»'s servers */
  proof?: { to: 'on' | 'off'; name?: string; status?: LoadsHealth['status']; read: LoadsHealth['read'] }
}
/** POST …/loads/switch — with scope machine, which logins Silos connects followed the user file */
export interface LoadsSwitchAnswer {
  folder: string
  ok: boolean
  logins?: { followed: string[]; missed: { name: string; why: string; file?: string }[] }
}
export interface LoadsRow {
  key: string
  engine: string
  kind: 'plugin' | 'mcp' | 'connector'
  name: string
  label: string
  /** false: only the id its tool names carry is known (no switch) */
  exact: boolean
  origin: { owner: 'agent' | 'project' | 'you' | 'account' | null; carrier: string; login?: string | null; unmatched?: true }
  state: 'active' | 'held' | 'available'
  decidedBy?: { file: string; key: string }
  /** the key family: override — the narrowest place decides, either way; off-only — off anywhere is off */
  family?: 'override' | 'off-only'
  /** «Where it loads» — one line per place and per fact, broadest first (absent: an engine with no places) */
  at?: LoadsLine[]
  /** the engine's exact names the click writes, and the other rows it reaches (a shared server's copies, a namesake) */
  switch?: { names: string[]; reaches?: string[] }
  /** a switch refused — said in its place: the folder is a login's config home, or the engine is older than `needs` */
  refused?: { why: 'home' } | { why: 'engine'; needs: string }
  parent?: string
  observed?: { from: 'reading' | 'tool-id' | 'notice' }
  placeholder?: { connector?: string }
  sameAs?: string
  replacedBy?: string
  detail?: string
  carries?: LoadsCarries
  /** a server's or connector's health: the newest status reading that
   *  lists it (harnesses/contract.ts LoadsHealth) */
  health?: LoadsHealth
  /** the project's own switch file turns it off — by its own entry or its origin's key */
  heldHere?: { by: 'item' | 'origin'; names: string[] }
  /** a reading after that switch still lists it (server/src/switch-proof.ts):
   *  «still loaded — the switch didn't take» */
  proof?: { name: string; status: LoadsHealth['status']; by: 'item' | 'origin'; read: LoadsHealth['read'] }
  /** the engine's own way to sign it in when it waits for your sign-in
   *  (server harnesses/contract.ts LoadsSignIn): absent, no door */
  signIn?: LoadsSignIn
}
/** console: a new real console of an agent here, `draft` the sentence the
 *  owner sends in it (shown beside it to copy; `menu`: the engine's menu of
 *  its servers, the door named by it) · link: a page outside Silos,
 *  «Connect in <where> ›» */
export type LoadsSignIn = { via: 'console'; draft: string; menu?: true } | { via: 'link'; url: string; where: string }
export interface LoadsHealth {
  status: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled'
  reason?: string
  tools?: number
  read: {
    at: number
    from: 'turn' | 'check' | 'notice'
    via?: 'chat' | 'run' | 'wake' | 'round'
    agent?: string
    agentName?: string
    login: string | null
    mode?: 'console' | 'chat'
  }
  /** how often it did not start (server/src/start-health.ts): no `of` — the
   *  last `n` times in a row since `since`; `of` — `n` of the last `of` */
  count?: { from: 'readings' | 'notices'; n: number; of?: number; since?: number; consoles?: true }
}
/** An account origin as a whole (plugins or connectors your Claude account
 *  sends): whether this project loads it, and its head's switch — or what
 *  decides it instead (server harnesses/contract.ts LoadsOrigin). */
export interface LoadsOrigin {
  id: 'plugins' | 'skills' | 'connectors'
  engine: string
  on: boolean
  switch?: true
  decidedBy?: { file: string; key: string }
  refused?: LoadsRow['refused']
  /** «Where it loads» for the head: the account door, the facts, the machine, the project, each agent */
  at?: LoadsLine[]
}
/** GET /api/loads/machine — each engine's heads for this whole machine, outside any folder */
export interface MachineHeads {
  engines: { engine: string; label: string; heads: { id: LoadsOrigin['id']; off: boolean; at: LoadsLine[] }[] }[]
}
/** Every Memory row's places (GET /api/folders/:folder/instructions, spec
 *  memory-places T4) — a mirror of InstructionPlacesRow in
 *  server/src/harnesses/contract.ts, one list per engine of the folder. */
export interface InstructionPlacesRow {
  path: string
  key: string
  /** off-only (a file) · override (auto memory) */
  family: 'off-only' | 'override'
  at: LoadsLine[]
  /** no switch at a place (or none at all): why */
  inert?: string
}
export interface FolderInstructionPlaces {
  folder: string
  engines: { id: string; label: string; rows: InstructionPlacesRow[] }[]
  conversation?: { thread: string; agent: string | null }
  logins?: LoadsSwitchAnswer['logins']
}
/** Your personal instructions in one folder (GET /api/folders/:folder/personal):
 *  one per engine of the folder that has the switch — none: the row is a fact */
export interface FolderPersonal {
  folder: string
  engines: {
    id: string
    label: string
    /** off: kept out for every login · partly: for some logins only */
    state: 'on' | 'off' | 'partly'
    /** the exact entries the switch writes */
    entries: string[]
    logins: number
    rules: boolean
    refused?: string
    decidedBy?: { file: string; key: string }
    /** «Where it loads» (spec scopes T10): the machine (a door), facts,
     *  the project, each agent and — asked — one conversation */
    at?: LoadsLine[]
  }[]
  /** asked for one conversation: the thread the server resolved, and its agent */
  conversation?: { thread: string; agent: string | null }
}

export interface FolderLoads {
  folder: string
  /** readsStatus: its turns read their servers' status — a row with no reading is «not read yet»;
   *  switches: its rows can be turned off here; checks: «Check now» — an engine without them is said so in one line */
  engines: { id: string; label: string; readsStatus?: true; switches?: true; checks?: true; scopes?: LoadsScope[] }[]
  rows: LoadsRow[]
  /** the account origins' heads (absent from an older server: no head) */
  origins?: LoadsOrigin[]
  logins: { login: string | null; accountId: string; matched: 'account-id' | 'elimination' | null }[]
  notes: string[]
  /** what the rows' health rests on: status readings kept, conversations
   *  whose start notice was read, of them console starts */
  basis?: { readings: number; notices: number; consoles: number }
  /** each place's last «Turn all off / on» that still holds (spec scopes §4) — its «Undo» */
  undo?: BulkUndoView[]
  /** a page: each conversation a row's line names («Also off in …»), with the session it continues in */
  conversations?: { thread: string; folder: string; id: string; title: string }[]
  /** asked for one conversation: its thread and agent */
  conversation?: { thread: string; agent: string | null }
}
/** A bulk click's place (a mirror of server/src/loads-bulk.ts BulkAt). */
export type BulkPlace =
  { scope: 'project' } | { scope: 'machine'; confirmed?: boolean } | { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: string }
/** What «Turn all off / on» reaches at one place, said first (loads-bulk.ts BulkPreview). */
export interface BulkPreview {
  to: 'on' | 'off'
  scope: BulkPlace['scope']
  agent?: string
  /** `skill`: a click on Skills — the skills it changes */
  changes: { plugin: number; mcp: number; connector: number; skill?: number }
  heads: ('plugins' | 'connectors' | 'skills')[]
  cannot: number
  asks?: string[]
}
/** A skill a click on Skills names (loads-bulk.ts SkillWant). */
export interface BulkSkill {
  name: string
  from: 'account' | 'personal' | 'project' | 'plugin'
}
export interface BulkUndoView {
  scope: BulkPlace['scope']
  agent?: string
  group: string
  to: 'on' | 'off'
  at: number
  counts: Record<string, number>
  /** a click on Skills */
  kind?: 'skills'
}
/** «Only <agent>» — the two-sided set (loads-bulk.ts OnlyAgentPlan). */
export interface OnlyAgentPlan {
  family: 'override' | 'off-only'
  agent: string
  project: 'on' | 'off' | null
  agents: { id: string; to: 'on' | 'off' }[]
  others: string[]
}
// «Check now» on a project's Tools — a mirror of server/src/loads-check.ts
// (GET/POST /api/folders/:folder/loads/check): one target per login the
// folder's agents run on by default.
export interface LoadsCheckRun {
  at: number
  ms?: number
  withoutLocal?: true
  incomplete?: true
  counts?: { connected: number; failed: number; needsAuth: number; other: number }
}
export interface LoadsCheckTarget {
  provider: string
  label: string
  login: string | null
  engine: string
  agents: string[]
  cost: string
  account: boolean
  sendsHere: boolean
  sends?: { at: number; connectors: string[] }
  last?: LoadsCheckRun
}
export interface LoadsCheckStatus {
  targets: LoadsCheckTarget[]
  running: { provider: string; withoutLocal: boolean; startedAt: number } | null
}
export interface LoadsCheckAnswer extends LoadsCheckRun {
  provider: string
  login: string | null
  connectors?: string[] | null
}
// an agent's OWN MCP server — a mirror of server/src/agent-tools.ts (GET
// /api/agents/:id/tools): its plugin's .mcp.json (active) or Silos' held
// twin. `refs`: the Vault names its config refers to; `needs`: those its
// Vault does not give it today.
export interface OwnToolRow {
  name: string
  kind: 'mcp'
  scope: 'agent'
  state: 'active' | 'held'
  transport: 'stdio' | 'http' | 'sse'
  detail: string
  refs: string[]
  needs: string[]
}
export type OwnToolConfig =
  { command: string; args?: string[]; env?: Record<string, string> } | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
// Map › Uses — a mirror of server/src/uses.ts (GET /api/uses): which
// agents/projects/conversations actually used a model, file, tool, MCP
// server, skill or account. Every cell counts conversations.
export type UsesRowKind = 'agent' | 'project' | 'conversation' | 'automation'
export type UsesColKind = 'model' | 'file' | 'tool' | 'mcp' | 'skill' | 'provider' | 'secret' | 'command'
export interface UsesAxis {
  id: string
  label: string
  sub?: string
  n: number
  m?: number
  rows?: number
  origin?: string
}
export interface UsesRef {
  s: number
  m?: number
  r?: number
}
export interface UsesCell {
  r: string
  c: string
  n: number
  m?: number
  refs: UsesRef[]
}
export interface UsesSessionRef {
  key: string
  title: string
  agentId: string
  mtime: number
  run: boolean
}
export interface UsesView {
  rows: UsesAxis[]
  cols: UsesAxis[]
  cells: UsesCell[]
  sessions: UsesSessionRef[]
  measure: 'tokens' | 'changes' | 'calls' | null
  considered: number
  truncated: { rows: number; cols: number }
  now: number
}
export interface UsesPrefs {
  rows?: UsesRowKind
  cols?: UsesColKind
  since?: string
}

export type WsEvent =
  | { ev: 'hello' }
  | { ev: 'pong' }
  // counts: every agent's uncapped totals, recomputed by the server per
  // event (the client's lists are capped — it can't count from them)
  | { ev: 'session'; meta: SessionView; counts?: Record<string, SessionCounts> }
  | { ev: 'removed'; folder: string; id: string; counts?: Record<string, SessionCounts> }
  // model/permissionMode are the SDK init's echo (the process's effective
  // truth) — the UI compares them against what was requested (an honest warn chip).
  // slashCommands: the REAL slash commands the init announced (excluding
  // terminal-only ones) — feed the composer's '/' menu. Absent = an init
  // with no such field → the menu falls back to skills only.
  | { ev: 'chat-init'; turnId: string; folder: string; sessionId: string; model?: string; permissionMode?: string; slashCommands?: string[] }
  | { ev: 'chat-delta'; turnId: string; text: string }
  | { ev: 'chat-thinking'; turnId: string; text: string }
  | { ev: 'chat-tool'; turnId: string; name: string; input?: string }
  | { ev: 'chat-usage'; turnId: string; outputTokens: number; contextTokens?: number }
  | { ev: 'chat-done'; turnId: string; subtype: string; costUsd: number | null }
  | { ev: 'chat-error'; turnId: string; error: string }
  | { ev: 'chat-ratelimit'; turnId: string; status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: string; kind?: string; utilization?: number }
  | { ev: 'automation'; automation: Automation }
  | { ev: 'run'; run: Run }
  // Auto-resume of interactive chats: an interactive turn that got
  // rate-limited, to be resumed (or its cancellation). See PendingResume.
  | { ev: 'pending-resume'; pending: PendingResume }
  | { ev: 'pending-resume-removed'; folder: string; id: string }
  // Knows live: the server sends
  // KnowsEvent bare ({type:'knows', …}, no `ev`) — WsClient wraps it here so
  // the store dispatches every message on `ev`.
  | { ev: 'knows'; knows: KnowsEvent }
  // an active silo's Home rows changed — by the clock alone too (server
  // silos/surfaces.ts signature): Home re-fetches the board
  | { ev: 'silos' }
  // the server's inbox composition changed (server.ts checkInbox): re-fetch the board
  | { ev: 'inbox' }
  // a daily digest was written (server/src/digest-job.ts) — Home re-reads its band
  | { ev: 'digest' }

// a mirror of server/src/knows-watcher.ts — a memory/context/skills file
// written (by an agent or by hand). The server coalesces a burst per
// (kind, folder): read it as "refetch this kind for this folder"; name /
// action / agentId are the burst's LAST event, not a full change list.
export interface KnowsEvent {
  type: 'knows'
  folder: string // the agent's project folder ('' = global, visible to every agent)
  agentId?: string // only per-agent paths (context/<id>, the agent's memory)
  kind: 'memory' | 'context' | 'skills' | 'plans' // plans: <folder>/plans/*.plan.json, folder = the territory
  action: 'added' | 'changed' | 'removed'
  name: string
  scope: string
}

// Auto-resume: a mirror of server/src/pending-resumes-store.ts — an
// interactive turn that hit the rate limit and Silos will resume on its own.
export interface PendingResume {
  agentId: string
  folder: string
  sessionId: string
  text: string
  cwd?: string
  resetsAt: string
  resumeAt: string
  createdAt: string
  attempts: number
  fallbackProviderId?: string
  turnCount?: number
  mtime?: number
  // an honest TERMINAL state: auto-resume gave up — the banner says so
  // instead of the promise silently vanishing.
  gaveUp?: { reason: string; tries: number }
}

// GET /api/account-load — who is on each Claude account right now, read
// from the process table (server/src/account-load.ts). Owner-only.
export type AccountLoadSource = 'console' | 'silos' | 'nested' | 'outside'
export interface AccountLoadEntry {
  account: string
  total: number
  bySource: Record<AccountLoadSource, number>
  outside: Array<{ label: string; count: number }>
  consoles: Array<{ agentId?: string; count: number }>
}
export type AccountLoad =
  // truncated: the server's scan hit its cap — the counts are a floor
  { supported: true; at: number; truncated?: boolean; accounts: AccountLoadEntry[] } | { supported: false }

// GET /api/plan-usage?provider=<id> — how much of a Claude subscription's
// 5h and weekly windows is spent (server harnesses/claude-code/plan-usage.ts,
// the endpoint Claude Code's /usage reads). Owner-only; null body = the
// provider is not a Claude account.
export interface PlanUsageWindow {
  kind: string
  label: string
  percent: number
  resetsAt: string | null
  windowMs: number | null
  severity: 'normal' | 'warning' | 'critical'
  active: boolean
}
export type PlanUsage =
  | { ok: true; at: number; stale: boolean; windows: PlanUsageWindow[] }
  | { ok: false; at: number; reason: 'not-logged-in' | 'token-expired' | 'unavailable'; detail?: string }

// Knows & can › Loaded at start (GET /api/agents/:id/loaded): what every
// session of the agent receives before its first message, read from disk by
// its engine's own reader (server harnesses/<engine>/loaded-at-start.ts).
// null = no folder, or an engine that can't say — the row is hidden.
export interface LoadedInstruction {
  path: string
  rel: string
  kind: 'local' | 'parent' | 'subfolder' | 'import' | 'rules' | 'project' | 'global' | 'silos'
  when: 'start' | 'on-demand'
  under?: string
  importedBy?: string
  bytes: number
}
export interface LoadedInjection {
  origin: 'plugin' | 'user' | 'project' | 'local' | 'managed' | 'silos'
  name: string
  on: string[]
  command: string
  file: string
  outputStyle?: true
  offBySilos?: true
  /** a plugin the Claude account sends: its owner is that account (login null = Silos can't say which) */
  account?: { login: string | null }
  seen?: { chars: number; excerpt: string; at: number; failed?: true }
  /** never recorded in this many recent starts that recorded other start hooks (it prints nothing) */
  unseenIn?: number
}
export interface LoadedMcp {
  name: string
  source: 'agent' | 'project' | 'user' | 'plugin' | 'account'
  from: string
  /** the engine's own exact name (`plugin:<plugin>:<server>`) */
  engineName?: string
  /** a server of a plugin the Claude account sends */
  account?: { login: string | null }
  /** no address: the plugin leaves this tool to an account connector */
  placeholder?: true
  /** one address with this earlier server: connected once, under it */
  sameAs?: string
}

// What a conversation started with, measured from its own transcript
// (server harnesses/claude-code/started-with.ts). Owners are the seven of
// lib/owners.ts.
export type StartedWithOwner = 'conversation' | 'agent' | 'project' | 'silos' | 'you' | 'account' | 'engine'
export interface StartedWithPart {
  owner: StartedWithOwner
  kind: string
  label: string
  chars: number
  tokens: number
  ref?: string
  stale?: true
  unsourced?: true
  loginBound?: true
  truncated?: { savedTo: string; size: string }
  exitCode?: number
  /** the key of the inventory row it belongs to (a plugin, a server, a connector) */
  item?: string
  /** the plugin it comes with (shown name) */
  group?: string
}
export interface StartedWith {
  totalTokens: number | null
  at: string | null
  measured: boolean
  mode: 'console' | 'chat' | null
  parts: StartedWithPart[]
  pendingMcp: number
  pendingMcpServers: string[]
  failedMcpServers: { name: string; error: string }[]
  now: {
    approx: true
    ratio: number
    parts: StartedWithPart[]
    tools: number
    pendingMcpServers: string[]
    failedMcpServers: { name: string; error: string }[]
    mcp: { server: string; label: string; owner: StartedWithOwner; tools: number; loginBound?: true; item?: string; group?: string }[]
  } | null
  contextNow: { tokens: number; at: string | null } | null
  accounts: { email: string; at: string | null }[]
  /** the engine's exact names of the MCP servers its first turn carried */
  loadedNames?: string[]
  /** what went wrong at its start (a conversation's own reading), each on
   *  the key of the inventory row it lands on — absent `row`: no project
   *  here, names and no door. Only on one conversation's reading. */
  problems?: StartProblem[]
}
/** One server that didn't start, or waits for a sign-in, at a conversation's start. */
export interface StartProblem {
  kind: 'failed' | 'needs-auth'
  name: string
  label: string
  row?: string
  signIn?: LoadsSignIn
}
/** The measured weight of what a folder loads (GET …/loads/weight): the
 *  tokens each inventory row's parts took at the newest measured start there. */
export interface FolderLoadsWeight {
  folder: string
  at: string | null
  conversation: { folder: string; id: string }
  mode: 'console' | 'chat' | null
  total: number
  items: Record<string, { tokens: number; parts: { kind: string; label: string; tokens: number }[] }>
}
export type StartedWithMode = 'console' | 'chat' | 'run'
export interface AgentStartedWithMode {
  n: number
  total: number
  range: [number, number]
  owners: Partial<Record<StartedWithOwner, number>>
  latest: { folder: string; id: string; at: string | null; login: string | null }
}
export type AgentStartedWith = Partial<Record<StartedWithMode, AgentStartedWithMode>>
export interface LoadedAtStart {
  engine: string
  folder: string
  instructions: LoadedInstruction[]
  injections: LoadedInjection[]
  outputStyle: { name: string; from: string; silos?: true } | null
  mcp: LoadedMcp[]
  toolsDoor: boolean
  notes: string[]
}

// Task mode: GET /api/task-mode, GET /api/tasks/mode,
// POST /api/tasks/work
export type AgentWakes = 'task' | 'never'
export interface TaskModeStatus {
  silo: string
  installed: boolean
  active: boolean
  bound: string[]
}
// `assigned`: the owner's gesture — «Give to X», «Start X ›»
export interface TaskWakeLine {
  id: string
  reason: 'unblocked' | 'children-done' | 'owner-note' | 'next-check' | 'stalled' | 'assigned' | 'answered'
  says: string
  at: string
  state: 'queued' | 'delivered' | 'superseded'
  deliveredAt?: string
  session?: string
  held?: string
  until?: string
  via?: 'wake' | 'work' | 'talk' | 'claim'
}
// the task feed — the visible reply of a turn the machinery sent for the task
// (mirror of server/src/task-mode/feed.ts TaskFeedCard; `texts` are the
// turn's visible segments, the folded UI shows the LAST — the answer)
export interface TaskFeedCard {
  at: string
  agent: string | null
  via: 'wake' | 'briefed'
  texts: string[]
  folder: string
  sessionId: string
}
// what the task page's ONE door opens (server routes/console.ts doorOf):
// the owner agent's tip of the task's thread (null:
// the door starts one), a turn running in that thread (the door only opens
// it), and whether its engine's console takes the briefing
// `hasConsole`: the agent has a console in the index — «Open» goes there
// (server open-surface.ts), else chat
export interface TaskDoorFacts {
  thread: { sessionId: string; folder: string } | null
  running: { sessionId: string; folder: string; readOnly?: true; error?: string } | null
  consoleBriefs: boolean
  hasConsole?: boolean
}
// the live line's facts (server task-mode/engine.ts TaskLive): what is
// happening to a start on the task right now
export type TaskLiveFact =
  | { kind: 'running'; turns: Array<{ turnId: string; sessionId: string | null; started: boolean; agent?: string }> }
  | { kind: 'queued'; cap: 'agent' | 'global'; running: number }
  | { kind: 'failed'; why: string; engine?: true }
  | { kind: 'held'; why: string }
  | { kind: 'starting' }
  | { kind: 'console'; sessionId: string }
// `handTo`: where «Give to… ›» may take the task —
// you ('owner', wakes null) and the agents in play whose fence holds it
export interface TaskModeView {
  bound: boolean
  owner: string
  wakes: AgentWakes | null
  history: TaskWakeLine[]
  heldNow?: string | null
  door?: TaskDoorFacts | null
  live?: TaskLiveFact | null
  ownerOutside?: true
  handTo?: Array<{ id: string; name: string; wakes: AgentWakes | null }>
}
// a task a conversation works, as the server reads it (GET /api/sessions/
// :folder/:id/tasks and /api/tasks/by-session — one function, session-tasks.ts):
// `current` false once its thread was unlinked; `closed` a task
// of a plan under plans/closed/ (read only)
// a finished plan (plans/closed/), as Tasks › Done's Plans strip lists it
// (GET /api/tasks/closed-plans — a listing; its tasks are in no reading).
// `mtime`: ms, when it moved to closed/; `open`: tasks it still holds open
export interface ClosedPlanEntry {
  key: string
  title: string
  folder: string | null
  file: string
  mtime: number
  done: number
  dropped: number
  open: number
}
export interface SessionTaskLine {
  key: string
  ref: string
  title: string
  state: string
  closed?: true
  current: boolean
  file?: string
}
// `warn`: what the link it made carries (another agent's conversation, a
// claim on someone else's task) — said beside the console, never a refusal
export interface TaskWorkAnswer {
  mode: 'new' | 'resumed'
  folder: string
  sessionId: string
  consoleKey?: string
  briefed: boolean
  why?: string
  linked?: boolean
  warn?: string
  released?: boolean
  releaseError?: string
}

// automation templates — mirror of server/src/automation-templates.ts (no logic)
export type TemplateParamKind = 'agent' | 'text' | 'url' | 'path' | 'time' | 'day' | 'command' | 'glob'
export interface TemplateParam {
  key: string
  kind: TemplateParamKind
  label: string
  placeholder?: string
  default?: string
}
export interface AutomationTemplate {
  kind: 'silos.automation-template'
  version: 1
  id: string
  name: string
  sentence: string // its blanks as {{key}}
  description: string
  params: TemplateParam[]
  automation: Record<string, unknown>
  source: 'builtin' | 'user'
  ownerOnly: boolean
}

// role packs — mirror of server/src/role-pack.ts (no logic)
export interface RolePack {
  kind: 'silos.role-pack'
  version: 1
  id: string
  packVersion: string
  name: string
  emoji: string
  mission?: { text: string; never: string[] }
  produces: { silo: string; version?: string }[]
  skills: { name: string; verified?: string; sources?: string[]; reviewEvery?: string }[]
  automations: { template: string }[]
  secrets: { name: string; why: string }[]
  territory: { needs: string[] }
  engine: { prefer?: string }
  files: Record<string, string>
}
export interface RolePackConsequences {
  agent: { id: string; name: string; emoji: string; folder: string; mission: { text: string; never: string[] } | null; framework?: string }
  skills: { name: string; files: number; verified?: string; reviewEvery?: string }[]
  silos: { silo: string; action: 'bind' | 'submit' | 'missing'; version: string | null; wanted?: string }[]
  automations: { template: string; name: string; sentence: string; ready: boolean; ownerOnly: boolean; command?: string; blanks: string[] }[]
  secrets: { name: string; why: string; present: boolean }[]
  territory: string[]
  engine: { prefer?: string; note?: string }
  problems: string[]
}
export interface RolePackReport {
  skillFiles: number
  automations: { template: string; saved?: string; automationId?: string; error?: string }[]
  silos: { silo: string; done: 'bound' | 'submitted' | 'missing' | 'failed'; error?: string }[]
  secrets: { name: string; state: 'stored' | 'present' | 'missing'; error?: string }[]
}

// a seal's row (server seals.ts SealRow)
export type SealRowView = { id: string; at: string } & (
  | { kind: 'changedOutside'; file: string; held: string | null }
  | { kind: 'unverified'; file: string; held: string | null }
  | { kind: 'ownerTokenRotated' }
  | { kind: 'sessionsReset' }
  | { kind: 'pluginAppeared'; agentId: string; files: Array<{ path: string; held: string }>; byHold?: true }
  | { kind: 'pluginChanged'; agentId: string; paths: string[]; version: string; edited?: string[] }
  | { kind: 'configChanged'; folder: string | null; files: string[]; agentIds: string[]; record?: true }
  | { kind: 'enginePlugins'; change: 'installed' | 'removed'; plugins: string[] }
)

// what the engine changed in its own configuration (server seals.ts PageLine):
// a settings diff that only touched engine keys, or a plugin it moved to
// another version — Settings › Engines' quiet list, never Needs you
export type EnginePageLine =
  | { kind: 'engineKeys'; at: string; file: string; folder: string; agentIds: string[]; keys: string[] }
  | { kind: 'pluginVersion'; at: string; plugin: string; from: string; to: string; text: string }

// proposals — mirror of server/src/proposals.ts + proposals-view.ts (no logic)
export type ProposalKind = 'automation' | 'skill' | 'mission'
export type ProposalState = 'pending' | 'accepted' | 'dismissed' | 'expired'
export interface ProposalWords {
  title: string
  brake?: string
  territoryOff?: string
  pace?: string
  readOutside?: string
  crosses?: string
  skillOf?: string
}
export type ProposalDiffLine = [' ' | '+' | '-', string]
export interface ProposalView {
  id: string
  by: string
  at: string
  run?: string
  // the conversation it was proposed in (a session id of it)
  session?: string
  kind: ProposalKind
  reason: string
  input: Record<string, unknown>
  state: ProposalState
  decidedAt?: string
  decidedBy?: string
  result?: string
  expiresAt: string
  inputHash: string
  contentHash?: string
  readOutside?: string[]
  agentName: string
  review: boolean
  words: ProposalWords
  automation?: {
    name: string
    when: string
    maxRunsPerDay: number
    prompt?: string
    command?: string
    cwd?: string
    runsOn?: { provider?: string; model?: string }
  }
  // `folder`: a change to that project's skill — files say how they differ
  skill?: { name: string; files: Array<{ path: string; size: number; change?: 'new' | 'changed' | 'same' }> | null; folder?: string; removed?: string[] }
  mission?: { before: { text: string; never: string[] } | null; after: { text: string; never: string[] } }
}

// an engine's own sign-in by link (server harnesses/opencode/sign-in.ts)
export interface EngineSignInOption {
  providerId: string
  name: string
  label: string
}
export type EngineSignInState =
  | { state: 'waiting'; providerId: string; url: string; instructions: string }
  | { state: 'done'; providerId: string; provider?: string }
  | { state: 'failed'; providerId: string; error: string }
