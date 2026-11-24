// seen-store.ts — "last seen" per conversation, persisted in
// ~/.silos/seen.json with key "folder/sessionId" → epoch ms. It's the
// durable half of the unread state: it survives closing the laptop, and
// together with the JSONL's mtime + the last turn's role it decides
// `unread` (see unread.ts).
//
// Same store discipline as conversation-prefs.ts: tolerant loading, atomic
// write (tmp + rename), a .corrupt-<stamp> backup BEFORE starting fresh if
// the JSON fails to parse (never silently overwrite a file that might be
// recoverable by hand), and pruning of orphaned keys (sessions no longer in
// the index) in a SLOW sweep with a grace window for freshly written keys —
// a just-opened conversation can get marked seen before the watcher indexes
// it, and within that window its key is indistinguishable from a ghost one.
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { join } from 'node:path'

interface Shape {
  seen: Record<string, number>
}

// Same window as conversation-prefs: 10 min of grace since the last write
// before the sweep can prune a key the index doesn't know about.
const SWEEP_GRACE_MS = 10 * 60_000

export class SeenStore {
  private seen: Record<string, number> = {}
  private file: string
  // Keys written by THIS process and when (memory-only on purpose: same
  // criterion as conversation-prefs — a restart loses the grace period, but
  // the sweep runs on the resident's heartbeat and any write reopens it).
  private touched = new Map<string, number>()

  constructor(
    dataDir: string,
    private now: () => number = () => Date.now(),
  ) {
    this.file = join(dataDir, 'seen.json')
  }

  load(): void {
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: Shape
    try {
      raw = JSON.parse(text) as Shape
    } catch {
      backupCorruptJson(this.file, text, 'seen-store')
      this.seen = {}
      return
    }
    const entries = raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? raw.seen : {}
    const good: Record<string, number> = {}
    for (const [key, ts] of Object.entries(entries)) {
      // an entry hand-edited to a non-numeric (or negative/NaN) value is
      // discarded entirely — it must never break the unread calculation later.
      if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 0) good[key] = ts
      else console.warn(`seen-store: entry discarded for invalid value (${key})`)
    }
    this.seen = good
  }

  // Last time the owner saw this conversation — an honest null if never.
  get(folder: string, sessionId: string): number | null {
    return this.seen[`${folder}/${sessionId}`] ?? null
  }

  // Marks the conversation seen NOW (the owner just opened it). Idempotent:
  // a later mtime will mark it unread again if the agent writes.
  markSeen(folder: string, sessionId: string, at: number = this.now()): number {
    const key = `${folder}/${sessionId}`
    this.seen[key] = at
    this.touched.set(key, this.now()) // sweep grace
    this.save()
    return at
  }

  // Prunes orphaned keys — same pattern (and same safeguards) as
  // ConversationPrefsStore.sweepOrphans: ONLY once the index is warm (gated
  // by the caller via index.isReady()), and keys within the grace window
  // survive even if the index doesn't know about them. Writes only if
  // something changed.
  sweepOrphans(keys: Set<string>, graceMs = SWEEP_GRACE_MS): void {
    const now = this.now()
    let changed = false
    for (const k of Object.keys(this.seen)) {
      if (keys.has(k)) continue
      const writtenAt = this.touched.get(k)
      if (writtenAt !== undefined && now - writtenAt < graceMs) continue
      delete this.seen[k]
      this.touched.delete(k)
      changed = true
    }
    if (changed) this.save()
  }

  private save(): void {
    atomicWriteJson(this.file, { seen: this.seen })
  }
}
