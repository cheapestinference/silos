// silos/kernel.ts — ties the registry to the reader: every silo the registry
// holds (except one in `error`, whose manifest isn't understood) is read, the
// owner's overlay is merged over its sync sources, what was read lands in its
// status (records parsed/failed, last write), and an active silo's
// transitions go to its convention's journal. The last MERGED reading of each
// silo is kept for the surfaces (Tasks 8-9), the validator's dry-run (Task 7)
// and the sync producer's read (mergedView — its HTTP route is Task 10/11).
//
// When it reads: at boot, whenever the registry changes a silo, when a file
// under one of its convention folders changes (noteFileChange, fed by the
// house's watcher), and on a timer — predicates
// with `now` change with the clock alone (the timer engine).
import { sep } from 'node:path'
import type { SiloEntry, SiloRegistry } from './registry.js'
import { readRecordValue, type ReadEnv, type SiloReader, type SiloReading, type SiloRecord } from './reader.js'
import type { EvalRecord } from './expressions.js'
import { observationsOf, recordKey, sinceResolver, type TransitionJournal } from './journal.js'
import type { OverlayConflict, OverlayOrphan, OverlayStore } from './overlay.js'
import { freshnessOf } from './freshness.js'
import { endPass } from '../pass.js'

export interface SiloKernelOptions {
  registry: SiloRegistry
  reader: SiloReader
  isAgent?: (value: string) => boolean
  now?: () => number
  // the transition journal: fed with every ACTIVE silo's reading — the
  // baseline is taken when the owner activates a silo, not at submission
  journal?: TransitionJournal
  // the owner's overlay over sync sources (per convention)
  overlay?: OverlayStore
  onReading?: (siloId: string, reading: SiloReading, now: number) => void
  // after every refresh (the server compares what Home would show and tells
  // the web when it changed)
  onRefresh?: () => void
  // the kernel's own tick (start, then every interval, AFTER the full read):
  // the daily sweep hangs here — SiloActions.rotateSweep, at most once per
  // silo, project and day (plans 0.5.2, E7). Never on a file-change read.
  onTick?: () => void
}

export interface OverlayState {
  conflicts: Array<OverlayConflict & { file: string | null }> // → Needs you (Task 9)
  orphans: OverlayOrphan[] // → a freshness term (Task 6)
}

export interface MergedRecord {
  key: string
  file: string
  rel: string
  location: string
  raw: Record<string, unknown> // the file's value with the owner's overlay merged in
  record: SiloRecord['record']
  overlay: SiloRecord['overlay'] | null
}

export type SetFieldResult = { ok: true; record: SiloRecord } | { ok: false; reason: string }

// a write under a convention folder is read within this window (coalesced)
export const FILE_CHANGE_WINDOW_MS = 500

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export class SiloKernel {
  private readings = new Map<string, SiloReading>()
  private sinces = new Map<string, (record: EvalRecord, state: string) => number | null>()
  private overlayStates = new Map<string, OverlayState>()
  private readAts = new Map<string, number>() // when each silo was last read
  private timer: NodeJS.Timeout | null = null
  private onChange = (id: string): void => {
    this.refresh(id)
  }

  constructor(private opts: SiloKernelOptions) {}

  private nowMs(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private env(now: number): ReadEnv {
    return { now, ...(this.opts.isAgent ? { isAgent: this.opts.isAgent } : {}) }
  }

  // Read one silo (or all of them). Never throws: a reader failure is a
  // warning and the silo keeps its last counts.
  refresh(id?: string): void {
    // new readings: whatever this pass read of the old ones is read again (pass.ts)
    endPass()
    const entries = id === undefined ? this.opts.registry.list() : [this.opts.registry.get(id)].filter((e) => e !== null)
    if (id !== undefined && entries.length === 0) this.forget(id)
    for (const e of entries) {
      if (e.status.state === 'error' || e.manifest === null) {
        this.forget(e.id)
        continue
      }
      try {
        const now = this.nowMs()
        const reading = this.opts.reader.read(e.id, e.manifest, this.env(now))
        this.mergeOverlay(e, reading, now)
        this.readings.set(e.id, reading)
        this.readAts.set(e.id, now)
        const freshness = freshnessOf(e.manifest, reading, this.overlayState(e.id).orphans, now)
        this.opts.registry.noteRecords(e.id, { parsed: reading.records.length, failed: reading.unreadable.length, lastWrite: reading.lastWrite, freshness })
        if (this.opts.journal && e.status.state === 'active') {
          const set = observationsOf(e.id, e.manifest, reading, e.status.conventions)
          for (const o of set.observations) this.opts.journal.observe(o, new Date(now))
          this.sinces.set(e.id, sinceResolver(this.opts.journal, set.keys))
        } else {
          this.sinces.delete(e.id)
        }
        this.opts.onReading?.(e.id, reading, now)
      } catch (err) {
        console.warn(`silos: reading ${e.id} failed —`, err instanceof Error ? err.message : err)
      }
    }
    try {
      this.opts.onRefresh?.()
    } catch {
      /* a listener never breaks a read */
    }
  }

  // When the silo was last read (its reading's clock) — null: never.
  readAt(id: string): number | null {
    return this.readAts.get(id) ?? null
  }

  private forget(id: string): void {
    this.readAts.delete(id)
    this.readings.delete(id)
    this.sinces.delete(id)
    this.overlayStates.delete(id)
  }

  // The sync sources of a silo whose kind declares ownerWritable fields —
  // the only place an overlay applies.
  private overlaySources(e: SiloEntry): { kind: string; writable: string[]; sources: Array<{ id: string; dir: string }> } | null {
    const spec = isObj(e.manifest?.spec) ? e.manifest.spec : {}
    const kinds = isObj(spec.kinds) ? spec.kinds : {}
    const names = Object.keys(kinds)
    if (names.length !== 1) return null
    const kind = names[0]!
    const writable =
      isObj(kinds[kind]) && Array.isArray((kinds[kind] as Json).ownerWritable)
        ? ((kinds[kind] as Json).ownerWritable as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
    if (writable.length === 0) return null
    const sources = (Array.isArray(spec.sources) ? spec.sources : [])
      .filter(isObj)
      .filter((s) => isObj(s.expects) && s.expects.producer === 'sync')
      .map((s) => ({ id: String(s.id), dir: e.status.conventions.find((c) => c.source === s.id)?.dir ?? '' }))
      .filter((s) => s.dir !== '')
    return sources.length > 0 ? { kind, writable, sources } : null
  }

  // Base + overlay: each record of a sync source is re-read with the owner's
  // standing values merged over the file's, so computed fields, state labels
  // and predicates see the merged view.
  private mergeOverlay(e: SiloEntry, reading: SiloReading, now: number): void {
    const store = this.opts.overlay
    const os = store ? this.overlaySources(e) : null
    if (!store || !os) {
      this.overlayStates.delete(e.id)
      return
    }
    const state: OverlayState = { conflicts: [], orphans: [] }
    const complete = reading.truncated.length === 0 && reading.problems.length === 0
    for (const src of os.sources) {
      const mine = reading.records.filter((r) => r.source === src.id)
      const byKey = new Map(mine.map((r) => [recordKey(r), r]))
      const unread = reading.unreadable.filter((u) => u.source === src.id).map((u) => (u.id !== null ? `${u.location}/${u.id}` : u.location))
      const res = store.reconcile(
        src.dir,
        {
          records: new Map([...byKey].map(([k, r]) => [k, r.raw])),
          preserved: (k) => unread.some((p) => k === p || k.startsWith(p + '/')),
          complete,
        },
        new Date(now),
      )
      for (const [key, values] of res.values) {
        const r = byKey.get(key)
        if (!r || !isObj(r.raw)) continue
        const b = readRecordValue(e.manifest!, r.kind, { ...r.raw, ...values }, r.record.id, this.env(now))
        if (b.ok) {
          r.record = b.record
          r.remarks = b.remarks
          r.partial = b.partial
        } else {
          r.remarks = [...r.remarks, `the owner's change does not read (${b.reason}) — showing the source`]
        }
      }
      for (const [key, entry] of res.entries) {
        const r = byKey.get(key)
        if (r) r.overlay = entry.fields
      }
      for (const c of res.conflicts) state.conflicts.push({ ...c, file: byKey.get(c.key)?.file ?? null })
      state.orphans.push(...res.orphans)
    }
    this.overlayStates.set(e.id, state)
  }

  reading(id: string): SiloReading | null {
    return this.readings.get(id) ?? null
  }

  // Moves when any file a silo reads was written or left, whatever it said: a note
  // on a task changes no count on the board, and the web must still hear of it.
  contentStamp(): string {
    return [...this.readings].map(([id, r]) => `${id}:${r.records.length}:${r.records.reduce((n, x) => n + x.mtimeMs, 0)}`).join('|')
  }

  // A producer writing hundreds of records (a first sync) must not re-read the
  // whole silo once per record: writes ask for ONE coalesced refresh; a read
  // that needs the latest (the producer's merged view) flushes it first.
  private soon = new Map<string, NodeJS.Timeout>()
  refreshSoon(id: string, ms = 250): void {
    if (this.soon.has(id)) return
    const t = setTimeout(() => {
      this.soon.delete(id)
      this.refresh(id)
    }, ms)
    t.unref()
    this.soon.set(id, t)
  }
  flush(id: string): void {
    const t = this.soon.get(id)
    if (!t) return
    clearTimeout(t)
    this.soon.delete(id)
    this.refresh(id)
  }

  // ── the file watch (every silo, one watcher) ──
  // Records are files an agent writes at any moment; the 5-minute timer alone
  // made a new support case reach Home up to 5 minutes late (the native code
  // read per request). The house's one watcher (knows-watcher.ts, fed with
  // watchedFolders) reports every write under a convention folder here, and
  // the silo whose convention holds it is re-read: coalesced per silo
  // (refreshSoon — at most one read per window, however long the burst), so
  // a first sync of hundreds of files is a handful of reads, never hundreds.

  // Every folder an installed silo reads files from (each convention of each
  // non-error silo, at every location), with the silo it belongs to.
  watchedFolders(): Array<{ silo: string; dir: string }> {
    const out: Array<{ silo: string; dir: string }> = []
    for (const e of this.opts.registry.list()) {
      if (e.status.state === 'error' || e.manifest === null) continue
      for (const c of e.status.conventions) {
        for (const dir of this.opts.reader.foldersOf?.(c) ?? []) out.push({ silo: e.id, dir })
      }
    }
    return out
  }

  // A file under some folder changed (added, written, removed): re-read the
  // silos whose conventions hold it. Returns the silos scheduled.
  noteFileChange(path: string, ms = FILE_CHANGE_WINDOW_MS): string[] {
    const ids = new Set<string>()
    for (const w of this.watchedFolders()) if (path === w.dir || path.startsWith(w.dir + sep)) ids.add(w.silo)
    for (const id of ids) this.refreshSoon(id, ms)
    return [...ids]
  }

  // The merged view the sync producer reads before writing (its precondition):
  // the file's value with the owner's standing values over it.
  mergedView(id: string): MergedRecord[] {
    return (this.readings.get(id)?.records ?? []).map((r) => {
      const values = Object.fromEntries(Object.entries(r.overlay ?? {}).map(([f, o]) => [f, o.value]))
      return {
        key: recordKey(r),
        file: r.file,
        rel: r.rel,
        location: r.location,
        raw: { ...(isObj(r.raw) ? r.raw : {}), ...values },
        record: r.record,
        overlay: r.overlay ?? null,
      }
    })
  }

  overlayState(id: string): OverlayState {
    return this.overlayStates.get(id) ?? { conflicts: [], orphans: [] }
  }

  // The owner sets a field of a record. On a sync source the write goes to the
  // overlay (sealing the base the file holds now) — never to the file; the
  // `set-field` action (silos/actions.ts) calls this, and only for an active
  // silo — the actions layer holds that gate. Curated sources write the file
  // with CAS there, not here.
  setOwnerField(id: string, key: string, field: string, value: unknown): SetFieldResult {
    const e = this.opts.registry.get(id)
    if (!e || !e.manifest) return { ok: false, reason: `no silo ${JSON.stringify(id)}` }
    const store = this.opts.overlay
    const os = this.overlaySources(e)
    if (!store || !os) return { ok: false, reason: `${id} has no owner-writable fields over a sync source` }
    if (!os.writable.includes(field)) return { ok: false, reason: `${field} is not one of the fields the owner may write (${os.writable.join(', ')})` }
    const r = (this.readings.get(id)?.records ?? []).find((x) => recordKey(x) === key)
    if (!r) return { ok: false, reason: `no record ${JSON.stringify(key)} in ${id}` }
    const src = os.sources.find((s) => s.id === r.source)
    if (!src) return { ok: false, reason: `${key} comes from a source the owner does not write over` }
    const raw = isObj(r.raw) ? r.raw : {}
    const standing = Object.fromEntries(Object.entries(r.overlay ?? {}).map(([f, o]) => [f, o.value]))
    const now = this.nowMs()
    const check = readRecordValue(e.manifest, r.kind, { ...raw, ...standing, [field]: value }, r.record.id, this.env(now))
    if (!check.ok) return { ok: false, reason: check.reason }
    store.set(src.dir, key, field, value, raw[field], new Date(now))
    this.refresh(id)
    const after = (this.readings.get(id)?.records ?? []).find((x) => recordKey(x) === key)
    return after ? { ok: true, record: after } : { ok: false, reason: `${key} could not be read back` }
  }

  // A conflict is settled only by the owner: keep their value over what the
  // source brings now (a new seal), or take the source's.
  resolveConflict(id: string, key: string, field: string, choice: 'keep-mine' | 'take-source'): SetFieldResult {
    const e = this.opts.registry.get(id)
    const store = this.opts.overlay
    const os = e ? this.overlaySources(e) : null
    const r = (this.readings.get(id)?.records ?? []).find((x) => recordKey(x) === key)
    const src = r && os ? os.sources.find((s) => s.id === r.source) : undefined
    if (!e || !store || !r || !src) return { ok: false, reason: `no overlay for ${JSON.stringify(key)} in ${id}` }
    store.resolve(src.dir, key, field, choice, isObj(r.raw) ? r.raw[field] : undefined, new Date(this.nowMs()))
    this.refresh(id)
    const after = (this.readings.get(id)?.records ?? []).find((x) => recordKey(x) === key)
    return after ? { ok: true, record: after } : { ok: false, reason: `${key} could not be read back` }
  }

  // env.since for evaluating this silo's predicates over its last reading
  // (needs-you, Task 9). Records of a silo that isn't journaled → null.
  sinceFor(id: string): (record: EvalRecord, state: string) => number | null {
    return this.sinces.get(id) ?? (() => null)
  }

  start(intervalMs = 5 * 60_000): void {
    this.opts.registry.on('change', this.onChange)
    this.refresh()
    this.tick()
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.refresh()
        this.tick()
      }, intervalMs)
      this.timer.unref()
    }
  }

  private tick(): void {
    try {
      this.opts.onTick?.()
    } catch (err) {
      console.warn('silos: the kernel tick failed —', err instanceof Error ? err.message : err)
    }
  }

  stop(): void {
    for (const t of this.soon.values()) clearTimeout(t)
    this.soon.clear()
    this.opts.registry.off('change', this.onChange)
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
