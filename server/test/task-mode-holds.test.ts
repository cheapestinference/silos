// task-mode-holds.test.ts — Task mode's holds: the stopped console (it was
// the it.todo «an open console that nobody types in holds the wakes of its
// task with no limit» in task-flow-invariant) and a read that fails never
// lets go of a hold. Task mode over a real store and a fake plans reading;
// generic fixtures only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskModeStore } from '../src/task-mode/store.js'
import { CONSOLE_BUSY, CONSOLE_UNSURE, ENGINE_UNREAD, LIMIT_RETRY_MS, TaskModeEngine, type TaskModeDeps } from '../src/task-mode/engine.js'
import { idleConsoleRows } from '../src/inbox.js'
import { CONVERSATION_BUSY_MS } from '../src/conversation-live.js'
import type { SiloReading } from '../src/silos/reader.js'

const T0 = Date.parse('2026-11-21T09:00:00Z')
const MIN = 60_000
const KEY = (id: string): string => `folder:/p/launch/tasks/${id}`

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-mode-holds-'))
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

// one queued wake of writer's on its task `a`, listed in conversation sess-a
// (the owner's Start, held at once by its open console); what holds it is set
// per pass
function world() {
  let now = T0
  // the console is open when the owner hands it over: the wake is queued
  let busy: string | null = CONSOLE_BUSY
  let refusal: (() => string | null) | null = null
  let limit: (() => string | null) | null = null
  const sent: string[] = []
  const store = new TaskModeStore(mkdtempSync(join(base, 'w-')))
  const deps: TaskModeDeps = {
    store,
    plans: () => ({ reading: readingOf([{ id: 'a', title: 'Ship', owner: 'writer', state: 'pending', dependsOn: [], notes: [], conversations: ['sess-a'] }]) }),
    bound: () => new Set(['writer']),
    ready: () => true,
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    conversationOf: (_a, ids) => (ids.length > 0 ? { sessionId: ids[ids.length - 1]!, folder: '-p' } : null),
    holdersOf: (_a, ids) => ids,
    busyWhy: () => busy,
    engineRefusal: () => (refusal ? refusal() : null),
    limitedUntil: () => (limit ? limit() : null),
    send: (i) => {
      sent.push(i.text)
      return { turnId: `turn-${sent.length}`, done: new Promise<void>(() => {}) }
    },
    nameOf: (id) => (id === 'writer' ? 'Writer' : id),
    // the kernel's word: its conversation is not live (the owner's Start goes)
    stalled: () => new Map([[KEY('a'), { cause: null, by: null, at: null, idle: false, waitsStart: false, live: false }]]),
    now: () => now,
  }
  const engine = new TaskModeEngine(deps)
  expect(engine.assign(KEY('a'), T0, { ownerGesture: true })).toMatchObject({ queued: true })
  return {
    engine,
    store,
    sent,
    pass: (at: number, o: { busy?: string | null; refusal?: (() => string | null) | null; limit?: (() => string | null) | null } = {}) => {
      now = at
      busy = o.busy ?? null
      refusal = o.refusal ?? null
      limit = o.limit ?? null
      engine.deliver(at)
      return store.wakes().find((w) => w.task === KEY('a'))!
    },
  }
}
const boom = (): never => {
  throw new Error('the read failed')
}

describe('a console hold names its conversation and its first pass, carried from pass to pass', () => {
  it('held by an open console: holdSession and heldSince written, heldSince kept on the next passes', () => {
    const w = world()
    expect(w.pass(T0, { busy: CONSOLE_BUSY })).toMatchObject({
      state: 'queued',
      holdClass: 'console',
      holdSession: 'sess-a',
      heldSince: new Date(T0).toISOString(),
    })
    expect(w.pass(T0 + 5 * MIN, { busy: CONSOLE_BUSY })).toMatchObject({ holdClass: 'console', holdSession: 'sess-a', heldSince: new Date(T0).toISOString() })
  })
  it('a pass that stops earlier — at the engine, at the limit — carries both; the console again keeps the first moment', () => {
    const w = world()
    w.pass(T0, { busy: CONSOLE_BUSY })
    expect(w.pass(T0 + MIN, { refusal: () => 'too old' })).toMatchObject({ holdClass: 'engine', holdSession: 'sess-a', heldSince: new Date(T0).toISOString() })
    expect(w.pass(T0 + 2 * MIN, { limit: () => new Date(T0 + 60 * MIN).toISOString() })).toMatchObject({
      holdClass: 'limit',
      holdSession: 'sess-a',
      heldSince: new Date(T0).toISOString(),
    })
    expect(w.pass(T0 + 70 * MIN, { busy: CONSOLE_BUSY })).toMatchObject({ holdClass: 'console', heldSince: new Date(T0).toISOString() })
  })
  it('a console probe that FAILED holds it all the same, with no holdSession (never «open»); heldSince stays', () => {
    const w = world()
    w.pass(T0, { busy: CONSOLE_BUSY })
    const unsure = w.pass(T0 + MIN, { busy: CONSOLE_UNSURE })
    expect(unsure).toMatchObject({ holdClass: 'console', heldSince: new Date(T0).toISOString() })
    expect(unsure.holdSession).toBeUndefined()
  })
  it('any other decision clears them: a turn on it, then the delivery', () => {
    const w = world()
    w.pass(T0, { busy: CONSOLE_BUSY })
    const turn = w.pass(T0 + MIN, { busy: 'a turn is running on its conversation' })
    expect(turn.holdClass).toBe('turn')
    expect([turn.heldSince, turn.holdSession]).toEqual([undefined, undefined])
    w.pass(T0 + 2 * MIN, { busy: CONSOLE_BUSY })
    const out = w.pass(T0 + 3 * MIN)
    expect(out.state).toBe('delivered')
    expect([out.heldSince, out.holdSession]).toEqual([undefined, undefined])
  })
  it("the store alone feeds Needs you's row: past CONVERSATION_BUSY_MS with its thread not live, one row for that conversation", () => {
    const w = world()
    w.pass(T0, { busy: CONSOLE_BUSY })
    const at = T0 + CONVERSATION_BUSY_MS + MIN
    w.pass(at, { busy: CONSOLE_BUSY })
    const rows = idleConsoleRows(w.engine.queuedWakes(), {
      threadLive: () => false,
      busyMs: CONVERSATION_BUSY_MS,
      sessionOf: () => ({ title: 'Launch', folder: '/p' }),
      nameOf: (id) => (id === 'writer' ? 'Writer' : id),
      now: at,
    })
    expect(rows).toMatchObject([
      {
        kind: 'consoleIdle',
        urgency: 'due',
        session: { id: 'sess-a', folder: '/p', title: 'Launch' },
        count: 1,
        voice: "Writer's console on «Launch» is open and idle — 1 wake waits for it",
        ack: { kind: 'consoleIdle', key: 'sess-a', version: new Date(T0).toISOString() },
      },
    ])
  })
})

describe('a read that fails never lets go of a hold', () => {
  it('limit: a failed read keeps a limit hold still ahead, bounded by its own until', () => {
    const w = world()
    const until = T0 + 30 * MIN
    expect(w.pass(T0, { limit: () => new Date(until).toISOString() })).toMatchObject({ holdClass: 'limit', until: new Date(until).toISOString() })
    expect(w.pass(T0 + 5 * MIN, { limit: boom })).toMatchObject({ state: 'queued', holdClass: 'limit', until: new Date(until).toISOString() })
    expect(w.pass(until + MIN, { limit: boom }).state).toBe('delivered')
  })
  it("engine: a failed read keeps an engine hold at most LIMIT_RETRY_MS from the first failure, said «couldn't read its engine»; then it goes", () => {
    const w = world()
    expect(w.pass(T0, { refusal: () => 'too old' })).toMatchObject({ holdClass: 'engine' })
    const kept = w.pass(T0 + MIN, { refusal: boom })
    expect(kept).toMatchObject({ state: 'queued', holdClass: 'engine', engineUnreadSince: new Date(T0 + MIN).toISOString() })
    expect(kept.held).toContain(ENGINE_UNREAD)
    expect(w.pass(T0 + 5 * MIN, { refusal: boom })).toMatchObject({ holdClass: 'engine', engineUnreadSince: new Date(T0 + MIN).toISOString() })
    expect(w.pass(T0 + MIN + LIMIT_RETRY_MS, { refusal: boom }).state).toBe('delivered')
  })
  it('engine: the engine answering clears engineUnreadSince; a failed read with no engine hold before changes nothing', () => {
    const w = world()
    w.pass(T0, { refusal: () => 'too old' })
    w.pass(T0 + MIN, { refusal: boom })
    expect(w.pass(T0 + 2 * MIN, { refusal: () => 'too old' }).engineUnreadSince).toBeUndefined()
    const fresh = world()
    expect(fresh.pass(T0, { refusal: boom }).state).toBe('delivered')
  })
})
