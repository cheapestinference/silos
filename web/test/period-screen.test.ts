// period-screen.test.ts — what the editors hold before the click is what
// the server would refuse: validation over the
// STAMPED period (the agent's staggered minute from the band's start), the
// count and ruler over that same period, the cadence of days and weeks in
// real words, refusals with no API field names — and the one door each
// skipped fire carries on the agent's page.
import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_RULES,
  HEARTBEAT_RULES,
  cadenceWords,
  draftOfPeriod,
  draftSlots,
  periodProblem,
  screenProblem,
  stampedOfDraft,
  type PeriodDraft,
} from '../src/lib/period'
import { PeriodError, parsePeriod, stampPeriod } from '../../server/src/period'
import { skipRow } from '../src/lib/proactive'

const draft = (o: Partial<PeriodDraft>): PeriodDraft => ({ ...draftOfPeriod({ every: 1, unit: 'days', at: '09:00' }), ...o })
// the server's verdict on the same draft: parse, then stamp (automations-validate.ts stampTrigger)
const serverRefuses = (d: PeriodDraft, rules: typeof AUTOMATION_RULES, m: number): boolean => {
  try {
    const p = {
      every: Number(d.every.trim()),
      unit: d.unit,
      ...(d.unit === 'days' || d.unit === 'weeks' ? { at: d.at } : {}),
      ...(d.unit === 'weeks' ? { day: d.day } : {}),
      ...((d.unit === 'minutes' || d.unit === 'hours') && d.band ? { between: d.band } : {}),
    }
    stampPeriod(parsePeriod(p, rules), { today: '2026-11-12', staggerMinute: m })
    return false
  } catch (e) {
    if (e instanceof PeriodError) return true
    throw e
  }
}

describe('the editor refuses exactly what the server refuses', () => {
  it('a band its staggered slots miss: «every 2 hours between 09:00 and 09:10» at minute 49 is held, at minute 5 it is not', () => {
    const d = draft({ every: '2', unit: 'hours', band: { from: '09:00', to: '09:10' } })
    expect(periodProblem(d, AUTOMATION_RULES, 49)).toMatch(/^Nothing falls between 09:00 and 09:10/)
    expect(draftSlots(d, 49)).toEqual([])
    expect(periodProblem(d, AUTOMATION_RULES, 5)).toBeNull()
    expect(draftSlots(d, 5)).toEqual([9 * 60 + 5])
  })
  it('parity over a grid of drafts and minutes', () => {
    const drafts: PeriodDraft[] = [
      draft({ every: '2', unit: 'hours', band: { from: '09:00', to: '09:10' } }),
      draft({ every: '45', unit: 'minutes', band: { from: '22:00', to: '22:30' } }),
      draft({ every: '3', unit: 'hours', band: { from: '20:00', to: '02:00' } }),
      draft({ every: '4', unit: 'hours', band: { from: '08:00', to: '20:00' } }),
      draft({ every: '1', unit: 'hours', band: { from: '10:00', to: '10:00' } }),
      draft({ every: '30', unit: 'hours' }),
      draft({ every: '1440', unit: 'minutes' }),
      draft({ every: '2', unit: 'minutes' }),
      draft({ every: '1.5', unit: 'hours' }),
      draft({ every: '', unit: 'days' }),
      draft({ every: '400', unit: 'days' }),
      draft({ every: '53', unit: 'weeks' }),
      draft({ every: '1', unit: 'days', at: '' }),
      draft({ every: '2', unit: 'weeks', day: 5, at: '17:30' }),
    ]
    for (const rules of [AUTOMATION_RULES, HEARTBEAT_RULES]) {
      for (const d of drafts) {
        for (const m of [0, 5, 22, 49, 59]) {
          expect(periodProblem(d, rules, m) !== null, `${JSON.stringify(d)} @${m}`).toBe(serverRefuses(d, rules, m))
        }
      }
    }
  })
  it('refusals in screen words — never a field name or prefix; from = to says to pick two different hours', () => {
    const bad: PeriodDraft[] = [
      draft({ every: '0' }),
      draft({ every: '1.5', unit: 'hours' }),
      draft({ every: '30', unit: 'hours' }),
      draft({ every: '400', unit: 'days' }),
      draft({ every: '60', unit: 'weeks' }),
      draft({ at: '' }),
      draft({ every: '1', unit: 'hours', band: { from: '', to: '10:00' } }),
    ]
    for (const rules of [AUTOMATION_RULES, HEARTBEAT_RULES]) {
      for (const d of bad) {
        const said = periodProblem(d, rules, 7)
        expect(said).not.toBeNull()
        expect(said).not.toMatch(/period\.|trigger\.|heartbeat\.|\bbetween takes\b|"HH:MM"/)
      }
    }
    expect(periodProblem(draft({ every: '1', unit: 'hours', band: { from: '10:00', to: '10:00' } }), HEARTBEAT_RULES, 7)).toMatch(/two different hours/)
    // a 400 the server sent back reads the same
    expect(screenProblem('heartbeat.period.every must be a whole number, 1 or more', HEARTBEAT_RULES)).not.toMatch(/heartbeat\./)
  })
})

describe('the count and the cadence', () => {
  it('«every 4 hours between 08:00 and 20:00» is stamped from 08:49: three runs, ticks at 08:49, 12:49, 16:49', () => {
    const d = draft({ every: '4', unit: 'hours', band: { from: '08:00', to: '20:00' } })
    const p = stampedOfDraft(d, AUTOMATION_RULES, 49)!
    expect(p.at).toBe('08:49')
    expect(cadenceWords(p, 'run')).toBe('≈ 3 runs a day')
    expect(draftSlots(d, 49)).toEqual([8 * 60 + 49, 12 * 60 + 49, 16 * 60 + 49])
  })
  it('days and weeks say their real cadence, never «≈ 1 a day»', () => {
    expect(cadenceWords({ every: 1, unit: 'days', at: '09:00' }, 'run')).not.toMatch(/≈/)
    expect(cadenceWords({ every: 1, unit: 'weeks', day: 1, at: '09:00' }, 'run')).not.toMatch(/≈/)
    expect(cadenceWords({ every: 2, unit: 'days', at: '09:00' }, 'round')).toContain('2 days')
    expect(cadenceWords({ every: 3, unit: 'weeks', day: 1, at: '09:00' }, 'run')).toContain('3 weeks')
  })
})

describe("a skip on its agent's page: one door per cause, plain words", () => {
  const at = '2026-11-12T10:22:00.000Z'
  it('the doors', () => {
    expect(skipRow({ at, cause: 'spend', reason: "X's daily spend cap is reached — it does its round tomorrow instead" }, 'X').door).toBe('continue')
    expect(skipRow({ at, cause: 'share', reason: "X spent half its day's cap — rounds wait, its tasks go on" }, 'X').door).toBe('continue')
    expect(skipRow({ at, cause: 'headroom', reason: "X's account is at 88% of its 5-hour window — rounds wait so there is room for you" }, 'X').door).toBe(
      'usage',
    )
    expect(skipRow({ at, cause: 'account', reason: "X's account is at its limit" }, 'X').door).toBe('usage')
    expect(skipRow({ at, cause: 'engine', reason: "X's engine can't run: claude 2.1.1 is older than 2.1.300" }, 'X')).toMatchObject({
      door: 'engine',
      text: "its engine can't run",
    })
    expect(skipRow({ at, cause: 'busy', reason: 'the previous one is still running' }, 'X').door).toBeNull()
  })
  it('creations are tasks; the page it is on is not named; an instant sent apart is said in local time', () => {
    expect(skipRow({ at, cause: 'quota', reason: 'made its 5 creations today and nothing arrived' }, 'X').text).toBe(
      'made its 5 tasks today and nothing arrived',
    )
    expect(skipRow({ at, cause: 'sleeping', reason: "sleeping until Nov 20 — wake it on X's page" }, 'X').text).not.toMatch(/page/)
    const until = new Date(2026, 10, 12, 14, 5).toISOString()
    const now = new Date(2026, 10, 12, 11, 0).getTime()
    expect(skipRow({ at, cause: 'headroom', reason: "X's account is at 88% of its 5-hour window, which resets at", until }, 'X', now).text).toMatch(/ 14:05$/)
    expect(skipRow({ at, cause: 'headroom', reason: "X's account is at 88% of its 5-hour window" }, 'X', now).text).toBe(
      'its account is at 88% of its 5-hour window',
    )
  })
})
