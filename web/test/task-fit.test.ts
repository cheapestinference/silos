// how tasks fit the rest of Silos, the web's own logic: how an agent moves in
// one vocabulary, what assigning will do, the quiet task lines and the rows
// beside Needs you, an agent's question to you, the label a screen paints
// and the monthly archive.
import { describe, expect, it } from 'vitest'
import { askWords, linesOf, stalledTasksDoor, stalledTasksWords, taskLineDoor, wakeCeilingWords } from '../src/lib/task-lines'
import { archiveFolds, archiveMonthOf, inPreset, taskOfRow as rawTaskOfRow, type TaskView } from '../src/lib/tasks'
import { isWaiting, scopeInbox, taskKeyFolder } from '../src/lib/home'
import { searchTasks } from '../src/lib/task-search'
import { taskOfRef } from '../src/lib/task-refs'
import type { AgentView, InboxRow, SiloRecordRow } from '../src/lib/types'
import { serverTaskRow } from './server-task-row'
const taskOfRow = (r: Parameters<typeof rawTaskOfRow>[0]): ReturnType<typeof rawTaskOfRow> => rawTaskOfRow(serverTaskRow(r))

const line = (l: 'waitsStart' | 'comingToYou' | 'idle', count: number, keys: string[] = []): InboxRow => ({
  kind: 'taskLine',
  line: l,
  count,
  keys,
  door: '',
  items: [],
  key: `line:${l}`,
  urgency: 'routine',
  at: 0,
  voice: '',
  clears: '',
})

describe('the quiet task lines (E6 G4, E8 P2)', () => {
  it('a line never waits: not Needs you, not the headline', () => {
    expect(isWaiting(line('idle', 1))).toBe(false)
    expect(isWaiting(line('waitsStart', 1))).toBe(false)
    expect(isWaiting({ kind: 'tasksStalled', count: 2, keys: [], key: 'st', urgency: 'due', at: 0, voice: '', clears: '' })).toBe(true)
  })
  it("the doors: the server's, else the view that lists them", () => {
    expect(taskLineDoor({ line: 'idle', door: '' })).toBe('/tasks?view=idle')
    expect(taskLineDoor({ line: 'idle', door: '/tasks?view=idle&project=%2Fp' })).toBe('/tasks?view=idle&project=%2Fp')
    expect(stalledTasksDoor({})).toBe('/tasks?view=untouched')
    expect(stalledTasksWords({ count: 3 })).toMatch(/^3 /)
    expect(wakeCeilingWords({ used: 30, perDay: 30, waiting: 2 }, 'Writer')).toMatch(/^Writer started 30 times without you today — its max/)
  })
  it("scoped to a project by its tasks' folders, and a line with none left is gone", () => {
    const rows = [line('idle', 2, ['folder:/p/a/tasks/tasks/t1', 'folder:/p/b/ship/tasks/t2'])]
    expect(taskKeyFolder('folder:/p/a/tasks/tasks/t1')).toBe('/p/a')
    const a = scopeInbox(rows, '/p/a', new Set(), 'master')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ count: 1, keys: ['folder:/p/a/tasks/tasks/t1'] })
    expect(scopeInbox(rows, '/p/c', new Set(), 'master')).toEqual([])
    expect(linesOf([...rows, line('comingToYou', 0)], 'comingToYou')).toEqual([])
  })
})

describe("an agent's question to you (E8 P3)", () => {
  const w = (waitingOn: TaskView['waitingOn']) => ({ waitingOn })
  it('`asked` is the row; options are its buttons', () => {
    const asked = askWords(w({ owner: 'owner', action: 'decide', asked: 'publish today?', options: ['Yes', 'No'] }), 'Finance')
    expect(asked).toMatchObject({ options: ['Yes', 'No'], silent: false })
    expect(asked!.text).toContain('publish today?')
  })
  it('options outside the convention are ignored, never a broken button (G9)', () => {
    expect(askWords(w({ owner: 'owner', action: '', asked: 'which?', options: ['a', 'b', 'c', 'd', 'e'] }), 'Finance')!.options).toEqual([])
    expect(askWords(w({ owner: 'owner', action: '', asked: 'which?', options: ['x'.repeat(41)] }), 'Finance')!.options).toEqual([])
  })
  it('no question: its action; neither: it says it did not say', () => {
    expect(askWords(w({ owner: 'owner', action: 'sign the lease' }), 'Writer')!.text).toBe('Writer waits on you: sign the lease')
    expect(askWords(w({ owner: 'owner', action: '' }), 'Writer')).toEqual({ text: "Writer waits on you — it didn't say for what", options: [], silent: true })
  })
  it("the server's words win: the row's sentence and the kernel's options (P3)", () => {
    const kernel = { owner: 'owner', action: 'decide', asked: 'publish today?', options: ['Yes'] }
    const t = { waitingOn: { ...kernel, options: ['Yes', 'No'] }, flow: { waitsOn: kernel } }
    expect(askWords(t, 'Finance', 'Finance asks: publish today? — Publish the post')).toEqual({
      text: 'Finance asks: publish today? — Publish the post',
      options: ['Yes'],
      silent: false,
    })
    // the kernel dropped them (outside G9): none, whatever the raw file says
    expect(askWords({ waitingOn: t.waitingOn, flow: { waitsOn: { ...kernel, options: undefined } } }, 'Finance')!.options).toEqual([])
    // the web's fallback measures as the kernel does (trimmed)
    expect(askWords(w({ owner: 'owner', action: '', asked: 'which?', options: [` ${'x'.repeat(40)} `] }), 'Finance')!.options).toHaveLength(1)
  })
  it('a wait on another person is not yours to answer', () => {
    expect(askWords(w({ owner: 'Sam', action: 'sign', asked: 'ok?' }), 'Writer')).toBeNull()
    expect(askWords(w(null), 'Writer')).toBeNull()
  })
})

// a record row of plans/plan/task, as the records route sends it — the
// server says the project's list (standingList) and the label it paints
function row(
  id: string,
  value: Record<string, unknown>,
  at: { folder?: string; plan?: string; file?: string; flow?: SiloRecordRow['flow']; label?: string } = {},
): TaskView {
  const folder = at.folder ?? '/home/u/cafe'
  const plan = at.plan ?? 'tasks'
  const p = `folder:${folder}/${plan}`
  return taskOfRow({
    key: `${p}/tasks/${id}`,
    id,
    identity: String(value.title ?? id),
    state: String(value.state ?? 'pending'),
    stateLabel: '',
    at: null,
    anchors: { folder },
    cells: [],
    row: '',
    folded: false,
    overlay: false,
    conflict: false,
    remarks: [],
    file: at.file ?? `${folder}/plans/${plan}.plan.json`,
    parent: { key: p, identity: plan === 'tasks' ? '' : plan, at: null, ...(plan === 'tasks' ? { standingList: true as const } : {}) },
    value: { id, owner: 'writer', ...value },
    moved: null,
    ...(at.flow ? { flow: at.flow } : {}),
    label: at.label ?? `${plan === 'tasks' ? folder.split('/').pop() : plan}#${id}`,
  } as SiloRecordRow)!
}

describe('ref stays, label paints (E7)', () => {
  it("a standing list's task paints <project>#t3; a named plan's <plan>#t3; the ref never changes", () => {
    const t = row('t3', {})
    expect([t.ref, t.label]).toEqual(['tasks#t3', 'cafe#t3'])
    const n = row('t4', {}, { plan: 'launch' })
    expect([n.ref, n.label]).toEqual(['launch#t4', 'launch#t4'])
  })
  it("the server's label wins", () => {
    expect(row('t3', {}, { label: 'Café#t3' }).label).toBe('Café#t3')
  })
  it('a reference finds its task by ref or by label — ⌘K and the notes alike', () => {
    const t = row('t3', { title: 'Order the beans' })
    expect(taskOfRef('cafe#t3', [t])).toBe(t)
    expect(taskOfRef('tasks#t3', [t])).toBe(t)
    // no old names: `backlog#t3` is no task
    expect(taskOfRef('backlog#t3', [t])).toBeNull()
    const agents = [] as unknown as AgentView[]
    expect(searchTasks([t], 'cafe#t3', { agentIds: new Set(), ownerSessions: new Set() }, agents, 0).tasks).toEqual([t])
  })
})

describe('released threads are history (E5)', () => {
  it('the last released:true mark per session, cleared by a revive', () => {
    const t = row('t1', {
      conversations: ['s1', 's2'],
      releases: [
        { session: 's1', released: true, at: '2026-11-08T10:00:00Z' },
        { session: 's2', released: true, at: '2026-11-08T11:00:00Z' },
        { session: 's2', released: false, at: '2026-11-08T12:00:00Z' },
      ],
    })
    expect(t.releasedAt).toEqual({ s1: '2026-11-08T10:00:00Z' })
  })
})

describe('idle is a view (E6)', () => {
  it("ready, nobody on it, its owner woken by Silos — the kernel's flow says it", () => {
    const ctx = { agentIds: new Set(['writer']), ownerSessions: new Set<string>() }
    const flow = { waiting: false, gate: false, unblocks: [], stalled: false, stalledCause: null, stalledBy: null }
    expect(inPreset(row('a', {}, { flow: { ...flow, idle: true } }), 'idle', ctx)).toBe(true)
    expect(inPreset(row('b', {}, { flow }), 'idle', ctx)).toBe(false)
    expect(inPreset(row('c', { state: 'done' }, { flow: { ...flow, idle: true } }), 'idle', ctx)).toBe(false)
    const r = searchTasks([row('a', {}, { flow: { ...flow, idle: true } }), row('b', {}, { flow })], 'is:idle', ctx, [] as unknown as AgentView[], 0)
    expect(r.view?.query).toEqual({ view: 'idle' })
    expect(r.tasks.map((t) => t.id)).toEqual(['a'])
  })
})

describe('the monthly archive in Done (E7)', () => {
  it('folds by month, newest first, the year said when it is not this one', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    const oct = row('t1', { state: 'done' }, { file: '/home/u/cafe/plans/closed/tasks-2026-10.plan.json' })
    const dec = row('t2', { state: 'done' }, { file: '/home/u/cafe/plans/closed/tasks-2025-12.plan.json' })
    const live = row('t3', { state: 'done' })
    expect(archiveMonthOf(live)).toBeNull()
    expect(archiveFolds([dec, live, oct], now).map((f) => [f.label, f.tasks.map((t) => t.id)])).toEqual([
      ['Archived · Oct', ['t1']],
      ['Archived · Dec 2025', ['t2']],
    ])
  })
})
