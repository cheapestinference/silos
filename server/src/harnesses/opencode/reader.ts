// harnesses/opencode/reader — OpenCode sessions as a HarnessReader, merged
// into the one SessionIndex (session-index.ts addReader). Two kinds of
// source, both opened read-only (db.ts):
//   · each live agent's own DB, <dataDir>/agents/<id>/opencode.db — a
//     session read there belongs to that agent (agentOfDb);
//   · the operator's global DB (paths.ts globalDbPath) — "external"
//     sessions, no owner recorded, exactly like a claude run by hand.
// Same skip rule as Claude Code's index: a session whose directory munges
// to a muted or ephemeral (tmpdir) folder is never indexed. A child session
// that is a subagent (parent_id set, first message's agent ≠ 'build') is
// not a row: it shows in its parent's context as a SubagentRef. Deleting
// HIDES (hidden.ts) — the databases are never written. A permission the
// session's agent is waiting on (asks-store.ts, written by the plugin) is
// its context.pending and lights its pendingAsk dot — and so is a question
// of OpenCode's `question` tool, shown with its own options, for as long as
// its tool call still waits in the DB (stillAsking).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AgentRegistry } from '../../agent-registry.js'
import { mungePath } from '../../agent-registry.js'
import { isEphemeralFolder } from '../../ephemeral.js'
import type { SessionContext, SessionMeta, SubagentRef, TranscriptTurn } from '../../types.js'
import type { HarnessReader, SessionRef, SessionToolCalls } from '../contract.js'
import { opencodeToolCalls } from './tool-calls.js'
import { harnessForId } from '../registry.js'
import { OpenCodeDb, type MessageRow, type PartRow, type SessionRow } from './db.js'
import { HiddenList } from './hidden.js'
import { loadSqlite, type DatabaseSyncCtor } from './sqlite.js'
import { contextOf, metaOf, turnsOf } from './map.js'
import { agentDbPath } from './paths.js'
import { askLine, type AsksStore, type PendingAsk } from '../../asks-store.js'

const DEBOUNCE_MS = 150
const DEBOUNCE_MAX_MS = 1000 // a DB written more often than the debounce is still scanned this often
const POLL_MS = 5_000 // when fs.watch is unavailable
const SOURCES_MS = 10_000 // how often a newly created agent DB is looked for while watching

type Kind = 'created' | 'updated' | 'removed'
type Listener = (ref: SessionRef, kind: Kind) => void

interface Source {
  path: string
  agentId: string | null // null = the operator's global DB
  db: OpenCodeDb | null
  lastSeen: number // newest session.time_updated read from this DB
  stop: (() => void) | null
  debounce: ReturnType<typeof setTimeout> | null
  pendingSince: number | null // first fs event not yet scanned (bounds the debounce)
}

interface Known {
  row: SessionRow
  source: Source
  meta: SessionMeta
  sub: SubagentRef | null // set when this session is a subagent of row.parent_id
}

export interface OpenCodeReaderOptions {
  dataDir: string
  registry: AgentRegistry
  globalDb: string | null
  muted: readonly string[]
  ephemeralPrefix: string | null
  /** The plugin's pending permission asks — absent: no session ever waits. */
  asks?: AsksStore
  now?: () => number
  /** node:sqlite's loader — injectable to test a Node without it. */
  sqlite?: () => DatabaseSyncCtor
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** A session's pending ask as context.pending — the newest ask wins. A
 *  question carries its own options (and questions 2..n as `more`, the
 *  shape AskUserQuestion has on Claude); a permission is Allow / Deny. */
export function pendingOf(asks: readonly PendingAsk[]): SessionContext['pending'] | null {
  const newest = [...asks].sort((a, b) => b.askedAt.localeCompare(a.askedAt))[0]
  if (!newest) return null
  if (newest.type === 'question' && newest.questions && newest.questions.length > 0) {
    const one = (q: NonNullable<PendingAsk['questions']>[number]) => ({
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      options: q.options.map((o) => (o.description ? { label: o.label, description: o.description } : { label: o.label })),
      ...(q.multiple ? { multiSelect: true } : {}),
    })
    const [first, ...rest] = newest.questions
    return { ...one(first!), ...(rest.length > 0 ? { more: rest.map(one) } : {}), askedAt: newest.askedAt }
  }
  return { question: askLine(newest), header: 'Permission', options: [{ label: 'Allow' }, { label: 'Deny' }], askedAt: newest.askedAt }
}

/** A question ask still waits when its tool call is pending/running in the
 *  session's parts — or is not written yet (the plugin's file can land
 *  before OpenCode's DB write). A call that completed or failed (answered,
 *  rejected, or its process died) is stale: never pending again. */
export function stillAsking(ask: PendingAsk, parts: readonly PartRow[]): boolean {
  if (ask.type !== 'question' || !ask.callId) return true
  const part = parts.find((p) => p.data.type === 'tool' && p.data.callID === ask.callId)
  if (!part || part.data.type !== 'tool') return true
  return part.data.state.status === 'pending' || part.data.state.status === 'running'
}

function subagentOf(row: SessionRow, msgs: MessageRow[]): SubagentRef | null {
  const agent = msgs[0]?.data.agent
  if (!row.parent_id || agent === 'build') return null
  const ref: SubagentRef = { id: row.id, description: row.title, type: agent ?? 'subagent', background: false, startedAt: iso(row.time_created) }
  const assistants = msgs.flatMap((m) => (m.data.role === 'assistant' ? [m.data] : []))
  const last = assistants.at(-1)
  if (last) ref.model = `${last.providerID}/${last.modelID}`
  const tail = msgs.at(-1)?.data
  if (tail?.role === 'assistant' && tail.finish === 'stop' && tail.time?.completed) ref.endedAt = iso(tail.time.completed)
  return ref
}

export class OpenCodeReader implements HarnessReader {
  readonly harness = 'opencode' as const
  private readonly sources: Source[] = []
  private readonly known = new Map<string, Known>()
  private readonly ownerByAgentDb = new Map<string, string>()
  // every source whose rows hold an id — a genuine session lives in ONE DB
  // (OPENCODE_DB points each agent at its own file); an id in two is
  // contested: no owner, listed only from the global DB.
  private readonly homes = new Map<string, Set<Source>>()
  private readonly contested = new Set<string>()
  // the contest is durable (<dataDir>/contested-sessions.json, Silos-owned):
  // an agent deleting its copy after the fact must not restore a native
  // record sealed for that copy across a restart (session-owner.ts).
  private readonly contestedFile: string
  private readonly warnedIds = new Set<string>()
  private readonly hiddenList: HiddenList
  private readonly muted: Set<string>
  private readonly listeners = new Set<Listener>()
  private sourcesTimer: ReturnType<typeof setInterval> | null = null
  private sqliteMissing = false

  constructor(private readonly opts: OpenCodeReaderOptions) {
    this.hiddenList = new HiddenList(opts.dataDir, opts.now)
    this.muted = new Set(opts.muted)
    this.contestedFile = join(opts.dataDir, 'contested-sessions.json')
    this.loadContested()
  }

  ownsId(id: string): boolean {
    return harnessForId(id) === 'opencode'
  }

  async init(): Promise<void> {
    if (this.opts.globalDb) this.addSource(this.opts.globalDb, null)
    this.syncAgentSources()
  }

  /** The agent whose own DB holds this session; null for the global DB or unknown. */
  agentOfDb(sessionId: string): string | null {
    return this.ownerByAgentDb.get(sessionId) ?? null
  }

  private loadContested(): void {
    try {
      const raw = JSON.parse(readFileSync(this.contestedFile, 'utf8')) as unknown
      if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string' && harnessForId(id) === 'opencode') this.contested.add(id)
    } catch {
      /* none yet (or unreadable: start empty, the DBs re-contest) */
    }
  }

  private saveContested(): void {
    try {
      mkdirSync(dirname(this.contestedFile), { recursive: true })
      const tmp = `${this.contestedFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify([...this.contested].sort()) + '\n', { mode: 0o600 })
      renameSync(tmp, this.contestedFile)
    } catch (err) {
      console.warn(`[opencode] could not record contested sessions: ${(err as Error).message}`)
    }
  }

  /** True once the id was seen in more than one DB — sticky and durable (fails closed). */
  isContested(sessionId: string): boolean {
    return this.contested.has(sessionId)
  }

  list(): SessionMeta[] {
    return [...this.known.values()].filter((k) => this.listed(k)).map((k) => this.withAsk(k.meta))
  }

  getMeta(_folder: string, id: string): SessionMeta | null {
    const k = this.known.get(id)
    return k && this.listed(k) ? this.withAsk(k.meta) : null
  }

  /**
   * The asks that count for a session: only those its OWN agent's plugin
   * wrote (an agent can write any file under its state dir, including an
   * ask naming another agent's session).
   */
  private asksOf(id: string): PendingAsk[] {
    const owner = this.ownerByAgentDb.get(id)
    if (!this.opts.asks || !owner) return []
    const mine = this.opts.asks.forSession(id).filter((a) => a.agentId === owner)
    if (!mine.some((a) => a.type === 'question' && a.callId)) return mine
    // a question counts only while its tool call waits (stillAsking)
    const k = this.known.get(id)
    const db = k ? this.dbOf(k.source) : null
    let parts: PartRow[] = []
    try {
      parts = db ? db.parts(id) : []
    } catch {
      return mine
    }
    return mine.filter((a) => stillAsking(a, parts))
  }

  /** The asks of a session that still wait — the answer route's view. */
  pendingAsks(id: string): PendingAsk[] {
    return this.asksOf(id)
  }

  private withAsk(meta: SessionMeta): SessionMeta {
    return this.asksOf(meta.id).length > 0 ? { ...meta, pendingAsk: true } : meta
  }

  getContext(_folder: string, id: string): SessionContext | null {
    const k = this.visible(id)
    const db = k && this.dbOf(k.source)
    if (!k || !db) return null
    try {
      const ctx = contextOf(k.row, db.messages(id), db.parts(id), pendingOf(this.asksOf(id)), db.todos(id))
      ctx.agents = [...this.known.values()]
        .flatMap((c) => (c.sub && c.row.parent_id === id ? [c.sub] : []))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      return ctx
    } catch (err) {
      this.warn(k.source, err)
      return null
    }
  }

  async readTurns(_folder: string, id: string): Promise<TranscriptTurn[]> {
    const k = this.visible(id)
    const db = k && this.dbOf(k.source)
    if (!k || !db) return []
    return turnsOf(db.messages(id), db.parts(id))
  }

  // The audit's read (contract.ts toolCalls): the session's tool parts and
  // those of every session below it by `parent_id` (subagents, at any
  // depth), from the DB that holds it. A hidden session is still read:
  // hiding is a Silos-side view, never a reason to audit less.
  async toolCalls(_folder: string, id: string): Promise<SessionToolCalls | null> {
    const k = this.known.get(id)
    for (const source of k ? [k.source] : this.sources) {
      const db = this.dbOf(source)
      if (!db) continue
      try {
        if (!k && !db.session(id)) continue
        const calls = opencodeToolCalls(db.parts(id), id)
        const children: string[] = []
        const queue = [id]
        const seen = new Set<string>([id])
        while (queue.length > 0 && seen.size < 512) {
          for (const c of db.children(queue.shift()!)) {
            if (seen.has(c.id)) continue
            seen.add(c.id)
            queue.push(c.id)
            children.push(c.id)
            calls.push(...opencodeToolCalls(db.parts(c.id), c.id))
          }
        }
        return { calls, children }
      } catch (err) {
        this.warn(source, err)
      }
    }
    return null
  }

  async refresh(_folder: string, id: string): Promise<SessionMeta | null> {
    const k = this.known.get(id)
    for (const source of k ? [k.source] : this.sources) {
      const db = this.dbOf(source)
      if (!db) continue
      try {
        const row = db.session(id)
        if (!row) continue
        const fresh = this.load(source, row)
        return fresh && this.listed(fresh) ? fresh.meta : null
      } catch (err) {
        this.warn(source, err)
      }
    }
    if (k) this.known.delete(id) // gone from its DB
    return null
  }

  // Never invokes the watch callback: SessionIndex.remove emits 'removed' itself.
  remove(_folder: string, id: string): void {
    this.hiddenList.add(id)
  }

  watch(onChange: Listener): () => void {
    this.listeners.add(onChange)
    if (this.listeners.size === 1) this.startWatching()
    return () => {
      this.listeners.delete(onChange)
      if (this.listeners.size === 0) this.stopWatching()
    }
  }

  close(): void {
    this.listeners.clear()
    this.stopWatching()
    for (const s of this.sources) {
      s.db?.close()
      s.db = null
    }
  }

  // ── sources ─────────────────────────────────────────────────────────────

  private addSource(path: string, agentId: string | null): void {
    if (!existsSync(path) || this.sources.some((s) => s.path === path)) return
    const source: Source = { path, agentId, db: null, lastSeen: 0, stop: null, debounce: null, pendingSince: null }
    // agent DBs first: a session found in both is the agent's
    if (agentId) this.sources.unshift(source)
    else this.sources.push(source)
    const db = this.dbOf(source)
    if (!db) return
    try {
      this.loadRows(source, db.sessions(), () => {})
    } catch (err) {
      this.warn(source, err)
    }
    if (this.listeners.size > 0) this.attach(source)
  }

  // An agent created after start gets its DB on its first run — looked for
  // again while watching, and its sessions arrive as 'created'.
  private syncAgentSources(): void {
    for (const a of this.opts.registry.list()) {
      const path = agentDbPath(this.opts.dataDir, a.id)
      if (this.sources.some((s) => s.path === path) || !existsSync(path)) continue
      const before = new Set(this.known.keys())
      this.addSource(path, a.id)
      for (const [id, k] of this.known) if (!before.has(id) && this.listed(k)) this.emit(k, 'created')
    }
  }

  private dbOf(source: Source): OpenCodeDb | null {
    if (source.db) return source.db
    const sqlite = this.sqlite()
    if (!sqlite) return null
    try {
      source.db = new OpenCodeDb(source.path, () => sqlite)
    } catch (err) {
      this.warn(source, err)
    }
    return source.db
  }

  // A Node without node:sqlite reads no OpenCode sessions — said once, never thrown.
  private sqlite(): DatabaseSyncCtor | null {
    if (this.sqliteMissing) return null
    try {
      return (this.opts.sqlite ?? loadSqlite)()
    } catch (err) {
      this.sqliteMissing = true
      console.error(`opencode: node:sqlite unavailable (${err instanceof Error ? err.message : String(err)}) — OpenCode sessions will not be read`)
      return null
    }
  }

  private warn(source: Source, err: unknown): void {
    console.error(`[opencode] ${source.path}:`, err instanceof Error ? err.message : err)
  }

  // ── sessions ────────────────────────────────────────────────────────────

  private skipped(directory: string): boolean {
    const folder = mungePath(directory)
    if (this.muted.has(folder)) return true
    return this.opts.ephemeralPrefix !== null && isEphemeralFolder(folder, this.opts.ephemeralPrefix)
  }

  // Reads one session's rows into memory; null when its folder is skipped.
  // Agents share the uid and can write their own DB with sqlite3, so a row
  // proves nothing by itself:
  //  · an id that is not OpenCode-shaped (`ses_…`) — e.g. a Claude session
  //    UUID planted to claim it — is ignored: never listed, never owned;
  //  · an id held by MORE THAN ONE DB (two agents', or an agent's and the
  //    global) is contested: no owner (agentOfDb null), listed from the
  //    global DB only when it is there, otherwise not at all.
  private load(source: Source, row: SessionRow): Known | null {
    if (harnessForId(row.id) !== 'opencode') {
      this.warnId(row.id, `[opencode] ${source.path}: session id ${row.id} is not an OpenCode id — ignored`)
      return null
    }
    const homes = this.homes.get(row.id) ?? new Set<Source>()
    homes.add(source)
    this.homes.set(row.id, homes)
    // in more than one DB now, or contested before (recorded): no owner
    if (homes.size > 1 || this.contested.has(row.id)) {
      if (!this.contested.has(row.id)) {
        this.contested.add(row.id)
        this.saveContested()
      }
      this.ownerByAgentDb.delete(row.id)
      this.warnId(row.id, `[opencode] session ${row.id} is in more than one database — no owner; listed from the global DB only`)
      const prev = this.known.get(row.id)
      if (prev?.source.agentId) {
        this.known.delete(row.id)
        if (this.listed(prev)) this.emit(prev, 'removed')
      }
      if (source.agentId) return null
    }
    if (this.skipped(row.directory)) return null
    const db = this.dbOf(source)
    if (!db) return null
    const msgs = db.messages(row.id)
    const k: Known = { row, source, meta: metaOf(row, msgs, db.parts(row.id), {}), sub: subagentOf(row, msgs) }
    this.known.set(row.id, k)
    if (source.agentId) this.ownerByAgentDb.set(row.id, source.agentId)
    return k
  }

  private warnId(id: string, message: string): void {
    if (this.warnedIds.has(id)) return
    this.warnedIds.add(id)
    console.warn(message)
  }

  private listed(k: Known): boolean {
    return k.sub === null && !this.hiddenList.has(k.row.id)
  }

  private visible(id: string): Known | null {
    const k = this.known.get(id)
    return k && !this.hiddenList.has(id) ? k : null
  }

  // ── watching ────────────────────────────────────────────────────────────

  private startWatching(): void {
    for (const s of this.sources) this.attach(s)
    this.sourcesTimer = setInterval(() => this.syncAgentSources(), SOURCES_MS)
    this.sourcesTimer.unref()
  }

  private stopWatching(): void {
    if (this.sourcesTimer) clearInterval(this.sourcesTimer)
    this.sourcesTimer = null
    for (const s of this.sources) {
      s.stop?.()
      s.stop = null
      if (s.debounce) clearTimeout(s.debounce)
      s.debounce = null
      s.pendingSince = null
    }
  }

  // fs.watch on the DB's directory, filtered to <name>.db / <name>.db-wal;
  // a 5 s poll when the platform refuses the watch.
  private attach(source: Source): void {
    if (source.stop) return
    const name = basename(source.path)
    const poll = () => {
      const t = setInterval(() => this.scan(source), POLL_MS)
      t.unref()
      source.stop = () => clearInterval(t)
    }
    let w: FSWatcher
    try {
      w = fsWatch(dirname(source.path), (_ev, file) => {
        if (file !== null && file !== name && file !== `${name}-wal`) return
        const now = Date.now()
        source.pendingSince ??= now
        if (source.debounce) clearTimeout(source.debounce)
        const wait = Math.min(DEBOUNCE_MS, Math.max(0, source.pendingSince + DEBOUNCE_MAX_MS - now))
        source.debounce = setTimeout(() => {
          source.debounce = null
          source.pendingSince = null
          this.scan(source)
        }, wait)
      })
    } catch {
      poll()
      return
    }
    w.on('error', () => {
      w.close()
      poll()
    })
    source.stop = () => w.close()
  }

  private scan(source: Source): void {
    const db = this.dbOf(source)
    if (!db) return
    try {
      const ids = db.updatedSince(source.lastSeen).map((r) => r.id)
      const rows = ids.flatMap((id) => {
        const row = db.session(id)
        return row ? [row] : []
      })
      this.loadRows(source, rows, (k, wasKnown) => {
        if (k.sub) {
          // a subagent's work is its parent's activity
          const parent = k.row.parent_id ? this.known.get(k.row.parent_id) : undefined
          if (parent && this.listed(parent)) this.emit(parent, 'updated')
        } else if (this.listed(k)) {
          this.emit(k, wasKnown ? 'updated' : 'created')
        }
      })
    } catch (err) {
      this.warn(source, err) // the query itself failed: lastSeen did not move, the next event retries
    }
  }

  // Loads each row on its own; lastSeen advances only past rows that LOADED.
  // A row that throws (busy, locked) caps lastSeen just below it, so the next
  // scan reads it again — whatever order the rows came in.
  private loadRows(source: Source, rows: SessionRow[], loaded: (k: Known, wasKnown: boolean) => void): void {
    let newestOk = source.lastSeen
    let oldestFailed = Infinity
    for (const row of rows) {
      try {
        const wasKnown = this.known.has(row.id)
        const k = this.load(source, row)
        newestOk = Math.max(newestOk, row.time_updated)
        if (k) loaded(k, wasKnown)
      } catch (err) {
        oldestFailed = Math.min(oldestFailed, row.time_updated)
        this.warn(source, err)
      }
    }
    source.lastSeen = Math.max(source.lastSeen, Math.min(newestOk, oldestFailed - 1))
  }

  private emit(k: Known, kind: Kind): void {
    const ref: SessionRef = { harness: 'opencode', folder: k.meta.folder, id: k.row.id }
    for (const l of this.listeners) l(ref, kind)
  }
}
