// The hook (plugin/hooks/compose.py) and the server (briefingText) compose
// the SAME bytes for the same skills — one briefing, whichever engine or
// launch path. Every subset of the fragment names, plus
// names that are not fragments and an empty --has.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BRIEFING_FRAGMENTS, briefingText } from '../src/harnesses/briefing.js'

const COMPOSE = fileURLToPath(new URL('../../plugin/hooks/compose.py', import.meta.url))
const compose = (has: string[]): string =>
  execFileSync('python3', [COMPOSE, '--has', has.join(',')], { env: { PATH: process.env.PATH ?? '' } }).toString('utf8')

const subsets: string[][] = []
for (let mask = 0; mask < 1 << BRIEFING_FRAGMENTS.length; mask++) {
  subsets.push(BRIEFING_FRAGMENTS.filter((_, i) => mask & (1 << i)))
}
subsets.push(['team-plan', 'not-a-fragment', 'support-inbox'])

describe('compose.py ≡ briefingText', () => {
  for (const has of subsets) {
    it(`--has ${has.join(',') || '(none)'}`, () => {
      expect(compose(has)).toBe(briefingText(has))
    })
  }
  it('--has= form and a missing --has read like the flag', () => {
    expect(execFileSync('python3', [COMPOSE, '--has=responsibility']).toString('utf8')).toBe(briefingText(['responsibility']))
    expect(execFileSync('python3', [COMPOSE]).toString('utf8')).toBe(briefingText([]))
  })
})
