// notices.test.ts — classification of system notices. The text in these
// tests is LITERALLY copied from the real corpus (~/.claude/projects) —
// never invented shapes.
import { describe, expect, it } from 'vitest'
import { classifyNotice } from '../src/lib/notices'

describe('classifyNotice', () => {
  it('a session rate limit → amber, tag "limit", with the reset highlighted separately', () => {
    const a = classifyNotice("You've hit your session limit · resets 10:20pm (Europe/Berlin)")
    expect(a.severity).toBe('amber')
    expect(a.label).toBe('limit')
    expect(a.body).toBe("You've hit your session limit")
    expect(a.resets).toBe('resets 10:20pm (Europe/Berlin)')
  })

  it('a rate limit with no reset part → amber with no `resets`', () => {
    const a = classifyNotice("You've hit your session limit")
    expect(a.severity).toBe('amber')
    expect(a.resets).toBeUndefined()
  })

  it('a model limit ("You\'ve reached your … limit. Run /usage-credits…") → amber', () => {
    const a = classifyNotice("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.")
    expect(a.severity).toBe('amber')
    expect(a.label).toBe('limit')
  })

  it('"API Error: 529 Overloaded…" → red, tag "api error"', () => {
    const a = classifyNotice(
      'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
    )
    expect(a.severity).toBe('red')
    expect(a.label).toBe('api error')
  })

  it('"Prompt is too long" → red', () => {
    expect(classifyNotice('Prompt is too long').severity).toBe('red')
  })

  it('a subscription disabled by the organization → amber, tag "account"', () => {
    const a = classifyNotice(
      'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
    )
    expect(a.severity).toBe('amber')
    expect(a.label).toBe('account')
  })

  it('an unknown synthetic text → a generic neutral, never an invented severity', () => {
    const a = classifyNotice('No response requested.')
    expect(a.severity).toBe('neutral')
    expect(a.label).toBe('system')
    expect(a.body).toBe('No response requested.')
  })
})
