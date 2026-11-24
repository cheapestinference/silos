// plan-view-execution.test.tsx — a plan task shows the SDD execution hung
// from it (the Executions silo, task-view phase 5), in both densities; a
// plan the silo does not name (no key) gets no execution line.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { PlanView } from '../src/components/PlanView'
import { useStore } from '../src/store'
import { resetExecutionsCache } from '../src/hooks/useExecutions'
import type { TeamPlan } from '../src/lib/team-plan'
import type { SiloRecordRow } from '../src/lib/types'

const records = vi.fn<(id: string) => Promise<{ records: SiloRecordRow[]; matching: number }>>()
vi.mock('../src/lib/api', () => ({
  api: { silos: { records: (id: string) => records(id) } },
  ApiError: class extends Error {
    status = 0
  },
}))

const NOW = 10 * 3_600_000
const PLAN_KEY = 'folder:/p/q4'
const row = (task: string | null, over: Record<string, unknown> = {}): SiloRecordRow => ({
  key: `platform/x~${task ?? 'none'}`,
  id: `x~${task ?? 'none'}`,
  identity: 'X',
  state: 'fixing',
  stateLabel: 'fixing',
  at: null,
  anchors: task ? { task: `${PLAN_KEY}/tasks/${task}` } : {},
  cells: [],
  row: '',
  folded: false,
  overlay: false,
  conflict: false,
  remarks: [],
  file: null,
  value: {
    state: 'fixing',
    updatedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    done: 1,
    total: 3,
    totalFrom: 'document',
    gone: false,
    ledger: '/p/.superpowers/sdd/x/progress.md',
    fixingTask: 2,
    round: 1,
    ...over,
  },
})
const plan: TeamPlan = {
  title: 'Q4',
  tasks: [
    { id: 't1', title: 'Execute X', owner: 'silos', status: 'in_progress', dependsOn: [], source: 'docs/x.md' },
    { id: 't2', title: 'Validate X', owner: 'sam', status: 'blocked', dependsOn: ['t1'] },
  ],
}

beforeEach(() => {
  records.mockReset()
  resetExecutionsCache()
  useStore.setState({
    agents: [{ id: 'silos', name: 'Silos', emoji: '📦', role: 'r', folder: '/p', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }] as never,
    nowTick: NOW,
  })
})

describe('PlanView × the Executions silo', () => {
  it('full view: the task its execution hangs from carries its line; the others none', async () => {
    records.mockResolvedValue({ records: [row('t1'), row(null)], matching: 2 })
    render(<PlanView plan={plan} planKey={PLAN_KEY} />)
    await waitFor(() => expect(screen.getByTestId('plan-exec-t1')).toHaveTextContent('1 of 3'))
    expect(records).toHaveBeenCalledWith('executions')
    expect(screen.queryByTestId('plan-exec-t2')).toBeNull()
  })
  it('compact: under the header, who executes and how far', async () => {
    records.mockResolvedValue({ records: [row('t1')], matching: 1 })
    render(<PlanView compact plan={plan} planKey={PLAN_KEY} />)
    await waitFor(() => expect(screen.getByTestId('plan-exec-compact')).toHaveTextContent('Silos'))
    expect(screen.getByTestId('plan-exec-compact')).toHaveTextContent('1 of 3')
  })
  it('the newest execution hung from a task speaks', async () => {
    records.mockResolvedValue({
      records: [row('t1'), { ...row('t1', { done: 3, state: 'done', updatedAt: new Date(NOW - 60_000).toISOString() }), key: 'platform/y', id: 'y' }],
      matching: 2,
    })
    render(<PlanView plan={plan} planKey={PLAN_KEY} />)
    await waitFor(() => expect(screen.getByTestId('plan-exec-t1')).toHaveTextContent('all 3'))
    expect(screen.getByTestId('plan-exec-t1')).not.toHaveTextContent('1 of 3')
  })
  it('no execution hung, or a plan with no key: no line', async () => {
    records.mockResolvedValue({ records: [row(null)], matching: 1 })
    const { unmount } = render(<PlanView compact plan={plan} planKey={PLAN_KEY} />)
    await waitFor(() => expect(records).toHaveBeenCalled())
    expect(screen.queryByTestId('plan-exec-compact')).toBeNull()
    unmount()
    render(<PlanView compact plan={plan} />)
    expect(screen.queryByTestId('plan-exec-compact')).toBeNull()
  })
})
