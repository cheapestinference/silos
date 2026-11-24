import { EventEmitter } from 'node:events'
import type { SessionMeta, TranscriptTurn, SessionContext, DiskSubagent } from './types.js'
import { isFileBacked, type HarnessReader, type SessionToolCalls, type UsageRecord } from './harnesses/contract.js'

// The one index the server talks to: a neutral merger of harness readers.
// Each reader answers for the ids it ownsId(); the fallback answers for
// every id no other reader claims. Emission ('session'/'removed') happens
// here, from the readers' answers and their watch() signals.
export class SessionIndex extends EventEmitter {
  private ready = false
  constructor(private fallback: HarnessReader) {
    super()
    // subscribed once, where the fallback is set: the watcher refreshes
    // before init() runs, and its removals must already be announced
    this.relay(this.fallback)
  }

  get root(): string {
    return isFileBacked(this.fallback) ? this.fallback.root : ''
  }

  // Other harnesses' sessions flow through this same index: the server
  // keeps talking to ONE SessionIndex. A reader that ownsId() an id answers
  // for it; everything else is the fallback reader's.
  private readers: HarnessReader[] = []
  addReader(r: HarnessReader): void {
    this.readers.push(r)
  }
  private readerFor(id: string): HarnessReader {
    return this.readers.find((r) => r.ownsId(id)) ?? this.fallback
  }
  private noTranscriptFile(r: HarnessReader): Error {
    return new Error(`no transcript file: ${r.harness} session`)
  }

  // A session's tool calls and its children's, from the reader that owns
  // it (HarnessReader.toolCalls) — null when that reader can't say.
  toolCalls(folder: string, id: string): Promise<SessionToolCalls | null> {
    const r = this.readerFor(id)
    return r.toolCalls ? r.toolCalls(folder, id) : Promise.resolve(null)
  }

  // What a session used (HarnessReader.usageRecords), from the reader that
  // owns it — `unmeasured` when that reader can't say (Usage's «not measured
  // on <engine>»), null when it doesn't know the session.
  usageRecords(folder: string, id: string): Promise<UsageRecord[] | null | 'unmeasured'> {
    const r = this.readerFor(id)
    return r.usageRecords ? r.usageRecords(folder, id) : Promise.resolve('unmeasured')
  }

  // The roots of every reader whose sessions are files on disk — what the
  // machine sampler measures as «transcripts» (machine-sampler.ts).
  transcriptRoots(): string[] {
    return [...this.readers, this.fallback].filter(isFileBacked).map((r) => r.root)
  }

  // What Silos itself used outside any conversation, across every reader
  // that runs some of it (HarnessReader.silosOwnUsage).
  async silosOwnUsage(sinceMs: number): Promise<UsageRecord[]> {
    const out: UsageRecord[] = []
    for (const r of [...this.readers, this.fallback]) {
      if (r.silosOwnUsage) out.push(...(await r.silosOwnUsage(sinceMs).catch(() => [] as UsageRecord[])))
    }
    return out
  }

  // Whether this session's transcript is a file on disk (its reader is
  // file-backed) — what file scans (search) ask before pathOf().
  hasTranscriptFile(id: string): boolean {
    return isFileBacked(this.readerFor(id))
  }

  pathOf(folder: string, id: string): string {
    const r = this.readerFor(id)
    if (!isFileBacked(r)) throw this.noTranscriptFile(r)
    return r.transcriptPath(folder, id)
  }

  isReady(): boolean {
    return this.fallback.isReady?.() ?? this.ready
  }

  private relay(r: HarnessReader): void {
    r.watch((ref, kind) => {
      if (this.readerFor(ref.id) !== r) return // routed to another reader: not this one's to announce
      if (kind === 'removed') {
        this.emit('removed', ref.folder, ref.id)
        return
      }
      const meta = r.getMeta(ref.folder, ref.id)
      if (meta) this.emit('session', meta)
    })
  }

  async init(): Promise<void> {
    for (const r of this.readers) {
      // a broken second harness must never keep the fallback's sessions from loading
      await r.init().catch((err) => console.error(`[session-index] ${r.harness} reader init`, err instanceof Error ? err.message : err))
      this.relay(r)
    }
    // the fallback's init failure propagates: index.ts logs it as the initial scan failure
    await this.fallback.init()
    this.ready = true
  }

  // Every session, as ONE array kept between changes (the
  // overview resolved each row's owner through ancestors, and every hop
  // rebuilt this list — 1,500 sessions × 8 hops × 1,500 metas froze the
  // event loop for seconds). The fallback's rows (minus the ids another
  // reader owns) are kept per its revision(); a reader without one is
  // asked on every call. Callers never mutate the array or its metas.
  private rows: { key: string; fallback: SessionMeta[]; byId: Map<string, SessionMeta>; all: SessionMeta[] | null } | null = null
  private fallbackRows(): { key: string; fallback: SessionMeta[]; byId: Map<string, SessionMeta>; all: SessionMeta[] | null } {
    const rev = this.fallback.revision?.()
    const versioned = this.readers.map((r) => r.revision?.())
    const key = rev === undefined ? null : `${rev}|${this.readers.length}|${versioned.join(',')}`
    if (key !== null && this.rows?.key === key) return this.rows
    // an id another reader owns is that reader's row even if the fallback
    // found a file for it (getMeta/refresh route it away from the fallback)
    const fallback = this.readers.length === 0 ? this.fallback.list() : this.fallback.list().filter((m) => this.readerFor(m.id) === this.fallback)
    const byId = new Map<string, SessionMeta>()
    for (const m of fallback) if (!byId.has(m.id)) byId.set(m.id, m)
    const rows = { key: key ?? '', fallback, byId, all: null as SessionMeta[] | null }
    if (key !== null) this.rows = rows
    return rows
  }

  allSessions(): SessionMeta[] {
    const rows = this.fallbackRows()
    if (this.readers.length === 0) return rows.fallback
    // every other reader versioned: the concatenation is kept too
    const allVersioned = this.readers.every((r) => r.revision !== undefined) && rows.key !== ''
    if (allVersioned && rows.all) return rows.all
    const all = rows.fallback.concat(...this.readers.map((r) => r.list()))
    if (allVersioned) rows.all = all
    return all
  }

  /** The session with this id, as allSessions() would find it — an O(1)
   *  read of the kept rows for the fallback's sessions. */
  metaById(id: string): SessionMeta | null {
    const rows = this.fallbackRows()
    const hit = rows.byId.get(id)
    if (hit) return hit
    for (const r of this.readers) {
      const m = r.list().find((x) => x.id === id)
      if (m) return m
    }
    return null
  }

  getMeta(folder: string, id: string): SessionMeta | null {
    return this.readerFor(id).getMeta(folder, id)
  }

  // Conversation context — always cheap: state the reader already
  // accumulated in memory.
  getContext(folder: string, id: string): SessionContext | null {
    return this.readerFor(id).getContext(folder, id)
  }

  // Root directory of a session — the routes that serve a session's own
  // files build and validate (realpath) paths under it. File-backed readers only.
  sessionDir(folder: string, id: string): string {
    const r = this.readerFor(id)
    if (!isFileBacked(r)) throw this.noTranscriptFile(r)
    return r.sessionDir(folder, id)
  }

  async refresh(folder: string, id: string, emit = true): Promise<SessionMeta | null> {
    const r = this.readerFor(id)
    const meta = await r.refresh(folder, id)
    if (emit && meta && !r.hidden?.(folder, id)) this.emit('session', meta)
    return meta
  }

  // contract.ts worktreeSessions, over every engine that answers it (merged per dir)
  async worktreeSessions(project: string, dirs: readonly string[], sinceMs: number): Promise<Map<string, string[]>> {
    const out = new Map(dirs.map((d) => [d, [] as string[]]))
    for (const r of [...this.readers, this.fallback]) {
      if (!r.worktreeSessions) continue
      const m = await r.worktreeSessions(project, dirs, sinceMs).catch(() => null)
      for (const [d, ids] of m ?? []) {
        const l = out.get(d)
        if (l) for (const id of ids) if (!l.includes(id)) l.push(id)
      }
    }
    return out
  }

  async listSubagents(folder: string, id: string): Promise<DiskSubagent[]> {
    const r = this.readerFor(id)
    return isFileBacked(r) ? r.listSubagents(folder, id) : []
  }

  stopHeartbeat(): void {
    this.fallback.stop?.()
    for (const r of this.readers) r.stop?.()
  }

  remove(folder: string, id: string): void {
    // false = the reader never knew the id: nothing to announce
    if (this.readerFor(id).remove(folder, id) !== false) this.emit('removed', folder, id)
  }

  async readTurns(folder: string, id: string): Promise<TranscriptTurn[]> {
    return this.readerFor(id).readTurns(folder, id)
  }

  async flushCache(): Promise<void> {
    await this.fallback.flush?.()
    for (const r of this.readers) await r.flush?.()
  }
}
