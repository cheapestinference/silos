import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { TerminalService } from '../src/terminal-service.js'

// Rule 2 (28-08 incident): never spawn a `claude --resume` of a
// conversation while the previous claude of that conversation is still
// alive. Two mechanisms, both tested here without a real tmux/claude:
//  - killConsoleAndWait waits for the pane's processes for a LONG grace
//    (claude takes ~20 s to exit; the old 3 s cap let the twin be born);
//  - ensureConsole refuses to resume a session another live claude holds
//    (its lock file in ~/.claude/sessions/<pid>.json, pid alive).
describe('console resume guard', () => {
  let terminals: TerminalService
  afterEach(async () => {
    terminals?.stopReaper()
  })

  const setup = async (isAlive: (pid: number) => boolean): Promise<{ folder: string; sessionsDir: string }> => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    mkdirSync(join(base, 'projects'), { recursive: true })
    const index = claudeSessionIndex(join(base, 'projects'), join(base, 'cache.json'))
    await index.init()
    const sessionsDir = join(base, 'claude-sessions')
    mkdirSync(sessionsDir)
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: join(base, 'tmux.sock'),
      sessionsDir,
      isAlive,
      appendDir: join(base, 'append'),
    })
    return { folder, sessionsDir }
  }

  // counted, not timed: how many times the guard asked whether the pane's
  // claude was still alive before it let the resume go on
  it('killConsoleAndWait outlives a slow claude: keeps polling while the pane pid is alive, returns once it is gone', async () => {
    let checks = 0
    await setup((pid) => pid === 4242 && ++checks <= 5) // alive for 5 checks, then gone
    ;(terminals as unknown as { consolePids: (k: string) => number[] }).consolePids = () => [4242]
    await terminals.killConsoleAndWait('k')
    expect(checks).toBe(6) // waited through every live answer, stopped at the first dead one
  })

  it('killConsoleAndWait gives up at the cap, never forever', async () => {
    let checks = 0
    await setup(() => {
      checks++
      return true
    }) // immortal
    ;(terminals as unknown as { consolePids: (k: string) => number[] }).consolePids = () => [4242]
    await terminals.killConsoleAndWait('k', 150) // returning at all is the cap
    expect(checks).toBeGreaterThanOrEqual(2) // it kept polling until the cap, not one look
  })

  it('ensureConsole refuses to resume a session a LIVE claude still holds (lock file, pid alive)', async () => {
    const { folder, sessionsDir } = await setup((pid) => pid === 777)
    writeFileSync(join(sessionsDir, '777.json'), JSON.stringify({ pid: 777, sessionId: 'abc', cwd: folder }))
    await expect(terminals.ensureConsole({ cwd: folder, key: 'abc', resumeId: 'abc' })).rejects.toThrow(/still running|still shutting down/)
  })

  it('a stale lock (pid dead) does not block — the resume proceeds to spawn', async () => {
    const { folder, sessionsDir } = await setup(() => false)
    writeFileSync(join(sessionsDir, '777.json'), JSON.stringify({ pid: 777, sessionId: 'abc', cwd: folder }))
    // no real tmux in this test: the spawn itself fails, but PAST the guard
    const err = await terminals.ensureConsole({ cwd: folder, key: 'abc', resumeId: 'abc' }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.message ?? '').not.toMatch(/still running|still shutting down/)
  })

  it('holdersOf reads only live pids for that session id', async () => {
    const { sessionsDir } = await setup((pid) => pid === 1)
    writeFileSync(join(sessionsDir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'abc' }))
    writeFileSync(join(sessionsDir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'abc' }))
    writeFileSync(join(sessionsDir, '3.json'), JSON.stringify({ pid: 3, sessionId: 'other' }))
    writeFileSync(join(sessionsDir, 'junk.json'), 'not json')
    expect(terminals.holdersOf('abc')).toEqual([1])
  })
})
