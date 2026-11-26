// harnesses/claude-code/holders.ts — WHO else holds a conversation open, and where it
// lives. Every running `claude` writes a lock under ~/.claude/sessions
// (`<pid>.json`) naming its session id; Silos reads those to refuse moving
// a JSONL a live claude would recreate (trash) or resuming a session twice
// (console). The lock also says WHERE that claude runs — the tmux target
// claude detected, its derived name, cwd, status — and a refusal that
// names the place beats one that names a pid: "a live claude (pid N)
// still holds this conversation" read as "another conversation is
// running" (e.g. a leftover auto-retry tmux from the night before).

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SessionHolder {
  pid: number
  /** the tmux SESSION name claude saw itself in (window/pane suffix dropped), or null */
  tmux: string | null
  /** claude's derived session name (`acme-91`), or null */
  name: string | null
  cwd: string | null
  kind: string | null
  status: string | null
  startedAt: number | null
  updatedAt: number | null
  /** the CLAUDE_CONFIG_DIR this claude runs under (null = the machine's
   *  ~/.claude) — WHICH account it spends, read from the live process */
  configDir: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Parse one lock file; null unless it names `sessionId` and its pid is
 *  alive AND still the process that wrote it. claude stamps `procStart`
 *  (the kernel's start ticks of its own process) into the lock exactly so
 *  a reused pid can be told from the claude that died: without the check a
 *  crashed claude's lock + an innocent process on its recycled pid read as
 *  «a claude outside Silos still holds this conversation», and «Close and
 *  open here» SIGHUPed that innocent process, waited the grace out and
 *  dead-ended on «it did not exit when asked». `startTicksOf` null (off
 *  Linux, or unreadable) stays conservative: the lock stands. */
export function readHolderLock(
  raw: string,
  sessionId: string,
  isAlive: (pid: number) => boolean,
  startTicksOf?: (pid: number) => string | null,
): SessionHolder | null {
  let o: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    o = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof o.pid !== 'number' || o.sessionId !== sessionId || !isAlive(o.pid)) return null
  const lockTicks = typeof o.procStart === 'string' ? o.procStart : typeof o.procStart === 'number' ? String(o.procStart) : null
  if (lockTicks !== null && startTicksOf) {
    const current = startTicksOf(o.pid)
    if (current !== null && current !== lockTicks) return null // the pid was reused: this is not that claude
  }
  // claude writes `session:@window.%pane`; the session is the only part a
  // person can look for (`tmux attach -t …`)
  const tmuxRaw = str(o.tmux)
  const tmux = tmuxRaw ? tmuxRaw.split(':')[0] || null : null
  return {
    pid: o.pid,
    tmux,
    name: str(o.name),
    cwd: str(o.cwd),
    kind: str(o.kind),
    status: str(o.status),
    startedAt: num(o.startedAt),
    updatedAt: num(o.updatedAt),
    configDir: null,
  }
}

/** A Silos console is a tmux session Silos itself named (`silos-<key>`). */
export function isSilosConsole(h: SessionHolder): boolean {
  return h.tmux !== null && h.tmux.startsWith('silos-')
}

function placeOf(h: SessionHolder): string {
  if (h.tmux) return `tmux "${h.tmux}" (pid ${h.pid})`
  if (h.name) return `"${h.name}" (pid ${h.pid})`
  return `pid ${h.pid}`
}

function idleOf(h: SessionHolder, now: number): string | null {
  if (!h.status || h.updatedAt === null) return null
  const ms = now - h.updatedAt
  if (ms < 60_000) return null
  const h2 = Math.round(ms / 3_600_000)
  return h2 >= 1 ? `${h.status} for ${h2} h` : `${h.status} for ${Math.round(ms / 60_000)} min`
}

/**
 * One line for the refusal: who (a Silos console / a claude outside Silos),
 * where (tmux session, derived name or pid) and, when the lock says so, for
 * how long it has been sitting there.
 */
export function describeHolders(holders: SessionHolder[], now: number): string {
  const places = holders.map((h) => {
    const idle = idleOf(h, now)
    return idle ? `${placeOf(h)}, ${idle}` : placeOf(h)
  })
  const allSilos = holders.length > 0 && holders.every(isSilosConsole)
  const who =
    holders.length === 1
      ? allSilos
        ? 'a Silos console'
        : 'a claude started outside Silos'
      : `${holders.length} claudes${allSilos ? ' in Silos consoles' : ' started outside Silos'}`
  const verb = holders.length === 1 ? 'holds' : 'hold'
  return `${who} still ${verb} this conversation — ${places.join('; ')}`
}

/** A live process's CLAUDE_CONFIG_DIR — the ONE name read from its
 *  environ (the same privacy rule as account-load.ts: the environ holds
 *  keys; nothing else is picked, kept or logged). null = unset, not ours,
 *  or unreadable. */
export function procConfigDir(pid: number, procRoot = '/proc'): string | null {
  try {
    const raw = readFileSync(join(procRoot, String(pid), 'environ'), 'utf8')
    for (const entry of raw.split('\0')) {
      if (entry.startsWith('CLAUDE_CONFIG_DIR=')) return entry.slice('CLAUDE_CONFIG_DIR='.length) || null
    }
  } catch {
    /* gone, or another user's */
  }
  return null
}

/** The start of the process now at `pid`, in the kernel's own ticks —
 *  /proc/<pid>/stat field 22, the clock claude stamps into its lock as
 *  `procStart`. Parsed after the last ')' (comm may hold spaces and
 *  parens). null off Linux or when unreadable. */
export function procStartTicks(pid: number, procRoot = '/proc'): string | null {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    return (
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[19] ?? null
    )
  } catch {
    return null
  }
}

/** Where every running claude files its lock (`<pid>.json`). */
export const CLAUDE_SESSIONS_DIR = (): string => join(homedir(), '.claude', 'sessions')

/** The holders of a conversation, read from claude's own lock files, and
 *  how they are asked to leave (TerminalService delegates here). */
export class ClaudeHolders {
  private readonly sessionsDir: string
  private readonly isAlive: (pid: number) => boolean
  private readonly signal: (pid: number, sig: NodeJS.Signals) => void
  private readonly graceMs: number
  private readonly configDirOf: (pid: number) => string | null
  private readonly startTicksOf: (pid: number) => string | null

  constructor(o: {
    sessionsDir: string
    isAlive: (pid: number) => boolean
    signal: (pid: number, sig: NodeJS.Signals) => void
    graceMs: number
    configDirOf?: (pid: number) => string | null
    startTicksOf?: (pid: number) => string | null
  }) {
    this.sessionsDir = o.sessionsDir
    this.isAlive = o.isAlive
    this.signal = o.signal
    this.graceMs = o.graceMs
    this.configDirOf = o.configDirOf ?? ((pid) => procConfigDir(pid))
    this.startTicksOf = o.startTicksOf ?? ((pid) => procStartTicks(pid))
  }

  // Every live claude holding `sessionId` through its ~/.claude/sessions
  // lock, with WHERE it lives (tmux session, derived name, cwd, status) —
  // the refusal names the place, not just a pid.
  detailsOf(sessionId: string): SessionHolder[] {
    let names: string[]
    try {
      names = readdirSync(this.sessionsDir)
    } catch {
      return []
    }
    const out: SessionHolder[] = []
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      let raw: string
      try {
        raw = readFileSync(join(this.sessionsDir, n), 'utf8')
      } catch {
        continue // junk file
      }
      const h = readHolderLock(raw, sessionId, this.isAlive, this.startTicksOf)
      if (h) out.push({ ...h, configDir: this.configDirOf(h.pid) })
    }
    return out
  }

  // Ask the holders of `sessionId` to leave and wait for them to be gone:
  // SIGHUP first (claude's clean shutdown — the lock is released by claude
  // itself), SIGTERM once half the grace has passed with it still alive.
  // Returns the pids that left; whatever is still alive afterwards is read
  // back by the caller through detailsOf (an honest second refusal).
  async closeAndWait(sessionId: string): Promise<number[]> {
    const holders = this.detailsOf(sessionId)
    if (holders.length === 0) return []
    const pids = holders.map((h) => h.pid)
    for (const pid of pids) {
      try {
        this.signal(pid, 'SIGHUP')
      } catch {
        /* already gone */
      }
    }
    const started = Date.now()
    const deadline = started + this.graceMs
    let termed = false
    while (pids.some((pid) => this.isAlive(pid)) && Date.now() < deadline) {
      if (!termed && Date.now() - started > this.graceMs / 2) {
        termed = true
        for (const pid of pids) {
          if (this.isAlive(pid)) {
            try {
              this.signal(pid, 'SIGTERM')
            } catch {
              /* gone */
            }
          }
        }
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    return pids.filter((pid) => !this.isAlive(pid))
  }
}
