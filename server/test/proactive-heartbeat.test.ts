// proactive-heartbeat.test.ts — the proactive engine through the REAL
// resident and ChatService with a fake query (no SDK turn, temp dirs only)
// — the think's re-arm,
// «Run now», the kind `round`, the regime SEALED on the run and the
// live turn, the engine options by `tools` (hooks, subagents, questions and
// the native scheduler always off), the skip order (busy, spend, its share,
// the account at its limit, its margin — fresh reading, the earliest slot of
// the day, an unmeasured provider — and the quota), the round's prompt with
// its blocks, the verdict that reads the sealed regime (a mode changed
// mid-round changes nothing), the bounded sleep, the re-armed think.
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
import { ROUND_TOOLS_LINE } from '../src/heartbeat-prompt.js'
import { HEARTBEAT_ALWAYS_OFF, HEARTBEAT_DISALLOWED_TOOLS } from '../src/harnesses/claude-code/headless.js'
import {
  headroomWords,
  runNowMarginWords,
  shareWords,
  unmeasuredWords,
  unreadableWords,
  quotaWords,
  type MarginReading,
  type OpenItem,
} from '../src/proactive.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import type { Automation, RunAudit } from '../src/automations-types.js'
import type { HeartbeatFacts } from '../src/heartbeat-facts.js'
import type { TurnAccount } from '../src/resident/deps.js'
import { configContent } from '../src/harnesses/opencode/launch.js'

let base: string, root: string, dataDir: string, folder: string
let registry: AgentRegistry, native: NativeStore, index: SessionIndex, store: AutomationsStore, chat: ChatService, lineage: LineageStore
let calls: QueryArgs[]
let clock: Date
let facts: HeartbeatFacts
let heartbeatStore: HeartbeatStore
let account: TurnAccount
// a reading, or one computed at ask time (a fresh one follows the clock)
let reading: MarginReading | null | (() => MarginReading)
const readingNow = (): MarginReading | null => (typeof reading === 'function' ? reading() : reading)
let readsAsked: number
let mission: {
  open: OpenItem[]
  undone: Array<{ ref: string; key: string; title: string; by: 'the owner' | 'Silos' | 'you'; why: string; at: string }>
  madeToday: number
}
let duringTurn: (() => void) | null
// a turn held mid-way (before its result) until the test releases it
let gate: Promise<void> | null = null
let gateReached = false
let release: () => void = () => {}
const holdTurns = (): void => {
  gateReached = false
  gate = new Promise<void>((res) => {
    release = () => {
      gate = null
      res()
    }
  })
}
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(cond()).toBe(true)
}
let residents: Resident[] = []

const script = (): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: `sess-${calls.length}`, model: 'claude-test-model' },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'nothing needed doing' } } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.01 },
]
const fakeQuery = (): ((args: QueryArgs) => SdkQueryHandle) => (args) => {
  calls.push(args)
  const msgs = script()
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) {
        if (m.type === 'result') {
          duringTurn?.()
          if (gate) {
            gateReached = true
            await gate
          }
        }
        yield m
      }
    },
    async interrupt() {
      return undefined
    },
  }
}
const empty = (): HeartbeatFacts => ({ messages: [], failedRuns: [], yours: [], waits: [], routed: [], decided: [], owner: [] })
const fresh =
  (percent: number, kind = 'session'): (() => MarginReading) =>
  () => ({
    ok: true,
    at: clock.getTime() - 60_000,
    windows: [{ kind, label: '5h', percent, windowMs: kind === 'session' ? 5 * 3600_000 : 7 * 86_400_000, resetsAt: null, active: false }],
  })

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
    heartbeats: new HeartbeatClock({ store, agents: () => registry.list(true), fenceOn: () => true }),
    heartbeat: {
      fenceOn: () => true,
      facts: () => facts,
      store: heartbeatStore,
      blocks: () => ({ web: true, connectors: true, subagents: true }),
      mission: () => mission,
      account: () => account,
      usage: {
        get: async () => {
          readsAsked++
          return readingNow()
        },
        peek: () => readingNow(),
      },
    },
    ...over,
  })
  residents.push(r)
  return r
}
const beat = (): Automation => store.get(heartbeatAutomationId('finance'))!
const runs = () => store.listRuns(heartbeatAutomationId('finance'))
const at = (h: number, m: number, d = 11): Date => new Date(2026, 10, d, h, m)
// a think had its turn this morning: the next slots are rounds
const thought = (t: Date): void =>
  heartbeatStore.noteRun('finance', {
    id: `th-${t.getTime()}`,
    automationId: 'heartbeat-finance',
    at: t.toISOString(),
    status: 'ok',
    heartbeat: { kind: 'think', packet: { keys: [] }, created: [], proposed: [], considered: 0 },
  })
const proactive = (p: { perDay?: number; tools?: boolean } = {}): void => {
  registry.update('finance', { heartbeat: { period: { every: 3, unit: 'hours', at: '08:22' } }, proactive: { perDay: p.perDay ?? 5, tools: p.tools ?? true } })
}
const opts = (i = 0): Record<string, unknown> => calls[i]!.options as Record<string, unknown>

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silos-pro-'))
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
  clock = at(11, 22)
  facts = empty()
  account = { id: 'default', priced: false, readable: true }
  reading = fresh(40)
  readsAsked = 0
  mission = { open: [], undone: [], madeToday: 0 }
  duringTurn = null
  gate = null
  gateReached = false
  chat = new ChatService({ registry, native, queryFn: fakeQuery(), dataDir })
})
afterEach(async () => {
  release()
  for (const r of residents) {
    r.stop()
    await r.drain()
  }
  residents = []
  rmSync(base, { recursive: true, force: true })
})

async function fireSlot(r: Resident, t: Date): Promise<void> {
  clock = t
  await r.tick(clock)
  store.update(beat().id, { nextRunAt: t.toISOString() })
  await r.tick(clock)
  await r.drain()
}

describe('the round', () => {
  it('a proactive agent with a think today does a ROUND: its regime SEALED on the run; with its tools — skills, connectors, the web — and never a subagent, a question, the scheduler or hooks', async () => {
    proactive()
    thought(at(8, 22))
    const r = mkResident()
    await fireSlot(r, at(11, 22))
    expect(calls).toHaveLength(1)
    const run = runs()[0]!
    expect(run).toMatchObject({ status: 'ok', heartbeat: { kind: 'round', tools: true, perDay: 5 } })
    const o = opts()
    expect(o.disallowedTools).toEqual([...HEARTBEAT_ALWAYS_OFF])
    expect(o.disallowedTools).toEqual(
      expect.arrayContaining([
        'Agent',
        'Task',
        'AskUserQuestion',
        'CronCreate',
        'Skill(schedule)',
        'Skill(loop)',
        'Workflow',
        'RemoteTrigger',
        'ScheduleWakeup',
        'SendMessage',
      ]),
    )
    expect(o.disallowedTools).not.toContain('WebFetch')
    expect(o.mcpServers).toBeUndefined()
    expect(o.strictMcpConfig).toBeUndefined()
    expect(o.maxTurns).toBe(60)
    expect((o.settings as { disableAllHooks?: boolean }).disableAllHooks).toBe(true)
    // a fresh conversation every round
    expect(o.resume).toBeUndefined()
    const prompt = String(calls[0]!.prompt)
    expect(prompt).toContain('This is your heartbeat — a round of what your mission covers.')
    expect(prompt).toContain('Look over what your mission covers — with your skills, your connectors and the web.')
    expect(prompt).toContain('5 more today (5 a day, counting what your own tasks create), and 10 from your mission open at most.')
    expect(prompt).toContain('sleep: POST …/heartbeat/sleep {"until","why"} (30 days at most; 3 after reading outside).')
    expect(prompt).toContain(ROUND_TOOLS_LINE)
    expect(prompt).toContain('Yours, open: nothing open')
    expect(prompt).toContain('Yours, undone: nothing')
    expect(prompt).not.toContain('You may also create ONE weekly automation')
  })

  it("without its tools: today's heartbeat options (no web, no MCP), 30 turns, the files line and the engine's tools line", async () => {
    proactive({ tools: false })
    thought(at(8, 22))
    mission = {
      open: [{ ref: 'books#t1', key: 'k1', title: 'Reconcile October', status: 'in_progress', createdAt: at(8, 30).toISOString() }],
      undone: [{ ref: 'books#t2', key: 'k2', title: 'Email the bank', by: 'the owner', why: 'undone', at: at(9, 0).toISOString() }],
      madeToday: 2,
    }
    const r = mkResident()
    await fireSlot(r, at(11, 22))
    const o = opts()
    expect(o.disallowedTools).toEqual([...HEARTBEAT_DISALLOWED_TOOLS])
    expect(o.mcpServers).toEqual({})
    expect(o.strictMcpConfig).toBe(true)
    expect(o.maxTurns).toBe(30)
    expect(runs()[0]!.heartbeat).toMatchObject({ kind: 'round', tools: false, perDay: 5 })
    const prompt = String(calls[0]!.prompt)
    expect(prompt).toContain('— in the files of your folders.')
    expect(prompt).toContain('3 more today (5 a day')
    expect(prompt).toContain('{"until","why"} (30 days at most).')
    expect(prompt).toContain('This turn has no web tools, no connectors and no subagents.')
    expect(prompt).toContain('books#t1 — Reconcile October — in_progress — ')
    expect(prompt).toContain('books#t2 — Email the bank — by the owner, undone')
  })

  it('the think of a proactive agent is a round with its header; without tools it may create one weekly automation', async () => {
    proactive({ tools: false })
    const r = mkResident()
    await fireSlot(r, at(11, 22))
    expect(runs()[0]!.heartbeat).toMatchObject({ kind: 'think', tools: false, perDay: 5 })
    const prompt = String(calls[0]!.prompt)
    expect(prompt).toContain('This is your heartbeat — your weekly think and a round of what your mission covers.')
    expect(prompt).toContain('You may also create ONE weekly automation of yours this week.')
  })

  it('a cut agent does no rounds: its heartbeat goes back to look (and skips an empty packet)', async () => {
    proactive()
    registry.update('finance', { cut: { at: at(7, 0).toISOString(), why: 'x' } })
    thought(at(8, 22))
    const r = mkResident()
    await fireSlot(r, at(11, 22))
    expect(calls).toHaveLength(0)
    expect(runs()[0]).toMatchObject({ status: 'skipped', heartbeat: { kind: 'look', tools: false, skipped: 'empty' } })
  })

  it("a round never skips for an empty packet (R5) — only with the day's count spent: `quota`", async () => {
    proactive({ perDay: 2 })
    thought(at(8, 22))
    const r = mkResident()
    await fireSlot(r, at(11, 22))
    expect(calls).toHaveLength(1)
    mission = { open: [], undone: [], madeToday: 2 }
    await fireSlot(r, at(14, 22))
    expect(runs()[0]).toMatchObject({ status: 'skipped', reason: quotaWords(2), heartbeat: { skipped: 'quota', kind: 'round' } })
    // something arrived: it runs
    facts = { ...empty(), messages: [{ id: 'm1', from: 'y', fromName: 'Y', text: 'hi', at: clock.getTime() }] }
    await fireSlot(r, at(17, 22))
    expect(calls).toHaveLength(2)
  })
})

describe('the skip order', () => {
  it("its share of the spend: past half the day's cap, rounds wait (`share`) and its tasks go on; «Let it continue today» lifts it", async () => {
    proactive()
    thought(at(8, 22))
    const r = mkResident({ wakesToday: () => ({ charged: 1, costUsd: 2.6, unpriced: 0 }) })
    await fireSlot(r, at(11, 22))
    expect(runs()[0]).toMatchObject({ status: 'skipped', reason: shareWords('FINANCE'), heartbeat: { skipped: 'share' } })
    registry.update('finance', { ownExemptDay: '2026-11-11' })
    await fireSlot(r, at(14, 22))
    expect(calls).toHaveLength(1)
  })

  it("the account's margin: any window at 85 % or more ⇒ `headroom` in its words — the 5-hour one or a weekly one", async () => {
    proactive()
    thought(at(8, 22))
    const r = mkResident()
    reading = fresh(88)
    await fireSlot(r, at(11, 22))
    expect(runs()[0]).toMatchObject({
      status: 'skipped',
      reason: headroomWords('FINANCE', { percent: 88, window: '5-hour' }),
      heartbeat: { skipped: 'headroom' },
    })
    expect(readsAsked).toBeGreaterThan(0)
    reading = fresh(91, 'weekly_scoped')
    await fireSlot(r, at(14, 22))
    expect(runs()[0]!.reason).toBe("FINANCE's account is at 91% of its weekly window — rounds wait so there is room for you")
    expect(calls).toHaveLength(0)
  })

  it('it fails CLOSED: without a fresh reading (by its hour, ≤ 15 min) a round waits — except the earliest slot of the local day', async () => {
    proactive()
    thought(at(1, 0))
    const r = mkResident()
    reading = { ok: true, at: at(4, 0).getTime(), windows: [] } // hours old
    // the earliest slot of the day (02:22 for every 3 hours from 08:22) runs all the same
    await fireSlot(r, at(2, 22))
    expect(calls).toHaveLength(1)
    await fireSlot(r, at(5, 22))
    expect(runs()[0]).toMatchObject({ status: 'skipped', reason: unreadableWords('FINANCE'), heartbeat: { skipped: 'headroom' } })
    reading = null
    await fireSlot(r, at(8, 22))
    expect(runs()[0]!.heartbeat?.skipped).toBe('headroom')
    expect(calls).toHaveLength(1)
  })

  it('a slot carried over from a previous day is no earliest slot of today: without a fresh reading it waits', async () => {
    proactive()
    thought(at(1, 0))
    const r = mkResident()
    reading = { ok: true, at: at(4, 0).getTime(), windows: [] } // hours old
    clock = at(0, 30, 12)
    await r.tick(clock)
    // yesterday's last slot (23:22), still due after midnight
    store.update(beat().id, { nextRunAt: at(23, 22).toISOString() })
    await r.tick(clock)
    await r.drain()
    expect(calls).toHaveLength(0)
    expect(runs()[0]).toMatchObject({ status: 'skipped', reason: unreadableWords('FINANCE'), heartbeat: { skipped: 'headroom' } })
    // today's own earliest slot (02:22) runs all the same
    await fireSlot(r, at(2, 22, 12))
    expect(calls).toHaveLength(1)
  })

  it('a provider that prices has no margin (its spend cap brakes it); one with no price and no reading: 12 rounds a day', async () => {
    proactive()
    thought(at(0, 0))
    account = { id: 'gw', priced: true, readable: false }
    reading = null
    const r = mkResident()
    await fireSlot(r, at(2, 22))
    expect(calls).toHaveLength(1)
    account = { id: 'oc', priced: false, readable: false }
    const day = heartbeatStore.state('finance').today!
    heartbeatStore.noteRun('finance', {
      id: 'pad',
      automationId: 'heartbeat-finance',
      at: at(3, 0).toISOString(),
      status: 'ok',
      heartbeat: { kind: 'round', packet: { keys: [] }, created: [], proposed: [], considered: 0 },
    })
    for (let i = 0; i < 10; i++)
      heartbeatStore.noteRun('finance', {
        id: `pad${i}`,
        automationId: 'heartbeat-finance',
        at: at(3, i).toISOString(),
        status: 'ok',
        heartbeat: { kind: 'round', packet: { keys: [] }, created: [], proposed: [], considered: 0 },
      })
    expect(day.day).toBe('2026-11-11')
    expect(heartbeatStore.turnsOfDay('finance', '2026-11-11').rounds).toBe(12)
    await fireSlot(r, at(5, 22))
    // its rounds and its think with a turn today: 12 rounds + the think
    expect(runs()[0]).toMatchObject({ status: 'skipped', reason: unmeasuredWords('FINANCE', 13), heartbeat: { skipped: 'headroom' } })
  })

  it("the account at its limit is the one the turn runs on (its reading), with today's words", async () => {
    proactive()
    thought(at(8, 22))
    reading = {
      ok: true,
      at: clock.getTime(),
      windows: [{ kind: 'session', label: '5h', percent: 100, windowMs: 5 * 3600_000, resetsAt: at(13, 0).toISOString(), active: true }],
    }
    const r = mkResident()
    await fireSlot(r, at(11, 22))
    // the instant rides apart: the words stop before it
    expect(runs()[0]).toMatchObject({
      status: 'skipped',
      reason: "FINANCE's account is at its usage limit — it does its round after",
      until: at(13, 0).toISOString(),
      heartbeat: { skipped: 'account' },
    })
  })

  it('a window at 100 % with no reset said is at its limit too: skipped, it goes at its next slot', async () => {
    proactive()
    thought(at(8, 22))
    reading = () => ({
      ok: true,
      at: clock.getTime(),
      windows: [{ kind: 'weekly', label: 'week', percent: 100, windowMs: 7 * 86_400_000, resetsAt: null, active: true }],
    })
    const r = mkResident()
    await fireSlot(r, at(11, 22))
    expect(calls).toHaveLength(0)
    expect(runs()[0]).toMatchObject({ status: 'skipped', heartbeat: { skipped: 'account' } })
    expect(runs()[0]).toMatchObject({ reason: "FINANCE's account is at its usage limit — it does its round at its next slot" })
    expect(runs()[0]!.until).toBeUndefined()
  })
})

describe('«Run now»', () => {
  it('a think, past its sleep; at the margin an honest 409 — without a fresh reading it runs (a gesture)', async () => {
    proactive()
    const r = mkResident()
    await r.tick(clock)
    reading = fresh(90)
    expect(await r.runNowManual(beat().id)).toEqual({ error: runNowMarginWords('FINANCE', { percent: 90, window: '5-hour' }), code: 409 })
    expect(calls).toHaveLength(0)
    reading = null
    expect(await r.runNowManual(beat().id)).toEqual({ ok: true })
    await r.drain()
    expect(calls).toHaveLength(1)
    expect(runs()[0]).toMatchObject({ status: 'ok', cause: 'manual', heartbeat: { kind: 'think', tools: true } })
  })
})

describe('the verdict reads the SEALED regime', () => {
  it('the owner turning the tools off mid-round changes nothing: the round sealed tools:true is audited as such', async () => {
    proactive({ tools: true })
    thought(at(8, 22))
    const seen: Array<{ tools?: boolean }> = []
    const audit: RunAudit = { readOutside: ['WebFetch'] }
    const r = mkResident({
      audit: async () => audit,
      afterAudit: (_a, _r, _au, o) => {
        seen.push(o)
      },
    })
    duringTurn = () => {
      registry.update('finance', { proactive: { perDay: 5, tools: false } })
    }
    await fireSlot(r, at(11, 22))
    await r.drain()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ heartbeat: true, tools: true })
    expect(runs()[0]).toMatchObject({ heartbeat: { tools: true }, audit })
  })
  it('…and the other way: a round sealed tools:false stays tools:false', async () => {
    proactive({ tools: false })
    thought(at(8, 22))
    const seen: Array<{ tools?: boolean }> = []
    const r = mkResident({
      audit: async () => ({ readOutside: ['WebFetch'] }),
      afterAudit: (_a, _r, _au, o) => {
        seen.push(o)
      },
    })
    duringTurn = () => {
      registry.update('finance', { proactive: { perDay: 5, tools: true } })
    }
    await fireSlot(r, at(11, 22))
    await r.drain()
    expect(seen[0]).toMatchObject({ tools: false })
  })
  it('a sleep asked in a round with its tools that read outside is bounded to 3 days', async () => {
    proactive({ tools: true })
    thought(at(8, 22))
    const far = new Date(at(11, 22).getTime() + 20 * 86_400_000).toISOString()
    const r = mkResident({ audit: async () => ({ readOutside: ['WebSearch'] }) })
    duringTurn = () => {
      registry.update('finance', { heartbeat: { sleepUntil: far } })
      const live = r.liveRunsOf('finance')[0]
      const run = live ? r.runOfTurn(live.turnId) : null
      if (run) r.noteSlept(run.runId, far)
    }
    await fireSlot(r, at(11, 22))
    await r.drain()
    const until = Date.parse(registry.get('finance')!.heartbeat!.sleepUntil!)
    expect(until).toBe(at(11, 22).getTime() + 3 * 86_400_000)
  })
})

// fires a slot without waiting for its turn to end (a held turn stays held)
async function startSlot(r: Resident, t: Date): Promise<void> {
  clock = t
  await r.tick(clock)
  store.update(beat().id, { nextRunAt: t.toISOString() })
  await r.tick(clock)
}

describe('a run is found BY ITS ID, never as the last line written', () => {
  it('a round in flight while its next slot writes a `busy` skip: its terminal row keeps its sealed regime, the audit judges tools:true, its state is noted', async () => {
    proactive({ tools: true })
    thought(at(8, 22))
    const seen: Array<{ tools?: boolean; heartbeat?: boolean }> = []
    const r = mkResident({
      audit: async () => ({ readOutside: ['WebFetch'] }),
      afterAudit: (_a, _r, _au, o) => {
        seen.push(o)
      },
    })
    holdTurns()
    await startSlot(r, at(11, 22))
    await until(() => gateReached)
    const round = runs()[0]!
    expect(round).toMatchObject({ status: 'running', heartbeat: { kind: 'round', tools: true } })
    // the next slot while the round still runs: a skip row is written after it
    await startSlot(r, at(14, 22))
    await until(() => runs().some((x) => x.status === 'skipped'))
    expect(runs()[0]).toMatchObject({ status: 'skipped', heartbeat: { skipped: 'busy' } })
    release()
    await r.drain()
    const closed = runs().find((x) => x.id === round.id)!
    expect(closed).toMatchObject({ status: 'ok', heartbeat: { kind: 'round', tools: true, perDay: 5 } })
    expect(seen).toEqual([expect.objectContaining({ heartbeat: true, tools: true })])
    const st = heartbeatStore.state('finance')
    expect(st.lastTurnAt).toBe(round.at)
    expect(st.today).toMatchObject({ rounds: 1, skipped: runs().filter((x) => x.status === 'skipped').length })
    // the newest run is still the skip: a re-write of an older run is never «the latest»
    expect(store.latestRun(beat().id)!.status).toBe('skipped')
  })

  it('a think started by «Run now» that sleeps mid-turn while a slot writes `sleeping`: its terminal row keeps its cause and its kind — the think is recorded as having had its turn', async () => {
    proactive()
    const r = mkResident()
    await r.tick(clock)
    holdTurns()
    duringTurn = () => {
      registry.update('finance', { heartbeat: { sleepUntil: at(9, 0, 13).toISOString() } })
    }
    expect(await r.runNowManual(beat().id)).toEqual({ ok: true })
    await until(() => gateReached)
    const think = runs()[0]!
    expect(think).toMatchObject({ status: 'running', cause: 'manual', heartbeat: { kind: 'think' } })
    // its next slot fires while the think still runs
    clock = at(14, 22)
    expect(await r.executeRun(beat())).toBe(true)
    expect(runs()[0]!.heartbeat?.skipped).toBe('sleeping')
    release()
    await r.drain()
    expect(runs().find((x) => x.id === think.id)).toMatchObject({ status: 'ok', cause: 'manual', heartbeat: { kind: 'think' } })
    const st = heartbeatStore.state('finance')
    expect(st.lastThinkTurnAt).toBe(think.at)
    expect(st.today?.thinks).toBe(1)
    // awake again the next day: a round, not another think
    registry.update('finance', { heartbeat: { sleepUntil: undefined } })
    await fireSlot(r, at(11, 22, 12))
    expect(runs()[0]!.heartbeat?.kind).toBe('round')
  })

  it('a restart with a round left `running` and a skip row after it closes the round interrupted and audits it by ITS seal', async () => {
    proactive({ tools: true })
    const id = heartbeatAutomationId('finance')
    const hb = { kind: 'round' as const, tools: true, perDay: 5, packet: { keys: [] }, created: [], proposed: [], considered: 0 }
    const r0 = mkResident()
    await r0.tick(clock)
    store.appendRun(id, {
      id: 'round-1',
      automationId: id,
      at: at(8, 22).toISOString(),
      status: 'running',
      startedAt: at(8, 22).toISOString(),
      sessionKey: 'f/s1',
      heartbeat: hb,
    })
    store.appendRun(id, {
      id: 'skip-1',
      automationId: id,
      at: at(11, 22).toISOString(),
      status: 'skipped',
      reason: 'busy',
      heartbeat: { ...hb, skipped: 'busy' },
    })
    r0.stop()
    const seen: Array<{ tools?: boolean }> = []
    // a fresh process: a cold store over the same files
    store = new AutomationsStore(dataDir)
    store.load()
    const r = mkResident({
      audit: async () => ({ readOutside: ['WebFetch'] }),
      afterAudit: (_a, _r, _au, o) => {
        seen.push(o)
      },
    })
    r.start()
    await r.drain()
    expect(runs().find((x) => x.id === 'round-1')).toMatchObject({
      status: 'failed',
      error: 'interrupted by a server restart',
      heartbeat: { tools: true },
      audit: { readOutside: ['WebFetch'] },
    })
    expect(seen).toEqual([expect.objectContaining({ tools: true })])
    expect(runs().filter((x) => x.status === 'running')).toEqual([])
  })
})

describe("the think's re-arm", () => {
  it('a think skipped by `headroom` is pending and re-armed after midnight; a skipped round never is', async () => {
    proactive()
    const r = mkResident()
    reading = fresh(95)
    await fireSlot(r, at(11, 22))
    expect(runs()[0]).toMatchObject({ status: 'skipped', heartbeat: { kind: 'think', skipped: 'headroom' } })
    expect(heartbeatStore.state('finance').pendingThink).toMatchObject({ why: 'headroom' })
    // a skipped round leaves nothing pending of its own
    reading = fresh(10)
    clock = at(0, 30, 12)
    // its next slot not yet due: only the re-arm fires
    store.update(beat().id, { nextRunAt: at(2, 22, 12).toISOString() })
    await r.tick(clock)
    await r.drain()
    expect(runs()[0]).toMatchObject({ cause: 'rearm', status: 'ok', heartbeat: { kind: 'think' } })
    expect(heartbeatStore.state('finance').pendingThink).toBeUndefined()
  })
  it('a think that FAILED is not repeated the same day: the next slot is a round', async () => {
    proactive()
    const hb0 = { kind: 'think' as const, packet: { keys: [] }, created: [], proposed: [], considered: 0 }
    heartbeatStore.noteRun('finance', { id: 'f1', automationId: 'heartbeat-finance', at: at(8, 22).toISOString(), status: 'running', heartbeat: hb0 })
    heartbeatStore.noteRun('finance', { id: 'f1', automationId: 'heartbeat-finance', at: at(8, 22).toISOString(), status: 'failed', heartbeat: hb0 })
    const r = mkResident()
    await fireSlot(r, at(11, 22))
    expect(runs()[0]!.heartbeat?.kind).toBe('round')
  })
})

describe('OpenCode: no rule of its own', () => {
  it("a round with its tools runs its runs' regime — the web on — and never a subagent; without, today's heartbeat", () => {
    const withTools = JSON.parse(
      configContent({ pluginPath: '/p', instructions: [], permission: null, provider: null, model: null, heartbeat: 'tools' }),
    ) as Record<string, Record<string, unknown>>
    expect(withTools.tools).toEqual({ task: false })
    expect(withTools.permission).toEqual({ task: 'deny' })
    const files = JSON.parse(configContent({ pluginPath: '/p', instructions: [], permission: null, provider: null, model: null, heartbeat: true })) as Record<
      string,
      Record<string, unknown>
    >
    expect(files.permission).toEqual({ webfetch: 'deny', websearch: 'deny', task: 'deny' })
  })
})

describe("the project's file rides every unattended turn", () => {
  it("what settings.local.json says rides the turn's settings layer — runs and wakes both ways, a round only what removes; an attended turn reads the file itself", async () => {
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(
      join(folder, '.claude', 'settings.local.json'),
      JSON.stringify({
        disabledMcpjsonServers: ['mail'],
        enabledPlugins: { 'drive@market': false, 'kept@market': true, 'notes@synced': false },
        deniedMcpServers: [{ serverName: 'claude.ai Drive' }],
        syncClaudeAiPlugins: false,
        syncClaudeAiSkills: false,
        disableClaudeAiConnectors: true,
        skillOverrides: { morning: 'off' },
      }),
    )
    const send = async (input: Parameters<ChatService['send']>[0]): Promise<void> => {
      for await (const _ of chat.send(input)) {
        /* drain */
      }
    }
    const isolation = { settingSources: ['user', 'project'] as Array<'user' | 'project' | 'local'>, disableAllHooks: true }
    await send({ turnId: 't1', agentId: 'finance', text: 'x', unattended: true, isolation, turn: { class: 'run', automationId: 'a1' } })
    await send({
      turnId: 't2',
      agentId: 'finance',
      text: 'x',
      unattended: true,
      isolation,
      turn: { class: 'heartbeat', kind: 'round', regime: { tools: true, perDay: 5 } },
    })
    await send({ turnId: 't4', agentId: 'finance', text: 'x', unattended: true, isolation, turn: { class: 'wake', taskKey: 'proj/tasks/tasks/t1' } })
    await send({ turnId: 't3', agentId: 'finance', text: 'x' })
    for (const i of [0, 1, 2]) {
      const s = opts(i).settings as Record<string, unknown>
      expect(s).toMatchObject({
        disabledMcpjsonServers: ['mail'],
        enabledPlugins: { 'drive@market': false, 'notes@synced': false },
        deniedMcpServers: [{ serverName: 'claude.ai Drive' }],
        syncClaudeAiPlugins: false,
        syncClaudeAiSkills: false,
        disableClaudeAiConnectors: true,
        skillOverrides: { morning: 'off' },
      })
      // a run and a wake load what the file turns on; a round never does (rule 14)
      expect((s.enabledPlugins as Record<string, boolean>)['kept@market']).toBe(i === 1 ? undefined : true)
    }
    const attended = (opts(3).settings as Record<string, unknown> | undefined) ?? {}
    for (const k of ['disabledMcpjsonServers', 'deniedMcpServers', 'syncClaudeAiPlugins', 'disableClaudeAiConnectors', 'skillOverrides'])
      expect(attended[k]).toBeUndefined()
    expect(opts(3).settingSources).toContain('local')
  })
})
