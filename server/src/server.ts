import type { Initiative } from './initiative.js'
import type { LoadsScopesStore } from './loads-scopes.js'
import type { PlansOrigins } from './plans-origins.js'
import { initiativeRoutes } from './routes/initiative.js'
import { usageRoutes } from './routes/usage.js'
import { vitalsRoutes } from './routes/vitals.js'
import type { VitalsService } from './vitals.js'
import type { UsageService } from './usage.js'
import { countSessions, type SessionCounts } from './session-counts.js'
import type { WebSocket } from 'ws'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { activateSkill, heldSkillNames, holdSkill } from './skill-states.js'
import { LoadsSwitchError } from './harnesses/contract.js'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import type { SessionIndex } from './session-index.js'
import type { AgentRegistry } from './agent-registry.js'
import type { SessionStore } from './session-store.js'
import type { NativeStore } from './native-store.js'
import type { LineageStore } from './lineage.js'
import { SessionOwners } from './session-owner.js'
import type { ChatService } from './chat-service.js'
import type { ExecService } from './exec-service.js'
import type { CompleteService } from './complete-service.js'
import type { PrefsStore } from './prefs-store.js'
import type { MemoryService } from './memory-service.js'
import { FileService } from './file-service.js'
import { ContextService } from './context-service.js'
import { ConsoleUnknownError, TerminalService } from './terminal-service.js'
import { boardCardOf } from './board.js'
import { messagesNeedsYou, asksNeedsYou, type NeedsYouItem } from './needs-you.js'
import type { AsksStore } from './asks-store.js'
import type { MessageStore } from './messages.js'
import type { HarnessService } from './harness.js'
import type { Agent, SessionMeta, TranscriptTurn } from './types.js'
import type { AutomationsStore } from './automations-store.js'
import type { SessionOriginsStore } from './session-origins.js'
import type { Birth } from './births-store.js'
import type { Resident } from './resident.js'
import { runCauseFor } from './run-cause.js'
import { secretsMatch } from './resident.js'
import { automationRoutes } from './routes/automations.js'
import { rolePackRoutes } from './routes/role-packs.js'
import type { AutomationTemplates } from './automation-templates.js'
import { siloRoutes } from './routes/silos.js'
import { providerRoutes } from './routes/providers.js'
import { mapRoutes } from './routes/map.js'
import { boardRoutes } from './routes/board.js'
import { fileRoutes } from './routes/files.js'
import { skillRoutes } from './routes/skills.js'
import { switchFolderSkill } from './folder-loads.js'
import { agentRoutes } from './routes/agents.js'
import { sessionRoutes } from './routes/sessions.js'
import { chatRoutes } from './routes/chat.js'
import { vaultRoutes, type VaultRoutesCtx } from './routes/vault.js'
import { messageRoutes } from './routes/messages.js'
import { MessageReads } from './message-reads.js'
import { consoleRoutes } from './routes/console.js'
import { taskSeenRoutes } from './routes/task-seen.js'
import { systemRoutes } from './routes/system.js'
import { sealRoutes } from './routes/seals.js'
import { sealInboxRows } from './inbox.js'
import { readClaudeSettings } from './harnesses/claude-code/settings.js'
import type { Seals } from './seals.js'
import { workspaceRoutes } from './routes/workspace.js'
import { ToolHealthLedger } from './tool-health.js'
import { LoadsChecks } from './loads-check.js'
import type { QueryFn } from './harnesses/claude-code/sdk-types.js'
import { PARAM, PURE_DOTS } from './segments.js'
import type { ProvidersStore, ResolvedProvider } from './providers-store.js'
import type { AccountsService } from './harnesses/claude-code/accounts.js'
import type { AccountLoad } from './harnesses/claude-code/account-load.js'
import type { PlanUsage } from './harnesses/claude-code/plan-usage.js'
import type { SiloRegistry } from './silos/registry.js'
import type { ValidateRoute } from './silos/validator.js'
import type { SiloKernel } from './silos/kernel.js'
import type { SiloSurfaces } from './silos/surfaces.js'
import type { TransitionJournal } from './silos/journal.js'
import { PLATFORM_LOCATION } from './silos/reader.js'
import type { SiloActions } from './silos/actions.js'
import type { SiloInstaller } from './silos/installer.js'
import type { SiloOperatorStore } from './silos/operator.js'
import { fallbackHarness, findHarness, harnessOf } from './harnesses/registry.js'
import type { HarnessId, HarnessServerHooks, ServerHookContext } from './harnesses/contract.js'
import type { StallSnapshot } from './loop-stalls.js'
import type { GatewayModelsRefresher } from './gateway-models.js'
import type { ConversationPrefsStore } from './conversation-prefs.js'
import type { SeenStore } from './seen-store.js'
import type { TaskSeenStore } from './task-seen-store.js'
import type { AckKind, NeedsYouAcksStore } from './needs-you-acks.js'
import type { ProposalsStore } from './proposals.js'
import { reviewOnly } from './proposals.js'
import { proposalWords } from './proposals-view.js'
import { proposalRoutes } from './routes/proposals.js'
import {
  composeInbox,
  engineCompatRow,
  engineUnwiredRow,
  inboxSignature,
  RESIDENT_TICK_MS,
  type InboxRow,
  type SessionAsk,
  type AccountUsage,
  type TaskFlowFact,
} from './inbox.js'
import { agentNameOf, kernelInboxRows, limitedProviders } from './inbox-source.js'

// The inbox, for whoever runs beside the server (the digest, the doorbell):
// app.composeInbox(now?) is the SAME composition GET /api/board returns as
// `inbox`; app.onInboxChange(fn) is called with the new rows whenever that
// composition changes (checked every resident tick and after acks and
// messages). Returns the unsubscribe.
// app.digestFacts(from, to) is what the daily digest counts beside the inbox
// (digest.ts DigestFacts) — read from the same index, stores and silos.
declare module 'fastify' {
  interface FastifyInstance {
    composeInbox: (now?: number) => InboxRow[]
    onInboxChange: (listener: (rows: InboxRow[]) => void) => () => void
    // compare the inbox now (soon: next turn of the loop) — a silo re-read
    // that moved Home's rows asks for it so the doorbell never waits a tick
    checkInboxNow: () => void
    digestFacts: (from: number, to: number) => DigestFacts
  }
}
import type { DigestFacts } from './digest.js'
import { VisitsStore, composeSince, weeklyPercentOf, type HomeSince, type SinceFacts } from './home-since.js'
import type { DigestStore, NotificationPrefsStore } from './digest-job.js'
import type { PushSubscriptionsStore, WebPushDoorbell } from './web-push.js'
import { planProgressOf, PLANS_SILO } from './plans-floor.js'
import type { TaskModeEngine } from './task-mode/engine.js'
import { isUnread } from './unread.js'
import type { ModelCatalog } from './model-catalog.js'
import type { PendingResumesStore } from './pending-resumes-store.js'
import type { VaultStore } from './vault-store.js'
import type { AgentStateStore } from './agent-state.js'
import type { HeartbeatClock } from './heartbeat.js'
import type { HeartbeatStore } from './heartbeat-store.js'
import type { OwnTurnsToday } from './own-turns.js'
import { heartbeatRoutes } from './routes/heartbeat.js'
import { controlOf, degradedWhy, heartbeatOf, positionOf } from './control.js'
import { heartbeatAutomationId } from './heartbeat.js'
import { LoginRateLimiter, STATE, cookieOf, readSignInPick, type SilosIdClient } from './silos-id.js'
import { SessionTokenStore } from './session-tokens.js'
import type { PeerRegistry } from './harnesses/claude-code/peer-registry.js'
import type { FenceOverlay, FenceScope } from './territory.js'
import type { TerritoryStore } from './territory-store.js'
import type { PlatformSettingsStore } from './platform-settings.js'
import type { Automation } from './automations-types.js'
import type { AgentTokens } from './agent-tokens.js'
import type { ExecutionsSource } from './silos/executions.js'
import { agentMayRead, agentMayWrite, anonymousMayRead, agentWriteNeedsTurn, isEgressPath, isWriteClass } from './agent-authz.js'
import { PROCESS_SILO, type ProcessRecords, type ProcessView, type StopResult } from './silos/processes.js'
import type { WorktreeRecords } from './silos/worktrees.js'
import { conversationThread } from './conversation-thread.js'
import type { KernelVerbImpl } from './silos/actions.js'
import { egressRoutes } from './routes/egress.js'
import { EgressLog, EgressRejectLog } from './egress-log.js'
import { territoryEgressRoutes } from './routes/territory-egress.js'
import { LiveTurns, turnOfRequest } from './live-turns.js'
import type { EscalationEngine } from './escalation/engine.js'
import type { TaskAsks } from './task-asks.js'
import { RelationStore } from './silos/relations.js'
import { makeAbsorbRotations, makeThreadRootKey, type AnnounceBox } from './thread-tools.js'
import { makeTranscriptOnly, type TranscriptOnly } from './transcript-only.js'
import { makeThreadIdOf, type TaskThreads, type ThreadIdOf } from './task-threads.js'
import { makeConversationPlaces } from './conversation-places.js'
import { conversationWorking } from './work-live.js'

// a run log's ids: one path segment of the shapes the resident mints
// (UUIDs, auto-resp-<agent>), never a traversal

export interface ServerDeps {
  // what one agent's launches load, kept by Silos (loads-scopes.ts): the
  // store Project › Tools' agent lines write, and what each launch carries
  loadsScopes?: LoadsScopesStore
  // the payloads an agent's launches carry, in overlay order (the launch
  // folder's, for an engine whose project place is carried; its own; then,
  // given a session, its conversation's thread's) — handed to its engine as
  // they are
  loadsCarried?: (agentId: string, cwd?: string, sessionId?: string) => unknown[]
  // the event loop's stalls (loop-stalls.ts): numbers on GET /healthz for a
  // request from this machine — absent, /healthz is the bare probe
  loopStalls?: { snapshot(): StallSnapshot }
  // the ledger's doors (initiative.ts, routes/initiative.ts)
  initiative?: { initiative: Initiative; origins: PlansOrigins }
  // Usage (usage.ts): GET /api/usage — absent, no route
  usage?: Pick<UsageService, 'report'>
  // the vitals (vitals.ts): GET /api/vitals and each automation's usage30d — absent, neither
  vitals?: Pick<VitalsService, 'vitals' | 'automationUsage'>
  index: SessionIndex
  registry: AgentRegistry
  store: SessionStore
  native: NativeStore
  // Lineage: optional, same criterion as `terminals`/`resident` — without
  // it, SessionView.parentKey simply never gets filled in (safe degradation).
  lineage?: LineageStore
  // The owner resolver (session-owner.ts): index.ts builds ONE and shares
  // it with the titler and the resident; absent (tests), the server builds
  // its own from the deps above.
  owners?: SessionOwners
  // the plugin's birth markers (births-store.ts) — used only when `owners`
  // is not handed in (tests); index.ts gives them to its shared owners.
  births?: { get(sessionId: string): Birth | null }
  chat: ChatService
  // the turn tokens (live-turns.ts) — absent: the chat service's own
  liveTurns?: LiveTurns
  // the serving of an inbox, marked by the class of the turn (index.ts
  // shares one with ChatService); absent, one over messages + liveTurns
  messageReads?: MessageReads
  exec: ExecService
  complete: CompleteService
  prefs: PrefsStore
  memory: MemoryService
  // File viewer/editor: optional (same criterion as terminals/resident) —
  // without it, /api/file* isn't registered. index.ts always builds it
  // with cfg.dataDir. Serves ANY absolute path to an authenticated request
  // (same boundary as the PTY terminal) — see file-service.ts.
  files?: FileService
  // Agent context: files you upload for the agent to read (under
  // <folder>/context/). Optional, same criterion — without it,
  // /api/agents/:id/context* isn't registered. See context-service.ts.
  context?: ContextService
  // the kernel kind `execution` (silos/executions.ts): a session's SDD
  // ledger, captured into Silos' copy and read with its plan document, and
  // the plan task it hangs from. Optional — without it the detail says
  // `execution: null`; index.ts always builds it.
  executions?: Pick<ExecutionsSource, 'forSession'>
  token: string
  liveMs: number
  // ~/.silos — the data dir the stores were built from. Optional (same criterion as accountPath): default is the
  // real ~/.silos; tests point it at a temp dir.
  dataDir?: string
  // the user's home; tests point it at a temp dir so nothing reads the
  // real ~/.claude
  home?: string
  // Claude Code's managed-settings directory (plugin-enablement.ts) — absent: no managed layer
  claudeManagedDir?: string
  // the ledger of the servers' status readings (tool-health.ts) — default
  // <dataDir>/tool-health when a dataDir is given, none otherwise
  toolHealth?: ToolHealthLedger
  // the engine's query for «Check now» (loads-check.ts) — the composition
  // root hands the real SDK's; tests a fake. Absent: no check is offered.
  checkQueryFn?: QueryFn
  // its bound, overridden (tests)
  checkTimeoutMs?: number
  // The chat's terminal PTYs — optional (default: its own instance over
  // registry/index) so tests that build ServerDeps by hand aren't forced
  // to know about it, same criterion as accountPath/muted below.
  terminals?: TerminalService
  // Ping/pong health interval for /ws/terminal/:id — injectable for tests
  // (default 30_000, see the comment on the route registration below).
  terminalPingMs?: number
  webDist?: string
  accountPath?: string // injectable path for ~/.claude.json (default: the real one, see below) — for tests
  claudeSettingsPath?: string // ~/.claude/settings.json (injectable for tests)
  backupsDir?: string // where settings.json backups go (default <dataDir>/claude-settings-backups)
  // Muted folders (muted.json, already loaded at startup — see index.ts) —
  // GET /api/muted is informational (SettingsPage › Projects, ProjectPage
  // › Settings): a "read-only" decision; changing it at runtime would
  // require re-filtering the already-built index, out of scope here. Edit
  // ~/.silos/muted.json by hand + restart.
  muted?: string[]
  // Automations resident — BOTH optional (same criterion as `terminals`):
  // if not injected, the /api/automations* and /api/hooks/:id routes
  // simply aren't registered (no existing test that doesn't know about
  // them is affected). index.ts always builds them.
  automations?: AutomationsStore
  resident?: Resident
  // WHO gave birth to a session (session-origins.ts) — optional: without
  // it no session carries `origin` and the UI treats them all as the owner's.
  origins?: SessionOriginsStore
  // The Vault (vault.json): optional — without it the /api/vault routes
  // aren't registered and no env credentials are injected.
  vault?: VaultStore
  // The bindings agents propose in their asks on the owner, and what a
  // successful binding save resolves (binding-asks.ts, wired in index.ts
  // over the Plans silo) — optional: without it the Vault lists no asks.
  bindingAsks?: VaultRoutesCtx['bindingAsks']
  // The signer's rows (egress-log.ts) — default <dataDir>/egress when a
  // dataDir is given, none otherwise; and its upstream idle cut (tests).
  egressLog?: EgressLog
  egressIdleMs?: number
  // tests with a 127.0.0.1 upstream inject () => null; production never does
  egressPrivateReason?: (ip: string) => string | null
  // The egress proxy's refusals (egress-log.ts EgressRejectLog) — default
  // <dataDir>/egress when a dataDir is given — and its stable port, shown by
  // GET /api/territory/egress (the proxy itself is started by index.ts).
  egressRejectLog?: EgressRejectLog
  egressProxyPort?: number
  // The agent↔platform state channel (SILOS_AGENT_STATE): optional, same
  // criterion as vault — without it, the console routes inject no state
  // dir either.
  agentState?: AgentStateStore
  // Territory: the per-agent fence the console carries in its --settings —
  // optional, same criterion: without it no console is fenced.
  territory?: {
    fenceFor(agentId: string): FenceOverlay | null
    fenceWhenOn?(agentId: string): FenceOverlay | null
    scopeWhenOn?(agentId: string): FenceScope | null
  }
  // the Silos API URL an engine's console process is told (SILOS_API —
  // OpenCode's) — default http://127.0.0.1:3210, the dev server.
  silosApi?: string
  // each engine's server options, from its runtime's beforeServer
  // (compose.ts Booted.beforeServer, keyed by harness id), handed to its
  // route hooks as ServerHookContext.options (harnesses/<id>/server-hooks.ts;
  // OpenCode's: the reader's own-DB owner and contest list, the version and
  // --auto probes, the console registrar). Absent → the hooks run without
  // them (no OpenCode session is resumed in a console).
  engines?: Partial<Record<HarnessId, unknown>>
  // Messages between agents (messages.ts): optional, same criterion as
  // vault — without it the /api/agents/:id/messages routes aren't
  // registered and needsYou has no message rows.
  messages?: MessageStore
  // OpenCode agents' permission asks (asks-store.ts): optional — without it
  // needsYou has no ask rows and POST /api/asks/... isn't registered.
  asks?: AsksStore
  // The harness (harness.ts): Claude Code's versions per engine + the
  // Settings button that runs `claude update`. Optional, same criterion as
  // support — without it /api/harness* aren't registered.
  harness?: HarnessService
  // The Silo Standard's registry (silos/registry.ts): the silos this Silos
  // knows, with the kernel's status of each. Optional, same criterion as
  // harness — without it GET /api/silos isn't registered.
  siloRegistry?: SiloRegistry
  // POST /api/silos/validate (silos/validator.ts createSiloValidate) —
  // registered with the registry; owner-only.
  siloValidate?: ValidateRoute
  // what the silos read, merged (silos/kernel.ts), what they add to Home
  // (silos/surfaces.ts) and their transition journal — optional with the
  // registry: without them GET /api/silos/:id/records* aren't registered and
  // the board carries no silo rows.
  siloKernel?: SiloKernel
  siloSurfaces?: SiloSurfaces
  siloJournal?: TransitionJournal
  // the v0 actions (silos/actions.ts): set-field, ack, message-agent,
  // resolve, proposals; and the producer's bearer routes
  siloActions?: SiloActions
  // install / approve / reject / uninstall and the operator's store
  // (silos/installer.ts, silos/operator.ts)
  siloInstaller?: SiloInstaller
  siloOperator?: SiloOperatorStore
  // the kernel's relation store (silos/relations.ts); absent = one over siloRegistry.root
  siloRelations?: RelationStore
  // Task mode (task-mode/engine.ts): «Work on this», the task page's wake
  // panel, and «wakes: task» in the set-field answer. Absent: none of it.
  taskMode?: TaskModeEngine
  escalation?: EscalationEngine
  // agent ↔ agent asks: POST /api/tasks/ask(+/answer), GET /api/agents/<self>/asks
  taskAsks?: TaskAsks
  // Materializes a saved responsibility into a real automation, right
  // when it's saved — optional, same criterion: without it, PATCH
  // /api/agents/:id still saves the field, it just doesn't materialize
  // anything (the next resident tick's reconcile is also a no-op then).
  // The heartbeat's clock (heartbeat.ts) and what its verbs write (the
  // considered lines) — optional: without them no heartbeat is reconciled on
  // a PATCH and the heartbeat routes are not registered.
  heartbeats?: HeartbeatClock
  heartbeatStore?: HeartbeatStore
  // the DERIVED control of an agent (control.ts controlOf) — the roster's
  // `controlNow`; and the agent's day on its own (own-turns.ts)
  controlOf?: (agentId: string) => 'told' | 'own'
  ownToday?: (agentId: string, now: number) => OwnTurnsToday | null
  accountResetOf?: (agentId: string) => string | null
  // the proactive mode as the agent's page reads it: the position, the setting, the day's count, what holds
  // it, the connectors a round would have (index.ts proactiveViewOf)
  proactiveView?: (agentId: string, now: number) => unknown
  // the flip to Only when told (routes/agents.ts): supersede its queued
  // wakes, and say what still runs
  flipToTold?: (
    agentId: string,
    name: string,
  ) => { running: Array<{ turnId: string; what: string }>; stillRuns: Array<{ id: string; name: string }>; queued: number }
  liveTurnsOf?: (agentId: string) => Array<{ turnId: string; what: string }>
  // Silos' plugin skills, the source a folder copy is made from (the
  // skills routes' «add», routes/skills.ts) and followed (skill-install.ts):
  // optional, same criterion as vault/context above. index.ts always
  // resolves it to the repo's plugin/skills dir.
  pluginSkillsDir?: string
  // Per-agent bearer tokens (agent-tokens.ts): optional — without it no
  // bearer resolves (any Authorization: Bearer → 401) and the rotate route
  // isn't registered.
  agentTokens?: AgentTokens
  // The owner's private-paths list (territory-store.ts): optional — without
  // it GET/PUT /api/territory aren't registered (Settings hides the section
  // on 404) and /api/agents/:id/territory reports 0 private paths.
  territoryStore?: TerritoryStore
  // The install's settings (platform-settings.ts): the
  // unattended provider. Optional — without it, no /api/settings.
  platformSettings?: PlatformSettingsStore
  // Providers v1: optional with the same criterion as automations/resident
  // — without injecting them, the /api/providers* and /api/accounts*
  // routes aren't registered.
  providers?: ProvidersStore
  accounts?: AccountsService
  // who is on each Claude account right now, from the process table
  // (harnesses/claude-code/account-load.ts) — Home's one line; owner-only.
  accountLoad?: { snapshot(): AccountLoad }
  // a Claude account's 5h/weekly windows (harnesses/claude-code/plan-usage.ts)
  // — the runs-on line's bars; owner-only.
  planUsage?: { get(providerId: string): Promise<PlanUsage | null>; peek?(providerId: string): PlanUsage | null }
  // Injectable fetch for provider verification — tests (and the E2E
  // harness) NEVER touch the real network: they pass a fake. Default: the
  // global fetch.
  verifyFetch?: typeof fetch
  // the live re-reader of every key's model listing (gateway-models.ts) — the refresh route calls it
  gatewayModels?: GatewayModelsRefresher
  // Cabin: the cascade's conversation level + the honest model catalog —
  // BOTH optional (same criterion as automations/resident): without
  // convPrefs, the /api/conversations/:folder/:id/prefs routes aren't
  // registered and the cascade collapses to agent→turn; without catalog,
  // GET /api/models responds honestly empty (models: [], fetchedAt: null)
  // — the UI falls back to its own default.
  convPrefs?: ConversationPrefsStore
  // Durable unread state: "last seen" per conversation — optional (same
  // criterion as convPrefs). Without it, `unread` always comes out false
  // and the PATCH /api/seen route isn't registered (the UI degrades to
  // the long-standing in-memory unread state). See seen-store.ts / unread.ts.
  seen?: SeenStore
  // «New to you» on plan tasks: the owner's read marks — optional, same
  // criterion. Without it no route, and no task ever reads as new.
  taskSeen?: TaskSeenStore
  // The machine's vitals (machine-sampler.ts, GET /api/system): the
  // sampler's directory, the measured filesystem and the server's start —
  // optional, same criterion: without it the route isn't registered.
  machine?: { dir: string; diskPath: string; since: string }
  // The owner's "Seen" on an escalation (needs-you-acks.ts) — optional:
  // without it every escalation stays until the agent writes a newer
  // status, and POST /api/needs-you/ack isn't registered.
  needsYouAcks?: NeedsYouAcksStore
  // What the agents propose and the owner decides (proposals.ts) —
  // optional; without it /api/proposals isn't registered.
  proposals?: ProposalsStore
  // automation templates (automation-templates.ts) — without it, no routes
  automationTemplates?: AutomationTemplates
  // The daily digest (digest-job.ts): its files and the owner's hour —
  // optional; without them /api/digest* isn't registered. The band's Seen
  // rides needsYouAcks (kind `digest`).
  digests?: DigestStore
  notificationPrefs?: NotificationPrefsStore
  // The doorbell's Web Push adapter (web-push.ts) and its devices —
  // optional; without it /api/push* isn't registered.
  push?: { doorbell: WebPushDoorbell; devices: PushSubscriptionsStore }
  // Cross-session addresses (SessionView.peer). Optional — tests and
  // environments without ~/.claude/sessions simply never fill it in.
  peers?: PeerRegistry
  catalog?: ModelCatalog
  // Auto-resume for interactive chats: a durable store of rate-limited
  // interactive turns. Optional (same criterion as automations): without
  // it, the /api/pending-resumes* routes aren't registered and an
  // interactive turn that hits the limit simply fails as before (no honest banner).
  pendingResumes?: PendingResumesStore
  // The resident lives outside buildServer (index.ts builds it with the
  // real cfg.root/cfg.dataDir) but needs the SAME WS broadcast() that
  // server.ts defines below (connected clients are internal state of this
  // function) — passed as a mutable box that server.ts fills in as soon as
  // `broadcast` exists. Without this, resident.ts would have to
  // reimplement its own WS hub, or buildServer would have to stop
  // returning a plain FastifyInstance (breaking every test).
  broadcastBox?: { send: (msg: unknown) => void }
  // Silos ID (silos-id.ts): the one remote sign-in, through the broker.
  // null/undefined = off, NOTHING changes (the usual local token flow).
  silosId?: SilosIdClient | null
  /** the owner's credential reached the API (instance-usage.ts marks the hour) */
  onOwnerActivity?: () => void
  // Injectable clock for the sign-in rate limit (window tests).
  authNow?: () => number
  // Per-login sessions — remote login mints its own session token instead
  // of handing out the static one. Default: an in-memory store (tests);
  // index.ts injects the one persisted to ~/.silos/sessions.json. See session-tokens.ts.
  sessions?: SessionTokenStore
  // A FRESH per-request allowlist: a session whose email leaves it stops
  // working on the next request. Default: the Silos ID client's owner
  // emails (SILOS_OWNER_EMAIL).
  allowlist?: () => string[]
  // The seal (seals.ts): its rows join Needs you and
  // its doors live under /api/seals (owner only). Absent (tests): no seal.
  seals?: Seals
  // The owner's static token as the server holds it NOW — the seal rotates
  // it on a delta (B1-r4). Default: the fixed `token`.
  ownerToken?: () => string
  // The thread machinery (thread-tools.ts, transcript-only.ts):
  // index.ts builds it once, after terminals and origins, and
  // hands the same functions to the task machinery; absent (tests), buildServer
  // makes its own. `announce` is the box buildServer fills in its WS scope
  // (the re-announce of a session whose parent link absorbRotations wrote).
  absorbRotations?: () => void
  threadRootKey?: (m: SessionMeta) => string
  // «which conversation is this session?» (task-threads.ts makeThreadIdOf) —
  // the one resolver chat and the routes share; absent, built here
  threadIdOf?: ThreadIdOf
  transcriptOnly?: TranscriptOnly
  announce?: AnnounceBox
  // the task threads read once per `ttlMs` (index.ts threadsOfTasks): the
  // session → tasks routes (session-tasks.ts) read the CURRENT ids through
  // it; absent, a fresh reading over the index + lineage per request
  threadsOfTasks?: (ttlMs: number) => TaskThreads
  // the kernel kind `process` (silos/processes.ts, the System silo): a
  // conversation's live processes (GET /api/sessions/:folder/:id/processes),
  // the kernel-verb stop-process and the trash's «also stop». Absent: none.
  processes?: Pick<ProcessRecords, 'ofSessions' | 'stopRecord'>
  // the kernel kind `worktree` (silos/worktrees.ts, the System silo): the
  // kernel-verb remove-worktree. Absent: none.
  worktrees?: Pick<WorktreeRecords, 'removeRecord' | 'branchStateFor'>
  // read a silo again when what it presents moved since its last reading
  // (index.ts: the System silo's gauges, at most one scan old) — the records
  // routes call it before they answer
  freshenSilo?: (id: string) => void
  // drop that cache — a claim, a release or a link wrote
  invalidateTaskThreads?: () => void
  // every plan task with its flow now (index.ts — the Plans
  // silo's voice): the inbox's task lines and «N tasks stalled». Absent: none.
  taskFlows?: (now: number) => readonly TaskFlowFact[]
  // what the idle-console row reads beside Task mode's
  // store: a thread live (conversation-live.ts), the 2 h rule, a session's
  // title and folder — composed in index.ts
  conversationFacts?: {
    threadLive: (ids: readonly string[]) => boolean
    busyMs: number
    sessionOf: (id: string) => { title: string | null; folder: string | null } | null
  }
  // the closed plans with how many open tasks each
  // still holds (index.ts — plans-closed.ts). Absent: no row.
  closedPlans?: () => ReadonlyArray<{ key: string; title: string; folder: string | null; file: string; open: number }>
}

export interface SessionView extends SessionMeta {
  // cross-session address: the name Claude Code's ListAgents/SendMessage
  // use for this conversation's RUNNING process ("silos-1f") — read from
  // ~/.claude/sessions (harnesses/claude-code/peer-registry.ts). Absent when no live process
  // holds the session.
  peer?: { name: string; status?: string }
  live: boolean
  worktree: boolean
  agentId: string
  native: boolean
  // Auto-titles: where `title` comes from — the owner's manual rename
  // ('manual'), synthesized by the titler ('auto'), or the parser's first
  // sentence ('raw'). The UI adds no chrome for this: it's informational.
  titleOrigin: 'manual' | 'auto' | 'raw'
  // Lineage: only the IMMEDIATE parent ("folder/id") — the full chain
  // (rotation after rotation, fork after fork) is resolved by the client,
  // walking these links over the sessions it already has in the overview.
  // Absent if this session wasn't born from another (or we don't know it).
  parentKey?: string
  // 'clear' when this session was STARTED by a console `/clear` of its
  // parent: the client shows it as its own conversation, while the live
  // console still follows the whole thread. Absent = a continuation.
  parentKind?: 'clear'
  // Durable unread state: this conversation is "unread" — the agent
  // replied and the owner hasn't opened it since. Derived on the server
  // from mtime + lastRole + seen.json (see unread.ts); false when no
  // SeenStore is wired. This is the source that SURVIVES closing the
  // laptop — the UI distinguishes it from the in-memory unread state
  // (live Pulse). Always present (a boolean, never omitted) so the client
  // never has to default it.
  unread: boolean
  // Birth: present ONLY on a session an automation run opened (the
  // resident records it at chat-init — session-origins.ts). The sidebar
  // files these under their automation instead of the conversation list;
  // Home/⌘K/the agent page keep seeing them. Absent = the owner's own.
  // A NESTED run is the other birth that is not the owner's: a session an
  // agent launched itself (a `claude -p` from Bash) — it presented itself
  // at start (the plugin's birth marker, births-store.ts) and Silos holds
  // no native record of launching it. `parent` is the conversation whose
  // claude ran it (null: unknown — it folds under its agent). Never a
  // sidebar row, never a console; the parent's column lists it.
  // A MESSAGE conversation is the third birth: Silos
  // opened it to work one urgent message (history — t6: no longer born) —
  // it lives in the agent's Messages (a sidebar row only while open or
  // searched, ✉), still continuable, out of unread, the owner's counts and
  // the digest.
  // A TASK conversation is the fourth: Task mode opened it to wake the agent
  // on one task (`task` its record key, `ref` its words) — it lives under
  // that task, out of the owner's conversations, counts and digest.
  origin?:
    | { kind: 'automation'; automationId: string; runId: string }
    | { kind: 'nested'; parent: string | null; agentId: string }
    | { kind: 'message'; messageId: string; from: string; gist: string }
    | { kind: 'task'; task: string; ref: string }
  // Why the run working in this conversation right now was started
  // (Run.cause — run-cause.ts). Absent when no caused run is in flight.
  runCause?: string
}

// a terminal dimension from a query string: an integer in a sane range, or
// the fallback (a hostile/garbage value must not size a PTY to 0 or 10^9).
function clampSize(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 2 || n > 1000) return fallback
  return n
}

// PATH_MAX, URI-encoded (3 bytes per byte at worst)
export const MAX_PATH_PARAM = 4096 * 3

// one process record of a conversation, as its column and the delete dialog read it
export type ConversationProcess = ProcessView & { key: string; stateLabel: string }

export function buildServer(deps: ServerDeps): FastifyInstance {
  const {
    index,
    registry,
    store,
    native,
    lineage,
    peers,
    chat,
    exec,
    complete,
    prefs,
    memory,
    files,
    context,
    executions,
    token,
    liveMs,
    webDist,
    automations,
    resident,
    origins,
    providers,
    accounts,
    convPrefs,
    seen,
    taskSeen,
    needsYouAcks,
    proposals,
    catalog,
    pendingResumes,
    vault,
    agentState,
    territory,
    messages,
    asks,
    harness,
    siloRegistry,
    siloValidate,
    siloKernel,
    siloSurfaces,
    siloJournal,
    siloActions,
    siloInstaller,
    siloOperator,
    siloRelations,
    heartbeats,
    pluginSkillsDir,
    agentTokens,
    territoryStore,
    gatewayModels,
    taskMode,
    escalation,
  } = deps
  const muted = deps.muted ?? []
  const terminals = deps.terminals ?? new TerminalService(registry, index)
  // the registry the chat turns mint into (a hand-built test chat may have none)
  const liveTurns: LiveTurns = deps.liveTurns ?? (chat as Partial<ChatService>).liveTurns ?? new LiveTurns()
  const terminalPingMs = deps.terminalPingMs ?? 30_000
  // THE home this server works in — ONE source for every route that lists,
  // reads or reports under home on the web's behalf (the Files page roots at
  // the home /api/agents reports): the CONFIGURED home (deps.home — cfg.home,
  // SILOS_HOME), never os.homedir() directly. A server on a fixture home (the
  // e2e harness) must neither show, read nor WRITE the machine's real home
  // (~/.claude/settings.json: Settings › Engines saves retention there).
  const machineHome = deps.home ?? homedir()
  const toolHealth = deps.toolHealth ?? (deps.dataDir ? new ToolHealthLedger(join(deps.dataDir, 'tool-health')) : null)
  // «Check now» on a project's Tools: the owner's click, one at a time per folder
  const loadsChecks = deps.checkQueryFn
    ? new LoadsChecks({
        registry: deps.registry,
        queryFn: deps.checkQueryFn,
        home: machineHome,
        ...(deps.providers ? { providers: deps.providers } : {}),
        ...(toolHealth ? { ledger: toolHealth } : {}),
        ...(deps.claudeManagedDir ? { managedDir: deps.claudeManagedDir } : {}),
        ...(deps.agentState ? { agentStateDir: (id: string) => deps.agentState!.pathFor(id) } : {}),
        ...(deps.loadsScopes ? { carriedOf: (id: string, engine: string) => deps.loadsScopes!.payloadOf('agents', id, engine) } : {}),
        ...(deps.accounts ? { loginOf: async (pid: string) => (await deps.accounts!.list()).find((a) => a.providerId === pid)?.email ?? null } : {}),
        ...(deps.checkTimeoutMs !== undefined ? { timeoutMs: deps.checkTimeoutMs } : {}),
      })
    : null
  const claudeSettingsPath = deps.claudeSettingsPath ?? join(machineHome, '.claude', 'settings.json')
  // is the reserve engine WIRED to Silos? (its two hooks in the operator's
  // settings — harnesses/claude-code/settings.ts). Read at most every 10 s.
  // A missing or unreadable file reads as UNWIRED (readClaudeSettings
  // answers {}), and that is the truth: the engine cannot run those hooks
  // either. The catch below is a belt for an fs error thrown outside it.
  let hooksWiredAt = 0
  let hooksWiredLast = true
  const claudeHooksWired = (): boolean => {
    const t = Date.now()
    if (t - hooksWiredAt > 10_000) {
      hooksWiredAt = t
      try {
        const v = readClaudeSettings(claudeSettingsPath)
        hooksWiredLast = v.hooks.briefing === 'installed' && v.hooks.cronGate === 'installed'
      } catch {
        hooksWiredLast = true
      }
    }
    return hooksWiredLast
  }
  const backupsDir = deps.backupsDir ?? join(machineHome, '.silos', 'claude-settings-backups')
  // A route param can be a folder's exact path, URI-encoded (/api/folders/
  // :folder/…): Fastify's default maxParamLength (100)
  // answered 414 for any folder past 100 chars. The bound is PATH_MAX
  // (4096) in its encoded form — every byte may become %XX — and Node's
  // 16 KB header limit still caps the request line above it.
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: MAX_PATH_PARAM } })

  // Who a session "belongs" to: the native-owner override (the agent that
  // created it via Silos) rules over folder-based classification if
  // it's still active; otherwise classify() decides by cwd/skills (and
  // master catches the orphans). Reused by view() and by master's
  // cross-resume guard.
  // The session this one was born from, if any: a console `/clear`
  // rotation recorded in lineage.json (the transcript only says it was a
  // /clear, never of what) or Claude Code's own `--resume` stamp. Lineage first — the stamp
  // names the CONSOLE key (its first session) while lineage names the
  // honest, latest parent. `continuation` restricts it to the same folder:
  // a fork from another project is a different conversation, not this
  // one's past (classification, console reuse); the sidebar chain takes both.
  // WHO a session belongs to, and the walk to its ancestors: ONE rule and
  // ONE walk (session-owner.ts / ancestry.ts), shared with the titler and
  // the resident — index.ts hands the same instance to all three.
  const owners =
    deps.owners ??
    new SessionOwners({
      registry,
      native,
      lineage: lineage ?? null,
      index,
      trashDir: deps.dataDir ? join(deps.dataDir, 'trash') : null,
      births: deps.births ?? null,
    })
  const { ancestorIdsOf, nearestIndexedAncestor } = owners.ancestry
  const metaById = (id: string): SessionMeta | null => index.metaById(id)
  // The history a sidebar row buries with it (Delete): the indexed
  // continuation ancestors of a session — the rotations folded under it as
  // "earlier" and the chain its `/clear` left archived — nearest first.
  // A row is a chain; trashing only its tip left every ancestor on disk, and
  // each one came back as a row of its own ("why do new conversations
  // appear when I delete one?!"). Two things never go with it: an ancestor
  // another surviving session still descends from (its history too — the
  // walk goes THROUGH buried ones, so "needed" covers everything above it),
  // and one the owner detached by drag into a row of its own
  // (prefs.detachedChains), which keeps everything above it as well.
  const THREAD_WALK = 64
  const threadHistoryOf = (m: SessionMeta): SessionMeta[] => {
    const detached = new Set((prefs.read().detachedChains ?? []).map((k) => k.slice(k.lastIndexOf('/') + 1)))
    const chain = ancestorIdsOf(m, true, THREAD_WALK)
    const cut = chain.findIndex((id) => detached.has(id))
    const own = cut === -1 ? chain : chain.slice(0, cut)
    const ownSet = new Set([m.id, ...own])
    const needed = new Set<string>()
    for (const other of index.allSessions()) {
      if (ownSet.has(other.id)) continue
      for (const id of ancestorIdsOf(other, true, THREAD_WALK)) needed.add(id)
    }
    const out: SessionMeta[] = []
    for (const id of own) {
      if (needed.has(id)) continue
      const meta = metaById(id)
      if (meta) out.push(meta)
    }
    return out
  }
  // A console's `/clear` files its rotation for the server to pick up
  // (see LineageStore.absorbRotations) — cheap when the dir is empty, so
  // it runs where the answer matters: the overview and opening a console.
  // set once the WS scope exists: re-announces a session whose parent link
  // just landed (its earlier broadcast carried no parentKey — the sidebar
  // was keeping an orphan twin row until the session's next line).
  // (thread-tools.ts — index.ts hands the shared one; the box is filled
  // in the WS scope below, deferring each send)
  const announce: AnnounceBox = deps.announce ?? { send: () => {} }
  const absorbRotations = deps.absorbRotations ?? makeAbsorbRotations({ lineage, terminals, index, announce })

  // plan files (plans/*.plan.json) an agent's conversations WROTE — by
  // Write/Edit or by naming the path in a command — wherever they live.
  // Authorship over territory: the dossier's plan progress
  // follows the agent, like the conversation's column does.
  const authoredPlanPathsOf = (agentId: string): string[] => {
    const out = new Set<string>()
    for (const m of index.allSessions()) {
      if (classifyAgentId(m) !== agentId) continue
      const files = index.getContext(m.folder, m.id)?.files ?? []
      for (const f of files) {
        if (!f.path.endsWith('.plan.json') || !f.path.includes('/plans/')) continue
        if (f.edits + f.writes + (f.disk ?? 0) > 0) out.add(f.path)
      }
    }
    return [...out]
  }

  const classifyAgentId = (m: SessionMeta): string => owners.agentIdOf(m)

  // The mission view's plan progress (plans-floor.ts planProgressOf): the
  // newest of the agent's folder's plans and of the plans its conversations
  // authored, read from the built-in Plans silo — none while it is not active
  // (the owner uninstalled it: plans leave every surface with it).
  const planProgressFor = (agentId: string) => (folder: string) => {
    const entry = siloRegistry?.get(PLANS_SILO)
    const reading = siloKernel?.reading(PLANS_SILO)
    if (!entry || entry.status.state !== 'active' || !entry.manifest || !reading) return null
    return planProgressOf({ manifest: entry.manifest, reading }, folder, authoredPlanPathsOf(agentId), {
      now: Date.now(),
      isAgent: (v) => registry.list(true).some((a) => a.id === v),
    })
  }

  // Every agent's uncapped totals (session-counts.ts), riding each WS
  // session/removed event: the client's lists are capped, so it can't tell
  // a brand-new session from an old one beyond the cap — the server, which
  // sees them all, hands the numbers over instead of the client guessing.
  const countsNow = (): Record<string, SessionCounts> =>
    Object.fromEntries(
      (() => {
        const all = index.allSessions()
        return countSessions(
          all.map((m) => {
            const born = origins?.get(`${m.folder}/${m.id}`) ?? null
            const nested = born ? null : owners.nestedOf(m)
            return {
              agentId: classifyAgentId(m),
              cwd: m.cwd,
              origin: nested
                ? { kind: 'nested' as const, parent: nested.parent }
                : born?.kind === 'message'
                  ? { kind: 'message' as const }
                  : born?.kind === 'task'
                    ? { kind: 'task' as const }
                    : born,
            }
          }),
          new Set(all.map((m) => m.id)),
        )
      })(),
    )

  // The console key for a session: its own id, unless it CONTINUES a
  // session whose console is still running — then that tmux IS this
  // conversation (a `--resume` fork of it wrote this very file), and a
  // second claude over the same thread would fork yet another file.
  // the key of a thread's ROOT — its topmost known ancestor (indexed or
  // not), the session itself when it has none. "Is this session the
  // thread's tip?" is measured from here (lineage.recentTipOf), never from
  // the nearest live console, which may not exist.
  const threadRootKey = deps.threadRootKey ?? makeThreadRootKey({ ancestry: owners.ancestry, lineage, metaById })
  const threadIdOf = deps.threadIdOf ?? makeThreadIdOf({ lineage, metaById })
  // ONE tmux listing for the whole ancestry (was a probe per ancestor); a
  // listing tmux did not answer finds no console, as a failed probe did
  const consoleKeyFor = async (m: SessionMeta): Promise<string> => {
    const ids = ancestorIdsOf(m, true)
    if (ids.length === 0) return m.id
    const live = new Set((await terminals.listConsoles()).map((c) => c.key))
    for (const id of ids) if (live.has(id)) return id
    return m.id
  }
  // agentId → the id of its not-yet-persisted "new conversation" console
  // (see POST /api/console); archive tears it down with the rest
  const freshConsoles = new Map<string, string>()
  // Each harness's branches of the routes (Harness.server: console open,
  // send, answer, live pin push, models narrowing, its own routes), built
  // on first use over this engine's server options (ServerDeps.engines[id]).
  // An id no harness is registered under has none. Hoisted here with
  // consoleKeyFor (routes/ modules receive it through their ctx).
  const hookContext = (id: HarnessId): ServerHookContext => ({
    deps,
    options: deps.engines?.[id],
    helpers: { consoleKeyFor, classifyAgentId, freshConsoles, prefs, terminals },
  })
  const serverHooks = new Map<HarnessId, HarnessServerHooks>()
  const hooks = (id: HarnessId): HarnessServerHooks => {
    const h = findHarness(id)
    if (!h) return {}
    let built = serverHooks.get(h.id)
    if (!built) {
      built = h.server?.(hookContext(h.id)) ?? {}
      serverHooks.set(h.id, built)
    }
    return built
  }

  // ONE rule for both engines (console route, chat-turn route): a session
  // that someone other than the owner gave birth to is a transcript.
  //  · an automation run: a --resume would make the run one of the owner's
  //    threads (and spawn a claude nobody is driving);
  //  · a nested run (births — an agent's own `claude -p`): likewise.
  // The 409 body names which, so the client goes read-only at once and
  // names the automation / the conversation that ran it.
  // (transcript-only.ts — index.ts hands the shared one)
  const transcriptOnly = deps.transcriptOnly ?? makeTranscriptOnly({ origins, owners })

  // resolve: manual > auto > raw precedence (session-store.titleResolver) —
  // a caller that walks many sessions (overview/board) creates ONE resolver
  // and passes it in; the default (one read per call) is for single-session routes.
  // causeOf: runCauseFor by default (one scan for one session); a caller
  // walking every session (overview) passes ONE runCauseIndex instead.
  type CauseOf = (sessionId: string, born: { automationId: string; runId: string } | null) => string | null
  const view = (m: SessionMeta, now: number, resolve = store.titleResolver(), causeOf?: CauseOf): SessionView => {
    const agentId = classifyAgentId(m)
    const { title, origin } = resolve(m.folder, m.id, m.title)
    // lineage.json (Silos' own forks/rotations) first, then the transcript's
    // own word: Claude Code stamps a `--resume` fork with its origin. The
    // parent handed to the client is the NEAREST ancestor indexed NOW,
    // placed in the folder it lives in NOW: a worktree relocation moves a
    // transcript between folders, and a trashed ancestor leaves the chain
    // — a key the client can't match split one console into two sidebar
    // rows. No ancestor left: an honest root.
    const parent = nearestIndexedAncestor(m, false)
    const parentKey = parent ? `${parent.folder}/${parent.id}` : null
    // how it was born from that parent: a console `/clear` is a NEW
    // conversation (its own sidebar row), anything else continues the
    // parent (one row, the tip). The hook's record, or the transcript's own
    // "SessionStart:clear" stamp for links filed before the record existed.
    const cleared = parentKey !== null && (lineage?.isClear(m.id) || m.startedByClear === true)
    const p = peers?.bySession().get(m.id)
    const peer = p ? { name: p.name, ...(p.status !== undefined ? { status: p.status } : {}) } : null
    const birth = origins?.get(`${m.folder}/${m.id}`) ?? null
    const born = birth?.kind === 'automation' ? birth : null
    const byMessage = birth?.kind === 'message' ? birth : null
    const byTask = birth?.kind === 'task' ? birth : null
    const nested = birth ? null : owners.nestedOf(m)
    // a run's cause
    const runCause = automations ? (causeOf ? causeOf(m.id, born) : runCauseFor(m.id, born, automations)) : null
    return {
      ...m,
      title,
      titleOrigin: origin,
      ...(born ? { origin: { kind: 'automation' as const, automationId: born.automationId, runId: born.runId } } : {}),
      ...(byMessage ? { origin: { kind: 'message' as const, messageId: byMessage.messageId, from: byMessage.from, gist: byMessage.gist } } : {}),
      ...(byTask ? { origin: { kind: 'task' as const, task: byTask.task, ref: byTask.ref } } : {}),
      ...(nested ? { origin: { kind: 'nested' as const, parent: nested.parent, agentId: nested.agentId } } : {}),
      live: now - m.mtime < liveMs || conversationWorking(m, now, liveMs), // the agents' liveCount; the same rule as the web's lib/live.ts
      worktree: m.cwd?.includes('/.claude/worktrees/') ?? false,
      agentId,
      native: native.isNative(m.folder, m.id),
      // Durable unread state: same in-memory pass as the rest of the
      // overview (seen.get is a cheap Map lookup) — an honest false without a SeenStore.
      // a message conversation works for its sender, not for you: never unread
      unread: seen && !byMessage ? isUnread(m.lastRole, m.mtime, seen.get(m.folder, m.id)) : false,
      ...(parentKey !== null ? { parentKey } : {}),
      ...(cleared ? { parentKind: 'clear' as const } : {}),
      ...(peer ? { peer } : {}),
      ...(runCause !== null ? { runCause } : {}),
    }
  }

  // Cross-session link: when serving turns, each third-voice message's
  // (interSession) sender is resolved to a known, non-archived agent,
  // attaching its `agentId` so the UI can link to the SENDER's dossier.
  // Honest: it doesn't jump to the exact source thread (the message
  // carries no session_id — data the harness doesn't provide today). No
  // match → the turn is left intact (plain text, no link). Done here (not
  // in the parser: the parser doesn't know about the agent registry) and
  // on every read (resolution is cheap and reflects the registry's live state).
  const enrichInterSession = (t: TranscriptTurn): TranscriptTurn => {
    if (!t.interSession) return t
    const agentId = registry.resolveSender(t.interSession.from)
    if (!agentId) return t
    return { ...t, interSession: { ...t.interSession, agentId } }
  }

  // Silos ID login + sessions (opt-in) — deps shared between the guard and
  // the /api/auth/* routes below.
  const silosId = deps.silosId ?? null
  const sessions = deps.sessions ?? new SessionTokenStore()
  const allowlist = deps.allowlist ?? (() => silosId?.ownerEmails ?? [])
  const ownerToken = deps.ownerToken ?? (() => token)
  const isEmailAllowed = (email: string): boolean => allowlist().some((e) => e.toLowerCase() === email.toLowerCase())

  // Auth is only required for REMOTE requests — detected PER REQUEST, not
  // by binding. A critical subtlety: the owner serves Silos online with
  // CLOUDFLARED, and the server keeps listening on 127.0.0.1 with the
  // tunnel forwarding over loopback — "no auth if the binding is loopback"
  // would leave the tunnel WIDE OPEN. The per-request rule: it's LOCAL
  // only if the Host is loopback AND NO forwarding/tunnel header is
  // present (cloudflared always adds CF-Connecting-IP/CF-Ray and
  // X-Forwarded-*; a remote client can't strip them because the tunnel
  // itself adds them, not the client).
  //
  // Honesty of the model: this trusts headers. A LOCAL process could
  // fabricate a "local" request — but that process already has the
  // loopback socket and the user's files: it's within the usual trust
  // boundary (the same one as the token in ~/.silos/token, which it can
  // already read). The real vector this rule closes is remote-via-tunnel,
  // and that one can't strip the headers. The Host check also blocks
  // classic DNS rebinding (evil.com → 127.0.0.1 arrives with Host:
  // evil.com → auth required).
  // x-real-ip and true-client-ip are included even though cloudflared and
  // Caddy are already caught by their other headers — an nginx-only proxy
  // that sends only X-Real-IP + Host: localhost, with no X-Forwarded-* at
  // all, would classify Internet traffic as local. The coverage is "any
  // proxy", not just the two documented ones: the presence of ANY of them ⇒ remote.
  const FORWARDING_HEADERS = [
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'cf-connecting-ip',
    'cf-ray',
    'forwarded',
    'x-real-ip',
    'true-client-ip',
  ] as const
  const HOST_LOCAL = /^(127\.0\.0\.1|localhost)(:\d+)?$/i
  // Cross-origin guard (CSWSH / localhost CSRF). The Host + forwarding-header
  // rule below distinguishes "arrived via tunnel/proxy" from "arrived on the
  // machine" — but it CANNOT distinguish "the Silos SPA is asking" from "some
  // OTHER website the user has open is asking": a page on evil.com can
  // `fetch('http://127.0.0.1:3210/...')` or open `new WebSocket('ws://127.0.0.1:3210/ws')`,
  // and the request reaches us with Host: 127.0.0.1 and no forwarding headers —
  // indistinguishable from the real SPA on the transport layer. WebSocket
  // message delivery is NOT subject to CORS, so such a page could read the live
  // event stream (transcripts hold secrets) and, since the console key IS the
  // session id broadcast over /ws, attach to the live tmux console and write to
  // its PTY → RCE. The one header that DOES tell the two apart is Origin, which
  // browsers always send on cross-origin fetch/XHR and on every WS handshake.
  // So: a request that carries a NON-loopback Origin never gets the no-token
  // local bypass (it still works if it carries a valid token/session). Requests
  // with no Origin (curl, server-to-server, the cloudflared tunnel — already
  // caught by the forwarding-header check anyway) are unaffected. A remote page
  // cannot forge a loopback Origin; a local process on another loopback port is
  // already inside the trust boundary (it can read ~/.silos/token).
  const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])$/i
  const isTrustedOrigin = (origin: string): boolean => {
    try {
      return LOOPBACK_HOST.test(new URL(origin).hostname)
    } catch {
      return false // 'null', malformed, or otherwise unparseable ⇒ untrusted
    }
  }
  // The Host header is the CLIENT's to write: bound on 0.0.0.0 (SILOS_HOST in
  // a container — Railway's private network, a bare `docker run -p`), a
  // direct client could send `Host: 127.0.0.1` with no forwarding header and
  // read as the owner. So the socket's peer must be loopback too — the one
  // fact a remote client cannot forge. On the default 127.0.0.1 binding every
  // peer is loopback and nothing changes.
  const LOOPBACK_PEER = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i
  const isLocalRequest = (req: FastifyRequest): boolean => {
    if (!LOOPBACK_PEER.test(req.socket?.remoteAddress ?? '')) return false
    if (!HOST_LOCAL.test(req.headers.host ?? '')) return false
    for (const h of FORWARDING_HEADERS) {
      if (req.headers[h] !== undefined) return false
    }
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '' && !isTrustedOrigin(origin)) return false
    return true
  }

  const authed = (req: FastifyRequest): boolean => {
    const q = (req.query as Record<string, unknown>)?.token
    const h = req.headers['x-token']
    const t = (typeof h === 'string' ? h : typeof q === 'string' ? q : '').trim()
    // Constant-time, same criterion as resident.ts's secretsMatch — the
    // global token protects all of /api/* and /ws*, the same consistency
    // as the hook secret. The static file token ALWAYS works (a manual
    // escape hatch, local or remote — the long-standing ?token= flow).
    if (secretsMatch(ownerToken(), t)) return true
    // Per-login sessions: a session token is valid if (1) Silos ID login is
    // still configured, (2) it hasn't expired, and (3) its email is STILL
    // on the allowlist — re-read per request.
    if (!silosId || t === '') return false
    const session = sessions.validate(t)
    return session !== null && isEmailAllowed(session.email)
  }

  // The agent an `Authorization: Bearer` names: undefined = no bearer at
  // all; null = a bearer that names no live agent. The SCHEME alone
  // decides: `Bearer` with an empty credential is an invalid agent token,
  // never a fall-through to anything else. Only a LIVE agent speaks: a token
  // whose agent is archived or no longer in the registry is refused like
  // any unknown one — checked on every request, so archiving by any path
  // (route, PATCH, a hand edit of agents.json) takes effect at once.
  const bearerOf = (req: FastifyRequest): string | null | undefined => {
    const authz = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : ''
    if (!/^Bearer\b/i.test(authz)) return undefined
    const bearer = authz.slice('Bearer'.length).trim()
    const resolved = bearer === '' ? null : (agentTokens?.agentIdOf(bearer) ?? null)
    const live = resolved === null ? null : registry.get(resolved)
    return live && !live.archived ? resolved : null
  }

  // The 401 of a write (or websocket upgrade) with no identity — the error
  // itself teaches the way.
  const READS_NEED_IDENTITY =
    'this read needs an identity — the owner: x-token (or ?token=) with the token in ~/.silos/token, or open Silos from the link the server prints at start; an agent: Authorization: Bearer $SILOS_AGENT_TOKEN'
  const WRITES_NEED_IDENTITY =
    'writes need an identity — the owner: x-token (or ?token=) with the token in ~/.silos/token, or open Silos from the link the server prints at start; an agent: Authorization: Bearer $SILOS_AGENT_TOKEN'

  // Liveness probe for PaaS/containers (Railway healthcheck, docker
  // HEALTHCHECK). Outside /api on purpose: public, no auth, reveals nothing.
  // From this machine (a local request: loopback Host, no tunnel headers) it
  // also carries the event loop's stalls — numbers only (loop-stalls.ts), so
  // a frozen console is diagnosed with one curl.
  app.get('/healthz', async (req) => (deps.loopStalls && isLocalRequest(req) ? { ok: true, loop: deps.loopStalls.snapshot() } : { ok: true }))

  // A rejected websocket upgrade must be cut at the socket (see the comment
  // at the end of the hook below); a short raw HTTP response goes out first
  // so the client learns why.
  const refuseUpgrade = (reply: FastifyReply, req: FastifyRequest, status: 400 | 401 | 403, body: { error: string }): void => {
    reply.hijack()
    const json = JSON.stringify(body)
    const text = status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : 'Forbidden'
    const sock = req.raw.socket
    try {
      sock.write(
        `HTTP/1.1 ${status} ${text}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
      )
    } catch {
      /* socket already gone */
    }
    sock.destroy()
  }

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // An absolute-form target (`GET http://host/api/agents`) is routed by
    // find-my-way as `/api/agents`, but every check below reads req.url —
    // which then doesn't start with /api and skipped auth. Origin-form only.
    if (!req.url.startsWith('/')) {
      if ((req.headers.upgrade ?? '').toLowerCase() === 'websocket') return refuseUpgrade(reply, req, 400, { error: 'malformed path' })
      return reply.code(400).send({ error: 'malformed path' })
    }
    // ONE canonical path for every check below. Fastify routes on the
    // DECODED path (`/%61pi/agents` reaches `/api/agents`), so deciding on
    // the raw url let an encoded character skip auth entirely. Each segment
    // is decoded, then re-encoded canonically: `/%61pi` → `/api`, while a
    // decoded `?`, `/` or `%` stays escaped (agent-authz.ts denies those).
    // A segment that doesn't decode → 401, before anything else.
    let path: string
    try {
      path = (req.url.split('?')[0] ?? '')
        .split('/')
        .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
        .join('/')
    } catch {
      if ((req.headers.upgrade ?? '').toLowerCase() === 'websocket') return refuseUpgrade(reply, req, 401, { error: 'malformed path' })
      return reply.code(401).send({ error: 'malformed path' })
    }
    if (!path.startsWith('/api/') && !path.startsWith('/ws')) return
    // The resident's webhook has its OWN auth (an x-hook-secret header, per
    // automation) — it stays OUTSIDE the global token on purpose ("no
    // global token — the secret IS the auth").
    if (path.startsWith('/api/hooks/')) return
    // Sign-in: /api/auth/* is public BY DESIGN — the login screen needs to
    // know whether login is enabled (config) and to run the Silos ID round
    // trip BEFORE having a token. Those routes carry their own rate limit
    // and full cryptographic verification (silos-id.ts); config never
    // exposes the allowed emails or the token.
    if (path.startsWith('/api/auth/')) return
    // Agent identity: a request carrying `Authorization: Bearer <t>` is an
    // AGENT speaking (agent-tokens.ts), wherever it comes from — loopback
    // included. A bearer that resolves to no agent is refused outright (an
    // agent with a stale token must not silently become the owner), and an
    // agent never falls through to the owner rules below: reads go through
    // agentMayRead, writes through agentMayWrite (agent-authz.ts).
    // The SCHEME alone decides: `Bearer` with an empty credential (what curl
    // sends when $SILOS_AGENT_TOKEN is unset) is an invalid agent token,
    // never a fall-through to the owner.
    const isUpgrade = (req.headers.upgrade ?? '').toLowerCase() === 'websocket'
    // write-class: a mutating verb, or ANY verb on the signer's route
    // (/api/egress/…) — a signed GET acts with a
    // credential, so it never rides the local read-without-token exception
    const writeClass = isWriteClass(req.method, path)
    const bearerAgent = bearerOf(req)
    if (bearerAgent !== undefined) {
      const agentId = bearerAgent
      if (agentId === null) {
        if (isUpgrade) return refuseUpgrade(reply, req, 401, { error: 'invalid agent token' })
        return reply.code(401).send({ error: 'invalid agent token' })
      }
      // WebSocket endpoints carry writes (terminal input, chat) and agents
      // never need them (the plugin speaks curl): an agent never opens one.
      if (isUpgrade) return refuseUpgrade(reply, req, 403, { error: `agent ${agentId} may not open a websocket` })
      req.agentId = agentId
      if (writeClass && !agentMayWrite(agentId, req.method, path)) {
        return reply.code(403).send({ error: `agent ${agentId} may not ${req.method} ${path}` })
      }
      // reads: agents are not general readers of owner surfaces (board,
      // transcripts, files, vault…) — agentMayRead (agent-authz.ts).
      if (!writeClass && (req.method === 'GET' || req.method === 'HEAD') && !agentMayRead(agentId, path)) {
        return reply.code(403).send({ error: `agent ${agentId} may not read ${path}` })
      }
      return
    }
    // The OWNER is whoever carries the owner's credential — the static token
    // (x-token / ?token=) or a login session — local or remote alike.
    if (authed(req)) {
      req.ownerCredential = true
      deps.onOwnerActivity?.()
      return
    }
    // Nobody is the owner by default: a genuinely
    // LOCAL request (loopback Host, zero forwarding headers — see
    // isLocalRequest above) with no credential is UNKNOWN. Any process on the
    // machine can make one — an agent's shell with its bearer left out
    // included — so it reads only the few routes a session with no identity
    // needs (anonymousMayRead, agent-authz.ts: the roster and a
    // conversation's tasks); every other read, every write and every
    // websocket upgrade (terminal input, chat) needs an identity: 401 that
    // teaches the way. Anything arriving via tunnel/proxy/public host still
    // requires auth.
    if (isLocalRequest(req)) {
      if (!writeClass && !isUpgrade && (req.method === 'GET' || req.method === 'HEAD') && anonymousMayRead(path)) return
      if (!writeClass && !isUpgrade) return reply.code(401).send({ error: READS_NEED_IDENTITY })
      if (isUpgrade) return refuseUpgrade(reply, req, 401, { error: WRITES_NEED_IDENTITY })
      return reply.code(401).send({ error: WRITES_NEED_IDENTITY })
    }
    // A websocket upgrade request rejected here never goes through
    // @fastify/websocket's onRequest/onResponse (which only
    // marks/destroys the raw socket when request.ws=true) because this
    // hook — registered directly on the root instance — runs earlier in
    // the chain and cuts the cycle short. Without this, the raw socket
    // stays open (keep-alive) and app.close() hangs waiting for that
    // connection to end.
    if (isUpgrade) {
      reply.hijack()
      req.raw.socket.destroy()
      return
    }
    return reply.code(401).send({ error: 'invalid token' })
  })

  // The turn of a bearer write: every write an agent
  // may make (agentMayWrite, checked above) names the turn it comes from —
  // `"turn": "$SILOS_TURN"` in its JSON body, or the x-silos-turn header on a
  // DELETE — and the token, which only Silos hands out, gives its class.
  // Here, after the body is parsed and before any route: another agent's
  // token 403; unknown/absent 400 with something of the agent live, 403
  // with nothing live — never guessed, never «attended» by default (G2).
  // The token leaves the body here, so no route ever stores it.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.agentId === undefined || !agentWriteNeedsTurn(req.method, req.url)) return
    // a signed call's body is the service's: its turn rides x-silos-turn
    const named = turnOfRequest(req.method, req.body, req.headers as Record<string, unknown>, isEgressPath(req.url))
    const c = liveTurns.classify(req.agentId, named)
    if (!c.ok) return reply.code(c.code).send({ error: c.error })
    req.turn = c.turn
    if (typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)) delete (req.body as Record<string, unknown>).turn
  })

  // Who THIS request is, by its own credential —
  // public like the rest of /api/auth/*: the browser's AuthGate asks it to
  // decide between the app and «Pair this browser». Never says more than
  // the identity the caller already holds.
  app.get('/api/auth/me', async (req: FastifyRequest) => {
    const agent = bearerOf(req)
    if (agent !== undefined) return { who: agent === null ? 'unknown' : `agent:${agent}` }
    return { who: authed(req) ? 'owner' : 'unknown' }
  })

  // ——— sign-in config (Silos ID or nothing) ———
  // Without Silos ID: config responds {enabled:false} — the local token flow
  // (?token= in the URL the server prints) remains the only remote auth.
  // The ?token= hatch works WITH Silos ID too: the manual escape hatch.
  const loginLimiter = new LoginRateLimiter(10, 60_000, deps.authNow ?? Date.now)

  app.get('/api/auth/config', async () => (silosId ? { enabled: true, mode: 'silos-id' } : { enabled: false }))

  // ——— Silos ID (opt-in, see silos-id.ts) ———
  // start: a single-use state bound to this browser by an HttpOnly cookie,
  // then off to the broker. callback: the broker's pass, verified here
  // (signature against the broker's JWKS, iss, aud = this instance, exp,
  // nonce = the state, email_verified) and the email against the allowed
  // set; then a 7-day session (session-tokens.ts). The browser lands
  // in the app with the session in the URL FRAGMENT (never sent to a server
  // or a log) — the web stores it like ?token=.
  const BIND_COOKIE = 'silos_id_bind'
  const bindCookie = (value: string, maxAge: number): string =>
    `${BIND_COOKIE}=${value}; Path=/api/auth/silos-id; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${silosId?.publicOrigin.startsWith('https:') ? '; Secure' : ''}`
  const landWithError = (reply: FastifyReply, msg: string): FastifyReply =>
    reply
      .code(302)
      .header('cache-control', 'no-store')
      .header('location', `/#${new URLSearchParams({ 'silos-id-error': msg }).toString()}`)
      .send()

  app.get('/api/auth/silos-id/start', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!silosId) return reply.code(404).send({ error: 'Silos ID login not configured' })
    if (!loginLimiter.allow(req.ip)) return landWithError(reply, 'too many sign-in attempts — wait a minute')
    const pick = readSignInPick(req.query as Record<string, unknown>)
    if (pick === null) return landWithError(reply, 'that email address doesn’t look right — check it and send the link again')
    try {
      const { location, bind } = await silosId.start(pick)
      return reply.code(302).header('cache-control', 'no-store').header('set-cookie', bindCookie(bind, 600)).header('location', location).send()
    } catch (err) {
      return landWithError(reply, err instanceof Error ? err.message : 'Silos ID is unreachable')
    }
  })

  app.get('/api/auth/silos-id/callback', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!silosId) return reply.code(404).send({ error: 'Silos ID login not configured' })
    reply.header('set-cookie', bindCookie('', 0)) // the binding is single use too
    if (!loginLimiter.allow(req.ip)) return landWithError(reply, 'too many sign-in attempts — wait a minute')
    const q = req.query as Record<string, unknown>
    const pass = typeof q.pass === 'string' ? q.pass : ''
    const state = typeof q.state === 'string' && STATE.test(q.state) ? q.state : null
    const bind = cookieOf(req.headers.cookie, BIND_COOKIE) ?? ''
    if (!state || pass === '') return landWithError(reply, 'malformed sign-in — start again')
    try {
      const who = await silosId.complete(pass, state, bind)
      if (!isEmailAllowed(who.email)) return landWithError(reply, `${who.email} is not authorized on this Silos`)
      const sessionToken = sessions.issue(who.email)
      const frag = new URLSearchParams({
        'silos-id': sessionToken,
        email: who.email,
        ...(who.name ? { name: who.name } : {}),
        ...(who.picture ? { picture: who.picture } : {}),
      })
      return reply.code(302).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('location', `/#${frag.toString()}`).send()
    } catch (err) {
      return landWithError(reply, err instanceof Error ? err.message : 'invalid Silos ID pass')
    }
  })

  // Sign out with REAL revocation: deletes the session on the server — the
  // token stops working right then, not just in the browser's localStorage.
  // Public like the rest of /api/auth/* (revoking requires KNOWING the
  // token — whoever has it already owns the session; there's no oracle:
  // the response is 200 whether it exists or not). The static token is
  // never revoked through here.
  app.post('/api/auth/logout', async (req: FastifyRequest) => {
    const h = req.headers['x-token']
    const body = req.body as { token?: unknown } | null
    const t = (typeof h === 'string' ? h : body && typeof body.token === 'string' ? body.token : '').trim()
    if (t !== '' && !secretsMatch(ownerToken(), t)) sessions.revoke(t)
    return { ok: true }
  })

  type SessionParams = { folder: string; id: string }
  const validParams = (p: SessionParams, reply: FastifyReply): boolean => {
    if (PARAM.test(p.folder) && PARAM.test(p.id) && !PURE_DOTS.test(p.folder) && !PURE_DOTS.test(p.id)) return true
    void reply.code(400).send({ error: 'invalid params' })
    return false
  }

  // The conversations' surface — moved to routes/sessions.ts.
  // the three positions of the control: told ·
  // own · proactive — derived (control.ts positionOf), never stored
  const positionNow = (agentId: string): 'told' | 'own' | 'proactive' => {
    const a = registry.get(agentId)
    return a ? positionOf(a, territoryStore ? territoryStore.isEnabled(agentId) : false) : 'told'
  }
  // A conversation's processes (the System silo's kernel kind `process`):
  // the live records of its whole thread (conversation-thread.ts — the same
  // resolution the engine attributes by), each with its record key and its
  // state said in the System manifest's words; and the ONE engine call that
  // stops a record (the kernel-verb stop-process, the trash's «also stop»),
  // its event in the record's story.
  const conversationProcesses = deps.processes
    ? ((src) => ({
        of: (m: SessionMeta): ConversationProcess[] => {
          const { ids } = conversationThread(m, { metas: index.allSessions(), lineage, ancestry: owners.ancestry })
          const label = processStateLabels()
          return src.ofSessions(ids).map((v) => ({ ...v, key: `${PLATFORM_LOCATION}/${v.id}`, stateLabel: label(v.state) }))
        },
        stop: async (recordId: string, by: string): Promise<StopResult> => {
          const r = await src.stopRecord(recordId, { by })
          if (r.ok) {
            try {
              siloActions?.noteKernelVerb(PROCESS_SILO, recordId, 'stop-process', by, r.value.says)
            } catch {
              /* the stop happened; its event is best-effort */
            }
          }
          return r
        },
      }))(deps.processes)
    : undefined
  // the System manifest's plain words for a state («left running»)
  function processStateLabels(): (state: string) => string {
    const m = siloRegistry?.get(PROCESS_SILO)?.manifest as
      { spec?: { kinds?: Record<string, { states?: Array<{ value?: unknown; label?: { one?: unknown } }> }> } } | null | undefined
    const states = m?.spec?.kinds?.process?.states ?? []
    const words = new Map(
      states.flatMap((st) => (typeof st.value === 'string' && typeof st.label?.one === 'string' ? [[st.value, st.label.one] as [string, string]] : [])),
    )
    return (state) => words.get(state) ?? state
  }
  // the silo route notes its own event (SiloActions.kernelVerb): the engine call alone here
  const kernelVerbs: Record<string, KernelVerbImpl> = {
    ...(conversationProcesses
      ? {
          'stop-process': async (recordId: string, by: string) => {
            const r = await deps.processes!.stopRecord(recordId, { by })
            return r.ok ? { ok: true as const, value: { ...r.value } } : r
          },
        }
      : {}),
    ...(deps.worktrees
      ? {
          'remove-worktree': async (recordId: string, by: string) => {
            const r = await deps.worktrees!.removeRecord(recordId, { by })
            return r.ok ? { ok: true as const, value: { ...r.value } } : r
          },
        }
      : {}),
  }
  sessionRoutes(app, {
    ...(toolHealth ? { toolHealth } : {}),
    index,
    store,
    registry,
    owners,
    lineage,
    native,
    chat,
    terminals,
    threadIdOf,
    dataDir: deps.dataDir,
    accounts,
    messages,
    pendingResumes,
    automations,
    executions,
    hooks,
    view,
    validParams,
    threadHistoryOf,
    threadRootKey,
    enrichInterSession,
    absorbRotations,
    countsNow,
    consoleKeyFor,
    classifyAgentId,
    ...(peers ? { peers } : {}),
    broadcast: (m) => broadcast(m),
    claudeSettingsPath,
    backupsDir,
    webDist,
    home: machineHome,
    ...(deps.controlOf ? { controlOf: deps.controlOf, positionOf: positionNow } : {}),
    ...(conversationProcesses ? { processes: conversationProcesses } : {}),
    ...(deps.worktrees ? { worktrees: deps.worktrees } : {}),
  })

  // Roster/projects/muted/prefs + MCP states — moved to routes/workspace.ts.
  // the provider a login (email) runs under: an account plugin's projected
  // weight is asked on its own login (unknown: the machine's own)
  const providerOfLogin =
    deps.accounts && deps.providers
      ? async (login: string | null): Promise<ResolvedProvider | null> => {
          if (login === null) return null
          const view = (await deps.accounts!.list()).find((a) => a.email === login)
          return view ? deps.providers!.resolve(view.providerId) : null
        }
      : undefined
  // ONE conversation as a place of «Where it loads» (conversation-places.ts):
  // the session the web holds → its thread (the server's own resolver), its
  // agent and the thread's sessions; a page's conversations that keep an entry
  const conversationPlaces = deps.loadsScopes
    ? makeConversationPlaces({
        metaById,
        allSessions: () => index.allSessions(),
        threadIdOf,
        agentOf: (m) => {
          const id = owners.agentIdOf(m)
          return registry.get(id) ? id : null
        },
        kept: () => deps.loadsScopes!.kept('conversations').map((k) => ({ thread: k.id, oldest: k.oldest })),
      })
    : null
  // Silos' held store of a folder's own skill copies — a bulk click on
  // Skills moves them out and back at the project's place (loads-bulk.ts);
  // a refusal of the move is the click's 409, in the store's own words
  const skillStore = deps.dataDir
    ? ((dataDir: string) => {
        const refused = (fn: () => void): void => {
          try {
            fn()
          } catch (err) {
            throw new LoadsSwitchError(err instanceof Error ? err.message : String(err), 409)
          }
        }
        return {
          held: (folder: string) => heldSkillNames(dataDir, folder),
          hold: (folder: string, name: string) => refused(() => holdSkill(dataDir, folder, name)),
          activate: (folder: string, name: string) => refused(() => activateSkill(dataDir, folder, name)),
        }
      })(deps.dataDir)
    : null
  workspaceRoutes(app, {
    instructions: () => memory.instructionsDeps(),
    ...(skillStore ? { skillStore } : {}),
    threadOf: (id) => threadIdOf(id),
    ...(conversationPlaces ? { conversationOf: conversationPlaces.conversationOf, threadsHere: conversationPlaces.threadsHere } : {}),
    registry,
    index,
    prefs,
    muted,
    claudeManagedDir: deps.claudeManagedDir,
    home: machineHome,
    ...(accounts ? { loginDirs: () => accounts.configDirs().map((c) => c.configDir), followMachine: () => accounts.follow() } : {}),
    ...(harness ? { harness } : {}),
    ...(providerOfLogin ? { providerOfLogin } : {}),
    ...(toolHealth ? { toolHealth } : {}),
    ...(loadsChecks ? { checks: loadsChecks } : {}),
    ...(agentState ? { agentState } : {}),
    ...(deps.loadsScopes ? { loadsScopes: deps.loadsScopes } : {}),
    ...(deps.controlOf ? { controlOf: deps.controlOf, positionOf: positionNow } : {}),
  })

  // Memories panel + file browser — moved to routes/files.ts.
  fileRoutes(app, { memory, files, index, owners })

  // The agents' own surface — moved to routes/agents.ts.
  agentRoutes(app, {
    ...(toolHealth ? { toolHealth } : {}),
    registry,
    index,
    owners,
    origins,
    context,
    native,
    threadIdOf,
    complete,
    chat,
    agentState,
    agentTokens,
    territory,
    territoryStore,
    heartbeats,
    automations,
    resident,
    needsYouAcks,
    pluginSkillsDir,
    providers,
    terminals,
    freshConsoles,
    classifyAgentId,
    planProgressFor,
    validParams,
    hooks,
    hookContext,
    broadcast: (m) => broadcast(m),
    home: machineHome,
    dataDir: deps.dataDir,
    vault,
    claudeManagedDir: deps.claudeManagedDir,
    ...(deps.platformSettings ? { startingSettings: deps.platformSettings } : {}),
    ...(deps.flipToTold ? { flipToTold: deps.flipToTold } : {}),
    ...(proposals ? { proposals } : {}),
  })
  if (deps.heartbeatStore && automations && resident) {
    heartbeatRoutes(app, {
      registry,
      automations,
      resident,
      chat,
      store: deps.heartbeatStore,
      ownToday: deps.ownToday ?? (() => null),
      ...(deps.accountResetOf ? { accountResetOf: deps.accountResetOf } : {}),
      ...(deps.proactiveView ? { proactiveView: deps.proactiveView } : {}),
      liveTurnsOf: deps.liveTurnsOf ?? (() => []),
      ...(deps.initiative ? { initiative: deps.initiative.initiative } : {}),
    })
  }
  // Usage: the owner's read of what the fleet spent
  if (deps.usage) usageRoutes(app, { usage: deps.usage })
  if (deps.vitals) vitalsRoutes(app, { vitals: deps.vitals })
  // what agents create on their own: Undo, the blessings, Restore
  if (deps.initiative && automations) initiativeRoutes(app, { initiative: deps.initiative.initiative, origins: deps.initiative.origins, automations })

  // The skills surface — moved to routes/skills.ts.
  skillRoutes(app, {
    complete,
    registry,
    index,
    pluginSkillsDir,
    dataDir: deps.dataDir,
    switchSkill: (folder, harnessId, target, to, at) =>
      switchFolderSkill(
        {
          index,
          registry,
          home: machineHome,
          ...(deps.claudeManagedDir ? { managedDir: deps.claudeManagedDir } : {}),
          configDirs: () => deps.accounts?.configDirs().map((c) => c.configDir) ?? [],
          ...(deps.loadsScopes ? { loadsScopes: deps.loadsScopes } : {}),
        },
        folder,
        harnessId,
        target,
        to,
        at,
      ),
    ...(deps.accounts ? { followMachine: () => deps.accounts!.follow() } : {}),
    ...(conversationPlaces ? { conversationOf: conversationPlaces.conversationOf } : {}),
  })

  // Board dimension — a single pass over
  // index.allSessions()+getContext() (already in memory, no per-session
  // fetches) to derive each conversation's real state. See board.ts
  // (boardCardOf/boardStateOf, with tests). `needsYou` is a SECOND,
  // file-borne source of the same signal (see needs-you.ts) — plan tasks
  // ready on a human, and agents whose latest status.json escalated —
  // that works whether or not the session's own context.pending caught it
  // (the console engine never sets pending: it answers AskUserQuestion
  // inline in the transcript).
  // Permission asks for Home: each resolved against the session's owner
  // (session-owner.ts, the same authority as everywhere) — see asksNeedsYou.
  const asksOnHome = (agents: readonly Agent[]) => {
    const pending = asks?.all() ?? []
    if (pending.length === 0) return []
    const byId = new Map(index.allSessions().map((m) => [m.id, m]))
    return asksNeedsYou(agents, pending, {
      ownerOf: (sid) => {
        const m = byId.get(sid)
        return m ? owners.agentIdOf(m) : null
      },
      folderOf: (sid) => byId.get(sid)?.folder ?? null,
    })
  }
  // ONE derivation for the board AND the inbox:
  // GET /api/board, the inbox watcher below (the open page's WS nudge) and
  // — through app.composeInbox — the digest and the doorbell all read this.
  // A1b (inbox.ts accountLimitRows): which account an automation's runs ran
  // on — the cascade's turn level (runsOn) over the agent's default; a kept
  // conversation's own pin is not consulted (the run's turn level is what
  // the automation decides) — normalised so undefined reads as
  // the default account, and named the way Run on names it.
  const providerOfAutomation = (a: Automation): string => {
    const raw = a.runsOn?.provider ?? registry.get(a.agentId)?.provider
    return deps.providers?.resolve(raw)?.id ?? raw ?? 'default'
  }
  const accountLabel = (p: string): string => {
    const r = deps.providers?.resolve(p)
    if (!r) return p
    return r.kind === 'claude-account' ? (r.configDir === null ? 'Your Claude account' : `Claude account ${p.slice(p.indexOf(':') + 1)}`) : r.label
  }
  const accountUsage = (p: string): AccountUsage | null => {
    const u = deps.planUsage?.peek?.(p) ?? null
    return u && u.ok ? { at: u.at, windows: u.windows } : null
  }
  // fire-and-forget: the reading lands in plan-usage's cache (90 s) and the
  // next inbox check (every resident tick) sees the row change and nudges
  // — and the engines' compatibility verdicts (harness.ts, cached 60 s), so
  // the engine row (inbox.ts engineCompatRow) reads a recent one
  const warmInboxReadings = (): Promise<unknown> => {
    const compat = harness ? harness.compatibility().catch(() => null) : Promise.resolve()
    if (!deps.planUsage || !automations) return compat
    const live = new Set(registry.list().map((a) => a.id))
    return Promise.all([compat, ...limitedProviders(automations, live, providerOfAutomation).map((p) => deps.planUsage!.get(p).catch(() => null))])
  }
  const composeBoard = (now: number) => {
    const resolve = store.titleResolver()
    const live = new Set(registry.list().map((a) => a.id))
    const sessionAsks: SessionAsk[] = []
    const cardAsks: SessionAsk[] = []
    const cards = index.allSessions().map((m) => {
      const ctx = index.getContext(m.folder, m.id)
      const { title } = resolve(m.folder, m.id, m.title)
      const agentId = classifyAgentId(m)
      const card = boardCardOf(m, ctx, now, liveMs, agentId, title)
      // a conversation waiting on an answer: its own pendingAsk (both
      // engines; what the overview shows, so only a live agent's) ∪ the
      // chat engine's context.pending (the card's needs_you)
      if (m.pendingAsk === true && live.has(agentId)) sessionAsks.push({ agentId, folder: m.folder, id: m.id, title, at: m.mtime, cwd: m.cwd ?? null })
      if (card.state === 'needs_you' && live.has(agentId)) cardAsks.push({ agentId, folder: m.folder, id: m.id, title, at: m.mtime, cwd: m.cwd ?? null })
      return card
    })
    // the whole registry (archived included) for names; the plan tasks of the
    // owner arrive with the silos below (the built-in Plans silo)
    const agents = registry.list(true)
    // every source that speaks FOR an agent reads the agents in play: an
    // archived agent is out of play (its beat kept paused), so its
    // escalation, the messages it handed to the owner, its permission asks,
    // its conversations' questions and its runs awaiting a go are no rows —
    // their door would open an agent the web doesn't list (third review
    // round: from there, a NEW real console for it)
    const liveAgents = agents.filter((a) => !a.archived)
    const needsYou: NeedsYouItem[] = [...(messages ? messagesNeedsYou(liveAgents, messages) : []), ...(asks ? asksOnHome(liveAgents) : [])]
    // the active silos (silos/surfaces.ts): needs-you rows by the same pipe,
    // and a `silos` block for the pulse and Done today — absent when no silo
    // is active, so Home stays exactly as it was until the first install
    const silo = siloSurfaces?.board(now)
    if (silo) needsYou.push(...silo.needsYou)
    const nameOf = agentNameOf(agents)
    // the engines the agents in play run on that are not ok (harness.ts
    // verdicts, kept warm by warmInboxReadings): one row
    const engineRow = harness
      ? engineCompatRow(harness.peekCompatibility(), { agents: liveAgents.map((a) => ({ id: a.id, harness: harnessOf(a) })), nameOf, now })
      : null
    // the reserve engine's wiring (its Silos hooks in ~/.claude/settings.json,
    // read at most every 10 s; unreadable reads as wired — never a false alarm)
    // the reserve engine, by the registry (never an id literal here)
    const reserve = fallbackHarness()
    const unwiredRow = engineUnwiredRow(claudeHooksWired(), {
      engine: reserve.label,
      harnessId: reserve.id,
      agents: liveAgents.map((a) => ({ id: a.id, harness: harnessOf(a) })),
      now,
    })
    const engineRows = [...(engineRow ? [engineRow] : []), ...(unwiredRow ? [unwiredRow] : [])]
    const automationAgent = new Map((automations ? automations.list() : []).map((a) => [a.id, a.agentId]))
    const inbox = composeInbox({
      nameOf,
      now,
      asks: [...sessionAsks, ...cardAsks],
      needsYou,
      // a run of an archived agent's automation waits for nobody
      pending: automations
        ? automations.pendingApprovals().filter((r) => {
            const owner = automationAgent.get(r.automationId)
            return owner === undefined || live.has(owner)
          })
        : [],
      // a proposal from an agent since archived waits for nobody: not a row
      // (accepting it would answer 409 anyway)
      proposals: proposals
        ? proposals
            .pending()
            .filter((p) => liveAgents.some((a) => a.id === p.by))
            .map((p) => ({
              id: p.id,
              by: p.by,
              at: p.at,
              kind: p.kind,
              reason: p.reason,
              inputHash: p.inputHash,
              review: reviewOnly(p),
              words: proposalWords(p, {
                registry,
                ...(deps.providers ? { providers: deps.providers } : {}),
                ...(deps.platformSettings ? { unattendedProvider: () => deps.platformSettings!.unattendedProvider() } : {}),
                ...(territoryStore ? { territoryOn: (id: string) => territoryStore.isEnabled(id) } : {}),
              }),
            }))
        : [],
      automations: automations ? automations.list() : [],
      kernel: [
        ...engineRows,
        ...(deps.seals ? sealInboxRows(deps.seals.rows(), nameOf) : []),
        ...kernelInboxRows({
          agents: liveAgents,
          nameOf,
          now,
          providerOf: providerOfAutomation,
          usageOf: accountUsage,
          labelOf: accountLabel,
          ...(harness
            ? {
                engineRefused: (id: string) => {
                  const a = registry.get(id)
                  return a !== null && harness.peekRefusal(a, 'chat') !== null
                },
              }
            : {}),
          ...(automations ? { automations } : {}),
          ...(agentState ? { agentState } : {}),
          ...(messages ? { messages } : {}),
          // an agent whose heartbeat looks reads its messages at its next
          // heartbeat — the row waits for that chance (and says what missed it)
          heartbeatLooks: (a: Agent) => controlOf(a, territoryStore ? territoryStore.isEnabled(a.id) : false) === 'own' && heartbeatOf(a).period !== null,
          ...(automations ? { heartbeatRuns: (id: string) => automations.listRuns(heartbeatAutomationId(id), 20) } : {}),
          // the task lines, the stalls nobody moves, the wake ceiling
          ...(deps.taskFlows ? { taskFlows: () => deps.taskFlows!(now) } : {}),
          isAgent: (id: string) => agents.some((a) => a.id === id),
          ...(taskMode
            ? {
                isBoundToTasks: (id: string) => taskMode.isBound(id),
                ownTurnsCeilings: () => taskMode.ceilingHits(now),
                taskAuditsUnreadable: () => taskMode.unreadableAudits(),
                tasksUnreadable: () => taskMode.unreadableTasks(),
              }
            : {}),
          ...(taskMode && deps.conversationFacts ? { queuedWakes: () => taskMode.queuedWakes(), conversations: deps.conversationFacts } : {}),
          ...(deps.closedPlans ? { closedPlans: deps.closedPlans } : {}),
          ...(deps.ownToday ? { ownToday: (id: string) => deps.ownToday!(id, now) } : {}),
          // an `own` agent whose territory turned off operates as told (G5-r7)
          ...(territoryStore ? { degradedWhy: (a: Agent) => degradedWhy(a, territoryStore.isEnabled(a.id)) } : {}),
          // the tasks from before Silos watched a folder: «Keep them all ›» (M13-r6)
          ...(deps.initiative ? { plansBaseline: () => deps.initiative!.initiative.baseline() } : {}),
        }),
      ],
      // a plan task's question asked after reading outside (m15): the last
      // 'ask' mark its unattended run left, re-stamped when the run ended
      ...(deps.initiative
        ? {
            askedOutside: (key: string) => {
              const asks = (deps.initiative!.origins.get(key)?.marks ?? []).filter((m) => m.kind === 'ask')
              const last = asks[asks.length - 1]
              return last?.readOutside && last.readOutside.length > 0 ? last.readOutside : null
            },
          }
        : {}),
      ...(needsYouAcks ? { ackedVersion: (kind: AckKind, key: string) => needsYouAcks.ackedVersion(kind, key) } : {}),
    })
    return { cards, needsYou, silo, inbox }
  }
  app.decorate('composeInbox', (now: number = Date.now()) => composeBoard(now).inbox)

  // What the daily digest counts for a window (digest.ts) — facts the
  // server already holds, no transcript read beyond the index:
  //   conversations  the owner's own (no automation birth, not nested) whose
  //                  last activity fell in the window shifted back by liveMs —
  //                  i.e. quiet by its end; consecutive windows tile, so a
  //                  conversation still live at the hour is counted next time
  //   runs           runs that ENDED in the window, each failure marked healed
  //                  when a later run of its automation ended ok
  //   silos          the journal's completions — a plan's tasks among them
  //                  since the Plans silo is built in — and the
  //                  Horizon (roles.due)
  app.decorate('digestFacts', (from: number, to: number): DigestFacts => {
    const agents = registry.list(true)
    const conversations: Array<{ agentId: string }> = []
    // the conversations Silos opened for urgent messages (history — t6: no
    // longer born): their own line, never «N conversations finished»
    const messageConversations: Array<{ agentId: string }> = []
    for (const m of index.allSessions()) {
      if (m.mtime < from - liveMs || m.mtime >= to - liveMs) continue
      const birth = origins?.get(`${m.folder}/${m.id}`)
      if (birth?.kind === 'message') {
        messageConversations.push({ agentId: classifyAgentId(m) })
        continue
      }
      if (birth) continue
      if (owners.nestedOf(m)) continue
      conversations.push({ agentId: classifyAgentId(m) })
    }
    const runs: DigestFacts['runs'][number][] = []
    for (const a of automations ? automations.list() : []) {
      const all = automations!.listRuns(a.id) // newest first
      all.forEach((r, i) => {
        if (r.status !== 'ok' && r.status !== 'failed') return
        const end = Date.parse(r.endedAt ?? r.at)
        if (!(end >= from && end < to)) return
        runs.push({ agentId: a.agentId, run: r, healedLater: r.status === 'failed' && all.slice(0, i).some((x) => x.status === 'ok') })
      })
    }
    return {
      nameOf: agentNameOf(agents),
      conversations,
      messageConversations,
      runs,
      siloDone: (siloSurfaces?.completions(from, to) ?? []).map((d) => ({ silo: d.silo, siloName: d.siloName, to: d.to, label: d.toLabel })),
      horizon: siloSurfaces?.horizon(to) ?? null,
    }
  })

  // Home's «Since …»: the facts
  // the server already keeps, counted from the owner's previous visit
  const visits = deps.dataDir ? new VisitsStore(deps.dataDir) : null
  const sinceFacts = (from: number, now: number): SinceFacts => {
    const live = registry.list()
    const runs: Array<{ automationId: string }> = []
    for (const a of automations ? automations.list() : []) {
      for (const r of automations!.listRuns(a.id)) {
        if (r.status !== 'ok' && r.status !== 'failed') continue
        const end = Date.parse(r.endedAt ?? r.at)
        if (end >= from && end < now) runs.push({ automationId: a.id })
      }
    }
    const done = (siloSurfaces?.completions(from, now) ?? []).filter((d) => d.silo === PLANS_SILO && !d.drop).length
    // a Claude account in use, by ACCOUNT (shared — never one agent's)
    const byAccount = new Map<string, number>()
    for (const a of live) {
      const r = providers?.resolve(a.provider)
      if (r?.kind === 'claude-account') byAccount.set(r.id, (byAccount.get(r.id) ?? 0) + 1)
    }
    const accounts = [...byAccount].map(([id, agents]) => {
      const u = deps.planUsage?.peek?.(id) ?? null
      if (!u) void deps.planUsage?.get(id).catch(() => null) // warm: the next visit reads it
      return {
        account: id === 'default' ? 'your Claude account' : id.slice(id.indexOf(':') + 1),
        weeklyPercent: u && u.ok ? weeklyPercentOf(u.windows) : null,
        agents,
      }
    })
    // «~$ today» only on an API key that prices turns
    const unattended = deps.platformSettings?.unattendedProvider() ?? null
    const priced = unattended !== null && providers?.resolve(unattended)?.kind === 'anthropic-compatible'
    const costUsd = priced && deps.ownToday ? live.reduce((s, a) => s + (deps.ownToday!(a.id, now)?.costUsd ?? 0), 0) : null
    const rows = composeBoard(now).inbox
    return {
      done,
      runs,
      stuck: taskMode ? taskMode.retryFailed(now).length : 0,
      decided: deps.initiative ? deps.initiative.initiative.decidedSince(from) : [],
      needsYou: rows.filter((r) => r.kind !== 'taskLine' && r.urgency !== 'routine').length,
      accounts,
      costUsd,
    }
  }
  const homeSince = (req: { ownerCredential?: boolean; agentId?: string }): HomeSince => {
    const now = Date.now()
    // the visit is stamped only under the owner's credential
    const prev = visits ? (req.ownerCredential === true && req.agentId === undefined ? visits.stamp(now) : visits.last()) : null
    const from = prev !== null ? Date.parse(prev) : now
    return composeSince(prev, now, sinceFacts(from, now))
  }

  // Home's reading surfaces — moved to routes/board.ts.
  boardRoutes(app, {
    index,
    store,
    registry,
    digests: deps.digests,
    notificationPrefs: deps.notificationPrefs,
    push: deps.push,
    asks,
    needsYouAcks,
    classifyAgentId,
    composeBoard,
    warmInboxReadings,
    checkInbox: () => checkInbox(),
    homeSince,
  })

  // Map › Uses — moved to routes/map.ts.
  mapRoutes(app, {
    index,
    store,
    registry,
    owners,
    origins,
    convPrefs,
    providers,
    accounts,
    automations,
    vault: deps.vault,
    classifyAgentId,
    home: machineHome,
  })

  // Accounts and providers — moved to routes/providers.ts.
  providerRoutes(app, {
    providers,
    accounts,
    chat,
    gatewayModels,
    accountLoad: deps.accountLoad,
    planUsage: deps.planUsage,
    verifyFetch: deps.verifyFetch,
    hooks,
    terminals,
    ...(deps.platformSettings ? { settings: deps.platformSettings } : {}),
    enginesInUse: () => [
      ...new Set(
        registry.list().flatMap((a) => {
          try {
            return [harnessOf(a)]
          } catch {
            return []
          }
        }),
      ),
    ],
  })

  // Automations resident routes — moved to routes/automations.ts;
  // registered only when both deps were injected, as before.
  const automationCreate =
    automations && resident
      ? automationRoutes(app, {
          automations,
          resident,
          registry,
          providers,
          ...(proposals ? { proposals } : {}),
          checkInbox: () => checkInbox(),
          ...(deps.automationTemplates ? { templates: deps.automationTemplates } : {}),
          // a bearer's own recurring work: its control and the ledger
          ...(deps.controlOf ? { controlOf: deps.controlOf } : {}),
          ...(deps.initiative ? { initiative: deps.initiative.initiative } : {}),
          ...(deps.vitals ? { usage: deps.vitals } : {}),
          // a template never holds these: every Vault value and the static token
          secrets: () => [...(vault?.secretValues() ?? []), { name: 'the Silos token', value: ownerToken() }],
        })
      : null
  // proposals (routes/proposals.ts)
  if (proposals) {
    proposalRoutes(app, {
      proposals,
      registry,
      automationCreate,
      ...(agentState ? { agentState } : {}),
      ...(deps.providers ? { providers: deps.providers } : {}),
      ...(deps.platformSettings ? { unattendedProvider: () => deps.platformSettings!.unattendedProvider() } : {}),
      ...(territoryStore ? { territoryOn: (id: string) => territoryStore.isEnabled(id) } : {}),
      ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
      checkInbox: () => checkInbox(),
    })
  }
  // role packs (role-pack.ts): export, preview, install — the owner's
  if (automations && automationCreate && deps.automationTemplates && agentState) {
    rolePackRoutes(app, {
      registry,
      agentState,
      automations,
      createAutomation: automationCreate,
      templates: deps.automationTemplates,
      siloRegistry,
      siloOperator,
      siloInstaller,
      vault,
      ...(pluginSkillsDir ? { pluginSkillsDir } : {}),
      ...(deps.home ? { home: deps.home } : {}),
      ...(territoryStore ? { territoryStore } : {}),
      ...(deps.platformSettings ? { startingSettings: deps.platformSettings } : {}),
      secrets: () => [...(vault?.secretValues() ?? []), { name: 'the Silos token', value: ownerToken() }],
    })
  }

  const clients = new Set<{ readyState: number; OPEN: number; send: (data: string) => void }>()
  const broadcast = (msg: unknown): void => {
    const data = JSON.stringify(msg)
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) socket.send(data)
    }
  }
  if (deps.broadcastBox) deps.broadcastBox.send = broadcast // see the comment on ServerDeps.broadcastBox

  // The inbox watcher: the inbox changes with the clock alone (a retry that
  // came due, a message past its recipient's next chance to read it) as well as with
  // writes. Every resident tick — and right after an ack or a message — the
  // composition is compared by signature (inbox.ts inboxSignature); when it
  // moved, an `inbox` WS event tells the open page to re-fetch the board
  // (the 20 s board poll stays the fallback) and every onInboxChange
  // listener (the doorbell) gets the new rows. Composed only while someone
  // listens.
  let inboxSig: string | null = null
  const inboxListeners = new Set<(rows: InboxRow[]) => void>()
  function checkInbox(now: number = Date.now()): void {
    if (clients.size === 0 && inboxListeners.size === 0) return
    let rows: InboxRow[]
    void warmInboxReadings()
    try {
      rows = composeBoard(now).inbox
    } catch (err) {
      console.warn('inbox: composition failed —', err instanceof Error ? err.message : err)
      return
    }
    const sig = inboxSignature(rows)
    if (sig === inboxSig) return
    const first = inboxSig === null
    inboxSig = sig
    if (first) return
    broadcast({ ev: 'inbox' })
    for (const l of inboxListeners) {
      try {
        l(rows)
      } catch (err) {
        console.warn('inbox: a listener failed —', err instanceof Error ? err.message : err)
      }
    }
  }
  app.decorate('onInboxChange', (listener: (rows: InboxRow[]) => void) => {
    inboxListeners.add(listener)
    return () => {
      inboxListeners.delete(listener)
    }
  })
  app.decorate('checkInboxNow', () => {
    setImmediate(() => checkInbox())
  })
  const inboxTimer = setInterval(() => checkInbox(), RESIDENT_TICK_MS)
  inboxTimer.unref?.()
  app.addHook('onClose', async () => {
    clearInterval(inboxTimer)
  })

  // The SDK chat lane — moved to routes/chat.ts.
  chatRoutes(app, {
    index,
    store,
    registry,
    native,
    chat,
    terminals,
    prefs,
    seen,
    convPrefs,
    catalog,
    providers,
    pendingResumes,
    origins,
    gatewayModels,
    agentState,
    hooks,
    transcriptOnly,
    validParams,
    freshConsoles,
    classifyAgentId,
    consoleKeyFor,
    owners,
    broadcast: (m) => broadcast(m),
  })

  // «New to you» marks on plan tasks — moved to routes/task-seen.ts.
  if (taskSeen) taskSeenRoutes(app, { taskSeen })
  if (deps.machine) systemRoutes(app, { machineDir: deps.machine.dir, diskPath: deps.machine.diskPath, since: deps.machine.since })
  if (deps.seals) sealRoutes(app, { seals: deps.seals })

  // exec/terminals/search/Vault — moved to routes/vault.ts.
  vaultRoutes(app, {
    exec,
    terminals,
    vault,
    index,
    store,
    registry,
    chat,
    owners,
    agentState,
    classifyAgentId,
    broadcast: (m) => broadcast(m),
    ...(deps.bindingAsks ? { bindingAsks: deps.bindingAsks } : {}),
  })
  // the signer: a Vault entry with a binding, used
  // through Silos and never held — routes/egress.ts
  if (vault)
    egressRoutes(app, {
      vault,
      registry,
      log: deps.egressLog ?? (deps.dataDir ? new EgressLog(join(deps.dataDir, 'egress')) : null),
      ...(deps.egressIdleMs !== undefined ? { idleMs: deps.egressIdleMs } : {}),
      ...(deps.egressPrivateReason !== undefined ? { privateReason: deps.egressPrivateReason } : {}),
    })
  // the network surface: each agent's egress policy
  // and the proxy's refusals — routes/territory-egress.ts
  if (territoryStore)
    territoryEgressRoutes(app, {
      territoryStore,
      registry,
      rejections: deps.egressRejectLog ?? (deps.dataDir ? new EgressRejectLog(join(deps.dataDir, 'egress')) : null),
      ...(deps.egressProxyPort !== undefined ? { proxyPort: deps.egressProxyPort } : {}),
    })
  // the agents' messages: read is marked by the class
  // of the turn served (message-reads.ts)
  if (messages) messageRoutes(app, { messages, reads: deps.messageReads ?? new MessageReads(messages, liveTurns), registry, checkInbox: () => checkInbox() })

  // The Silo Standard's routes — moved to routes/silos.ts.
  siloRoutes(app, {
    siloRegistry,
    siloInstaller,
    siloOperator,
    siloKernel,
    siloSurfaces,
    siloJournal,
    siloActions,
    siloRelations,
    siloValidate,
    registry,
    agentState,
    taskMode,
    index,
    resident,
    classifyAgentId,
    broadcast: (m) => broadcast(m),
    ...(lineage ? { lineage } : {}),
    ...(deps.threadsOfTasks ? { threadsOfTasks: deps.threadsOfTasks } : {}),
    nativeIdOf: (k) => terminals.nativeIdOf(k),
    kernelVerbs,
    ...(deps.freshenSilo ? { freshen: deps.freshenSilo } : {}),
  })

  // Engines + the real console + escalation + task mode — moved to
  // routes/console.ts.
  consoleRoutes(app, {
    harness,
    terminals,
    chat,
    escalation,
    taskMode,
    ...(deps.taskAsks ? { taskAsks: deps.taskAsks } : {}),
    refreshPlans: () => {
      siloKernel?.refresh(PLANS_SILO)
    },
    ...(deps.invalidateTaskThreads ? { invalidateTaskThreads: deps.invalidateTaskThreads } : {}),
    registry,
    index,
    store,
    convPrefs,
    providers,
    agentState,
    prefs,
    lineage,
    siloRegistry,
    siloActions,
    native,
    freshConsoles,
    consoleKeyFor,
    transcriptOnly,
    absorbRotations,
    threadRootKey,
    classifyAgentId,
    hooks,
    hookContext,
    broadcast: (m) => broadcast(m),
  })

  void app.register(websocket)
  void app.register(async (scope) => {
    // A single pair of index listeners for the whole scope (not one per
    // connection): every event is broadcast once to all live clients via broadcast().
    // a console's `/clear` writes a NEW JSONL — the rotation file must be
    // absorbed BEFORE this view is built, or the pushed session carries no
    // parentKey and the sidebar shows a second "(untitled)" topic until a
    // reload (the overview absorbs, this path didn't).
    // deferred (setImmediate): absorbRotations writes lineage synchronously
    // and may run inside a read (a task-threads cache that expired) — the
    // broadcast waits for that read to end
    announce.send = (keys) => {
      setImmediate(() => {
        for (const key of keys) {
          const slash = key.indexOf('/')
          const meta = index.getMeta(key.slice(0, slash), key.slice(slash + 1))
          if (meta) broadcast({ ev: 'session', meta: view(meta, Date.now()), counts: countsNow() })
        }
      })
    }
    index.on('session', (m: SessionMeta) => {
      absorbRotations()
      broadcast({ ev: 'session', meta: view(m, Date.now()), counts: countsNow() })
    })
    index.on('removed', (folder: string, id: string) => broadcast({ ev: 'removed', folder, id, counts: countsNow() }))

    scope.get('/ws', { websocket: true }, (socket) => {
      const send = (msg: unknown): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
      }
      clients.add(socket)
      socket.on('message', (raw: Buffer) => {
        try {
          if ((JSON.parse(String(raw)) as { op?: string }).op === 'ping') send({ ev: 'pong' })
        } catch {
          /* ignore */
        }
      })
      socket.on('close', () => {
        clients.delete(socket)
      })
      send({ ev: 'hello' })
    })

    // Raw PTY streaming — not wrapped in JSON: the server sends output
    // text as-is (xterm.js writes it directly), the client sends JSON
    // control frames ({op:'write'|'resize'}). Shared by the shell
    // terminals (/ws/terminal/:id) and the real console (/ws/console/:key)
    // — `release` is what happens to the PTY when the socket goes away.
    function bindTerminalSocket(socket: WebSocket, id: string, release: () => void): void {
      const off = terminals.onData(id, (data: string) => {
        if (socket.readyState === socket.OPEN) socket.send(data)
      })

      // Health ping/pong — a "half-open" remote client (a sleeping laptop,
      // a network drop with no clean FIN) never fires 'close' on its own:
      // without this, release() is NEVER called, the client counter never
      // drops below 1, and the PTY stays alive forever (exhausting the
      // limit). We send a ping every terminalPingMs; if the pong doesn't
      // arrive before the NEXT round, we count a miss; on the second
      // consecutive miss (2 pings with no response) we assume the client
      // is dead and force the close — terminate() DOES fire 'close' on
      // the server side, which does the usual release()/off().
      let pongsMissed = 0
      const onPong = (): void => {
        pongsMissed = 0
      }
      socket.on('pong', onPong)
      const pingTimer = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return
        if (pongsMissed >= 2) {
          socket.terminate()
          return
        }
        pongsMissed += 1
        socket.ping()
      }, terminalPingMs)
      pingTimer.unref?.()

      // If the PTY dies (DELETE, the idle reaper, or it exited on its own)
      // while this WS is still attached, close it — otherwise the client
      // is left staring at a phantom terminal with no signal that
      // there's nothing on the other end anymore.
      const onKilled = (killedId: string): void => {
        if (killedId === id && socket.readyState === socket.OPEN) socket.close()
      }
      terminals.on('killed', onKilled)

      socket.on('message', (raw: Buffer) => {
        let msg: { op?: string; data?: string; cols?: number; rows?: number }
        try {
          msg = JSON.parse(String(raw)) as typeof msg
        } catch {
          return // a non-JSON frame from the client: shouldn't happen, ignored
        }
        try {
          // the client's heartbeat (TerminalPanel): answered with an EMPTY
          // BINARY frame — every text frame is the pane's output.
          if (msg.op === 'ping') {
            if (socket.readyState === socket.OPEN) socket.send(Buffer.alloc(0), { binary: true })
          } else if (msg.op === 'write' && typeof msg.data === 'string') terminals.write(id, msg.data)
          else if (msg.op === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') terminals.resize(id, msg.cols, msg.rows)
        } catch {
          /* the PTY could have died right between attach and this message */
        }
      })
      socket.on('close', () => {
        clearInterval(pingTimer)
        socket.off('pong', onPong)
        terminals.off('killed', onKilled)
        off()
        release()
      })
    }

    // a shell terminal: the PTY outlives the socket (it's idle-reaped
    // later, so a reload reattaches). A nonexistent id (already killed, or
    // never existed) just closes the socket.
    scope.get<{ Params: { id: string } }>('/ws/terminal/:id', { websocket: true }, (socket, req) => {
      const { id } = req.params
      if (!terminals.attach(id)) {
        socket.close()
        return
      }
      bindTerminalSocket(socket, id, () => terminals.detach(id))
    })

    // the real console: ONE tmux client per socket, born at the tab's size
    // (?cols=&rows=) so the first paint is already right, and killed with
    // the socket (the tmux session — the real claude — lives on). An
    // unknown key, or the client cap, just closes the socket.
    scope.get<{ Params: { key: string }; Querystring: { cols?: string; rows?: string } }>('/ws/console/:key', { websocket: true }, (socket, req) => {
      const cols = clampSize(req.query.cols, 200)
      const rows = clampSize(req.query.rows, 50)
      // the open probes tmux (async): what the tab sends meanwhile (its
      // first resize, a keystroke) is held and replayed once bound, and a
      // socket that closed meanwhile takes its fresh client with it
      const early: Buffer[] = []
      const hold = (raw: Buffer): void => {
        early.push(raw)
      }
      let closed = false
      const onEarlyClose = (): void => {
        closed = true
      }
      socket.on('message', hold)
      socket.on('close', onEarlyClose)
      void (async () => {
        let id: string
        try {
          id = (await terminals.openConsoleClient(req.params.key, cols, rows)).id
        } catch (err) {
          socket.off('message', hold)
          socket.off('close', onEarlyClose)
          // tmux did not answer (a probe that failed is never «gone»): a plain
          // close the pane retries with its backoff — never the 4404 that
          // stops it and offers Restart over a console that may be running
          if (err instanceof ConsoleUnknownError) {
            socket.close(4503, 'console unknown')
            return
          }
          // the console isn't open (its claude exited / the tmux session died):
          // close with 4404 so the client stops reconnecting and offers Restart,
          // instead of an indistinguishable drop it retries forever.
          socket.close(4404, 'console gone')
          return
        }
        socket.off('message', hold)
        socket.off('close', onEarlyClose)
        if (closed) {
          terminals.kill(id)
          return
        }
        bindTerminalSocket(socket, id, () => terminals.kill(id))
        for (const raw of early) socket.emit('message', raw, false)
      })()
    })
  })

  const hasWebDist = webDist !== undefined && existsSync(webDist)
  if (hasWebDist) {
    // Avoids the "blank page" gotcha: wildcard:false used to register ONE
    // route per file with a glob AT BOOT TIME — a later `npm run build`
    // generates assets with a new hash the server doesn't know about, and
    // they fell through to the SPA fallback (a 200 HTML where the browser
    // expects JS ⇒ a blank screen from the MIME mismatch). wildcard:true
    // serves /* with a per-request disk lookup: a new build is visible
    // with no restart. The explicit /api and /ws routes still win over the
    // wildcard by specificity, and a nonexistent file still falls through
    // to the setNotFoundHandler below (the SPA).
    void app.register(fastifyStatic, { root: webDist, wildcard: true })
  }
  app.setNotFoundHandler((req, reply) => {
    const isPageGet = req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')
    if (isPageGet && hasWebDist) {
      return reply.type('text/html').send(readFileSync(join(webDist!, 'index.html')))
    }
    // First-run landmine: `npm run dev` without a prior `npm run build` leaves
    // web/dist absent, and a bare {"error":"not found"} at / gives a newcomer
    // no idea what's wrong. Serve a plain page that says exactly what to run.
    if (isPageGet && !hasWebDist) {
      return reply
        .code(503)
        .type('text/html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>Silos — build required</title>' +
            '<body style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a">' +
            '<h1 style="font-size:1.4rem">Silos is running, but the web UI isn\'t built yet</h1>' +
            '<p>The server is up — it just has no <code>web/dist</code> to serve. Build the frontend once:</p>' +
            '<pre style="background:#f4f4f2;padding:1rem;border-radius:8px;overflow:auto">npm run build</pre>' +
            '<p>then reload this page. (During UI development, <code>npm run dev:web</code> serves it with hot-reload on another port instead.)</p>' +
            '</body>',
        )
    }
    return reply.code(404).send({ error: 'not found' })
  })

  return app
}
