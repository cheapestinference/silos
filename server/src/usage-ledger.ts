// usage-ledger.ts — the WINDOWS of Usage: one line
// when a turn or a console opens, one when it closes, in
// ~/.silos/usage/<YYYY-MM>.jsonl (the month of the line, local time).
//
// A window says WHO and WHY — agent, class (chat · console · heartbeat with
// its kind · wake · run), task, automation, run, gesture, provider, account,
// whether the provider prices — never what was spent: the tokens come only
// from the transcript (usage.ts reads them through the engine's reader and
// drops each record into the window that holds it).
//
// - A TURN opens at its chat-init (ChatService.send: before it there is no
//   session nor provider) and closes when its send ends — done, failed or
//   cancelled; `timeout` is stamped by the resident, who decides it, BEFORE
//   it cancels the turn (the first close wins).
// - A turn whose process died (here: every save under server/src) left an
//   open line: the next boot closes it `interrupted`, at the time of the
//   conversation's last record (closeInterrupted).
// - A CONSOLE opens when Silos launches its tmux and stays open while that
//   tmux lives — consoles outlive a restart, so a boot never closes one;
//   it closes when its tmux is found gone. It matches by THREAD (usage.ts):
//   a /clear rotates the session inside the same window.
//
// Append-only, 0600 in a 0700 dir; fenced from every agent (territory.ts
// DATA_DIR_DENIED) and outside the seal (seal-regimes.ts) with its reason.
// Read whole at construction and kept in memory (a line per turn).
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type WindowClass = 'chat' | 'console' | 'heartbeat' | 'wake' | 'run'
export type WindowOutcome = 'done' | 'failed' | 'cancelled' | 'timeout' | 'interrupted'
/** The heartbeat's kind, as data: q3's `round` needs no change here. */
export type WindowKind = 'look' | 'think' | 'round'
/** Whose automation a RUN window's turn served, sealed when it opened: the
 *  agent's own (counts against its daily max), its own but accepted by the
 *  owner (outside the max), or one the owner set. Deleting or accepting the
 *  automation later never rewrites a past day. */
export type RunOf = 'own' | 'accepted' | 'yours'

export interface WindowOpen {
  ev: 'open'
  id: string
  at: string
  class: WindowClass
  kind?: WindowKind
  agentId: string
  session: { folder: string; id: string }
  taskKey?: string
  automationId?: string
  runId?: string
  /** a run window: whose automation it served, sealed at the opening */
  runOf?: RunOf
  gesture?: boolean
  provider: string
  account?: string
  priced: boolean
}
export interface WindowClose {
  ev: 'close'
  id: string
  at: string
  outcome: WindowOutcome
}

/** A window as read: its open line plus its close, when there is one. */
export interface UsageWindow extends Omit<WindowOpen, 'ev'> {
  closedAt?: string
  outcome?: WindowOutcome
}

const CLASSES: ReadonlySet<string> = new Set(['chat', 'console', 'heartbeat', 'wake', 'run'])
const OUTCOMES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'timeout', 'interrupted'])
const KINDS: ReadonlySet<string> = new Set(['look', 'think', 'round'])
const RUN_OF: ReadonlySet<string> = new Set(['own', 'accepted', 'yours'])
const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
const isoOk = (v: unknown): v is string => str(v) && Number.isFinite(Date.parse(v))

function monthOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** A line as written, or null — the reader is strict: a line it does not
 *  recognise is skipped, never half-read. */
export function parseLedgerLine(line: string): WindowOpen | WindowClose | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null || !str(o.id) || !isoOk(o.at)) return null
  if (o.ev === 'close') {
    if (typeof o.outcome !== 'string' || !OUTCOMES.has(o.outcome)) return null
    return { ev: 'close', id: o.id, at: o.at, outcome: o.outcome as WindowOutcome }
  }
  if (o.ev !== 'open') return null
  if (typeof o.class !== 'string' || !CLASSES.has(o.class) || !str(o.agentId) || !str(o.provider) || typeof o.priced !== 'boolean') return null
  const s = o.session as { folder?: unknown; id?: unknown } | undefined
  if (!s || typeof s !== 'object' || typeof s.folder !== 'string' || !str(s.id)) return null
  const w: WindowOpen = {
    ev: 'open',
    id: o.id,
    at: o.at,
    class: o.class as WindowClass,
    agentId: o.agentId,
    session: { folder: s.folder, id: s.id },
    provider: o.provider,
    priced: o.priced,
  }
  if (typeof o.kind === 'string' && KINDS.has(o.kind)) w.kind = o.kind as WindowKind
  if (str(o.taskKey)) w.taskKey = o.taskKey
  if (str(o.automationId)) w.automationId = o.automationId
  if (str(o.runId)) w.runId = o.runId
  if (typeof o.runOf === 'string' && RUN_OF.has(o.runOf)) w.runOf = o.runOf as RunOf
  if (typeof o.gesture === 'boolean') w.gesture = o.gesture
  if (str(o.account)) w.account = o.account
  return w
}

/** Every event a physical line holds: itself when it parses; else each
 *  piece that starts an event (`{"ev":`) — a half-written line glued to the
 *  next one loses the broken half, never the whole one after it. */
export function salvageLedgerLine(raw: string): Array<WindowOpen | WindowClose> {
  const whole = parseLedgerLine(raw)
  if (whole) return [whole]
  const starts: number[] = []
  for (let i = raw.indexOf('{"ev":'); i !== -1; i = raw.indexOf('{"ev":', i + 1)) starts.push(i)
  const out: Array<WindowOpen | WindowClose> = []
  for (let k = 0; k < starts.length; k++) {
    const l = parseLedgerLine(raw.slice(starts[k], starts[k + 1] ?? raw.length))
    if (l) out.push(l)
  }
  return out
}

function endsMidLine(file: string): boolean {
  let fd: number | null = null
  try {
    const size = statSync(file).size
    if (size === 0) return false
    fd = openSync(file, 'r')
    const b = Buffer.alloc(1)
    readSync(fd, b, 0, 1, size - 1)
    return b[0] !== 0x0a
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export interface UsageLedgerOptions {
  now?: () => number
}

export class UsageLedger {
  private byId = new Map<string, UsageWindow>()
  private order: string[] = []
  private now: () => number

  constructor(
    private dir: string,
    opts: UsageLedgerOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.load()
  }

  /** Every window, oldest first. */
  windows(): UsageWindow[] {
    return this.order.map((id) => this.byId.get(id)!).filter(Boolean)
  }

  get(id: string): UsageWindow | null {
    return this.byId.get(id) ?? null
  }

  /** When the register starts: the first window's opening (ms), or null —
   *  what came before is «before <date>», never filled in. */
  since(): number | null {
    let min: number | null = null
    for (const w of this.byId.values()) {
      const t = Date.parse(w.at)
      if (min === null || t < min) min = t
    }
    return min
  }

  /** Opens a window. An id already known is never opened twice (a console
   *  relaunched under the same key opens a new id — see consoleWindowId). */
  open(w: Omit<WindowOpen, 'ev' | 'at'> & { at?: string }): boolean {
    if (this.byId.has(w.id)) return false
    const line: WindowOpen = { ev: 'open', ...w, at: w.at ?? new Date(this.now()).toISOString() }
    const parsed = parseLedgerLine(JSON.stringify(line))
    if (!parsed || parsed.ev !== 'open') return false
    if (!this.append(parsed)) return false
    this.place(parsed)
    return true
  }

  /** Closes an open window — the first close wins (the resident's `timeout`
   *  lands before the cancelled turn's own end). false: unknown or closed. */
  close(id: string, outcome: WindowOutcome, at?: string): boolean {
    const w = this.byId.get(id)
    if (!w || w.closedAt !== undefined) return false
    const line: WindowClose = { ev: 'close', id, at: at ?? new Date(this.now()).toISOString(), outcome }
    if (!this.append(line)) return false
    w.closedAt = line.at
    w.outcome = outcome
    return true
  }

  /** Open TURN windows (never a console's: it lives while its tmux does). */
  openTurns(): UsageWindow[] {
    return this.windows().filter((w) => w.closedAt === undefined && w.class !== 'console')
  }

  /** Open console windows. */
  openConsoles(): UsageWindow[] {
    return this.windows().filter((w) => w.closedAt === undefined && w.class === 'console')
  }

  private place(l: WindowOpen | WindowClose): void {
    if (l.ev === 'open') {
      if (this.byId.has(l.id)) return
      const { ev: _ev, ...rest } = l
      this.byId.set(l.id, { ...rest })
      this.order.push(l.id)
      return
    }
    const w = this.byId.get(l.id)
    if (w && w.closedAt === undefined) {
      w.closedAt = l.at
      w.outcome = l.outcome
    }
  }

  private append(line: WindowOpen | WindowClose): boolean {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const file = join(this.dir, `${monthOf(Date.parse(line.at))}.jsonl`)
      // a line half-written by a dying process must not swallow this one:
      // the file ends in a newline before anything is appended
      appendFileSync(file, (endsMidLine(file) ? '\n' : '') + JSON.stringify(line) + '\n', { mode: 0o600 })
      chmodSync(file, 0o600)
      return true
    } catch (err) {
      console.warn('usage: could not write the ledger —', err instanceof Error ? err.message : err)
      return false
    }
  }

  private load(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
        .filter((n) => MONTH_FILE.test(n))
        .sort()
    } catch {
      return
    }
    for (const n of names) {
      let text: string
      try {
        text = readFileSync(join(this.dir, n), 'utf8')
      } catch {
        continue
      }
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue
        for (const l of salvageLedgerLine(raw)) this.place(l)
      }
    }
  }
}

/** A console window's id: its key plus when it was launched — a relaunch
 *  under the same key is a new window. */
export function consoleWindowId(key: string, atMs: number): string {
  return `console:${key}:${atMs}`
}
