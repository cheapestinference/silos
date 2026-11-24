import { describe, expect, it } from 'vitest'
import { resolveEffective, fieldOrigin } from '../src/lib/cockpit'

// provider: the fifth cascade field — which Claude account or key a
// conversation (or one turn) runs on. Agent level = agent.provider.
describe('resolveEffective — provider', () => {
  it('turn > conversation > agent; absent when nobody opines', () => {
    expect(resolveEffective(undefined, {}, {}).provider).toBeUndefined()
    expect(resolveEffective(undefined, {}, {}, 'account:a').provider).toBe('account:a')
    expect(resolveEffective(undefined, { provider: 'ci' }, {}, 'account:a').provider).toBe('ci')
    expect(resolveEffective(undefined, { provider: 'ci' }, { provider: 'default' }, 'account:a').provider).toBe('default')
  })

  it("field by field: a turn that only sets effort inherits the conversation's provider", () => {
    const r = resolveEffective('sonnet', { provider: 'ci' }, { effort: 'low' })
    expect(r).toMatchObject({ model: 'sonnet', effort: 'low', provider: 'ci' })
  })

  it('fieldOrigin names the level the provider comes from', () => {
    expect(fieldOrigin('provider', { provider: 'ci' }, {})).toBe('conversation')
    expect(fieldOrigin('provider', { provider: 'ci' }, { provider: 'default' })).toBe('turn')
    expect(fieldOrigin('provider', {}, {})).toBe('agent')
  })
})
