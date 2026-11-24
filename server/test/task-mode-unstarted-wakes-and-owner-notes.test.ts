// task-mode-unstarted-wakes-and-owner-notes.test.ts — Task mode and the
// escalation engine around wakes that never started and owner notes:
//   - a wake whose turn never started (usage limit, engine failure) is not
//     lost, not charged, not «delivered», and no false stalled → escalate
//   - a note signed "owner" counts only when Silos recorded the owner
//     writing it (the kernel's append-item events — owner-notes.ts)
//   - an unreadable / missing plan keeps its queued wakes a while
//   - a nextCheckAt already past at the first look fires or is cleared
//   - Silos' own notes are nobody's creator; the creator is frozen
//   - a hop to an agent with no beat goes urgent
//   - an owner's note reopening an escalated task drops Silos' wait
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskModeStore } from '../src/task-mode/store.js'
import { MISSING_KEEP_MS, TaskModeEngine, START_RETRY_BASE_MS, type TaskModeDeps, type TaskTurnEnd } from '../src/task-mode/engine.js'
import { UNVERIFIED_OWNER, type TaskSnap } from '../src/task-mode/evaluate.js'
import { wakeBriefing } from '../src/task-mode/briefing.js'
import { noteDigest, OwnerNoteLedger, type OwnerNoteCheck } from '../src/task-mode/owner-notes.js'
import { EscalationEngine, creatorOf } from '../src/escalation/engine.js'
import { EscalationStore } from '../src/escalation/store.js'
import { evaluateEscalation, type ChainView, type Subject } from '../src/escalation/evaluate.js'
import { SILOS_AUTHOR } from '../src/system-author.js'
import type { SiloReading } from '../src/silos/reader.js'

const T0 = Date.parse('2026-11-03T09:00:00Z')
const MIN = 60_000
const KEY = (id: string): string => `folder:/p/launch/tasks/${id}`

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-mode-unstarted-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function readingOf(tasks: Array<Record<string, unknown>> | null, unreadable = false): SiloReading {
  return {
    records: tasks
      ? [
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
        ]
      : [],
    unreadable: unreadable
      ? [
          {
            silo: 'plans',
            kind: 'plan',
            source: 'plans',
            file: '/p/plans/launch.plan.json',
            rel: 'plans/launch.plan.json',
            location: 'folder:/p',
            id: 'launch',
            reason: 'not valid JSON',
          },
        ]
      : [],
    problems: [],
    sources: {},
    lastWrite: null,
  } as unknown as SiloReading
}

// a ledger stand-in: the notes `trust` vouches for are the owner's
const trusting = (trust: (n: { at: string; text: string }) => boolean) => (): OwnerNoteCheck => (_k, notes) => ({
  fromOwner: notes.map(trust),
  closes: notes.map(() => false),
  lost: [],
})

type Turn = { agentId: string; text: string; started?: () => void; end: (r?: TaskTurnEnd) => Promise<void> }

function world(
  opts: {
    throwOnSend?: string
    limitedUntil?: () => string | null
    ownerNotes?: TaskModeDeps['ownerNotes']
    stalled?: () => Map<string, { cause: string; by: string | null }>
  } = {},
) {
  let now = T0
  let tasks: Array<Record<string, unknown>> | null = []
  let unreadable = false
  const turns: Turn[] = []
  const writes: Array<[string, string, unknown]> = []
  const notes: Array<[string, string]> = []
  const store = new TaskModeStore(base)
  const deps: TaskModeDeps = {
    store,
    plans: () => ({ reading: readingOf(tasks, unreadable) }),
    bound: () => new Set(['writer']),
    ready: () => true,
    setField: (k, f, v) => {
      writes.push([k, f, v])
      return { ok: true }
    },
    appendConversation: () => ({ ok: true }),
    appendNote: (k, t) => {
      notes.push([k, t])
      return { ok: true }
    },
    conversationOf: (_a, ids) => (ids.length > 0 ? { sessionId: ids[ids.length - 1]!, folder: '-p' } : null),
    holdersOf: (_a, ids) => ids,
    busyWhy: () => null,
    send: (i) => {
      if (opts.throwOnSend) throw new Error(opts.throwOnSend)
      let resolve!: (r?: TaskTurnEnd) => void
      const done = new Promise<void | TaskTurnEnd>((r) => {
        resolve = r
      })
      turns.push({
        agentId: i.agentId,
        text: i.text,
        ...(i.onStarted ? { started: i.onStarted } : {}),
        end: async (r) => {
          resolve(r)
          await new Promise((x) => setTimeout(x, 0))
        },
      })
      return { turnId: `turn-${turns.length}`, done }
    },
    ...(opts.limitedUntil ? { limitedUntil: opts.limitedUntil } : {}),
    ...(opts.ownerNotes ? { ownerNotes: opts.ownerNotes } : {}),
    ...(opts.stalled ? { stalled: opts.stalled } : {}),
    now: () => now,
  }
  const engine = new TaskModeEngine(deps)
  return {
    engine,
    store,
    turns,
    writes,
    notes,
    set: (t: Array<Record<string, unknown>> | null, u = false) => {
      tasks = t
      unreadable = u
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
  conversations: ['sess-0001aaaa'],
  ...over,
})
const ownerNote = (text: string, at = new Date(T0).toISOString()) => ({ at, by: 'owner', text })
const day = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('a turn that never started is not lost, not charged, not «delivered»', () => {
  it('a usage limit: the wake goes back to the queue held until the reset, the day counts nothing; after the reset it goes again', async () => {
    const w = world()
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    expect(w.turns).toHaveLength(1)
    // an owner's note is the owner's gesture (R1): it is
    // never charged to the agent's day — not while on its way, not after
    expect(w.engine.today('writer').woke).toBe(0)
    const reset = new Date(T0 + 3 * 3600_000).toISOString()
    await w.turns[0]!.end({ costUsd: null, started: false, limitedUntil: reset })
    expect(w.store.queued()).toEqual([
      expect.objectContaining({
        reason: 'owner-note',
        held: expect.stringMatching(/^its account is at its usage limit — it goes at \d\d:\d\d$/),
        until: reset,
        attempts: 0,
      }),
    ])
    expect(w.store.usedToday('writer', day(T0))).toBe(0)
    expect(w.engine.today('writer').woke).toBe(0)
    // before the reset: held, nothing sent
    w.at(T0 + 3600_000)
    w.engine.deliver()
    expect(w.turns).toHaveLength(1)
    // after it: sent again; this one starts — charged once
    w.at(T0 + 3 * 3600_000 + 1)
    w.engine.deliver()
    expect(w.turns).toHaveLength(2)
    w.turns[1]!.started!()
    expect(w.store.usedToday('writer', day(T0))).toBe(0)
    await w.turns[1]!.end({ costUsd: 0.1, started: true })
    expect(w.store.usedToday('writer', day(T0))).toBe(0)
    expect(w.store.wakes()[0]).toMatchObject({ state: 'delivered', costUsd: 0.1 })
    expect(w.store.wakes()[0]!.startedAt).toBeDefined()
  })

  it('the account already at its limit (the account reading): held for the reset, never sent', () => {
    const reset = new Date(T0 + 2 * 3600_000).toISOString()
    const w = world({ limitedUntil: () => reset })
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    expect(w.turns).toEqual([])
    expect(w.store.queued()[0]).toMatchObject({ held: expect.stringMatching(/^its account is at its usage limit — it goes at \d\d:\d\d$/), until: reset })
    expect(w.engine.today('writer').woke).toBe(0)
  })

  it('start() throws (no folder): back in the queue, retried with a backoff, never charged — «woke N times» stays 0', () => {
    const w = world({ throwOnSend: 'Writer has no folder' })
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('go')] })])
    w.engine.look()
    const q = w.store.queued()[0]!
    expect(q).toMatchObject({
      held: 'its turn could not start (1 try): Writer has no folder — Silos tries again',
      attempts: 1,
      until: new Date(T0 + START_RETRY_BASE_MS).toISOString(),
    })
    // the ticks inside the backoff try nothing
    for (let i = 1; i < 4; i += 1) {
      w.at(T0 + i * 10_000)
      w.engine.deliver()
    }
    expect(w.store.queued()[0]!.attempts).toBe(1)
    w.at(T0 + START_RETRY_BASE_MS + 1)
    w.engine.deliver()
    expect(w.store.queued()[0]).toMatchObject({ attempts: 2, until: new Date(T0 + START_RETRY_BASE_MS + 1 + 2 * START_RETRY_BASE_MS).toISOString() })
    expect(w.store.usedToday('writer', day(T0))).toBe(0)
    expect(w.engine.today('writer').woke).toBe(0)
    expect(w.engine.ceilingHits()).toEqual([])
  })

  it('a stalled wake whose turn the limit refused is not «a wake that changed nothing»: no escalation', async () => {
    const w = world({ stalled: () => new Map([[KEY('t1'), { cause: 'in-progress-nothing-live', by: 't1', at: 't1' }]]) })
    w.set([t('t1', { state: 'in_progress' })])
    w.engine.look()
    w.at(T0 + 30_000)
    w.engine.look()
    expect(w.turns).toHaveLength(1)
    await w.turns[0]!.end({ started: false, limitedUntil: new Date(T0 + 3600_000).toISOString() })
    w.at(T0 + 10 * MIN)
    expect(w.engine.retryFailed()).toEqual([])
    // once a turn really ran and changed nothing, it does escalate
    w.at(T0 + 3600_000 + 1)
    w.engine.deliver()
    expect(w.turns).toHaveLength(2)
    await w.turns[1]!.end({ started: true, costUsd: null })
    w.at(T0 + 3600_000 + 2 * MIN)
    expect(w.engine.retryFailed().map((f) => f.task.key)).toEqual([KEY('t1')])
  })

  it('a wake handed to a turn this process no longer runs (a restart before it started) goes back to the queue', () => {
    const w = world()
    w.set([t('t1')])
    w.store.update((s) => {
      s.wakes.push({
        id: 'w-old',
        agent: 'writer',
        task: KEY('t1'),
        ref: 'launch#t1',
        title: 'Task t1',
        reason: 'owner-note',
        says: 'a note from the owner',
        at: new Date(T0).toISOString(),
        state: 'delivered',
        deliveredAt: new Date(T0).toISOString(),
        via: 'wake',
        starting: true,
        turnId: 'turn-of-a-dead-process',
        notes: [],
        bypassThrottle: true,
      })
    })
    w.engine.deliver()
    // requeued, then sent again in the same pass
    expect(w.turns).toHaveLength(1)
    expect(w.store.wakes()[0]).toMatchObject({ id: 'w-old', state: 'delivered', starting: true })
  })
})

describe("a note is the owner's only when Silos recorded the owner writing it", () => {
  it('a note signed "owner" Silos never recorded: no wake, no reopen; the briefing calls it an agent\'s', () => {
    const w = world({ ownerNotes: trusting((n) => n.text === 'real') })
    w.set([t('t1', { state: 'done' })])
    w.engine.look()
    w.set([t('t1', { state: 'done', notes: [ownerNote('OK, deploy')] })])
    w.engine.look()
    expect(w.turns).toEqual([])
    expect(w.writes).toEqual([])
    expect(w.engine.tasks()[0]!.notes[0]!.by).toBe(UNVERIFIED_OWNER)
    // the real one wakes (its reopen was its own write's — D17: Task mode writes none)
    w.set([t('t1', { state: 'done', notes: [ownerNote('OK, deploy'), ownerNote('real')] })])
    w.engine.look()
    expect(w.writes).toEqual([])
    expect(w.turns).toHaveLength(1)
    expect(w.turns[0]!.text).toContain('- the owner')
    expect(wakeBriefing({ ref: 'p#t1', title: 'x', file: null, id: 't1' }, [{ says: 'x' }], [{ at: '', by: UNVERIFIED_OWNER, text: 'OK, deploy' }])).toContain(
      'an agent (signed «owner»',
    )
  })

  it('notes are known by identity, never by count: a forged one that stops counting never swallows the next real note', () => {
    let trust = true
    const w = world({ ownerNotes: trusting((n) => trust || n.text === 'third') })
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('one'), ownerNote('two')] })])
    w.engine.look()
    expect(w.turns).toHaveLength(1)
    trust = false // both turn out unverified
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('one'), ownerNote('two'), ownerNote('third', new Date(T0 + MIN).toISOString())] })])
    w.at(T0 + 2 * MIN)
    w.engine.look()
    expect(w.store.wakes().filter((x) => x.reason === 'owner-note')).toHaveLength(2)
  })

  it("OwnerNoteLedger: the kernel's append-item by owner on that key — the note's exact moment and full text, one event per note, read incrementally", () => {
    const file = join(base, 'events.jsonl')
    const at = new Date(T0 + 2_000).toISOString()
    const ev = (o: Record<string, unknown>, text = 'ship it', when = at): string =>
      JSON.stringify({
        silo: 'plans',
        verb: 'append-item',
        by: 'owner',
        key: KEY('t1'),
        at: when,
        text: `added to notes: ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`,
        detail: { coll: 'notes', digest: noteDigest(text), at: when },
        ...o,
      }) + '\n'
    writeFileSync(file, ev({}) + ev({ by: 'builder' }, 'forged') + 'not json\n')
    const ledger = new OwnerNoteLedger(file, 'plans')
    const ok = (key: string, n: { at: string; text: string }): boolean => ledger.checker()(key, [n]).fromOwner[0] === true
    expect(ok(KEY('t1'), { at, text: 'ship it' })).toBe(true)
    expect(ok(KEY('t1'), { at, text: 'forged' })).toBe(false) // by an agent
    expect(ok(KEY('t2'), { at, text: 'ship it' })).toBe(false) // another task
    expect(ok(KEY('t1'), { at: new Date(T0 + 3_000).toISOString(), text: 'ship it' })).toBe(false) // not the recorded moment
    expect(ok(KEY('t1'), { at: '', text: 'ship it' })).toBe(false) // undated: unprovable
    // ONE event vouches for ONE note: a copy with the same moment and words is an agent's
    expect(
      ledger.checker()(KEY('t1'), [
        { at, text: 'ship it' },
        { at, text: 'ship it' },
      ]).fromOwner,
    ).toEqual([true, false])
    // a long note: the WHOLE text is what counts — a rewritten tail is not the owner's
    const long = 'x'.repeat(300)
    appendFileSync(file, ev({ key: KEY('t3') }, long))
    expect(ok(KEY('t3'), { at, text: long })).toBe(true)
    expect(ok(KEY('t3'), { at, text: `${'x'.repeat(200)}${'y'.repeat(100)}` })).toBe(false)
    // an event with no exact moment and digest vouches for nothing (no old form is read)
    appendFileSync(file, JSON.stringify({ silo: 'plans', verb: 'append-item', by: 'owner', key: KEY('t6'), at, text: 'added to notes: ship it' }) + '\n')
    expect(ok(KEY('t6'), { at, text: 'ship it' })).toBe(false)
    // another silo's events are not the plans silo's
    appendFileSync(file, ev({ silo: 'support', key: KEY('t4') }))
    expect(ok(KEY('t4'), { at, text: 'ship it' })).toBe(false)
    // the owner's recorded note the file no longer holds: lost, said with the log's words
    expect(ledger.checker()(KEY('t1'), [])).toEqual({ fromOwner: [], closes: [], lost: [{ at, digest: noteDigest('ship it'), text: 'ship it' }] })
    // a log rewritten smaller is read again whole
    writeFileSync(file, ev({ key: KEY('t5') }))
    expect(ok(KEY('t5'), { at, text: 'ship it' })).toBe(true)
    expect(ok(KEY('t1'), { at, text: 'ship it' })).toBe(false)
  })
})

describe('an unreadable plan keeps the queued wakes', () => {
  it('unreadable for a moment: kept, said; it reads again → delivered', () => {
    const w = world()
    w.engine.store.update(() => {})
    w.set([t('t1')])
    w.engine.look()
    // a wake queued while a console held it… simplest: queue one by hand
    w.store.update((s) => {
      s.wakes.push({
        id: 'w1',
        agent: 'writer',
        task: KEY('t1'),
        ref: 'launch#t1',
        title: 'Task t1',
        reason: 'owner-note',
        says: 'a note from the owner',
        at: new Date(T0).toISOString(),
        state: 'queued',
        notes: [ownerNote('hi')],
        bypassThrottle: true,
      })
    })
    w.set(null, true)
    w.at(T0 + 3600_000)
    w.engine.deliver()
    expect(w.store.queued()[0]).toMatchObject({ id: 'w1', held: "its plan can't be read right now (not valid JSON) — kept until it reads again" })
    w.at(T0 + 24 * 3600_000)
    w.engine.deliver()
    expect(w.store.queued()).toHaveLength(1)
    w.set([t('t1')])
    w.engine.deliver()
    expect(w.turns).toHaveLength(1)
    expect(w.store.wakes()[0]).toMatchObject({ state: 'delivered' })
    expect(w.store.wakes()[0]!.missingSince).toBeUndefined()
  })

  it('a task simply gone (no unreadable file): kept MISSING_KEEP_MS, then superseded, said', () => {
    const w = world()
    w.set([t('t1')])
    w.store.update((s) => {
      s.wakes.push({
        id: 'w1',
        agent: 'writer',
        task: KEY('t1'),
        ref: 'launch#t1',
        title: 'Task t1',
        reason: 'owner-note',
        says: 'x',
        at: new Date(T0).toISOString(),
        state: 'queued',
        notes: [],
        bypassThrottle: true,
      })
    })
    w.set(null)
    w.engine.deliver()
    expect(w.store.queued()[0]!.held).toBe('its task is not in the plans Silos reads right now — kept a while in case it comes back')
    w.at(T0 + MISSING_KEEP_MS + 1)
    w.engine.deliver()
    expect(w.store.wakes()[0]).toMatchObject({
      state: 'superseded',
      held: "its task is no longer in a plan Silos reads — the owner's note stays in the plan file",
    })
  })
})

describe('a next check already past at the first look', () => {
  it('long past: the field is cleared and a note by Silos says so; recent: it wakes once', () => {
    const w = world()
    w.set([
      t('t1', { nextCheckAt: new Date(T0 - 3 * 24 * 3600_000).toISOString() }),
      t('t2', { nextCheckAt: new Date(T0 - 3600_000).toISOString(), conversations: [] }),
    ])
    w.engine.look()
    expect(w.writes).toEqual([
      [KEY('t1'), 'nextCheckAt', null],
      [KEY('t2'), 'nextCheckAt', null],
    ])
    expect(w.notes).toEqual([[KEY('t1'), expect.stringMatching(/had passed long before Silos first looked at this task — cleared without a wake/)]])
    expect(w.turns.map((x) => x.text)).toEqual([expect.stringContaining('launch#t2')])
  })
})

// finding 10 (the owner's note on an escalated task drops Silos' own wait)
// moved to the note's own write with J1: task-owner-write-routes.test.ts
// «J1 — Silos' unstick wait goes in the same write»

describe("Silos' own notes are nobody's; the creator is read once", () => {
  it("creatorOf skips notes signed Silos — a note signed `silos` is the agent silos'", () => {
    const recovery =
      'stalled: it is in progress and nothing is working it; one wake on Nov 3 changed nothing. Silos marks it blocked and asks for help — Builder stays its owner.'
    expect(creatorOf({ notes: [{ at: '', by: SILOS_AUTHOR, text: recovery }] }, () => true)).toBeNull()
    expect(
      creatorOf(
        {
          notes: [
            { at: '', by: SILOS_AUTHOR, text: recovery },
            { at: '', by: 'ana', text: 'x' },
          ],
        },
        () => true,
      ),
    ).toBe('ana')
    expect(creatorOf({ notes: [{ at: '', by: 'silos', text: 'please wire the parser' }] }, () => true)).toBe('silos')
    expect(creatorOf({ notes: [{ at: '', by: UNVERIFIED_OWNER, text: 'x' }] }, (id) => id === 'ana')).toBeNull()
  })

  it('a case keeps the creator it opened with, whatever notes come later', () => {
    const chain: ChainView = { installed: true, up: () => [] }
    const s = (creator: string | null): Subject => ({
      id: 'task:k',
      kind: 'task',
      key: 'k',
      ref: 'p#t1',
      title: 'T',
      who: 'builder',
      creator,
      cause: 'c',
      since: new Date(T0).toISOString(),
    })
    const a = evaluateEscalation({ subjects: [s('ana')], prev: {}, now: T0, windowMs: 24 * 3600_000, chain })
    const b = evaluateEscalation({ subjects: [s('bob')], prev: a.cases, now: T0 + 60_000, windowMs: 24 * 3600_000, chain })
    expect(b.cases['task:k']!.creator).toBe('ana')
  })
})

// A hop goes to an agent only when it is On its own
// and its next heartbeat with a turn falls inside the window — otherwise the
// chain skips it (and at the end, the owner). Hops are normal messages: no
// urgency exists any more.
describe('a hop only to an agent whose heartbeat falls in the window', () => {
  it('hopOk false: the agent is skipped, the owner is asked; true: a normal message to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esc-beat-'))
    try {
      const PLAN = 'folder:/p/launch'
      const task: TaskSnap = {
        key: `${PLAN}/tasks/t1`,
        planKey: PLAN,
        planId: 'launch',
        id: 't1',
        ref: 'launch#t1',
        title: 'Ship',
        owner: 'writer',
        state: 'in_progress',
        dependsOn: [],
        parent: null,
        nextCheckAt: null,
        waitingOn: false,
        waitingFor: null,
        stalledCause: 'in-progress-nothing-live',
        stalledBy: 't1',
        stalledAt: 't1',
        notes: [],
        conversations: [],
        current: [],
        file: null,
        folder: '/p',
      }
      const msgs: string[] = []
      const texts: string[] = []
      const run = (hop: boolean): EscalationEngine => {
        const e = new EscalationEngine({
          store: new EscalationStore(join(dir, hop ? 'b' : 'n')),
          taskMode: {
            tasks: () => [task],
            retryFailed: () => [{ task, cause: 'in-progress-nothing-live', since: new Date(T0).toISOString(), wokeAt: new Date(T0).toISOString() }],
          },
          chain: () => ({ installed: true, up: (a) => (a === 'writer' ? ['support'] : []) }),
          isAgent: () => true,
          nameOf: (id) => id,
          setField: () => ({ ok: true }),
          appendNote: () => ({ ok: true }),
          message: (to, text) => {
            msgs.push(to)
            texts.push(text)
          },
          hopOk: () => hop,
          now: () => T0,
        })
        e.tick()
        return e
      }
      const skipped = run(false)
      expect(msgs).toEqual([])
      expect(skipped.ownerRows()).toHaveLength(1)
      run(true)
      expect(msgs).toEqual(['support'])
      expect(texts[0]).toMatch(/This is a normal message, not an assignment/)
      expect(texts[0]).not.toMatch(/urgent/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
