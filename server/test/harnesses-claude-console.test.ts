// harnesses-claude-console.test.ts — the Claude Code adapter's console face
// (the argv it describes is today's defaultConsoleCommand, byte for byte)
// and ensureConsole's explicit-command branch (another harness's argv rides
// the same tmux launch and env-file launcher; Claude's path is untouched).
import { describe, it, expect, afterEach, onTestFinished } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { LAUNCH_ARGV_INLINE_MAX, LONG_ARGV_LAUNCHER, TerminalService } from '../src/terminal-service.js'
import { defaultConsoleCommand } from '../src/harnesses/claude-code/console.js'
import { claudeCode } from '../src/harnesses/claude-code/index.js'
import { harnesses } from '../src/harnesses/index.js'
import type { Agent } from '../src/types.js'

const agent = { id: 'writer', name: 'Writer', folder: '/p' } as Agent

describe('claude-code adapter', () => {
  it('claude adapter command equals defaultConsoleCommand for a new and a resumed console', async () => {
    const spec = { agent, cwd: '/p', key: 'k1', fence: null, provider: null, env: {} }
    expect(claudeCode.console.command(spec)).toEqual(defaultConsoleCommand({ sessionId: 'k1' }))
    expect(claudeCode.console.command({ ...spec, resumeId: 'k1', theme: 'light' })).toEqual(defaultConsoleCommand({ resumeId: 'k1', theme: 'light' }))
  })
  it('carries the permission cascade and the fence like the console does', async () => {
    const fence = { permissions: { deny: ['Read(//s/**)'], additionalDirectories: ['/st'] } }
    const spec = { agent, cwd: '/p', key: 'k1', fence, provider: null, env: {}, permissionMode: 'bypassPermissions' }
    expect(claudeCode.console.command(spec)).toEqual(defaultConsoleCommand({ sessionId: 'k1', permissionMode: 'bypassPermissions', fence }))
  })
  it("carries the role's skills plugin as --plugin-dir (role-plugin.ts)", async () => {
    const spec = { agent, cwd: '/p', key: 'k1', fence: null, provider: null, env: {}, rolePlugin: '/data/agent-state/writer/plugin' }
    const argv = claudeCode.console.command(spec)
    expect(argv).toEqual(defaultConsoleCommand({ sessionId: 'k1', rolePluginDir: '/data/agent-state/writer/plugin' }))
    const at = argv.indexOf('--plugin-dir')
    expect(at).toBeGreaterThan(0)
    expect(argv[at + 1]).toBe('/data/agent-state/writer/plugin')
    expect(defaultConsoleCommand({ sessionId: 'k1' })).not.toContain('--plugin-dir')
  })
  it('declares its caps, id discovery and console env', async () => {
    expect(claudeCode.id).toBe('claude-code')
    expect(claudeCode.caps).toEqual({
      compaction: true,
      subagents: true,
      skills: true,
      thinking: true,
      costFromHarness: false,
      permissionsAsEvents: false,
      sendToConsole: false,
      outputStyles: true,
      agentAutoMemory: true,
    })
    expect(claudeCode.console.idDiscovery).toBe('silos-chosen')
    expect(claudeCode.console.env({ agent, cwd: '/p', key: 'k1', fence: null, provider: null, env: {} })).toEqual({ CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' })
  })
  it('is registered in the harness registry', async () => {
    expect(harnesses['claude-code']).toBe(claudeCode)
  })
})

describe('ensureConsole with an explicit command', () => {
  const socket = `silos-harness-${process.pid}`
  let svc: TerminalService
  let calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>

  async function setup(): Promise<string> {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const cwd = mkdtempSync(join(tmpdir(), 'deck-folder-'))
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder: cwd })
    mkdirSync(join(base, 'projects'), { recursive: true })
    const index = claudeSessionIndex(join(base, 'projects'), join(base, 'cache.json'))
    await index.init()
    svc = new TerminalService(registry, index, 30 * 60_000, 60_000, { tmuxSocket: socket, envDir: join(base, 'env'), appendDir: join(base, 'append') })
    // record every tmux call instead of running it: nothing real is spawned
    // (no `opencode`, no `claude`), the argv and env are what's asserted.
    calls = []
    ;(svc as unknown as { tmux: (args: string[], env?: NodeJS.ProcessEnv) => void }).tmux = (args, env) => {
      calls.push({ args, env })
    }
    return cwd
  }
  const newSession = () => calls.find((c) => c.args.includes('new-session'))!

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

  it('ensureConsole with an explicit command execs that argv and keeps the env file launcher', async () => {
    const cwd = await setup()
    await svc.ensureConsole({ cwd, key: `k2-${randomUUID()}`, command: ['opencode', '--port', '4100'], extraEnv: { A: '1' } })
    const { args, env } = newSession()
    expect(args).toContain('opencode')
    expect(args).not.toContain('claude')
    expect(args.slice(-3)).toEqual(['opencode', '--port', '4100'])
    expect(args).toContain('silos-console') // the env-file launcher wraps it
    expect(env?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
  })

  // the fence makes a console's --settings long; tmux
  // caps a whole new-session message at 16 KB ("command too long"), so a
  // long argv rides the launch file — and reaches the program byte for byte
  // (the launcher really runs here, through sh)
  it('a long argv (a big fence) rides the launch file, untouched; a short one stays inline', async () => {
    const cwd = await setup()
    const big = JSON.stringify({ permissions: { deny: Array.from({ length: 400 }, (_, i) => `Edit(//home/u/folder-${i}/.claude/settings*.json)`) } })
    const argv = ['printf', '%s\\n', '--settings', big, "it's", 'a b']
    expect(argv.join(' ').length).toBeGreaterThan(LAUNCH_ARGV_INLINE_MAX)
    await svc.ensureConsole({ cwd, key: `k4-${randomUUID()}`, command: argv, extraEnv: { A: '1' } })
    const { args } = newSession()
    const at = args.indexOf('silos-console')
    expect(args.slice(at - 2, at)).toEqual(['-c', LONG_ARGV_LAUNCHER])
    const file = args[at + 1]!
    expect(args.slice(at + 2)).toEqual([]) // nothing of the argv on the tmux line
    expect(args.join(' ').length).toBeLessThan(4096)
    // the launcher, run for real: the program gets the exact argv, the env, and the file is gone
    const out = execFileSync('sh', ['-c', LONG_ARGV_LAUNCHER.replace('exec "$@"', 'printf "%s\\n" "$A"; exec "$@"'), 'silos-console', file]).toString()
    expect(out).toBe(`1\n--settings\n${big}\nit's\na b\n`)
    expect(existsSync(file)).toBe(false)
    // a short argv: as before, inline after the env file
    await svc.ensureConsole({ cwd, key: `k5-${randomUUID()}`, command: ['opencode', '--port', '4100'], extraEnv: { A: '1' } })
    expect(
      calls
        .filter((c) => c.args.includes('new-session'))
        .at(-1)!
        .args.slice(-3),
    ).toEqual(['opencode', '--port', '4100'])
  })

  // review A5: the launcher once kept the file's path in `$f` — a Vault entry
  // named `f` then redirected the rm (secrets left on disk, an attacker-named
  // path removed). The path now lives only in `$1`, which no export touches.
  it("a Vault entry named like a shell variable cannot redirect the launch file's removal", async () => {
    const cwd = await setup()
    const victim = join(mkdtempSync(join(tmpdir(), 'deck-victim-')), 'keep-me')
    writeFileSync(victim, 'x')
    const big = 'x'.repeat(LAUNCH_ARGV_INLINE_MAX + 10)
    await svc.ensureConsole({ cwd, key: `k8-${randomUUID()}`, command: ['printf', '%s|%s\\n', '--settings', big], extraEnv: { f: victim, SECRET: 's3cret' } })
    const { args } = newSession()
    const file = args[args.indexOf('silos-console') + 1]!
    const out = execFileSync('sh', [
      '-c',
      LONG_ARGV_LAUNCHER.replace('exec "$@"', 'printf "%s %s\\n" "$f" "$SECRET"; exec "$@"'),
      'silos-console',
      file,
    ]).toString()
    expect(out).toBe(`${victim} s3cret\n--settings|${big}\n`)
    expect(existsSync(file)).toBe(false) // the secrets are off the disk
    expect(existsSync(victim)).toBe(true) // and nothing else was removed
    // the short launcher, same entry: its path is in $1 too
    await svc.ensureConsole({ cwd, key: `k9-${randomUUID()}`, command: ['true'], extraEnv: { f: victim } })
    const short = calls.filter((c) => c.args.includes('new-session')).at(-1)!.args
    const at = short.indexOf('silos-console')
    const shortFile = short[at + 1]!
    execFileSync('sh', [...short.slice(at - 2, at), 'silos-console', shortFile, 'true'])
    expect(existsSync(shortFile)).toBe(false)
    expect(existsSync(victim)).toBe(true)
  })

  it('baseEnv rides over the clean env instead of the Claude-specific switch', async () => {
    const cwd = await setup()
    await svc.ensureConsole({ cwd, key: `k3-${randomUUID()}`, command: ['opencode'], baseEnv: { OPENCODE_X: 'y' } })
    const { args, env } = newSession()
    expect(args.at(-1)).toBe('opencode')
    expect(env?.OPENCODE_X).toBe('y')
    expect(env?.TERM).toBe('xterm-256color')
    expect(env?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
  })

  it('without a command the Claude console is launched exactly as before', async () => {
    const cwd = await setup()
    const key = `k4-${randomUUID()}`
    await svc.ensureConsole({ cwd, key, sessionId: key })
    const { args, env } = newSession()
    expect(args.slice(-defaultConsoleCommand({ sessionId: key }).length)).toEqual(defaultConsoleCommand({ sessionId: key }))
    expect(env?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
  })

  it("a first prompt (task mode's Work on this) rides as ONE positional argv element, last — new or resumed — and the answer says briefed", async () => {
    const cwd = await setup()
    const prompt = 'The owner opened this conversation to work ONE task — p#t1 «x».\n\n- the owner: "quoted" $HOME `tick`'
    const key = `k5-${randomUUID()}`
    expect(await svc.ensureConsole({ cwd, key, sessionId: key, prompt, extraEnv: { SILOS_SESSION_ID: key } })).toMatchObject({ key, briefed: true })
    expect(newSession().args.slice(-3)).toEqual(['--session-id', key, prompt])
    calls = []
    const r = `k6-${randomUUID()}`
    await svc.ensureConsole({ cwd, key: r, resumeId: r, prompt })
    expect(newSession().args.slice(-3)).toEqual(['--resume', r, prompt])
    // no prompt: byte-identical argv, no briefed
    expect(defaultConsoleCommand({ sessionId: 's', prompt: '  ' })).toEqual(defaultConsoleCommand({ sessionId: 's' }))
    // another harness's own argv never carries it, and never says briefed
    calls = []
    expect(await svc.ensureConsole({ cwd, key: `k7-${randomUUID()}`, command: ['opencode'], prompt })).not.toHaveProperty('briefed')
    expect(newSession().args).not.toContain(prompt)
  })
})

// a new console takes the tmux SERVER's global env, frozen
// when it started — one started under `npm run dev` gave every console npm's
// run variables and Silos' node_modules/.bin first on PATH, long after the
// Silos server itself was cleaned. Real tmux on a private socket; the
// console's program is a stand-in (`sleep`), never an engine.
describe("a console never inherits the dev run through tmux's global env", () => {
  const socket = `silos-genv-${process.pid}-${randomUUID().slice(0, 8)}`
  const tmux = (args: string[], env?: NodeJS.ProcessEnv): string => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', ...(env ? { env } : {}) })
  afterEach(async () => {
    try {
      tmux(['kill-server'])
    } catch {
      /* already gone */
    }
  })

  it('npm run variables leave the global env and its PATH becomes the clean one', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const cwd = mkdtempSync(join(tmpdir(), 'deck-folder-'))
    // a tmux server started by a dirty Silos (an older boot)
    const dirtyPath = `/x/silos/node_modules/.bin:/x/node_modules/.bin:${process.env.PATH ?? '/usr/bin:/bin'}`
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'seed', 'sleep', '30'], {
      ...process.env,
      PATH: dirtyPath,
      npm_package_name: '@silos/server',
      npm_lifecycle_event: 'dev',
      INIT_CWD: '/x/silos',
    })
    expect(tmux(['show-environment', '-g'])).toContain('npm_package_name=')
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder: cwd })
    mkdirSync(join(base, 'projects'), { recursive: true })
    const index = claudeSessionIndex(join(base, 'projects'), join(base, 'cache.json'))
    await index.init()
    const svc = new TerminalService(registry, index, 30 * 60_000, 60_000, { tmuxSocket: socket, envDir: join(base, 'env'), appendDir: join(base, 'append') })
    await svc.ensureConsole({ cwd, key: `g-${randomUUID()}`, command: ['sleep', '30'] })
    const global = tmux(['show-environment', '-g'])
    expect(global).not.toMatch(/^(npm_|INIT_CWD=)/m)
    const path = /^PATH=(.*)$/m.exec(global)?.[1] ?? ''
    expect(path).not.toBe('')
    expect(path.split(':').some((p) => p.endsWith('node_modules/.bin'))).toBe(false)
    rmSync(base, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  // the same frozen env carried the owner's token (a server
  // started with SILOS_TOKEN) and a parent agent's wiring into every console
  it("the owner's token and Silos' own wiring leave it too; CLAUDE* set on purpose stays", async () => {
    // its own socket: a tmux server re-born on the one just killed can race its exit
    const socket = `silos-genv2-${process.pid}-${randomUUID().slice(0, 8)}`
    const tmux = (args: string[], env?: NodeJS.ProcessEnv): string =>
      execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', ...(env ? { env } : {}) })
    onTestFinished(() => {
      try {
        tmux(['kill-server'])
      } catch {
        /* already gone */
      }
    })
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const cwd = mkdtempSync(join(tmpdir(), 'deck-folder-'))
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'seed', 'sleep', '30'], {
      ...process.env,
      SILOS_TOKEN: 'owner-token',
      SILOS_PROVIDER_KEY: 'sk-x',
      SILOS_AGENT_TOKEN: 'parent-bearer',
      SILOS_CONSOLE_THEME: 'dark',
      CLAUDE_CODE_SEEDED: '1',
    })
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder: cwd })
    mkdirSync(join(base, 'projects'), { recursive: true })
    const index = claudeSessionIndex(join(base, 'projects'), join(base, 'cache.json'))
    await index.init()
    const svc = new TerminalService(registry, index, 30 * 60_000, 60_000, { tmuxSocket: socket, envDir: join(base, 'env'), appendDir: join(base, 'append') })
    await svc.ensureConsole({ cwd, key: `g-${randomUUID()}`, command: ['sleep', '30'] })
    const global = tmux(['show-environment', '-g'])
    expect(global).not.toMatch(/^(SILOS_TOKEN|SILOS_PROVIDER_KEY|SILOS_AGENT_TOKEN)=/m)
    expect(global).toMatch(/^CLAUDE_CODE_SEEDED=1$/m)
    rmSync(base, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })
})
