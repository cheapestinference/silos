import { describe, expect, it } from 'vitest'
import { summarizeTools } from '../src/lib/tool-summary'
import { groupToolRuns } from '../src/components/ToolChip'

describe('summarizeTools', () => {
  it('counts by label, most frequent first, singletons without a number', () => {
    expect(summarizeTools(['Read', 'Edit', 'Read', 'Bash', 'Read'])).toBe('Read ×3 · Edit · Bash')
  })

  it('keeps first-appearance order on ties', () => {
    expect(summarizeTools(['Grep', 'Read', 'Read', 'Grep'])).toBe('Grep ×2 · Read ×2')
  })

  it('uses the chip label: skills by name, SendMessage by destination', () => {
    const s = summarizeTools([
      { name: 'Skill', skill: 'frontend-design', input: '{}', result: null },
      { name: 'SendMessage', skill: null, input: '{"to":"builder"}', result: null },
      'skill:brainstorming',
    ])
    for (const part of ['frontend-design', 'builder', 'brainstorming']) expect(s).toContain(part)
    expect(s).not.toContain('Skill')
    expect(s).not.toContain('SendMessage')
  })

  it('folds everything past four names into "+N more"', () => {
    expect(summarizeTools(['A', 'A', 'B', 'C', 'D', 'E', 'F', 'F'])).toBe('A ×2 · F ×2 · B · C · +2 more')
  })
})

describe('groupToolRuns', () => {
  it('folds only consecutive calls with the same label, keeping every call', () => {
    const runs = groupToolRuns(['Bash', 'Bash', 'Bash', 'Read', 'Bash'])
    expect(runs.map((r) => [r.label, r.items.length])).toEqual([
      ['Bash', 3],
      ['Read', 1],
      ['Bash', 1],
    ])
  })

  it('groups by the chip label: two skills are not one run, two MCP calls of one tool are', () => {
    const a = { name: 'Skill', skill: 'a', input: '{}', result: null }
    const b = { name: 'Skill', skill: 'b', input: '{}', result: null }
    expect(groupToolRuns([a, b]).length).toBe(2)
    const m = { name: 'mcp__claude_ai_Gmail__search', skill: null, input: '{}', result: null }
    const runs = groupToolRuns([m, { ...m, isError: true }])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.items[1]).toMatchObject({ isError: true })
  })
})
