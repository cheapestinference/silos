// executions.test.ts — the Executions silo's rows as the web reads them
// (task-view phase 5): the row → view (its task from the anchor), the one
// line every surface says (the parity contract with the old PlanView line),
// and the grouping by task / without a task.
import { describe, expect, it } from 'vitest'
import { executionLine, executionOfRow, executionsByTask, executionsWithoutTask, type ExecutionView } from '../src/lib/executions'
import type { SiloRecordRow } from '../src/lib/types'

const row = (id: string, over: Record<string, unknown> = {}, anchors: Record<string, unknown> = {}): SiloRecordRow => ({
  key: `platform/${id}`,
  id,
  identity: 'Plan X',
  state: 'running',
  stateLabel: 'running',
  at: null,
  anchors,
  cells: [],
  row: '',
  folded: false,
  overlay: false,
  conflict: false,
  remarks: [],
  file: null,
  value: {
    state: 'running',
    updatedAt: '1970-01-01T00:00:00.000Z',
    done: 2,
    total: 3,
    totalFrom: 'document',
    gone: false,
    ledger: '/r/.superpowers/sdd/x/progress.md',
    ...over,
  },
})

describe('executionOfRow', () => {
  it('reads the record; its task is the anchor the kernel resolved', () => {
    const e = executionOfRow(
      row(
        'f~s',
        { session: 's', folder: 'f', agent: 'writer', fixingTask: 2, round: 1, state: 'fixing', taskRef: 'p#t1', edge: 'conversation' },
        { task: 'folder:/r/p/tasks/t1' },
      ),
    )!
    expect(e).toMatchObject({
      id: 'f~s',
      state: 'fixing',
      title: 'Plan X',
      done: 2,
      total: 3,
      session: 's',
      agent: 'writer',
      fixingTask: 2,
      round: 1,
      task: 'folder:/r/p/tasks/t1',
      taskRef: 'p#t1',
      edge: 'conversation',
    })
  })
  it('a state the kind does not have is not an execution', () => {
    expect(executionOfRow(row('x', { state: 'weird' }))).toBeNull()
  })
})

describe('executionLine — the same words the PlanView always said', () => {
  const now = 3 * 3_600_000
  const e = (over: Partial<ExecutionView> = {}) => ({ done: 2, total: 3, fixingTask: null, round: null, updatedAt: 0, gone: false, ...over })
  it('a task in a fix round, while not all done', () => {
    expect(executionLine(e({ done: 1, total: 2, fixingTask: 2, round: 2 }), now)).toContain('round 2')
    expect(executionLine(e({ done: 2, total: 2, fixingTask: 2, round: 2 }), now)).not.toMatch(/fixing/)
  })
  it('a finished one, and one whose worktree is gone; zero of zero is not «all done»', () => {
    expect(executionLine(e({ done: 3 }), now)).toMatch(/^all 3/)
    expect(executionLine(e({ gone: true }), now)).toMatch(/removed/)
    expect(executionLine(e({ done: 0, total: 0 }), now)).not.toMatch(/all/)
  })
})

describe('grouping', () => {
  it('by task, newest first; the ones no task holds apart', () => {
    const all = [
      executionOfRow(row('a', { updatedAt: '2026-11-01T00:00:00Z' }, { task: 'k1' }))!,
      executionOfRow(row('b', { updatedAt: '2026-11-02T00:00:00Z' }, { task: 'k1' }))!,
      executionOfRow(row('c'))!,
    ]
    expect(
      executionsByTask(all)
        .get('k1')!
        .map((x) => x.id),
    ).toEqual(['b', 'a'])
    expect(executionsWithoutTask(all).map((x) => x.id)).toEqual(['c'])
  })
})

describe('an execution nothing runs says so', () => {
  const base = { done: 16, total: 17, fixingTask: null, round: null, updatedAt: 0, gone: false }
  const NOW = 5 * 86_400_000
  it('stopped replaces the running words, and names the task it stopped fixing', () => {
    expect(executionLine({ ...base, state: 'stopped' }, NOW)).toContain('stopped')
    const stoppedFixing = executionLine({ ...base, state: 'stopped', fixingTask: 4, round: 1 }, NOW)
    expect(stoppedFixing).toContain('stopped')
    expect(stoppedFixing).toContain('Step 4')
    expect(executionLine({ ...base, state: 'fixing', fixingTask: 4, round: 1 }, NOW)).not.toContain('stopped')
  })
  it('a row that folded other ledgers of its document counts them', () => {
    expect(executionLine({ ...base, state: 'stopped', otherLedgers: 1 }, NOW)).toMatch(/1 other/)
  })
})
