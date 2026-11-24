import type { HarnessId } from './harnesses/contract.js'
import type { Mission } from './mission.js'
import type { Control, Cut, Heartbeat, Proactive } from './control.js'

export type Role = 'user' | 'assistant'

// Multimedia: images in tool_results and images pasted directly by the
// user — both forms are covered because they share a shape. METADATA only:
// the base64 NEVER travels in the turn — `ref` is a stable pointer to the
// block inside the JSONL (`t.<toolUseId>.<n>` for tool_result images,
// `u.<uuid>.<n>` for user-pasted ones) that the /media/:ref route
// re-extracts on demand. w/h come from the PNG's IHDR header (or from
// toolUseResult.dimensions) when known — the UI reserves the exact space
// and scroll doesn't jump on load.
export interface TurnImage {
  ref: string
  mediaType: string
  bytes: number // approximate decoded size (base64 * 3/4)
  w?: number
  h?: number
}

export interface ToolUseDetail {
  name: string
  skill: string | null
  input: string // JSON.stringify of the input, capped at 2000
  result: string | null // text of the tool_result linked by id, capped at 2000; null if it hasn't arrived yet
  images?: TurnImage[] // multimedia: images from the tool_result (a Read of a PNG, a screenshot…), metadata only
  isError?: boolean // the tool_result was is_error:true — the UI tints it so failures are scannable
  // ExitPlanMode only (c6, verified on CLI 2.1.316): the CLI fills the
  // tool_use input with the whole plan and its file. `approved` = the result
  // says so (toolUseResult.plan / "User has approved your plan"); any other
  // answer is `not_approved` — no rejection sample exists, so no stronger word.
  plan?: PlanProposal
}

export interface PlanProposal {
  text: string // the plan's markdown, capped at PLAN_TEXT_CAP
  state: 'proposed' | 'approved' | 'not_approved'
  file?: string // ~/.claude/plans/<slug>.md
}

export interface TranscriptTurn {
  index: number
  role: Role
  text: string
  tools: string[] // "Bash" | "skill:finance-acme"
  ts: string | null
  thinking?: string // concatenated thinking blocks, capped at 4000
  toolUses?: ToolUseDetail[] // present only if the turn has tools
  outputTokens?: number // message.usage.output_tokens from the assistant entry, if present
  interjection?: boolean // rescued from inside a tool_result (see harnesses/claude-code/parser.ts interjectionsOf) — a message sent while a turn was in progress
  compact?: boolean // marker turn for a compaction (entry isCompactSummary:true), text is always ''
  // Harness warning — an assistant entry with message.model="<synthetic>"
  // (rate limits, API errors, "Prompt is too long"…). The UI paints it as a
  // system band, not prose.
  synthetic?: boolean
  // Marker turn for a receipt (a system/turn_duration entry the CLI writes
  // when closing each turn; the SDK doesn't write these), text ''.
  durationMs?: number
  // The FINAL message of a turn carries message.stop_reason === "end_turn"
  // (intermediate ones, including text between tool calls, carry
  // "tool_use") — an honest close signal that also works for SDK sessions,
  // which don't write turn_duration. See lastTurnClosed (web/src/lib/live.ts).
  turnEnded?: boolean
  // A message from ANOTHER Claude session (the harness's peer-messaging) —
  // `from` is the sender (a friendly from-name if one came through,
  // otherwise the raw socket) and `text` the clean body, without the
  // <cross-session-message> wrapper or boilerplate. The UI paints it as a
  // third voice, never a user bubble.
  // `agentId` is present ONLY when the sender confidently resolves to a
  // known, non-archived agent (filled in by the server when serving, see
  // resolveSender). The UI links it to that agent's (the sender's)
  // dossier, NOT to the exact source conversation: the message carries no
  // session_id, so that jump is pending data the harness doesn't provide
  // today. Absent → plain text (no link).
  interSession?: { from: string; agentId?: string }
  // Images pasted by the user in THIS turn (direct type:'image' blocks in
  // the content) — metadata only, see TurnImage.
  images?: TurnImage[]
}

export interface SessionMeta {
  id: string
  folder: string // dir name under ~/.claude/projects (munged form)
  title: string
  skills: string[]
  cwd: string | null
  mtime: number
  size: number
  turnCount: number
  contextTokens?: number // input+cache_creation+cache_read from the last assistant usage seen
  model?: string // message.model from the last assistant usage seen
  // An engine whose console pins the model (traits.consolePinsModel — today
  // OpenCode, as `provider/model`): the model the LAST USER message asked
  // for — what the console runs next (OpenCode: the TUI's /models pick), and
  // when it was written. The pin follower (pin-follower.ts) turns a pick made
  // inside the console into the conversation's own pref.
  requestedModel?: string
  requestedModelAt?: number
  queue?: string[] // external queue (queue-operation), present only if non-empty
  // Role of the last real conversational turn — the input the server uses
  // to compute `unread` (see unread.ts). Present only when there is one
  // (same omission criterion as model/contextTokens).
  lastRole?: Role
  // Is the agent's turn still open (owner wrote, no receipt/end_turn yet)?
  // See AccumulatorState.turnOpen. Present whenever lastRole is.
  turnOpen?: boolean
  // an AskUserQuestion is open (asked, not yet answered) — the sidebar
  // dot turns SOLID even mid-turn: the agent is waiting on the owner.
  // Present only when true (same omission criterion as queue).
  pendingAsk?: boolean
  // ms of the tool_use still in flight (no tool_result yet) — only while the
  // turn is open. See AccumulatorState.toolSince.
  toolSince?: number
  // Newest mtime under the session's subagents dir — a background agent
  // (the Agent tool spawns detached and CLOSES the main turn) keeps working
  // with turnOpen false, and this is the only trace. Present whenever the
  // dir has transcripts; the client decides "working" from its recency
  // (live.ts), so a stale dir is history, not work.
  subMtime?: number
  // ms of the NEWEST tool still in flight in any subagent transcript under
  // that dir (any depth: nested agents, workflow agents, a resumed one) — a
  // subagent running a long command writes nothing until it returns, and
  // the same bound as the main turn's toolSince holds (work-live.ts).
  // Present only while one is in flight.
  subToolSince?: number
  // ms the newest background command it launched and still awaits started
  // (AccumulatorState.shells) — working with the turn closed, bounded by
  // SHELL_MAX_MS (work-live.ts). Present only while one is awaited.
  shellSince?: number
  // Transcript birthtime ms — when this conversation started (the baseline
  // for "new in this conversation"). Absent when the filesystem reports no
  // birthtime (birthtimeMs === 0), same rule as DiskSubagent.startedAt.
  startedAt?: number
  // The session id this transcript continues (Claude Code forks on
  // `--resume`, see AccumulatorState.resumedFrom). Present only when set.
  resumedFrom?: string
  // Started by a console `/clear` (see AccumulatorState.startedByClear).
  // Present only when true.
  startedByClear?: true
  // Written by the engine's CONSOLE (Claude Code: entrypoint "cli"). Present
  // only when true. What «Open» reads: an agent with
  // a console in the index opens in its console, else in chat.
  console?: true
  // The harness that wrote this session. Absent = the default engine (harnessOf).
  harness?: HarnessId
}

export interface Agent {
  id: string
  name: string
  emoji: string
  folder: string | null // real path; null only for master
  // Extra territories (absolute paths) besides `folder`; territoriesOf() is the single helper.
  folders?: string[]
  skills: string[]
  model?: string // optional: model for the agent's sessions (empty = CLI default); used by F2
  // The mission (mission.ts): why it acts, in the
  // owner's words — the text and the «Never» lines. It replaced role and the
  // charter (systemAppend) and reaches every conversation of both engines as
  // the head of the system append. Written only by the owner (PATCH).
  mission?: Mission
  default?: boolean
  archived?: boolean
  // Absent = the fallback engine (harnessOf) and the default provider;
  // AgentRegistry writes both on create.
  // The harness the agent runs on (harnesses/contract.ts; harnesses/registry.ts harnessOf()).
  framework?: HarnessId
  // Providers v1: provider id ('default' | 'account:<name>' | an id from
  // providers.json). Absent = default. An id
  // that no longer exists is tolerated on read (falls back to the default
  // with a single warning) — hard validation lives on the write routes
  // (server.ts).
  provider?: string
  // Providers v1 — simple fallback: an ORDERED chain of provider ids to
  // jump to (at a turn boundary) when the primary hits a rate limit with
  // resetsAt. See fallback.ts for which entries are usable in v1.
  fallback?: string[]
  // The cockpit's outputStyle at the agent level (cockpit.ts): the exact
  // name of a style its engine offers ('Explanatory', a custom style's
  // name…). Absent = nobody set one = the operator's own Claude Code config.
  outputStyle?: string
  // The ONE setting that decides whether something happens without the
  // owner (control.ts): «Only when told» · «On its own».
  // Always written by the registry (absent on read = 'told'); every reader
  // asks the DERIVED controlOf() — an `own` without its territory or its
  // mission operates as told, this field intact (decision 2, G5-r7).
  control?: Control
  // When it thinks (with `own`): rhythm week|day|never, the weekly
  // think's day, the hour (staggered minute by default), and its sleep.
  heartbeat?: Heartbeat
  // The owner's two knobs (R7, B1): the ceiling of turns on its own a day
  // (absent = OWN_TURNS_PER_DAY) and its unattended spend a day in USD
  // (absent = UNATTENDED_SPEND_USD_DAY); null on the PATCH = the default.
  ownTurnsPerDay?: number
  unattendedSpendPerDay?: number
  // «Let it continue today»: lifts TODAY's ceiling and spend cap
  ownExemptDay?: string
  // the capability of creating work of its own, cut by Silos; the
  // owner lifts it with cut: null («Allow again»)
  cut?: Cut
  // the proactive mode: On its own plus a setting —
  // written only by the owner (PATCH, never a bearer); `control: 'told'`
  // clears it. Every reader asks proactiveOf() (control.ts).
  proactive?: Proactive
  // installed from a role pack (role-pack.ts): which one, at which version —
  // template ≠ instance, the pack never travels back with this agent's state
  pack?: { id: string; packVersion: string }
}

// A Board task (TaskCreate/TaskUpdate) — see harnesses/claude-code/context.ts.
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
  agents: string[] // ids of subagents launched while this task was in_progress
}

// One transcript under the session's subagents dir (root/folder/id/
// subagents/agent-<id>.jsonl) with its sidecar metadata. This listing is
// the ONLY complete census of the session's background work: the context's
// SubagentRef tracking sees depth-1 Task spawns in the main transcript,
// but a backgrounded skill's own children (spawnDepth 2+) never write
// there. The client derives alive/finished from mtime (live.ts), same as
// conversations.
export interface DiskSubagent {
  id: string
  description: string | null // meta.json description (null: no sidecar)
  type: string | null // meta.json agentType
  model?: string
  skill?: string // forked-skill.json skillName — this agent IS a skill run
  effort?: string
  parentId?: string // meta.json parentAgentId — nests under another agent
  depth?: number // meta.json spawnDepth (1 = direct child of the session)
  mtime: number
  startedAt?: number // transcript birthtime ms — "at work for 12m" is real
  // ms of its tool_use still waiting for a result — at work even while
  // silent (work-live.ts agentAtWork); absent when nothing is in flight
  toolSince?: number
  lastTool?: string // what it is doing NOW (tail of a RECENT transcript, or one with a tool in flight)
  lastToolDetail?: string // the tool's own description/command, if it gave one
  // the agent's token bill so far, summed from its transcript's assistant
  // messages (incremental read; the column says which model and
  // how many tokens without being asked). usd is null when any of its
  // models has no price row — never a lying partial figure.
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; usd: number | null }
}

// A reference to a subagent (Agent tool) launched from the session.
export interface SubagentRef {
  id: string
  description: string
  type: string // subagent_type from the input
  model?: string
  background: boolean
  startedAt: string
  endedAt?: string
  taskId?: string // the in_progress task at launch time, if there was one
}

// "Conversation context" derived from the same JSONL as TranscriptTurn, via
// a second accumulator (ContextAccumulator, harnesses/claude-code/context.ts) — feeds the context
// column, the Board, and the live state. See A1-brief.md.
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
    // the AskUserQuestion's tool_use id: its tool_result IS the answer. Kept
    // in the state so an answer landing after a restart (the context comes
    // back from the cache) still closes the question.
    toolUseId?: string
  } | null
  links: {
    prs: { number: number; url: string; repo: string; ts: string }[]
    artifacts: { path: string; url: string; ts: string; title?: string }[] // one per URL; title = the published page's title (Artifact tool_result), absent when only a frame-link was seen
    worktree: { path: string; name: string } | null
  }
  events: { ts: string; kind: 'model' | 'refusal' | 'compact' | 'loop' | 'remote' | 'info'; text: string }[] // max 50, most recent
  files: { path: string; edits: number; writes: number; reads: number; sent: number; disk: number }[] // max 200 paths; sent = handed over via SendUserFile; disk = a plans/*.plan.json path cited in a tool's input other than Read/Write/Edit (harnesses/claude-code/context.ts attributePlanMentions — no clocks, no mtime: it paints activity, it never attributes authorship)
  tools: { name: string; server: string | null; count: number }[]
  // accountEmail: the Claude login of its latest start, as Claude Code itself
  // records it (session_context userEmail) — the account it RAN on, not the
  // one it was set to (they can differ). Absent on other engines.
  flags: { remote: boolean; permissionMode: string | null; gitBranch: string | null; effort: string | null; model: string | null; accountEmail?: string | null }
  waiting: { kind: 'monitor' | 'wakeup' | 'workflow'; since: string; label: string } | null
  // what this conversation sent to OTHERS and may still be waiting on
  // (proof of life: if it is doing something, it must show in the
  // column). Real transcript signals only, two kinds:
  //  - 'session': an outbound SendMessage nothing answered yet — cleared by
  //    an incoming <cross-session-message from-name=…> / task-notification
  //    from that name, or by the owner's next typed turn
  //  - 'message': a message POSTed to an agent's inbox through the API; its
  //    live state/answer are joined at read time (server.ts enrichOutbound)
  //    from the message store, never written into the cached context —
  //    state 'gone' = the stored message no longer exists (pruned)
  // Bounded: at most 5 of each kind, oldest dropped.
  outbound?: {
    kind: 'session' | 'message'
    to: string // the session/agent name messaged, or the inbox agent's id
    summary: string // SendMessage input.summary (or the message's first words) / the message text's first words
    since: string
    messageId?: string // message only: the stored message's id
    state?: AgentMessageState | 'gone' // joined live, message only
    answer?: string // joined live: what the recipient said when it closed it
  }[]
  // computed by Silos from each assistant message's real usage × API list
  // prices (harnesses/claude-code/model-prices.ts — the only source; the CLI Silos
  // runs writes no cost-state aggregate live): USD at API list prices —
  // NOTIONAL under a subscription, real money only with an API key/provider;
  // the client labels it "~$X · API price" accordingly.
  // unknownModels: some usage had no price row and contributed $0;
  // unpricedModels names those models (the column says which, never «unpriced»).
  // planPriced: the harness reported $0 for every assistant message (OpenCode on a plan) — a subscription priced it, not free.
  cost: {
    totalUsd: number
    unknownModels: boolean
    unpricedModels?: string[]
    planPriced?: true
    byModel: { model: string; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }[]
  } | null
  // documents pasted into the conversation (user-message document blocks).
  // The real shape carries NO filename — only media_type + base64 — so this
  // is type/size/when; bytes estimated from the base64 length (never
  // decoded here). Last DOCS_CAP kept.
  documents: { mediaType: string; bytes: number; ts: string }[]
  // Claude Code's /rewind checkpoints (file-history-delta lines), grouped
  // per file: how many versions were checkpointed and when the last one
  // landed. Read-only observation — the restore itself is claude's /rewind.
  fileHistory: { path: string; versions: number; lastAt: string }[]
  // c6: the conversation's LATEST plan-mode plan (ExitPlanMode). Absent when
  // it never planned. `proposed` waits on the owner like an open question
  // (it lights pendingAsk). title = the plan's first heading.
  planMode?: { state: 'proposed' | 'approved' | 'not_approved'; title: string; at: string; file?: string; toolUseId?: string } // toolUseId: only while proposed (the result it waits on)
  // Bash: the environment variables it named (names only, never values) —
  // counted per call; the Uses matrix joins them against the Vault for a
  // secret's reach. The 'commands' sibling (programs launched) was removed:
  // the matrix maps visibility, not activity.
  envRefs?: { name: string; count: number }[]
  // its start notice: what the engine told the model about its servers at
  // the conversation's start (start-health.ts). A PART of their health —
  // it names some failures and the sign-ins, never the whole status.
  // Absent on engines that record none, and before the first start.
  start?: StartNotice
}

// A conversation's start notice (SessionContext.start). Names are the
// engine's exact ones; a sign-in a console announces only as the id its
// tool names carry stays that id (needsAuthIds) — never turned back into a
// name here: the engine's inventory resolves it against the names it knows.
export interface StartNotice {
  /** the record's time (ISO), or null */
  at: string | null
  mode: 'console' | 'chat' | null
  /** servers it said did not start, with the engine's message (cleaned) */
  failed: { name: string; reason: string }[]
  /** servers waiting for a sign-in, by exact name */
  needsAuth: string[]
  /** servers waiting for a sign-in, known only by their tool-name id */
  needsAuthIds?: string[]
}

// A conversation card (GET /api/board) — a pass over
// index.allSessions()+getContext(), see board.ts.
export interface BoardCard {
  folder: string
  id: string
  title: string
  agentId: string
  cwd: string | null
  state: 'needs_you' | 'working' | 'waiting' | 'done_today' | 'idle'
  // only on a 'waiting' card: what it waits on (SessionContext.waiting)
  waiting?: { kind: 'monitor' | 'wakeup' | 'workflow'; since: string; label: string }
  planDone?: number
  planTotal?: number
  mtime: number
  // FacetFilter: tool names seen in the session (ctx.tools, already
  // accumulated by ContextAccumulator) — present only if there are any.
  // This is what makes the client's "tool" facet real: with no data, the
  // facet hides itself.
  tools?: string[]
}

// An aggregated row for the Tools dimension (GET /api/tools) — see tools-aggregate.ts.
export interface ToolAgg {
  name: string
  server: string | null
  count: number
  agentIds: string[]
}

// Aggregated artifacts list (GET /api/artifacts) — see artifacts-aggregate.ts.
// title = the last segment of the path (the only thing the parsed data carries).
export interface ArtifactItem {
  title: string
  url: string
  path: string
  ts: string
  sessionKey: string // "folder/id" of the session that produced it
  sessionTitle: string
  agentId: string
}

export interface Config {
  root: string
  dataDir: string
  host: string
  port: number
  liveMs: number
  webDist: string // root of the served static bundle — SILOS_WEB_DIST overrides it (see config.ts)
  home: string // the user's home — SILOS_HOME overrides (tests, containers); disk readers of the engine's files read from here, never from os.homedir() directly
  claudeManagedDir?: string // Claude Code's managed-settings directory (read-only) — SILOS_CLAUDE_MANAGED_DIR overrides
}

// A message one agent (or the owner) leaves in another agent's inbox — a
// file under <dataDir>/messages/<to>/<id>.json (messages.ts; the
// store is the server's, fenced and sealed). It is read at the
// recipient's next conversation — any conversation starts with its inbox —
// and «read» is marked by the server; `needs_owner` surfaces it in
// Home's Needs you. No message wakes anyone.
export type AgentMessageState = 'new' | 'read' | 'answered' | 'needs_owner'
export const AGENT_MESSAGE_STATES: readonly AgentMessageState[] = ['new', 'read', 'answered', 'needs_owner']
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
  // the sender's turn: the run it was sent in, stamped by the
  // SERVER from the turn token — never believed from the body
  run?: string
  // the tools from outside that turn used, re-stamped when it ended
  readOutside?: string[]
  // the root of the turn it was sent from: 'mission'
  // from a round or a think, or a turn of a mission-rooted task — a task made
  // of this message inherits it. Stamped by the SERVER from the turn token.
  root?: 'mission'
}

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
