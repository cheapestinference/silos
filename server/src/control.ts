// control.ts — the ONE setting that decides whether something happens
// without the owner: `control` —
// «Only when told» (told) · «On its own» (own) — and, with own, the period
// its heartbeat beats at (free — `period`, null =
// never). One source for: the shapes and their defaults, the exact 400/409
// words of PATCH /api/agents/:id, and the DERIVED control every reader asks
// (controlOf): decision 2 says an agent without its territory is never on
// its own — agents.json keeps `own`, the system treats it as `told` while
// the fence is off (G5-r7), and the same degradation holds for an `own`
// without a mission (S1-r4).
import { createHash } from 'node:crypto'
import {
  HEARTBEAT_PERIOD_MIN,
  PROACTIVE_PER_DAY,
  PROACTIVE_PER_DAY_MAX,
  PROACTIVE_PER_DAY_MIN,
  OWN_TURNS_PER_DAY,
  OWN_TURNS_PER_DAY_MAX,
  OWN_TURNS_PER_DAY_MIN,
  UNATTENDED_SPEND_MAX,
  UNATTENDED_SPEND_MIN,
  UNATTENDED_SPEND_USD_DAY,
} from './limits.js'
import { PeriodError, intervalMinutes, parsePeriod, periodDay, stampPeriod, storedPeriod, type Period, type PeriodRules } from './period.js'

export type Control = 'told' | 'own'
export interface Heartbeat {
  period: Period | null // null = never
  sleepUntil?: string
  sleepWhy?: string
}
// the capability of creating work of its own, cut
export interface Cut {
  at: string
  why: string
  run?: string
}
/** The proactive mode: «On its own» plus a setting —
 *  never a third control (R2). Present ⇒ chosen by the owner. */
export interface Proactive {
  perDay: number
  tools: boolean
}
/** The three positions the screen draws — derived, never stored. */
export type Position = 'told' | 'own' | 'proactive'

export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const YMD = /^\d{4}-\d{2}-\d{2}$/

export class ControlError extends Error {
  constructor(
    public status: 400 | 409,
    message: string,
  ) {
    super(message)
  }
}

/** The staggered minute of an agent's default heartbeat: a
 *  fleet never beats in chorus — the same id always lands on the same
 *  minute, so the row can say it («Every Monday 09:07»). */
export function staggeredMinute(id: string): number {
  return createHash('sha256').update(id).digest().readUInt32BE(0) % 60
}

/** The default period: every Monday at 09:MM, the
 *  agent's staggered minute. */
export function defaultPeriod(id: string): Period {
  return { every: 1, unit: 'weeks', day: 1, at: `09:${String(staggeredMinute(id)).padStart(2, '0')}` }
}

export function defaultHeartbeat(id: string): Heartbeat {
  return { period: defaultPeriod(id) }
}

/** A proactive agent's rounds when the owner asked for Proactive at birth:
 *  every 3 hours between 08:00 and 20:00 (the «Make X proactive» sheet's
 *  own fallback, web/src/lib/proactive.ts SHEET_FALLBACK), with Silos'
 *  default limits — PROACTIVE_PER_DAY tasks a day, its tools on. Changed
 *  on its page. Stamped like any PATCH's period: `since` today, `at` the
 *  agent's staggered minute from the band's start. */
export const PROACTIVE_BIRTH_PERIOD: Period = { every: 3, unit: 'hours', between: { from: '08:00', to: '20:00' } }
export function proactiveAtBirth(id: string, now: number): { heartbeat: Heartbeat; proactive: Proactive } {
  return {
    heartbeat: { period: stampPeriod(PROACTIVE_BIRTH_PERIOD, { prior: null, today: periodDay(now), staggerMinute: staggeredMinute(id) }) },
    proactive: { perDay: PROACTIVE_PER_DAY, tools: true },
  }
}

const HEARTBEAT_KEYS: ReadonlySet<string> = new Set(['period', 'sleepUntil', 'sleepWhy'])

/** The heartbeat as stored. The field absent, or an
 *  object that does not name `period`, is the default (weekly); a period it
 *  names is read back valid, or null. Any shape it does not recognise — the
 *  old `{ rhythm, day, at }` included — is `period: null`, on the SAFE side:
 *  an agent never starts beating from data Silos does not understand (no
 *  compatibility: the owner picks it again on the page). */
export function heartbeatOf(a: { id: string; heartbeat?: unknown }): Heartbeat {
  const h = a.heartbeat
  if (h === undefined) return defaultHeartbeat(a.id)
  if (!h || typeof h !== 'object' || Array.isArray(h)) return { period: null }
  const o = h as Record<string, unknown>
  const known = Object.keys(o).every((k) => HEARTBEAT_KEYS.has(k))
  const out: Heartbeat = {
    period: !known ? null : !('period' in o) ? defaultPeriod(a.id) : o.period === null ? null : storedPeriod(o.period, HEARTBEAT_PERIOD_MIN),
  }
  if (typeof o.sleepUntil === 'string' && !Number.isNaN(Date.parse(o.sleepUntil))) out.sleepUntil = o.sleepUntil
  if (typeof o.sleepWhy === 'string' && o.sleepWhy !== '') out.sleepWhy = o.sleepWhy
  return out
}

/** The control as stored: anything but 'own' is 'told' (no value ⇒
 *  'told'). */
export function storedControl(a: { control?: unknown }): Control {
  return a.control === 'own' ? 'own' : 'told'
}

/** The EFFECTIVE control — the one source every reader asks (the
 *  heartbeat's reconcile, Task mode's bound set, assign, the queue's
 *  re-check at dequeue). `own` holds only with the territory on, a mission
 *  and in play; otherwise it operates as `told`, the stored field intact
 *  (decision 2, G5-r7, S1-r4): turning the fence back on brings the
 *  heartbeat and the `own` events back with no gesture. */
export function controlOf(a: { control?: unknown; mission?: unknown; archived?: boolean; folder?: string | null }, fenceOn: boolean): Control {
  if (storedControl(a) !== 'own') return 'told'
  if (!fenceOn || !a.mission || a.archived || !a.folder) return 'told'
  return 'own'
}

/** The proactive setting as stored, valid, or null (a shape Silos does not
 *  recognise is no proactive — the safe side, like heartbeatOf). */
export function storedProactive(a: { proactive?: unknown }): Proactive | null {
  const p = a.proactive
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const o = p as Record<string, unknown>
  if (Object.keys(o).some((k) => k !== 'perDay' && k !== 'tools')) return null
  const perDay = o.perDay
  if (typeof perDay !== 'number' || !Number.isInteger(perDay) || perDay < PROACTIVE_PER_DAY_MIN || perDay > PROACTIVE_PER_DAY_MAX) return null
  if (typeof o.tools !== 'boolean') return null
  return { perDay, tools: o.tools }
}

/** The EFFECTIVE proactive mode — the ONE source:
 *  `controlOf(...) === 'own'`, a valid `proactive`, a period that is not
 *  never, and no cut (a cut agent does no rounds: its heartbeat goes back to
 *  look/think). Null: it is not proactive right now. */
export function proactiveOf(
  a: { id: string; control?: unknown; mission?: unknown; archived?: boolean; folder?: string | null; proactive?: unknown; heartbeat?: unknown; cut?: unknown },
  fenceOn: boolean,
): Proactive | null {
  if (controlOf(a, fenceOn) !== 'own') return null
  const p = storedProactive(a)
  if (!p) return null
  if (heartbeatOf(a).period === null) return null
  if (a.cut) return null
  return p
}

/** The position the control's three-way switch shows: derived. */
export function positionOf(a: Parameters<typeof proactiveOf>[0], fenceOn: boolean): Position {
  if (controlOf(a, fenceOn) !== 'own') return 'told'
  return proactiveOf(a, fenceOn) ? 'proactive' : 'own'
}

/** Why a stored proactive does no rounds right now (the page says it),
 *  or null: 'cut' (Allow again), 'told' (its control operates as told). */
export function proactiveOffWhy(a: Parameters<typeof proactiveOf>[0], fenceOn: boolean): 'cut' | 'told' | 'never' | null {
  if (!storedProactive(a)) return null
  if (controlOf(a, fenceOn) !== 'own') return 'told'
  if (heartbeatOf(a).period === null) return 'never'
  if (a.cut) return 'cut'
  return null
}

/** Why a stored `own` operates as `told` right now, or null (it is own, or
 *  it is told by choice) — what the degradation row names. */
export function degradedWhy(
  a: { control?: unknown; mission?: unknown; archived?: boolean; folder?: string | null },
  fenceOn: boolean,
): 'territory' | 'mission' | null {
  if (storedControl(a) !== 'own' || a.archived || !a.folder) return null
  if (!fenceOn) return 'territory'
  if (!a.mission) return 'mission'
  return null
}

/** The agent's ceiling a day (R7): its ownTurnsPerDay in range, else 10. */
export function ownTurnsPerDayOf(a: { ownTurnsPerDay?: unknown }): number {
  const c = a.ownTurnsPerDay
  return typeof c === 'number' && Number.isInteger(c) && c >= OWN_TURNS_PER_DAY_MIN && c <= OWN_TURNS_PER_DAY_MAX ? c : OWN_TURNS_PER_DAY
}

/** The agent's spend cap a day in USD (B1): its unattendedSpendPerDay in range, else 5. */
export function spendPerDayOf(a: { unattendedSpendPerDay?: unknown }): number {
  const c = a.unattendedSpendPerDay
  return typeof c === 'number' && Number.isFinite(c) && c >= UNATTENDED_SPEND_MIN && c <= UNATTENDED_SPEND_MAX ? c : UNATTENDED_SPEND_USD_DAY
}

/** The local day 'YYYY-MM-DD' of an instant (the ceiling's midnight, the
 *  exemption's day): the server machine's zone. */
export function localYmd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** «Let it continue today» holds today only: the exemption is true
 *  when ownExemptDay is the local day of `now`. */
export function exemptToday(a: { ownExemptDay?: unknown }, now: number): boolean {
  return typeof a.ownExemptDay === 'string' && a.ownExemptDay === localYmd(now)
}

// ── PATCH /api/agents/:id — the control fields ──

export const CONTROL_ERROR = 'control must be told or own'
// a heartbeat's period: the 400s with the
// `heartbeat.period.` prefix and the floor of five minutes
export const HEARTBEAT_PERIOD_RULES: PeriodRules = {
  prefix: 'heartbeat.period.',
  minMinutes: HEARTBEAT_PERIOD_MIN,
  floorWords: 'a heartbeat runs every 5 minutes at most',
}
// The body is `heartbeat: { period }`; a body of another shape gets these
// words
export const HEARTBEAT_SHAPE_ERROR = 'heartbeat takes { period } — a period, or null for never'
export const OWN_TURNS_ERROR = `ownTurnsPerDay must be a whole number from ${OWN_TURNS_PER_DAY_MIN} to ${OWN_TURNS_PER_DAY_MAX} — or null for the default (${OWN_TURNS_PER_DAY})`
export const SPEND_ERROR = `unattendedSpendPerDay must be a number from ${UNATTENDED_SPEND_MIN} to ${UNATTENDED_SPEND_MAX} — or null for the default (${UNATTENDED_SPEND_USD_DAY})`
export const EXEMPT_ERROR = 'ownExemptDay must be a "YYYY-MM-DD" date — or null to clear it'
export const CUT_ERROR = 'cut only takes null, to lift it ("Allow again") — Silos writes a cut itself'
// proactive's 400s and its 409s on the state the PATCH leaves
export const PROACTIVE_PER_DAY_ERROR = `proactive.perDay must be a whole number from ${PROACTIVE_PER_DAY_MIN} to ${PROACTIVE_PER_DAY_MAX} — or leave it out for the default (${PROACTIVE_PER_DAY})`
export const PROACTIVE_TOOLS_ERROR = 'proactive.tools must be true or false'
// The body is `{ perDay?, tools? } | null`; a body of another shape gets the
// nearest words
export const PROACTIVE_SHAPE_ERROR = 'proactive takes { perDay?, tools? } — or null to turn it off'
export const proactiveNeedsOwn = (name: string): string => `Proactive is On its own and more — set ${name} On its own first`
export const proactiveNeedsPeriod = (name: string): string => `${name} does no rounds while its heartbeat is set to never — pick how often first`
export const proactiveNeedsShortPeriod = (name: string): string => `${name} does rounds more often than weekly — pick how often`
// the row «Create recurring work of its own» — the ONE source of the 403 a bearer
// hears creating recurring work of its own outside its weekly think: the text forks by control, never by route
export const SELF_RECURRING_TOLD = "You are Only when told: scheduled work is the owner's to create — propose it (POST /api/proposals)"
export const SELF_RECURRING_NEVER = 'your own scheduled work is decided in your weekly think (you have none: your control is On its own · never) — propose it'
export const SELF_RECURRING_OUTSIDE_THINK =
  'scheduled work of your own is decided in your weekly think — propose it (POST /api/proposals), the owner accepts in one touch'
/** The 403 of a bearer's create of recurring work outside its think turn,
 *  by its EFFECTIVE control (controlOf) and its period — null is never. */
export function selfRecurringRefusal(control: Control, period: Period | null): string {
  if (control !== 'own') return SELF_RECURRING_TOLD
  return period === null ? SELF_RECURRING_NEVER : SELF_RECURRING_OUTSIDE_THINK
}

export const noMissionForOwn = (name: string): string => `Give ${name} a mission first — on its own, it needs to know what it answers for`
export const noFenceForOwn = (name: string): string => `${name}'s territory is off. Turn it on, then it can go on its own ›`
export const ownNeedsMission = (name: string): string => `${name} is On its own and needs its mission — set it Only when told first, or write another mission`

/** The control fields of a PATCH body, validated (400s), with `null` meaning
 *  «back to the default / clear». Fields absent are left alone. */
export interface ControlPatch {
  control?: Control
  heartbeat?: Pick<Heartbeat, 'period'>
  ownTurnsPerDay?: number | null
  unattendedSpendPerDay?: number | null
  ownExemptDay?: string | null
  cut?: null
  // null turns it off; `control: 'told'` clears it in
  // the same write (the route)
  proactive?: Proactive | null
}

/** `stamp`: the agent the PATCH writes — its period's `since` and staggered
 *  minute are the server's; without it the period is
 *  only validated. Its stored `proactive`: a partial `proactive` merges with
 *  it (a field the PATCH does not name keeps what is stored; only what is
 *  stored nowhere takes its default). */
export function parseControlPatch(body: unknown, stamp?: { agentId: string; prior: Period | null; now: number; proactive?: Proactive | null }): ControlPatch {
  const out: ControlPatch = {}
  if (!body || typeof body !== 'object') return out
  const b = body as Record<string, unknown>
  if (b.control !== undefined) {
    if (b.control !== 'told' && b.control !== 'own') throw new ControlError(400, CONTROL_ERROR)
    out.control = b.control
  }
  if (b.heartbeat !== undefined) {
    if (!b.heartbeat || typeof b.heartbeat !== 'object' || Array.isArray(b.heartbeat)) throw new ControlError(400, HEARTBEAT_SHAPE_ERROR)
    const h = b.heartbeat as Record<string, unknown>
    if (!('period' in h) || Object.keys(h).some((k) => k !== 'period')) throw new ControlError(400, HEARTBEAT_SHAPE_ERROR)
    try {
      if (h.period === null) out.heartbeat = { period: null }
      else {
        const p = parsePeriod(h.period, HEARTBEAT_PERIOD_RULES)
        out.heartbeat = {
          period: stamp ? stampPeriod(p, { prior: stamp.prior, today: periodDay(stamp.now), staggerMinute: staggeredMinute(stamp.agentId) }) : p,
        }
      }
    } catch (err) {
      if (err instanceof PeriodError) throw new ControlError(400, err.message)
      throw err
    }
  }
  if (b.ownTurnsPerDay !== undefined) {
    const v = b.ownTurnsPerDay
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < OWN_TURNS_PER_DAY_MIN || v > OWN_TURNS_PER_DAY_MAX))
      throw new ControlError(400, OWN_TURNS_ERROR)
    out.ownTurnsPerDay = v as number | null
  }
  if (b.unattendedSpendPerDay !== undefined) {
    const v = b.unattendedSpendPerDay
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < UNATTENDED_SPEND_MIN || v > UNATTENDED_SPEND_MAX))
      throw new ControlError(400, SPEND_ERROR)
    out.unattendedSpendPerDay = v as number | null
  }
  if (b.ownExemptDay !== undefined) {
    const v = b.ownExemptDay
    if (v !== null && (typeof v !== 'string' || !YMD.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00`)))) throw new ControlError(400, EXEMPT_ERROR)
    out.ownExemptDay = v as string | null
  }
  if (b.cut !== undefined) {
    if (b.cut !== null) throw new ControlError(400, CUT_ERROR)
    out.cut = null
  }
  if (b.proactive !== undefined) {
    const v = b.proactive
    if (v === null) out.proactive = null
    else {
      if (typeof v !== 'object' || Array.isArray(v)) throw new ControlError(400, PROACTIVE_SHAPE_ERROR)
      const o = v as Record<string, unknown>
      if (Object.keys(o).some((k) => k !== 'perDay' && k !== 'tools')) throw new ControlError(400, PROACTIVE_SHAPE_ERROR)
      if (
        o.perDay !== undefined &&
        (typeof o.perDay !== 'number' || !Number.isInteger(o.perDay) || o.perDay < PROACTIVE_PER_DAY_MIN || o.perDay > PROACTIVE_PER_DAY_MAX)
      )
        throw new ControlError(400, PROACTIVE_PER_DAY_ERROR)
      if (o.tools !== undefined && typeof o.tools !== 'boolean') throw new ControlError(400, PROACTIVE_TOOLS_ERROR)
      // merged with what is stored; its defaults only for what is
      // stored nowhere: 5 a day, with its tools
      const stored = stamp?.proactive ?? null
      out.proactive = {
        perDay: (o.perDay as number | undefined) ?? stored?.perDay ?? PROACTIVE_PER_DAY,
        tools: (o.tools as boolean | undefined) ?? stored?.tools ?? true,
      }
    }
  }
  return out
}

/** The 409s of proactive on the state the PATCH would leave —
 *  judged only when proactive is present after it:
 *  own (stored control), a period, a period of less than 7 days. */
export function checkProactive(o: { name: string; controlAfter: Control; proactiveAfter: boolean; periodAfter: Period | null }): void {
  if (!o.proactiveAfter) return
  if (o.controlAfter !== 'own') throw new ControlError(409, proactiveNeedsOwn(o.name))
  if (o.periodAfter === null) throw new ControlError(409, proactiveNeedsPeriod(o.name))
  if (intervalMinutes(o.periodAfter) >= 7 * 24 * 60) throw new ControlError(409, proactiveNeedsShortPeriod(o.name))
}

/** Decision 2 and the mission rule, on the state the PATCH would leave
 *  («Switch to On its own»): own needs a mission and the territory;
 *  clearing the mission of an own agent is refused. 409s. */
// Only what the PATCH itself asks is judged: a rename of an `own` agent whose
// fence is off right now is no transition (it operates as told, derived).
export function checkControlTransition(o: {
  name: string
  storedBefore: Control
  askedOwn: boolean
  controlAfter: Control
  missionAfter: boolean
  missionCleared: boolean
  fenceOn: boolean
}): void {
  if (o.controlAfter !== 'own') return
  if (o.missionCleared && o.storedBefore === 'own' && !o.askedOwn) throw new ControlError(409, ownNeedsMission(o.name))
  if (!o.askedOwn && !o.missionCleared) return
  if (!o.missionAfter) throw new ControlError(409, o.askedOwn && o.storedBefore !== 'own' ? noMissionForOwn(o.name) : ownNeedsMission(o.name))
  if (o.askedOwn && !o.fenceOn) throw new ControlError(409, noFenceForOwn(o.name))
}
