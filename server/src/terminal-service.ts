// terminal-service.ts — real PTYs (bash/$SHELL) opened by the server in an
// active registered agent's folder or the cwd of a session already seen by
// the index — NEVER an arbitrary path (see validateCwd). A maximum of
// MAX_PTYS concurrent PTYs per process; each one is destroyed when killed
// by hand (DELETE /api/terminals/:id or a WS close with no reconnection)
// or after IDLE_MS with no WS client attached (see attach/detach — the
// client counter decides whether a terminal counts as idle; see the note
// below on HOW that idle state is detected reliably).
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import type { AgentRegistry } from './agent-registry.js'
import type { SessionIndex } from './session-index.js'
import { cleanEnv, isNeverInherited } from './env.js'
import { devRunVars } from './inherited-env.js'
import { startPaletteResponder } from './console-palette.js'
import type { FenceOverlay } from './territory.js'
import type { ConsoleDialog, HarnessId } from './harnesses/contract.js'
import { fallbackHarness, findHarness } from './harnesses/registry.js'
import { ConsoleDialogError } from './console-dialog.js'
import { ClaudeHolders, CLAUDE_SESSIONS_DIR, describeHolders, type SessionHolder } from './harnesses/claude-code/holders.js'
import { CLAUDE_CONSOLE_ENV, defaultConsoleCommand, type ConsoleCommandOpts } from './harnesses/claude-code/console.js'
import { defaultLoginCommand, loginEnv, type LoginCommand } from './harnesses/claude-code/login.js'
import type { ConsoleLiveness, LiveTurns } from './live-turns.js'

// Every tmux call goes through here: ASYNC and bounded. The server is one
// event loop that also relays the owner's live consoles, so a synchronous
// fork (spawnSync — 20–200 ms each on a loaded machine) froze every
// terminal for its length (perf: scroll reads, listings and reattach
// together held the loop ~2 s a minute). And tmux can stall on Silos
// itself: our own attach client's pty is drained by this same loop (once
// a sync `send-keys /model …` hung 14 min and took the public tunnel with
// it). A stalled call is killed (SIGKILL) at the bound and rejects; callers
// already treat a failed tmux call as "not there / not done" — or, for a
// liveness probe, as «unknown» (tmuxSaysGone).
// The guard of the class: server/test/no-sync-spawn.test.ts.
export const TMUX_TIMEOUT_MS = 5_000

/** Options of one tmux call: the env (a new-session's) and nothing else —
 *  stdout and stderr are always captured (stderr is tmux's own words). */
export interface TmuxRunOpts {
  env?: NodeJS.ProcessEnv
}

/** One tmux call, async: resolves with stdout; rejects with an error shaped
 *  like execFileSync's (`status` = the exit code or null, `signal`,
 *  `stderr`) so tmuxSaysGone reads both the same. `timeoutMs` exported for
 *  tests (a frozen server times out fast). */
export function tmuxExec(args: string[], opts: TmuxRunOpts = {}, timeoutMs = TMUX_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'tmux',
      args,
      { ...(opts.env ? { env: opts.env } : {}), encoding: 'buffer', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error & { code?: unknown; signal?: unknown }
          reject(Object.assign(e, { status: typeof e.code === 'number' ? e.code : null, signal: e.signal ?? null, stderr }))
          return
        }
        resolve(stdout)
      },
    )
    // nothing is ever typed into a tmux command's stdin
    child.stdin?.end()
  })
}

/** How every tmux call is run — `tmux <args>` (the `-L <socket>` included),
 *  rejecting (or throwing) like tmuxExec on failure. Injectable so a test
 *  can hand every caller each outcome tmux can give (a timeout, a spawn
 *  error, «can't find session», «no server running»…). */
export type TmuxRunner = (args: string[], opts: TmuxRunOpts) => string | Buffer | Promise<string | Buffer>

/** How long a probe's or a listing's answer stands for the sync readers
 *  (knownConsoleState / knownConsoleKeys): older is «unknown», refreshed in
 *  the background. */
export const LIVENESS_FRESH_MS = 3_000

export type { ConsoleLiveness }

/** A console whose liveness could not be told (its probe failed): nothing
 *  is spawned over it and nothing of it is dropped — the caller retries. */
export class ConsoleUnknownError extends Error {
  constructor(readonly key: string) {
    super('the console could not be checked (tmux did not answer) — try again')
  }
}

// THE rule of every probe (console turn tokens once died
// while their console ran): a failed tmux call is «unknown», never «gone».
// Only tmux's OWN statement ends a console — the session is not there
// («can't find session»), no server listens on the socket («no server
// running on» = ECONNREFUSED on a stale socket file), or there is no socket
// at all («error connecting to … (No such file or directory)»). A timeout
// (status null, SIGKILL), a spawn error (no status), any other errno on the
// connect (EAGAIN, EMFILE, EACCES…) or any other stderr is not an answer.
// Verified on tmux 3.4 (has-session, list-sessions, kill-session).
export function tmuxSaysGone(err: unknown): boolean {
  const e = err as { status?: unknown; signal?: unknown; stderr?: unknown } | null
  if (!e || typeof e.status !== 'number' || e.status === 0 || e.signal) return false
  const stderr = e.stderr == null ? '' : String(e.stderr)
  return /can't find session|no server running on|error connecting to .*\(No such file or directory\)/.test(stderr)
}

const MAX_PTYS = 4
/** Bytes of console argv sent inline on `tmux new-session` (its imsg caps the
 *  whole message at 16 KB); a longer argv rides the launch file. Exported for tests. */
export const LAUNCH_ARGV_INLINE_MAX = 8 * 1024
/** The launcher of a console whose argv rides the launch file: the file
 *  removes itself on its first line and ends with `set -- <argv>`. */
export const LONG_ARGV_LAUNCHER = '. "$1"; exec "$@"'
// real-console clients (one per open tab/WebSocket), separate from the shells
const MAX_CONSOLE_CLIENTS = 8
const IDLE_MS = 30 * 60_000
// How long killConsoleAndWait waits for the pane's claude to be really
// gone. claude's shutdown (hooks, the last-prompt append, releasing its
// ~/.claude/sessions lock) takes ~20 s under load; the old 3 s cap let a
// `--resume` twin be born beside the dying one (incident: Remote
// Control conflict + the in-flight prompt lost).
const CONSOLE_EXIT_GRACE_MS = 60_000
// The same wait for a claude OUTSIDE Silos' consoles that the owner asked
// us to close (closeHoldersAndWait): its shutdown is the same claude's.
const HOLDER_EXIT_GRACE_MS = 60_000

// A resume refused because another claude still holds the conversation
// (rule 2: never a --resume twin). Typed so the console route can
// say WHO holds it and offer to close it (the trash route's own gesture).
export class ConsoleHeldError extends Error {
  constructor(
    message: string,
    readonly resumeId: string,
    readonly holders: SessionHolder[],
  ) {
    super(message)
  }
}
// A single periodic sweep, not a setTimeout per PTY. An earlier design
// (arming an idle timer per entry, canceled in attach() and re-armed in
// detach() once clients hits 0) depended entirely on the WS 'close' event
// ALWAYS arriving — with a half-open remote client (network drop with no
// clean FIN, a sleeping laptop) that server-side 'close' might NEVER
// arrive, `clients` would stay >0 forever, the idle timer would never be
// re-armed, and the PTY would live indefinitely (exhausting MAX_PTYS). A
// periodic sweep doesn't depend on any single event: it looks at the real
// state (clients===0 since when) every REAPER_INTERVAL_MS, so it's enough
// for SOME OTHER mechanism (the WS ping/pong, see server.ts) to eventually
// get `clients` down to 0 for the real idle state to be noticed — it
// doesn't need to be immediate or exact.
const REAPER_INTERVAL_MS = 60_000
// Console auto-sleep: a live claude costs ~300 MB of RAM
// and is disposable — the JSONL is the real memory and ensureConsole
// revives it with --resume on the next open. A console sleeps once nobody
// is attached AND its conversation's transcript has been still for the
// window; the mtime signal folds subagent activity while a turn is open
// (harnesses/claude-code/reader.ts), so a working claude — even detached — never sleeps.
const CONSOLE_SLEEP_MS = 24 * 60 * 60_000
const CONSOLE_SLEEP_INTERVAL_MS = 10 * 60_000

// the sleep decision, pure. lastAliveMs null = "we know nothing" — when
// in doubt, keep it. sleepMs <= 0 disables the sweep entirely.
export function shouldSleepConsole(i: { attached: number; lastAliveMs: number | null; now: number; sleepMs: number }): boolean {
  if (i.sleepMs <= 0) return false
  if (i.attached > 0) return false
  if (i.lastAliveMs === null) return false
  return i.now - i.lastAliveMs >= i.sleepMs
}

// The real console: tmux on its OWN socket (-L) so it never touches the
// owner's tmux, with deep history, mouse wheel scrolling, and no status
// bar (so it feels like a pure Claude Code console, not "a tmux session").
// `alternate-screen off`: the current `claude` runs in the alternate
// screen, where tmux keeps NO history — the wheel had nothing to scroll.
// With it off, claude's output stays in the normal screen and the wheel
// scrolls real history via tmux's copy mode.
// overridable so an e2e run gets its OWN tmux server (a test must
// never park real claudes on the production socket — it happened).
const TMUX_SOCKET = process.env.SILOS_TMUX_SOCKET ?? 'silos'
const TMUX_CONF = join(tmpdir(), 'silos-console-tmux.conf')

// what the real console's `claude` is started with — `resumeId` for an
// existing session, `sessionId` for a new conversation (never both).
export type ConsoleTheme = 'light' | 'dark'

/** Who hears a console's life (Usage's windows, usage.ts): its tmux
 *  launched for an agent, killed, or found gone on a listing. */
export interface ConsoleLife {
  launched(c: { key: string; agentId: string; cwd: string; sessionId: string; providerPick?: string }): void
  gone(key: string): void
  alive(keys: ReadonlySet<string>): void
}

/** A console Silos launched for another harness — see "console records". */
export interface ConsoleRecord {
  key: string
  agentId: string | null
  harness: HarnessId
  createdMs: number
  port?: number
  nativeId?: string
  /** The TUI HTTP server's basic-auth password (Silos sends `silos:<it>`). */
  serverPassword?: string | null
  /** The account the owner explicitly picked for a NEW console, kept until
   *  the registrar seals the session id and pins it on the conversation
   *  (harnesses/opencode/registrar.ts). */
  providerPick?: string
  /** The model the owner picked for a NEW console (the panel's pending pin),
   *  kept with providerPick until the seal pins both on the conversation. */
  modelPick?: string
}
// one source of truth for both the conf (server start) and set-option (live server)
const CONSOLE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['history-limit', '50000'],
  ['mouse', 'on'],
  ['status', 'off'],
  ['alternate-screen', 'off'],
]
// SERVER options (set -s): with `mouse on`, a selection lands in tmux's own
// buffer, not the browser's — the OS clipboard stayed empty. set-clipboard
// makes tmux emit the copy as OSC 52, and terminal-features declares that
// the attached client (xterm.js) understands it; the web client turns that
// escape into navigator.clipboard (see TerminalView's OSC handler).
const CONSOLE_SERVER_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['set-clipboard', 'on'],
  // RGB: xterm.js renders 24-bit colour, so a pane that emits it (an
  // OpenCode console, COLORTERM=truecolor) reaches the browser exact instead
  // of rounded to the 256 cube. Claude's consoles never get COLORTERM (not in
  // the server's env nor tmux's global one), so they keep drawing in 256 —
  // the cube web/src/lib/terminal-palette.ts remaps for contrast.
  ['terminal-features', 'xterm*:clipboard:RGB'],
]
// KEY BINDINGS (bind-key): the copy-mode wheel scrolls ONE row per tick
// (tmux's default is 5). The web client already sends one tick per row of
// pointer travel (WheelAccumulator in web/src/lib/console-scroll.ts), so
// with this the content follows the gesture 1:1 — a mouse notch used to
// jump and a trackpad swipe flew off. Both copy-mode
// tables, so it holds whatever mode-keys the owner's tmux defaults to.
const CONSOLE_BINDINGS: ReadonlyArray<readonly string[]> = [
  ['-T', 'copy-mode', 'WheelUpPane', 'send-keys', '-X', '-N', '1', 'scroll-up'],
  ['-T', 'copy-mode', 'WheelDownPane', 'send-keys', '-X', '-N', '1', 'scroll-down'],
  ['-T', 'copy-mode-vi', 'WheelUpPane', 'send-keys', '-X', '-N', '1', 'scroll-up'],
  ['-T', 'copy-mode-vi', 'WheelDownPane', 'send-keys', '-X', '-N', '1', 'scroll-down'],
]

// Where a console's tmux view stands — `position` is tmux's scroll_position
// (rows above the bottom; 0 = live), `history` its history_size, `rows` the
// pane height. `inMode`: whether the pane is in copy-mode (scrolled up).
export type ConsoleScroll = { position: number; history: number; rows: number }
export function parseScrollInfo(out: string): ConsoleScroll & { inMode: boolean } {
  // "#{scroll_position} #{history_size} #{pane_height} #{pane_in_mode}" —
  // scroll_position is EMPTY outside copy-mode (hence the split on ONE
  // space, not on runs of whitespace: the empty first field must survive).
  const [pos, hist, rows, mode] = out.replace(/\n$/, '').split(' ')
  return { position: Number(pos) || 0, history: Number(hist) || 0, rows: Number(rows) || 0, inMode: mode === '1' }
}
/** When a question to tmux was asked: its order and its time. */
type Stamp = { seq: number; ms: number }

/** Several tmux commands as ONE call (one fork): `a ; b ; c` — tmux runs
 *  them in order and stops at the first that fails. */
export function chained(cmds: readonly (readonly string[])[]): string[] {
  return cmds.flatMap((c, i) => (i === 0 ? [...c] : [';', ...c]))
}

export interface EnsureConsoleInput {
  cwd: string
  key: string
  resumeId?: string
  sessionId?: string
  append?: string
  extraEnv?: Record<string, string>
  permissionMode?: string
  model?: string
  outputStyle?: string
  theme?: ConsoleTheme
  agentId?: string
  fence?: FenceOverlay
  command?: string[]
  baseEnv?: Record<string, string>
  port?: number
  harness?: HarnessId
  serverPassword?: string
  providerPick?: string
  modelPick?: string
  skin?: { paneStyle: string; palette: readonly string[] }
  prompt?: string
  rolePluginDir?: string
  // the queue of files the owner gave this conversation (context-news.ts):
  // its per-prompt hook drains it (harnesses/claude-code/console.ts)
  contextQueue?: string
  // what Silos keeps for this agent's launches (loads-scopes.ts), in overlay
  // order: the engine's command merges it into its flag-tier settings
  carried?: unknown[]
  // every login's own directory, read at this launch (what a carried
  // choice is computed against)
  loginDirs?: string[]
}

let confWritten = false
function ensureTmuxConf(): void {
  if (confWritten) return
  try {
    writeFileSync(
      TMUX_CONF,
      [
        ...CONSOLE_OPTIONS.map(([k, v]) => `set -g ${k} ${v}\n`),
        ...CONSOLE_SERVER_OPTIONS.map(([k, v]) => `set -s ${k} ${v}\n`),
        ...CONSOLE_BINDINGS.map((args) => `bind-key ${args.join(' ')}\n`),
      ].join(''),
    )
    confWritten = true
  } catch {
    /* best-effort: without a conf, tmux uses defaults (shorter history) */
  }
}

export interface TerminalHandle {
  id: string
  agentId: string | null
  cwd: string
}

interface TerminalEntry {
  id: string
  agentId: string | null
  cwd: string
  proc: pty.IPty
  clients: number
  idleSince: number | null // timestamp since clients hit 0; null while any client is attached
  // a real-console CLIENT (one tmux client per WebSocket, see
  // openConsoleClient) — not a plain shell: it doesn't count toward
  // MAX_PTYS (it has its own cap) and is never idle-reaped (it dies with
  // its socket).
  console?: boolean
  // a Claude account's sign-in (openAccountLogin): the account's name. Not
  // a shell (own cap: one per account), and it keeps what it printed so a
  // socket that attaches late still sees the sign-in link.
  login?: string
  backlog?: string
}

const LOGIN_BACKLOG_MAX = 64 * 1024

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === b
  } catch {
    return a === b
  }
}

// Emits 'killed' (id) every time a PTY dies — via DELETE, the idle reaper,
// or because the process exited on its own — so server.ts can close any WS
// still attached to that id (otherwise a "zombie" WS pointing at an
// already-dead PTY stays open until the client itself notices).
// `kill -0`: is the pid still around (zombies included — they vanish once
// tmux reaps them, which is what we wait for)?
// `pgrep -P <pid>` (async, bounded): the pid's children, one per line;
// rejects when there are none (pgrep exits 1)
function childPids(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('pgrep', ['-P', String(pid)], { timeout: TMUX_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    )
    child.stdin?.end()
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class TerminalService extends EventEmitter {
  private terminals = new Map<string, TerminalEntry>()
  private reaper: ReturnType<typeof setInterval>

  // the real console's tmux socket and the command it runs — injectable so
  // tests can drive a real tmux on a throwaway socket with a stand-in for
  // `claude` (never the real one, never the owner's console socket).
  private tmuxSocket: string
  private tmuxRunner: TmuxRunner
  // every tmux call on the console socket (async + bounded: tmuxExec); a
  // runner that throws synchronously rejects all the same
  private async run(args: string[], opts: TmuxRunOpts = {}): Promise<string> {
    return String(await this.tmuxRunner(['-L', this.tmuxSocket, ...args], opts))
  }

  // ── ordering ────────────────────────────────────────────────────────────
  // The sync calls gave every act on a console its order for free; async,
  // two requests on one console could interleave (prompt A's text, prompt
  // B's text, Enter, Enter — or two spawns over one key). Every act that
  // CHANGES a console (spawn, kill, keys, scroll) runs on its key's chain,
  // one after the other; reads (probes, listings, scroll reads) don't wait.
  private chains = new Map<string, Promise<unknown>>()
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return next
  }

  // ── liveness, as last stated by tmux ────────────────────────────────────
  // For the readers that must stay synchronous (a turn token's check on
  // every agent request — live-turns.ts —, a task wake's busy test): the
  // last DEFINITE answer tmux gave about a key (a probe, a listing, a spawn,
  // a kill), stamped with when the asking STARTED, so an answer that was in
  // flight across a spawn or a kill never overrides it. Older than
  // LIVENESS_FRESH_MS, or never asked, it is «unknown» — which keeps a
  // token, never ends one — and a background probe refreshes it.
  // `seq`: the order the questions were ASKED in (a counter — two answers
  // within one millisecond still order); `ms`: when, for freshness
  private seq = 0
  private ask(): Stamp {
    return { seq: ++this.seq, ms: Date.now() }
  }
  private liveness = new Map<string, { state: 'alive' | 'gone' } & Stamp>()
  private listing: ({ keys: Set<string> } & Stamp) | null = null
  private refreshing = new Set<string>()
  private listingRefresh: Promise<unknown> | null = null
  // keys whose spawn is in flight (and when the last spawn of each began):
  // a listing or a probe that started before it never reads them as gone
  private spawning = new Set<string>()
  private spawnStarted = new Map<string, number>()
  // a spawn of `key` began after (or while) the question stamped `at` was asked
  private spawnedSince(key: string, at: Stamp): boolean {
    return this.spawning.has(key) || (this.spawnStarted.get(key) ?? -1) > at.seq
  }

  private noteLiveness(key: string, state: ConsoleLiveness, at: Stamp): void {
    if (state === 'unknown') return
    const cur = this.liveness.get(key)
    if (cur && cur.seq > at.seq) return
    if (this.lastStated(key)?.state !== state) this.livenessChanged()
    this.liveness.set(key, { state, ...at })
  }

  private lastStated(key: string): ({ state: 'alive' | 'gone' } & Stamp) | null {
    const own = this.liveness.get(key) ?? null
    const l = this.listing
    if (l && (!own || l.seq > own.seq)) return { state: l.keys.has(key) ? 'alive' : 'gone', seq: l.seq, ms: l.ms }
    return own
  }

  /** The console's liveness WITHOUT asking tmux now (sync, no fork): the
   *  last definite answer tmux gave of this key — its own probe, or the
   *  newest listing (a key a listing does not name is gone: a conversation
   *  that never had a console needs no probe of its own). An answer older
   *  than LIVENESS_FRESH_MS still stands (only Silos spawns on its socket,
   *  and a spawn notes itself) and is refreshed in the background.
   *  'unknown' only when tmux has said nothing yet (before the first
   *  listing: one is started, and `liveness` is emitted when it lands so a
   *  reader that decided on unknown re-evaluates), when its last answer was
   *  a failure, or while a spawn of the key is in flight. Decisions that
   *  spawn or drop read consoleState. */
  knownConsoleState(key: string): ConsoleLiveness {
    if (this.spawning.has(key)) return 'unknown'
    const s = this.lastStated(key)
    if (!s || Date.now() - s.ms > LIVENESS_FRESH_MS) {
      if (!this.listing)
        this.listingRefresh ??= this.listConsoles().finally(() => {
          this.listingRefresh = null
        })
      else if (!this.refreshing.has(key)) {
        this.refreshing.add(key)
        void this.consoleState(key).finally(() => this.refreshing.delete(key))
      }
    }
    return s?.state ?? 'unknown'
  }

  // a sync reader's answer may have changed (a key first stated, or flipped):
  // `liveness` once per turn of the loop, so what decided on the old answer
  // (Task mode's holds, the live line) re-evaluates (index.ts)
  private livenessEmit = false
  private livenessChanged(): void {
    if (this.livenessEmit) return
    this.livenessEmit = true
    setImmediate(() => {
      this.livenessEmit = false
      this.emit('liveness')
    })
  }

  /** The keys of the consoles tmux last listed (sync, no fork) — plus any
   *  spawned since —, or null when tmux was never listed. A listing older
   *  than LIVENESS_FRESH_MS is still answered (the OpenCode registrar lists
   *  every 5 s, the sleep sweep every 10 min) and refreshed in the background. */
  knownConsoleKeys(): ReadonlySet<string> | null {
    const l = this.listing
    if (!l || Date.now() - l.ms > LIVENESS_FRESH_MS)
      this.listingRefresh ??= this.listConsoles().finally(() => {
        this.listingRefresh = null
      })
    if (!l) return null
    const keys = new Set(l.keys)
    for (const [k, s] of this.liveness)
      if (s.seq > l.seq) {
        if (s.state === 'alive') keys.add(k)
        else keys.delete(k)
      }
    return keys
  }
  // the console tmux socket's NAME (`tmux -L <name>`) — read by the account
  // load (harnesses/claude-code/account-load.ts) to tell Silos' consoles from any other claude.
  get consoleSocket(): string {
    return this.tmuxSocket
  }
  private loginCommand: LoginCommand
  private consoleCommand: (opts: ConsoleCommandOpts) => string[]
  // where a console's `/clear` files its rotation (see rotationHookCommand);
  // null = no hook (tests with a stand-in claude, or no data dir given).
  readonly rotationsDir: string | null
  // the console's system-prompt append files — under the DATA dir, never
  // a hardcoded ~/.silos: the e2e harness runs with its own dataDir and
  // must never write into the owner's real one (invariant 3).
  private appendDir: string
  // the console's per-session credentials (Vault) — a file the launcher
  // sources and removes before exec'ing claude (see writeEnvFile).
  private envDir: string
  // claude's per-process lock files (<pid>.json with {pid, sessionId}) —
  // the truth of "who runs this conversation right now"; the dir
  // (sessionsDir) is injectable so tests need no real ~/.claude. How a
  // holder outside Silos' consoles is asked to leave (signal: SIGHUP, the
  // same signal `tmux kill-session` sends — claude shuts down cleanly,
  // appends its last-prompt line and releases its lock) and how long we
  // wait for it (holderExitGraceMs) are injectable too.
  private holders: ClaudeHolders
  private isAlive: (pid: number) => boolean

  constructor(
    private registry: AgentRegistry,
    private index: SessionIndex,
    private idleMs = IDLE_MS, // injectable for tests
    reaperIntervalMs = REAPER_INTERVAL_MS, // injectable for tests
    consoleOpts: {
      loginCommand?: LoginCommand
      tmuxSocket?: string
      tmuxRunner?: TmuxRunner
      command?: (opts: ConsoleCommandOpts) => string[]
      rotationsDir?: string
      appendDir?: string
      envDir?: string
      sessionsDir?: string
      isAlive?: (pid: number) => boolean
      consoleSleepMs?: number
      consoleSleepIntervalMs?: number
      lastActivityOf?: (key: string) => number | null
      consolesDir?: string
      signal?: (pid: number, sig: NodeJS.Signals) => void
      holderExitGraceMs?: number
      configDirOf?: (pid: number) => string | null
      liveTurns?: LiveTurns
      consoleLife?: ConsoleLife
    } = {},
  ) {
    super()
    this.consoleLife = consoleOpts.consoleLife ?? null
    this.tmuxSocket = consoleOpts.tmuxSocket ?? TMUX_SOCKET
    this.tmuxRunner = consoleOpts.tmuxRunner ?? tmuxExec
    this.loginCommand = consoleOpts.loginCommand ?? defaultLoginCommand
    this.consoleCommand = consoleOpts.command ?? defaultConsoleCommand
    this.rotationsDir = consoleOpts.rotationsDir ?? null
    this.appendDir = consoleOpts.appendDir ?? join(homedir(), '.silos', 'console-append')
    this.envDir = consoleOpts.envDir ?? join(homedir(), '.silos', 'console-env')
    this.consolesDir = consoleOpts.consolesDir ?? null
    this.liveTurns = consoleOpts.liveTurns ?? null
    // a console's turn token lives until tmux SAYS its session is gone — a
    // probe that fails keeps it (unknown is never gone). Read on every agent
    // request, so from the last answer tmux gave (knownConsoleState: no
    // fork on the request; a stale answer is unknown and refreshed)
    this.liveTurns?.setConsoleAlive((key) => this.knownConsoleState(key))
    this.isAlive = consoleOpts.isAlive ?? alive
    this.holders = new ClaudeHolders({
      sessionsDir: consoleOpts.sessionsDir ?? CLAUDE_SESSIONS_DIR(),
      isAlive: this.isAlive,
      signal: consoleOpts.signal ?? ((pid, sig) => process.kill(pid, sig)),
      graceMs: consoleOpts.holderExitGraceMs ?? HOLDER_EXIT_GRACE_MS,
      ...(consoleOpts.configDirOf ? { configDirOf: consoleOpts.configDirOf } : {}),
    })
    if (this.rotationsDir) mkdirSync(this.rotationsDir, { recursive: true, mode: 0o700 })
    // The reaper is created ONCE at service init (not a timer per PTY) —
    // see the REAPER_INTERVAL_MS comment above.
    this.reaper = setInterval(() => this.sweepIdle(), reaperIntervalMs)
    this.reaper.unref?.()
    this.consoleSleepMs = consoleOpts.consoleSleepMs ?? CONSOLE_SLEEP_MS
    this.lastActivityOf = consoleOpts.lastActivityOf ?? null
    this.sleepSweeper = setInterval(() => void this.sweepSleepingConsoles(), consoleOpts.consoleSleepIntervalMs ?? CONSOLE_SLEEP_INTERVAL_MS)
    this.sleepSweeper.unref?.()
  }

  private consoleSleepMs: number
  // Usage's console windows (usage.ts): told when a
  // console's tmux is launched and when it is found gone. Absent: nothing.
  private consoleLife: ConsoleLife | null
  // the turn tokens (live-turns.ts): every console
  // spawned for an agent gets its own SILOS_TURN through the launcher's env
  // FILE — the same path for every engine's console (Claude's, OpenCode's,
  // console-open.ts's) — dropped when its tmux dies. Absent: no token (tests).
  private liveTurns: LiveTurns | null
  // the latest activity of a console's THREAD (its key and every session a
  // /clear rotated it into) — wired to lineage + index in index.ts. Without
  // it the sweep falls back to the key's own transcript.
  private lastActivityOf: ((key: string) => number | null) | null
  private sleepSweeper: ReturnType<typeof setInterval>
  private sleepSweepRunning = false

  // Every console tmux session on our socket: its conversation key, how
  // many clients are attached, and when tmux created it (the fallback
  // liveness stamp for a console whose conversation has no transcript yet).
  async listConsoles(): Promise<{ key: string; attached: number; createdMs: number | null }[]> {
    const startedAt = this.ask()
    let rows: { key: string; attached: number; createdMs: number | null }[]
    try {
      // `:` between the fields — tmux allows none in a session name, and it
      // is plain ASCII: without a UTF-8 locale (a server started with no
      // LANG) tmux prints every control character as `_`, a tab too, and no
      // key of that listing matched a console — every live one read «gone»
      // and lost its turn token
      const out = await this.run(['list-sessions', '-F', '#{session_name}:#{session_attached}:#{session_created}'])
      rows = []
      for (const line of out.split('\n')) {
        if (!line.startsWith('silos-')) continue
        const m = /^silos-([^:]+):(\d+):(\d+)$/.exec(line)
        // a line of ours that does not read is no answer: the whole listing
        // is unknown (nothing forgotten), never «that console is gone»
        if (!m) {
          console.warn(`consoles: tmux's listing could not be read («${line.slice(0, 80)}») — nothing is dropped on it`)
          return []
        }
        rows.push({ key: m[1]!, attached: Number(m[2]) || 0, createdMs: Number(m[3]) > 0 ? Number(m[3]) * 1000 : null })
      }
    } catch (err) {
      // no tmux server on this socket = no consoles; any OTHER failure is
      // unknown and must not forget live consoles' agents nor their turn
      // tokens (tmuxSaysGone: «error connecting to» is gone only for a
      // missing socket — EAGAIN/EMFILE on a live server are not answers)
      if (!tmuxSaysGone(err)) return []
      rows = []
    }
    const keys = new Set(rows.map((r) => r.key))
    if (!this.listing || this.listing.seq < startedAt.seq) {
      const prev = this.listing
      if (!prev || prev.keys.size !== keys.size || [...keys].some((k) => !prev.keys.has(k))) this.livenessChanged()
      this.listing = { keys, ...startedAt }
    }
    // a console whose spawn began after this listing asked (or is still in
    // flight) is not «gone» because the listing predates it
    const alive = new Set(keys)
    for (const k of this.spawning) alive.add(k)
    for (const [k, t] of this.spawnStarted) if (t > startedAt.seq) alive.add(k)
    this.forgetAgentsBut(alive)
    return rows
  }

  // The sleep sweep — async (killConsoleAndWait waits out claude's clean
  // shutdown, up to a minute each) and self-excluding so a slow pass never
  // overlaps the next tick.
  async sweepSleepingConsoles(): Promise<void> {
    if (this.sleepSweepRunning) return
    this.sleepSweepRunning = true
    try {
      const now = Date.now()
      for (const c of await this.listConsoles()) {
        // a console's claude writes to the chain's LATEST session after a
        // /clear, never to the key again: timing the key alone slept
        // consoles mid-work once the key's transcript turned 24 h old (the
        // log showed the same console slept three times).
        // An OpenCode console is keyed by a Silos UUID until the registrar
        // seals the session OpenCode minted: time it by that session once
        // bound; unsealed, by its creation (so a young one is never slept).
        const sid = this.nativeIdOf(c.key) ?? c.key
        const meta = this.index.allSessions().find((m) => m.id === sid)
        const lastAliveMs = this.lastActivityOf?.(sid) ?? (meta ? meta.mtime : (c.createdMs ?? this.consoleRecord(c.key)?.createdMs ?? null))
        if (!shouldSleepConsole({ attached: c.attached, lastAliveMs, now, sleepMs: this.consoleSleepMs })) continue
        // logged before the kill so a death mid-shutdown still leaves the
        // intent in server.log.
        console.log(
          `console slept: ${c.key} (still ${Math.round((now - (lastAliveMs ?? now)) / 3_600_000)}h, nobody attached) — transcript kept, reopens via --resume`,
        )
        this.emit('console-slept', c.key)
        await this.killConsoleAndWait(c.key)
      }
    } finally {
      this.sleepSweepRunning = false
    }
  }

  private sweepIdle(): void {
    const now = Date.now()
    for (const entry of [...this.terminals.values()]) {
      if (entry.clients === 0 && entry.idleSince !== null && now - entry.idleSince >= this.idleMs) {
        this.kill(entry.id)
      }
    }
  }

  // For tests / clean shutdown — the reaper is already unref()'d (never
  // blocks process exit), but a long test suite accumulates a lot of
  // phantom intervals if they aren't stopped explicitly between cases.
  stopReaper(): void {
    clearInterval(this.reaper)
    clearInterval(this.sleepSweeper)
  }

  // The candidate must exist AND match (by realpath, against symlinks)
  // either an active agent's folder OR the cwd of some session already
  // seen — never an arbitrary path on the owner's filesystem.
  private validateCwd(candidate: string): string {
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      throw new Error('cwd not allowed')
    }
    const allowed =
      this.registry.list().some((a) => a.folder !== null && sameDir(a.folder, real)) ||
      this.index.allSessions().some((m) => m.cwd !== null && sameDir(m.cwd, real))
    if (!allowed) throw new Error('cwd not allowed')
    return real
  }

  private resolveCwd(input: { agentId?: string; cwd?: string }): { cwd: string; agentId: string | null } {
    if (input.agentId !== undefined) {
      const agent = this.registry.get(input.agentId)
      if (!agent || agent.archived) throw new Error('agent not available')
      if (agent.folder === null) throw new Error('the agent has no folder')
      return { cwd: this.validateCwd(agent.folder), agentId: agent.id }
    }
    if (input.cwd !== undefined) return { cwd: this.validateCwd(input.cwd), agentId: null }
    throw new Error('agentId or cwd required')
  }

  create(input: { agentId?: string; cwd?: string }): TerminalHandle {
    if (this.shellCount() >= MAX_PTYS) throw new Error('terminal limit reached (max 4)')
    const { cwd, agentId } = this.resolveCwd(input)
    const shell = process.env.SHELL ?? '/bin/bash'
    const env = { ...cleanEnv(), TERM: 'xterm-256color', HOME: homedir() }
    const proc = pty.spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env })
    const id = randomUUID()
    const entry: TerminalEntry = { id, agentId, cwd, proc, clients: 0, idleSince: Date.now() } // no client attached yet — the idle clock starts right away
    this.terminals.set(id, entry)
    proc.onExit(() => {
      // If the PTY died on its own (e.g. the owner typed `exit`), still
      // notify attached WS clients — avoids a double-guard if kill() also
      // killed it (kill() already deletes from the map before calling
      // proc.kill(), so delete() here returns false and doesn't re-emit).
      if (this.terminals.delete(id)) this.emit('killed', id)
    })
    return { id, agentId, cwd }
  }

  // A Claude account's sign-in, as a terminal (see LoginCommand). ONE per
  // account: asking again while it runs returns the same one (a reload, a
  // second tab), so two flows never race on one .credentials.json. It dies
  // when claude exits (signed in, or the owner quit it), by DELETE, or idle
  // like a shell.
  // configDir null = the machine's own account (no CLAUDE_CONFIG_DIR; it
  // runs from HOME, which a fresh machine has even before ~/.claude exists).
  openAccountLogin(input: { account: string; configDir: string | null }): TerminalHandle {
    for (const e of this.terminals.values()) if (e.login === input.account) return { id: e.id, agentId: null, cwd: e.cwd }
    const { file, args } = this.loginCommand(input.configDir)
    // cleanEnv() drops inherited CLAUDE* vars, so the account's dir is set after it
    const env = { ...cleanEnv(), TERM: 'xterm-256color', HOME: homedir(), ...loginEnv(input.configDir) }
    const cwd = input.configDir ?? homedir()
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 12, cwd, env })
    const id = randomUUID()
    const entry: TerminalEntry = { id, agentId: null, cwd, proc, clients: 0, idleSince: Date.now(), login: input.account, backlog: '' }
    this.terminals.set(id, entry)
    proc.onData((d) => {
      entry.backlog = (entry.backlog + d).slice(-LOGIN_BACKLOG_MAX)
    })
    proc.onExit(() => {
      if (this.terminals.delete(id)) this.emit('killed', id)
    })
    return { id, agentId: null, cwd }
  }

  // ---- the real console -------------------------------------------------
  // ONE tmux session per conversation (durable: the real `claude` lives on
  // the tmux server and survives reloads and even a Silos restart) and ONE
  // tmux client — a PTY — per WebSocket. That's what tmux is built for:
  // every client gets the full screen the moment it attaches, its own size
  // (window-size latest: the most recently active client sets the window,
  // the others see a filler), and the mouse modes — nothing depends on
  // racing the first paint or on some other tab's size. The earlier spike
  // shared ONE PTY between tabs and paid for it three times: a blank
  // reload (the bytes before the WS attached were lost), a foreign size
  // left by the phone, and no scroll.
  private consoleName(key: string): string {
    return `silos-${key}`
  }

  // An OpenCode console's key is Silos' own; the session id OpenCode minted
  // for it arrives later in the plugin's birth marker and is bound here by
  // harnesses/opencode/registrar.ts. A rebind of either side drops the
  // stale pairing, so both maps stay one-to-one.
  private nativeIdByKey = new Map<string, string>()
  private keyByNativeId = new Map<string, string>()
  // console key → the agent it was launched (or reattached) for, by Silos.
  // In memory: after a restart it is unknown (null) until the console is
  // reopened through the API — the registrar then refuses, never guesses.
  private agentByKey = new Map<string, string>()

  // a console that died outside killConsole (claude exited, tmux killed by
  // hand) takes its recorded agent with it — pruned on every listing
  private forgetAgentsBut(alive: Set<string>): void {
    for (const key of [...this.agentByKey.keys()]) if (!alive.has(key)) this.agentByKey.delete(key)
    for (const r of this.consoleRecords()) if (!alive.has(r.key)) this.removeRecord(r.key)
    this.liveTurns?.pruneConsoles(alive)
    try {
      this.consoleLife?.alive(alive)
    } catch {
      /* Usage never stops a listing */
    }
  }

  // ── console records ─────────────────────────────────────────────────────
  // What Silos itself knows about a console it launched for another harness
  // (OpenCode): the agent it was launched for, its port and HTTP password,
  // when, and the native session id bound to it. Silos-owned and durable —
  // <consolesDir>/<key>.json, 0600 in a 0700 dir under the data dir (fenced
  // from agents) — so a restart rebuilds the in-memory maps from it
  // (registrar.ts rehydrate) instead of from anything an agent can write
  // (birth markers, tmux env). Written at launch, updated on bind, removed
  // with the console. Without a consolesDir (tests) they live in memory.
  private consolesDir: string | null
  private records = new Map<string, ConsoleRecord>()

  private recordPath(key: string): string | null {
    return this.consolesDir && /^[A-Za-z0-9_-]+$/.test(key) ? join(this.consolesDir, `${key}.json`) : null
  }

  consoleRecord(key: string): ConsoleRecord | null {
    const mem = this.records.get(key)
    if (mem) return mem
    const p = this.recordPath(key)
    if (!p) return null
    try {
      const r = JSON.parse(readFileSync(p, 'utf8')) as ConsoleRecord
      if (r?.key !== key || (r.agentId !== null && typeof r.agentId !== 'string')) return null
      this.records.set(key, r)
      return r
    } catch {
      return null
    }
  }

  consoleRecords(): ConsoleRecord[] {
    const keys = new Set(this.records.keys())
    if (this.consolesDir) {
      try {
        for (const n of readdirSync(this.consolesDir)) if (n.endsWith('.json')) keys.add(n.slice(0, -'.json'.length))
      } catch {
        /* no records yet */
      }
    }
    return [...keys].map((k) => this.consoleRecord(k)).filter((r): r is ConsoleRecord => r !== null)
  }

  private writeRecord(r: ConsoleRecord): void {
    this.records.set(r.key, r)
    const p = this.recordPath(r.key)
    if (!p || !this.consolesDir) return
    try {
      mkdirSync(this.consolesDir, { recursive: true, mode: 0o700 })
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(r) + '\n', { mode: 0o600 })
      renameSync(tmp, p)
    } catch (err) {
      console.warn(`console record ${r.key}: could not write — ${(err as Error).message}`)
    }
  }

  private removeRecord(key: string): void {
    this.records.delete(key)
    const p = this.recordPath(key)
    if (p) rmSync(p, { force: true })
  }

  consoleAgent(key: string): string | null {
    return this.agentByKey.get(key) ?? null
  }

  // the launch agent of a console that survived a restart, as
  // harnesses/opencode/registrar.ts rehydrate() proves it — never a guess
  setConsoleAgent(key: string, agentId: string): void {
    this.agentByKey.set(key, agentId)
  }

  // Emits the neutral `native-bound` (key, id) when the pair is NEW and the
  // key is not the id (R5): a key written on a task before
  // the seal gets its id listed (index.ts). Not on bindNativeId(id, id), nor
  // on a rehydration that re-binds the pair the record already holds.
  bindNativeId(key: string, id: string): void {
    const fresh = key !== id && this.nativeIdByKey.get(key) !== id && this.consoleRecord(key)?.nativeId !== id
    this.bindPair(key, id)
    if (fresh) this.emit('native-bound', key, id)
  }

  private bindPair(key: string, id: string): void {
    const oldId = this.nativeIdByKey.get(key)
    if (oldId !== undefined) this.keyByNativeId.delete(oldId)
    const oldKey = this.keyByNativeId.get(id)
    if (oldKey !== undefined) this.nativeIdByKey.delete(oldKey)
    this.nativeIdByKey.set(key, id)
    this.keyByNativeId.set(id, key)
    if (oldKey !== undefined && oldKey !== key) {
      const stale = this.consoleRecord(oldKey)
      if (stale?.nativeId === id) {
        const { nativeId: _drop, ...rest } = stale
        this.writeRecord(rest)
      }
    }
    const rec = this.consoleRecord(key)
    if (rec && rec.nativeId !== id) this.writeRecord({ ...rec, nativeId: id })
  }

  // a second, different account pick on a console still waiting for its
  // first session (POST /api/console reuse path) replaces the first one
  setConsoleProviderPick(key: string, pick: string, model?: string): void {
    const rec = this.consoleRecord(key)
    if (rec && (rec.providerPick !== pick || (model !== undefined && rec.modelPick !== model)))
      this.writeRecord({ ...rec, providerPick: pick, ...(model !== undefined ? { modelPick: model } : {}) })
  }

  /** the model pick for a console still waiting for its first session */
  setConsoleModelPick(key: string, model: string): void {
    const rec = this.consoleRecord(key)
    if (rec && rec.modelPick !== model) this.writeRecord({ ...rec, modelPick: model })
  }

  nativeIdOf(key: string): string | null {
    return this.nativeIdByKey.get(key) ?? null
  }

  keyOfNativeId(id: string): string | null {
    return this.keyByNativeId.get(id) ?? null
  }

  // The console's liveness, as tmux states it (tmuxSaysGone): `unknown` when
  // the probe itself failed. Every decision that DROPS, REPLACES or SPAWNS
  // over a console reads this — never hasConsole's boolean.
  async consoleState(key: string): Promise<ConsoleLiveness> {
    const startedAt = this.ask()
    let state: ConsoleLiveness
    try {
      // `=name`: an exact match — a bare -t would also match by prefix.
      // tmux's own words (stderr) are what tell gone from unknown
      await this.run(['has-session', '-t', `=${this.consoleName(key)}`])
      state = 'alive'
    } catch (err) {
      state = tmuxSaysGone(err) ? 'gone' : 'unknown'
    }
    // a «gone» asked before a spawn of the key began says nothing of it
    if (state === 'gone' && this.spawnedSince(key, startedAt)) return 'unknown'
    this.noteLiveness(key, state, startedAt)
    return state
  }

  // «Is there a console to show / reach right now?» — true only when tmux
  // said so. A read for display and routing; it never decides dropping a
  // console's token nor spawning over its key (consoleState does).
  async hasConsole(key: string): Promise<boolean> {
    return (await this.consoleState(key)) === 'alive'
  }

  // the guard of every act ON a running console: tmux said it is gone →
  // 'console not open'; the probe failed → ConsoleUnknownError, never «gone»
  // (hasConsole first — the one probe on the happy path; the reason is
  // asked only when it said no)
  private async mustBeAlive(key: string): Promise<void> {
    if (await this.hasConsole(key)) return
    if ((await this.consoleState(key)) === 'gone') throw new Error('console not open')
    throw new ConsoleUnknownError(key)
  }

  private shellCount(): number {
    let n = 0
    for (const e of this.terminals.values()) if (!e.console && e.login === undefined) n += 1
    return n
  }

  private consoleClientCount(): number {
    let n = 0
    for (const e of this.terminals.values()) if (e.console) n += 1
    return n
  }

  // The agent's identity (mission + agent memory + platform notes — the
  // SAME append a chat session gets) travels into the CLI by FILE
  // (--append-system-prompt-file): tmux joins its command arguments with
  // spaces and runs them through a shell, so passing the multi-line text
  // inline would need shell quoting — a plain path is safe. The file holds
  // the agent's MEMORY, so it never touches the shared /tmp: it lives under
  // ~/.silos in an owner-only dir (0700) with owner-only files (0600).
  // Best effort: a write failure just spawns the console without the append.
  // The console's settings (its fence among them) as an owner-only file
  // beside its append, named by `--settings` — never the JSON on argv,
  // which /proc/<pid>/cmdline shows to every process of the user (D8). Kept
  // for the console's life like the append: the engine may read it again.
  private writeSettingsFile(key: string, json: string): string | undefined {
    if (!/^[\w-]+$/.test(key)) return undefined
    try {
      mkdirSync(this.appendDir, { recursive: true, mode: 0o700 })
      const p = join(this.appendDir, `${key}.settings.json`)
      writeFileSync(p, json, { mode: 0o600 })
      chmodSync(p, 0o600)
      return p
    } catch {
      return undefined
    }
  }

  private writeAppendFile(key: string, append?: string): string | undefined {
    if (!append || append.trim() === '') return undefined
    try {
      const dir = this.appendDir
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const p = join(dir, `${key}.md`)
      writeFileSync(p, append, { mode: 0o600 })
      return p
    } catch {
      return undefined
    }
  }

  // Every tmux call of the console spawn reports tmux's OWN reason and
  // never the argv: execFileSync's "Command failed: <argv…>" once put the
  // whole Vault on the owner's screen. Same words for every
  // subcommand, so no later call can leak what the first one no longer does.
  private async tmux(args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
    try {
      await this.run([...args], env ? { env } : {})
    } catch (err) {
      const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim().split('\n')[0] ?? ''
      const sub = args[0] === '-f' ? args[2] : args[0]
      throw new Error(`tmux ${sub} failed${stderr ? `: ${stderr}` : ''}`)
    }
  }

  // A new session takes the tmux SERVER's global environment, frozen when
  // that server started — and it outlives Silos' restarts (the owner's is up
  // for days). One started by a server that ran under `npm run dev` carries
  // npm's run variables and node_modules/.bin on PATH into every console
  // (revision M1); one started before a PATH change (the service unit)
  // keeps the old PATH. So before each new console the global environment
  // loses npm's run variables and its PATH becomes the server's own (clean:
  // cleanEnv) — the same PATH the SDK turns resolve `claude` with. No tmux
  // server yet = nothing to clean: the new-session that starts it inherits
  // the clean `env` it is given.
  private async cleanGlobalEnv(path: string | undefined): Promise<void> {
    let shown: string
    try {
      shown = await this.run(['show-environment', '-g'])
    } catch {
      return
    }
    const global: Record<string, string> = {}
    for (const line of shown.split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (m) global[m[1]!] = m[2]!
    }
    for (const name of devRunVars(global)) await this.tmux(['set-environment', '-gu', name])
    // a tmux server born before the boot scrubs (or from a server started
    // inside an agent's console) keeps that env as its global one, and every
    // new session inherits it: Silos' own wiring and the owner's token go
    // (env.ts isNeverInherited) — never CLAUDE*, which a console's first
    // spawn put there on purpose (CLAUDE_CONSOLE_ENV)
    for (const name of Object.keys(global)) if (name.startsWith('SILOS_') && isNeverInherited(name)) await this.tmux(['set-environment', '-gu', name])
    if (path !== undefined && global.PATH !== path) await this.tmux(['set-environment', '-g', 'PATH', path])
  }

  // Credentials never travel on a command line. They used to ride as
  // `tmux new-session -e K=V …`: ONE client→server message, capped by
  // tmux's imsg buffer (16 KB) — a Vault of 24 console cookies made every
  // new console of that agent fail with "command too long", and the
  // failure carried every secret into the error. So
  // the env is an owner-only file (0600, in a 0700 dir under the data
  // dir) of `export K='v'` lines that the launcher (consoleLaunch) sources
  // and REMOVES before exec'ing claude: no size limit, nothing on argv, no
  // file left once claude runs. Names that aren't shell identifiers are
  // skipped (a bad Vault entry must not block the console).
  // The same 16 KB message carries the console's ARGV: a fenced agent's
  // `--settings` grows with the fence, and past the cap
  // tmux refuses with "command too long". So an argv over
  // LAUNCH_ARGV_INLINE_MAX rides the same file (`argv` given): its FIRST line
  // removes the file (an unlinked file still reads to the end), then the
  // exports, then `set -- '<arg>' …` — the launcher (LONG_ARGV_LAUNCHER)
  // only sources it and exec's "$@". The path lives only in `$1`, which no
  // `export NAME=` line can touch — a Vault entry named like a shell variable
  // the launcher used (`f`, review A5) can no longer redirect the rm or leave
  // the secrets on disk.
  private writeEnvFile(key: string, extraEnv?: Record<string, string>, argv?: string[]): string | undefined {
    const entries = Object.entries(extraEnv ?? {}).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    if (entries.length === 0 && argv === undefined) return undefined
    mkdirSync(this.envDir, { recursive: true, mode: 0o700 })
    const p = join(this.envDir, `${key}.env`)
    const quote = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`
    const lines = entries.map(([k, v]) => `export ${k}=${quote(v)}`)
    if (argv !== undefined) {
      lines.unshift('rm -f -- "$1"')
      lines.push(`set -- ${argv.map(quote).join(' ')}`)
    }
    writeFileSync(p, lines.join('\n') + '\n', { mode: 0o600 })
    return p
  }

  // Makes sure the conversation's tmux session exists (detached: nobody
  // is attached until a WebSocket opens a client). `resumeId` present →
  // `claude --resume <id>`; `sessionId` present → a fresh claude that
  // will persist under that id. `key` names the tmux session — ALWAYS the
  // conversation's id (a new conversation's key is the id it's born with).
  // The theme a console was BORN with — stamped as a tmux session variable
  // at spawn, so it survives server restarts along with the session itself.
  // The claude inside keeps its birth palette until the console is closed
  // and reopened, so the UI must render the pane with THIS theme, not the
  // current one — a light-born console viewed in dark painted near-black
  // text on charcoal ("diffs unreadable in dark").
  async consoleTheme(key: string): Promise<ConsoleTheme | null> {
    try {
      const out = (await this.run(['show-environment', '-t', `=${this.consoleName(key)}`, 'SILOS_CONSOLE_THEME'])).trim()
      const v = out.split('=')[1]
      return v === 'light' || v === 'dark' ? v : null
    } catch {
      return null
    }
  }

  // The fixed port of a console whose program is a server (OpenCode's TUI:
  // `--port`), for its HTTP API (send to console) — from the console's
  // Silos-owned record, so it survives a restart.
  consolePort(key: string): number | null {
    return this.consoleRecord(key)?.port ?? null
  }

  // Serialized per key (serial): two opens of one conversation never both
  // see «gone» and race two spawns over it — the second reattaches.
  ensureConsole(input: EnsureConsoleInput): Promise<{ key: string; theme: ConsoleTheme; briefed?: true }> {
    return this.serial(input.key, () => this.ensureConsoleNow(input))
  }

  private async ensureConsoleNow(input: EnsureConsoleInput): Promise<{ key: string; theme: ConsoleTheme; briefed?: true }> {
    const cwd = this.validateCwd(input.cwd)
    ensureTmuxConf()
    const attached = await this.reattachConsole(input.key)
    if (attached === null) {
      this.spawning.add(input.key)
      this.spawnStarted.set(input.key, this.ask().seq)
      try {
        await this.spawnConsole(input, cwd)
      } finally {
        this.spawning.delete(input.key)
      }
    }
    // the agent this console runs as — the registrar seals a plugin-reported
    // OpenCode id only for a marker of THIS agent (an agent can read other
    // consoles' keys off the shared tmux socket).
    // A call without one (server.ts omits it when the registry lookup
    // fails) forgets any earlier answer for a reused key.
    if (input.agentId) this.agentByKey.set(input.key, input.agentId)
    else this.agentByKey.delete(input.key)
    // `briefed`: a NEW claude was launched with the first prompt (a console
    // that was already running was only reattached — nothing typed into it;
    // another harness's own argv never carries it)
    return attached ?? { key: input.key, theme: input.theme ?? 'dark', ...(input.prompt && !input.command ? { briefed: true as const } : {}) }
  }

  private async spawnConsole(input: EnsureConsoleInput, cwd: string): Promise<void> {
    // Rule 2: never a `--resume` twin. If a live claude — the one
    // being torn down by a restart, or one the owner launched by hand —
    // still holds this session, refuse with a clear message instead of
    // spawning beside it (two writers, one transcript, Remote Control
    // conflict, the in-flight prompt lost).
    const prior = input.resumeId ? this.holderDetailsOf(input.resumeId) : []
    if (prior.length > 0) {
      // typed so POST /api/console can hand the owner a door (Close it
      // and open — the same close-and-wait the trash route offers)
      throw new ConsoleHeldError(`the previous claude of this conversation is still running (${describeHolders(prior, Date.now())})`, input.resumeId!, prior)
    }
    // CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: claude 2.1.x otherwise draws
    // itself in the alternate screen AND captures the mouse to scroll its
    // own view — a third layer repainting on top of tmux and xterm.js.
    // With the switch (an official knob, verified on 2.1.241: alt 0,
    // mouse 0) claude writes to the normal screen, tmux keeps the
    // history and the wheel scrolls it through tmux's copy mode — the
    // plain, well-trodden "claude inside tmux" path.
    // cleanEnv() strips inherited CLAUDE* vars, so this is set AFTER it.
    // Another harness (input.command present) brings its own argv and its
    // own base env (input.baseEnv) — the Claude switch is not its business.
    const env = input.command
      ? { ...cleanEnv(), TERM: 'xterm-256color', HOME: homedir(), ...input.baseEnv }
      : { ...cleanEnv(), TERM: 'xterm-256color', HOME: homedir(), ...CLAUDE_CONSOLE_ENV }
    const command =
      input.command ??
      this.consoleCommand({
        resumeId: input.resumeId,
        sessionId: input.sessionId,
        appendFile: this.writeAppendFile(input.key, input.append),
        permissionMode: input.permissionMode,
        ...(input.model ? { model: input.model } : {}),
        ...(input.outputStyle ? { outputStyle: input.outputStyle } : {}),
        theme: input.theme,
        ...(this.rotationsDir ? { rotationHook: { dir: this.rotationsDir, key: input.key } } : {}),
        ...(this.rotationsDir && input.agentId
          ? {
              contextNews: {
                dir: this.rotationsDir,
                key: input.key,
                cwd: input.cwd,
                agentId: input.agentId,
                ...(input.contextQueue ? { queue: input.contextQueue } : {}),
              },
            }
          : {}),
        ...(input.fence ? { fence: input.fence } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.rolePluginDir ? { rolePluginDir: input.rolePluginDir } : {}),
        ...(input.carried && input.carried.length > 0 ? { carried: input.carried, ...(input.loginDirs ? { loginDirs: input.loginDirs } : {}) } : {}),
        cwd: input.cwd,
        settingsFile: (json) => this.writeSettingsFile(input.key, json),
      })
    // The client environment does NOT reach a new session once the tmux
    // server is already running (sessions inherit the server's global
    // env), so per-session credentials ride the launch itself: an env
    // FILE the launcher sources and removes (writeEnvFile) — never `-e`
    // (16 KB cap, secrets on argv). tmux exec()s a multi-word command
    // directly (no shell), so the launcher is `sh` with a script argument:
    // $1 = the env file, the rest = claude's own argv, untouched.
    // An argv over LAUNCH_ARGV_INLINE_MAX (a big fence) rides the file too:
    // nothing of it on the tmux line (writeEnvFile).
    const longArgv = command.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0) > LAUNCH_ARGV_INLINE_MAX
    // the console's turn token rides the same file, last: no Vault entry
    // or engine env can name it (never `tmux -e`,
    // so `tmux show-environment` never shows it)
    // STAGED, not swapped: the key's earlier token stays valid until the
    // spawn succeeds (commitConsole) and the new one is discarded if it
    // fails — a failed relaunch (a `duplicate session` over a console
    // that was alive after all) never leaves the running claude tokenless
    const turn = input.agentId && this.liveTurns ? this.liveTurns.stageConsole(input.agentId, input.key) : null
    const extraEnv = turn ? { ...input.extraEnv, SILOS_TURN: turn } : input.extraEnv
    let envFile: string | undefined
    try {
      envFile = this.writeEnvFile(input.key, extraEnv, longArgv ? command : undefined)
    } catch (err) {
      if (turn) this.liveTurns?.drop(turn)
      throw err
    }
    const launch = !envFile
      ? command
      : longArgv
        ? ['sh', '-c', LONG_ARGV_LAUNCHER, 'silos-console', envFile]
        : ['sh', '-c', '. "$1"; rm -f -- "$1"; shift; exec "$@"', 'silos-console', envFile, ...command]
    try {
      // another harness's console gets its Silos-owned record (Claude's
      // console keeps none: its key IS its session id) — written BEFORE the
      // spawn, so no live console ever lacks one; removed if tmux fails
      if (input.harness) {
        this.writeRecord({
          key: input.key,
          agentId: input.agentId ?? null,
          harness: input.harness,
          createdMs: Date.now(),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
          ...(input.providerPick ? { providerPick: input.providerPick } : {}),
          ...(input.modelPick ? { modelPick: input.modelPick } : {}),
        })
      } else this.removeRecord(input.key)
      await this.cleanGlobalEnv((env as Record<string, string | undefined>).PATH)
      await this.tmux(
        [
          '-f',
          TMUX_CONF,
          'new-session',
          '-d',
          '-s',
          this.consoleName(input.key),
          '-c',
          cwd,
          '-x',
          '200',
          '-y',
          '50',
          // birth-theme stamp — read back by consoleTheme() (see above).
          '-e',
          `SILOS_CONSOLE_THEME=${input.theme ?? 'dark'}`,
          ...launch,
          // the pane's own colours and passthrough, in the SAME tmux call
          // (before the TUI asks the terminal for its background and its
          // palette — OpenCode's `system` theme derives itself from both;
          // harnesses/opencode/console-theme.ts, console-palette.ts)
          ...(input.skin
            ? [
                ';',
                'set-option',
                '-w',
                '-t',
                this.consoleName(input.key),
                'window-style',
                input.skin.paneStyle,
                ';',
                'set-option',
                '-p',
                '-t',
                this.consoleName(input.key),
                'allow-passthrough',
                'on',
              ]
            : []),
        ],
        env,
      )
    } catch (err) {
      if (envFile) rmSync(envFile, { force: true }) // nothing sourced it: don't leave it behind
      if (input.harness) this.removeRecord(input.key)
      // only the token staged for THIS spawn: the key's earlier one (a
      // console still running under it) is untouched
      if (turn) this.liveTurns?.drop(turn)
      throw err
    }
    // tmux took the new session: from here its token is THE key's one
    if (turn) this.liveTurns?.commitConsole(input.key, turn)
    if (input.agentId) {
      try {
        this.consoleLife?.launched({
          key: input.key,
          agentId: input.agentId,
          cwd,
          sessionId: input.resumeId ?? input.sessionId ?? input.key,
          ...(input.providerPick ? { providerPick: input.providerPick } : {}),
        })
      } catch {
        /* Usage never stops a console */
      }
    }
    // `-f` only counts when the tmux SERVER starts; on a server that's
    // been up for hours (the usual case) the conf is never re-read. So
    // the options are also set explicitly, every time — idempotent. No
    // `=` prefix here: set-option's -t doesn't accept it (it fails
    // silently with exit 1 — a documented trap in other xterm.js+tmux
    // integrations), and these are global anyway.
    // ONE tmux call (`;`-chained): every fork is one more process start
    await this.tmux(
      chained([
        ...CONSOLE_OPTIONS.map(([name, value]) => ['set-option', '-g', name, value]),
        ...CONSOLE_SERVER_OPTIONS.map(([name, value]) => ['set-option', '-s', name, value]),
        ...CONSOLE_BINDINGS.map((args) => ['bind-key', ...args]),
      ]),
    ) // a reattach applied the bindings in reattachConsole
    if (input.skin) this.answerPalette(input.key, input.skin.palette)
    // tmux took it: alive as of the spawn (the sync readers see it at once)
    this.noteLiveness(input.key, 'alive', this.ask())
  }

  // Reopening a console that already runs: no cwd, no spawn — the claude
  // inside already has both. Null when there is nothing to reattach to.
  // The route needs this on its own for a console-born session whose
  // transcript has not written its cwd yet.
  // A probe that fails throws ConsoleUnknownError: null would make
  // ensureConsole spawn over a console that may be running (and, once,
  // swap its turn token for one no claude holds).
  async reattachConsole(key: string): Promise<{ key: string; theme: ConsoleTheme } | null> {
    const state = await this.consoleState(key)
    if (state === 'unknown') throw new ConsoleUnknownError(key)
    if (state === 'gone') return null
    await this.applyBindings()
    return { key, theme: (await this.consoleTheme(key)) ?? 'dark' }
  }

  // bindings are server-global and cheap: applied on EVERY open (a reopen
  // included), so a tmux server that predates them — the owner's, up for
  // days — picks them up the next time any console is opened. One tmux
  // call for all of them (`;`-chained).
  private async applyBindings(): Promise<void> {
    await this.tmux(chained(CONSOLE_BINDINGS.map((args) => ['bind-key', ...args])))
  }

  // the console's pane as a target-pane: `=name:` — exact session match,
  // its current window, active pane. (`=name` alone is fine for session
  // commands like has-session but "can't find pane" for copy-mode/
  // send-keys; and display-message -t doesn't expand pane formats at all,
  // hence list-panes below — verified on tmux 3.4.)
  private consolePane(key: string): string {
    return `=${this.consoleName(key)}:`
  }

  private async readScroll(key: string): Promise<ConsoleScroll & { inMode: boolean }> {
    try {
      const out = await this.run(['list-panes', '-t', this.consolePane(key), '-F', '#{scroll_position} #{history_size} #{pane_height} #{pane_in_mode}'])
      return parseScrollInfo(out)
    } catch {
      throw new Error('console not open')
    }
  }

  // Where the console's view stands — for the pane's own scrollbar
  // (ConsoleScrollbar in the web). One tmux query; throws if there's no
  // such console.
  async consoleScroll(key: string): Promise<ConsoleScroll> {
    const { inMode: _inMode, ...info } = await this.readScroll(key)
    return info
  }

  // Moves the view to `position` rows above the bottom (clamped to the
  // history). tmux's copy-mode `goto-line N` sets exactly that offset. 0
  // means "back to live": copy-mode is LEFT (cancel), so what's typed
  // reaches claude again — staying in copy-mode at the bottom would
  // swallow keystrokes. Answers with where the view actually landed.
  // Types into the console's claude as if at its keyboard — tmux
  // send-keys on the pane, each entry a key name ('1', 'Enter'). Used to
  // answer an AskUserQuestion shown in the console: the TUI takes a digit
  // to pick an option and Enter to confirm. Throws if there's no console.
  // On the key's chain: two gestures never interleave their keys.
  consoleSendKeys(key: string, keys: readonly string[]): Promise<void> {
    return this.serial(key, async () => {
      await this.mustBeAlive(key)
      const t = this.consolePane(key)
      for (const k of keys) await this.run(['send-keys', '-t', t, k])
    })
  }

  // Types a prompt into the console: the text literally (`send-keys -l`, so
  // a prompt that happens to be a key name — "Enter", "C-c" — is typed, not
  // pressed), then Enter as a key. consoleSendKeys stays for key gestures.
  //
  // THE guard of every typed prompt (the class, not one route): the screen
  // is read first and, when the console's engine sees one of its dialogs on
  // it (HarnessConsole.dialogOnScreen — conservative, an unknown screen
  // passes), nothing is typed and ConsoleDialogError is thrown — that Enter
  // would answer the dialog (an Enter on «No, exit» at folder trust once
  // closed the console). consoleSendKeys is the deliberate answer to a dialog: unguarded.
  // On the key's chain: the screen check, the text and its Enter are one
  // act — another prompt's text never lands between them.
  consoleSendLiteral(key: string, text: string): Promise<void> {
    return this.serial(key, async () => {
      await this.mustBeAlive(key)
      const dialog = await this.consoleDialog(key)
      if (dialog) throw new ConsoleDialogError(dialog)
      const t = this.consolePane(key)
      // `--`: a prompt starting with `-` ("-R", "- item") is text, never a flag
      await this.run(['send-keys', '-t', t, '-l', '--', text])
      await this.run(['send-keys', '-t', t, 'Enter'])
    })
  }

  // The console's screen as the owner sees it (tmux capture-pane): the
  // only honest reading of what a TUI has SELECTED when its server does not
  // say (OpenCode's header "Build auto · <model> <provider>", tui-client
  // settleModelOnScreen). Empty when the console is gone.
  async consoleScreen(key: string): Promise<string> {
    if (!(await this.hasConsole(key))) return ''
    try {
      return await this.run(['capture-pane', '-p', '-t', this.consolePane(key)])
    } catch {
      return ''
    }
  }

  // The dialog the console's engine sees on its screen, or null. A console
  // without a Silos-owned record is the fallback engine's (Claude Code).
  async consoleDialog(key: string): Promise<ConsoleDialog | null> {
    const id = this.consoleRecord(key)?.harness ?? fallbackHarness().id
    const detect = findHarness(id)?.console.dialogOnScreen
    if (!detect) return null
    // a reading that fails is an unknown screen: the send goes on
    try {
      return detect(await this.consoleScreen(key))
    } catch {
      return null
    }
  }

  // On the key's chain: read-then-move is one act (a drag sends many).
  consoleScrollTo(key: string, position: number): Promise<ConsoleScroll> {
    return this.serial(key, async () => {
      const cur = await this.readScroll(key)
      const target = Math.max(0, Math.min(Math.floor(position), cur.history))
      const t = this.consolePane(key)
      if (target === 0) {
        if (cur.inMode) await this.run(['send-keys', '-t', t, '-X', 'cancel'])
      } else {
        // -e: leave copy-mode on scrolling past the bottom, as the wheel
        // does — entering it and moving in ONE tmux call
        await this.run(
          cur.inMode
            ? ['send-keys', '-t', t, '-X', 'goto-line', String(target)]
            : chained([
                ['copy-mode', '-e', '-t', t],
                ['send-keys', '-t', t, '-X', 'goto-line', String(target)],
              ]),
        )
      }
      return this.consoleScroll(key)
    })
  }

  // A newborn console's palette answer (console-palette.ts): Silos' own
  // short-lived tmux client — `-f ignore-size`, so it never sizes the
  // window, and outside `terminals`, so it is no WebSocket's and counts
  // against no cap — answers the TUI's OSC 4 questions and detaches.
  private answerPalette(key: string, palette: readonly string[]): void {
    const env = { ...cleanEnv(), TERM: 'xterm-256color', HOME: homedir() }
    startPaletteResponder({
      palette,
      // the reply goes to the pane's stdin by tmux itself: typed into the
      // listening client it never arrives on tmux ≥ 3.5 (console-palette.ts)
      deliver: (reply) => {
        const hex = [...Buffer.from(reply, 'latin1')].map((b) => b.toString(16).padStart(2, '0'))
        void this.run(['send-keys', '-t', this.consolePane(key), '-H', ...hex]).catch(() => {
          /* console gone: nothing to theme */
        })
      },
      spawn: () =>
        pty.spawn('tmux', ['-u', '-L', this.tmuxSocket, '-f', TMUX_CONF, 'attach-session', '-f', 'ignore-size', '-t', `=${this.consoleName(key)}`], {
          name: 'xterm-256color',
          cols: 200,
          rows: 50,
          cwd: homedir(),
          env,
        }),
    })
  }

  // A tmux client for ONE WebSocket, born at the socket's size (no 200x50
  // flash, no resize needed to get the first paint). Lives in the same map
  // as the shells so onData/write/resize/kill work unchanged; killed by
  // the WS handler when the socket closes. Its own cap, separate from the
  // shells' MAX_PTYS.
  async openConsoleClient(key: string, cols: number, rows: number): Promise<TerminalHandle> {
    // gone → 'console not open' (the socket closes 4404: the pane offers
    // Restart); unknown → ConsoleUnknownError (closed so the client retries)
    await this.mustBeAlive(key)
    if (this.consoleClientCount() >= MAX_CONSOLE_CLIENTS) throw new Error(`console client limit reached (max ${MAX_CONSOLE_CLIENTS})`)
    const env = { ...cleanEnv(), TERM: 'xterm-256color', HOME: homedir() }
    const cwd = homedir()
    const proc = pty.spawn('tmux', ['-u', '-L', this.tmuxSocket, '-f', TMUX_CONF, 'attach-session', '-t', `=${this.consoleName(key)}`], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    })
    const id = randomUUID()
    // clients: 1 and idleSince: null from birth — a console client is
    // always bound to exactly one socket, never "idle".
    const entry: TerminalEntry = { id, agentId: null, cwd, proc, clients: 1, idleSince: null, console: true }
    this.terminals.set(id, entry)
    proc.onExit(() => {
      if (this.terminals.delete(id)) this.emit('killed', id)
    })
    return { id, agentId: null, cwd }
  }

  // Tears a console down completely: the tmux session behind it (the
  // background claude) — its attached clients exit on their own, which
  // emits 'killed' for each and closes their sockets. Tied to the
  // conversation/agent lifecycle — call it when a conversation is deleted
  // or its agent archived, so no orphan claude keeps running (and
  // resuming) a trashed session. A no-op if there's no such session.
  // On the key's chain: a spawn queued behind it starts after the kill.
  killConsole(key: string): Promise<void> {
    return this.serial(key, () => this.killConsoleNow(key))
  }

  /** Several consoles torn down (an agent archived: one per conversation it
   *  ever had): ONE listing first, so only the consoles that run cost a
   *  tmux call — the rest are already over (the same bookkeeping, no fork). */
  async killConsoles(keys: Iterable<string>): Promise<void> {
    const startedAt = this.ask()
    let live: Set<string> | null = null
    try {
      live = new Set(
        (await this.run(['list-sessions', '-F', '#{session_name}']))
          .split('\n')
          .filter((n) => n.startsWith('silos-'))
          .map((n) => n.slice('silos-'.length)),
      )
    } catch (err) {
      if (tmuxSaysGone(err)) live = new Set()
    }
    for (const key of new Set(keys)) {
      // a spawn that began after the listing asked may be running: killed for real
      const mayRun = live === null || live.has(key) || this.spawnedSince(key, startedAt)
      if (mayRun) await this.killConsole(key)
      else
        await this.serial(key, async () => {
          this.forgetConsole(key)
          this.settleKill(key, true, startedAt)
        })
    }
  }

  // the bookkeeping of a console being killed (whatever tmux answers)
  private forgetConsole(key: string): void {
    // the console is gone: its agent and its native-id binding go with it,
    // so a relaunch under the same key starts clean (not "already bound")
    this.agentByKey.delete(key)
    this.removeRecord(key)
    try {
      this.consoleLife?.gone(key)
    } catch {
      /* Usage never stops a kill */
    }
    const nativeId = this.nativeIdByKey.get(key)
    if (nativeId !== undefined) {
      this.nativeIdByKey.delete(key)
      this.keyByNativeId.delete(nativeId)
    }
  }

  // `over`: tmux SAID the session is gone — only then does its turn token go
  private settleKill(key: string, over: boolean, at: Stamp): void {
    if (over) {
      this.noteLiveness(key, 'gone', at)
      this.liveTurns?.dropConsole(key)
    } else console.warn(`console ${key}: tmux gave no answer to the kill — its turn token is kept until tmux says the session is gone`)
  }

  private async killConsoleNow(key: string): Promise<void> {
    // the turn token goes only once tmux SAYS the session is over: killed
    // now, or already not there (no such session, no server). A kill that
    // timed out or failed otherwise may have left the claude running — its
    // token is kept and the next definite probe or listing collects it.
    // (The bookkeeping first, before the fork: as before, a kill forgets
    // the console's agent and binding whatever tmux answers.)
    this.forgetConsole(key)
    let over: boolean
    try {
      await this.run(['kill-session', '-t', `=${this.consoleName(key)}`])
      over = true
    } catch (err) {
      over = tmuxSaysGone(err)
    }
    this.settleKill(key, over, this.ask()) // stamped at the answer: a probe in flight across the kill never outranks it
  }

  // killConsole's counterpart for the paths that must NOT race the dying
  // claude: tmux's kill-session returns the instant the SIGHUP is sent,
  // but claude's shutdown hook still appends a `last-prompt` line to its
  // JSONL afterwards. Trash moved the file first and got an empty twin
  // resurrected at the old path (symptom: "session has no
  // cwd — cannot open console"). This one notes the pane's process tree
  // before killing and resolves once every pid is gone (or after a short
  // grace, so a stuck process can't hold the request hostage). The note and
  // the kill are one act on the key's chain; the wait is not (it only polls
  // pids — a gesture on the dying console fails on its own).
  async killConsoleAndWait(key: string, graceMs = CONSOLE_EXIT_GRACE_MS): Promise<void> {
    const pids = await this.serial(key, async () => {
      const p = await this.consolePids(key)
      await this.killConsoleNow(key)
      return p
    })
    const deadline = Date.now() + graceMs
    while (pids.some((pid) => this.isAlive(pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  }

  // Live claude processes holding `sessionId` right now, per claude's own
  // lock files (~/.claude/sessions/<pid>.json). A dead pid's leftover file
  // is ignored; unreadable files are skipped.
  holdersOf(sessionId: string): number[] {
    return this.holderDetailsOf(sessionId).map((h) => h.pid)
  }

  // Every live claude holding `sessionId` through its ~/.claude/sessions
  // lock, with WHERE it lives (harnesses/claude-code/holders.ts).
  holderDetailsOf(sessionId: string): SessionHolder[] {
    return this.holders.detailsOf(sessionId)
  }

  // Ask the holders of `sessionId` to leave and wait for them to be gone
  // (SIGHUP, then SIGTERM at half the grace); returns the pids that left.
  async closeHoldersAndWait(sessionId: string): Promise<number[]> {
    return this.holders.closeAndWait(sessionId)
  }

  // The pane's pid plus its live descendants (tmux runs the command via
  // the default shell, which may or may not exec claude in place).
  private async consolePids(key: string): Promise<number[]> {
    let root: number
    try {
      const out = await this.run(['list-panes', '-t', `=${this.consoleName(key)}`, '-F', '#{pane_pid}'])
      root = Number.parseInt(out.trim().split('\n')[0] ?? '', 10)
    } catch {
      return []
    }
    if (!Number.isFinite(root)) return []
    const all = [root]
    for (let i = 0; i < all.length; i++) {
      try {
        const kids = (await childPids(all[i]!)).trim()
        if (kids)
          all.push(
            ...kids
              .split('\n')
              .map((n) => Number.parseInt(n, 10))
              .filter(Number.isFinite),
          )
      } catch {
        // pgrep exits 1 when there are no children
      }
    }
    return all
  }

  onData(id: string, cb: (data: string) => void): () => void {
    const entry = this.terminals.get(id)
    if (!entry) throw new Error('terminal not found')
    // a sign-in replays what it already printed (the link comes first thing)
    if (entry.backlog) cb(entry.backlog)
    const disposable = entry.proc.onData(cb)
    return () => disposable.dispose()
  }

  write(id: string, data: string): void {
    const entry = this.terminals.get(id)
    if (!entry) throw new Error('terminal not found')
    entry.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.terminals.get(id)
    if (!entry) throw new Error('terminal not found')
    entry.proc.resize(cols, rows)
  }

  // A WS connected to this terminal: while at least one client is
  // attached, idleSince stays null (never considered idle). Returns false
  // if the id doesn't exist (already killed, or never existed) — the
  // caller just closes the socket.
  attach(id: string): boolean {
    const entry = this.terminals.get(id)
    if (!entry) return false
    entry.clients += 1
    entry.idleSince = null
    return true
  }

  // The last client left: marks since when it's idle — the periodic
  // reaper (sweepIdle) decides when to kill the PTY, see constructor.
  detach(id: string): void {
    const entry = this.terminals.get(id)
    if (!entry) return
    entry.clients = Math.max(0, entry.clients - 1)
    if (entry.clients === 0) entry.idleSince = Date.now()
  }

  kill(id: string): void {
    const entry = this.terminals.get(id)
    if (!entry) return
    this.terminals.delete(id)
    this.emit('killed', id) // so server.ts closes any WS still attached
    try {
      entry.proc.kill()
    } catch {
      /* the process may have already died */
    }
  }

  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id)
  }

  list(): TerminalHandle[] {
    return [...this.terminals.values()].map((t) => ({ id: t.id, agentId: t.agentId, cwd: t.cwd }))
  }
}
