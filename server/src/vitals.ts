// vitals.ts — the fleet's vitals:
// GET /api/vitals (runs a day, executions a day, the fleet by control) and
// what each automation spent in its last 30 days (`usage30d` on the list).
//
// Everything is derived backwards from what Silos already keeps — nothing
// is sampled:
//   - RUNS: the automations' runs files (<dataDir>/runs/<id>.jsonl and its
//     rotated .1 — automations-store.ts), folded by id like listRuns, read
//     INCREMENTALLY (only the bytes appended since the last read, sliced —
//     jsonl-lines.ts) so a read never re-folds megabytes. A run counts on the
//     local day it started, when it ran (ok · failed · running): a skip, a
//     queued or a held run is no run.
//   - EXECUTIONS: the kernel kind `execution` (silos/executions.ts), each on
//     the local day its ledger was last written (the record says no start).
//   - FLEET: today's agents at their derived position (control.ts
//     positionOf); history from the birth markers (an agent is born on the
//     day of its first marker — none: it predates the window) and from the
//     control log (fleet-events.ts). Before an agent's first logged change it
//     sits at that change's `from`; never changed, at its position today.
//   - SPEND per automation: each finished run of an agent automation → its
//     conversation (`sessionKey`) → the engine's usage records (the index's
//     usageRecords — the SAME reader and price table Usage reads) inside the
//     run's [start, end] → tokens and dollars. One run is read ONCE: its
//     figure is cached in <dataDir>/vitals/run-usage.json and never read
//     again. Dollars follow Usage's one money: a run on a plan (priced:false)
//     counts its tokens, no dollars. A command automation has none: null.
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteJson } from './json-store.js'
import { sliceLines } from './jsonl-lines.js'
import { localYmd, type Position } from './control.js'
import { appendFleetLines, lastPositions, readFleetLog, type FleetLine } from './fleet-events.js'
import { totalTokens } from './usage-attribution.js'
import type { UsageRecord } from './harnesses/contract.js'
import type { Automation, RunStatus } from './automations-types.js'
import { isCommandRun } from './automations-types.js'

export const RUN_DAYS = 30
export const FLEET_DAYS = 90
/** a finished run whose transcript can't be read yet is asked again until then */
const GONE_AFTER_MS = 3600_000
/** a run's records are those written in [start − 1 s, end + slack] */
const END_SLACK_MS = 10_000
/** a terminal run that never said its end: its window closes this long after its start */
const OPEN_END_MS = 24 * 3600_000
/** how long the automations list waits for a fill before answering from the cache */
const FILL_WAIT_MS = 1_500
const CONCURRENCY = 4
const CACHE_KEEP_MS = (RUN_DAYS + 10) * 24 * 3600_000

const RAN: ReadonlySet<RunStatus> = new Set(['ok', 'failed', 'running'])
const FINISHED: ReadonlySet<RunStatus> = new Set(['ok', 'failed'])

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
export type FleetEvent = { date: string; kind: 'birth'; agent: string } | { date: string; kind: 'control'; agent: string; from: Position; to: Position }
export interface Vitals {
  runs: DayCount[]
  executions: DayCount[]
  fleet: {
    today: { told: number; own: number; proactive: number; agents: Array<{ id: string; control: Position }> }
    days: FleetDay[]
    events: FleetEvent[]
  }
}
export interface AutomationUsage {
  tokens: number
  cost: number
  unpricedTokens: number
  days: Array<{ date: string; tokens: number }>
  runsCounted: number
  /** some of its tokens ran on a plan (no dollars for them — Usage's «on plan») */
  plan: boolean
}

/** One run as the vitals read it (a runs line, folded by id). */
interface RunLite {
  id: string
  status: RunStatus
  startMs: number
  endMs: number | null
  sessionKey?: string
  priced?: boolean
}

/** One finished run's figure, cached for good. */
export interface RunUsage {
  automation: string
  at: number
  tokens: number
  cost: number
  unpricedTokens: number
  plan: boolean
  measured: boolean
}

export interface VitalsDeps {
  dataDir: string
  automations: { list(): Automation[]; automationIdsWithRuns(): string[]; runsPath(id: string): string }
  usageRecords(folder: string, id: string): Promise<UsageRecord[] | null | 'unmeasured'>
  /** the fleet now: every agent not archived, at its derived position */
  agents(): Array<{ id: string; position: Position }>
  /** the birth markers (births-store.ts): whose, and when each landed */
  births(): Array<{ agentId: string; ctimeMs: number }>
  /** the kernel's executions: when each ledger was last written (ms) */
  executions(): Array<{ updatedAt: number }>
  now?: () => number
}

/** The last `n` local days ending on `now`'s, ascending. */
export function lastDays(now: number, n: number): string[] {
  const d = new Date(now)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(localYmd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime()))
  return out
}

function endOfLocalDay(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d + 1).getTime()
}

const countByDay = (days: string[], stamps: Iterable<number>): DayCount[] => {
  const n = new Map(days.map((d) => [d, 0]))
  for (const t of stamps) {
    const k = localYmd(t)
    if (n.has(k)) n.set(k, n.get(k)! + 1)
  }
  return days.map((date) => ({ date, count: n.get(date)! }))
}

const round = (usd: number): number => Math.round(usd * 1e6) / 1e6

/** The fleet's history (pure — the tests' door): today's agents, their
 *  births and the control log → 90 days of counts and the events in them. */
export function fleetSeries(o: {
  agents: Array<{ id: string; position: Position }>
  births: Array<{ agentId: string; ctimeMs: number }>
  log: readonly FleetLine[]
  now: number
  days?: number
}): Vitals['fleet'] {
  const days = lastDays(o.now, o.days ?? FLEET_DAYS)
  const first = days[0]!
  const ids = new Set(o.agents.map((a) => a.id))
  const born = new Map<string, number>()
  for (const b of o.births) {
    if (!ids.has(b.agentId) || !Number.isFinite(b.ctimeMs)) continue
    const cur = born.get(b.agentId)
    if (cur === undefined || b.ctimeMs < cur) born.set(b.agentId, b.ctimeMs)
  }
  const changes = new Map<string, Array<{ at: number; from: Position; to: Position }>>()
  for (const l of o.log) {
    if (l.kind !== 'control' || !ids.has(l.agent)) continue
    const list = changes.get(l.agent) ?? []
    list.push({ at: Date.parse(l.at), from: l.from, to: l.to })
    changes.set(l.agent, list)
  }
  for (const list of changes.values()) list.sort((a, b) => a.at - b.at)
  const positionAt = (a: { id: string; position: Position }, before: number): Position => {
    const list = changes.get(a.id)
    if (!list || list.length === 0) return a.position
    let p: Position = list[0]!.from
    for (const c of list) {
      if (c.at < before) p = c.to
      else break
    }
    return p
  }
  const series: FleetDay[] = days.map((date) => {
    const end = endOfLocalDay(date)
    const row: FleetDay = { date, told: 0, own: 0, proactive: 0 }
    for (const a of o.agents) {
      const b = born.get(a.id)
      if (b !== undefined && b >= end) continue
      row[positionAt(a, end)]++
    }
    return row
  })
  const events: FleetEvent[] = []
  for (const [agent, at] of born) {
    const date = localYmd(at)
    if (date >= first) events.push({ date, kind: 'birth', agent })
  }
  for (const [agent, list] of changes) {
    for (const c of list) {
      const date = localYmd(c.at)
      if (date >= first) events.push({ date, kind: 'control', agent, from: c.from, to: c.to })
    }
  }
  events.sort((x, y) => x.date.localeCompare(y.date) || (x.kind === y.kind ? 0 : x.kind === 'birth' ? -1 : 1) || x.agent.localeCompare(y.agent))
  const today = { told: 0, own: 0, proactive: 0, agents: o.agents.map((a) => ({ id: a.id, control: a.position })) }
  for (const a of o.agents) today[a.position]++
  return { today, days: series, events }
}

/** What one finished run used, from its conversation's records (pure). */
export function runUsageOf(run: { startMs: number; endMs: number | null; priced?: boolean }, automation: string, recs: readonly UsageRecord[]): RunUsage {
  const from = run.startMs - 1000
  const to = (run.endMs ?? run.startMs + OPEN_END_MS) + END_SLACK_MS
  const plan = run.priced === false
  let tokens = 0
  let cost = 0
  let unpricedTokens = 0
  for (const r of recs) {
    if (r.at < from || r.at > to) continue
    const t = totalTokens(r.tokens)
    tokens += t
    if (plan) continue
    if (r.costUsd === null) unpricedTokens += t
    else cost += r.costUsd
  }
  return { automation, at: run.startMs, tokens, cost: round(cost), unpricedTokens, plan: plan && tokens > 0, measured: true }
}

interface RunsFile {
  ino: number
  offset: number
}
interface RunsState {
  rotated: string | null
  current: RunsFile | null
  byId: Map<string, RunLite>
}

const statOf = (p: string): { ino: number; size: number; mtimeMs: number } | null => {
  try {
    const s = statSync(p)
    return s.isFile() ? { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs } : null
  } catch {
    return null
  }
}

function liteOf(line: string): RunLite | null {
  if (!line.trim()) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof o.id !== 'string' || typeof o.status !== 'string') return null
  const started = typeof o.startedAt === 'string' ? Date.parse(o.startedAt) : NaN
  const at = typeof o.at === 'string' ? Date.parse(o.at) : NaN
  const startMs = Number.isFinite(started) ? started : at
  if (!Number.isFinite(startMs)) return null
  const ended = typeof o.endedAt === 'string' ? Date.parse(o.endedAt) : NaN
  const dur = typeof o.durationMs === 'number' && o.durationMs >= 0 ? o.durationMs : null
  const endMs = Number.isFinite(ended) ? ended : dur !== null ? startMs + dur : null
  return {
    id: o.id,
    status: o.status as RunStatus,
    startMs,
    endMs,
    ...(typeof o.sessionKey === 'string' && o.sessionKey.includes('/') ? { sessionKey: o.sessionKey } : {}),
    ...(typeof o.priced === 'boolean' ? { priced: o.priced } : {}),
  }
}

export class VitalsService {
  private now: () => number
  private runs = new Map<string, RunsState>()
  private cache: Map<string, RunUsage> | null = null
  private filling: Promise<void> | null = null
  /** how many transcripts the fills have read (the tests' proof the cache holds) */
  reads = 0

  constructor(private d: VitalsDeps) {
    this.now = d.now ?? Date.now
  }

  private cacheFile(): string {
    return join(this.d.dataDir, 'vitals', 'run-usage.json')
  }

  // ── runs, folded incrementally ───────────────────────────────────────

  private async refreshRuns(id: string): Promise<Map<string, RunLite>> {
    const path = this.d.automations.runsPath(id)
    const rotPath = `${path}.1`
    const rot = statOf(rotPath)
    const cur = statOf(path)
    const rotSig = rot ? `${rot.ino}:${rot.size}:${rot.mtimeMs}` : null
    let st = this.runs.get(id)
    // a rotation (the .1 changed), a replaced or shrunk current file: from the start
    if (!st || st.rotated !== rotSig || (st.current && (!cur || cur.ino !== st.current.ino || cur.size < st.current.offset))) {
      st = { rotated: rotSig, current: null, byId: new Map() }
      this.runs.set(id, st)
      if (rot) await this.feed(rotPath, 0, rot.size, st.byId).catch(() => 0)
    }
    if (cur) {
      const from = st.current?.offset ?? 0
      const got = cur.size > from ? await this.feed(path, from, cur.size, st.byId).catch(() => 0) : 0
      st.current = { ino: cur.ino, offset: from + got }
    } else st.current = null
    return st.byId
  }

  private feed(path: string, from: number, to: number, into: Map<string, RunLite>): Promise<number> {
    return sliceLines(path, from, to, (lines) => {
      for (const line of lines) {
        const r = liteOf(line)
        if (r) into.set(r.id, r) // last line wins, as listRuns folds
      }
    })
  }

  private async allRuns(): Promise<Map<string, Map<string, RunLite>>> {
    const out = new Map<string, Map<string, RunLite>>()
    for (const id of this.d.automations.automationIdsWithRuns()) out.set(id, await this.refreshRuns(id))
    return out
  }

  // ── the per-run cache ────────────────────────────────────────────────

  private loadCache(): Map<string, RunUsage> {
    if (this.cache) return this.cache
    const m = new Map<string, RunUsage>()
    // missing or unreadable: an empty cache — every figure is read again, never lost
    const raw = ((): { runs?: Record<string, Partial<RunUsage> | null> } | null => {
      try {
        return JSON.parse(readFileSync(this.cacheFile(), 'utf8')) as { runs?: Record<string, Partial<RunUsage> | null> }
      } catch {
        return null
      }
    })()
    if (raw && raw.runs && typeof raw.runs === 'object') {
      for (const [k, v] of Object.entries(raw.runs)) {
        if (v && typeof v.automation === 'string' && typeof v.at === 'number' && typeof v.tokens === 'number' && typeof v.cost === 'number')
          m.set(k, {
            automation: v.automation,
            at: v.at,
            tokens: v.tokens,
            cost: v.cost,
            unpricedTokens: typeof v.unpricedTokens === 'number' ? v.unpricedTokens : 0,
            plan: v.plan === true,
            measured: v.measured !== false,
          })
      }
    }
    this.cache = m
    return m
  }

  private saveCache(): void {
    const m = this.loadCache()
    const keep = this.now() - CACHE_KEEP_MS
    for (const [k, v] of m) if (v.at < keep) m.delete(k)
    try {
      mkdirSync(dirname(this.cacheFile()), { recursive: true })
      atomicWriteJson(this.cacheFile(), { version: 1, runs: Object.fromEntries(m) })
    } catch (err) {
      console.warn("vitals: could not save the runs' usage —", err instanceof Error ? err.message : err)
    }
  }

  /** Read the finished runs of the last 30 days that no figure holds yet —
   *  one read per conversation, however many runs it holds. */
  fill(): Promise<void> {
    this.filling ??= this.doFill().finally(() => {
      this.filling = null
    })
    return this.filling
  }

  private async doFill(): Promise<void> {
    const cache = this.loadCache()
    const now = this.now()
    const since = new Date(lastDays(now, RUN_DAYS)[0]! + 'T00:00:00').getTime()
    const agentAutomations = new Set(
      this.d.automations
        .list()
        .filter((a) => !isCommandRun(a))
        .map((a) => a.id),
    )
    const bySession = new Map<string, Array<{ automation: string; run: RunLite }>>()
    for (const [automation, runs] of await this.allRuns()) {
      if (!agentAutomations.has(automation)) continue
      for (const run of runs.values()) {
        if (!FINISHED.has(run.status) || run.startMs < since || !run.sessionKey || cache.has(run.id)) continue
        const list = bySession.get(run.sessionKey) ?? []
        list.push({ automation, run })
        bySession.set(run.sessionKey, list)
      }
    }
    if (bySession.size === 0) return
    let changed = false
    const sessions = [...bySession]
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < sessions.length) {
        const [key, runs] = sessions[i++]!
        const cut = key.indexOf('/')
        let recs: UsageRecord[] | null | 'unmeasured' = null
        this.reads++
        try {
          recs = await this.d.usageRecords(key.slice(0, cut), key.slice(cut + 1))
        } catch {
          recs = null
        }
        for (const { automation, run } of runs) {
          if (Array.isArray(recs)) cache.set(run.id, runUsageOf(run, automation, recs))
          // its engine can't say, or its transcript is gone for good: counted, nothing measured
          else if (recs === 'unmeasured' || now - (run.endMs ?? run.startMs) > GONE_AFTER_MS)
            cache.set(run.id, { automation, at: run.startMs, tokens: 0, cost: 0, unpricedTokens: 0, plan: false, measured: false })
          else continue
          changed = true
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sessions.length) }, worker))
    if (changed) this.saveCache()
  }

  /** `usage30d` of each automation (null: a command — it runs no turn) and
   *  the list's totals. Waits a moment for a fill; what is not read yet is
   *  counted on the next read (`runsCounted` says how many runs it holds). */
  async automationUsage(list: readonly Automation[]): Promise<{ byId: Map<string, AutomationUsage | null>; totals: { tokens: number; cost: number } }> {
    const fill = this.fill().catch((err) => console.warn("vitals: reading the runs' usage failed —", err instanceof Error ? err.message : err))
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      fill,
      new Promise<void>((r) => {
        timer = setTimeout(r, FILL_WAIT_MS)
        timer.unref?.()
      }),
    ])
    if (timer) clearTimeout(timer)
    return this.usageFromCache(list)
  }

  /** The figures the cache holds now (sync, no read). */
  usageFromCache(list: readonly Automation[]): { byId: Map<string, AutomationUsage | null>; totals: { tokens: number; cost: number } } {
    const days = lastDays(this.now(), RUN_DAYS)
    const dayIdx = new Map(days.map((d, i) => [d, i]))
    const acc = new Map<string, AutomationUsage>()
    const byId = new Map<string, AutomationUsage | null>()
    for (const a of list) {
      if (isCommandRun(a)) {
        byId.set(a.id, null)
        continue
      }
      const u: AutomationUsage = { tokens: 0, cost: 0, unpricedTokens: 0, days: days.map((date) => ({ date, tokens: 0 })), runsCounted: 0, plan: false }
      acc.set(a.id, u)
      byId.set(a.id, u)
    }
    for (const r of this.loadCache().values()) {
      const u = acc.get(r.automation)
      const k = dayIdx.get(localYmd(r.at))
      if (!u || k === undefined) continue
      u.tokens += r.tokens
      u.cost += r.cost
      u.unpricedTokens += r.unpricedTokens
      u.days[k]!.tokens += r.tokens
      u.runsCounted++
      if (r.plan) u.plan = true
    }
    const totals = { tokens: 0, cost: 0 }
    for (const u of acc.values()) {
      u.cost = round(u.cost)
      totals.tokens += u.tokens
      totals.cost += u.cost
    }
    totals.cost = round(totals.cost)
    return { byId, totals }
  }

  // ── the fleet's control log ──────────────────────────────────────────

  /** Reconcile the log with the fleet now: a position moved by a path that
   *  wrote nothing gets its change written (at this instant); an agent never
   *  written gets its `seen` baseline. Returns the log as it now stands. */
  noteFleet(agents: Array<{ id: string; position: Position }>): FleetLine[] {
    const log = readFleetLog(this.d.dataDir)
    const last = lastPositions(log)
    const at = new Date(this.now()).toISOString()
    const add: FleetLine[] = []
    for (const a of agents) {
      const p = last.get(a.id)
      if (p === undefined) add.push({ at, kind: 'seen', agent: a.id, position: a.position })
      else if (p !== a.position) add.push({ at, kind: 'control', agent: a.id, from: p, to: a.position })
    }
    if (add.length > 0) {
      try {
        appendFleetLines(this.d.dataDir, add)
        log.push(...add)
      } catch (err) {
        console.warn("vitals: could not write the fleet's control log —", err instanceof Error ? err.message : err)
      }
    }
    return log
  }

  // ── GET /api/vitals ──────────────────────────────────────────────────

  async vitals(): Promise<Vitals> {
    const now = this.now()
    const days = lastDays(now, RUN_DAYS)
    const ran: number[] = []
    for (const runs of (await this.allRuns()).values()) for (const r of runs.values()) if (RAN.has(r.status)) ran.push(r.startMs)
    let execs: Array<{ updatedAt: number }> = []
    try {
      execs = this.d.executions()
    } catch {
      execs = []
    }
    const agents = this.d.agents()
    let births: Array<{ agentId: string; ctimeMs: number }> = []
    try {
      births = this.d.births()
    } catch {
      births = []
    }
    const log = this.noteFleet(agents)
    return {
      runs: countByDay(days, ran),
      executions: countByDay(
        days,
        execs.map((e) => e.updatedAt),
      ),
      fleet: fleetSeries({ agents, births, log, now }),
    }
  }
}
