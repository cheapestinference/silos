// ⌘K finds tasks: by title, by plan#id or
// #id, and the three operators — each one an existing facet.
import { describe, expect, it } from 'vitest'
import { hasOperators, parseTaskOperators, resolveOwner, searchTasks, taskRank } from '../src/lib/task-search'
import { taskOfRow as rawTaskOfRow, YOU_FACET, type TaskView } from '../src/lib/tasks'
import type { AgentView, SiloRecordRow, SiloTaskFlow } from '../src/lib/types'
import { serverTaskRow } from './server-task-row'
const taskOfRow = (r: Parameters<typeof rawTaskOfRow>[0]): ReturnType<typeof rawTaskOfRow> => rawTaskOfRow(serverTaskRow(r))

const NOW = Date.parse('2026-11-03T12:00:00Z')
const flow = (over: Partial<SiloTaskFlow> = {}): SiloTaskFlow => ({
  waiting: false,
  gate: false,
  unblocks: [],
  stalled: false,
  stalledCause: null,
  stalledBy: null,
  ...over,
})
const task = (plan: string, id: string, title: string, value: Record<string, unknown> = {}, f: Partial<SiloTaskFlow> = {}): TaskView =>
  taskOfRow({
    key: `folder:/p/${plan}/tasks/${id}`,
    id,
    identity: title,
    state: String(value.state ?? 'pending'),
    stateLabel: 'x',
    at: null,
    anchors: { folder: '/p' },
    cells: [],
    row: '',
    folded: false,
    overlay: false,
    conflict: false,
    remarks: [],
    file: null,
    parent: { key: `folder:/p/${plan}`, identity: `Plan ${plan}`, at: null },
    flow: flow(f),
    value: { id, owner: 'finance', dependsOn: [], conversations: [], notes: [], ...value },
    moved: null,
  } as SiloRecordRow)!
const agent = (id: string, name = id.toUpperCase()): AgentView => ({ id, name, sessions: [] }) as unknown as AgentView
const agents = [agent('finance', 'Finance'), agent('builder', 'Builder'), agent('support', 'Support')]
const ctx = { agentIds: new Set(agents.map((a) => a.id)), ownerSessions: new Set<string>() }
const ALL = [
  task('cafe-reopening', 'r6', 'Sign the new lease'),
  task('cafe-reopening', 'r7', 'Café books in Ledgerly', { owner: 'owner' }),
  task('ship', 't1', 'Sync Ledgerly', { owner: 'builder' }, { stalled: true, stalledCause: 'in-progress-nothing-live', stalledBy: 't1', stalledAt: 't1' }),
  task('ship', 'r6', 'Another r6', { owner: 'builder' }),
  task('ship', 't9', 'Ledgerly finished', { state: 'done', owner: 'finance' }),
]
const ids = (q: string): string[] => searchTasks(ALL, q, ctx, agents, NOW).tasks.map((t) => t.ref)

describe('the operators', () => {
  it('reads them out of the words, any case, any order', () => {
    expect(parseTaskOperators('IS:untouched ledgerly owner:Finance')).toEqual({ stalled: true, mine: false, idle: false, owner: 'Finance', text: 'ledgerly' })
    // is:idle — ready, nobody on it: its own view
    expect(parseTaskOperators('is:idle')).toMatchObject({ idle: true, text: '' })
    expect(hasOperators(parseTaskOperators('ledgerly'))).toBe(false)
  })
  it('anything else stays text: an unknown operator, an empty owner', () => {
    expect(parseTaskOperators('is:done owner:')).toMatchObject({ stalled: false, owner: null, text: 'is:done owner:' })
  })
  it('owner: resolves by id, by name, by a start only one fits; me is the owner', () => {
    expect(resolveOwner('finance', agents)).toBe('finance')
    expect(resolveOwner('SUPP', agents)).toBe('support')
    expect(resolveOwner('c', agents)).toBeNull() // finance or builder: never guessed
    expect(resolveOwner('nobody', agents)).toBeNull()
    expect(resolveOwner('me', agents)).toBe(YOU_FACET)
  })
})

describe('finding a task', () => {
  it('by plan#id goes straight to it, ahead of everything', () => {
    expect(ids('cafe-reopening#r6')).toEqual(['cafe-reopening#r6'])
  })
  it('#id finds it in every plan', () => {
    expect(ids('#r6')).toEqual(['cafe-reopening#r6', 'ship#r6'])
  })
  it('accents never matter', () => {
    expect(ids('cafe')[0]).toBe('cafe-reopening#r7')
  })
  it("the title's start outranks a word's start, then anywhere, then the plan", () => {
    expect(ids('ledgerly')).toEqual(['ship#t9', 'cafe-reopening#r7', 'ship#t1'])
    const rank = (title: string, planTitle = 'P'): number | null => taskRank({ id: 'a', ref: 'p#a', title, planTitle }, 'ledgerly')
    expect([rank('Ledgerly finished'), rank('Café books in Ledgerly'), rank('unledgerly'), rank('x', 'Ledgerly plan'), rank('x')]).toEqual([3, 4, 5, 6, null])
  })
  it('finished work comes after open work of the same rank', () => {
    const done = task('a', 'a1', 'Ledgerly one', { state: 'done' })
    const open = task('b', 'b1', 'Ledgerly two')
    expect(searchTasks([done, open], 'ledgerly', ctx, agents, NOW).tasks.map((t) => t.ref)).toEqual(['b#b1', 'a#a1'])
  })
  it('an empty search lists no task', () => {
    expect(searchTasks(ALL, '  ', ctx, agents, NOW)).toEqual({ view: null, tasks: [] })
  })
})

describe('an operator is a view', () => {
  it('is:untouched → the stalled view and its tasks', () => {
    const r = searchTasks(ALL, 'is:untouched', ctx, agents, NOW)
    expect(r.tasks.map((t) => t.ref)).toEqual(['ship#t1'])
    expect(r.view?.query).toEqual({ view: 'untouched' })
  })
  it("is:mine → Mine, a person's open tasks", () => {
    const r = searchTasks(ALL, 'is:mine', ctx, agents, NOW)
    expect(r.tasks.map((t) => t.ref)).toEqual(['cafe-reopening#r7'])
    expect(r.view?.query).toEqual({ view: 'mine' })
  })
  it("owner:finance → that agent's open tasks, finished ones out", () => {
    const r = searchTasks(ALL, 'owner:finance', ctx, agents, NOW)
    expect(r.tasks.map((t) => t.ref)).toEqual(['cafe-reopening#r6'])
    expect(r.view?.query).toEqual({ view: 'open', agent: ['finance'] })
  })
  it('they combine, and free text narrows — then there is no address to offer', () => {
    expect(searchTasks(ALL, 'is:untouched owner:builder', ctx, agents, NOW).view?.query).toEqual({ view: 'untouched', agent: ['builder'] })
    const r = searchTasks(ALL, 'owner:builder another', ctx, agents, NOW)
    expect(r.tasks.map((t) => t.ref)).toEqual(['ship#r6'])
    expect(r.view).toBeNull()
  })
  it('an owner nobody fits finds nothing, never everything', () => {
    expect(searchTasks(ALL, 'owner:martian', ctx, agents, NOW)).toEqual({ view: null, tasks: [] })
  })
})
