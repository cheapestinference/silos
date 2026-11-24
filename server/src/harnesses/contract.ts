// harnesses/contract.ts — what Silos needs from an agent harness (Claude Code,
// OpenCode): read its sessions, launch its console, say what it can do.
// Types only plus one pure helper (isFileBacked); the lookups live in the
// leaf registry.ts and the engines register in index.ts.

import type { Agent, DiskSubagent, SessionContext, SessionMeta, TranscriptTurn } from '../types.js'
import type { FenceOverlay } from '../territory.js'
import type { ProvidersStore, ResolvedProvider } from '../providers-store.js'
import type { PermissionConfig } from './fence-rules.js'
import type { EngineCompat, OtherHarnessStatus, RunFn } from '../harness-run.js'
import type { ChatEvent } from '../chat-types.js'
import type { ChatDeps, ChatSendInput } from '../chat-service.js'
import type { FallbackState } from '../fallback.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { AsksStore } from '../asks-store.js'
import type { SessionIndex } from '../session-index.js'
import type { TerminalService } from '../terminal-service.js'
import type { BirthsStore } from '../births-store.js'
import type { NativeStore } from '../native-store.js'
import type { ConversationPrefsStore } from '../conversation-prefs.js'
import type { CatalogView, FetchModels } from '../model-catalog.js'
import type { ConsoleRecord } from '../terminal-service.js'
import type { PrefsStore } from '../prefs-store.js'
import type { CockpitOverrides } from '../cockpit.js'
import type { ServerDeps } from '../server.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/** Open: the registry decides which ids are known, so adding an engine edits no union. */
export type HarnessId = string

/** A session addressed across harnesses: the harness plus its own folder/id. */
export interface SessionRef {
  harness: HarnessId
  folder: string
  id: string
}

/** What a harness can do — the UI hides what a harness lacks, never fakes it. */
export interface HarnessCaps {
  compaction: boolean
  subagents: boolean
  skills: boolean
  thinking: boolean
  costFromHarness: boolean
  permissionsAsEvents: boolean
  sendToConsole: boolean
  /** The cockpit's outputStyle field (a per-agent / per-conversation voice):
   *  true only for an engine that declares `outputStyles` and honours the
   *  style on both its chat turn and its console. */
  outputStyles: boolean
}

/** One output style an engine offers — `id` is the exact value it takes. */
export interface OutputStyleInfo {
  id: string
  description: string
  source: 'built-in' | 'user' | 'project'
}

export interface HarnessReader {
  readonly harness: HarnessId
  ownsId(id: string): boolean
  /** From in-memory state after init(). Never mutated by the caller. */
  list(): SessionMeta[]
  /** A number that changes whenever list() would answer differently. With
   *  it, the index keeps the reader's rows between changes (allSessions()
   *  and metaById() are O(1) reads); without it, list() is called on every
   *  allSessions(). */
  revision?(): number
  init(): Promise<void>
  getMeta(folder: string, id: string): SessionMeta | null
  getContext(folder: string, id: string): SessionContext | null
  readTurns(folder: string, id: string): Promise<TranscriptTurn[]>
  refresh(folder: string, id: string): Promise<SessionMeta | null>
  /** The sessions this engine places in each of `dirs` — linked worktrees
   *  of the main checkout `project`: a conversation that entered one (the
   *  engine keeps its transcript there), a child session spawned into one,
   *  counted for the session that spawned it. `sinceMs`: nothing older can
   *  have made these worktrees (a reader may skip what has not moved since).
   *  Absent: this engine places none (the kernel kind `worktree` then
   *  attributes by working directory alone). */
  worktreeSessions?(project: string, dirs: readonly string[], sinceMs: number): Promise<Map<string, string[]>>
  /** Hide (Silos-side), never delete. false = the id was not known: the
   *  index emits no 'removed'. void (OpenCode) = always emits. */
  remove(folder: string, id: string): boolean | void
  watch(onChange: (ref: SessionRef, kind: 'created' | 'updated' | 'removed') => void): () => void
  /** Known by id (getMeta answers) but not a conversation. The reader's own
   *  list() must exclude hidden ids — the index does not filter them; the
   *  index only skips the 'session' emit on refresh() (which still returns the meta). */
  hidden?(folder: string, id: string): boolean
  /** Every tool call of a session AND of its child sessions (the engine's
   *  subagents), in the engine-neutral shape the unattended-turn audit reads
   *  (heartbeat-audit.ts). Read-only. null = the
   *  session is unknown here. Absent = this engine can't say: its turns are
   *  audited as unreadable, never as clean. */
  toolCalls?(folder: string, id: string): Promise<SessionToolCalls | null>
  /** What a conversation used (Usage): its assistant
   *  records AND its child sessions' (the engine's subagents), each with
   *  when, which model, its tokens and its price by the engine's own table —
   *  one record per message id within each file. Read-only. null = the
   *  session is unknown here. Absent = this engine can't say: Usage shows
   *  «not measured on <engine>», never another engine's numbers. */
  usageRecords?(folder: string, id: string): Promise<UsageRecord[] | null>
  /** What Silos itself used through this engine outside any conversation
   *  (the titler), records since `sinceMs` — Usage's «Silos itself» row.
   *  Absent = nothing of Silos' own runs on this engine. */
  silosOwnUsage?(sinceMs: number): Promise<UsageRecord[]>
  /** The reader's own readiness, when it differs from "init() resolved". */
  isReady?(): boolean
  flush?(): Promise<void>
  stop?(): void
}

/** One tool call as the audit reads it — the engine says what the call IS
 *  (its own tool names and input shapes stay inside its adapter). */
export interface ToolCallRecord {
  /** The tool's name as the engine called it (shown in `readOutside`). */
  name: string
  /** The session it ran in: the conversation itself or one of its children. */
  session: string
  /** When it was called (ms since epoch), when the engine records it. */
  at?: number
  /** A shell call: its command line. */
  command?: string
  /** The files this call writes, as the tool named them (absolute or relative to the session's folder). */
  writes?: string[]
  /** It reads from outside the machine by its very nature: a web tool, or a
   *  tool of an MCP server (`mcp`: the label is then `mcp__…`, both engines). */
  outside?: 'web' | 'mcp'
}

/** One assistant reply as Usage reads it (HarnessReader.usageRecords). The
 *  price travels here so neutral code never names an engine's price table. */
export interface UsageRecord {
  /** the engine's message id: one bill, however many lines repeat it */
  id: string
  /** when it was written (ms since epoch) */
  at: number
  model: string
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
  /** USD at the engine's list prices; null = a model without a price row */
  costUsd: number | null
  /** the session that wrote it: the conversation itself or one of its children */
  session: string
}

/** HarnessReader.toolCalls' answer. */
export interface SessionToolCalls {
  calls: ToolCallRecord[]
  /** Ids of the child sessions (subagents) whose calls are included. */
  children: string[]
}

/** A reader whose sessions are files on disk (Claude Code). */
export interface FileBackedReader extends HarnessReader {
  readonly root: string
  transcriptPath(folder: string, id: string): string
  sessionDir(folder: string, id: string): string
  listSubagents(folder: string, id: string): Promise<DiskSubagent[]>
}

export function isFileBacked(r: HarnessReader): r is FileBackedReader {
  const f = r as Partial<FileBackedReader>
  return typeof f.root === 'string' && typeof f.transcriptPath === 'function' && typeof f.sessionDir === 'function' && typeof f.listSubagents === 'function'
}

export interface LaunchSpec {
  agent: Agent
  cwd: string
  key: string
  resumeId?: string
  theme?: 'light' | 'dark'
  permissionMode?: string
  append?: string
  fence: FenceOverlay | null
  provider: ResolvedProvider | null
  env: Record<string, string>
  /** Fixed TUI port, for harnesses whose console is a server (OpenCode). */
  port?: number
  /** The model the console must open on, in the harness's own id form
   *  (`provider/model` for OpenCode). A resumed OpenCode session keeps the
   *  model it last used unless told otherwise — the pin travels as `--model`. */
  model?: string
  /** The cockpit's output style (caps.outputStyles engines only). */
  outputStyle?: string
  /** What Silos keeps for this launch's places (spec scopes §6) — the
   *  agent's payload, then (T5) its conversation's: each the engine's own
   *  shape, validated by the engine against its allowlist before it rides
   *  the launch's flag-tier settings, beside the fence. Empty or absent:
   *  the launch is what it was. */
  carried?: unknown[]
  /** The role's own skills plugin (`agent-state/<id>/plugin`, role-plugin.ts),
   *  present only when the role HAS skills. Each adapter passes it in its own
   *  dialect: Claude Code `--plugin-dir` / SDK `plugins: local`; OpenCode
   *  appends `<dir>/skills` to its config's `skills.paths`. */
  rolePlugin?: string
  /** The cockpit's permission mode as argv in the harness's own dialect —
   *  for OpenCode auto-mode.ts modeArgs (`--auto`, `--agent plan`); the
   *  fence's denies still hold. Placed before `--session`. */
  modeArgs?: string[]
}

export interface HarnessConsole {
  idDiscovery: 'silos-chosen' | 'reported-by-plugin'
  /** The id a new console of this engine is born with ('silos-chosen'
   *  only; console-open.ts genericOpenNew). It must satisfy the harness's
   *  own ownsId, or the session would route to the fallback. Default:
   *  randomUUID() (the fallback's form). */
  newSessionId?(): string
  command(spec: LaunchSpec): string[]
  env(spec: LaunchSpec): Record<string, string>
  /** Is the engine's TUI showing a dialog on this screen (tmux capture-pane)?
   *  Read before Silos types a prompt + Enter into the console (terminal-
   *  service consoleSendLiteral): the Enter would pick the highlighted
   *  option. CONSERVATIVE: only the engine's own known markers say a dialog;
   *  an unknown or empty screen is null — a missed dialog is the old
   *  behaviour, a false one would block every send. Absent = never blocks
   *  (an engine that takes prompts over its own API, not keys). */
  dialogOnScreen?(screen: string): ConsoleDialog | null
}

/** What kind of dialog a console shows (HarnessConsole.dialogOnScreen). */
export type ConsoleDialog = 'trust' | 'permission' | 'question' | 'plan'

export interface Harness {
  readonly id: HarnessId
  readonly label: string
  readonly caps: HarnessCaps
  console: HarnessConsole
  /** Exactly one registered harness is the fallback (Claude Code): it owns every id
   *  no other harness claims, its reader is the SessionIndex's fallback, and an agent
   *  with no `framework` runs on it. Every other harness declares ownsId. */
  readonly fallback?: true
  ownsId?(id: string): boolean
  readonly traits: HarnessTraits
  readonly providers: HarnessProviderRules
  readonly ui: HarnessUiFacts
  /** caps.outputStyles: the styles a conversation in `cwd` (null = no
   *  folder) can answer in — read-only, from the engine's own places. */
  outputStyles?(cwd: string | null): OutputStyleInfo[]
  /** Model catalogue cache, relative to dataDir, and the source's name in logs/errors. */
  readonly models?: { file: string; label: string }
  /** Silos' deny rules in the permission dialect this engine enforces (Settings › Territory). */
  fencePermission(fence: FenceOverlay, opts: { worktree: string; home: string }): PermissionConfig
  /** Its binary: the command Silos looks up on PATH (a path when the
   *  operator overrode it) and the directories this engine's OWN documented
   *  installer puts it in under the operator's `home`. Silos appends the one
   *  that holds the command to its PATH when PATH does not find it
   *  (engine-path.ts) — an installed engine is found however Silos was
   *  started. Absent = looked up on PATH only. */
  readonly binary?: { command(): string; installDirs(home: string): string[] }
  /** Absolute paths of files holding this engine's own login secrets under
   *  the operator's `home` (or the engine's own env overrides). EVERY
   *  agent's fence denies them read and edit, whatever engine the agent
   *  runs on — a fenced agent must not read another engine's credentials
   *  either (territory.ts consumes the union of all registered engines).
   *  Absent = nothing beyond what fenceFor already denies itself. */
  secretFiles?(home: string): string[]
  /** Absolute paths (or globs) of the files this engine LOADS executable
   *  behaviour from for a conversation in `folder` — MCP servers, its own
   *  config — that no fenced agent may write (the twin of
   *  secretFiles). EVERY agent's fence denies Edit on the union of
   *  all registered engines, once per territory. Absent = nothing beyond
   *  what fenceFor already denies itself. */
  configFiles?(folder: string, home: string): string[]
  /** The hosts this engine itself calls, as ITS OWN docs publish them for
   *  corporate proxies — never guessed. An agent on
   *  egress `allowlist` always has the non-optional ones pinned in its
   *  allowlist («the engine's own»); `optional` ones (telemetry, extras)
   *  are listed for the owner to add. Patterns: an exact host, `*.domain`
   *  (any subdomain) or `*-suffix` (a prefix inside the first label).
   *  Absent = nothing pinned: an allowlisted agent on it reaches only its
   *  owner-given hosts. */
  readonly engineHosts?: EngineHosts
  /** traits.consolePinsModel: the conversation pin a model picked inside the
   *  console stands for — `meta.requestedModel` read in this engine's own
   *  model-id dialect (pin-follower.ts). null = nothing to pin (an id it
   *  cannot read, a key Silos no longer has). Required with consolePinsModel
   *  (conformance checks it). */
  requestedModelPin?(ref: string, providers: Pick<ProvidersStore, 'list' | 'get'>): ConsolePin | null
  /** Its runtime parts, built once by compose.ts bootHarnesses (production
   *  and tests), in registration order. */
  boot?(ctx: HarnessBootContext): HarnessRuntime
  /** Its chat engine (ChatService builds one per harness). null = none wired:
   *  an agent on this harness has its turn refused. */
  headless?(ctx: HeadlessContext): HeadlessEngine | null
  /** Its rows in GET /api/harness and its updater (harness.ts HarnessService). */
  versions?(ctx: VersionsContext): HarnessVersions
  /** Its branches of the server's routes (server.ts builds them once per
   *  harness, on first use). Every member is optional; the neutral default
   *  is stated on each. */
  server?(ctx: ServerHookContext): HarnessServerHooks
  /** What every session of an agent on this engine receives before its first
   *  message, read from disk (Knows & can › Loaded at start). Never executes
   *  anything and never writes. Absent = the engine can't say: the row is
   *  hidden, never filled with another engine's data. */
  loadedAtStart?(input: LoadedAtStartInput): LoadedAtStart
  /** What ONE conversation started with and carries now, measured from its
   *  own transcript: a fresh feed the caller hands the transcript's lines in
   *  file order, in any slicing (all at once, or what was appended since its
   *  last read — the caller reads the file, sliced, jsonl-lines.ts). Pure:
   *  reads nothing, writes nothing. Absent = the engine records no such
   *  thing: the column shows the first turn's usage only. */
  startedWith?(): StartedWithFeed
  /** Everything a conversation in a folder loads at start, ONE row per
   *  thing, with where it comes from and whether this project loads it
   *  (GET /api/folders/:folder/loads — Project › Tools, Agent › Tools).
   *  Read-only: never executes, never writes. Absent = the engine can't
   *  say: no rows, never another engine's. */
  readonly loads?: HarnessLoads
  /** Your personal instructions (the engine's user-level instruction
   *  files) switched off for ONE folder — Project › Memory, the switch on
   *  the «Your machine» row (GET/POST /api/folders/:folder/personal).
   *  Absent = the engine has no such switch: the row stays a fact. */
  readonly personal?: HarnessPersonal
  /** Every instruction file a conversation in a folder loads — the ONE
   *  inventory Memory draws (spec memory-places T2) and the ONE list a
   *  memory write is judged against (T3): a write is allowed only on a row
   *  this lists as editable, or a new file at one of its `places`. Reads
   *  files and transcripts, never writes. Absent = the engine lists none:
   *  Memory shows no instruction rows for it, never another engine's. */
  readonly instructions?: HarnessInstructions
}

/** Where an instruction file comes from (spec memory-places §3: the head). */
export type InstructionOrigin = 'organization' | 'machine' | 'above' | 'project' | 'private' | 'auto' | 'agent'

/** What kind of instruction file a row is (§2's rows). */
export type InstructionKind =
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
  /** the agent's own memory — Silos', never an engine's (memory-service.ts adds it) */
  | 'agent'

/** The kinds of start Silos launches — which ones read a file is its reach.
 *  `run-inherits`: an automation run set to inherit hooks; `run-no-folder`:
 *  a run of an agent without a folder. */
export type InstructionLaunch = 'console' | 'chat' | 'wake' | 'run' | 'run-inherits' | 'run-no-folder'

/** Whom a row reaches by default — data; the web says it in §3's words. */
export interface InstructionReach {
  /** organization: every conversation here · machine: every project on this
   *  machine · under: every project under `under` · project: every agent of
   *  the folder · agent: only that agent */
  scope: 'organization' | 'machine' | 'under' | 'project' | 'agent'
  /** scope `under`: the folder above (absolute) */
  under?: string
  /** the starts that read it (by the sources each launch reads) */
  launches: InstructionLaunch[]
  /** a rule's `paths:` — it loads when a matching file is read */
  paths?: string
  /** login config dirs that do NOT load this file: a login that keeps its
   *  own (e.g. a rules folder of its own, not the machine's) */
  notOn?: string[]
}

/** When a row loads: at start, or on demand (a subfolder's file, a rule
 *  with `paths:`, an auto-memory note). */
export interface InstructionWhen {
  at: 'start' | 'on-demand'
  /** a subfolder's file: the subfolder, relative to the folder, with '/' */
  under?: string
}

/** What a row weighs: as the newest start that named it loaded it
 *  (characters of its recorded content), else on disk (bytes). tokens ≈
 *  chars / 4, the engine's own estimate. */
export interface InstructionWeight {
  chars: number
  tokens: number
  as: 'loaded' | 'disk'
  /** as loaded: when that record was written (ISO) */
  at?: string
}

/** One instruction file. `path` as the engine names it; `real` with links
 *  resolved — rows are matched, and writes judged, by `real`. */
export interface InstructionRow {
  path: string
  real: string
  /** shown name: folder-relative, ~-relative, or absolute */
  rel: string
  origin: InstructionOrigin
  kind: InstructionKind
  /** the engine's own type for it, when it has one (User · Project · Local · Managed · AutoMem) */
  engineType: string | null
  reach: InstructionReach
  when: InstructionWhen
  weight: InstructionWeight
  bytes: number
  mtime: number
  /** Silos may write it (T3) — false: `readOnly` says why */
  editable: boolean
  readOnly?: string
  /** a write needs the owner's explicit confirm (`confirmed: true`): the machine's files */
  confirm?: true
  /** an import: the file that names it (shown name) */
  importedBy?: string
  /** a folder's AGENTS.md: loaded through a CLAUDE.md's import, or alone (in place of one) */
  through?: 'import' | 'alone'
  /** auto memory moved by a settings key: the file that moved it */
  movedBy?: string
  /** auto memory: a note the index links */
  inIndex?: boolean
  /** listed because a conversation's record names it, not by the scan */
  fromRecord?: true
  /** a link that leads out of its root (the folder, the login dir, the
   *  memory dir): never written, and never opened through Memory */
  linkOut?: true
}

/** A fixed place a NEW instruction file may be created at (T3): a file, or
 *  a directory taking one plain `<name>.md`. */
export interface InstructionPlace {
  path: string
  shape: 'file' | 'dir'
  origin: InstructionOrigin
  kind: InstructionKind
  reach: InstructionReach
  confirm?: true
  /** shape file: it exists already (then it is a row; a write edits it) */
  exists?: boolean
  /** the ignore line a create may add, only when the request says so —
   *  present only where `<folder>/.git` is a directory */
  ignoreLine?: { file: string; line: string }
  /** no ignore line can be written here (the folder's git is elsewhere): said */
  ignoreElsewhere?: true
}

export interface InstructionsInput {
  /** the folder conversations start in; null = the machine's files only */
  folder: string | null
  home: string
  /** every login's own config dir, the machine's own first */
  loginDirs: string[]
  /** where the engine keeps each folder's conversations (auto memory beside them) */
  projectsRoot: string
  managedDir?: string
  /** the folder's newest conversations' transcripts, newest first (file-backed readers) */
  transcripts: string[]
}

export interface InstructionsList {
  engine: string
  folder: string | null
  rows: InstructionRow[]
  places: InstructionPlace[]
  /** one-liners: caps reached, what is not listed and why */
  notes: string[]
  /** the folder's own engine-config dir is a login's: only its top file is Silos' */
  homeFolder?: true
}

/** Harness.instructions: the list, and one listed file's text. */
export interface HarnessInstructions {
  list(input: InstructionsInput): Promise<InstructionsList>
  /** a LISTED file's text — throws `not listed` for any other path */
  read(input: InstructionsInput, path: string): Promise<{ row: InstructionRow; content: string }>
  /** «Where it loads» for each of `rows` (the engine's own list for the
   *  folder, spec memory-places §4, T4): one answer per row, its lines
   *  broadest first, or why it has none. Pure — reads settings files,
   *  writes nothing. Absent: no row has places. */
  places?(input: InstructionPlacesInput, rows: readonly InstructionRow[]): InstructionPlacesRow[]
  /** One listed row switched at one place: a FILE place (`project`, the
   *  folder's local settings; `machine`, the user's settings — only where
   *  the row's line has a switch) the engine writes itself; a LAUNCH place
   *  (`agent`, `conversation`) is handed the payload Silos keeps and
   *  returns the new one, writing nothing. Throws LoadsSwitchError: 404 a
   *  path the rows do not list, 409 a line that is locked, a fact, or has
   *  no switch (saying why). */
  switch?(input: InstructionPlacesInput, rows: readonly InstructionRow[], path: string, to: 'on' | 'off', at?: LoadsSwitchAt): LoadsCarriedSwitch | void
  /** What one conversation loaded, read from its own transcripts (oldest
   *  first: a later session that starts over is the one in force). A
   *  conversation with no record reads as nothing in force — a start
   *  writes none when nothing loads, or when nothing changed (then the
   *  earlier record stays in force). Absent: no proof for instruction files. */
  reading?(transcripts: readonly string[]): Promise<InstructionsThreadReading>
}

/** What ONE conversation's own record says it loaded (spec memory-places
 *  §6), read by the engine from its transcripts: the proof's evidence. */
export interface InstructionsThreadReading {
  /** real paths in force after its newest start, by the engine's replay */
  inForce: string[]
  /** on-demand loads since the last base: real path, ms */
  nested: { path: string; at: number }[]
  /** the starts the record itself shows (a start marker followed by a reply), ms */
  starts: number[]
}

export interface InstructionPlacesInput extends InstructionsInput {
  /** the launch places' payloads Silos keeps (the folder's agents'; one
   *  conversation's when its column asks) */
  carried?: LoadsCarried
}

/** One row's places (HarnessInstructions.places). */
export interface InstructionPlacesRow {
  path: string
  /** the row key a launch place's entry is timed by (loads-scopes.ts `at`) */
  key: string
  /** off-only (a file: «off» at any place that reaches it is off) ·
   *  override (auto memory: the narrowest place with an entry decides) */
  family: 'off-only' | 'override'
  at: LoadsLine[]
  /** a row with no switch at a place, or none at all: why, in the engine's words */
  inert?: string
}

/** Harness.personal: the state of the folder's switch and the switch. */
export interface HarnessPersonal {
  state(input: PersonalInput): PersonalState
  /** for NEW conversations in the folder; idempotent. Refuses with
   *  LoadsSwitchError 409 saying what decides (a home folder, a file it
   *  can't read, another settings file that already keeps them out).
   *  `at` a LAUNCH place (spec scopes T10: `agent`, `conversation`): handed
   *  the payload Silos keeps there, it returns the new one and writes
   *  NOTHING — the payload keeps the choice, the engine turns it into its
   *  own entries at each launch, for every login known then. */
  switch(input: PersonalInput, to: 'on' | 'off', at?: LoadsSwitchAt): LoadsCarriedSwitch | void
  /** «Where it loads» (spec scopes §4, T10): one line per place and per
   *  fact, broadest first — `input.carried` names the agents' and, asked,
   *  one conversation's payloads. Pure. Absent = no places: the folder's
   *  switch alone. */
  places?(input: PersonalInput): LoadsLine[]
}

export interface PersonalInput {
  folder: string
  home: string
  /** every login's own directory on this machine (the engine's config dir
   *  each conversation reads its personal files from); absent: the
   *  machine's own only */
  loginDirs?: string[]
  managedDir?: string
  /** the launch places' payloads Silos keeps (the folder's agents'; one
   *  conversation's when its column asks) — for `places` and a launch switch */
  carried?: LoadsCarried
}

export interface PersonalState {
  /** on: they load here · off: kept out for every login · partly: for some
   *  logins only (another click keeps them out for all) */
  state: 'on' | 'off' | 'partly'
  /** the exact entries the switch writes — what a later reading is matched
   *  against (rule 7: a reading that still lists one marks the row) */
  entries: string[]
  /** how many logins the entries cover */
  logins: number
  /** a login has personal rules beside its instruction file */
  rules: boolean
  /** no switch: why (the writer's refusal) */
  refused?: string
  /** another settings file already keeps them out: a fact naming it */
  decidedBy?: { file: string; key: string }
}

/** Harness.loads: the inventory, and what the engine adds to it — its
 *  switches, its status readings, its check. Only `inventory` is required:
 *  an engine with nothing else (OpenCode) lists its rows, each naming the
 *  file that decides it, and its Tools says in one line why there is no
 *  switch and no health (folder-loads.ts `engines`). */
export interface HarnessLoads {
  inventory(input: LoadsInput): LoadsInventory
  /** The places a choice about loading a thing can be kept at, broadest
   *  first, in this engine's own order (spec scopes §2, §9): each with its
   *  carrier — a FILE the engine reads itself, the LAUNCH (Silos keeps the
   *  choice and hands it to every process it starts), or a DOOR (changed
   *  outside Silos, never written). Declared: its rows carry `at`, one line
   *  per place. Absent: the engine keeps today's single project switch and
   *  its rows carry no `at` (folder-loads strips one). */
  readonly scopes?: readonly LoadsScope[]
  /** Turns the row `key` on or off for new conversations in `input.folder`
   *  — the one writer of the engine's per-folder file (POST …/loads/switch).
   *  Idempotent. Refuses with LoadsSwitchError: 404 no such row, 409 the
   *  row has no switch (and the error says what decides). Absent = the
   *  engine switches nothing: its rows name their file.
   *
   *  With `at` (spec scopes §6, §9): a FILE place the engine writes itself
   *  — `machine`, the user's own settings, only on the owner's click that
   *  names it; `project`, today's — refused 409 where its line has no
   *  switch (the line's `locked` / `refused`, said); or a LAUNCH place of
   *  `scopes`: the row on or off for that place, from the payload Silos
   *  keeps for it, which the engine is handed and validates against its own
   *  allowlist; it returns the new payload and writes NOTHING — neutral
   *  code keeps it. 404 a row or an agent line it has not; 409 a line that
   *  can't take it (the error says why: a wider place keeps an off-only
   *  thing off, the organization decides, no exact name). */
  switch?(input: LoadsInput, key: string, to: 'on' | 'off', at?: LoadsSwitchAt): LoadsCarriedSwitch | void
  /** An origin's head (LoadsInventory.origins) for new conversations in
   *  `input.folder`: «off» writes only the origin's key, «on» removes only
   *  it — whatever that origin sends then loads here (POST …/loads/switch
   *  with `origin`). Idempotent. LoadsSwitchError 409 what decides instead
   *  (another file, a home folder, an engine too old). Absent = no head.
   *
   *  With `at` (spec scopes §3, T8), the head at one place, only its key:
   *  `project` — today's; `machine` — the user's own settings, its «off»
   *  refused (409) unless `at.confirmed`; `agent` — the payload Silos
   *  keeps, returned and never written (as `switch`'s). A head a wider
   *  place keeps off can't be turned on below it (409, saying where). */
  switchOrigin?(input: LoadsInput, origin: LoadsOriginId, to: 'on' | 'off', at?: LoadsSwitchAt): LoadsCarriedSwitch | void
  /** All / nothing (spec scopes §4, T11): every row of `set.keys` and every
   *  head of `set.origins` to `to` at ONE place (`at`, as `switch`'s), in
   *  ONE write — a file place's file written once, a launch place's payload
   *  answered once and never written. Each item changes as its own switch
   *  would; an item its switch refuses refuses the whole click (409) and
   *  nothing is written. Absent: no bulk click on this engine's rows. */
  switchMany?(input: LoadsInput, set: LoadsBulkSet, to: 'on' | 'off', at?: LoadsSwitchAt): LoadsBulkSwitch | void
  /** What an account origin's head is for this whole MACHINE, outside any
   *  folder (spec scopes §3, §5 — Settings' «New projects» lines): per
   *  origin, its account door, the organization's say and the machine
   *  line, with the sentence that line says before its «off». Absent: no
   *  machine head. */
  machineHeads?(input: LoadsMachineInput): LoadsMachineHead[]
  /** One origin's head on or off for this whole machine (the user's own
   *  settings), outside any folder — the same writer as a folder's
   *  machine line. Its «off» is refused (409) unless `confirmed`: what the
   *  account sends stops reaching every login Silos connects. */
  switchMachineHead?(input: LoadsMachineInput, origin: LoadsOriginId, to: 'on' | 'off', confirmed: boolean): void
  /** When the engine's per-folder switch file last changed (ms), null when
   *  there is none — what a reading must be newer than to prove a switch
   *  (switch-proof.ts). Absent = no proof is read for its rows. */
  switchesChangedAt?(folder: string): number | null
  /** When the machine's own settings file (the `machine` place's) last
   *  changed (ms), null when there is none — what a reading must be newer
   *  than to prove a machine entry. Absent = no machine proof. */
  machineChangedAt?(home: string): number | null
  /** its turns read their servers' status (ChatTurnHooks.onToolStatus):
   *  a row with no reading says «not read yet»; absent = no health at all */
  readonly readsStatus?: true
  /** «Check now» (the owner's click, never by itself): start the engine in
   *  the folder on one login with the given agents' own tools, send NO
   *  prompt, read its servers' status, close it — bounded. `withoutLocal`
   *  («See what it sends»): without the folder's local layer, so what the
   *  login sends is fetched; nothing is written to the folder. Absent = the
   *  engine has no check (no button). */
  check?(input: LoadsCheckInput, deps: Pick<ChatDeps, 'queryFn'>): Promise<LoadsCheckReading>
  /** the check's cost, in the words said beside its button */
  readonly checkCost?: string
  /** The skills the engine's Claude account origin sends to the folder
   *  (per login), the folder's per-skill positions and whether that origin
   *  loads here — what the skills catalog (complete-service.ts) lists as
   *  account rows and the three-position control on account and personal
   *  skills (Project › Skills). Read-only. Absent = the engine has none. */
  skills?(input: LoadsSkillsInput): LoadsSkills
  /** One skill to a position (`on` · `name-only` · `off`), or the account
   *  origin on/off, for new conversations in the folder — through the
   *  engine's one writer. Idempotent. LoadsSwitchError: 404 an unknown
   *  name, 409 what decides instead. Absent = nothing switches.
   *
   *  With `at` (spec scopes §3, T9) as `switch`'s: `machine` the user's own
   *  settings, on the owner's click that names it; a LAUNCH place (an
   *  agent) — handed the payload Silos keeps, it returns the new one and
   *  writes NOTHING. An entry is written only where the place differs from
   *  what it follows; a line the engine locks is refused, nothing tried. */
  skillSwitch?(input: LoadsSkillsInput, target: LoadsSkillTarget, to: string, at?: LoadsSwitchAt): LoadsCarriedSwitch | void
  /** «Where it loads» for each skill asked (spec scopes §3, §4, T9): one
   *  line per place and per fact, each with its position as found, what
   *  loads there, the positions a click may pick and which copies of a
   *  shared name its entry reaches. Pure. Absent = skills have no places. */
  skillPlaces?(input: LoadsSkillsInput, asks: readonly LoadsSkillAsk[]): LoadsSkillPlaces[]
  /** All / nothing for skills (spec scopes §4): every item at ONE place
   *  (`at`, as `skillSwitch`'s) in ONE write — a file place's file written
   *  once, a launch place's payload answered once and never written. An
   *  item with `to` changes as its own switch would; one with `entry` puts
   *  that exact entry back (null: none) — the undo. One item refused
   *  refuses the whole click (409), nothing written. A launch place's
   *  answer names each item it changed by its skill's name. Absent: no
   *  bulk click on skills. */
  skillSwitchMany?(input: LoadsSkillsInput, items: readonly LoadsSkillBulkItem[], at?: LoadsSwitchAt): LoadsBulkSwitch | void
  /** whether a conversation in the folder on this login fetches what the
   *  login's account sends (its connectors) — false where it is off, and
   *  for a login with no account: «See what it sends» is offered only on a
   *  login that has one (`account`) with it off here */
  sends?(input: { folder: string; home: string; provider: ResolvedProvider | null; managedDir?: string }): { account: boolean; here: boolean }
  /** A plugin row this project does not load, opened: the engine's own
   *  estimate of the tokens it would add to every start — ONE figure, never
   *  a count (counts come from the plugin's manifest, `carries`). null when
   *  it can't say: an engine version the reading was not confirmed on, an
   *  output it cannot read, the bound. Bounded, one at a time, kept per
   *  plugin version; the owner's opening only (POST …/loads/projected).
   *  Absent = no estimate: the row shows none. */
  projected?(input: LoadsProjectedInput): Promise<number | null>
  /** whose estimate, said after the figure («Claude Code’s estimate») */
  readonly projectedBy?: string
  /** The starting set (spec tools-origin §8): the classes of what a NEW
   *  project of this engine loads that Silos sets once, at its birth — the
   *  folder's first agent of this engine (server/src/starting-set.ts, the
   *  one seam). Absent = no class: nothing is set at a birth, no line in
   *  the New agent form. */
  readonly startingSet?: HarnessStartingSet
}

/** One class of the starting set: what it is, where it comes from, and
 *  Silos' recommendation (by origin: what the user set up is always on;
 *  what an account sends may be off). */
export interface StartingSetClass {
  /** stable id — the key of `startingSet.<engine>.<id>` in ~/.silos/settings.json */
  readonly id: string
  /** what it is, as the form lists it: «plugins» */
  readonly what: string
  /** where it comes from: «your Claude account» */
  readonly from: string
  /** Silos' recommendation: loaded in a new project, or not */
  readonly recommended: boolean
  /** what of the inventory it covers — the account's rows of that kind
   *  (`plugin`, `connector`) or the account's skills (`skill`): what the
   *  first run names under it, and the project tab it is switched in */
  readonly covers: 'plugin' | 'connector' | 'skill'
  /** the account origin whose head is this class's key (machineHeads) —
   *  a class the machine keeps off says so on its line */
  readonly origin?: LoadsOriginId
}

export interface HarnessStartingSet {
  readonly classes: readonly StartingSetClass[]
  /** Writes, for each class `set` turns off, its key in the folder's own
   *  file — only where that file does not already set the key (a choice
   *  on disk wins). Returns the keys written ([] = nothing to write, no
   *  file touched). Throws when it cannot write (a home folder, a file it
   *  cannot read or write): the caller says so, never blocks the birth. */
  apply(input: { folder: string; home: string }, set: Readonly<Record<string, boolean>>): string[]
}

/** What the server hands Harness.loads.projected. */
export interface LoadsProjectedInput {
  folder: string
  home: string
  /** the row, as this engine's inventory answered it */
  row: LoadsRow
  /** the login the row's things load on (an account row: its login's);
   *  null = the machine's own login */
  provider: ResolvedProvider | null
  /** the engine's installed version as last read (null: not read) */
  engineVersion: string | null
}

/** What the server hands Harness.loads.skills / skillSwitch for one folder. */
export interface LoadsSkillsInput {
  folder: string
  home: string
  managedDir?: string
  /** every login's own config dir Silos connects (the machine's is read anyway) */
  configDirs?: string[]
  /** transcripts of the newest conversations started in the folder — read
   *  only when there is a batch to match to a login */
  recentTranscripts: () => string[]
  /** the launch places' payloads (LoadsInput.carried): the folder's
   *  agents, each with what Silos keeps for it — an agent line each */
  carried?: LoadsCarried
}

/** A skill's copy, by where it comes from (a name several copies share is
 *  one entry: a line says which copies it reaches). */
export type LoadsSkillCopy = 'personal' | 'account' | 'project'
/** The positions a skill line can take. */
export type LoadsSkillPosition = 'on' | 'name-only' | 'off'

/** One skill the catalog asks the places of (HarnessLoads.skillPlaces):
 *  its name, where this copy comes from, and Silos' own facts about it —
 *  `held` (the folder's copy is in Silos' held store), `shadowed` (a
 *  personal skill of the same name runs instead of the folder's copy). */
export interface LoadsSkillAsk {
  name: string
  from: LoadsSkillCopy | 'plugin'
  held?: true
  shadowed?: true
}

/** A skill's line of «Where it loads», broadest first — LoadsLine's
 *  grammar with three positions instead of on/off. */
export interface LoadsSkillLine {
  place: LoadsScopeId | 'fact'
  /** an agent line: whose — a conversation line: its agent (the line it follows) */
  agent?: string
  /** a conversation line: its thread */
  conversation?: string
  /** set by the server: the agent's name */
  agentName?: string
  /** a fact: managed settings, the repository's checked-in file */
  fact?: { who: 'organization' | 'repository'; file: string; key: string }
  /** where its entry is (or would be) kept, in the engine's words */
  keptIn?: string
  /** the account's line: a door, never a switch */
  door?: { word: string; where: string; url?: string; login?: string | null }
  /** this place's own position as found (any value — one Silos doesn't
   *  write is shown and kept); absent: it follows the line above */
  entry?: string
  /** what loads there, every line above counted: a position, or a value
   *  found by hand */
  result: string
  /** this line can't change the result: `organization` managed settings
   *  decide; `wider` what a wider place keeps off (the account's head, a
   *  folder copy out in Silos' store) — `at` names it; `engine` the engine
   *  ignores every entry (`reason`: a plugin's skill, a name settings
   *  can't store) */
  locked?: { why: 'organization' | 'wider' | 'engine'; at?: LoadsScopeId | 'fact'; reason?: 'plugin' | 'reserved' }
  /** the positions a click may pick here (absent: the line reads) */
  positions?: LoadsSkillPosition[]
  /** the project line of a folder copy: switched by Silos' held store
   *  (moved out of the folder and back), not by an entry */
  store?: true
  /** nothing here switches: the folder's settings dir is the engine's own */
  refused?: { why: 'home' }
  /** a shared name: the copies this place's entry reaches, and among them
   *  the ones whose reach from here is not measured */
  reaches?: LoadsSkillCopy[]
  unmeasured?: LoadsSkillCopy[]
}

/** HarnessLoads.skillPlaces — one skill copy's lines. */
export interface LoadsSkillPlaces {
  name: string
  from: LoadsSkillAsk['from']
  lines: LoadsSkillLine[]
}

/** One skill of a bulk click (HarnessLoads.skillSwitchMany): to a position
 *  as its own switch, or its exact entry put back (the undo). */
export type LoadsSkillBulkItem =
  | { name: string; from: 'account' | 'personal' | 'project'; to: LoadsSkillPosition }
  | { name: string; from: 'account' | 'personal' | 'project'; entry: string | null }

/** What a skill switch acts on: one skill (an account one, or one of your
 *  personal ones), or the account origin's head. */
export type LoadsSkillTarget = { kind: 'skill'; name: string; from: 'account' | 'personal' | 'project' } | { kind: 'origin' }

/** Harness.loads.skills: the account's skills per login, the folder's
 *  positions and the origin. `decidedBy`: a file other than the folder's
 *  local one sets it — named, no switch. */
export interface LoadsSkills {
  accounts: { login: string | null; accountId: string; unmatched?: true; skills: { name: string; file: string }[] }[]
  origin: { on: boolean; decidedBy?: { file: string; key: string } }
  /** every name a settings layer gives a position, with its value as found */
  overrides: { name: string; value: string; decidedBy?: { file: string; key: string } }[]
  /** the personal skill names the engine loads in every folder */
  personal: string[]
  /** nothing here switches: the folder's settings dir is the engine's own */
  refused?: { why: 'home' }
}

/** What the server hands Harness.loads.check. */
export interface LoadsCheckInput {
  folder: string
  home: string
  /** the login's provider (its env); null = the machine's own login */
  provider: ResolvedProvider | null
  /** the agents whose own tools (role plugins) are read too */
  agents: { id: string; name: string; stateDir: string | null }[]
  withoutLocal?: boolean
  managedDir?: string
  /** the bound (default: the engine's — 20 s); the process is closed at it */
  timeoutMs?: number
  /** «Check now» on an agent's page (spec scopes §7): the check starts as
   *  THAT agent's launches do — the payload Silos keeps for it (the
   *  engine's own shape, null: none) rides the check's flag-tier settings
   *  through the same allowlist. Absent: the project's check, no overlay. */
  as?: { agent: string; payload: unknown }
}

/** A check's reading: the engine's status of every server, the login it
 *  really ran on (the engine's own answer), and whether it fetched the
 *  login's connectors. `complete` false: the bound came while servers were
 *  still connecting — kept as pending. */
export interface LoadsCheckReading {
  login: string | null
  connectorsOn: boolean
  servers: TurnToolStatusServer[]
  complete: boolean
  ms: number
}

/** What the server hands Harness.loads.inventory for one folder. */
export interface LoadsInput {
  folder: string
  home: string
  /** the machine's managed-settings directory as the server is configured
   *  (absent: the engine's own default) */
  managedDir?: string
  /** transcripts of the newest conversations started in the folder (file-
   *  backed readers only): the logins they recorded */
  recentTranscripts: string[]
  /** the tool-name ids of the MCP servers the folder's conversations called */
  seenToolIds: string[]
  /** status readings of the folder's servers, newest first — exact names
   *  with the engine's own source; [] until a reader records them */
  readings: LoadsReading[]
  /** the servers of the folder's agents' OWN tools (Agent › Tools is their
   *  house): known names, never a row here */
  agentServers?: { agent: string; servers: string[] }[]
  /** the engine's installed version as last read (null/absent: not read) —
   *  a switch confirmed on a later version is refused, said on its row */
  engineVersion?: string | null
  /** the start notices of the folder's listed conversations (a trashed
   *  one is not listed), newest first — what the engine told the model at
   *  each start: some failures, the sign-ins */
  notices?: LoadsNotice[]
  /** each login's list of what its account sends (the ledger's
   *  `logins.json`: its newest reading in ANY folder taken with that
   *  origin on, or «See what it sends»), for the logins of the folder's
   *  conversations and agents — what a project with that origin off cannot
   *  fetch itself, offered as «could add» rows */
  loginLists?: { login: string; at: number; connectors: string[] }[]
  /** what Silos keeps for the launch places (spec scopes §6): the folder's
   *  agents, each with its payload — the engine's own shape, null while it
   *  has none — and one conversation's when the inventory is asked for it.
   *  Neutral code keeps a payload and never reads inside; the engine
   *  answers an agent line per agent listed here. Absent: no agent line. */
  carried?: LoadsCarried
}

/** Where a switch writes (HarnessLoads.switch `at`): one place of the
 *  engine's `scopes`. A FILE place (`project`, `machine`) the engine writes
 *  itself; a LAUNCH place (`agent` — its line's agent —, `conversation`)
 *  comes with the payload Silos keeps for it now (null: none yet). */
export interface LoadsSwitchAt {
  scope: 'project' | 'machine' | 'agent' | 'conversation'
  /** the agent line's agent (scope agent); a conversation's own agent
   *  (scope conversation — the line it follows), absent when none */
  agent?: string
  /** a launch place's payload (absent for a file place) — the project too,
   *  for an engine that carries it at launch (OpenCode) */
  payload?: unknown
  /** the owner said yes to the line's sentence (LoadsLine.asks) — a
   *  machine head's «off» is refused without it */
  confirmed?: true
}

/** All / nothing (HarnessLoads.switchMany, spec scopes §4): the rows and
 *  the account heads one click turns, at one place. */
export interface LoadsBulkSet {
  keys: string[]
  origins: LoadsOriginId[]
}

/** What a bulk click answers at a launch place: the new payload once, and
 *  each item it changed with whether that item keeps an entry of its own
 *  there (its `at` is kept while it does). */
export interface LoadsBulkSwitch extends LoadsCarriedSwitch {
  rows: { key: string; held: boolean }[]
  origins: { id: LoadsOriginId; held: boolean }[]
}

/** What a launch place's switch answers: the new payload (null: nothing
 *  left to keep), whether it changed, and whether the row has an entry of
 *  its own there after it (its `at` is kept while it does). */
export interface LoadsCarriedSwitch {
  payload: unknown
  changed: boolean
  held: boolean
}

/** LoadsInput.carried — the launch places' payloads. */
export interface LoadsCarried {
  /** the project's own payload — only for an engine whose project place is
   *  carried at launch (its `scopes` say `project: launch`) */
  folder?: { payload: unknown }
  agents: { id: string; payload: unknown }[]
  /** ONE conversation's place (its column — spec scopes §4): its thread
   *  id, the payload Silos keeps for it, and its agent, whose line it
   *  follows (absent: it follows the project's). Its line carries its
   *  switch. */
  conversation?: { id: string; payload: unknown; agent?: string }
  /** a page's facts (spec scopes §4 «Also off in …»): the folder's other
   *  conversations that keep an entry — a line only where one names the
   *  row, never a switch */
  conversations?: { id: string; payload: unknown; agent?: string }[]
}

/** A place a loading choice is kept at (HarnessLoads.scopes). «Scope» is a
 *  word of the code; on screen it is «where». */
export type LoadsScopeId = 'account' | 'machine' | 'project' | 'agent' | 'conversation'
export interface LoadsScope {
  id: LoadsScopeId
  carrier: 'file' | 'launch' | 'door'
  /** where its entries are kept, in the engine's words (a file's path as
   *  the owner knows it, the account's site) — absent for a launch place:
   *  Silos keeps it */
  keptIn?: string
}

/** One line of a row's «Where it loads» (LoadsRow.at), broadest first: a
 *  place of the engine's `scopes`, or a FACT the engine reads and Silos
 *  never writes (managed settings, a repository's checked-in file, the
 *  engine's own per-project toggle, a thing's own default). */
export interface LoadsLine {
  place: LoadsScopeId | 'fact'
  /** an agent line: whose — a conversation line: its agent, the line it follows */
  agent?: string
  /** a conversation line: its thread (LoadsCarried.conversation.id) */
  conversation?: string
  /** set by the server: the agent's name */
  agentName?: string
  /** set by the server on the project line of ONE agent's read: the names
   *  of every agent of the project it reaches (their lines are dropped) */
  agents?: string[]
  /** a fact: who decides there, the file (the engine's words) and its key */
  fact?: { who: 'organization' | 'repository' | 'engine' | 'default'; file: string; key: string }
  /** this place's own entry; absent: it has none and follows the line above */
  entry?: 'on' | 'off'
  /** whether a conversation this line reaches loads the thing, every line
   *  above it counted */
  result: 'on' | 'off'
  /** where the entry is (or would be) kept, in the engine's words; absent
   *  for a launch place (kept by Silos) */
  keptIn?: string
  /** this line can't change the result: `wider` an off-only thing a wider
   *  line keeps off (`at` names it), `organization` managed settings decide,
   *  `provided` the organization provides it and an entry here does not
   *  apply to it; `parent`: an imported file whose importing file (its
   *  shown name) is off at `at` — it goes with it; `head`: what keeps it off there is its origin's head
   *  (everything the account sends of that kind), not its own entry */
  locked?: { why: 'wider' | 'organization' | 'provided'; at?: LoadsScopeId | 'fact'; head?: true; parent?: string }
  /** the account's line: a door, never a switch — `url` only where the
   *  engine's page is confirmed */
  door?: { word: string; where: string; url?: string; login?: string | null }
  /** a line's own switch (POST …/loads/switch with `scope`): the
   *  engine's exact names its entry writes — every copy's for a server
   *  several plugins ship — and the other rows it reaches with them.
   *  Absent: this line can't change the result (`locked` says why), it is
   *  a fact or a door, or no exact name is known. */
  switch?: { names: string[]; reaches?: string[] }
  /** set by the server on ONE conversation's line with an entry of its own
   *  (spec scopes §7): «pending» while the entry is newer than the
   *  thread's last start, «in-effect» after a start that no longer has it
   *  (or, for an «on», that has it), «didnt-take» after one that still
   *  does (or doesn't). `since`: the entry's own time; `read`: the start
   *  that decided. */
  here?: { state: 'pending' | 'in-effect' | 'didnt-take'; since: number; read?: number }
  /** the switch this line would have, refused — `engine`: the installed
   *  engine is older than the version its key was confirmed on at this
   *  place; `file`: the file its entry is kept in is one the engine's
   *  writer won't rewrite (`reason` names it and says why) */
  refused?: { why: 'engine'; needs: string } | { why: 'file'; reason: string }
  /** this place's own «off» is its origin's head (everything the account
   *  sends of this kind), not the thing's entry: an «on» here adds this one
   *  and writes «off» for every other known one at this place (rule 4) */
  headOff?: true
  /** what the line's switch says before it acts, in the engine's words —
   *  the click waits for a yes (a machine head's «off»; adding one thing
   *  where its origin's head is off: the others stay off) */
  asks?: string
  /** set by the server (switch-proof.ts withPlaceProof): the newest reading
   *  this place reaches, taken after its own entry, says the entry didn't
   *  take — an «off» still listed, an «on» listing none of its names */
  proof?: LoadsPlaceProof
}

/** What a place expects a reading to show of a row (LoadsRow.expect, set
 *  by the engine): the machine where its entry decides for the project,
 *  each agent or conversation holding its own entry; `names` what a status
 *  reading lists if it loads. */
export interface LoadsExpect {
  scope: 'machine' | 'agent' | 'conversation'
  agent?: string
  conversation?: string
  to: 'on' | 'off'
  names: string[]
}

/** A place's entry that didn't take: which way it was, the name the
 *  reading still listed (an «off»; absent for an «on» — it listed none),
 *  and how that reading was taken. */
export interface LoadsPlaceProof {
  to: 'on' | 'off'
  name?: string
  status?: LoadsHealth['status']
  read: LoadsHealth['read']
}

/** One conversation's start notice, as the server hands it over. */
export interface LoadsNotice {
  conversation: string
  /** the login its start recorded (email), or null */
  login: string | null
  at: number
  mode: 'console' | 'chat' | null
  failed: { name: string; reason: string }[]
  needsAuth: string[]
  /** sign-ins known only by the id their tool names carry (a console's tool pair) */
  needsAuthIds?: string[]
}

/** A start notice with every name the engine's own: an id resolved to the
 *  one known name that has it, kept as the id of its observed row when no
 *  known name has it, dropped when two do (LoadsInventory.notices). */
export interface ResolvedNotice {
  conversation: string
  login: string | null
  at: number
  mode: 'console' | 'chat' | null
  servers: { name: string; status: 'failed' | 'needs-auth'; reason?: string }[]
}

/** A switch the engine refuses — the words say what decides. */
export class LoadsSwitchError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message)
  }
}

/** One reading of the engine's own status for the servers of a folder. */
export interface LoadsReading {
  at: number
  /** the login it was taken on, as its start recorded it (email), or null */
  login: string | null
  servers: { name: string; status: string; source?: string; scope?: string; noAddress?: true }[]
}

/** A row's health, from the newest status reading that lists it (on its
 *  login, for an account row) — set by the server (folder-loads.ts), never
 *  by an engine. `pending` is «still connecting», never a failure. */
export interface LoadsHealth {
  status: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled'
  /** the engine's message, cleaned (tool-health.ts scrubReason) */
  reason?: string
  tools?: number
  /** how it was read: when, by what, in whose conversation — `notice`: a
   *  conversation's start notice (only some failures, said so) */
  read: { at: number; from: 'turn' | 'check' | 'notice'; via?: TurnVia; agent?: string; agentName?: string; login: string | null; mode?: 'console' | 'chat' }
  /** how often it did not start (start-health.ts): `of` absent — the last
   *  `n` times in a row, since `since` (the kept run: it holds past the
   *  readings' cap); `of` set — `n` of the last `of` times. `from` says
   *  what was counted: status readings, else start notices (`consoles`:
   *  all of them console starts) */
  count?: { from: 'readings' | 'notices'; n: number; of?: number; since?: number; consoles?: true }
}

/** What kind of turn took a reading — said «in a chat of Builder». */
export type TurnVia = 'chat' | 'run' | 'wake' | 'round'

/** One server of a turn's status reading, as the engine hands it over —
 *  never its config (secrets); only whether it has no address. */
export interface TurnToolStatusServer {
  name: string
  status: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled'
  error?: string
  source?: string
  scope?: string
  tools?: number
  noAddress?: true
}

/** A turn's own status reading of its servers (ChatTurnHooks.onToolStatus). */
export interface TurnToolStatus {
  /** the turn's working folder */
  folder: string
  conversation: string
  turnId: string
  agentId: string
  /** the login its start recorded (email), or null */
  login: string | null
  via: TurnVia
  /** when the turn's process was started — it read its settings then, so
   *  a switch after it is not this reading's (switch-proof.ts) */
  started?: number
  /** the process fetched the Claude account's connectors: only such a
   *  reading replaces the login's connector list */
  connectorsOn: boolean
  servers: TurnToolStatusServer[]
}

/** Who a row belongs to: an owner of the web's lib/owners.ts, or null — a
 *  thing seen loading that Silos can't place. */
export type LoadsOwner = 'agent' | 'project' | 'you' | 'account' | null

/** One thing a conversation in the folder loads (or could). */
export interface LoadsRow {
  /** stable and exact — doors and switches name it, never a derived name */
  key: string
  engine: string
  kind: 'plugin' | 'mcp' | 'connector'
  /** the engine's own exact name; for a row known only by the id its tool
   *  names carry, that id (`exact` false) */
  name: string
  /** the short name on screen */
  label: string
  exact: boolean
  origin: {
    owner: LoadsOwner
    /** what carries it, said after the owner: `.mcp.json`, `~/.claude.json`,
     *  `stripe plugin`, `connector` */
    carrier: string
    /** an account row: its login (email) — null when Silos can't say which;
     *  `unmatched` when the batch matches no login a start recorded */
    login?: string | null
    unmatched?: true
  }
  /** active: this project loads it · held: a thing of yours or the
   *  project's turned off here · available: what the Claude account sends
   *  and this project has not added */
  state: 'active' | 'held' | 'available'
  /** the file (and key) that decides it, when it is not this project's
   *  local settings file — named, no button */
  decidedBy?: { file: string; key: string }
  /** the key family (spec scopes §2): `override` — the narrowest place
   *  that names it decides, either way; `off-only` — off at any place that
   *  reaches the conversation is off. Set with `at`. */
  family?: 'override' | 'off-only'
  /** «Where it loads»: one line per place of the engine's `scopes` (and
   *  per fact), broadest first. Absent: an engine with no `scopes`, or a
   *  row no line can name (known only by a tool id, seen and not placed). */
  at?: LoadsLine[]
  /** the switch (the project's local file decides it): the engine's exact
   *  names the click writes — several for a server several plugins ship,
   *  each copy's — and the other rows the click reaches with it (those
   *  copies, a namesake a name-based deny takes too) */
  switch?: { names: string[]; reaches?: string[] }
  /** the switch this row would have, refused — said in its place, no
   *  button: `home` the folder's settings dir is the engine's own config
   *  dir for every project; `engine` the installed engine is older than
   *  the version the switch was confirmed on (`needs`) */
  refused?: { why: 'home' } | { why: 'engine'; needs: string }
  /** a plugin's server: its plugin's row key */
  parent?: string
  /** seen loading (a reading or a tool id), not configured on disk */
  observed?: { from: 'reading' | 'tool-id' | 'notice' }
  /** an entry with no address — the plugin leaves this tool to a connector:
   *  the connector row of the same name, when the login's list has one */
  placeholder?: { connector?: string }
  /** the same address as this row (key): the engine connects it once */
  sameAs?: string
  /** a copy that does not load because another copy of the same plugin
   *  does: that copy's row key */
  replacedBy?: string
  /** display only: a server's url or command, a plugin's version */
  detail?: string
  /** what a plugin carries, from its manifest and folders */
  carries?: LoadsCarries
  /** a server's or connector's health (server-side, from the ledger) */
  health?: LoadsHealth
  /** set by the engine: the project's own switch file turns this row off —
   *  by its own entry (`item`) or by its origin's key (`origin`) — and the
   *  engine's exact names a status reading would list if it still loaded
   *  (a plugin: its servers'). Absent: nothing here a reading can prove. */
  heldHere?: { by: 'item' | 'origin'; names: string[] }
  /** set by the server (switch-proof.ts): a reading taken after the switch
   *  file last changed still lists this held row — «still loaded — the
   *  switch didn't take», with where it was read */
  proof?: LoadsProof
  /** set by the engine: what each place other than the project expects a
   *  reading to show (spec scopes §7) — the server marks the place's line
   *  (LoadsLine.proof) when a reading after that place's own change says
   *  otherwise. Absent: nothing a reading can prove outside the project. */
  expect?: LoadsExpect[]
  /** set by the engine: how this server or connector is signed in when it
   *  waits for your sign-in — the door its row offers. Absent: no door. */
  signIn?: LoadsSignIn
}

/** The engine's own way to sign a waiting server in, as a door:
 *  `console` — a new real console of an agent of the project; `draft` is
 *  the sentence the owner sends there (shown beside it to copy — Silos
 *  never types it), the engine's exact name in it; `menu`: the draft opens
 *  the engine's own menu of its servers (a row known only by an id) —
 *  the door is named by it («<draft> in a console ›»), else «Sign in ›»;
 *  `link` — a page outside Silos (`url`, opened in a new tab), named by
 *  `where` («Connect in <where> ›»); never a conversation. */
export type LoadsSignIn = { via: 'console'; draft: string; menu?: true } | { via: 'link'; url: string; where: string }

/** A switch that didn't take: which name the reading listed, as what, and
 *  how that reading was taken (the words of LoadsHealth.read). */
export interface LoadsProof {
  name: string
  status: LoadsHealth['status']
  by: 'item' | 'origin'
  read: LoadsHealth['read']
}

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

export interface LoadsInventory {
  engine: string
  folder: string
  rows: LoadsRow[]
  /** the logins its account rows name, with whether a batch matched them */
  logins: { login: string | null; accountId: string; matched: 'account-id' | 'elimination' | null }[]
  /** honest one-liners about what is not on disk */
  notes: string[]
  /** the input's start notices with the engine's own names (rows' health
   *  where no reading lists them — start-health.ts) */
  notices?: ResolvedNotice[]
  /** what an account origin sends, as a whole: whether this project loads
   *  it, and the head's switch (or what decides it) — the head of each
   *  account group on Project › Tools */
  origins?: LoadsOrigin[]
}

/** An origin of things the engine's account sends, as a whole. */
export type LoadsOriginId = 'plugins' | 'skills' | 'connectors'
export interface LoadsOrigin {
  id: LoadsOriginId
  /** this project loads what the origin sends (later sends included) */
  on: boolean
  /** the head switches here (the folder's local file decides it) */
  switch?: true
  /** another file decides it — named, no switch */
  decidedBy?: { file: string; key: string }
  /** the switch this head would have, refused (as a row's) */
  refused?: LoadsRow['refused']
  /** «Where it loads» for the head (spec scopes §3, rule 4 per place): its
   *  account door, the facts, the machine, the project and each agent —
   *  an off-only key: off at a wider place locks every narrower line */
  at?: LoadsLine[]
}

/** What Harness.loads.machineHeads is handed: the machine, no folder. */
export interface LoadsMachineInput {
  home: string
  managedDir?: string
  engineVersion?: string | null
}

/** An origin's head for this whole machine (Harness.loads.machineHeads):
 *  its lines — the account door, the organization's fact, the machine
 *  line with its switch and the sentence it asks before an «off». */
export interface LoadsMachineHead {
  id: LoadsOriginId
  /** the machine keeps it off (every project on this machine) */
  off: boolean
  at: LoadsLine[]
}

/** Harness.engineHosts: the documented list and where it is documented. */
export interface EngineHosts {
  /** the URL(s) of the engine's own network documentation */
  readonly source: string
  readonly hosts: readonly { readonly host: string; readonly optional?: true; readonly reason: string }[]
}

/** What GET /api/agents/:id/loaded hands Harness.loadedAtStart. */
export interface LoadedAtStartInput {
  agent: Agent
  /** Where its sessions start (the agent's primary folder). */
  folder: string
  home: string
  /** Its $SILOS_AGENT_STATE folder (never created by the read), or null. */
  agentStateDir: string | null
  /** Transcript files of its newest conversations, then of other conversations
   *  started in its folder (newest first, file-backed readers only): what
   *  the last starts there actually received. */
  recentTranscripts: string[]
  /** MCP server names its conversations really called (tool `server`), newest data. */
  seenMcpServers: string[]
  /** the folder's inventory (Harness.loads) as the server read it — its MCP
   *  servers and connectors are the ones listed; absent: the engine reads
   *  its own */
  loads?: Pick<LoadsInventory, 'rows' | 'logins'>
}

/** One instruction file the engine reads. `when`: at start, or on demand
 *  when the session works under `under` (a subfolder, relative, with '/'). */
export interface LoadedInstruction {
  path: string
  /** Shown name: relative to the folder, or ~-relative. */
  rel: string
  kind: 'local' | 'parent' | 'subfolder' | 'import' | 'rules' | 'project' | 'global' | 'silos'
  when: 'start' | 'on-demand'
  under?: string
  /** For an import: the file that names it (shown name). */
  importedBy?: string
  bytes: number
}

/** One thing a start hook adds to the context. */
export interface LoadedInjection {
  /** who wired it: a plugin, a settings file, or Silos' own plugin */
  origin: 'plugin' | 'user' | 'project' | 'local' | 'managed' | 'silos'
  /** the plugin's name, or the settings file's shown name */
  name: string
  /** when it fires (the matcher's words: startup, resume, clear, compact); [] = always */
  on: string[]
  command: string
  /** the file it is declared in */
  file: string
  /** a plugin that stands in for an output style (its name says so) */
  outputStyle?: true
  /** off in every conversation Silos starts for this agent: the agent's
   *  cockpit style switches the style plugins off per process */
  offBySilos?: true
  /** a plugin the Claude account sends (not one installed on the machine):
   *  its owner is that account — `login` the email its starts recorded, or
   *  null when Silos can't say which login */
  account?: { login: string | null }
  /** what its last observed run added, from the newest transcript that recorded it */
  seen?: { chars: number; excerpt: string; at: number; failed?: true }
  /** never recorded in this many recent starts that DID record other start
   *  hooks — Claude Code keeps a start hook only when it prints (an async
   *  hook, or one that says nothing, leaves no trace): it adds nothing there */
  unseenIn?: number
}

export interface LoadedMcp {
  /** the key it is declared under; for a connector seen only in tool names,
   *  that id as recorded (never turned back into a name) */
  name: string
  /** agent = its own servers (its plugin's .mcp.json, agent-tools.ts); project = the folder's own config; user = the operator's config for every folder; plugin; account = seen in conversations only */
  source: 'agent' | 'project' | 'user' | 'plugin' | 'account'
  /** where it is declared (shown name), or the plugin that provides it */
  from: string
  /** the engine's own exact name, when Silos can compute it (`plugin:<plugin>:<server>`) */
  engineName?: string
  /** a plugin server whose plugin the Claude account sends (see LoadedInjection.account) */
  account?: { login: string | null }
  /** an entry with no address: the plugin leaves this tool to an account
   *  connector — not a server of its own (recognised by structure) */
  placeholder?: true
  /** the same address as this earlier server (engine name): connected once, under it */
  sameAs?: string
}

export interface LoadedAtStart {
  engine: string
  folder: string
  instructions: LoadedInstruction[]
  injections: LoadedInjection[]
  outputStyle: { name: string; from: string; silos?: true } | null
  mcp: LoadedMcp[]
  /** the project page's Tools piece governs these servers (the door is drawn) */
  toolsDoor: boolean
  /** honest one-liners about what is not on disk, or was capped */
  notes: string[]
}

/** Who a piece of a conversation's start belongs to,
 *  in display order: the subject first, the furthest inheritance last. */
export type StartedWithOwner = 'conversation' | 'agent' | 'project' | 'silos' | 'you' | 'account' | 'engine'

/** One part of what a conversation's first turn carried. */
export interface StartedWithPart {
  owner: StartedWithOwner
  /** system · tools · instructions · memory-index · skills · agents · deferred ·
   *  mcp · hook · context · prelude · outcome · first */
  kind: string
  label: string
  /** its size in characters, as recorded */
  chars: number
  /** its share of the measured total, in proportion to its size */
  tokens: number
  /** the key of its exact text (GET …/started-with/part/:key) */
  ref?: string
  /** skills listed at that start the agent's catalog no longer has */
  stale?: true
  /** MCP servers Silos can't name the source of */
  unsourced?: true
  /** a folder's MCP server stored in the login's ~/.claude.json: it exists
   *  only when the conversation runs on that Claude account */
  loginBound?: true
  /** a start hook whose output was too large: only this stub reached the model */
  truncated?: { savedTo: string; size: string }
  /** a start hook's non-zero exit code */
  exitCode?: number
  /** the thing it belongs to: the key of its row in the folder's inventory
   *  (Harness.loads — a plugin, an MCP server, a connector), when one is
   *  known. Tools rows read their measured weight from it. */
  item?: string
  /** the plugin it comes with (its shown name), for a plugin's servers,
   *  skills and subagent types */
  group?: string
}

export interface StartedWithMcpFailure {
  name: string
  error: string
}

export interface StartedWith {
  /** input + cache_creation + cache_read of the first assistant with non-zero
   *  usage after the first api-request-shape; null = no such reply yet */
  totalTokens: number | null
  /** when that first turn was answered */
  at: string | null
  /** false: no record of the parts (only the total, if any) */
  measured: boolean
  mode: 'console' | 'chat' | null
  parts: StartedWithPart[]
  /** MCP servers still connecting at the first turn (not counted) */
  pendingMcp: number
  pendingMcpServers: string[]
  failedMcpServers: StartedWithMcpFailure[]
  /** What it carries NOW: the latest record of each kind (listings
   *  and tools replayed), sized in characters and converted with this
   *  conversation's own chars-per-token ratio — approximate, said so. null =
   *  no measured first turn to take the ratio from. */
  now: {
    approx: true
    /** characters per token, from the measured first turn */
    ratio: number
    parts: StartedWithPart[]
    /** tool names in force after replaying every deferred-tools delta */
    tools: number
    /** the MCP servers in force now, from replaying every deferred-tools delta
     *  in order (Claude Code's own deltas drop a previous login's connectors
     *  when the account changes — verified on 4c440473: −307 +9), each
     *  with its owner and how many of its tools are announced */
    mcp: { server: string; label: string; owner: StartedWithOwner; tools: number; loginBound?: true; item?: string; group?: string }[]
    pendingMcpServers: string[]
    failedMcpServers: StartedWithMcpFailure[]
  } | null
  /** the latest reply with non-zero usage: what the context holds now (exact) */
  contextNow: { tokens: number; at: string | null } | null
  /** the Claude login, from session_context records, one entry per change;
   *  the last is the account in force */
  accounts: { email: string; at: string | null }[]
  /** the engine's exact names of the MCP servers its first turn carried
   *  (tool definitions, deferred names, server instructions) — only names
   *  a known name resolves to; an id is never turned back */
  loadedNames: string[]
}

/** What a measurement is read against: today's facts about the agent. */
export interface StartedWithContext {
  /** the agent's mission as the append renders it (mission.ts missionHeader) — the agent-owned head of the system block */
  charter: string | null
  loaded: {
    injections: Pick<LoadedInjection, 'command' | 'name' | 'origin' | 'account'>[]
    mcp: (Pick<LoadedMcp, 'name' | 'source' | 'engineName' | 'account'> & { from?: string })[]
  } | null
  /** the folder's inventory (Harness.loads): a part's owner, label and
   *  item come from its row — of two copies of a plugin, the live one */
  loads?: LoadsRow[]
  catalog: { name: string; source?: string }[]
  /** Silos' own plugin folder (its hooks are Silos') */
  silosPluginDir: string
  /** the project folder (a worktree's main checkout) */
  projectDir: string | null
}

/** A measurement plus the exact text of every part, by `ref`. */
export interface StartedWithReading {
  summary: StartedWith
  texts: Record<string, string>
}

/** Harness.startedWith's feed. `reading(ctx)` after feeding every line equals
 *  one pass over the whole transcript, whatever the slicing; it never
 *  changes the fed state (call it after each growth). */
export interface StartedWithFeed {
  feed(lines: readonly string[]): unknown
  reading(ctx: StartedWithContext): StartedWithReading
}

/** A conversation pin (conversation-prefs): its provider id (null = the
 *  engine's own login / no Silos provider) and its model. */
export interface ConsolePin {
  provider: string | null
  model: string
}

/** A hook's answer, sent as `reply.code(code).send(body)`. */
export type RouteResult = { code: number; body: unknown }

/** What POST /api/console hands a hook after its shared preamble. */
export interface ConsoleOpenInput {
  /** The UI's theme at open time ('light', else absent = dark). */
  theme?: 'light'
  /** The explicit account/key for THIS console ('' = none), already validated. */
  pick: string
  /** A NEW console's model pick ('' = none), already validated. */
  modelPick: string
  /** Persists this console's picks (provider, model, output style) as the
   *  conversation's pins under `key` — a no-op without any. */
  pinPicks(cwd: string, key: string): void
  /** The conversation's first prompt (task mode's «Work on this» briefing).
   *  A harness that launches its engine with it answers `briefed: true` in
   *  the body; one that cannot (or only reattaches a running console) opens
   *  without it and says nothing — the route then says it was not briefed.
   *  A NEW conversation with a prompt is never the agent's idle console. */
  prompt?: string
}

export interface HarnessServerHooks {
  /** POST /api/console, before the session's meta is looked up. Default: nothing. */
  beforeOpen?(id: string): void | Promise<void>
  /** POST /api/console for an existing session, after the lineage tip and
   *  transcriptOnly checks. Default: console-open.ts genericOpenSession. */
  openSession?(id: string, meta: SessionMeta | undefined, input: ConsoleOpenInput): Promise<RouteResult>
  /** POST /api/console for a new conversation, after the agent-folder check.
   *  Default: console-open.ts genericOpenNew. */
  openNew?(agent: Agent & { folder: string }, input: ConsoleOpenInput): Promise<RouteResult>
  /** POST /api/console/:key/send. Default: tmux literal keystrokes + Enter. */
  sendText?(key: string, rec: ConsoleRecord, text: string): Promise<RouteResult>
  /** POST /api/sessions/:folder/:id/answer. Default: digit + Enter into the
   *  live console. `answers` = the form's picks, one label list per question
   *  (several questions, or one that takes several answers). */
  answer?(meta: SessionMeta, id: string, index: number, answers?: string[][]): RouteResult | Promise<RouteResult>
  /** PATCH …/prefs with a model or provider: push the pick to a live console.
   *  `key` = the conversation's live console, or null. Default: key ? 'next-turn' : null. */
  pushPin?(id: string, key: string | null, patch: Record<string, unknown>, prefs: CockpitOverrides): Promise<'live' | 'restart' | 'next-turn' | null>
  /** GET /api/models?harness=<id>: narrow the view to what an agent or a
   *  provider reaches (a RouteResult = an error reply). Default: the view as is. */
  narrowModels?(view: CatalogView, q: { agentId?: string; provider?: string }): CatalogView | RouteResult
  /** Its own routes, registered with the providers routes. Default: none. */
  routes?(app: FastifyInstance, ownerOnly: (req: FastifyRequest, reply: FastifyReply) => boolean): void
}

/** What buildServer hands Harness.server: its deps (a live object), this
 *  engine's server options (ServerDeps.engines[id]) and the closures the
 *  routes share. */
export interface ServerHookContext {
  deps: Readonly<ServerDeps>
  options: unknown
  helpers: {
    consoleKeyFor(m: SessionMeta): Promise<string>
    classifyAgentId(m: SessionMeta): string
    freshConsoles: Map<string, string>
    prefs: PrefsStore
    /** deps.terminals, or the TerminalService buildServer made when none was given. */
    terminals: TerminalService
  }
}

/** What the composition root (server/src/index.ts) hands every harness's
 *  boot(), right after the agent-state and asks stores exist. */
export interface HarnessBootContext {
  dataDir: string
  home: string
  root: string
  port: number
  /** The server's API URL (agent-env.ts silosApiUrl) — SILOS_API; absent: loopback on `port`. */
  silosApi?: string
  registry: AgentRegistry
  asks: AsksStore
  muted: readonly string[]
  ephemeral: string | null
  /** SILOS_NO_MODEL_CATALOG=1 → false: the runtime returns no modelFetcher. */
  modelCatalog: boolean
  log(line: string): void
}

/** A booted harness, phased in the order index.ts has always used. */
export interface HarnessRuntime {
  /** The fallback's → new SessionIndex(reader); every other's → index.addReader, in registration order. */
  reader?: HarnessReader
  /** Who a session belongs to by the engine's own storage (OpenCode: the agent DB holding it). */
  ownership?: { agentOfDb(id: string): string | null; isContested(id: string): boolean }
  modelFetcher?: FetchModels
  /** Handed to Harness.versions (HarnessService engines[id]). */
  versionOptions?: unknown
  /** Handed to Harness.headless (ChatDeps.headlessOptions[id]). */
  headlessOptions?: unknown
  /** Resolves once the start phases can run (a module the runtime loads
   *  lazily — Claude Code: its transcript watcher). The root awaits
   *  Booted.ready() right after bootHarnesses, before anything async starts. */
  ready?: Promise<void>
  /** Before buildServer (OpenCode: registrar, 5 s sweep, reader→seal wiring). */
  beforeServer?(ctx: HarnessStartContext): { serverOptions?: unknown; stop?(): void | Promise<void> } | void
  /** After buildServer (Claude Code: the transcript watcher). */
  afterServer?(ctx: HarnessStartContext): { stop?(): void | Promise<void> } | void
  /** After index.init() resolves (OpenCode: registrar rehydrate). */
  onIndexReady?(): void
}

/** The services a runtime's start phases reach (built by index.ts). */
export interface HarnessStartContext {
  index: SessionIndex
  terminals: TerminalService
  births: BirthsStore
  native: NativeStore
  convPrefs: ConversationPrefsStore
  root: string
  muted: readonly string[]
  ephemeral: string | null
}

/** A conversation an append is built for (conversation files): any
 *  session id of it (the router resolves the thread), the cwd
 *  it runs from, and the turn when the append is a real turn's. */
export interface ConversationRef {
  sessionId: string
  cwd: string
  turnId?: string
}

/** What an engine's turn needs from the router (ChatService): the per-turn
 *  provider resolution, the system-prompt append, and the fallback and event
 *  bookkeeping it owns. */
export interface ChatTurnHooks {
  /** `turnId`: the turn it resolves for — the router records what each turn
   *  ran on (its chat-done says whether that provider prices). */
  providerFor(agent: Agent, pinnedId?: string, turnId?: string): { provider: ResolvedProvider | null; onFallback: FallbackState | null }
  /** `has`: the skills the launch loads (its briefing's set).
   *  `conv`: the conversation the append is for, when one is known — its
   *  thread's own context files and queued news join the note; a `turnId`
   *  marks a real turn, whose news is consumed once its init arrives. */
  appendFor(agent: Agent, has: readonly string[], conv?: ConversationRef): string
  onRateLimit(
    agent: Agent,
    turn: { provider: ResolvedProvider | null; onFallback: FallbackState | null },
    ev: Extract<ChatEvent, { ev: 'chat-ratelimit' }>,
  ): void
  onErrorText(agent: Agent, turn: { onFallback: FallbackState | null }, text: string): void
  /** Every event a turn yields is emitted here too, in order: the resident learns of turns only this way. */
  emit(agentId: string, ev: ChatEvent): void
  /** The turn's own status reading of its servers, when the engine took one
   *  (never awaited by the turn; absent = nobody records it). */
  onToolStatus?(reading: TurnToolStatus): void
}

export interface HeadlessEngine {
  send(agent: Agent, input: ChatSendInput): AsyncGenerator<ChatEvent>
  cancel(turnId: string): Promise<boolean>
  isInflight(turnId: string): boolean
  isSessionActive(sessionId: string): boolean
}

/** deps: ChatService's own (a live object — read fields at use time);
 *  options: this engine's runtime options (ChatDeps.headlessOptions[id]). */
export interface HeadlessContext {
  deps: Readonly<ChatDeps>
  hooks: ChatTurnHooks
  options: unknown
}

/** What HarnessService hands an engine's versions factory: the shared process
 *  runner, the clock, and this engine's own options (HarnessDeps.engines[id]). */
export interface VersionsContext {
  run: RunFn
  now: () => number
  options: unknown
}

export interface HarnessVersions {
  /** Fallback engine only: the top-level rows of GET /api/harness — the ONE
   *  binary its consoles and chat turns both run, the client library Silos
   *  ships for it (null = none), and the published latest. */
  primary?(): Promise<{
    console: { version: string | null; path: string | null }
    library: { name: string; version: string | null; pairedWith: string | null } | null
    latest: string | null
    checkedAt: number
  }>
  /** Every other engine: its row in `others`. */
  other?(): Promise<OtherHarnessStatus>
  version(): Promise<string | null>
  /** Its compatibility verdict against the minimum the adapter declares
   *  (harness-run.ts EngineCompat): what Silos refuses to start on it, in
   *  one line with the command that fixes it. */
  compat(): Promise<EngineCompat>
  updateCommand(): [string, string[]]
  /** The words the update error uses ('claude update', 'opencode upgrade'). */
  readonly updateLabel: string
  invalidate?(): void
}

export interface HarnessTraits {
  /** 'trash': sessions are files Silos moves to ~/.silos/trash (needs a file-backed reader;
   *  FALLBACK ONLY — the trash route works on the fallback's root, holder scan and
   *  lineage, and registerHarness refuses it on any other harness);
   *  'hide': hidden Silos-side, the engine's data is never written. */
  deletion: 'trash' | 'hide'
  /** Console and headless write the SAME session: a live console is closed before a chat
   *  turn (console-handover.ts) and a started conversation may switch console ⇄ chat. */
  handover: boolean
  /** A model picked inside the console arrives as meta.requestedModel and becomes the
   *  conversation's pin (pin-follower.ts). */
  consolePinsModel: boolean
  /** Its console launches with a first prompt (ConsoleOpenInput.prompt → `briefed: true`):
   *  the task page's door opens the console briefed on the task. Absent = it opens
   *  without one, so the door defaults to chat (the chat turn carries the briefing). */
  consoleBriefing?: boolean
  /** Entries its plugin writes under agent-state/<agent>/ (kept out of "produced" files). */
  agentStateDirs: readonly string[]
  /** Which skills its sessions load besides the folder's own copies and the
   *  operator's personal ones (the skills catalog's ACTIVE truth): the
   *  machine's enabled Claude Code plugins, and/or skill roots it is handed
   *  at launch, each named as the plugin that brings it. Absent = neither —
   *  an engine is never credited with another engine's plugins. */
  readonly skillLoad?: {
    readonly claudePlugins: boolean
    readonly personal?: boolean
    readonly roots?: readonly { readonly plugin: string; readonly dir: string }[]
  }
  /** The tool its sessions ask the owner a structured question with — named in
   *  the per-turn append (chat-service askDecisionsNote) and nowhere else (the
   *  mission prompts say "your question tool"). Absent = "your question tool". */
  readonly askTool?: string
  /** What this engine's heartbeat turn REALLY blocks: the
   *  prompt states each as a fact only when it is (S10 — one
   *  source, never a promise the engine does not deliver), and a tainted
   *  heartbeat whose outside reads are only an unblockable class undoes
   *  without cutting. Absent = nothing is blocked. */
  readonly heartbeatBlocks?: { web: boolean; connectors: boolean; subagents: boolean }
  /** The environment variables this engine ITSELF sets, in every process a
   *  conversation's turn starts, to that conversation's session id — kept by
   *  the process when it outlives the turn (reparented to init). The System
   *  silo attributes a process to its conversation by them
   *  (silos/processes.ts); Silos' own SILOS_SESSION_ID needs no declaring.
   *  Only these names are ever read from a process's environment. Absent =
   *  the engine sets none. */
  readonly sessionEnvKeys?: readonly string[]
}

export type ProviderKind = ResolvedProvider['kind'] // 'claude-account' | 'anthropic-compatible' | 'harness-provider' | 'harness-native'

export interface HarnessProviderRules {
  /** Kinds it can run. 'default' is always allowed; harness-* only when p.harness === id. */
  kinds: readonly ProviderKind[]
  /** "Copy config": the export route's ?target= value and the snippet. */
  export?: { target: string; snippet(p: ResolvedProvider): string | null }
}

export interface HarnessUiFacts {
  contextPercent: boolean // StatusLine, ExternalStatus
  models: 'catalog' | 'provider-model' | 'none' // see D.4
  ownLogin: boolean // the cascade's default = the engine's own login
  territoryFenced: boolean // Settings › Territory lists the denied kinds
  territoryNote: string | null // extra sentence under Territory
  settingsAbout: string | null // Settings › Engines section description
  loginImport: { list: string; import: string } | null // routes the engine's login import uses
  // the engine's own sign-in by link, from Silos (GET options · POST start · GET/DELETE <path>/:id); absent = none
  signIn?: { path: string } | null
  providerExport: { target: string; label: string } | null // "Copy config" button
  // Optional (absent = the neutral wording/none) — the engine-specific words
  // Settings › Engines and › Accounts & providers print for an engine that is not the
  // default one:
  updateLabel?: string | null // its update command, "<updateLabel> finished; still …" (= versions.updateLabel)
  consoleColours?: boolean // the "Console colours" row (prefs.consoleTheme[<id>]: 'silos' | 'own')
  consoleColoursHint?: string | null // how the engine's own theme is changed inside its console, shown under 'own' ("<label>’s own theme — <hint>.")
  providersAbout?: string | null // the "<label> providers" section description
  providerIdPlaceholder?: string | null // the provider-id field's placeholder in "<label> provider"
  loginCommand?: string | null // the command that adds a login ("Run <loginCommand>, then come back.")
  givenFilesNote?: string | null // beside «give this conversation a file» when the engine is not told of it
}
