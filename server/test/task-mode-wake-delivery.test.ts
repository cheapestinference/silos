// task-mode-wake-delivery.test.ts — delivery of Task mode wakes:
//   - a refused engine HOLDS a wake: nothing sent, no attempt counted; it
//     goes the moment the engine reads ok
//   - a wake whose turn can't start is retried with a backoff, and after
//     START_ATTEMPTS_MAX it is a subject of the escalation (once), a
//     stalled wake that never started included
//   - a wake turn that ended without saying its price (a restart cut it)
//     is never «running» all day: unpriced
//   - the store never drops a queued wake; the throttle is pruned
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskModeStore, WAKES_KEEP, WAKE_KEEP_MS, type Wake } from '../src/task-mode/store.js'
import { START_ATTEMPTS_MAX, TaskModeEngine, type TaskModeDeps, type TaskTurnEnd } from '../src/task-mode/engine.js'
import { EscalationEngine } from '../src/escalation/engine.js'
import { ENGINE_RETRY_MS } from '../src/harness-run.js'
import { EscalationStore } from '../src/escalation/store.js'
import type { SiloReading } from '../src/silos/reader.js'

const T0 = Date.parse('2026-11-03T09:00:00Z')
const MIN = 60_000
const KEY = (id: string): string => `folder:/p/launch/tasks/${id}`

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tm-rev0911b-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function readingOf(tasks: Array<Record<string, unknown>>): SiloReading {
  return {
    records: [
      {
        silo: 'plans',
        kind: 'plan',
        source: 'plans',
        file: '/p/plans/launch.plan.json',
        rel: 'plans/launch.plan.json',
        location: 'folder:/p',
        anchors: {},
        mtimeMs: 0,
        raw: {},
        record: { id: 'launch', title: 'L', tasks },
        remarks: [],
        partial: [],
      },
    ],
    unreadable: [],
    problems: [],
    sources: {},
    lastWrite: null,
  } as unknown as SiloReading
}

type Turn = { text: string; origin?: { task: string; ref: string }; started?: () => void; end: (r?: TaskTurnEnd) => Promise<void>; fail: () => Promise<void> }

function world(opts: { engineRefusal?: () => string | null; stalled?: () => Map<string, { cause: string; by: string | null }>; store?: TaskModeStore } = {}) {
  let now = T0
  let tasks: Array<Record<string, unknown>> = []
  const turns: Turn[] = []
  const store = opts.store ?? new TaskModeStore(base)
  const deps: TaskModeDeps = {
    store,
    plans: () => ({ reading: readingOf(tasks) }),
    bound: () => new Set(['writer']),
    ready: () => true,
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    appendNote: () => ({ ok: true }),
    conversationOf: (_a, ids) => (ids.length > 0 ? { sessionId: ids[ids.length - 1]!, folder: '-p' } : null),
    holdersOf: (_a, ids) => ids,
    busyWhy: () => null,
    send: (i) => {
      let resolve!: (r?: TaskTurnEnd) => void
      let reject!: (e: unknown) => void
      const done = new Promise<void | TaskTurnEnd>((r, j) => {
        resolve = r
        reject = j
      })
      const tick = () => new Promise((x) => setTimeout(x, 0))
      turns.push({
        text: i.text,
        ...(i.origin ? { origin: i.origin } : {}),
        ...(i.onStarted ? { started: i.onStarted } : {}),
        end: async (r) => {
          resolve(r)
          await tick()
        },
        fail: async () => {
          reject(new Error('boom'))
          await tick()
        },
      })
      return { turnId: `turn-${turns.length}`, done }
    },
    ...(opts.engineRefusal ? { engineRefusal: opts.engineRefusal } : {}),
    ...(opts.stalled ? { stalled: opts.stalled } : {}),
    nameOf: (id) => (id === 'writer' ? 'Writer' : id),
    now: () => now,
  }
  const engine = new TaskModeEngine(deps)
  return {
    engine,
    store,
    turns,
    set: (t: Array<Record<string, unknown>>) => {
      tasks = t
    },
    at: (ms: number) => {
      now = ms
    },
  }
}
const t = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Task ${id}`,
  owner: 'writer',
  state: 'pending',
  dependsOn: [],
  notes: [],
  conversations: [],
  ...over,
})
const ownerNote = (text: string) => ({ at: new Date(T0).toISOString(), by: 'owner', text })

describe('a refused engine holds the wake, spending nothing', () => {
  it('known up front: held, never sent, no attempt; sent once the engine reads ok', () => {
    let refusal: string | null = 'Claude Code 2.0.1 is older than Silos needs (2.1.300) — update it: claude update'
    const w = world({ engineRefusal: () => refusal })
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    expect(w.turns).toEqual([])
    const q = w.store.queued()[0]!
    expect(q.held).toMatch(/^its engine can't run: Claude Code 2\.0\.1 is older/)
    expect(q.attempts).toBeUndefined()
    expect(w.engine.today('writer').woke).toBe(0)
    refusal = null
    w.at(T0 + 30_000)
    w.engine.deliver()
    expect(w.turns).toHaveLength(1)
  })

  it('refused at send time: back in the queue, no attempt counted, retried after ENGINE_RETRY_MS', async () => {
    const w = world()
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    await w.turns[0]!.end({ started: false, costUsd: null, refused: 'Claude Code is missing' })
    expect(w.store.queued()[0]).toMatchObject({ attempts: 0, until: new Date(T0 + ENGINE_RETRY_MS).toISOString() })
    expect(w.store.queued()[0]!.held).toMatch(/its engine can't run: Claude Code is missing/)
    w.at(T0 + ENGINE_RETRY_MS - 1)
    w.engine.deliver()
    expect(w.turns).toHaveLength(1)
    w.at(T0 + ENGINE_RETRY_MS + 1)
    w.engine.deliver()
    expect(w.turns).toHaveLength(2)
    expect(w.store.queued()).toEqual([])
  })

  it('a wake turn carries its task as the origin of the conversation it opens', () => {
    const w = world()
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    expect(w.turns[0]!.origin).toEqual({ task: KEY('t1'), ref: 'launch#t1' })
  })
})

describe("a wake that can't start is bounded, then escalates once", () => {
  async function failStarts(w: ReturnType<typeof world>, n: number): Promise<number> {
    let at = T0
    for (let i = 0; i < n; i++) {
      const turn = w.turns[w.turns.length - 1]!
      await turn.end({ started: false, costUsd: null, error: 'provider credential revoked' })
      at += 2 * 3600_000
      w.at(at)
      w.engine.deliver()
    }
    return at
  }

  it(`after ${START_ATTEMPTS_MAX} failed starts the task is a subject (cannotStart) — still queued and retried; a start clears it`, async () => {
    const w = world()
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    await failStarts(w, START_ATTEMPTS_MAX - 1)
    expect(w.engine.cannotStart()).toEqual([])
    const turn = w.turns[w.turns.length - 1]!
    await turn.end({ started: false, costUsd: null, error: 'provider credential revoked' })
    const q = w.store.queued()[0]!
    expect(q.attempts).toBe(START_ATTEMPTS_MAX)
    expect(q.gaveUp).toMatchObject({ error: 'provider credential revoked' })
    expect(q.held).toMatch(/Silos asked for help, and keeps trying/)
    const subjects = w.engine.cannotStart()
    expect(subjects.map((s) => [s.task.key, s.attempts, s.error])).toEqual([[KEY('t1'), START_ATTEMPTS_MAX, 'provider credential revoked']])
    // still retried (at the backoff's ceiling); a turn that starts clears it
    w.at(T0 + 48 * 3600_000)
    w.engine.deliver()
    w.turns[w.turns.length - 1]!.started!()
    expect(w.store.wakes()[0]!.gaveUp).toBeUndefined()
    expect(w.engine.cannotStart()).toEqual([])
  })

  it('a refused engine or a usage limit never counts toward the bound', async () => {
    const w = world()
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    let at = T0
    for (let i = 0; i < START_ATTEMPTS_MAX + 2; i++) {
      if (i > 0) {
        at += 2 * 3600_000
        w.at(at)
        w.engine.deliver()
      }
      await w.turns[w.turns.length - 1]!.end(i % 2 === 0 ? { started: false, refused: 'Claude Code is missing' } : { started: false, limitedUntil: null })
    }
    expect(w.turns).toHaveLength(START_ATTEMPTS_MAX + 2)
    expect(w.store.queued()[0]!.attempts).toBe(0)
    expect(w.engine.cannotStart()).toEqual([])
  })

  it("the escalation opens ONE case for it — «Silos could not start Writer's turn», never «one wake changed nothing»", async () => {
    const w = world({ stalled: () => new Map([[KEY('t1'), { cause: 'in-progress-nothing-live', by: 't1', at: 't1' }]]) })
    w.set([t('t1', { state: 'in_progress' })])
    w.engine.look()
    w.at(T0 + 30_000)
    w.engine.look()
    expect(w.turns).toHaveLength(1) // the stalled wake
    let at = T0 + 30_000
    for (let i = 0; i < START_ATTEMPTS_MAX; i++) {
      if (i > 0) {
        at += 2 * 3600_000
        w.at(at)
        w.engine.deliver()
      }
      await w.turns[w.turns.length - 1]!.end({ started: false, error: 'API Error: 401' })
    }
    expect(w.turns).toHaveLength(START_ATTEMPTS_MAX)
    expect(w.engine.retryFailed()).toEqual([]) // it never started: no «changed nothing»
    const notes: string[] = []
    const msgs: string[] = []
    const e = new EscalationEngine({
      store: new EscalationStore(join(base, 'esc')),
      taskMode: { tasks: (n) => w.engine.tasks(n), retryFailed: (n, ts) => w.engine.retryFailed(n, ts), cannotStart: (n, ts) => w.engine.cannotStart(n, ts) },
      chain: () => ({ installed: true, up: (a) => (a === 'writer' ? ['builder'] : []) }),
      isAgent: () => true,
      nameOf: (id) => (id === 'writer' ? 'Writer' : id),
      setField: () => ({ ok: true }),
      appendNote: (_k, text) => {
        notes.push(text)
        return { ok: true }
      },
      message: (_to, text) => {
        msgs.push(text)
      },
      now: () => at,
    })
    e.tick(at)
    e.tick(at + MIN)
    expect(Object.keys(e.store.cases())).toEqual([`task:${KEY('t1')}`])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/^stuck: Silos could not start Writer's turn on it \(5 tries: API Error: 401\)\./)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatch(/Silos could not get Writer working on it/)
  })
})

describe('a wake turn that ended unpriced is not «running»', () => {
  it('a turn whose end never said its price (its promise failed) reads unpriced at the next delivery', async () => {
    const w = world()
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    w.turns[0]!.started!()
    await w.turns[0]!.fail()
    w.engine.deliver()
    expect(w.engine.today('writer')).toMatchObject({ running: 0, unpriced: 1 })
  })

  it('a restart: a started wake whose turn this process never ran is settled unpriced, never running', async () => {
    const w = world()
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    w.turns[0]!.started!()
    expect(w.engine.today('writer').running).toBe(1)
    // the process dies before the turn's end: a new engine over the same state
    const w2 = world({ store: new TaskModeStore(base) })
    w2.set([t('t1', { notes: [ownerNote('go')] })])
    w2.engine.deliver()
    expect(w2.engine.today('writer')).toMatchObject({ running: 0, unpriced: 1 })
    expect(w2.store.wakes()[0]).toMatchObject({ state: 'delivered', costUsd: null })
  })
})

describe('a wake turn on a plan is no money for the spend cap', () => {
  it("its notional cost stays out of wakesToday and its null is no «unpriced»; a key's cost counts", () => {
    const w = world()
    const iso = new Date(T0).toISOString()
    const mk = (i: number, over: Partial<Wake>): Wake =>
      ({
        id: `w${i}`,
        agent: 'writer',
        task: KEY(`t${i}`),
        ref: `l#t${i}`,
        title: 't',
        reason: 'stall',
        says: 's',
        at: iso,
        state: 'delivered',
        via: 'wake',
        deliveredAt: iso,
        startedAt: iso,
        turnId: `turn-${i}`,
        notes: [],
        bypassThrottle: false,
        ...over,
      }) as Wake
    w.store.update((s) => {
      s.wakes.push(
        mk(1, { costUsd: 3, priced: false }),
        mk(2, { costUsd: null, priced: false }),
        mk(3, { costUsd: 0.25, priced: true }),
        mk(4, { costUsd: null, priced: true }),
      )
    })
    const d = new Date(T0)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(w.engine.wakesToday('writer', day)).toMatchObject({ charged: 4, costUsd: 0.25, unpriced: 1 })
    expect(w.engine.today('writer', T0)).toMatchObject({ unpriced: 1 })
  })
})

describe('the store never drops a queued wake', () => {
  it('more queued wakes than WAKES_KEEP all survive; the settled history keeps its last WAKES_KEEP', () => {
    const store = new TaskModeStore(base)
    const mk = (i: number, state: Wake['state']): Wake => ({
      id: `w${i}`,
      agent: 'writer',
      task: KEY(`t${i}`),
      ref: `l#t${i}`,
      title: 't',
      reason: 'owner-note',
      says: 's',
      at: new Date(T0 + i).toISOString(),
      state,
      notes: [],
      bypassThrottle: false,
    })
    store.update((s) => {
      for (let i = 0; i < WAKES_KEEP + 50; i++) s.wakes.push(mk(i, 'queued'))
      for (let i = 0; i < WAKES_KEEP + 50; i++) s.wakes.push(mk(10_000 + i, 'delivered'))
    }, T0 + 1000)
    expect(store.queued()).toHaveLength(WAKES_KEEP + 50)
    expect(store.wakes().filter((w) => w.state === 'delivered')).toHaveLength(WAKES_KEEP)
    // and they survive a reload
    expect(new TaskModeStore(base).queued()).toHaveLength(WAKES_KEEP + 50)
  })

  it('a throttle nobody woke within WAKE_KEEP_MS is pruned; a recent one stays', () => {
    const store = new TaskModeStore(base)
    store.update((s) => {
      s.throttle['writer|old'] = { lastFp: 'a', streak: 3, lastAt: new Date(T0 - WAKE_KEEP_MS - 1).toISOString() }
      s.throttle['writer|new'] = { lastFp: 'b', streak: 1, lastAt: new Date(T0 - 3600_000).toISOString() }
    }, T0)
    expect(store.throttleOf('writer', 'old')).toEqual({ lastFp: null, streak: 0, lastAt: null })
    expect(store.throttleOf('writer', 'new').streak).toBe(1)
  })
})
