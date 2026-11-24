import { describe, it, expect } from 'vitest'
import { isUnread } from '../src/unread.js'

// Durable unread state: the rule is a pure function over real data
// (mtime + role of the last turn + lastSeen). These tests pin down the
// exact semantics described in the spec.
describe('isUnread', () => {
  it('never seen + last turn from the agent = unread', () => {
    expect(isUnread('assistant', 1000, null)).toBe(true)
  })

  it("last turn from the owner (user) = NOT unread (it is the agent's turn)", () => {
    expect(isUnread('user', 1000, null)).toBe(false)
    expect(isUnread('user', 5000, 1000)).toBe(false)
  })

  it('no conversational turn at all (lastRole null/undefined) = NOT unread', () => {
    expect(isUnread(null, 1000, null)).toBe(false)
    expect(isUnread(undefined, 1000, null)).toBe(false)
  })

  it('seen AFTER the last mtime (lastSeen >= mtime) = up to date', () => {
    expect(isUnread('assistant', 1000, 1000)).toBe(false) // seen right then
    expect(isUnread('assistant', 1000, 2000)).toBe(false) // seen after
  })

  it('new agent activity AFTER it was seen (mtime > lastSeen) = unread again', () => {
    expect(isUnread('assistant', 3000, 1000)).toBe(true)
  })
})
