// usage-attribution.ts — which window each assistant record falls in.
// Pure: the service (usage.ts) hands it the windows and
// the records of every conversation, each already placed on its THREAD.
//
//   - A record falls in a window of its own thread that was open at its
//     time (open ≤ at ≤ close; a window still open has no end). When
//     several hold it — a console left open while a wake ran on the same
//     file — the one opened LAST takes it: the more specific turn. So a
//     conversation with a console and wakes over one file is SPLIT, never
//     summed twice.
//   - Subagents ride in their conversation's records; nested sessions (a
//     `claude -p` an agent ran, by its birth marker) are placed on their
//     parent's thread by the service — both fall in the parent's window by
//     their time.
//   - Deduplicated by message id PER THREAD, not per file: a `--resume`
//     copies records into a new file.
//   - One day rule: a record in a TURN's window counts in the local day
//     (and the range) its window OPENED in; a console's records (its window
//     lives for days) and what falls in no window go by their own time.
//   - What falls in no window is never guessed: «Unattributed» from the
//     register's start on, «before <date>» before it (no backfill).
import type { UsageRecord } from './harnesses/contract.js'
import type { UsageWindow } from './usage-ledger.js'

/** One conversation's records, placed on its thread. */
export interface ThreadedRecords {
  /** `<folder>/<id>` of the session the records were read from */
  sessionKey: string
  /** the thread it belongs to (its root's key; a nested session: its parent's thread) */
  threadKey: string
  records: readonly UsageRecord[]
}

export type Bucket = 'window' | 'unattributed' | 'before'

export interface AttributedRecord {
  rec: UsageRecord
  sessionKey: string
  threadKey: string
  bucket: Bucket
  window: UsageWindow | null
}

export interface AttributeInput {
  /** every window that may hold a record of the range, each with its thread */
  windows: ReadonlyArray<{ window: UsageWindow; threadKey: string }>
  conversations: readonly ThreadedRecords[]
  /** the register's start (ms), null = no window was ever opened */
  since: number | null
  /** the range: a turn window's records count when the window opened in
   *  it; a console's record or one in no window, when it was written */
  from: number
  to: number
}

export function attribute(input: AttributeInput): AttributedRecord[] {
  const byThread = new Map<string, Array<{ w: UsageWindow; open: number; close: number }>>()
  for (const { window: w, threadKey } of input.windows) {
    const list = byThread.get(threadKey) ?? []
    list.push({ w, open: Date.parse(w.at), close: w.closedAt !== undefined ? Date.parse(w.closedAt) : Infinity })
    byThread.set(threadKey, list)
  }
  const seen = new Map<string, Set<string>>()
  const out: AttributedRecord[] = []
  for (const c of input.conversations) {
    let ids = seen.get(c.threadKey)
    if (!ids) {
      ids = new Set()
      seen.set(c.threadKey, ids)
    }
    const windows = byThread.get(c.threadKey) ?? []
    for (const rec of c.records) {
      if (ids.has(rec.id)) continue
      ids.add(rec.id)
      let best: { w: UsageWindow; open: number } | null = null
      for (const x of windows) {
        if (x.open <= rec.at && rec.at <= x.close && (best === null || x.open > best.open)) best = x
      }
      // ONE day rule: a record in a TURN's window counts when its window
      // OPENED (a turn across midnight is the day it started — like the
      // caps); a console's window lives for days, so its records — like
      // what fell in no window — go by their own time
      if (best) {
        if (best.w.class === 'console' ? rec.at >= input.from && rec.at < input.to : best.open >= input.from && best.open < input.to)
          out.push({ rec, sessionKey: c.sessionKey, threadKey: c.threadKey, bucket: 'window', window: best.w })
      } else if (rec.at < input.from || rec.at >= input.to) continue
      else
        out.push({
          rec,
          sessionKey: c.sessionKey,
          threadKey: c.threadKey,
          bucket: input.since !== null && rec.at >= input.since ? 'unattributed' : 'before',
          window: null,
        })
    }
  }
  return out
}

/** The tokens of one record, summed into `t`. */
export function addTokens(t: { in: number; out: number; cacheRead: number; cacheWrite: number }, r: UsageRecord): void {
  t.in += r.tokens.in
  t.out += r.tokens.out
  t.cacheRead += r.tokens.cacheRead
  t.cacheWrite += r.tokens.cacheWrite
}

export const totalTokens = (t: { in: number; out: number; cacheRead: number; cacheWrite: number }): number => t.in + t.out + t.cacheRead + t.cacheWrite
