import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { mungePath, type AgentRegistry } from './agent-registry.js'
import type { NativeStore } from './native-store.js'
import type { LineageStore } from './lineage.js'
import type { ChatEvent } from './chat-types.js'
import type { QueryFn } from './harnesses/claude-code/sdk-types.js'
import type { Agent } from './types.js'
import { agentMemoryPath } from './memory-service.js'
import { conversationTerritory, type ContextService } from './context-service.js'
import { consumeContextNews, contextNewsPath, readContextNews, THREAD_ID_RE } from './context-news.js'
import { makeThreadIdOf, type ThreadIdOf } from './task-threads.js'
import { territoriesOf } from './territory.js'
import type { ConversationRef } from './harnesses/contract.js'
import { FallbackTracker, looksLikeRateLimit, type FallbackState } from './fallback.js'
import { EngineRefusedError } from './harness-run.js'
import { providerPrices, type ProvidersStore, type ResolvedProvider } from './providers-store.js'
import { switchFor } from './platform-settings.js'
import { resolveCascade, type CockpitOverrides } from './cockpit.js'
import type { ConversationPrefsStore } from './conversation-prefs.js'
import type { ModelCatalog } from './model-catalog.js'
import type { VaultStore } from './vault-store.js'
import type { AgentStateStore } from './agent-state.js'
import type { FenceOverlay } from './territory.js'
import { fallbackFirst, harnessById, harnessOf, nonFallbackFirst, registeredHarnesses, registryGeneration } from './harnesses/registry.js'
import type { ChatTurnHooks, HarnessId, HeadlessContext, HeadlessEngine } from './harnesses/contract.js'
import { missionHeader } from './mission.js'
import { LiveTurns, type TurnDeclaration } from './live-turns.js'
import type { MessageReads, ServedBy } from './message-reads.js'
import type { ToolHealthLedger } from './tool-health.js'

// Appended to EVERY session's system prompt (see appendFor): decisions must
// surface through the engine's question tool because that tool call is the
// only marker the transcript carries for "the agent is waiting on the owner"
// — it's what feeds the honest needs_you state (context.pending). An open
// question in prose is invisible to that signal. The tool is named per
// engine (HarnessTraits.askTool, E10 #31); its first 8 words never change —
// they are the marker started-with.ts splits Silos' append on.
export function askDecisionsNote(askTool?: string | null): string {
  return `When you need a decision or missing input from the owner to continue, ask with ${askTool ? `the ${askTool} tool` : 'your question tool'} and offer clear options — do not bury the question in prose. Reserve it for real decisions.`
}
/** The engine-neutral form (no tool named). */
export const ASK_DECISIONS_NOTE = askDecisionsNote(null)

// The automations rule (scheduled work must be visible to the owner, with
// the proposals recipe) lives in the briefing alone —
// plugin/context/briefing.d/base.md, which every launch of both engines
// carries (Claude: withBriefingAfter on every append; OpenCode: the
// instruction file). A compact copy used to ride here too: the same rule
// and the same curl recipe landed TWICE in every conversation's prompt.
// The CronCreate gate (plugin/hooks/pre-cron.sh) still refuses a durable
// cron even in a session whose briefing failed to ride.

export interface ChatDeps {
  registry: AgentRegistry
  // the ledger of the turns' status readings of their servers (tool-health.ts):
  // absent, a reading is taken and dropped
  toolHealth?: Pick<ToolHealthLedger, 'record'>
  // the producing half of the silos this agent is bound to (silos/
  // producer-brief.ts) — null when none: the append stays as it was.
  // `has`: the skills the launch loads (a silo produced through a skill
  // briefs only a session without it)
  producerBriefFor?: (agentId: string, has: readonly string[]) => string | null
  // the Vault (vault.json): env credentials injected into every agent
  // process — optional with the usual criterion (absent in older tests).
  vault?: VaultStore
  // The server's API URL (SILOS_API in every agent process, agent-env.ts) —
  // absent: the address the config resolves (SILOS_HOST/SILOS_PORT).
  silosApi?: string
  native: NativeStore
  queryFn: QueryFn
  // Silos' data root (~/.silos) — used ONLY to
  // locate agents/<id>/memory.md and inject it into systemPrompt.append.
  // Optional so as not to break tests/harnesses that don't pass it yet:
  // without it, there's simply no agent memory to inject (safe
  // degradation, same behavior as today).
  dataDir?: string
  // Lineage: optional, same criterion as dataDir — without it, a fork
  // simply leaves no lineage record (safe degradation).
  lineage?: LineageStore
  // Providers v1: optional with the same safe-degradation criterion —
  // without a store, every agent runs on the default provider (the usual
  // byte-identical cleanEnv()) and fallback never activates.
  providers?: ProvidersStore
  // Cabin: the "conversation" level of the cascade — optional with the
  // same safe-degradation criterion: without a store, the cascade
  // collapses to agent-default → turn-override (tests that don't pass it
  // stay byte-identical to the long-standing behavior).
  convPrefs?: ConversationPrefsStore
  // Catalog for the effort/fastMode gate — optional, same criterion:
  // without a catalog (or an unknown model) everything passes through
  // as-is, with no invented validation.
  catalog?: Pick<ModelCatalog, 'infoOf'>
  // Agent context: optional, same criterion — without it (or without a
  // folder), the context-files note isn't added and the append stays
  // byte-identical to the long-standing behavior.
  context?: ContextService
  // «Which conversation is this session?» — the ONE resolver (task-threads.ts
  // makeThreadIdOf) the routes use too: a conversation's files and its
  // context news are keyed by its thread root. Absent: lineage alone.
  threadIdOf?: ThreadIdOf
  // The agent↔platform state channel (SILOS_AGENT_STATE): optional, same
  // criterion as vault — without it, no state dir is injected and an
  // agent's responsibility skill has nowhere to write runmode/status.
  agentState?: AgentStateStore
  // Territory: the per-agent permissions overlay (deny rules +
  // additionalDirectories). Optional, same criterion — without it, or for
  // an agent with no fence (master), the options stay byte-identical.
  territory?: { fenceFor(agentId: string): FenceOverlay | null }
  // What one agent's launches load, kept by Silos (loads-scopes.ts): the
  // payloads its turns carry beside the fence, in overlay order — the
  // launch folder's (an engine whose project place is carried), the
  // agent's, then (given a session of a known conversation) its thread's;
  // the engine validates each against its own allowlist. Absent or empty: the
  // options stay byte-identical.
  loadsCarried?: (agentId: string, cwd?: string, sessionId?: string) => unknown[]
  // every login's own directory on this machine, read at each launch: what
  // an engine computes a launch place's choice against (personal
  // instructions off covers every login known THEN). Absent: its default.
  loginDirs?: () => string[]
  // Chat engines by harness, overriding the harness's own headless factory
  // (tests). send() dispatches by the agent's harness; an engine whose
  // factory returns null refuses its agents' turns (never sent to the SDK).
  headless?: Partial<Record<HarnessId, (ctx: HeadlessContext) => HeadlessEngine | null>>
  // Each harness's runtime options for its headless factory (from the
  // composition root) — absent, a harness that needs them wires no engine.
  headlessOptions?: Partial<Record<HarnessId, unknown>>
  // Why a turn on this harness is refused — its engine is older than Silos
  // needs (harness.ts HarnessService.refusal: one line with the update
  // command) — or null. Absent: no gate (tests that don't ask).
  compatGate?: (harness: HarnessId) => Promise<string | null>
  // The turn tokens (live-turns.ts): send() mints one
  // per turn. Absent: the service keeps its own (tests).
  liveTurns?: LiveTurns
  // The install's unattended provider (platform-settings.ts):
  // what every unattended turn runs on unless the turn names its own.
  // Absent, or null: each agent's own cascade.
  settings?: { unattendedProvider(): string | null }
  // The serving of an inbox, marked by the class of the turn (message-reads.ts):
  // a turn without hooks gets «Your Silos inbox» from
  // it, and an unattended turn that ends WITH output marks what it was
  // served. Absent: no inbox in hookless turns, nothing marked (tests).
  messageReads?: MessageReads
  // Usage's windows (usage-ledger.ts): every turn
  // opens one at its chat-init and closes it when its send ends. Absent:
  // nothing recorded (tests).
  usage?: TurnWindows
}

/** What ChatService tells Usage about each turn (usage-ledger.ts). */
export interface TurnWindows {
  turnOpened(t: { turnId: string; agentId: string; folder: string; sessionId: string; turn: TurnDeclaration; provider: ResolvedProvider | null }): void
  /** `chatDone`: the engine said its end and price — without it, the
   *  turn's cost is read from its transcript («one money»). */
  turnClosed(turnId: string, outcome: 'done' | 'failed' | 'cancelled', chatDone: boolean): void
}

// One turn's input, named once for every engine (HeadlessEngine.send).
export type ChatSendInput = Parameters<ChatService['send']>[0]

export class ChatService extends EventEmitter {
  // One chat engine per registered harness (Harness.headless, or the
  // ChatDeps.headless override), in registration order. ChatService routes by
  // harness and keeps the provider/fallback/append bookkeeping.
  private engines = new Map<HarnessId, HeadlessEngine>()
  // the RESUMED sessions a turn of this service is running right now — every
  // turn (the chat route's, the resident's task wakes and message turns)
  // passes through send(), so this is the one honest answer to «is something
  // writing this conversation?» before the harness lock throws its raw error
  // A NEW session has no id until chat-init and can
  // collide with nothing.
  private liveResumes = new Map<string, { turnId: string; unattended: boolean }>()
  // Providers v1 — simple fallback: in-memory state per agent (the active
  // fallback provider + until when). Switching is ALWAYS at a turn
  // boundary: this tracker is only consulted when STARTING a turn and only
  // written when SEEING a 'rejected' rate limit — the turn in progress is
  // never touched.
  private fallback = new FallbackTracker()
  // Last rate limit seen PER PROVIDER (the account cards' 5h bar): honest
  // attribution — only the window of the provider a turn actually went
  // through is known; the rest stays "unknown" in the UI.
  private rateLimits = new Map<string, { status: string; resetsAt?: string; kind?: string; utilization?: number; at: string }>()
  // the turn tokens this service mints (SILOS_TURN) — shared with the
  // server's classification of bearer writes and with the consoles
  readonly liveTurns: LiveTurns
  // turnId → the provider the engine resolved for it (hooks.providerFor):
  // what the turn REALLY ran on, fallback applied — its chat-done says
  // whether that provider prices (the spend cap's input)
  private turnProviders = new Map<string, ResolvedProvider | null>()
  // conversation → the provider the unattended switch put its last
  // unattended turn on (the column's «on <provider> · unattended setting»).
  // In memory: after a restart the line waits for the next such turn.
  private unattendedOn = new Map<string, string>()
  constructor(private deps: ChatDeps) {
    super()
    this.liveTurns = deps.liveTurns ?? new LiveTurns()
    const hooks: ChatTurnHooks = {
      providerFor: (agent, pinnedId, turnId) => {
        const r = this.providerForTurn(agent, pinnedId)
        if (turnId !== undefined) this.turnProviders.set(turnId, r.provider)
        return r
      },
      appendFor: (agent, has, conv) => this.appendFor(agent, has, conv),
      onRateLimit: (agent, turn, ev) => this.noteRateLimit(agent, turn, ev),
      onErrorText: (agent, turn, text) => this.burnIfFallbackTextLimit(agent, turn, text),
      emit: (agentId, event) => {
        this.settleContextTurn(event)
        this.emit('chat-event', { agentId, event })
      },
      // the turn's own status of its servers, kept (tool-health.ts) — a
      // reading never reaches the turn: a ledger that cannot write loses it
      onToolStatus: (reading) => {
        try {
          this.deps.toolHealth?.record(reading)
        } catch (err) {
          console.warn('tool-health: a reading was not kept:', err instanceof Error ? err.message : String(err))
        }
      },
    }
    this.threadIdOf = deps.threadIdOf ?? makeThreadIdOf({ lineage: deps.lineage, metaById: () => null })
    for (const h of registeredHarnesses()) {
      // deps: this.deps itself — engines read its fields at use time (tests
      // swap deps.queryFn on a built ChatService between turns)
      const ctx: HeadlessContext = { deps: this.deps, hooks, options: this.deps.headlessOptions?.[h.id] }
      const override = this.deps.headless?.[h.id]
      const engine = override ? override(ctx) : (h.headless?.(ctx) ?? null)
      if (engine) this.engines.set(h.id, engine)
    }
  }

  // ---- Providers v1: per-turn resolution --------------------------------

  // The EFFECTIVE provider for the turn about to start. The primary is the
  // pinned one (a conversation's or a turn's `provider` override) or the
  // agent's own; the agent's fallback only diverts turns whose primary IS
  // the provider that hit the limit — a conversation pinned to another
  // account keeps its account (switching is declared, never
  // silent). An active fallback whose until hasn't passed, else the primary.
  providerForTurn(agent: Agent, pinnedId?: string, now = new Date()): { provider: ResolvedProvider | null; onFallback: FallbackState | null } {
    if (!this.deps.providers) return { provider: null, onFallback: null }
    const primary = this.resolvePrimary(agent, pinnedId)
    const fb = this.fallback.effective(agent.id, now)
    if (fb && fb.from === (primary?.id ?? 'default')) {
      const p = this.deps.providers.resolve(fb.providerId)
      // The fallback provider could have been deleted while active — it's
      // cleared and falls back to the primary, the turn never breaks.
      if (p) return { provider: p, onFallback: fb }
      this.fallback.clear(agent.id)
    }
    return { provider: primary, onFallback: null }
  }

  // A pinned provider that no longer exists (account dir removed, key
  // deleted) falls back to the agent's own with ONE warning per id — the
  // same tolerance-on-read as ProvidersStore.resolveForAgent.
  private unknownPins = new Set<string>()
  private resolvePrimary(agent: Agent, pinnedId: string | undefined): ResolvedProvider | null {
    const providers = this.deps.providers!
    if (pinnedId !== undefined) {
      const p = providers.resolve(pinnedId)
      if (p) return p
      const key = `${agent.id}:${pinnedId}`
      if (!this.unknownPins.has(key)) {
        this.unknownPins.add(key)
        console.warn(`chat-service: provider '${pinnedId}' pinned on a conversation of ${agent.id} is unknown — using the agent's own`)
      }
    }
    return providers.resolveForAgent(agent.id, agent.provider)
  }

  // The provider a CONSOLE spawn must honor — the same cascade as a chat
  // turn (an explicit pick for a NEW console → the conversation's pin → the
  // agent's own, with the agent's fallback applied), minus the turn level.
  consoleProviderFor(agentId: string, cwd: string, sessionId?: string, pick?: string): ResolvedProvider | null {
    const agent = this.deps.registry.get(agentId)
    if (!agent) return null
    const conv = sessionId && this.deps.convPrefs ? this.deps.convPrefs.get(mungePath(cwd), sessionId) : null
    return this.providerForTurn(agent, pick ?? conv?.provider).provider
  }

  // An agent's current fallback state (the "on fallback · resumes HH:MM"
  // badge in the overview/Board) — null if it runs on its primary.
  fallbackStateOf(agentId: string, now = new Date()): FallbackState | null {
    return this.fallback.effective(agentId, now)
  }

  // Last rate-limit window seen for a specific provider (account cards in
  // Settings › Providers) — null = an honest "unknown".
  // The provider the install's switch puts THIS turn on, or null — only
  // an unattended turn that names no provider of its own (an automation's
  // runsOn wins: the owner set it) and is not the owner's own chat turn
  // resent at its reset (class 'chat': his conversation, his use — the
  // switch covers heartbeats, task wakes and automations); only when the agent's engine
  // can run it (a mixed fleet keeps its own account), and an id that
  // no longer exists is skipped the same way — never a broken turn.
  unattendedProviderFor(agent: Agent, input: { unattended?: boolean; overrides?: CockpitOverrides; turn?: TurnDeclaration }): string | null {
    if (input.unattended !== true || input.overrides?.provider !== undefined || input.turn?.class === 'chat') return null
    return switchFor(this.deps.settings?.unattendedProvider() ?? null, harnessOf(agent), this.deps.providers)
  }

  /** The provider an UNATTENDED turn of this agent would run on right now —
   *  the SAME resolution send() makes: the turn's
   *  own provider (an automation's runsOn), else the install's switch, else
   *  the agent's own, with its fallback applied. Null: no providers store. */
  unattendedTurnProvider(agentId: string, runsOnProvider?: string, now = new Date()): ResolvedProvider | null {
    const agent = this.deps.registry.get(agentId)
    if (!agent) return null
    const overrides = runsOnProvider !== undefined ? { provider: runsOnProvider } : undefined
    const switched = this.unattendedProviderFor(agent, { unattended: true, ...(overrides ? { overrides } : {}), turn: { class: 'heartbeat' } })
    return this.providerForTurn(agent, overrides?.provider ?? switched ?? undefined, now).provider
  }

  // the provider the switch ran this conversation's last unattended turn on
  // — null when none did (since this server started), or its last
  // unattended turn ran on the agent's own
  unattendedProviderOf(sessionId: string): string | null {
    return this.unattendedOn.get(sessionId) ?? null
  }

  rateLimitOf(providerId: string): { status: string; resetsAt?: string; kind?: string; utilization?: number; at: string } | null {
    return this.rateLimits.get(providerId) ?? null
  }

  async *send(input: {
    turnId: string
    agentId: string
    text: string
    resume?: { sessionId: string; mode: 'append' | 'fork' }
    cwd?: string // effective cwd — only used by master (agent.folder === null); ignored for everyone else, agent.folder rules
    // Isolation for unattended sessions — omitted = the long-standing
    // behavior (parity with the owner's terminal, inherits EVERYTHING).
    // When passed, it replaces settingSources and adds
    // settings.disableAllHooks — the user's hooks/plugins (claude-mem,
    // superpowers, ...) don't fire on automated runs unless inheritHooks.
    isolation?: { settingSources: Array<'user' | 'project' | 'local'>; disableAllHooks?: boolean }
    // Cabin: TURN-LEVEL overrides (a one-shot from the UI) — win over the
    // conversation level (convPrefs), which wins over the agent's default.
    // Arrive ALREADY validated by the route (validateTurnOverrides).
    overrides?: CockpitOverrides
    // EXPLICIT marker for an unattended run — the resident passes it on
    // ALL its sends (runs, keep threads, retries). With it, the cascade's
    // conversation level is ignored. `isolation` is never overloaded as a
    // proxy for this: with inheritHooks:true the resident sends isolation
    // as undefined, and using it as a proxy let the thread's prefs slip through.
    unattended?: boolean
    // WHICH turn this is: its class — 'chat' (the
    // owner's chat), 'heartbeat' (with kind/packetKeys), 'wake' (taskKey),
    // 'run' (automationId). It rides the turn token, never the body of a
    // bearer request. Omitted: a chat turn — and an `unattended` send MUST
    // name its class («attended» is a class, never a default, G2).
    turn?: TurnDeclaration
    // SET BY send() ITSELF — the turn token the engine exports as
    // SILOS_TURN; whatever a caller puts here is overwritten
    turnToken?: string
  }): AsyncGenerator<ChatEvent> {
    const agent = this.deps.registry.get(input.agentId)
    if (!agent) throw new Error('agent not found')
    const h = harnessById(harnessOf(agent))
    const engine = this.engines.get(h.id)
    if (!engine) throw new Error(`no ${h.label} chat engine wired — cannot run an ${h.label} agent's turn`)
    // archived and master-without-a-folder are the engine's own checks (the
    // Claude engine refuses them before the turn; OpenCodeHeadless.send too).
    // Every event is emitted to 'chat-event' by the engine, in order.
    // The switch rides as the TURN level of the cascade — the slot an
    // automation's runsOn uses — so both engines honor it and the agent's
    // fallback chain still applies to the effective provider
    const switched = this.unattendedProviderFor(agent, input)
    if (switched !== null) input = { ...input, overrides: { ...(input.overrides ?? {}), provider: switched } }
    const resumeId = input.resume?.sessionId
    const declared = input.turn ?? (input.unattended === true ? null : { class: 'chat' as const })
    if (declared === null) throw new Error('an unattended turn must declare its class (turn.class) — attended is never a default')
    // the turn token: minted for EVERY turn, bound to its session at
    // chat-init (a resume already knows it; a fork's is the new branch)
    const turnToken = this.liveTurns.mintTurn({
      agentId: agent.id,
      turnId: input.turnId,
      turn: declared,
      unattended: input.unattended === true,
      ...(resumeId !== undefined && input.resume?.mode === 'append' ? { sessionId: resumeId } : {}),
    })
    if (resumeId !== undefined) this.liveResumes.set(resumeId, { turnId: input.turnId, unattended: input.unattended === true })
    let produced = false,
      done = false,
      failed = false
    let doneSubtype: string | null = null,
      opened = false
    // a NEW conversation's id is known only at chat-init: the turn is live on
    // it from then on (liveOn — what lets the owner steer a first turn too)
    let bornLive: string | null = null
    try {
      // an engine older than Silos needs never runs the turn:
      // refused like a missing engine, in the verdict's one line — inside
      // the live mark, so no console can open over the session meanwhile
      // (no gate wired, no await: the turn starts in the same tick as before)
      if (this.deps.compatGate) {
        const refused = await this.deps.compatGate(h.id)
        if (refused) throw new EngineRefusedError(refused, h.id)
      }
      for await (const ev of engine.send(agent, { ...input, turnToken })) {
        if (ev.ev === 'chat-init' && ev.turnId === input.turnId) {
          this.liveTurns.bindSession(turnToken, ev.sessionId)
          if (resumeId === undefined && bornLive === null && !this.liveResumes.has(ev.sessionId)) {
            bornLive = ev.sessionId
            this.liveResumes.set(ev.sessionId, { turnId: input.turnId, unattended: input.unattended === true })
          }
          if (input.unattended === true) {
            if (switched !== null) this.unattendedOn.set(ev.sessionId, switched)
            else this.unattendedOn.delete(ev.sessionId)
          }
          if (!opened && this.deps.usage) {
            opened = true
            try {
              this.deps.usage.turnOpened({
                turnId: input.turnId,
                agentId: agent.id,
                folder: ev.folder,
                sessionId: ev.sessionId,
                turn: declared,
                provider: this.turnProviders.get(input.turnId) ?? null,
              })
            } catch (err) {
              console.warn('chat: opening the usage window failed —', err instanceof Error ? err.message : err)
            }
          }
        }
        if (ev.ev === 'chat-done' && ev.turnId === input.turnId) doneSubtype = ev.subtype
        // «with output» — what the resident calls a turn that started
        // (text, a tool, thinking, output tokens) and ended without an error
        if ((ev.ev === 'chat-delta' && ev.text !== '') || ev.ev === 'chat-tool' || ev.ev === 'chat-thinking' || (ev.ev === 'chat-usage' && ev.outputTokens > 0))
          produced = true
        else if (ev.ev === 'chat-error') failed = true
        else if (ev.ev === 'chat-done' && ev.turnId === input.turnId) done = true
        // what the turn's provider is: one that prices (an API key) or a
        // plan — the spend cap sums only the first. No providers
        // store (tests): nothing said, the event as the engine wrote it
        if (ev.ev === 'chat-done' && ev.turnId === input.turnId && this.deps.providers && this.turnProviders.has(input.turnId)) {
          yield { ...ev, priced: providerPrices(this.turnProviders.get(input.turnId)) }
          continue
        }
        yield ev
      }
    } catch (err) {
      failed = true
      throw err
    } finally {
      if (opened && this.deps.usage) {
        const outcome =
          this.cancelledTurns.has(input.turnId) || doneSubtype === 'cancelled' ? 'cancelled' : !failed && doneSubtype === 'success' ? 'done' : 'failed'
        try {
          this.deps.usage.turnClosed(input.turnId, outcome, done)
        } catch (err) {
          console.warn('chat: closing the usage window failed —', err instanceof Error ? err.message : err)
        }
      }
      this.cancelledTurns.delete(input.turnId)
      this.turnProviders.delete(input.turnId)
      // an unattended turn that ended WITH output marks what it was served
      // (its briefing's inbox, its packet, its GETs) — a dead turn eats none
      const ended = this.liveTurns.get(turnToken)
      if (ended && this.deps.messageReads) {
        try {
          this.deps.messageReads.turnEnded(ended, produced && done && !failed)
        } catch (err) {
          console.warn('chat: marking the served messages read failed —', err instanceof Error ? err.message : err)
        }
      }
      this.liveTurns.drop(turnToken)
      if (resumeId !== undefined && this.liveResumes.get(resumeId)?.turnId === input.turnId) this.liveResumes.delete(resumeId)
      if (bornLive !== null && this.liveResumes.get(bornLive)?.turnId === input.turnId) this.liveResumes.delete(bornLive)
    }
  }

  // the turn this service is running on that session right now, or null —
  // what the chat route asks BEFORE handing a console over or colliding with
  // the harness lock (a wake turn's raw «a turn is already in progress»)
  liveOn(sessionId: string): { turnId: string; unattended: boolean } | null {
    return this.liveResumes.get(sessionId) ?? null
  }

  private noteRateLimit(
    agent: Agent,
    turn: { provider: ResolvedProvider | null; onFallback: FallbackState | null },
    ev: { status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: string; kind?: string; utilization?: number },
  ): void {
    const providerId = turn.provider?.id ?? 'default'
    this.rateLimits.set(providerId, {
      status: ev.status,
      ...(ev.resetsAt !== undefined ? { resetsAt: ev.resetsAt } : {}),
      ...(ev.kind !== undefined ? { kind: ev.kind } : {}),
      ...(ev.utilization !== undefined ? { utilization: ev.utilization } : {}),
      at: new Date().toISOString(),
    })
    if (ev.status !== 'rejected' || !this.deps.providers) return
    // If the turn that just got limited was ALREADY going out through the
    // fallback, the fallback is BURNED — it's cleared (with or without
    // resetsAt in the event) and the next turn goes back to the primary,
    // which will wait for its reset as usual. Without this, the resident
    // would retry via the broken fallback every tick (30s) until the
    // primary's reset.
    if (turn.onFallback) {
      this.fallback.clear(agent.id)
      return
    }
    if (ev.resetsAt === undefined) return
    const providers = this.deps.providers
    this.fallback.note(agent.id, agent.fallback, (id) => providers.resolve(id), providerId, ev.resetsAt)
  }

  // anthropic-compatible proxies normally don't emit rate_limit_event —
  // their 429 arrives as error TEXT. If that text smells like a rate limit
  // and the turn was going out through the fallback, it's burned the same way.
  private burnIfFallbackTextLimit(agent: Agent, turn: { onFallback: FallbackState | null }, errorText: string): void {
    if (turn.onFallback && looksLikeRateLimit(errorText)) this.fallback.clear(agent.id)
  }

  // Non-fallback engines first, the fallback last (the long-standing order:
  // OpenCode, then Claude); the first that knew the turn answers.
  async cancel(turnId: string): Promise<boolean> {
    for (const h of nonFallbackFirst(registeredHarnesses())) {
      const engine = this.engines.get(h.id)
      if (engine && (await engine.cancel(turnId))) {
        this.cancelledTurns.add(turnId)
        return true
      }
    }
    return false
  }
  // the owner's message into a turn still running (HeadlessEngine.steer):
  // true when an engine took it for its next step
  steer(turnId: string, text: string): boolean {
    for (const h of nonFallbackFirst(registeredHarnesses())) {
      const engine = this.engines.get(h.id)
      if (engine?.steer?.(turnId, text)) return true
    }
    return false
  }
  // turns cancel() reached — their window closes `cancelled`, whatever
  // the engine's last word; dropped at the turn's end
  private cancelledTurns = new Set<string>()

  // The engines in the order isInflight/isSessionActive have always asked:
  // the fallback (Claude) first, then the others in registration order.
  // Kept while the registry stays the same (registryGeneration): the busy
  // check asks it per conversation, and a task-flow pass asks thousands —
  // a walk of the registry each time showed in the live profile.
  private engineOrder: { gen: number; list: HeadlessEngine[] } | null = null
  private fallbackFirst(): HeadlessEngine[] {
    const gen = registryGeneration()
    if (this.engineOrder?.gen === gen) return this.engineOrder.list
    const list = fallbackFirst(registeredHarnesses())
      .map((h) => this.engines.get(h.id))
      .filter((e): e is HeadlessEngine => e !== undefined)
    this.engineOrder = { gen, list }
    return list
  }

  // The server's ground truth for the frontend's WS resilience watchdog:
  // if the turn is still in the inflight map, the SDK is still working on
  // it (no persisted-content heuristic is reliable here — a turn with
  // several tool calls can go minutes without persisting anything new).
  isInflight(turnId: string): boolean {
    return this.fallbackFirst().some((e) => e.isInflight(turnId))
  }

  // Whether a turn (interactive, resident, or mission) is currently WRITING
  // this session's JSONL — the SDK appends by sessionId, tracked in
  // activeSessions on resume. The trash route consults this: moving a file the
  // running claude is appending to lets its next write (or shutdown line)
  // recreate it at the old path (the SDK dual of the console-resurrection bug).
  isSessionActive(sessionId: string): boolean {
    return this.fallbackFirst().some((e) => e.isSessionActive(sessionId))
  }

  // The prelude stays as literal user text in the real JSONL (the SDK
  // doesn't separate "context" from "prompt"), so the UI (Turn.tsx,
  // stripAgentContext in web/src/lib/) and the parser-derived title
  // (server/src/harnesses/claude-code/parser.ts) hide it in presentation — the raw content is
  // untouched. Fixed format, in English, and NEVER starts with '<'
  // (isNoise() in the parser would kill the turn if it did).
  // "Agent memory": builds the final systemPrompt.append, every turn (not
  // cached: the owner can edit it between turns, via the panel or via the
  // composer's own memory mode). A missing or empty file (after trim)
  // adds no memory heading; the decisions note below is the one part that
  // is ALWAYS present (a platform behavior, not per-agent state).
  // the engine's question tool (HarnessTraits.askTool); an agent whose
  // engine can't be told falls back to the neutral wording
  private askToolOf(agent: Agent): string | null {
    try {
      return harnessById(harnessOf(agent)).traits.askTool ?? null
    } catch {
      return null
    }
  }

  // `has`: the skills this launch loads — the same set its briefing is
  // composed for
  private appendFor(agent: Agent, has: readonly string[], conv?: ConversationRef): string {
    const parts: string[] = []
    // the mission first (R3): the owner's text
    // and its «Never» lines, in every conversation of both engines
    if (agent.mission) parts.push(missionHeader(agent.mission))
    const memory = this.readAgentMemory(agent.id)
    if (memory !== '') parts.push(`# Agent memory\n${memory}`)
    const ctx = this.contextNote(agent, conv)
    if (ctx) parts.push(ctx)
    // the silos this agent produces (an active silo, an explicit binding):
    // the manifest's instructions + the kernel's routes, on both engines
    let produce: string | null = null
    try {
      produce = this.deps.producerBriefFor?.(agent.id, has) ?? null
    } catch {
      /* a silo never breaks a turn */
    }
    if (produce) parts.push(produce)
    // Decisions surface as STRUCTURED questions: the engine's question tool
    // is the only signal the platform can turn into an honest "Needs you"
    // (an open question in prose carries no marker). Scoped to real
    // decisions so agents don't turn every reply into a form.
    parts.push(askDecisionsNote(this.askToolOf(agent)))
    return parts.join('\n\n')
  }

  /** «Your Silos inbox» for a launch without hooks (message-reads.ts): ''
   *  without a reader. The serving is marked by `by`'s class. */
  inboxFor(agentId: string, by: ServedBy): string {
    return this.deps.messageReads?.inboxFor(agentId, by) ?? ''
  }

  // The permission mode a CONSOLE spawn must honor — the same cascade a
  // chat turn resolves (conversation override → the cockpit default,
  // bypass), minus the turn level (a console has no one-shot overrides).
  // Without this the console fell to the CLI's own default and its
  // auto-mode classifier blocked work the chat engine would have allowed.
  consolePermissionMode(cwd: string, sessionId?: string): string {
    const conv = sessionId && this.deps.convPrefs ? this.deps.convPrefs.get(mungePath(cwd), sessionId) : undefined
    return resolveCascade({}, conv, undefined).permissionMode
  }

  // The model a CONSOLE spawn must open on — the same cascade as a chat
  // turn (the conversation's pin › the agent's own), minus the turn level.
  // undefined when nobody opined: the CLI's default stands, never an id
  // Silos invented.
  consoleModel(agentId: string, cwd: string, sessionId?: string): string | undefined {
    const agent = this.deps.registry.get(agentId)
    const conv = sessionId && this.deps.convPrefs ? this.deps.convPrefs.get(mungePath(cwd), sessionId) : undefined
    return resolveCascade({ ...(agent?.model ? { model: agent.model } : {}) }, conv, undefined).model
  }

  // The output style a CONSOLE spawn must carry — the same cascade as a
  // chat turn (the conversation's pin › the agent's own), minus the turn
  // level. undefined when nobody opined: the operator's own config stands.
  consoleOutputStyle(agentId: string, cwd: string, sessionId?: string): string | undefined {
    const agent = this.deps.registry.get(agentId)
    const conv = sessionId && this.deps.convPrefs ? this.deps.convPrefs.get(mungePath(cwd), sessionId) : undefined
    return resolveCascade({ ...(agent?.outputStyle ? { outputStyle: agent.outputStyle } : {}) }, conv, undefined).outputStyle
  }

  // The same system-prompt append a chat session gets — exposed so the real
  // console can inject the IDENTICAL identity (mission + agent memory +
  // platform notes) into the CLI it spawns: one agent, the same self on
  // both engines. null for an unknown/archived agent.
  // `conv`: the conversation the console serves (its key, its cwd) — its
  // thread's given files join the note. A launch is never a turn: it moves
  // no «last turn» marker and consumes no queued news (the console's own
  // per-prompt hook drains those, contextQueueFor).
  systemAppendFor(agentId: string, has: readonly string[], conv?: { sessionId: string; cwd: string }): string | null {
    const agent = this.deps.registry.get(agentId)
    if (!agent || agent.archived) return null
    return this.appendFor(agent, has, conv ? { sessionId: conv.sessionId, cwd: conv.cwd } : undefined)
  }

  // The queue file of the thread a console serves — baked into its
  // per-prompt hook at launch (harnesses/claude-code/console.ts). null
  // without a data dir or for an id that is not a thread id.
  contextQueueFor(sessionId: string): string | null {
    if (this.deps.dataDir === undefined) return null
    const thread = this.threadIdOf(sessionId)
    return THREAD_ID_RE.test(thread) ? contextNewsPath(this.deps.dataDir, thread) : null
  }

  // "Context files" note: lists the files the agent can READ on demand (it
  // doesn't inject their content). Without a context store or a folder
  // (master), adds nothing — the append stays byte-identical to the
  // long-standing behavior.
  //
  // Files added since this CONVERSATION's last turn are called out on top
  // (context-service.ts awarenessNote newSince): the owner uploads a file
  // mid-conversation and the next turn knows. Per THREAD:
  // per agent, a new file was news to whichever conversation spoke next and
  // to no other, and every console open reset it. Moved only by a real turn
  // of that thread, when its `system/init` arrives (settleContextTurn). In
  // memory — after a restart the first turn simply gets the plain list.
  private lastTurnAt = new Map<string, number>()
  private threadIdOf: ThreadIdOf
  // turnId → what its append told it: the thread, when it was built, and
  // how many queued news lines it printed — settled at init, dropped when
  // the turn ends without one (the lines stay queued).
  private contextTurns = new Map<string, { thread: string; at: number; news: number }>()

  private contextNote(agent: Agent, conv?: ConversationRef): string | null {
    if (!this.deps.context || !agent.folder) return null
    try {
      const resolved = conv ? this.threadIdOf(conv.sessionId) : null
      const thread = resolved !== null && THREAD_ID_RE.test(resolved) ? resolved : null
      const since = thread !== null ? this.lastTurnAt.get(thread) : undefined
      const news = thread !== null && this.deps.dataDir !== undefined ? readContextNews(this.deps.dataDir, thread) : []
      const territory = conv && thread !== null ? conversationTerritory(territoriesOf(agent), conv.cwd) : null
      const note = this.deps.context.awarenessNote(agent.folder, agent.id, {
        ...(since !== undefined ? { newSince: since } : {}),
        ...(thread !== null && territory !== null && conv ? { thread: { id: thread, folder: territory, cwd: conv.cwd } } : {}),
        ...(news.length > 0 ? { news } : {}),
      })
      if (thread !== null && conv?.turnId !== undefined) this.contextTurns.set(conv.turnId, { thread, at: Date.now(), news: news.length })
      return note
    } catch {
      return null // a failure reading context/ must never break a turn
    }
  }

  // A turn's init is the proof it reached the model: only then is its
  // thread's «last turn» moved and the news it printed dropped from the
  // queue. A turn that ends without one (refused, failed before the model)
  // leaves both as they were.
  private settleContextTurn(event: ChatEvent): void {
    if (event.ev !== 'chat-init' && event.ev !== 'chat-done' && event.ev !== 'chat-error') return
    const t = this.contextTurns.get(event.turnId)
    if (!t) return
    this.contextTurns.delete(event.turnId)
    if (event.ev !== 'chat-init') return
    this.lastTurnAt.set(t.thread, t.at)
    if (t.news > 0 && this.deps.dataDir !== undefined) {
      try {
        consumeContextNews(this.deps.dataDir, t.thread, t.news)
      } catch {
        /* the queue is never worth a turn */
      }
    }
  }

  private readAgentMemory(agentId: string): string {
    if (this.deps.dataDir === undefined) return ''
    try {
      return readFileSync(agentMemoryPath(this.deps.dataDir, agentId), 'utf8').trim()
    } catch {
      return '' // no file yet (an agent with no memory of its own) → empty layer, not an error
    }
  }
}
