// plans-provenance.test.ts — the plans reader stamps and judges:
// judgeCreation (signal by class, quotas by signal
// class, the cut), judgeBirth (G6-r7), judgeTransition as an ALLOW-LIST
// field by field (G3-r6), attribution by WRITE only (S2-r5), the stamper's
// adoption / cancellation / revert / re-stamp / resurrection (c) and replay.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CreationsStore, type Creation } from '../src/creations.js'
import type { LiveTurn } from '../src/live-turns.js'
import { PlansOrigins, noteReadOutside, originIsKnown, type Candidate } from '../src/plans-origins.js'
import {
  NOTE_NO_SIGNAL,
  NOTE_OPEN_MAX,
  OPEN_MAX_WORDS,
  SIGNAL_REQUIRED_HEARTBEAT,
  MISSION_OUTSIDE_THINK,
  CUT_RESTORED_CANCELLED,
  CUT_RESTORED_UNDONE,
  PlansProvenance,
  judgeBirth,
  judgeCreation,
  judgeTransition,
  noteOverWeek,
  weekWords,
  writesFile,
  type JudgeTurn,
  type PlansSnapshot,
  type TaskView,
} from '../src/plans-provenance.js'

const NOW = Date.parse('2026-11-11T10:00:00Z')
const think: JudgeTurn = { class: 'heartbeat', unattended: true, kind: 'think', packetKeys: ['message:m1', 'task:k9'] }
const look: JudgeTurn = { class: 'heartbeat', unattended: true, kind: 'look', packetKeys: ['message:m1'] }
const base = { agent: { id: 'x', name: 'X' }, ledger: [] as Creation[], now: NOW, openTask: () => true, selfRecurrentLive: 0 }
const made = (over: Partial<Creation>): Creation => ({ id: 'c1', kind: 'task', ref: 'r1', title: 't', createdAt: '2026-11-10T09:00:00Z', by: 'x', ...over })

describe('judgeCreation — one source of the rules', () => {
  it('an attended turn is stamped, never judged', () => {
    expect(judgeCreation({ ...base, turn: { class: 'console', unattended: false } })).toEqual({ ok: true, judged: false, mission: false })
  })
  it('a heartbeat without signal: 403 with its words; the file path note', () => {
    const v = judgeCreation({ ...base, turn: look })
    expect(v).toMatchObject({ ok: false, code: 403, error: SIGNAL_REQUIRED_HEARTBEAT, note: NOTE_NO_SIGNAL })
  })
  it('a reactive signal must be an item of the packet', () => {
    expect(judgeCreation({ ...base, turn: look, signal: 'message:m1' })).toMatchObject({ ok: true, mission: false })
    expect(judgeCreation({ ...base, turn: look, signal: 'message:zz' })).toMatchObject({ ok: false, code: 403 })
  })
  it('a wake: its task; a run: its run', () => {
    expect(judgeCreation({ ...base, turn: { class: 'wake', unattended: true, taskKey: 'k' }, signal: 'task:k' })).toMatchObject({ ok: true })
    expect(judgeCreation({ ...base, turn: { class: 'wake', unattended: true, taskKey: 'k' }, signal: 'task:other' })).toMatchObject({ ok: false })
    expect(judgeCreation({ ...base, turn: { class: 'run', unattended: true, automationId: 'a1', runId: 'r1' }, signal: 'run:a1' })).toMatchObject({ ok: true })
  })
  it('mission outside the think: 403', () => {
    expect(judgeCreation({ ...base, turn: look, signal: 'mission' })).toMatchObject({ ok: false, code: 403, error: MISSION_OUTSIDE_THINK })
  })
  it('one initiative a week: the second is 429 with the date, and its note', () => {
    const ledger = [made({ signal: 'mission', createdAt: '2026-11-09T09:00:00Z' })]
    const v = judgeCreation({ ...base, ledger, turn: think, signal: 'mission' })
    expect(v).toMatchObject({ ok: false, code: 429, error: weekWords('2026-11-09'), note: noteOverWeek('2026-11-09') })
  })
  it('a rejected initiative does not spend the week; an adopted one does (M5-r4)', () => {
    const rejected = [made({ signal: 'mission', rejected: { at: 'x', why: 'y' } })]
    expect(judgeCreation({ ...base, ledger: rejected, turn: think, signal: 'mission' })).toMatchObject({ ok: true, mission: true })
    const adopted = [made({ signal: 'mission', rejected: { at: 'x', why: 'y' }, adopted: { at: 'z', label: 'kept by the owner' } })]
    expect(judgeCreation({ ...base, ledger: adopted, turn: think, signal: 'mission' })).toMatchObject({ ok: false, code: 429 })
  })
  it('INITIATIVES_OPEN_MAX counts open mission tasks + live own recurrents, with its note', () => {
    const old = (i: number): Creation => made({ id: `c${i}`, ref: `r${i}`, signal: 'mission', createdAt: '2026-10-01T09:00:00Z' })
    const v = judgeCreation({ ...base, ledger: [old(1), old(2)], selfRecurrentLive: 1, turn: think, signal: 'mission' })
    expect(v).toMatchObject({ ok: false, code: 429, error: OPEN_MAX_WORDS, note: NOTE_OPEN_MAX })
    // closed ones do not count
    expect(judgeCreation({ ...base, ledger: [old(1), old(2)], selfRecurrentLive: 1, openTask: () => false, turn: think, signal: 'mission' })).toMatchObject({
      ok: true,
    })
  })
  it('a reactive creation NEVER dies of a numeric quota (S4-r5)', () => {
    const many = Array.from({ length: 30 }, (_, i) => made({ id: `c${i}`, ref: `r${i}`, signal: 'message:m1', createdAt: '2026-11-11T09:00:00Z' }))
    const full = [...many, made({ id: 'w', ref: 'w', signal: 'mission', createdAt: '2026-11-10T09:00:00Z' })]
    expect(judgeCreation({ ...base, ledger: full, selfRecurrentLive: 3, turn: think, signal: 'message:m1' })).toMatchObject({ ok: true, mission: false })
  })
  it('the cut denies every creation, with its words', () => {
    const v = judgeCreation({
      ...base,
      agent: { id: 'x', name: 'X', cut: { at: '2026-11-01T00:00:00Z', why: 'created work after reading outside (WebFetch)' } },
      turn: think,
      signal: 'message:m1',
    })
    expect(v).toMatchObject({ ok: false, code: 403, reason: 'cut' })
    if (!v.ok) expect(v.note).toBe("Silos cancelled it: creating work of X's own is stopped — created work after reading outside (WebFetch)")
  })
})

describe('judgeBirth — born pending and clean for another owner (G6-r7)', () => {
  it('keeps title, dependsOn, signal, notes; drops the rest field by field', () => {
    for (const f of ['waitingOn', 'nextCheckAt', 'due', 'short', 'source', 'parent']) {
      expect(judgeBirth({ id: 't1', title: 'a', owner: 'y', status: 'pending', [f]: { owner: 'owner', asked: 'q' } }, 'x')).toEqual([f])
    }
    expect(judgeBirth({ id: 't1', title: 'a', owner: 'y', status: 'blocked' }, 'x')).toEqual(['status'])
    expect(judgeBirth({ id: 't1', title: 'a', owner: 'y', status: 'pending', dependsOn: ['t0'], signal: 'mission', notes: [] }, 'x')).toEqual([])
  })
  it('its own task: nothing to clean', () => {
    expect(judgeBirth({ id: 't1', title: 'a', owner: 'x', status: 'in_progress', waitingOn: {} }, 'x')).toEqual([])
  })
})

describe('judgeTransition — an ALLOW-LIST on foreign tasks (G3-r6), test per field', () => {
  const before = { id: 't1', title: 'A', owner: 'y', status: 'pending', dependsOn: ['t0'], notes: [{ at: '1', by: 'y', text: 'n' }] }
  for (const [field, value] of [
    ['status', 'done'],
    ['status', 'cancelled'],
    ['status', 'in_progress'],
    ['owner', 'x'],
    ['dependsOn', []],
    ['waitingOn', { owner: 'owner', asked: 'fabricated?' }],
    ['nextCheckAt', '2026-11-12T00:00:00Z'],
    ['title', 'B'],
  ] as const) {
    it(`${field} → ${JSON.stringify(value)} is reverted`, () => {
      expect(judgeTransition(before, { ...before, [field]: value }, 'x')).toMatchObject({ judge: true, revert: true, fields: [field] })
    })
  }
  it('deleting a field is reverted', () => {
    const { dependsOn: _d, ...without } = before
    expect(judgeTransition(before, without, 'x')).toMatchObject({ revert: true, fields: ['dependsOn'] })
  })
  it('removing the task is reverted', () => {
    expect(judgeTransition(before, null, 'x')).toMatchObject({ revert: true, removed: true })
  })
  it('appending a note survives; rewriting one does not', () => {
    expect(judgeTransition(before, { ...before, notes: [...before.notes, { at: '2', by: 'x', text: 'hi' }] }, 'x')).toEqual({ judge: true, revert: false })
    expect(judgeTransition(before, { ...before, notes: [{ at: '1', by: 'y', text: 'changed' }] }, 'x')).toMatchObject({ revert: true, fields: ['notes'] })
  })
  it('its own task is not judged; a gift self→Y is (G6-r7)', () => {
    const own = { ...before, owner: 'x' }
    expect(judgeTransition(own, { ...own, status: 'done' }, 'x')).toEqual({ judge: false })
    expect(judgeTransition(own, { ...own, owner: 'y' }, 'x')).toMatchObject({ revert: true, fields: ['owner'] })
  })
})

describe('writesFile — attribution by WRITE only (S2-r5)', () => {
  const plan = '/w/proj/plans/tasks.plan.json'
  it('Write/Edit file paths and shell writes attribute', () => {
    expect(writesFile([{ name: 'Edit', session: 's', writes: ['plans/tasks.plan.json'] }], plan, '/w/proj', '/h')).toBe(true)
    expect(writesFile([{ name: 'Bash', session: 's', command: 'jq . x > plans/tasks.plan.json' }], plan, '/w/proj', '/h')).toBe(true)
    expect(writesFile([{ name: 'Bash', session: 's', command: 'cp /tmp/p.json /w/proj/plans/tasks.plan.json' }], plan, '/w/proj', '/h')).toBe(true)
  })
  it('a read never attributes (cat, grep, Read)', () => {
    expect(
      writesFile(
        [
          { name: 'Bash', session: 's', command: 'cat plans/tasks.plan.json | grep t3' },
          { name: 'Read', session: 's' },
        ],
        plan,
        '/w/proj',
        '/h',
      ),
    ).toBe(false)
  })
})

// ── the stamper, with a fake kernel ──────────────────────────────────────

interface World {
  files: Map<string, Record<string, unknown>> // key → task raw
  live: LiveTurn[]
  wrote: Set<string> // `${turnId}` that wrote the plan
  tainted: Set<string>
  cuts: Array<{ agent: string; why: string; run?: string }>
  restored: Array<{ key: string; owner: string }>
  stamper: PlansProvenance
  origins: PlansOrigins
  creations: CreationsStore
  journal: Array<{ at: string; event: string; key?: string; kind?: string }>
  read(): void
}

const PLAN = '/w/proj/plans/tasks.plan.json'
const keyOf = (id: string): string => `proj/tasks/tasks/${id}`
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prov-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function world(initial: Record<string, Record<string, unknown>> = {}): World {
  const files = new Map(Object.entries(initial).map(([id, t]) => [keyOf(id), { id, ...t }]))
  const known = new Set<string>()
  let reads = 0
  const w: World = {
    files,
    live: [],
    wrote: new Set(),
    tainted: new Set(),
    cuts: [],
    restored: [],
    journal: [],
    origins: new PlansOrigins(join(dir, 'plans-origins.json')),
    creations: new CreationsStore(dir),
    stamper: null as unknown as PlansProvenance,
    read() {
      // the kernel's journal: baseline on the first read, appeared after
      const first = reads++ === 0
      for (const k of files.keys())
        if (!known.has(k)) {
          w.journal.push({ at: new Date(NOW).toISOString(), event: first ? 'baseline' : 'appeared', key: k, kind: 'plan/task' })
          known.add(k)
        }
      for (const k of [...known]) if (!files.has(k)) known.delete(k)
      const tasks = new Map<string, TaskView>()
      for (const [k, raw] of files) tasks.set(k, { key: k, file: PLAN, location: 'proj', raw: JSON.parse(JSON.stringify(raw)) as Record<string, unknown> })
      w.stamper.onReading({ tasks, complete: true } satisfies PlansSnapshot)
    },
  }
  w.stamper = new PlansProvenance({
    origins: w.origins,
    creations: w.creations,
    cursorFile: join(dir, 'plans-provenance.json'),
    agents: () => [
      { id: 'x', name: 'X', folders: ['/w/proj'] },
      { id: 'y', name: 'Y', folders: ['/w/proj'] },
    ],
    liveOf: (id) => w.live.filter((t) => t.agentId === id),
    probe: { wrote: async (c: Candidate) => w.wrote.has(c.turnId) },
    write: (key, mutate, _text) => {
      const id = key.slice(key.lastIndexOf('/') + 1)
      const list = [...files.values()].map((t) => JSON.parse(JSON.stringify(t)) as Record<string, unknown>)
      const child = list.find((t) => t.id === id) ?? null
      const out = mutate(child, list)
      if (typeof out === 'string') return { ok: false, reason: out }
      if (!out.write) return { ok: true }
      const next = list.find((t) => t.id === id)
      if (next) files.set(key, next)
      w.read() // the kernel re-reads after every write
      return { ok: true }
    },
    journal: () => [{ dir: 'plans', read: (n: number) => ({ lines: w.journal.slice(n), next: w.journal.length }) }],
    runVerdict: (_a, run) => (w.tainted.has(run) ? { tainted: true, readOutside: ['WebFetch'] } : null),
    selfRecurrentLive: () => 0,
    cut: (agent, why, run) => {
      w.cuts.push({ agent, why, ...(run ? { run } : {}) })
    },
    ownerRestored: (key, owner) => {
      w.restored.push({ key, owner })
    },
    now: () => NOW,
  })
  w.read()
  return w
}

const turn = (over: Partial<LiveTurn>): LiveTurn => ({
  agentId: 'x',
  turnId: 'T1',
  unattended: true,
  class: 'heartbeat',
  kind: 'think',
  packetKeys: ['message:m1'],
  runId: 'R1',
  at: new Date(NOW - 60_000).toISOString(),
  ...over,
})
const notesOf = (t: Record<string, unknown> | undefined): string[] => ((t?.notes as Array<{ text: string }> | undefined) ?? []).map((n) => n.text)

describe('the stamper — adoption by file', () => {
  it('the baseline is unknown, the block door blesses (M13-r6 data)', () => {
    const w = world({ t1: { title: 'old', owner: 'x', status: 'pending' } })
    expect(w.origins.get(keyOf('t1'))).toMatchObject({ by: 'unknown', how: 'baseline' })
    expect(originIsKnown(w.origins.get(keyOf('t1')))).toBe(false)
  })

  it('ONE unattended candidate is provisional until its turn ends and a WRITE confirms — then adopted and judged', async () => {
    const w = world()
    w.live.push(turn({}))
    w.files.set(keyOf('t2'), { id: 't2', title: 'new', owner: 'x', status: 'pending', signal: 'message:m1' })
    w.read()
    expect(w.origins.get(keyOf('t2'))?.provisional).toBeDefined()
    expect(originIsKnown(w.origins.get(keyOf('t2')))).toBe(false)
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.origins.get(keyOf('t2'))).toMatchObject({ by: 'x', how: 'creation' })
    expect(w.creations.byRef('x', keyOf('t2'))).toMatchObject({ run: 'R1', signal: 'message:m1' })
    // the mirror fields in the file
    expect(w.files.get(keyOf('t2'))).toMatchObject({ createdBy: 'x', origin: 'self', run: 'R1' })
  })

  it('the owner adding a task while a wake only READ the plan: unknown, never cancelled (S2-r5)', async () => {
    const w = world()
    w.live.push(turn({ class: 'wake', kind: undefined, packetKeys: undefined, taskKey: 'k' }))
    w.files.set(keyOf('t3'), { id: 't3', title: 'mine', owner: 'owner', status: 'pending' })
    w.read()
    w.live = [] // the wake ends without writing the plan
    await w.stamper.settle()
    expect(w.origins.get(keyOf('t3'))).toMatchObject({ by: 'unknown' })
    expect(w.files.get(keyOf('t3'))?.status).toBe('pending')
  })

  it('a tie of writers ⇒ unknown, the task stays', async () => {
    const w = world()
    w.live.push(turn({}), turn({ agentId: 'y', turnId: 'T2', runId: 'R2' }))
    w.files.set(keyOf('t4'), { id: 't4', title: 'x', owner: 'x', status: 'pending', signal: 'message:m1' })
    w.read()
    w.wrote.add('T1')
    w.wrote.add('T2')
    w.live = []
    await w.stamper.settle()
    expect(w.origins.get(keyOf('t4'))).toMatchObject({ by: 'unknown' })
    expect(w.files.get(keyOf('t4'))?.status).toBe('pending')
  })

  it('no signal ⇒ Silos cancels it with its note and a rejected entry', async () => {
    const w = world()
    w.live.push(turn({}))
    w.files.set(keyOf('t5'), { id: 't5', title: 'x', owner: 'x', status: 'pending' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.files.get(keyOf('t5'))?.status).toBe('cancelled')
    expect(notesOf(w.files.get(keyOf('t5')))).toContain(NOTE_NO_SIGNAL)
    expect(w.creations.byRef('x', keyOf('t5'))?.rejected).toBeDefined()
  })

  it('over the weekly quota ⇒ cancelled with its note', async () => {
    const w = world()
    w.creations.add('x', { kind: 'task', ref: 'other', title: 'o', createdAt: '2026-11-10T09:00:00Z', by: 'x', signal: 'mission' })
    w.live.push(turn({}))
    w.files.set(keyOf('t6'), { id: 't6', title: 'x', owner: 'x', status: 'pending', signal: 'mission' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(notesOf(w.files.get(keyOf('t6')))).toContain(noteOverWeek('2026-11-10'))
  })

  it('adopted AFTER its tainted turn ended ⇒ undone at adoption (S6-r4)', async () => {
    const w = world()
    w.live.push(turn({}))
    w.files.set(keyOf('t7'), { id: 't7', title: 'x', owner: 'x', status: 'pending', signal: 'message:m1' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    w.tainted.add('R1')
    await w.stamper.settle()
    expect(w.files.get(keyOf('t7'))?.status).toBe('cancelled')
    expect(notesOf(w.files.get(keyOf('t7')))).toContain('Undone by Silos: created after reading outside (WebFetch)')
  })

  it('a creation for Y is born pending and clean (G6-r7)', async () => {
    const w = world()
    w.live.push(turn({}))
    w.files.set(keyOf('t8'), {
      id: 't8',
      title: 'for y',
      owner: 'y',
      status: 'blocked',
      signal: 'message:m1',
      waitingOn: { owner: 'owner', asked: 'q?' },
      nextCheckAt: '2026-11-12T00:00:00Z',
    })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    const t = w.files.get(keyOf('t8'))!
    expect(t.status).toBe('pending')
    expect(t.waitingOn).toBeUndefined()
    expect(t.nextCheckAt).toBeUndefined()
  })

  it('a whole rewrite losing the mirror fields is re-stamped on the next reading (m3)', async () => {
    const w = world()
    w.live.push(turn({}))
    w.files.set(keyOf('t9'), { id: 't9', title: 'x', owner: 'x', status: 'pending', signal: 'message:m1' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    w.files.set(keyOf('t9'), { id: 't9', title: 'x', owner: 'x', status: 'in_progress' })
    w.read()
    expect(w.files.get(keyOf('t9'))).toMatchObject({ createdBy: 'x', origin: 'self', signal: 'message:m1', status: 'in_progress' })
  })
})

// Silos' own write through an API route — an ask
// answered — registered with ownWrite: the reading that shows it is Silos',
// and it is the base an unattended turn that ALSO touches the same task (a
// note of its own) is judged against: nothing reverted
describe("the stamper — ownWrite: Silos' write is not reverted by a turn that edits the same plan (H4)", () => {
  const answered = { id: 'y9', title: 'Y task', owner: 'y', status: 'pending', notes: [{ at: '2026-11-11T09:58:00Z', by: 'x', text: 'the answer' }] }
  const asked = { id: 'y9', title: 'Y task', owner: 'y', status: 'blocked', waitingOn: { owner: 'x', action: 'review it' }, notes: [] }
  it("the unattended turn that answered appends a note before the next reading: Silos' write stands, its note survives", async () => {
    const w = world({ y9: asked })
    w.live.push(turn({}))
    // Silos answers for x (status, wait, the note): registered, then written — the reading lags
    w.stamper.ownWrite(keyOf('y9'), answered)
    w.files.set(keyOf('y9'), JSON.parse(JSON.stringify(answered)))
    // x, in the same unattended turn, edits the plan file: a note of its own
    w.files.set(keyOf('y9'), { ...answered, notes: [...answered.notes, { at: '2026-11-11T09:59:00Z', by: 'x', text: 'and one more thing' }] })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    const t = w.files.get(keyOf('y9'))!
    expect(t.status).toBe('pending')
    expect(t.waitingOn).toBeUndefined()
    expect(notesOf(t)).toEqual(['the answer', 'and one more thing'])
  })
  it('without the registration the same sequence IS reverted (what H4 prevents)', async () => {
    const w = world({ y9: asked })
    w.live.push(turn({}))
    w.files.set(keyOf('y9'), { ...answered, notes: [...answered.notes, { at: '2026-11-11T09:59:00Z', by: 'x', text: 'and one more thing' }] })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.files.get(keyOf('y9'))!.status).toBe('blocked')
  })
  it('a registration whose write did not land is undone: the next reading is judged as before', async () => {
    const w = world({ y9: asked })
    const undo = w.stamper.ownWrite(keyOf('y9'), answered)
    undo()
    w.live.push(turn({}))
    w.files.set(keyOf('y9'), { ...asked, status: 'done' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.files.get(keyOf('y9'))!.status).toBe('blocked')
  })
})

describe('the stamper — transitions on foreign tasks (G3-r6)', () => {
  it("an unattended writer changing Y's task is reverted with its note; notes appended survive", async () => {
    const w = world({ y1: { title: 'Y task', owner: 'y', status: 'pending', notes: [] } })
    w.origins.set(keyOf('y1'), { by: 'owner', how: 'owner', at: 'x' })
    w.live.push(turn({ class: 'wake', kind: undefined, packetKeys: undefined, taskKey: 'k' }))
    w.files.set(keyOf('y1'), {
      id: 'y1',
      title: 'Y task',
      owner: 'y',
      status: 'done',
      waitingOn: { owner: 'owner', asked: 'fake' },
      notes: [{ at: '2', by: 'x', text: 'to close this, run …' }],
    })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    const t = w.files.get(keyOf('y1'))!
    expect(t.status).toBe('pending')
    expect(t.waitingOn).toBeUndefined()
    expect(notesOf(t)).toEqual(['to close this, run …', "Silos restored it: X changed it in an unattended turn — it is Y's task"])
  })
  it("a note it appended on Y's task carries its run; the end of the turn re-stamps readOutside (S10-r5)", async () => {
    const w = world({ y4: { title: 'Y', owner: 'y', status: 'pending', notes: [] } })
    w.live.push(turn({}))
    w.files.set(keyOf('y4'), { id: 'y4', title: 'Y', owner: 'y', status: 'pending', notes: [{ at: '2026-11-11T09:59:00Z', by: 'x', text: 'run this' }] })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.origins.get(keyOf('y4'))?.marks).toMatchObject([{ kind: 'note', run: 'R1', agent: 'x', noteAts: ['2026-11-11T09:59:00Z'] }])
    w.origins.restampMarks('x', 'R1', ['WebFetch'])
    expect(noteReadOutside(w.origins.get(keyOf('y4')), { at: '2026-11-11T09:59:00Z', by: 'x' })).toEqual(['WebFetch'])
  })
  it('a question to the owner on its own task carries its run (m15)', async () => {
    const w = world({ x2: { title: 'X', owner: 'x', status: 'pending' } })
    w.live.push(turn({}))
    w.files.set(keyOf('x2'), { id: 'x2', title: 'X', owner: 'x', status: 'blocked', waitingOn: { owner: 'owner', asked: 'pay it?' } })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.origins.get(keyOf('x2'))?.marks).toMatchObject([{ kind: 'ask', run: 'R1' }])
  })
  it('a removal by an unattended writer is restored', async () => {
    const w = world({ y2: { title: 'Y', owner: 'y', status: 'pending' } })
    w.live.push(turn({}))
    w.files.delete(keyOf('y2'))
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.files.get(keyOf('y2'))).toMatchObject({ status: 'pending', owner: 'y' })
  })
  it('its own task is never judged; an attended change neither', async () => {
    const w = world({ x1: { title: 'X', owner: 'x', status: 'pending' }, y3: { title: 'Y', owner: 'y', status: 'pending' } })
    w.live.push(turn({}))
    w.files.set(keyOf('x1'), { id: 'x1', title: 'X', owner: 'x', status: 'done' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.files.get(keyOf('x1'))?.status).toBe('done')
    w.live.push(turn({ class: 'console', unattended: false, turnId: 'C1' }))
    w.files.set(keyOf('y3'), { id: 'y3', title: 'Y', owner: 'y', status: 'done' })
    w.read()
    w.wrote.add('C1')
    w.live = []
    await w.stamper.settle()
    expect(w.files.get(keyOf('y3'))?.status).toBe('done')
  })
})

// a verdict still pending when the owner writes the same
// task restores ONLY the fields it judged, over the task as it is now: the
// owner's hand (or Done) written after the foreign change stays
describe('the stamper — a pending verdict restores only what it judged (K1)', () => {
  const y5 = { id: 'y5', title: 'Y task', owner: 'y', status: 'in_progress', notes: [] as unknown[] }
  for (const [gesture, after] of [
    ['hand', { owner: 'owner', status: 'pending', notes: [{ at: '2026-11-11T09:59:30Z', by: 'owner', text: 'Handed from Y to you.' }] }],
    ['done', { status: 'done' }],
  ] as const) {
    it(`a foreign title change pending its verdict, then the owner's ${gesture}: the title comes back, the ${gesture} stays`, async () => {
      const w = world({ y5 })
      w.origins.set(keyOf('y5'), { by: 'owner', how: 'owner', at: 'x' })
      w.live.push(turn({ class: 'wake', kind: undefined, packetKeys: undefined, taskKey: 'k' }))
      // x's unattended turn retitles y's task — queued, its turn still live
      w.files.set(keyOf('y5'), { ...y5, title: 'retitled by x' })
      w.read()
      // the owner's gesture, registered as Silos' own write (J3)
      const owned = { ...y5, title: 'retitled by x', ...after }
      w.stamper.ownWrite(keyOf('y5'), owned)
      w.files.set(keyOf('y5'), JSON.parse(JSON.stringify(owned)))
      w.read()
      w.wrote.add('T1')
      w.live = []
      await w.stamper.settle()
      const t = w.files.get(keyOf('y5'))!
      expect(t.title).toBe('Y task')
      for (const [f, v] of Object.entries(after)) if (f !== 'notes') expect(t[f]).toEqual(v)
      if (gesture === 'hand') expect(notesOf(t)[0]).toBe('Handed from Y to you.')
      expect(w.restored).toEqual([])
    })
  }
  it('a removed task still comes back whole', async () => {
    const w = world({ y6: { title: 'Y', owner: 'y', status: 'pending', dependsOn: ['t0'] } })
    w.live.push(turn({}))
    w.files.delete(keyOf('y6'))
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.files.get(keyOf('y6'))).toMatchObject({ owner: 'y', status: 'pending', dependsOn: ['t0'] })
  })
})

// (J3, K5) a steal of the owner field reverted: ownerRestored names the owner
// it restored — what it cancels is everyone else's (stopTask keep)
describe('the stamper — ownerRestored names the restored owner (K5)', () => {
  it("x takes y's task in an unattended turn: restored to y, and ownerRestored(key, 'y')", async () => {
    const w = world({ y7: { title: 'Y', owner: 'y', status: 'pending' } })
    w.live.push(turn({}))
    w.files.set(keyOf('y7'), { id: 'y7', title: 'Y', owner: 'x', status: 'in_progress' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.files.get(keyOf('y7'))).toMatchObject({ owner: 'y', status: 'pending' })
    expect(w.restored).toEqual([{ key: keyOf('y7'), owner: 'y' }])
  })
})

describe('the stamper — resurrection (race (c), G2-r6)', () => {
  async function cancelledCreation(w: World, over: Partial<Creation>): Promise<void> {
    w.files.set(keyOf('c1'), { id: 'c1', title: 'mine', owner: 'x', status: 'cancelled' })
    w.read()
    const c = w.creations.add('x', {
      kind: 'task',
      ref: keyOf('c1'),
      title: 'mine',
      createdAt: '2026-11-10T09:00:00Z',
      by: 'x',
      signal: 'message:m1',
      run: 'R0',
      ...over,
    })
    w.origins.set(keyOf('c1'), { by: 'x', how: 'creation', at: 'x', creation: { agent: 'x', id: c.id } })
  }
  it('the agent restoring what Silos cancelled: re-cancelled + cut', async () => {
    const w = world()
    await cancelledCreation(w, { rejected: { at: 'a', why: 'b' } })
    w.live.push(turn({}))
    w.files.set(keyOf('c1'), { id: 'c1', title: 'mine', owner: 'x', status: 'pending' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.files.get(keyOf('c1'))?.status).toBe('cancelled')
    expect(w.cuts).toEqual([{ agent: 'x', why: CUT_RESTORED_CANCELLED, run: 'R1' }])
  })
  it('the agent restoring what the OWNER undid: re-cancelled + cut (G2-r6)', async () => {
    const w = world()
    await cancelledCreation(w, { undoneAt: '2026-11-10T10:00:00Z', undoneBy: 'owner' })
    w.live.push(turn({}))
    w.files.set(keyOf('c1'), { id: 'c1', title: 'mine', owner: 'x', status: 'pending' })
    w.read()
    w.wrote.add('T1')
    w.live = []
    await w.stamper.settle()
    expect(w.cuts).toEqual([{ agent: 'x', why: CUT_RESTORED_UNDONE, run: 'R1' }])
  })
  it("nobody claims it (the owner's Reopen): adopted «kept by the owner», keptAt, no cut — and it consumes the week", async () => {
    const w = world()
    await cancelledCreation(w, { signal: 'mission', undoneAt: '2026-11-10T10:00:00Z', undoneBy: 'owner' })
    w.files.set(keyOf('c1'), { id: 'c1', title: 'mine', owner: 'x', status: 'pending' })
    w.read()
    const c = w.creations.byRef('x', keyOf('c1'))!
    expect(c.adopted?.label).toBe('kept by the owner')
    expect(c.keptAt).toBeDefined()
    expect(c.undoneAt).toBeUndefined()
    expect(w.cuts).toEqual([])
    expect(judgeCreation({ ...base, ledger: w.creations.list('x'), turn: think, signal: 'mission' })).toMatchObject({ ok: false, code: 429 })
  })
  it('restored by an attended conversation of the agent: «restored in an attended conversation»', async () => {
    const w = world()
    await cancelledCreation(w, { rejected: { at: 'a', why: 'b' } })
    w.live.push(turn({ class: 'console', unattended: false, turnId: 'C1' }))
    w.files.set(keyOf('c1'), { id: 'c1', title: 'mine', owner: 'x', status: 'pending' })
    w.read()
    w.wrote.add('C1')
    w.live = []
    await w.stamper.settle()
    expect(w.creations.byRef('x', keyOf('c1'))?.adopted?.label).toBe('restored in an attended conversation')
    expect(w.cuts).toEqual([])
  })
})

describe('the cursor — replay after a restart (d)', () => {
  it('the cursor file holds where the stamper stopped: nothing is re-adopted', () => {
    const w = world({ t1: { title: 'a', owner: 'x', status: 'pending' } })
    expect(JSON.parse(readFileSync(join(dir, 'plans-provenance.json'), 'utf8'))).toEqual({ cursors: { plans: w.journal.length }, pending: [] })
  })
  it('a verdict waiting for its turn survives a restart: the next stamper judges it from the file', async () => {
    const w = world()
    w.live.push(turn({}))
    w.files.set(keyOf('r1'), { id: 'r1', title: 'x', owner: 'x', status: 'pending' })
    w.read()
    expect(w.stamper.waiting()).toHaveLength(1)
    // the server stops: the SDK turn dies with it; a new stamper boots on the same files
    w.live = []
    w.wrote.add('T1')
    const deps = (w.stamper as unknown as { deps: ConstructorParameters<typeof PlansProvenance>[0] }).deps
    const again = new PlansProvenance(deps)
    expect(again.waiting()).toHaveLength(1)
    await again.settle()
    // no signal: cancelled by Silos, as if the server had never stopped
    expect(w.files.get(keyOf('r1'))?.status).toBe('cancelled')
    expect(again.waiting()).toHaveLength(0)
  })
})

describe('the kernel reads plans/ in EVERY managed folder', () => {
  it('the house locations are every agent territory — folder and folders[], no installable silo needed', async () => {
    const { houseLocations } = await import('../src/silos/files-source.js')
    const locs = houseLocations(
      { agentIdsOnDisk: () => [], pathFor: (id: string) => `/state/${id}` },
      {
        list: () =>
          [
            { id: 'a', folder: '/w/one', folders: ['/w/two'] },
            { id: 'b', folder: '/w/three' },
          ] as never,
      },
    )
    expect(locs.projects()).toEqual(['/w/one', '/w/three', '/w/two'])
  })
})
