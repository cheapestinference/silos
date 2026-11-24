// server/test/execution-record.test.ts
import { describe, it, expect } from 'vitest'
import { buildRecord, isLedgerPath, parseLedger, parsePlanDoc, repoRootOfLedger, taskRefOf } from '../src/execution-record.js'

const LEDGER = `# SDD ledger — plan: docs/superpowers/plans/2026-10-27-x.md
Branch: feat/x (from main abc1234)
Task 1: fix round 1/5 (1 addressed pending re-review; commits a1..b2)
Task 1: complete (commits a1..c3, review clean after fix round 1)
Task 2: Ruling: keep the regex — not a finding
Task 3: fix round 2
Task 4: complete — e2e 11/11 PASS (after 2 fixes)
`
const DOC = `# X Implementation Plan

> **For agentic workers:** …

### Task 1: The parser
- [ ] step
### Task 2: The store
### Task 3: Wiring
### Task 4: The column
### Task 5: Docs
`

describe('isLedgerPath / repoRootOfLedger', () => {
  it('recognises the per-plan ledger, nothing else', () => {
    expect(isLedgerPath('/r/.superpowers/sdd/2026-10-27-x/progress.md')).toBe(true)
    expect(isLedgerPath('/r/.superpowers/sdd/progress.md')).toBe(false)
    expect(isLedgerPath('/r/progress.md')).toBe(false)
    expect(isLedgerPath('/r/.superpowers/sdd/x/notes.md')).toBe(false)
    expect(repoRootOfLedger('/r/.worktrees/w/.superpowers/sdd/x/progress.md')).toBe('/r/.worktrees/w')
  })
})

describe("parseLedger — the SDD skill's own lines, verbatim", () => {
  it('reads the header, completes, fix rounds; complete wins over an earlier round; free-text detail survives', () => {
    const p = parseLedger(LEDGER)
    expect(p.planRef).toBe('docs/superpowers/plans/2026-10-27-x.md')
    expect(p.tasks.get(1)).toEqual({ state: 'complete', detail: 'commits a1..c3, review clean after fix round 1' })
    expect(p.tasks.get(2)).toBeUndefined()
    expect(p.tasks.get(3)).toEqual({ state: 'fixing', round: 2 })
    expect(p.tasks.get(4)).toEqual({ state: 'complete', detail: 'e2e 11/11 PASS (after 2 fixes)' })
  })
  it('a fix round after a complete line does not un-complete the task', () => {
    const p = parseLedger('# SDD ledger — plan: p.md\nTask 2: complete (x)\nTask 2: fix round 1/5 (y)\n')
    expect(p.tasks.get(2)?.state).toBe('complete')
  })
  it('a first line other than the current header names no plan', () => {
    const p = parseLedger('# SDD Progress — pools education layer\nTask 0: complete (baseline)\n')
    expect(p.planRef).toBeNull()
  })
  it('an empty or foreign text parses to nothing', () => {
    expect(parseLedger('').tasks.size).toBe(0)
    expect(parseLedger('# notes\nTask: nope\n').tasks.size).toBe(0)
  })
})

describe('parsePlanDoc', () => {
  it('reads the title and the ### Task N headings in order', () => {
    expect(parsePlanDoc(DOC)).toEqual({
      title: 'X Implementation Plan',
      tasks: [
        { n: 1, title: 'The parser' },
        { n: 2, title: 'The store' },
        { n: 3, title: 'Wiring' },
        { n: 4, title: 'The column' },
        { n: 5, title: 'Docs' },
      ],
    })
    expect(parsePlanDoc('no headings')).toEqual({ title: null, tasks: [] })
  })
  it('skips headings inside ``` and ~~~ fences; the first heading per number wins', () => {
    const doc = [
      '# Real Plan',
      '```markdown',
      '# Fixture title',
      '### Task 1: Fixture',
      '### Task 2: Fixture two',
      '```',
      '### Task 1: The parser',
      '~~~',
      '### Task 9: Tilde fixture',
      '```',
      '### Task 8: still inside the tilde fence',
      '~~~',
      '### Task 2: The store',
      '### Task 2: A repeated heading',
    ].join('\n')
    expect(parsePlanDoc(doc)).toEqual({
      title: 'Real Plan',
      tasks: [
        { n: 1, title: 'The parser' },
        { n: 2, title: 'The store' },
      ],
    })
    const r = buildRecord({
      ledgerPath: '/r/.superpowers/sdd/x/progress.md',
      ledger: 'Task 1: complete (a)\n',
      ledgerMtime: 1,
      planPath: '/r/p.md',
      plan: doc,
      gone: false,
    })
    expect(r).toMatchObject({ done: 1, total: 2 })
    expect(r.tasks[0]).toMatchObject({ n: 1, title: 'The parser' })
  })
})

describe('taskRefOf / parseLedger — the real task-reference forms', () => {
  it('reads plain, plural, parenthetical and lettered references', () => {
    expect(taskRefOf('Task 3: complete (x)')).toEqual({ numbers: [3], rest: 'complete (x)' })
    expect(taskRefOf('Tasks 2+3: complete (joint)')).toEqual({ numbers: [2, 3], rest: 'complete (joint)' })
    expect(taskRefOf('Tasks 4, 5 & 6: fix round 1')).toEqual({ numbers: [4, 5, 6], rest: 'fix round 1' })
    expect(taskRefOf('Tasks 4-6: complete (joint)')).toEqual({ numbers: [4, 5, 6], rest: 'complete (joint)' })
    expect(taskRefOf('Tasks 4–6: fix round 1')).toEqual({ numbers: [4, 5, 6], rest: 'fix round 1' })
    expect(taskRefOf('Tasks 1-2, 5: complete')).toEqual({ numbers: [1, 2, 5], rest: 'complete' })
    expect(taskRefOf('Tasks 6-4: complete')).toEqual({ numbers: [6, 4], rest: 'complete' })
    expect(taskRefOf('Tasks 1-999999999: complete')).toEqual({ numbers: [1, 999999999], rest: 'complete' })
    expect(taskRefOf('Task 8 (v2): complete (redo)')).toEqual({ numbers: [8], rest: 'complete (redo)' })
    expect(taskRefOf('Task 2A: complete (half)')).toEqual({ numbers: [2], rest: 'complete (half)' })
    expect(taskRefOf('Branch: x')).toBeNull()
    expect(taskRefOf('Taskforce 3: complete')).toBeNull()
  })
  it('every number on a line takes its state; complete still wins over a later fix round', () => {
    const p = parseLedger(
      ['Tasks 2+3: complete (commits a..b)', 'Task 8 (v2): complete (rewritten)', 'Task 5A: fix round 2/3 (pending)', 'Tasks 3, 9: fix round 1'].join('\n'),
    )
    expect(p.tasks.get(2)).toEqual({ state: 'complete', detail: 'commits a..b' })
    expect(p.tasks.get(3)).toEqual({ state: 'complete', detail: 'commits a..b' })
    expect(p.tasks.get(8)).toEqual({ state: 'complete', detail: 'rewritten' })
    expect(p.tasks.get(5)).toEqual({ state: 'fixing', round: 2, detail: 'pending' })
    expect(p.tasks.get(9)).toEqual({ state: 'fixing', round: 1 })
  })
})

describe('buildRecord', () => {
  it('unions document and ledger by task number, counts done against the document', () => {
    const r = buildRecord({
      ledgerPath: '/r/.superpowers/sdd/x/progress.md',
      ledger: LEDGER,
      ledgerMtime: 1000,
      planPath: '/r/docs/superpowers/plans/2026-10-27-x.md',
      plan: DOC,
      gone: false,
    })
    expect(r.planTitle).toBe('X Implementation Plan')
    expect(r.done).toBe(2)
    expect(r.total).toBe(5)
    expect(r.updatedAt).toBe(1000)
    expect(r.gone).toBe(false)
    expect(r.tasks.map((t) => [t.n, t.title, t.state])).toEqual([
      [1, 'The parser', 'complete'],
      [2, 'The store', 'pending'],
      [3, 'Wiring', 'fixing'],
      [4, 'The column', 'complete'],
      [5, 'Docs', 'pending'],
    ])
    expect(r.tasks[2]).toMatchObject({ round: 2 })
  })
  it('with a document, done counts only the tasks it names; a Task 0 baseline still lists', () => {
    const ledger = ['Task 0: complete (baseline)', 'Task 1: complete', 'Task 2: complete', 'Task 3: complete', 'Task 4: complete'].join('\n')
    const r = buildRecord({ ledgerPath: '/r/.superpowers/sdd/x/progress.md', ledger, ledgerMtime: 1, planPath: '/r/p.md', plan: DOC, gone: false })
    expect(r).toMatchObject({ done: 4, total: 5 })
    expect(r.tasks[0]).toMatchObject({ n: 0, title: null, state: 'complete' })
  })
  it('without a document: tasks from the ledger alone, no total, no title', () => {
    const r = buildRecord({
      ledgerPath: '/r/.superpowers/sdd/x/progress.md',
      ledger: '# SDD ledger — plan: docs/x.md\nTask 1: complete (a)\nTask 2: complete (b)\n',
      ledgerMtime: 5,
      planPath: null,
      plan: null,
      gone: true,
    })
    expect(r).toMatchObject({ planPath: null, planTitle: null, done: 2, total: null, gone: true })
    expect(r.tasks.map((t) => [t.n, t.title])).toEqual([
      [1, null],
      [2, null],
    ])
  })
})
