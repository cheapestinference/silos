// plans-closed.ts — a task whose plan moved to plans/closed/ (team-plan's
// protocol: «Plan finished → plans/closed/») keeps its REFERENCES: the
// conversation that worked it still says «Worked on «title» ✓» and the
// task's page still opens — read-only. It never enters a list: the silo's reading (plans/*.plan.json)
// stays the truth for Tasks, Home and the Board; this answers only a
// question by key («what was folder:/p/ship/tasks/t4?») and the inverse
// «which closed tasks name this conversation».
//
// How: each convention folder the Plans silo reads (<project>/plans) has its
// closed/ beside the files; each file there is read through the silo's own
// rules (reader.ts readOutside — the name must match the source's pattern,
// safe-file containment, the size cap) and filed under the project's
// LOCATION key, so its record and task keys are exactly the keys they had
// while the plan was open. Parsed once per file mtime.
import { readdirSync, statSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { readOutside, type ReadEnv, type SiloRecord } from './silos/reader.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export const CLOSED_DIR = 'closed'
// a bound on what one question reads (a folder of years of closed plans)
const MAX_FILES_PER_DIR = 500

// the static folder a project source's glob names ('plans/*.plan.json' →
// ['plans']); null when the glob has no fixed folder, or is not a project's
export function projectConventionDir(manifest: Json): string[] | null {
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  const src = (Array.isArray(spec.sources) ? spec.sources : []).filter(isObj).find((s) => s.root === 'project' && typeof s.glob === 'string')
  if (!src) return null
  const segs = String(src.glob)
    .split('/')
    .filter((s) => s !== '' && s !== '.')
  const dir = segs.slice(0, -1)
  if (dir.length === 0 || dir.some((s) => /[*?[\]{}]/.test(s) || s === '..')) return null
  return dir
}

export interface ClosedPlansDeps {
  siloId: string
  manifest: () => Json | null
  // the folders the silo reads its files from (kernel.watchedFolders for
  // this silo: <project>/plans)
  conventionDirs: () => string[]
}

// one finished plan, as Tasks › Done's Plans strip lists it
export interface ClosedPlanEntry {
  key: string // the record's key it had while open
  title: string
  folder: string | null
  file: string // absolute, under plans/closed/ — the strip's door (read-only)
  mtime: number // ms: when it was moved there (its last write)
  done: number
  dropped: number
  open: number // a closed plan still holding open tasks (the inbox's row says it)
}

export class ClosedPlans {
  private cache = new Map<string, { mtimeMs: number; rec: SiloRecord | null }>()
  constructor(private deps: ClosedPlansDeps) {}

  // every closed plan, under its project's location key
  records(env: ReadEnv = {}): SiloRecord[] {
    const manifest = this.deps.manifest()
    if (!manifest) return []
    const prefix = projectConventionDir(manifest)
    if (!prefix) return []
    const out: SiloRecord[] = []
    const seen = new Set<string>()
    for (const dir of new Set(this.deps.conventionDirs())) {
      const tail = sep + prefix.join(sep)
      if (!dir.endsWith(tail)) continue
      const folder = dir.slice(0, dir.length - tail.length)
      const closed = join(dir, CLOSED_DIR)
      let names: string[]
      try {
        names = readdirSync(closed).sort().slice(0, MAX_FILES_PER_DIR)
      } catch {
        continue
      }
      for (const name of names) {
        const file = join(closed, name)
        seen.add(file)
        let mtimeMs: number
        try {
          const st = statSync(file)
          if (!st.isFile()) continue
          mtimeMs = st.mtimeMs
        } catch {
          continue
        }
        const hit = this.cache.get(file)
        let rec: SiloRecord | null
        if (hit && hit.mtimeMs === mtimeMs) rec = hit.rec
        else {
          const r = readOutside(this.deps.siloId, manifest, file, env)
          rec = r && !('unreadable' in r) ? { ...r, location: `folder:${folder}`, anchors: { folder } } : null
          this.cache.set(file, { mtimeMs, rec })
        }
        if (rec) out.push(rec)
      }
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k)
    return out
  }

  // Tasks › Done's Plans strip (work-photograph R2): every finished PLAN as
  // one line — title · file · when it closed (the file's mtime: the move to
  // closed/ is the last write) · its done words as counts. A LISTING, never
  // an ingestion: no task of these files enters any open reading. The
  // project's list's monthly archives (the rotation's tasks-YYYY-MM files)
  // are not plans — Done folds them by month already — so they stay out.
  listing(env: ReadEnv = {}): ClosedPlanEntry[] {
    const manifest = this.deps.manifest()
    if (!manifest) return []
    const archives = rotationsOf(manifest).map((r) => r.archive)
    return this.records(env)
      .filter((r) => !archives.some((a) => a.test(basename(r.file))))
      .map((r) => {
        const tasks = (Array.isArray(r.record.tasks) ? r.record.tasks : []).filter(isObj)
        const count = (pred: (s: unknown) => boolean): number => tasks.filter((t) => pred(t.state)).length
        return {
          key: `${r.location}/${r.record.id}`,
          title: typeof r.record.title === 'string' && r.record.title !== '' ? r.record.title : String(r.record.id),
          folder: r.location.startsWith('folder:') ? r.location.slice('folder:'.length) : null,
          file: r.file,
          mtime: r.mtimeMs,
          done: count((s) => s === 'done'),
          dropped: count((s) => s === 'cancelled'),
          open: count((s) => s !== 'done' && s !== 'cancelled'),
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
  }

  // the closed record a key names: the record's own key, or a child's under
  // it — or (plans 0.5.2, E7) a RETIRED child of a standing record: the key
  // it had in the live list (`folder:/p/tasks/tasks/t3`) resolves to the
  // archive its rotation wrote (`plans/closed/tasks-2026-10.plan.json`),
  // said under the standing record's id so the old link keeps opening. The
  // caller asks the live reading first: a child that is live wins.
  resolve(key: string, env: ReadEnv = {}): SiloRecord | null {
    if (!key.startsWith('folder:')) return null
    const recs = this.records(env)
    const direct = recs.find((r) => {
      const k = `${r.location}/${r.record.id}`
      return key === k || key.startsWith(`${k}/`)
    })
    if (direct) return direct
    const manifest = this.deps.manifest()
    if (!manifest) return null
    for (const rot of rotationsOf(manifest)) {
      const mid = `/${rot.id}/${rot.children}/`
      const at = key.lastIndexOf(mid)
      if (at < 0) continue
      const location = key.slice(0, at)
      const childId = key.slice(at + mid.length)
      if (childId === '' || childId.includes('/')) continue
      // the newest archive holding it (names sort by month)
      const hit = recs
        .filter((r) => r.location === location && rot.archive.test(basename(r.file)))
        .sort((a, b) => basename(a.file).localeCompare(basename(b.file)))
        .reverse()
        .find((r) => Array.isArray(r.record[rot.children]) && (r.record[rot.children] as unknown[]).some((c) => isObj(c) && c.id === childId))
      if (hit) return { ...hit, record: { ...hit.record, id: rot.id } }
    }
    return null
  }
}

// the rotations a manifest declares (ensure-record + rotate): the standing
// record's id, the collection that rotates, and the archive file name pattern
function rotationsOf(manifest: Json): Array<{ id: string; children: string; archive: RegExp }> {
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  const out: Array<{ id: string; children: string; archive: RegExp }> = []
  for (const a of (Array.isArray(spec.actions) ? spec.actions : []).filter(isObj)) {
    if (a.verb !== 'ensure-record' || typeof a.id !== 'string' || !isObj(a.rotate)) continue
    const children = a.rotate.children
    const into = a.rotate.into
    if (typeof children !== 'string' || typeof into !== 'string' || !into.includes('{{month}}')) continue
    const [pre, post] = (into.split('/').pop() ?? '').split('{{month}}') as [string, string | undefined]
    const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out.push({ id: a.id, children, archive: new RegExp(`^${esc(pre)}\\d{4}-\\d{2}${esc(post ?? '')}$`) })
  }
  return out
}
