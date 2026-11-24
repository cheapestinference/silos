// The ONE split rule of the mission textarea
// — the same code in the create dialog and in the mission editor — and the
// first sentence every surface says (the server's firstSentence twin).
import { describe, expect, it } from 'vitest'
import { firstSentence, missionFromFields, missionLine, missionProblem, splitMission } from '../src/lib/mission'

describe('splitMission', () => {
  it('lines STARTING with «Never:» (trimmed, any case) are the rules, without the prefix; the rest, in order, is the text', () => {
    expect(splitMission('Taxes and accounts.\n  never: file anything\nKeep receipts.\nNEVER:pay anything')).toEqual({
      text: 'Taxes and accounts.\nKeep receipts.',
      never: ['file anything', 'pay anything'],
    })
  })
  it('a «Never:» mid-sentence cuts nothing; an empty «Never:» line is dropped', () => {
    expect(splitMission('Books. Never: mid-line stays\nNever:   ')).toEqual({ text: 'Books. Never: mid-line stays', never: [] })
  })
  it("only «Never» lines leave no text — the inline problem, in the field's own words", () => {
    const m = splitMission('Never: pay anything')
    expect(m).toEqual({ text: '', never: ['pay anything'] })
    expect(missionProblem(m, 'Ana')).not.toBeNull()
    expect(missionProblem(splitMission(''), 'Ana')).toBeNull()
    expect(missionProblem({ text: 'x'.repeat(2001), never: [] }, 'Ana')).toMatch(/under 2000/)
    expect(missionProblem({ text: 'ok', never: Array.from({ length: 11 }, () => 'n') }, 'Ana')).toMatch(/Up to 10/)
    expect(missionProblem({ text: 'ok', never: ['y'.repeat(201)] }, 'Ana')).toMatch(/200 characters/)
  })
  it("the editor's two fields: a Never line typed in the text moves to the rules, before the rules field's own lines", () => {
    expect(missionFromFields('Books.\nnever: sign', 'pay\n\nNever: hire')).toEqual({ text: 'Books.', never: ['sign', 'pay', 'hire'] })
  })
})

describe('firstSentence / missionLine', () => {
  it('says the first sentence, whitespace collapsed; the whole text without a sentence end', () => {
    expect(firstSentence('  Keep  the VPS\nalive. Deploys too!')).toBe('Keep the VPS alive.')
    expect(firstSentence('Who pays? Then the rest.')).toBe('Who pays?')
    expect(firstSentence('Answers the inbox')).toBe('Answers the inbox')
    expect(missionLine({ mission: { text: 'One. Two.', never: [], updatedAt: '' } })).toBe('One.')
    expect(missionLine({})).toBe('')
    expect(missionLine(undefined)).toBe('')
  })
})
