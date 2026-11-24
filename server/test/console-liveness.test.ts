// Console liveness (a reported bug: a console's turn token died while its
// console ran — writes carrying SILOS_TURN refused 400/403 for the rest of
// the conversation). THE rule, for the whole class: a liveness probe that
// FAILS is «unknown», never «gone»; only tmux's own statement that the
// session does not exist ends a token; a replacement token is minted before
// the old one is dropped, and the new one is discarded if the spawn fails.
// Unknown never leaks: the next DEFINITE answer (a probe or a listing)
// collects a console that is really dead.
//
// Every tmux outcome × every caller, through an injected tmux runner; then
// one real tmux on a private socket (never the owner's) whose server is
// frozen (SIGSTOP) so the probe really times out.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { ConsoleUnknownError, LIVENESS_FRESH_MS, TerminalService, tmuxExec, tmuxSaysGone, type TmuxRunner, type TmuxRunOpts } from '../src/terminal-service.js'
import { LiveTurns, TURN_REQUIRED_NONE_LIVE } from '../src/live-turns.js'

// ---- every outcome tmux (or the spawn of it) can give --------------------

type Outcome = 'exists' | 'cantFind' | 'noServer' | 'noSocket' | 'timeout' | 'spawnError' | 'unrelated' | 'connectEagain'

function failure(o: Exclude<Outcome, 'exists'>, name = 'silos-k'): Error {
  const e = new Error(`Command failed: tmux (${o})`) as Error & Record<string, unknown>
  switch (o) {
    case 'cantFind':
      Object.assign(e, { status: 1, signal: null, stderr: Buffer.from(`can't find session: ${name}\n`) })
      break
    case 'noServer':
      Object.assign(e, { status: 1, signal: null, stderr: Buffer.from('no server running on /tmp/tmux-1000/test\n') })
      break
    case 'noSocket':
      Object.assign(e, { status: 1, signal: null, stderr: Buffer.from('error connecting to /tmp/tmux-1000/test (No such file or directory)\n') })
      break
    // the shapes tmuxExec rejects with (execFile's, normalized like
    // execFileSync's): a timeout is killed (status null, SIGKILL); a spawn
    // error has no status at all
    case 'timeout':
      Object.assign(e, { status: null, signal: 'SIGKILL', code: 'ETIMEDOUT', stderr: Buffer.from('') })
      break
    case 'spawnError':
      Object.assign(e, { status: null, signal: null, code: 'EAGAIN' })
      break
    case 'unrelated':
      Object.assign(e, { status: 1, signal: null, stderr: Buffer.from('server exited unexpectedly\n') })
      break
    // a live server whose accept queue is full, or out of fds: not an answer
    case 'connectEagain':
      Object.assign(e, { status: 1, signal: null, stderr: Buffer.from('error connecting to /tmp/tmux-1000/test (Resource temporarily unavailable)\n') })
      break
  }
  return e
}

const GONE: readonly Outcome[] = ['cantFind', 'noServer', 'noSocket']
const UNKNOWN: readonly Outcome[] = ['timeout', 'spawnError', 'unrelated', 'connectEagain']
const ALL: readonly Outcome[] = ['exists', ...GONE, ...UNKNOWN]

// the tmux subcommand of a call (`-L <sock>` and a leading `-f <conf>` skipped)
function sub(args: string[]): string {
  let a = args[0] === '-L' ? args.slice(2) : args
  if (a[0] === '-f') a = a.slice(2)
  return a[0] ?? ''
}

/** A scripted tmux: per subcommand, an outcome (or a function of the call). */
function scripted(plan: Partial<Record<string, Outcome | ((args: string[]) => Outcome)>>, calls: string[][] = []): TmuxRunner {
  return (args: string[], _opts: TmuxRunOpts) => {
    calls.push(args)
    const p = plan[sub(args)]
    const o = typeof p === 'function' ? p(args) : (p ?? 'exists')
    if (o !== 'exists') throw failure(o)
    if (sub(args) === 'list-sessions') return Buffer.from('')
    return Buffer.from('')
  }
}

let registry: AgentRegistry, index: SessionIndex, folder: string, base: string
const services: TerminalService[] = []

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'silos-liveness-'))
  folder = mkdtempSync(join(tmpdir(), 'silos-liveness-folder-'))
  registry = new AgentRegistry(join(base, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder })
  const root = join(base, 'projects')
  mkdirSync(root, { recursive: true })
  index = claudeSessionIndex(root, join(base, 'cache.json'))
  await index.init()
})

afterEach(() => {
  for (const s of services.splice(0)) {
    s.killAll()
    s.stopReaper()
  }
  rmSync(base, { recursive: true, force: true })
  rmSync(folder, { recursive: true, force: true })
})

function service(runner: TmuxRunner, liveTurns?: LiveTurns, socket = `liveness-fake-${process.pid}`): TerminalService {
  const s = new TerminalService(registry, index, 30 * 60_000, 60_000, {
    tmuxSocket: socket,
    tmuxRunner: runner,
    command: () => ['bash', '-c', 'sleep 60'],
    appendDir: join(base, 'append'),
    envDir: join(base, 'env'),
    sessionsDir: join(base, 'claude-sessions'),
    ...(liveTurns ? { liveTurns } : {}),
  })
  services.push(s)
  return s
}

const persisted = (file: string): string[] => (JSON.parse(readFileSync(file, 'utf8')) as { consoles: { token: string }[] }).consoles.map((c) => c.token)

describe("tmuxSaysGone — only tmux's own statement is «gone»", () => {
  it.each(GONE)('%s → gone', (o) => {
    expect(tmuxSaysGone(failure(o as Exclude<Outcome, 'exists'>))).toBe(true)
  })
  it.each(UNKNOWN)('%s → not an answer', (o) => {
    expect(tmuxSaysGone(failure(o as Exclude<Outcome, 'exists'>))).toBe(false)
  })
  it('garbage is not an answer', () => {
    expect(tmuxSaysGone(null)).toBe(false)
    expect(tmuxSaysGone(new Error('boom'))).toBe(false)
    expect(tmuxSaysGone({ status: 0, stderr: "can't find session: x" })).toBe(false)
  })
})

describe('consoleState / hasConsole — every outcome', () => {
  const want: Record<Outcome, 'alive' | 'gone' | 'unknown'> = {
    exists: 'alive',
    cantFind: 'gone',
    noServer: 'gone',
    noSocket: 'gone',
    timeout: 'unknown',
    spawnError: 'unknown',
    unrelated: 'unknown',
    connectEagain: 'unknown',
  }
  it.each(ALL)('has-session %s', async (o) => {
    const s = service(scripted({ 'has-session': o }))
    expect(await s.consoleState('k')).toBe(want[o])
    expect(await s.hasConsole('k')).toBe(o === 'exists')
  })

  it.each(ALL)('knownConsoleState after has-session %s: the last definite answer, never a fork', async (o) => {
    const calls: string[][] = []
    const s = service(scripted({ 'has-session': o }, calls))
    await s.consoleState('k')
    const n = calls.length
    // fresh: answered from what tmux last said (unknown stays unknown)
    expect(s.knownConsoleState('k')).toBe(want[o])
    if (o !== 'exists' && !GONE.includes(o)) return
    expect(calls.length).toBe(n)
  })
})

// A token is checked on every agent request, so its console's liveness is
// read from the last answer tmux gave (knownConsoleState — no fork on the
// request): a definite answer ends it at the next check; before any answer
// it is unknown (kept) and a background probe is started.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the turn token × every probe outcome (stillAlive: classify, liveOf, get)', () => {
  it.each(ALL)('has-session %s', async (o) => {
    const file = join(base, 'live-turns.json')
    const turns = new LiveTurns({ file })
    const s = service(scripted({ 'has-session': o }), turns)
    const token = turns.mintConsole('writer', 'k')
    await s.consoleState('k') // the probe (the background one, or any caller's)
    const c = turns.classify('writer', token)
    if (GONE.includes(o)) {
      expect(c).toEqual({ ok: false, code: 403, error: TURN_REQUIRED_NONE_LIVE })
      expect(persisted(file)).toEqual([])
    } else {
      // alive or UNKNOWN: the token still classifies — and stays on disk
      expect(c.ok).toBe(true)
      expect(turns.liveOf('writer')).toHaveLength(1)
      expect(turns.get(token)?.class).toBe('console')
      expect(persisted(file)).toEqual([token])
    }
  })

  it('unknown never leaks: kept through any number of failed probes, collected by the first definite «gone»', async () => {
    const file = join(base, 'live-turns.json')
    const turns = new LiveTurns({ file })
    let answer: Outcome = 'timeout'
    // the listing a first check starts answers like the probe (tmux is one server)
    const s = service(scripted({ 'has-session': () => answer, 'list-sessions': () => answer }), turns)
    const token = turns.mintConsole('writer', 'k')
    for (const o of UNKNOWN) {
      answer = o
      await s.consoleState('k')
      expect(turns.classify('writer', token).ok).toBe(true)
    }
    answer = 'cantFind'
    await s.consoleState('k')
    expect(turns.classify('writer', token).ok).toBe(false)
    expect(persisted(file)).toEqual([])
    answer = 'exists' // a token, once ended, never comes back
    expect(turns.get(token)).toBeNull()
  })

  it('a throwing probe is unknown too', () => {
    const turns = new LiveTurns({
      consoleAlive: () => {
        throw new Error('boom')
      },
    })
    const token = turns.mintConsole('writer', 'k')
    expect(turns.classify('writer', token).ok).toBe(true)
  })

  it("a check with no answer yet starts ONE background listing and keeps the token; the listing's «gone» ends it at the next check", async () => {
    const calls: string[][] = []
    const turns = new LiveTurns()
    service(scripted({ 'has-session': 'cantFind' }, calls), turns)
    const token = turns.mintConsole('writer', 'k')
    expect(turns.classify('writer', token).ok).toBe(true)
    expect(turns.classify('writer', token).ok).toBe(true) // one listing in flight, not two
    expect(calls.map(sub)).toEqual(['list-sessions'])
    await settle()
    expect(turns.classify('writer', token).ok).toBe(false)
  })

  it('persistence across a restart: an unknown probe keeps the token on disk; the next life reloads it, and a definite gone then ends it', async () => {
    const file = join(base, 'live-turns.json')
    const first = new LiveTurns({ file })
    const s1 = service(scripted({ 'has-session': 'timeout', 'list-sessions': 'timeout' }), first)
    const token = first.mintConsole('writer', 'k')
    await s1.consoleState('k')
    expect(first.classify('writer', token).ok).toBe(true)
    expect(persisted(file)).toEqual([token])
    // the server restarts (tsx reload): a new registry from the same file,
    // tmux still busy — the console's claude keeps working with its token
    const second = new LiveTurns({ file })
    let answer: Outcome = 'spawnError'
    const s2 = service(scripted({ 'has-session': () => answer, 'list-sessions': () => answer }), second)
    await s2.consoleState('k')
    expect(second.classify('writer', token).ok).toBe(true)
    expect(persisted(file)).toEqual([token])
    answer = 'exists'
    await s2.consoleState('k')
    expect(second.classify('writer', token).ok).toBe(true)
    answer = 'noServer' // tmux died with the machine's reboot
    await s2.consoleState('k')
    expect(second.classify('writer', token).ok).toBe(false)
    expect(persisted(file)).toEqual([])
  })
})

describe('listConsoles — a listing is a definite answer only when tmux gives one', () => {
  it('a successful listing prunes the consoles it does not name, and keeps the ones it does', async () => {
    const turns = new LiveTurns()
    const s = service(
      ((args: string[]) => {
        if (sub(args) === 'list-sessions') return Buffer.from('silos-live:0:1700000000\nother:0:1700000000\n')
        return Buffer.from('')
      }) as TmuxRunner,
      turns,
    )
    const live = turns.mintConsole('writer', 'live')
    const dead = turns.mintConsole('writer', 'dead')
    expect((await s.listConsoles()).map((c) => c.key)).toEqual(['live'])
    // the listing pruned `dead` without a probe; `live` is still there
    turns.setConsoleAlive(() => 'alive')
    expect(turns.get(live)).not.toBeNull()
    expect(turns.get(dead)).toBeNull()
  })

  // 21-11: with no UTF-8 locale tmux prints a control character as `_` —
  // a listing whose lines do not read drops nothing
  it('a listing that cannot be read is no answer — no console is forgotten on it', async () => {
    const turns = new LiveTurns()
    const s = service(((args: string[]) => Buffer.from(sub(args) === 'list-sessions' ? 'silos-live_0_1700000000\n' : '')) as TmuxRunner, turns)
    const live = turns.mintConsole('writer', 'live')
    expect(await s.listConsoles()).toEqual([])
    turns.setConsoleAlive(() => 'alive')
    expect(turns.get(live)).not.toBeNull()
  })

  it.each([...GONE, ...UNKNOWN])('list-sessions %s', async (o) => {
    const turns = new LiveTurns()
    const s = service(scripted({ 'list-sessions': o }), turns)
    const token = turns.mintConsole('writer', 'k')
    expect(await s.listConsoles()).toEqual([])
    turns.setConsoleAlive(() => 'alive') // look at what the listing left
    if (GONE.includes(o)) expect(turns.get(token)).toBeNull()
    else expect(turns.get(token)).not.toBeNull()
  })

  it('collection without any probe: a truly dead console whose has-session keeps failing is ended by the next successful listing (the sleep sweep lists every 10 min)', async () => {
    const turns = new LiveTurns()
    let listing = false
    const s = service(
      ((args: string[]) => {
        if (sub(args) === 'has-session') throw failure('timeout')
        if (sub(args) === 'list-sessions') {
          if (!listing) throw failure('timeout')
          return Buffer.from('')
        }
        return Buffer.from('')
      }) as TmuxRunner,
      turns,
    )
    const token = turns.mintConsole('writer', 'k')
    await s.listConsoles() // the listing timed out: nothing is concluded
    expect(turns.classify('writer', token).ok).toBe(true)
    listing = true
    await s.listConsoles() // tmux answered: no such console
    expect(turns.classify('writer', token).ok).toBe(false)
  })
})

describe('reattachConsole / ensureConsole — the relaunch race', () => {
  it.each(ALL)('reattach on has-session %s', async (o) => {
    const s = service(scripted({ 'has-session': o }))
    if (o === 'exists') expect(await s.reattachConsole('k')).toEqual({ key: 'k', theme: 'dark' })
    else if (GONE.includes(o)) expect(await s.reattachConsole('k')).toBeNull()
    else await expect(s.reattachConsole('k')).rejects.toThrow(ConsoleUnknownError)
  })

  it.each(UNKNOWN)('has-session %s: ensureConsole spawns nothing and the live token is kept', async (o) => {
    const turns = new LiveTurns()
    const calls: string[][] = []
    const s = service(scripted({ 'has-session': o }, calls), turns)
    const token = turns.mintConsole('writer', 'k')
    await expect(s.ensureConsole({ cwd: folder, key: 'k', resumeId: 'k', agentId: 'writer' })).rejects.toThrow(ConsoleUnknownError)
    expect(calls.map(sub)).not.toContain('new-session')
    turns.setConsoleAlive(() => 'alive')
    expect(turns.get(token)).not.toBeNull()
    expect(turns.liveOf('writer')).toHaveLength(1)
  })

  it('tmux said gone, and the relaunch fails with «duplicate session» (the console was alive after all): the old token stays, the new one is discarded', async () => {
    const turns = new LiveTurns()
    const s = service(
      scripted({
        'has-session': 'cantFind',
        'new-session': () => {
          throw Object.assign(new Error('x'), { status: 1, stderr: Buffer.from('duplicate session: silos-k\n') })
        },
      }),
      turns,
    )
    const old = turns.mintConsole('writer', 'k')
    turns.setConsoleAlive(() => 'alive')
    await expect(s.ensureConsole({ cwd: folder, key: 'k', agentId: 'writer' })).rejects.toThrow(/duplicate session/)
    turns.setConsoleAlive(() => 'alive')
    expect(turns.liveOf('writer').map((t) => t.consoleKey)).toEqual(['k'])
    expect(turns.get(old)).not.toBeNull()
  })

  it('tmux said gone and the relaunch takes: the new token replaces the old one (minted before it was dropped)', async () => {
    const file = join(base, 'live-turns.json')
    const turns = new LiveTurns({ file })
    let spawned = false
    let atSpawn: string[] = []
    const s = service(
      ((args: string[]) => {
        if (sub(args) === 'has-session' && !spawned) throw failure('cantFind')
        if (sub(args) === 'new-session') {
          // at the moment of the spawn BOTH tokens exist: the old one is
          // dropped only once tmux has taken the new session
          atSpawn = persisted(file)
          spawned = true
        }
        return Buffer.from('')
      }) as TmuxRunner,
      turns,
    )
    const old = turns.mintConsole('writer', 'k')
    await s.ensureConsole({ cwd: folder, key: 'k', agentId: 'writer' })
    expect(spawned).toBe(true)
    expect(atSpawn).toHaveLength(2)
    expect(atSpawn).toContain(old)
    const now = persisted(file)
    expect(now).toHaveLength(1)
    expect(now[0]).not.toBe(old)
    expect(turns.get(old)).toBeNull()
    expect(turns.get(now[0]!)?.consoleKey).toBe('k')
  })

  it('a staged token is persisted beside the old one and only committed by the spawn', () => {
    const file = join(base, 'live-turns.json')
    const turns = new LiveTurns({ file })
    const old = turns.mintConsole('writer', 'k')
    const staged = turns.stageConsole('writer', 'k')
    expect(persisted(file).sort()).toEqual([old, staged].sort())
    turns.drop(staged) // the spawn failed
    expect(persisted(file)).toEqual([old])
    const next = turns.stageConsole('writer', 'k')
    turns.commitConsole('k', next) // the spawn took
    expect(persisted(file)).toEqual([next])
  })

  it('a staged token outlives «no such session» until its spawn answers', () => {
    const file = join(base, 'live-turns.json')
    let state: 'alive' | 'gone' | 'unknown' = 'gone' // the old console ended; the new one is not born yet
    const turns = new LiveTurns({ file, consoleAlive: () => state })
    const staged = turns.stageConsole('writer', 'k')
    expect(turns.get(staged)?.consoleKey).toBe('k') // a probe in the gap
    turns.pruneConsoles(new Set()) // a listing in the gap
    turns.dropConsole('k') // the old console's confirmed end
    expect(persisted(file)).toEqual([staged])
    state = 'alive'
    turns.commitConsole('k', staged)
    expect(turns.get(staged)?.consoleKey).toBe('k')
    state = 'gone' // once born, tmux's word counts again
    expect(turns.get(staged)).toBeNull()
    expect(persisted(file)).toEqual([])
  })
})

describe('killConsole — the token goes only when tmux confirms the session is over', () => {
  it.each(ALL)('kill-session %s', async (o) => {
    const turns = new LiveTurns()
    let probe: Outcome = 'exists'
    const s = service(scripted({ 'kill-session': o, 'has-session': () => probe }), turns)
    const token = turns.mintConsole('writer', 'k')
    await s.killConsole('k')
    if (o === 'exists' || GONE.includes(o)) {
      expect(turns.get(token)).toBeNull()
    } else {
      // the kill gave no answer: the claude may still run with this token
      expect(turns.get(token)).not.toBeNull()
      // …and the next definite answer collects it
      probe = 'cantFind'
      await s.consoleState('k')
      expect(turns.get(token)).toBeNull()
    }
  })
})

describe('the acts on a running console: gone and unknown are told apart', () => {
  it.each(ALL.filter((o) => o !== 'exists'))('has-session %s: openConsoleClient / consoleSendKeys / consoleSendLiteral', async (o) => {
    const s = service(scripted({ 'has-session': o }))
    const expected = GONE.includes(o) ? 'console not open' : ConsoleUnknownError
    await expect(s.openConsoleClient('k', 80, 24)).rejects.toThrow(expected)
    await expect(s.consoleSendKeys('k', ['1'])).rejects.toThrow(expected)
    await expect(s.consoleSendLiteral('k', 'hi')).rejects.toThrow(expected)
    expect(await s.consoleScreen('k')).toBe('')
  })
})

// ---- a real tmux, on a private socket ------------------------------------

function tmuxOk(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!tmuxOk())("real tmux on a private socket: a frozen tmux server never ends a live console's token", () => {
  const socket = `silos-liveness-${process.pid}-${randomUUID().slice(0, 8)}`
  // the real runner with a short bound, so the frozen server times out in
  // 400 ms instead of TMUX_TIMEOUT_MS
  const runner: TmuxRunner = (args, opts) => tmuxExec(args, opts, 400)
  let serverPid: number | null = null

  afterEach(() => {
    if (serverPid !== null) {
      try {
        process.kill(serverPid, 'SIGCONT')
      } catch {
        /* gone */
      }
    }
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

  it('SIGSTOP the tmux server: probes time out (unknown), the token keeps classifying, no relaunch happens; SIGCONT: alive; a real kill: gone, token ended', async () => {
    const file = join(base, 'live-turns.json')
    const turns = new LiveTurns({ file })
    const s = service(runner, turns, socket)
    const key = `k-${randomUUID()}`
    await s.ensureConsole({ cwd: folder, key, agentId: 'writer' })
    const [token] = persisted(file)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(await s.consoleState(key)).toBe('alive')
    serverPid = Number(execFileSync('tmux', ['-L', socket, 'display-message', '-p', '#{pid}']).toString().trim())
    expect(serverPid).toBeGreaterThan(0)
    process.kill(serverPid, 'SIGSTOP')
    try {
      expect(await s.consoleState(key)).toBe('unknown')
      expect(turns.classify('writer', token).ok).toBe(true)
      await expect(s.ensureConsole({ cwd: folder, key, agentId: 'writer' })).rejects.toThrow(ConsoleUnknownError)
      expect(await s.listConsoles()).toEqual([]) // a timed-out listing concludes nothing…
      expect(turns.classify('writer', token).ok).toBe(true) // …so the token is still there
    } finally {
      process.kill(serverPid, 'SIGCONT')
    }
    expect(persisted(file)).toEqual([token])
    expect(await s.consoleState(key)).toBe('alive')
    expect(await s.ensureConsole({ cwd: folder, key, agentId: 'writer' })).toEqual({ key, theme: 'dark' }) // a reattach: same token
    expect(persisted(file)).toEqual([token])
    execFileSync('tmux', ['-L', socket, 'kill-session', '-t', `=silos-${key}`])
    expect(await s.consoleState(key)).toBe('gone')
    expect(turns.classify('writer', token).ok).toBe(false)
    expect(persisted(file)).toEqual([])
  }, 20_000)

  it("a relaunch refused by the real tmux («duplicate session») leaves the running console's token alive", async () => {
    const file = join(base, 'live-turns.json')
    const turns = new LiveTurns({ file })
    const s = service(runner, turns, socket)
    const key = `k-${randomUUID()}`
    await s.ensureConsole({ cwd: folder, key, agentId: 'writer' })
    const [first] = persisted(file)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    // a caller that believed the console gone (the pre-21-11 false negative)
    // spawning over it: the real tmux refuses, and nothing of the live one moves
    const liar = service(
      ((args, opts) => {
        if (sub(args) === 'has-session') throw failure('cantFind')
        return runner(args, opts)
      }) as TmuxRunner,
      turns,
      socket,
    )
    turns.setConsoleAlive((k) => s.knownConsoleState(k)) // the liar wired itself in: put the honest reader back
    await expect(liar.ensureConsole({ cwd: folder, key, agentId: 'writer' })).rejects.toThrow(/duplicate session/)
    expect(persisted(file)).toEqual([first])
    await s.consoleState(key)
    expect(turns.classify('writer', first).ok).toBe(true)
  }, 20_000)
})

// e2e give.spec 21-11: a sync reader (Task mode's busyWhy → the live line,
// a wake's hold) re-asks every few seconds. Answering «unknown» once the
// last answer was 3 s old made a conversation that never had a console read
// «a console may have it open» for good — the line never left. The rule: a
// key tmux stated (its own probe, or a listing that does not name it) keeps
// that answer while a refresh runs; «unknown» only before tmux said anything,
// and the first answer emits `liveness` so whoever decided on it re-decides.
describe("knownConsoleState — the sync readers decide on tmux's last answer, never on a stale «unknown»", () => {
  const delayed =
    (ms: number, answer: (args: string[]) => Outcome, calls: string[][] = []): TmuxRunner =>
    (args: string[]) =>
      new Promise((resolve, reject) =>
        setTimeout(() => {
          calls.push(args)
          const o = answer(args)
          if (o === 'exists') resolve(Buffer.from(sub(args) === 'list-sessions' ? 'silos-live:0:1700000000\n' : ''))
          else reject(failure(o))
        }, ms),
      )
  const CONSOLE_UNSURE = 'unsure',
    CONSOLE_BUSY = 'busy'
  // index.ts busyWhy's console part, over the service
  const busyWhy = (s: TerminalService, id: string): string | null => {
    const st = s.knownConsoleState(id)
    return st === 'alive' ? CONSOLE_BUSY : st === 'unknown' ? CONSOLE_UNSURE : null
  }

  it('a conversation with no console: unknown only until the first (delayed) listing lands — then free, with one `liveness`, and no probe of its own', async () => {
    const calls: string[][] = []
    const s = service(delayed(40, (a) => (sub(a) === 'list-sessions' ? 'exists' : 'cantFind'), calls))
    let events = 0
    s.on('liveness', () => {
      events++
    })
    expect(busyWhy(s, 'never-had-one')).toBe(CONSOLE_UNSURE)
    await new Promise<void>((r) => s.once('liveness', () => r()))
    expect(events).toBe(1)
    expect(busyWhy(s, 'never-had-one')).toBeNull()
    expect(busyWhy(s, 'live')).toBe(CONSOLE_BUSY)
    expect(calls.map(sub)).toEqual(['list-sessions'])
  })

  it('an answer older than the freshness window still stands while it is refreshed (never «unknown» in between)', async () => {
    const s = service(delayed(30, (a) => (sub(a) === 'list-sessions' ? 'exists' : 'cantFind')))
    await s.listConsoles()
    expect(busyWhy(s, 'never-had-one')).toBeNull()
    const real = Date.now
    try {
      Date.now = () => real() + LIVENESS_FRESH_MS + 1_000 // the answer is stale now
      expect(busyWhy(s, 'never-had-one')).toBeNull() // still the last answer…
      expect(busyWhy(s, 'live')).toBe(CONSOLE_BUSY)
    } finally {
      Date.now = real
    }
    await new Promise((r) => setTimeout(r, 80)) // …and the refresh lands
    expect(busyWhy(s, 'never-had-one')).toBeNull()
  })

  it('a probe that FAILED is still unknown (the liveness rule), and a later definite answer flips it with `liveness`', async () => {
    let o: Outcome = 'timeout'
    const s = service(delayed(10, () => o))
    await s.consoleState('k')
    expect(s.knownConsoleState('k')).toBe('unknown')
    o = 'cantFind'
    const flipped = new Promise<void>((r) => s.once('liveness', () => r()))
    await s.consoleState('k')
    await flipped
    expect(s.knownConsoleState('k')).toBe('gone')
  })
})
