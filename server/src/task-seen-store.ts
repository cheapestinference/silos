// task-seen-store.ts — «new to you» on a plan task: when the owner last looked at each task and in which state they left it,
// in ~/.silos/task-seen.json. It is the owner's state, so it lives on the server
// (desktop and phone read the same marks), never in the plan: the plan file is
// the agents' truth and Silos does not write a read mark into it.
//
// Its own file, not seen.json: that one's keys are conversations and its sweep
// prunes whatever the session index does not know.
//
// `since` is the moment the book opened. Nothing older reads as new: on the first
// day the whole history is not bold. Same discipline as seen-store.ts: tolerant
// load, a .corrupt-<stamp> backup before starting over, atomic write.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'

export interface TaskSeenMark {
  at: number
  // the state the owner left it in: a state change is «another's» when the state
  // differs from this, with no race against when the journal noticed their own
  state: string
}
export interface TaskSeenBook {
  since: number
  seen: Record<string, TaskSeenMark>
}

// a bound against a file growing forever: the oldest marks go first (a mark that
// goes reads as «never looked», which `since` still keeps quiet for old tasks)
const MAX_MARKS = 20_000

const validMark = (v: unknown): v is TaskSeenMark => {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return typeof m.at === 'number' && Number.isFinite(m.at) && m.at >= 0 && typeof m.state === 'string'
}

export class TaskSeenStore {
  private book: TaskSeenBook
  private file: string

  constructor(
    dataDir: string,
    private now: () => number = () => Date.now(),
  ) {
    this.file = join(dataDir, 'task-seen.json')
    this.book = { since: this.now(), seen: {} }
  }

  load(): void {
    if (!existsSync(this.file)) {
      this.save()
      return
    }
    const text = readFileSync(this.file, 'utf8')
    let raw: Partial<TaskSeenBook>
    try {
      raw = JSON.parse(text) as Partial<TaskSeenBook>
    } catch {
      backupCorruptJson(this.file, text, 'task-seen-store')
      this.save()
      return
    }
    const since = typeof raw.since === 'number' && Number.isFinite(raw.since) && raw.since >= 0 ? raw.since : this.book.since
    const entries = raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? raw.seen : {}
    const seen: Record<string, TaskSeenMark> = {}
    for (const [key, mark] of Object.entries(entries)) if (validMark(mark)) seen[key] = { at: mark.at, state: mark.state }
    this.book = { since, seen }
  }

  read(): TaskSeenBook {
    return this.book
  }

  mark(key: string, state: string): TaskSeenMark {
    const mark = { at: this.now(), state }
    this.book.seen[key] = mark
    const keys = Object.keys(this.book.seen)
    if (keys.length > MAX_MARKS) {
      keys.sort((a, b) => this.book.seen[a]!.at - this.book.seen[b]!.at)
      for (const k of keys.slice(0, keys.length - MAX_MARKS)) delete this.book.seen[k]
    }
    this.save()
    return mark
  }

  private save(): void {
    atomicWriteJson(this.file, this.book, { mode: 0o600 })
  }
}
