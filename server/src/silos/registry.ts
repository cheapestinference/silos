// silos/registry.ts — the SiloRegistry: which silos this Silos knows, read
// from disk at boot and kept live by a watcher (Silo Standard step 1).
//
// On disk, under <dataDir>/silos/ (~/.silos/silos/):
//
//   registry/<id>/silo.json     the manifest, materialized by the kernel when
//                               the owner approves (Task 11) — the author's
//                               SPEC; the kernel never edits it
//   registry/<id>/status.json   the kernel's STATUS of that silo, CRD-style —
//                               written ONLY here: state (pending | active |
//                               disabled | error) with its reason in plain
//                               words, wants, records parsed/failed, last
//                               write, slots, and the convention DERIVED from
//                               each source's canonical root
//   conventions/<conv>/         per CONVENTION, not per silo — the owner's
//                               overlay (data/) and the transition journal
//                               (journal.jsonl) live here so they survive an
//                               uninstall (Tasks 4-5 create it; <conv> is the
//                               derived convention, URI-encoded — see
//                               SourceConvention.dir)
//
// GATE (step 1 guards): loading or installing a silo NEVER touches the
// session parser, the session index or CACHE_VERSION — this store is its own,
// outside the transcripts cache (SupportStore pattern). A test keeps this
// folder's imports away from them.
import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { atomicWriteJson, backupCorruptJson } from '../json-store.js'
import { hashText, readManifest, type ReadOptions, type SourceConvention } from './manifest.js'
import type { Freshness } from './freshness.js'
import { kernelKind } from './kernel-kinds.js'
import { offerableTheme, type ResolvedTheme } from './theme-rule.js'

export type SiloState = 'pending' | 'active' | 'disabled' | 'error'

// The slots a manifest can ask for (catalogs.md «Slots») — the keys of
// spec.surfaces this kernel grants. Derived surfaces (record, ⌘K) are
// never asked for, so they never appear here.
export const SLOTS = ['rail', 'pulse', 'needs-you', 'agent-section', 'project-machinery', 'lens'] as const

export interface SiloStatus {
  state: SiloState
  reason: string // plain words, always — also for pending/active
  observedAt: string // when the kernel last CHANGED this status
  manifest: { apiVersion: string | null; version: string | null; name: string | null; hash: string | null }
  wants: string[] // additive fields this kernel does not understand (loaded without them)
  conventions: SourceConvention[] // one per source, derived — never read from the manifest
  records: { parsed: number; failed: number } // the reader's last count (Task 3)
  lastWrite: string | null // newest record write the reader saw (freshness, Task 6)
  freshness: Freshness | null // past a source's cadence, the one term every slot says (null: not computed yet)
  slots: { requested: string[]; granted: string[]; off: string[] }
}

// The operator's decisions about a silo (approval click, slot switches). Their
// one exportable store is <dataDir>/silos/operator.json — Task 11's approval
// dialog will WRITE it; this is only the READ side, so a decision placed there
// (by hand, by a test seed) is honored at boot. Without the file nothing is
// approved and every valid silo reads `pending` — the standard's «nothing
// activates without the owner's click».
export interface SiloOperatorView {
  decisionFor(id: string): 'approved' | 'disabled' | null
  slotsOff(id: string): readonly string[]
}

// silos/operator.json: { "silos": { "<id>": { "decision": "approved" |
// "disabled", "slotsOff": ["pulse", …] } } }. Read lazily on each decision —
// loadOne is rare and the file is tiny; a corrupt or absent file decides
// nothing (pending). Changes to it are picked up on the next loadOne (boot,
// a manifest change, or Task 11 calling loadOne after writing).
export function fileOperatorView(root: string): SiloOperatorView {
  const entryOf = (id: string): Json | null => {
    try {
      const v = JSON.parse(readFileSync(join(root, 'operator.json'), 'utf8')) as unknown
      const silos = isObj(v) && isObj(v.silos) ? v.silos : {}
      return isObj(silos[id]) ? (silos[id] as Json) : null
    } catch {
      return null
    }
  }
  return {
    decisionFor: (id) => {
      const d = entryOf(id)?.decision
      return d === 'approved' || d === 'disabled' ? d : null
    },
    slotsOff: (id) => {
      const s = entryOf(id)?.slotsOff
      return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string') : []
    },
  }
}

// A materialized manifest is a small JSON document; anything bigger, or not
// a regular file (a FIFO froze the server once — execution-store), is refused.
export const MANIFEST_MAX_BYTES = 256 * 1024
const SILO_ID = /^[a-z0-9][a-z0-9-]*$/
// The kernel's own words: never a silo id (route segments under /api/silos —
// validate — and the store's folders).
export const KERNEL_RESERVED_IDS: readonly string[] = [
  'kernel',
  'silo',
  'silos',
  'registry',
  'conventions',
  'reserved',
  'validate',
  'draft',
  'drafts',
  'status',
  'submissions',
  'operator',
  'uninstalled',
  'events',
  'proposals',
  'available',
]

export interface SiloEntry {
  id: string
  manifest: Record<string, unknown> | null // what was understood (wants stripped); null when unreadable
  status: SiloStatus
}

// What GET /api/silos answers — everything a web paints without asking by
// name (the harness-descriptor pattern).
export interface SiloDescriptor {
  id: string
  name: string | null
  description: string | null
  icon: string | null // metadata.icon — a name of the standard's icon catalog; null = the kernel's silo glyph
  // spec.theme, only while the silo is ACTIVE and only a theme that holds
  // the contrast rule (theme-rule.ts — re-checked here: the file on disk is
  // read again at every boot), every token resolved (accent-soft derived).
  // The web offers it in Settings › Appearance; null = it brings no look
  theme: ResolvedTheme | null
  version: string | null
  apiVersion: string | null
  state: SiloState
  reason: string
  conventions: Array<{ source: string; convention: string }>
  wants: string[]
  kinds: string[] // qualified: invoices/invoice, plans/plan/task
  producer: { role: string; sync: string | null } | null
  // a kernel source (step 2): the kernel kind it presents and what that
  // reads, in the catalog's words — a page says it instead of a producer
  kernel: { kind: string; reads: string } | null
  records: { parsed: number; failed: number }
  lastWrite: string | null
  freshness: Freshness | null
  slots: { requested: string[]; granted: string[]; off: string[] }
  observedAt: string
  // step 4 (edge-only silos): the relations it declares, its first tree view
  // and its lens — what the web needs to draw them without a records route
  relations: Array<{ name: string; from: string; to: string; acyclic: boolean }>
  tree: { view: string; relation: string } | null
  lens: { over: string; label: string | null; relation: string; by: string } | null
  // its `list` views over its top-level kinds, in the manifest's order —
  // the first is its page's default; several over different kinds (System:
  // Processes · Worktrees) are what its page switches between, by `label`
  lists: Array<{ id: string; kind: string; label: string | null }>
}

export interface SiloRegistryOptions extends ReadOptions {
  dataDir: string
  operator?: SiloOperatorView
  // the words that keep a dimension Silos serves natively out (native.ts):
  // such an id is never active here, whatever operator.json says — the house
  // passes HOUSE_DIMENSIONS.nativeRefusal; absent = no dimension is native
  nativeRefusal?: (id: string) => string | null
  debounceMs?: number
  now?: () => Date
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export class SiloRegistry extends EventEmitter {
  readonly root: string
  readonly registryDir: string
  readonly conventionsDir: string
  private entries = new Map<string, SiloEntry>()
  private watcher: FSWatcher | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private operator: SiloOperatorView
  private now: () => Date

  constructor(private opts: SiloRegistryOptions) {
    super()
    this.root = join(opts.dataDir, 'silos')
    this.registryDir = join(this.root, 'registry')
    this.conventionsDir = join(this.root, 'conventions')
    this.operator = opts.operator ?? fileOperatorView(this.root)
    this.now = opts.now ?? (() => new Date())
  }

  // Boot: read every registry/<id>/ (creates registry/ — chokidar only
  // watches paths that exist). conventions/ is created by its first writer.
  load(): void {
    mkdirSync(this.registryDir, { recursive: true, mode: 0o700 })
    const seen = new Set<string>()
    let names: string[] = []
    try {
      names = readdirSync(this.registryDir)
    } catch (err) {
      console.warn('silos: the registry could not be read —', err instanceof Error ? err.message : err)
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      seen.add(name)
      this.loadOne(name)
    }
    for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.entries.delete(id)
  }

  // Ids that can't be taken by a new silo: the kernel's own words (route
  // segments under /api/silos among them) and every silo ever approved — an
  // approved id stays reserved after an uninstall (conformance.md §2), kept in
  // silos/reserved.json.
  reservedIds(): { kernel: readonly string[]; approved: string[] } {
    return { kernel: KERNEL_RESERVED_IDS, approved: this.readReserved() }
  }

  private readReserved(): string[] {
    try {
      const raw = JSON.parse(readFileSync(join(this.root, 'reserved.json'), 'utf8')) as unknown
      return isObj(raw) && Array.isArray(raw.approved) ? raw.approved.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  private reserve(id: string): void {
    const ids = this.readReserved()
    if (ids.includes(id)) return
    try {
      atomicWriteJson(join(this.root, 'reserved.json'), { approved: [...ids, id].sort() }, { mode: 0o600 })
    } catch (err) {
      console.warn(`silos: could not reserve ${id} —`, err instanceof Error ? err.message : err)
    }
  }

  list(): SiloEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): SiloEntry | null {
    return this.entries.get(id) ?? null
  }

  describe(): SiloDescriptor[] {
    return this.list().map(describeEntry)
  }

  // The reader (Task 3) reports what it parsed; the kernel records it in
  // status. A count for a silo the registry does not hold is ignored.
  noteRecords(id: string, stats: { parsed: number; failed: number; lastWrite: string | null; freshness?: Freshness | null }): void {
    const e = this.entries.get(id)
    if (!e) return
    const freshness = stats.freshness === undefined ? e.status.freshness : stats.freshness
    // 'records', not 'change': a new count is not a new manifest (the kernel
    // re-reads on 'change' — emitting it here would loop)
    this.commit(id, e.manifest, { ...e.status, records: { parsed: stats.parsed, failed: stats.failed }, lastWrite: stats.lastWrite, freshness }, 'records')
  }

  // Re-read one silo folder (the watcher's unit of work; also public so the
  // install route of Task 11 can apply its own write at once).
  loadOne(id: string): SiloEntry | null {
    const dir = join(this.registryDir, id)
    let isDir = false
    try {
      isDir = lstatSync(dir).isDirectory()
    } catch {
      /* gone */
    }
    const manifestFile = join(dir, 'silo.json')
    if (!isDir || !existsSync(manifestFile)) {
      // a folder without a manifest is not a silo (nothing to show)
      if (this.entries.delete(id)) this.emit('change', id)
      return null
    }
    const previous = this.readStatus(dir)
    const fail = (reason: string, manifest: Json | null = null, extra: Partial<SiloStatus> = {}): SiloEntry =>
      this.commit(id, manifest, { ...this.base(previous), ...extra, state: 'error', reason })

    if (!SILO_ID.test(id)) return fail(`the folder name ${JSON.stringify(id)} is not a valid silo id (lowercase letters, digits and -)`)
    const text = this.readManifestText(manifestFile)
    if ('error' in text) return fail(text.error)
    let raw: unknown
    try {
      raw = JSON.parse(text.text)
    } catch (err) {
      return fail(`silo.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    const meta = isObj(raw) && isObj(raw.metadata) ? raw.metadata : {}
    const manifestInfo = { apiVersion: isObj(raw) ? str(raw.apiVersion) : null, version: str(meta.version), name: str(meta.name), hash: hashText(text.text) }
    const reading = readManifest(raw, this.opts)
    if (!reading.ok) return fail(reading.reason, null, { manifest: manifestInfo, wants: reading.wants })
    if (meta.id !== id)
      return fail(`the manifest says its id is ${JSON.stringify(meta.id)} but it lives in the folder ${JSON.stringify(id)}`, null, {
        manifest: manifestInfo,
        wants: reading.wants,
      })

    const requested = SLOTS.filter(
      (s) => isObj((reading.manifest.spec as Json).surfaces) && ((reading.manifest.spec as Json).surfaces as Json)[s] !== undefined,
    )
    const approved = this.operator.decisionFor(id)
    const native = this.opts.nativeRefusal?.(id) ?? null
    const decision = native !== null ? 'disabled' : approved
    if (decision === 'approved') this.reserve(id)
    const off = [...this.operator.slotsOff(id)].filter((s) => (requested as readonly string[]).includes(s))
    const state: SiloState = decision === 'approved' ? 'active' : decision === 'disabled' ? 'disabled' : 'pending'
    const reason =
      state === 'active'
        ? reading.wants.length > 0
          ? `active — loaded without ${reading.wants.length} field${reading.wants.length === 1 ? '' : 's'} this Silos does not know yet`
          : 'active'
        : state === 'disabled'
          ? (native ?? 'turned off by the owner')
          : 'waiting for the owner to approve it'
    return this.commit(id, reading.manifest, {
      ...this.base(previous),
      state,
      reason,
      manifest: manifestInfo,
      wants: reading.wants,
      conventions: reading.conventions,
      slots: { requested: [...requested], granted: state === 'active' ? requested.filter((s) => !off.includes(s)) : [], off },
    })
  }

  // Hot reload: registry/<id>/silo.json added, changed or removed → that silo
  // is re-read (debounced per id). status.json is the kernel's own write and
  // never triggers a reload.
  watch(): void {
    if (this.watcher) return
    mkdirSync(this.registryDir, { recursive: true, mode: 0o700 })
    this.watcher = watch(this.registryDir, {
      ignoreInitial: true,
      depth: 1,
      ignored: (p: string) => /(^|[/\\])status\.json$/.test(p) || p.endsWith('.tmp'),
    })
    const touch = (p: string): void => {
      const rel = relative(this.registryDir, p)
      if (rel === '' || rel.startsWith('..')) return
      const id = rel.split(sep)[0]!
      if (id.startsWith('.')) return
      const prev = this.timers.get(id)
      if (prev) clearTimeout(prev)
      this.timers.set(
        id,
        setTimeout(() => {
          this.timers.delete(id)
          try {
            this.loadOne(id)
          } catch (err) {
            console.warn(`silos: reloading ${id} failed —`, err instanceof Error ? err.message : err)
          }
        }, this.opts.debounceMs ?? 150),
      )
    }
    for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) this.watcher.on(ev, touch)
    this.watcher.on('error', (err) => console.warn('silos: registry watcher —', err instanceof Error ? err.message : err))
  }

  async close(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    await this.watcher?.close()
    this.watcher = null
  }

  // ── internals ──

  private readManifestText(file: string): { text: string } | { error: string } {
    try {
      const st = lstatSync(file)
      if (st.isSymbolicLink()) {
        const real = realpathSync(file)
        if (!real.startsWith(realpathSync(this.registryDir) + sep))
          return { error: 'silo.json points outside the registry — a manifest must be a file inside its silo folder' }
        const rst = lstatSync(real)
        if (!rst.isFile()) return { error: 'silo.json is not a regular file' }
        if (rst.size > MANIFEST_MAX_BYTES) return { error: `silo.json is larger than ${MANIFEST_MAX_BYTES / 1024} KB` }
        return { text: readFileSync(real, 'utf8') }
      }
      if (!st.isFile()) return { error: 'silo.json is not a regular file' }
      if (st.size > MANIFEST_MAX_BYTES) return { error: `silo.json is larger than ${MANIFEST_MAX_BYTES / 1024} KB` }
      return { text: readFileSync(file, 'utf8') }
    } catch (err) {
      return { error: `silo.json could not be read: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  private readStatus(dir: string): SiloStatus | null {
    const file = join(dir, 'status.json')
    if (!existsSync(file)) return null
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
      const raw = JSON.parse(text) as unknown
      return isObj(raw) ? (raw as unknown as SiloStatus) : null
    } catch {
      if (text !== '') backupCorruptJson(file, text, 'silos')
      return null
    }
  }

  // What survives a re-read: the reader's counts (Task 3 refreshes them).
  private base(previous: SiloStatus | null): SiloStatus {
    const records =
      isObj(previous?.records) && typeof previous.records.parsed === 'number' && typeof previous.records.failed === 'number'
        ? { parsed: previous.records.parsed, failed: previous.records.failed }
        : { parsed: 0, failed: 0 }
    return {
      state: 'pending',
      reason: '',
      observedAt: previous?.observedAt ?? this.now().toISOString(),
      manifest: { apiVersion: null, version: null, name: null, hash: null },
      wants: [],
      conventions: [],
      records,
      lastWrite: typeof previous?.lastWrite === 'string' ? previous.lastWrite : null,
      freshness: isObj(previous?.freshness) ? (previous.freshness as Freshness) : null,
      slots: { requested: [], granted: [], off: [] },
    }
  }

  // Keep the entry and write status.json only when something changed
  // (observedAt aside) — a reload that finds the same silo leaves no trace.
  private commit(id: string, manifest: Json | null, status: SiloStatus, event: 'change' | 'records' = 'change'): SiloEntry {
    const dir = join(this.registryDir, id)
    const file = join(dir, 'status.json')
    const prev = this.entries.get(id)?.status ?? this.readStatus(dir)
    const same = prev !== null && JSON.stringify({ ...prev, observedAt: '' }) === JSON.stringify({ ...status, observedAt: '' })
    const next: SiloStatus = same ? { ...status, observedAt: prev.observedAt } : { ...status, observedAt: this.now().toISOString() }
    if (!same || !existsSync(file)) {
      try {
        atomicWriteJson(file, next, { mode: 0o600 })
      } catch (err) {
        console.warn(`silos: status of ${id} could not be written —`, err instanceof Error ? err.message : err)
      }
    }
    // the manifest's hash is part of status: a changed manifest is a changed status
    const entry: SiloEntry = { id, manifest, status: next }
    const known = this.entries.has(id)
    this.entries.set(id, entry)
    if (!same || !known) this.emit(event, id)
    return entry
  }
}

function describeEntry(e: SiloEntry): SiloDescriptor {
  const m = e.manifest
  const meta = isObj(m?.metadata) ? m.metadata : {}
  const spec = isObj(m?.spec) ? m.spec : {}
  const kinds: string[] = []
  if (isObj(spec.kinds)) {
    for (const [k, def] of Object.entries(spec.kinds)) {
      kinds.push(`${e.id}/${k}`)
      if (isObj(def) && isObj(def.subKinds)) for (const s of Object.keys(def.subKinds)) kinds.push(`${e.id}/${k}/${s}`)
    }
  }
  const producer =
    isObj(spec.producer) && typeof spec.producer.role === 'string'
      ? { role: spec.producer.role, sync: isObj(spec.producer.sync) ? str(spec.producer.sync.service) : null }
      : null
  const kss = (Array.isArray(spec.sources) ? spec.sources : []).filter((x): x is Json => isObj(x) && x.root === 'kernel')
  const ks = kss[0]
  const kk = ks ? kernelKind(String(ks.kind)) : null
  // several kernel kinds (System): what each reads, said in one sentence
  const reads = kss
    .map((x) => kernelKind(String(x.kind))?.reads)
    .filter((r): r is string => typeof r === 'string')
    .join('; and ')
  return {
    id: e.id,
    name: e.status.manifest.name,
    description: str(meta.description),
    icon: str(meta.icon),
    theme: e.status.state === 'active' ? offerableTheme(spec.theme) : null,
    version: e.status.manifest.version,
    apiVersion: e.status.manifest.apiVersion,
    state: e.status.state,
    reason: e.status.reason,
    conventions: e.status.conventions.map((c) => ({ source: c.source, convention: c.convention })),
    wants: [...e.status.wants],
    kinds,
    producer,
    kernel: ks && kk ? { kind: String(ks.kind), reads } : null,
    records: { ...e.status.records },
    lastWrite: e.status.lastWrite,
    freshness: e.status.freshness ? { ...e.status.freshness, sources: e.status.freshness.sources.map((x) => ({ ...x })) } : null,
    slots: { requested: [...e.status.slots.requested], granted: [...e.status.slots.granted], off: [...e.status.slots.off] },
    observedAt: e.status.observedAt,
    relations: (Array.isArray(spec.relations) ? spec.relations : [])
      .filter(isObj)
      .map((r) => ({ name: String(r.name), from: String(r.from), to: String(r.to), acyclic: r.acyclic === true })),
    tree: treeOf(spec),
    lens: lensOf(spec),
    lists: listsOf(spec),
  }
}

function listsOf(spec: Json): SiloDescriptor['lists'] {
  const top = new Set(isObj(spec.kinds) ? Object.keys(spec.kinds) : [])
  return (Array.isArray(spec.views) ? spec.views : [])
    .filter((x): x is Json => isObj(x) && x.archetype === 'list' && typeof x.kind === 'string' && top.has(x.kind))
    .map((v) => ({ id: String(v.id), kind: String(v.kind), label: str(v.label) }))
}

function treeOf(spec: Json): SiloDescriptor['tree'] {
  const v = (Array.isArray(spec.views) ? spec.views : []).find((x): x is Json => isObj(x) && x.archetype === 'tree' && typeof x.relation === 'string')
  return v ? { view: String(v.id), relation: String(v.relation) } : null
}

function lensOf(spec: Json): SiloDescriptor['lens'] {
  const l = isObj(spec.surfaces) && isObj(spec.surfaces.lens) ? spec.surfaces.lens : null
  const g = l && isObj(l.groupBy) ? l.groupBy : null
  if (!l || !g || typeof g.relation !== 'string') return null
  return { over: String(l.over), label: str(l.label), relation: g.relation, by: String(g.by) }
}
