// resident/deps.ts — what the resident is built from (moved verbatim from
// resident.ts, which re-exports the type).
import type { AutomationsStore } from '../automations-store.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { ChatService } from '../chat-service.js'
import type { NativeStore } from '../native-store.js'
import type { LineageStore } from '../lineage.js'
import type { SessionOwners } from '../session-owner.js'
import type { SessionIndex } from '../session-index.js'
import type { PendingResumesStore } from '../pending-resumes-store.js'
import type { AgentStateStore } from '../agent-state.js'
import type { Agent } from '../types.js'
import type { PacketInput } from '../heartbeat-packet.js'
import type { HeartbeatStore } from '../heartbeat-store.js'
import type { HeartbeatBlocks } from '../heartbeat-prompt.js'
import type { WakesToday } from '../own-turns.js'
import type { TurnSlots } from '../turn-slots.js'
import type { RunAudit } from '../automations-types.js'
import type { SessionOriginsStore } from '../session-origins.js'
import type { MarginReading, OpenItem, UndoneItem } from '../proactive.js'

/** The account an unattended turn will run on. */
export interface TurnAccount {
  id: string
  priced: boolean
  readable: boolean
}

export interface ResidentDeps {
  store: AutomationsStore
  registry: AgentRegistry
  chat: ChatService
  native: NativeStore
  index: SessionIndex
  root: string // ~/.claude/projects — the same root as SessionIndex
  dataDir: string // ~/.silos
  broadcast: (msg: unknown) => void
  // Lineage: optional (same criterion as the rest of this list's deps) —
  // without it, a rotation simply leaves no lineage record.
  lineage?: LineageStore
  // The owner resolver (session-owner.ts) — index.ts shares ONE instance
  // with the server and the titler; absent (tests), built from the deps.
  owners?: SessionOwners
  // WHO gave birth to a session (session-origins.ts): a chat-init with no
  // `resume` is a session this run opened — recorded there so the UI can
  // tell an automation's conversation from the owner's. Optional: without
  // it, births simply aren't recorded.
  origins?: SessionOriginsStore
  now?: () => Date
  claudeSessionsDir?: string // default homedir()/.claude/sessions — injectable for tests
  isPidAlive?: (pid: number) => boolean
  fetchFn?: typeof fetch
  // the fetch of an http watch an AGENT wrote (check.publicOnly) — default
  // net-guard.ts guardedFetch; injectable for tests
  guardedFetchFn?: (url: string, o: { method?: string; headers?: Record<string, string> }) => Promise<{ status: number; body: string }>
  execFn?: (command: string, cwd: string) => Promise<{ stdout: string; code: number }>
  tickIntervalMs?: number
  runTimeoutMs?: number // injectable for tests (default RUN_TIMEOUT_MS, 30 min)
  // Auto-resume caps, injectable for tests (default RESUME_BATCH_PER_TICK /
  // DEFAULT_MAX_RUNS_PER_DAY).
  resumeBatchPerTick?: number
  resumeDailyBudget?: number
  // Auto-titles: a low-priority sweep on this same heartbeat — optional
  // (same criterion as lineage): without it, titles simply aren't
  // synthesized. See titler.ts.
  titler?: { sweep: (now?: Date) => Promise<number> }
  // The machine's vitals (machine-sampler.ts): one sample at the first tick
  // of the process and one per hour — the same low-priority lane as the
  // titler, fire-and-forget. Absent: nothing is sampled.
  machine?: { sweep: (now: Date) => Promise<unknown> }
  // Prunes orphaned conversation-prefs — same criterion as the titler: a
  // low-priority sweep on this heartbeat, optional (without it, it simply
  // isn't pruned). index.ts wires it gated by index.isReady(), and the
  // grace window lives in the store itself.
  prefsSweep?: () => void
  // Auto-resume for interactive chats: a durable store of rate-limited
  // interactive turns to resume. Optional (same criterion as the rest of
  // this list): without it, the resident simply doesn't resume interactive
  // chats — AUTOMATION auto-retry (waiting_reset) is independent and keeps
  // working the same. index.ts always wires it.
  pendingResumes?: PendingResumesStore
  // The heartbeat's clock (heartbeat.ts): reconciled on every tick, before
  // anything is evaluated. Absent: no heartbeat is created or adjusted.
  heartbeats?: { reconcile(): void }
  // What a heartbeat fire reads (resident/heartbeat.ts): the agent's territory (the derived control), the packet's facts,
  // the considered lines and what its engine's heartbeat really blocks.
  // Absent: a heartbeat fires with an empty packet and Claude's blocks.
  heartbeat?: {
    fenceOn(agentId: string): boolean
    facts(agent: Agent, since: number, now: number): Omit<PacketInput, 'agentId' | 'since' | 'now' | 'lastListed' | 'considered'>
    store: HeartbeatStore
    blocks(agent: Agent): HeartbeatBlocks
    // the proactive mode: the round's state blocks and
    // its day's count, read from the ledger (proactive.ts). Absent: empty.
    mission?(agent: Agent, now: number): { open: OpenItem[]; undone: UndoneItem[]; madeToday: number }
    // the account the agent's next UNATTENDED turn will run on — the same
    // resolution ChatService.send makes (the automation's runsOn, the
    // install's switch, the agent's fallback):
    // whether it prices, and whether its plan usage can be read. Absent:
    // the machine's own login, readable.
    account?(agent: Agent, runsOnProvider: string | undefined): TurnAccount
    // the plan reading of an account: get() ASKS (a fetch at most every
    // 90 s), peek() is the cache. Absent: no reading, ever.
    usage?: { get(id: string): Promise<MarginReading | null>; peek(id: string): MarginReading | null }
  }
  // Task mode's wakes of an agent's local day that count on its own (not an
  // owner's gesture, charged) — the ceiling's and the spend cap's wake half
  wakesToday?: (agentId: string, day: string) => WakesToday
  // The live caps on unattended turns (turn-slots.ts), shared with Task mode
  slots?: TurnSlots
  // The transcript audit of a finished unattended run (heartbeat-audit.ts):
  // absent, no audit is written
  audit?: (run: { agentId: string; sessionKey: string; startedAt: string }) => Promise<RunAudit | null>
  // the verdict of an audit once the ledger exists (initiative.ts
  // afterAudit): absent, the t3 verdict (cut only on
  // the owner's credential) holds
  afterAudit?: (
    agentId: string,
    run: string,
    audit: RunAudit,
    o: { heartbeat: boolean; tools?: boolean; gaps: { mcp: boolean; childSessions: boolean } },
  ) => unknown
  // The agent's own state dir (agent-state.ts) — a command run's env
  agentState?: AgentStateStore
  // The Vault (vault-store.ts): the env a command run gets is the one an
  // agent's console gets — its secrets by visibility (envFor(agent, cwd)).
  // Optional: without it a command runs with no secrets.
  vault?: { envFor(agentId: string | null, cwd: string | null): Record<string, string>; secretsFor?(agentId: string | null, cwd: string | null): string[] }
  // The server's API URL — SILOS_API in a command run's env (agent-env.ts).
  // Absent: the address the config resolves (SILOS_HOST/SILOS_PORT).
  silosApi?: string
  // When an agent's account comes off its usage limit (plan-usage reading),
  // ISO — a task turn refused on its limit says when it goes. Optional.
  accountResetOf?: (agentId: string) => string | null
  // Why the agent's engine refuses its chat turns right now (harness.ts
  // peekRefusal — outdated, missing), or null. The unattended lanes HOLD on
  // it, spending nothing: an automation's due beat (it stays due and runs once when the engine is ok). Absent:
  // nothing is held up front — a refusal at send time is still held.
  engineRefusal?: (agentId: string) => string | null
  // Task mode (task-mode/engine.ts): its look runs on every tick — next checks that came, holds that lifted, queued
  // wakes whose conversation is free now. Optional: without it, nothing.
  taskMode?: { look(now?: number): void }
  // Escalation (escalation/engine.ts): after task mode, the stuck things
  // that hop one link up their chain (or reach the owner) when their window
  // passes. Optional: without it, nothing escalates.
  escalation?: { tick(now?: number): void }
  // Proposals (proposals.ts): a pending proposal past
  // its 14 days is marked expired (decidedBy 'silos') on the tick.
  // Optional: without it, nothing expires.
  proposals?: { expireDue(now?: number): number }
  // Usage's windows (usage-ledger.ts): the resident
  // decides a timeout, so it stamps it on the turn's window before it
  // cancels the turn (the first close wins). Optional: nothing stamped.
  usageTimeout?: (turnId: string) => void
}
