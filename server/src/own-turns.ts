// own-turns.ts — the ONE count behind the ceiling (R7) and the spend cap
// of an agent's local day: what it started ON ITS OWN today.
//
//   ceiling  charged task wakes that were not an owner's gesture + runs of
//            its own recurring work WITHOUT acceptedFrom (an accepted one
//            runs at the rhythm the owner approved — outside the ceiling,
//            per the accept). Heartbeat turns are OUT, «Run now» included: the owner chose their rhythm — its
//            period is its ceiling.
//   spend    the costUsd of the same wakes + every heartbeat turn («Run now»
//            included) + every run of
//            its own recurring work (acceptedFrom INCLUDED — the accept
//            approved its rhythm, not its spend: S15); the owner's
//            automations stay OUT of the brake (I2). Only turns whose
//            provider PRICES count: a turn recorded `priced: false`
//            ran on a plan — a Claude account, an engine's own login — and
//            its engine's notional cost is no money the cap brakes; such a
//            turn is not «unpriced» either (that row names a model without a
//            price on a provider that prices, G5). A turn with no record of
//            its provider counts — the brake errs on the side of braking.
//
// Both are checked when a turn STARTS, never mid-turn; «Let it
// continue today» (ownExemptDay) lifts both for today (S16).
//
// The two counts come back broken down: the row
// at the max says WHY — «7 task starts · 3 runs of its own automations» and,
// at the spend cap, «$3.10 task starts · $1.90 heartbeat · $0.40 its
// automations». ONE source per row: the
// head and its breakdown are the same records counted here — never Usage's
// transcript reading, which dates and prices a turn its own way — so the
// breakdown always adds up to the head. «See today ›» opens Usage for the
// tokens.
import type { AutomationsStore } from './automations-store.js'
import { countsAgainstBudget } from './automations-store.js'
import type { Automation, Run } from './automations-types.js'
import { exemptToday, localYmd, ownTurnsPerDayOf, spendPerDayOf } from './control.js'
import { heartbeatAutomationId } from './heartbeat.js'
import type { Agent } from './types.js'

export interface WakesToday {
  charged: number
  costUsd: number
  unpriced: number
  unpricedModels?: string[]
  /** the wake turns counted */ turnIds?: string[]
}

export interface OwnTurnsDeps {
  automations: Pick<AutomationsStore, 'list' | 'listRuns' | 'get'>
  // Task mode's wakes of the agent's local day that were NOT an owner's
  // gesture and were charged (they started), with what they cost
  wakesToday?: (agentId: string, day: string) => WakesToday
  // whether the agent's unattended turns run on a provider that prices NOW
  // (platform-settings.ts unattendedPrices) — the spend line's words: the
  // cap «applies when its provider prices turns». Absent: true.
  pricesNow?: (agentId: string) => boolean
}

/** What the ceiling counted, by kind: task starts, runs of its own
 *  automations (an accepted one is outside it). `used` = wakes + self. */
export interface StartsBy {
  wakes: number
  self: number
}
/** What the spend summed, by kind: task starts, heartbeat («Run now»
 *  included), its own automations (accepted ones included, S15). */
export interface SpentBy {
  wakes: number
  heartbeat: number
  self: number
}
export interface OwnTurnsToday {
  used: number
  costUsd: number
  unpriced: number
  unpricedModels?: string[]
  ceiling: number
  spendCap: number
  exempt: boolean
  priced?: boolean
  starts?: StartsBy
  spent?: SpentBy
}

// a run that took a turn (its status says it worked or is working), whatever
// its cause — a gesture's run costs like any other
const tookATurn = (r: Run): boolean => countsAgainstBudget({ ...r, cause: undefined })

function runsOfDay(store: OwnTurnsDeps['automations'], a: Automation, day: string): Run[] {
  return store.listRuns(a.id).filter((r) => localYmd(Date.parse(r.at) || 0) === day && tookATurn(r))
}

export function ownTurnsToday(
  d: OwnTurnsDeps,
  agent: Pick<Agent, 'id' | 'ownTurnsPerDay' | 'unattendedSpendPerDay' | 'ownExemptDay'>,
  now: number,
): OwnTurnsToday {
  const day = localYmd(now)
  let used = 0
  let cost = 0
  let unpriced = 0
  const models = new Set<string>()
  const starts: StartsBy = { wakes: 0, self: 0 }
  const spent: SpentBy = { wakes: 0, heartbeat: 0, self: 0 }
  const add = (kind: keyof SpentBy, c: number | null | undefined, finished: boolean, model?: string, priced?: boolean): void => {
    if (priced === false) return
    if (typeof c === 'number' && Number.isFinite(c)) {
      cost += c
      spent[kind] += c
    } else if (finished) {
      unpriced++
      if (model) models.add(model)
    }
  }
  const w = d.wakesToday?.(agent.id, day)
  if (w) {
    used += w.charged
    starts.wakes += w.charged
    cost += w.costUsd
    spent.wakes += w.costUsd
    unpriced += w.unpriced
    for (const m of w.unpricedModels ?? []) models.add(m)
  }
  for (const a of d.automations.list()) {
    if (a.agentId !== agent.id) continue
    const isBeat = a.id === heartbeatAutomationId(agent.id)
    const self = a.origin === 'self'
    if (!isBeat && !self) continue
    for (const r of runsOfDay(d.automations, a, day)) {
      // the ceiling: its own runs without acceptedFrom — never a heartbeat
      if (!isBeat && !a.acceptedFrom) {
        used++
        starts.self++
      }
      add(isBeat ? 'heartbeat' : 'self', r.costUsd, r.status !== 'running' && r.status !== 'queued' && r.status !== 'waiting_approval', r.model, r.priced)
    }
  }
  // the head and its breakdown, one source: used = starts.wakes + starts.self,
  // costUsd = spent.wakes + spent.heartbeat + spent.self
  return {
    used,
    costUsd: cost,
    unpriced,
    unpricedModels: [...models].sort(),
    ceiling: ownTurnsPerDayOf(agent),
    spendCap: spendPerDayOf(agent),
    exempt: exemptToday(agent, now),
    priced: d.pricesNow?.(agent.id) ?? true,
    starts,
    spent,
  }
}

/** What holds a turn on its own from starting now, or null: the day's
 *  ceiling, then the spend cap — neither under «Let it continue today».
 *  `outsideCeiling`: a turn the ceiling does not count — an accepted own
 *  run (S15) and every heartbeat turn, «Run now» included
 *  — the spend cap alone holds it. */
export function ownCapHold(t: OwnTurnsToday, o: { outsideCeiling?: boolean } = {}): 'ceiling' | 'spend' | null {
  if (t.exempt) return null
  if (!o.outsideCeiling && t.used >= t.ceiling) return 'ceiling'
  if (t.costUsd >= t.spendCap) return 'spend'
  return null
}

/** An agent held at its day's max or its spend cap (TaskModeEngine.ceilingHits)
 *  — what the Needs you row is made of, its breakdown included. */
export interface OwnCapHit {
  agent: string
  used: number
  perDay: number
  waiting: number
  until: string
  day: string
  cap: 'ceiling' | 'spend'
  spentUsd: number
  starts?: StartsBy
  spent?: SpentBy
}
