// task-mode/owner-notes.ts — WHICH notes are the owner's. A note's `by` is whatever the plan file says,
// and a plan file is written by agents too: an agent that signs a note
// "owner" (a prompt injection, or an agent transcribing «OK from the owner in
// chat») must not get the owner's powers — a note of the owner wakes, reopens
// a closed task and skips the throttle — nor be painted as «You».
//
// So a note counts as the owner's only when Silos itself RECORDED the owner
// writing it: the kernel's append-item event on that task key, by `owner`,
// whose `detail` carries the note's EXACT `at` and the digest of its full
// text (silos/actions.ts appendItem — every owner note box, «Answer & done»,
// Drop, respond go through it). ONE event vouches for exactly ONE note: two
// notes alike in the file need two events. Anything else signed "owner" is an
// agent's note. Task mode's wakes, the briefings and every screen read this
// one check (fromOwner on the task views — silos/views.ts).
//
// The same matching says which of the owner's recorded notes are MISSING
// from the file (`lost`): an agent's write from an old copy (OpenCode, jq,
// python — anything but Silos' own CAS) replaced the file without it. Task
// mode says so on the task (engine.ts sayLostOwnerNotes).
//
// Cheap: the events log (silos/events.jsonl) is read INCREMENTALLY — only the
// bytes appended since the last call — and indexed by record key. A log that
// shrank or was replaced is read again whole.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { childDigest } from '../silos/child-digest.js'

// the fields of a plan task's note the digest covers (plans.silo.json:
// plan/task/note declares `text` alone)
export const NOTE_FIELDS = ['text'] as const
export const noteDigest = (text: string): string => childDigest({ text }, NOTE_FIELDS)
const PREFIX = 'added to notes: '

// one recorded owner note: its exact moment, its digest, and the event's
// line (clipped) — the words a lost note is said with. `closes`: written by
// a verb that CLOSES the task (approve, drop,
// silos/actions.ts taskGesture): that note neither reopens nor wakes
export interface OwnerSaid {
  at: string
  digest: string
  text: string
  closes?: true
}

// for one task: per note (in the file's order) whether the owner wrote it,
// whether that note closed it (`closes`, same order), and the owner's
// recorded notes the file no longer holds
export interface OwnerNoteMatch {
  fromOwner: boolean[]
  closes: boolean[]
  lost: OwnerSaid[]
}
export type OwnerNoteCheck = (taskKey: string, notes: ReadonlyArray<{ at: string; text: string }>) => OwnerNoteMatch

// One-to-one: each recorded event vouches for the first note not yet vouched
// for with the same `at` and digest.
export function matchOwnerNotes(said: readonly OwnerSaid[], notes: ReadonlyArray<{ at: string; text: string }>): OwnerNoteMatch {
  const free = [...said]
  const closes: boolean[] = []
  const fromOwner = notes.map((n) => {
    closes.push(false)
    if (free.length === 0) return false
    const d = noteDigest(n.text)
    const i = free.findIndex((s) => s.at === n.at && s.digest === d)
    if (i < 0) return false
    closes[closes.length - 1] = free[i]!.closes === true
    free.splice(i, 1)
    return true
  })
  return { fromOwner, closes, lost: free }
}

export class OwnerNoteLedger {
  private offset = 0
  private ino = -1
  private tail = '' // a partial last line, kept for the next read
  private byKey = new Map<string, OwnerSaid[]>()

  constructor(
    private file: string,
    private silo: string,
  ) {}

  private refresh(): void {
    let st: { size: number; ino: number }
    try {
      st = statSync(this.file)
    } catch {
      this.reset()
      return
    }
    if (st.ino !== this.ino || st.size < this.offset) {
      this.reset()
      this.ino = st.ino
    }
    if (st.size === this.offset) return
    let fd: number
    try {
      fd = openSync(this.file, 'r')
    } catch {
      return
    }
    try {
      const size = fstatSync(fd).size
      const len = size - this.offset
      if (len <= 0) return
      const buf = Buffer.alloc(len)
      let read = 0
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, this.offset + read)
        if (n <= 0) break
        read += n
      }
      this.offset += read
      const text = this.tail + buf.subarray(0, read).toString('utf8')
      const lines = text.split('\n')
      this.tail = lines.pop() ?? ''
      for (const line of lines) this.take(line)
    } finally {
      closeSync(fd)
    }
  }

  private reset(): void {
    this.offset = 0
    this.ino = -1
    this.tail = ''
    this.byKey.clear()
  }

  private take(line: string): void {
    if (line.trim() === '' || !line.includes('"append-item"')) return
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      return
    }
    if (typeof e !== 'object' || e === null) return
    const ev = e as Record<string, unknown>
    if (ev.silo !== this.silo || ev.verb !== 'append-item' || ev.by !== 'owner' || typeof ev.key !== 'string' || typeof ev.text !== 'string') return
    const d = ev.detail
    if (typeof d !== 'object' || d === null) return
    const det = d as Record<string, unknown>
    if (det.coll !== 'notes' || typeof det.at !== 'string' || typeof det.digest !== 'string') return
    const list = this.byKey.get(ev.key) ?? []
    list.push({
      at: det.at,
      digest: det.digest,
      text: ev.text.startsWith(PREFIX) ? ev.text.slice(PREFIX.length) : ev.text,
      ...(det.closes === true ? { closes: true as const } : {}),
    })
    this.byKey.set(ev.key, list)
  }

  // The check for this moment: the log is read once per call — one pass of
  // task mode (or one page of tasks) asks many tasks.
  checker(): OwnerNoteCheck {
    this.refresh()
    return (taskKey, notes) => matchOwnerNotes(this.byKey.get(taskKey) ?? [], notes)
  }
}
