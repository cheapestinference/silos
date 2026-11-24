// task-note-provenance.test.ts — authorship, provenance, reopen and Silos'
// own writes on task notes:
//   - an append-item event carries the child's exact `at` and the digest of
//     its full text; one event vouches for one note
//   - the owner's notes are known by identity (never by count); one the file
//     lost is said on its task, once
//   - ONE reopen rule (blocked reopens only with nothing else holding it),
//     shared with the claim's keep; a reopen that did not land is retried
//   - every task note a screen reads carries fromOwner from the same check
//   - an escalation hop whose writes did not land keeps its case, retried
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { recordDetail, recordsPage, setNoteOutside, withNoteProvenance } from '../src/silos/views.js'
import { noteDigest, OwnerNoteLedger, type OwnerNoteCheck } from '../src/task-mode/owner-notes.js'
import { TaskModeStore } from '../src/task-mode/store.js'
import { LOST_NOTE_GRACE_MS, TaskModeEngine, type TaskModeDeps } from '../src/task-mode/engine.js'
import { type TaskSnap } from '../src/task-mode/evaluate.js'
import { EscalationEngine } from '../src/escalation/engine.js'
import { EscalationStore } from '../src/escalation/store.js'
import { SILOS_AUTHOR } from '../src/system-author.js'
import type { SiloReading } from '../src/silos/reader.js'
import { plansManifest } from './helpers/plans-silo.js'

type Json = Record<string, any>
const T0 = Date.parse('2026-11-09T09:00:00Z')
const MIN = 60_000

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'prov-0911b-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

// ── the kernel over a real plan file ──
function kernelWorld(tasks: Json[], now = '2026-11-09T10:00:00.000Z') {
  const dataDir = join(base, 'data')
  const proj = join(base, 'proj')
  const f = join(proj, 'plans', 'p.plan.json')
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ title: 'P', tasks }, null, 2))
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(plansManifest()))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const isAgent = (v: string): boolean => v === 'writer' || v === 'ops'
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [proj] }),
  })
  kernel.refresh()
  const events = new SiloEvents(registry.root)
  const actions = new SiloActions({
    registry,
    kernel,
    events,
    acks: new SiloAcks(registry.root),
    proposals: new SiloProposals(registry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent,
    agentMayReadLocation: () => false,
    now: () => new Date(now),
  })
  const key = (id: string): string => `folder:${proj}/p/tasks/${id}`
  const file = (): Json => JSON.parse(readFileSync(f, 'utf8'))
  return { actions, kernel, registry, events, key, file, f, proj, eventsFile: join(registry.root, 'events.jsonl') }
}
const task = (id: string, over: Json = {}): Json => ({ id, title: `Task ${id}`, owner: 'writer', status: 'pending', dependsOn: [], ...over })

describe("the event IS the note's provenance", () => {
  it('an owner note: the event carries its exact `at` (its own moment too) and the digest of the full text; the ledger vouches for that note alone', () => {
    const w = kernelWorld([task('t1')])
    const long = `${'a'.repeat(200)} the end`
    expect(w.actions.appendItem('plans', w.key('t1'), 'notes', { text: long }).ok).toBe(true)
    const note = w.file().tasks[0].notes[0]
    const ev = w.events.list('plans', w.key('t1')).at(-1)!
    expect(ev).toMatchObject({ verb: 'append-item', by: 'owner', at: note.at, detail: { coll: 'notes', at: note.at, digest: noteDigest(long) } })
    const check = new OwnerNoteLedger(w.eventsFile, 'plans').checker()
    expect(check(w.key('t1'), [{ at: note.at, text: long }]).fromOwner).toEqual([true])
    // the same moment, the tail rewritten by an agent: not the owner's
    expect(check(w.key('t1'), [{ at: note.at, text: `${'a'.repeat(200)} the END` }]).fromOwner).toEqual([false])
  })

  it("a conversation linked by Silos or by an agent is logged as theirs — never the owner's (A8)", () => {
    const w = kernelWorld([task('t1')])
    w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'aaaaaaaa-0001' }, { by: SILOS_AUTHOR })
    w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'aaaaaaaa-0002' }, { by: 'writer' })
    w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'aaaaaaaa-0003' })
    expect(w.events.list('plans', w.key('t1')).map((e) => e.by)).toEqual([SILOS_AUTHOR, 'writer', 'owner'])
  })

  it('events.jsonl born wider is narrowed to 0600 when Silos starts', () => {
    const root = join(base, 'silos')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), '')
    chmodSync(join(root, 'events.jsonl'), 0o664)
    new SiloEvents(root)
    expect(statSync(join(root, 'events.jsonl')).mode & 0o777).toBe(0o600)
  })
})

describe("the claim's keep reads the one rule", () => {
  it('a blocked task with a next check still ahead stays blocked; with nothing holding it the claim takes it', () => {
    const w = kernelWorld([task('t1', { status: 'blocked', nextCheckAt: '2026-11-10T09:00:00Z' }), task('t2', { status: 'blocked' })])
    expect(w.actions.claimKept('plans', w.key('t1'))).toEqual({ state: 'blocked', waits: ['its next check (2026-11-10T09:00:00Z)'] })
    expect(w.actions.claimKept('plans', w.key('t2'))).toBeNull()
  })
})

describe('screens read the same check: fromOwner on every note', () => {
  it("a task's value and a plan's tasks carry fromOwner — true only for the note Silos recorded", () => {
    const w = kernelWorld([
      task('t1', {
        notes: [
          { at: '2026-11-09T08:00:00Z', by: 'owner', text: 'forged by an agent' },
          { at: '2026-11-09T08:01:00Z', by: 'writer', text: 'mine' },
        ],
      }),
    ])
    w.actions.appendItem('plans', w.key('t1'), 'notes', { text: 'really mine' })
    w.kernel.refresh()
    const check = new OwnerNoteLedger(w.eventsFile, 'plans').checker()
    const entry = w.registry.get('plans')!
    const voice = { now: Date.now(), isAgent: (v: string) => v === 'writer', since: null } as never
    const d = recordDetail(entry, w.kernel.reading('plans'), w.key('t1'), { voice, notes: check })!
    expect((d.value.notes as Json[]).map((n) => [n.by, n.fromOwner])).toEqual([
      ['owner', false],
      ['writer', false],
      ['owner', true],
    ])
    const plan = recordDetail(entry, w.kernel.reading('plans'), `folder:${w.proj}/p`, { voice, notes: check })!
    expect(((plan.value.tasks as Json[])[0]!.notes as Json[]).map((n) => n.fromOwner)).toEqual([false, false, true])
    const page = recordsPage(entry, w.kernel.reading('plans'), { voice, overlayKeys: new Set(), conflictKeys: new Set(), notes: check }, {
      kind: 'plan/task',
      values: true,
    } as never)
    if ('error' in page) throw new Error(page.error)
    expect((page.records[0]!.value!.notes as Json[]).map((n) => n.fromOwner)).toEqual([false, false, true])
    // never mutates the reading
    expect((w.kernel.reading('plans')!.records[0]!.record.tasks as Json[])[0]!.notes[0].fromOwner).toBeUndefined()
  })
  it('a note an unattended run left after reading outside is stamped readOutside (S10-r5)', () => {
    setNoteOutside((k, n) => (k === 'k' && n.by === 'x' && n.at === '2' ? ['WebFetch'] : null))
    try {
      const v = {
        id: 't1',
        title: 'T',
        owner: 'y',
        status: 'pending',
        notes: [
          { at: '1', by: 'y', text: 'mine' },
          { at: '2', by: 'x', text: 'run this' },
        ],
      }
      const out = withNoteProvenance(plansManifest(), 'plan/task', 'k', v, () => ({ fromOwner: [] })) as { notes: Array<{ readOutside?: string[] }> }
      expect(out.notes.map((n) => n.readOutside)).toEqual([undefined, ['WebFetch']])
    } finally {
      setNoteOutside(null)
    }
  })
  it('a record of another kind passes through untouched', () => {
    const v = { id: 'x', notes: [{ by: 'owner', text: 'hi' }] }
    expect(withNoteProvenance(plansManifest(), 'nope', 'k', v, () => ({ fromOwner: [true] }))).toBe(v)
  })
})

// ── task mode over a stand-in reading ──
const PLAN = 'folder:/p/launch'
const KEY = (id: string): string => `${PLAN}/tasks/${id}`
function readingOf(tasks: Json[]): SiloReading {
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
const ownerNote = (text: string, at = new Date(T0).toISOString()): Json => ({ at, by: 'owner', text })
const t = (id: string, over: Json = {}): Json => ({
  id,
  title: `Task ${id}`,
  owner: 'writer',
  state: 'pending',
  dependsOn: [],
  conversations: ['s-1'],
  ...over,
})

function modeWorld(o: { check?: () => OwnerNoteCheck; failWrites?: () => boolean; bound?: string[] } = {}) {
  let now = T0
  let tasks: Json[] = []
  const writes: Array<[string, string, unknown]> = []
  const notes: Array<[string, string]> = []
  const store = new TaskModeStore(join(base, 'tm'))
  const deps: TaskModeDeps = {
    store,
    plans: () => ({ reading: readingOf(tasks) }),
    bound: () => new Set(o.bound ?? ['writer']),
    ready: () => true,
    setField: (k, f, v) => {
      if (o.failWrites?.()) return { ok: false, reason: 'the plan changed' }
      writes.push([k, f, v])
      return { ok: true }
    },
    appendConversation: () => ({ ok: true }),
    appendNote: (k, text) => {
      notes.push([k, text])
      return { ok: true }
    },
    conversationOf: () => null,
    holdersOf: () => [],
    busyWhy: () => null,
    send: () => ({ turnId: 'x', done: new Promise(() => {}) }),
    deliveryOff: true,
    ...(o.check ? { ownerNotes: o.check } : {}),
    now: () => now,
  }
  const engine = new TaskModeEngine(deps)
  return {
    engine,
    store,
    writes,
    notes,
    set: (x: Json[]) => {
      tasks = x
    },
    at: (ms: number) => {
      now = ms
    },
  }
}

describe("ONE reopen rule, now in the note's own write", () => {
  // the rule itself lives in the note's write now
  // (silos/actions.ts reopenVerdict — its cases in task-owner-write-routes.test.ts);
  // Task mode only wakes on the note, and never writes a reopen
  it("the review's scenario: t5 blocked on open t4 and asking the owner — the answer's note wakes but never reopens", () => {
    const w = modeWorld()
    const base5 = { state: 'blocked', dependsOn: ['t4'], waitingOn: { owner: 'owner', action: 'A or B?' } }
    w.set([t('t4'), t('t5', base5)])
    w.engine.look()
    w.set([t('t4'), t('t5', { ...base5, notes: [ownerNote('A')] })])
    w.engine.look()
    expect(w.writes).toEqual([])
    expect(w.store.wakes().map((x) => x.reason)).toEqual(['owner-note'])
  })
})

describe("the owner's notes by identity; a lost one is said", () => {
  it('one note lost and another written between two looks: the new one still wakes', () => {
    const w = modeWorld()
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('first')] })])
    w.engine.look()
    w.set([t('t1', { notes: [ownerNote('second', new Date(T0 + MIN).toISOString())] })])
    w.engine.look()
    expect(
      w.store
        .wakes()
        .filter((x) => x.reason === 'owner-note')
        .map((x) => x.notes.map((n) => n.text)),
    ).toEqual([['first'], ['second']])
  })
  it('a recorded owner note the file lost is said on its task once its grace passed — once, for any owner, bound or not', () => {
    const lostAt = new Date(T0).toISOString()
    const check = (): OwnerNoteCheck => (k, notes) => ({
      fromOwner: notes.map(() => true),
      lost: k === KEY('t1') ? [{ at: lostAt, digest: noteDigest('ship on Friday'), text: 'ship on Friday' }] : [],
    })
    const w = modeWorld({ check, bound: [] })
    w.set([t('t1', { owner: 'ops' })])
    w.at(T0 + MIN)
    w.engine.look()
    expect(w.notes).toEqual([]) // within the grace: the reading may lag the log
    w.at(T0 + LOST_NOTE_GRACE_MS + 1)
    w.engine.look()
    expect(w.notes).toEqual([[KEY('t1'), expect.stringContaining(`The owner's note of ${lostAt} is no longer in this task's notes`)]])
    expect(w.notes[0]![1]).toContain('«ship on Friday»')
    // the note on the task is its own record: said once
    w.set([t('t1', { owner: 'ops', notes: [{ at: new Date(T0 + 3 * MIN).toISOString(), by: SILOS_AUTHOR, text: w.notes[0]![1] }] })])
    w.engine.look()
    expect(w.notes).toHaveLength(1)
  })
})

describe('an escalation hop whose writes did not land keeps its case', () => {
  it('the case stays open with writesDue, tried again; one recovery note, never a second case', () => {
    const task: TaskSnap = {
      key: KEY('t1'),
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
    let fail = true
    let failed = task
    const writes: Array<[string, unknown]> = []
    const notes: string[] = []
    const store = new EscalationStore(join(base, 'esc'))
    const e = new EscalationEngine({
      store,
      // after the failed hop the task is NOT as Silos would have left it, and
      // its stall may be gone (the wait did land elsewhere) — the case holds
      taskMode: {
        tasks: () => [failed],
        retryFailed: (now) =>
          now < T0 + 2 * MIN ? [{ task, cause: 'in-progress-nothing-live', since: new Date(T0).toISOString(), wokeAt: new Date(T0).toISOString() }] : [],
      },
      chain: () => ({ installed: false, up: () => [] }),
      isAgent: () => true,
      nameOf: (id) => id,
      setField: (_k, f, v) => {
        if (fail) return { ok: false, reason: '409' }
        writes.push([f, v])
        return { ok: true }
      },
      appendNote: (_k, text) => {
        notes.push(text)
        return { ok: true }
      },
      message: () => {},
      now: () => T0,
    })
    e.tick(T0)
    expect(store.cases()[`task:${KEY('t1')}`]).toMatchObject({ writesDue: true, hops: [{ to: 'owner' }] })
    expect(notes).toHaveLength(1)
    // the next tick: retryFailed no longer lists it, the task is untouched — kept, tried again
    fail = false
    e.tick(T0 + 3 * MIN)
    expect(writes).toEqual([
      ['waitingOn', { owner: 'owner', action: 'unstick launch#t1' }],
      ['status', 'blocked'],
    ])
    expect(store.cases()[`task:${KEY('t1')}`]!.writesDue).toBeUndefined()
    // now as Silos left it: the case lives on that shape, no second note
    failed = { ...task, state: 'blocked', waitingOn: true, waitingFor: { owner: 'owner', action: 'unstick launch#t1' } }
    e.tick(T0 + 4 * MIN)
    expect(Object.keys(store.cases())).toEqual([`task:${KEY('t1')}`])
    expect(notes).toHaveLength(1)
    expect(store.closed()).toEqual([])
  })
})
