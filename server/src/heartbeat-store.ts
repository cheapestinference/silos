// heartbeat-store.ts — what an agent considered in its heartbeats:
// ~/.silos/heartbeats/<agentId>/considered.jsonl,
// append-only, rotated to its last CONSIDERED_KEEP_LINES lines, written ONLY
// by the server from POST /api/agents/<self>/considered. Fenced from every
// agent (heartbeats/** is in the fence's dataDir deny list): it is read back
// into quotas and into PROMPTS («You considered before»).
//
// And the heartbeat's STATE: with a free period an
// agent may beat hundreds of times a day, so what a fire used to derive by
// re-reading the run history on every tick — its last think, the think left
// pending to re-arm, today's counts — is kept here, written as each
// heartbeat run is written (noteRun), and read from here.
// ~/.silos/heartbeats/<agentId>/state.json — same seal, same fence.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { sealHooks } from './seal-hooks.js'
import { join } from 'node:path'
import { CONSIDERED_KEEP_LINES, CONSIDERED_PROMPT_DAYS_MS, CONSIDERED_PROMPT_MAX } from './limits.js'
import type { Considered } from './heartbeat-packet.js'
import type { Run } from './automations-types.js'
import { periodDay } from './period.js'

/** Why a think is left pending to re-arm (spend,
 *  account, headroom, engine — or it failed). */
export type PendingWhy = 'spend' | 'account' | 'headroom' | 'engine' | 'failed'
export interface HeartbeatState {
  /** the last heartbeat run that had a turn — the packet's `since` */
  lastTurnAt?: string
  /** the last think that had a turn («7 d − 1 h») */
  lastThinkTurnAt?: string
  /** the local day a think was last TRIED — it had its turn or failed; a
   *  skipped one is no try (at most one try a day, plus the re-arm) */
  thinkTriedDay?: string
  /** the think a skip or a failure left pending — cleared by a think that ran */
  pendingThink?: { at: string; why: PendingWhy }
  /** the start of the newest think whose rows decided `pendingThink`: an
   *  older think's row (its audit's re-write, a boot's close) never
   *  overrides what a newer one set */
  thinkNotedAt?: string
  /** the local day of the last re-armed launch (one a day) */
  rearmDay?: string
  /** the engine's refusal said on its row today — then silence while it lasts */
  engineSaid?: { day: string; refusal: string }
  /** today's fires: turns by kind (one that had its turn) and skips (counted once per run id) */
  today?: { day: string; looks: number; thinks: number; rounds?: number; skipped: number; counted: string[] }
}

// a heartbeat run that took a turn (the packet's `since`, the last think)
export const hadTurn = (r: Pick<Run, 'status' | 'produced'>): boolean =>
  r.status === 'ok' || ((r.status === 'failed' || r.status === 'waiting_reset') && r.produced === true)
const PENDING_SKIPS: ReadonlySet<string> = new Set(['spend', 'account', 'headroom', 'engine'])

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export class HeartbeatStore {
  constructor(private dataDir: string) {}

  private dir(agentId: string): string {
    if (!AGENT_ID.test(agentId)) throw new Error('invalid agent id')
    return join(this.dataDir, 'heartbeats', agentId)
  }

  private file(agentId: string): string {
    return join(this.dir(agentId), 'considered.jsonl')
  }
  private stateFile(agentId: string): string {
    return join(this.dir(agentId), 'state.json')
  }
  private states = new Map<string, HeartbeatState>()

  /** The heartbeat's state (cached; a missing or torn file is a fresh one). */
  state(agentId: string): HeartbeatState {
    const cached = this.states.get(agentId)
    if (cached) return cached
    let st: HeartbeatState = {}
    try {
      const f = this.stateFile(agentId)
      if (existsSync(f)) {
        const o = JSON.parse(readFileSync(f, 'utf8')) as unknown
        if (o && typeof o === 'object' && !Array.isArray(o)) st = o as HeartbeatState
      }
    } catch {
      st = {}
    }
    this.states.set(agentId, st)
    return st
  }

  private saveState(agentId: string, st: HeartbeatState): void {
    this.states.set(agentId, st)
    const dir = this.dir(agentId)
    mkdirSync(dir, { recursive: true })
    const f = this.stateFile(agentId)
    const text = `${JSON.stringify(st)}\n`
    if (sealHooks().write?.(f, text) === true) return
    const tmp = `${f}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, f)
  }

  /** A heartbeat run as the resident writes it (its start, its end, a skip,
   *  the audit's re-write, a boot's close): the state follows it. Idempotent
   *  per run, and ordered: a row of an OLDER run never overrides what a
   *  newer one set — a row of an older day never resets today's counters,
   *  an older think never sets a think pending again after a newer one. */
  noteRun(agentId: string, run: Run): void {
    const hb = run.heartbeat
    if (!hb) return
    const st: HeartbeatState = { ...this.state(agentId) }
    const day = periodDay(Date.parse(run.at) || 0)
    const later = (a: string | undefined, b: string): string => (a !== undefined && (Date.parse(a) || 0) >= (Date.parse(b) || 0) ? a : b)
    const laterDay = (a: string | undefined, b: string): string => (a !== undefined && a >= b ? a : b)
    if (hadTurn(run)) {
      st.lastTurnAt = later(st.lastTurnAt, run.at)
      if (hb.kind === 'think') st.lastThinkTurnAt = later(st.lastThinkTurnAt, run.at)
    }
    if (run.cause === 'rearm') st.rearmDay = laterDay(st.rearmDay, day)
    if (hb.kind === 'think') {
      if (run.status === 'running') st.thinkTriedDay = laterDay(st.thinkTriedDay, day)
      // only the newest think decides what is pending
      if (st.thinkNotedAt === undefined || (Date.parse(run.at) || 0) >= (Date.parse(st.thinkNotedAt) || 0)) {
        st.thinkNotedAt = run.at
        if (run.status === 'ok') delete st.pendingThink
        else if (run.status === 'failed') st.pendingThink = { at: run.at, why: 'failed' }
        else if (run.status === 'skipped' && hb.skipped !== undefined && PENDING_SKIPS.has(hb.skipped))
          st.pendingThink = { at: run.at, why: hb.skipped as PendingWhy }
      }
    }
    // today's counts — a terminal row, once per run id, counted on the day
    // it started; a row of a day older than the one counted changes nothing
    if (st.today && day < st.today.day) {
      this.saveState(agentId, st)
      return
    }
    const terminal = run.status !== 'running' && run.status !== 'queued' && run.status !== 'waiting_approval'
    const today = st.today && st.today.day === day ? { ...st.today, counted: [...st.today.counted] } : { day, looks: 0, thinks: 0, skipped: 0, counted: [] }
    if (terminal && !today.counted.includes(run.id)) {
      today.counted.push(run.id)
      if (run.status === 'skipped') today.skipped++
      // a look or a think counts when it had its turn (Measured's «looked
      // twice today») — a failure before any turn is none
      else if (!hadTurn(run)) {
        /* no turn */
      } else if (hb.kind === 'think') today.thinks++
      else if (hb.kind === 'round') today.rounds = (today.rounds ?? 0) + 1
      else today.looks++
    }
    st.today = today
    this.saveState(agentId, st)
  }

  /** The heartbeat's turns of a local day, by class (Measured's line apart
   *  from the max); zero for a day it holds nothing of. */
  turnsOfDay(agentId: string, day: string): { looks: number; thinks: number; rounds: number } {
    const t = this.state(agentId).today
    return t && t.day === day ? { looks: t.looks, thinks: t.thinks, rounds: t.rounds ?? 0 } : { looks: 0, thinks: 0, rounds: 0 }
  }

  /** The engine's refusal said today (its row once a day, then silence
   *  until it changes). */
  engineSaidToday(agentId: string, day: string, refusal: string): boolean {
    const e = this.state(agentId).engineSaid
    return e !== undefined && e.day === day && e.refusal === refusal
  }
  noteEngineSaid(agentId: string, day: string, refusal: string): void {
    this.saveState(agentId, { ...this.state(agentId), engineSaid: { day, refusal } })
  }

  // Rewritten whole (≤ CONSIDERED_KEEP_LINES short lines) and THROUGH the
  // seal (heartbeats/** is restore — what Silos writes here is read
  // back into prompts, so an outside edit is set aside, never served)
  append(agentId: string, c: Considered): void {
    const dir = this.dir(agentId)
    mkdirSync(dir, { recursive: true })
    const f = this.file(agentId)
    const lines = [...this.lines(agentId), c].slice(-CONSIDERED_KEEP_LINES)
    const text = `${lines.map((x) => JSON.stringify(x)).join('\n')}\n`
    if (sealHooks().write?.(f, text) === true) return
    const tmp = `${f}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, f)
  }

  private lines(agentId: string): Considered[] {
    const f = this.file(agentId)
    if (!existsSync(f)) return []
    const out: Considered[] = []
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l.trim()) continue
      try {
        const o = JSON.parse(l) as Considered
        if (o && typeof o.idea === 'string' && typeof o.at === 'string') out.push(o)
      } catch {
        /* a torn line is skipped, never a crash */
      }
    }
    return out
  }

  /** Every line, oldest first (the packet's suppression reads them all). */
  all(agentId: string): Considered[] {
    try {
      return this.lines(agentId)
    } catch {
      return []
    }
  }

  /** The lines a prompt carries: the last CONSIDERED_PROMPT_MAX within
   *  CONSIDERED_PROMPT_DAYS_MS. */
  forPrompt(agentId: string, now: number, max = CONSIDERED_PROMPT_MAX): Considered[] {
    return this.all(agentId)
      .filter((c) => now - (Date.parse(c.at) || 0) <= CONSIDERED_PROMPT_DAYS_MS)
      .slice(-max)
  }

  /** The run's readOutside onto every considered line it wrote —
   *  rewritten whole, through the seal. How many changed. */
  restampRun(agentId: string, run: string, readOutside: readonly string[]): number {
    if (readOutside.length === 0) return 0
    const lines = this.lines(agentId)
    let n = 0
    const next = lines.map((c) => {
      if (c.run !== run) return c
      const merged = [...new Set([...(c.readOutside ?? []), ...readOutside])]
      if (merged.length === (c.readOutside?.length ?? 0)) return c
      n++
      return { ...c, readOutside: merged }
    })
    if (n === 0) return 0
    const f = this.file(agentId)
    const text = `${next.map((x) => JSON.stringify(x)).join('\n')}\n`
    if (sealHooks().write?.(f, text) === true) return n
    const tmp = `${f}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, f)
    return n
  }

  /** How many lines a run recorded (the cap per heartbeat, 429 at 20). */
  countForRun(agentId: string, run: string): number {
    return this.all(agentId).filter((c) => c.run === run).length
  }
}

export function consideredLine(c: Considered): string {
  const outside = c.readOutside && c.readOutside.length > 0 ? ` (after reading outside: ${c.readOutside.join(', ')})` : ''
  return `- ${c.at.slice(0, 10)} ${c.decision}${c.until ? ` until ${c.until.slice(0, 10)}` : ''}: ${c.idea} — ${c.why}${outside}`
}
