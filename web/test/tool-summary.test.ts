import { describe, expect, it } from 'vitest'
import { summarizeTools } from '../src/lib/tool-summary'

describe('summarizeTools', () => {
  it('counts by label, most frequent first, singletons without a number', () => {
    expect(summarizeTools(['Read', 'Edit', 'Read', 'Bash', 'Read'])).toBe('Read 3 · Edit · Bash')
  })

  it('keeps first-appearance order on ties', () => {
    expect(summarizeTools(['Grep', 'Read', 'Read', 'Grep'])).toBe('Grep 2 · Read 2')
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
    expect(summarizeTools(['A', 'A', 'B', 'C', 'D', 'E', 'F', 'F'])).toBe('A 2 · F 2 · B · C · +2 more')
  })
})
