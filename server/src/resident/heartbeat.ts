// resident/heartbeat.ts — the heartbeat when it fires (zero tokens
// until a turn is worth it; extended for a free period and the proactive
// mode): its kind (a
// look, a think, or — a proactive agent — a round), its band, the sleep,
// the engine, the room to start (a probe that queues nothing), the spend
// cap and the rounds' share of it, the account at its limit and its margin,
// the packet «since the last time» (and a round's state blocks), the prompt
// — and the re-armed think that a skip or a failure left pending.
// RunEngine calls prepare() for every fire of a heartbeat automation, with
// the plan reading it ASKED for before taking the run's lock (the
// reading may take seconds; everything after it is decided at once); what
// comes back is a skip with its exact words, a think that waits, a slot
// that passes in silence, or the turn's prompt and the kind/keys/regime its
// run records AT START. What a fire used to derive by re-reading the run
// history (the last think, the pending one, the re-arm of the day) is read
// from heartbeat-store's state.
import type { Automation, Run, RunHeartbeat } from '../automations-types.js'
import { MANUAL_CAUSE } from '../automations-types.js'
import { controlOf, heartbeatOf, localYmd, proactiveOf, type Proactive } from '../control.js'
import { composePacket, lastListedOf, type Packet } from '../heartbeat-packet.js'
import { heartbeatPrompt, roundPrompt } from '../heartbeat-prompt.js'
import { consideredLine, type HeartbeatState } from '../heartbeat-store.js'
import {
  CONSIDERED_PROMPT_MAX,
  CONSIDERED_PROMPT_ROUND,
  PACKET_FIRST_SINCE_MS,
  PACKET_PER_SOURCE_MAX,
  ROUND_SPEND_SHARE,
  ROUNDS_UNMEASURED_PER_DAY,
} from '../limits.js'
import { inWindow, intervalMinutes, nextSlot, type Period } from '../period.js'
import { ownTurnsToday } from '../own-turns.js'
import {
  headroomWords,
  limitOf,
  marginOf,
  openLines,
  quotaWords,
  shareWords,
  undoneLines,
  unmeasuredWords,
  unreadableWords,
  type MarginReading,
} from '../proactive.js'
import type { Agent } from '../types.js'
import { ResidentPart } from './core.js'
import type { TurnAccount } from './deps.js'

export const REARM_CAUSE = 'rearm'

// why a heartbeat fire took no turn — the whole set
export type HeartbeatSkip = 'sleeping' | 'busy' | 'spend' | 'share' | 'account' | 'headroom' | 'engine' | 'empty' | 'quota'
export type HeartbeatKind = 'look' | 'think' | 'round'
export type Prepared =
  // a think does not skip for want of room or outside its band: it waits —
  // queued, never lost
  | { wait: 'alive' | 'room' | 'band' }
  // the slot passes with no row (the engine's refusal already said today)
  | { pass: true }
  // `until`: the instant the reason's words stop before (ISO) — never
  // written into them; the web says it in the viewer's local time
  | { skip: HeartbeatSkip; reason: string; until?: string; heartbeat: RunHeartbeat & { skipped: HeartbeatSkip } }
  | { kind: HeartbeatKind; prompt: string; packet: Packet; heartbeat: RunHeartbeat }

/** What the fire knows of the account its turn would run on. */
export interface FireAccount extends TurnAccount {
  reading: MarginReading | null
}

const DAY_MS = 24 * 3600_000
const WEEK_MIN = 7 * 24 * 60
// «no think had its turn in the last 7 d − 1 h»: a daily slot at the
// same hour a week later still counts as a week
const THINK_GAP_MS = 7 * DAY_MS - 3600_000
const verbOf = (k: HeartbeatKind): string => (k === 'look' ? 'looks' : k === 'think' ? 'thinks' : 'does its round')

/** The first slot of the local day of `t` (the earliest slot of the
 *  day runs without a fresh reading), or null. */
export function firstSlotOfDay(p: Period, t: number): number | null {
  const d = new Date(t)
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const s = nextSlot(p, midnight - 1)
  return s !== null && localYmd(s) === localYmd(t) ? s : null
}

export class HeartbeatRuns extends ResidentPart {
  private stateOf(agentId: string): HeartbeatState {
    try {
      return this.deps.heartbeat?.store.state(agentId) ?? {}
    } catch {
      return {}
    }
  }

  /** The agent's proactive mode right now (control.ts proactiveOf, the
   *  one source) — what a fire SEALS into its run. */
  proactiveOf(agent: Agent): Proactive | null {
    let fence = false
    try {
      fence = this.deps.heartbeat?.fenceOn(agent.id) ?? false
    } catch {
      fence = false
    }
    return proactiveOf(agent, fence)
  }

  /** Think when the period is 7 days or
   *  more; or when no think had its turn in the last 7 d − 1 h AND none was
   *  tried today (one that had its turn or failed; a skipped one is no try)
   *  — a think that fails does not turn every next slot into another: one
   *  try a day, plus the re-arm. Else a round if it is proactive; else a
   *  look. «Run now» and a re-armed think are thinks. */
  kindOf(agent: Agent, now: Date, cause?: string): HeartbeatKind {
    if (cause === MANUAL_CAUSE || cause === REARM_CAUSE) return 'think'
    const p = heartbeatOf(agent).period
    if (!p || intervalMinutes(p) >= WEEK_MIN) return 'think'
    const st = this.stateOf(agent.id)
    const t = now.getTime()
    const thoughtLately = st.lastThinkTurnAt !== undefined && t - (Date.parse(st.lastThinkTurnAt) || 0) < THINK_GAP_MS
    const triedToday = st.thinkTriedDay === localYmd(t)
    if (!thoughtLately && !triedToday) return 'think'
    return this.proactiveOf(agent) ? 'round' : 'look'
  }

  /** Whether a fire of this kind would ask the account's margin:
   *  a round or a think, on a provider that does not price. */
  needsMargin(kind: HeartbeatKind, account: TurnAccount | null): boolean {
    return (kind === 'round' || kind === 'think') && account !== null && !account.priced
  }

  /** One fire, decided with zero tokens and nothing awaited in between (the
   *  numbered order below). `at`: what the run engine knows of this instant — the
   *  engine's refusal, whether the previous run still lives, a probe for
   *  room that queues nothing, the account its turn would run on with the
   *  reading asked for before the lock, and the slot this fire is for. */
  prepare(
    a: Automation,
    agent: Agent,
    now: Date,
    cause: string | undefined,
    at: { engine: string | null; alive: boolean; room: () => boolean; account?: FireAccount | null; slotAt?: number },
  ): Prepared {
    const manual = cause === MANUAL_CAUSE
    const kind = this.kindOf(agent, now, cause)
    const verb = verbOf(kind)
    // the regime SEALED at the start: a round, or the think of a
    // proactive agent, carries its tools and its day's count; a look or the
    // think of an agent that is not proactive has no tools
    const pro = kind === 'look' ? null : this.proactiveOf(agent)
    const base: RunHeartbeat = {
      kind,
      tools: pro?.tools ?? false,
      ...(pro ? { perDay: pro.perDay } : {}),
      packet: { keys: [] },
      created: [],
      proposed: [],
      considered: 0,
    }
    const skip = (s: HeartbeatSkip, reason: string, until?: string): Prepared => ({
      skip: s,
      reason,
      ...(until !== undefined ? { until } : {}),
      heartbeat: { ...base, skipped: s },
    })
    const hb = heartbeatOf(agent)
    const t = now.getTime()
    // its band: never outside it, a re-armed think included; «Run
    // now» is the owner's gesture and ignores it
    if (!manual && hb.period && !inWindow(hb.period, t)) return kind === 'think' ? { wait: 'band' } : { pass: true }
    // 1 — asleep (Run now skips the sleep)
    if (!manual && hb.sleepUntil && Date.parse(hb.sleepUntil) > t) {
      return skip('sleeping', `sleeping — wake it on ${agent.name}'s page, or it wakes on its own at`, new Date(Date.parse(hb.sleepUntil)).toISOString())
    }
    // the engine refused: its row once a local day, then silence while it
    // lasts — a think so skipped is re-armed, so a think writes its
    // row until one is pending
    if (at.engine !== null) {
      if (manual) return { wait: 'alive' }
      const day = localYmd(t)
      const store = this.deps.heartbeat?.store
      const st = this.stateOf(agent.id)
      if (store?.engineSaidToday(agent.id, day, at.engine) && (kind !== 'think' || st.pendingThink !== undefined)) return { pass: true }
      try {
        store?.noteEngineSaid(agent.id, day, at.engine)
      } catch {
        /* said on the row regardless */
      }
      return skip('engine', `${agent.name}'s engine can't run: ${at.engine}`)
    }
    // 2 — no room to start: a look or a round skips (its next slot comes on
    // its own); a think waits — queued, never lost
    // its OWN previous run still alive at its next slot: its runs take
    // longer than its period, and its row says so
    if (at.alive) return kind === 'think' ? { wait: 'alive' } : skip('busy', 'the previous one is still running — its runs take longer than its period')
    if (!at.room()) return kind === 'think' ? { wait: 'room' } : skip('busy', 'the fleet is busy — it goes at its next slot')
    // 3 — the spend cap (the day's ceiling is never asked of a heartbeat:
    // its period is its ceiling)
    const today = ownTurnsToday({ automations: this.deps.store, ...(this.deps.wakesToday ? { wakesToday: this.deps.wakesToday } : {}) }, agent, t)
    if (!today.exempt && today.costUsd >= today.spendCap) return skip('spend', `${agent.name}'s daily spend cap is reached — it ${verb} tomorrow instead`)
    // 4 — the rounds' share of the spend (a round only): past half of the
    // day's cap, rounds wait and its tasks go on; «Let it continue today»
    // lifts it too
    if (kind === 'round' && !manual && !today.exempt && today.costUsd >= today.spendCap * (ROUND_SPEND_SHARE / 100))
      return skip('share', shareWords(agent.name))
    // 5 — the account at its limit, on the account the turn will run on (a
    // window at 100 % with no reset said is at its limit too: it waits for
    // its next slot)
    const account = at.account ?? null
    const limit = this.limitNow(account, agent, t)
    if (limit) {
      return limit.resetsAt !== null
        ? skip('account', `${agent.name}'s account is at its usage limit — it ${verb} after`, limit.resetsAt)
        : skip('account', `${agent.name}'s account is at its usage limit — it ${verb} at its next slot`)
    }
    // 6 — the account's margin (a round or a think, a provider that does
    // not price): THE brake of a subscription — it fails CLOSED
    if (this.needsMargin(kind, account)) {
      if (account!.readable) {
        const m = marginOf(account!.reading, t)
        if (m.over) return skip('headroom', headroomWords(agent.name, m.over))
        if (!m.fresh && !manual) {
          // no fresh reading: the earliest slot of the local day runs all
          // the same (only a turn refreshes an expired token); «Run now» too.
          // Only a slot OF TODAY: one carried over from a previous day is
          // no earliest slot of this one
          const first = hb.period ? firstSlotOfDay(hb.period, t) : null
          const earliest = first !== null && at.slotAt !== undefined && localYmd(at.slotAt) === localYmd(t) && at.slotAt <= first && cause === undefined
          if (!earliest) return skip('headroom', unreadableWords(agent.name))
        }
      } else if (!manual) {
        // no price and no reading: the brake is a number
        const beats = this.deps.heartbeat?.store.turnsOfDay(agent.id, localYmd(t)) ?? { looks: 0, thinks: 0, rounds: 0 }
        const n = beats.rounds + beats.thinks
        if (n >= ROUNDS_UNMEASURED_PER_DAY) return skip('headroom', unmeasuredWords(agent.name, n))
      }
    }
    // the packet: a delta since the last heartbeat that had a turn
    const st = this.stateOf(agent.id)
    const since = st.lastTurnAt !== undefined ? Date.parse(st.lastTurnAt) || t - PACKET_FIRST_SINCE_MS : t - PACKET_FIRST_SINCE_MS
    const facts = this.deps.heartbeat?.facts(agent, since, t)
    const considered = this.deps.heartbeat?.store.all(agent.id) ?? []
    let runs: Run[] = []
    try {
      runs = this.deps.store.listRuns(a.id)
    } catch {
      runs = []
    }
    const packet = composePacket({
      agentId: agent.id,
      since,
      now: t,
      messages: facts?.messages ?? [],
      failedRuns: facts?.failedRuns ?? [],
      yours: facts?.yours ?? [],
      waits: facts?.waits ?? [],
      routed: facts?.routed ?? [],
      decided: facts?.decided ?? [],
      owner: facts?.owner ?? [],
      asks: facts?.asks ?? [],
      lastListed: lastListedOf(runs),
      considered,
    })
    const sinceWords = new Date(since).toISOString().replace('T', ' ').slice(0, 16)
    // 7 — a look with nothing new costs nothing (R5); a round skips only
    // with its day's count spent and nothing new; a think always runs
    if (kind === 'look' && packet.empty && !manual) return skip('empty', `nothing happened since ${sinceWords}`)
    const mission = pro ? (this.deps.heartbeat?.mission?.(agent, t) ?? { open: [], undone: [], madeToday: 0 }) : null
    if (kind === 'round' && pro && mission && packet.empty && mission.madeToday >= pro.perDay) return skip('quota', quotaWords(mission.madeToday))
    const blocks = this.deps.heartbeat?.blocks(agent) ?? { web: true, connectors: true, subagents: true }
    let prompt: string
    if (pro && mission) {
      // 8 — a round (or a proactive think): its prompt and its state blocks;
      // the blocks are no signal — never in packet.keys
      prompt = roundPrompt({
        kind: kind === 'think' ? 'think' : 'round',
        mission: agent.mission!,
        tools: pro.tools,
        perDay: pro.perDay,
        left: pro.perDay - mission.madeToday,
        blocks,
        since: sinceWords,
        packetLines: packet.lines,
        openLines: openLines(mission.open, t, PACKET_PER_SOURCE_MAX),
        undoneLines: undoneLines(mission.undone, PACKET_PER_SOURCE_MAX),
        consideredLines: (this.deps.heartbeat?.store.forPrompt(agent.id, t, CONSIDERED_PROMPT_ROUND) ?? []).map(consideredLine),
      })
    } else {
      prompt = heartbeatPrompt({
        // RunEngine dispatches a heartbeat only for an agent On its own, and
        // the derived control needs a mission (control.ts controlOf)
        kind: kind === 'look' ? 'look' : 'think',
        mission: agent.mission!,
        blocks,
        since: sinceWords,
        packetLines: packet.lines,
        consideredLines: (this.deps.heartbeat?.store.forPrompt(agent.id, t, CONSIDERED_PROMPT_MAX) ?? []).map(consideredLine),
      })
    }
    return { kind, prompt, packet, heartbeat: { ...base, packet: { keys: packet.keys } } }
  }

  /** A think that the spend cap, the account, its margin or the
   *  engine skipped, or that FAILED, is not lost: the first tick after local midnight (or the account's reset),
   *  inside its band and with its engine able to run, launches it once, if
   *  nothing thought since. The account is the one its turn will run on (the
   *  same resolution ChatService makes). Read from the heartbeat's
   *  state (a restart reads it back, never doubles it); at most one
   *  launch a day. A skipped ROUND is never re-armed: the next one
   *  comes on its own. */
  rearm(now: Date, launch: (a: Automation) => void): void {
    const t = now.getTime()
    const day = localYmd(t)
    for (const a of this.deps.store.list()) {
      if (a.origin !== 'heartbeat' || a.paused) continue
      const agent = this.deps.registry.get(a.agentId)
      if (!agent) continue
      if (controlOf(agent, this.deps.heartbeat?.fenceOn(agent.id) ?? false) !== 'own') continue
      const st = this.stateOf(agent.id)
      const pending = st.pendingThink
      if (!pending) continue
      if (localYmd(Date.parse(pending.at) || 0) === day && pending.why !== 'account') continue // after midnight
      if (pending.why === 'account' && this.accountLimit(agent, a, t)) continue // still at its limit
      if (st.rearmDay === day) continue // one re-armed launch a day
      const period = heartbeatOf(agent).period
      if (period && !inWindow(period, t)) continue // it waits for its band
      let refused: string | null = null
      try {
        refused = this.deps.engineRefusal?.(agent.id) ?? null
      } catch {
        refused = null
      }
      if (refused !== null) continue // it waits for its engine
      launch(a)
    }
  }

  /** The account a heartbeat's turn will run on, or null when the
   *  wiring cannot say (tests): its runsOn, the switch, the fallback. */
  accountOf(agent: Agent, a: Automation): TurnAccount | null {
    try {
      return this.deps.heartbeat?.account?.(agent, a.runsOn?.provider) ?? null
    } catch {
      return null
    }
  }

  /** The account its turn will run on at its limit, from the cached
   *  reading (never a fetch) — or, unwired, the agent's own. */
  private accountLimit(agent: Agent, a: Automation, t: number): { resetsAt: string | null } | null {
    const acct = this.accountOf(agent, a)
    let reading: MarginReading | null = null
    if (acct?.readable) {
      try {
        reading = this.deps.heartbeat?.usage?.peek(acct.id) ?? null
      } catch {
        reading = null
      }
    }
    return this.limitNow(acct ? { ...acct, reading } : null, agent, t)
  }

  /** At its limit now (step 5): the reading of the account the turn runs on
   *  (an unreadable one cannot say), or — unwired — the agent's own reset. */
  private limitNow(account: FireAccount | null, agent: Agent, t: number): { resetsAt: string | null } | null {
    if (account) return account.readable ? limitOf(account.reading, t) : null
    let reset: string | null = null
    try {
      reset = this.deps.accountResetOf?.(agent.id) ?? null
    } catch {
      reset = null
    }
    return reset !== null && Date.parse(reset) > t ? { resetsAt: reset } : null
  }
}
