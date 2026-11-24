// plan-record.test.ts — the adapter from the plans silo's record (the
// kernel's normalized reading) to the TeamPlan the plan views draw, and the
// owner's Done from a plan view — the verb (lib/task-gesture.ts planTaskDone).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handoffOf, loadPlan, planOfRecord, PLANS_SILO, unreadTasksOf } from '../src/lib/plan-record'
import { planTaskDone } from '../src/lib/task-gesture'
import { readyTasks, unblocksOf } from '../src/lib/team-plan'
import { api, ApiError } from '../src/lib/api'
import type { SiloRecordDetail } from '../src/lib/types'

afterEach(() => vi.restoreAllMocks())

// what GET /api/silos/plans/record answers in `value` for the manifest's
// first example
const CLOSING = {
  _file: 'august-close.plan.json',
  title: 'August books close',
  createdAt: '2026-08-25',
  updatedAt: '2026-08-27',
  tasks: [
    {
      id: 't1',
      title: 'Export the monthly sales',
      owner: 'finance',
      status: 'done',
      dependsOn: [],
      state: 'done',
      at: '2026-08-27',
      updatedBy: null,
      notes: [],
      conversations: [
        { session: '6ad8e4db-0000-4000-8000-000000000001', id: '6ad8e4db-0000-4000-8000-000000000001', identity: '6ad8e4db-0000-4000-8000-000000000001' },
      ],
      identity: 'Export the monthly sales',
      ready: false,
      stateLabel: { one: 'done', many: 'done' },
    },
    {
      id: 't2',
      title: 'Confirm the figure with the accountant',
      owner: 'sam',
      status: 'pending',
      dependsOn: ['t1'],
      notes: [{ at: '2026-08-26T09:00:00Z', by: 'finance', text: 'Before the 28th', id: '0', identity: 'Before the 28th' }],
      state: 'pending',
      at: '2026-08-27',
      conversations: [],
      identity: 'Confirm the figure with the accountant',
      ready: true,
      stateLabel: { one: 'pending', many: 'pending' },
    },
    {
      id: 't3',
      title: 'Close the month in the ERP',
      owner: 'finance',
      status: 'blocked',
      dependsOn: ['t2'],
      notes: [{ at: '2026-08-26T09:05:00Z', by: 'finance', text: 'Waits for the figure from t2', id: '0' }],
      state: 'blocked',
      conversations: [],
      identity: 'Close the month in the ERP',
      stateLabel: { one: 'blocked', many: 'blocked' },
    },
  ],
  id: 'august-close',
  at: '2026-08-27',
  updatedBy: null,
  identity: 'August books close',
  state: 'active',
  stateLabel: { one: 'active', many: 'active' },
}

describe('planOfRecord', () => {
  it('the record reads as the plan the views always drew: title, dates, tasks with status, deps, notes text and conversation', () => {
    const p = planOfRecord(CLOSING)
    expect(p).toMatchObject({ title: 'August books close', createdAt: '2026-08-25', updatedAt: '2026-08-27', _file: 'august-close.plan.json' })
    expect(p.tasks.map((t) => [t.id, t.status, t.owner, t.dependsOn])).toEqual([
      ['t1', 'done', 'finance', []],
      ['t2', 'pending', 'sam', ['t1']],
      ['t3', 'blocked', 'finance', ['t2']],
    ])
    expect(p.tasks[0]!.conversation).toBe('6ad8e4db-0000-4000-8000-000000000001')
    expect(p.tasks[1]!.notes).toBe('Before the 28th')
    expect(p.tasks[2]!.notes).toBe('Waits for the figure from t2')
    // nothing of the kernel's envelope leaks into a task
    expect(Object.keys(p.tasks[1]!)).not.toEqual(expect.arrayContaining(['state', 'stateLabel', 'identity', 'ready']))
    expect(readyTasks(p).map((t) => t.id)).toEqual(['t2'])
  })

  it('the v-next shape: notes[] joined oldest first, conversations[] first session, in_review and cancelled kept', () => {
    const p = planOfRecord({
      title: 'Launch',
      updatedAt: '2026-11-02',
      tasks: [
        {
          id: 't1',
          title: 'Write',
          owner: 'writer',
          state: 'in_review',
          dependsOn: [],
          notes: [
            { at: 'a', by: 'writer', text: 'one' },
            { at: 'b', by: 'owner', text: 'two' },
          ],
          conversations: [{ session: 'ses_abcdefgh' }],
        },
        { id: 't2', title: 'OK', owner: 'sam', state: 'pending', dependsOn: ['t1'] },
        { id: 't3', title: 'Video', owner: 'writer', state: 'cancelled', dependsOn: [] },
        { id: 't4', title: 'Depends on cancelled', owner: 'writer', state: 'pending', dependsOn: ['t3'] },
        { id: 't5', title: 'Odd', owner: 'writer', state: 'someday', dependsOn: [] },
      ],
    })
    expect(p.tasks.map((t) => t.status)).toEqual(['in_review', 'pending', 'cancelled', 'pending'])
    expect(p.tasks[0]).toMatchObject({ notes: 'one\ntwo', conversation: 'ses_abcdefgh' })
    // in review is not ready; a cancelled blocker resolves nothing
    expect(readyTasks(p).map((t) => t.id)).toEqual([])
    expect(unblocksOf(p, 't1').map((t) => t.id)).toEqual(['t2'])
  })
})

describe('loadPlan / planTaskDone', () => {
  const detail = (over: Partial<SiloRecordDetail> = {}): SiloRecordDetail =>
    ({ record: { key: 'folder:/p/august-close' }, version: 'v1', value: CLOSING, ...over }) as unknown as SiloRecordDetail

  it('loads by file; a file the silo does not read is null (the caller shows the raw file)', async () => {
    const spy = vi.spyOn(api.silos, 'recordByFile').mockResolvedValueOnce(detail())
    expect(await loadPlan('/p/plans/august-close.plan.json')).toMatchObject({
      key: 'folder:/p/august-close',
      version: 'v1',
      outside: false,
      plan: { title: 'August books close' },
    })
    expect(spy).toHaveBeenCalledWith(PLANS_SILO, '/p/plans/august-close.plan.json')
    vi.spyOn(api.silos, 'recordByFile').mockRejectedValueOnce(new ApiError('no record', 404, {}))
    expect(await loadPlan('/p/plans/x.plan.json')).toBeNull()
  })

  it("Done = the owner's verb on the task key with the state the view painted; the handoff names the agents and their wakes", async () => {
    const act = vi.fn(async () => ({
      key: 'k',
      record: { tasks: [{ id: 't2', state: 'done' }] },
      already: false,
      holds: [],
      nowReady: [
        { key: 'folder:/p/august-close/tasks/t3', id: 't3', identity: 'Close the month in the ERP', owner: 'finance', wakes: 'task' as const },
        { key: 'k', id: 't9', identity: 'x', owner: 'ana' },
      ],
    }))
    const p = (await (async () => {
      vi.spyOn(api.silos, 'recordByFile').mockResolvedValueOnce(detail())
      return loadPlan('/p/plans/august-close.plan.json')
    })())!
    const r = await planTaskDone(p, 't2', { act })
    expect(act).toHaveBeenCalledWith({ key: 'folder:/p/august-close/tasks/t2', verb: 'done', state: 'pending' })
    expect(handoffOf(r.nowReady ?? [], (id) => id.toUpperCase())).toEqual([
      { agentId: 'finance', agentName: 'FINANCE', taskId: 't3', title: 'Close the month in the ERP', wakes: 'task' },
    ])
  })

  it("a plan under its project's plans/closed/ loads closed (its own, read only), never written", async () => {
    vi.spyOn(api.silos, 'recordByFile').mockResolvedValueOnce(detail({ outside: true, version: null }))
    const p = (await loadPlan('/p/plans/closed/august-close.plan.json'))!
    expect(p.closed).toBe(true)
    const act = vi.fn()
    await expect(planTaskDone(p, 't2', { act })).rejects.toThrow(/closed/)
    expect(act).not.toHaveBeenCalled()
  })

  it("a plan read outside Silos' projects is never written", async () => {
    vi.spyOn(api.silos, 'recordByFile').mockResolvedValueOnce(detail({ outside: true, version: null }))
    const p = (await loadPlan('/elsewhere/plans/x.plan.json'))!
    expect(p.outside).toBe(true)
    const act = vi.fn()
    await expect(planTaskDone(p, 't2', { act })).rejects.toThrow(/outside Silos' projects/)
    expect(act).not.toHaveBeenCalled()
    expect(handoffOf([], (id) => id)).toEqual([])
  })
})

describe('the tasks a plan file holds that the reader could not build', () => {
  it("each with the id the raw file gives (else none) and the reader's why; other remarks are not tasks", () => {
    const raw = JSON.stringify({ title: 'P', tasks: [{ id: 't1' }, { id: 't7', notes: 'x' }, { title: 'no id' }] })
    expect(unreadTasksOf(['tasks[1] is not read: notes is not an array', 'state is computed — ignored', 'tasks[2] is not read: missing id'], raw)).toEqual([
      { id: 't7', reason: 'notes is not an array' },
      { id: null, reason: 'missing id' },
    ])
    expect(unreadTasksOf(['tasks[0] is not read: x'], 'not json')).toEqual([{ id: null, reason: 'x' }])
  })
})
