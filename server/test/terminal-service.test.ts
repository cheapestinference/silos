import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { TerminalService, parseScrollInfo } from '../src/terminal-service.js'
import { defaultConsoleCommand, rotationHookCommand, contextNewsHookCommand } from '../src/harnesses/claude-code/console.js'

let registry: AgentRegistry, index: SessionIndex, terminals: TerminalService, folder: string
const IDLE = 30 * 60_000,
  REAP = 60_000

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
  registry = new AgentRegistry(join(base, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder })
  const root = join(base, 'projects')
  mkdirSync(root, { recursive: true })
  index = claudeSessionIndex(root, join(base, 'cache.json'))
  await index.init()
  terminals = new TerminalService(registry, index)
})

afterEach(async () => {
  terminals.killAll()
  terminals.stopReaper()
})

// waits until `out.value` contains `needle`, with a timeout — avoids fixed
// sleeps against a real PTY (bash's echo isn't instantaneous).
async function waitFor(out: { value: string }, needle: string, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!out.value.includes(needle)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for "${needle}" — output so far: ${JSON.stringify(out.value)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

// resolves once `out.value` has stopped growing for `idleMs`.
async function waitForCond(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for the condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function quiet(out: { value: string }, idleMs = 800, maxMs = 5000): Promise<void> {
  const t0 = Date.now()
  let last = out.value.length,
    since = Date.now()
  while (Date.now() - since < idleMs) {
    if (Date.now() - t0 > maxMs) return
    await new Promise((r) => setTimeout(r, 50))
    if (out.value.length !== last) {
      last = out.value.length
      since = Date.now()
    }
  }
}

describe('TerminalService', () => {
  it("creates a real PTY in the agent's folder, writes and reads the echo", async () => {
    const { id, cwd, agentId } = terminals.create({ agentId: 'writer' })
    expect(agentId).toBe('writer')
    expect(cwd).toBe(realpathSync(folder))

    const out = { value: '' }
    const off = terminals.onData(id, (d) => {
      out.value += d
    })
    terminals.write(id, 'echo hi\n')
    await waitFor(out, 'hi')
    off()
  })

  it("a disallowed cwd (neither the agent's folder nor a known session cwd) -> error", async () => {
    expect(() => terminals.create({ cwd: '/etc' })).toThrow('cwd not allowed')
  })

  it('a nonexistent or archived agent -> error', async () => {
    expect(() => terminals.create({ agentId: 'nobody' })).toThrow('agent not available')
  })

  it('a limit of 4 simultaneous PTYs', async () => {
    const ids = Array.from({ length: 4 }, () => terminals.create({ agentId: 'writer' }).id)
    expect(() => terminals.create({ agentId: 'writer' })).toThrow('limit')
    for (const id of ids) terminals.kill(id)
  })

  it('kill cleans up the PTY — later writes fail', async () => {
    const { id } = terminals.create({ agentId: 'writer' })
    expect(terminals.list()).toHaveLength(1)
    terminals.kill(id)
    expect(terminals.list()).toHaveLength(0)
    expect(() => terminals.write(id, 'x')).toThrow('not found')
  })

  // kill() (via DELETE, via the reaper, or because the PTY exited on its
  // own) must emit 'killed' — that's what server.ts uses to close any WS
  // still attached to that id.
  it('kill() emits "killed" with the id — so server.ts can close any attached WS', async () => {
    const { id } = terminals.create({ agentId: 'writer' })
    const seen: string[] = []
    terminals.on('killed', (killedId: string) => seen.push(killedId))
    terminals.kill(id)
    expect(seen).toEqual([id])
    terminals.kill(id) // second time: already gone, must not emit again
    expect(seen).toEqual([id])
  })

  // the reaper is a SINGLE periodic sweep (created in the service's
  // constructor), not a per-PTY timer — previously, a PTY with no attached
  // WS client depended on detach() rearming a setTimeout that only fired if
  // the WS's 'close' event arrived; with a "half-open" remote client that
  // 'close' could simply never arrive. The sweep depends on no event: it
  // checks clients===0 && an expired idleSince on every pass.
  it('the reaper kills a PTY with clients=0 after idleMs, with nobody calling kill()', async () => {
    const svc = new TerminalService(registry, index, 30, 10) // idleMs=30ms, sweep every 10ms — only for this test
    svc.create({ agentId: 'writer' })
    expect(svc.list()).toHaveLength(1)

    await waitForCond(() => svc.list().length === 0) // the reaper killed it with no explicit kill()/detach()

    svc.stopReaper()
  })

  it('the reaper does NOT kill a PTY with at least one attached client (attach without detach)', async () => {
    const svc = new TerminalService(registry, index, 30, 10)
    const { id } = svc.create({ agentId: 'writer' })
    expect(svc.attach(id)).toBe(true)

    await new Promise((r) => setTimeout(r, 200))
    expect(svc.list()).toHaveLength(1) // still alive — there's an "attached" client

    svc.stopReaper()
    svc.killAll()
  })
})

// The real console: ONE tmux session per conversation, ONE tmux client per
// socket. Driven against a real tmux on a throwaway socket with a stand-in
// for `claude` (a bash that paints a marker and stays alive). Born from the
// owner's symptoms with the earlier shared-PTY spike: a blank reload
// (the bytes before the WS attached were lost), a foreign size left by the
// phone, and no scroll.
describe('TerminalService — real console', () => {
  const socket = `silos-test-${process.pid}`
  const key = `test-${randomUUID()}`
  let svc: TerminalService

  beforeEach(async () => {
    svc = new TerminalService(registry, index, IDLE, REAP, {
      tmuxSocket: socket,
      command: () => ['bash', '-c', 'printf "SCREEN-MARK\\n"; sleep 60'],
    })
  })
  afterEach(async () => {
    await svc.killConsole(key)
    svc.killAll()
    svc.stopReaper()
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    } catch {
      /* no server */
    }
    // kill-server leaves the socket FILE behind in /tmp/tmux-$UID — 160 of
    // them had piled up. Removing it after the kill keeps /tmp clean.
    try {
      rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
    } catch {
      /* best effort */
    }
  })

  function hasSession(): boolean {
    try {
      execFileSync('tmux', ['-L', socket, 'has-session', '-t', `=silos-${key}`], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  it("consoleState: tmux saying «no such session» is gone; tmux that could not be asked is unknown — never gone (a failed reading once dropped a live console's turn token for good)", async () => {
    expect(await svc.consoleState('no-such-console')).toBe('gone')
    expect(await svc.hasConsole('no-such-console')).toBe(false)
    const path = process.env.PATH
    process.env.PATH = '' // tmux cannot even be spawned: the question was never asked
    try {
      expect(await svc.consoleState('no-such-console')).toBe('unknown')
      expect(await svc.hasConsole('no-such-console')).toBe(false)
    } finally {
      process.env.PATH = path
    }
  })

  it('consoleAgent: the agent Silos launched the console for; unknown without one, forgotten on kill', async () => {
    expect(svc.consoleAgent(key)).toBeNull()
    await svc.ensureConsole({ cwd: folder, key, agentId: 'writer' })
    expect(svc.consoleAgent(key)).toBe('writer')
    expect(svc.consoleAgent('other')).toBeNull()
    await svc.killConsole(key)
    expect(svc.consoleAgent(key)).toBeNull()
  })

  it('a reused key: ensureConsole without agentId forgets the agent; kill drops the native-id binding', async () => {
    await svc.ensureConsole({ cwd: folder, key, agentId: 'writer' })
    await svc.ensureConsole({ cwd: folder, key })
    expect(svc.consoleAgent(key)).toBeNull()
    svc.bindNativeId(key, 'ses_a')
    await svc.killConsole(key)
    expect(svc.nativeIdOf(key)).toBeNull()
    expect(svc.keyOfNativeId('ses_a')).toBeNull()
  })

  it('a console that died outside killConsole loses its agent at the next listing', async () => {
    await svc.ensureConsole({ cwd: folder, key, agentId: 'writer' })
    execFileSync('tmux', ['-L', socket, 'kill-session', '-t', `=silos-${key}`], { stdio: 'ignore' })
    expect((await svc.listConsoles()).map((c) => c.key)).not.toContain(key)
    expect(svc.consoleAgent(key)).toBeNull()
  })

  it('ensureConsole starts the tmux session once (detached, nobody attached); a second call reuses it', async () => {
    expect(hasSession()).toBe(false)
    expect(await svc.ensureConsole({ cwd: folder, key })).toEqual({ key, theme: 'dark' })
    expect(hasSession()).toBe(true)
    const clients = execFileSync('tmux', ['-L', socket, 'list-clients']).toString().trim()
    expect(clients).toBe('')
    await svc.ensureConsole({ cwd: folder, key })
    expect(execFileSync('tmux', ['-L', socket, 'list-sessions', '-F', '#{session_name}']).toString().trim().split('\n')).toEqual([`silos-${key}`])
  })

  it('every client gets the full screen on attach — even one that attaches seconds later, at the same size', async () => {
    await svc.ensureConsole({ cwd: folder, key })
    // the initial paint happened with nobody listening: irrelevant now,
    // each client is a tmux client of its own and tmux paints it on attach.
    const pane = (): string => execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', `=silos-${key}:`]).toString()
    await waitForCond(() => pane().includes('SCREEN-MARK'))
    const a = { value: '' }
    const ca = await svc.openConsoleClient(key, 100, 30)
    const offA = svc.onData(ca.id, (d) => {
      a.value += d
    })
    await waitFor(a, 'SCREEN-MARK', 4000)
    await quiet(a)

    const b = { value: '' }
    const cb = await svc.openConsoleClient(key, 100, 30)
    const offB = svc.onData(cb.id, (d) => {
      b.value += d
    })
    await waitFor(b, 'SCREEN-MARK', 4000)
    offA()
    offB()
    svc.kill(ca.id)
    svc.kill(cb.id)
  }, 15000)

  it('clients have their own size: the phone at 48x31 does not shrink the desktop client', async () => {
    await svc.ensureConsole({ cwd: folder, key })
    const desk = await svc.openConsoleClient(key, 120, 40)
    const phone = await svc.openConsoleClient(key, 48, 31)
    const sizes = (): string[] =>
      execFileSync('tmux', ['-L', socket, 'list-clients', '-F', '#{client_width}x#{client_height}']).toString().trim().split('\n').sort()
    await waitForCond(() => sizes().join() === '120x40,48x31')
    expect(sizes()).toEqual(['120x40', '48x31'])
    svc.kill(phone.id)
    svc.kill(desk.id)
  }, 15000)

  it('killConsole ends the session and every attached client (emits killed for each)', async () => {
    await svc.ensureConsole({ cwd: folder, key })
    const c = await svc.openConsoleClient(key, 100, 30)
    const killed: string[] = []
    svc.on('killed', (id: string) => killed.push(id))
    await svc.killConsole(key)
    await waitForCond(() => killed.includes(c.id))
    expect(hasSession()).toBe(false)
  }, 15000)

  it('killConsoleAndWait resolves only once the claude behind the console has actually exited (its shutdown hook has run)', async () => {
    // Born from the owner's symptom: trash moved the JSONL, THEN
    // killed the console; the dying claude wrote its `last-prompt` line to
    // the old path and resurrected an empty session ("no cwd"). The stand-in
    // here mimics claude: on SIGHUP it takes a moment and then writes a
    // marker before exiting.
    const mark = join(mkdtempSync(join(tmpdir(), 'silos-mark-')), 'exited')
    const slow = new TerminalService(registry, index, IDLE, REAP, {
      tmuxSocket: socket,
      command: () => ['bash', '-c', `trap 'sleep 0.4; touch "${mark}"; exit 0' HUP; printf 'TRAP-SET\\n'; while true; do sleep 1; done`],
    })
    const k = `test-slow-${randomUUID()}`
    await slow.ensureConsole({ cwd: folder, key: k })
    // the trap is installed once bash has printed past it
    await waitForCond(() =>
      execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', `=silos-${k}:`])
        .toString()
        .includes('TRAP-SET'),
    )
    await slow.killConsoleAndWait(k)
    expect(existsSync(mark)).toBe(true)
    expect(await slow.hasConsole(k)).toBe(false)
    slow.stopReaper()
  }, 15000)

  it("openConsoleClient on an unknown key throws; console clients do not count toward the shells' limit", async () => {
    await expect(svc.openConsoleClient('nope', 80, 24)).rejects.toThrow('console not open')
    await svc.ensureConsole({ cwd: folder, key })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await svc.openConsoleClient(key, 80, 24)).id)
    // 4 console clients open and a shell still fits (MAX_PTYS counts shells only)
    const shell = svc.create({ agentId: 'writer' })
    ids.forEach((id) => svc.kill(id))
    svc.kill(shell.id)
  })

  // The wheel: the web client sends ONE tick per row of travel (its
  // WheelAccumulator), so tmux must scroll one row per tick — its default
  // is 5, which is what made a notch jump and a swipe fly.
  it('binds copy-mode wheel to one row per tick, on the live server too', async () => {
    await svc.ensureConsole({ cwd: folder, key })
    const keys = execFileSync('tmux', ['-L', socket, 'list-keys', '-T', 'copy-mode'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    expect(keys).toMatch(/WheelUpPane\s+send-keys -X -N 1 scroll-up/)
    expect(keys).toMatch(/WheelDownPane\s+send-keys -X -N 1 scroll-down/)
  })

  // The pane's own scrollbar: where tmux's view stands, and moving it.
  // `position` = rows above the bottom (tmux's scroll_position), so 0 is
  // "live, at the bottom" and `history` is the top.
  it('consoleScroll reports the view; consoleScrollTo moves it, clamps to the history, and 0 leaves copy-mode', async () => {
    const k = `test-${randomUUID()}`
    const tall = new TerminalService(registry, index, IDLE, REAP, {
      tmuxSocket: socket,
      command: () => ['bash', '-c', 'for i in $(seq 1 300); do echo "line $i"; done; sleep 60'],
    })
    // list-panes, not display-message: the latter's -t doesn't expand pane
    // formats (prints empty fields, exit 0 — even for a missing session).
    const inMode = (): boolean =>
      execFileSync('tmux', ['-L', socket, 'list-panes', '-t', `=silos-${k}:`, '-F', '#{pane_in_mode}'], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() === '1'
    try {
      await tall.ensureConsole({ cwd: folder, key: k })
      // 300 lines through a 50-row pane → ~250 rows of history once bash is done
      await waitForCond(async () => (await tall.consoleScroll(k)).history >= 200)
      expect(await tall.consoleScroll(k)).toMatchObject({ position: 0, rows: 50 })
      expect(inMode()).toBe(false)

      const moved = await tall.consoleScrollTo(k, 40)
      expect(moved.position).toBe(40)
      expect(inMode()).toBe(true)
      expect((await tall.consoleScroll(k)).position).toBe(40)

      // beyond the top clamps to the top; fractions are floored
      expect((await tall.consoleScrollTo(k, 999_999)).position).toBe(moved.history)
      expect((await tall.consoleScrollTo(k, 12.7)).position).toBe(12)

      // back to 0 = live again: copy-mode is left, typing reaches the app
      expect((await tall.consoleScrollTo(k, 0)).position).toBe(0)
      expect(inMode()).toBe(false)
      // and 0 while already live is a harmless no-op
      expect((await tall.consoleScrollTo(k, -5)).position).toBe(0)
    } finally {
      await tall.killConsole(k)
      tall.stopReaper()
    }
  }, 15000)

  it('consoleScroll/consoleScrollTo on an unknown key throw "console not open"', async () => {
    await expect(svc.consoleScroll('nope')).rejects.toThrow('console not open')
    await expect(svc.consoleScrollTo('nope', 3)).rejects.toThrow('console not open')
  })
})

describe('parseScrollInfo', () => {
  it('reads tmux\'s "scroll_position history_size pane_height pane_in_mode"', async () => {
    expect(parseScrollInfo('40 250 50 1\n')).toEqual({ position: 40, history: 250, rows: 50, inMode: true })
  })
  it('outside copy-mode scroll_position is EMPTY — that is position 0', async () => {
    expect(parseScrollInfo(' 250 50 0\n')).toEqual({ position: 0, history: 250, rows: 50, inMode: false })
  })
})

// The console's command line, flag by flag (pure — no tmux involved).
describe('defaultConsoleCommand', () => {
  it('dark (or no theme) is the plain command: no --settings override', async () => {
    expect(defaultConsoleCommand({ sessionId: 'abc' })).toEqual(['claude', '--session-id', 'abc'])
    expect(defaultConsoleCommand({ resumeId: 'abc', theme: 'dark' })).toEqual(['claude', '--resume', 'abc'])
  })
  it("light tells claude to use ITS light theme via --settings (per-process, never the owner's settings.json)", async () => {
    const cmd = defaultConsoleCommand({ resumeId: 'abc', theme: 'light' })
    const i = cmd.indexOf('--settings')
    expect(i).toBeGreaterThan(0)
    expect(JSON.parse(cmd[i + 1]!)).toEqual({ theme: 'light' })
    expect(cmd.slice(-2)).toEqual(['--resume', 'abc'])
  })
  it('rotationHook: a SessionStart hook (matcher "clear") that files the NEW session id under the console key', async () => {
    const cmd = defaultConsoleCommand({ resumeId: 'abc', rotationHook: { dir: '/tmp/rot', key: 'abc' } })
    const i = cmd.indexOf('--settings')
    expect(i).toBeGreaterThan(0)
    const settings = JSON.parse(cmd[i + 1]!)
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.SessionStart[0].matcher).toBe('clear')
    const hook = settings.hooks.SessionStart[0].hooks[0]
    expect(hook.type).toBe('command')
    expect(hook.command).toContain('/tmp/rot')
    expect(hook.command).toContain('abc')
    // theme and hook share ONE --settings
    const both = defaultConsoleCommand({ resumeId: 'abc', theme: 'light', rotationHook: { dir: '/tmp/rot', key: 'abc' } })
    expect(both.filter((a) => a === '--settings')).toHaveLength(1)
    expect(JSON.parse(both[both.indexOf('--settings') + 1]!).theme).toBe('light')
  })
  it('the rotation hook command really files {from: key} as <new id>.json when fed the SessionStart payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'))
    const cmd = defaultConsoleCommand({ resumeId: 'abc', rotationHook: { dir, key: 'abc' } })
    const hook = JSON.parse(cmd[cmd.indexOf('--settings') + 1]!).hooks.SessionStart[0].hooks[0].command as string
    execSync(hook, { input: JSON.stringify({ session_id: 'new-1', source: 'clear', cwd: '/x' }), shell: '/bin/sh' })
    expect(JSON.parse(readFileSync(join(dir, 'new-1.json'), 'utf8')).from).toBe('abc')
  })
  // a data dir under a home with a space (`/Users/Jane Doe/.silos`) is a
  // path like any other: the hook still runs and files the right path
  it('the rotation hook runs from a data dir whose path holds a space', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'rot space-')), 'with space')
    const hook = rotationHookCommand(dir, 'abc')
    mkdirSync(dir, { recursive: true })
    execSync(hook, { input: JSON.stringify({ session_id: 'new-2' }), shell: '/bin/sh' })
    expect(JSON.parse(readFileSync(join(dir, 'new-2.json'), 'utf8')).from).toBe('abc')
  })
  it('rotationHookCommand refuses a key or dir that could break out of the shell string', async () => {
    expect(() => rotationHookCommand('/tmp/rot', 'a"; rm -rf /; echo "')).toThrow()
    expect(() => rotationHookCommand('/tmp/$(id)', 'abc')).toThrow()
    expect(() => rotationHookCommand('/tmp/rot', 'abc')).not.toThrow()
  })
  it('permission cascade: bypass → --dangerously-skip-permissions, otherwise --permission-mode', async () => {
    expect(defaultConsoleCommand({ permissionMode: 'bypassPermissions' })).toContain('--dangerously-skip-permissions')
    expect(defaultConsoleCommand({ permissionMode: 'plan' }).slice(1, 3)).toEqual(['--permission-mode', 'plan'])
  })
  it('console command carries the fence inside the single --settings JSON', async () => {
    const cmd = defaultConsoleCommand({ fence: { permissions: { deny: ['Read(//x/**)'], additionalDirectories: ['/y'] } }, theme: 'light' })
    const i = cmd.indexOf('--settings')
    const s = JSON.parse(cmd[i + 1]!)
    expect(s.theme).toBe('light')
    expect(s.permissions.deny).toEqual(['Read(//x/**)'])
    expect(s.permissions.additionalDirectories).toEqual(['/y'])
    expect(cmd.filter((a) => a === '--settings')).toHaveLength(1)
  })
  it('the fence shares the one --settings with the hooks too', async () => {
    const cmd = defaultConsoleCommand({
      resumeId: 'abc',
      rotationHook: { dir: '/tmp/rot', key: 'abc' },
      fence: { permissions: { deny: ['Edit(//x/**)'], additionalDirectories: [] } },
    })
    expect(cmd.filter((a) => a === '--settings')).toHaveLength(1)
    const s = JSON.parse(cmd[cmd.indexOf('--settings') + 1]!)
    expect(s.hooks.SessionStart).toHaveLength(1)
    expect(s.permissions).toEqual({ deny: ['Edit(//x/**)'], additionalDirectories: [] })
  })
  it('no fence → command byte-identical to before', async () => {
    expect(defaultConsoleCommand({ sessionId: 'abc' })).toEqual(['claude', '--session-id', 'abc'])
    expect(defaultConsoleCommand({ resumeId: 'abc', theme: 'light', permissionMode: 'bypassPermissions' })).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--settings',
      '{"theme":"light"}',
      '--resume',
      'abc',
    ])
    expect(defaultConsoleCommand({ resumeId: 'abc', fence: undefined })).toEqual(['claude', '--resume', 'abc'])
    // the cockpit's model rides as --model (alias or id); nothing when nobody opined
    expect(defaultConsoleCommand({ resumeId: 'abc', permissionMode: 'bypassPermissions', model: 'opus' })).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'opus',
      '--resume',
      'abc',
    ])
  })
})

describe('TerminalService — the fence reaches the console command', () => {
  const socket = `silos-fence-${process.pid}`
  const key = `fence-${randomUUID()}`
  afterEach(async () => {
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    } catch {
      /* no server */
    }
    try {
      rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
    } catch {
      /* best effort */
    }
  })
  it('ensureConsole passes input.fence to the command builder (and nothing when absent)', async () => {
    const seen: Array<Record<string, unknown>> = []
    const svc = new TerminalService(registry, index, IDLE, REAP, {
      tmuxSocket: socket,
      command: (o) => {
        seen.push(o as Record<string, unknown>)
        return ['bash', '-c', 'sleep 60']
      },
    })
    const fence = { permissions: { deny: ['Read(//s/**)'], additionalDirectories: ['/st'] } }
    await svc.ensureConsole({ cwd: folder, key, fence })
    await svc.ensureConsole({ cwd: folder, key: `${key}-b` })
    expect(seen[0]!.fence).toEqual(fence)
    expect('fence' in seen[1]!).toBe(false)
    await svc.killConsole(key)
    await svc.killConsole(`${key}-b`)
    svc.killAll()
    svc.stopReaper()
  })
})

// Birth theme: a console keeps the theme it was SPAWNED with (the claude
// inside won't re-theme until reopened) — ensureConsole reports it so the
// UI renders the pane accordingly, even across server restarts (the stamp
// lives in the tmux session itself).
describe('console birth theme', () => {
  const socket = `silos-test-${process.pid}`
  let svc: TerminalService
  beforeEach(async () => {
    svc = new TerminalService(registry, index, IDLE, REAP, {
      tmuxSocket: socket,
      command: () => ['bash', '-c', 'sleep 60'],
    })
  })
  afterEach(async () => {
    svc.killAll()
    svc.stopReaper()
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    } catch {
      /* no server */
    }
    try {
      rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
    } catch {
      /* best effort */
    }
  })

  it('a light-born console still reports light when reopened with the UI in dark', async () => {
    const key = `theme-${randomUUID()}`
    expect((await svc.ensureConsole({ cwd: folder, key, theme: 'light' })).theme).toBe('light')
    expect((await svc.ensureConsole({ cwd: folder, key, theme: 'dark' })).theme).toBe('light')
    expect(await svc.consoleTheme(key)).toBe('light')
    await svc.killConsole(key)
  })
  it('no theme at spawn means dark (the long-standing default)', async () => {
    const key = `theme-${randomUUID()}`
    expect((await svc.ensureConsole({ cwd: folder, key })).theme).toBe('dark')
    await svc.killConsole(key)
  })
})

describe('contextNews: a UserPromptSubmit hook that tells the console about files added since its last prompt', () => {
  it('rides in the same --settings as the rotation hook', async () => {
    const cmd = defaultConsoleCommand({
      resumeId: 'abc',
      rotationHook: { dir: '/tmp/rot', key: 'abc' },
      contextNews: { dir: '/tmp/rot', key: 'abc', cwd: '/home/u/proj', agentId: 'finance' },
    })
    const settings = JSON.parse(cmd[cmd.indexOf('--settings') + 1]!)
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].type).toBe('command')
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('/home/u/proj')
    expect(() => contextNewsHookCommand('/tmp/rot', 'abc', '/home/u/proj', 'c;fo')).toThrow()
  })
  it('the hook really prints ONLY the files newer than its marker, primes silently on the first prompt, and stays quiet after', async () => {
    const { execFileSync } = await import('node:child_process')
    const { CONTEXT_NEWS_HEADING } = await import('../src/context-service.js')
    const dir = mkdtempSync(join(tmpdir(), 'rot-'))
    const cwd = mkdtempSync(join(tmpdir(), 'proj-'))
    mkdirSync(join(cwd, 'context', 'shared'), { recursive: true })
    mkdirSync(join(cwd, 'context', 'finance'), { recursive: true })
    writeFileSync(join(cwd, 'context', 'shared', 'guide.md'), 'g')
    const cmd = contextNewsHookCommand(dir, 'abc', cwd, 'finance')
    const run = () => execFileSync('sh', ['-c', cmd], { encoding: 'utf8' })
    expect(run()).toBe('') // first prompt: primes the marker, says nothing
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(cwd, 'context', 'finance', '036-08-26.pdf'), '%PDF')
    writeFileSync(join(cwd, 'context', 'finance', '.env.example'), 'x') // dot-names: the same rule as the listing's walk
    writeFileSync(join(cwd, 'context', 'shared', '.x.tmp-1'), 'x')
    expect(run()).toBe(`${CONTEXT_NEWS_HEADING}\n- context/finance/036-08-26.pdf\n`)
    expect(run()).toBe('') // consumed
  })
  it("drains the thread's queue of given files: prints each queued line once (rename, then read), on any prompt", async () => {
    const { execFileSync } = await import('node:child_process')
    const { CONTEXT_GIVEN_HEADING } = await import('../src/context-service.js')
    const { queueContextNews, contextNewsPath } = await import('../src/context-news.js')
    const dir = mkdtempSync(join(tmpdir(), 'rot-'))
    const cwd = mkdtempSync(join(tmpdir(), 'proj-'))
    const data = mkdtempSync(join(tmpdir(), 'data-'))
    const thread = 'aaaaaaaa-1111-4111-8111-111111111111'
    queueContextNews(data, thread, `context/finance/conversations/${thread}/brief.md`)
    const cmd = contextNewsHookCommand(dir, 'abc', cwd, 'finance', contextNewsPath(data, thread))
    const run = () => execFileSync('sh', ['-c', cmd], { encoding: 'utf8' })
    expect(run()).toBe(`${CONTEXT_GIVEN_HEADING}\n- context/finance/conversations/${thread}/brief.md\n`)
    expect(existsSync(contextNewsPath(data, thread))).toBe(false)
    expect(run()).toBe('') // printed once
    queueContextNews(data, thread, '/elsewhere/context/finance/conversations/x/a.csv')
    expect(run()).toBe(`${CONTEXT_GIVEN_HEADING}\n- /elsewhere/context/finance/conversations/x/a.csv\n`)
    expect(() => contextNewsHookCommand(dir, 'abc', cwd, 'finance', '/tmp/q;rm')).toThrow()
  })
})

// Vault credentials ride into the console as a per-session environment.
// They used to travel as `tmux new-session -e K=V …` — ONE client→server
// message, capped by tmux's imsg buffer (16 KB): a Vault of 24 console
// cookies (15 KB) made every new console of that agent fail with
// "command too long" (the builder), and the failure surfaced as
// execFileSync's "Command failed: tmux … -e SECRET=…" — every secret on the
// owner's screen. Two rules, fixed here for every variant:
//  · credentials never travel on a command line: an owner-only file the
//    launcher sources and removes before exec'ing claude (no size limit,
//    no argv, nothing left on disk once claude runs);
//  · a spawn failure reports tmux's own reason and never the command.
describe('TerminalService — console credentials off the command line', () => {
  const socket = `silos-env-${process.pid}`
  const key = `env-${randomUUID()}`
  let svc: TerminalService
  let envDir: string
  let mark: string

  beforeEach(async () => {
    envDir = join(mkdtempSync(join(tmpdir(), 'deck-env-')), 'console-env')
    mark = join(mkdtempSync(join(tmpdir(), 'deck-mark-')), 'seen.txt')
    svc = new TerminalService(registry, index, IDLE, REAP, {
      tmuxSocket: socket,
      envDir,
      // the stand-in claude writes what it sees of its environment
      command: () => ['bash', '-c', `printf '%s\\n%s\\n%s' "$BIG" "$QUOTED" "$SILOS_CONSOLE_THEME" > "${mark}"; sleep 60`],
    })
  })
  afterEach(async () => {
    await svc.killConsole(key)
    svc.killAll()
    svc.stopReaper()
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    } catch {
      /* no server */
    }
    try {
      rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
    } catch {
      /* best effort */
    }
  })

  it("a Vault larger than tmux's 16 KB message limit reaches claude verbatim — quotes, $, ; and newlines included", async () => {
    const big = 'x'.repeat(20_000)
    const quoted = `it's "q" $HOME \`w\` ; a=b\nline2`
    await svc.ensureConsole({ cwd: folder, key, extraEnv: { BIG: big, QUOTED: quoted } })
    await waitForCond(() => existsSync(mark) && readFileSync(mark, 'utf8').split('\n').length >= 4, 6000)
    expect(readFileSync(mark, 'utf8')).toBe(`${big}\n${quoted}\ndark`) // the theme stamp still rides its own way
  })

  it('the credentials file does not outlive the launch: gone once claude runs', async () => {
    await svc.ensureConsole({ cwd: folder, key, extraEnv: { BIG: 'b', QUOTED: 'q' } })
    await waitForCond(() => existsSync(mark), 6000)
    await waitForCond(() => !existsSync(join(envDir, `${key}.env`)), 2000)
    expect(existsSync(envDir)).toBe(true) // the file WAS written here…
    expect(existsSync(join(envDir, `${key}.env`))).toBe(false) // …and is gone
  })

  it("a failed spawn names tmux's reason and NEVER the command or the secrets", async () => {
    // a socket in a directory that does not exist: tmux cannot start
    const broken = new TerminalService(registry, index, IDLE, REAP, {
      tmuxSocket: join(tmpdir(), `no-such-dir-${randomUUID()}`, 'sock'),
      envDir,
      command: () => ['bash', '-c', 'sleep 60'],
    })
    let message = ''
    try {
      await broken.ensureConsole({ cwd: folder, key: `x-${randomUUID()}`, extraEnv: { API_KEY: 'hunter2-secret' } })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toBe('')
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('Command failed')
    expect(message).not.toContain('sleep 60') // the console's own argv never shows
    expect(message).toMatch(/tmux/i)
    broken.stopReaper()
  })
})

describe('TerminalService — console key ↔ native id (OpenCode)', () => {
  it('binds both ways; unknown lookups are null', async () => {
    expect(terminals.nativeIdOf('k1')).toBeNull()
    expect(terminals.keyOfNativeId('ses_a')).toBeNull()
    terminals.bindNativeId('k1', 'ses_a')
    expect(terminals.nativeIdOf('k1')).toBe('ses_a')
    expect(terminals.keyOfNativeId('ses_a')).toBe('k1')
  })

  it('a rebind drops the stale pairing on both sides', async () => {
    terminals.bindNativeId('k1', 'ses_a')
    terminals.bindNativeId('k1', 'ses_b')
    expect(terminals.keyOfNativeId('ses_a')).toBeNull()
    expect(terminals.nativeIdOf('k1')).toBe('ses_b')
    terminals.bindNativeId('k2', 'ses_b')
    expect(terminals.nativeIdOf('k1')).toBeNull()
    expect(terminals.keyOfNativeId('ses_b')).toBe('k2')
  })
})
