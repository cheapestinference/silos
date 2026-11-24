// silos/overlay.ts — the owner's overlay over a SYNC source (Silo Standard v0,
// «Writing»). A sync producer regenerates its files whole
// from an external service, so an owner's edit written into the file would
// be erased by the next sync — and the CAS only binds the kernel. The owner's
// writes to `ownerWritable` fields of a sync source live here instead, per
// CONVENTION, beside the journal:
//
//   <dataDir>/silos/conventions/<conv>/data/<sha(key)>.json
//     { key, fields: { <field>: { value, base, at, by, conflict? } }, orphanSince? }
//
// Per field:
//   seal      every owner write SEALS the base value the file held then
//   retire    the entry leaves by itself once the source brings the owner's value
//   pending   the source still holds the sealed base → the owner's value shows
//   conflict  the source brings a THIRD value (neither base nor owner's) → the
//             entry is marked, kept, and listed — nobody wins in silence
//   orphan    the record's file is gone but the entry remains → a freshness term
//
// Pinned to the convention, so it survives an uninstall.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from '../json-store.js'

export interface OverlayField {
  value: unknown // the owner's
  base: unknown // what the source held when the owner wrote (sealed)
  at: string
  by: 'owner'
  conflict?: { sourceValue: unknown; seenAt: string } // the source brought a third value
}

export interface OverlayEntry {
  key: string // the record's key: '<location>/<id>' (journal.recordKey)
  fields: Record<string, OverlayField>
  orphanSince?: string // first seen without its record
}

export interface OverlayConflict {
  key: string
  field: string
  owner: unknown
  base: unknown
  source: unknown
  seenAt: string
  ownerAt: string
}

export interface OverlayOrphan {
  key: string
  fields: string[]
  since: string
}

export interface ReconcileInput {
  records: ReadonlyMap<string, unknown> // key → the file's raw value
  preserved: (key: string) => boolean // exists but unreadable: neither applied nor orphaned
  complete: boolean // false = a cap truncated the reading: no orphan concluded
}

export interface ReconcileResult {
  values: Map<string, Record<string, unknown>> // key → owner values to merge over the base
  entries: Map<string, OverlayEntry> // what is still standing, per key (after retirements)
  conflicts: OverlayConflict[]
  orphans: OverlayOrphan[]
  retired: Array<{ key: string; field: string }> // the source caught up
}

// JSON-equal (values are plain JSON: strings, numbers, money objects…)
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return a === b
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
    )
  return v
}

export class OverlayStore {
  constructor(private conventionsDir: string) {}

  dataDir(dir: string): string {
    return join(this.conventionsDir, dir, 'data')
  }

  fileFor(dir: string, key: string): string {
    return join(this.dataDir(dir), `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)
  }

  list(dir: string): OverlayEntry[] {
    const d = this.dataDir(dir)
    if (!existsSync(d)) return []
    const out: OverlayEntry[] = []
    for (const name of readdirSync(d).sort()) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const file = join(d, name)
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
        const e = JSON.parse(text) as OverlayEntry
        if (typeof e.key === 'string' && e.fields && typeof e.fields === 'object') out.push(e)
      } catch {
        if (text !== '') backupCorruptJson(file, text, 'silos overlay')
      }
    }
    return out
  }

  get(dir: string, key: string): OverlayEntry | null {
    const file = this.fileFor(dir, key)
    if (!existsSync(file)) return null
    try {
      const e = JSON.parse(readFileSync(file, 'utf8')) as OverlayEntry
      return e.key === key ? e : null
    } catch {
      return null
    }
  }

  // The owner writes `value` over a source that holds `base` now. Writing the
  // base itself withdraws the field (nothing to hold over the source).
  set(dir: string, key: string, field: string, value: unknown, base: unknown, now: Date): OverlayEntry | null {
    const entry = this.get(dir, key) ?? { key, fields: {} }
    if (sameValue(value, base)) delete entry.fields[field]
    else entry.fields[field] = { value, base, at: now.toISOString(), by: 'owner' }
    return this.save(dir, entry)
  }

  // After a conflict: the owner keeps their value over what the source brings
  // now (a new seal), or takes the source's (the field leaves).
  resolve(dir: string, key: string, field: string, choice: 'keep-mine' | 'take-source', sourceValue: unknown, now: Date): OverlayEntry | null {
    const entry = this.get(dir, key)
    const f = entry?.fields[field]
    if (!entry || !f) return entry
    if (choice === 'take-source') delete entry.fields[field]
    else entry.fields[field] = { value: f.value, base: sourceValue, at: now.toISOString(), by: 'owner' }
    return this.save(dir, entry)
  }

  private save(dir: string, entry: OverlayEntry): OverlayEntry | null {
    const file = this.fileFor(dir, entry.key)
    if (Object.keys(entry.fields).length === 0) {
      try {
        unlinkSync(file)
      } catch {
        /* already gone */
      }
      return null
    }
    mkdirSync(this.dataDir(dir), { recursive: true, mode: 0o700 })
    atomicWriteJson(file, entry, { mode: 0o600 })
    return entry
  }

  // Compare every entry of a convention with what the source holds now.
  // Persists retirements, conflict marks and orphan dates; returns what to
  // merge and what to say.
  reconcile(dir: string, input: ReconcileInput, now: Date): ReconcileResult {
    const res: ReconcileResult = { values: new Map(), entries: new Map(), conflicts: [], orphans: [], retired: [] }
    const at = now.toISOString()
    for (const entry of this.list(dir)) {
      let changed = false
      if (!input.records.has(entry.key)) {
        if (!input.preserved(entry.key) && input.complete) {
          if (!entry.orphanSince) {
            entry.orphanSince = at
            changed = true
          }
          res.orphans.push({ key: entry.key, fields: Object.keys(entry.fields), since: entry.orphanSince })
        }
        if (changed) this.save(dir, entry)
        res.entries.set(entry.key, entry)
        continue
      }
      if (entry.orphanSince) {
        delete entry.orphanSince
        changed = true
      }
      const raw = input.records.get(entry.key)
      const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const values: Record<string, unknown> = {}
      for (const [field, f] of Object.entries(entry.fields)) {
        const sv = src[field]
        if (sameValue(sv, f.value)) {
          delete entry.fields[field]
          res.retired.push({ key: entry.key, field })
          changed = true
          continue
        }
        if (sameValue(sv, f.base)) {
          if (f.conflict) {
            delete f.conflict
            changed = true
          } // the source went back to the base
        } else if (!f.conflict || !sameValue(f.conflict.sourceValue, sv)) {
          f.conflict = { sourceValue: sv, seenAt: at }
          changed = true
        }
        if (f.conflict)
          res.conflicts.push({ key: entry.key, field, owner: f.value, base: f.base, source: f.conflict.sourceValue, seenAt: f.conflict.seenAt, ownerAt: f.at })
        values[field] = f.value
      }
      if (changed) this.save(dir, entry)
      if (Object.keys(values).length > 0) res.values.set(entry.key, values)
      if (Object.keys(entry.fields).length > 0) res.entries.set(entry.key, entry)
    }
    return res
  }
}
