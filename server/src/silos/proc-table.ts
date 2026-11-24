// silos/proc-table.ts — the process table the kernel kind `process` reads
// (silos/processes.ts), behind an interface: tests hand the engine a fake
// table, never the real /proc.
//
// The Linux reader reads /proc and nothing else — no `ps`, no shell-out. It
// is ASYNC and BOUNDED (this server once froze 14 min on one sync tmux
// call; tmux is async now too — terminal-service.ts tmuxExec): every read is
// a promise, a few at a time,
// capped in processes and in fd links per scan, and every read tolerates the
// process vanishing mid-read (it is simply not in the table).
//
// Privacy (the account-load.ts rule): /proc/<pid>/environ holds secrets. Only
// the names the caller passes (the session-id keys) are ever picked from it;
// nothing else is kept, logged or returned. The command line is returned raw
// — the engine redacts it before it is stored or served (processes.ts
// redactCommand).
//
// Only THIS user's processes are read (another user's environ, cwd and fds
// can't be read anyway). A listening socket another user owns is returned
// with its uid and no pid: the engine says so plainly.
import { readdir, readFile, readlink, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface ProcEntry {
  pid: number
  ppid: number
  startTicks: number // field 22 of /proc/<pid>/stat: start time in clock ticks since boot
  startedAt: number // the same, as an epoch ms
  comm: string
  argv: string[]
  cwd: string | null
  cpuSeconds: number // utime + stime
  rssBytes: number
  // ONLY the asked keys present in its environment (the session-id keys)
  env: Record<string, string>
}

export interface ListenerEntry {
  port: number
  uid: number
  user: string | null // the uid's name in /etc/passwd, when it has one
  pids: number[] // the processes holding the socket; [] = its owner can't be read
}

export interface ProcTable {
  at: number
  uid: number // whose processes these are (this server's user)
  procs: ProcEntry[]
  listeners: ListenerEntry[]
  // false when a cap cut the scan: the engine concludes no exits from it
  complete: boolean
}

export interface ProcessTableReader {
  // null = this platform has no /proc: no data, and nothing said about it
  read(envKeys: readonly string[]): Promise<ProcTable | null>
  // which of these processes are STILL the same process: alive (not a
  // zombie) with the same start time — a pid reused by a stranger is not
  // one of them. What a stop asks between its signals, one stat each.
  // Absent: the stop asks read() for the whole table instead.
  alive?(ps: ReadonlyArray<{ pid: number; startTicks: number }>): Promise<Array<{ pid: number; startTicks: number }>>
}

// /proc/<pid>/stat: "pid (comm) S ppid …" — comm may hold spaces and parens
// ("(tmux: server)"), so the fields start after the LAST ')'.
export function parseStat(raw: string): { comm: string; state: string; ppid: number; startTicks: number; cpuTicks: number; rssPages: number } | null {
  const open = raw.indexOf('(')
  const close = raw.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const f = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  // f[0] = state (field 3) → field n is f[n - 3]
  const n = (i: number): number => Number(f[i - 3])
  const ppid = n(4)
  const startTicks = n(22)
  const cpuTicks = n(14) + n(15)
  const rssPages = n(24)
  if (![ppid, startTicks, cpuTicks, rssPages].every(Number.isFinite)) return null
  return { comm: raw.slice(open + 1, close), state: f[0] ?? '', ppid, startTicks, cpuTicks, rssPages }
}

// /proc/net/tcp{,6}: the LISTEN rows (state 0A) — local port, uid, inode.
export function parseNetTcp(raw: string): Array<{ port: number; uid: number; inode: number }> {
  const out: Array<{ port: number; uid: number; inode: number }> = []
  for (const line of raw.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== '0A') continue
    const port = Number.parseInt((f[1] ?? '').split(':').pop() ?? '', 16)
    const uid = Number(f[7])
    const inode = Number(f[9])
    if (!Number.isFinite(port) || !Number.isFinite(uid) || !Number.isFinite(inode) || inode === 0) continue
    out.push({ port, uid, inode })
  }
  return out
}

// only the asked names, never another value
export function pickEnv(raw: string, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (keys.length === 0) return out
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const name = entry.slice(0, eq)
    if (keys.includes(name) && entry.length > eq + 1) out[name] = entry.slice(eq + 1)
  }
  return out
}

export interface LinuxProcOptions {
  procRoot?: string
  passwd?: string
  maxProcs?: number // this user's processes read per scan
  maxFdLinks?: number // fd links followed per scan (listening-socket owners)
  concurrency?: number
  // Linux's USER_HZ and page size on every architecture Silos runs on
  ticksPerSecond?: number
  pageBytes?: number
}

const DEFAULT_MAX_PROCS = 4000
const DEFAULT_MAX_FD_LINKS = 40_000
const DEFAULT_CONCURRENCY = 16

// run `fn` over `items`, `n` at a time
async function eachLimited<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const t = items[i++]!
      try {
        await fn(t)
      } catch {
        /* a vanished process is not in the table */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

export function linuxProcTable(o: LinuxProcOptions = {}): ProcessTableReader {
  const root = o.procRoot ?? '/proc'
  const hz = o.ticksPerSecond ?? 100
  const page = o.pageBytes ?? 4096
  const maxProcs = o.maxProcs ?? DEFAULT_MAX_PROCS
  const maxFd = o.maxFdLinks ?? DEFAULT_MAX_FD_LINKS
  const conc = o.concurrency ?? DEFAULT_CONCURRENCY
  const me = typeof process.getuid === 'function' ? process.getuid() : -1
  return {
    async alive(ps) {
      const out: Array<{ pid: number; startTicks: number }> = []
      await eachLimited(ps, conc, async (p) => {
        const s = parseStat(await readFile(join(root, String(p.pid), 'stat'), 'utf8'))
        // a zombie (Z) or a dead entry (X) has exited: only its parent's wait is missing
        if (s && s.startTicks === p.startTicks && s.state !== 'Z' && s.state !== 'X') out.push({ pid: p.pid, startTicks: p.startTicks })
      })
      return out
    },
    async read(envKeys) {
      if (process.platform !== 'linux' && o.procRoot === undefined) return null
      let bootMs: number
      try {
        const m = /^btime\s+(\d+)/m.exec(await readFile(join(root, 'stat'), 'utf8'))
        if (!m) return null
        bootMs = Number(m[1]) * 1000
      } catch {
        return null // no /proc here
      }
      const at = Date.now()
      let complete = true
      let names: string[]
      try {
        names = (await readdir(root)).filter((n) => /^\d+$/.test(n))
      } catch {
        return null
      }
      // this user's pids (a stat each — another user's never eat the budget)
      const mine: number[] = []
      await eachLimited(names, conc * 2, async (n) => {
        const st = await stat(join(root, n))
        if (st.uid === me) mine.push(Number(n))
      })
      mine.sort((a, b) => a - b)
      if (mine.length > maxProcs) {
        complete = false
        mine.length = maxProcs
      }
      const procs: ProcEntry[] = []
      await eachLimited(mine, conc, async (pid) => {
        const dir = join(root, String(pid))
        const s = parseStat(await readFile(join(dir, 'stat'), 'utf8'))
        if (!s) return
        const cmdline = await readFile(join(dir, 'cmdline'), 'utf8').catch(() => '')
        const argv = cmdline.split('\0')
        if (argv[argv.length - 1] === '') argv.pop()
        if (argv.length === 0) return // a kernel thread or a zombie: nothing to say
        const env = envKeys.length > 0 ? pickEnv(await readFile(join(dir, 'environ'), 'utf8').catch(() => ''), envKeys) : {}
        const cwd = await readlink(join(dir, 'cwd')).catch(() => null)
        procs.push({
          pid,
          ppid: s.ppid,
          startTicks: s.startTicks,
          startedAt: Math.round(bootMs + (s.startTicks / hz) * 1000),
          comm: s.comm,
          argv,
          cwd,
          cpuSeconds: s.cpuTicks / hz,
          rssBytes: s.rssPages * page,
          env,
        })
      })
      // the listening sockets, and whose they are
      const rows: Array<{ port: number; uid: number; inode: number }> = []
      for (const f of ['tcp', 'tcp6']) {
        try {
          rows.push(...parseNetTcp(await readFile(join(root, 'net', f), 'utf8')))
        } catch {
          /* no IPv6, or no net */
        }
      }
      const want = new Map<number, number[]>() // inode → holders (this user's sockets only)
      for (const r of rows) if (r.uid === me) want.set(r.inode, [])
      if (want.size > 0) {
        let links = 0
        let left = want.size
        const found = new Set<number>()
        await eachLimited(
          procs.map((p) => p.pid),
          conc,
          async (pid) => {
            if (left === 0 || links >= maxFd) return
            const fdDir = join(root, String(pid), 'fd')
            const fds = await readdir(fdDir)
            for (const fd of fds) {
              if (links >= maxFd) {
                complete = false
                return
              }
              links++
              const target = await readlink(join(fdDir, fd)).catch(() => '')
              const m = /^socket:\[(\d+)\]$/.exec(target)
              if (!m) continue
              const holders = want.get(Number(m[1]))
              if (!holders) continue
              if (!holders.includes(pid)) holders.push(pid)
              if (!found.has(Number(m[1]))) {
                found.add(Number(m[1]))
                left--
              }
            }
          },
        )
      }
      let users: Map<number, string> | null = null
      const userOf = async (uid: number): Promise<string | null> => {
        if (!users) {
          users = new Map()
          try {
            for (const line of (await readFile(o.passwd ?? '/etc/passwd', 'utf8')).split('\n')) {
              const f = line.split(':')
              if (f.length > 2 && f[0] && /^\d+$/.test(f[2] ?? '')) users.set(Number(f[2]), f[0])
            }
          } catch {
            /* no names: the uid speaks */
          }
        }
        return users.get(uid) ?? null
      }
      // one entry per (port, uid): IPv4 and IPv6 rows of one port fold
      const byPort = new Map<string, ListenerEntry>()
      for (const r of rows) {
        const k = `${r.port}/${r.uid}`
        const e = byPort.get(k) ?? { port: r.port, uid: r.uid, user: await userOf(r.uid), pids: [] }
        for (const pid of r.uid === me ? (want.get(r.inode) ?? []) : []) if (!e.pids.includes(pid)) e.pids.push(pid)
        byPort.set(k, e)
      }
      // this user's socket whose holder was not found this scan (raced, or
      // the fd cap) says nothing — only another user's is «can't be read»
      const listeners = [...byPort.values()].filter((l) => l.uid !== me || l.pids.length > 0)
      return { at, uid: me, procs, listeners, complete }
    },
  }
}
