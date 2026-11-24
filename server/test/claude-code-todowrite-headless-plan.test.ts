import { describe, it, expect } from 'vitest'
import { ContextAccumulator } from '../src/harnesses/claude-code/context.js'

// R10: the Checklist from TodoWrite (a snapshot of the
// whole list per call, no ids) and plan mode in headless turns (`-p` / SDK:
// no ExitPlanMode — the plan_mode attachment names the file, the Write of
// that file is the proposal). Generic fixtures, shapes from the SDK types
// (TodoWriteInput) and the CLI 2.1.319 attachment.
const PLAN_FILE = '/home/user/.claude/plans/quiet-river-plan.md'
let n = 0
const at = () => `2026-11-08T10:00:${String(n++ % 60).padStart(2, '0')}.000Z`
const toolUse = (name: string, input: Record<string, unknown>, id = `toolu_${n}`) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(),
    message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  })
const toolResult = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    ...extra,
  })
const planAttachment = (file = PLAN_FILE) =>
  JSON.stringify({
    type: 'attachment',
    timestamp: at(),
    slug: 'quiet-river-plan',
    attachment: { type: 'plan_mode', reminderType: 'full', isSubAgent: false, planFilePath: file, planExists: false },
  })
const todos = (...items: Array<[string, 'pending' | 'in_progress' | 'completed']>) =>
  toolUse('TodoWrite', { todos: items.map(([content, status]) => ({ content, status, activeForm: `Doing: ${content}` })) })

describe('TodoWrite — the Checklist', () => {
  it('each call replaces the list: ids by position, subject = content, activeForm, status', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([todos(['Read the code', 'in_progress'], ['Write the fix', 'pending'], ['Run tests', 'pending'])])
    expect(acc.state.plan?.tasks.map((t) => [t.id, t.subject, t.status])).toEqual([
      ['1', 'Read the code', 'in_progress'],
      ['2', 'Write the fix', 'pending'],
      ['3', 'Run tests', 'pending'],
    ])
    expect(acc.state.plan?.tasks[0]!.activeForm).toBe('Doing: Read the code')

    acc.feedLines([todos(['Read the code', 'completed'], ['Write the fix', 'in_progress'])])
    const plan = acc.state.plan!
    expect(plan.tasks.map((t) => [t.id, t.subject, t.status])).toEqual([
      ['1', 'Read the code', 'completed'],
      ['2', 'Write the fix', 'in_progress'],
    ])
    expect(plan.done).toBe(1)
    expect(plan.total).toBe(2)
  })

  it('an empty list empties the Checklist, and the list survives the cache', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([todos(['One', 'pending'])])
    const again = new ContextAccumulator(acc.state)
    expect(again.state.plan?.total).toBe(1)
    again.feedLines([toolUse('TodoWrite', { todos: [] })])
    expect(again.state.plan).toBeNull()
  })
})

describe('plan mode in a headless turn', () => {
  it('attachment + Write of that path → proposed, titled by its first «# », without toolUseId', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([planAttachment(), toolUse('Write', { file_path: PLAN_FILE, content: 'Intro line\n# Ship the importer\n\n## Steps\n1. a' })])
    expect(acc.state.planMode).toEqual({ state: 'proposed', title: 'Ship the importer', at: expect.any(String), file: PLAN_FILE })
    expect(acc.hasPendingAsk).toBe(true)
  })

  it('an Edit of the plan file re-proposes it; without a heading it keeps the title', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([planAttachment(), toolUse('Write', { file_path: PLAN_FILE, content: '# First title\nbody' })])
    acc.feedLines([toolUse('Edit', { file_path: PLAN_FILE, old_string: 'body', new_string: 'better body' })])
    expect(acc.state.planMode).toMatchObject({ state: 'proposed', title: 'First title', file: PLAN_FILE })
  })

  it('a write to any other path, or with no attachment, proposes nothing', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([toolUse('Write', { file_path: PLAN_FILE, content: '# Not in plan mode' })])
    expect(acc.state.planMode).toBeUndefined()
    acc.feedLines([planAttachment(), toolUse('Write', { file_path: '/work/notes.md', content: '# Notes' })])
    expect(acc.state.planMode).toBeUndefined()
  })

  it('ExitPlanMode wins: it waits on its result, and a later write of the file does not reopen it', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([planAttachment(), toolUse('Write', { file_path: PLAN_FILE, content: '# Draft' })])
    acc.feedLines([toolUse('ExitPlanMode', { plan: '# The plan\nsteps', planFilePath: PLAN_FILE }, 'toolu_exit')])
    expect(acc.state.planMode).toMatchObject({ state: 'proposed', title: 'The plan', toolUseId: 'toolu_exit' })
    acc.feedLines([
      toolResult('toolu_exit', 'User has approved your plan. You can now start coding.', { toolUseResult: { plan: '# The plan', filePath: PLAN_FILE } }),
    ])
    expect(acc.state.planMode?.state).toBe('approved')
    acc.feedLines([toolUse('Edit', { file_path: PLAN_FILE, old_string: 'steps', new_string: 'steps done' })])
    expect(acc.state.planMode?.state).toBe('approved')
    // a NEW plan_mode attachment is a new round: its write proposes again
    acc.feedLines([planAttachment(), toolUse('Write', { file_path: PLAN_FILE, content: '# Round two' })])
    expect(acc.state.planMode).toMatchObject({ state: 'proposed', title: 'Round two' })
    expect(acc.state.planMode && 'toolUseId' in acc.state.planMode).toBe(false)
  })
})
