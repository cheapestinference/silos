// machine-sampler.ts — the machine's vitals:
// what the disk and the memory looked like, hour by hour. Runs, executions
// and births are derived backwards from their own records; disk and RAM are
// not reconstructible, so they are SAMPLED — one sample per hour on the
// resident's tick (resident.ts, the titler's lane), and one at boot (the
// first tick of every process samples).
//
// THE SAMPLE. One JSON line appended to <dataDir>/machine/<YYYY-MM>.jsonl
// (UTC month of `at`): {at, disk:{capBytes, usedBytes, bytes:{transcripts,
// trash, worktrees, agentState, other}}, mem:{usedBytes, totalBytes}, load}.
// Monthly files older than MACHINE_KEEP_MONTHS are deleted when a sample is
// written (Silos' own measurements, nobody else's data).
//
// THE ATTRIBUTION. transcripts = the roots of the engines whose sessions are
// files (SessionIndex.transcriptRoots — no engine named here); trash =
// Silos' trash; worktrees = the live records of the `worktree` kind;
// agentState = the dataDir's agent-state; other = usedBytes − the sum (never
// below 0). A path nested in another of the same group counts once.
//
// THE EVENT LOOP (silos#t22: ≤50 ms per synchronous stretch). Sizes come
// from `du -sb` as a child process with a bounded timeout, never a walk in
// this process; the disk from statfs (async); memory and load from os.*. A
// `du` that times out leaves its group at 0 — the bytes land in «other»,
// unattributed, never guessed. Reading back is async and reads at most the
// two monthly files the 30-day window touches.
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readdir, readFile, rm, stat, statfs } from 'node:fs/promises'
import { freemem, loadavg, totalmem } from 'node:os'
import { join, sep } from 'node:path'

// the machine's local calendar day (the same day Home's runs are counted in)
function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const MACHINE_SAMPLE_MS = 3600_000
export const MACHINE_KEEP_MONTHS = 12
export const DU_TIMEOUT_MS = 120_000
export const DISK_DAYS = 30
export const MEMORY_DAYS = 7

export const DISK_GROUPS = ['transcripts', 'trash', 'worktrees', 'agentState', 'other'] as const
export type DiskGroup = (typeof DISK_GROUPS)[number]
export type DiskBytes = Record<DiskGroup, number>

export interface MachineSample {
  at: string
  disk: { capBytes: number; usedBytes: number; bytes: DiskBytes }
  mem: { usedBytes: number; totalBytes: number }
  load: number
}

/** Where each group lives — read at every sample (worktrees come and go). */
export interface MachineSources {
  transcripts(): readonly string[]
  trash: string
  worktrees(): readonly string[]
  agentState: string
  /** the path whose filesystem is measured (the dataDir) */
  disk: string
}

/** Total bytes under `paths` (one `du` for all of them), null when it could not say. */
export type DuRun = (paths: readonly string[]) => Promise<number | null>
export type DiskStat = (path: string) => Promise<{ capBytes: number; usedBytes: number }>
export type MemStat = () => { usedBytes: number; totalBytes: number; load: number }

// `du -sb` as a bounded child: its stdout is read even when it exits 1 (a
// file it could not read is skipped, the rest still counts); a timeout or a
// missing du says null.
export function execDu(o: { timeoutMs?: number } = {}): DuRun {
  return (paths) =>
    new Promise((resolve) => {
      if (paths.length === 0) {
        resolve(0)
        return
      }
      execFile('du', ['-sb', '--', ...paths], { timeout: o.timeoutMs ?? DU_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
        if (err && ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as { killed?: boolean }).killed)) {
          resolve(null)
          return
        }
        let sum = 0
        let any = false
        for (const line of String(stdout).split('\n')) {
          const m = /^(\d+)\t/.exec(line)
          if (m) {
            sum += Number(m[1])
            any = true
          }
        }
        resolve(any ? sum : err ? null : 0)
      })
    })
}

export const statfsDisk: DiskStat = async (path) => {
  const s = await statfs(path)
  return { capBytes: s.blocks * s.bsize, usedBytes: (s.blocks - s.bfree) * s.bsize }
}

export const osMem: MemStat = () => {
  const total = totalmem()
  return { usedBytes: total - freemem(), totalBytes: total, load: Math.round((loadavg()[0] ?? 0) * 100) / 100 }
}

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** The paths of one group, each once: duplicates and paths nested in another dropped. */
export function outermost(paths: readonly string[]): string[] {
  const uniq = [...new Set(paths.filter((p) => p !== ''))]
  return uniq.filter((p) => !uniq.some((q) => q !== p && within(p, q)))
}

async function existing(paths: readonly string[]): Promise<string[]> {
  const ok = await Promise.all(
    paths.map((p) =>
      stat(p).then(
        () => true,
        () => false,
      ),
    ),
  )
  return paths.filter((_, i) => ok[i])
}

/** One sample of the machine, now. */
export async function takeSample(src: MachineSources, o: { du?: DuRun; disk?: DiskStat; mem?: MemStat; now?: () => Date } = {}): Promise<MachineSample> {
  const du = o.du ?? execDu()
  const at = (o.now?.() ?? new Date()).toISOString()
  const disk = await (o.disk ?? statfsDisk)(src.disk)
  const groups: Record<Exclude<DiskGroup, 'other'>, readonly string[]> = {
    transcripts: src.transcripts(),
    trash: [src.trash],
    worktrees: src.worktrees(),
    agentState: [src.agentState],
  }
  const bytes: DiskBytes = { transcripts: 0, trash: 0, worktrees: 0, agentState: 0, other: 0 }
  // one du at a time: a sample is background work, never an IO burst
  for (const g of Object.keys(groups) as (keyof typeof groups)[]) {
    bytes[g] = (await du(await existing(outermost(groups[g])))) ?? 0
  }
  const attributed = bytes.transcripts + bytes.trash + bytes.worktrees + bytes.agentState
  bytes.other = Math.max(0, disk.usedBytes - attributed)
  const m = (o.mem ?? osMem)()
  return { at, disk: { capBytes: disk.capBytes, usedBytes: disk.usedBytes, bytes }, mem: { usedBytes: m.usedBytes, totalBytes: m.totalBytes }, load: m.load }
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)
const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/

/** The month files from `sinceMs` to `nowMs`, inclusive (UTC months). */
function monthsBetween(sinceMs: number, nowMs: number): string[] {
  const out: string[] = []
  const d = new Date(Date.UTC(new Date(sinceMs).getUTCFullYear(), new Date(sinceMs).getUTCMonth(), 1))
  const last = monthOf(nowMs)
  for (let i = 0; i < 24; i++) {
    const m = d.toISOString().slice(0, 7)
    out.push(m)
    if (m >= last) break
    d.setUTCMonth(d.getUTCMonth() + 1)
  }
  return out
}

function isSample(v: unknown): v is MachineSample {
  const s = v as MachineSample
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.at === 'string' &&
    Number.isFinite(Date.parse(s.at)) &&
    typeof s.disk?.usedBytes === 'number' &&
    typeof s.disk?.capBytes === 'number' &&
    typeof s.disk?.bytes === 'object' &&
    s.disk.bytes !== null &&
    typeof s.mem?.usedBytes === 'number' &&
    typeof s.mem?.totalBytes === 'number'
  )
}

/** The samples taken since `sinceMs`, ascending; a malformed line is skipped. */
export async function readSamples(dir: string, sinceMs: number, nowMs = Date.now()): Promise<MachineSample[]> {
  const out: MachineSample[] = []
  for (const m of monthsBetween(sinceMs, nowMs)) {
    const text = await readFile(join(dir, `${m}.jsonl`), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let v: unknown
      try {
        v = JSON.parse(line)
      } catch {
        continue
      }
      if (isSample(v) && Date.parse(v.at) >= sinceMs) out.push(v)
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** Appends one sample to its month's file and deletes the months past retention. */
export async function writeSample(dir: string, s: MachineSample, keepMonths = MACHINE_KEEP_MONTHS): Promise<void> {
  await mkdir(dir, { recursive: true })
  const ms = Date.parse(s.at)
  await appendFile(join(dir, `${monthOf(ms)}.jsonl`), JSON.stringify(s) + '\n')
  const d = new Date(ms)
  const oldest = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (keepMonths - 1), 1)).toISOString().slice(0, 7)
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = MONTH_FILE.exec(name)
    if (m && `${m[1]}-${m[2]}` < oldest) await rm(join(dir, name), { force: true })
  }
}

export interface MachineSamplerOptions {
  dir: string
  sources: MachineSources
  du?: DuRun
  disk?: DiskStat
  mem?: MemStat
  intervalMs?: number
}

// The resident's sweep: due at the first tick of the process (the boot
// sample) and then every intervalMs; never two at once.
export class MachineSampler {
  private lastMs: number | null = null
  private running: Promise<MachineSample | null> | null = null
  constructor(private o: MachineSamplerOptions) {}

  get dir(): string {
    return this.o.dir
  }

  sweep(now: Date = new Date()): Promise<MachineSample | null> {
    if (this.running) return this.running
    if (this.lastMs !== null && now.getTime() - this.lastMs < (this.o.intervalMs ?? MACHINE_SAMPLE_MS)) return Promise.resolve(null)
    this.lastMs = now.getTime()
    this.running = (async () => {
      try {
        const s = await takeSample(this.o.sources, { du: this.o.du, disk: this.o.disk, mem: this.o.mem, now: () => now })
        await writeSample(this.o.dir, s)
        return s
      } catch (err) {
        console.warn('machine sampler: sample failed —', err instanceof Error ? err.message : err)
        return null
      } finally {
        this.running = null
      }
    })()
    return this.running
  }
}

// ---------------------------------------------------------------------------
// GET /api/system — the contract's shape, from the samples
// ---------------------------------------------------------------------------

export interface SystemView {
  disk: {
    capBytes: number
    days: { date: string; bytes: DiskBytes }[]
    now: { usedBytes: number; bytes: DiskBytes }
  }
  memory: { totalBytes: number; points: { at: string; usedBytes: number }[] }
  load: number
  server: { since: string }
  trash: { bytes: number }
}

const bytesOf = (b: Partial<DiskBytes>): DiskBytes => {
  const out = {} as DiskBytes
  for (const g of DISK_GROUPS) out[g] = typeof b[g] === 'number' ? b[g] : 0
  return out
}

const hourOf = (ms: number): string => new Date(Math.floor(ms / 3600_000) * 3600_000).toISOString().replace('.000Z', 'Z')

/** The view: disk days = the last sample of each local day (≤30, ascending);
 *  memory = the last sample of each UTC hour of the last 7 days — an hour
 *  without a sample is simply absent (a gap, never interpolated); `now` and
 *  trash from the latest sample (no sample yet: the live disk, all «other»);
 *  load and total memory live. */
export function systemView(
  samples: readonly MachineSample[],
  live: { nowMs: number; since: string; disk: { capBytes: number; usedBytes: number } | null; mem: ReturnType<MemStat> },
): SystemView {
  // 30 CALENDAR days back, never 29 × 24 h: across a DST change the hour
  // arithmetic lands on the wrong date and the chart lost a day
  const back = new Date(live.nowMs)
  back.setDate(back.getDate() - (DISK_DAYS - 1))
  const firstDay = localDay(back.getTime())
  const days = new Map<string, DiskBytes>()
  const hours = new Map<string, number>()
  const memSince = live.nowMs - MEMORY_DAYS * 86_400_000
  for (const s of samples) {
    const ms = Date.parse(s.at)
    const day = localDay(ms)
    if (day >= firstDay) days.set(day, bytesOf(s.disk.bytes))
    if (ms >= memSince) hours.set(hourOf(ms), s.mem.usedBytes)
  }
  const latest = samples.length > 0 ? samples[samples.length - 1] : null
  const liveDisk = live.disk ?? { capBytes: 0, usedBytes: 0 }
  const now = latest
    ? { usedBytes: latest.disk.usedBytes, bytes: bytesOf(latest.disk.bytes) }
    : { usedBytes: liveDisk.usedBytes, bytes: { ...bytesOf({}), other: liveDisk.usedBytes } }
  return {
    disk: {
      capBytes: latest?.disk.capBytes ?? liveDisk.capBytes,
      days: [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, bytes]) => ({ date, bytes })),
      now,
    },
    memory: { totalBytes: live.mem.totalBytes, points: [...hours].sort(([a], [b]) => (a < b ? -1 : 1)).map(([at, usedBytes]) => ({ at, usedBytes })) },
    load: live.mem.load,
    server: { since: live.since },
    trash: { bytes: now.bytes.trash },
  }
}
