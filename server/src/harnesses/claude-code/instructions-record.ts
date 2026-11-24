// harnesses/claude-code/instructions-record.ts — THE one reader of what a
// conversation's instruction files are, from its own transcript (spec
// memory-places §6). A start that loads instruction files writes an
// `attachment` record of type `instructions`, `files: [{path, type,
// content}]`; a later start writes a DELTA — `changed: true`, `reason`, the
// new or changed `files`, the `removed` paths; an on-demand load writes a
// `nested_memory` record (`path`, `content.type`, `content.parent` for an
// import). What is in force is the engine's own replay: the last record
// without `changed`, then each later one's `files` and `removed`.
//
// No record is not «not read»: the CLI writes nothing when the set did not
// change, and nothing on a fresh conversation that loads no file. So the
// reader also keeps the starts it sees (a SessionStart hook record followed
// by a reply; a caller may add the starts it knows from elsewhere): a start
// after the last record reads as `unchanged`, a start with no record ever as
// `empty`, no start and no record as `unread`.
//
// Pure and tolerant: a damaged line or an unknown shape is skipped, never
// thrown on. Used by Started with (the first turn's files and now's), the
// Memory rows' weight (instructions.ts) and, later, the column and the proof.

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** One file as a record names it. */
export interface RecordedFile {
  path: string
  /** the engine's type: User · Project · Local · Managed · AutoMem (or '' when unsaid) */
  type: string
  content: string
  /** an import's parent, for a nested load */
  parent?: string
  /** the record's timestamp (ISO), or null */
  at: string | null
}

export interface InstructionsRecordReading {
  /** in force by the replay, in the order the records list them */
  files: RecordedFile[]
  /** on-demand loads since the last base */
  nested: RecordedFile[]
  /** recorded: a record is in force · unchanged: a start after the last record
   *  (the set did not change) · empty: starts seen, never a record (a fresh
   *  conversation that loaded no file) · unread: neither */
  state: 'recorded' | 'unchanged' | 'empty' | 'unread'
  lastRecordAt: string | null
  lastStartAt: string | null
  /** every start the record shows (a start hook followed by a reply), ISO, in order */
  starts: string[]
}

const ms = (iso: string | null): number => (iso === null ? NaN : Date.parse(iso))

/** The replay, fed records (or lines) in file order. */
export class InstructionsReplay {
  private inForce = new Map<string, RecordedFile>()
  private nestedLoads = new Map<string, RecordedFile>()
  private recorded = false
  private lastRecord: string | null = null
  private lastStart: string | null = null
  /** a start hook seen, waiting for the reply that makes it a start (its timestamp) */
  private pendingStart: { at: string | null } | null = null
  private startSeen = false
  private startList: string[] = []
  private unnamed = 0

  clone(): InstructionsReplay {
    const c = new InstructionsReplay()
    c.inForce = new Map(this.inForce)
    c.nestedLoads = new Map(this.nestedLoads)
    c.recorded = this.recorded
    c.lastRecord = this.lastRecord
    c.lastStart = this.lastStart
    c.pendingStart = this.pendingStart
    c.startSeen = this.startSeen
    c.startList = [...this.startList]
    c.unnamed = this.unnamed
    return c
  }

  /** More transcript lines, in file order (damaged lines skipped). */
  feed(lines: readonly string[]): this {
    for (const line of lines) {
      if (!line) continue
      let r: unknown
      try {
        r = JSON.parse(line)
      } catch {
        continue
      }
      if (isRec(r)) this.record(r)
    }
    return this
  }

  /** One parsed transcript record. */
  record(r: Rec): void {
    const at = typeof r.timestamp === 'string' ? r.timestamp : null
    if (r.type === 'assistant') {
      if (this.pendingStart !== null) {
        this.lastStart = this.pendingStart.at ?? this.lastStart
        this.startSeen = true
        if (this.pendingStart.at !== null) this.startList.push(this.pendingStart.at)
        this.pendingStart = null
      }
      return
    }
    if (r.type !== 'attachment' || !isRec(r.attachment)) return
    this.attachment(r.attachment, at)
  }

  /** One attachment (the record's `attachment`), with the record's timestamp. */
  attachment(a: Rec, at: string | null): void {
    if (a.hookEvent === 'SessionStart' && typeof a.type === 'string' && a.type.startsWith('hook_')) {
      if (this.pendingStart === null) this.pendingStart = { at }
      return
    }
    if (a.type === 'instructions') {
      const files = Array.isArray(a.files) ? a.files.filter(isRec) : []
      if (a.changed !== true) {
        // a base: what this start loaded, whole
        this.inForce.clear()
        this.nestedLoads.clear()
      }
      for (const f of files) {
        // a file with no path (never seen; tolerated) is kept under a key of its own
        const path = str(f.path)
        this.inForce.set(path === '' ? `\0${this.unnamed++}` : path, { path, type: str(f.type), content: str(f.content), at })
      }
      if (Array.isArray(a.removed)) {
        for (const x of a.removed) {
          const path = typeof x === 'string' ? x : isRec(x) ? str(x.path) : ''
          if (path === '') continue
          this.inForce.delete(path)
          this.nestedLoads.delete(path)
        }
      }
      this.recorded = true
      this.lastRecord = at
      return
    }
    if (a.type === 'nested_memory') {
      const path = str(a.path)
      if (path === '') return
      const c = a.content
      const type = isRec(c) ? str(c.type) : ''
      const content = isRec(c) ? str(c.content) : typeof c === 'string' ? c : ''
      const parent = isRec(c) ? str(c.parent) : ''
      this.nestedLoads.set(path, { path, type, content, at, ...(parent ? { parent } : {}) })
    }
  }

  /** The files in force, as the started-with drafts read them ({path, type, content}). */
  filesInForce(): Rec[] {
    return [...this.inForce.values()].map((f) => ({ path: f.path, type: f.type, content: f.content }))
  }

  /** The reading so far; `starts` adds starts the caller knows from
   *  elsewhere (a turn's status, the ledger), epoch ms, each followed by a reply. */
  reading(starts: readonly number[] = []): InstructionsRecordReading {
    let lastStart = this.lastStart
    let seen = this.startSeen
    const known = Math.max(-Infinity, ...starts.filter(Number.isFinite))
    if (Number.isFinite(known)) {
      seen = true
      if (!(ms(lastStart) >= known)) lastStart = new Date(known).toISOString()
    }
    const startMs = ms(lastStart)
    const state: InstructionsRecordReading['state'] = this.recorded
      ? seen && startMs > ms(this.lastRecord)
        ? 'unchanged'
        : 'recorded'
      : seen
        ? 'empty'
        : 'unread'
    return {
      files: [...this.inForce.values()],
      nested: [...this.nestedLoads.values()],
      state,
      lastRecordAt: this.lastRecord,
      lastStartAt: lastStart,
      starts: [...this.startList],
    }
  }
}

/** A transcript's lines (all of them) → its reading. */
export function readInstructionsRecord(lines: readonly string[], starts: readonly number[] = []): InstructionsRecordReading {
  return new InstructionsReplay().feed(lines).reading(starts)
}

/** Whether a transcript line can matter to the replay — a cheap test before
 *  parsing, for callers that read big transcripts. */
export function mayMatter(line: string): boolean {
  return line.includes('"instructions"') || line.includes('"nested_memory"') || line.includes('SessionStart') || line.includes('"type":"assistant"')
}
