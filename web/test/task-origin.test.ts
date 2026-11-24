// A task's page remembers where you came from: the back link's words and the list previous/next walk, in the order
// that list draws.
import { describe, expect, it } from 'vitest'
import { neighbours, originList, originWords, taskPageOfKey, viewTasks, type OriginNames } from '../src/lib/task-origin'
import { taskOfRow as rawTaskOfRow, type TaskView } from '../src/lib/tasks'
import type { AgentView, InboxRow, SiloNeedsYou, SiloRecordRow, SiloTaskFlow } from '../src/lib/types'
import { siloRow } from './inbox-rows'
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
const task = (plan: string, id: string, value: Record<string, unknown> = {}, moved = 0): TaskView =>
  taskOfRow({
    key: `folder:/p/${plan}/tasks/${id}`,
    id,
    identity: id,
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
    flow: flow(),
    value: { id, owner: 'finance', dependsOn: [], conversations: [], notes: [], ...value },
    moved: new Date(NOW - moved * 60_000).toISOString(),
  } as SiloRecordRow)!
const agent = (id: string): AgentView => ({ id, name: id.toUpperCase(), folder: '/p', sessions: [] }) as unknown as AgentView
const agents = [agent('finance'), agent('builder')]
const key = (plan: string, id: string): string => `folder:/p/${plan}/tasks/${id}`
const names: OriginNames = { agent: (id) => id.toUpperCase(), plan: () => 'Ship it', silo: () => 'Hierarchy', conversation: () => 'The long talk' }

describe('the back link says where it goes', () => {
  it.each([
    [undefined, 'Tasks'],
    [{ kind: 'needs-you' }, 'Needs you'],
    [{ kind: 'yours' }, 'Yours to do'],
    [{ kind: 'org' }, 'Org'],
    [{ kind: 'silo', id: 'hierarchy' }, 'Hierarchy'],
    [{ kind: 'conversation', folder: 'f', id: 'i' }, 'The long talk'],
    [{ kind: 'tasks', query: { view: 'open', agent: ['finance'] } }, 'Tasks · Open · FINANCE'],
    [{ kind: 'tasks', query: { view: 'mine', project: ['/home/u/silos'], plan: ['k'] } }, 'Tasks · Yours to do · silos · Ship it'],
  ] as const)('%j → %s', (o, words) => {
    expect(originWords(o as Parameters<typeof originWords>[0], names)).toBe(words)
  })
  it('a conversation that is gone is still a way back', () => {
    expect(originWords({ kind: 'conversation', folder: 'f', id: 'i' }, { ...names, conversation: () => undefined })).toBe('Conversation')
  })
})

describe('neighbours', () => {
  it('first, middle, last', () => {
    const list = ['a', 'b', 'c']
    expect(neighbours(list, 'a')).toEqual({ index: 0, total: 3, prev: null, next: 'b' })
    expect(neighbours(list, 'b')).toEqual({ index: 1, total: 3, prev: 'a', next: 'c' })
    expect(neighbours(list, 'c')).toEqual({ index: 2, total: 3, prev: 'b', next: null })
  })
  it('a task out of the list, or a list not read: nothing to count', () => {
    expect(neighbours(['a'], 'x')).toBeNull()
    expect(neighbours(null, 'a')).toBeNull()
  })
  it('a key becomes its page; a key that is no task, nothing', () => {
    expect(taskPageOfKey('folder:/p/ship/tasks/t1')).toEqual({ kind: 'task', plan: 'folder:/p/ship', task: 't1' })
    expect(taskPageOfKey('agent:finance/a1')).toBeNull()
  })
})

describe('a Tasks view walks in the order it draws', () => {
  const a = task('ship', 'a', { state: 'in_progress' }, 2)
  const b = task('ship', 'b', { state: 'pending' }, 10)
  const c = task('ship', 'c', { state: 'pending', parent: 'a' }, 20)
  const other = task('docs', 'd', { state: 'pending', owner: 'builder' }, 5)
  const done = task('ship', 'e', { state: 'done' }, 1)
  const all = [a, b, c, other, done]
  const ids = (q: Parameters<typeof viewTasks>[1]): string[] => viewTasks(all, q, agents, NOW).map((t) => t.id)

  it('the list: by last activity', () => {
    expect(ids({ view: 'open', layout: 'list' })).toEqual(['a', 'd', 'b', 'c'])
  })
  it('the board: column by column, pending before in progress', () => {
    expect(ids({ view: 'open', layout: 'board' })).toEqual(['d', 'b', 'c', 'a'])
  })
  it('the tree: a parent, then its children', () => {
    expect(ids({ view: 'open', layout: 'tree', plan: ['folder:/p/ship'] })).toEqual(['a', 'c', 'b'])
  })
  it('facets narrow it; a view leaves finished work out and Done holds it', () => {
    expect(ids({ view: 'open', agent: ['builder'] })).toEqual(['d'])
    expect(ids({ view: 'done' })).toEqual(['e'])
  })
})

describe('originList', () => {
  const row = (plan: string, id: string, urgency: SiloNeedsYou['urgency'], extra: Partial<SiloNeedsYou> = {}): InboxRow =>
    siloRow({
      kind: 'silo',
      reason: 'entry',
      silo: 'plans',
      siloName: 'Plans',
      key: key(plan, id),
      recordKind: 'plan/task',
      urgency,
      text: id,
      identity: id,
      at: '2026-11-01',
      folder: `/p/${plan}`,
      file: null,
      entry: 1,
      actions: [],
      parent: { key: `folder:/p/${plan}`, kind: 'plan', identity: plan, at: '2026-11-01' },
      ...extra,
    } as SiloNeedsYou)
  const ask = { kind: 'ask', agentId: 'finance', id: 's1', folder: 'f', cwd: '/p', title: 'may I', at: NOW, voice: 'asks' } as unknown as InboxRow
  const sources = { all: [], agents, now: NOW }

  it("Needs you: its task rows, in the server's order, asks and routine rows out", () => {
    const inbox = [row('ship', 'g1', 'due'), ask, row('ship', 'r1', 'routine'), row('docs', 'g2', 'due')]
    expect(originList({ kind: 'needs-you' }, { ...sources, inbox })).toEqual([key('ship', 'g1'), key('docs', 'g2')])
  })
  it('an escalated task is walked too', () => {
    const inbox = [row('ship', 'x1', 'blocking', { reason: 'escalation' } as Partial<SiloNeedsYou>)]
    expect(originList({ kind: 'needs-you' }, { ...sources, inbox })).toEqual([key('ship', 'x1')])
  })
  it('Yours to do: the routine ones, plan by plan', () => {
    const inbox = [row('ship', 'g1', 'due'), row('ship', 'r1', 'routine'), row('docs', 'r2', 'routine'), row('ship', 'r3', 'routine')]
    expect(originList({ kind: 'yours' }, { ...sources, inbox })).toEqual([key('ship', 'r1'), key('ship', 'r3'), key('docs', 'r2')])
  })
  it("a project's Needs you holds only that folder's", () => {
    const inbox = [row('ship', 'g1', 'due'), row('docs', 'g2', 'due')]
    expect(originList({ kind: 'needs-you', folder: '/p/docs' }, { ...sources, inbox })).toEqual([key('docs', 'g2')])
  })
  it('before the inbox is read there is no list; Org and a conversation never have one', () => {
    expect(originList({ kind: 'needs-you' }, { ...sources, inbox: null })).toBeNull()
    expect(originList({ kind: 'org' }, { ...sources, inbox: [] })).toBeNull()
    expect(originList({ kind: 'conversation', folder: 'f', id: 'i' }, { ...sources, inbox: [] })).toBeNull()
    expect(originList(undefined, { ...sources, inbox: [] })).toBeNull()
  })
})
