// The Tasks view's data (task-view phase 2): a plans silo row → a task; the
// presets' filters (Mine · Active · Stalled · Done); order by last activity;
// what a row says (Blocked by the FIRST stuck task, in review with nobody
// reviewing, N running below, due); the layouts' shapes; the links both ways.
import { describe, expect, it } from 'vitest'
import {
  activityOf,
  blockedBy,
  blocksOf,
  boardColumns,
  byActivity,
  childrenOf,
  conversationsWithoutTask,
  dueWords,
  foldByAge,
  inPreset,
  isLiveTask,
  isReadyOnOwner,
  linkedConversations,
  nowTasks,
  ownerSessionIds,
  planFold,
  planProgress,
  closedPlanFolds,
  planIdOf,
  presetCounts,
  reviewWithoutReviewer,
  runningBelow,
  siblingsOf,
  stallLine,
  causeWords,
  currentConversationOf,
  planHouse,
  planDoor,
  dependsLabel,
  noteAuthorWords,
  taskFacets,
  taskOfRow as rawTaskOfRow,
  taskPage,
  taskTree,
  tasksOfSession,
  withLiveFlow,
  type TaskView,
  type WorkedTask,
  NO_PLAN_FACET,
  ownLooseTasks,
  identityWords,
  isStandingPlan,
  planHeading,
  standingTitle,
  waitCarry,
} from '../src/lib/tasks'
import { applyFilter, computeFacets } from '../src/lib/facets'
import type { AgentView, SessionView, SiloRecordRow, SiloTaskFlow } from '../src/lib/types'
import { serverTaskRow } from './server-task-row'
const taskOfRow = (r: Parameters<typeof rawTaskOfRow>[0]): ReturnType<typeof rawTaskOfRow> => rawTaskOfRow(serverTaskRow(r))

const NOW = Date.parse('2026-11-03T12:00:00Z')
const PLAN = 'folder:/home/u/proj/ship'
const flow = (over: Partial<SiloTaskFlow> = {}): SiloTaskFlow => ({
  waiting: false,
  gate: false,
  unblocks: [],
  stalled: false,
  stalledCause: null,
  stalledBy: null,
  ...over,
})
const row = (id: string, value: Record<string, unknown>, over: Partial<SiloRecordRow> = {}): SiloRecordRow => ({
  key: `${PLAN}/tasks/${id}`,
  id,
  identity: String(value.title ?? id),
  state: String(value.state ?? 'pending'),
  stateLabel: String(value.state ?? 'pending'),
  at: null,
  anchors: { folder: '/home/u/proj' },
  cells: [],
  row: '',
  folded: false,
  overlay: false,
  conflict: false,
  remarks: [],
  file: '/home/u/proj/plans/ship.plan.json',
  parent: { key: PLAN, identity: 'Ship it', at: '2026-11-01T10:00:00Z' },
  flow: flow(),
  value: { id, owner: 'writer', dependsOn: [], conversations: [], notes: [], ...value },
  moved: null,
  ...over,
})
const task = (id: string, value: Record<string, unknown>, over: Partial<SiloRecordRow> = {}): TaskView => taskOfRow(row(id, value, over))!
const session = (id: string, over: Partial<SessionView> = {}): SessionView =>
  ({
    id,
    folder: '-home-u-proj',
    title: id,
    skills: [],
    cwd: '/home/u/proj',
    mtime: NOW - 3600_000,
    size: 1,
    turnCount: 1,
    live: false,
    worktree: false,
    native: false,
    agentId: 'writer',
    ...over,
  }) as SessionView
const agent = (id: string, sessions: SessionView[] = []): AgentView =>
  ({ id, name: id.toUpperCase(), emoji: '', folder: '/home/u/proj', sessions }) as unknown as AgentView

describe('a plans silo row becomes a task', () => {
  it('its plan, plan#id, owner, parent, deps, lifted conversations and notes, waitingOn, due and flow', () => {
    const t = task(
      't3',
      {
        title: 'Fill package.json',
        state: 'blocked',
        owner: 'writer',
        parent: 't5',
        dependsOn: ['t2'],
        conversations: [{ session: 's1' }],
        notes: [
          { at: '2026-11-02T09:00:00Z', by: 'writer', text: 'waits on t2' },
          { at: '', by: 'agent', text: '' },
        ],
        waitingOn: { owner: 'sam', action: 'sign' },
        due: '2026-11-06',
      },
      { flow: flow({ stalled: true, stalledCause: 'blocker-parked', stalledBy: 't2' }), moved: '2026-11-02T10:00:00Z' },
    )
    expect(t).toMatchObject({
      planKey: PLAN,
      planId: 'ship',
      planTitle: 'Ship it',
      ref: 'ship#t3',
      title: 'Fill package.json',
      state: 'blocked',
      owner: 'writer',
      parent: 't5',
      dependsOn: ['t2'],
      conversations: ['s1'],
      waitingOn: { owner: 'sam', action: 'sign' },
      due: '2026-11-06',
      folder: '/home/u/proj',
      moved: Date.parse('2026-11-02T10:00:00Z'),
    })
    expect(t.notes).toEqual([{ at: '2026-11-02T09:00:00Z', by: 'writer', text: 'waits on t2', fromOwner: false }])
  })
  it('a note is «You» only when the server saw the owner write it (fromOwner) — a note signed «owner» is not', () => {
    const agents = [{ id: 'writer', name: 'Writer' }]
    expect(noteAuthorWords({ by: 'owner', fromOwner: true }, agents)).toBe('You')
    expect(noteAuthorWords({ by: 'owner', fromOwner: false }, agents)).toBe('Signed «owner»')
    expect(noteAuthorWords({ by: 'writer', fromOwner: false }, agents)).toBe('Writer')
    expect(noteAuthorWords({ by: '', fromOwner: false }, agents)).toBe('An agent')
    const t = task('t9', {
      notes: [
        { at: '2026-11-02T09:00:00Z', by: 'owner', text: 'yes', fromOwner: true },
        { at: '2026-11-02T09:01:00Z', by: 'owner', text: 'forged' },
      ],
    })
    expect(t.notes.map((n) => n.fromOwner)).toEqual([true, false])
    expect(planIdOf('folder:/a/b/c-d')).toBe('c-d')
  })
  it('a row with no parent, or an unknown state, is no task', () => {
    expect(taskOfRow(row('x', {}, { parent: undefined }))).toBeNull()
    expect(taskOfRow(row('x', { state: 'someday' }))).toBeNull()
  })
})

// the project's list (plans/tasks.plan.json) has no
// name on screen — whatever its title says, its tasks are the project's
describe("the project's list is no plan", () => {
  const LIST = 'folder:/home/u/proj/tasks'
  const loose = (id: string, title: string | undefined, over: Partial<SiloRecordRow> = {}): TaskView =>
    task(
      id,
      { owner: 'writer' },
      { key: `${LIST}/tasks/${id}`, file: '/home/u/proj/plans/tasks.plan.json', parent: { key: LIST, identity: title as string, at: null }, ...over },
    )
  it('the list titled «Tasks», "" or untitled → standingList, and no plan title', () => {
    for (const title of ['Tasks', '', undefined]) {
      const t = loose('t1', title)
      expect(t.standingList).toBe(true)
      expect(t.planTitle).toBe('')
      expect(t.ref).toBe('tasks#t1')
    }
  })
  it("the server's word decides (another reserved id); a named plan stays a plan", () => {
    const P = 'folder:/home/u/proj/inbox'
    const t = task('t1', {}, { key: `${P}/tasks/t1`, parent: { key: P, identity: 'Inbox', at: null, standingList: true } })
    expect(t).toMatchObject({ standingList: true, planTitle: '' })
    expect(task('t2', {})).toMatchObject({ standingList: false, planTitle: 'Ship it' })
  })
  it('the tree hangs loose tasks straight from the project, before its named plans', () => {
    const k = loose('k', '', {})
    const kid = task('kid', { owner: 'writer', parent: 'k' }, { key: `${LIST}/tasks/kid`, parent: { key: LIST, identity: '', at: null } })
    const named = task('n1', {})
    const tree = taskTree([named, k, kid])
    expect(tree).toHaveLength(1)
    expect(tree[0]!.loose.map((n) => n.task.id)).toEqual(['k'])
    expect(tree[0]!.loose[0]!.children.map((n) => n.task.id)).toEqual(['kid'])
    expect(tree[0]!.plans.map((p) => p.planKey)).toEqual([PLAN])
    expect(tree[0]!.plans[0]!.nodes.map((n) => n.task.id)).toEqual(['n1'])
  })
  it('a parent of the same id in a named plan does not adopt a loose task', () => {
    const named = task('p', {})
    const kid = task('kid', { parent: 'p' }, { key: `${LIST}/tasks/kid`, parent: { key: LIST, identity: '', at: null } })
    const tree = taskTree([named, kid])
    expect(tree[0]!.loose.map((n) => n.task.id)).toEqual(['kid'])
    expect(tree[0]!.plans[0]!.nodes[0]!.children).toEqual([])
  })
  it('the Plan facet says «No plan» — one value across projects', () => {
    const other = task(
      'o1',
      {},
      {
        key: 'folder:/home/u/other/tasks/tasks/o1',
        anchors: { folder: '/home/u/other' },
        parent: { key: 'folder:/home/u/other/tasks', identity: 'Tasks', at: null },
      },
    )
    const ex = taskFacets([agent('writer')])
    const plan = computeFacets([loose('t1', ''), other, task('n1', {})], ex, {}).find((f) => f.id === 'plan')!
    expect(plan.values.map((v) => [v.value, v.label, v.count]).sort()).toEqual(
      [
        [NO_PLAN_FACET, 'No plan', 2],
        [PLAN, 'Ship it', 1],
      ].sort(),
    )
    expect(applyFilter([loose('t1', ''), task('n1', {})], ex, { plan: new Set([NO_PLAN_FACET]) }).map((t) => t.id)).toEqual(['t1'])
  })
  it('where a heading is unavoidable: «Tasks of <project>» by key or file; an empty identity elsewhere is «(untitled)»', () => {
    expect(isStandingPlan('/home/u/proj/plans/tasks.plan.json')).toBe(true)
    expect(isStandingPlan('/home/u/proj/plans/backlog.plan.json')).toBe(false)
    expect(isStandingPlan('/home/u/proj/plans/ship.plan.json')).toBe(false)
    expect(standingTitle(LIST)).toBe('Tasks of proj')
    expect(planHeading('', '/home/u/proj/plans/tasks.plan.json')).toBe('Tasks of proj')
    expect(planHeading('Ship it', '/home/u/proj/plans/ship.plan.json')).toBe('Ship it')
    // the server says which record is the project's list — the web never guesses it from the id
    expect(identityWords({ identity: '', key: LIST, standingList: true })).toBe('Tasks of proj')
    expect(identityWords({ identity: '', key: LIST })).toBe('(untitled)')
    expect(identityWords({ identity: '', key: 'folder:/x/inbox', standingList: true })).toBe('Tasks of x')
    expect(identityWords({ identity: 'Ship it', key: PLAN })).toBe('Ship it')
  })
})

// conversations[] is history; the server's currentConversations
// say which are still on it — the ☑, the live blink and ⌘K read those
describe('current vs all conversations', () => {
  it("currentConversations are the flow's — the web never re-derives them", () => {
    const t = task('t1', { conversations: ['a', 'b'] }, { flow: flow({ currentConversations: ['b'] }) })
    expect(t.conversations).toEqual(['a', 'b'])
    expect(t.currentConversations).toEqual(['b'])
    expect(rawTaskOfRow({ ...row('t2', { conversations: ['a', 'b'] }), flow: flow() })!.currentConversations).toEqual([])
  })
  it('a released conversation working right now does not make the task live', () => {
    const agents = [agent('writer', [session('a', { mtime: NOW - 1000, turnOpen: true })])]
    const listed = task('t1', { state: 'in_progress', conversations: ['a'] })
    const released = task('t2', { state: 'in_progress', conversations: ['a'] }, { flow: flow({ currentConversations: [] }) })
    expect(isLiveTask(listed, agents, NOW)).toBe(true)
    expect(isLiveTask(released, agents, NOW)).toBe(false)
  })
})

describe('the presets', () => {
  const agents = [agent('writer', [session('s-own'), session('s-run', { origin: { kind: 'automation', automationId: 'a', runId: 'r' } })])]
  const ctx = { agentIds: new Set(['writer', 'finance']), ownerSessions: ownerSessionIds(agents) }
  const tasks = [
    task('h', { owner: 'owner', state: 'pending' }),
    task('hd', { owner: 'owner', state: 'done' }),
    task('c', { owner: 'writer', state: 'in_progress', conversations: [{ session: 's-own' }] }),
    task('r', { owner: 'writer', state: 'in_progress', conversations: [{ session: 's-run' }] }),
    task('s', { owner: 'finance', state: 'blocked' }, { flow: flow({ stalled: true, stalledCause: 'blocker-cancelled', stalledBy: 'x', stalledAt: 's' }) }),
    task('x', { owner: 'finance', state: 'cancelled' }),
    task(
      'v',
      { owner: 'finance', state: 'in_review' },
      { flow: flow({ stalled: true, stalledCause: 'review-without-reviewer', stalledBy: 'v', stalledAt: 'v' }) },
    ),
  ]
  const ids = (p: Parameters<typeof inPreset>[1]): string[] => tasks.filter((t) => inPreset(t, p, ctx)).map((t) => t.id)
  it("Yours: exactly your open tasks — an agent's task a conversation of yours touched is not yours", () => {
    expect(ids('mine')).toEqual(['h'])
  })
  it('Open: pending, in progress, in review, blocked', () => {
    expect(ids('open')).toEqual(['h', 'c', 'r', 's', 'v'])
  })
  it("Untouched: the kernel's computed stalled, open only", () => {
    expect(ids('untouched')).toEqual(['s', 'v'])
  })
  it("Untouched lists the SEATS — what Home's row counts: a task waiting on another's stall is that seat's; an unowned seat below says so", () => {
    const above = task(
      'w',
      { owner: 'owner', state: 'pending', dependsOn: ['s'] },
      { flow: flow({ stalled: true, stalledCause: 'blocker-cancelled', stalledBy: 'x', stalledAt: 's' }) },
    )
    expect(inPreset(above, 'untouched', ctx)).toBe(false)
    const nobody = task('n', { owner: '', state: 'pending' }, { flow: flow({ stalled: true, stalledCause: 'unowned', stalledBy: 'n', stalledAt: 'n' }) })
    const onNobody = task(
      'm',
      { owner: 'writer', state: 'blocked', dependsOn: ['n'] },
      { flow: flow({ stalled: true, stalledCause: 'unowned', stalledBy: 'n', stalledAt: 'n' }) },
    )
    expect(inPreset(nobody, 'untouched', ctx)).toBe(true)
    const plan = siblingsOf([nobody, onNobody], PLAN)
    expect(stallLine(nobody, plan)).toBe('nobody owns it')
    expect(stallLine(onNobody, plan)).toMatch(/^waits on a task nobody owns: /)
  })
  it('Done: done and cancelled listed; the tab counts the done ones — the header says the dropped apart', () => {
    expect(ids('done')).toEqual(['hd', 'x'])
    expect(presetCounts(tasks, ctx)).toEqual({ mine: 1, open: 5, untouched: 2, done: 1, idle: 0, start: 0 })
  })
})

describe('what a row says', () => {
  const tasks = [
    task(
      't2',
      { title: 'Pick the org', owner: 'writer', state: 'in_progress' },
      { flow: flow({ stalled: true, stalledCause: 'in-progress-nothing-live', stalledBy: 't2' }) },
    ),
    task(
      't3',
      { title: 'Fill', owner: 'writer', state: 'blocked', dependsOn: ['t2'], parent: 't5' },
      { flow: flow({ stalled: true, stalledCause: 'blocker-parked', stalledBy: 't2' }) },
    ),
    task('t5', { title: 'Release', owner: 'writer', state: 'in_progress', conversations: [{ session: 'live' }] }),
    task('t6', { title: 'Docs', owner: 'finance', state: 'pending', parent: 't5' }),
    task(
      't7',
      { title: 'Check', owner: 'finance', state: 'in_review' },
      { flow: flow({ stalled: true, stalledCause: 'review-without-reviewer', stalledBy: 't7' }) },
    ),
    task(
      't8',
      { title: 'Old', owner: 'finance', state: 'blocked', dependsOn: ['gone'] },
      { flow: flow({ stalled: true, stalledCause: 'blocker-missing', stalledBy: 'gone', stalledAt: 't8' }) },
    ),
  ]
  const plan = siblingsOf(tasks, PLAN)
  it('Blocked by names the FIRST stuck task down the chain, by plan#id and title', () => {
    expect(blockedBy(tasks[1]!, plan)).toEqual({ id: 't2', ref: 'ship#t2', title: 'Pick the org', key: `${PLAN}/tasks/t2` })
    expect(stallLine(tasks[1]!, plan)).toBe('waits on untouched work: ship#t2 Pick the org')
    // stuck on itself: the cause alone, no «blocked by»
    expect(blockedBy(tasks[0]!, plan)).toBeNull()
    expect(stallLine(tasks[0]!, plan)).toBe('in progress, but nothing is working on it')
    // an id naming no task: said by its reference, no title invented
    expect(stallLine(tasks[5]!, plan)).toBe("waits on a task its plan doesn't have: ship#gone")
    expect(stallLine(tasks[2]!, plan)).toBeNull()
  })
  // the line is true beside every status a cause can come with
  it('a cause reads true beside every status it comes with — «waits on» down the chain, what is wrong with it on its own', () => {
    const stuck = (state: string, cause: NonNullable<SiloTaskFlow['stalledCause']>, by: string | null, owner = 'writer'): TaskView =>
      task('x', { owner, state, dependsOn: by && by !== 'x' ? [by] : [] }, { flow: flow({ stalled: true, stalledCause: cause, stalledBy: by }) })
    for (const state of ['pending', 'in_progress', 'blocked']) {
      for (const cause of [
        'unowned',
        'blocked-on-nothing',
        'blocker-missing',
        'blocker-cycle',
        'blocker-parked',
        'blocker-cancelled',
        'owner-cannot-run',
      ] as const) {
        const w = causeWords(stuck(state, cause, 'y'))!
        expect(w.startsWith('waits on '), `${state} · ${cause}: ${w}`).toBe(true)
      }
    }
    expect(causeWords(stuck('pending', 'blocker-parked', 'y'))).toBe('waits on untouched work')
    expect(causeWords(stuck('pending', 'owner-cannot-run', 'y'))).toBe('waits on a task whose owner never wakes on its own')
    // its own causes
    expect(causeWords(stuck('pending', 'unowned', 'x', ''))).toBe('nobody owns it')
    expect(causeWords(stuck('blocked', 'blocked-on-nothing', 'x'))).toBe('blocked, and it names nothing it waits on')
    expect(causeWords(stuck('blocked', 'blocker-cycle', 'x'))).toBe('waits on a task that waits back on it')
    expect(causeWords(stuck('pending', 'owner-cannot-run', 'x'))).toBe('its owner never wakes on its own')
    expect(causeWords(stuck('in_review', 'review-without-reviewer', 'x'))).toBe('in review — nobody is reviewing it')
    expect(causeWords(stuck('in_progress', 'in-progress-nothing-live', 'x'))).toBe('in progress, but nothing is working on it')
    // no «blocked by» is ever said beside a status that is not blocked
    for (const state of ['pending', 'in_progress', 'in_review']) {
      for (const cause of [
        'unowned',
        'blocker-missing',
        'blocker-cycle',
        'blocker-parked',
        'blocker-cancelled',
        'owner-cannot-run',
        'review-without-reviewer',
        'in-progress-nothing-live',
      ] as const) {
        for (const by of ['x', 'y']) expect(causeWords(stuck(state, cause, by))).not.toMatch(/^blocked/)
      }
    }
    expect(causeWords(task('z', { state: 'pending' }))).toBeNull()
  })
  it('in review with nobody reviewing it', () => {
    expect(reviewWithoutReviewer(tasks[4]!)).toBe(true)
    expect(reviewWithoutReviewer(tasks[2]!)).toBe(false)
  })
  it("N running below: subtasks in progress or live; children and blocks in the plan's order", () => {
    const agents = [agent('finance', [session('live', { mtime: NOW - 1000, turnOpen: true })])]
    expect(childrenOf(tasks[2]!, tasks).map((t) => t.id)).toEqual(['t3', 't6'])
    expect(runningBelow(tasks[2]!, tasks, agents, NOW)).toBe(0)
    const withLive = [...tasks, task('t9', { owner: 'finance', state: 'pending', parent: 't5', conversations: [{ session: 'live' }] })]
    expect(runningBelow(withLive[2]!, withLive, agents, NOW)).toBe(1)
    expect(blocksOf(tasks[0]!, tasks).map((t) => t.id)).toEqual(['t3'])
  })
  it('due: upcoming, overdue, or as written when it does not parse', () => {
    expect(dueWords('2026-11-06', NOW)).toBe('due Nov 6')
    expect(dueWords('2026-11-01', NOW)).toBe('overdue since Nov 1')
    expect(dueWords('end of month', NOW)).toBe('due end of month')
    expect(dueWords(null, NOW)).toBeNull()
  })
})

describe('live conversations', () => {
  it("working, waiting for you, idle or gone — found in the census, the owner's first", () => {
    const agents = [agent('writer', [session('w', { mtime: NOW - 1000, turnOpen: true }), session('q', { pendingAsk: true }), session('i')])]
    const t = task('t', { owner: 'writer', conversations: ['w', 'q', 'i', 'nope'] })
    expect(linkedConversations(t, agents, NOW).map((c) => [c.id, c.state])).toEqual([
      ['w', 'working'],
      ['q', 'waiting'],
      ['i', 'idle'],
      ['nope', 'gone'],
    ])
  })
  it('a listed conversation is walked to its thread tip — a rotation keeps the blink and the door, a /clear does not', () => {
    // old → rot (a --resume rotation, working) · old → cut (a /clear, working)
    const agents = [
      agent('writer', [session('old', { mtime: NOW - 7200_000 }), session('rot', { mtime: NOW - 1000, turnOpen: true, parentKey: '-home-u-proj/old' })]),
    ]
    const t = task('t', { owner: 'writer', conversations: ['old'] })
    const [c] = linkedConversations(t, agents, NOW)
    expect([c!.state, c!.session?.id]).toEqual(['working', 'rot'])
    expect(isLiveTask(t, agents, NOW)).toBe(true)
    const cleared = [
      agent('writer', [
        session('old', { mtime: NOW - 7200_000 }),
        session('cut', { mtime: NOW - 1000, turnOpen: true, parentKey: '-home-u-proj/old', parentKind: 'clear' }),
      ]),
    ]
    const [k] = linkedConversations(t, cleared, NOW)
    expect([k!.state, k!.session?.id]).toEqual(['idle', 'old'])
  })
})

describe('the one conversation a door names', () => {
  const agents = [
    agent('writer', [session('old', { mtime: NOW - 86_400_000 }), session('mid', { mtime: NOW - 7200_000 }), session('new', { mtime: NOW - 3600_000 })]),
  ]
  it('the current one last active — never the first listed, the oldest', () => {
    const t = task(
      't',
      { owner: 'writer', conversations: ['old', 'mid', 'new'] },
      { flow: flow({ currentConversations: ['mid', 'new'] } as Partial<SiloTaskFlow>) },
    )
    expect(currentConversationOf(t, agents, NOW)?.id).toBe('new')
  })
  it('a current one working now wins over a more recent one', () => {
    const live = [
      agent('writer', [
        session('old', { mtime: NOW - 86_400_000 }),
        session('w', { mtime: NOW - 5000, turnOpen: true }),
        session('new', { mtime: NOW - 1000 }),
      ]),
    ]
    const t = task(
      't',
      { owner: 'writer', conversations: ['old', 'w', 'new'] },
      { flow: flow({ currentConversations: ['w', 'new'] } as Partial<SiloTaskFlow>) },
    )
    expect(currentConversationOf(t, live, NOW)).toMatchObject({ id: 'w', state: 'working' })
  })
  it('every one let go: the last active of its history; none found: gone; none listed: null', () => {
    const t = task('t', { owner: 'writer', conversations: ['old', 'mid'] }, { flow: flow({ currentConversations: [] } as Partial<SiloTaskFlow>) })
    expect(currentConversationOf(t, agents, NOW)?.id).toBe('mid')
    expect(currentConversationOf(task('g', { owner: 'writer', conversations: ['nope'] }), agents, NOW)).toMatchObject({ id: 'nope', state: 'gone' })
    expect(currentConversationOf(task('n', { owner: 'writer' }), agents, NOW)).toBeNull()
  })
})

describe("a conversation's own loose tasks", () => {
  const w = (over: Partial<WorkedTask>): WorkedTask => ({
    key: 'folder:/w/p/tasks/tasks/t1',
    ref: 'tasks#t1',
    title: 'x',
    state: 'pending',
    closed: false,
    current: true,
    view: null,
    file: '/w/p/plans/tasks.plan.json',
    ...over,
  })
  it("open, held tasks of a project's list only — never a named plan's, a finished, closed or let-go one", () => {
    const own = w({})
    const named = w({ key: 'folder:/w/p/ship/tasks/t1', file: '/w/p/plans/ship.plan.json' })
    const done = w({ state: 'done' })
    const closed = w({ closed: true })
    const letGo = w({ current: false })
    expect(ownLooseTasks([own, named, done, closed, letGo])).toEqual([own])
  })
})

describe("a plan's name opens its house", () => {
  it('Tasks narrowed to that plan, Open — the same address from every door', () => {
    expect(planHouse(PLAN)).toEqual({ kind: 'tasks', view: 'open', plan: [PLAN] })
  })
  it("a plan's door: open → its house; closed, unreadable or outside → its read-only file; no file → none", () => {
    const file = '/w/plans/ship.plan.json'
    expect(planDoor({ key: PLAN, file })).toEqual({ kind: 'house', page: planHouse(PLAN) })
    expect(planDoor({ key: PLAN, file, closed: true })).toEqual({ kind: 'file', path: file })
    expect(planDoor({ key: PLAN, file: '/w/plans/closed/ship.plan.json' })).toEqual({ kind: 'file', path: '/w/plans/closed/ship.plan.json' })
    expect(planDoor({ key: PLAN, file, unreadable: true })).toEqual({ kind: 'file', path: file })
    expect(planDoor({ key: PLAN, file, outside: true })).toEqual({ kind: 'file', path: file })
    expect(planDoor({ key: PLAN, closed: true })).toBeNull()
  })
})

describe("the label over a task's dependencies", () => {
  it("«Blocked by» only when its state is blocked; «After» for every other state — never «Waits on», the declared wait's word", () => {
    expect(dependsLabel({ state: 'blocked' })).toBe('Blocked by')
    for (const state of ['pending', 'in_progress', 'in_review', 'done', 'cancelled'] as const) expect(dependsLabel({ state })).toBe('After')
  })
})

describe('order and layouts', () => {
  const agents = [agent('writer', [session('s', { mtime: NOW - 60_000 })])]
  const a = task('a', { owner: 'writer', state: 'pending' }, { moved: '2026-11-01T12:00:00Z' })
  const b = task('b', { owner: 'writer', state: 'pending', notes: [{ at: '2026-11-02T00:00:00Z', by: 'writer', text: 'n' }] })
  const c = task('c', { owner: 'writer', state: 'pending', conversations: ['s'] })
  const d = task('d', { owner: 'writer', state: 'done' })
  it("by last activity: the journal, a note, a conversation — else the plan's moment", () => {
    expect(byActivity([a, b, c, d], agents, NOW).map((t) => t.id)).toEqual(['c', 'b', 'a', 'd'])
    expect(activityOf(d, agents, NOW)).toBe(Date.parse('2026-11-01T10:00:00Z'))
  })
  it('board: columns by state, done and cancelled collapsed, empty finished columns left out', () => {
    const cols = boardColumns([a, d])
    expect(cols.map((col) => [col.state, col.tasks.length, col.collapsed])).toEqual([
      ['pending', 1, false],
      ['in_progress', 0, false],
      ['in_review', 0, false],
      ['blocked', 0, false],
      ['done', 1, true],
    ])
  })
  it('tree: project → plan → parents with their children; a parent outside the set leaves its child a root', () => {
    const p = task('p', { owner: 'writer' })
    const k1 = task('k1', { owner: 'writer', parent: 'p' })
    const k2 = task('k2', { owner: 'writer', parent: 'k1' })
    const orphan = task('o', { owner: 'writer', parent: 'missing' })
    const tree = taskTree([p, k1, k2, orphan])
    expect(tree).toHaveLength(1)
    expect(tree[0]!.name).toBe('proj')
    const nodes = tree[0]!.plans[0]!.nodes
    expect(nodes.map((n) => n.task.id)).toEqual(['p', 'o'])
    expect(nodes[0]!.children[0]!.task.id).toBe('k1')
    expect(nodes[0]!.children[0]!.children[0]!.task.id).toBe('k2')
  })
  it('Done folds by age', () => {
    const recent = task('r', { state: 'done' }, { moved: new Date(NOW - 86_400_000).toISOString() })
    const old = task('o', { state: 'done' }, { moved: new Date(NOW - 60 * 86_400_000).toISOString() })
    expect(foldByAge([old, recent], [], NOW).map((f) => [f.label, f.tasks.map((t) => t.id)])).toEqual([
      ['This week', ['r']],
      ['Older', ['o']],
    ])
  })
  it('facets: project and agent through the FacetBar engine — «you» is the owner alone, another person reads by name', () => {
    const agentsF = [agent('writer')]
    const h = task('h', { owner: 'owner' })
    const sam = task('sam', { owner: 'Sam' })
    const ex = taskFacets(agentsF)
    const facets = computeFacets([a, h, sam], ex, {})
    expect(
      facets
        .find((f) => f.id === 'agent')!
        .values.map((v) => v.label)
        .sort(),
    ).toEqual(['Sam', 'WRITER', 'you'])
    expect(applyFilter([a, h, sam], ex, { agent: new Set(['__you__']) }).map((t) => t.id)).toEqual(['h'])
    expect(applyFilter([a, h, sam], ex, { agent: new Set(['Sam']) }).map((t) => t.id)).toEqual(['sam'])
  })
})

describe('links both ways', () => {
  it('a conversation names its tasks (open first); conversations no task names are counted', () => {
    const t1 = task('t1', { state: 'done', conversations: ['s1'] })
    const t2 = task('t2', { state: 'in_progress', conversations: ['s1', 's2'] })
    expect(tasksOfSession([t1, t2], 's1').map((t) => t.id)).toEqual(['t2', 't1'])
    const agents = [agent('writer', [session('s1'), session('s3'), session('s4', { origin: { kind: 'automation', automationId: 'a', runId: 'r' } })])]
    expect(conversationsWithoutTask(agents, [t1, t2])).toBe(1)
    expect(taskPage(t2)).toEqual({ kind: 'task', plan: PLAN, task: 't2' })
  })
})

describe("the census is fresher than the server's read: a task seen working is not «nothing is working on it»", () => {
  it('in-progress-nothing-live clears when a linked conversation works now; a parked blocker that is live clears its dependants', () => {
    const agents = [agent('writer', [session('live', { mtime: NOW - 1000, turnOpen: true })])]
    const stuck = flow({ stalled: true, stalledCause: 'in-progress-nothing-live', stalledBy: 'a' })
    const a = task('a', { owner: 'writer', state: 'in_progress', conversations: ['live'] }, { flow: stuck })
    const b = task(
      'b',
      { owner: 'writer', state: 'blocked', dependsOn: ['a'] },
      { flow: flow({ stalled: true, stalledCause: 'blocker-parked', stalledBy: 'a' }) },
    )
    const c = task(
      'c',
      { owner: 'writer', state: 'blocked', dependsOn: ['x'] },
      { flow: flow({ stalled: true, stalledCause: 'blocker-cancelled', stalledBy: 'x' }) },
    )
    const out = withLiveFlow([a, b, c], agents, NOW)
    expect(out.map((t) => t.flow?.stalled)).toEqual([false, false, true])
    // nothing live: unchanged (same objects)
    const quiet = withLiveFlow([a, b], [agent('writer')], NOW)
    expect(quiet[0]).toBe(a)
  })
})

describe('the sidebar: «Now» on top, every plan one folded line', () => {
  const agents = [agent('writer', [session('live', { mtime: NOW - 1000, turnOpen: true })])]
  const ids = new Set(['writer'])
  it("Now: live tasks first, then the owner's READY ones (not blocked, every blocker done) — the ready ones capped, the rest counted", () => {
    const tasks = [
      task('w', { owner: 'writer', state: 'in_progress', conversations: ['live'] }),
      task('r1', { owner: 'owner', state: 'pending' }, { moved: '2026-11-03T10:00:00Z' }),
      task('r2', { owner: 'owner', state: 'in_review' }, { moved: '2026-11-03T11:00:00Z' }),
      task('b', { owner: 'owner', state: 'blocked' }),
      task('dep', { owner: 'owner', state: 'pending', dependsOn: ['x'] }),
      task('x', { owner: 'writer', state: 'pending' }),
      task('dd', { owner: 'owner', state: 'pending', dependsOn: ['f'] }),
      task('f', { owner: 'writer', state: 'done' }),
      task('fin', { owner: 'owner', state: 'done' }),
      task('agent', { owner: 'writer', state: 'pending' }),
    ]
    const n = nowTasks(tasks, agents, NOW)
    expect(n.shown.map((t) => t.id)).toEqual(['w', 'r2', 'r1', 'dd'])
    expect(n.more).toBe(0)
    const capped = nowTasks(tasks, agents, NOW, 2)
    expect(capped.shown.map((t) => t.id)).toEqual(['w', 'r2'])
    expect(capped.more).toBe(2)
    // live ones are never cut: the cap trims only the ready ones (all yours)
    const tight = nowTasks(tasks, agents, NOW, 0)
    expect(tight.shown.map((t) => t.id)).toEqual(['w'])
    expect(tight.more).toBe(3)
    const plan = siblingsOf(tasks, PLAN)
    expect(isReadyOnOwner(plan.get('dep')!, plan, ids)).toBe(false)
    expect(isReadyOnOwner(plan.get('agent')!, plan, ids)).toBe(false)
  })
  it("a plan's fold: its open tasks, how many are on the owner, whether one is live, and the ONE fraction over all its tasks", () => {
    const open = [
      task('w', { owner: 'writer', state: 'in_progress', conversations: ['live'] }),
      task('h', { owner: 'owner' }),
      task('h2', { owner: 'owner', state: 'blocked' }),
    ]
    expect(planFold(open, agents, NOW)).toEqual({ open: 3, onYou: 2, live: true, done: 0, total: 3 })
    expect(planFold(open.slice(1), agents, NOW)).toEqual({ open: 2, onYou: 2, live: false, done: 0, total: 2 })
    // finished tasks count in the fraction, never in open / yours / live; a dropped one leaves the total
    const all = [
      ...open,
      task('d1', { owner: 'owner', state: 'done' }),
      task('d2', { owner: 'writer', state: 'done', conversations: ['live'] }),
      task('x', { owner: 'owner', state: 'cancelled' }),
    ]
    expect(planFold(all, agents, NOW)).toEqual({ open: 3, onYou: 2, live: true, done: 2, total: 5 })
    expect(planProgress(all)).toEqual({ done: 2, total: 5 })
    // a team plan's tasks (`status`) read the same
    expect(planProgress([{ status: 'done' }, { status: 'cancelled' }, { status: 'pending' }])).toEqual({ done: 1, total: 2 })
  })
  it('the closed plans fold by month: the current month first and open, earlier months behind a fold, newest first', () => {
    const at = (iso: string): number => Date.parse(iso)
    const cp = (title: string, iso: string) => ({
      key: `folder:/p/${title}`,
      title,
      folder: '/p',
      file: `/p/plans/closed/${title}.plan.json`,
      mtime: at(iso),
      done: 1,
      dropped: 0,
      open: 0,
    })
    const now = at('2026-11-24T12:00:00Z')
    const folds = closedPlanFolds(
      [cp('old', '2025-12-03T00:00:00Z'), cp('a', '2026-11-02T00:00:00Z'), cp('oct', '2026-10-30T00:00:00Z'), cp('b', '2026-11-20T00:00:00Z')],
      now,
    )
    expect(folds.map((f) => [f.month, f.label === null, f.plans.map((p) => p.title)])).toEqual([
      ['2026-11', true, ['b', 'a']],
      ['2026-10', false, ['oct']],
      ['2025-12', false, ['old']],
    ])
    expect(closedPlanFolds([], now)).toEqual([])
  })
})

// the task page says which of the two a wait on an agent is
describe('waitCarry — Silos carries the ask, or the owner relays it', () => {
  const flow = (over: Partial<SiloTaskFlow>): Pick<TaskView, 'flow'> => ({
    flow: { waiting: true, gate: false, unblocks: [], stalled: false, stalledCause: null, stalledBy: null, ...over } as SiloTaskFlow,
  })
  it('linked and in reach: the beat, with who and when; relayed: you; anything else: nothing', () => {
    expect(waitCarry(flow({ asked: { to: 'builder', at: '2026-11-21T09:00:00Z', seenBy: 1 }, waitsOnRelay: false }))).toEqual({
      kind: 'beat',
      to: 'builder',
      seenBy: 1,
    })
    expect(waitCarry(flow({ asked: null, waitsOnRelay: true }))).toEqual({ kind: 'relay' })
    expect(waitCarry(flow({ waitsOnRelay: false }))).toBeNull()
    expect(waitCarry({ flow: null })).toBeNull()
  })
})
