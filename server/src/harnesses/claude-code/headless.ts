import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mungePath } from '../../agent-registry.js'
import type { ChatEvent } from '../../chat-types.js'
import type { ChatDeps, ChatSendInput } from '../../chat-service.js'
import type { SdkQueryHandle, SdkMessage } from './sdk-types.js'
import type { Agent } from '../../types.js'
import { envForProvider } from './env.js'
import { ensureRolePluginManifest, rolePluginFor } from '../../role-plugin.js'
import { agentAutoMemoryDir } from '../../memory-service.js'
import { gatewayModelFor } from '../../provider-models.js'
import type { ChatTurnHooks, HeadlessEngine } from '../contract.js'
import { resolveCascade, validateTurnOverrides } from '../../cockpit.js'
import { BRIEFED_ENV, briefingText, silosBriefing, withBriefingAfter } from '../briefing.js'
import { activeSkillNames, preludeSkillNames } from '../../skill-states.js'
import { outputStyleSettings } from './output-styles.js'
import { filesCarry, withFilesCarried } from './local-holds.js'
import { loginDirsNow, withLaunchEntries } from './loads/launch-entries.js'
import { connectorsOnFor, turnStatusAsker } from './turn-status.js'
import { startLogin } from './loaded-at-start.js'
import { launchSkillNames } from './loads/skills.js'
import type { TurnVia } from '../contract.js'
import { inputChannel, type InputChannel } from './input-channel.js'

// The skills that schedule work natively: vetoed BY
// NAME in every heartbeat — a native cron or loop is recurring work the
// owner never sees, outside automations.json, the ledger and the counts.
// Permission-rule syntax of the documented `disallowedTools` (smoke:
// scripts/smoke-heartbeat-vetoes.mts says whether the engine honours it).
export const HEARTBEAT_SKILL_VETOES = ['Skill(schedule)', 'Skill(loop)'] as const
// The tools a heartbeat turn never has, with its tools or without (fixed
// in both): the native scheduler, the
// subagent tool (and its legacy alias — the heartbeat decides, it does not
// delegate, R4), the question to the owner (it decides, sleeps or leaves
// the wait in a task, m8) and the skills that schedule work.
// …and the engine's OTHER ways to delegate or schedule, which the live
// smoke found in a round's tools: `Workflow` orchestrates
// subagents, `RemoteTrigger` starts and schedules cloud agents,
// `ScheduleWakeup` re-arms the session by itself, `SendMessage` hands work
// to another local session. Same rule, by name; a name an engine version
// does not have is a no-op.
export const HEARTBEAT_DELEGATION_VETOES = ['Workflow', 'RemoteTrigger', 'ScheduleWakeup', 'SendMessage'] as const
export const HEARTBEAT_ALWAYS_OFF = ['CronCreate', 'Agent', 'Task', 'AskUserQuestion', ...HEARTBEAT_SKILL_VETOES, ...HEARTBEAT_DELEGATION_VETOES] as const
// …and, without its tools (a look, a think, a round with its files only),
// the web too
export const HEARTBEAT_DISALLOWED_TOOLS = [
  'CronCreate',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'AskUserQuestion',
  ...HEARTBEAT_SKILL_VETOES,
  ...HEARTBEAT_DELEGATION_VETOES,
] as const
// maxTurns of a heartbeat turn (limits.ts HEARTBEAT_MAX_TURNS, mirrored: the
// engine module stays free of the server's tunables) and of a round WITH
// its tools (limits.ts ROUND_MAX_TURNS)
export const HEARTBEAT_MAX_TURNS_SDK = 30
export const ROUND_MAX_TURNS_SDK = 60

/** The Agent SDK options an unattended turn adds: `CronCreate`
 *  withheld from EVERY unattended turn (a native cron is recurring work the
 *  owner never sees — kept from before, now tied to `unattended`, G5); a
 *  heartbeat additionally runs without web, subagents, questions, and with
 *  NO MCP server at all (`strictMcpConfig` + an empty `mcpServers`: only the
 *  servers passed count — none of .mcp.json, user settings or plugins). */
export function unattendedSdkOptions(input: Pick<ChatSendInput, 'unattended' | 'turn'>): Record<string, unknown> {
  if (input.turn?.class === 'heartbeat') {
    // a round WITH its tools (its SEALED regime): its skills, its connectors and the web — never a subagent, a
    // question, the native scheduler or a skill that schedules
    if (input.turn.regime?.tools === true) return { disallowedTools: [...HEARTBEAT_ALWAYS_OFF], maxTurns: ROUND_MAX_TURNS_SDK }
    return { disallowedTools: [...HEARTBEAT_DISALLOWED_TOOLS], mcpServers: {}, strictMcpConfig: true, maxTurns: HEARTBEAT_MAX_TURNS_SDK }
  }
  // RemoteTrigger schedules CLOUD work — standing work the owner cannot
  // see, the same class as a native cron (an automation is the visible way)
  return input.unattended ? { disallowedTools: ['CronCreate', 'RemoteTrigger'] } : {}
}

export type ClaudeHeadlessDeps = Pick<
  ChatDeps,
  'native' | 'queryFn' | 'lineage' | 'convPrefs' | 'catalog' | 'territory' | 'vault' | 'registry' | 'messageReads' | 'loadsCarried' | 'loginDirs' | 'dataDir'
> & {
  agentStateEnv(agentId: string): Record<string, string>
  /** agent-env.ts agentProcessEnv over these deps: Vault → state → SILOS_API → SILOS_SESSION_ID → SILOS_TURN. */
  processEnv(agent: Agent, cwd: string, key: string, turn?: string): Record<string, string>
}

// A Claude Code agent's chat turn over the Agent SDK's query(): the
// options, the SDK message → ChatEvent mapping, and the per-session lock.
export class ClaudeHeadless {
  private inflight = new Map<string, SdkQueryHandle>()
  // the open input of each interactive turn (input-channel.ts): steer() writes here
  private channels = new Map<string, InputChannel>()
  // Sessions with a turn in progress: the SDK appends to the same JSONL by
  // sessionId, two concurrent turns on the same id would corrupt the transcript.
  private activeSessions = new Set<string>()
  // `deps` is read at use time (a live view over ChatService.deps): never copy or destructure it here — tests swap deps.queryFn between turns.
  constructor(
    private deps: ClaudeHeadlessDeps,
    private hooks: ChatTurnHooks,
  ) {}

  // agent/cwd are already resolved (not found by ChatService.send; archived
  // and master without a folder by claudeEngine below).
  async *send(agent: Agent, cwd: string, input: ChatSendInput): AsyncGenerator<ChatEvent> {
    // A new session has no id yet (the SDK assigns it at init), so it
    // can't collide with anything — the guard is only needed on resume.
    const lockId = input.resume?.sessionId
    if (lockId !== undefined) {
      if (this.activeSessions.has(lockId)) throw new Error('a turn is already in progress for this session')
      this.activeSessions.add(lockId)
    }

    try {
      const isNew = !input.resume
      // an interactive turn (the owner at the keyboard) takes its prompt as
      // an open stream so a message typed while it works reaches it at its
      // next step (steer); an unattended turn keeps a closed text prompt
      const channel = input.unattended ? null : inputChannel(input.text)
      const prompt = channel ? channel.iterable : input.text
      // Defense in depth at the choke point — the route already validates,
      // but any future caller (the resident, new plumbing) goes through
      // here: an invalid override blows up BEFORE anything starts.
      const turnOverrides = input.overrides !== undefined ? validateTurnOverrides(input.overrides) : undefined
      // Cabin: the `agent default → conversation override → turn override`
      // cascade, resolved RIGHT BEFORE building the query's options. The
      // conversation level only exists for a resume (a new session has no
      // id yet to have saved prefs under). A fork inherits the SOURCE
      // session's prefs: turn 1 reads them from the source key and
      // chat-init copies that entry to the new branch's key (see toEvent)
      // — inheritance is real for turns 2+ too.
      // An UNATTENDED run ignores the conversation level — its turns stay
      // byte-identical even if the owner set plan/model on the thread from
      // the UI (a silently degraded automation would be worse than the
      // override). The key is the EXPLICIT `unattended` flag (the resident
      // always passes it), never the presence of `isolation`: with
      // inheritHooks:true isolation travels as undefined, and using it as
      // a proxy let the thread's prefs slip through.
      const conv = !input.unattended && input.resume && this.deps.convPrefs ? this.deps.convPrefs.get(mungePath(cwd), input.resume.sessionId) : null
      // Providers v1: the effective provider is resolved ONCE per turn (a
      // turn boundary — a rate limit mid-THIS-turn doesn't change its env,
      // only the next one's). Pinned by the turn, else the conversation,
      // else the agent's own (see providerForTurn).
      const effective = this.hooks.providerFor(agent, turnOverrides?.provider ?? conv?.provider, input.turnId)
      const loginDir = effective.provider?.kind === 'claude-account' ? effective.provider.configDir : null
      // A new session or a fork is born HERE: Silos picks its id (and, below,
      // writes the birth record before query() starts the claude). Minted
      // BEFORE the append: the append is for a known conversation — a new
      // one's thread is its own id, a fork's and a resume's the source's.
      const bornId = isNew || input.resume?.mode === 'fork' ? randomUUID() : null
      const conversationOf = isNew ? bornId! : (input.resume as { sessionId: string }).sessionId
      const effectiveCockpit = resolveCascade(
        { ...(agent.model ? { model: agent.model } : {}), ...(agent.outputStyle ? { outputStyle: agent.outputStyle } : {}) },
        conv,
        turnOverrides,
      )
      // If the catalog KNOWS the effective model and says it doesn't
      // support effort/fast mode, those overrides are dropped (sending
      // --effort to an unsupported model would assert something false).
      // An unknown model or an empty catalog = passes through as-is, no
      // invented validation.
      // a gateway runs what its key lists: a pinned model the pool dropped,
      // or no model at all, becomes the key's first model (gatewayModelFor)
      if (effective.provider?.kind === 'anthropic-compatible') {
        const gm = gatewayModelFor(effective.provider.models, effectiveCockpit.model ?? null)
        if (gm !== null) effectiveCockpit.model = gm
      }
      const modelInfo = this.deps.catalog?.infoOf(effectiveCockpit.model) ?? null
      if (modelInfo && modelInfo.supportsEffort !== true) delete effectiveCockpit.effort
      if (modelInfo && modelInfo.supportsFastMode !== true) effectiveCockpit.fastMode = false
      // fastMode has no field in Options and no --fast flag (sdk.d.ts
      // 0.3.233): it travels as Settings.fastMode via the `settings` layer
      // — merged with the isolation's disableAllHooks.
      const fence = this.deps.territory?.fenceFor(agent.id) ?? null
      // the role's own skills (role-plugin.ts): the state dir is read from
      // the same env the launch exports — one truth for both engines' paths
      const roleStateDir = this.deps.agentStateEnv(agent.id).SILOS_AGENT_STATE ?? null
      const rolePlugin = rolePluginFor(agent.id, roleStateDir)
      if (rolePlugin) ensureRolePluginManifest(rolePlugin, agent.id, agent.name)
      // the agent's own auto-memory dir (memory per agent): created at
      // launch, like the state dir; a deps without dataDir (tests) keeps
      // the engine's per-folder default
      const autoMemoryDir = this.deps.dataDir !== undefined ? agentAutoMemoryDir(this.deps.dataDir, agent.id) : null
      if (autoMemoryDir !== null) {
        try {
          mkdirSync(autoMemoryDir, { recursive: true })
        } catch {
          /* the engine creates it on first write */
        }
      }
      const baseSettings: Record<string, unknown> = {
        // a heartbeat runs with hooks off, FIXED (G4-r6): whatever its
        // automation says — a hook is a process the transcript never shows
        ...(input.isolation?.disableAllHooks || input.turn?.class === 'heartbeat' ? { disableAllHooks: true } : {}),
        ...(effectiveCockpit.fastMode ? { fastMode: true } : {}),
        // the territory fence rides the same flag-tier settings layer
        ...(fence ? { permissions: fence.permissions } : {}),
        // the agent's memory, not the folder's (memory per agent, t48)
        ...(autoMemoryDir !== null ? { autoMemoryDirectory: autoMemoryDir } : {}),
        // the cockpit's style: `outputStyle` + the style plugins off for
        // this process; nothing when nobody set one (output-styles.ts)
        ...outputStyleSettings(effectiveCockpit.outputStyle),
      }
      // The overlay (rule 14: the turn loads what the screen says, and never
      // more), later wins for an override kind, lists joined: what the
      // launch always carries (above), then every settings FILE this turn
      // does not read — the repository's, then the local one, for the
      // spec's keys in both directions (local-holds.ts) — then what Silos
      // keeps for this agent's launches and for its conversation's thread
      // (loads-scopes.ts), through the allowlist (loads/launch-entries.ts).
      // A heartbeat, with its tools or without, takes only what removes from
      // each. The fence's `permissions` is a key no carry can bring.
      const sources = input.isolation?.settingSources ?? ['user', 'project', 'local']
      const onlyRemoves = input.turn?.class === 'heartbeat'
      const files = withFilesCarried(baseSettings, filesCarry(cwd, { sources, configDir: loginDir, onlyRemoves }), { onlyRemoves })
      // a new conversation has no place of its own yet: it loads what its agent loads
      const settings = withLaunchEntries(files, this.deps.loadsCarried?.(agent.id, cwd, isNew ? undefined : conversationOf), {
        onlyRemoves,
        cwd,
        ...loginDirsNow(this.deps.loginDirs),
      })
      // the skills this turn loads — by the same carry: its briefing and
      // the silos' producer brief are composed for them
      const has = sdkTurnSkills(cwd, sources, loginDir, homedir(), undefined, settings)
      const briefed = this.withBriefing(
        agent,
        input.isolation?.disableAllHooks === true,
        this.hooks.appendFor(agent, has, { sessionId: conversationOf, cwd, turnId: input.turnId }),
        has,
        input.turnToken,
        cwd,
      )
      const append = this.withSkillsNote(cwd, briefed.append, has)
      // The birth record (bornId, minted above) is written before query()
      // starts the claude. The session's
      // own SessionStart hook writes its birth marker within milliseconds,
      // and a marker with no native record reads as a nested run — even a
      // moment of that hid a fresh conversation from the sidebar.
      // `system/init` still registers (idempotent; and the honest
      // id if an SDK ever ignored the option).
      if (bornId) this.deps.native.register(mungePath(cwd), bornId, { agentId: agent.id, createdAt: new Date().toISOString() })
      const sessionIdForTurn = bornId ?? (input.resume as { sessionId: string }).sessionId
      // the binary is the `claude` on PATH, set at the SDK boundary
      // (sdk.ts withClaudeExecutable) — the consoles' own, never the SDK's
      const options: Record<string, unknown> = {
        cwd,
        permissionMode: effectiveCockpit.permissionMode,
        // Required by the SDK alongside bypassPermissions (verified
        // against a real smoke test) — only with bypass: it's a no-op
        // under plan/acceptEdits.
        ...(effectiveCockpit.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        includePartialMessages: true,
        settingSources: input.isolation?.settingSources ?? ['user', 'project', 'local'],
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        // the engine's own options for an unattended turn: the
        // native scheduler withheld from EVERY unattended turn —
        // tied to `unattended`, never to hooks (G5) — and, in a heartbeat,
        // no web, no connectors, no subagents, no question to the owner
        ...unattendedSdkOptions(input),
        ...(fence ? { additionalDirectories: fence.permissions.additionalDirectories } : {}),
        // the role's skills plugin — the SDK's documented session-only
        // plugin load, the console's --plugin-dir in this dialect
        ...(rolePlugin ? { plugins: [{ type: 'local', path: rolePlugin }] } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
        // The SDK doesn't merge with process.env when env is passed — the
        // full set has to be given. envForProvider cleans what was
        // inherited and THEN injects the provider's own
        // (CLAUDE_CONFIG_DIR / ANTHROPIC_BASE_URL+AUTH_TOKEN); with the
        // default it's byte-identical to the usual cleanEnv().
        // The agent's process env spreads AFTER it (agent-env.ts): vault
        // vars so they actually land (their names are validated to never
        // collide with the provider/auth layer's), agent state later
        // (platform plumbing, immune to anything a vault entry names),
        // SILOS_API after both, and SILOS_SESSION_ID: the conversation this
        // claude serves — a `claude -p` it runs from Bash inherits it and
        // its birth marker names this conversation as `parent`
        // (plugin/hooks/birth.py). And SILOS_TURN: the turn token
        // (live-turns.ts) its bearer writes name themselves with.
        // and SILOS_BRIEFING when the append carries the briefing: the
        // SessionStart hook then sends only what is dynamic (session-start.sh)
        env: {
          ...envForProvider(effective.provider),
          ...this.deps.processEnv(agent, cwd, sessionIdForTurn, input.turnToken),
          ...(briefed.briefed ? BRIEFED_ENV : {}),
        },
        ...(effectiveCockpit.model ? { model: effectiveCockpit.model } : {}),
        ...(effectiveCockpit.effort ? { effort: effectiveCockpit.effort } : {}),
        ...(input.resume ? { resume: input.resume.sessionId } : {}),
        ...(input.resume?.mode === 'fork' ? { forkSession: true } : {}),
        // a new session or a fork: the id Silos chose (allowed by the SDK
        // without resume, or with forkSession)
        ...(bornId ? { sessionId: bornId } : {}),
      }

      const folder = mungePath(cwd) // master: the real folder under ~/.claude/projects comes from the effective cwd, not agent.folder (null)
      try {
        // inside the try: the query can refuse synchronously, before any
        // claude exists (sdk.ts: no `claude` on PATH any more — it vanished
        // between the cached compat gate and this turn). That is the turn's
        // chat-error like any other, and the birth record written for the
        // session that was never born is taken back (no orphan record).
        let handle: ReturnType<typeof this.deps.queryFn>
        // the process reads its settings as it starts: a switch after this
        // is not what its status reading saw (switch-proof.ts)
        const started = Date.now()
        try {
          handle = this.deps.queryFn({ prompt, options })
        } catch (err) {
          if (bornId) this.deps.native.unregister(mungePath(cwd), bornId)
          throw err
        }
        this.inflight.set(input.turnId, handle)
        if (channel) this.channels.set(input.turnId, channel)
        // the turn's own status of its servers (turn-status.ts): asked on
        // its first assistant or tool message, never awaited — a heartbeat
        // without its tools has no server to read
        const noServers = options.strictMcpConfig === true && Object.keys((options.mcpServers as object | undefined) ?? {}).length === 0
        const status = turnStatusAsker(handle, noServers || this.hooks.onToolStatus === undefined, (servers) => {
          const configDir = effective.provider?.kind === 'claude-account' ? effective.provider.configDir : null
          const conversation = sessionIdForTurn
          let login: string | null = null
          try {
            login = startLogin([join(configDir ?? join(homedir(), '.claude'), 'projects', folder, `${conversation}.jsonl`)])?.email ?? null
          } catch {
            /* no start yet */
          }
          const cls = input.turn?.class
          const via: TurnVia = cls === 'heartbeat' ? 'round' : cls === 'wake' || cls === 'run' || cls === 'chat' ? cls : input.unattended ? 'run' : 'chat'
          this.hooks.onToolStatus?.({
            folder: cwd,
            conversation,
            turnId: input.turnId,
            agentId: agent.id,
            login,
            via,
            started,
            connectorsOn: connectorsOnFor({
              cwd,
              home: homedir(),
              configDir,
              sources,
              flagSettings: settings,
              claudeLogin: effective.provider === null || effective.provider.kind === 'claude-account',
              strict: options.strictMcpConfig === true,
            }),
            servers,
          })
        })
        for await (const m of handle as AsyncIterable<SdkMessage>) {
          status.see(m)
          // the turn's answer: no more input — the process ends with it, so a
          // turn stays one turn (a push after this is refused and queued)
          if (m.type === 'result') channel?.close()
          const ev = this.toEvent(m, input, agent, folder)
          if (ev) {
            // Providers v1: every rate limit seen is attributed to the
            // provider THIS turn actually went through (the 5h card
            // window); a 'rejected' with resetsAt also arms the agent's
            // fallback for the NEXT turn (a turn boundary — this one is
            // never touched).
            if (ev.ev === 'chat-ratelimit') this.hooks.onRateLimit(agent, effective, ev)
            // Besides being yielded to this specific turn's consumer, it's
            // also emitted with agentId — so the resident can subscribe to
            // "any turn of this agent finished" without itself driving the
            // generator (server.ts drives it in the normal interactive chat).
            this.hooks.emit(agent.id, ev)
            yield ev
          }
        }
      } catch (err) {
        // If the agent's folder does NOT exist (e.g. the repo was
        // renamed/moved and agents.json kept a stale path), the SDK spawns
        // the child with a nonexistent cwd → ENOENT, which the SDK itself
        // DISGUISES as "native binary failed to launch / musl" (a misleading
        // message that cost hours to diagnose). It's translated to the
        // HONEST error in the catch — only when it has genuinely failed,
        // without touching the normal path or the tests.
        const original = err instanceof Error ? err.message : String(err)
        // Only translated when (a) the error has the SIGNATURE of the SDK's
        // spawn failure (its misleading libc/binary message) AND (b) the
        // folder genuinely doesn't exist — so a textual 429 or another real
        // error is never overridden.
        const isSpawnFailure = /failed to launch|native binary|ld-musl|ENOENT/i.test(original)
        const message =
          isSpawnFailure && !existsSync(cwd) ? `agent folder does not exist: ${cwd} — did it get moved or renamed? Update it in the agent settings.` : original
        const ev: ChatEvent = { ev: 'chat-error', turnId: input.turnId, error: message }
        // A textual 429 from the fallback (proxies with no
        // rate_limit_event) also burns it — the turn boundary stays intact.
        this.hooks.onErrorText(agent, effective, ev.error)
        this.hooks.emit(agent.id, ev)
        yield ev
      } finally {
        channel?.close()
        this.channels.delete(input.turnId)
        this.inflight.delete(input.turnId)
      }
    } finally {
      if (lockId !== undefined) this.activeSessions.delete(lockId)
    }
  }

  steer(turnId: string, text: string): boolean {
    return this.channels.get(turnId)?.push(text) ?? false
  }

  async cancel(turnId: string): Promise<boolean> {
    const handle = this.inflight.get(turnId)
    if (!handle) return false
    await handle.interrupt().catch(() => {
      /* best effort: the turn may have already finished */
    })
    return true
  }

  isInflight(turnId: string): boolean {
    return this.inflight.has(turnId)
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  // Slash menu: normalizes the init's command list — discards anything
  // that isn't a string, strips a leading '/' in case the CLI included it,
  // dedupes, and removes the "terminal-only" ones the SDK marks to hide on
  // remote surfaces.
  private slashCommandsFromInit(raw: unknown, terminal: unknown): string[] {
    const clean = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .filter((c): c is string => typeof c === 'string')
            .map((c) => c.replace(/^\//, '').trim())
            .filter((c) => c !== '')
        : []
    const hidden = new Set(clean(terminal))
    return [...new Set(clean(raw))].filter((c) => !hidden.has(c))
  }

  // The briefing (briefing.ts) rides EVERY turn's system-prompt append — one
  // agent, the same Silos, whoever started the turn; in the system prompt it
  // survives /clear and compaction and is never capped (a hook's
  // additionalContext is cut at 10,000 characters). `briefed` says so, and
  // the launch tells the SessionStart hook with SILOS_BRIEFING.
  //  · A turn WITH hooks (the owner's chat, an inheritHooks run): the static
  //    briefing only, after the append; its roster and its INBOX come from
  //    its own SessionStart (session-start.sh), never twice.
  //  · A turn with its hooks off (isolation: automations, task wakes,
  //    heartbeats) has no SessionStart at all: briefing + roster, and its
  //    INBOX («the reader first»): the same «Your
  //    Silos inbox» inbox.py prints at SessionStart (inbox-text.ts, its
  //    twin), composed from the server's store. The serving is marked by the
  //    turn token's class (message-reads.ts).
  // `has`: the skills THIS turn loads, so the briefing never
  // points at a skill the turn does not have (sdkTurnSkills).
  private withBriefing(
    agent: Agent,
    hooksOff: boolean,
    append: string,
    has: readonly string[],
    turnToken?: string,
    cwd?: string,
  ): { append: string; briefed: boolean } {
    if (!hooksOff) {
      let text = ''
      try {
        text = briefingText(has)
      } catch {
        /* the briefing never breaks a turn */
      }
      return { append: withBriefingAfter(append, text), briefed: text !== '' }
    }
    let brief = ''
    try {
      brief = silosBriefing(this.deps.registry.list(), agent.id, {
        withBearer: 'SILOS_AGENT_TOKEN' in this.deps.agentStateEnv(agent.id),
        has,
        cwd: cwd ?? null,
      })
    } catch {
      /* the briefing never breaks a turn */
    }
    let inbox = ''
    try {
      inbox = this.deps.messageReads?.inboxFor(agent.id, { turn: turnToken ?? null }) ?? ''
    } catch {
      /* the inbox never breaks a turn */
    }
    const head = [brief, inbox].filter((x) => x !== '').join('\n\n')
    return { append: head === '' ? append : append === '' ? head : `${head}\n\n${append}`, briefed: brief !== '' }
  }

  // The emphasis line names the FOLDER's skills THIS turn loads: its active
  // copies (capability states) that `has` — the one answer of what the
  // launch loads (sdkTurnSkills) — keeps, so a skill turned off at any
  // place is never named; never the retired agent.skills declaration.
  // Silos' own plugin skills first (heartbeat, responsibility, team-plan…),
  // capped at 8.
  // It rides the system append, never the owner's message:
  // prepended to the first prompt it sat in the transcript as text the
  // owner never typed, shown in the chat and the console as theirs.
  private withSkillsNote(cwd: string, append: string, has: readonly string[]): string {
    const names = preludeSkillNames(cwd, 8, undefined, has)
    if (names.length === 0) return append
    const note = `Your skills for this session include ${names.map((s) => `/${s}`).join(', ')} — load them when the task calls for them.`
    return append === '' ? note : `${append}\n\n${note}`
  }

  private toEvent(
    m: SdkMessage,
    input: { turnId: string; agentId: string; resume?: { sessionId: string; mode: 'append' | 'fork' } },
    agent: Agent,
    folder: string,
  ): ChatEvent | null {
    if (m.type === 'system' && (m as { subtype?: string }).subtype === 'init') {
      const sessionId = (m as { session_id: string }).session_id
      // a new session or a fork → a new identity to register as native to the agent
      if (!input.resume || input.resume.mode === 'fork') {
        this.deps.native.register(folder, sessionId, { agentId: agent.id, createdAt: new Date().toISOString() })
      }
      // Lineage: a fork is born from another session (the "Continue in
      // Silos" of a terminal session) — the lineage gets recorded, the
      // original stays untouched. resume.sessionId ALWAYS shares its
      // folder with the new branch: server.ts's guard requires the source
      // session to already classify to the same agent/cwd before reaching
      // here (see the 400 "does not belong to this agent's folder").
      if (input.resume?.mode === 'fork') {
        this.deps.lineage?.record(`${folder}/${sessionId}`, `${folder}/${input.resume.sessionId}`)
        // REAL inheritance of the conversation prefs — the fork's turn 1
        // already ran with the source's prefs (resume points at the old
        // id), but turns 2+ resume the NEW id: without this copy, the
        // cascade would collapse to bypass while the UI still shows the
        // inherited prefs (the shield would lie in the dangerous direction).
        this.deps.convPrefs?.copy(folder, input.resume.sessionId, folder, sessionId)
      }
      // Cabin (honest echo): model/permissionMode from the init are the
      // ground truth of the process that STARTED — the UI compares them
      // against what was requested and warns if they don't match.
      const init = m as { model?: string; permissionMode?: string; slash_commands?: unknown; terminal_slash_commands?: unknown }
      // Slash menu: captures the REAL commands the init announced, minus
      // the "terminal-only" ones (exit/statusline) the SDK itself marks as
      // unfit for remote/web surfaces (sdk.d.ts, terminal_slash_commands).
      // The field is only emitted if there really was a list (every init
      // of the minimum CLI carries `slash_commands`; an empty one leaves
      // `slashCommands` absent) — the UI degrades to skills, never to an
      // empty menu.
      const slashCommands = this.slashCommandsFromInit(init.slash_commands, init.terminal_slash_commands)
      return {
        ev: 'chat-init',
        turnId: input.turnId,
        folder,
        sessionId,
        ...(typeof init.model === 'string' ? { model: init.model } : {}),
        ...(typeof init.permissionMode === 'string' ? { permissionMode: init.permissionMode } : {}),
        ...(slashCommands.length > 0 ? { slashCommands } : {}),
      }
    }
    if (m.type === 'stream_event') {
      const e = (
        m as {
          event: {
            type: string
            content_block?: { type: string; name?: string; input?: unknown }
            delta?: { type: string; text?: string; thinking?: string }
            usage?: { output_tokens?: number }
          }
        }
      ).event
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
        return { ev: 'chat-delta', turnId: input.turnId, text: e.delta.text }
      }
      if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && typeof e.delta.thinking === 'string') {
        return { ev: 'chat-thinking', turnId: input.turnId, text: e.delta.thinking }
      }
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        // the first 120 chars of the serialized input, if the block already carries it at start
        // (sometimes arrives empty/partial — the rest comes via input_json_delta, not followed in v1).
        const raw = e.content_block.input
        const inputStr = raw !== undefined ? JSON.stringify(raw).slice(0, 120) : undefined
        return { ev: 'chat-tool', turnId: input.turnId, name: e.content_block.name ?? '?', ...(inputStr !== undefined ? { input: inputStr } : {}) }
      }
      if (e.type === 'message_delta' && typeof e.usage?.output_tokens === 'number') {
        return { ev: 'chat-usage', turnId: input.turnId, outputTokens: e.usage.output_tokens }
      }
      return null
    }
    // The full 'assistant' message (not the partial stream_event) is the
    // one that carries usage with the three context line items — same sum
    // as the parser (parser.ts): input + cache_creation + cache_read, only
    // the numeric fields present; if none are there, contextTokens stays
    // undefined (NEVER 0).
    if (m.type === 'assistant') {
      const usage = (m as { message?: { usage?: Record<string, unknown> } }).message?.usage
      if (typeof usage?.output_tokens === 'number') {
        const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].filter((n): n is number => typeof n === 'number')
        const contextTokens = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : undefined
        return {
          ev: 'chat-usage',
          turnId: input.turnId,
          outputTokens: usage.output_tokens,
          ...(contextTokens !== undefined ? { contextTokens } : {}),
        }
      }
      return null
    }
    if (m.type === 'result') {
      const r = m as { subtype: string; total_cost_usd?: number }
      return { ev: 'chat-done', turnId: input.turnId, subtype: r.subtype, costUsd: r.total_cost_usd ?? null }
    }
    // Resident + 5h/7d bar: rate_limit_info.resetsAt arrives in epoch ms —
    // normalized to ISO 8601 so the rest of the system (Automation.trigger,
    // Run.resetsAt) doesn't juggle two different date formats.
    if (m.type === 'rate_limit_event') {
      const info = (m as { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number } }).rate_limit_info
      if (!info || typeof info.status !== 'string') return null
      return {
        ev: 'chat-ratelimit',
        turnId: input.turnId,
        status: info.status as 'allowed' | 'allowed_warning' | 'rejected',
        ...(typeof info.resetsAt === 'number' ? { resetsAt: new Date(info.resetsAt).toISOString() } : {}),
        ...(info.rateLimitType !== undefined ? { kind: info.rateLimitType } : {}),
        ...(typeof info.utilization === 'number' ? { utilization: info.utilization } : {}),
      }
    }
    return null
  }
}

// The Claude engine through the contract: today's agent checks (archived,
// then master without a folder — after ChatService's not found), then the turn.
export function claudeEngine(h: ClaudeHeadless): HeadlessEngine {
  return {
    async *send(agent, input) {
      if (agent.archived) throw new Error('agent archived')
      const cwd = agent.folder ?? input.cwd
      if (cwd === undefined) throw new Error('master agent has no folder')
      yield* h.send(agent, cwd, input)
    },
    cancel: (turnId) => h.cancel(turnId),
    isInflight: (turnId) => h.isInflight(turnId),
    isSessionActive: (sessionId) => h.isSessionActive(sessionId),
    steer: (turnId, text) => h.steer(turnId, text),
  }
}

/** The skills an SDK turn (or a console) loads — its briefing's `has`,
 *  its skills note, a console's append: the folder's active copies when
 *  `settingSources` has `project`, the login's personal and account skills
 *  when it has `user` (`<CLAUDE_CONFIG_DIR or ~/.claude>`; the machine's
 *  login keeps its .claude.json in the home, a login of its own in its
 *  dir), without what any tier turns off — managed, the flag tier `flag`
 *  (what the launch carries), the files it reads (loads/skills.ts
 *  launchSkillNames, the one rule). [] with neither source. */
export function sdkTurnSkills(
  cwd: string,
  settingSources: readonly string[],
  configDir: string | null,
  home: string = homedir(),
  managedDir?: string,
  flag?: Record<string, unknown> | null,
): string[] {
  return launchSkillNames({
    cwd,
    sources: settingSources,
    configDir: configDir ?? join(home, '.claude'),
    claudeJsonPath: configDir ? join(configDir, '.claude.json') : join(home, '.claude.json'),
    ...(managedDir !== undefined ? { managedDir } : {}),
    flag: flag ?? null,
    folderSkills: settingSources.includes('project') ? activeSkillNames(cwd) : [],
  })
}
