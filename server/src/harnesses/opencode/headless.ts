// harnesses/opencode/headless — Silos' CHAT engine for an OpenCode agent:
// typed turns from the composer and the resident's automation runs, as one
// `opencode run --format json` child per turn. ChatService.send dispatches
// here by harness (the Claude path is untouched) and re-emits every event.
//
// The child:
//   argv  [binary, run, --format, json, --dir, cwd, (--session id [--fork]),
//         (--model provider/model), (--auto | --agent plan),
//         --thinking]. Never --print-logs (logs on stderr would bury the
//         error line). --thinking: OpenCode 1.14.22 only emits `reasoning`
//         events with it (run.ts: `w.type==="reasoning"&&…&&D.thinking`).
//   stdin the prompt (run.ts appends stdin when it is not a TTY; never argv:
//         argv limits and the process listing).
//   env   the shared assembly (assemble.ts — the SAME config, context file,
//         role file, fence and DB the agent's console gets) through
//         launch.ts envFor, over cleanEnv(); SILOS_SESSION_ID only on a
//         resume. Secrets ride env only — never argv, never a log line.
//
// Session id: OpenCode mints it; the first stdout event carrying `sessionID`
// becomes chat-init. The plugin (loaded through OPENCODE_CONFIG_CONTENT)
// writes the birth marker inside the child. A session born here (new or
// fork) must ALSO get a native record — a startup marker without one reads
// as a nested run, hidden from the sidebar (session-owner.ts nestedBirthOf).
// But stdout is not trusted: plugins and config the agent controls can write
// to it before OpenCode's first event, and a native record outranks
// everything in session-owner.ts. So the announced id must be an OpenCode id
// (a Claude uuid → chat-error, kill); on an append resume it must be the
// resumed id (else chat-error, kill); and it is registered only once the
// agent's OWN database holds it and no other DB does (reader agentOfDb /
// isContested — the registrar's criteria). Not in the DB yet → it waits in
// `pending` and sealPending() (the reader's 'created' event, and each turn's
// end) registers it once the DB has it. Another agent's id → never.
//
// Permissions (Task 8 finding): `opencode run` without --auto
// auto-REJECTS every permission ask the moment it is raised — nothing
// reaches the plugin's bridge. So an agent whose effective mode is
// bypassPermissions runs with --auto (the fence's deny rules still bind —
// Claude's bypass + deny, same shape), and a binary whose `run` lacks it
// has the turn refused with one chat-error line (auto-mode.ts); any other
// mode runs without it, its asks auto-rejected by OpenCode, with one warn
// line per run in the server log. Nothing is invented into the chat. plan
// runs as `--agent plan` (no edits); acceptEdits leaves OpenCode's defaults
// and the operator's own rules in force — any ask that does arise under
// `run` is auto-rejected (auto-mode.ts).
//
// Termination: exit 0 → chat-done success (cost summed over step_finish,
// null when 0); an `error` event → chat-error (terminal: OpenCode exits 0
// after a session error, no chat-done follows); non-zero exit without one →
// chat-error with the last stderr line. A rate-limit text in either also
// emits chat-ratelimit rejected first. Once a turn has errored, nothing more
// is emitted. cancel → SIGTERM, SIGKILL after 5 s → chat-done cancelled. The
// child leads its own process group (detached) and signals go to the group,
// so tools it spawned die with it.
//
// Bounded: stdout is split by hand — a line over 8 MB is chat-error and a
// kill; when the event queue reaches HIGH_WATER, splitting stops and stdout
// is paused until the consumer drains it below LOW_WATER; of stderr only the
// last line (4 KB) is kept. The session lock is released when the child is
// dead, not when the consumer stops reading.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mungePath, type AgentRegistry } from '../../agent-registry.js'
import type { AgentStateStore } from '../../agent-state.js'
import type { ChatService } from '../../chat-service.js'
import type { ChatTurnHooks, HeadlessEngine } from '../contract.js'
import type { ChatEvent } from '../../chat-types.js'
import { resolveCascade, validateTurnOverrides } from '../../cockpit.js'
import type { ConversationPrefsStore } from '../../conversation-prefs.js'
import { cleanEnv } from '../../env.js'
import type { LineageStore } from '../../lineage.js'
import type { NativeStore } from '../../native-store.js'
import type { FenceOverlay } from '../../territory.js'
import type { ResolvedProvider } from '../../providers-store.js'
import type { Agent } from '../../types.js'
import type { VaultStore } from '../../vault-store.js'
import { harnessForId } from '../registry.js'
import { assembleOpencode } from './assemble.js'
import { modeArgs } from './auto-mode.js'
import { envFor } from './launch.js'
import type { MessageReads } from '../../message-reads.js'

const RATE_LIMIT_RE = /rate limit|429|quota|too many requests/i
const KILL_GRACE_MS = 5000
// after the child exits, how long its stdout may stay open (a grandchild
// that escaped the group) before Silos stops waiting for it
const DRAIN_MS = 500
export const MAX_LINE_BYTES = 8 * 1024 * 1024
const STDERR_TAIL = 4096
export const HIGH_WATER = 1000
export const LOW_WATER = 200
// an id announced but not yet in the agent's DB waits this long for it
const PENDING_TTL_MS = 10 * 60_000

export interface OpenCodeHeadlessDeps {
  binary: string
  registry: AgentRegistry
  agentState: AgentStateStore
  native: NativeStore
  dataDir: string
  home: string
  silosApi: string
  /** reader.ts agentOfDb — the agent whose own opencode.db holds the session. */
  agentOfDb: (sessionId: string) => string | null
  /** reader.ts isContested — the id is in more than one DB. */
  isContested?: (sessionId: string) => boolean
  convPrefs?: ConversationPrefsStore
  lineage?: LineageStore
  vault?: VaultStore
  territory?: { fenceFor(agentId: string): FenceOverlay | null }
  /** The turn's provider through the Claude engine's cascade
   *  (ChatService.providerForTurn: the pin — turn › conversation — else the
   *  agent's own, with its declared fallback applied). Absent: none. */
  providerFor?: (agent: Agent, pinnedId: string | undefined, turnId?: string) => ResolvedProvider | null
  /** The agent's role prompt (ChatService.systemAppendFor) — the console's. */
  systemAppendFor?: (agentId: string, has: readonly string[]) => string | null
  /** The inbox's serving (message-reads.ts). */
  messageReads?: MessageReads
  /** what Silos keeps for an agent's launches, in overlay order
   *  (ChatDeps.loadsCarried) */
  loadsCarried?: (agentId: string, cwd?: string) => unknown[]
  /** Test hook: the event queue's depth after every push. */
  onQueueDepth?: (depth: number) => void
  /** SIGTERM → SIGKILL grace (default KILL_GRACE_MS); tests shorten it. */
  killGraceMs?: number
}

/** What the composition root hands the OpenCode headless factory (index.ts):
 *  the runtime pieces ChatDeps doesn't carry. The factory stores the engine it
 *  builds on `engine`, so the root reaches sealPending() (the reader's 'created'). */
export interface OpenCodeHeadlessOptions {
  binary: string
  home: string
  silosApi: string
  agentOfDb: (sessionId: string) => string | null
  isContested?: (sessionId: string) => boolean
  engine?: OpenCodeHeadless
}

interface Running {
  child: ChildProcess
  cancelled: boolean
  killTimer?: NodeJS.Timeout
}
interface Pending {
  folder: string
  agentId: string
  forkOf: string | null
  at: number
}

type SendInput = Parameters<ChatService['send']>[0]

export class OpenCodeHeadless {
  private running = new Map<string, Running>()
  private activeSessions = new Set<string>()
  private pending = new Map<string, Pending>()
  constructor(private deps: OpenCodeHeadlessDeps) {}

  async *send(input: SendInput): AsyncGenerator<ChatEvent> {
    const agent = this.deps.registry.get(input.agentId)
    if (!agent) throw new Error('agent not found')
    if (agent.archived) throw new Error('agent archived')
    const cwd = agent.folder ?? input.cwd
    if (cwd === undefined) throw new Error('master agent has no folder')
    const resume = input.resume
    if (resume) {
      if (this.activeSessions.has(resume.sessionId)) throw new Error('a turn is already in progress for this session')
      this.activeSessions.add(resume.sessionId)
    }
    const folder = mungePath(cwd)
    const turnId = input.turnId
    let sessionId: string | null = null
    // the locks go when the child is dead (close), or here if none started
    let spawned = false
    const release = (): void => {
      if (resume) this.activeSessions.delete(resume.sessionId)
      if (sessionId !== null) this.activeSessions.delete(sessionId)
    }
    try {
      if (!existsSync(cwd)) {
        yield { ev: 'chat-error', turnId, error: `agent folder does not exist: ${cwd} — did it get moved or renamed? Update it in the agent settings.` }
        return
      }
      // the cockpit cascade, as the Claude engine resolves it: an unattended
      // run ignores the conversation level
      const turnOverrides = input.overrides !== undefined ? validateTurnOverrides(input.overrides) : undefined
      const conv = !input.unattended && resume && this.deps.convPrefs ? this.deps.convPrefs.get(folder, resume.sessionId) : null
      const cockpit = resolveCascade({ ...(agent.model ? { model: agent.model } : {}) }, conv, turnOverrides)
      // the provider, by the same cascade as a Claude turn (the turn's pin,
      // else the conversation's, else the agent's own — fallback applied);
      // assemble turns it into config + SILOS_PROVIDER_KEY (launch.ts
      // providerLaunch), and the model into a provider/model id (a Claude
      // alias like `opus` with no provider of Silos's names nothing: the
      // operator's default stands)
      const provider = this.deps.providerFor?.(agent, turnOverrides?.provider ?? conv?.provider, turnId) ?? null
      const bypass = cockpit.permissionMode === 'bypassPermissions'
      if (!bypass) console.warn(`opencode run: permission mode ${cockpit.permissionMode} — asks are auto-rejected by opencode in headless mode`)
      // bypass → `--auto`, plan → `--agent plan`; acceptEdits → nothing:
      // OpenCode's defaults and the operator's own rules stand — auto-mode.ts
      const modeFlags = modeArgs(cockpit.permissionMode)

      const assembled = assembleOpencode(
        {
          agents: () => this.deps.registry.list(),
          agentState: this.deps.agentState,
          dataDir: this.deps.dataDir,
          home: this.deps.home,
          silosApi: this.deps.silosApi,
          ...(this.deps.vault ? { vault: this.deps.vault } : {}),
          ...(this.deps.territory ? { territory: this.deps.territory } : {}),
          ...(this.deps.systemAppendFor ? { systemAppendFor: this.deps.systemAppendFor } : {}),
          // served by the turn token's class: a chat marks, an unattended turn
          // notes it and marks at its end with output (message-reads.ts)
          ...(this.deps.messageReads ? { inboxFor: (id: string) => this.deps.messageReads!.inboxFor(id, { turn: input.turnToken ?? null }) } : {}),
        },
        agent,
        cwd,
        {
          provider,
          model: cockpit.model ?? null,
          ...(input.turn?.class === 'heartbeat' ? { heartbeat: input.turn.regime?.tools === true ? ('tools' as const) : true } : {}),
          // what Silos keeps for this launch's places (loads-scopes.ts): the
          // folder's, then the agent's — every turn: chat, run, wake, round
          carried: this.deps.loadsCarried?.(agent.id, cwd) ?? [],
        },
      )
      const model = assembled.model
      const env = {
        ...inheritedEnv(),
        ...envFor({
          agentId: agent.id,
          agentDb: assembled.agentDb,
          ...(resume ? { sessionId: resume.sessionId } : {}),
          ...(input.turnToken ? { turn: input.turnToken } : {}),
          silosApi: assembled.silosApi,
          agentStateEnv: assembled.agentEnv,
          configContent: assembled.configContent,
          fenced: assembled.fence !== null,
          ...(assembled.providerKey !== undefined ? { providerKey: assembled.providerKey } : {}),
          asksReplies: assembled.asksReplies,
        }),
      }
      const args = [
        'run',
        '--format',
        'json',
        '--dir',
        cwd,
        ...(resume ? ['--session', resume.sessionId] : []),
        ...(resume?.mode === 'fork' ? ['--fork'] : []),
        ...(model ? ['--model', model] : []),
        ...modeFlags,
        '--thinking',
      ]

      const child = spawn(this.deps.binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      spawned = true
      const run: Running = { child, cancelled: false }
      this.running.set(turnId, run)

      // events → queue; the generator drains it
      const queue: ChatEvent[] = []
      let wake: (() => void) | null = null
      let done = false
      const push = (ev: ChatEvent): void => {
        queue.push(ev)
        this.deps.onQueueDepth?.(queue.length)
        wake?.()
      }

      let cost = 0
      let errored = false
      const errorOut = (message: string): void => {
        if (errored) return
        errored = true
        if (RATE_LIMIT_RE.test(message)) push({ ev: 'chat-ratelimit', turnId, status: 'rejected' })
        push({ ev: 'chat-error', turnId, error: message })
      }
      const fail = (message: string): void => {
        errorOut(message)
        this.kill(run)
      }

      const onLine = (line: string): void => {
        if (errored) return
        const obj = parseLine(line)
        if (!obj) return
        if (sessionId === null && typeof obj.sessionID === 'string' && obj.sessionID !== '') {
          const id = obj.sessionID
          if (harnessForId(id) !== 'opencode') return fail(`unexpected session id from opencode run: ${id.slice(0, 64)}`)
          if (resume?.mode === 'append' && id !== resume.sessionId)
            return fail(`unexpected session id from opencode run: ${id.slice(0, 64)} (resumed ${resume.sessionId})`)
          if (resume?.mode === 'fork' && id === resume.sessionId) return fail(`unexpected session id from opencode run: a fork announced its source ${id}`)
          sessionId = id
          this.activeSessions.add(id)
          if (!resume || resume.mode === 'fork') this.claimBirth(id, { folder, agentId: agent.id, forkOf: resume?.sessionId ?? null, at: Date.now() })
          push({ ev: 'chat-init', turnId, folder, sessionId: id })
        }
        const ev = this.toEvent(obj, turnId)
        if (ev === null) return
        if (ev.ev === 'chat-error') errorOut(ev.error)
        else {
          if (ev.ev === 'chat-usage') cost += stepCost(obj)
          push(ev)
        }
      }

      // stdout: split by hand, bounded per line, paused at HIGH_WATER
      let buf: Buffer = Buffer.alloc(0)
      let stdoutEnded = false
      let paused = false
      let exited: { code: number | null } | null = null
      let closed = false
      const pump = (): void => {
        while (!errored && queue.length < HIGH_WATER) {
          const nl = buf.indexOf(0x0a)
          if (nl === -1) break
          if (nl > MAX_LINE_BYTES) return fail('output line too long')
          const line = buf.subarray(0, nl).toString('utf8')
          buf = buf.subarray(nl + 1)
          onLine(line)
        }
        if (!errored && buf.indexOf(0x0a) === -1 && buf.length > MAX_LINE_BYTES) return fail('output line too long')
        if (stdoutEnded && !errored && buf.length > 0 && buf.indexOf(0x0a) === -1 && queue.length < HIGH_WATER) {
          const line = buf.toString('utf8')
          buf = Buffer.alloc(0)
          onLine(line)
        }
        if (errored) buf = Buffer.alloc(0)
        const wantPause = queue.length >= HIGH_WATER
        if (wantPause && !paused) {
          paused = true
          child.stdout!.pause()
        } else if (!wantPause && paused && queue.length < LOW_WATER) {
          paused = false
          child.stdout!.resume()
        }
        finalize()
      }
      child.stdout!.on('data', (chunk: Buffer) => {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
        pump()
      })
      const endStdout = (): void => {
        stdoutEnded = true
        pump()
      }
      child.stdout!.on('end', endStdout)
      child.stdout!.on('close', endStdout)

      let stderrTail = ''
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2 * STDERR_TAIL)
      })
      const lastStderrLine = (): string | undefined => {
        const lines = stderrTail
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
        return lines.at(-1)?.slice(-STDERR_TAIL)
      }

      let spawnError: Error | null = null
      // the end, once the child is dead AND every buffered line is parsed
      const finalize = (): void => {
        if (closed || exited === null || !stdoutEnded) return
        if (!errored && buf.length > 0) return
        closed = true
        if (run.killTimer) clearTimeout(run.killTimer)
        this.running.delete(turnId)
        release()
        if (!errored) {
          if (run.cancelled) push({ ev: 'chat-done', turnId, subtype: 'cancelled', costUsd: null })
          else if (spawnError) errorOut(spawnError.message)
          else if (exited.code === 0) push({ ev: 'chat-done', turnId, subtype: 'success', costUsd: cost > 0 ? cost : null })
          else errorOut(lastStderrLine() ?? `opencode run exited with code ${exited.code}`)
        }
        if (sessionId !== null) this.sealPending()
        done = true
        wake?.()
      }
      child.on('error', (err) => {
        spawnError = err
        if (child.pid === undefined) {
          exited = { code: null }
          stdoutEnded = true
          finalize()
        }
      })
      // stdout may outlive the child: once it is gone, wait briefly, then stop waiting
      child.on('exit', () => {
        setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }, DRAIN_MS).unref()
      })
      child.on('close', (code) => {
        exited = { code }
        stdoutEnded = true
        pump()
      })

      child.stdin!.on('error', () => {
        /* the child exited before reading it all: its exit says why */
      })
      child.stdin!.end(input.text)

      try {
        for (;;) {
          const ev = queue.shift()
          if (ev) {
            if (paused && queue.length < LOW_WATER) pump()
            yield ev
            continue
          }
          if (done) break
          if (paused) {
            pump()
            continue
          }
          await new Promise<void>((r) => {
            wake = r
          })
          wake = null
        }
      } finally {
        // a consumer that stops early must not leave the turn running; its
        // lock goes when the child is dead (finalize)
        if (!closed) {
          this.kill(run)
          if (paused) {
            paused = false
            child.stdout!.resume()
          }
          errored = true // nothing is read for it any more
        }
      }
    } finally {
      if (!spawned) release()
    }
  }

  async cancel(turnId: string): Promise<boolean> {
    const run = this.running.get(turnId)
    if (!run) return false
    run.cancelled = true
    this.kill(run)
    return true
  }

  isInflight(turnId: string): boolean {
    return this.running.has(turnId)
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  /** Registers the announced ids whose agent's own DB now holds them; drops
   *  another agent's, contested ones and expired waits. Returns how many it sealed. */
  sealPending(now = Date.now()): number {
    let sealed = 0
    for (const [id, p] of this.pending) {
      const verdict = this.verdict(id, p.agentId)
      if (verdict === 'wait' && now - p.at < PENDING_TTL_MS) continue
      this.pending.delete(id)
      if (verdict === 'seal') {
        this.seal(id, p)
        sealed++
      } else if (verdict !== 'wait') console.warn(`opencode run: not registering ${id} for ${p.agentId}: ${verdict}`)
    }
    return sealed
  }

  private claimBirth(id: string, p: Pending): void {
    const verdict = this.verdict(id, p.agentId)
    if (verdict === 'seal') this.seal(id, p)
    else if (verdict === 'wait') this.pending.set(id, p)
    else console.warn(`opencode run: not registering ${id} for ${p.agentId}: ${verdict}`)
  }

  private verdict(id: string, agentId: string): 'seal' | 'wait' | string {
    if (this.deps.isContested?.(id)) return 'the session is in more than one database'
    const inDb = this.deps.agentOfDb(id)
    if (inDb === null) return 'wait'
    return inDb === agentId ? 'seal' : `the session is in ${inDb}'s database`
  }

  // a session born HERE (new, or a fork) and proven the agent's: native to
  // it; a fork also keeps its lineage and inherits the source's conversation
  // prefs (ChatService does the same for Claude)
  private seal(id: string, p: Pending): void {
    if (this.deps.native.get(p.folder, id)) return
    this.deps.native.register(p.folder, id, { agentId: p.agentId, createdAt: new Date(p.at).toISOString() })
    if (p.forkOf !== null) {
      this.deps.lineage?.record(`${p.folder}/${id}`, `${p.folder}/${p.forkOf}`)
      this.deps.convPrefs?.copy(p.folder, p.forkOf, p.folder, id)
    }
  }

  // the whole process group (detached: the child leads it)
  private kill(run: Running): void {
    if (run.killTimer) return
    signal(run.child, 'SIGTERM')
    run.killTimer = setTimeout(() => {
      signal(run.child, 'SIGKILL')
    }, this.deps.killGraceMs ?? KILL_GRACE_MS)
    run.killTimer.unref()
  }

  // one `opencode run --format json` line → a ChatEvent (or nothing)
  private toEvent(obj: RunLine, turnId: string): ChatEvent | null {
    const part = (obj.part ?? {}) as Record<string, unknown>
    switch (obj.type) {
      case 'text':
        return typeof part.text === 'string' ? { ev: 'chat-delta', turnId, text: part.text } : null
      case 'reasoning':
        return typeof part.text === 'string' ? { ev: 'chat-thinking', turnId, text: part.text } : null
      case 'tool_use': {
        const state = part.state as { input?: unknown } | undefined
        // the first 120 chars of the input, as the Claude engine sends
        const toolInput = state?.input !== undefined ? JSON.stringify(state.input).slice(0, 120) : undefined
        return { ev: 'chat-tool', turnId, name: typeof part.tool === 'string' ? part.tool : '?', ...(toolInput !== undefined ? { input: toolInput } : {}) }
      }
      case 'step_finish': {
        const t = (part.tokens ?? {}) as { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown } }
        return { ev: 'chat-usage', turnId, outputTokens: num(t.output) + num(t.reasoning), contextTokens: num(t.input) + num(t.cache?.read) }
      }
      case 'error':
        return { ev: 'chat-error', turnId, error: errorMessage(obj) }
      default:
        return null
    }
  }
}

type RunLine = { type: string; sessionID?: unknown; part?: unknown; error?: unknown }

function parseLine(line: string): RunLine | null {
  const s = line.trim()
  if (!s.startsWith('{')) return null
  try {
    const obj = JSON.parse(s) as unknown
    return obj !== null && typeof obj === 'object' && typeof (obj as { type?: unknown }).type === 'string' ? (obj as RunLine) : null
  } catch {
    return null
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function stepCost(obj: RunLine): number {
  return num((obj.part as { cost?: unknown } | undefined)?.cost)
}

// OpenCode 1.14.22 writes `{type:'error', error: <session error>}` (a
// NamedError: name + data.message); other parsers read
// `part.error.message` — both are read
function errorMessage(obj: RunLine): string {
  const err = (obj.error ?? (obj.part as { error?: unknown } | undefined)?.error) as
    { name?: unknown; message?: unknown; data?: { message?: unknown } } | undefined
  if (err && typeof err === 'object') {
    if (typeof err.data?.message === 'string') return err.data.message
    if (typeof err.message === 'string') return err.message
    if (typeof err.name === 'string') return err.name
  }
  return JSON.stringify(obj.part ?? obj)
}

// the server's env minus Claude's (cleanEnv) and minus any inherited
// OPENCODE_*: the config Silos assembles (and the fence in it) must be the
// only one the child sees
function inheritedEnv(): Record<string, string> {
  const env = cleanEnv()
  for (const k of Object.keys(env)) if (k.startsWith('OPENCODE_')) delete env[k]
  return env
}

function signal(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, sig)
  } catch {
    try {
      child.kill(sig)
    } catch {
      /* already gone */
    }
  }
}

// The OpenCode engine through the contract: each event the turn yields is
// emitted with the agent's id first (the resident listens to 'chat-event'),
// then yielded — ChatService's long-standing sendOpencode loop.
export function opencodeEngine(h: OpenCodeHeadless, hooks: Pick<ChatTurnHooks, 'emit'>): HeadlessEngine {
  return {
    async *send(agent, input) {
      for await (const ev of h.send(input)) {
        hooks.emit(agent.id, ev)
        yield ev
      }
    },
    cancel: (turnId) => h.cancel(turnId),
    isInflight: (turnId) => h.isInflight(turnId),
    isSessionActive: (sessionId) => h.isSessionActive(sessionId),
  }
}
