import { describe, expect, it } from 'vitest'
import { promptGist } from '../src/lib/automations'

// the one line that says what an automation DOES — the prompt's first
// sentence, literal, trimmed to a measure. Nothing clever: no rewriting,
// no stripping of preambles.
describe('promptGist', () => {
  it('returns the first sentence when it fits', () => {
    expect(promptGist('Check the Stripe disputes. Then report any you find.')).toBe('Check the Stripe disputes.')
  })
  it('collapses whitespace and newlines', () => {
    expect(promptGist('Short   summary\n\nof the day.')).toBe('Short summary of the day.')
  })
  it('cuts a long first sentence at a word boundary with an ellipsis', () => {
    const long = 'Run the daily cost journal following the method described in the context file and the automatic readings of every provider with their limits'
    const g = promptGist(long, 60)
    expect(g.length).toBeLessThanOrEqual(61)
    expect(g.endsWith('…')).toBe(true)
    expect(g).not.toMatch(/\s…$/)
  })
  it('does not split on dots inside numbers or versions', () => {
    expect(promptGist('Retire the alias glm-5.2 → glm-5.3 on 30-09. Then report.')).toBe('Retire the alias glm-5.2 → glm-5.3 on 30-09.')
  })
  it('is empty for an empty prompt', () => {
    expect(promptGist('   ')).toBe('')
  })
})
