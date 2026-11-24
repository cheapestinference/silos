// The link shows on both sides: which task the
// conversation's chip leads with («Working on» an open one first, «Worked on
// ✓» when all are finished, closed plans resolved read-only), which sidebar
// rows carry the ☑ (the thread rule over parentKey), which tasks ⌘K offers to
// link (the agent's open ones, its project first), and what linking writes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  conversationWork,
  currentTasksOfSession,
  linkCandidates,
  openTasksBySession,
  taskOfRow as rawTaskOfRow,
  workWord,
  workedTasks,
  type TaskView,
  type WorkedTask,
} from '../src/lib/tasks'
import type { AgentView, SessionView, SiloRecordRow } from '../src/lib/types'
import { serverTaskRow } from './server-task-row'
const taskOfRow = (r: Parameters<typeof rawTaskOfRow>[0]): ReturnType<typeof rawTaskOfRow> => rawTaskOfRow(serverTaskRow(r))

const append = vi.fn(async () => ({}))
const setField = vi.fn(async (): Promise<Record<string, unknown>> => ({}))
const release = vi.fn(async (): Promise<Record<string, unknown>> => ({}))
const link = vi.fn(async (): Promise<Record<string, unknown>> => ({ linked: true }))
vi.mock('../src/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body: unknown,
    ) {
      super(message)
    }
  }
  return {
    ApiError,
    api: {
      silos: { append: (...a: unknown[]) => append(...(a as [])), setField: (...a: unknown[]) => setField(...(a as [])) },
      tasksRelease: (...a: unknown[]) => release(...(a as [])),
      tasksLink: (...a: unknown[]) => link(...(a as [])),
    },
  }
})
const refresh = vi.fn()
const refreshBySession = vi.fn()
vi.mock('../src/hooks/useTasks', () => ({ refreshTasks: () => refresh(), refreshTasksBySession: () => refreshBySession() }))

const NOW = Date.parse('2026-11-08T12:00:00Z')
const plan = (folder: string, id: string): string => `folder:${folder}/${id}`
function task(id: string, value: Record<string, unknown>, at: { folder?: string; plan?: string } = {}): TaskView {
  const folder = at.folder ?? '/home/u/proj'
  const p = plan(folder, at.plan ?? 'ship')
  const r: SiloRecordRow = {
    key: `${p}/tasks/${id}`,
    id,
    identity: String(value.title ?? id),
    state: String(value.state ?? 'pending'),
    stateLabel: String(value.state ?? 'pending'),
    at: null,
    anchors: { folder },
    cells: [],
    row: '',
    folded: false,
    overlay: false,
    conflict: false,
    remarks: [],
    file: `${folder}/plans/${at.plan ?? 'ship'}.plan.json`,
    parent: { key: p, identity: 'Ship', at: null },
    value: { id, owner: 'writer', dependsOn: [], conversations: [], notes: [], ...value },
    moved: null,
  } as SiloRecordRow
  return taskOfRow(r)!
}
const session = (id: string, over: Partial<SessionView> = {}): SessionView =>
  ({
    id,
    folder: '-home-u-proj',
    title: id,
    skills: [],
    cwd: '/home/u/proj',
    mtime: NOW,
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
const worked = (t: TaskView, closed = false, current = true): WorkedTask => ({
  key: t.key,
  ref: t.ref,
  title: t.title,
  state: t.state,
  closed,
  current,
  view: closed ? null : t,
  file: t.file,
})

describe('the chip: which task it leads with', () => {
  it('an open task leads, in progress before pending, whatever the listed order', () => {
    const done = task('t1', { state: 'done' })
    const pending = task('t2', { state: 'pending' })
    const going = task('t3', { state: 'in_progress' })
    const w = conversationWork([done, pending, going].map((t) => worked(t)))!
    expect(w.lead.ref).toBe('ship#t3')
    expect(w.working).toBe(true)
    expect(w.rest.map((t) => t.ref)).toEqual(['ship#t2', 'ship#t1'])
  })
  it('all finished: «Worked on» the first listed, the rest behind it', () => {
    const w = conversationWork([task('t1', { state: 'done' }), task('t2', { state: 'cancelled' })].map((t) => worked(t)))!
    expect(w.working).toBe(false)
    expect(w.lead.ref).toBe('ship#t1')
    expect(w.rest).toHaveLength(1)
  })
  it("a closed plan's task is never «Working on», even left open in its file", () => {
    const w = conversationWork([worked(task('t9', { state: 'in_progress' }), true)])!
    expect(w.working).toBe(false)
  })
  it('no task: nothing', () => {
    expect(conversationWork([])).toBeNull()
  })
  it('an open task the conversation was unlinked from is «Worked on», behind a current one', () => {
    const released = task('t1', { state: 'in_progress' })
    const current = task('t2', { state: 'pending' })
    const w = conversationWork([worked(released, false, false), worked(current)])!
    expect([w.lead.ref, w.working]).toEqual(['ship#t2', true])
    const alone = conversationWork([worked(released, false, false)])!
    expect([alone.lead.ref, alone.working]).toEqual(['ship#t1', false])
  })
  it("the server's `current` rides through", () => {
    const t1 = task('t1', { state: 'in_progress' })
    const t2 = task('t2', { state: 'in_progress' })
    const got = workedTasks(
      [
        { key: t1.key, ref: t1.ref, title: t1.title, state: 'in_progress', current: false },
        { key: t2.key, ref: t2.ref, title: t2.title, state: 'in_progress', current: true },
      ],
      [t1, t2],
      's1',
    )
    expect(got.map((t) => [t.ref, t.current])).toEqual([
      ['ship#t1', false],
      ['ship#t2', true],
    ])
  })
  it("no server answer: current from the reading's currentConversations", () => {
    const r = task('t1', { conversations: ['s1'] })
    const released = { ...r, currentConversations: [] }
    expect(workedTasks(null, [released], 's1').map((t) => t.current)).toEqual([false])
    expect(workedTasks(null, [r], 's1').map((t) => t.current)).toEqual([true])
  })
  it("the server's answer is matched to the reading; a closed task keeps the server's words; a stale open one is dropped", () => {
    const t1 = task('t1', { state: 'in_progress' })
    const got = workedTasks(
      [
        { key: t1.key, ref: t1.ref, title: 'old words', state: 'pending', current: true },
        { key: 'folder:/home/u/proj/old/tasks/t4', ref: 'old#t4', title: 'Bump proxy image', state: 'done', closed: true, current: true },
        { key: 'folder:/home/u/proj/gone/tasks/t1', ref: 'gone#t1', title: 'stale', state: 'pending', current: true },
      ],
      [t1],
      's1',
    )
    expect(got.map((t) => [t.ref, t.title, t.closed])).toEqual([
      ['ship#t1', t1.title, false],
      ['old#t4', 'Bump proxy image', true],
    ])
    expect(got[0]!.view).toBe(t1)
  })
  it("no server answer: the reading's direct match", () => {
    const t1 = task('t1', { conversations: ['s1'] })
    expect(workedTasks(null, [t1, task('t2', {})], 's1').map((t) => t.ref)).toEqual(['ship#t1'])
  })
})

describe('the sidebar ☑: conversations that work an open task', () => {
  it("the listed session, and the rest of its thread (a rotation's tip, its root); never a finished task", () => {
    const agents = [agent('writer', [session('root'), session('tip', { parentKey: '-home-u-proj/root', parentKind: 'clear' }), session('other')])]
    const open = task('t1', { state: 'in_progress', conversations: ['root'] })
    const done = task('t2', { state: 'done', conversations: ['other'] })
    const m = openTasksBySession(agents, [open, done])
    expect([...m.keys()].sort()).toEqual(['root', 'tip'])
    expect(m.get('tip')!.map((t) => t.ref)).toEqual(['ship#t1'])
    // listed by the tip: the root is the same thread
    const byTip = openTasksBySession(agents, [task('t3', { state: 'pending', conversations: ['tip'] })])
    expect([...byTip.keys()].sort()).toEqual(['root', 'tip'])
  })
  it('only the CURRENT conversations carry the ☑ — an unlinked thread does not', () => {
    const agents = [agent('writer', [session('root'), session('tip', { parentKey: '-home-u-proj/root', parentKind: 'clear' }), session('later')])]
    const t = { ...task('t1', { state: 'in_progress', conversations: ['root', 'later'] }), currentConversations: ['later'] }
    expect([...openTasksBySession(agents, [t]).keys()]).toEqual(['later'])
  })
  it('an id the census does not hold marks only itself', () => {
    expect([...openTasksBySession([agent('writer', [])], [task('t1', { conversations: ['gone'] })]).keys()]).toEqual(['gone'])
  })
})

describe('⌘K: the tasks a conversation can be linked to', () => {
  const agents = [agent('writer')]
  it("the agent's open tasks, its project first, without the ones already worked", () => {
    const elsewhere = task('e1', { state: 'pending' }, { folder: '/home/u/other', plan: 'misc' })
    const here = task('h1', { state: 'in_progress' })
    const linked = task('h2', { state: 'pending' })
    const someoneElse = task('c1', { owner: 'finance' })
    const finished = task('h3', { state: 'done' })
    const got = linkCandidates([elsewhere, here, linked, someoneElse, finished], {
      agentId: 'writer',
      cwd: '/home/u/proj/.claude/worktrees/x',
      linked: new Set([linked.key]),
      agents,
      now: NOW,
    })
    expect(got.map((t) => t.ref)).toEqual(['ship#h1', 'misc#e1'])
  })
  it('a task the conversation was unlinked from is offered again; a current one is not', () => {
    const released = { ...task('h1', { state: 'in_progress', conversations: ['s1'] }), currentConversations: [] }
    const current = task('h2', { state: 'pending', conversations: ['s1'] })
    const linked = new Set(currentTasksOfSession([released, current], 's1').map((t) => t.key))
    expect(linkCandidates([released, current], { agentId: 'writer', cwd: null, linked, agents, now: NOW }).map((t) => t.id)).toEqual(['h1'])
  })
  it('narrowed by what was typed — the title or plan#id', () => {
    const a = task('t1', { title: 'Rotate TLS certs' })
    const b = task('t2', { title: 'Bump proxy image' })
    expect(linkCandidates([a, b], { agentId: 'writer', cwd: null, linked: new Set(), agents, now: NOW }, 'proxy').map((t) => t.id)).toEqual(['t2'])
    expect(linkCandidates([a, b], { agentId: 'writer', cwd: null, linked: new Set(), agents, now: NOW }, 'ship#t1').map((t) => t.id)).toEqual(['t1'])
  })
})

describe('unlinking is the release verb, never an edit of conversations[]', () => {
  beforeEach(() => {
    release.mockClear()
    refresh.mockClear()
    refreshBySession.mockClear()
    append.mockClear()
  })
  it('POST /api/tasks/release with the task and the session, then both readings are read again', async () => {
    const { unlinkConversation } = await import('../src/lib/task-link')
    release.mockResolvedValueOnce({ warn: "this conversation is X's" })
    const r = await unlinkConversation('folder:/home/u/proj/ship/tasks/t4', 'sess-1')
    expect(release).toHaveBeenCalledWith({ key: 'folder:/home/u/proj/ship/tasks/t4', session: 'sess-1' })
    expect(append).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refreshBySession).toHaveBeenCalledTimes(1)
    expect(r.warn).toBe("this conversation is X's")
  })
  it("a refusal (409 nothing to release, 501 an older Plans) is the caller's to say", async () => {
    release.mockRejectedValueOnce(new Error('this Plans has no release — update it'))
    const { unlinkConversation } = await import('../src/lib/task-link')
    await expect(unlinkConversation('k/tasks/t1', 's')).rejects.toThrow('no release')
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("linking is the owner's ONE link — the server's ownerLink", () => {
  beforeEach(() => {
    append.mockClear()
    link.mockClear()
    refresh.mockClear()
  })
  it('POST /api/tasks/link {key, session}, then the shared reading is read again', async () => {
    const { linkConversation } = await import('../src/lib/task-link')
    await linkConversation('folder:/home/u/proj/ship/tasks/t4', 'sess-1')
    expect(link).toHaveBeenCalledWith({ key: 'folder:/home/u/proj/ship/tasks/t4', session: 'sess-1' })
    expect(append).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it("a refused link is the caller's to say — nothing is re-read", async () => {
    link.mockRejectedValueOnce(new Error('another conversation is working it'))
    const { linkConversation } = await import('../src/lib/task-link')
    await expect(linkConversation('k/tasks/t1', 's')).rejects.toThrow('working it')
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('Unlink… with a disposition', () => {
  beforeEach(() => {
    release.mockClear()
  })
  it("the choice exists only on an in-progress task's LAST current thread", async () => {
    const { releaseOffersChoice } = await import('../src/lib/task-link')
    expect(releaseOffersChoice(task('a', { state: 'in_progress', conversations: ['s1'] }))).toBe(true)
    expect(releaseOffersChoice(task('b', { state: 'in_progress', conversations: ['s1', 's2'] }))).toBe(false)
    expect(releaseOffersChoice(task('c', { state: 'blocked', conversations: ['s1'] }))).toBe(false)
    // a let-go thread is not a current one (the kernel's currentConversations): the other is the last
    expect(releaseOffersChoice({ ...task('d', { state: 'in_progress', conversations: ['s1', 's2'] }), currentConversations: ['s2'] })).toBe(true)
  })
  it("the state rides the release; the server's words come back said", async () => {
    const { unlinkConversation, releaseWords } = await import('../src/lib/task-link')
    release.mockResolvedValueOnce({ released: true })
    const r = await unlinkConversation('k/tasks/t1', 's1', 'done')
    expect(release).toHaveBeenCalledWith({ key: 'k/tasks/t1', session: 's1', state: 'done' })
    expect(r.said).toBe('Unlinked — it is done now.')
    release.mockResolvedValueOnce({ released: true })
    await unlinkConversation('k/tasks/t1', 's1')
    expect(release).toHaveBeenLastCalledWith({ key: 'k/tasks/t1', session: 's1' })
    expect(releaseWords({ released: true, kept: 'in_progress' })).toBe('Unlinked — it stays in progress (another conversation is on it).')
    expect(releaseWords({ written: false, kept: 'blocked', already: 'released' })).toBe('Already unlinked — it stays blocked.')
    expect(releaseWords({ released: true })).toBe('Unlinked — it is to pick up now.')
  })
})

describe("the header's words", () => {
  const w = (state: string, current: boolean, closed = false) => workWord({ state: state as WorkedTask['state'], current, closed })
  it('working · linked · worked · state · done', () => {
    expect(w('in_progress', true)).toEqual({ word: 'working', lead: 'Working on', state: null })
    expect(w('blocked', true)).toEqual({ word: 'linked', lead: 'Linked to', state: null })
    expect(w('in_review', true).word).toBe('linked')
    // let go and still open: its state, no ✓
    expect(w('pending', false)).toEqual({ word: 'worked', lead: 'Worked on', state: 'pending' })
    expect(w('done', true).word).toBe('done')
    expect(w('in_progress', true, true).word).toBe('done')
  })
})

// «Unlink… as blocked» is ONE release with its wait:
// nothing is written before it, nothing taken back after it (unlinkAs's
// write-and-undo is gone)
describe('Unlink as blocked — ONE release carrying its wait', () => {
  beforeEach(() => {
    release.mockReset()
    setField.mockReset()
    setField.mockResolvedValue({})
  })
  const wait = { owner: 'owner', action: 'unblock it' }
  it('blocked: the wait rides the release itself; no set-field at all', async () => {
    const { unlinkConversation } = await import('../src/lib/task-link')
    release.mockResolvedValueOnce({ released: true, disposed: 'blocked', wait })
    const r = await unlinkConversation('k/tasks/t1', 's1', 'blocked', wait)
    expect(release).toHaveBeenCalledWith({ key: 'k/tasks/t1', session: 's1', state: 'blocked', wait })
    expect(setField).not.toHaveBeenCalled()
    expect(r.said).toBe('Unlinked — it is blocked now.')
  })
  it('the server kept another state: no wait was written — and said', async () => {
    const { unlinkConversation } = await import('../src/lib/task-link')
    release.mockResolvedValueOnce({ released: true, kept: 'in_progress' })
    const r = await unlinkConversation('k/tasks/t1', 's1', 'blocked', wait)
    expect(r.said).toMatch(/stays in progress.*no wait was written/)
    expect(setField).not.toHaveBeenCalled()
  })
  it('any other disposition sends no wait', async () => {
    const { unlinkConversation } = await import('../src/lib/task-link')
    release.mockResolvedValueOnce({ released: true, disposed: 'done' })
    await unlinkConversation('k/tasks/t1', 's1', 'done', wait)
    expect(release).toHaveBeenLastCalledWith({ key: 'k/tasks/t1', session: 's1', state: 'done' })
  })
})
