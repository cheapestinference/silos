// live-turns.ts — the turn token. The body of a
// bearer request is never believed about WHICH turn it comes from: the class
// of the turn is given by a token only Silos hands out.
//
// - Minted: ChatService.send mints one (128 random bits) for EVERY turn it
//   launches — Claude SDK and OpenCode alike — and exports it as SILOS_TURN
//   in the process env, the same way SILOS_SESSION_ID travels (agent-env.ts
//   agentProcessEnv; opencode/launch.ts envFor). A console gets its own when
//   TerminalService spawns it (the launcher's env FILE, sourced then removed
//   — never `tmux -e`): one path for every engine's console.
// - Registry: token → LiveTurn below. A NEW session's id is bound when its
//   chat-init is heard. Dropped when the turn ends (send's finally) and, for
//   a console, when tmux SAYS its session is gone — a probe that fails is
//   «unknown» and keeps it (stillAlive). Console entries persist in
//   <dataDir>/live-turns.json (an SDK turn never survives a restart).
// - Classification of a bearer request that ACTS (classify below): «attended»
//   is a CLASS of the token (console/chat), never a default (G2). Another
//   agent's token ⇒ 403; an unknown or absent token while anything of the
//   agent is live ⇒ 400; with nothing live ⇒ 403. Never guessed, never «the
//   only live one».
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJson } from './json-store.js'

export type TurnClass = 'chat' | 'console' | 'heartbeat' | 'wake' | 'run'
export type HeartbeatKind = 'look' | 'think' | 'round'
/** The regime a proactive heartbeat SEALED at its start: the
 *  engine's options, the judge of creations and the audit read it
 *  from HERE, never from the agent — a mode changed mid-round, or a restart,
 *  never turns a legitimate round into a cut one or back. */
export interface SealedRegime {
  tools: boolean
  perDay: number
}

/** What a caller of ChatService.send declares about the turn it launches. */
export interface TurnDeclaration {
  class: Exclude<TurnClass, 'console'>
  kind?: HeartbeatKind
  packetKeys?: string[]
  /** a proactive heartbeat's sealed regime (round, or a proactive think) */
  regime?: SealedRegime
  automationId?: string
  /** the automation run this turn serves (classes run/heartbeat) — what a
   *  creation, proposal or message is stamped with (runOfTurn) */
  runId?: string
  taskKey?: string
}

export interface LiveTurn {
  agentId: string
  /** the chat turn's id; a console's is its key */
  turnId: string
  unattended: boolean
  class: TurnClass
  kind?: HeartbeatKind
  packetKeys?: string[]
  regime?: SealedRegime
  automationId?: string
  runId?: string
  taskKey?: string
  sessionId?: string
  /** a console's tmux key (class 'console' only) */
  consoleKey?: string
  /** the messages an UNATTENDED turn was served — composed
   *  into its briefing or fetched by its GET mid-turn. Marked `read` only
   *  when the turn ends WITH output (messageReadsAtEnd) — never at serving */
  servedMessages?: string[]
  /** ISO, when the token was minted */
  at: string
}

/** The classes where the owner is in front by definition. */
const ATTENDED: ReadonlySet<TurnClass> = new Set(['chat', 'console'])

/** The header that carries the turn on a request without a body (DELETE). */
export const TURN_HEADER = 'x-silos-turn'

export const TURN_REQUIRED_LIVE = 'a turn of yours is running: say which turn this is — send "turn": "$SILOS_TURN"'
export const TURN_REQUIRED_NONE_LIVE = 'no conversation of yours is live — this must come from inside a turn (send "turn": "$SILOS_TURN")'
export const TURN_OF_ANOTHER = 'that turn is not yours — send your own "turn": "$SILOS_TURN"'

export type Classified = { ok: true; turn: LiveTurn } | { ok: false; code: 400 | 403; error: string }

const TOKEN_RE = /^[0-9a-f]{32}$/

/** What a probe of a console's tmux says (TerminalService.consoleState).
 *  `unknown`: the probe itself failed (a timeout, a spawn error, any answer
 *  that is not tmux's own «no such session / no server») — the console may
 *  well be running, so its token is KEPT; only `gone` ends it. */
export type ConsoleLiveness = 'alive' | 'gone' | 'unknown'

export interface LiveTurnsOptions {
  /** <dataDir>/live-turns.json — absent: consoles live in memory only (tests) */
  file?: string
  /** whether a console's tmux still runs — absent: every console counts as alive */
  consoleAlive?: (key: string) => ConsoleLiveness
  now?: () => Date
  /** told once per turn minted and per console spawned (instance-usage.ts
   *  counts them); `attended` as the entry records it */
  onTurn?: (attended: boolean) => void
}

// The trace of a console turn taken away on tmux's word — always written
// (the server's log, server-log.ts: evidence exists only if it was being
// written when it happened; once every console went mute and nothing said
// when or why). Never the token: the console, its agent and the reason.
function retired(e: LiveTurn, why: string): void {
  console.warn(`live-turns: console ${e.consoleKey ?? '?'} of ${e.agentId} lost its turn — ${why}; it cannot write to Silos until it is reopened`)
}

export class LiveTurns {
  private turns = new Map<string, LiveTurn>()
  /** console tokens staged for a spawn that has not answered yet: between the
   *  old console's end and the new one's birth tmux truthfully says «no such
   *  session», and that must not collect the token the new claude is born with */
  private staging = new Set<string>()
  private consoleAlive: ((key: string) => ConsoleLiveness) | null
  private now: () => Date

  constructor(private opts: LiveTurnsOptions = {}) {
    this.consoleAlive = opts.consoleAlive ?? null
    this.now = opts.now ?? (() => new Date())
    this.load()
  }

  /** wired after construction when the console service is built later */
  setConsoleAlive(fn: (key: string) => ConsoleLiveness): void {
    this.consoleAlive = fn
  }

  // ---- minting ---------------------------------------------------------

  /** A turn ChatService launches: its token. `unattended` is the send's
   *  explicit flag, or the class's own nature. */
  mintTurn(input: { agentId: string; turnId: string; turn: TurnDeclaration; unattended?: boolean; sessionId?: string }): string {
    const token = newToken()
    const d = input.turn
    this.turns.set(token, {
      agentId: input.agentId,
      turnId: input.turnId,
      unattended: input.unattended === true || !ATTENDED.has(d.class),
      class: d.class,
      ...(d.kind !== undefined ? { kind: d.kind } : {}),
      ...(d.packetKeys !== undefined ? { packetKeys: [...d.packetKeys] } : {}),
      ...(d.regime !== undefined ? { regime: { tools: d.regime.tools, perDay: d.regime.perDay } } : {}),
      ...(d.automationId !== undefined ? { automationId: d.automationId } : {}),
      ...(d.runId !== undefined ? { runId: d.runId } : {}),
      ...(d.taskKey !== undefined ? { taskKey: d.taskKey } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      at: this.now().toISOString(),
    })
    this.told(input.unattended === true || !ATTENDED.has(d.class))
    return token
  }

  private told(unattended: boolean): void {
    try {
      this.opts.onTurn?.(!unattended)
    } catch {
      /* counting never breaks a turn */
    }
  }

  /** A console TerminalService is about to spawn: its token, persisted
   *  BESIDE any earlier one of the key — nothing is dropped yet. The spawn
   *  then either commits it (commitConsole) or discards it (drop): a relaunch
   *  that fails (tmux refuses a `duplicate session` over a console that was
   *  running after all) leaves the running claude's token where it was. */
  stageConsole(agentId: string, key: string): string {
    const token = newToken()
    this.turns.set(token, { agentId, turnId: key, unattended: false, class: 'console', consoleKey: key, sessionId: key, at: this.now().toISOString() })
    this.staging.add(token)
    this.save()
    return token
  }

  /** The spawn took: `token` is now the key's ONLY console token — the
   *  earlier claude under the key is gone (tmux said so before the spawn). */
  commitConsole(key: string, token: string): void {
    if (this.staging.delete(token)) this.told(false)
    let changed = false
    for (const [t, e] of this.turns)
      if (e.class === 'console' && e.consoleKey === key && t !== token) {
        this.turns.delete(t)
        changed = true
      }
    if (changed) this.save()
  }

  /** stage + commit in one step (a console known to be spawned) */
  mintConsole(agentId: string, key: string): string {
    const token = this.stageConsole(agentId, key)
    this.commitConsole(key, token)
    return token
  }

  /** chat-init of the turn: the session it is writing (a NEW session has no
   *  id before it). */
  bindSession(token: string, sessionId: string): void {
    const e = this.turns.get(token)
    if (e && e.class !== 'console') e.sessionId = sessionId
  }

  /** note the messages this turn was served (unattended classes mark
   *  them at the end, with output). Unknown token: nothing. */
  noteServed(token: string, ids: readonly string[]): void {
    const e = this.findLive(token)
    if (!e || ids.length === 0) return
    e.servedMessages = [...new Set([...(e.servedMessages ?? []), ...ids])]
  }

  /** the turn ended (send's finally) */
  drop(token: string): void {
    const e = this.turns.get(token)
    if (!e) return
    this.turns.delete(token)
    this.staging.delete(token)
    if (e.class === 'console') this.save()
  }

  /** the console's tmux died — tmux SAID so (a kill it confirmed, or «no
   *  such session / no server»); never on a probe that failed */
  dropConsole(key: string): void {
    let changed = false
    for (const [t, e] of this.turns)
      if (e.class === 'console' && e.consoleKey === key && !this.staging.has(t)) {
        this.turns.delete(t)
        changed = true
        retired(e, 'its tmux session ended')
      }
    if (changed) this.save()
  }

  /** a listing of the live consoles: every console entry not in it is gone */
  pruneConsoles(alive: ReadonlySet<string>): void {
    let changed = false
    for (const [t, e] of this.turns)
      if (e.class === 'console' && !alive.has(e.consoleKey ?? '') && !this.staging.has(t)) {
        this.turns.delete(t)
        changed = true
        retired(e, `tmux's listing (${alive.size} console${alive.size === 1 ? '' : 's'}) does not name it`)
      }
    if (changed) this.save()
  }

  // ---- reading ---------------------------------------------------------

  get(token: string): LiveTurn | null {
    const e = this.findLive(token)
    return e ? { ...e } : null
  }

  /** the agent a console was minted for (persisted across restarts), or null */
  consoleAgentOf(key: string): string | null {
    for (const e of this.turns.values()) if (e.class === 'console' && e.consoleKey === key) return e.agentId
    return null
  }

  /** everything of the agent that is live right now (turns and consoles) */
  liveOf(agentId: string): LiveTurn[] {
    const out: LiveTurn[] = []
    for (const [t, e] of [...this.turns]) {
      if (e.agentId !== agentId) continue
      if (!this.stillAlive(t, e)) continue
      out.push({ ...e })
    }
    return out
  }

  /** the class of a bearer request that acts, from the token it sent. */
  classify(agentId: string, token: unknown): Classified {
    const e = typeof token === 'string' ? this.findLive(token) : null
    if (e) {
      if (e.agentId !== agentId) return { ok: false, code: 403, error: TURN_OF_ANOTHER }
      return { ok: true, turn: { ...e } }
    }
    // unknown or absent: never guessed — what is live only picks the words
    return this.liveOf(agentId).length > 0 ? { ok: false, code: 400, error: TURN_REQUIRED_LIVE } : { ok: false, code: 403, error: TURN_REQUIRED_NONE_LIVE }
  }

  // ---- internals -------------------------------------------------------

  // constant-time against every live token (a handful): the lookup never
  // tells a guesser how close it came
  private findLive(token: string): LiveTurn | null {
    if (!TOKEN_RE.test(token)) return null
    const probe = Buffer.from(token)
    let hit: [string, LiveTurn] | null = null
    for (const [t, e] of this.turns) {
      const b = Buffer.from(t)
      if (b.length === probe.length && timingSafeEqual(b, probe)) hit = [t, e]
    }
    if (!hit) return null
    return this.stillAlive(hit[0], hit[1]) ? hit[1] : null
  }

  // A console entry whose tmux is GONE — tmux's own statement — is dropped
  // where it is found. A probe that fails (timeout, spawn error, an answer
  // that is not tmux's) is `unknown`: the token is kept and still classifies
  // (one 5 s timeout used to kill a live console's token for good).
  // A truly dead console whose probes keep failing is collected by the next
  // DEFINITE answer: any later probe of it (every classify/liveOf asks
  // again) or any successful listing (pruneConsoles — the sleep sweep lists
  // every 10 min, the OpenCode registrar every 5 s while consoles run).
  private stillAlive(token: string, e: LiveTurn): boolean {
    if (e.class !== 'console' || !this.consoleAlive) return true
    if (this.staging.has(token)) return true // its console is being born: «no such session» is true and means nothing yet
    let state: ConsoleLiveness
    try {
      state = this.consoleAlive(e.consoleKey ?? '')
    } catch {
      state = 'unknown'
    }
    if (state !== 'gone') return true
    this.turns.delete(token)
    retired(e, 'tmux said its session is gone')
    this.save()
    return false
  }

  private load(): void {
    const file = this.opts.file
    if (!file) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return
    }
    const list =
      typeof raw === 'object' && raw !== null && Array.isArray((raw as { consoles?: unknown }).consoles) ? (raw as { consoles: unknown[] }).consoles : []
    for (const c of list) {
      if (typeof c !== 'object' || c === null) continue
      const o = c as Record<string, unknown>
      if (typeof o.token !== 'string' || !TOKEN_RE.test(o.token)) continue
      if (typeof o.agentId !== 'string' || typeof o.key !== 'string' || o.key === '') continue
      this.turns.set(o.token, {
        agentId: o.agentId,
        turnId: o.key,
        unattended: false,
        class: 'console',
        consoleKey: o.key,
        sessionId: o.key,
        at: typeof o.at === 'string' ? o.at : this.now().toISOString(),
      })
    }
  }

  // only consoles are written: an SDK turn never survives a restart
  private save(): void {
    const file = this.opts.file
    if (!file) return
    const consoles = [...this.turns].filter(([, e]) => e.class === 'console').map(([token, e]) => ({ token, agentId: e.agentId, key: e.consoleKey, at: e.at }))
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      atomicWriteJson(file, { consoles }, { mode: 0o600 })
      chmodSync(file, 0o600)
    } catch (err) {
      console.warn('live-turns: could not persist the console turns:', err instanceof Error ? err.message : err)
    }
  }
}

/** The run a turn's acts are stamped with (its `run`): the
 *  automation run it serves (heartbeat, run), else its own turn id (a wake,
 *  a chat, a console's key) — the same id the end-of-turn audit looks up. */
export function runOfTurn(t: Pick<LiveTurn, 'runId' | 'turnId'>): string {
  return t.runId ?? t.turnId
}

function newToken(): string {
  return randomBytes(16).toString('hex')
}

/** The turn a bearer request names: `turn` in its JSON body, or — for a
 *  request without a body of Silos' own (a DELETE; a signed call, whose body
 *  is the service's: `headerOnly`) — the x-silos-turn header. */
export function turnOfRequest(method: string, body: unknown, headers: Record<string, unknown>, headerOnly = false): unknown {
  if (headerOnly || method.toUpperCase() === 'DELETE') {
    const h = headers[TURN_HEADER]
    return typeof h === 'string' ? h.trim() : undefined
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) return (body as Record<string, unknown>).turn
  return undefined
}
