// resident-heartbeat.test.ts — the heartbeat when it fires («Run now»
// included; the free period's clock too) through the REAL resident and
// ChatService, with a fake query (no SDK turn, temp dirs only).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { LineageStore } from '../src/lineage.js'
import { ChatService } from '../src/chat-service.js'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AutomationsStore } from '../src/automations-store.js'
import { Resident } from '../src/resident.js'
import { HeartbeatClock, heartbeatAutomationId } from '../src/heartbeat.js'
import { HeartbeatStore } from '../src/heartbeat-store.js'
import { DECIDE_STAGE_LINE } from '../src/heartbeat-prompt.js'
import { localYmd } from '../src/control.js'
import { TurnSlots } from '../src/turn-slots.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import type { Automation } from '../src/automations-types.js'
import type { HeartbeatFacts } from '../src/heartbeat-facts.js'

let base: string, root: string, dataDir: string, folder: string
let registry: AgentRegistry, native: NativeStore, index: SessionIndex, store: AutomationsStore, chat: ChatService, lineage: LineageStore
let calls: QueryArgs[]
let clock: Date
let fenceOn: boolean
let facts: HeartbeatFacts
let heartbeatStore: HeartbeatStore
let accountReset: string | null
let engineRefused: string | null
let turnCost: number
let residents: Resident[] = []

const script = (cost = turnCost): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: `sess-${calls.length}`, model: 'claude-test-model' },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'decided nothing' } } },
  { type: 'result', subtype: 'success', total_cost_usd: cost },
]
const fakeQuery = (): ((args: QueryArgs) => SdkQueryHandle) => (args) => {
  calls.push(args)
  const msgs = script()
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) yield m
    },
    async interrupt() {
      return undefined
    },
  }
}
const empty = (): HeartbeatFacts => ({ messages: [], failedRuns: [], yours: [], waits: [], routed: [], decided: [], owner: [] })

function mkResident(over: Partial<ConstructorParameters<typeof Resident>[0]> = {}): Resident {
  const r = new Resident({
    store,
    registry,
    chat,
    native,
    index,
    root,
    dataDir,
    lineage,
    broadcast: () => {},
    now: () => clock,
    claudeSessionsDir: join(base, 'no-sessions'),
    tickIntervalMs: 999_999_999,
    heartbeats: new HeartbeatClock({ store, agents: () => registry.list(true), fenceOn: () => fenceOn }),
    heartbeat: { fenceOn: () => fenceOn, facts: () => facts, store: heartbeatStore, blocks: () => ({ web: true, connectors: true, subagents: true }) },
    accountResetOf: () => accountReset,
    engineRefusal: () => engineRefused,
    ...over,
  })
  residents.push(r)
  return r
}
const beat = (): Automation => store.get(heartbeatAutomationId('finance'))!
const runs = () => store.listRuns(heartbeatAutomationId('finance'))

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silos-hb-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  folder = join(base, 'books')
  for (const d of [root, dataDir, folder]) mkdirSync(d, { recursive: true })
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder, mission: { text: 'Keep the books.' }, control: 'own' })
  native = new NativeStore(join(dataDir, 'native.json'))
  lineage = new LineageStore(join(dataDir, 'lineage.json'))
  index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  store = new AutomationsStore(dataDir)
  store.load()
  heartbeatStore = new HeartbeatStore(dataDir)
  calls = []
  // a Monday, 09:30 local — the default weekly think's day
  clock = new Date(2026, 10, 9, 9, 30)
  fenceOn = true
  facts = empty()
  accountReset = null
  engineRefused = null
  turnCost = 0.02
  chat = new ChatService({ registry, native, queryFn: fakeQuery(), dataDir })
})
afterEach(async () => {
  for (const r of residents) {
    r.stop()
    await r.drain()
  }
  residents = []
  rmSync(base, { recursive: true, force: true })
})

describe('the heartbeat clock', () => {
  it('tick reconciles heartbeat-<id> from control and period; told deletes it; the fence off deletes it and on brings it back with no gesture', async () => {
    const r = mkResident()
    await r.tick(clock)
    const a = beat()
    // no budget (its period is its ceiling) and an account at its limit waits for its slot
    expect(a).toMatchObject({ origin: 'heartbeat', agentId: 'finance', thread: { mode: 'new' }, projectSettings: true, approval: false, keepAlive: false })
    expect(a.maxRunsPerDay).toBeUndefined()
    expect(a.trigger).toMatchObject({ kind: 'period', period: { every: 1, unit: 'weeks', day: 1 } })
    expect(a.runsOn).toBeUndefined()
    // one made the old way is brought to the derived shape
    store.update(a.id, { keepAlive: true, maxRunsPerDay: 3, trigger: { kind: 'cron', expr: '0 9 * * 1' } })
    await r.tick(clock)
    expect(beat()).toMatchObject({ keepAlive: false, trigger: { kind: 'period' } })
    expect(beat().maxRunsPerDay).toBeUndefined()
    fenceOn = false
    await r.tick(clock)
    expect(store.get(heartbeatAutomationId('finance'))).toBeNull()
    fenceOn = true
    await r.tick(clock)
    expect(beat()).toBeDefined()
    registry.update('finance', { control: 'told' })
    await r.tick(clock)
    expect(store.get(heartbeatAutomationId('finance'))).toBeNull()
  })
})

describe('a heartbeat fire', () => {
  it('a weekly think runs ONE turn: the t3 prompt variant, the heartbeat class, hooks off even with inheritHooks, no OUTCOME line; its kind at start, its cost at the end', async () => {
    const r = mkResident()
    await r.tick(clock)
    store.update(beat().id, { inheritHooks: true })
    await r.executeRun(beat())
    await r.drain()
    expect(calls).toHaveLength(1)
    const o = calls[0]!.options as Record<string, unknown>
    expect((o.settings as { disableAllHooks?: boolean }).disableAllHooks).toBe(true)
    // and the skills that schedule work, vetoed by name in every heartbeat
    expect(o.disallowedTools).toEqual([
      'CronCreate',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Task',
      'AskUserQuestion',
      'Skill(schedule)',
      'Skill(loop)',
      'Workflow',
      'RemoteTrigger',
      'ScheduleWakeup',
      'SendMessage',
    ])
    const prompt = String(calls[0]!.prompt)
    expect(prompt).toContain('This is your heartbeat — your weekly think about your mission.')
    expect(prompt).toContain('Your mission: Keep the books.')
    // t5: the complete variant (G5-r6)
    expect(prompt).not.toContain(DECIDE_STAGE_LINE)
    expect(prompt).toContain('Create ONE thing from your mission')
    expect(prompt).not.toMatch(/OUTCOME/)
    expect(prompt).toContain('This turn has no web tools, no connectors and no subagents.')
    const done = runs()[0]!
    expect(done).toMatchObject({ status: 'ok', heartbeat: { kind: 'think', considered: 0 } })
    expect(done.costUsd).toBeCloseTo(0.02)
  })

  it('an audit that cannot read the transcript fails closed: `transcript unreadable` on the run (tainted), no silent drop — and no cut without creations', async () => {
    const r = mkResident({
      audit: async () => {
        throw new Error('reader gone')
      },
    })
    await r.tick(clock)
    await r.executeRun(beat())
    await r.drain()
    const done = runs()[0]!
    expect(done.sessionKey).toBeDefined()
    expect(done.audit).toEqual({ readOutside: ['transcript unreadable'] })
    expect(registry.get('finance')!.cut).toBeUndefined()
  })

  it('a daily look with nothing new costs nothing: skipped «nothing happened since …», no turn', async () => {
    registry.update('finance', { heartbeat: { period: { every: 1, unit: 'days', at: '09:30' } } })
    const r = mkResident()
    await r.tick(clock)
    await r.executeRun(beat())
    // the first heartbeat of a daily rhythm thinks (no think in 7 days)…
    expect(runs()[0]!.heartbeat?.kind).toBe('think')
    await r.drain()
    clock = new Date(clock.getTime() + 24 * 3600_000)
    await r.executeRun(beat())
    await r.drain()
    expect(calls).toHaveLength(1)
    expect(runs()[0]).toMatchObject({ status: 'skipped', heartbeat: { kind: 'look', skipped: 'empty' } })
    expect(runs()[0]!.reason).toMatch(/^nothing happened since /)
    // …and a new message makes the next look a turn
    facts = { ...empty(), messages: [{ id: 'm1', from: 'builder', fromName: 'BUILDER', text: 'the invoice is late', at: clock.getTime() }] }
    clock = new Date(clock.getTime() + 24 * 3600_000)
    await r.executeRun(beat())
    await r.drain()
    expect(calls).toHaveLength(2)
    expect(String(calls[1]!.prompt)).toContain('message:m1 from BUILDER: «the invoice is late»')
    expect(runs()[0]!.heartbeat).toMatchObject({ kind: 'look', packet: { keys: ['message:m1'] } })
  })

  it('asleep: skipped in its words, no turn; Run now skips the sleep', async () => {
    const until = new Date(clock.getTime() + 5 * 24 * 3600_000).toISOString()
    registry.update('finance', { heartbeat: { sleepUntil: until } })
    const r = mkResident()
    await r.tick(clock)
    await r.executeRun(beat())
    // the instant rides apart (`until`): the words stop before it
    expect(runs()[0]).toMatchObject({
      status: 'skipped',
      reason: "sleeping — wake it on FINANCE's page, or it wakes on its own at",
      until,
      heartbeat: { skipped: 'sleeping' },
    })
    expect(await r.runNowManual(beat().id)).toEqual({ ok: true })
    await r.drain()
    expect(calls).toHaveLength(1)
  })

  it("never held by the day's ceiling; the spend cap and the account's limit skip in their words (never failed); a think so skipped is re-armed after midnight, once", async () => {
    registry.update('finance', { ownTurnsPerDay: 1, unattendedSpendPerDay: 1 })
    turnCost = 0.6
    const r = mkResident()
    await r.tick(clock)
    await r.executeRun(beat())
    await r.drain()
    await r.executeRun(beat())
    await r.drain() // past its ceiling of 1: it still runs
    expect(calls).toHaveLength(2)
    clock = new Date(clock.getTime() + 3600_000)
    // the weekly slot's next fire is next week: only the re-arm can think tomorrow
    store.update(beat().id, { nextRunAt: new Date(2026, 10, 16, 9, 0).toISOString() })
    await r.executeRun(beat())
    expect(runs()[0]).toMatchObject({
      status: 'skipped',
      reason: "FINANCE's daily spend cap is reached — it thinks tomorrow instead",
      heartbeat: { kind: 'think', skipped: 'spend' },
    })
    expect(heartbeatStore.state('finance').pendingThink).toMatchObject({ why: 'spend' })
    // the next day's first tick re-arms the think — once
    clock = new Date(2026, 10, 10, 0, 5)
    await r.tick(clock)
    await r.drain()
    expect(calls).toHaveLength(3)
    expect(runs()[0]).toMatchObject({ status: 'ok', cause: 'rearm', heartbeat: { kind: 'think' } })
    expect(heartbeatStore.state('finance').pendingThink).toBeUndefined()
    await r.tick(clock)
    await r.drain()
    expect(calls).toHaveLength(3)
    // the account at its limit: skipped, its reset said
    registry.update('finance', { unattendedSpendPerDay: 100 })
    accountReset = new Date(clock.getTime() + 3600_000).toISOString()
    await r.executeRun(beat())
    expect(runs()[0]).toMatchObject({
      status: 'skipped',
      reason: "FINANCE's account is at its usage limit — it thinks after",
      until: accountReset,
      heartbeat: { skipped: 'account' },
    })
  })
})

describe('no budget: its period is its ceiling', () => {
  it('a maxRunsPerDay written on it is never consulted — by its slots or by Run now', async () => {
    const r = mkResident()
    await r.tick(clock)
    store.update(beat().id, { maxRunsPerDay: 1 })
    for (let i = 0; i < 3; i++) {
      expect(await r.runNowManual(beat().id)).toEqual({ ok: true })
      await r.drain()
    }
    expect(calls).toHaveLength(3)
    expect(
      runs()
        .filter((x) => x.status === 'ok')
        .map((x) => x.cause),
    ).toEqual(['manual', 'manual', 'manual'])
    await r.executeRun(beat())
    await r.drain()
    await r.executeRun(beat())
    await r.drain()
    expect(calls).toHaveLength(5)
    expect(runs().some((x) => /daily budget/.test(x.reason ?? ''))).toBe(false)
  })
})

describe('the live caps: a think queued, never lost; a look skipped, holding no place', () => {
  it('a think with no slot stays due (no run row, its place in the line); it starts once a slot frees', async () => {
    const slots = new TurnSlots({ globalMax: 1 })
    const r = mkResident({ slots })
    await r.tick(clock)
    const other = slots.tryAcquire({ id: 'wake:x|t', agentId: 'x', gesture: false, at: 0 })
    expect(other.ok).toBe(true)
    expect(await r.executeRun(beat())).toBe(false)
    expect(runs()).toEqual([])
    expect(r.heldWhy(beat().id)).toBe('the fleet is running 1 thing — FINANCE starts when one ends')
    expect(slots.queue().map((q) => q.id)).toEqual([`run:${beat().id}`])
    if (other.ok) other.release()
    expect(await r.executeRun(beat())).toBe(true)
    await r.drain()
    expect(calls).toHaveLength(1)
  })
  it('a look with no slot is skipped «busy» — and the probe leaves nothing in the line', async () => {
    registry.update('finance', { heartbeat: { period: { every: 1, unit: 'hours', at: '00:30' } } })
    heartbeatStore.noteRun('finance', {
      id: 'th',
      automationId: 'heartbeat-finance',
      at: clock.toISOString(),
      status: 'ok',
      heartbeat: { kind: 'think', packet: { keys: [] }, created: [], proposed: [], considered: 0 },
    })
    const slots = new TurnSlots({ globalMax: 1 })
    const r = mkResident({ slots })
    await r.tick(clock)
    const other = slots.tryAcquire({ id: 'wake:x|t', agentId: 'x', gesture: false, at: 0 })
    expect(other.ok).toBe(true)
    facts = { ...empty(), messages: [{ id: 'm1', from: 'builder', fromName: 'BUILDER', text: 'hi', at: clock.getTime() }] }
    expect(await r.executeRun(beat())).toBe(true)
    expect(runs()[0]).toMatchObject({ status: 'skipped', reason: 'the fleet is busy — it goes at its next slot', heartbeat: { kind: 'look', skipped: 'busy' } })
    expect(slots.queue()).toEqual([])
    // its previous run alive: «the previous one is still running»
    if (other.ok) other.release()
    store.appendRun(beat().id, { id: 'alive', automationId: beat().id, at: clock.toISOString(), status: 'running' })
    expect(await r.executeRun(beat())).toBe(true)
    expect(runs()[0]).toMatchObject({
      status: 'skipped',
      reason: 'the previous one is still running — its runs take longer than its period',
      heartbeat: { skipped: 'busy' },
    })
    expect(calls).toHaveLength(0)
  })
})

describe("the period's clock", () => {
  const at = (h: number, m: number, d = 9): Date => new Date(2026, 10, d, h, m)
  const nextAt = (id: string): string | undefined => store.get(id)?.nextRunAt
  const hourly = (): void => {
    registry.update('finance', { heartbeat: { period: { every: 1, unit: 'hours', at: '00:30' } } })
  }
  const thought = (at0: Date): void =>
    heartbeatStore.noteRun('finance', {
      id: `th-${at0.getTime()}`,
      automationId: 'heartbeat-finance',
      at: at0.toISOString(),
      status: 'ok',
      heartbeat: { kind: 'think', packet: { keys: [] }, created: [], proposed: [], considered: 0 },
    })

  it('a heartbeat moves to its next slot at every slot, run or skipped: it never chains and never piles up', async () => {
    hourly()
    const r = mkResident()
    clock = at(9, 0)
    await r.tick(clock)
    expect(nextAt(beat().id)).toBe(at(9, 30).toISOString())
    clock = at(9, 31)
    await r.tick(clock)
    await r.drain()
    expect(calls).toHaveLength(1) // the first beat thinks: nothing thought in 7 days
    expect(runs()[0]).toMatchObject({ status: 'ok', heartbeat: { kind: 'think' } })
    expect(nextAt(beat().id)).toBe(at(10, 30).toISOString())
    // its run ended: nothing fires again before its slot (no chaining)
    clock = at(9, 33)
    await r.tick(clock)
    await r.drain()
    expect(runs()).toHaveLength(1)
    // four slots missed: ONE fire, then the next slot after now
    clock = at(14, 45)
    await r.tick(clock)
    await r.drain()
    expect(runs()).toHaveLength(2)
    expect(runs()[0]).toMatchObject({ status: 'skipped', heartbeat: { kind: 'look', skipped: 'empty' } })
    expect(nextAt(beat().id)).toBe(at(15, 30).toISOString())
  })

  it('a think tried today does not come back on the next slot; a failed one stays pending for the re-arm', async () => {
    hourly()
    const r = mkResident()
    const hb0 = { kind: 'think' as const, packet: { keys: [] }, created: [], proposed: [], considered: 0 }
    heartbeatStore.noteRun('finance', { id: 't1', automationId: 'heartbeat-finance', at: at(9, 30).toISOString(), status: 'running', heartbeat: hb0 })
    heartbeatStore.noteRun('finance', { id: 't1', automationId: 'heartbeat-finance', at: at(9, 30).toISOString(), status: 'failed', heartbeat: hb0 })
    clock = at(10, 31)
    await r.tick(clock)
    store.update(beat().id, { nextRunAt: at(10, 30).toISOString() })
    facts = { ...empty(), messages: [{ id: 'm1', from: 'builder', fromName: 'BUILDER', text: 'hi', at: clock.getTime() }] }
    await r.tick(clock)
    await r.drain()
    expect(runs()[0]!.heartbeat?.kind).toBe('look')
    expect(heartbeatStore.state('finance').pendingThink).toMatchObject({ why: 'failed' })
  })

  it("an owner's automation with a period: due stays due while its run lives — ONE pending — then runs once and moves on from its start", async () => {
    const r = mkResident()
    const a = store.create({
      id: 'own1',
      name: 'own1',
      agentId: 'finance',
      prompt: 'p',
      trigger: { kind: 'period', period: { every: 5, unit: 'minutes', at: '00:00' } },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: false,
      paused: false,
      createdAt: clock.toISOString(),
    })
    clock = at(9, 0, 10)
    await r.tick(clock)
    expect(nextAt(a.id)).toBe(at(9, 5, 10).toISOString())
    // its previous run still lives: the slot stays due, no row
    store.appendRun(a.id, { id: 'alive', automationId: a.id, at: clock.toISOString(), status: 'running' })
    clock = at(9, 6, 10)
    await r.tick(clock)
    await r.drain()
    clock = at(9, 16, 10)
    await r.tick(clock)
    await r.drain()
    expect(store.listRuns(a.id)).toHaveLength(1)
    expect(nextAt(a.id)).toBe(at(9, 5, 10).toISOString())
    // it ends: the one pending run goes, and the clock moves from that start
    store.appendRun(a.id, { id: 'alive', automationId: a.id, at: at(9, 0, 10).toISOString(), status: 'ok' })
    clock = at(9, 17, 10)
    await r.tick(clock)
    await r.drain()
    expect(store.listRuns(a.id).filter((x) => x.status === 'ok')).toHaveLength(2)
    expect(nextAt(a.id)).toBe(at(9, 20, 10).toISOString())
  })

  it("at boot: a heartbeat recovers no slot; an owner's due period runs once (cron's rule)", async () => {
    hourly()
    const r0 = mkResident()
    await r0.tick(at(9, 0))
    const a = store.create({
      id: 'own2',
      name: 'own2',
      agentId: 'finance',
      prompt: 'p',
      trigger: { kind: 'period', period: { every: 1, unit: 'hours', at: '00:00' } },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: false,
      paused: false,
      createdAt: clock.toISOString(),
    })
    store.update(beat().id, { nextRunAt: at(6, 30).toISOString() })
    store.update(a.id, { nextRunAt: at(6, 0).toISOString() })
    clock = at(9, 10)
    const r = mkResident()
    r.start()
    r.stop()
    expect(nextAt(beat().id)).toBe(at(9, 30).toISOString())
    expect(runs()).toEqual([])
    expect(nextAt(a.id)).toBe(at(6, 0).toISOString()) // < 6 h: the tick runs it
    await r.tick(clock)
    await r.drain()
    expect(store.listRuns(a.id)).toHaveLength(1)
    expect(nextAt(a.id)).toBe(at(10, 0).toISOString())
  })

  it('a heartbeat never resumes: one a restart cut stays interrupted, its next turn is a fresh conversation', async () => {
    const r0 = mkResident()
    await r0.tick(clock)
    const sessDir = join(root, 'books-folder')
    mkdirSync(sessDir, { recursive: true })
    writeFileSync(join(sessDir, 'cut.jsonl'), '')
    store.appendRun(beat().id, {
      id: 'cut',
      automationId: beat().id,
      at: clock.toISOString(),
      startedAt: clock.toISOString(),
      status: 'running',
      sessionKey: 'books-folder/cut',
      heartbeat: { kind: 'think', packet: { keys: [] }, created: [], proposed: [], considered: 0 },
    })
    const r = mkResident()
    r.start()
    r.stop()
    expect(runs()[0]).toMatchObject({ id: 'cut', status: 'failed' })
    await r.executeRun(beat())
    await r.drain()
    expect(calls).toHaveLength(1)
    expect((calls[0]!.options as { resume?: string }).resume).toBeUndefined()
    expect(String(calls[0]!.prompt)).not.toMatch(/restart interrupted/)
  })

  it('its engine refused: a row once a local day, then silence while it lasts — the slot moves on either way', async () => {
    hourly()
    thought(at(9, 0))
    const r = mkResident()
    clock = at(9, 0)
    await r.tick(clock)
    engineRefused = 'claude 2.0.1 is older than 2.1.0'
    clock = at(9, 31)
    await r.tick(clock)
    await r.drain()
    expect(runs()[0]).toMatchObject({
      status: 'skipped',
      reason: "FINANCE's engine can't run: claude 2.0.1 is older than 2.1.0",
      heartbeat: { skipped: 'engine' },
    })
    clock = at(10, 31)
    await r.tick(clock)
    await r.drain()
    expect(runs()).toHaveLength(1)
    expect(nextAt(beat().id)).toBe(at(11, 30).toISOString())
  })

  it('outside its band a think waits and a look passes; never a turn there', async () => {
    registry.update('finance', { heartbeat: { period: { every: 1, unit: 'hours', at: '08:30', between: { from: '08:00', to: '20:00' } } } })
    const r = mkResident()
    clock = at(21, 0)
    await r.tick(clock)
    store.update(beat().id, { nextRunAt: at(20, 30).toISOString() })
    expect(await r.executeRun(beat())).toBe(false) // a think: waits for its band
    thought(at(8, 0))
    await r.tick(clock)
    await r.drain()
    expect(runs()).toEqual([])
    expect(calls).toHaveLength(0)
    expect(nextAt(beat().id)).toBe(at(8, 30, 10).toISOString())
  })

  it('a shape Silos does not recognise never beats', async () => {
    const raw = registry.get('finance')!
    ;(raw as unknown as { heartbeat: unknown }).heartbeat = { rhythm: 'day', day: 1, at: '09:00' }
    const r = mkResident()
    await r.tick(clock)
    expect(store.get(heartbeatAutomationId('finance'))).toBeNull()
  })
})

describe('own recurring work without territory', () => {
  it("a run of origin self is skipped in its words while the territory is off; the owner's automations run", async () => {
    fenceOn = false
    const r = mkResident()
    const mk = (id: string, origin?: 'self'): Automation =>
      store.create({
        id,
        name: id,
        agentId: 'finance',
        prompt: 'p',
        trigger: { kind: 'cron', expr: '0 9 * * *' },
        thread: { mode: 'new' },
        approval: false,
        keepAlive: false,
        paused: false,
        createdAt: clock.toISOString(),
        ...(origin ? { origin } : {}),
      })
    await r.executeRun(mk('mine', 'self'))
    expect(store.listRuns('mine')[0]).toMatchObject({ status: 'skipped', reason: "FINANCE's territory is off — its own automation waits for it" })
    await r.executeRun(mk('owners'))
    await r.drain()
    expect(store.listRuns('owners')[0]).toMatchObject({ status: 'ok' })
  })
})

// ONE wall cap for every unattended turn —
// the runs (as before) AND the task wakes, which had none
describe('UNATTENDED_TURN_TIMEOUT_MS covers the task wakes', () => {
  it('a wake turn that hangs is cancelled at the cap and ends as a timeout', async () => {
    const cancelled: string[] = []
    let abort: () => void = () => {}
    const hanging = {
      on: () => {},
      off: () => {},
      // a turn that never ends on its own — only the cancel ends it
      send: async function* () {
        await new Promise<void>((r) => {
          abort = r
        })
      },
      cancel: async (id: string) => {
        cancelled.push(id)
        abort()
        return true
      },
    } as unknown as ChatService
    const r = mkResident({ chat: hanging, runTimeoutMs: 50 })
    const t = r.openTaskTurn({ agentId: 'finance', text: 'work', resume: null, onSession: () => {}, turn: { class: 'wake', taskKey: 'k' } })
    const end = await t.done
    expect(end).toMatchObject({ error: 'timeout' })
    expect(cancelled).toEqual([t.turnId])
  })
})

describe('the audit of a task turn (fail closed)', () => {
  it('an audit that cannot read hands the task `transcript unreadable` — never dropped', async () => {
    const r = mkResident({
      audit: async () => {
        throw new Error('reader gone')
      },
    })
    const got: Array<{ audit: unknown; sessionId: string }> = []
    const t = r.openTaskTurn({
      agentId: 'finance',
      text: 'work',
      resume: null,
      onSession: () => {},
      onAudit: (audit, at) => got.push({ audit, sessionId: at.sessionId }),
      turn: { class: 'wake', taskKey: 'k' },
    })
    await t.done
    await r.drain()
    expect(got).toEqual([{ audit: { readOutside: ['transcript unreadable'] }, sessionId: 'sess-1' }])
  })
})

describe('costUsd on every run', () => {
  it("an owner's automation records what its turn cost", async () => {
    const r = mkResident()
    const a = store.create({
      id: 'o1',
      name: 'o1',
      agentId: 'finance',
      prompt: 'p',
      trigger: { kind: 'cron', expr: '0 9 * * *' },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: false,
      paused: false,
      createdAt: clock.toISOString(),
    })
    await r.executeRun(a)
    await r.drain()
    expect(store.listRuns('o1')[0]!.costUsd).toBeCloseTo(0.02)
    // and the model its turn ran — what the unpriced-spend row names (G5-product)
    expect(store.listRuns('o1')[0]!.model).toBe('claude-test-model')
    expect(localYmd(clock.getTime())).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it("the install's unattended switch reaches the real Claude engine, and the run records that its provider prices", async () => {
    const { ProvidersStore } = await import('../src/providers-store.js')
    const providers = new ProvidersStore(dataDir)
    providers.load()
    const gw = providers.create({ kind: 'anthropic-compatible', label: 'Gateway', baseUrl: 'https://gateway.invalid', apiKey: 'sk-test-0000000000' })
    const switched = new ChatService({ registry, native, queryFn: fakeQuery(), dataDir, providers, settings: { unattendedProvider: () => gw.id } })
    const r = mkResident({ chat: switched })
    const a = store.create({
      id: 'o2',
      name: 'o2',
      agentId: 'finance',
      prompt: 'p',
      trigger: { kind: 'cron', expr: '0 9 * * *' },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: false,
      paused: false,
      createdAt: clock.toISOString(),
    })
    await r.executeRun(a)
    await r.drain()
    expect((calls[0]!.options.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe('https://gateway.invalid')
    expect(store.listRuns('o2')[0]).toMatchObject({ priced: true })
    expect(switched.unattendedProviderOf(store.listRuns('o2')[0]!.sessionKey!.split('/')[1]!)).toBe(gw.id)
  })
})
