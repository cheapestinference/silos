// control.test.ts — the ONE setting (and the heartbeat's period):
// shapes, exact words, decision 2 and the derived control.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import {
  checkControlTransition,
  ControlError,
  controlOf,
  defaultHeartbeat,
  degradedWhy,
  heartbeatOf,
  localYmd,
  parseControlPatch,
  staggeredMinute,
  CONTROL_ERROR,
  CUT_ERROR,
  EXEMPT_ERROR,
  HEARTBEAT_SHAPE_ERROR,
  OWN_TURNS_ERROR,
  SPEND_ERROR,
  selfRecurringRefusal,
  positionOf,
  proactiveOf,
  proactiveOffWhy,
  storedProactive,
} from '../src/control.js'

const M = { text: 'Keep the books.', never: [], updatedAt: 'x' }

describe("the heartbeat's default: every Monday at 09:<staggered minute>", () => {
  it('the same id always lands on the same minute; a fleet spreads over the hour', () => {
    expect(defaultHeartbeat('alpha')).toEqual({ period: { every: 1, unit: 'weeks', day: 1, at: `09:${String(staggeredMinute('alpha')).padStart(2, '0')}` } })
    expect(staggeredMinute('alpha')).toBe(staggeredMinute('alpha'))
    const minutes = new Set(Array.from({ length: 40 }, (_, i) => staggeredMinute(`agent-${i}`)))
    expect(minutes.size).toBeGreaterThan(20)
  })
  it('the field absent is the default; a shape it does not recognise — the old one included — never beats (period: null)', () => {
    expect(heartbeatOf({ id: 'a' })).toEqual(defaultHeartbeat('a'))
    expect(heartbeatOf({ id: 'a', heartbeat: { sleepUntil: '2030-01-01T00:00:00.000Z' } })).toEqual({
      ...defaultHeartbeat('a'),
      sleepUntil: '2030-01-01T00:00:00.000Z',
    })
    expect(heartbeatOf({ id: 'a', heartbeat: { rhythm: 'week', day: 1, at: '09:07' } }).period).toBeNull()
    expect(heartbeatOf({ id: 'a', heartbeat: { period: { every: 3, unit: 'fortnights' } } }).period).toBeNull()
    expect(heartbeatOf({ id: 'a', heartbeat: 'weekly' }).period).toBeNull()
    expect(heartbeatOf({ id: 'a', heartbeat: { period: null } }).period).toBeNull()
    expect(heartbeatOf({ id: 'a', heartbeat: { period: { every: 3, unit: 'hours', at: '08:22', since: '2026-11-11' } } }).period).toEqual({
      every: 3,
      unit: 'hours',
      at: '08:22',
      since: '2026-11-11',
    })
  })
  it('selfRecurringRefusal reads never as period null', () => {
    expect(selfRecurringRefusal('own', null)).toMatch(/On its own · never/)
    expect(selfRecurringRefusal('own', defaultHeartbeat('a').period)).toMatch(/decided in your weekly think/)
  })
})

describe('the derived control (decision 2, G5-r7, S1-r4)', () => {
  it('own needs the territory, a mission, a folder, in play — else it operates as told, the field intact', () => {
    const a = { control: 'own', mission: M, folder: '/f' }
    expect(controlOf(a, true)).toBe('own')
    expect(controlOf(a, false)).toBe('told')
    expect(degradedWhy(a, false)).toBe('territory')
    expect(controlOf({ ...a, mission: undefined }, true)).toBe('told')
    expect(degradedWhy({ ...a, mission: undefined }, true)).toBe('mission')
    expect(controlOf({ ...a, archived: true }, true)).toBe('told')
    expect(controlOf({ mission: M, folder: '/f' }, true)).toBe('told') // absent ⇒ told
  })
})

describe('PATCH words — 400s', () => {
  const words = (body: unknown): string => {
    try {
      parseControlPatch(body)
      return 'ok'
    } catch (e) {
      expect(e).toBeInstanceOf(ControlError)
      expect((e as ControlError).status).toBe(400)
      return (e as Error).message
    }
  }
  it('each field says its own rule', () => {
    expect(words({ control: 'maybe' })).toBe(CONTROL_ERROR)
    expect(CONTROL_ERROR).toBe('control must be told or own')
    // the old shape is no period (no compatibility)
    expect(words({ heartbeat: { rhythm: 'week' } })).toBe(HEARTBEAT_SHAPE_ERROR)
    expect(words({ heartbeat: { period: { every: 0, unit: 'hours' } } })).toBe('heartbeat.period.every must be a whole number, 1 or more')
    expect(words({ heartbeat: { period: { every: 1, unit: 'days', at: '9:00' } } })).toBe('heartbeat.period.at must be a 24h "HH:MM" time')
    expect(words({ heartbeat: { period: { every: 1, unit: 'weeks', at: '09:00', day: 7 } } })).toBe('heartbeat.period.day must be 0–6 (0 = Sunday)')
    expect(words({ heartbeat: { period: { every: 2, unit: 'minutes' } } })).toBe('a heartbeat runs every 5 minutes at most')
    expect(words({ heartbeat: { period: { every: 30, unit: 'hours' } } })).toBe('use days for a day or more')
    expect(words({ ownTurnsPerDay: 201 })).toBe(OWN_TURNS_ERROR)
    expect(OWN_TURNS_ERROR).toBe('ownTurnsPerDay must be a whole number from 1 to 200 — or null for the default (10)')
    expect(words({ unattendedSpendPerDay: 0.5 })).toBe(SPEND_ERROR)
    expect(SPEND_ERROR).toBe('unattendedSpendPerDay must be a number from 1 to 1000 — or null for the default (5)')
    expect(words({ ownExemptDay: 'today' })).toBe(EXEMPT_ERROR)
    expect(EXEMPT_ERROR).toBe('ownExemptDay must be a "YYYY-MM-DD" date — or null to clear it')
    expect(words({ cut: { at: 'x', why: 'y' } })).toBe(CUT_ERROR)
    expect(CUT_ERROR).toBe('cut only takes null, to lift it ("Allow again") — Silos writes a cut itself')
    expect(parseControlPatch({ ownTurnsPerDay: null, cut: null, heartbeat: { period: null } })).toEqual({
      ownTurnsPerDay: null,
      cut: null,
      heartbeat: { period: null },
    })
  })
  it('the server stamps since and the staggered minute; a band no slot falls in is a 400', () => {
    const now = new Date(2026, 10, 11, 12, 0).getTime()
    const asked = { heartbeat: { period: { every: 3, unit: 'hours', between: { from: '08:00', to: '20:00' }, since: '1999-01-01' } } }
    const p = parseControlPatch(asked, { agentId: 'a', prior: null, now }).heartbeat!.period!
    expect(p.since).toBe(localYmd(now))
    expect(p.at).toBe(`08:${String(staggeredMinute('a')).padStart(2, '0')}`)
    expect(words({ heartbeat: { period: { every: 5, unit: 'hours', at: '01:00', between: { from: '08:00', to: '09:00' } } } })).toBe('ok') // judged when stamped
    expect(() =>
      parseControlPatch(
        { heartbeat: { period: { every: 5, unit: 'hours', at: '01:00', between: { from: '08:00', to: '09:00' } } } },
        { agentId: 'a', prior: null, now },
      ),
    ).toThrow('nothing falls between 08:00 and 09:00 — widen it')
  })
})

describe('PATCH transitions — 409s', () => {
  const t = (o: Partial<Parameters<typeof checkControlTransition>[0]>): string => {
    try {
      checkControlTransition({
        name: 'X',
        storedBefore: 'told',
        askedOwn: false,
        controlAfter: 'told',
        missionAfter: true,
        missionCleared: false,
        fenceOn: true,
        ...o,
      })
      return 'ok'
    } catch (e) {
      expect((e as ControlError).status).toBe(409)
      return (e as Error).message
    }
  }
  it('own without a mission, own without a territory, clearing the mission of an own agent', () => {
    expect(t({ askedOwn: true, controlAfter: 'own', missionAfter: false })).toBe('Give X a mission first — on its own, it needs to know what it answers for')
    expect(t({ askedOwn: true, controlAfter: 'own', fenceOn: false })).toBe("X's territory is off. Turn it on, then it can go on its own ›")
    expect(t({ storedBefore: 'own', controlAfter: 'own', missionAfter: false, missionCleared: true })).toBe(
      'X is On its own and needs its mission — set it Only when told first, or write another mission',
    )
    // a rename of an own agent whose fence is off now: no transition, no 409
    expect(t({ storedBefore: 'own', controlAfter: 'own', fenceOn: false })).toBe('ok')
    expect(t({ askedOwn: true, controlAfter: 'own' })).toBe('ok')
  })
})

describe('the registry: control at birth, invariants re-validated on read', () => {
  it('born told by default with its heartbeat; own only with a mission', () => {
    const reg = new AgentRegistry(join(mkdtempSync(join(tmpdir(), 'ctl-')), 'agents.json'))
    reg.load()
    expect(reg.create({ id: 'a', name: 'A', folder: '/tmp/a' })).toMatchObject({
      control: 'told',
      heartbeat: { period: { ...defaultHeartbeat('a').period, since: localYmd(Date.now()) } },
    })
    expect(reg.create({ id: 'b', name: 'B', folder: '/tmp/b', control: 'own' }).control).toBe('told')
    expect(reg.create({ id: 'c', name: 'C', folder: '/tmp/c', control: 'own', mission: { text: 'x' } }).control).toBe('own')
  })
  it('a stale exemption is dropped, an out-of-range knob goes back to its default, a missing control is told', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ctl-')), 'agents.json')
    writeFileSync(
      file,
      JSON.stringify({
        agents: [{ id: 'z', name: 'Z', emoji: '', folder: '/tmp/z', skills: [], ownExemptDay: '2020-01-01', ownTurnsPerDay: 9999, unattendedSpendPerDay: 3 }],
      }),
    )
    const reg = new AgentRegistry(file)
    reg.load()
    const z = reg.get('z')!
    expect(z.ownExemptDay).toBeUndefined()
    expect(z.ownTurnsPerDay).toBeUndefined()
    expect(z.unattendedSpendPerDay).toBe(3)
    expect(z.control).toBe('told')
    expect(JSON.parse(readFileSync(file, 'utf8')).agents.find((a: { id: string }) => a.id === 'z').ownTurnsPerDay).toBeUndefined()
    // today's exemption survives; tomorrow's revalidate drops it
    reg.update('z', { ownExemptDay: localYmd(Date.now()) })
    reg.revalidate(Date.now())
    expect(reg.get('z')!.ownExemptDay).toBe(localYmd(Date.now()))
    reg.revalidate(Date.now() + 2 * 24 * 3600_000)
    expect(reg.get('z')!.ownExemptDay).toBeUndefined()
  })
  it('a heartbeat PATCH replaces the period and keeps the sleep; null knobs clear', () => {
    const reg = new AgentRegistry(join(mkdtempSync(join(tmpdir(), 'ctl-')), 'agents.json'))
    reg.load()
    reg.create({ id: 'a', name: 'A', folder: '/tmp/a' })
    reg.update('a', { heartbeat: { sleepUntil: '2030-01-01T00:00:00.000Z' } })
    expect(reg.update('a', { heartbeat: { period: { every: 1, unit: 'days', at: '07:15' } } }).heartbeat).toEqual({
      period: { every: 1, unit: 'days', at: '07:15' },
      sleepUntil: '2030-01-01T00:00:00.000Z',
    })
    expect(reg.update('a', { heartbeat: { period: null } }).heartbeat!.period).toBeNull()
    reg.update('a', { ownTurnsPerDay: 4 })
    expect(reg.update('a', { ownTurnsPerDay: null }).ownTurnsPerDay).toBeUndefined()
  })
})

// the EFFECTIVE proactive mode, one source
describe('proactiveOf', () => {
  const a = (over: Record<string, unknown> = {}) => ({
    id: 'x',
    control: 'own',
    mission: { text: 'm' },
    folder: '/w',
    heartbeat: { period: { every: 3, unit: 'hours', at: '08:22' } },
    proactive: { perDay: 5, tools: true },
    ...over,
  })
  it('own, a valid setting, a period, no cut — else null; the position follows', () => {
    expect(proactiveOf(a(), true)).toEqual({ perDay: 5, tools: true })
    expect(positionOf(a(), true)).toBe('proactive')
    expect(proactiveOf(a(), false)).toBeNull() // no territory: told
    expect(positionOf(a(), false)).toBe('told')
    expect(proactiveOf(a({ heartbeat: { period: null } }), true)).toBeNull()
    expect(proactiveOffWhy(a({ heartbeat: { period: null } }), true)).toBe('never')
    expect(proactiveOf(a({ cut: { at: 'x', why: 'y' } }), true)).toBeNull()
    expect(proactiveOffWhy(a({ cut: { at: 'x', why: 'y' } }), true)).toBe('cut')
    expect(positionOf(a({ cut: { at: 'x', why: 'y' } }), true)).toBe('own')
    expect(proactiveOf(a({ control: 'told' }), true)).toBeNull()
  })
  it('a shape Silos does not read is no proactive (the safe side)', () => {
    expect(storedProactive({ proactive: { perDay: 99, tools: true } })).toBeNull()
    expect(storedProactive({ proactive: { perDay: 5, tools: true, extra: 1 } })).toBeNull()
    expect(storedProactive({ proactive: { perDay: 5 } })).toBeNull()
    expect(storedProactive({ proactive: { perDay: 5, tools: false } })).toEqual({ perDay: 5, tools: false })
  })
})
