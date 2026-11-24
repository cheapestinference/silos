// cron.ts — resident: minimal 5-field cron parser (minute hour dom month
// dow), no new dependency. Standard cron semantics: lists ("1,15"), ranges
// ("1-5"), steps ("*/n" and "a-b/n"), "*" = the whole range; if DOM and DOW
// are BOTH restricted (≠ '*'), a day matches if either one matches (OR) — if
// only one is restricted, that one rules; if neither, every day matches.
//
// nextRun(expr, after) does NOT brute-force minute by minute: it jumps
// field by field (month → day → hour → minute), so an expression that only
// matches years apart doesn't hang the process searching minute by minute.

export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const RANGES: Record<'minute' | 'hour' | 'dom' | 'month' | 'dow', [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6], // 0 = Sunday
}

function parseField(raw: string, kind: keyof typeof RANGES): { values: Set<number>; restricted: boolean } {
  const [min, max] = RANGES[kind]
  const restricted = raw.trim() !== '*'
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    const p = part.trim()
    if (p === '') throw new Error('invalid cron')
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(p)
    if (!m) throw new Error('invalid cron')
    const base = m[1] as string
    const step = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1
    if (step <= 0) throw new Error('invalid cron')
    let lo: number, hi: number
    if (base === '*') {
      lo = min
      hi = max
    } else if (base.includes('-')) {
      const [a, b] = base.split('-').map((n) => Number.parseInt(n, 10))
      lo = a as number
      hi = b as number
    } else {
      lo = Number.parseInt(base, 10)
      hi = lo
    }
    const effectiveMax = kind === 'dow' ? 7 : max // dow accepts 7 as a synonym for 0 (Sunday)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || lo < min || hi > effectiveMax) {
      throw new Error('invalid cron')
    }
    for (let v = lo; v <= hi; v += step) {
      // dow accepts 7 as a synonym for 0 (Sunday) — normalized here, before inserting
      out.add(kind === 'dow' && v === 7 ? 0 : v)
    }
  }
  if (out.size === 0) throw new Error('invalid cron')
  return { values: out, restricted }
}

export function parseCron(expr: string): CronFields {
  if (typeof expr !== 'string') throw new Error('invalid cron')
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('invalid cron')
  const [minRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts as [string, string, string, string, string]
  const minute = parseField(minRaw, 'minute')
  const hour = parseField(hourRaw, 'hour')
  const dom = parseField(domRaw, 'dom')
  const month = parseField(monthRaw, 'month')
  const dow = parseField(dowRaw, 'dow')
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  }
}

// true if the validator doesn't throw — used by routes for a 400 'invalid cron'.
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

// ---- wall clock vs instants ----
//
// Cron fields describe WALL-CLOCK time (what a clock on the wall reads in
// the zone), but a schedule is a sequence of INSTANTS. The two differ around
// DST transitions: in the fall-back hour every wall-clock minute happens
// twice, in the spring-forward hour some wall-clock minutes never happen.
// So nextRun searches in wall-clock space (field jumps on a "naive" wall
// time held as a UTC Date and read with getUTC*), and only then resolves
// the matching wall-clock slot to an instant:
//
//   - a slot that happens once → that instant;
//   - a slot that happens twice (fall back) → its FIRST occurrence, once.
//     If the first occurrence is already ≤ `after`, the slot is past and
//     the repeat is skipped — a cron never fires twice for one wall-clock
//     slot (a "58 */2" job does not run again at the second 02:58);
//   - a slot that never happens (spring forward, e.g. 02:30 in Berlin) →
//     the first instant after the gap (03:00 local), once: the search
//     continues from the wall clock after that instant, so the slots the
//     gap swallowed collapse into that single run.
//
// The result is always strictly after `after`.

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// A zone = how to read an instant's wall clock, as a naive UTC ms value.
// The server's local zone (no tz) reads Date's local getters; a named IANA
// zone (trigger.tz, e.g. "America/New_York") reads Intl's calendar parts.
type WallOf = (t: number) => number

const localWall: WallOf = (t) => {
  const d = new Date(t)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())
}

const zoneWalls = new Map<string, WallOf>()

// Throws RangeError for a zone Intl doesn't know — isValidTimeZone is the check.
function zoneWall(tz: string): WallOf {
  const cached = zoneWalls.get(tz)
  if (cached) return cached
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  const wall: WallOf = (t) => {
    const p: Record<string, number> = {}
    for (const part of fmt.formatToParts(new Date(t))) {
      if (part.type !== 'literal') p[part.type] = Number.parseInt(part.value, 10)
    }
    const ms = ((t % 1000) + 1000) % 1000
    return Date.UTC(p.year as number, (p.month as number) - 1, p.day as number, p.hour as number, p.minute as number, p.second as number, ms)
  }
  zoneWalls.set(tz, wall)
  return wall
}

// true if `tz` is an IANA zone this runtime knows — used by the validator
// for a 400 instead of storing a cron that can never be scheduled.
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.trim() === '') return false
  try {
    zoneWall(tz)
    return true
  } catch {
    return false
  }
}

// The instants whose wall clock reads `wall` (0, 1 or 2 of them, ascending).
// Offsets in force around a wall time are those 14 h before and after it
// (no zone moves twice within a day); each candidate is kept only if it
// really reads `wall`.
function instantsOf(wallOf: WallOf, wall: number): number[] {
  const offsetAt = (t: number) => wallOf(t) - t
  const out = new Set<number>()
  for (const probe of [wall - 14 * HOUR, wall + 14 * HOUR]) {
    const t = wall - offsetAt(probe)
    if (wallOf(t) === wall) out.add(t)
  }
  return [...out].sort((a, b) => a - b)
}

// A wall time inside a spring-forward gap: the first instant after the gap
// (the transition itself), found by bisecting minutes between the two
// candidate instants. Transitions fall on whole minutes.
function gapEnd(wallOf: WallOf, wall: number): number {
  const offsetAt = (t: number) => wallOf(t) - t
  const before = offsetAt(wall - 14 * HOUR)
  const after = offsetAt(wall + 14 * HOUR)
  let lo = Math.floor((wall - after) / MINUTE) // offset `before` still in force
  let hi = Math.ceil((wall - before) / MINUTE) // offset `after` already in force
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (offsetAt(mid * MINUTE) === before) lo = mid
    else hi = mid
  }
  return hi * MINUTE
}

function dayMatches(f: CronFields, wall: Date): boolean {
  const dom = wall.getUTCDate()
  const dow = wall.getUTCDay()
  if (f.domRestricted && f.dowRestricted) return f.dom.has(dom) || f.dow.has(dow)
  if (f.domRestricted) return f.dom.has(dom)
  if (f.dowRestricted) return f.dow.has(dow)
  return true
}

// Search horizon: 4 years. We jump field by field (never minute by minute
// except once month+day+hour already match), so 4 years of days+months+
// hours fit comfortably in a few thousand iterations — an impossible
// pattern (e.g. "0 0 30 2 *", February 30th) exhausts the horizon quickly
// instead of hanging the process.
const MAX_STEPS = 20_000

// Next instant (exact minute, seconds/ms at 0) whose wall clock matches
// expr, strictly after `after` — in the IANA zone `tz` when given
// (trigger.tz), else the server's local zone (see the DST rules above).
// An unknown `tz` throws.
export function nextRun(expr: string, after: Date, tz?: string): Date {
  const f = parseCron(expr)
  const wallOf = tz === undefined ? localWall : zoneWall(tz)
  const afterMs = after.getTime()
  // the first whole wall-clock minute after `after`'s wall clock
  let w = new Date(Math.floor(wallOf(afterMs) / MINUTE) * MINUTE + MINUTE)
  const horizon = Date.UTC(w.getUTCFullYear() + 4, w.getUTCMonth(), w.getUTCDate())

  for (let steps = 0; steps < MAX_STEPS; steps += 1) {
    if (w.getTime() > horizon) break
    const y = w.getUTCFullYear(),
      mo = w.getUTCMonth(),
      d = w.getUTCDate(),
      h = w.getUTCHours()
    if (!f.month.has(mo + 1)) {
      w = new Date(Date.UTC(y, mo + 1, 1))
      continue
    }
    if (!dayMatches(f, w)) {
      w = new Date(Date.UTC(y, mo, d + 1))
      continue
    }
    if (!f.hour.has(h)) {
      w = new Date(Date.UTC(y, mo, d, h + 1))
      continue
    }
    if (!f.minute.has(w.getUTCMinutes())) {
      w = new Date(w.getTime() + MINUTE)
      continue
    }
    // a matching wall-clock slot — resolve it to an instant
    const instants = instantsOf(wallOf, w.getTime())
    const first = instants.length > 0 ? (instants[0] as number) : gapEnd(wallOf, w.getTime())
    if (first > afterMs) return new Date(first)
    // the slot's first (or only) occurrence is already past: never fire its repeat
    w = new Date(w.getTime() + MINUTE)
  }
  throw new Error('cron has no next run within the search horizon')
}
