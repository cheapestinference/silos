// spend.test.ts — the spend cap of an agent's day on its own
// the per-agent knob set by
// the owner's PATCH, the day's sum of its own turns, «Let it continue today»
// lifting BOTH caps, an accepted proposal's runs braked by spend (outside
// the ceiling), the owner's automations outside the brake, and the turns
// without a price counted — never silently dropped.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { buildServer } from '../src/server.js'
import { localYmd } from '../src/control.js'
import { ownCapHold, ownTurnsToday, type OwnTurnsDeps } from '../src/own-turns.js'
import type { Automation, Run } from '../src/automations-types.js'
import { UNATTENDED_SPEND_USD_DAY } from '../src/limits.js'
import { asOwner } from './helpers/owner.js'

const NOW = Date.parse('2026-11-11T12:00:00')
const at = new Date(NOW - 3600_000).toISOString()

const auto = (id: string, over: Partial<Automation> = {}): Automation => ({
  id,
  name: id,
  agentId: 'x',
  prompt: 'p',
  trigger: { kind: 'cron', expr: '0 9 * * 1' },
  thread: { mode: 'new' },
  approval: false,
  keepAlive: true,
  paused: false,
  createdAt: at,
  ...over,
})
const run = (automationId: string, costUsd: number | null): Run => ({ id: `${automationId}-${Math.random()}`, automationId, at, status: 'ok', costUsd }) as Run

function store(autos: Automation[], runs: Run[]): OwnTurnsDeps['automations'] {
  return {
    list: () => autos,
    get: (id) => autos.find((a) => a.id === id) ?? null,
    listRuns: (id) => runs.filter((r) => r.automationId === id),
  } as OwnTurnsDeps['automations']
}

describe('the day of its own turns (own-turns.ts)', () => {
  const autos = [
    auto('heartbeat-x', { origin: 'heartbeat' }),
    auto('direct', { origin: 'self' }),
    auto('accepted', { origin: 'self', acceptedFrom: 'p1' }),
    auto('owners'), // the owner's: outside the brake (I2)
  ]
  const runs = [run('heartbeat-x', 1), run('direct', 1), run('accepted', 2.5), run('owners', 100), run('direct', null)]
  const d = { automations: store(autos, runs), wakesToday: () => ({ charged: 2, costUsd: 0.5, unpriced: 1 }) }

  it("sums wakes, heartbeats and its own runs — accepted included (S15) — and leaves the owner's out", () => {
    const t = ownTurnsToday(d, { id: 'x' }, NOW)
    expect(t.costUsd).toBeCloseTo(0.5 + 1 + 1 + 2.5)
    // the ceiling: wakes + direct runs; an accepted runs outside it (R7), and
    // a heartbeat turn never counts
    expect(t.used).toBe(2 + 2)
    expect(t.spendCap).toBe(UNATTENDED_SPEND_USD_DAY)
  })

  it('the breakdown the row says: starts by kind, money by kind — the heartbeat in the money only', () => {
    const t = ownTurnsToday(d, { id: 'x' }, NOW)
    expect(t.starts).toEqual({ wakes: 2, self: 2 })
    expect(t.starts!.wakes + t.starts!.self).toBe(t.used)
    expect(t.spent!.wakes).toBeCloseTo(0.5)
    expect(t.spent!.heartbeat).toBeCloseTo(1)
    expect(t.spent!.self).toBeCloseTo(1 + 2.5) // the accepted one's money is its automations'
    expect(t.spent!.wakes + t.spent!.heartbeat + t.spent!.self).toBeCloseTo(t.costUsd)
  })

  it('heartbeat turns — «Run now» included — never reach the ceiling, however many; the spend cap still holds them', () => {
    const beats = Array.from({ length: 30 }, () => run('heartbeat-x', 0.25))
    const manual = { ...run('heartbeat-x', 0.25), cause: 'manual' } as Run
    const t = ownTurnsToday({ automations: store(autos, [...beats, manual]) }, { id: 'x', ownTurnsPerDay: 1, unattendedSpendPerDay: 100 }, NOW)
    expect(t.used).toBe(0)
    expect(t.starts).toEqual({ wakes: 0, self: 0 })
    expect(ownCapHold(t)).toBeNull()
    expect(t.spent!.heartbeat).toBeCloseTo(31 * 0.25)
    const capped = ownTurnsToday({ automations: store(autos, [...beats, manual]) }, { id: 'x', ownTurnsPerDay: 1, unattendedSpendPerDay: 5 }, NOW)
    expect(ownCapHold(capped, { outsideCeiling: true })).toBe('spend')
  })

  it('turns without a price are counted, never dropped (G5-product)', () => {
    expect(ownTurnsToday(d, { id: 'x' }, NOW).unpriced).toBe(2)
  })

  it('the unpriced turns name their models, once each — and say so in one row, never held (G5-product)', async () => {
    const { unpricedSpendRow } = await import('../src/inbox.js')
    const withModels = {
      automations: store(autos, [...runs, { ...run('direct', null), model: 'm-new' } as Run, { ...run('heartbeat-x', null), model: 'm-new' } as Run]),
      wakesToday: () => ({ charged: 1, costUsd: 0, unpriced: 1, unpricedModels: ['m-other'] }),
    }
    const t = ownTurnsToday(withModels, { id: 'x' }, NOW)
    expect(t.unpriced).toBe(4)
    expect(t.unpricedModels).toEqual(['m-new', 'm-other'])
    const row = unpricedSpendRow({ agentId: 'x', agentName: 'X', day: '2026-11-11', unpriced: t.unpriced, models: t.unpricedModels!, now: NOW })
    expect(row).toMatchObject({ kind: 'spend', urgency: 'due', ack: { kind: 'spend', key: 'x', version: '2026-11-11' } })
    expect(row.voice).toBe("X: 4 unpriced today (m-new, m-other) — the $ cap can't count them; the plan's usage line is the brake")
  })

  it('an accepted one is braked by spend, not by the ceiling; a direct one by both', () => {
    const over = ownTurnsToday(d, { id: 'x', unattendedSpendPerDay: 3, ownTurnsPerDay: 100 }, NOW)
    expect(ownCapHold(over, { outsideCeiling: true })).toBe('spend')
    const atCeiling = ownTurnsToday(d, { id: 'x', ownTurnsPerDay: 4, unattendedSpendPerDay: 100 }, NOW)
    expect(ownCapHold(atCeiling)).toBe('ceiling')
    expect(ownCapHold(atCeiling, { outsideCeiling: true })).toBeNull()
  })

  it("the owner's automations never reach the cap, whatever they cost", () => {
    const only = { automations: store([auto('owners')], [run('owners', 100)]) }
    const t = ownTurnsToday(only, { id: 'x' }, NOW)
    expect(t.costUsd).toBe(0)
    expect(ownCapHold(t)).toBeNull()
  })

  it("only turns on a provider that PRICES reach the cap: a plan's notional cost is no money", () => {
    const plan = (id: string, c: number | null): Run => ({ ...run(id, c), priced: false }) as Run
    const key = (id: string, c: number | null): Run => ({ ...run(id, c), priced: true }) as Run
    const mixed = { automations: store(autos, [plan('heartbeat-x', 40), plan('direct', null), key('direct', 1.5), key('accepted', null)]) }
    const t = ownTurnsToday(mixed, { id: 'x', unattendedSpendPerDay: 5, ownTurnsPerDay: 100 }, NOW)
    // the plan's $40 never brakes; its null is no «unpriced» either (G5 is a
    // model without a price on a provider that prices)
    expect(t.costUsd).toBeCloseTo(1.5)
    expect(t.unpriced).toBe(1)
    expect(t.used).toBe(2) // the ceiling still counts every direct start (the accepted one and the heartbeat are outside it)
    expect(ownCapHold(t)).toBeNull()
    // a run with no record of its provider counts: the brake errs on braking
    const unsaid = ownTurnsToday({ automations: store(autos, [run('direct', 6)]) }, { id: 'x' }, NOW)
    expect(ownCapHold(unsaid)).toBe('spend')
  })

  it("the day says whether its unattended turns price NOW (the spend line's words)", () => {
    expect(ownTurnsToday({ ...d, pricesNow: () => false }, { id: 'x' }, NOW).priced).toBe(false)
    expect(ownTurnsToday(d, { id: 'x' }, NOW).priced).toBe(true)
  })

  it('«Let it continue today» lifts both caps — today only (S16)', () => {
    const today = localYmd(NOW)
    const t = ownTurnsToday(d, { id: 'x', unattendedSpendPerDay: 1, ownTurnsPerDay: 1, ownExemptDay: today }, NOW)
    expect(t.exempt).toBe(true)
    expect(ownCapHold(t)).toBeNull()
    expect(ownCapHold(t, { outsideCeiling: true })).toBeNull()
    const yesterday = ownTurnsToday(d, { id: 'x', unattendedSpendPerDay: 1, ownExemptDay: '2026-11-10' }, NOW)
    expect(ownCapHold(yesterday)).not.toBeNull()
  })
})

describe('the per-agent knob is data and API (B1)', () => {
  let app: FastifyInstance, registry: AgentRegistry
  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'silos-spend-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    const folder = join(base, 'work')
    for (const dir of [root, join(dataDir, 'trash'), folder]) mkdirSync(dir, { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'x', name: 'X', folder })
    const native = new NativeStore(join(dataDir, 'native.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => {
        throw new Error('no sdk')
      },
    })
    app = buildServer({
      index,
      registry,
      native,
      chat,
      store: new SessionStore(root, dataDir),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: 't0k',
      liveMs: 120_000,
      agentTokens: new AgentTokens(dataDir),
      home: base,
    })
    asOwner(app, 't0k')
  })
  afterEach(async () => {
    await app.close()
  })

  it("the owner's PATCH sets it, and the day's cap reads it; null goes back to the default", async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/agents/x', headers: { host: '127.0.0.1:3210' }, payload: { unattendedSpendPerDay: 2 } })
    expect(r.statusCode).toBe(200)
    const d = { automations: store([], []) }
    expect(ownTurnsToday(d, registry.get('x')!, NOW).spendCap).toBe(2)
    await app.inject({ method: 'PATCH', url: '/api/agents/x', headers: { host: '127.0.0.1:3210' }, payload: { unattendedSpendPerDay: null } })
    expect(ownTurnsToday(d, registry.get('x')!, NOW).spendCap).toBe(UNATTENDED_SPEND_USD_DAY)
  })
})

describe("Measured's heartbeat line: its turns of the day by class, apart from the max", () => {
  it('counts a look or a think that had its turn, once per run; a skip or a failure before any turn is none', async () => {
    const { HeartbeatStore } = await import('../src/heartbeat-store.js')
    const hs = new HeartbeatStore(mkdtempSync(join(tmpdir(), 'q2-beats-')))
    const day = localYmd(NOW)
    const hb = (kind: 'look' | 'think', skipped?: 'busy') => ({
      kind,
      packet: { keys: [] },
      created: [],
      proposed: [],
      considered: 0,
      ...(skipped ? { skipped } : {}),
    })
    const r = (id: string, status: Run['status'], kind: 'look' | 'think', extra: Partial<Run> = {}): Run =>
      ({ id, automationId: 'heartbeat-x', at, status, heartbeat: hb(kind, status === 'skipped' ? 'busy' : undefined), ...extra }) as Run
    hs.noteRun('x', r('a', 'running', 'look'))
    hs.noteRun('x', r('a', 'ok', 'look'))
    hs.noteRun('x', r('a', 'ok', 'look')) // the audit's re-write: still one
    hs.noteRun('x', r('b', 'ok', 'look'))
    hs.noteRun('x', r('c', 'skipped', 'look'))
    hs.noteRun('x', r('d', 'failed', 'look'))
    hs.noteRun('x', r('e', 'failed', 'think', { produced: true }))
    expect(hs.turnsOfDay('x', day)).toEqual({ looks: 2, thinks: 1, rounds: 0 })
    expect(hs.turnsOfDay('x', '2026-11-10')).toEqual({ looks: 0, thinks: 0, rounds: 0 })
  })
})
