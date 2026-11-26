// console-handover.test.ts — one engine process per session: a chat turn on
// a session whose console is live closes that console first (OpenCode and,
// since 31-10, Claude Code); a session with no console is left alone, and a
// console mid-turn is never closed (consoleBusyFor → the route's 409).
import { describe, expect, it, vi } from 'vitest'
import { consoleBusyFor, handOverConsoleForChat } from '../src/console-handover.js'

function terminals(over: { bound?: Record<string, string>; consoles?: string[] } = {}) {
  const killed: string[] = []
  return {
    killed,
    keyOfNativeId: (id: string) => over.bound?.[id] ?? null,
    hasConsole: (key: string) => over.consoles?.includes(key) ?? false,
    killConsoleAndWait: vi.fn(async (key: string) => {
      killed.push(key)
    }),
  }
}

describe('handOverConsoleForChat', () => {
  it('closes the console bound to the OpenCode session (by native id, or keyed by the id itself) and names it', async () => {
    const t1 = terminals({ bound: { ses_a: 'born-key' } })
    const log: string[] = []
    expect(await handOverConsoleForChat(t1, 'ses_a', (l) => log.push(l))).toBe('born-key')
    expect(t1.killed).toEqual(['born-key'])
    expect(log[0]).toContain('born-key closed: the chat engine takes session ses_a')
    const t2 = terminals({ consoles: ['ses_b'] })
    expect(await handOverConsoleForChat(t2, 'ses_b', () => undefined)).toBe('ses_b')
  })

  it('hands a Claude session over too; leaves a session with no console and a missing terminal service alone', async () => {
    const claude = '11111111-2222-4333-8444-555555555555'
    const t = terminals({ bound: { [claude]: 'k' } })
    expect(await handOverConsoleForChat(t, claude, () => undefined)).toBe('k')
    expect(await handOverConsoleForChat(t, 'ses_none', () => undefined)).toBeNull()
    expect(t.killed).toEqual(['k'])
    expect(await handOverConsoleForChat(undefined, 'ses_a', () => undefined)).toBeNull()
  })

  it('a live console mid-turn is busy (the chat turn must wait); idle, or no console, is not', async () => {
    const t = terminals({ bound: { ses_a: 'k' } })
    expect(await consoleBusyFor(t, 'ses_a', true)).toBe(true)
    expect(await consoleBusyFor(t, 'ses_a', false)).toBe(false)
    expect(await consoleBusyFor(t, 'ses_a', undefined)).toBe(false)
    expect(await consoleBusyFor(t, 'ses_none', true)).toBe(false)
    expect(await consoleBusyFor(undefined, 'ses_a', true)).toBe(false)
  })

  // The staleness rule: an open turn is work only if the transcript moved
  // since the console was created. A turn left open by a dead claude (every
  // adopted pre-Silos conversation that was killed mid-turn) must not
  // refuse chat forever over a fresh `--resume` console sitting idle.
  it('an open turn older than the console is stale, not busy; one that moved since is busy; no creation time stays busy', async () => {
    const consoleBorn = 1_000_000
    const withCreated = (createdMs: number | null) => ({
      ...terminals({ bound: { ses_a: 'k' } }),
      consoleCreatedMs: async (_key: string) => createdMs,
    })
    // the transcript last moved BEFORE this console existed: nothing runs in it
    expect(await consoleBusyFor(withCreated(consoleBorn), 'ses_a', true, consoleBorn - 60_000)).toBe(false)
    // records landed after the console's birth: its claude is working
    expect(await consoleBusyFor(withCreated(consoleBorn), 'ses_a', true, consoleBorn + 60_000)).toBe(true)
    // tmux could not say when, or the caller has no activity stamp: conservative
    expect(await consoleBusyFor(withCreated(null), 'ses_a', true, consoleBorn - 60_000)).toBe(true)
    expect(await consoleBusyFor(withCreated(consoleBorn), 'ses_a', true, undefined)).toBe(true)
    // a terminals without the probe (older embedders): conservative too
    expect(await consoleBusyFor(terminals({ bound: { ses_a: 'k' } }), 'ses_a', true, consoleBorn - 60_000)).toBe(true)
    // a closed turn never asks the console's age
    expect(await consoleBusyFor(withCreated(consoleBorn), 'ses_a', false, consoleBorn + 60_000)).toBe(false)
  })
})
