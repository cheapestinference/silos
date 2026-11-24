// automations-types.ts — resident: the Automation/Run model that lives in
// ~/.silos/automations.json + ~/.silos/runs/<id>.jsonl. Mirrored (no logic) in web/src/lib/types.ts.
import type { Period } from './period.js'

export interface OnceTrigger {
  kind: 'once'
  at: string
}
// tz: the IANA zone the cron's wall clock is read in (validated); absent = the server's local zone.
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
// the free period: its own clock, never cron's —
// slots from period.ts, at most one due, a heartbeat never catches up
export interface PeriodTrigger {
  kind: 'period'
  period: Period
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
  every: string // 5-field cron expression
  check: WatchCheck
  runWhen: 'changed' | 'nonzero' | 'zero' | 'matches'
  pattern?: string
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

export interface AutomationLastRun {
  at: string
  status: RunStatus
  durationMs: number
  sessionKey?: string
  summary?: string
  outcome?: RunOutcome
  exitCode?: number // a command run's (CommandRun)
}

// A usage limit waits for its reset and retries by itself unless the creator
// says otherwise — the one default every creator uses: the
// API, the editor, the responsibility beat and a silo's sync.
export const KEEP_ALIVE_DEFAULT = true

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
  // Daily budget — defaults to 24 when omitted (see DEFAULT_MAX_RUNS_PER_DAY).
  maxRunsPerDay?: number
  // Explicit opt-in for resident sessions to inherit the user's
  // hooks/plugins — defaults to NO (isolation).
  inheritHooks?: boolean
  // Adds the 'project' setting source to an isolated run (hooks stay off).
  // The SDK only discovers a folder's .claude/skills when that source is
  // enabled, so an automation whose prompt depends on skills installed in
  // the agent's own folder needs this; a plain automation does not.
  projectSettings?: boolean
  // Last fingerprint seen by the check — persisted so it can be compared
  // after a server restart.
  lastFingerprint?: string
  // Text of the last ChatService error for this automation — needsRotation()
  // uses it to detect "Prompt is too long" without re-reading the JSONL.
  lastRunError?: string
  // Set together with paused:true when the PLATFORM stopped the beat (the
  // agent chose a non-standing run-mode, its agent was archived...), never
  // when a person did. Only an automation carrying this marker may be
  // un-paused automatically; a user pause owns the switch until the user
  // flips it back.
  autoPaused?: boolean
  // Who materialized this automation. Absent =
  // created by a person in the UI/API; 'heartbeat' = an agent's heartbeat
  // (heartbeat-<agentId>, derived from Agent.heartbeat by heartbeat.ts
  // reconcile); 'self' = the agent's own recurring work (t5); 'pack' = a
  // role pack's.
  origin?: 'heartbeat' | 'self' | 'pack'
  // the proposal whose accept created it — an accepted own recurring
  // work runs at the rhythm the owner approved (outside the ceiling)
  acceptedFrom?: string
  // who created it: an agent id or 'owner' — an accepted proposal
  // carries its proposer
  createdBy?: string
  // where its own recurring work was decided: the run of the think
  // turn and the session it wrote — stamped by the server from the turn token
  createdIn?: { run: string; session: string }
  // what it answers: 'mission' or an item of the heartbeat's packet
  signal?: string
  // the line of its mission it serves (≤ 200), as the agent said it
  missionLine?: string
  // What its runs run on (the model matters more than the agent): the
  // same provider + model pair a conversation pins in Run on, passed to
  // every run as the TURN level of the cockpit cascade — so it wins over
  // the kept conversation's pin and the agent's default, field by field.
  // Absent = the agent's default, as always.
  runsOn?: AutomationRunsOn
  // WHAT its runs execute: an agent turn (absent = 'agent', every
  // automation before command runs existed, no migration) or a command, run without Claude. Only the owner creates or
  // edits a command (server.ts): the territory fence lives inside Claude and
  // never reaches an exec.
  run?: AutomationRun
}

export type AutomationRun = { kind: 'agent' } | CommandRun

export interface CommandRun {
  kind: 'command'
  // exec'd directly, NO shell: no `;`, `>>`, `$( )`. `$SILOS_AGENT_STATE`
  // (and `${SILOS_AGENT_STATE}`) is the one variable expanded, in argv and cwd.
  argv: string[]
  cwd?: string // absolute; default the agent's folder
  timeoutMs?: number // default COMMAND_TIMEOUT_MS, at most COMMAND_TIMEOUT_MAX_MS
  // on a non-ok exit (or a timeout): a Needs you row ('inbox'), or a turn
  // of the agent with the prompt + exit code + the log's tail ('agent')
  onFailure: 'inbox' | 'agent'
  okCodes?: number[] // exit codes that are not a failure; default [0]
}

export const COMMAND_TIMEOUT_MS = 10 * 60_000
export const COMMAND_TIMEOUT_MAX_MS = 60 * 60_000

export function isCommandRun(a: Pick<Automation, 'run'>): a is { run: CommandRun } {
  return a.run?.kind === 'command'
}

// The command leg of a run (Run.command): what the exec did, kept even when
// the failure was handed over to the agent (then the run's status, summary
// and sessionKey are that turn's).
export interface CommandLeg {
  exitCode?: number // absent: it timed out, or never started
  timedOut?: boolean
  error?: string // why it never started (ENOENT, a bad cwd…)
  durationMs: number
  lastLine?: string // last non-empty line of its (redacted) output, ≤ 200
  logBytes: number // bytes in <dataDir>/runs/<automationId>/<runId>.log
}

export interface AutomationRunsOn {
  provider?: string
  model?: string
}

export type RunStatus = 'queued' | 'waiting_approval' | 'running' | 'ok' | 'failed' | 'skipped' | 'waiting_reset'

// What an ok run says it did — the agent's own OUTCOME line at the end of
// its final message (see RUN_OUTCOME_INSTRUCTION in resident.ts). Absent =
// unclassified (no line, an older record, a failure): shown as a bare "ok".
export type RunOutcome = 'nothing' | 'acted'

export interface Run {
  id: string
  automationId: string
  at: string
  status: RunStatus
  startedAt?: string
  endedAt?: string
  durationMs?: number
  sessionKey?: string // "folder/id"
  error?: string
  summary?: string
  outcome?: RunOutcome
  reason?: string // reason for 'skipped' (e.g. "session open in terminal")
  // the instant a skip's reason stops before (ISO): «…at its usage limit —
  // it looks after» + the reset, said in the viewer's local time by the web
  until?: string
  resetsAt?: string // ISO — when a 'waiting_reset' gets retried
  // Whether the model produced anything during this run (text, thinking, a
  // tool call or output tokens) — false when the turn was rejected before
  // any work (an API 400, a usage limit). Set on every terminal run that
  // reached the turn; absent on older records. Feeds the daily budget.
  produced?: boolean
  // The effective prompt for THIS specific run when it differs from the
  // generic automation.prompt (webhook payload, watch fingerprint...) —
  // persisted on the run itself so approve() can reconstruct it after a
  // server restart (the approval queue is durable, not in-memory).
  promptOverride?: string
  // Why this run was started, on the initial record (running /
  // waiting_approval): a standing wake's causes joined by '; ', or
  // 'message:<id>:<from>' on older records, from when an urgent
  // message still woke the heartbeat (history: no message wakes anyone).
  // Absent on cron/manual runs and older records.
  cause?: string
  // A command automation's run (CommandRun): its exit code (absent on a
  // timeout), the command leg, and whether its failure was handed to the
  // agent (`handover`: status/summary/sessionKey are then that turn's).
  exitCode?: number
  command?: CommandLeg
  handover?: boolean
  // what the turn cost, from its chat-done — written on every
  // run when it closes; null: it ran no turn (a command) or its engine said
  // no price. The spend cap sums it.
  costUsd?: number | null
  // the model its turn ran (chat-init) — said by the unpriced-spend row
  model?: string
  // whether its turn's provider prices (chat-done, providers-store
  // providerPrices): false — a plan — keeps its costUsd out of the spend cap;
  // absent (it ran no turn, or one that said nothing) counts
  priced?: boolean
  // a heartbeat run: its kind written AT START (the live turn's class
  // reads it), the rest when it ends
  heartbeat?: RunHeartbeat
  // the transcript audit of every unattended run, written at its end
  audit?: RunAudit
}

// The packet's listed keys — the source of «when was it last listed»
// (the next packet re-reads the packet.keys of earlier heartbeat runs).
export interface PacketSummary {
  keys: string[]
}
export interface RunHeartbeat {
  kind: 'look' | 'think' | 'round'
  // the regime SEALED at start: whether the turn had
  // the agent's tools, and — a proactive heartbeat (a round, or the think of
  // a proactive agent) — its day's count. Engine options, the judge and the
  // audit read it from here, never from the agent.
  tools?: boolean
  perDay?: number
  packet: PacketSummary
  created: string[]
  proposed: string[]
  considered: number
  sleptUntil?: string
  // why a heartbeat fire took no turn — what
  // the re-armed think follows and the page's last line says
  skipped?: 'sleeping' | 'busy' | 'spend' | 'share' | 'account' | 'headroom' | 'engine' | 'empty' | 'quota'
}
export interface RunAudit {
  readOutside: string[]
  memoryEdited?: string[]
  configEdited?: string[]
  ownerCredential?: string[]
}
// the cause a run of an owner's gesture carries: it
// skips the automation's daily budget check and never counts in it (b)
export const MANUAL_CAUSE = 'manual'

export const DEFAULT_MAX_RUNS_PER_DAY = 24
