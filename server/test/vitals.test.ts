import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationsStore } from '../src/automations-store.js'
import type { Automation, Run } from '../src/automations-types.js'
import type { UsageRecord } from '../src/harnesses/contract.js'
import { VitalsService, fleetSeries, lastDays, type VitalsDeps } from '../src/vitals.js'
import { noteControlChange, readFleetLog } from '../src/fleet-events.js'
import type { Position } from '../src/control.js'

// local noon, so every «day» below is the server's local day
const NOW = new Date(2026, 10, 21, 12, 0, 0).getTime()
const DAY = 24 * 3600_000
const at = (daysAgo: number, h = 10): number => {
  const d = new Date(NOW)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, h).getTime()
}
const iso = (ms: number): string => new Date(ms).toISOString()

let dataDir: string
let store: AutomationsStore

function mkAutomation(id: string, extra: Partial<Automation> = {}): Automation {
  return {
    id,
    name: 'Routine ' + id,
    agentId: 'alpha',
    prompt: 'do X',
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    thread: { mode: 'keep', folder: 'proj', sessionId: 's-kept' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: iso(at(40)),
    ...extra,
  }
}
const run = (id: string, automationId: string, start: number, status: Run['status'], extra: Partial<Run> = {}): Run => ({
  id,
  automationId,
  at: iso(start),
  startedAt: iso(start),
  status,
  ...(status === 'ok' || status === 'failed' ? { endedAt: iso(start + 60_000) } : {}),
  ...extra,
})
const rec = (id: string, ms: number, tokens: number, costUsd: number | null): UsageRecord => ({
  id,
  at: ms,
  model: 'model-x',
  tokens: { in: tokens, out: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd,
  session: 's',
})

function service(records: Record<string, UsageRecord[] | null | 'unmeasured'>, over: Partial<VitalsDeps> = {}): { v: VitalsService; calls: string[] } {
  const calls: string[] = []
  const v = new VitalsService({
    dataDir,
    automations: store,
    usageRecords: async (f, i) => {
      calls.push(`${f}/${i}`)
      return records[`${f}/${i}`] ?? null
    },
    agents: () => [],
    births: () => [],
    executions: () => [],
    now: () => NOW,
    ...over,
  })
  return { v, calls }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'silos-vitals-'))
  store = new AutomationsStore(dataDir)
  store.load()
})

describe('vitals — runs and executions a day', () => {
  it('counts runs on the day they started, folded by id; skips and held runs are no run; appended lines are picked up', async () => {
    store.create(mkAutomation('a1'))
    store.appendRun('a1', run('r1', 'a1', at(2), 'running'))
    store.appendRun('a1', run('r1', 'a1', at(2), 'ok')) // same run, its terminal line
    store.appendRun('a1', run('r2', 'a1', at(2, 14), 'failed'))
    store.appendRun('a1', run('r3', 'a1', at(1), 'skipped'))
    store.appendRun('a1', run('r4', 'a1', at(1), 'waiting_approval'))
    store.appendRun('a1', run('r5', 'a1', at(45), 'ok')) // outside the 30 days
    const exec = [{ updatedAt: at(0) }, { updatedAt: at(0, 8) }, { updatedAt: at(3) }]
    const { v } = service({}, { executions: () => exec })
    const first = await v.vitals()
    expect(first.runs).toHaveLength(30)
    expect(first.runs.at(-1)!.date).toBe(lastDays(NOW, 1)[0])
    const by = (xs: Array<{ date: string; count: number }>, ms: number) => xs.find((x) => x.date === lastDays(ms, 1)[0])!.count
    expect(by(first.runs, at(2))).toBe(2)
    expect(by(first.runs, at(1))).toBe(0)
    expect(first.runs.reduce((s, x) => s + x.count, 0)).toBe(2)
    expect(by(first.executions, at(0))).toBe(2)
    expect(by(first.executions, at(3))).toBe(1)
    // another automation and a new run of the first, after the first read
    store.appendRun('a1', run('r6', 'a1', at(0), 'ok'))
    store.create(mkAutomation('a2'))
    store.appendRun('a2', run('q1', 'a2', at(0), 'running'))
    const second = await v.vitals()
    expect(by(second.runs, at(0))).toBe(2)
    expect(by(second.runs, at(2))).toBe(2)
  })
})

describe('vitals — the fleet by control, backwards', () => {
  const agents: Array<{ id: string; position: Position }> = [
    { id: 'alpha', position: 'proactive' }, // changed twice
    { id: 'beta', position: 'own' }, // never logged: projected back
    { id: 'gamma', position: 'told' }, // born 10 days ago
  ]
  it('births, logged changes and the projection of an agent never changed', () => {
    const log = [
      { at: iso(at(60)), kind: 'seen' as const, agent: 'alpha', position: 'told' as const },
      { at: iso(at(20)), kind: 'control' as const, agent: 'alpha', from: 'told' as const, to: 'own' as const },
      { at: iso(at(5)), kind: 'control' as const, agent: 'alpha', from: 'own' as const, to: 'proactive' as const },
      { at: iso(at(100)), kind: 'control' as const, agent: 'ghost', from: 'told' as const, to: 'own' as const }, // archived/unknown: out
    ]
    const births = [
      { agentId: 'gamma', ctimeMs: at(10) },
      { agentId: 'gamma', ctimeMs: at(3) },
      { agentId: 'alpha', ctimeMs: at(200) },
    ]
    const f = fleetSeries({ agents, births, log, now: NOW })
    expect(f.days).toHaveLength(90)
    const day = (ms: number) => f.days.find((d) => d.date === lastDays(ms, 1)[0])!
    // before alpha's first change: its `from`; gamma not born yet
    expect(day(at(30))).toMatchObject({ told: 1, own: 1, proactive: 0 })
    // the day of the first change counts its `to`
    expect(day(at(20))).toMatchObject({ told: 0, own: 2, proactive: 0 })
    // gamma born on its FIRST marker's day
    expect(day(at(10))).toMatchObject({ told: 1, own: 2, proactive: 0 })
    expect(day(at(11))).toMatchObject({ told: 0, own: 2, proactive: 0 })
    expect(f.days.at(-1)).toMatchObject({ told: 1, own: 1, proactive: 1 })
    expect(f.today).toMatchObject({ told: 1, own: 1, proactive: 1 })
    expect(f.today.agents).toEqual([
      { id: 'alpha', control: 'proactive' },
      { id: 'beta', control: 'own' },
      { id: 'gamma', control: 'told' },
    ])
    expect(f.events).toEqual([
      { date: lastDays(at(20), 1)[0], kind: 'control', agent: 'alpha', from: 'told', to: 'own' },
      { date: lastDays(at(10), 1)[0], kind: 'birth', agent: 'gamma' },
      { date: lastDays(at(5), 1)[0], kind: 'control', agent: 'alpha', from: 'own', to: 'proactive' },
    ])
  })

  it('the log: a PATCH writes only a move; a read writes a baseline once and a change made by another path', async () => {
    noteControlChange(dataDir, 'alpha', 'own', 'own', at(9))
    expect(readFleetLog(dataDir)).toEqual([])
    noteControlChange(dataDir, 'alpha', 'told', 'own', at(9))
    let fleet: Array<{ id: string; position: Position }> = [
      { id: 'alpha', position: 'own' },
      { id: 'beta', position: 'told' },
    ]
    const { v } = service({}, { agents: () => fleet })
    await v.vitals()
    await v.vitals() // nothing moved: nothing written
    expect(readFleetLog(dataDir).map((l) => `${l.agent}:${l.kind}`)).toEqual(['alpha:control', 'beta:seen'])
    fleet = [
      { id: 'alpha', position: 'own' },
      { id: 'beta', position: 'own' },
    ]
    const out = await v.vitals()
    expect(readFleetLog(dataDir).at(-1)).toMatchObject({ kind: 'control', agent: 'beta', from: 'told', to: 'own' })
    expect(out.fleet.today).toMatchObject({ told: 0, own: 2 })
  })
})

describe('vitals — what each automation spent in 30 days', () => {
  it("sums each run's records inside its window, prices like Usage, a plan run has no dollars, a command is null", async () => {
    store.create(mkAutomation('a1'))
    store.create(mkAutomation('cmd', { run: { kind: 'command', argv: ['true'], onFailure: 'inbox' } }))
    store.create(mkAutomation('a3', { thread: { mode: 'new' } }))
    // two runs of a1 in ONE kept conversation: each counts only its own records
    store.appendRun('a1', run('r1', 'a1', at(3), 'ok', { sessionKey: 'proj/s-kept', priced: true }))
    store.appendRun('a1', run('r2', 'a1', at(1), 'ok', { sessionKey: 'proj/s-kept', priced: true }))
    store.appendRun('a1', run('r3', 'a1', at(0), 'running', { sessionKey: 'proj/s-kept' })) // not finished: not counted yet
    store.appendRun('cmd', run('c1', 'cmd', at(1), 'ok'))
    store.appendRun('a3', run('p1', 'a3', at(2), 'ok', { sessionKey: 'proj/s-plan', priced: false }))
    const kept = [
      rec('m0', at(5), 999, 1), // before any run (the owner's own turn): no one's
      rec('m1', at(3) + 1000, 100, 0.5),
      rec('m2', at(3) + 30_000, 50, null),
      rec('m3', at(1) + 5000, 200, 0.25),
      rec('m4', at(0) + 1000, 77, 1), // the running run's
    ]
    const { v, calls } = service({ 'proj/s-kept': kept, 'proj/s-plan': [rec('n1', at(2) + 1000, 300, 2)] })
    const u = await v.automationUsage(store.list())
    expect(u.byId.get('cmd')).toBeNull()
    const a1 = u.byId.get('a1')!
    expect(a1).toMatchObject({ tokens: 350, cost: 0.75, unpricedTokens: 50, runsCounted: 2, plan: false })
    expect(a1.days).toHaveLength(30)
    expect(a1.days.find((d) => d.date === lastDays(at(3), 1)[0])!.tokens).toBe(150)
    expect(a1.days.find((d) => d.date === lastDays(at(1), 1)[0])!.tokens).toBe(200)
    expect(u.byId.get('a3')).toMatchObject({ tokens: 300, cost: 0, plan: true, runsCounted: 1 })
    expect(u.totals).toEqual({ tokens: 650, cost: 0.75 })
    expect(calls.sort()).toEqual(['proj/s-kept', 'proj/s-plan']) // one read per conversation
  })

  it('a finished run is read once: the cache file holds its figure across restarts', async () => {
    store.create(mkAutomation('a1'))
    store.appendRun('a1', run('r1', 'a1', at(2), 'ok', { sessionKey: 'proj/s1', priced: true }))
    const records = { 'proj/s1': [rec('m1', at(2) + 1000, 40, 0.1)] }
    const one = service(records)
    expect((await one.v.automationUsage(store.list())).byId.get('a1')).toMatchObject({ tokens: 40, runsCounted: 1 })
    await one.v.automationUsage(store.list())
    expect(one.calls).toHaveLength(1)
    // a new server over the same dataDir: nothing is read again
    const two = service(records)
    expect((await two.v.automationUsage(store.list())).byId.get('a1')).toMatchObject({ tokens: 40, runsCounted: 1 })
    expect(two.calls).toHaveLength(0)
    // a new finished run: only its conversation is read
    store.appendRun('a1', run('r2', 'a1', at(1), 'ok', { sessionKey: 'proj/s2', priced: true }))
    const u = await two.v.automationUsage(store.list())
    expect(two.calls).toEqual(['proj/s2'])
    expect(u.byId.get('a1')).toMatchObject({ tokens: 40, runsCounted: 2 })
  })

  it('a transcript not readable yet is asked again; gone for good past an hour, counted with nothing measured', async () => {
    store.create(mkAutomation('a1'))
    store.appendRun('a1', run('fresh', 'a1', NOW - 5 * 60_000, 'ok', { sessionKey: 'proj/s-new', endedAt: iso(NOW - 60_000) }))
    store.appendRun('a1', run('old', 'a1', NOW - 3 * DAY, 'ok', { sessionKey: 'proj/s-gone' }))
    const { v, calls } = service({})
    expect((await v.automationUsage(store.list())).byId.get('a1')).toMatchObject({ tokens: 0, runsCounted: 1 })
    await v.automationUsage(store.list())
    expect(calls.filter((c) => c === 'proj/s-new')).toHaveLength(2)
    expect(calls.filter((c) => c === 'proj/s-gone')).toHaveLength(1)
  })
})
