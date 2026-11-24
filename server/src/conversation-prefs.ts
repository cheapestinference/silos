// conversation-prefs.ts — the "conversation" level of the cabin's cascade
// (cockpit.ts): model/effort/permissionMode/fastMode overrides per
// conversation, persisted in ~/.silos/conversation-prefs.json with key
// "folder/sessionId". Same store discipline as automations-store.ts: atomic
// write (tmp + rename) and a .corrupt-<stamp> backup BEFORE starting fresh
// if the JSON fails to parse (never silently overwrite a file that might
// be recoverable by hand). Prunes orphaned keys (sessions no longer in the
// index) with the same pattern as Titler.pruneOrphans: only once the index
// is warm, never during warmup.
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { join } from 'node:path'
import { validateOverrides, type CockpitOverrides } from './cockpit.js'

interface Shape {
  prefs: Record<string, CockpitOverrides>
}

// Minimal shape check for a persisted entry — an entry hand-edited with a
// malformed field is discarded entirely (with a warning), never breaks a
// turn later in the cascade.
function isValidEntry(v: unknown): v is CockpitOverrides {
  try {
    validateOverrides(v)
    return true
  } catch {
    return false
  }
}

// Sweep grace window — a key written less than this ago is NEVER pruned
// even if the index doesn't know about it: a new chat's assignment
// (chat-init) arrives before the watcher indexes its JSONL, and within
// that window the legitimate key is indistinguishable from a ghost one.
const SWEEP_GRACE_MS = 10 * 60_000

export class ConversationPrefsStore {
  private prefs: Record<string, CockpitOverrides> = {}
  private file: string
  // Keys written by THIS process and when (memory-only on purpose: a
  // restart loses the grace period, but the sweep runs on the resident's
  // heartbeat — the real window reopens with any write).
  private touched = new Map<string, number>()

  constructor(
    dataDir: string,
    private now: () => number = () => Date.now(),
  ) {
    this.file = join(dataDir, 'conversation-prefs.json')
  }

  load(): void {
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: Shape
    try {
      raw = JSON.parse(text) as Shape
    } catch {
      backupCorruptJson(this.file, text, 'conversation-prefs')
      this.prefs = {}
      return
    }
    const entries = raw.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs) ? raw.prefs : {}
    const good: Record<string, CockpitOverrides> = {}
    for (const [key, entry] of Object.entries(entries)) {
      if (isValidEntry(entry)) {
        good[key] = entry
      } else {
        console.warn(`conversation-prefs: entry discarded for invalid shape (${key})`)
      }
    }
    this.prefs = good
  }

  // A conversation's overrides — an honest null if nothing was ever set.
  get(folder: string, sessionId: string): CockpitOverrides | null {
    return this.prefs[`${folder}/${sessionId}`] ?? null
  }

  /** When THIS process last wrote the entry (memory-only: a restart forgets,
   *  and a pin that never ran may then follow the console's last pick). */
  writtenAt(folder: string, sessionId: string): number | null {
    return this.touched.get(`${folder}/${sessionId}`) ?? null
  }

  // Shallow, field-by-field merge: present = overrides, `null` = DELETES
  // that override (falls back to the agent's default), absent = keeps it.
  // An entry left empty disappears from the file (we never accumulate
  // {}). The patch arrives ALREADY validated by the route
  // (validateOverrides with allowNull) — applied here as-is.
  patch(folder: string, sessionId: string, patch: Record<string, unknown>): CockpitOverrides {
    const key = `${folder}/${sessionId}`
    const current: Record<string, unknown> = { ...this.prefs[key] }
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete current[field]
      else current[field] = value
    }
    if (Object.keys(current).length === 0) {
      delete this.prefs[key]
      // An emptied entry takes its grace mark with it — the sweep only
      // visits keys that have prefs, so without this the mark would stay
      // alive forever in a long-running process (a leak).
      this.touched.delete(key)
    } else {
      this.prefs[key] = current as CockpitOverrides
      this.touched.set(key, this.now()) // sweep grace
    }
    this.save()
    return (this.prefs[key] ?? {}) as CockpitOverrides
  }

  // Real inheritance for a fork — copies the SOURCE conversation's prefs to
  // the new branch's key (chat-service calls this on the fork's
  // chat-init). A source with no prefs is a clean no-op. The copied key
  // counts as freshly written: the sweep must not eat it before the
  // watcher indexes the new session.
  copy(fromFolder: string, fromId: string, toFolder: string, toId: string): void {
    const source = this.get(fromFolder, fromId)
    if (source === null) return
    const key = `${toFolder}/${toId}`
    this.prefs[key] = { ...source }
    this.touched.set(key, this.now())
    this.save()
  }

  // Prunes orphaned keys (trashed sessions/ones gone from the index) —
  // lives in a SLOW sweep (the resident's heartbeat, same pattern as the
  // titler), never on the PATCH path. The caller must ONLY invoke it once
  // the index is warm (index.isReady()); during warmup allSessions() is
  // empty and would prune legitimate prefs. Keys within the grace window
  // survive even if the index doesn't know about them (see
  // SWEEP_GRACE_MS). Writes only if something changed.
  sweepOrphans(keys: Set<string>, graceMs = SWEEP_GRACE_MS): void {
    const now = this.now()
    let changed = false
    for (const k of Object.keys(this.prefs)) {
      if (keys.has(k)) continue
      const writtenAt = this.touched.get(k)
      if (writtenAt !== undefined && now - writtenAt < graceMs) continue
      delete this.prefs[k]
      this.touched.delete(k)
      changed = true
    }
    if (changed) this.save()
  }

  private save(): void {
    atomicWriteJson(this.file, { prefs: this.prefs })
  }
}
