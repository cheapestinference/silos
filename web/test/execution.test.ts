import { describe, expect, it } from 'vitest'
import { executionOver, executionProgress, executionWord, groupExecution, parseExecutionRole, progressSource, spanWord, stepWord } from '../src/lib/execution'
import type { DiskSubagent, ExecutionRecord } from '../src/lib/types'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const LIVE = NOW - 5_000 // within the liveness window
const OLD = NOW - 60 * 60_000

function sub(o: Partial<DiskSubagent> & { id: string }): DiskSubagent {
  return { description: null, type: 'general-purpose', mtime: OLD, ...o }
}

describe('parseExecutionRole — the SDD prompt templates, verbatim', () => {
  it('reads implementer, reviewer and re-reviewer names', () => {
    expect(parseExecutionRole('Implement Task 12: OpenCode console route')).toEqual({ role: 'implement', task: 12, title: 'OpenCode console route' })
    expect(parseExecutionRole('Implement Task 3')).toEqual({ role: 'implement', task: 3 })
    expect(parseExecutionRole('Review Task 12 (spec + quality)')).toEqual({ role: 'review', task: 12 })
    expect(parseExecutionRole('Review Task 9 (spec + quality + security)')).toEqual({ role: 'review', task: 9 })
    expect(parseExecutionRole('Re-review Task 9 fix round 2')).toEqual({ role: 're-review', task: 9, round: 2 })
    expect(parseExecutionRole('Re-review Task 6 round 3 (security hotfix)')).toEqual({ role: 're-review', task: 6, round: 3 })
  })
  it('leaves everything else alone', () => {
    expect(parseExecutionRole('Review births branch (spec + quality)')).toBeNull()
    expect(parseExecutionRole('Finder: cross-file')).toBeNull()
    expect(parseExecutionRole('/code-review max — sixth pass')).toBeNull()
    expect(parseExecutionRole(null)).toBeNull()
    expect(parseExecutionRole('')).toBeNull()
  })
  it('words a step as what it does', () => {
    expect(stepWord({ role: 'implement' })).toBe('implement')
    expect(stepWord({ role: 'review' }, 'ing')).toBe('reviewing')
    expect(stepWord({ role: 're-review', round: 2 })).toBe('re-review round 2')
    expect(stepWord({ role: 're-review' }, 'ing')).toBe('re-reviewing')
  })
})

describe('groupExecution — one row per task, steps in order, live first', () => {
  const census: DiskSubagent[] = [
    sub({ id: 'i11', description: 'Implement Task 11: Console registrar', startedAt: OLD - 3000, mtime: OLD }),
    sub({ id: 'r11', description: 'Review Task 11 (spec + quality)', startedAt: OLD - 2000, mtime: OLD + 1000 }),
    sub({ id: 'i12', description: 'Implement Task 12: OpenCode console route', startedAt: OLD + 5000, mtime: OLD + 9000 }),
    sub({ id: 'r12', description: 'Review Task 12 (spec + quality + security)', startedAt: OLD + 10_000, mtime: LIVE }),
    sub({ id: 'f1', description: 'Finder: cross-file', parentId: 'r12', depth: 2, mtime: LIVE }),
    sub({ id: 'x', description: 'Explore the repo', mtime: OLD }),
  ]
  it('groups by task number and claims steps with their helpers', () => {
    const { tasks, claimed } = groupExecution(census, NOW)
    expect(tasks.map((t) => t.n)).toEqual([12, 11])
    expect(tasks[0]!.title).toBe('OpenCode console route')
    expect(tasks[0]!.live).toBe(true)
    expect(tasks[0]!.steps.map((s) => s.role)).toEqual(['implement', 'review'])
    expect(tasks[0]!.steps[1]!.kin.map((k) => k.id)).toEqual(['f1'])
    expect(tasks[1]!.live).toBe(false)
    expect([...claimed].sort()).toEqual(['f1', 'i11', 'i12', 'r11', 'r12'])
    expect(claimed.has('x')).toBe(false)
  })
  it('is empty for a census with no execution rows', () => {
    const { tasks, claimed } = groupExecution([sub({ id: 'x', description: 'Explore the repo' })], NOW)
    expect(tasks).toEqual([])
    expect(claimed.size).toBe(0)
  })
  it('a title arrives with the implementer even when the reviewer came first in the listing', () => {
    const { tasks } = groupExecution(
      [
        sub({ id: 'r', description: 'Review Task 4 (spec + quality)', startedAt: OLD + 10, mtime: OLD + 10 }),
        sub({ id: 'i', description: 'Implement Task 4: Agent sign-up', startedAt: OLD, mtime: OLD }),
      ],
      NOW,
    )
    expect(tasks[0]!.title).toBe('Agent sign-up')
    expect(tasks[0]!.steps.map((s) => s.role)).toEqual(['implement', 'review'])
  })
})

describe('executionWord — Home names the newest live step', () => {
  it('says the task and what is happening to it', () => {
    const census = [
      sub({ id: 'i12', description: 'Implement Task 12: OpenCode console route', mtime: OLD }),
      sub({ id: 'r12', description: 'Review Task 12 (spec + quality)', mtime: LIVE }),
    ]
    expect(executionWord(census, NOW)).toBe('Step 12 · reviewing')
  })
  it('a live helper keeps its step live', () => {
    const census = [
      sub({ id: 'r9', description: 'Re-review Task 9 fix round 2', mtime: OLD }),
      sub({ id: 'f', description: 'Finder', parentId: 'r9', mtime: LIVE }),
    ]
    expect(executionWord(census, NOW)).toMatch(/9/)
  })
  it('is null when nothing is live, or nothing is an execution', () => {
    expect(executionWord([sub({ id: 'i', description: 'Implement Task 1: x', mtime: OLD })], NOW)).toBeNull()
    expect(executionWord([sub({ id: 'x', description: 'Finder', mtime: LIVE })], NOW)).toBeNull()
  })
})

describe('executionProgress — done/total from the plan, pace from the census', () => {
  const H = 60 * 60_000
  const step = (id: string, d: string, start: number, end: number) => sub({ id, description: d, startedAt: start, mtime: end })
  const census = [
    step('i1', 'Implement Task 1: a', NOW - 10 * H, NOW - 9.5 * H),
    step('r1', 'Review Task 1 (spec + quality)', NOW - 9.5 * H, NOW - 9 * H), // task 1: 1 h
    step('i2', 'Implement Task 2: b', NOW - 9 * H, NOW - 7.5 * H),
    step('r2', 'Review Task 2 (spec + quality)', NOW - 7.5 * H, NOW - 7 * H), // task 2: 2 h
    step('i3', 'Implement Task 3: c', NOW - 7 * H, NOW - 1000), // live
  ]
  // what the record says (done tasks 1 and 2 of 4)
  const two = { done: new Set([1, 2]), total: 4 }
  it('counts the plan, names the live step with its own time, and extrapolates the mean work time over what remains', () => {
    const { tasks } = groupExecution(census, NOW)
    const p = executionProgress(tasks, two, NOW)
    expect(p.done).toBe(2)
    expect(p.total).toBe(4)
    expect(p.current).toEqual({ task: 3, word: 'implementing', forMs: 7 * H })
    expect(p.remainingMs).toBe(2 * 1.5 * H) // mean 1.5 h × 2 left
  })
  it("work time is the steps' own durations — the night between an implementer and its reviewer does not count", () => {
    const gapped = [
      step('i1', 'Implement Task 1: a', NOW - 30 * H, NOW - 29 * H), // 1 h
      step('r1', 'Review Task 1 (spec + quality)', NOW - 20 * H, NOW - 19 * H), // 1 h, nine hours later
      step('i2', 'Implement Task 2: b', NOW - 19 * H, NOW - 18 * H), // 1 h
      step('r2', 'Review Task 2 (spec + quality)', NOW - 18 * H, NOW - 17 * H), // 1 h
    ]
    const { tasks } = groupExecution(gapped, NOW)
    const p = executionProgress(tasks, two, NOW)
    expect(p.remainingMs).toBe(2 * 2 * H) // 2 h of work per task × 2 left, not 11 h × 2
    expect(p.current).toBeNull()
  })
  it('names no pace with fewer than two finished tasks measured', () => {
    const { tasks } = groupExecution(census.slice(0, 3), NOW)
    const p = executionProgress(tasks, { done: new Set([1]), total: 2 }, NOW)
    expect(p.done).toBe(1)
    expect(p.remainingMs).toBeNull()
  })
  it('without a record, counts finished execution tasks and no total', () => {
    const { tasks } = groupExecution(census, NOW)
    const p = executionProgress(tasks, null, NOW)
    expect(p).toMatchObject({ done: 2, total: null, remainingMs: null })
    expect(p.current?.task).toBe(3)
  })
  it('words a span plainly', () => {
    expect(spanWord(30_000)).toBe('under a minute')
    expect(spanWord(40 * 60_000)).toBe('40 min')
    expect(spanWord(2 * H)).toBe('2 h')
    expect(spanWord(2 * H + 10 * 60_000)).toBe('2 h 10 min')
  })
})

describe('executionOver — history once nothing runs and nothing is left', () => {
  const H = 60 * 60_000
  const finished = groupExecution(
    [
      sub({ id: 'i1', description: 'Implement Task 1: a', startedAt: NOW - 3 * H, mtime: NOW - 2 * H }),
      sub({ id: 'i2', description: 'Implement Task 2: b', startedAt: NOW - 2 * H, mtime: NOW - H }),
    ],
    NOW,
  ).tasks
  it('is over when the plan calls every task done and no step is live', () => {
    expect(executionOver(finished, { done: 2, total: 2 })).toBe(true)
  })
  it('a paused execution is not over: the plan still has tasks left', () => {
    expect(executionOver(finished, { done: 2, total: 4 })).toBe(false)
  })
  it('a live step is never over, even on a plan marked complete', () => {
    const live = groupExecution([sub({ id: 'r2', description: 'Review Task 2 (spec + quality)', mtime: LIVE })], NOW).tasks
    expect(executionOver(live, { done: 2, total: 2 })).toBe(false)
  })
  it('without a plan, a quiet census is over; an empty one is nothing', () => {
    expect(executionOver(finished, { done: 2, total: null })).toBe(true)
    expect(executionOver([], { done: 0, total: null })).toBe(false)
  })
})

describe('progressSource / groupExecution with the execution record', () => {
  const record = (over: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
    ledgerPath: '/r/.superpowers/sdd/x/progress.md',
    planPath: '/r/docs/x.md',
    planTitle: 'X',
    updatedAt: OLD,
    gone: false,
    tasks: [
      { n: 1, title: 'a', state: 'complete', detail: 'commits a..b, review clean' },
      { n: 2, title: 'b', state: 'fixing', round: 2 },
      { n: 3, title: 'c', state: 'pending' },
    ],
    done: 1,
    total: 3,
    ...over,
  })
  it('the record is the only source; without one there is none (no plans.json fallback since phase 5)', () => {
    expect(progressSource(record())).toEqual({ done: new Set([1]), total: 3 })
    expect(progressSource(null)).toBeNull()
  })
  it('record tasks that ran without a census row become rows; pending ones do not; a record title fills a missing one', () => {
    const census = [sub({ id: 'r2', description: 'Review Task 2 (spec + quality)', mtime: LIVE })]
    const { tasks } = groupExecution(census, NOW, record())
    expect(tasks.map((t) => [t.n, t.title, t.live, t.steps.length])).toEqual([
      [2, 'b', true, 1],
      [1, 'a', false, 0],
    ])
    expect(tasks[1]!.detail).toBe('commits a..b, review clean')
    expect(tasks.map((t) => [t.n, t.state, t.round])).toEqual([
      [2, 'fixing', 2],
      [1, 'complete', undefined],
    ])
  })
  it('with a document, done counts only its tasks: a Task 0 baseline lists but is not progress', () => {
    const r = record({
      total: 5,
      done: 4,
      tasks: [
        { n: 0, title: null, state: 'complete', detail: 'baseline' },
        ...[1, 2, 3, 4].map((n) => ({ n, title: `t${n}`, state: 'complete' as const })),
        { n: 5, title: 't5', state: 'pending' as const },
      ],
    })
    const source = progressSource(r)!
    expect(source).toEqual({ done: new Set([1, 2, 3, 4]), total: 5 })
    const { tasks } = groupExecution([], NOW, r)
    expect(tasks.map((t) => t.n)).toContain(0) // it ran: still a row
    const progress = executionProgress(tasks, source, NOW)
    expect(progress).toMatchObject({ done: 4, total: 5 })
    expect(executionOver(tasks, progress)).toBe(false)
  })
  it("without a document, the total is the tasks the ledger names — the Executions silo's own count", () => {
    const noDoc = record({
      total: null,
      planPath: null,
      tasks: [
        { n: 1, title: null, state: 'complete' },
        { n: 2, title: null, state: 'complete' },
        { n: 3, title: null, state: 'fixing', round: 1 },
      ],
    })
    expect(progressSource(noDoc)).toEqual({ done: new Set([1, 2]), total: 3 })
  })
})
