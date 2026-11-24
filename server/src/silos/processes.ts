// silos/processes.ts — the kernel kind `process` (the built-in System silo,
// docs/standard/reference/system.silo.json): the processes the owner's
// conversations left running on this machine, with each conversation's title
// and the ports they hold. Moment 1 «What's happening?»: «why is this
// machine's CPU maxed?» was answered by builds, tests and dev servers that
// conversations had launched — some of them orphans whose conversation was
// long gone.
//
// WHAT IS A RECORD. Not every process: a test worker that lives 2 s is not a
// case (limits.ts: a window is a gauge, the episode is the case). One record
// per PROCESS TREE ROOT that either
//   (a) carries a conversation's session id in its environment and was seen
//       alive across scans for MIN_ALIVE_MS, or
//   (b) holds a listening TCP port — recorded at once, conversation or not
//       (a listener another user owns is a record that says so, with its
//       port and no command).
//
// ATTRIBUTION. Every process a conversation starts inherits the session id
// in its environment and keeps it when orphaned (reparented to init): Silos'
// own SILOS_SESSION_ID (consoles and chats Silos launched; OpenCode's shells
// through Silos' plugin) and the variables each ENGINE declares it sets
// itself (Harness.traits.sessionEnvKeys — this module names no engine). Only
// those names are read from a process's environment.
//
// THE ENGINE IS NOT A RECORD. The engine process of a conversation (any
// registered harness's binary — isEngineProcess) is the conversation, not something
// it left: it never becomes a record, its subtree is never folded into one,
// and a process whose ancestor is a live engine — or whose session an engine
// process alive in the table carries — has a conversation that runs.
//
// TREE ROOTS. Among the processes carrying a session (engines excluded), a
// root is one whose parent does not carry one. A root that is a bare shell
// wrapper (`sh -c …`, `bash -c …`) waiting on exactly one child is replaced
// by that child, repeatedly — the record is the thing, not its wrapper.
// Descendants fold into the root: `processes`, summed cpu and memory, the
// union of ports.
//
// STATES. running — its conversation runs now (a turn, a live console, a
// live holder: the Silos side, `conversations`; or an engine alive in the
// table), or it belongs to no conversation; left — alive, nothing of its
// conversation runs any more (closed, asleep, deleted), with `why`; exited —
// terminal, when a complete scan no longer finds that pid with that start
// time; kept PROCESS_RETENTION_MS, then pruned. The id is `<pid>-<start
// ticks>`: a reused pid is a new record.
//
// THE EVENT LOOP. One tick every PROCESS_TICK_MS that never overlaps itself;
// the table is read asynchronously and bounded (proc-table.ts). The store is
// on disk (<dataDir>/silos/kernel/process/processes.json, atomicWriteJson,
// like limits.ts) so `exited` and first-seen survive a restart. `onChange`
// fires only when something a reader would see as a fact changed — a
// record, a state, ports, a conversation — never a cpu or memory wobble:
// the kernel re-reads on change (and every 5 min), and the journal only
// ever sees states.
//
// STOP (the kernel-verb stop-process — kernel-kinds.ts KERNEL_VERBS): the
// owner's gesture only. At the moment of the gesture the live table is read
// again; the root must still be the same process (pid AND start time — a
// reused pid is a stranger, never signalled); its tree is collected as it is
// NOW (the same shape a scan folds: root + descendants, engines and other
// roots excluded); every member gets SIGTERM, a short grace (STOP_GRACE_MS,
// awaited — the event loop never blocks), SIGKILL for the survivors — each
// re-verified by its start time before that second signal —, and the record
// reads `exited` at once with `stoppedAt`/`stoppedBy` and «stopped by you».
// Never this server's own tree (origin silos, re-checked on the fresh
// table), never another user's process (origin other-user: Silos can't even
// read it). The signal and the clock are injected: tests never signal a pid.
//
// SECURITY. Command lines carry secrets (a tunnel's `--token eyJ…` is in
// argv): `command` is redacted (redactCommand) BEFORE it is stored or
// served. Reading the records over the API is the owner's: an agent bearer
// is refused every /api/silos read but its own producer routes, and a
// kernel source has no producer (agent-authz.ts agentMayRead).
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from '../json-store.js'
import type { KernelRecord, KernelRecordSource } from './kernel-kinds.js'
import type { ProcEntry, ProcessTableReader, ProcTable } from './proc-table.js'

// the built-in silo that presents this kind
export const PROCESS_SILO = 'system'
// Silos' own session variable — every launch serving a conversation carries it (agent-env.ts)
export const SILOS_SESSION_KEY = 'SILOS_SESSION_ID'
export const PROCESS_TICK_MS = 30_000
export const MIN_ALIVE_MS = 60_000
export const PROCESS_RETENTION_MS = 24 * 3600_000
export const COMMAND_MAX = 200
export const STOP_GRACE_MS = 5_000
export const STOP_KILL_WAIT_MS = 2_000
// how often a stop re-reads liveness: the answer comes within one step of the
// last exit (a stop is a wait the owner watches — it should say
// closing), each step a stat per member, never a full scan
const STOP_STEP_MS = 100

export type ProcessState = 'running' | 'left' | 'exited'
// machine: this user's, outside any conversation · other-user: a listener of
// another user — its process can't be read here
export type ProcessOrigin = 'conversation' | 'silos' | 'machine' | 'other-user'
export type StopSignal = 'SIGTERM' | 'SIGKILL'

// ── redaction ───────────────────────────────────────────────────────────────

const SECRET_NAME = /token|secret|password|passwd|key|auth|credential/i
const FLAG = /^(-{1,2}[A-Za-z0-9][\w.-]*)$/
const FLAG_EQ = /^(-{1,2}[A-Za-z0-9][\w.-]*)=(.*)$/s
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
export const REDACTED = '[redacted]'

// A long opaque run (a token, a key, a base64 blob): 32+ characters of the
// alphabets keys are written in, holding both letters and digits — a path
// (it has '/') or a long hyphenated name (no digits) is not one.
function redactBlobs(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){0,2}/g, REDACTED) // a JWT, header first
    .replace(/[A-Za-z0-9+_=-]{32,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? REDACTED : m))
}

// Inside one argument that is itself a command line (`sh -c '… --token x'`):
// the value after a secret-named flag or assignment, a URL's userinfo, blobs.
function redactInside(s: string): string {
  return redactBlobs(
    s
      .replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${REDACTED}@`)
      .replace(/(-{1,2}[A-Za-z0-9][\w.-]*)(=|\s+)("[^"]*"|'[^']*'|\S+)/g, (m, flag: string, sep: string) =>
        SECRET_NAME.test(flag) ? `${flag}${sep}${REDACTED}` : m,
      )
      .replace(/(^|[\s;&|?])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, (m, pre: string, name: string) =>
        SECRET_NAME.test(name) ? `${pre}${name}=${REDACTED}` : m,
      ),
  )
}

/** A command line as the System silo may store and serve it: the value of
 *  any flag or assignment whose name says token/secret/password/passwd/key/
 *  auth/credential (`--flag value`, `--flag=value`, `KEY=value`, also inside
 *  a `sh -c` script), a URL's userinfo and any long opaque blob replaced by
 *  [redacted]; the program said by its name; capped at COMMAND_MAX. */
export function redactCommand(argv: readonly string[]): string {
  // a shell wrapper whose script prepares the shell and then `eval`s one
  // command (`sh -c "source … && … && eval '<cmd>'"`) is said by that
  // command — shell semantics, the same for every program that wraps so
  const inner = isShellWrapper({ argv }) ? evalTarget(argv[argv.length - 1]!) : null
  if (inner !== null) return cap(redactInside(inner).replace(/\s+/g, ' ').trim())
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (i === 0) {
      out.push(redactBlobs(basename(a)))
      continue
    }
    const eq = FLAG_EQ.exec(a)
    if (eq) {
      out.push(SECRET_NAME.test(eq[1]!) ? `${eq[1]}=${REDACTED}` : `${eq[1]}=${redactInside(eq[2]!)}`)
      continue
    }
    const flag = FLAG.exec(a)
    if (flag && SECRET_NAME.test(flag[1]!) && i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
      out.push(a, REDACTED)
      i++
      continue
    }
    const as = ASSIGN.exec(a)
    if (as && SECRET_NAME.test(as[1]!)) {
      out.push(`${as[1]}=${REDACTED}`)
      continue
    }
    out.push(redactInside(a))
  }
  return cap(out.join(' ').replace(/\s+/g, ' ').trim())
}

function cap(s: string): string {
  return s.length > COMMAND_MAX ? `${s.slice(0, COMMAND_MAX - 1)}…` : s
}

// the command an `eval '<cmd>'` in a script runs (single-quoted, with the
// '"'"' / '\'' escapes undone), or null when the script evals nothing
export function evalTarget(script: string): string | null {
  const m = /(?:^|&&|;)\s*eval '((?:[^']|'"'"'|'\\'')*)'/s.exec(script)
  if (!m) return null
  return m[1]!.replace(/'"'"'/g, "'").replace(/'\\''/g, "'")
}

// ── the tree ────────────────────────────────────────────────────────────────

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'fish'])

// `sh -c …` / `bash -c -l …`: a shell running one script
export function isShellWrapper(p: { argv: readonly string[] }): boolean {
  return p.argv.length > 1 && SHELLS.has(basename(p.argv[0]!).replace(/^-/, '')) && p.argv.slice(1).some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
}

// an engine's process: its program (argv0, else the kernel's comm) is a
// registered engine's command
export function isEngineProcess(p: Pick<ProcEntry, 'argv' | 'comm'>, commands: ReadonlySet<string>): boolean {
  return commands.has(basename(p.argv[0] ?? '')) || commands.has(p.comm)
}

// what the Silos side knows of one conversation (index.ts wires it)
export interface ConversationFacts {
  session: string // the conversation's session now (its thread's tip)
  folder?: string
  agent?: string
  title: string | null // as Silos shows it (the owner's, the auto-title, else the engine's)
  running: boolean // a turn, a live console, a live holder of its thread
}
// session ids → their facts; an id absent (or null) is not in the index
export type ConversationLookup = (ids: readonly string[]) => Map<string, ConversationFacts | null>

export interface ProcessRecord {
  id: string
  state: ProcessState
  updatedBy: 'kernel'
  command: string
  startedAt: string
  origin: ProcessOrigin
  pid?: number
  cpu?: number
  memoryMb?: number
  processes?: number
  ports?: string
  cwd?: string
  session?: string
  folder?: string
  agent?: string
  conversation?: string
  why?: string
  exitedAt?: string
  stoppedAt?: string // the owner stopped it (stop-process)
  stoppedBy?: string
  // the engine's own bookkeeping — never served
  updatedAt: string
  startTicks?: number
  listener?: { port: number; uid: number }
}

type Draft = Omit<ProcessRecord, 'id' | 'updatedBy' | 'updatedAt' | 'exitedAt'>

const INTERNAL = new Set(['updatedAt', 'startTicks', 'listener'])
// what a reader sees as a FACT of a record (cpu, memory and the tree's size
// are gauges: they move on every scan and never journal nor notify)
const FACTS = [
  'state',
  'command',
  'startedAt',
  'origin',
  'pid',
  'ports',
  'cwd',
  'session',
  'folder',
  'agent',
  'conversation',
  'why',
  'exitedAt',
  'stoppedAt',
  'stoppedBy',
] as const

function factsOf(r: ProcessRecord): string {
  return `${r.id}\0${FACTS.map((f) => String(r[f] ?? '')).join('\0')}`
}

export interface ProcessRecordsOptions {
  file: string
  table?: ProcessTableReader // absent: no data here (and nothing said about it)
  // the session-id variables: Silos' own and every engine's (read at each scan)
  sessionKeys: () => readonly string[]
  // the engines' commands (every registered harness's binary, by name): a
  // process whose program is one of them is an engine, never a record
  engineCommands: () => ReadonlySet<string>
  // false while the Silos side can't answer (the index warming up): no scan
  // is judged — a conversation not yet listed must never read «deleted»
  ready?: () => boolean
  selfPid?: number // this server: its tree's records say origin `silos`
  conversations?: ConversationLookup
  now?: () => number
  onChange?: () => void
  minAliveMs?: number
  retentionMs?: number
  // stop-process: how a signal is sent (default process.kill) and how a
  // grace is awaited (default a timer) — tests inject both, never a real pid
  signal?: (pid: number, sig: StopSignal) => void
  wait?: (ms: number) => Promise<void>
  stopGraceMs?: number
  stopKillWaitMs?: number
}

// Why a record can't be stopped, in plain words — null: it can (the guard
// the kind's `stoppable` field says; the stop re-checks it on a fresh table).
export function stopRefusal(r: Pick<ProcessRecord, 'state' | 'origin' | 'pid' | 'startTicks' | 'listener'>): string | null {
  if (r.state === 'exited') return 'it already exited'
  if (r.origin === 'silos') return 'it is Silos itself — this server and what runs it are stopped where they were started, never from here'
  if (r.origin === 'other-user' || r.listener || r.pid === undefined || r.startTicks === undefined)
    return "it runs as another user — Silos can't read it and never signals it"
  return null
}

// The answer of a stop, said in plain words in `says`.
export interface StopAnswer {
  id: string
  // stopped: every process it signalled is gone · gone: it had already exited
  // (nothing signalled) · partial: some did not exit
  outcome: 'stopped' | 'gone' | 'partial'
  signalled: number // processes sent SIGTERM
  stopped: number // of those, gone at the end
  killed: number // of those, the ones that needed SIGKILL
  survivors: number[] // pids still alive at the end
  says: string
}
export type StopResult = { ok: true; value: StopAnswer } | { ok: false; code: number; reason: string }

// what a conversation's column and the delete dialog read of one record
export interface ProcessView {
  id: string
  state: ProcessState
  command: string
  startedAt: string
  origin: ProcessOrigin
  stoppable: boolean
  pid?: number
  ports?: string
  cpu?: number
  memoryMb?: number
  processes?: number
  session?: string
  conversation?: string
  why?: string
}

const plural = (n: number, one: string, many = `${one}es`): string => `${n} ${n === 1 ? one : many}`

const short = (id: string): string => id.slice(0, 8)
const iso = (ms: number): string => new Date(ms).toISOString()

export class ProcessRecords implements KernelRecordSource {
  private recs = new Map<string, ProcessRecord>()
  private pending = new Map<string, number>() // session roots not yet a record: first seen
  private prevCpu = new Map<string, number>() // `<pid>-<start>` → cpu seconds at the last scan
  private prevAt: number | null = null
  private loaded = false
  private written: number | null = null
  private ticker: NodeJS.Timeout | null = null
  private ticking = false
  private scanned: number | null = null // when the gauges last moved (the last scan)
  private stopping = new Set<string>()
  // where this user's processes work, as the last scan read them (the
  // kernel kind `worktree` asks it — /proc is scanned once, here)
  private where: { at: number; procs: WorkingProcess[] } | null = null

  constructor(private o: ProcessRecordsOptions) {}

  static fileIn(silosRoot: string): string {
    return join(silosRoot, 'kernel', 'process', 'processes.json')
  }

  private nowMs(): number {
    return this.o.now?.() ?? Date.now()
  }

  load(): void {
    this.loaded = true
    this.recs.clear()
    this.pending.clear()
    if (!existsSync(this.o.file)) return
    let text = ''
    try {
      text = readFileSync(this.o.file, 'utf8')
      const raw = JSON.parse(text) as { records?: unknown; pending?: unknown; writtenAt?: unknown }
      for (const r of Array.isArray(raw.records) ? raw.records : []) {
        if (
          typeof r === 'object' &&
          r !== null &&
          typeof (r as ProcessRecord).id === 'string' &&
          typeof (r as ProcessRecord).state === 'string' &&
          typeof (r as ProcessRecord).startedAt === 'string'
        )
          this.recs.set((r as ProcessRecord).id, r as ProcessRecord)
      }
      if (typeof raw.pending === 'object' && raw.pending !== null) {
        for (const [id, at] of Object.entries(raw.pending as Record<string, unknown>))
          if (typeof at === 'number' && Number.isFinite(at)) this.pending.set(id, at)
      }
      this.written = typeof raw.writtenAt === 'number' ? raw.writtenAt : null
    } catch {
      if (text !== '') backupCorruptJson(this.o.file, text, 'silos')
      this.recs.clear()
      this.pending.clear()
    }
  }

  private ensure(): void {
    if (!this.loaded) this.load()
  }

  private persist(now: number, moved: boolean): void {
    if (moved) this.written = now
    mkdirSync(dirname(this.o.file), { recursive: true, mode: 0o700 })
    atomicWriteJson(
      this.o.file,
      { version: 1, writtenAt: this.written, records: [...this.recs.values()], pending: Object.fromEntries(this.pending) },
      { mode: 0o600 },
    )
  }

  list(): ProcessRecord[] {
    this.ensure()
    return [...this.recs.values()].map((r) => ({ ...r }))
  }

  // The table's shape, as observe and stop both read it: the engines, this
  // server's tree, the roots (with the sessions they speak for) and each
  // root's members — ONE rule for what a record holds.
  private shape(t: ProcTable): {
    keys: readonly string[]
    byPid: Map<number, ProcEntry>
    kids: Map<number, ProcEntry[]>
    engine: Set<number>
    selfTree: Set<number>
    roots: Map<number, ProcEntry>
    idsOf: Map<number, string[]>
    memberOf: (root: ProcEntry) => ProcEntry[]
    portsOf: Map<number, number[]>
  } {
    const keys = this.o.sessionKeys()
    const engineKeys = keys.filter((k) => k !== SILOS_SESSION_KEY)
    const byPid = new Map(t.procs.map((p) => [p.pid, p]))
    const kids = new Map<number, ProcEntry[]>()
    for (const p of t.procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
    const cmds = this.o.engineCommands()
    const engine = new Set(t.procs.filter((p) => isEngineProcess(p, cmds)).map((p) => p.pid))
    // the session ids a process carries: the engine's own first (the exact
    // session that started it), Silos' after (the conversation it launched for)
    const sessionsOf = (p: ProcEntry): string[] => [
      ...new Set([...engineKeys, SILOS_SESSION_KEY].map((k) => p.env[k]).filter((v): v is string => typeof v === 'string' && v !== '')),
    ]
    const carries = (p: ProcEntry | undefined): boolean => !!p && !engine.has(p.pid) && sessionsOf(p).length > 0
    const portsOf = new Map<number, number[]>()
    for (const l of t.listeners) for (const pid of l.pids) portsOf.set(pid, [...(portsOf.get(pid) ?? []), l.port])
    // this server's tree
    const selfTree = new Set<number>()
    if (this.o.selfPid !== undefined && byPid.has(this.o.selfPid)) {
      const q = [this.o.selfPid]
      for (let i = 0; i < q.length; i++) {
        selfTree.add(q[i]!)
        for (const c of kids.get(q[i]!) ?? []) if (!selfTree.has(c.pid)) q.push(c.pid)
      }
    }

    // ── the roots ──
    const roots = new Map<number, ProcEntry>()
    // the session a root speaks for: the carrying process it was found from
    // (a wrapper that started its child with a cleared environment — `env -i
    // … npm run dev` from a conversation's shell — still hands it the session)
    const idsOf = new Map<number, string[]>()
    const descend = (p: ProcEntry): ProcEntry | null => {
      let cur = p
      for (let guard = 0; guard < 32 && isShellWrapper(cur); guard++) {
        const c = kids.get(cur.pid) ?? []
        if (c.length !== 1) break
        cur = c[0]!
      }
      return engine.has(cur.pid) ? null : cur
    }
    for (const p of t.procs) {
      if (!carries(p) || carries(byPid.get(p.ppid))) continue
      const r = descend(p)
      if (r) {
        roots.set(r.pid, r)
        idsOf.set(r.pid, sessionsOf(p))
      }
    }
    const memberOf = (root: ProcEntry): ProcEntry[] => {
      const out = [root]
      for (let i = 0; i < out.length && out.length < 10_000; i++) {
        for (const c of kids.get(out[i]!.pid) ?? []) {
          if (engine.has(c.pid) || (roots.has(c.pid) && c.pid !== root.pid)) continue
          out.push(c)
        }
      }
      return out
    }
    // a conversation's tree holds its listeners: they fold into its root
    const covered = new Set<number>()
    for (const r of roots.values()) for (const m of memberOf(r)) covered.add(m.pid)
    for (const l of t.listeners) {
      for (const pid of l.pids) {
        let p = byPid.get(pid)
        if (!p || engine.has(p.pid) || covered.has(p.pid)) continue
        // the topmost listener of a chain (a server's master and its workers share the socket)
        for (let guard = 0; guard < 64; guard++) {
          const up = byPid.get(p.ppid)
          if (!up || engine.has(up.pid) || covered.has(up.pid) || !portsOf.has(up.pid)) break
          p = up
        }
        roots.set(p.pid, p)
      }
    }

    return { keys, byPid, kids, engine, selfTree, roots, idsOf, memberOf, portsOf }
  }

  // One scan of the table. Returns whether a FACT moved (onChange-worthy).
  observe(t: ProcTable, now = this.nowMs()): boolean {
    this.ensure()
    const before = [...this.recs.values()].map(factsOf).sort().join('\n')
    const pendingBefore = [...this.pending.keys()].sort().join('\n')
    const { keys, byPid, engine, selfTree, roots, idsOf, memberOf, portsOf } = this.shape(t)

    // ── each root's tree, its conversation, its draft ──
    const allIds = new Set<string>()
    for (const r of roots.values()) for (const id of idsOf.get(r.pid) ?? []) allIds.add(id)
    const facts = allIds.size > 0 && this.o.conversations ? this.o.conversations([...allIds]) : new Map<string, ConversationFacts | null>()
    const engineSessions = new Set<string>()
    for (const pid of engine)
      for (const k of keys) {
        const v = byPid.get(pid)!.env[k]
        if (v) engineSessions.add(v)
      }
    const underEngine = (p: ProcEntry): boolean => {
      let cur = byPid.get(p.ppid)
      for (let guard = 0; cur && guard < 64; guard++) {
        if (engine.has(cur.pid)) return true
        cur = byPid.get(cur.ppid)
      }
      return false
    }
    const dt = this.prevAt !== null && t.at > this.prevAt ? (t.at - this.prevAt) / 1000 : null
    const drafts = new Map<string, Draft>()
    for (const root of roots.values()) {
      const members = memberOf(root)
      let cpu = 0
      let measured = false
      for (const m of members) {
        const prev = this.prevCpu.get(`${m.pid}-${m.startTicks}`)
        if (prev !== undefined && dt) {
          cpu += Math.max(0, m.cpuSeconds - prev)
          measured = true
        }
      }
      const ports = [...new Set(members.flatMap((m) => portsOf.get(m.pid) ?? []))].sort((a, b) => a - b)
      // this server's own tree is Silos, never something a conversation left —
      // even when a conversation's shell started it (the restart recipe runs
      // `npm run dev` from one): a root that holds this server speaks as silos
      const holdsSelf = this.o.selfPid !== undefined && members.some((m) => m.pid === this.o.selfPid)
      const ids = holdsSelf ? [] : (idsOf.get(root.pid) ?? [])
      const d: Draft = {
        state: 'running',
        command: redactCommand(root.argv),
        startedAt: iso(root.startedAt),
        origin: ids.length > 0 ? 'conversation' : holdsSelf || selfTree.has(root.pid) ? 'silos' : 'machine',
        pid: root.pid,
        startTicks: root.startTicks,
        processes: members.length,
        memoryMb: Math.round(members.reduce((s, m) => s + m.rssBytes, 0) / (1024 * 1024)),
        ...(measured && dt ? { cpu: Math.round((cpu / dt) * 1000) / 10 } : {}),
        ...(ports.length > 0 ? { ports: ports.join(', ') } : {}),
        ...(root.cwd ? { cwd: root.cwd } : {}),
      }
      if (ids.length > 0) {
        const hit = ids.map((id) => facts.get(id) ?? null).find((f): f is ConversationFacts => f !== null) ?? null
        const engineAlive = underEngine(root) || ids.some((id) => engineSessions.has(id))
        if (hit) {
          d.session = hit.session
          if (hit.folder) d.folder = hit.folder
          if (hit.agent) d.agent = hit.agent
          d.conversation = hit.title && hit.title.trim() !== '' ? hit.title : `an untitled conversation (${short(hit.session)})`
          if (!(hit.running || engineAlive)) {
            d.state = 'left'
            d.why = 'its conversation is not running'
          }
        } else {
          d.session = ids[0]!
          // not in the index yet with an engine alive = a conversation just
          // born: no title to say, and none invented
          if (!engineAlive) {
            d.state = 'left'
            d.why = 'its conversation was deleted'
            d.conversation = `a deleted conversation (${short(ids[0]!)})`
          }
        }
      }
      drafts.set(`${root.pid}-${root.startTicks}`, d)
    }
    // a listener nobody here can read: said with its port, no command
    for (const l of t.listeners) {
      if (l.pids.length > 0 || l.uid === t.uid) continue
      const id = `port-${l.port}-${l.uid}`
      if (drafts.has(id)) continue
      const known = this.recs.get(id)
      drafts.set(id, {
        state: 'running',
        command: `a process of another user (${l.user ?? `uid ${l.uid}`}) — its command can't be read`,
        startedAt: known && known.state !== 'exited' ? known.startedAt : iso(t.at),
        origin: 'other-user',
        ports: String(l.port),
        listener: { port: l.port, uid: l.uid },
      })
    }

    // ── into the store ──
    const stamp = iso(now)
    for (const [id, d] of drafts) {
      const r = this.recs.get(id)
      if (r && r.state === 'exited') continue // terminal is terminal (an id never comes back: its start time is in it)
      if (!r) {
        const immediate = d.ports !== undefined || d.origin !== 'conversation'
        if (!immediate) {
          const first = this.pending.get(id) ?? t.at
          this.pending.set(id, first)
          if (t.at - first < (this.o.minAliveMs ?? MIN_ALIVE_MS)) continue
        }
        this.pending.delete(id)
      }
      // a gauge keeps its last value only while it is measured; the record's
      // write time moves only with a fact (a cpu wobble is not a write)
      const next: ProcessRecord = { id, updatedBy: 'kernel', updatedAt: stamp, ...d }
      if (r && factsOf(r) === factsOf(next)) next.updatedAt = r.updatedAt
      this.recs.set(id, next)
    }
    for (const id of [...this.pending.keys()]) if (!drafts.has(id)) this.pending.delete(id)
    for (const r of [...this.recs.values()]) {
      if (r.state === 'exited' || drafts.has(r.id)) continue
      const p = r.pid !== undefined ? byPid.get(r.pid) : undefined
      if (p && p.startTicks === r.startTicks) {
        // alive, but no longer a case of its own (folded under a new root, a
        // listener that closed its port): not «exited» — it is simply not listed
        this.recs.delete(r.id)
        continue
      }
      if (!r.listener && !t.complete) continue // a capped scan concludes no exit
      const { cpu: _c, memoryMb: _m, processes: _p, ports: _ports, why: _w, ...rest } = r
      this.recs.set(r.id, { ...rest, state: 'exited', exitedAt: stamp, updatedAt: stamp })
    }
    const keep = this.o.retentionMs ?? PROCESS_RETENTION_MS
    for (const r of [...this.recs.values()]) if (r.state === 'exited' && r.exitedAt && now - Date.parse(r.exitedAt) > keep) this.recs.delete(r.id)
    // the cpu baseline for the next scan
    this.prevCpu = new Map(t.procs.map((p) => [`${p.pid}-${p.startTicks}`, p.cpuSeconds]))
    this.prevAt = t.at
    this.scanned = now
    this.where = { at: now, procs: workingOf(t, keys) }

    const moved = [...this.recs.values()].map(factsOf).sort().join('\n') !== before
    const pendingMoved = [...this.pending.keys()].sort().join('\n') !== pendingBefore
    if (moved || pendingMoved) this.persist(now, moved)
    return moved
  }

  // The clock's part (no reading): exited records past retention are pruned.
  expire(now = this.nowMs()): boolean {
    this.ensure()
    const keep = this.o.retentionMs ?? PROCESS_RETENTION_MS
    let changed = false
    for (const r of [...this.recs.values()]) {
      if (r.state === 'exited' && r.exitedAt && now - Date.parse(r.exitedAt) > keep) {
        this.recs.delete(r.id)
        changed = true
      }
    }
    if (changed) this.persist(now, true)
    return changed
  }

  // One scan (the periodic tick). Never throws, never overlaps itself.
  async tick(): Promise<boolean> {
    if (this.ticking || !this.o.table || this.o.ready?.() === false) return false
    this.ticking = true
    let changed = false
    try {
      const t = await this.o.table.read(this.o.sessionKeys())
      if (t) changed = this.observe(t, this.nowMs())
    } catch (err) {
      console.warn('silos: the process scan failed —', err instanceof Error ? err.message : err)
    } finally {
      this.ticking = false
    }
    if (changed) {
      try {
        this.o.onChange?.()
      } catch {
        /* a listener never breaks the engine */
      }
    }
    return changed
  }

  // `poll`: false = the store and the clock only, no reading (the e2e harness).
  start(opts: { intervalMs?: number; poll?: boolean } = {}): void {
    this.ensure()
    if (this.ticker) return
    const poll = opts.poll !== false && this.o.table !== undefined
    this.ticker = setInterval(() => {
      if (poll) void this.tick()
      else if (this.expire(this.nowMs())) {
        try {
          this.o.onChange?.()
        } catch {
          /* never breaks the engine */
        }
      }
    }, opts.intervalMs ?? PROCESS_TICK_MS)
    this.ticker.unref()
    if (this.expire(this.nowMs())) {
      try {
        this.o.onChange?.()
      } catch {
        /* never breaks the engine */
      }
    }
    if (poll) void this.tick()
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  // ── what the silo reader takes (KernelRecordSource) ──

  records(_now?: number): KernelRecord[] {
    this.ensure()
    return [...this.recs.values()].map((r) => {
      const value = Object.fromEntries(Object.entries(r).filter(([k, v]) => !INTERNAL.has(k) && v !== undefined))
      // the kernel's guard of stop-process, said on every record (derived
      // from facts: it moves only when they do)
      value.stoppable = stopRefusal(r) === null
      return { id: r.id, value, writtenAt: Date.parse(r.updatedAt) || 0 }
    })
  }

  // When the gauges (cpu, memory, the tree's size) last moved: the last scan.
  // A reader holding an older reading may read again (index.ts freshen) —
  // the numbers it serves are then at most one scan old.
  scannedAt(): number | null {
    return this.scanned
  }

  // The LIVE records (running, left) of these sessions — a conversation's
  // thread (index.ts resolves it: every id of the thread, its tip included).
  // Fresh from memory: the gauges of the last scan.
  ofSessions(ids: readonly string[]): ProcessView[] {
    this.ensure()
    const want = new Set(ids)
    const out: ProcessView[] = []
    for (const r of this.recs.values()) {
      if (r.state === 'exited' || r.session === undefined || !want.has(r.session)) continue
      out.push({
        id: r.id,
        state: r.state,
        command: r.command,
        startedAt: r.startedAt,
        origin: r.origin,
        stoppable: stopRefusal(r) === null,
        ...(r.pid !== undefined ? { pid: r.pid } : {}),
        ...(r.ports !== undefined ? { ports: r.ports } : {}),
        ...(r.cpu !== undefined ? { cpu: r.cpu } : {}),
        ...(r.memoryMb !== undefined ? { memoryMb: r.memoryMb } : {}),
        ...(r.processes !== undefined ? { processes: r.processes } : {}),
        ...(r.session !== undefined ? { session: r.session } : {}),
        ...(r.conversation !== undefined ? { conversation: r.conversation } : {}),
        ...(r.why !== undefined ? { why: r.why } : {}),
      })
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
  }

  // ── stop-process ──

  private signalOf(): (pid: number, sig: StopSignal) => void {
    return (
      this.o.signal ??
      ((pid, sig) => {
        process.kill(pid, sig)
      })
    )
  }

  private waitMs(ms: number): Promise<void> {
    if (this.o.wait) return this.o.wait(ms)
    return new Promise((res) => {
      const t = setTimeout(res, ms)
      t.unref?.()
    })
  }

  // which of these are still the same process (alive, same start time)
  private async stillAlive(ps: ReadonlyArray<{ pid: number; startTicks: number }>): Promise<Array<{ pid: number; startTicks: number }>> {
    if (ps.length === 0 || !this.o.table) return []
    if (this.o.table.alive) return this.o.table.alive(ps)
    const t = await this.o.table.read([])
    if (!t) return []
    const live = new Set(t.procs.map((p) => `${p.pid}-${p.startTicks}`))
    return ps.filter((p) => live.has(`${p.pid}-${p.startTicks}`))
  }

  private markExited(id: string, now: number, stopped: { by: string } | null): void {
    const r = this.recs.get(id)
    if (!r || r.state === 'exited') return
    const stamp = iso(now)
    const { cpu: _c, memoryMb: _m, processes: _p, ports: _ports, why: _w, ...rest } = r
    this.recs.set(id, {
      ...rest,
      state: 'exited',
      exitedAt: stamp,
      updatedAt: stamp,
      ...(stopped ? { stoppedAt: stamp, stoppedBy: stopped.by, why: stopped.by === 'owner' ? 'stopped by you' : `stopped by ${stopped.by}` } : {}),
    })
    this.persist(now, true)
  }

  // Stop the record `id` (the kernel-verb stop-process). `by`: who asked —
  // the owner (the route lets no one else through). Never throws.
  async stopRecord(id: string, opts: { by?: string } = {}): Promise<StopResult> {
    this.ensure()
    const by = opts.by ?? 'owner'
    const r = this.recs.get(id)
    if (!r) return { ok: false, code: 404, reason: `no process ${id} — it is not listed (exited long ago, or never a record)` }
    const why = stopRefusal(r)
    if (why) return { ok: false, code: 409, reason: `${r.command} can't be stopped: ${why}` }
    if (!this.o.table) return { ok: false, code: 503, reason: "this machine's process table can't be read here — nothing was signalled" }
    if (this.stopping.has(id)) return { ok: false, code: 409, reason: `${r.command} is being stopped already` }
    this.stopping.add(id)
    let changed = false
    try {
      const t = await this.o.table.read(this.o.sessionKeys())
      if (!t) return { ok: false, code: 503, reason: "this machine's process table can't be read here — nothing was signalled" }
      const root = t.procs.find((p) => p.pid === r.pid && p.startTicks === r.startTicks)
      if (!root) {
        // not in the table: gone — or only cut from a capped scan (then the
        // one stat says). A pid now held by another start time is a stranger.
        if ((await this.stillAlive([{ pid: r.pid!, startTicks: r.startTicks! }])).length > 0)
          return { ok: false, code: 503, reason: 'the process table was cut short this time — nothing was signalled; try again' }
        this.markExited(id, this.nowMs(), null)
        changed = true
        return {
          ok: true,
          value: { id, outcome: 'gone', signalled: 0, stopped: 0, killed: 0, survivors: [], says: `${r.command} had already exited — nothing was signalled.` },
        }
      }
      const sh = this.shape(t)
      // this server's own tree, said again on the table as it is now
      const self = this.o.selfPid
      if (self !== undefined) {
        const under = [root]
        let holds = sh.selfTree.has(root.pid)
        for (let i = 0; i < under.length && !holds && under.length < 10_000; i++) {
          for (const c of sh.kids.get(under[i]!.pid) ?? []) {
            if (c.pid === self) {
              holds = true
              break
            }
            under.push(c)
          }
        }
        if (holds)
          return {
            ok: false,
            code: 409,
            reason: `${r.command} can't be stopped: it holds Silos itself — this server is stopped where it was started, never from here`,
          }
      }
      const targets = sh.memberOf(root).map((p) => ({ pid: p.pid, startTicks: p.startTicks }))
      const send = this.signalOf()
      const signalAll = (ps: ReadonlyArray<{ pid: number }>, sig: StopSignal): void => {
        for (const p of ps) {
          try {
            send(p.pid, sig)
          } catch {
            /* gone between the read and the signal (ESRCH): nothing to stop */
          }
        }
      }
      // SIGTERM, then the grace — ended early once every one is gone
      signalAll(targets, 'SIGTERM')
      const grace = this.o.stopGraceMs ?? STOP_GRACE_MS
      const started = this.nowMs()
      let left = await this.stillAlive(targets)
      while (left.length > 0 && this.nowMs() - started < grace) {
        await this.waitMs(Math.min(STOP_STEP_MS, grace - (this.nowMs() - started)))
        left = await this.stillAlive(left)
      }
      // SIGKILL for the survivors — `left` was just re-verified by start time
      const killed = left.length
      if (left.length > 0) {
        signalAll(left, 'SIGKILL')
        const killWait = this.o.stopKillWaitMs ?? STOP_KILL_WAIT_MS
        const at = this.nowMs()
        left = await this.stillAlive(left)
        while (left.length > 0 && this.nowMs() - at < killWait) {
          await this.waitMs(Math.min(STOP_STEP_MS, killWait - (this.nowMs() - at)))
          left = await this.stillAlive(left)
        }
      }
      const survivors = left.map((p) => p.pid)
      const stopped = targets.length - survivors.length
      const rootGone = !survivors.includes(root.pid)
      if (rootGone) {
        this.markExited(id, this.nowMs(), { by })
        changed = true
      }
      const viaKill = killed - survivors.length
      const killedWords = viaKill > 0 ? ` (${viaKill} of them only with SIGKILL)` : ''
      const says =
        survivors.length === 0
          ? `Stopped ${r.command} — ${plural(stopped, 'process')}${killedWords}.`
          : `Stopped ${stopped} of ${plural(targets.length, 'process')} of ${r.command}${killedWords} — ${survivors.length} did not exit (pid ${survivors.join(', ')}).`
      return { ok: true, value: { id, outcome: survivors.length === 0 ? 'stopped' : 'partial', signalled: targets.length, stopped, killed, survivors, says } }
    } catch (err) {
      return { ok: false, code: 500, reason: `the stop failed: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      this.stopping.delete(id)
      // a scan at once: the tree's leftovers, the gauges — then the kernel reads
      if (changed && !(await this.tick())) {
        try {
          this.o.onChange?.()
        } catch {
          /* a listener never breaks the engine */
        }
      }
    }
  }

  lastWrite(): number | null {
    this.ensure()
    return this.written
  }

  // The live processes whose working directory is inside each of `dirs`
  // (the dir itself or below it), with the session ids they carry — what
  // the kernel kind `worktree` reads (silos/worktrees.ts: «a process runs
  // inside it»). From the last scan, when it is at most `maxAgeMs` old;
  // `fresh` (a removal's re-check at the gesture) reads the table once more.
  // null: nothing to tell from (no recent scan; no table here) — the caller
  // says it can't tell, and never acts on it.
  async inside(dirs: readonly string[], o: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<Map<string, { count: number; sessions: string[] }> | null> {
    let procs: WorkingProcess[] | null = null
    const maxAge = o.maxAgeMs ?? 2 * PROCESS_TICK_MS
    if (!o.fresh) {
      if (this.where && this.nowMs() - this.where.at <= maxAge) procs = this.where.procs
    } else if (this.o.table) {
      const keys = this.o.sessionKeys()
      const t = await this.o.table.read(keys)
      if (t) procs = workingOf(t, keys)
    }
    if (!procs) return null
    return countInside(procs, dirs)
  }
}

export interface WorkingProcess {
  cwd: string
  sessions: string[]
}

function workingOf(t: ProcTable, keys: readonly string[]): WorkingProcess[] {
  return t.procs.flatMap((p) =>
    p.cwd ? [{ cwd: p.cwd, sessions: [...new Set(keys.map((k) => p.env[k]).filter((v): v is string => typeof v === 'string' && v !== ''))] }] : [],
  )
}

export function countInside(procs: readonly WorkingProcess[], dirs: readonly string[]): Map<string, { count: number; sessions: string[] }> {
  const out = new Map(dirs.map((d) => [d, { count: 0, sessions: [] as string[] }]))
  for (const p of procs) {
    for (const d of dirs) {
      if (p.cwd !== d && !p.cwd.startsWith(d.endsWith('/') ? d : `${d}/`)) continue
      const e = out.get(d)!
      e.count++
      for (const s of p.sessions) if (!e.sessions.includes(s)) e.sessions.push(s)
    }
  }
  return out
}
