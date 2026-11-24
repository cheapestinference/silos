// rate-limits.test.ts — the 5h vs weekly label. The system's truth (the SDK's
// kind) comes first; the >24h heuristic only applies with no kind.
import { describe, expect, it } from 'vitest'
import { limitLabel, resumeLabel } from '../src/lib/rate-limits'

const NOW = Date.parse('2026-08-20T12:00:00Z')
const IN_2H = new Date(NOW + 2 * 3600_000).toISOString()
const IN_3D = new Date(NOW + 3 * 24 * 3600_000).toISOString()

describe('limitLabel', () => {
  it('maps the SDK kinds', () => {
    expect(limitLabel('five_hour')).toBe('5h window')
    expect(limitLabel('seven_day')).toBe('weekly window')
    expect(limitLabel('seven_day_overage_included')).toBe('weekly window')
    expect(limitLabel('seven_day_opus')).toBe('weekly · opus')
    expect(limitLabel('seven_day_sonnet')).toBe('weekly · sonnet')
    expect(limitLabel('overage')).toBe('overage')
  })

  it('an unknown SDK kind is shown raw and readable, never hidden', () => {
    expect(limitLabel('brand_new_kind')).toBe('brand new kind')
  })

  it('with no kind: a resetsAt heuristic — >24h = weekly, otherwise 5h', () => {
    expect(limitLabel(undefined, IN_2H, NOW)).toBe('5h window')
    expect(limitLabel(undefined, IN_3D, NOW)).toBe('weekly window')
  })

  it('with neither a kind nor a parseable resetsAt → a generic "limit"', () => {
    expect(limitLabel(undefined, undefined, NOW)).toBe('limit')
    expect(limitLabel(undefined, 'not-a-date', NOW)).toBe('limit')
  })
})

describe('resumeLabel', () => {
  it('a near reset: just "resumes HH:MM"', () => {
    const label = resumeLabel(IN_2H, NOW)
    expect(label).toMatch(/^resumes \d{1,2}:\d{2}/)
    expect(label).not.toContain('weekly')
  })

  it('a reset days out: adds the day and the weekly mark (the time alone is misleading)', () => {
    const label = resumeLabel(IN_3D, NOW)
    expect(label).toContain('· weekly')
    // the abbreviated day goes before the time (locale-dependent, only the
    // presence of an extra non-numeric token is asserted)
    expect(label).toMatch(/^resumes \S+ \d{1,2}:\d{2}/)
  })

  it('a seven_day kind forces weekly even when the reset is near', () => {
    expect(resumeLabel(IN_2H, NOW, 'seven_day')).toContain('· weekly')
  })

  it('an unparseable date → null (the caller decides its fallback)', () => {
    expect(resumeLabel('not-a-date', NOW)).toBeNull()
  })
})
