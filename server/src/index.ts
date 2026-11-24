// fills the harness registry (harnesses/registry.ts) before anything reads it
import { setNoteOutside } from './silos/views.js'
import { CreationsStore } from './creations.js'
import { heartbeatAutomationId } from './heartbeat.js'
import { Initiative, setInitiative } from './initiative.js'
import { PlansOrigins, noteReadOutside } from './plans-origins.js'
import { PlansProvenance, plansSnapshotOf, writesFile } from './plans-provenance.js'
import { AutomationTemplates } from './automation-templates.js'
import './harnesses/index.js'
import { SkillCopyFollower } from './skill-install.js'
import { heldSkills } from './skill-states.js'
import { ownMcpServerNames, withRoleSkills } from './role-plugin.js'
import { basename, join } from 'node:path'
import { defaultConfig, ensureData } from './config.js'
import { initServerLog } from './server-log.js'
import { acquireInstanceLock } from './instance-lock.js'
import { openBrowser } from './open-browser.js'
import { scrubDevRunEnv, scrubInheritedEngineEnv } from './inherited-env.js'
import { scrubOwnerCredentials } from './env.js'
import { loadMuted } from './muted.js'
import { resolveEphemeralPrefix } from './ephemeral.js'
import { watch } from 'node:fs'
import { AgentRegistry, mungePath } from './agent-registry.js'
import { fallbackHarness, findHarness, harnessById, harnessForId, harnessOf } from './harnesses/registry.js'
import { completeEnginePath } from './engine-path.js'
import { turnAccountOf as turnAccountOfTurn } from './turn-account.js'
import { bootHarnesses } from './compose.js'
import { SessionStore } from './session-store.js'
import { NativeStore } from './native-store.js'
import { LineageStore } from './lineage.js'
import { SessionOwners } from './session-owner.js'
import { makeThreadIdOf, taskThreads, type TaskThreads } from './task-threads.js'
import { continuableOf, makeAbsorbRotations, makeThreadRootKey, type AnnounceBox } from './thread-tools.js'
import { makeTranscriptOnly, type TranscriptOnly } from './transcript-only.js'
import { bindNativeOnTasks, nativeBindPass } from './task-native-bind.js'
import { BirthsStore } from './births-store.js'
import { AsksStore } from './asks-store.js'
import { PrefsStore } from './prefs-store.js'
import { ChatService } from './chat-service.js'
import { LiveTurns, runOfTurn } from './live-turns.js'
import { askSeenByOf, TaskAsks } from './task-asks.js'
import { ExecService } from './exec-service.js'
import { CompleteService } from './complete-service.js'
import { MemoryService } from './memory-service.js'
import { FileService } from './file-service.js'
import { ContextService } from './context-service.js'
import { TerminalService } from './terminal-service.js'
import { AutomationsStore } from './automations-store.js'
import { SessionOriginsStore } from './session-origins.js'
import { ProvidersStore } from './providers-store.js'
import { GatewayModelsRefresher } from './gateway-models.js'
import { TuiPinFollower } from './pin-follower.js'
import { VaultStore, type VaultCredential, type VaultEntry } from './vault-store.js'
import { AgentStateStore } from './agent-state.js'
import { AgentTokens } from './agent-tokens.js'
import { LOADS_SCOPES_FILE, LoadsScopesStore, sweepLostConversations } from './loads-scopes.js'
import { TerritoryStore } from './territory-store.js'
import { effectiveEgressOf, egressProxyEnv, egressProxyPort, startEgressProxy, type EgressProxy } from './egress-proxy.js'
import { EgressRejectLog } from './egress-log.js'
import { makeTerritory, territoriesOf } from './territory.js'
import { MessageStore, MESSAGES_DIR, validateMessageFile } from './messages.js'
import { MessageReads } from './message-reads.js'
import { HarnessService } from './harness.js'
import { HeartbeatClock } from './heartbeat.js'
import { nextSlot } from './period.js'
import { controlOf, heartbeatOf, positionOf, proactiveOf, proactiveOffWhy, storedProactive } from './control.js'
import { madeFromMissionToday, missionOpen, missionUndone, openFromMissionRoot, type TaskNow } from './proactive.js'
import { folderLoads, folderSkillPlaces, folderSkills } from './folder-loads.js'
import { ToolHealthLedger } from './tool-health.js'
import { TaskCancellations } from './task-cancellations.js'
import { slotsPerDay } from './period.js'
import { PROACTIVE_OPEN_MAX, ROUND_ACCOUNT_HEADROOM, ROUNDS_UNMEASURED_PER_DAY, ROUND_SPEND_SHARE } from './limits.js'
import type { TurnAccount } from './resident/deps.js'
import { HeartbeatStore } from './heartbeat-store.js'
import { heartbeatFacts } from './heartbeat-facts.js'
import { TurnSlots } from './turn-slots.js'
import { ownTurnsToday, type OwnTurnsToday } from './own-turns.js'
import { UsageService } from './usage.js'
import { VitalsService } from './vitals.js'
import { UsageLedger } from './usage-ledger.js'
import { weeklyPercentOf } from './home-since.js'
import { MANUAL_CAUSE } from './automations-types.js'
import { PlatformSettingsStore, unattendedPrices } from './platform-settings.js'
import { auditPaths, auditSessionsOf, auditToolCalls, collectTurnCalls } from './heartbeat-audit.js'
import type { RunAudit } from './automations-types.js'
import { SiloRegistry } from './silos/registry.js'
import { SiloReader } from './silos/reader.js'
import { SiloKernel } from './silos/kernel.js'
import { standingIdsOf } from './silos/manifest.js'
import { TransitionJournal } from './silos/journal.js'
import { OverlayStore } from './silos/overlay.js'
import { createSiloValidate } from './silos/validator.js'
import { bearerLocations, bearerMayReadLocation } from './silos/bearer-scope.js'
import { SiloSurfaces } from './silos/surfaces.js'
import { SiloOperatorStore } from './silos/operator.js'
import { SiloInstaller } from './silos/installer.js'
import { HOUSE_DIMENSIONS } from './silos/native.js'
import { producerBriefFor } from './silos/producer-brief.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from './silos/actions.js'
import { houseLocations } from './silos/files-source.js'
import { BACKGROUND_BUSY, CONVERSATION_BUSY_MS, backgroundBusy, conversationLive, wakesOfControl } from './conversation-live.js'
import { endPass, perPass } from './pass.js'
import { AccountsService } from './harnesses/claude-code/accounts.js'
import { ClaudeIdentityReader } from './harnesses/claude-code/auth-status.js'
import { AccountLoadService } from './harnesses/claude-code/account-load.js'
import { PlanUsageService } from './harnesses/claude-code/plan-usage.js'
import { Resident } from './resident.js'
import { Titler } from './titler.js'
import { generateTitleWithSdk } from './harnesses/claude-code/titler-sdk.js'
import { ConversationPrefsStore } from './conversation-prefs.js'
import { SeenStore } from './seen-store.js'
import { TaskSeenStore } from './task-seen-store.js'
import { NeedsYouAcksStore } from './needs-you-acks.js'
import { ProposalsStore } from './proposals.js'
import { DigestJob, DigestStore, NotificationPrefsStore } from './digest-job.js'
import { InboxBell } from './doorbell.js'
import { PushSubscriptionsStore, WebPushDoorbell, loadOrCreateVapidKeys } from './web-push.js'
import { RESIDENT_TICK_MS, limitedWindow } from './inbox.js'
import { ExecutionStore, ledgerPathsOf } from './execution-store.js'
import type { SessionMeta } from './types.js'
import { PendingResumesStore } from './pending-resumes-store.js'
import { ModelCatalog } from './model-catalog.js'
import { startKnowsWatcher } from './knows-watcher.js'
import { PLANS_SILO } from './plans-floor.js'
import { ClosedPlans } from './plans-closed.js'
import { baseRecordOf, flowOf, holds, kindsOf, recordsOfKind, taskFlowRecords, type KindRecord } from './silos/voice.js'
import { turnOf } from './silos/turn.js'
import { siblingRefOf } from './silos/views.js'
import type { TaskFlowFact } from './inbox.js'
import { agentChainRelation, chainUp, RelationStore, type EndpointState } from './silos/relations.js'
import { EscalationEngine } from './escalation/engine.js'
import { EscalationStore } from './escalation/store.js'
import { OWNER } from './escalation/evaluate.js'
import type { SiloNeedsYou } from './silos/surfaces.js'
import { TaskModeStore } from './task-mode/store.js'
import { ExecutionsSource, EXECUTIONS_SILO, sessionAtWork, taskRefsOf } from './silos/executions.js'
import { ProcessRecords, PROCESS_SILO, SILOS_SESSION_KEY, type ConversationFacts, type ConversationLookup } from './silos/processes.js'
import { WorktreeRecords } from './silos/worktrees.js'
import { linuxProcTable } from './silos/proc-table.js'
import { conversationThread } from './conversation-thread.js'
import { CONSOLE_BUSY, CONSOLE_UNSURE, TaskModeEngine, TASK_MODE_SILO } from './task-mode/engine.js'
import { OwnerNoteLedger } from './task-mode/owner-notes.js'
import { SILOS_AUTHOR } from './system-author.js'
import { SilosIdClient, silosIdSettingsFromEnv } from './silos-id.js'
import { InstanceUsage, silosVersion, telemetryOn } from './instance-usage.js'
import { readServerEnv, serverEnvWarning, serverSettings } from './server-env.js'
import { SessionTokenStore } from './session-tokens.js'
import { buildServer } from './server.js'
import { silosApiUrl } from './agent-env.js'
import { PeerRegistry } from './harnesses/claude-code/peer-registry.js'
import { sdkQueryFn } from './harnesses/claude-code/sdk.js'
import { purgeTrash, TRASH_PURGE_INTERVAL_MS } from './trash-purge.js'
import { MachineSampler } from './machine-sampler.js'
import { LoopStalls, startLoopStallMonitor } from './loop-stalls.js'
import { Seals, SEAL_TICK_MS, READS_EVERY_TICKS, validateAgentsJson, degradeAgentsJson } from './seals.js'
import { registeredHarnesses } from './harnesses/registry.js'
import { askTasksOf, bindingAsksOf, resolveBindingWaits, type AskTask, type BindingAsk } from './binding-asks.js'

const cfg = defaultConfig()
// the server's real address: SILOS_API in every agent process (agent-env.ts)
const silosApi = silosApiUrl(cfg.host, cfg.port)
const ensured = ensureData(cfg)
// Durable evidence: every start, everything on stdout/
// stderr and every fatal lands in <dataDir>/logs/server.log (rotated,
// bounded), however the server was launched.
initServerLog(cfg.dataDir)
// one server per data directory (instance-lock.ts): a second child started
// in the same instant (tsx watch after a big merge) leaves HERE, before any
// boot side effect — not at listen, after installing builtins twice
{
  const lock = acquireInstanceLock(cfg.dataDir)
  if (!lock.ok) {
    console.error(`another Silos server (pid ${lock.holder}) already runs over ${cfg.dataDir} — this one leaves before touching anything`)
    process.exit(1)
  }
  process.on('exit', lock.release)
}
// The seal (seals.ts): every control file of the data
// dir under the regime of its legitimate writer — installed and booted
// BEFORE any store loads (the boot re-hashes each sealed file against the
// cache and its copy, and restores/degrades before anything reads it).
// The rules of each file (validate on «Keep the edit», degrade on the
// unverified double mismatch, reload on adopt) are registered here; the
// stores are created below, so their reloads are closures.
const seals = new Seals({ dataDir: cfg.dataDir, home: cfg.home }).install()
// an adopted roster drops the launch entries of an agent it no longer has
seals.registerFile('agents.json', {
  validate: validateAgentsJson,
  degrade: degradeAgentsJson,
  onAdopt: () => {
    registry.load()
    loadsScopes.prune(new Set(registry.list(true).map((a) => a.id)))
  },
})
seals.registerFile('automations.json', { onAdopt: () => automations.load() })
seals.registerFile('proposals.json', { onAdopt: () => proposals.load() })
seals.registerFile('providers.json', { onAdopt: () => providers.load() })
seals.registerFile('vault.json', { onAdopt: () => vault.load() })
seals.boot()
// the owner's token: a value planted while Silos was off is never served —
// rotated, with its row (B1-r4); SILOS_TOKEN is the owner's own write
const tokenFromEnv = Boolean(process.env.SILOS_TOKEN?.trim())
const token = seals.bootOwnerToken(ensured.token, { fromEnv: tokenFromEnv })
// read — so it leaves process.env now: no process Silos starts (console,
// chat turn, command run, shell, a tmux server born later) inherits the
// owner's key (env.ts OWNER_CREDENTIAL_ENV)
scrubOwnerCredentials()
// the shell that started Silos never chooses what its engines run on —
// before anything is spawned (inherited-env.ts)
const inheritedEngineVars = scrubInheritedEngineEnv()
if (inheritedEngineVars.length > 0) console.warn(`silos: ignoring engine variables inherited from the shell that started it: ${inheritedEngineVars.join(', ')}`)
// nor does the dev run (npm's variables, node_modules/.bin on PATH) reach
// any agent process
const devRunVarsScrubbed = scrubDevRunEnv()
if (devRunVarsScrubbed.length > 0)
  console.log(
    `silos: agents get the user's own environment — dropped ${devRunVarsScrubbed.filter((n) => n !== 'PATH').length} npm run variable(s)${devRunVarsScrubbed.includes('PATH') ? ' and node_modules/.bin from PATH' : ''}`,
  )
// an engine installed where its own installer puts it is found, whatever
// PATH started Silos (engine-path.ts) — after the scrubs, before any spawn
const completePath = (): void => {
  for (const a of completeEnginePath(registeredHarnesses(), cfg.home))
    console.log(`silos: ${harnessById(a.harness).label} is not on the PATH Silos was started with — found in ${a.dir}, added to PATH`)
}
completePath()
const muted = loadMuted(cfg.dataDir)
// Ephemeral-noise rule — computed at startup (not in config, not in
// muted.json) and merged with the muted set for SessionIndex and the
// watcher. resolveEphemeralPrefix() returns null (rule off) if
// SILOS_NO_EPHEMERAL=1 — see
// ephemeral.ts, test harnesses only.
const ephemeral = resolveEphemeralPrefix()

const registry = new AgentRegistry(join(cfg.dataDir, 'agents.json'))
registry.load()
// The agent↔platform state channel: per-agent files under
// <dataDir>/agent-state/<id>/ (runmode.json, status.json) — see
// agent-state.ts. Constructed before ChatService/buildServer (and the
// harnesses' boot, whose readers may read the plugin's files under it) so
// every engine can inject SILOS_AGENT_STATE the same way vault injects its
// credentials.
// Per-agent bearer tokens (agent-tokens.ts): envFor hands each engine its
// agent's SILOS_AGENT_TOKEN — EVERY agent, master included, fence on or off
// (G1); the server resolves bearers back to agents
// against the tokens loaded here at boot (memory, never disk per request).
const agentTokens = new AgentTokens(cfg.dataDir, seals)
// Territory: the owner's settings (private paths + the rollout gate
// `enabled`) and ONE adapter both engines ask for an agent's fence (console
// --settings, SDK settings overlay). Only an enabled agent is fenced — the
// fence governs file rules, never identity.
const territoryStore = new TerritoryStore(cfg.dataDir)
territoryStore.load()
// restore regime (seal-regimes.ts): «Keep the edit» re-reads the fence
seals.registerFile('territory.json', { onAdopt: () => territoryStore.load() })
// the install's own settings: the unattended provider
const platformSettings = new PlatformSettingsStore(cfg.dataDir)
platformSettings.load()
seals.registerFile('settings.json', { onAdopt: () => platformSettings.load() })
// The egress proxy (egress-proxy.ts): ONE local proxy on
// a STABLE port (the API's + 1). An agent on egress `allowlist` gets it in
// its env through the identity channel (agent-state.ts), both engines.
const egressPort = egressProxyPort(cfg.port)
const egressRejectLog = new EgressRejectLog(join(cfg.dataDir, 'egress'))
const agentState = new AgentStateStore(join(cfg.dataDir, 'agent-state'), agentTokens, (agentId, bearer) =>
  egressProxyEnv(territoryStore.egressOf(agentId), bearer, egressPort),
)
// Engines' permission asks (asks-store.ts): a reader's context.pending and
// Home's Needs you read the same files.
const asks = new AsksStore(agentState, { dataDir: cfg.dataDir })
// Every registered harness's runtime (compose.ts): the readers merged into ONE
// session index (the fallback's reader + the others, in registration order),
// ownership by engine storage, model sources, versions and chat options, and
// the start phases used below. SILOS_NO_MODEL_CATALOG=1 turns off the model
// sources (same pattern/use as SILOS_NO_AUTOTITLES: only for harnesses that
// must never spawn the CLI — npm run e2e sets it and seeds model-catalog.json).
const booted = bootHarnesses({
  dataDir: cfg.dataDir,
  home: cfg.home,
  root: cfg.root,
  port: cfg.port,
  silosApi,
  registry,
  asks,
  muted,
  ephemeral,
  modelCatalog: process.env.SILOS_NO_MODEL_CATALOG !== '1',
  log: (line) => console.log(line),
})
// a runtime may load a module lazily (Claude Code: its transcript watcher);
// nothing async has started yet, so this wait reorders nothing below
await booted.ready()
const index = booted.index
const store = new SessionStore(cfg.root, cfg.dataDir)
const native = new NativeStore(join(cfg.dataDir, 'native.json'))
const lineage = new LineageStore(join(cfg.dataDir, 'lineage.json'))
const prefs = new PrefsStore(cfg.dataDir)

// Providers v1: key-based providers (providers.json 0600) + Claude accounts
// derived from disk (~/.silos/claude-accounts/). ChatService uses them to
// resolve the env per agent on every turn (turn boundary, see fallback.ts).
const providers = new ProvidersStore(cfg.dataDir)
// a gateway's models are live data: re-read from each gateway at boot and on a timer
const gatewayModels = new GatewayModelsRefresher({ providers, log: (line) => console.log(line) })
providers.load()
// The Vault: env credentials for agent processes (vault.json 0600).
const vault = new VaultStore(join(cfg.dataDir, 'vault.json'))
vault.load()
// What an agent's brief says it can use from the Vault — delivered or signed —
// with its Vault view's semantics: the winner per name over EVERY folder it
// works in (envFor(id, null) dropped the folder ones)
const vaultCredentialsOf = (agentId: string): VaultCredential[] => {
  const a = registry.list(true).find((x) => x.id === agentId)
  return vault.credentialsFor(agentId, a ? territoriesOf(a) : [])
}
const territory = makeTerritory({ registry, agentState, store: territoryStore, home: cfg.home, dataDir: cfg.dataDir })
// What one agent's launches load (loads-scopes.ts, 0600, restore regime):
// Project › Tools' agent lines write it; every launch of the agent — chat,
// console, run, wake, round — carries it beside the fence, through its
// engine's allowlist. A deleted agent's entries go; an archived one's stay.
const loadsScopes = new LoadsScopesStore(cfg.dataDir)
loadsScopes.load()
seals.registerFile(LOADS_SCOPES_FILE, { onAdopt: () => loadsScopes.load() })
loadsScopes.prune(new Set(registry.list(true).map((a) => a.id)))
// In overlay order: the launch folder's (an engine whose project place is
// carried at launch — OpenCode; none is ever kept for another), then the
// agent's, then — given one of its sessions — its conversation's, keyed by
// the thread's root (threadIdOf, the one resolver).
const loadsCarried = (agentId: string, cwd?: string, sessionId?: string): unknown[] => {
  const a = registry.get(agentId)
  if (!a) return []
  let engine: string
  try {
    engine = harnessOf(a)
  } catch {
    return []
  }
  const there = cwd ?? a.folder
  return [
    there ? loadsScopes.payloadOf('folders', there, engine) : null,
    loadsScopes.payloadOf('agents', agentId, engine),
    sessionId ? loadsScopes.payloadOf('conversations', threadIdOf(sessionId), engine) : null,
  ].filter((p) => p !== null && p !== undefined)
}
// The plugin's birth markers (agent-state/<id>/births/*.json): every session
// that runs as an agent presents itself at start — births-store.ts.
const births = new BirthsStore(agentState)
// WHO a session belongs to — ONE resolver (session-owner.ts) shared by the
// server, the titler and the resident, so every surface agrees.
// A session an engine's own storage files under an agent is that agent's (Booted.ownership).
const owners = new SessionOwners({
  registry,
  native,
  lineage,
  index,
  trashDir: join(cfg.dataDir, 'trash'),
  births,
  agentOfDb: (id) => booted.ownership.agentOfDb(id),
  isContested: (id) => booted.ownership.isContested(id),
})
// Messages between agents (messages.ts): the server's
// store under <dataDir>/messages — fenced, sealed (restore: memory is the
// truth; «Keep the edit» of a message file is adopted through its rules).
const messages = new MessageStore(cfg.dataDir)
seals.registerDir(MESSAGES_DIR, { validate: (b, rel) => validateMessageFile(b, rel), onAdopt: (b, rel) => messages.adopt(b, rel) })
// the DERIVED control of an agent (control.ts controlOf): own only with its
// territory on and a mission — the one answer every reader asks
const controlOfId = (agentId: string): 'told' | 'own' => {
  const a = registry.get(agentId)
  return a ? controlOf(a, territoryStore.isEnabled(agentId)) : 'told'
}
// the EFFECTIVE proactive mode of an agent (control.ts
// proactiveOf) — what a wake or a run is judged by (it seals nothing)
const proactiveOfId = (agentId: string): { tools: boolean; perDay: number } | null => {
  const a = registry.get(agentId)
  return a ? proactiveOf(a, territoryStore.isEnabled(agentId)) : null
}
// a task as the plans reading has it now (the round's blocks, the duplicate)
// — and, cancelled, who and when (task-cancellations.ts: the owner only by
// Silos' record of the owner's Drop; when, from the plans journal)
const taskNowOf = (key: string): TaskNow | null => {
  // one reading per pass: the mission ledger asks one key per entry
  const t = tasksThisPass().get(key)
  if (!t) return null
  if (t.state !== 'cancelled') return { status: t.state, title: t.title, ref: t.ref }
  let since: number | null = null
  for (const c of siloRegistry.get(PLANS_SILO)?.status.conventions ?? []) {
    const s0 = siloJournal.since(c.dir, key, 'cancelled')
    if (s0 !== null && (since === null || s0 > since)) since = s0
  }
  return { status: t.state, title: t.title, ref: t.ref, cancel: taskCancellations.of(key, since) }
}
// Each engine's versions + the Settings update buttons (harness.ts), from its
// runtime's own options.
const harness = new HarnessService({ engines: booted.versionOptions(), completePath })
// Claude-named features (accounts, account load, titler, peers, accountPath,
// backupsDir, the skills catalog, the SDK query
// function) and the TUI pin follower stay here as they are — docs/harnesses.md
// "Still outside the folders (on purpose)".
// The default account is the machine's own claude login — asked with HOME =
// cfg.home (~/.claude), never os.homedir() directly, so the E2E harness
// (SILOS_HOME) asks its fixture home instead of the real login. Same rule
// as the skills catalog.
const accounts = new AccountsService({
  dataDir: cfg.dataDir,
  defaultConfigDir: join(cfg.home, '.claude'),
  identity: new ClaudeIdentityReader({ home: cfg.home }),
})
// Extra accounts follow the machine's settings (accounts.ts FOLLOWED_*):
// applied at boot and again whenever ~/.claude/settings.json or the
// personal skills change — not only when a page happens to list accounts,
// so a night run that falls back to another account never starts on a
// stale copy (a stale retention once deleted shared transcripts).
accounts.follow()
// (the DIR is watched: Claude replaces settings.json by rename, which a
// watch on the file itself would lose after the first save)
const refollow = (): void => {
  try {
    accounts.follow()
  } catch {
    /* next change retries */
  }
}
try {
  watch(join(cfg.home, '.claude'), { persistent: false }, (_e, name) => {
    if (name === 'settings.json' || name === 'CLAUDE.md') refollow()
  })
} catch {
  /* absent: the boot pass and every account listing still apply */
}
try {
  watch(join(cfg.home, '.claude', 'skills'), { persistent: false }, refollow)
} catch {
  /* no personal skills dir */
}

// The Silo Standard's registry (~/.silos/silos/registry/<id>/): manifests
// validated at boot and on every change, the kernel's status of each silo.
// Its own store — loading a silo never touches the session index or
// CACHE_VERSION. See silos/registry.ts.
// the operator's decisions — approvals, slots switched off, the producer
// binding — in ONE exportable file, ~/.silos/silos/operator.json
const siloOperator = new SiloOperatorStore(join(cfg.dataDir, 'silos'))
const siloRegistry = new SiloRegistry({ dataDir: cfg.dataDir, operator: siloOperator, nativeRefusal: (id) => HOUSE_DIMENSIONS.nativeRefusal(id) })
siloRegistry.load()
siloRegistry.watch()
// …and what each silo's sources hold: read at boot, on every registry change
// and every 5 min; counts land in status, an active silo's transitions in
// its convention's journal (silos/kernel.ts, reader.ts, journal.ts).
const siloLocations = houseLocations(agentState, registry)
// an agent's territories by id (archived included: its records stay its own)
const territoriesOfAgent = (agentId: string): string[] => {
  const a = registry.list(true).find((x) => x.id === agentId)
  return a ? territoriesOf(a) : []
}
// the runs-on line's 5h/weekly bars read this service (one call per account
// per 90 s, read-only on credentials):
// provider id → that account's config dir
const planUsage = new PlanUsageService({
  configDirOf: (id) => accounts.configDirs().find((a) => (a.name === 'default' ? 'default' : `account:${a.name}`) === id)?.configDir ?? null,
})
// Task mode's wakes (task-mode/store.ts) — the kernel kind `task-wake` the
// opt-in Task mode silo presents; its state lives in <dataDir>/task-mode/
const taskModeStore = new TaskModeStore(cfg.dataDir, () => {
  try {
    siloKernel.refresh(TASK_MODE_SILO)
  } catch {
    /* read at the kernel's next pass */
  }
})
// Silos' copy of each session's SDD ledger + plan document, taken as the
// session moves so the record outlives the worktree. See execution-store.ts.
const executions = new ExecutionStore(cfg.dataDir)
// The kernel kind `execution` (task-view phase 5, silos/executions.ts): every
// ledger the kernel reads — a conversation's saved copy, a live ledger in a
// managed folder's checkouts — each hung from the plan task it executes (its
// conversation in the task's conversations[], else the task's `source` names
// its document). The built-in Executions silo presents them.
const executionsSource = new ExecutionsSource({
  store: executions,
  sessions: () => {
    if (!index.isReady()) return []
    const out: Array<{ folder: string; id: string; cwd: string | null; ledgerPaths: string[] }> = []
    for (const m of index.allSessions()) {
      const paths = ledgerPathsOf(index.getContext(m.folder, m.id)?.files ?? [])
      if (paths.length > 0) out.push({ folder: m.folder, id: m.id, cwd: m.cwd ?? null, ledgerPaths: paths })
    }
    return out
  },
  checkouts: () => siloLocations.projects(),
  agentOf: (folder, id) => {
    const m = index.getMeta(folder, id)
    return m ? owners.agentIdOf(m) : null
  },
  sessionLive: (folder, id, now) => {
    const m = index.getMeta(folder, id)
    return m ? sessionAtWork(m, now, cfg.liveMs) : false
  },
  liveMs: cfg.liveMs,
  tasks: () => {
    const entry = siloRegistry.get(PLANS_SILO)
    return entry && entry.status.state === 'active'
      ? taskRefsOf(siloKernel.reading(PLANS_SILO), entry.manifest ? standingIdsOf(entry.manifest, 'plan') : new Set<string>())
      : null
  },
})
// a ledger moved (a conversation wrote it) or a plan did: read the executions
// again, coalesced — the kernel's 5-minute pass stays the fallback
let executionsRefresh: NodeJS.Timeout | null = null
function refreshExecutionsSoon(): void {
  executionsSource.invalidate()
  if (executionsRefresh) return
  executionsRefresh = setTimeout(() => {
    executionsRefresh = null
    try {
      siloKernel.refresh(EXECUTIONS_SILO)
    } catch {
      /* read at the kernel's next pass */
    }
  }, 2_000)
  executionsRefresh.unref?.()
}
// What the Silos side knows of a conversation: its thread's tip, title,
// agent and whether it runs now (a turn, a live console of its thread, a
// live holder) — the ONE liveness rule the System silo's kinds read
// (processes left, worktrees in use).
const conversationFactsOf: ConversationLookup = (ids) => {
  const metas = index.allSessions()
  const byId = new Map(metas.map((m) => [m.id, m]))
  let consoles: Set<string> | null = null
  const out = new Map<string, ConversationFacts | null>()
  for (const id of ids) {
    const meta = byId.get(id)
    if (!meta) {
      out.set(id, null)
      continue
    }
    // a /clear rotated it: the conversation is its thread's tip now
    const { tip, ids: thread } = conversationThread(meta, { metas, lineage, ancestry: owners.ancestry })
    // the last tmux listing (no fork here: a stale one is refreshed in the background)
    consoles ??= new Set(terminals.knownConsoleKeys() ?? [])
    const live = consoles
    const running = thread.some((t) => chat.isSessionActive(t) || live.has(t)) || terminals.holdersOf(tip.id).length > 0
    out.set(id, { session: tip.id, folder: tip.folder, agent: owners.agentIdOf(tip), title: sessionTitleOf(tip.id)?.title ?? null, running })
  }
  return out
}
// The kernel kind `process` (silos/processes.ts): the processes conversations
// left on this machine, read from /proc every 30 s (proc-table.ts — async,
// bounded; no /proc = no data). Attributed by the session variables (Silos'
// own + each engine's traits.sessionEnvKeys), the engines' own processes
// told apart by their command (Harness.binary); whether a conversation still
// runs is asked of the same pieces the trash asks (a turn, a live console of
// its thread, a live holder). The built-in System silo presents them.
// SILOS_NO_PROCESS_SCAN=1 (the E2E harness) keeps the store, reads nothing.
const processRecords = new ProcessRecords({
  file: ProcessRecords.fileIn(join(cfg.dataDir, 'silos')),
  // SILOS_PROC_ROOT: a fixture /proc (an isolated server reads no machine's processes)
  table: linuxProcTable(process.env.SILOS_PROC_ROOT ? { procRoot: process.env.SILOS_PROC_ROOT } : {}),
  sessionKeys: () => [SILOS_SESSION_KEY, ...registeredHarnesses().flatMap((h) => h.traits.sessionEnvKeys ?? [])],
  engineCommands: () => new Set(registeredHarnesses().flatMap((h) => (h.binary ? [basename(h.binary.command())] : []))),
  selfPid: process.pid,
  ready: () => index.isReady(),
  conversations: conversationFactsOf,
  onChange: () => {
    try {
      siloKernel.refresh(PROCESS_SILO)
    } catch {
      /* read at the kernel's next pass */
    }
  },
})
// The kernel kind `worktree` (silos/worktrees.ts): the linked git worktrees
// of every project folder Silos knows, each with what of it is not in the
// default branch, the conversation that made or works it (the engines'
// placement — a transcript moved into it, a subagent spawned into it — or a
// conversation whose cwd is inside) and the processes inside (the table the
// `process` kind already scanned). Merged ones idle 6 h are closed by Silos
// itself; the owner removes others from the System silo. Every 60 s.
// SILOS_NO_WORKTREE_SCAN=1 (the E2E harness, isolated servers) reads nothing.
const worktreeRecords = new WorktreeRecords({
  file: WorktreeRecords.fileIn(join(cfg.dataDir, 'silos')),
  trashDir: join(cfg.dataDir, 'trash'),
  projects: () => siloLocations.projects(),
  ready: () => index.isReady(),
  sessionsIn: async (wts, project) => {
    const dirs = wts.map((w) => w.dir)
    // a session older than the oldest worktree (an hour of slack: the engine's
    // sidecar may be written before git makes the folder) made none of them
    const since = Math.min(...wts.map((w) => w.createdAt)) - 3600_000
    const out = await index.worktreeSessions(project, dirs, since)
    for (const m of index.allSessions()) {
      if (!m.cwd) continue
      for (const d of dirs)
        if (m.cwd === d || m.cwd.startsWith(`${d}/`)) {
          const l = out.get(d)!
          if (!l.includes(m.id)) l.push(m.id)
        }
    }
    return out
  },
  conversations: conversationFactsOf,
  inside: (dirs, o) => processRecords.inside(dirs, { fresh: o.fresh }),
  onChange: () => {
    try {
      siloKernel.refresh(PROCESS_SILO)
    } catch {
      /* read at the kernel's next pass */
    }
  },
})
const kernelKinds = (kind: string): TaskModeStore | ExecutionsSource | ProcessRecords | WorktreeRecords | null =>
  kind === 'task-wake'
    ? taskModeStore
    : kind === 'execution'
      ? executionsSource
      : kind === 'process'
        ? processRecords
        : kind === 'worktree'
          ? worktreeRecords
          : null
const siloReader = new SiloReader(siloLocations, kernelKinds)
const isAgentId = (v: string): boolean => registry.list(true).some((a) => a.id === v)
// an agent IN PLAY (listed, not archived): who works a silo's rows — routing,
// «with Finance», the producer brief, message-agent, producer writes, the binding
// — counts only these; isAgentId (archived included) stays for actor reading
const isAgentInPlay = (v: string): boolean => registry.list().some((a) => a.id === v)
const siloJournal = new TransitionJournal(siloRegistry.conventionsDir) // per convention — survives uninstall (silos/journal.ts)
// Home's silo rows change with the clock alone (a predicate with `now`): after
// every kernel read the board's silo fingerprint is compared and a `silos`
// WS event tells the web to re-fetch (the 20 s board poll stays the fallback).
let siloSignature = ''
// filled once the server exists (app.checkInboxNow) — the kernel reads before it does
const inboxCheckBox: { now: () => void } = { now: () => {} }
// the plans reader stamps and judges (plans-provenance.ts):
// fed with every reading of the plans silo — built below, once the
// actions it writes through exist
const plansStamperBox: { v: PlansProvenance | null } = { v: null }
// (B2) the asks — built further down, read lazily by the
// start briefing and the heartbeat's facts
const taskAsksBox: { v: TaskAsks | null } = { v: null }
// (B2.5, H8) when `to` sees an ask armed at `atMs` by itself (task-asks.ts
// askSeenByOf, over the agent as the registry has it now)
function askSeenBy(to: string, atMs: number): number | null {
  const a = registry.get(to)
  if (!a) return null
  const hb = heartbeatOf(a)
  return askSeenByOf(
    { archived: a.archived === true, bound: taskModeBound().has(to), own: controlOfId(to) === 'own', period: hb.period, sleepUntil: hb.sleepUntil ?? null },
    atMs,
  )
}
const initiativeBox: { v: Initiative | null } = { v: null }
const plansOriginsBox: { v: PlansOrigins | null } = { v: null }
const siloKernel: SiloKernel = new SiloKernel({
  registry: siloRegistry,
  reader: siloReader,
  journal: siloJournal,
  onReading: (id, reading) => {
    if (id === PLANS_SILO) plansStamperBox.v?.onReading(plansSnapshotOf(reading.records))
  },
  onRefresh: () => {
    const sig = siloSurfaces.signature(Date.now()) + siloKernel.contentStamp()
    if (sig !== siloSignature) {
      const first = siloSignature === ''
      siloSignature = sig
      if (!first) {
        broadcastBox.send({ ev: 'silos' })
        // the doorbell compares the inbox now, not at the next resident tick
        inboxCheckBox.now()
      }
    }
  },
  overlay: new OverlayStore(siloRegistry.conventionsDir), // the owner's writes over sync sources (silos/overlay.ts)
  isAgent: isAgentId,
  // the daily sweep (plans 0.5.2, E7): a project's list that EXISTS rotates
  // once per project and day, even when nobody adds a task (never makes one)
  onTick: () => {
    siloActions.rotateSweep()
  },
})
// what the active silos add to Home: pulse terms, needs-you rows (entries,
// overlay conflicts, proposals), Done today from the journal (silos/surfaces.ts)
// the v0 actions; their events go to ~/.silos/silos/events.jsonl, acks to
// silos/acks.json, proposals to silos/proposals/ (silos/actions.ts)
const siloEvents = new SiloEvents(siloRegistry.root)
const siloActions = new SiloActions({
  registry: siloRegistry,
  kernel: siloKernel,
  events: siloEvents,
  acks: new SiloAcks(siloRegistry.root),
  proposals: new SiloProposals(siloRegistry.root),
  messages,
  agentStateBase: join(cfg.dataDir, 'agent-state'),
  isAgent: isAgentId,
  producersOf: (id) => siloOperator.producersOf(id),
  inPlay: isAgentInPlay,
  // where ensure-record may make a record: the project folders sources read
  locations: siloLocations,
  // the thread a conversation id is on (task-threads.ts threadKey, R13) —
  // what groups a task's releases[]; read lazily, at write time
  threadKey: (id) => threadsOfTasks(5_000).threadKey(id),
  // a task's current conversations (R13) — whether a release let go the LAST
  // current thread, the one case its dispose sets the state (plans 0.5.2)
  currentOf: (listed, releases) => threadsOfTasks(5_000).currentOf(listed, releases),
  // what an agent's location already lets it read on disk: its own state,
  // and project folders inside its territories
  agentMayReadLocation: (agentId, location) => bearerMayReadLocation(agentId, location, territoriesOfAgent),
  // (J3, K4) every owner write on a plan task is the
  // stamper's expected shape — never reverted as an unattended turn's
  ownWrite: (silo, key, shape) => (silo === PLANS_SILO && plansStamperBox.v ? plansStamperBox.v.ownWrite(key, shape) : () => {}),
})
// install / approve / reject / uninstall (silos/installer.ts): submissions in
// silos/submissions/, uninstalled manifests in silos/uninstalled/
const siloInstaller = new SiloInstaller({
  root: siloRegistry.root,
  registry: siloRegistry,
  operator: siloOperator,
  kernel: siloKernel,
  events: siloEvents,
  locations: siloLocations,
  agentStateBase: join(cfg.dataDir, 'agent-state'),
  isAgent: isAgentId,
  inPlay: isAgentInPlay,
  // every agent in play holds a bearer, fenced or not (G1)
  hasBearer: (agentId) => isAgentInPlay(agentId),
  territoriesOf: territoriesOfAgent,
  // the automations store is built further down (with the resident); reached lazily
  automations: { create: (a) => automations.create(a), get: (id) => automations.get(id), update: (id, p) => automations.update(id, p) },
  messages,
  credentialNames: vaultCredentialsOf,
  kernelKinds, // the owner's dry-run of a kernel source reads what the kernel holds
})
const siloSurfaces = new SiloSurfaces({
  registry: siloRegistry,
  kernel: siloKernel,
  journal: siloJournal,
  isAgent: isAgentId,
  inPlay: isAgentInPlay,
  acks: new SiloAcks(siloRegistry.root),
  proposals: (id) => siloActions.proposalsNeedsYou(id),
  producersOf: (id) => siloOperator.producersOf(id),
  audienceOff: (id) => siloOperator.audienceOff(id),
  uninstalledGrowth: () => siloInstaller.growth(),
  submissions: () => siloInstaller.needsYou(), // pending manifests waiting for the approval click
  // the live facts a task's flow reads at request time (silos/task-flow.ts,
  // G4): a conversation live by the resident's busy rule, an agent's wake by
  // its runmode — the same floor the plan routes report (agent-wakes.ts).
  // `chat` is built further down; reached lazily, only at request time.
  taskEnv: {
    isLive: (sessionId) => liveConversation(sessionId),
    // the THREAD's conversations, not only the listed ones (a /clear tip)
    threadLive: (ids) => threadsOfTasks(5_000).anyLive(ids, liveConversation),
    // the task's CURRENT conversations (R13 — releases[] let some go)
    currentOf: (listed, releases) => threadsOfTasks(5_000).currentOf(listed, releases),
    wakes: (agentId) => (isAgentInPlay(agentId) && taskModeBound().has(agentId) ? wakesOfControl('own') : 'never'),
    // the door can start it: in play, with a folder (F11)
    startable: (agentId) => isAgentInPlay(agentId) && !!registry.get(agentId)?.folder,
    // a task-mode wake on its way (G2) — the engine is built further down,
    // reached lazily (a read before it exists says none)
    wakeOnTheWay: (q) => {
      try {
        return taskMode.wakeOnTheWay(q)
      } catch {
        return false
      }
    },
    // a conversation's title and last activity (the turn's «last in …»)
    titleOf: (sessionId) => sessionTitleOf(sessionId),
    // (B2.5) the ask its owner armed on the task — the fact
    // Task mode's store holds — with
    // when the asked agent's next heartbeat falls, counted from the ask (H8)
    askOf: (key) => {
      const f = taskModeStore.armedOf(key)
      return f ? { ...f, seenBy: askSeenBy(f.to, Date.parse(f.at)) } : null
    },
  },
  nameOf: (agentId) => registry.list(true).find((a) => a.id === agentId)?.name ?? agentId,
  // the escalation (escalation/engine.ts, built further down; reached lazily):
  // a routed row that rose to the owner, and the escalated tasks' rows
  escalatedRow: (silo, entry, key) => escalation.escalatedRow(silo, entry, key),
  escalations: () => escalationRows(),
})
// a task's thread read through the one membership rule (task-threads.ts):
// one pass over the index + lineage, kept `ttlMs` (a request evaluating many
// tasks reads it once; the engine asks with 0 — a fresh read)
// The thread tools (thread-tools.ts, transcript-only.ts) are built further
// down — after `terminals` and `origins` — and reached through this box, only
// at request time. When the cache expires (never on every kernel read: a
// rotation absorbed mid-read would broadcast mid-read) the console rotations
// are absorbed first, so the wakes, /talk, /work and the door read the same.
const threadTools: {
  absorbRotations: () => void
  continuable: ((metas: readonly SessionMeta[]) => (m: SessionMeta) => boolean) | null
  nativeIdOf: (id: string) => string | null
} = { absorbRotations: () => {}, continuable: null, nativeIdOf: () => null }
let taskThreadsCache: { at: number; v: TaskThreads } | null = null
const threadsOfTasks = (ttlMs: number): TaskThreads => {
  const now = Date.now()
  if (!taskThreadsCache || now - taskThreadsCache.at > ttlMs) {
    threadTools.absorbRotations()
    const metas = index.allSessions()
    const continuable = threadTools.continuable?.(metas)
    taskThreadsCache = {
      at: now,
      v: taskThreads({
        metas,
        lineage,
        ownerOf: (m) => owners.agentIdOf(m),
        nativeIdOf: (id) => threadTools.nativeIdOf(id),
        ...(continuable ? { continuable } : {}),
      }),
    }
  }
  return taskThreadsCache.v
}
const liveConversation = conversationLive({ isActive: (id) => chat.isSessionActive(id), sessions: () => index.allSessions(), liveMs: cfg.liveMs })
const backgroundBusyNow = backgroundBusy({ sessions: () => index.allSessions(), liveMs: cfg.liveMs })
// (m4) a claim, a release or a link drops the threads' cache in
// the same request (the next read rebuilds it)
const invalidateTaskThreads = (): void => {
  taskThreadsCache = null
  endPass()
}
// a conversation's title (the owner's, the auto-title, else the engine's)
// and its last activity — read over the index once per 5 s
let titleCache: { at: number; byId: Map<string, { title: string | null; at: number | null }> } | null = null
function sessionTitleOf(sessionId: string): { title: string | null; at: number | null } | null {
  const now = Date.now()
  if (!titleCache || now - titleCache.at > 5_000) {
    const resolve = store.titleResolver()
    titleCache = { at: now, byId: new Map(index.allSessions().map((m) => [m.id, { title: resolve(m.folder, m.id, m.title).title || null, at: m.mtime }])) }
  }
  return titleCache.byId.get(sessionId) ?? null
}
// (E6) every plan task with its flow and turn, as the Plans silo's
// voice reads them NOW — the inbox's task lines and «N tasks stalled»
function taskFlowsNow(now: number): TaskFlowFact[] {
  const entry = siloRegistry.get(PLANS_SILO)
  const reading = siloKernel.reading(PLANS_SILO)
  if (!entry || entry.status.state !== 'active' || !entry.manifest || !reading) return []
  const base: KindRecord[] = reading.records.map((r) => baseRecordOf(r))
  const v = siloSurfaces.voice(PLANS_SILO, now)
  const kinds = kindsOf(entry.manifest)
  const out: TaskFlowFact[] = []
  for (const info of kinds.values()) {
    const role = info.dict.task
    if (!role || !info.parent) continue
    for (const r of recordsOfKind(kinds, base, info.name)) {
      const flow = flowOf(info, r, v)
      if (!flow) continue
      const owner = typeof r.rec[role.owner] === 'string' ? (r.rec[role.owner] as string).trim() : ''
      // the one ref form (task-ref.ts): `<project>#t3` for the project's list
      const refOf = siblingRefOf(entry.manifest, info, r, reading.records)
      const turn = turnOf(r.rec, r.siblings ?? [], info.dict, refOf, {
        now,
        key: r.key,
        ...(v.isAgent ? { isAgent: v.isAgent } : {}),
        ...(v.taskEnv ? { taskEnv: v.taskEnv } : {}),
        ...(v.nameOf ? { nameOf: v.nameOf } : {}),
        ...(r.unreadableSiblings ? { unreadableSiblings: r.unreadableSiblings } : {}),
      })
      out.push({
        key: r.key,
        planKey: r.parentKey ?? '',
        ref: refOf(String(r.rec.id)),
        title: typeof r.rec.title === 'string' ? r.rec.title : String(r.rec.id),
        owner,
        state: String(r.rec.state ?? r.rec.status ?? ''),
        ready: holds('ready', info, r, v),
        flow,
        ...(turn && turn.sentence ? { sentence: turn.sentence } : {}),
      })
    }
  }
  return out
}
// (A1.7) the closed plans (plans/closed/) that still hold
// open tasks — read through the Plans silo's own rules (plans-closed.ts,
// parsed once per file mtime), only for the inbox's one routine row: never a
// list, never a wake
const closedPlansReader = new ClosedPlans({
  siloId: PLANS_SILO,
  manifest: () => {
    const e = siloRegistry.get(PLANS_SILO)
    return e?.manifest && e.status.state === 'active' ? (e.manifest as Record<string, unknown>) : null
  },
  conventionDirs: () =>
    siloKernel
      .watchedFolders()
      .filter((w) => w.silo === PLANS_SILO)
      .map((w) => w.dir),
})
function closedPlansNow(): Array<{ key: string; title: string; folder: string | null; file: string; open: number }> {
  return closedPlansReader.records({ now: Date.now(), isAgent: isAgentId }).map((r) => ({
    key: `${r.location}/${r.record.id}`,
    title: typeof r.record.title === 'string' && r.record.title !== '' ? r.record.title : String(r.record.id),
    folder: r.location.startsWith('folder:') ? r.location.slice('folder:'.length) : null,
    file: r.file,
    open: (Array.isArray(r.record.tasks) ? (r.record.tasks as Array<Record<string, unknown>>) : []).filter((t) => t.state !== 'done' && t.state !== 'cancelled')
      .length,
  }))
}
// the silos that come WITH Silos (silos/native.ts, served 'builtin'): installed
// by the platform now, born active, said as an event — unless the owner ever
// decided on that id (an uninstall is respected at every boot). Support
// and plans are builtin; the table flips a dimension only with its kernelectomy.
for (const b of siloInstaller.installBuiltins()) if (b.outcome !== 'kept') console.log(`silos: builtin ${b.id} ${b.outcome} — ${b.says}`)
// POST /api/silos/validate: the eleven checks + the text preview (owner-only).
// The producer role is a word of the manifest, never an agent id: the
// approval dialog binds it to agents and checks their bearers there.
const siloValidate = createSiloValidate({
  registry: siloRegistry,
  reader: siloReader,
  // an agent's dry-run reads its own territory only (silos/bearer-scope.ts)
  readerFor: (agentId) => new SiloReader(bearerLocations(siloLocations, agentId, territoriesOfAgent)),
  isAgent: isAgentId,
  agentStateBase: join(cfg.dataDir, 'agent-state'),
})

// Cabin (selectors): per-conversation prefs (the cascade's middle level) +
// the honest model catalog (its sources: Booted.modelSources, empty under
// SILOS_NO_MODEL_CATALOG=1).
const convPrefs = new ConversationPrefsStore(cfg.dataDir)
convPrefs.load()
// Durable unread state: "last seen" per conversation. See seen-store.ts / unread.ts.
const seen = new SeenStore(cfg.dataDir)
seen.load()
// «New to you» on plan tasks: the owner's read marks. See task-seen-store.ts.
const taskSeen = new TaskSeenStore(cfg.dataDir)
taskSeen.load()
// The owner's "Seen" on an escalation in Needs you. See needs-you-acks.ts.
const needsYouAcks = new NeedsYouAcksStore(cfg.dataDir)
needsYouAcks.load()
// what the agents propose and the owner decides (proposals.ts)
const proposals = new ProposalsStore(cfg.dataDir)
proposals.load()
// the built-ins are checked here: a broken one stops the boot, not a use
const automationTemplates = new AutomationTemplates(cfg.dataDir)
// The daily digest's files and hour, and the doorbell's Web Push adapter
// — the jobs start once the index is warm, below.
const digests = new DigestStore(cfg.dataDir)
const notificationPrefs = new NotificationPrefsStore(cfg.dataDir)
const pushDevices = new PushSubscriptionsStore(cfg.dataDir)
pushDevices.load()
const doorbell = new WebPushDoorbell({ keys: loadOrCreateVapidKeys(cfg.dataDir), store: pushDevices })
// a model picked inside an OpenCode TUI becomes the conversation's pin (pin-follower.ts)
const pinFollower = new TuiPinFollower({ providers, convPrefs, log: (line) => console.log(line) })
index.on('session', (m: SessionMeta) => {
  try {
    pinFollower.onSession(m)
  } catch {
    /* best effort */
  }
})
index.on('session', (m: SessionMeta) => {
  try {
    // no ledger named: nothing to copy (the detail route still serves a saved copy)
    const paths = ledgerPathsOf(index.getContext(m.folder, m.id)?.files ?? [])
    if (paths.length === 0) return
    executions.capture(m.folder, m.id, paths, m.cwd ? [m.cwd] : [])
    refreshExecutionsSoon()
  } catch {
    /* a copy is best effort */
  }
})
const catalog = new ModelCatalog(cfg.dataDir, booted.modelSources())
catalog.load()

// Agent context: files under <folder>/context/ the agent reads on demand;
// ChatService appends the availability note.
const context = new ContextService()
// ChatService builds each engine's chat turn through its harness's headless
// factory, with that runtime's own options.
// the turn tokens (live-turns.ts): minted by every
// chat turn and every console, read by the classification of bearer writes;
// console entries persist in live-turns.json (an SDK turn never survives a
// restart — a console does)
// usage told to Silos ID (instance-usage.ts) — set once Silos ID is known
// below; every turn counts from the first
let instanceUsage: InstanceUsage | null = null
const liveTurns = new LiveTurns({ file: join(cfg.dataDir, 'live-turns.json'), onTurn: (attended) => instanceUsage?.countTurn(attended) })
// the serving of an inbox, marked by the class of the turn — one for
// the chat engines and the messages route
const messageReads = new MessageReads(messages, liveTurns, (agentId) => taskAsksBox.v?.asksTo(agentId) ?? [])
// Usage: the windows each turn and console opens
// (usage-ledger.ts) and the reader that drops every transcript record into
// one (usage.ts). Its closures reach stores built further down — called
// only once turns run.
let usageTaskTitles: { at: number; byKey: Map<string, string> } | null = null
const usage = new UsageService({
  ledger: new UsageLedger(join(cfg.dataDir, 'usage')),
  sessions: { all: () => index.allSessions(), usageRecords: (f, i) => index.usageRecords(f, i), silosOwnUsage: (s) => index.silosOwnUsage(s) },
  threadKeyOf: (m, lookup) => threadRootKey(m, lookup),
  nestedParentOf: (m) => owners.nestedOf(m)?.parent ?? null,
  engineLabelOf: (m) => harnessById(m.harness ?? harnessForId(m.id)).label,
  labels: {
    agent: (id) => registry.list(true).find((a) => a.id === id)?.name ?? id,
    automation: (id) => {
      const a = automations.get(id)
      if (!a) {
        // a heartbeat no longer armed keeps its name: «<agent>'s heartbeat»
        const agentId = id.startsWith('heartbeat-') ? id.slice('heartbeat-'.length) : null
        return agentId && heartbeatAutomationId(agentId) === id && registry.get(agentId) ? `${registry.get(agentId)!.name}'s heartbeat` : null
      }
      return a.id === heartbeatAutomationId(a.agentId) ? `${registry.get(a.agentId)?.name ?? a.agentId}'s heartbeat` : a.name
    },
    task: (key) => {
      if (!usageTaskTitles || Date.now() - usageTaskTitles.at > 30_000)
        usageTaskTitles = { at: Date.now(), byKey: new Map(taskMode.tasks().map((t) => [t.key, t.title])) }
      return usageTaskTitles.byKey.get(key) ?? null
    },
    // an account by its name («default», «work»), a priced provider by its label
    provider: (id) => {
      const p = providers.resolve(id)
      return p?.kind === 'claude-account' ? (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id) : (p?.label ?? id)
    },
  },
  // «Silos itself» and a loose record whose conversation named no provider
  // are billed to the machine's default (a plan: no dollars)
  defaultProvider: () => providers.resolve(undefined),
  planReading: (account) => {
    const u = planUsage.peek(account)
    if (!u) {
      void planUsage.get(account).catch(() => null)
      return null
    }
    if (!u.ok) return null
    return { weeklyPercent: weeklyPercentOf(u.windows), fiveHourPercent: u.windows.find((w) => w.windowMs === 5 * 3600_000)?.percent ?? null }
  },
  // a run's automation as it is when its window opens — sealed there (F):
  // deleting or accepting it later never rewrites a past day
  runOfNow: (id) => {
    const a = automations.get(id)
    if (!a) return null
    if (a.id === heartbeatAutomationId(a.agentId) || a.origin === 'self') return a.acceptedFrom !== undefined ? 'accepted' : 'own'
    return 'yours'
  },
  gestureOf: (turnId, turn) => {
    if (turn.class === 'wake') return taskMode.gestureOfTurn(turnId)
    if ((turn.class === 'run' || turn.class === 'heartbeat') && turn.automationId && turn.runId) {
      const r = automations.runById(turn.automationId, turn.runId)
      return r ? r.cause === MANUAL_CAUSE : undefined
    }
    return undefined
  },
  // «one money»: a turn that ended without its price gets its
  // transcript's, where own-turns.ts reads it
  writeCost: (w, c) => {
    if (c.costUsd === null) return 'skip'
    const cost = { costUsd: c.costUsd, ...(c.model ? { model: c.model } : {}), priced: w.priced }
    if (w.class === 'wake') return taskMode.costFromTranscript(w.id, cost)
    if ((w.class === 'run' || w.class === 'heartbeat') && w.automationId && w.runId) return automations.patchRunCost(w.automationId, w.runId, cost)
    return 'skip'
  },
})
// «which conversation is this session?» — the ONE resolver (task-threads.ts):
// chat (its context news, the console hook's queue) and the routes share it
const threadIdOf = makeThreadIdOf({ lineage, metaById: (id) => index.metaById(id) })
const toolHealth = new ToolHealthLedger(join(cfg.dataDir, 'tool-health'))
const chat = new ChatService({
  toolHealth,
  threadIdOf,
  usage,
  liveTurns,
  messageReads,
  producerBriefFor: (id, has) =>
    producerBriefFor(id, has, { registry: siloRegistry, operator: siloOperator, inPlay: isAgentInPlay, credentialNames: vaultCredentialsOf }),
  registry,
  native,
  queryFn: sdkQueryFn,
  dataDir: cfg.dataDir,
  lineage,
  providers,
  convPrefs,
  catalog,
  context,
  vault,
  silosApi,
  agentState,
  territory,
  loadsCarried,
  loginDirs: () => accounts.configDirs().map((c) => c.configDir),
  headlessOptions: booted.headlessOptions(),
  compatGate: (h) => harness.refusal(h, 'chat'),
  settings: platformSettings,
})

// Auto-resume for interactive chats: durable records of rate-limited
// interactive turns — the resident resends them at reset. See
// pending-resumes-store.ts.
const pendingResumes = new PendingResumesStore(cfg.dataDir)
pendingResumes.load()
const exec = new ExecService(registry)
// Skills catalog reads <home>/.claude/skills — cfg.home, never os.homedir()
// directly (same rule as the default account), so tests and the E2E harness
// point it at a fake home via SILOS_HOME instead of the machine's real ~/.claude.
// The 4th arg binds the held-skills store (<dataDir>/skills-held) so the
// catalog can name each skill's state and list the held ones (skill-states.ts).
// the skills an agent's ENGINE loads (Harness.traits.skillLoad): an unknown
// framework loads none beyond folder + personal copies
// (personal: whether it loads ~/.claude/skills — absent = yes)
// Consent-first autonomy skill install: the plugin's skill sources live at
// the repo root (plugin/skills/<name>/SKILL.md), two levels up from this
// file — same relative-path idiom as webDist in config.ts. The catalog's
// 'available' is exactly these (the add route copies only from here).
const pluginSkillsDir = join(import.meta.dirname, '..', '..', 'plugin', 'skills')
const complete = new CompleteService(
  registry,
  index,
  join(cfg.home, '.claude', 'skills'),
  (folder) => heldSkills(cfg.dataDir, folder),
  (agent) => {
    const load = findHarness(agent.framework ?? fallbackHarness().id)?.traits.skillLoad
    const base = load
      ? { claudePlugins: load.claudePlugins, ...(load.personal !== undefined ? { personal: load.personal } : {}), ...(load.roots ? { roots: load.roots } : {}) }
      : { claudePlugins: false }
    // + the role's own skills (role-plugin.ts): the catalog reads the same
    // disk every launch passes, so Knows & can names them from truth
    let roleState: string | null = null
    try {
      roleState = agentState.pathFor(agent.id)
    } catch {
      /* unsafe id: no role skills */
    }
    return withRoleSkills(base, agent.id, roleState)
  },
  pluginSkillsDir,
  cfg.claudeManagedDir,
  (agent) => {
    // what the agent's engine reads of its Claude account's skills and the
    // folder's positions (Harness.loads.skills, folder-loads.ts)
    if (!agent.folder) return null
    const id = agent.framework ?? fallbackHarness().id
    const skills = folderSkills(
      {
        index,
        registry,
        home: cfg.home,
        ...(cfg.claudeManagedDir ? { managedDir: cfg.claudeManagedDir } : {}),
        configDirs: () => accounts.configDirs().map((c) => c.configDir),
      },
      agent.folder,
      id,
    )
    return skills ? { skills, switches: findHarness(id)?.loads?.skillSwitch !== undefined } : null
  },
  (agent, asks, conversation) => {
    // each skill's «Where it loads»: machine, project, each agent of the
    // folder with what Silos keeps for it — and, asked by one conversation's
    // column, that conversation's line (folder-loads.ts, loads-scopes.ts)
    if (!agent.folder) return null
    const id = agent.framework ?? fallbackHarness().id
    return folderSkillPlaces(
      {
        index,
        registry,
        home: cfg.home,
        ...(cfg.claudeManagedDir ? { managedDir: cfg.claudeManagedDir } : {}),
        configDirs: () => accounts.configDirs().map((c) => c.configDir),
        loadsScopes,
      },
      agent.folder,
      id,
      asks,
      conversation,
    )
  },
)
// every instruction file the engines list for a folder, the boundary its
// writes are judged against (folder-instructions.ts, spec memory-places T3)
const memory = new MemoryService(cfg.root, cfg.dataDir, registry, {
  instructions: {
    home: cfg.home,
    index,
    loginDirs: () => accounts.configDirs().map((c) => c.configDir),
    ...(cfg.claudeManagedDir ? { managedDir: cfg.claudeManagedDir } : {}),
  },
})
// File viewer/editor: serves any absolute path to an authenticated request
// (same boundary as the PTY terminal) — see file-service.ts.
const files = new FileService(cfg.dataDir)
const terminals = new TerminalService(registry, index, undefined, undefined, {
  // claude's live locks under the CONFIGURED home (SILOS_HOME), like
  // PeerRegistry — the e2e harness read the machine's real ones
  sessionsDir: join(cfg.home, '.claude', 'sessions'),
  rotationsDir: join(cfg.dataDir, 'console-rotations'),
  appendDir: join(cfg.dataDir, 'console-append'),
  // Silos-owned records of engine consoles (agent, port, password, bound
  // id) — what a restart rebuilds the console maps from (registrar rehydrate)
  consolesDir: join(cfg.dataDir, 'consoles'),
  liveTurns,
  // Usage's console windows: open while the tmux lives; the provider
  // is the console's own cascade (ChatService.consoleProviderFor)
  consoleLife: {
    launched: (c) =>
      usage.consoleOpened({
        key: c.key,
        agentId: c.agentId,
        folder: mungePath(c.cwd),
        sessionId: c.sessionId,
        provider: chat.consoleProviderFor(c.agentId, c.cwd, c.sessionId, c.providerPick),
      }),
    gone: (key) => usage.consoleClosed(key),
    // a live console without a window (launched before the register, or
    // the window lost) gets one now, under the agent Silos knows it by: the
    // one it launched it for, the one its token was minted for, else the
    // conversation's owner — never a console whose conversation it can't see
    alive: (keys) =>
      usage.consolesAlive(keys, (key) => {
        const sid = terminals.nativeIdOf(key) ?? key
        const meta = index.allSessions().find((m) => m.id === sid)
        if (!meta) return null
        const agentId = terminals.consoleAgent(key) ?? liveTurns.consoleAgentOf(key) ?? owners.agentIdOf(meta)
        const agent = registry.get(agentId)
        if (!agent) return null
        const cwd = meta.cwd ?? agent.folder
        return { agentId, folder: meta.folder, sessionId: sid, provider: cwd ? chat.consoleProviderFor(agentId, cwd, sid) : null }
      }),
  },
  // the auto-sleep times a console by its thread's latest session, not its key
  lastActivityOf: (key) => {
    const mtimeOf = (k: string): number | null => index.allSessions().find((m) => `${m.folder}/${m.id}` === k)?.mtime ?? null
    const meta = index.allSessions().find((m) => m.id === key)
    if (!meta) return null
    return mtimeOf(lineage.recentTipOf(`${meta.folder}/${meta.id}`, mtimeOf))
  },
}) // an explicit instance so it can killAll() on shutdown, below

// What every engine's start phases reach (compose.ts HarnessStartContext).
const harnessStart = { index, terminals, births, native, convPrefs, root: cfg.root, muted, ephemeral }
// Before the server: each runtime's own wiring (OpenCode: the console
// registrar, its 5 s sweep and the reader → seal hook); its server options
// become ServerDeps.engines.
const engines = booted.beforeServer(harnessStart)

// the trash empties itself after 30 days — at boot and every
// 6 h; deleting still only ever MOVES to the trash (invariant 3).
// Same pass prunes the inboxes: delivered messages (read/answered)
// untouched for 30 days (messages.ts MESSAGE_KEEP_MS); unread never.
const runTrashPurge = (): void => {
  const { removed } = purgeTrash(join(cfg.dataDir, 'trash'))
  if (removed > 0) console.log(`trash purged: ${removed} entries older than 30 days`)
  try {
    const pruned = messages.prune().removed
    if (pruned > 0) console.log(`inboxes pruned: ${pruned} delivered messages older than 30 days`)
  } catch (err) {
    console.warn('inbox prune failed —', err instanceof Error ? err.message : err)
  }
}
runTrashPurge()
setInterval(runTrashPurge, TRASH_PURGE_INTERVAL_MS).unref()

// Automations resident — lives outside buildServer (it needs the real
// cfg.root/cfg.dataDir) but shares the WS broadcast() that buildServer
// defines internally, via the mutable broadcastBox (see the comment on
// ServerDeps.broadcastBox in server.ts).
const automations = new AutomationsStore(cfg.dataDir)
automations.load()
// the vitals (vitals.ts): runs, executions and the fleet backwards, and what
// each automation spent — its runs' transcripts read once, cached per run
const vitals = new VitalsService({
  dataDir: cfg.dataDir,
  automations,
  usageRecords: (f, i) => index.usageRecords(f, i),
  agents: () => registry.list().map((a) => ({ id: a.id, position: positionOf(a, territoryStore.isEnabled(a.id)) })),
  births: () => births.all(),
  executions: () => executionsSource.list().map((e) => ({ updatedAt: e.record.updatedAt })),
})
// WHO gave birth to each session (session-origins.ts): the resident records
// births going forward; the one-time backfill adopts the history of
// `thread: new` automations so today's run-born conversations are filed
// under their automation from the first start after this landed.
const origins = new SessionOriginsStore(cfg.dataDir)
origins.load()
const backfilled = origins.backfill(automations)
if (backfilled > 0) console.log(`session-origins: adopted ${backfilled} automation-born session(s) from run history`)
// The heartbeat's clock (heartbeat.ts): heartbeat-<id> derived from each
// agent's control and rhythm, on the SAME store the resident schedules from.
const heartbeats = new HeartbeatClock({ store: automations, agents: () => registry.list(true), fenceOn: (id) => territoryStore.isEnabled(id) })
// The transcript audit of a finished unattended turn (heartbeat-audit.ts):
// the session, its subagents and the nested sessions its Bash
// launched (birth markers), read with each engine's reader
async function auditTurn(run: { agentId: string; sessionKey: string; startedAt: string }): Promise<RunAudit | null> {
  const agent = registry.get(run.agentId)
  if (!agent) return null
  const slash = run.sessionKey.indexOf('/')
  if (slash <= 0) return null
  const folder = run.sessionKey.slice(0, slash)
  const sessionId = run.sessionKey.slice(slash + 1)
  const since = Date.parse(run.startedAt)
  const got = await collectTurnCalls(
    { folder, sessionId, agentId: agent.id, ...(Number.isNaN(since) ? {} : { since }) },
    { sessions: auditSessionsOf(index), births },
  )
  const blocks = findHarness(agent.framework ?? fallbackHarness().id)?.traits.heartbeatBlocks
  return auditToolCalls(got.calls, {
    cwd: agent.folder ?? cfg.home,
    home: cfg.home,
    silos: { port: cfg.port, api: silosApi },
    paths: auditPaths({
      folders: territoriesOf(agent),
      home: cfg.home,
      dataDir: cfg.dataDir,
      engineConfigFiles: (f) => registeredHarnesses().flatMap((h) => h.configFiles?.(f, cfg.home) ?? []),
    }),
    ownerTokenPaths: [join(cfg.dataDir, 'token')],
    children: got.children,
    unread: got.unread,
    // a child session in a heartbeat of an engine whose subagent deny is not
    // verified reads as `subagent`
    ...(blocks && !blocks.subagents ? { markChildSessions: true } : {}),
  })
}
// what heartbeats considered (heartbeats/<id>/considered.jsonl)
const heartbeatStore = new HeartbeatStore(cfg.dataDir)
// the live caps on unattended turns — ONE gate for the resident's runs and
// Task mode's wakes
const turnSlots = new TurnSlots()
// an agent's day on its own (own-turns.ts): the ceiling's and the spend
// cap's ONE count — wakes (Task mode), heartbeats and its own recurring work
const ownTodayOf = (agentId: string, now: number): OwnTurnsToday | null => {
  const a = registry.get(agentId)
  if (!a) return null
  return ownTurnsToday(
    {
      automations,
      wakesToday: (id, day) => taskMode.wakesToday(id, day),
      pricesNow: (id) => {
        const x = registry.get(id)
        return x ? unattendedPrices(x, { switchId: platformSettings.unattendedProvider(), providers }) : false
      },
    },
    a,
    now,
  )
}

// The thread tools, ONE instance for buildServer and the task machinery
// (R5): built here, after terminals and origins. `announce`
// is filled by buildServer inside its WS scope.
const announce: AnnounceBox = { send: () => {} }
const transcriptOnly: TranscriptOnly = makeTranscriptOnly({ origins, owners })
const absorbRotations = makeAbsorbRotations({ lineage, terminals, index, announce })
const threadRootKey = makeThreadRootKey({ ancestry: owners.ancestry, lineage, metaById: (id) => index.allSessions().find((m) => m.id === id) ?? null })
threadTools.absorbRotations = absorbRotations
threadTools.continuable = (metas) => continuableOf({ transcriptOnly, lineage, threadRootKey }, metas)
threadTools.nativeIdOf = (id) => terminals.nativeIdOf(id)
const broadcastBox: { send: (msg: unknown) => void } = { send: () => {} }

// Auto-titles: channel-style titles synthesized by the resident for
// sessions with no manual title. SILOS_NO_AUTOTITLES=1 turns the whole
// thing off (the titler isn't even constructed) — only for harnesses that
// must never touch the SDK (npm run e2e sets it; see web/e2e/helpers.ts),
// same pattern as SILOS_NO_EPHEMERAL in ephemeral.ts.
const titler =
  process.env.SILOS_NO_AUTOTITLES === '1'
    ? undefined
    : new Titler({
        index,
        store,
        dataDir: cfg.dataDir,
        generateTitle: generateTitleWithSdk(sdkQueryFn),
        classifyAgentId: (m) => owners.agentIdOf(m), // the same rule as server.ts/resident.ts
        muted,
        ephemeralPrefix: ephemeral,
        bornOfSilos: (m) => origins.get(`${m.folder}/${m.id}`) !== null,
      })

// the agents in TASK MODE — DERIVED, never operated:
// On its own (the derived control: territory on, a mission) ∧ in play ∧ with
// a folder, while the (builtin) task-mode silo is active
function taskModeBound(): ReadonlySet<string> {
  const entry = siloRegistry.get(TASK_MODE_SILO)
  if (!entry || entry.status.state !== 'active') return new Set()
  return new Set(
    registry
      .list()
      .filter((a) => a.folder && controlOfId(a.id) === 'own')
      .map((a) => a.id),
  )
}

// when an agent's account comes off a usage limit (the same reading the
// inbox's limit row uses — plan-usage's cache, never a fetch here); null
// when it is not at one
function accountResetOf(agentId: string): string | null {
  const raw = registry.get(agentId)?.provider
  const provider = providers.resolve(raw)?.id ?? raw ?? 'default'
  const u = planUsage.peek(provider)
  if (!u || !u.ok) return null
  return limitedWindow({ at: u.at, windows: u.windows }, Date.now())?.resetsAt ?? null
}

// the account an agent's next UNATTENDED turn runs on (turn-account.ts):
// readable only when the turn's engine really runs
// on that Claude account
function turnAccountOf(agentId: string, runsOnProvider: string | undefined): TurnAccount {
  return turnAccountOfTurn({ registry, chat }, agentId, runsOnProvider)
}
// «Run now» of a heartbeat: the account at its limit is the one the
// turn will run on — its cached reading, never a fetch here
function heartbeatAccountResetOf(agentId: string): string | null {
  const a = automations.get(heartbeatAutomationId(agentId))
  const acct = turnAccountOf(agentId, a?.runsOn?.provider)
  if (!acct.readable) return null
  const u = planUsage.peek(acct.id)
  if (!u || !u.ok) return null
  return limitedWindow({ at: u.at, windows: u.windows }, Date.now())?.resetsAt ?? null
}

// why an agent's engine refuses its turns right now (harness.ts peekRefusal,
// the verdicts the tick keeps warm) — the ONE reading message delivery, the
// automations and Task mode hold their unattended work by
function engineRefusalOf(agentId: string): string | null {
  const a = registry.get(agentId)
  return a ? harness.peekRefusal(a, 'chat') : null
}

// the kernel's record of the owner writing each note (task mode's owner-note
// rule): the plans silo's append-item events, read incrementally
const ownerNoteLedger = new OwnerNoteLedger(join(siloRegistry.root, 'events.jsonl'), PLANS_SILO)
// …and the same record says which cancellations were the owner's Drop
// («Yours, undone»)
const taskCancellations = new TaskCancellations(join(siloRegistry.root, 'events.jsonl'), PLANS_SILO)

// The machine's vitals (machine-sampler.ts, GET /api/system): a sample at
// the resident's first tick and one per hour, the disk attributed to the
// engines' transcripts, the trash, the live worktrees and agent-state.
const serverSince = new Date().toISOString()
const machine = new MachineSampler({
  dir: join(cfg.dataDir, 'machine'),
  sources: {
    transcripts: () => index.transcriptRoots(),
    trash: join(cfg.dataDir, 'trash'),
    worktrees: () =>
      worktreeRecords
        .list()
        .filter((r) => r.state !== 'removed')
        .map((r) => r.dir),
    agentState: join(cfg.dataDir, 'agent-state'),
    disk: cfg.dataDir,
  },
})
const resident = new Resident({
  machine,
  store: automations,
  registry,
  chat,
  native,
  index,
  root: cfg.root,
  dataDir: cfg.dataDir,
  lineage,
  owners,
  origins,
  claudeSessionsDir: join(cfg.home, '.claude', 'sessions'), // the configured home, not $HOME
  broadcast: (msg) => broadcastBox.send(msg),
  // the resident decides a timeout: stamped on the turn's Usage window
  usageTimeout: (turnId) => usage.markTimeout(turnId),
  heartbeats,
  agentState,
  // what a heartbeat fire reads (resident/heartbeat.ts)
  heartbeat: {
    fenceOn: (agentId) => territoryStore.isEnabled(agentId),
    facts: (agent, since, now) =>
      heartbeatFacts(
        {
          messages,
          automations,
          nameOf: nameOfAgent,
          tasks: (t) => taskMode.tasks(t),
          routedRows: (t) => siloSurfaces.routedRows(t),
          proposals,
          ownToday: (id, t) => ownTodayOf(id, t),
          originOf: (key) => plansOrigins.get(key),
          creations: (id) => creations.list(id),
          // (B2.4) the asks other agents left it through Silos
          asks: (id) => taskAsksBox.v?.asksTo(id) ?? [],
        },
        agent,
        since,
        now,
      ),
    store: heartbeatStore,
    blocks: (agent) => findHarness(agent.framework ?? fallbackHarness().id)?.traits.heartbeatBlocks ?? { web: false, connectors: false, subagents: false },
    // the proactive mode: the round's state blocks and
    // its day's count, from the ledger
    mission: (agent, now) => {
      const ledger = creations.list(agent.id)
      return { open: missionOpen(ledger, taskNowOf), undone: missionUndone(ledger, taskNowOf, now), madeToday: madeFromMissionToday(ledger, now) }
    },
    account: (agent, runsOnProvider) => turnAccountOf(agent.id, runsOnProvider),
    usage: { get: (id) => planUsage.get(id), peek: (id) => planUsage.peek(id) },
  },
  wakesToday: (agentId, day) => taskMode.wakesToday(agentId, day),
  proposals,
  slots: turnSlots,
  // the transcript audit of every finished unattended run
  audit: (run) => auditTurn(run),
  // its verdict, with the ledger (initiative.ts afterAudit)
  afterAudit: (agentId, run, audit, o) => initiativeBox.v?.afterAudit(agentId, run, audit, o),
  vault, // a command run gets the env an agent console gets (its Vault secrets)
  silosApi,
  ...(titler ? { titler } : {}),
  // Prunes orphaned conversation-prefs in the heartbeat's slow sweep —
  // ONLY once the index is warm (during warmup allSessions() is empty and
  // would prune legitimate prefs); the grace window for recent keys lives
  // in the store itself (sweepOrphans).
  prefsSweep: () => {
    if (!index.isReady()) return
    const keys = new Set(index.allSessions().map((m) => `${m.folder}/${m.id}`))
    // a conversation's launch entries (loads-scopes.ts): its thread is known
    // while the index has its root or any session on it — the same warm
    // index, the store's own grace (its rows' times)
    sweepLostConversations(loadsScopes, index, (id) => threadIdOf(id))
    convPrefs.sweepOrphans(keys)
    // Durable unread state: same slow sweep and same safeguard (warm index
    // + the store's own grace window) as conversation-prefs.
    seen.sweepOrphans(keys)
    // Auto-resume records for a session that no longer exists — never resume a
    // gone (trashed/deleted) conversation (resurrection, invariant 3).
    pendingResumes.sweepOrphans(keys)
  },
  pendingResumes,
  // when an agent's account comes off a usage limit (the same reading the
  // inbox's limit row uses — plan-usage's cache, never a fetch here)
  accountResetOf: (agentId) => accountResetOf(agentId),
  engineRefusal: engineRefusalOf,
  taskMode: { look: (now) => taskMode.look(now) },
  escalation: { tick: (now) => escalation.tick(now) },
})

// Task mode (task-view phase 3): the bound agents' task events → wakes on
// the (agent, task) conversation, through the resident's turn machinery.
// SILOS_NO_TASK_WAKE_DELIVERY=1 (the e2e harness) evaluates, never sends.
const taskMode: TaskModeEngine = new TaskModeEngine({
  store: taskModeStore,
  plans: () => {
    const entry = siloRegistry.get(PLANS_SILO)
    const reading = siloKernel.reading(PLANS_SILO)
    return entry && entry.status.state === 'active' && reading
      ? { reading, standing: entry.manifest ? standingIdsOf(entry.manifest, 'plan') : new Set<string>() }
      : null
  },
  bound: taskModeBound,
  // the kernel's flow of every plan task (task-flow.ts, the same live facts
  // Home's rows read): its stall — what the stuck sweep wakes on — and its
  // idle / waitsStart / live, read by assign and the heartbeat (A1.1)
  stalled: (now) => {
    const entry = siloRegistry.get(PLANS_SILO)
    const reading = siloKernel.reading(PLANS_SILO)
    if (!entry || entry.status.state !== 'active' || !entry.manifest || !reading) return new Map()
    const base = reading.records.map((r) => baseRecordOf(r))
    return taskFlowRecords(entry.manifest, base, siloSurfaces.voice(PLANS_SILO, now))
  },
  // nothing is sent before the index is warm: conversationOf() would miss
  // the task's conversations and open a new one (engine.ts)
  ready: () => index.isReady(),
  setField: (key, field, value) => {
    const r = siloActions.setField(PLANS_SILO, key, field, value, { by: SILOS_AUTHOR })
    return r.ok ? { ok: true } : { ok: false, reason: r.reason }
  },
  appendNote: (key, text) => {
    const r = siloActions.appendItem(PLANS_SILO, key, 'notes', { text }, { by: SILOS_AUTHOR })
    return r.ok ? { ok: true } : { ok: false, reason: r.reason }
  },
  // a note is the owner's only when Silos recorded the owner writing it (the
  // kernel's append-item events) — one signed "owner" in the file by an
  // agent is the agent's
  ownerNotes: () => ownerNoteLedger.checker(),
  // a wake waits for the account's reset instead of being spent on a turn
  // the limit refuses (finding 1) — the same reading message delivery uses
  // — only for an agent with no fallback declared: one with a fallback runs
  // on it, so its turn is tried (a refused turn waits all the same)
  limitedUntil: (agentId) => ((registry.get(agentId)?.fallback ?? []).length > 0 ? null : accountResetOf(agentId)),
  engineRefusal: engineRefusalOf,
  // stored as the native id the engine sealed, when it did (R3/R5)
  appendConversation: (key, sessionId) => {
    const r = siloActions.appendItem(PLANS_SILO, key, 'conversations', { session: terminals.nativeIdOf(sessionId) ?? sessionId }, { by: SILOS_AUTHOR })
    return r.ok ? { ok: true } : { ok: false, reason: r.reason }
  },
  // …the newest of ITS conversations in the task's THREAD: a task lists the
  // conversation it was worked in, and after a rotation the thread continues
  // in a newer one — the wake must land there, like Work on this already
  // does
  conversationOf: (agent, ids) => threadsOfTasks(0).tipOf(agent, ids),
  holdersOf: (agent, ids) => threadsOfTasks(0).holdersOf(agent, ids),
  busyWhy: (sessionId) => {
    if (chat.isSessionActive(sessionId)) return 'a turn is running on its conversation'
    // a console probe that fails is not «no console» (consoleState): busy —
    // said apart, so Needs you never calls it «open and idle» (A2.8, E7)
    const st = terminals.knownConsoleState(sessionId)
    if (st === 'alive' || terminals.holdersOf(sessionId).length > 0) return CONSOLE_BUSY
    if (st === 'unknown') return CONSOLE_UNSURE
    // its turn closed but its subagents still work (work-live.ts)
    return backgroundBusyNow(sessionId) ? BACKGROUND_BUSY : null
  },
  send: (i) => resident.openTaskTurn(i),
  nameOf: (agentId) => registry.list(true).find((a) => a.id === agentId)?.name ?? agentId,
  // an execution completing a task is progress; a fix round is not (D5)
  executionsDone: () => executionsSource.doneByTask(),
  // the CURRENT conversations of a task (R13): the wakes, /talk and the door
  // never resume — nor wait on — a thread its releases[] let go
  currentOf: (listed, releases) => threadsOfTasks(5_000).currentOf(listed, releases),
  deliveryOff: process.env.SILOS_NO_TASK_WAKE_DELIVERY === '1',
  // (B2, H3) an answer an unattended turn gave: its `answered` wake waits for
  // that turn's audit (the same reader the stamper asks)
  answeredTurn: {
    live: (agentId, run) => liveTurns.liveOf(agentId).some((t) => runOfTurn(t) === run),
    readOutside: (agentId, run) => runReadOutsideOf(agentId, run),
  },
  // the agent's day on its own (own-turns.ts): its ceiling and spend cap
  ownToday: (agentId, now) =>
    ownTodayOf(agentId, now) ?? { used: 0, costUsd: 0, unpriced: 0, ceiling: Number.MAX_SAFE_INTEGER, spendCap: Number.MAX_SAFE_INTEGER, exempt: true },
  // the live caps shared with the resident's runs (turn-slots.ts)
  slots: turnSlots,
  // a wake's audit: its creations re-stamped; the owner's credential cuts
  noteReadOutside: (key, note) => noteReadOutside(plansOriginsBox.v?.get(key) ?? null, note),
  afterAudit: (agentId, turnId, audit) => {
    initiativeBox.v?.afterAudit(agentId, turnId, audit, { heartbeat: false, gaps: { mcp: false, childSessions: false } })
  },
})

// One reading of every task per SYNCHRONOUS pass (pass.ts). A lookup by key
// used to recompute all the snapshots (every task's flow against every
// conversation), and the ledger's baseline asks one key per origin: the inbox
// tick held the event loop 11–15 s every 30 s — every console and page froze
// (profiled live). The map dies with the pass (a microtask, or a
// writer's endPass), so nothing read after an await, a write or a file event
// is ever stale.
const taskPass = perPass(() => new Map(taskMode.tasks().map((t) => [t.key, t])))
function tasksThisPass(): Map<string, ReturnType<typeof taskMode.tasks>[number]> {
  return taskPass.get()
}

// ── initiative: the ledger, the origins, the stamper ──
const creations = new CreationsStore(cfg.dataDir)
const plansOrigins = new PlansOrigins(join(cfg.dataDir, 'plans-origins.json'))
const writePlanTask = (
  key: string,
  mutate: (child: Record<string, unknown> | null, list: unknown[]) => { write: boolean } | string,
  text: string,
): { ok: boolean; reason?: string } => {
  const r = siloActions.silosWriteChild(PLANS_SILO, key, mutate, { by: SILOS_AUTHOR, text })
  return r.ok ? { ok: true } : { ok: false, reason: r.reason }
}
// the run's verdict once its audit is written (S6-r4): only a heartbeat run
// is tainted by reading outside
// — and only one that SEALED `tools: false`: a round
// with its tools is audited like a wake, marked and never undone
const runVerdictOf = (agentId: string, run: string): { tainted: boolean; readOutside: string[] } | null => {
  const r = automations.listRuns(heartbeatAutomationId(agentId)).find((x) => x.id === run)
  if (!r?.audit) return null
  return { tainted: r.audit.readOutside.length > 0 && r.heartbeat?.tools !== true, readOutside: r.audit.readOutside }
}
// the readOutside of any run already audited — an automation's run (a
// heartbeat's included) or a wake turn — or null while its audit is not in:
// what the stamper and Task mode's `answered` hold (B2, H3) read
function runReadOutsideOf(agentId: string, run: string): string[] | null {
  for (const a of automations.list()) {
    if (a.agentId !== agentId) continue
    const r = automations.listRuns(a.id).find((x) => x.id === run)
    if (r) return r.audit ? r.audit.readOutside : null
  }
  return taskModeStore.auditOfTurn(run)?.readOutside ?? null
}
const plansStamper: PlansProvenance = new PlansProvenance({
  origins: plansOrigins,
  creations,
  cursorFile: join(cfg.dataDir, 'plans-provenance.json'),
  agents: () => registry.list().map((a) => ({ id: a.id, name: a.name, cut: a.cut ?? null, folders: territoriesOf(a) })),
  liveOf: (id) => liveTurns.liveOf(id),
  // attribution by WRITE in the candidate's transcript (S2-r5)
  probe: {
    wrote: async (c, file) => {
      const agent = registry.get(c.agentId)
      const sid = c.sessionId ? (terminals.nativeIdOf(c.sessionId) ?? c.sessionId) : null
      if (!agent || !sid) return null
      const folder = index.allSessions().find((m) => m.id === sid)?.folder
      if (!folder) return null
      const since = Date.parse(c.startedAt)
      const got = await collectTurnCalls(
        { folder, sessionId: sid, agentId: agent.id, ...(Number.isNaN(since) ? {} : { since }) },
        { sessions: auditSessionsOf(index), births },
      )
      if (got.unread.includes(sid)) return null
      return writesFile(got.calls, file, agent.folder ?? cfg.home, cfg.home)
    },
  },
  write: writePlanTask,
  journal: () => (siloRegistry.get(PLANS_SILO)?.status.conventions ?? []).map((c) => ({ dir: c.dir, read: (n: number) => siloJournal.linesFrom(c.dir, n) })),
  runVerdict: runVerdictOf,
  // the readOutside of any run already audited: an automation's run or a wake turn
  runReadOutside: (agentId, run) => runReadOutsideOf(agentId, run),
  selfRecurrentLive: (id) => initiative.selfRecurrentLive(id),
  cut: (agentId, why, run) => {
    try {
      registry.update(agentId, { cut: { at: new Date().toISOString(), why, ...(run ? { run } : {}) } })
    } catch (err) {
      console.warn(`initiative: could not record the cut of ${agentId} —`, err instanceof Error ? err.message : err)
    }
  },
  ownerRestored: (key, owner) => {
    endPass()
    for (const t of taskMode.stopTask(key, 'its owner was restored by Silos', { keep: owner })) void chat.cancel(t)
  },
  // the same proactive rules as append-item
  rootOf: (_agentId, signal) => initiative.rootOf(signal),
  messageFrom: (_agentId, id) => messages.find(id)?.from ?? null,
  proactiveNow: proactiveOfId,
  taskNow: taskNowOf,
  // the owner's Drop, by Silos' record of the gesture (task-cancellations.ts)
  ownerDrop: (key) => {
    const c = taskCancellations.of(key, null)
    return c.byOwner ? c.at : null
  },
})
const initiative = new Initiative({
  creations,
  origins: plansOrigins,
  stamper: plansStamper,
  agent: (id) => registry.get(id) ?? null,
  agents: () => registry.list(),
  automations,
  trashDir: join(cfg.dataDir, 'trash', 'automations'),
  task: (key) => {
    const t = tasksThisPass().get(key)
    return t ? { status: t.state, title: t.title, owner: t.owner, ...(plansOrigins.get(key)?.file ? { file: plansOrigins.get(key)!.file! } : {}) } : null
  },
  writeTask: (key, mutate, text) => {
    endPass()
    return writePlanTask(key, (child) => mutate(child), text)
  },
  stopTask: (key, why) => {
    endPass()
    for (const t of taskMode.stopTask(key, why)) void chat.cancel(t)
  },
  stopAutomation: (id) => resident.cancelLiveRun(id),
  cut: (agentId, cut) => {
    try {
      registry.update(agentId, { cut })
    } catch (err) {
      console.warn(`initiative: could not record the cut of ${agentId} —`, err instanceof Error ? err.message : err)
    }
  },
  proposals,
  messages,
  considered: heartbeatStore,
  proactiveNow: proactiveOfId,
  taskNow: taskNowOf,
})
initiativeBox.v = initiative
setInitiative(initiative)
plansStamperBox.v = plansStamper
plansOriginsBox.v = plansOrigins
setNoteOutside((key, note) => noteReadOutside(plansOrigins.get(key), note))
// the verdicts whose turns ended (their transcripts are read once the turn is over)
setInterval(() => {
  void plansStamper.settle()
}, 15_000).unref()

// The proactive mode as the agent's page reads it (what q4's three-way
// switch, its sheet and its rows read; nothing here is computed by the screen): the position (derived), the owner's setting, why
// a set proactive does no rounds, the day's count and the open cap, what
// holds it (a price, the account's margin, or the unmeasured count), the
// rounds a day its period gives, and the connectors a round WITH its tools
// would have — what the folder loads (folder-loads.ts over the engine's
// inventory): its active plugins, MCP servers and connectors, the account's
// included; what the owner holds left out.
function proactiveViewOf(agentId: string, now: number): unknown {
  const agent = registry.get(agentId)
  if (!agent) return null
  const fence = territoryStore.isEnabled(agentId)
  const setting = storedProactive(agent)
  const effective = proactiveOf(agent, fence)
  const ledger = creations.list(agentId)
  const open = (ref: string): boolean => {
    const t = taskNowOf(ref)
    return t !== null && t.status !== 'done' && t.status !== 'cancelled'
  }
  const beat = automations.get(heartbeatAutomationId(agentId))
  const acct = turnAccountOf(agentId, beat?.runsOn?.provider)
  const period = heartbeatOf(agent).period
  let connectors: Array<{ name: string; kind: 'mcp' | 'plugin'; scope: 'agent' | 'project' | 'user' | 'account' }> = []
  // its own servers first (agent-tools.ts): a round with its tools loads its plugin too
  try {
    connectors = ownMcpServerNames(agentState.pathFor(agentId)).map((name) => ({ name, kind: 'mcp' as const, scope: 'agent' as const }))
  } catch {
    connectors = []
  }
  if (agent.folder) {
    try {
      const live = folderLoads(
        { index, registry, home: cfg.home, ...(cfg.claudeManagedDir ? { managedDir: cfg.claudeManagedDir } : {}), agentState, toolHealth },
        agent.folder,
      ).rows.filter((r) => r.state === 'active' && !r.replacedBy && !r.placeholder && !r.sameAs && !r.observed)
      connectors = [
        ...connectors,
        ...live.map((r) => ({
          name: r.label,
          kind: r.kind === 'plugin' ? ('plugin' as const) : ('mcp' as const),
          scope: r.origin.owner === 'project' ? ('project' as const) : r.origin.owner === 'account' ? ('account' as const) : ('user' as const),
        })),
      ]
    } catch {
      /* the folder's half unknown */
    }
  }
  const perDay = (effective ?? setting)?.perDay ?? null
  const made = madeFromMissionToday(ledger, now)
  return {
    position: positionOf(agent, fence),
    setting,
    effective: effective !== null,
    // why a set proactive does no rounds now: 'cut' (Allow again), 'told', 'never'
    off: proactiveOffWhy(agent, fence),
    today: { made, perDay, left: perDay === null ? null : Math.max(0, perDay - made), open: openFromMissionRoot(ledger, open), openMax: PROACTIVE_OPEN_MAX },
    // «≈ n rounds a day» — slotsPerDay, never the screen
    roundsPerDay: period ? slotsPerDay(period) : 0,
    // what holds it: its spend cap, or its account's margin, or a count
    holds: acct.priced
      ? { kind: 'spend', spendPerDay: ownTodayOf(agentId, now)?.spendCap ?? null, sharePercent: ROUND_SPEND_SHARE }
      : acct.readable
        ? { kind: 'account', account: acct.id, headroomPercent: ROUND_ACCOUNT_HEADROOM }
        : { kind: 'unmeasured', account: acct.id, roundsPerDay: ROUNDS_UNMEASURED_PER_DAY },
    connectors,
    connectorsNote: "the account's connectors (claude.ai) are listed once a conversation here names them",
  }
}

// A console key listed on a task before its engine sealed the native id
// (OpenCode) gets that id listed beside it — on the neutral `native-bound`
// event, and once when the index is warm (task-native-bind.ts).
const appendNativeId = (taskKey: string, sessionId: string): void => {
  const r = siloActions.appendItem(PLANS_SILO, taskKey, 'conversations', { session: sessionId }, { by: SILOS_AUTHOR, revive: false })
  if (!r.ok) console.warn(`tasks: listing ${sessionId} on ${taskKey} failed — ${r.reason}`)
}
// a console's liveness became known or changed (terminal-service.ts
// knownConsoleState): a wake held on «a console may have it open» is
// delivered now, not at the next look
terminals.on('liveness', () => {
  try {
    taskMode.deliver()
  } catch (err) {
    console.warn('tasks: deliver on console liveness failed —', err instanceof Error ? err.message : err)
  }
})
terminals.on('native-bound', (key: string, id: string) => {
  try {
    bindNativeOnTasks(taskMode.tasks(), key, id, appendNativeId)
  } catch (err) {
    console.warn('tasks: native-bound failed —', err instanceof Error ? err.message : err)
  }
})

// (B2) agent ↔ agent asks: ONE fact per task in Task
// mode's store, the plain wait in the file as Silos' own write the stamper
// expects (H4), the answer's `answered` wake (task-asks.ts)
const taskAsks = new TaskAsks({
  store: taskModeStore,
  tasks: () => taskMode.tasks(),
  write: (key, mutate, text) => {
    const r = siloActions.silosWriteChild(PLANS_SILO, key, mutate, { by: SILOS_AUTHOR, text })
    return r.ok ? { ok: true } : { ok: false, code: r.code, reason: r.reason }
  },
  isAgent: isAgentId,
  inPlay: isAgentInPlay,
  nameOf: (agentId) => registry.list(true).find((a) => a.id === agentId)?.name ?? agentId,
  bound: (agentId) => isAgentInPlay(agentId) && taskModeBound().has(agentId),
  seenBy: askSeenBy,
  ownWrite: (key, shape) => plansStamper.ownWrite(key, shape),
  markAsk: (key, agentId, turn, at) => plansOrigins.addMark(key, { kind: 'ask', at, run: runOfTurn(turn), agent: agentId }),
  markNote: (key, agentId, turn, noteAt) => initiative.markNote(key, agentId, turn, noteAt),
  askReadOutside: (key, agentId, at) => plansOrigins.get(key)?.marks?.find((m) => m.kind === 'ask' && m.agent === agentId && m.at === at)?.readOutside ?? null,
  look: () => taskMode.look(),
})
taskAsksBox.v = taskAsks

// Escalation (hierarchy phase 4, escalation/): a bound agent's stalled task
// whose one wake changed nothing, and a routed row its producer did not
// clear in the window, go up the chain the kernel walks (the first active
// acyclic agent → agent relation — silos/relations.ts) one hop per window as
// normal messages from Silos (SILOS_AUTHOR) — only to an agent On its own
// whose next heartbeat falls inside the window — then to the owner's
// Needs you; with no chain installed, straight to Needs you.
const siloRelations = new RelationStore(siloRegistry.root)
const relationLookup = {
  stateOf: (id: string): EndpointState => {
    const a = registry.list(true).find((x) => x.id === id)
    return !a ? 'gone' : a.archived ? 'archived' : 'ok'
  },
}
const nameOfAgent = (agentId: string): string => registry.list(true).find((a) => a.id === agentId)?.name ?? agentId
const escalationStore = new EscalationStore(cfg.dataDir)
const escalation: EscalationEngine = new EscalationEngine({
  store: escalationStore,
  taskMode: {
    tasks: (now) => taskMode.tasks(now),
    retryFailed: (now, tasks) => taskMode.retryFailed(now, tasks),
    cannotStart: (now, tasks) => taskMode.cannotStart(now, tasks),
  },
  routedRows: (now) => siloSurfaces.routedRows(now),
  chain: () => {
    const rel = agentChainRelation(siloRegistry.list())
    if (!rel) return { installed: false, up: () => [] }
    const edges = siloRelations.live(rel.silo, rel.decl.name, relationLookup)
    return { installed: true, up: (agent) => chainUp(edges, agent) }
  },
  isAgent: isAgentInPlay,
  nameOf: nameOfAgent,
  setField: (key, field, value) => {
    const r = siloActions.setField(PLANS_SILO, key, field, value, { by: SILOS_AUTHOR })
    return r.ok ? { ok: true } : { ok: false, reason: r.reason }
  },
  appendNote: (key, text) => {
    const r = siloActions.appendItem(PLANS_SILO, key, 'notes', { text }, { by: SILOS_AUTHOR })
    return r.ok ? { ok: true } : { ok: false, reason: r.reason }
  },
  message: (to, text) => {
    try {
      messages.send({ from: SILOS_AUTHOR, to, text })
    } catch (err) {
      console.warn(`escalation: message to ${to} failed —`, err instanceof Error ? err.message : err)
    }
  },
  // a hop to an agent only when it is On its own and its next
  // heartbeat with a turn falls inside the window (asleep past it: skipped)
  hopOk: (agentId, now, windowMs) => {
    const a = registry.get(agentId)
    if (!a || controlOfId(agentId) !== 'own') return false
    const hb = heartbeatOf(a)
    if (!hb.period) return false
    const next = nextSlot(hb.period, now)
    if (next === null) return false
    if (hb.sleepUntil && Date.parse(hb.sleepUntil) > next) return false
    return next - now <= windowMs
  },
  // (B2.10, H10) an agent hop is the same fact an agent's ask arms
  asks: {
    writeHop: (key, to, action) => taskAsks.writeHop(key, to, action),
    hopArmed: (key, to, action) => taskAsks.hopArmed(key, to, action),
    armHop: (key, to, action) => taskAsks.armHop(key, to, action),
  },
})
// the escalated tasks, as the owner's Needs you rows (blocking, the door to the task)
function escalationRows(): SiloNeedsYou[] {
  const plans = siloRegistry.get(PLANS_SILO)
  return escalation.ownerRows().map(({ c, text, at }) => ({
    kind: 'silo' as const,
    reason: 'escalation' as const,
    silo: PLANS_SILO,
    siloName: plans?.status.manifest.name ?? 'Plans',
    key: c.key,
    recordKind: 'plan/task',
    urgency: 'blocking' as const,
    text,
    at,
    agentId: c.who,
    ...(c.folder ? { folder: c.folder } : {}),
    file: c.file ?? null,
    identity: c.title,
    actions: ['open'],
    escalated: { since: c.since, asked: c.hops.map((h) => h.to).filter((t) => t !== OWNER), with: c.who },
  }))
}

// webDist lives in cfg (defaultConfig already resolves SILOS_WEB_DIST
// against the same long-standing default) — see config.ts.
// Silos skills already copied into an agent's folder (or held for it)
// follow Silos: an untouched older release is brought to the current text;
// an edited copy is the operator's and is only named; a stale PERSONAL copy
// (an account's <config>/skills — never written) is only named
// (skill-install.ts SkillCopyFollower). At startup, then every minute — a
// cheap mtime check that runs the pass only when plugin/skills or the
// agents' folders changed (a merge without a restart).
const skillFollower = new SkillCopyFollower({
  pluginSkillsDir,
  dataDir: cfg.dataDir,
  folders: () =>
    registry
      .list()
      .flatMap((a) => [a.folder, ...(a.folders ?? [])])
      .filter((f): f is string => !!f),
  personalRoots: () => accounts.configDirs().map((c) => join(c.configDir, 'skills')),
})
skillFollower.tick()
setInterval(() => {
  try {
    skillFollower.tick()
  } catch (err) {
    console.warn('skill follow failed —', err instanceof Error ? err.message : err)
  }
}, 60_000).unref()

// Per-login sessions, persisted in ~/.silos/sessions.json (0600) —
// mandatory with tsx watch: an in-memory-only store would log out every
// remote user on every restart caused by a code change.
const sessions = new SessionTokenStore({ file: join(cfg.dataDir, 'sessions.json'), seal: seals })

// Silos ID (silos-id.ts): the one remote sign-in, for any domain, through
// the broker at SILOS_ID_URL. Who may sign in: SILOS_OWNER_EMAIL. Read from
// the environment merged with <dataDir>/server.env (server-env.ts: the real
// environment wins; the file's values never enter process.env, so no agent
// or child process inherits them). Read once: a change needs a restart.
const serverEnv = readServerEnv(cfg.dataDir)
const serverEnvNote = serverEnvWarning(serverEnv)
if (serverEnvNote) console.warn(`warning: ${serverEnvNote}`)
const silosIdSettings = silosIdSettingsFromEnv({ ...process.env, ...serverSettings(process.env, serverEnv.values) })
if (silosIdSettings && 'off' in silosIdSettings) console.warn(`warning: Silos ID login disabled — ${silosIdSettings.off}`)
const silosId = silosIdSettings && !('off' in silosIdSettings) ? new SilosIdClient(silosIdSettings, { dataDir: cfg.dataDir }) : null
const allowlist = (): string[] => (silosId ? silosId.ownerEmails : [])
// on by default with Silos ID; SILOS_TELEMETRY=off (env or server.env) stops it
if (silosId && telemetryOn(serverSettings(process.env, serverEnv.values).SILOS_TELEMETRY)) {
  const version = silosVersion(process.env)
  instanceUsage = new InstanceUsage({ file: join(cfg.dataDir, 'instance-usage.json'), send: (r) => silosId.reportUsage(r, version) })
}

// The seal's in-life half: what each agent's engine loads (its folders'
// configFiles and .claude/settings*.json, the ~/.claude home layer), then
// every store has loaded — from here a sealed file Silos never wrote
// APPEARED — and one reconcile tick (memory is the truth; a delta is set
// aside, a credential rotated, a plugin path held).
seals.setAgents(() =>
  registry
    .list()
    .map((a) => ({ id: a.id, name: a.name, folder: a.folder, ...(a.folders ? { folders: a.folders } : {}), ...(a.archived ? { archived: true } : {}) })),
)
seals.setConfigFiles((folder, home) => registeredHarnesses().flatMap((h) => h.configFiles?.(folder, home) ?? []))
seals.endBoot()
let sealTicks = 0
// the read-hash walk (thousands of engine config files) runs async and in
// batches (reconcileReadsAsync — never overlapping itself): the tick's sync
// part is the handful of control files only
setInterval(() => {
  try {
    seals.reconcile({ reads: false })
  } catch (err) {
    console.warn('seals: reconcile failed —', err instanceof Error ? err.message : err)
  }
  if (++sealTicks % READS_EVERY_TICKS === 0)
    seals.reconcileReadsAsync().catch((err: unknown) => console.warn('seals: read-hash pass failed —', err instanceof Error ? err.message : err))
}, SEAL_TICK_MS).unref()

// The bindings agents propose in their asks on the owner (binding-asks.ts,
// t43): read from the Plans silo NOW against the Vault as it stands, and a
// successful binding save answers every open ask on that entry — the owner's
// note (task mode's owner-note wakes a bound owner), the wait cleared,
// pending when nothing else holds it.
function bindingAskTasksNow(): AskTask[] {
  const entry = siloRegistry.get(PLANS_SILO)
  const reading = siloKernel.reading(PLANS_SILO)
  if (!entry || entry.status.state !== 'active' || !reading) return []
  return askTasksOf(reading, entry.manifest ? standingIdsOf(entry.manifest, 'plan') : new Set<string>())
}
function bindingAsksFor(tasks: readonly AskTask[]): BindingAsk[] {
  return bindingAsksOf(tasks, {
    entries: vault.list(),
    winnerOf: (name, agentId, folders) => vault.winnerOf(name, agentId, folders),
    foldersOf: (id) => {
      const a = registry.get(id)
      return a && !a.archived ? territoriesOf(a) : null
    },
    engineHosts: registeredHarnesses().flatMap((h) => (h.engineHosts?.hosts ?? []).map((x) => x.host)),
  })
}
const bindingAsks = {
  list: (): BindingAsk[] => bindingAsksFor(bindingAskTasksNow()),
  resolve: (saved: VaultEntry) => {
    const tasks = bindingAskTasksNow()
    const r = resolveBindingWaits(saved, bindingAsksFor(tasks), tasks, {
      // the owner's answer, ONE write (C14c): the note, the wait cleared, the state
      answer: (key, text) => {
        const w = siloActions.taskGesture(PLANS_SILO, key, 'answer', { text })
        if (!w.ok) return { ok: false, reason: w.reason }
        const st = (w.value.record as Record<string, unknown>).tasks
        const id = key.slice(key.lastIndexOf('/') + 1)
        const after = Array.isArray(st) ? (st as Array<Record<string, unknown>>).find((x) => x.id === id)?.state : undefined
        return { ok: true, state: typeof after === 'string' ? after : '' }
      },
    })
    if (r.resolved.length > 0) {
      try {
        taskMode.look()
      } catch {
        /* the tick looks again */
      }
    }
    return r
  },
}

// the event loop's stalls (loop-stalls.ts), counted from the listen on —
// the boot's own sync stretch is not a console's freeze
let loopStalls: LoopStalls | null = null
const app = buildServer({
  loadsScopes,
  loadsCarried,
  loopStalls: { snapshot: () => (loopStalls ?? new LoopStalls({ now: Date.now, log: () => {} })).snapshot() },
  initiative: { initiative, origins: plansOrigins },
  usage,
  vitals,
  // PeerRegistry and the account identity read from cfg.home (SILOS_HOME),
  // never os.homedir() directly — the same rule the comment above AccountsService
  // states: the E2E harness must see its fixture identity, not the machine's
  // real login (/api/account fed the real account email into committed shots).
  index,
  registry,
  store,
  native,
  lineage,
  owners,
  peers: new PeerRegistry(join(cfg.home, '.claude', 'sessions')),
  chat,
  exec,
  complete,
  prefs,
  memory,
  files,
  context,
  executions: executionsSource,
  terminals,
  token,
  liveMs: cfg.liveMs,
  webDist: cfg.webDist,
  dataDir: cfg.dataDir,
  home: cfg.home,
  ...(cfg.claudeManagedDir ? { claudeManagedDir: cfg.claudeManagedDir } : {}),
  toolHealth,
  // «Check now» starts the engine through the same SDK query as the chats
  checkQueryFn: sdkQueryFn,
  silosId,
  onOwnerActivity: () => instanceUsage?.markActive(),
  sessions,
  allowlist,
  seals,
  ownerToken: () => seals.ownerToken() ?? token,
  accountPath: join(cfg.home, '.claude.json'),
  backupsDir: join(cfg.dataDir, 'claude-settings-backups'),
  muted,
  automations,
  resident,
  broadcastBox,
  // Home's "who is on my Claude subscription now": /proc, Silos' console
  // socket, and the accounts' config dirs (harnesses/claude-code/account-load.ts).
  // the runs-on line's 5h/weekly bars: provider id → that account's config dir
  planUsage,
  // /proc is machine-global — no SILOS_HOME can fence it. SILOS_NO_ACCOUNT_LOAD=1
  // (the E2E harness) leaves the dep out so the route answers {supported:false}
  // and no shot ever carries the machine's real process table (same pattern as
  // SILOS_NO_AUTOTITLES/SILOS_NO_MODEL_CATALOG).
  ...(process.env.SILOS_NO_ACCOUNT_LOAD === '1'
    ? {}
    : { accountLoad: new AccountLoadService({ tmuxSocket: terminals.consoleSocket, accounts: () => accounts.configDirs(), home: cfg.home }) }),
  providers,
  accounts,
  vault,
  bindingAsks,
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
  heartbeatStore,
  pluginSkillsDir,
  controlOf: controlOfId,
  ownToday: (agentId: string, now: number) => ownTodayOf(agentId, now),
  accountResetOf: (agentId: string) => heartbeatAccountResetOf(agentId),
  proactiveView: (agentId: string, now: number) => proactiveViewOf(agentId, now),
  flipToTold: (agentId: string, name: string) => {
    // the flip to Only when told: its queued wakes superseded
    // at once; what still runs, for the sheet
    const queued = taskMode.supersedeAgent(agentId, `${name} is Only when told now — its queued wakes were dropped`)
    const running = [...taskMode.liveTurnsOf(agentId), ...resident.liveRunsOf(agentId)]
    const stillRuns = automations
      .list()
      .filter((a) => a.agentId === agentId && a.origin === 'self' && !a.paused)
      .map((a) => ({ id: a.id, name: a.name }))
    return { running, stillRuns, queued }
  },
  liveTurnsOf: (agentId: string) => [...taskMode.liveTurnsOf(agentId), ...resident.liveRunsOf(agentId)],
  agentTokens,
  territoryStore,
  egressRejectLog,
  egressProxyPort: egressPort,
  gatewayModels,
  taskMode,
  escalation,
  taskAsks,
  platformSettings,
  convPrefs,
  seen,
  taskSeen,
  needsYouAcks,
  proposals,
  automationTemplates,
  catalog,
  pendingResumes,
  origins,
  machine: { dir: machine.dir, diskPath: cfg.dataDir, since: serverSince },
  digests,
  notificationPrefs,
  push: { doorbell, devices: pushDevices },
  silosApi,
  // the thread tools shared with the task machinery (thread-tools.ts)
  absorbRotations,
  threadRootKey,
  threadIdOf,
  transcriptOnly,
  announce,
  threadsOfTasks,
  invalidateTaskThreads,
  // the System silo: a conversation's processes, stop-process, the trash's
  // «also stop»; and fresh numbers — a records read after a scan moved the
  // gauges reads the silo once more (no journal line: gauges are no facts;
  // at most one read per scan, however often the page asks)
  processes: processRecords,
  worktrees: worktreeRecords,
  freshenSilo: (id) => {
    if (id !== PROCESS_SILO) return
    const scanned = processRecords.scannedAt()
    if (scanned !== null && scanned > (siloKernel.readAt(id) ?? -Infinity)) siloKernel.refresh(id)
  },
  // the task lines and the stalls nobody moves (E6)
  taskFlows: (now) => taskFlowsNow(now),
  // (A2.8) the idle-console row: a thread live by the 2 h
  // rule (the taskEnv's own reading), that rule's window, a session's title
  conversationFacts: {
    threadLive: (ids) => threadsOfTasks(5_000).anyLive([...ids], liveConversation),
    busyMs: CONVERSATION_BUSY_MS,
    sessionOf: (id) => {
      const t = sessionTitleOf(id)
      const m = index.allSessions().find((x) => x.id === id)
      return t || m ? { title: t?.title ?? null, folder: m?.folder ?? null } : null
    },
  },
  closedPlans: () => closedPlansNow(),
  engines,
})

inboxCheckBox.now = () => app.checkInboxNow()

// First boot with no persisted catalog: fetched ONCE in the background from
// each engine's model source (see model-catalog.ts); subsequent restarts
// (tsx watch) read the files and spawn nothing.
void catalog.maybeRefreshOnBoot()

// After the server: each runtime's own (Claude Code: the transcript watcher).
booted.afterServer(harnessStart)
// Knows Drawer live feed: memory/context/skills writes of every registered
// agent/folder → one coalesced `knows` event per (kind, folder) over the same
// WS broadcast() the resident uses (broadcastBox is filled by buildServer above).
const knowsWatcher = startKnowsWatcher({
  registry,
  broadcast: (e) => {
    broadcastBox.send(e)
    // A plan changed: the resident evaluates that folder's standing agents
    // now instead of waiting for its 30 s tick (which stays as fallback) —
    // after the Plans silo has READ the write (G11): its file watch would
    // re-read within its coalescing window, too late for this evaluation.
    if (e.kind === 'plans') {
      try {
        siloKernel.refresh(PLANS_SILO)
      } catch (err) {
        console.warn('silos: reading plans failed —', err instanceof Error ? err.message : err)
      }
      // an execution hangs from a task by the plan's conversations[] and sources
      refreshExecutionsSoon()
      // task mode first: a wake it starts makes the task's conversation
      // busy, which the plan watch below already skips
      try {
        taskMode.look()
      } catch (err) {
        console.warn('task mode: look failed —', err instanceof Error ? err.message : err)
      }
    }
  },
  home: cfg.home,
  projectsRoot: cfg.root,
  dataDir: cfg.dataDir,
  // every installed silo's convention folders ride the same watcher: a new
  // record (a support case an agent just wrote) is read within a second, so
  // Home's Needs you, the doorbell and the silo's pages never wait for the
  // kernel's 5-minute timer (silos/kernel.ts noteFileChange)
  siloFolders: () => siloKernel.watchedFolders().map((w) => w.dir),
  onSiloFile: (p) => {
    siloKernel.noteFileChange(p)
  },
})
siloKernel.start() // reads every silo now, then on change and every 5 min
processRecords.start({ poll: process.env.SILOS_NO_PROCESS_SCAN !== '1' }) // the processes conversations left: a scan now, then every 30 s
worktreeRecords.start({ poll: process.env.SILOS_NO_WORKTREE_SCAN !== '1' }) // the worktrees conversations left: a scan now, then every 60 s
// resident.start() moved AFTER app.listen() resolves (watchdog): its
// boot pass closes every 'running' run as interrupted — a second process
// started by mistake would clobber the FIRST server's live runs before
// dying on EADDRINUSE. Holding the port first makes that impossible.
gatewayModels.start() // every key's model listing re-read at boot and every 6 h — see gateway-models.ts

// The index warms up in the background: the server already responds
// (overview carries warming: true). seedPendingBaseline() must run AFTER
// the index has real sessions — otherwise index.allSessions() is empty and
// the needs_you (C5) anti-edge baseline gets seeded empty forever (init()
// refreshes with emit:false, never repopulates it). Documented residual
// risk: an fs event landing between the watcher's startup and this
// resolution could still see an empty baseline — a much smaller window
// than "forever", accepted since this is a single local owner.
// seedPendingBaseline() used to be called only inside .then() — if
// index.init() REJECTS (a real failure, not just taking a while), the
// .catch() only logged and the needs_you (C5) anti-edge baseline would get
// seeded empty forever, resurfacing the original bug. With .finally(), the
// baseline gets seeded no matter what happens to init() (success or
// failure) — index.allSessions() can still return whatever it managed to
// index before the failure, better than nothing.
void index
  .init()
  .then(() => {
    console.log('index ready:', index.allSessions().length, 'sessions')
    // each runtime's warm-index step (OpenCode: consoles that outlived the
    // last server are rebound — registrar.ts rehydrate())
    booted.indexReady()
    // Usage: the turns the previous process left open close
    // `interrupted`, at their conversation's last record
    void usage.closeInterrupted().then(
      (n) => {
        if (n > 0) console.log(`usage: closed ${n} turn window(s) a restart cut`)
      },
      (err) => console.warn('usage: closing the cut turns failed —', err instanceof Error ? err.message : err),
    )
    // …and the live consoles are listed once now: one without a window
    // (launched before the register) gets it here, not at the first sweep
    void terminals.listConsoles().catch(() => {
      /* a listing never stops the boot */
    })
    // the one pass of task-native-bind.ts: the rehydrations bound before
    // the Plans reading was ready (nothing to do while Plans is not active)
    try {
      const n = nativeBindPass(taskMode.tasks(), (k) => terminals.nativeIdOf(k), appendNativeId)
      if (n > 0) console.log(`tasks: listed ${n} sealed id(s) beside their console keys`)
    } catch (err) {
      console.warn('tasks: native-bind pass failed —', err instanceof Error ? err.message : err)
    }
  })
  .catch((err) => console.error('initial scan failed:', err))
  .finally(() => {
    resident.seedPendingBaseline()
    startInboxJobs()
  })

// The doorbell and the daily digest — platform jobs, never automations: no
// run, no agent, zero tokens. Both read the inbox the server composes
// (app.composeInbox / app.onInboxChange), so they start only once the index
// is warm (a cold index has no asks: the doorbell would baseline a partial
// inbox, the digest would count nothing). SILOS_NO_DIGEST=1 (the E2E
// harness) keeps the digest job off, so Home shows only seeded files.
let inboxJobsStop: () => void = () => {}
const MORNING_PUSH_GRACE_MS = 2 * 3600_000
function startInboxJobs(): void {
  const bell = new InboxBell({ dataDir: cfg.dataDir, bell: doorbell })
  try {
    bell.baseline(app.composeInbox())
  } catch (err) {
    console.warn('doorbell: baseline failed —', err instanceof Error ? err.message : err)
  }
  const off = app.onInboxChange((rows) => {
    void bell.observe(rows)
  })
  bell.start(RESIDENT_TICK_MS)
  const job =
    process.env.SILOS_NO_DIGEST === '1'
      ? null
      : new DigestJob({
          store: digests,
          prefs: notificationPrefs,
          inbox: (now) => app.composeInbox(now),
          facts: (from, to) => app.digestFacts(from, to),
          onWritten: (f, lateByMs) => {
            console.log(`digest: ${f.date} written${f.late ? ' (late)' : ''}`)
            broadcastBox.send({ ev: 'digest' })
            // the morning push belongs to the morning: a digest caught up hours
            // later (Silos was down, or just installed) waits on Home, silently
            if (lateByMs <= MORNING_PUSH_GRACE_MS) void bell.morning(f)
          },
        })
  job?.start(RESIDENT_TICK_MS)
  inboxJobsStop = () => {
    off()
    bell.stop()
    job?.stop()
  }
}

let egressProxy: EgressProxy | null = null
app
  .listen({ host: cfg.host, port: cfg.port })
  .then(() => {
    loopStalls = startLoopStallMonitor().stalls
    // registration is idempotent: every boot re-announces this origin (a
    // broker that lost its registry learns it again); a failure retries lazily
    // on the first sign-in
    silosId?.ensureRegistered(true).then(
      (id) => {
        console.log(`Silos ID: registered ${silosId.publicOrigin} with ${silosId.brokerUrl} (${id})`)
        if (instanceUsage && !silosId.canReport)
          console.warn('Silos ID: this instance holds no reporting key — its usage is not sent (silos-id/README.md › Usage)')
        // finished days go at boot, then the first hour after each day ends
        void instanceUsage?.report()
        setInterval(() => {
          void instanceUsage?.report()
        }, 3_600_000).unref()
      },
      (err: unknown) => console.warn(`Silos ID: registration failed — ${err instanceof Error ? err.message : err}`),
    )
    const url = `http://${cfg.host}:${cfg.port}/?token=${seals.ownerToken() ?? token}`
    // a token the owner set in SILOS_TOKEN (a PaaS secret) is never echoed: it
    // already lives in the platform's variables, and deploy logs are read by
    // more people than the dashboard. A minted one is printed — the log is
    // where a first boot shows it.
    console.log(tokenFromEnv ? `Silos at http://${cfg.host}:${cfg.port}/ (token from SILOS_TOKEN)` : `Silos at ${url}`)
    // the packaged `silos` asks for it (open-browser.ts); `npm run dev` never does
    if (process.argv.includes('--open')) openBrowser(url)
    resident.start() // 30s heartbeat + missed-run policy + keep-session backup — see resident.ts; after listen, see the note above
    // the egress proxy re-listens on the same port every boot (a console's env
    // is frozen for days); a failure costs allowlisted agents their network
    // — closed, never open — and is said in the log
    startEgressProxy(
      {
        agentOf: (bearer) => {
          const id = agentTokens.agentIdOf(bearer)
          const a = id === null ? null : registry.get(id)
          return a && !a.archived ? a.id : null
        },
        policyFor: (agentId) => effectiveEgressOf({ egressOf: (id) => territoryStore.egressOf(id), agent: (id) => registry.get(id) }, agentId),
        log: egressRejectLog,
      },
      { port: egressPort },
    )
      .then((p) => {
        egressProxy = p
        console.log(`egress proxy at 127.0.0.1:${p.port}`)
      })
      .catch((err) => {
        console.error(
          `egress proxy: could not listen on 127.0.0.1:${egressPort} —`,
          err instanceof Error ? err.message : err,
          '— agents on an egress allowlist have no network until it does',
        )
      })
  })
  .catch((err) => {
    console.error('could not listen on', cfg.host + ':' + cfg.port, '—', err instanceof Error ? err.message : err)
    process.exit(1)
  })

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    terminals.killAll() // no PTY should outlive the server process
    resident.shutdown() // closes in-flight runs honestly (failed/interrupted, sessionKey kept) — the next boot continues their sessions
    inboxJobsStop()
    siloKernel.stop()
    processRecords.stop()
    worktreeRecords.stop()
    void Promise.allSettled([...booted.stop(), egressProxy?.close(), knowsWatcher.close(), siloRegistry.close(), index.flushCache(), app.close()]).then(() =>
      process.exit(0),
    )
  })
}
