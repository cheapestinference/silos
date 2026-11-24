// vitals.ts — the web's reading of GET /api/system and GET /api/vitals.
// Two zooms, one
// mark: Home's «This month» draws the miniature, System the full plate —
// the same series, the same colour, two sizes. This file holds the shapes
// and the pure rules both zooms share; never a figure the server didn't
// send, and no drawing here.

export const DISK_GROUPS = ['transcripts', 'trash', 'worktrees', 'agentState', 'other'] as const
export type DiskGroup = (typeof DISK_GROUPS)[number]
export type DiskBytes = Record<DiskGroup, number>

export interface SystemReport {
  disk: { capBytes: number; days: Array<{ date: string; bytes: DiskBytes }>; now: { usedBytes: number; bytes: DiskBytes } }
  memory: { totalBytes: number; points: Array<{ at: string; usedBytes: number }> }
  load: number
  server: { since: string }
  trash: { bytes: number }
}
export type SystemView = SystemReport

/** the control ladder — ordinal (Only when told · On its own · Proactive) */
export type Control = 'told' | 'own' | 'proactive'
export interface DayCount {
  date: string
  count: number
}
export interface FleetDay {
  date: string
  told: number
  own: number
  proactive: number
}
export type FleetEvent = { date: string; kind: 'birth'; agent: string } | { date: string; kind: 'control'; agent: string; from: Control; to: Control }
export interface VitalsReport {
  runs: DayCount[]
  executions: DayCount[]
  fleet: {
    today: { told: number; own: number; proactive: number; agents: Array<{ id: string; control: Control }> }
    days: FleetDay[]
    events: FleetEvent[]
  }
}
export type Vitals = VitalsReport

// the disk's groups, bottom up: Usage's categorical hues for what Silos can
// name, the residual in neutral — never a hue of its own
export const DISK_LABEL: Record<DiskGroup, string> = {
  transcripts: 'Transcripts',
  trash: 'Trash',
  worktrees: 'Worktrees',
  agentState: 'Agent state',
  other: 'Other',
}
export const DISK_FILL: Record<DiskGroup, string> = {
  transcripts: 'var(--use-agent-1)',
  trash: 'var(--use-agent-2)',
  worktrees: 'var(--use-agent-3)',
  agentState: 'var(--use-agent-4)',
  other: 'var(--ink-3)',
}

// the control ladder is ordinal: more ink = more autonomy, never three hues
// (solid · half · hollow), the most autonomous first
export const CONTROLS: readonly Control[] = ['proactive', 'own', 'told']
export const CONTROL_LABEL: Record<Control, string> = { proactive: 'Proactive', own: 'On its own', told: 'Only when told' }
export const CONTROL_INK: Record<Control, number> = { proactive: 0.85, own: 0.42, told: 0.14 }
export const CONTROL_ORDER = CONTROLS
export const CONTROL_WORDS = CONTROL_LABEL

export interface FleetKind {
  control: Control
  word: string
  count: number
  names: string[]
}

// Home's fleet line: each kind SAID with its word and its count, the
// ladder's order, a kind with nobody left out; the names (for the cursor)
// in the order the server listed the agents. The count is the server's
// (`today.<kind>`), never the length of a list this file filtered.
export function fleetKinds(today: Vitals['fleet']['today'], nameOf: (id: string) => string): FleetKind[] {
  return CONTROL_ORDER.filter((c) => today[c] > 0).map((c) => ({
    control: c,
    word: CONTROL_WORDS[c],
    count: today[c],
    names: today.agents.filter((a) => a.control === c).map((a) => nameOf(a.id)),
  }))
}

const GB = 1e9

/** «24.3 GB», «468 GB», «52 MB» — decimal units, as `du -sb` and `df` count. */
export function bytesWords(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 GB'
  if (n < 0.1 * GB) return `${Math.max(1, Math.round(n / 1e6))} MB`
  const g = n / GB
  return `${g >= 100 ? Math.round(g) : g.toFixed(1)} GB`
}

/** a size in the machine's words (1000-based, as `df -H` and the plate say it) */
export function gbWords(bytes: number): string {
  const gb = bytes / GB
  return gb >= 100 ? `${Math.round(gb)} GB` : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/** A figure in GB for an axis or a tooltip row, without the unit. */
export function gbFigure(n: number): string {
  const g = n / GB
  return g >= 100 ? String(Math.round(g)) : g >= 10 ? g.toFixed(1) : g.toFixed(g >= 1 ? 1 : 2)
}

/** «12 Nov» — a chart's day. */
export function shortDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
/** «21 Nov» — a month's day, for the cursor */
export const monthDayWords = shortDay

/** «12 Nov, 14:00» — an hour of the memory line. */
export function hourWords(ms: number): string {
  const d = new Date(ms)
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${String(d.getHours()).padStart(2, '0')}:00`
}

/** Gridline values for an axis from 0 to at least `max`: 0 and two or three
 *  round steps above it, the top one ≥ max. */
export function niceTicks(max: number, want = 3): number[] {
  if (!(max > 0)) return [0, 1]
  const raw = max / want
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

/** The disk's stack: for each day, each group's bottom and top (bytes), in
 *  DISK_GROUPS order — the same sum as the day's attributed total. */
export function diskStack(days: SystemReport['disk']['days']): Array<Record<DiskGroup, [number, number]>> {
  return days.map((d) => {
    let at = 0
    const row = {} as Record<DiskGroup, [number, number]>
    for (const g of DISK_GROUPS) {
      const v = Math.max(0, d.bytes[g] ?? 0)
      row[g] = [at, at + v]
      at += v
    }
    return row
  })
}

export const diskTotal = (b: DiskBytes): number => DISK_GROUPS.reduce((s, g) => s + Math.max(0, b[g] ?? 0), 0)

/** a disk day's used bytes: the groups add up to it (`other` is the residue) */
export function diskUsed(bytes: Record<DiskGroup, number>): number {
  let n = 0
  for (const v of Object.values(bytes)) n += typeof v === 'number' && Number.isFinite(v) ? v : 0
  return n
}

const HOUR = 3600_000

/** The memory line cut where the server did not run: runs of consecutive
 *  hours, and the gaps between them (a missing hour between two samples is
 *  the server down — never interpolated). Before the first sample is not a
 *  gap: that is before the sampler, said apart. */
export function memoryRuns(points: SystemReport['memory']['points']): {
  runs: Array<Array<{ ms: number; usedBytes: number }>>
  gaps: Array<{ fromMs: number; toMs: number }>
} {
  const sorted = points
    .map((p) => ({ ms: Date.parse(p.at), usedBytes: p.usedBytes }))
    .filter((p) => Number.isFinite(p.ms))
    .sort((a, b) => a.ms - b.ms)
  const runs: Array<Array<{ ms: number; usedBytes: number }>> = []
  const gaps: Array<{ fromMs: number; toMs: number }> = []
  for (const p of sorted) {
    const cur = runs[runs.length - 1]
    const last = cur?.[cur.length - 1]
    if (!cur || !last || p.ms - last.ms > HOUR * 1.5) {
      if (last) gaps.push({ fromMs: last.ms, toMs: p.ms })
      runs.push([p])
    } else cur.push(p)
  }
  return { runs, gaps }
}

/** «server up 3 days» — how long this server has run. */
export function uptimeWords(since: string, nowMs: number): string {
  const ms = nowMs - Date.parse(since)
  if (!Number.isFinite(ms) || ms < 0) return 'server up'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `server up ${min <= 1 ? 'a minute' : `${min} minutes`}`
  const h = Math.floor(min / 60)
  if (h < 48) return `server up ${h === 1 ? 'an hour' : `${h} hours`}`
  return `server up ${Math.floor(h / 24)} days`
}

/** The quiet sentence under a chart whose history is still short; null once
 *  the window is full. `n` days (or hours) held out of `full`. */
export function shortHistoryWords(held: number, full: number, firstDate: string | null, unit: 'days' | 'hours'): string | null {
  if (held >= full || !firstDate) return null
  if (unit === 'days')
    return held <= 1
      ? 'Sampling began today — the chart grows a day at a time.'
      : `Sampled since ${shortDay(firstDate)} — the chart grows a day at a time until it holds ${full}.`
  return `Sampled since ${hourWords(Date.parse(firstDate))} — one sample an hour, a week at most.`
}
