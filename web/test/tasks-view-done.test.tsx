// tasks-view-done.test.tsx — Tasks' `d` on a row of the owner's is the
// owner's Done: the ONE verb, with the state the row
// painted; a refusal is said in the view in the server's words.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TasksView } from '../src/components/tasks/TasksView'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { resetTasksCache } from '../src/hooks/useTasks'
import type { SiloRecordsPage } from '../src/lib/types'

vi.mock('../src/lib/api', async (orig) => {
  const real = await orig<typeof import('../src/lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      silos: { ...real.api.silos, records: vi.fn() },
      tasksAct: vi.fn(),
      tasksBySession: vi.fn(async () => ({})),
      taskSeen: { read: vi.fn(async () => ({ seen: {} })), mark: vi.fn(async () => null) },
    },
  }
})
const mocked = vi.mocked(api, { deep: true })
const PLAN = 'folder:/proj/ship'
let KEY = `${PLAN}/tasks/t1`
let n = 0

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  // a fresh task per case: the list's held order never carries one case's Done into the next
  n += 1
  KEY = `${PLAN}/tasks/t${n}`
  vi.clearAllMocks()
  resetTasksCache()
  const page: SiloRecordsPage = {
    silo: { id: 'plans', name: 'Plans', state: 'active', freshness: null },
    kind: { name: 'plans/plan/task', states: [], columns: [], columnTypes: {}, facets: [], stateEdit: null },
    total: 1,
    matching: 1,
    offset: 0,
    limit: 200,
    said: null,
    unreadable: { count: 0, items: [] },
    records: [
      {
        key: KEY,
        id: `t${n}`,
        identity: 'Sign the lease',
        state: 'in_progress',
        stateLabel: 'in progress',
        at: null,
        anchors: { folder: '/proj' },
        cells: [],
        row: '',
        folded: false,
        overlay: false,
        conflict: false,
        remarks: [],
        file: '/proj/plans/ship.plan.json',
        parent: { key: PLAN, identity: 'Ship', at: '2026-11-01' },
        value: { id: `t${n}`, title: 'Sign the lease', owner: 'owner', state: 'in_progress', dependsOn: [] },
      } as never,
    ],
  }
  mocked.silos.records.mockResolvedValue(page)
  useStore.setState({ agents: [], page: { kind: 'tasks', view: 'open' } as never, silos: [] })
})

describe('Tasks — d on a task of yours', () => {
  it('is the verb done with the state the row painted', async () => {
    mocked.tasksAct.mockResolvedValue({ key: KEY, record: { tasks: [{ id: `t${n}`, state: 'done' }] }, already: false, holds: [] })
    render(<TasksView />)
    await screen.findAllByText('Sign the lease')
    // the keys are pressed until the list takes them: under a loaded machine the
    // row can be painted a tick before the view's key handler holds it
    await waitFor(
      () => {
        if (mocked.tasksAct.mock.calls.length === 0) {
          fireEvent.keyDown(document.body, { key: 'j' })
          fireEvent.keyDown(document.body, { key: 'd' })
        }
        expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'done', state: 'in_progress' })
      },
      { timeout: 5000 },
    )
  })
  it("a refusal is said in the server's words", async () => {
    mocked.tasksAct.mockRejectedValue(new Error('it is dropped — reopen it first'))
    render(<TasksView />)
    await screen.findAllByText('Sign the lease')
    await waitFor(
      () => {
        if (mocked.tasksAct.mock.calls.length === 0) {
          fireEvent.keyDown(document.body, { key: 'j' })
          fireEvent.keyDown(document.body, { key: 'd' })
        }
        expect(mocked.tasksAct).toHaveBeenCalled()
      },
      { timeout: 5000 },
    )
    expect(await screen.findByText('«Sign the lease» is not done: it is dropped — reopen it first', {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
