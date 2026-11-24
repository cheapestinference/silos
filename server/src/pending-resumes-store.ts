// pending-resumes-store.ts — auto-resume for rate-limited interactive
// chats: when an interactive turn hits the limit and does NOT continue via
// a working fallback, a durable record is persisted here so the resident
// resumes the SAME conversation at the reset (or immediately if a fallback
// is armed). Survives server restarts — that's the whole point: the banner
// promises "Silos will resume this on its own" and it has to stay true even
// if the process restarts in between.
//
// Same store discipline as conversation-prefs.ts / automations-store.ts:
// atomic write (tmp + rename), a .corrupt-<stamp> backup BEFORE starting
// fresh if the JSON fails to parse (never silently overwrite a file that
// might be recoverable by hand), and per-entry shape validation (a
// malformed entry is discarded with a warning, never breaks a later tick).
// No secrets inside (`text` is the owner's prompt, not a credential) — 0600
// isn't required, but the discipline is kept anyway.
//
// ONE record per `folder/sessionId`: a newer turn on the same session
// REPLACES the previous one (the owner's latest intent wins).
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { join } from 'node:path'

export interface PendingResume {
  agentId: string
  folder: string // dir name under ~/.claude/projects (munged form)
  sessionId: string
  text: string // the owner's turn to retry, verbatim
  // Effective cwd — ONLY for the master agent (agent.folder === null): its
  // sessions have no folder of their own, resume needs THE SESSION's cwd.
  // Absent for a normal agent (agent.folder rules).
  cwd?: string
  resetsAt: string // ISO — the limit's REAL reset (the copy says "will resume at <time>")
  // ISO instant at which the resident should retry: = resetsAt when it has
  // to wait, = now (immediate) when a fallback was armed (turn boundary).
  resumeAt: string
  createdAt: string
  attempts: number // retries already consumed by the resident (capped at MAX_RESUME_ATTEMPTS)
  // id of the fallback provider armed when the record was created/re-armed
  // — the UI resolves it to a readable name for the "continuing on
  // <provider>" copy.
  fallbackProviderId?: string
  // snapshot of the session when the record was created — anti-double-send
  // guard: if the owner resends by hand and the session advances
  // (turnCount/mtime grow), the resident discards the record instead of
  // resending the same turn.
  turnCount?: number
  mtime?: number
  // Honest TERMINAL state: auto-resume gave up (retries exhausted, the
  // destination is unrecoverable, or a non-recoverable error) — the record
  // is NOT silently deleted, it's marked this way so the banner tells the
  // truth ("couldn't resume automatically…") instead of the promise just
  // vanishing without notice. The resident NEVER retries a record with
  // `gaveUp` — it's terminal until the owner dismisses it (DELETE).
  gaveUp?: { reason: string; tries: number }
}

interface Shape {
  pending: Record<string, PendingResume>
}

function isValid(v: unknown): v is PendingResume {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.agentId !== 'string' || o.agentId === '') return false
  if (typeof o.folder !== 'string' || o.folder === '') return false
  if (typeof o.sessionId !== 'string' || o.sessionId === '') return false
  if (typeof o.text !== 'string' || o.text === '') return false
  if (typeof o.resetsAt !== 'string') return false
  if (typeof o.resumeAt !== 'string') return false
  if (typeof o.createdAt !== 'string') return false
  if (typeof o.attempts !== 'number' || !Number.isFinite(o.attempts)) return false
  if (o.cwd !== undefined && typeof o.cwd !== 'string') return false
  if (o.fallbackProviderId !== undefined && typeof o.fallbackProviderId !== 'string') return false
  if (o.turnCount !== undefined && typeof o.turnCount !== 'number') return false
  if (o.mtime !== undefined && typeof o.mtime !== 'number') return false
  if (o.gaveUp !== undefined) {
    const g = o.gaveUp
    if (typeof g !== 'object' || g === null) return false
    const gg = g as Record<string, unknown>
    if (typeof gg.reason !== 'string' || typeof gg.tries !== 'number') return false
  }
  return true
}

export function pendingKey(folder: string, sessionId: string): string {
  return `${folder}/${sessionId}`
}

export class PendingResumesStore {
  private pending: Record<string, PendingResume> = {}
  private file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, 'pending-resumes.json')
  }

  load(): void {
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: Shape
    try {
      raw = JSON.parse(text) as Shape
    } catch {
      backupCorruptJson(this.file, text, 'pending-resumes')
      this.pending = {}
      return
    }
    const entries = raw.pending && typeof raw.pending === 'object' && !Array.isArray(raw.pending) ? raw.pending : {}
    const good: Record<string, PendingResume> = {}
    for (const [key, entry] of Object.entries(entries)) {
      if (isValid(entry)) {
        good[key] = entry
      } else {
        console.warn(`pending-resumes: entry discarded for invalid shape (${key})`)
      }
    }
    this.pending = good
  }

  list(): PendingResume[] {
    return Object.values(this.pending)
  }

  get(folder: string, sessionId: string): PendingResume | null {
    return this.pending[pendingKey(folder, sessionId)] ?? null
  }

  // ONE record per folder/sessionId — a new one REPLACES the previous one
  // (the owner's latest intent rules). Returns the saved record.
  upsert(rec: PendingResume): PendingResume {
    this.pending[pendingKey(rec.folder, rec.sessionId)] = rec
    this.save()
    return rec
  }

  // Returns true if there was something to delete (so the caller can decide
  // whether to emit the removed WS event — never announce a deletion that
  // didn't happen).
  remove(folder: string, sessionId: string): boolean {
    const key = pendingKey(folder, sessionId)
    if (!(key in this.pending)) return false
    delete this.pending[key]
    this.save()
    return true
  }

  // Drop records whose session no longer exists — belt-and-suspenders for the
  // resurrection guard (the trash route already removes the record; this catches
  // a session deleted outside trash). Gated by the caller on a WARM index, so a
  // key missing from `keys` means the transcript is genuinely gone, not just
  // un-indexed yet. Same slow-sweep pattern as conversation-prefs / seen.
  sweepOrphans(keys: Set<string>): void {
    let changed = false
    for (const key of Object.keys(this.pending)) {
      if (keys.has(key)) continue
      delete this.pending[key]
      changed = true
    }
    if (changed) this.save()
  }

  private save(): void {
    atomicWriteJson(this.file, { pending: this.pending })
  }
}
