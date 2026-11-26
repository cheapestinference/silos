// store/types.ts — the store's shared shapes (pages, tabs, turns, queue,
// terminal tabs). Re-exported from ../store.ts: import them from there.
import type { ConvPrefs } from '../lib/types'
import type { TaskOrigin, TasksQuery } from '../lib/routes'

// a tab in the terminal panel — `agentId` can be null (a terminal opened on
// a cwd free of any master agent) and is only used for ContextColumn's
// "Terminal · running" chip (filtered by the agent that was OPEN when it
// was created, not by whichever one is currently selected).
export interface TerminalTab {
  id: string
  agentId: string | null
  title: string
}

// a step in the activity tree: each chat-tool opens one; the previous one
// with no `end` closes when the next one opens (a sequential heuristic — v1
// doesn't model parallel steps). `desc` comes from the chat-tool's own
// `input` (best effort, can arrive empty) and the live refetch enriches it
// afterward by matching against the already-persisted toolUses.
export interface ActiveStep {
  name: string
  isSubagent: boolean
  desc: string | null
  start: number
  end: number | null
}

export interface ChatTurnState {
  turnId: string
  agentId: string
  text: string
  tools: string[]
  status: 'streaming' | 'done' | 'error'
  error?: string
  costUsd?: number | null
  userText: string // optimistic echo: what was sent, to paint the user bubble while it streams
  steered?: string[] // messages the owner sent INTO this running turn (POST …/chat answered steered): painted as their bubbles at once — the engine delivers them at its next step
  sessionKey?: string | null // `${folder}/${sessionId}` set on chat-init; null/undefined = a new chat, no session yet
  thinkingText?: string // accumulated chat-thinking for the turn in progress
  lastEvent?: 'init' | 'thinking' | 'delta' | 'tool' // the last chat-* event type applied, for the status UI
  startedAt?: number // Date.now() on send — for the StatusLine's elapsed time
  outputTokens?: number // the last chat-usage — accumulated as-is from the SDK, not a delta
  contextTokens?: number // the last chat-usage.contextTokens — doesn't always arrive, so an
  // event with no such field must NOT erase the previously stored value (see applyDelta)
  steps?: ActiveStep[] // the activity tree: one per chat-tool seen in this turn
  // present if this turn was sent in memory mode (see
  // store.memoryMode) — the path of the file being edited. finishTurn uses
  // it to tell AgentPage/MemoryDrawer (memorySaved) to reload if it has it open.
  memoryPath?: string
  // an honest echo: what the cascade REQUESTED on send for this turn vs.
  // what the SDK's init echoes back as the process's truth — CockpitChips
  // compares both and warns if they don't match (proof-of-life for configuration).
  requested?: { model?: string; permissionMode: string }
  echo?: { model?: string; permissionMode?: string }
}

// A receipt for a turn that finished IN THIS VIEW:
// "✻ Brewed for 1m 26s · ↓ 79.2k tokens" inline at the end of the turn,
// forever. Only REAL data from the turn we just ran (the turn's verb in
// past tense + measured elapsed + the last chat-usage) — never made up for
// historical turns (the CLI's own turns carry their own system/turn_duration,
// see Turn.tsx). `ts` anchors the receipt after the last persisted turn with
// a timestamp <= ts (lib/receipts.ts) — the same machine clock writes both,
// so the comparison is reliable in a local product.
export interface TurnReceipt {
  turnId: string
  verb: string // already in past tense (pastVerbForTurn)
  elapsedMs: number
  outputTokens?: number
  ts: number
  // present = the turn FAILED (chat-error, or chat-done's error subtype) —
  // the receipt then reads "Failed after X · <error>" instead of the verb.
  // The ErrorStrip toast auto-dismisses in 8s; this is the durable trace.
  error?: string
}

// a queued message freezes its DESTINATION (agent + session) at the moment
// it's queued, not when it drains: if the user navigates to another
// agent/session while the turn in progress finishes, the drain must still
// go to where it was written, never to whatever is currently selected
// (this avoids misdelivery between agents — the central "write to someone
// else while A is working" flow).

// contract v1→v2: a faceted filter for the navigation rail that will land
// later. There's no UI touching it yet; the store already carries the
// shape (with `selectFilter`, below) so that later phase doesn't have to
// migrate state — only mount UI on top of it.
export interface NavFilter {
  framework?: string[]
  agent?: string[]
  project?: string[]
  state?: string[]
  tool?: string[]
  skill?: string[]
  memory?: string[]
}
export interface NavState {
  filter: NavFilter
  groupBy: 'project' | 'agent' | 'state'
  preset: string
}
// the current page — replaces "a selected agent" for the navigation rail
// (which also navigates to a project or to settings). `null` is the cold
// start (nothing chosen yet); it's not part of the agent/project/settings
// contract, it's just this app's initial state.
// an automation's detail page — reached from the Automations dimension
// (clicking a row) or from the sidebar's ⏰. A header plate + Runs/Edit
// tabs, see AutomationsPage.tsx.
// 'automations' is every automation as one list (AutomationsListPage.tsx,
// /automations) — the rail's door. The Board that once hosted it as a tab
// is retired: its views landed on Home and
// /board is an alias to '/'. 'settings' carries an optional `tab` — one
// section of SettingsPage.tsx, grouped by what it IS (each
// thing has one house; a tab's id is its label in kebab-case, no aliases).
// 'vault' left this list: the Vault is its own page now ({kind:
// 'vault'}, /vault) — old /settings/vault links land there (routes.ts).
export type SettingsTab =
  'access' | 'appearance' | 'notifications' | 'accounts' | 'engines' | 'territory' | 'archived' | 'memories' | 'skills' | 'silos' | 'maintenance' | 'about'

export type UsagePeriod = 'today' | '7d' | '30d'
export type UsageView = 'agent' | 'task' | 'automation' | 'conversation' | 'account'

export type Page =
  | { kind: 'agent'; id: string }
  | { kind: 'project'; folder: string }
  | { kind: 'settings'; tab?: SettingsTab }
  // id 'new' is the automation editor creating one (/automation/new),
  // `agent` the agent it starts with (?agent=<id>) — see AutomationsPage.
  // `proposal`: /automation/new opened by a proposal's «Review ›» — the
  // editor starts from its input and its create resolves it
  | { kind: 'automation'; id: string; agent?: string; template?: string; proposal?: string }
  // agent: the list narrowed to one agent (the sidebar's per-agent
  // "⚡ N automations" row) — /automations?agent=<agentId>.
  | { kind: 'automations'; agent?: string }
  // Background — the GLOBAL background-work view: every recent
  // session's subagents in one page, reached from ⌘K («Background work»).
  // A full page. Once called «Tasks», until the name went to
  // plan tasks: two things must never be called Tasks.
  | { kind: 'background' }
  // Usage: what the fleet spent — /usage?period=&by=&agent=.
  // Reached from Home's plan line, an agent's Measured, the caps' «See
  // today ›», Automations' header and Settings; never the sidebar.
  | { kind: 'usage'; agent?: string; period?: UsagePeriod; by?: UsageView }
  // Tasks — every plan task in one view:
  // presets Mine · Active · Stalled · Done, layouts list · board · tree.
  // Reached from the sidebar's «Conversations | Tasks» switch and ⌘K; every
  // view is an address (lib/routes.ts TasksQuery), so a counter can open it.
  | ({ kind: 'tasks' } & TasksQuery)
  // one task's page: its plan's record key (the Plans silo's) + the task id
  // (/task/<plan key>/<task id>). Reached from a Tasks row, Home's Needs you
  // («open task»), the column's PlanView and a conversation's header.
  // `from`: the list it was opened from (back link, Esc, previous/next)
  | { kind: 'task'; plan: string; task: string; from?: TaskOrigin; give?: true }
  // the dependency Map: a full page — reached from Home's lens line and
  // from ⌘K. `view` picks its sibling views: absent = Uses, the usage
  // matrix of what agents, projects and conversations ACTUALLY used,
  // counted from their transcripts (UsesView.tsx); Org, who reports
  // to whom. The wiring graph of what the configuration declared is
  // retired, as the five-lane flow was before it.
  | { kind: 'map'; view?: 'org' }
  // Files mode: a file explorer in the sidebar + a viewer/editor in the main
  // area. `path` is the file currently open (none = the empty "pick a file" state);
  // `folder` roots the explorer at one folder (a project's «Browse the folder ›»).
  | { kind: 'files'; path?: string; folder?: string }
  // System's landing (Vitals): the machine told in Silos' terms —
  // disk by who eats it, memory with its gaps, the fleet by control, runs
  // and executions. The house's first tab: the rail's System door lands here; ⌘K too.
  | { kind: 'system' }
  // the Vault — the fleet's keyring, its own full page (its own view, out
  // of Settings). Reached from the rail's key and ⌘K.
  // sign: a task key whose binding ask the Vault opens prefilled
  | { kind: 'vault'; sign?: string; entry?: string; add?: string }
  // an installed silo's pages (the Silo Standard, Task 8): the `list`
  // archetype at /silo/<id>, and — with recordKey — one record's page
  // (/silo/<id>/r/<key>). Reached from ⌘K, Home's silo rows, and the rail
  // only when the manifest's `rail` slot was granted.
  // review: the install dialog of the silo's pending submission (/silo/<id>/review)
  // view: one of its list views (descriptor.lists) when not the first
  | { kind: 'silo'; id: string; recordKey?: string; review?: boolean; view?: string }
  | null
// 'chat' isn't a tab — a conversation is no longer just another tab among
// others, it IS the page itself (see AgentPage.tsx: ConversationView vs.
// AgentDossier). `Tab` names the agent page's facet — its tab, carried in
// the URL. Since navigation C nothing covers a
// conversation: an agent facet opened from one navigates to the agent page
// (openDossier). 'context' isn't one of them: the context column is its own
// mechanism (contextOpen/toggleContext). The page's landing tab is 'threads'.
export type Tab = 'identity' | 'memory' | 'vault' | 'threads' | 'control' | 'skills' | 'context' | 'mission' | 'loaded' | 'tools' | 'inbox'
// ProjectPage's tabs — the agent page's nouns in its order:
// Now · Memory · Files · Skills · Tools · Map. Now is the Home scoped to
// the folder; the others are what the FOLDER owns, switched there and only
// there. The id is the tab's name, and the landing ('now') is omitted from
// the URL.
export type ProjectTab = 'now' | 'memory' | 'files' | 'skills' | 'tools' | 'map'
// the Files tab's two parts — the same on the agent page and the project
// page, each an address (…/files/artifacts): a reload keeps it
export type FilesPart = 'files' | 'artifacts'

export interface QueueItem {
  text: string
  agentId: string
  session: { folder: string; id: string } | null
  // master's new-chat cwd, captured WHEN QUEUED (the same criterion as
  // `session`) — present only if the queued message opens a new master
  // chat with a project already chosen.
  cwd?: string
  // see ChatTurnState.memoryPath — survives the trip through the queue.
  memoryPath?: string
  // turn-level overrides captured WHEN QUEUED (the same criterion as
  // `session` — the one-shot was already consumed from the composer when it was pushed).
  overrides?: ConvPrefs
  // a snapshot of the destination conversation's prefs when queued — `requested`
  // (the honest echo) must be computed from these, never from whichever
  // conversation happens to be open when the drain fires.
  convPrefs?: ConvPrefs
  // naming at birth, captured WHEN QUEUED (the same criterion as `session`)
  // — present only if the queued message opens a new chat the owner named.
  title?: string
}
