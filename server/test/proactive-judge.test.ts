// proactive-judge.test.ts — the proactive mode's judge: one source for append-item and the plan file — the
// root, the day's count, the open cap, the literal duplicate, a round's
// creation is ITS own and waits on nobody, a message of its own is no
// signal, the second generation spends the count (in a wake and through a
// message), recurring work of its own, and the end-of-turn verdict by the
// SEALED `tools` (false: undo + cut; true: mark, never undo nor cut; the
// owner's credential cuts in both).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CreationsStore, type Creation } from '../src/creations.js'
import type { Automation } from '../src/automations-types.js'
import type { Cut } from '../src/control.js'
import { Initiative, selfRecurrentWeekWords } from '../src/initiative.js'
import type { LiveTurn } from '../src/live-turns.js'
import { PlansOrigins, type Candidate } from '../src/plans-origins.js'
import { PlansProvenance, judgeCreation, type JudgeTurn, type PlansSnapshot, type TaskView } from '../src/plans-provenance.js'
import {
  OWN_MESSAGE_NO_SIGNAL,
  ROUND_RECURRING_PROPOSED,
  ROUND_TASK_IS_YOURS,
  ROUND_TASK_NO_WAIT,
  dayMaxWakeWords,
  dayMaxWords,
  duplicateOpenWords,
  duplicateUndoneWords,
  missionOpen,
  missionUndone,
  openMaxWords,
} from '../src/proactive.js'
import { PROACTIVE_OPEN_MAX } from '../src/limits.js'
import { MessageStore, parseMessage } from '../src/messages.js'
import { TaskCancellations } from '../src/task-cancellations.js'
import { noteReopenRefused } from '../src/proactive.js'
import { agentMayWrite } from '../src/agent-authz.js'

const NOW = new Date(2026, 10, 11, 14, 0).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pro-judge-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const K = (id: string): string => `proj/tasks/tasks/${id}`
const round = (over: Partial<JudgeTurn> = {}): JudgeTurn => ({
  class: 'heartbeat',
  unattended: true,
  kind: 'round',
  packetKeys: ['message:m1'],
  regime: { tools: true, perDay: 2 },
  ...over,
})
const made = (over: Partial<Creation>): Creation => ({
  id: `c${Math.random()}`,
  kind: 'task',
  ref: K('o'),
  title: 'o',
  createdAt: iso(NOW - 3600_000),
  by: 'x',
  ...over,
})
const base = { agent: { id: 'x', name: 'X' }, ledger: [] as Creation[], now: NOW, openTask: () => true, selfRecurrentLive: 0 }

describe('judgeCreation — the proactive regime', () => {
  it('`mission` holds in a round and a think, never in a look', () => {
    expect(judgeCreation({ ...base, turn: round(), signal: 'mission' })).toMatchObject({ ok: true, mission: true, root: 'mission' })
    expect(judgeCreation({ ...base, turn: round({ kind: 'look', regime: undefined }), signal: 'mission' })).toMatchObject({ ok: false, code: 403 })
  })
  it("the day's count: mission-rooted creations made today ≤ perDay — an undo gives nothing back; the API and the file note say the same", () => {
    const ledger = [made({ root: 'mission' }), made({ root: 'mission', undoneAt: iso(NOW) })]
    const v = judgeCreation({ ...base, ledger, turn: round(), signal: 'mission' })
    expect(v).toMatchObject({ ok: false, code: 429, error: dayMaxWords(2), note: `Silos cancelled it: ${dayMaxWords(2)}` })
    // yesterday's do not count; a refusal never existed
    const old = [made({ root: 'mission', createdAt: iso(NOW - 2 * 86_400_000) }), made({ root: 'mission', rejected: { at: iso(NOW), why: 'x' } })]
    expect(judgeCreation({ ...base, ledger: old, turn: round(), signal: 'mission' })).toMatchObject({ ok: true })
    // a taint undo is an undo: it still counts
    const tainted = [
      made({ root: 'mission', rejected: { at: iso(NOW), why: 'Undone by Silos: created after reading outside (WebFetch)' } }),
      made({ root: 'mission' }),
    ]
    expect(judgeCreation({ ...base, ledger: tainted, turn: round(), signal: 'mission' })).toMatchObject({ ok: false, code: 429 })
  })
  it("its own recurring work (an automation with root mission) never spends the day's count nor counts as open", () => {
    const ledger = [made({ kind: 'automation', ref: 'auto-1', root: 'mission', signal: 'mission' }), made({ root: 'mission' })]
    expect(judgeCreation({ ...base, ledger, turn: round(), signal: 'mission', task: { title: 'new' } })).toMatchObject({ ok: true })
    expect(judgeCreation({ ...base, ledger: [...ledger, made({ root: 'mission' })], turn: round(), signal: 'mission', task: { title: 'new' } })).toMatchObject({
      ok: false,
      code: 429,
      error: dayMaxWords(2),
    })
  })
  it('the open cap counts its open TASKS with root mission', () => {
    const ledger = Array.from({ length: PROACTIVE_OPEN_MAX }, (_, i) =>
      made({ root: 'mission', ref: K(`o${i}`), title: `o${i}`, createdAt: iso(NOW - 3 * 86_400_000) }),
    )
    const v = judgeCreation({ ...base, ledger, turn: round({ regime: { tools: true, perDay: 50 } }), signal: 'mission', task: { title: 'new' } })
    expect(v).toMatchObject({ ok: false, code: 429, error: openMaxWords(PROACTIVE_OPEN_MAX) })
  })
  it('on a round, a mission creation is ITS task (403) and waits on nobody (400)', () => {
    expect(judgeCreation({ ...base, turn: round(), signal: 'mission', task: { title: 'a', owner: 'y' } })).toMatchObject({
      ok: false,
      code: 403,
      error: ROUND_TASK_IS_YOURS,
      note: `Silos cancelled it: ${ROUND_TASK_IS_YOURS}`,
    })
    expect(
      judgeCreation({ ...base, turn: round(), signal: 'mission', task: { title: 'a', owner: 'x', waitingOn: { owner: 'owner', asked: '?' } } }),
    ).toMatchObject({ ok: false, code: 400, error: ROUND_TASK_NO_WAIT })
    // a reactive creation for another agent stays the normal path (R8)
    expect(judgeCreation({ ...base, turn: round(), signal: 'message:m1', task: { title: 'a', owner: 'y' } })).toMatchObject({ ok: true })
  })
  it('a literal duplicate of an open one or an undone one (trimmed, case-insensitive), against the WHOLE ledger', () => {
    const ledger = [
      made({ root: 'mission', ref: K('o1'), title: 'Renew the domain' }),
      made({ root: 'mission', ref: K('u1'), title: 'Email the bank', undoneAt: iso(NOW - 86_400_000) }),
    ]
    const taskNow = (k: string) =>
      k === K('o1')
        ? { status: 'pending', title: 'Renew the domain', ref: 'proj#o1' }
        : k === K('u1')
          ? { status: 'cancelled', title: 'Email the bank', ref: 'proj#u1' }
          : null
    const j = (title: string) =>
      judgeCreation({
        ...base,
        ledger,
        turn: round({ regime: { tools: true, perDay: 10 } }),
        signal: 'mission',
        task: { title },
        taskNow,
        openTask: (r) => r === K('o1'),
      })
    expect(j('  renew THE domain ')).toMatchObject({ ok: false, code: 409, error: duplicateOpenWords('proj#o1') })
    expect(j('Email the bank')).toMatchObject({ ok: false, code: 409, error: duplicateUndoneWords('proj#u1') })
    expect(j('Renew the domain now')).toMatchObject({ ok: true })
  })
  it('a message of its own is no signal (403)', () => {
    const v = judgeCreation({ ...base, turn: round({ packetKeys: ['message:m9'] }), signal: 'message:m9', messageFrom: () => 'x' })
    expect(v).toMatchObject({ ok: false, code: 403, error: OWN_MESSAGE_NO_SIGNAL })
  })
  it('the SECOND generation spends the count: in a wake of a mission-rooted task, and through a message sent from a round', () => {
    const ledger = [made({ root: 'mission' }), made({ root: 'mission' })]
    const wake: JudgeTurn = { class: 'wake', unattended: true, taskKey: K('t1') }
    // the agent is proactive NOW: charged, with the wake's words
    expect(
      judgeCreation({ ...base, ledger, turn: wake, signal: `task:${K('t1')}`, rootOf: () => 'mission', proactiveNow: { tools: true, perDay: 2 } }),
    ).toMatchObject({ ok: false, code: 429, error: dayMaxWakeWords(2) })
    // not proactive: the root is kept, nothing is charged
    expect(judgeCreation({ ...base, ledger, turn: wake, signal: `task:${K('t1')}`, rootOf: () => 'mission', proactiveNow: null })).toMatchObject({
      ok: true,
      root: 'mission',
    })
    // a colleague's round turns a mission-rooted message into a task: its count
    expect(judgeCreation({ ...base, ledger, turn: round(), signal: 'message:m1', rootOf: () => 'mission', messageFrom: () => 'y' })).toMatchObject({
      ok: false,
      code: 429,
    })
    // a message with no root is reactive at first hand: no count
    expect(judgeCreation({ ...base, ledger, turn: round(), signal: 'message:m1', rootOf: () => null, messageFrom: () => 'y' })).toMatchObject({ ok: true })
  })
  it('On its own without proactive keeps its ONE weekly initiative (unchanged)', () => {
    const think: JudgeTurn = { class: 'heartbeat', unattended: true, kind: 'think', packetKeys: [] }
    expect(judgeCreation({ ...base, ledger: [made({ signal: 'mission', root: 'mission' })], turn: think, signal: 'mission' })).toMatchObject({
      ok: false,
      code: 429,
    })
  })
})

describe('the blocks a round reads', () => {
  it('open: its open mission-rooted tasks; undone: owner undo, Silos taint undo, withdrawn — never a refusal, 30 days', () => {
    const ledger = [
      made({ root: 'mission', ref: K('a'), title: 'A' }),
      made({ root: 'mission', ref: K('b'), title: 'B', undoneAt: iso(NOW - 86_400_000) }),
      made({ root: 'mission', ref: K('c'), title: 'C', rejected: { at: iso(NOW), why: 'Undone by Silos: created after reading outside (WebFetch)' } }),
      made({ root: 'mission', ref: K('d'), title: 'D', rejected: { at: iso(NOW), why: dayMaxWords(5) } }),
      made({ root: 'mission', ref: K('e'), title: 'E' }),
      made({ root: 'mission', ref: K('f'), title: 'F', undoneAt: iso(NOW - 40 * 86_400_000) }),
      made({ ref: K('g'), title: 'G' }),
    ]
    const state: Record<string, string> = { [K('a')]: 'pending', [K('b')]: 'cancelled', [K('c')]: 'cancelled', [K('e')]: 'cancelled', [K('g')]: 'pending' }
    const taskNow = (k: string) => (state[k] ? { status: state[k]!, title: k.slice(-1).toUpperCase() } : null)
    expect(missionOpen(ledger, taskNow).map((x) => x.title)).toEqual(['A'])
    expect(missionUndone(ledger, taskNow, NOW).map((x) => [x.title, x.by])).toEqual([
      ['B', 'the owner'],
      ['C', 'Silos'],
      ['E', 'you'],
    ])
  })
})

// ── Initiative (the API path) ────────────────────────────────────────────

function setup(o: { proactiveNow?: { tools: boolean; perDay: number } | null; messages?: Map<string, { from: string; to: string; root?: 'mission' }> } = {}) {
  const creations = new CreationsStore(dir)
  const origins = new PlansOrigins(join(dir, 'plans-origins.json'))
  const tasks = new Map<string, { status: string; title: string; owner: string }>()
  const autos: Automation[] = []
  const cuts: Array<{ agent: string; cut: Cut }> = []
  const considered: string[] = []
  const restamped: string[] = []
  const init = new Initiative({
    creations,
    origins,
    stamper: { expectOrigin: (k, ov) => origins.set(k, ov) },
    agent: (id) => ({ id, name: id.toUpperCase() }),
    agents: () => [
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' },
    ],
    automations: { list: () => autos, get: (id: string) => autos.find((a) => a.id === id), delete: () => {}, listRuns: () => [] } as never,
    trashDir: join(dir, 'trash'),
    task: (k) => tasks.get(k) ?? null,
    writeTask: (k, mutate) => {
      const t = tasks.get(k)
      const child = t ? ({ ...t } as Record<string, unknown>) : null
      const out = mutate(child)
      if (typeof out === 'string') return { ok: false, reason: out }
      if (out.write && child) tasks.set(k, child as never)
      return { ok: true }
    },
    stopTask: () => {},
    stopAutomation: () => true,
    cut: (agent, cut) => {
      cuts.push({ agent, cut })
    },
    messages: {
      restampRun: (_f, run) => {
        restamped.push(`msg:${run}`)
      },
      find: (id) => o.messages?.get(id) ?? null,
    },
    considered: {
      restampRun: (_a, run) => {
        considered.push(run)
      },
    },
    proactiveNow: () => o.proactiveNow ?? null,
    taskNow: (k) => {
      const t = tasks.get(k)
      return t ? { status: t.status, title: t.title } : null
    },
    now: () => NOW,
  })
  return { init, creations, origins, tasks, autos, cuts, considered, restamped }
}

const live = (over: Partial<LiveTurn> = {}): LiveTurn => ({
  agentId: 'x',
  turnId: 'T1',
  runId: 'R1',
  unattended: true,
  class: 'heartbeat',
  kind: 'round',
  packetKeys: ['message:m1'],
  regime: { tools: true, perDay: 2 },
  at: iso(NOW),
  ...over,
})

describe('Initiative — the API birth in a round', () => {
  it('stores the root on the ledger entry; the second generation in a WAKE is charged while the agent is proactive', () => {
    const w = setup({ proactiveNow: { tools: true, perDay: 2 } })
    expect(w.init.prepareTask({ agentId: 'x', turn: live() }, K('t1'), { id: 't1', title: 'First', owner: 'x', signal: 'mission' })).toMatchObject({ ok: true })
    expect(w.creations.byRef('x', K('t1'))?.root).toBe('mission')
    w.tasks.set(K('t1'), { status: 'in_progress', title: 'First', owner: 'x' })
    const wake = live({ class: 'wake', kind: undefined, packetKeys: undefined, regime: undefined, taskKey: K('t1'), runId: undefined, turnId: 'W1' })
    expect(w.init.prepareTask({ agentId: 'x', turn: wake }, K('t2'), { id: 't2', title: 'Child', owner: 'x', signal: `task:${K('t1')}` })).toMatchObject({
      ok: true,
    })
    expect(w.creations.byRef('x', K('t2'))?.root).toBe('mission')
    // the day's two are spent: the third generation is refused, with the wake's words
    expect(w.init.prepareTask({ agentId: 'x', turn: wake }, K('t3'), { id: 't3', title: 'Grandchild', owner: 'x', signal: `task:${K('t1')}` })).toMatchObject({
      ok: false,
      code: 429,
      error: dayMaxWakeWords(2),
    })
  })
  it('a message sent from a round carries the root: the colleague that makes it a task in its round pays its own count', () => {
    const w = setup({ messages: new Map([['m1', { from: 'y', to: 'x', root: 'mission' }]]) })
    expect(w.init.rootOfTurn({ agentId: 'y', class: 'heartbeat', kind: 'round' })).toBe('mission')
    expect(w.init.rootOfTurn({ agentId: 'y', class: 'heartbeat', kind: 'look' })).toBeNull()
    w.creations.add('x', { kind: 'task', ref: K('z1'), title: 'z1', createdAt: iso(NOW), by: 'x', root: 'mission' })
    w.creations.add('x', { kind: 'task', ref: K('z2'), title: 'z2', createdAt: iso(NOW), by: 'x', root: 'mission' })
    expect(w.init.prepareTask({ agentId: 'x', turn: live() }, K('t4'), { id: 't4', title: 'From Y', owner: 'x', signal: 'message:m1' })).toMatchObject({
      ok: false,
      code: 429,
      error: dayMaxWords(2),
    })
  })
  it('a message of its own is no signal', () => {
    const w = setup({ messages: new Map([['m1', { from: 'x', to: 'x' }]]) })
    expect(w.init.prepareTask({ agentId: 'x', turn: live() }, K('t5'), { id: 't5', title: 'Me', owner: 'x', signal: 'message:m1' })).toMatchObject({
      ok: false,
      code: 403,
      error: OWN_MESSAGE_NO_SIGNAL,
    })
  })
  it('a round never creates for another agent (403)', () => {
    const w = setup()
    expect(w.init.prepareTask({ agentId: 'x', turn: live() }, K('t6'), { id: 't6', title: 'For Y', owner: 'y', signal: 'mission' })).toMatchObject({
      ok: false,
      code: 403,
      error: ROUND_TASK_IS_YOURS,
    })
  })
  it("recurring work of its own: with its tools it is proposed (403); without, its own weekly counter — never the day's count", () => {
    const w = setup()
    const think = live({ kind: 'think', regime: { tools: true, perDay: 1 } })
    expect(w.init.judgeAutomation('x', think, { signal: 'mission', title: 'weekly', ref: 'a1' })).toEqual({ code: 403, error: ROUND_RECURRING_PROPOSED })
    const files = live({ kind: 'think', regime: { tools: false, perDay: 1 } })
    // the day's count spent by a task: recurring work still has its own counter
    w.creations.add('x', { kind: 'task', ref: K('d1'), title: 'd', createdAt: iso(NOW), by: 'x', root: 'mission', signal: 'mission' })
    expect(w.init.judgeAutomation('x', files, { signal: 'mission', title: 'weekly', ref: 'a2' })).toBeNull()
    w.creations.add('x', { kind: 'automation', ref: 'a2', title: 'weekly', createdAt: iso(NOW), by: 'x', signal: 'mission', root: 'mission' })
    expect(w.init.judgeAutomation('x', files, { signal: 'mission', title: 'another', ref: 'a3' })).toEqual({
      code: 429,
      error: selfRecurrentWeekWords(iso(NOW).slice(0, 10)),
    })
  })
})

describe('the end of a round — the verdict by its SEALED tools', () => {
  const audit = { readOutside: ['WebFetch'] }
  it("tools:false — tainted: undoes what it created and cuts (today's rule)", () => {
    const w = setup()
    expect(
      w.init.prepareTask({ agentId: 'x', turn: live({ regime: { tools: false, perDay: 3 } }) }, K('f1'), {
        id: 'f1',
        title: 'A',
        owner: 'x',
        signal: 'mission',
      }),
    ).toMatchObject({ ok: true })
    w.tasks.set(K('f1'), { status: 'pending', title: 'A', owner: 'x' })
    const cut = w.init.afterAudit('x', 'R1', audit, { heartbeat: true, tools: false, gaps: { mcp: false, childSessions: false } })
    expect(cut?.why).toMatch(/created work after reading outside \(WebFetch\)/)
    expect(w.tasks.get(K('f1'))?.status).toBe('cancelled')
  })
  it('tools:true — marks every creation, message and considered line; never undoes nor cuts', () => {
    const w = setup()
    expect(w.init.prepareTask({ agentId: 'x', turn: live() }, K('t1'), { id: 't1', title: 'A', owner: 'x', signal: 'mission' })).toMatchObject({ ok: true })
    w.tasks.set(K('t1'), { status: 'pending', title: 'A', owner: 'x' })
    const cut = w.init.afterAudit('x', 'R1', audit, { heartbeat: true, tools: true, gaps: { mcp: false, childSessions: false } })
    expect(cut).toBeNull()
    expect(w.cuts).toEqual([])
    expect(w.tasks.get(K('t1'))?.status).toBe('pending')
    expect(w.creations.byRef('x', K('t1'))?.readOutside).toEqual(['WebFetch'])
    expect(w.considered).toEqual(['R1'])
    expect(w.restamped).toEqual(['msg:R1'])
  })
  it("the owner's credential cuts in BOTH regimes", () => {
    for (const tools of [true, false]) {
      const w = setup()
      const cut = w.init.afterAudit(
        'x',
        'R1',
        { readOutside: [], ownerCredential: ['x-token header: curl -H x-token …'] },
        { heartbeat: true, tools, gaps: { mcp: false, childSessions: false } },
      )
      expect(cut?.why).toMatch(/used the owner's credential/)
    }
  })
})

describe('who cancelled a task, and when («Yours, undone»)', () => {
  const ev = (o: Record<string, unknown>): string => JSON.stringify({ silo: 'plans', verb: 'set-field', ...o })
  it("the owner only by Silos' record of the owner's Drop; an agent's set-field or a later re-cancel is not the owner's", () => {
    const f = join(dir, 'events.jsonl')
    writeFileSync(
      f,
      [
        ev({ key: K('a'), by: 'owner', at: iso(NOW - 86_400_000), text: 'set-field status: pending → cancelled' }),
        ev({ key: K('b'), by: 'x', at: iso(NOW - 86_400_000), text: 'set-field status: pending → cancelled' }),
        ev({ key: K('c'), by: 'owner', at: iso(NOW - 5 * 86_400_000), text: 'set-field status: pending → cancelled' }),
        ev({ key: K('d'), by: 'owner', at: iso(NOW - 86_400_000), text: 'set-field status: pending → cancelled' }),
        ev({ key: K('d'), by: 'owner', at: iso(NOW - 3600_000), text: 'set-field status: cancelled → pending' }),
        ev({ key: K('e'), by: 'owner', at: iso(NOW - 86_400_000), text: 'set-field notes: x → y' }),
        '',
      ].join('\n'),
    )
    const tc = new TaskCancellations(f, 'plans')
    expect(tc.of(K('a'), NOW - 86_400_000 + 5_000)).toEqual({ at: iso(NOW - 86_400_000 + 5_000), byOwner: true })
    expect(tc.of(K('b'), null).byOwner).toBe(false)
    // the journal saw it cancelled again days after the owner's Drop: a file write, not the owner
    expect(tc.of(K('c'), NOW - 86_400_000).byOwner).toBe(false)
    // reopened by the owner since: its last word is no cancel
    expect(tc.of(K('d'), NOW - 600_000).byOwner).toBe(false)
    expect(tc.of(K('e'), null)).toEqual({ at: null, byOwner: false })
    expect(tc.of(K('a'), null).at).toBe(iso(NOW - 86_400_000))
  })
  it("a task created 40 days ago and cancelled yesterday is in «undone» — the window counts from the cancellation; the owner's Drop says so", () => {
    const ledger = [
      made({ root: 'mission', ref: K('old'), title: 'Old one', createdAt: iso(NOW - 40 * 86_400_000) }),
      made({ root: 'mission', ref: K('mine'), title: 'Mine', createdAt: iso(NOW - 40 * 86_400_000) }),
    ]
    const yesterday = iso(NOW - 86_400_000)
    const taskNow = (k: string) =>
      k === K('old')
        ? { status: 'cancelled', title: 'Old one', cancel: { at: yesterday, byOwner: true } }
        : { status: 'cancelled', title: 'Mine', cancel: { at: null, byOwner: false } }
    const u = missionUndone(ledger, taskNow, NOW)
    expect(u.map((x) => [x.title, x.by, x.why, x.at])).toEqual([['Old one', 'the owner', 'dropped', yesterday]])
    // and the duplicate against it holds
    expect(
      judgeCreation({
        ...base,
        ledger,
        turn: round({ regime: { tools: true, perDay: 9 } }),
        signal: 'mission',
        task: { title: 'old one' },
        taskNow,
        openTask: () => false,
      }),
    ).toMatchObject({ ok: false, code: 409, error: duplicateUndoneWords(K('old')) })
  })
})

describe('a message carries the root of the turn it was sent from', () => {
  it('`root` is a field the strict reader knows; anything but mission is no message', () => {
    const store = new MessageStore(dir)
    const m = store.send({ from: 'y', to: 'x', text: 'look into the bank', run: 'R9', root: 'mission' })
    expect(store.find(m.id)).toMatchObject({ from: 'y', root: 'mission' })
    store.load()
    expect(store.find(m.id)?.root).toBe('mission')
    expect(parseMessage({ ...m, root: 'other' })).toBeNull()
  })
})

// ── the plan-file path: the same rules, the same phrases ──

const PLAN = '/w/proj/plans/tasks.plan.json'
interface World {
  files: Map<string, Record<string, unknown>>
  live: LiveTurn[]
  wrote: Set<string>
  journal: Array<{ at: string; event: string; key?: string; kind?: string }>
  outside: Map<string, string[]>
  tainted: Set<string>
  creations: CreationsStore
  origins: PlansOrigins
  cuts: string[]
  stamper: PlansProvenance
  read(): void
}
function world(over: Partial<ConstructorParameters<typeof PlansProvenance>[0]> = {}): World {
  const files = new Map<string, Record<string, unknown>>()
  const known = new Set<string>()
  let reads = 0
  const w: World = {
    files,
    live: [],
    wrote: new Set(),
    journal: [],
    outside: new Map(),
    tainted: new Set(),
    creations: new CreationsStore(dir),
    origins: new PlansOrigins(join(dir, 'po.json')),
    cuts: [],
    stamper: null as unknown as PlansProvenance,
    read() {
      const first = reads++ === 0
      for (const k of files.keys())
        if (!known.has(k)) {
          w.journal.push({ at: iso(NOW), event: first ? 'baseline' : 'appeared', key: k, kind: 'plan/task' })
          known.add(k)
        }
      const tasks = new Map<string, TaskView>()
      for (const [k, raw] of files) tasks.set(k, { key: k, file: PLAN, location: 'proj', raw: JSON.parse(JSON.stringify(raw)) as Record<string, unknown> })
      w.stamper.onReading({ tasks, complete: true } satisfies PlansSnapshot)
    },
  }
  w.stamper = new PlansProvenance({
    origins: w.origins,
    creations: w.creations,
    cursorFile: join(dir, 'pp.json'),
    agents: () => [{ id: 'x', name: 'X', folders: ['/w/proj'] }],
    liveOf: (id) => w.live.filter((t) => t.agentId === id),
    probe: { wrote: async (c: Candidate) => w.wrote.has(c.turnId) },
    write: (key, mutate) => {
      const id = key.slice(key.lastIndexOf('/') + 1)
      const list = [...files.values()].map((t) => JSON.parse(JSON.stringify(t)) as Record<string, unknown>)
      const child = list.find((t) => t.id === id) ?? null
      const out = mutate(child, list)
      if (typeof out === 'string') return { ok: false, reason: out }
      if (out.write) {
        const next = list.find((t) => t.id === id)
        if (next) files.set(key, next)
        w.read()
      }
      return { ok: true }
    },
    journal: () => [{ dir: 'plans', read: (n: number) => ({ lines: w.journal.slice(n), next: w.journal.length }) }],
    // the SEALED verdict (index.ts runVerdictOf): tainted only when tools:false
    runVerdict: (_a, run) =>
      w.tainted.has(run)
        ? { tainted: true, readOutside: w.outside.get(run) ?? [] }
        : w.outside.has(run)
          ? { tainted: false, readOutside: w.outside.get(run)! }
          : null,
    runReadOutside: (_a, run) => w.outside.get(run) ?? null,
    selfRecurrentLive: () => 0,
    cut: (_a, why) => {
      w.cuts.push(why)
    },
    proactiveNow: () => null,
    taskNow: (k) => {
      const t = files.get(k)
      return t ? { status: String(t.status ?? 'pending'), title: String(t.title ?? ''), ref: k } : null
    },
    now: () => NOW,
    ...over,
  })
  w.read()
  return w
}
const notesOf = (t: Record<string, unknown> | undefined): string[] => ((t?.notes as Array<{ text: string }> | undefined) ?? []).map((n) => n.text)

describe('the plan-file path in a round', () => {
  it('tools:true — a creation adopted AFTER its turn read outside is MARKED, never cancelled', async () => {
    const w = world()
    w.live.push(live())
    w.files.set(K('p1'), { id: 'p1', title: 'Look into it', owner: 'x', status: 'pending', signal: 'mission' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    w.outside.set('R1', ['WebSearch'])
    await w.stamper.settle()
    expect(w.files.get(K('p1'))?.status).toBe('pending')
    expect(w.creations.byRef('x', K('p1'))).toMatchObject({ root: 'mission', readOutside: ['WebSearch'] })
    expect(w.creations.byRef('x', K('p1'))?.rejected).toBeUndefined()
  })
  it('tools:false — the same adoption is undone (the sealed verdict)', async () => {
    const w = world()
    w.live.push(live({ regime: { tools: false, perDay: 3 } }))
    w.files.set(K('p2'), { id: 'p2', title: 'Look into it', owner: 'x', status: 'pending', signal: 'mission' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    w.outside.set('R1', ['WebSearch'])
    w.tainted.add('R1')
    await w.stamper.settle()
    expect(w.files.get(K('p2'))?.status).toBe('cancelled')
  })
  it("by file, a duplicate, a foreign owner and a wait are cancelled with the API's own phrase", async () => {
    const w = world()
    w.creations.add('x', { kind: 'task', ref: K('o1'), title: 'Renew the domain', createdAt: iso(NOW - 3600_000), by: 'x', root: 'mission', signal: 'mission' })
    w.files.set(K('o1'), { id: 'o1', title: 'Renew the domain', owner: 'x', status: 'pending' })
    w.read()
    w.live.push(live({ regime: { tools: true, perDay: 10 } }))
    w.files.set(K('d1'), { id: 'd1', title: 'renew the domain', owner: 'x', status: 'pending', signal: 'mission' })
    w.files.set(K('d2'), { id: 'd2', title: 'For Y', owner: 'y', status: 'pending', signal: 'mission' })
    w.files.set(K('d3'), { id: 'd3', title: 'Waits', owner: 'x', status: 'pending', signal: 'mission', waitingOn: { owner: 'owner', asked: '?' } })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(notesOf(w.files.get(K('d1')))).toContain(`Silos cancelled it: ${duplicateOpenWords(K('o1'))}`)
    expect(notesOf(w.files.get(K('d2')))).toContain(`Silos cancelled it: ${ROUND_TASK_IS_YOURS}`)
    expect(notesOf(w.files.get(K('d3')))).toContain(`Silos cancelled it: ${ROUND_TASK_NO_WAIT}`)
    for (const k of ['d1', 'd2', 'd3']) expect(w.files.get(K(k))?.status).toBe('cancelled')
  })
})

// ── the quota and «what the owner undid stays undone» hold on an EXISTING
// task too: a reopen by its creator is judged like a creation ──
describe('reopening a task of its own from its mission', () => {
  // a mission task it created yesterday, now `status`
  const mine = (w: World, id: string, status: string): void => {
    const c = w.creations.add('x', { kind: 'task', ref: K(id), title: id, createdAt: iso(NOW - 86_400_000), by: 'x', root: 'mission', signal: 'mission' })
    w.origins.set(K(id), { by: 'x', how: 'creation', at: iso(NOW - 86_400_000), file: PLAN, title: id, creation: { agent: 'x', id: c.id } })
    w.files.set(K(id), { id, title: id, owner: 'x', status })
  }
  const reopen = async (w: World, id: string, turn: Partial<LiveTurn> = {}): Promise<void> => {
    w.live.push(live(turn))
    w.files.set(K(id), { ...w.files.get(K(id))!, status: 'in_progress' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
  }

  it('one the OWNER dropped, reopened in a round, is a resurrection: cancelled again and cut — as an undone one', async () => {
    const w = world({ ownerDrop: (k) => (k === K('d1') ? iso(NOW - 3600_000) : null) })
    mine(w, 'd1', 'cancelled')
    w.read()
    await reopen(w, 'd1')
    expect(w.files.get(K('d1'))?.status).toBe('cancelled')
    expect(w.cuts).toEqual(['restored work the owner had undone'])
  })

  it("its own done one reopened in a round spends the day's count; at its max it goes back to done with the API's words", async () => {
    const w = world()
    mine(w, 'r1', 'done')
    mine(w, 'r2', 'cancelled')
    w.read()
    // perDay 2, nothing made today: the reopen is the first of the day
    await reopen(w, 'r1')
    expect(w.files.get(K('r1'))?.status).toBe('in_progress')
    expect(w.creations.byRef('x', K('r1'))?.reopenedAt).toEqual([iso(NOW)])
    // one made today besides: the second reopen is over the count
    w.creations.add('x', { kind: 'task', ref: K('n1'), title: 'n1', createdAt: iso(NOW - 600_000), by: 'x', root: 'mission', signal: 'mission' })
    await reopen(w, 'r2')
    expect(w.files.get(K('r2'))?.status).toBe('cancelled')
    expect(notesOf(w.files.get(K('r2')))).toContain(noteReopenRefused('cancelled', dayMaxWords(2)))
    expect(w.cuts).toEqual([])
  })

  it('an agent that is not proactive reopens its own as before: nothing charged', async () => {
    const w = world()
    mine(w, 'q1', 'done')
    w.read()
    await reopen(w, 'q1', { kind: 'think', regime: undefined })
    expect(w.files.get(K('q1'))?.status).toBe('in_progress')
    expect(w.creations.byRef('x', K('q1'))?.reopenedAt).toBeUndefined()
  })

  it('by API there is no reopen for a bearer: claim and assign refuse a closed task (the owner reopens it)', () => {
    // pinned in task-claim-route.test.ts («more work on it is a new task (or
    // the owner reopens it)») and task-assign.test.ts («the task is done
    // already» / «…cancelled already»); set-field is not in a bearer's allow-list
    expect(agentMayWrite('x', 'POST', '/api/silos/plans/record/set-field')).toBe(false)
  })
})
