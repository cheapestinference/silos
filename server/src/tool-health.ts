// tool-health.ts — the ledger of the engines' own status readings of a
// folder's MCP servers and connectors (docs/architecture.md «Tool health»).
// A reading is in no transcript, so Silos keeps it: `<dataDir>/tool-health/`,
// one 0600 file per folder (its key a hash of the exact path, the path kept
// inside), `logins.json` — each login's connector list — and `machine.json`,
// the machine place's switch records. Neutral: it reads
// what an engine handed over (contract.ts TurnToolStatus) and names none.
//
// Per folder and login: the last READINGS_PER_LOGIN readings, one per
// conversation (its newest); beside them, per server that is failing, when
// its unbroken run began and how many readings long it is — kept when the
// readings that started it rotate out. A placeholder (an entry with no
// address) is never a failure, `pending` never breaks or extends a run.
//
// Untrusted text: a server's message is cleaned before it is stored and
// before it is sent anywhere (scrubReason). A status row's config is never
// handed over (the engine keeps it), so nothing here can hold a secret it
// carried. It is an observation, never authority: outside the seal
// (seal-regimes.ts) and fenced from every agent (territory.ts DATA_DIR_DENIED).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteJson } from './json-store.js'
import type { LoadsHealth, LoadsReading, LoadsRow, TurnToolStatus, TurnVia } from './harnesses/contract.js'

export const READINGS_PER_LOGIN = 20
const REASON_MAX = 160
const STATUSES: ReadonlySet<string> = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])

export interface StoredServer {
  name: string
  status: LoadsHealth['status']
  reason?: string
  source?: string
  scope?: string
  tools?: number
  noAddress?: true
}
export interface StoredReading {
  at: number
  /** when the process that read it started (it read its settings then) */
  started?: number
  login: string | null
  from: 'turn' | 'check'
  conversation?: string
  agent?: string
  via?: TurnVia
  servers: StoredServer[]
}
/** A failing server's unbroken run, per login. `by`: how many of its
 *  readings each conversation gave (the newest RUN_CONVERSATIONS), so a
 *  conversation put in the trash leaves the count (forget). */
export interface FailureRun {
  login: string | null
  name: string
  since: number
  count: number
  last: number
  turn?: string
  by?: [string, number][]
}
const RUN_CONVERSATIONS = 50
const tally = (by: [string, number][] | undefined, conversation: string | undefined): [string, number][] | undefined => {
  if (!conversation) return by
  const list = (by ?? []).filter(([c]) => c !== conversation)
  const prev = (by ?? []).find(([c]) => c === conversation)?.[1] ?? 0
  list.push([conversation, prev + 1])
  return list.slice(-RUN_CONVERSATIONS)
}
/** A switch the one writer made on a row (switch-proof.ts): when, which
 *  way, and the switch file's mtime right after — while the file still has
 *  that mtime nothing else wrote it, so the row's own time is exact. */
export interface SwitchRecord {
  key: string
  to: 'on' | 'off'
  at: number
  mtime: number
}
export const SWITCHES_KEPT = 50
/** Where a switch record is kept: the folder's own file, or the machine's. */
export type SwitchPlace = 'project' | 'machine'
const MACHINE_FILE = 'machine.json'
interface MachineFile {
  v: 1
  switches: SwitchRecord[]
}
interface FolderFile {
  v: 1
  folder: string
  readings: StoredReading[]
  runs: FailureRun[]
  switches?: SwitchRecord[]
}
interface LoginsFile {
  v: 1
  logins: { login: string; at: number; connectors: string[] }[]
}

/** A server's message, safe to keep and to show: every URL cut to its host,
 *  what looks like a credential removed, cut at the first markup and at 160
 *  characters. */
export function scrubReason(raw: string): string {
  let s = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  // markup first: a server that answers with a page names nothing useful after it
  const markup = s.search(/<[a-zA-Z!?/]|!DOCTYPE|<\?xml/i)
  if (markup >= 0) s = s.slice(0, markup)
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([^\s/?#:]+)[^\s]*/gi, '$1')
  s = s.replace(/\bBearer\s+\S+/gi, '')
  s = s.replace(/\b(?:Basic|Token)\s+[A-Za-z0-9+/=._-]{8,}/g, '')
  s = s.replace(/\b[\w-]*(?:key|token|secret|password|passwd|pwd|auth|credential|signature)[\w-]*\s*[=:]\s*\S+/gi, '')
  s = s.replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, '')
  s = s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, '')
  s = s.replace(/[A-Za-z0-9+/_=-]{32,}/g, '')
  s = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s:;,(-]+$/, '')
  if (s.length > REASON_MAX) s = `${s.slice(0, REASON_MAX - 1).trimEnd()}…`
  return s
}

const folderKey = (folder: string): string => createHash('sha256').update(folder).digest('hex').slice(0, 24)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export class ToolHealthLedger {
  constructor(
    private dir: string,
    private now: () => number = Date.now,
  ) {}

  private fileOf(folder: string): string {
    return join(this.dir, `${folderKey(folder)}.json`)
  }

  private readFolder(folder: string): FolderFile {
    const empty: FolderFile = { v: 1, folder, readings: [], runs: [] }
    try {
      const j = JSON.parse(readFileSync(this.fileOf(folder), 'utf8')) as unknown
      if (!isObj(j) || j.folder !== folder || !Array.isArray(j.readings) || !Array.isArray(j.runs)) return empty
      return {
        v: 1,
        folder,
        readings: j.readings as StoredReading[],
        runs: j.runs as FailureRun[],
        ...(Array.isArray(j.switches) ? { switches: j.switches as SwitchRecord[] } : {}),
      }
    } catch {
      return empty
    }
  }

  private write(file: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    atomicWriteJson(file, data, { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      /* written */
    }
  }

  /** A turn's reading (or a check's): kept, its runs moved, the login's
   *  connector list replaced when the reading fetched connectors. */
  record(
    r: Omit<TurnToolStatus, 'turnId' | 'agentId' | 'via' | 'conversation'> & {
      conversation?: string
      turnId?: string
      agentId?: string
      via?: TurnVia
      from?: 'turn' | 'check'
      at?: number
    },
  ): void {
    const at = r.at ?? this.now()
    const servers: StoredServer[] = []
    const seen = new Set<string>()
    for (const s of r.servers) {
      if (typeof s.name !== 'string' || s.name === '' || !STATUSES.has(s.status) || seen.has(s.name)) continue
      seen.add(s.name)
      const reason = typeof s.error === 'string' ? scrubReason(s.error) : ''
      servers.push({
        name: s.name,
        status: s.status,
        ...(reason ? { reason } : {}),
        ...(typeof s.source === 'string' ? { source: s.source } : {}),
        ...(typeof s.scope === 'string' ? { scope: s.scope } : {}),
        ...(typeof s.tools === 'number' && Number.isFinite(s.tools) ? { tools: s.tools } : {}),
        ...(s.noAddress === true ? { noAddress: true as const } : {}),
      })
    }
    const reading: StoredReading = {
      at,
      ...(typeof r.started === 'number' && Number.isFinite(r.started) && r.started <= at ? { started: r.started } : {}),
      login: r.login,
      from: r.from ?? 'turn',
      ...(r.conversation ? { conversation: r.conversation } : {}),
      ...(r.agentId ? { agent: r.agentId } : {}),
      ...(r.via ? { via: r.via } : {}),
      servers,
    }
    const f = this.readFolder(r.folder)
    // one per conversation: its newest
    let readings = f.readings.filter((x) => !(reading.conversation && x.conversation === reading.conversation))
    readings.push(reading)
    readings.sort((a, b) => b.at - a.at)
    const perLogin = new Map<string, number>()
    readings = readings.filter((x) => {
      const k = x.login ?? ''
      const n = (perLogin.get(k) ?? 0) + 1
      perLogin.set(k, n)
      return n <= READINGS_PER_LOGIN
    })
    // the failing runs: a failure extends (once per turn) or starts one;
    // anything but pending ends it; a placeholder is never one
    const runs = f.runs.slice()
    for (const s of servers) {
      const i = runs.findIndex((x) => x.login === r.login && x.name === s.name)
      if (s.status === 'failed' && !s.noAddress) {
        const by = (prev?: [string, number][]): { by?: [string, number][] } => {
          const t = tally(prev, r.conversation)
          return t ? { by: t } : {}
        }
        if (i < 0) runs.push({ login: r.login, name: s.name, since: at, count: 1, last: at, ...(r.turnId ? { turn: r.turnId } : {}), ...by(undefined) })
        else if (!(r.turnId && runs[i]!.turn === r.turnId))
          runs[i] = { ...runs[i]!, count: runs[i]!.count + 1, last: at, ...(r.turnId ? { turn: r.turnId } : {}), ...by(runs[i]!.by) }
      } else if (s.status !== 'pending' && i >= 0) runs.splice(i, 1)
    }
    this.write(this.fileOf(r.folder), { v: 1, folder: r.folder, readings, runs, ...(f.switches ? { switches: f.switches } : {}) } satisfies FolderFile)
    if (r.connectorsOn && r.login)
      this.setConnectors(
        r.login,
        at,
        servers.filter((s) => s.source === 'claudeai').map((s) => s.name),
      )
  }

  /** A conversation put in the trash is not counted: its reading leaves
   *  the window and what it gave a failing run leaves the run (a run left
   *  with nothing ends). Every folder's file when none is named. */
  forget(conversation: string, folder?: string): void {
    const files =
      folder !== undefined
        ? [this.fileOf(folder)]
        : (() => {
            try {
              return readdirSync(this.dir)
                .filter((n) => n.endsWith('.json') && n !== 'logins.json' && n !== MACHINE_FILE)
                .map((n) => join(this.dir, n))
            } catch {
              return []
            }
          })()
    for (const file of files) {
      if (!existsSync(file)) continue
      let j: unknown
      try {
        j = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      if (!isObj(j) || typeof j.folder !== 'string' || !Array.isArray(j.readings) || !Array.isArray(j.runs)) continue
      const readings = (j.readings as StoredReading[]).filter((x) => x.conversation !== conversation)
      let changed = readings.length !== j.readings.length
      const runs: FailureRun[] = []
      for (const run of j.runs as FailureRun[]) {
        const gave = run.by?.find(([c]) => c === conversation)?.[1] ?? 0
        if (gave === 0) {
          runs.push(run)
          continue
        }
        changed = true
        const by = run.by!.filter(([c]) => c !== conversation)
        if (run.count - gave > 0) runs.push({ ...run, count: run.count - gave, by })
      }
      if (changed)
        this.write(file, {
          v: 1,
          folder: j.folder,
          readings,
          runs,
          ...(Array.isArray(j.switches) ? { switches: j.switches as SwitchRecord[] } : {}),
        } satisfies FolderFile)
    }
  }

  /** «See what it sends»: a reading taken without a folder's local layer
   *  is no reading of that folder — only the login's connector list is
   *  kept from it. */
  recordSends(login: string, servers: { name: string; source?: string }[], at: number = this.now()): void {
    this.setConnectors(
      login,
      at,
      servers.filter((s) => s.source === 'claudeai' && typeof s.name === 'string' && s.name !== '').map((s) => s.name),
    )
  }

  private loginsFile(): string {
    return join(this.dir, 'logins.json')
  }
  private readLogins(): LoginsFile {
    try {
      const j = JSON.parse(readFileSync(this.loginsFile(), 'utf8')) as unknown
      if (isObj(j) && Array.isArray(j.logins)) return { v: 1, logins: j.logins as LoginsFile['logins'] }
    } catch {
      /* none yet */
    }
    return { v: 1, logins: [] }
  }
  private setConnectors(login: string, at: number, connectors: string[]): void {
    const f = this.readLogins()
    const prev = f.logins.find((l) => l.login === login)
    if (prev && prev.at > at) return
    const logins = f.logins.filter((l) => l.login !== login)
    logins.push({ login, at, connectors: [...new Set(connectors)].sort() })
    this.write(this.loginsFile(), { v: 1, logins } satisfies LoginsFile)
  }

  /** A login's connector list: its newest reading in any folder where
   *  connectors were on; null when none was. */
  connectorsOf(login: string): { at: number; connectors: string[] } | null {
    const l = this.readLogins().logins.find((x) => x.login === login)
    return l ? { at: l.at, connectors: l.connectors } : null
  }

  /** The folder's readings, newest first. */
  readings(folder: string): StoredReading[] {
    if (!existsSync(this.fileOf(folder))) return []
    return this.readFolder(folder)
      .readings.slice()
      .sort((a, b) => b.at - a.at)
  }
  runs(folder: string): FailureRun[] {
    return this.readFolder(folder).runs
  }

  /** A row the one writer just switched (the switched file's mtime after
   *  the write): kept, the newest SWITCHES_KEPT. Keyed by place: the
   *  project's in the folder's file; the machine's — one user file for
   *  every project — in `machine.json` (the folder is not part of it). */
  noteSwitch(folder: string, key: string, to: 'on' | 'off', mtime: number, at: number = this.now(), place: SwitchPlace = 'project'): void {
    const keep = (list: SwitchRecord[] | undefined): SwitchRecord[] =>
      [...(list ?? []).filter((x) => x.key !== key), { key, to, at, mtime }].sort((a, b) => b.at - a.at).slice(0, SWITCHES_KEPT)
    if (place === 'machine') {
      this.write(this.machineFile(), { v: 1, switches: keep(this.readMachine()) } satisfies MachineFile)
      return
    }
    const f = this.readFolder(folder)
    this.write(this.fileOf(folder), { v: 1, folder, readings: f.readings, runs: f.runs, switches: keep(f.switches) } satisfies FolderFile)
  }
  /** The switch records of a place, newest first: the folder's (project),
   *  or the machine's (the folder is not read). */
  switches(folder: string, place: SwitchPlace = 'project'): SwitchRecord[] {
    const list = place === 'machine' ? this.readMachine() : existsSync(this.fileOf(folder)) ? (this.readFolder(folder).switches ?? []) : []
    return list
      .filter((x) => isObj(x) && typeof x.key === 'string' && typeof x.at === 'number' && typeof x.mtime === 'number' && (x.to === 'on' || x.to === 'off'))
      .sort((a, b) => b.at - a.at)
  }

  private machineFile(): string {
    return join(this.dir, MACHINE_FILE)
  }
  private readMachine(): SwitchRecord[] {
    try {
      const j = JSON.parse(readFileSync(this.machineFile(), 'utf8')) as unknown
      if (isObj(j) && Array.isArray(j.switches)) return j.switches as SwitchRecord[]
    } catch {
      /* none yet */
    }
    return []
  }
}

/** The readings as the inventory takes them (exact names, the engine's source). */
export function asLoadsReadings(readings: StoredReading[]): LoadsReading[] {
  return readings.map((r) => ({
    at: r.at,
    login: r.login,
    servers: r.servers.map((s) => ({
      name: s.name,
      status: s.status,
      ...(s.source ? { source: s.source } : {}),
      ...(s.scope ? { scope: s.scope } : {}),
      ...(s.noAddress ? { noAddress: true as const } : {}),
    })),
  }))
}

/** The agents that hold a row — those whose own line of «Where it loads»
 *  has an entry (spec scopes §7: their readings are skipped for the
 *  project's health and weight, never «not read»). */
export function holdersOf(row: Pick<LoadsRow, 'at'>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const l of row.at ?? []) if (l.place === 'agent' && l.agent !== undefined && l.entry !== undefined) out.add(l.agent)
  return out
}

/** Whether a reading's conversation is held from the project's line: its
 *  agent holds the row (holdersOf), or its thread's own conversation line
 *  has an entry (spec scopes §7: a holder's reading — agent or
 *  conversation — never marks the project's line nor its health). `thread`:
 *  the conversation's thread as the server resolves it (the session id
 *  until a resolver is handed in). */
export function heldBy(row: Pick<LoadsRow, 'at'>, agent: string | undefined, thread: string | null | undefined): boolean {
  return (row.at ?? []).some(
    (l) =>
      l.entry !== undefined &&
      ((l.place === 'agent' && agent !== undefined && l.agent === agent) || (l.place === 'conversation' && thread != null && l.conversation === thread)),
  )
}

/** Each loading server or connector row gets its health: the newest reading
 *  that lists it — on its login, for a Claude account row. A placeholder,
 *  the same server as another, and a copy standing aside have none. */
export function withHealth(rows: LoadsRow[], readings: StoredReading[], threadOf: (conversation: string) => string | null = (c) => c): LoadsRow[] {
  const newest = readings.slice().sort((a, b) => b.at - a.at)
  return rows.map((row) => {
    if (row.kind === 'plugin' || !row.exact || row.state !== 'active' || row.replacedBy || row.placeholder || row.sameAs) return row
    for (const r of newest) {
      // the project's health: a reading of an agent or a conversation that
      // holds the row (its own entry, either way) is not a start the row
      // was expected to load in
      if (heldBy(row, r.agent, r.conversation ? threadOf(r.conversation) : null)) continue
      if (row.origin.owner === 'account' && row.origin.login != null && r.login !== row.origin.login) continue
      const s = r.servers.find((x) => x.name === row.name)
      if (!s) continue
      if (s.noAddress) return { ...row, placeholder: row.placeholder ?? {} }
      const health: LoadsHealth = {
        status: s.status,
        ...(s.reason ? { reason: s.reason } : {}),
        ...(s.tools !== undefined ? { tools: s.tools } : {}),
        read: { at: r.at, from: r.from, login: r.login, ...(r.via ? { via: r.via } : {}), ...(r.agent ? { agent: r.agent } : {}) },
      }
      return { ...row, health }
    }
    return row
  })
}
