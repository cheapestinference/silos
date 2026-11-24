// account-load.ts — "who is on my Claude subscription right now", read
// from the process table and nothing else.
//
// Once a 429 hit the owner's subscription while it was shared by ten
// Silos consoles, two claude children of the claude-mem plugin's daemon,
// SDK chats and nested `claude -p` runs — and nothing in Silos said so.
// Home now answers in one line, literally: every `claude` process this
// user runs, classified by where it came from and which account it rides.
//
// Privacy rule: /proc/<pid>/environ holds API keys. Only FOUR names are
// ever picked from it (ENV_NAMES below), only for Claude processes, and
// nothing else is kept, logged or returned. Ancestors are read by
// stat/cmdline only.
import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const ENV_NAMES = ['CLAUDE_CONFIG_DIR', 'SILOS_AGENT_ID', 'SILOS_SESSION_ID', 'TMUX'] as const
export type PickedEnv = Partial<Record<(typeof ENV_NAMES)[number], string>>

export interface ProcEntry {
  pid: number
  ppid: number
  argv: string[]
  env: PickedEnv // empty for non-Claude processes
}

export type Source = 'console' | 'silos' | 'nested' | 'outside'

export interface AccountLoadEntry {
  account: string
  total: number
  bySource: Record<Source, number>
  outside: Array<{ label: string; count: number }>
  consoles: Array<{ agentId?: string; count: number }>
}

export type AccountLoad =
  // truncated: the scan hit its cap on the owner's own pids — the counts are a floor
  { supported: true; at: number; truncated: boolean; accounts: AccountLoadEntry[] } | { supported: false }

export interface ProcTable {
  procs: ProcEntry[]
  truncated: boolean
}

const DEFAULT_MAX_PIDS = 4000
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'tcsh', 'csh', 'env', 'sudo', 'su', 'login', 'nohup', 'setsid', 'timeout', 'script'])

// A Claude process is one whose argv0 IS claude (bare or a path ending in
// /claude). A shell wrapper (`bash -c '… claude …'`) is not, and neither is
// an npm-installed claude run as `node …/bin/claude` (argv0 is node).
export function isClaudeArgv(argv: readonly string[]): boolean {
  return argv.length > 0 && basename(argv[0] ?? '') === 'claude'
}

function pickEnv(raw: string): PickedEnv {
  const out: PickedEnv = {}
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const name = entry.slice(0, eq)
    if ((ENV_NAMES as readonly string[]).includes(name)) out[name as (typeof ENV_NAMES)[number]] = entry.slice(eq + 1)
  }
  return out
}

// /proc/<pid>/stat: "pid (comm) S ppid …" — comm may hold spaces and
// parens ("(tmux: server)"), so the fields start after the LAST ')'.
function ppidOf(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const fields = stat.slice(close + 2).split(' ')
  const ppid = Number(fields[1])
  return Number.isInteger(ppid) ? ppid : null
}

// The process table of ONE user (other uids skipped), capped on THAT
// user's pids (other users' never eat the budget); `truncated` says the
// cap was hit. null when
// the root is unreadable (not Linux, /proc hidden) — the caller says
// "unsupported", never an empty "nobody is on it".
export function readProcTable(procRoot = '/proc', opts: { uid?: number; maxPids?: number } = {}): ProcTable | null {
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1)
  const max = opts.maxPids ?? DEFAULT_MAX_PIDS
  let names: string[]
  try {
    names = readdirSync(procRoot)
  } catch {
    return null
  }
  const out: ProcEntry[] = []
  let owned = 0
  let truncated = false
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const dir = join(procRoot, name)
    try {
      if (statSync(dir).uid !== uid) continue
      if (++owned > max) {
        truncated = true
        break
      }
      const ppid = ppidOf(readFileSync(join(dir, 'stat'), 'utf8'))
      if (ppid === null) continue
      const argv = readFileSync(join(dir, 'cmdline'), 'utf8').split('\0')
      while (argv.length > 0 && argv[argv.length - 1] === '') argv.pop()
      let env: PickedEnv = {}
      if (isClaudeArgv(argv)) {
        try {
          env = pickEnv(readFileSync(join(dir, 'environ'), 'utf8'))
        } catch {
          env = {}
        }
      }
      out.push({ pid: Number(name), ppid, argv, env })
    } catch {
      // the process exited mid-scan, or is not ours to read
    }
  }
  return { procs: out, truncated }
}

export interface ClassifyInput {
  procs: readonly ProcEntry[]
  selfPid: number // Silos' own server: SDK chats and automation runs descend from it
  tmuxSocket: string // Silos' console socket name (`tmux -L <name>`)
  accounts: ReadonlyArray<{ name: string; configDir: string }> // 'default' first = the machine's ~/.claude
  home: string
  now?: number
  truncated?: boolean
}

function canon(p: string): string {
  const r = resolve(p)
  try {
    return realpathSync(r)
  } catch {
    return r
  }
}

function emptyBySource(): Record<Source, number> {
  return { console: 0, silos: 0, nested: 0, outside: 0 }
}

// A launcher label must never carry a process's arguments (a rewritten
// title like "x.py --token=abc" holds them): the program only — cut at the
// first whitespace or ':', basename, [\w.@+-] only, at most 32 chars.
export function launcherName(argv0: string): string {
  const head = argv0.split(/[\s:]/)[0] ?? ''
  return basename(head)
    .replace(/^-/, '')
    .replace(/[^\w.@+-]/g, '')
    .slice(0, 32)
}

export function classifyAccountLoad(input: ClassifyInput): { supported: true; at: number; truncated: boolean; accounts: AccountLoadEntry[] } {
  const byPid = new Map<number, ProcEntry>()
  for (const p of input.procs) byPid.set(p.pid, p)
  const ancestorsOf = (p: ProcEntry): ProcEntry[] => {
    const out: ProcEntry[] = []
    const seen = new Set<number>([p.pid])
    let cur = byPid.get(p.ppid)
    while (cur && !seen.has(cur.pid)) {
      out.push(cur)
      seen.add(cur.pid)
      cur = byPid.get(cur.ppid)
    }
    return out
  }
  const isSilosTmux = (a: ProcEntry): boolean => {
    if (basename(a.argv[0] ?? '') !== 'tmux') return false
    for (let i = 1; i < a.argv.length; i++) {
      const arg = a.argv[i]
      if (arg === '-L' && a.argv[i + 1] === input.tmuxSocket) return true
      if (arg === `-L${input.tmuxSocket}`) return true
    }
    return false
  }
  const tmuxEnvIsSilos = (tmux: string | undefined): boolean => {
    if (!tmux) return false
    const path = tmux.split(',')[0] ?? ''
    return path === input.tmuxSocket || path.endsWith(`/${input.tmuxSocket}`)
  }
  const pluginRoots = Array.from(new Set([join(input.home, '.claude'), ...input.accounts.map((a) => a.configDir)])).map(
    (d) => `${d.replace(/\/+$/, '')}/plugins/cache/`,
  )
  const pluginOf = (a: ProcEntry): string | null => {
    for (const arg of a.argv) {
      for (const root of pluginRoots) {
        const i = arg.indexOf(root)
        if (i < 0) continue
        const parts = arg.slice(i + root.length).split('/')
        // <owner>/<name>/… — the plugin's name is the second segment
        if (parts.length >= 3 && parts[0] && parts[1]) return `${parts[1]} plugin`
      }
    }
    return null
  }
  const outsideLabel = (anc: ProcEntry[]): string => {
    for (const a of anc) {
      const plugin = pluginOf(a)
      if (plugin) return plugin
    }
    for (const a of anc) {
      if (a.pid <= 1) break // reparented to init: no launcher left to name
      // "-bash" = a login shell; "sshd: op@pts/0" = a rewritten title, named by its program
      const b = launcherName(a.argv[0] ?? '')
      if (b && !SHELLS.has(b)) return b
    }
    return 'terminal'
  }

  // The NEAREST launcher decides, walking up: a claude (→ nested when it
  // carries SILOS_SESSION_ID, else outside), Silos' own server (→ silos),
  // Silos' tmux server (→ console). Env alone can lie — a Silos server
  // started from inside a console hands its TMUX to every SDK child, and a
  // `claude -p` inside a console inherits TMUX too — so the TMUX value is
  // only a fallback when the ancestry names none of the three.
  const sourceOf = (p: ProcEntry, anc: ProcEntry[]): Source => {
    for (const a of anc) {
      if (isClaudeArgv(a.argv)) return p.env.SILOS_SESSION_ID ? 'nested' : 'outside'
      if (a.pid === input.selfPid) return 'silos'
      if (isSilosTmux(a)) return 'console'
    }
    return tmuxEnvIsSilos(p.env.TMUX) ? 'console' : 'outside'
  }

  const accountDirs = input.accounts.map((a) => ({ name: a.name, dir: canon(a.configDir) }))
  const defaultName = input.accounts[0]?.name ?? 'default'
  const accountOf = (env: PickedEnv): string => {
    const raw = env.CLAUDE_CONFIG_DIR
    if (!raw) return defaultName
    const dir = canon(raw)
    const hit = accountDirs.find((a) => a.dir === dir)
    if (hit) return hit.name
    // a config dir that is no Silos account: named by its path, home-relative
    return dir.startsWith(`${input.home}/`) ? `~${dir.slice(input.home.length)}` : dir
  }

  const acc = new Map<string, { bySource: Record<Source, number>; outside: Map<string, number>; consoles: Map<string, number> }>()
  for (const p of input.procs) {
    if (!isClaudeArgv(p.argv)) continue
    const anc = ancestorsOf(p)
    const source = sourceOf(p, anc)
    const name = accountOf(p.env)
    let a = acc.get(name)
    if (!a) {
      a = { bySource: emptyBySource(), outside: new Map(), consoles: new Map() }
      acc.set(name, a)
    }
    a.bySource[source]++
    if (source === 'outside') {
      const label = outsideLabel(anc)
      a.outside.set(label, (a.outside.get(label) ?? 0) + 1)
    } else if (source === 'console') {
      const id = p.env.SILOS_AGENT_ID ?? ''
      a.consoles.set(id, (a.consoles.get(id) ?? 0) + 1)
    }
  }

  const order = new Map(input.accounts.map((a, i) => [a.name, i]))
  const desc = <T extends { count: number }>(xs: T[]): T[] => xs.sort((x, y) => y.count - x.count)
  const accounts: AccountLoadEntry[] = [...acc.entries()]
    .sort(([x], [y]) => (order.get(x) ?? 1e9) - (order.get(y) ?? 1e9) || x.localeCompare(y))
    .map(([account, a]) => ({
      account,
      total: a.bySource.console + a.bySource.silos + a.bySource.nested + a.bySource.outside,
      bySource: a.bySource,
      outside: desc([...a.outside].map(([label, count]) => ({ label, count }))),
      consoles: desc([...a.consoles].map(([id, count]) => (id ? { agentId: id, count } : { count }))),
    }))
  return { supported: true, at: input.now ?? Date.now(), truncated: input.truncated ?? false, accounts }
}

export interface AccountLoadOpts {
  tmuxSocket: string
  accounts: () => ReadonlyArray<{ name: string; configDir: string }>
  home: string
  procRoot?: string
  selfPid?: number
  uid?: number
  platform?: NodeJS.Platform
  ttlMs?: number
  now?: () => number
}

// The route's source: one /proc scan per ttl (5 s), so a Home poll is cheap.
export class AccountLoadService {
  private cache: { at: number; value: AccountLoad } | null = null
  constructor(private opts: AccountLoadOpts) {}

  snapshot(): AccountLoad {
    const now = (this.opts.now ?? Date.now)()
    if (this.cache && now - this.cache.at < (this.opts.ttlMs ?? 5000)) return this.cache.value
    const value = this.read(now)
    this.cache = { at: now, value }
    return value
  }

  private read(now: number): AccountLoad {
    if ((this.opts.platform ?? process.platform) !== 'linux') return { supported: false }
    const table = readProcTable(this.opts.procRoot ?? '/proc', this.opts.uid === undefined ? {} : { uid: this.opts.uid })
    if (table === null) return { supported: false }
    return classifyAccountLoad({
      procs: table.procs,
      truncated: table.truncated,
      selfPid: this.opts.selfPid ?? process.pid,
      tmuxSocket: this.opts.tmuxSocket,
      accounts: this.opts.accounts(),
      home: this.opts.home,
      now,
    })
  }
}
