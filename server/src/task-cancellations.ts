// task-cancellations.ts — WHO cancelled a plan task, and WHEN (the
// «Yours, undone» block and the duplicate against what
// was undone). A task's `status: cancelled` says nothing of its author: the
// plan file is written by agents too. So a cancellation counts as the
// OWNER's only when Silos itself RECORDED the owner making it — the kernel's
// `set-field` event on that task key, `by: 'owner'`, «set-field status: … →
// cancelled» (silos/actions.ts taskGesture: the owner's Drop leaves exactly
// that event, signed owner — the route lets only the owner in; setField's
// `by` is authorOf — an owner credential naming no agent). The
// same provenance task-mode/owner-notes.ts trusts for an owner's note.
// Anything else — an agent's set-field, a file edit — is not the owner's.
//
// When: the plans journal's entry into `cancelled` (silos/journal.ts since —
// the moment the kernel SAW it), else the owner's event, else unknown (the
// caller falls back to the creation). An owner's event vouches only for a
// cancellation the journal saw within OWNER_CANCEL_SLACK of it: one the
// journal dates later (reopened and cancelled again by a file write) is not
// the owner's.
//
// Cheap: the events log is read INCREMENTALLY, like OwnerNoteLedger.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'

const CANCEL_RE = /^set-field status: .* → cancelled(?: \(|$)/
const REOPEN_RE = /^set-field status: cancelled → (?!cancelled)/
export const OWNER_CANCEL_SLACK_MS = 10 * 60_000

interface StatusEvent {
  at: number
  by: string
  cancel: boolean
}
export interface Cancellation {
  at: string | null
  byOwner: boolean
}

export class TaskCancellations {
  private offset = 0
  private ino = -1
  private tail = ''
  private byKey = new Map<string, StatusEvent[]>()

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
      const len = fstatSync(fd).size - this.offset
      if (len <= 0) return
      const buf = Buffer.alloc(len)
      let read = 0
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, this.offset + read)
        if (n <= 0) break
        read += n
      }
      this.offset += read
      const lines = (this.tail + buf.subarray(0, read).toString('utf8')).split('\n')
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
    if (!line.includes('"set-field"') || !line.includes('status')) return
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      return
    }
    if (typeof e !== 'object' || e === null) return
    const ev = e as Record<string, unknown>
    if (
      ev.silo !== this.silo ||
      ev.verb !== 'set-field' ||
      typeof ev.key !== 'string' ||
      typeof ev.text !== 'string' ||
      typeof ev.by !== 'string' ||
      typeof ev.at !== 'string'
    )
      return
    const cancel = CANCEL_RE.test(ev.text)
    if (!cancel && !REOPEN_RE.test(ev.text)) return
    const at = Date.parse(ev.at)
    if (Number.isNaN(at)) return
    const list = this.byKey.get(ev.key) ?? []
    list.push({ at, by: ev.by, cancel })
    this.byKey.set(ev.key, list)
  }

  /** The cancellation of a task now cancelled: who (the owner's recorded
   *  gesture, or not) and when. `journalSince`: when the journal saw it
   *  enter `cancelled` (ms), or null. */
  of(key: string, journalSince: number | null): Cancellation {
    this.refresh()
    const last = (this.byKey.get(key) ?? []).at(-1)
    const ownerEvent = last && last.cancel && last.by === 'owner' ? last : null
    const byOwner = ownerEvent !== null && (journalSince === null || journalSince <= ownerEvent.at + OWNER_CANCEL_SLACK_MS)
    const at = journalSince ?? ownerEvent?.at ?? null
    return { at: at === null ? null : new Date(at).toISOString(), byOwner }
  }
}
