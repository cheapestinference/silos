// console-sleep.test.ts — the auto-sleep decision: a live
// claude costs ~300 MB of RAM and is disposable (--resume revives it from
// the JSONL, which is the real memory); the transcript is cheap and
// irreplaceable. So consoles SLEEP — killed cleanly — once nobody is
// attached AND the conversation itself has been still for the window.
// The liveness signal is the JSONL mtime (the filesystem is the truth,
// and index mtime folds subagent activity while a turn is open), so a
// console mid-turn — even detached — can never be put to sleep.
import { describe, expect, it } from 'vitest'
import { shouldSleepConsole } from '../src/terminal-service.js'

const H = 60 * 60_000
const SLEEP = 24 * H
const NOW = 1_700_000_000_000

describe('shouldSleepConsole', () => {
  it('never sleeps a console with a client attached, however still', () => {
    expect(shouldSleepConsole({ attached: 1, lastAliveMs: NOW - 100 * H, now: NOW, sleepMs: SLEEP })).toBe(false)
  })

  it('never sleeps a console whose conversation moved inside the window', () => {
    expect(shouldSleepConsole({ attached: 0, lastAliveMs: NOW - 2 * H, now: NOW, sleepMs: SLEEP })).toBe(false)
  })

  it('sleeps a detached console once the conversation has been still for the window', () => {
    expect(shouldSleepConsole({ attached: 0, lastAliveMs: NOW - 25 * H, now: NOW, sleepMs: SLEEP })).toBe(true)
  })

  it('an unknown last-alive (no transcript yet, no tmux stamp) is never slept — when in doubt, keep it', () => {
    expect(shouldSleepConsole({ attached: 0, lastAliveMs: null, now: NOW, sleepMs: SLEEP })).toBe(false)
  })

  it('a sleepMs of 0 disables the sweep entirely', () => {
    expect(shouldSleepConsole({ attached: 0, lastAliveMs: NOW - 100 * H, now: NOW, sleepMs: 0 })).toBe(false)
  })
})

// Without this the same console slept three times while its claude kept
// working: after a /clear the console's claude writes to the
// chain's LATEST session, never to the key again — the sweep must time the
// thread, not the key.
describe('sweepSleepingConsoles — times the console by its thread', () => {
  it('a key whose own transcript is old is NOT slept while its thread is active; it is when the thread is still', async () => {
    const { vi } = await import('vitest')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { TerminalService } = await import('../src/terminal-service.js')
    const now = Date.now()
    const index = { allSessions: () => [{ id: 'key', folder: 'f', mtime: now - 40 * H }] }
    let threadActivity: number | null = now - 1 * H
    const base = mkdtempSync(join(tmpdir(), 'sleep-'))
    const t = new TerminalService({} as never, index as never, undefined, undefined, {
      tmuxSocket: `silos-sleep-${process.pid}`,
      appendDir: join(base, 'a'),
      envDir: join(base, 'e'),
      sessionsDir: join(base, 's'),
      lastActivityOf: () => threadActivity,
    })
    try {
      vi.spyOn(t, 'listConsoles').mockReturnValue([{ key: 'key', attached: 0, createdMs: null }])
      const kill = vi.spyOn(t as unknown as { killConsoleAndWait: (k: string) => Promise<void> }, 'killConsoleAndWait').mockResolvedValue()
      await t.sweepSleepingConsoles()
      expect(kill).not.toHaveBeenCalled()
      threadActivity = now - 30 * H
      await t.sweepSleepingConsoles()
      expect(kill).toHaveBeenCalledWith('key')
    } finally {
      t.stopReaper()
    }
  })
})

// event layer, Task 13: an OpenCode console is keyed by a Silos UUID until
// the registrar seals the session OpenCode minted (bindNativeId). The index
// knows the ses_ session, never the key — timing by the key slept an
// active OpenCode console 24 h after it was created.
describe('sweepSleepingConsoles — an OpenCode console is timed by its bound session', () => {
  async function make(sessions: { id: string; mtime: number }[], lastActivityOf?: (key: string) => number | null) {
    const { vi } = await import('vitest')
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { TerminalService } = await import('../src/terminal-service.js')
    const index = { allSessions: () => sessions.map((s) => ({ ...s, folder: 'f' })) }
    const base = mkdtempSync(join(tmpdir(), 'sleep-oc-'))
    const consolesDir = join(base, 'consoles')
    const t = new TerminalService({} as never, index as never, undefined, undefined, {
      tmuxSocket: `silos-sleep-oc-${process.pid}`,
      appendDir: join(base, 'a'),
      envDir: join(base, 'e'),
      sessionsDir: join(base, 's'),
      consolesDir,
      ...(lastActivityOf ? { lastActivityOf } : {}),
    })
    const record = (key: string, createdMs: number): void => {
      mkdirSync(consolesDir, { recursive: true })
      writeFileSync(join(consolesDir, `${key}.json`), JSON.stringify({ key, agentId: 'oc', harness: 'opencode', createdMs, port: 1, serverPassword: 'p' }))
    }
    const kill = vi.spyOn(t as unknown as { killConsoleAndWait: (k: string) => Promise<void> }, 'killConsoleAndWait').mockResolvedValue()
    const list = (rows: { key: string; attached: number; createdMs: number | null }[]) => vi.spyOn(t, 'listConsoles').mockReturnValue(rows)
    return { t, kill, list, record }
  }

  it('sealed: an old console whose ses_ session moved an hour ago is kept; slept once the session is still for the window', async () => {
    const now = Date.now()
    const sessions = [{ id: 'ses_oc', mtime: now - 1 * H }]
    const { t, kill, list } = await make(sessions)
    try {
      list([{ key: 'uuid-k', attached: 0, createdMs: now - 40 * H }])
      t.bindNativeId('uuid-k', 'ses_oc')
      await t.sweepSleepingConsoles()
      expect(kill).not.toHaveBeenCalled()
      sessions[0]!.mtime = now - 30 * H
      await t.sweepSleepingConsoles()
      expect(kill).toHaveBeenCalledWith('uuid-k')
    } finally {
      t.stopReaper()
    }
  })

  it('sealed: the thread-activity hook is asked about the bound session, not the key', async () => {
    const now = Date.now()
    const asked: string[] = []
    const { t, kill, list } = await make([], (k) => {
      asked.push(k)
      return k === 'ses_oc' ? now - 1 * H : null
    })
    try {
      list([{ key: 'uuid-k', attached: 0, createdMs: now - 40 * H }])
      t.bindNativeId('uuid-k', 'ses_oc')
      await t.sweepSleepingConsoles()
      expect(asked).toEqual(['ses_oc'])
      expect(kill).not.toHaveBeenCalled()
    } finally {
      t.stopReaper()
    }
  })

  it("unsealed: younger than the window is never slept — tmux stamp or, without one, the console record's createdMs", async () => {
    const now = Date.now()
    const { t, kill, list, record } = await make([])
    try {
      record('young', now - 2 * H)
      list([
        { key: 'young', attached: 0, createdMs: null },
        { key: 'young2', attached: 0, createdMs: now - 3 * H },
      ])
      await t.sweepSleepingConsoles()
      expect(kill).not.toHaveBeenCalled()
      record('old', now - 30 * H)
      list([{ key: 'old', attached: 0, createdMs: null }])
      await t.sweepSleepingConsoles()
      expect(kill).toHaveBeenCalledWith('old')
    } finally {
      t.stopReaper()
    }
  })
})
