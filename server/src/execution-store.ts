// execution-store.ts — Silos' own copy of an SDD ledger and its plan document,
// at <dataDir>/executions/<folder>/<id>.json (one file per session).
// The ledger lives in `.superpowers/sdd/` inside a worktree and is git-ignored
// scratch: when the worktree is merged and removed it dies with it, and the
// record of how the execution went would vanish. So Silos keeps a snapshot
// the first time it sees the ledger and refreshes it only when the ledger's
// mtime moves on. Nothing is ever written inside the repo.
//
// Same store discipline as needs-you-acks.ts: tolerant loading, atomic write,
// a .corrupt-<stamp> backup before starting fresh. The store never throws —
// a failing fs call yields the saved copy, or null.
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { buildRecord, isLedgerPath, parseLedger, repoRootOfLedger } from './execution-record.js'
import type { ExecutionRecord } from './types.js'

// A ledger or plan document is a few KB of markdown; anything larger is not
// one, and is never read (memory) — one cap for both reads.
export const MAX_RECORD_FILE_BYTES = 1_048_576

// The file a candidate ledger path really is, or null. An agent controls
// what sits at that path: a FIFO would hang the read (and the server's event
// loop), a symlink could point at /dev/zero or a key. So the TARGET is judged
// — still ledger-shaped, a regular file, within the cap — and read instead.
function ledgerTarget(p: string): { real: string; mtime: number } | null {
  try {
    const real = realpathSync(p)
    if (!isLedgerPath(real)) return null
    const st = statSync(real)
    if (!st.isFile() || st.size > MAX_RECORD_FILE_BYTES) return null
    return { real, mtime: st.mtimeMs }
  } catch {
    return null
  }
}

export interface ExecutionSnapshot {
  ledgerPath: string
  ledger: string
  ledgerMtime: number
  planPath: string | null
  plan: string | null
  savedAt: number
}

/** The ledger paths a session wrote or named — what feeds `capture`. */
export function ledgerPathsOf(files: readonly { path: string; edits: number; writes: number; disk?: number }[]): string[] {
  return files.filter((f) => isLedgerPath(f.path) && f.edits + f.writes + (f.disk ?? 0) > 0).map((f) => f.path)
}

// folder and id become path segments: refuse anything that could leave the dir.
function safe(seg: string): boolean {
  return seg !== '' && !seg.includes('/') && !seg.includes('..')
}

function isSnapshot(v: unknown): v is ExecutionSnapshot {
  const s = v as Partial<ExecutionSnapshot> | null
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.ledgerPath === 'string' &&
    typeof s.ledger === 'string' &&
    typeof s.ledgerMtime === 'number' &&
    (s.planPath === null || typeof s.planPath === 'string') &&
    (s.plan === null || typeof s.plan === 'string') &&
    typeof s.savedAt === 'number'
  )
}

export class ExecutionStore {
  private mem = new Map<string, ExecutionSnapshot>()

  constructor(private dataDir: string) {}

  private fileOf(folder: string, id: string): string {
    return join(this.dataDir, 'executions', folder, `${id}.json`)
  }

  get(folder: string, id: string): ExecutionSnapshot | null {
    if (!safe(folder) || !safe(id)) return null
    const key = `${folder}/${id}`
    const hit = this.mem.get(key)
    if (hit) return hit
    const file = this.fileOf(folder, id)
    try {
      if (!existsSync(file)) return null
      const text = readFileSync(file, 'utf8')
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        backupCorruptJson(file, text, 'execution')
        return null
      }
      if (!isSnapshot(raw)) return null
      this.mem.set(key, raw)
      return raw
    } catch {
      return null
    }
  }

  capture(folder: string, id: string, ledgerPaths: readonly string[], roots: readonly string[] = []): ExecutionSnapshot | null {
    if (!safe(folder) || !safe(id)) return null
    const saved = this.get(folder, id)
    try {
      let best: { path: string; real: string; mtime: number } | null = null
      for (const p of ledgerPaths) {
        const t = ledgerTarget(p) // missing or not a real ledger: skip
        if (t && (!best || t.mtime > best.mtime)) best = { path: p, ...t }
      }
      if (!best) return saved
      if (saved && saved.ledgerMtime >= best.mtime) return saved
      const ledger = readFileSync(best.real, 'utf8')
      const planPath = this.resolvePlan(best.path, parseLedger(ledger).planRef, roots)
      let plan: string | null = null
      if (planPath) {
        try {
          plan = readFileSync(planPath, 'utf8')
        } catch {
          /* unreadable: no document */
        }
      }
      const snap: ExecutionSnapshot = {
        ledgerPath: best.path,
        ledger,
        ledgerMtime: best.mtime,
        planPath: plan === null ? null : planPath,
        plan,
        savedAt: Date.now(),
      }
      const file = this.fileOf(folder, id)
      mkdirSync(dirname(file), { recursive: true })
      atomicWriteJson(file, snap)
      this.mem.set(`${folder}/${id}`, snap)
      return snap
    } catch {
      return saved
    }
  }

  record(folder: string, id: string, ledgerPaths: readonly string[], roots: readonly string[] = []): ExecutionRecord | null {
    const snap = this.capture(folder, id, ledgerPaths, roots)
    if (!snap) return null
    return buildRecord({ ...snap, gone: !existsSync(snap.ledgerPath) })
  }

  /** Every copy Silos saved, one per (folder, session) — what the kernel
   *  kind `execution` lists (silos/executions.ts). Never writes. */
  saved(): Array<{ folder: string; id: string; snap: ExecutionSnapshot }> {
    const out: Array<{ folder: string; id: string; snap: ExecutionSnapshot }> = []
    const dir = join(this.dataDir, 'executions')
    try {
      if (!existsSync(dir)) return out
      for (const folder of readdirSync(dir).sort()) {
        if (!safe(folder)) continue
        let ids: string[] = []
        try {
          ids = readdirSync(join(dir, folder))
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
            .sort()
        } catch {
          continue
        }
        for (const id of ids) {
          const snap = this.get(folder, id)
          if (snap) out.push({ folder, id, snap })
        }
      }
    } catch {
      /* a failing fs call: whatever was listed so far */
    }
    return out
  }

  /** A live ledger read as a snapshot WITHOUT saving it — the kernel's sweep
   *  of a checkout (a ledger no conversation is known to have written, or one
   *  newer than its saved copy). Same guards as capture: the target judged
   *  (a FIFO, a link out, an oversize file are not read), the document
   *  confined to the ledger's repo and `roots`. null when it is not a ledger. */
  peek(ledgerPath: string, roots: readonly string[] = []): Omit<ExecutionSnapshot, 'savedAt'> | null {
    const t = ledgerTarget(ledgerPath)
    if (!t) return null
    try {
      const ledger = readFileSync(t.real, 'utf8')
      const planPath = this.resolvePlan(ledgerPath, parseLedger(ledger).planRef, roots)
      let plan: string | null = null
      if (planPath) {
        try {
          plan = readFileSync(planPath, 'utf8')
        } catch {
          /* unreadable: no document */
        }
      }
      return { ledgerPath, ledger, ledgerMtime: t.mtime, planPath: plan === null ? null : planPath, plan }
    } catch {
      return null
    }
  }

  /** The live mtime of a ledger path, judged like capture judges it (null:
   *  gone, or not a real ledger). */
  liveMtime(ledgerPath: string): number | null {
    return ledgerTarget(ledgerPath)?.mtime ?? null
  }

  // The ledger header names the plan, and an agent writes that header: the
  // reference is confined to the repo the ledger sits in or a session cwd, and
  // to markdown, or Silos would copy any readable file into a record it serves.
  private resolvePlan(ledgerPath: string, ref: string | null, roots: readonly string[]): string | null {
    if (!ref) return null
    const real = (p: string): string | null => {
      try {
        return realpathSync(p)
      } catch {
        return null
      }
    }
    const bases = [repoRootOfLedger(ledgerPath), ...roots].map((b) => real(b)).filter((b): b is string => b !== null)
    const candidates = isAbsolute(ref) ? [ref] : bases.map((b) => join(b, ref))
    // Judge the target, not the name: a symlink inside the repo is followed first.
    for (const c of candidates) {
      const p = real(c)
      if (p === null || !p.endsWith('.md')) continue
      if (!bases.some((b) => p.startsWith(b.endsWith(sep) ? b : b + sep))) continue
      try {
        const st = statSync(p)
        if (st.isFile() && st.size <= MAX_RECORD_FILE_BYTES) return p
      } catch {
        /* gone: next */
      }
    }
    return null
  }
}
