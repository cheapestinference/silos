// task-live.test.ts — the task's live line, server half:
// what TaskModeEngine.liveOf says is happening to
// a start on a task RIGHT NOW — the turns in flight (started or not), a wake
// held by the agent's own live cap or by the fleet's, a start that did not
// start (with the engine's door), any other hold in its words, or nothing.
// The web's give.ts liveLine says the words; this pins the facts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskModeStore } from '../src/task-mode/store.js'
import { CONSOLE_BUSY, ENGINE_HOLD, TaskModeEngine, localDay, type TaskModeDeps, type TaskTurnEnd } from '../src/task-mode/engine.js'
import { TurnSlots } from '../src/turn-slots.js'
import { OWN_TURNS_PER_DAY } from '../src/limits.js'
import type { SiloReading } from '../src/silos/reader.js'

const T0 = Date.parse('2026-11-11T09:00:00Z')
const KEY = (id: string): string => `folder:/p/launch/tasks/${id}`

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-live-'))
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

function world(opts: { slots?: TurnSlots; engineRefusal?: () => string | null; busy?: (id: string) => string | null } = {}) {
  const now = T0
  let tasks: Array<Record<string, unknown>> = []
  const ends: Array<(e: TaskTurnEnd) => void> = []
  const started: Array<() => void> = []
  const store = new TaskModeStore(mkdtempSync(join(base, 'w-')), () => {})
  const deps: TaskModeDeps = {
    store,
    plans: () => ({ reading: readingOf(tasks) }),
    bound: () => new Set(['writer', 'reader']),
    ready: () => true,
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    conversationOf: () => null,
    holdersOf: (_a, ids) => ids,
    busyWhy: (id) => opts.busy?.(id) ?? null,
    send: (i) => {
      i.onSession(`sess-${ends.length + 1}`)
      let end!: (e: TaskTurnEnd) => void
      const done = new Promise<TaskTurnEnd>((r) => {
        end = r
      })
      ends.push(end)
      started.push(() => i.onStarted?.())
      return { turnId: `turn-${ends.length}`, done }
    },
    ownToday: (agent, at) => ({
      used: store.usedToday(agent, localDay(at)),
      costUsd: 0,
      unpriced: 0,
      ceiling: OWN_TURNS_PER_DAY,
      spendCap: 1000,
      exempt: false,
    }),
    nameOf: (id) => (id === 'writer' ? 'Writer' : id),
    ...(opts.slots ? { slots: opts.slots } : {}),
    ...(opts.engineRefusal ? { engineRefusal: opts.engineRefusal } : {}),
    now: () => now,
  }
  const engine = new TaskModeEngine(deps)
  return {
    engine,
    store,
    ends,
    started,
    set: (x: Array<Record<string, unknown>>) => {
      tasks = x
    },
  }
}
const live = (w: ReturnType<typeof world>, id: string) => w.engine.view(KEY(id))!.live

describe('the live line, server half (liveOf)', () => {
  it('nothing on its way: null', () => {
    const w = world()
    w.set([t('t1')])
    expect(live(w, 't1')).toBeNull()
  })

  it("the owner's Give hands it to a turn: running, not started → started at its first output", async () => {
    const w = world()
    w.set([t('t1')])
    expect(w.engine.assign(KEY('t1'), T0, { ownerGesture: true })).toEqual({ queued: true })
    expect(live(w, 't1')).toEqual({ kind: 'running', turns: [{ turnId: 'turn-1', sessionId: null, started: false, agent: 'writer' }] }) // the turn names its agent
    w.started[0]!()
    expect(live(w, 't1')).toMatchObject({ kind: 'running', turns: [{ turnId: 'turn-1', started: true }] })
    w.ends[0]!({ started: true, costUsd: 0.01 })
    await new Promise((r) => setTimeout(r, 0))
    expect(live(w, 't1')).toBeNull()
  })

  it("held by the agent's own live cap: queued · agent, with how many run — and by the fleet's: queued · global", () => {
    const slots = new TurnSlots({ now: () => T0, agentMax: 1, globalMax: 2 })
    const w = world({ slots })
    w.set([t('t1'), t('t2'), t('t3', { owner: 'reader' }), t('t4', { owner: 'reader' })])
    w.engine.assign(KEY('t1'), T0, { ownerGesture: true })
    // the writer runs one thing: its second waits on its own cap
    expect(w.engine.assign(KEY('t2'), T0, { ownerGesture: true })).toMatchObject({
      queued: true,
      held: 'Writer is running 1 thing already — it starts when one ends',
    })
    expect(live(w, 't2')).toEqual({ kind: 'queued', cap: 'agent', running: 1 })
    // another agent takes the fleet's last slot; then the fleet is full
    w.engine.assign(KEY('t3'), T0, { ownerGesture: true })
    w.engine.assign(KEY('t4'), T0, { ownerGesture: true })
    expect(live(w, 't4')).toEqual({ kind: 'queued', cap: 'agent', running: 1 })
    const fleet = world({ slots: new TurnSlots({ now: () => T0, agentMax: 5, globalMax: 1 }) })
    fleet.set([t('t1'), t('t3', { owner: 'reader' })])
    fleet.engine.assign(KEY('t1'), T0, { ownerGesture: true })
    fleet.engine.assign(KEY('t3'), T0, { ownerGesture: true })
    expect(live(fleet, 't3')).toEqual({ kind: 'queued', cap: 'global', running: 1 })
  })

  it('a start that did not start: failed, in its words — an engine refusal carries its door', async () => {
    const w = world()
    w.set([t('t1')])
    w.engine.assign(KEY('t1'), T0, { ownerGesture: true })
    w.ends[0]!({ started: false, error: 'spawn claude ENOENT' })
    await new Promise((r) => setTimeout(r, 0))
    expect(live(w, 't1')).toEqual({ kind: 'failed', why: 'its turn could not start (1 try): spawn claude ENOENT — Silos tries again' })
    const r = world({ engineRefusal: () => 'Claude Code 2.0.1 is older than the minimum' })
    r.set([t('t1')])
    r.engine.assign(KEY('t1'), T0, { ownerGesture: true })
    expect(live(r, 't1')).toEqual({
      kind: 'failed',
      engine: true,
      why: `${ENGINE_HOLD}: Claude Code 2.0.1 is older than the minimum — it goes once the engine is updated`,
    })
    const refused = world()
    refused.set([t('t1')])
    refused.engine.assign(KEY('t1'), T0, { ownerGesture: true })
    refused.ends[0]!({ started: false, refused: 'missing' })
    await new Promise((x) => setTimeout(x, 0))
    expect(live(refused, 't1')).toMatchObject({ kind: 'failed', engine: true })
  })

  it('an open console holds its conversation: console — yours, no Stop; a turn of another kind holds nothing here', () => {
    const w = world({ busy: (id) => (id === 'sess-console' ? CONSOLE_BUSY : null) })
    w.set([t('t1', { state: 'in_progress', conversations: [{ session: 'sess-console' }] })])
    expect(live(w, 't1')).toEqual({ kind: 'console', sessionId: 'sess-console' })
    const chat = world({ busy: () => 'a turn is running on its conversation' })
    chat.set([t('t1', { state: 'in_progress', conversations: [{ session: 'sess-x' }] })])
    expect(live(chat, 't1')).toBeNull()
  })
})
