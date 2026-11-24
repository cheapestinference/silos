import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TranscriptAccumulator } from '../src/harnesses/claude-code/parser.js'
import { ContextAccumulator } from '../src/harnesses/claude-code/context.js'

// c6 — plan mode, from a REAL transcript (CLI 2.1.316, 02-11): EnterPlanMode,
// the plan_mode attachment, permission-mode "plan", ExitPlanMode whose
// tool_use input the CLI fills with { plan, planFilePath } (the wire input
// is {} — see the api-request-blob line), the approval result whose
// toolUseResult is { plan, isAgent, filePath }, plan_mode_exit. Only the
// plan's text and the paths were shortened/redacted.
const lines = readFileSync(new URL('./fixtures/plan-mode.jsonl', import.meta.url), 'utf8').split('\n')

const PLAN_START = '# Add a dark mode toggle'

describe('plan mode — the transcript', () => {
  it('the ExitPlanMode tool use carries the whole plan, approved', () => {
    const turns = new TranscriptAccumulator().feedLines(lines)
    const uses = turns.flatMap((t) => t.toolUses ?? []).filter((u) => u.name === 'ExitPlanMode')
    expect(uses).toHaveLength(1) // the api-request-blob duplicate is not a second turn
    expect(uses[0]!.plan).toEqual({
      text: expect.stringContaining(PLAN_START),
      state: 'approved',
      file: '/home/user/.claude/plans/dreamy-stirring-owl.md',
    })
    // the raw input no longer repeats the plan (it rides `plan`)
    expect(uses[0]!.input).not.toContain('dark mode')
  })

  it('proposed until its result lands', () => {
    const cut = lines.findIndex((l) => l.includes('User has approved your plan'))
    const turns = new TranscriptAccumulator().feedLines(lines.slice(0, cut))
    const use = turns.flatMap((t) => t.toolUses ?? []).find((u) => u.name === 'ExitPlanMode')
    expect(use?.plan?.state).toBe('proposed')
  })

  it('any other answer is "not approved" — never guessed as rejected', () => {
    const swapped = lines.map((l) => {
      if (!l.includes('User has approved your plan')) return l
      const e = JSON.parse(l)
      e.message.content[0].content = "The user doesn't want to proceed with this tool use. Keep planning: use a CSS variable"
      e.message.content[0].is_error = true
      delete e.toolUseResult
      return JSON.stringify(e)
    })
    const use = new TranscriptAccumulator()
      .feedLines(swapped)
      .flatMap((t) => t.toolUses ?? [])
      .find((u) => u.name === 'ExitPlanMode')
    expect(use?.plan?.state).toBe('not_approved')
  })
})

describe('plan mode — the context', () => {
  it('the latest plan, approved, with its title and time', () => {
    const acc = new ContextAccumulator()
    acc.feedLines(lines)
    expect(acc.state.planMode).toEqual({
      state: 'approved',
      title: 'Add a dark mode toggle',
      at: expect.stringMatching(/^2026-11-02T/),
      file: '/home/user/.claude/plans/dreamy-stirring-owl.md',
    })
    expect(acc.hasPendingAsk).toBe(false)
  })

  it('a proposed plan waits on the owner like an open question, and survives the cache', () => {
    const cut = lines.findIndex((l) => l.includes('User has approved your plan'))
    const acc = new ContextAccumulator()
    acc.feedLines(lines.slice(0, cut))
    expect(acc.state.planMode?.state).toBe('proposed')
    expect(acc.hasPendingAsk).toBe(true)
    const again = new ContextAccumulator(acc.state)
    expect(again.hasPendingAsk).toBe(true)
    again.feedLines(lines.slice(cut))
    expect(again.state.planMode?.state).toBe('approved')
    expect(again.hasPendingAsk).toBe(false)
  })

  it('no plan mode, no field', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([lines[0]!])
    expect(acc.state.planMode).toBeUndefined()
  })
})
