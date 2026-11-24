// account-load.test.ts — "who is on my Claude subscription right now",
// classified from a fake /proc tree: every source variant, the wrapper
// shell excluded, other uids skipped, account mapping, and the privacy
// rule (no environ value other than the four names ever surfaces).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { AccountLoadService, classifyAccountLoad, readProcTable, type ProcEntry } from '../src/harnesses/claude-code/account-load.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { buildServer } from '../src/server.js'

const HOME = '/home/op'
const SECRET = 'sk-ant-api03-SUPERSECRET'
const SELF = 500 // Silos' server pid
let base: string, proc: string, extraDir: string

interface FakeProc {
  pid: number
  ppid: number
  argv: string[]
  exe?: string
  env?: Record<string, string>
  comm?: string
}
function addProc(p: FakeProc): void {
  const dir = join(proc, String(p.pid))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stat'), `${p.pid} (${p.comm ?? 'x'}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560`)
  writeFileSync(join(dir, 'cmdline'), p.argv.join('\0') + '\0')
  const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: SECRET, ...(p.env ?? {}) }
  writeFileSync(
    join(dir, 'environ'),
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\0') + '\0',
  )
  if (p.exe) symlinkSync(p.exe, join(dir, 'exe'))
}

// a machine like the owner's on 27-10
function seedMachine(): void {
  addProc({
    pid: 100,
    ppid: 1,
    argv: ['tmux', '-L', 'silos', '-f', '/tmp/silos-console-tmux.conf', 'new-session', '-d'],
    comm: 'tmux: server',
    exe: '/usr/bin/tmux',
  })
  addProc({
    pid: 101,
    ppid: 100,
    argv: ['claude', '--append-system-prompt-file', `${HOME}/.silos/console-append/s1.md`],
    exe: '/opt/claude/versions/2.1.311',
    env: { TMUX: '/tmp/tmux-1000/silos,100,0', SILOS_AGENT_ID: 'builder', SILOS_SESSION_ID: 's1' },
  })
  addProc({
    pid: 102,
    ppid: 100,
    argv: ['claude', '--append-system-prompt-file', `${HOME}/.silos/console-append/s2.md`],
    exe: '/opt/claude/versions/2.1.311',
    env: { TMUX: '/tmp/tmux-1000/silos,100,0', SILOS_AGENT_ID: 'builder', SILOS_SESSION_ID: 's2' },
  })
  addProc({
    pid: 103,
    ppid: 100,
    argv: ['claude', '--resume', 's3'],
    exe: '/opt/claude/versions/2.1.311',
    env: { TMUX: '/tmp/tmux-1000/silos,100,0', SILOS_AGENT_ID: 'writer', SILOS_SESSION_ID: 's3' },
  })
  // the claude-mem daemon and its two claude children
  addProc({
    pid: 200,
    ppid: 1,
    argv: ['/usr/lib/bun.exe', `${HOME}/.claude/plugins/cache/thedotmack/claude-mem/13.16.0/scripts/worker-service.cjs`, '--daemon'],
    exe: '/usr/lib/bun.exe',
  })
  addProc({ pid: 201, ppid: 200, argv: [`${HOME}/.local/bin/claude`, '--output-format', 'stream-json', '--verbose'], exe: '/opt/claude/versions/2.1.311' })
  addProc({ pid: 202, ppid: 200, argv: [`${HOME}/.local/bin/claude`, '--output-format', 'stream-json', '--verbose'], exe: '/opt/claude/versions/2.1.311' })
  // Silos' server and one SDK chat
  addProc({ pid: SELF, ppid: 1, argv: ['node', 'tsx', 'server/src/index.ts'], exe: '/usr/bin/node' })
  addProc({
    pid: 501,
    ppid: SELF,
    argv: ['/srv/node_modules/@anthropic-ai/claude-agent-sdk/claude', '--output-format', 'stream-json'],
    env: { SILOS_AGENT_ID: 'support' },
  })
  // a nested `claude -p` launched from the console claude 101
  addProc({ pid: 300, ppid: 101, argv: ['bash', '-c', 'claude -p "check the build"'], exe: '/usr/bin/bash' })
  addProc({
    pid: 301,
    ppid: 300,
    argv: ['claude', '-p', 'check the build'],
    env: { TMUX: '/tmp/tmux-1000/silos,100,0', SILOS_AGENT_ID: 'builder', SILOS_SESSION_ID: 's1' },
  })
  // the owner's own terminal: bash in their own tmux, a claude on the extra account
  addProc({ pid: 400, ppid: 1, argv: ['tmux', 'new', '-s', 'work'], exe: '/usr/bin/tmux' })
  addProc({ pid: 401, ppid: 400, argv: ['-bash'], exe: '/usr/bin/bash' })
  addProc({ pid: 402, ppid: 401, argv: ['claude'], env: { TMUX: '/tmp/tmux-1000/default,400,0', CLAUDE_CONFIG_DIR: extraDir } })
  // not Claude processes
  addProc({ pid: 600, ppid: 1, argv: ['vim', 'notes'] })
}

const accounts = () => [
  { name: 'default', configDir: join(HOME, '.claude') },
  { name: 'work', configDir: extraDir },
]
function classify(procs: ProcEntry[]) {
  return classifyAccountLoad({ procs, selfPid: SELF, tmuxSocket: 'silos', accounts: accounts(), home: HOME, now: 42 })
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silos-acload-'))
  proc = join(base, 'proc')
  extraDir = join(base, 'claude-accounts', 'work')
  mkdirSync(proc, { recursive: true })
  mkdirSync(extraDir, { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('readProcTable', () => {
  it('reads ppid past a comm with spaces and parens, and argv', () => {
    seedMachine()
    const t = readProcTable(proc)!.procs
    const tmux = t.find((p) => p.pid === 100)!
    expect(tmux.ppid).toBe(1)
    expect(tmux.argv.slice(0, 3)).toEqual(['tmux', '-L', 'silos'])
  })

  it('picks only the four env names, and only for Claude processes', () => {
    seedMachine()
    const t = readProcTable(proc)!.procs
    expect(t.find((p) => p.pid === 101)!.env).toEqual({ TMUX: '/tmp/tmux-1000/silos,100,0', SILOS_AGENT_ID: 'builder', SILOS_SESSION_ID: 's1' })
    expect(t.find((p) => p.pid === 200)!.env).toEqual({}) // the daemon: environ never read
    expect(JSON.stringify(t)).not.toContain(SECRET)
    expect(JSON.stringify(t)).not.toContain('PATH')
  })

  it('skips processes of another uid', () => {
    seedMachine()
    expect(readProcTable(proc, { uid: 999_999 })).toEqual({ procs: [], truncated: false })
  })

  it("caps the scan on the owner's own pids and says it was truncated", () => {
    seedMachine()
    expect(readProcTable(proc)!.truncated).toBe(false)
    const t = readProcTable(proc, { maxPids: 3 })!
    expect(t.procs.length).toBe(3)
    expect(t.truncated).toBe(true)
  })

  it("other users' pids never eat the cap", () => {
    seedMachine()
    const mine = readProcTable(proc)!.procs.length
    // every fake pid is ours: other uids' pids are skipped BEFORE counting,
    // so a different uid sees zero of ours and never trips the cap
    expect(readProcTable(proc, { maxPids: mine })).toMatchObject({ truncated: false })
    expect(readProcTable(proc, { uid: 999_999, maxPids: 1 })).toEqual({ procs: [], truncated: false })
  })

  it('an unreadable root is null (unsupported), not an empty table', () => {
    expect(readProcTable(join(base, 'nope'))).toBeNull()
  })
})

describe('classifyAccountLoad', () => {
  it("the owner's machine: consoles by agent, nested, Silos chats, a plugin outside, the extra account apart", () => {
    seedMachine()
    const r = classify(readProcTable(proc)!.procs)
    expect(r).toEqual({
      supported: true,
      at: 42,
      truncated: false,
      accounts: [
        {
          account: 'default',
          total: 7,
          bySource: { console: 3, silos: 1, nested: 1, outside: 2 },
          outside: [{ label: 'claude-mem plugin', count: 2 }],
          consoles: [
            { agentId: 'builder', count: 2 },
            { agentId: 'writer', count: 1 },
          ],
        },
        {
          account: 'work',
          total: 1,
          bySource: { console: 0, silos: 0, nested: 0, outside: 1 },
          outside: [{ label: 'tmux', count: 1 }],
          consoles: [],
        },
      ],
    })
  })

  it('a shell wrapper that mentions claude is not a Claude process', () => {
    addProc({ pid: 10, ppid: 1, argv: ['bash', '-c', 'claude --print hi'] })
    addProc({ pid: 11, ppid: 1, argv: ['/usr/bin/claude-code-helper'] })
    expect(classify(readProcTable(proc)!.procs).accounts).toEqual([])
  })

  it('a console is recognised by its tmux ancestor alone (no TMUX env)', () => {
    addProc({ pid: 100, ppid: 1, argv: ['tmux', '-Lsilos', 'new-session'] })
    addProc({ pid: 101, ppid: 100, argv: ['claude'], env: { SILOS_AGENT_ID: 'builder' } })
    expect(classify(readProcTable(proc)!.procs).accounts[0]!.bySource.console).toBe(1)
  })

  it("another tmux socket is not Silos' (the e2e's own, the owner's own)", () => {
    addProc({ pid: 100, ppid: 1, argv: ['tmux', '-L', 'silos-e2e', 'new-session'] })
    addProc({ pid: 101, ppid: 100, argv: ['claude'], env: { TMUX: '/tmp/tmux-1000/silos-e2e,100,0' } })
    const a = classify(readProcTable(proc)!.procs).accounts[0]!
    expect(a.bySource).toEqual({ console: 0, silos: 0, nested: 0, outside: 1 })
    expect(a.outside).toEqual([{ label: 'tmux', count: 1 }])
  })

  it('a console without SILOS_AGENT_ID counts with no agent', () => {
    addProc({ pid: 100, ppid: 1, argv: ['tmux', '-L', 'silos'] })
    addProc({ pid: 101, ppid: 100, argv: ['claude'], env: { TMUX: '/tmp/tmux-1000/silos,100,0' } })
    expect(classify(readProcTable(proc)!.procs).accounts[0]!.consoles).toEqual([{ count: 1 }])
  })

  it('a claude under another claude WITHOUT SILOS_SESSION_ID is not nested', () => {
    addProc({ pid: 10, ppid: 1, argv: ['sshd: op@pts/0'] })
    addProc({ pid: 11, ppid: 10, argv: ['claude'] })
    addProc({ pid: 12, ppid: 11, argv: ['claude', '-p', 'x'] })
    const a = classify(readProcTable(proc)!.procs).accounts[0]!
    expect(a.bySource.nested).toBe(0)
    // a rewritten process title ("sshd: op@pts/0") is named by its program
    expect(a.outside).toEqual([
      { label: 'sshd', count: 1 },
      { label: 'claude', count: 1 },
    ])
    expect(a.bySource.outside).toBe(2)
  })

  it("an SDK child carrying Silos' TMUX (server started inside a console) is a Silos chat", () => {
    addProc({ pid: 100, ppid: 1, argv: ['tmux', '-L', 'silos', 'new-session'] })
    addProc({ pid: 110, ppid: 100, argv: ['bash'] })
    addProc({ pid: SELF, ppid: 110, argv: ['node', 'server.js'] })
    addProc({ pid: 501, ppid: SELF, argv: ['/sdk/claude'], env: { TMUX: '/tmp/tmux-1000/silos,100,0', SILOS_SESSION_ID: 'c1', SILOS_AGENT_ID: 'builder' } })
    expect(classify(readProcTable(proc)!.procs).accounts[0]!.bySource).toEqual({ console: 0, silos: 1, nested: 0, outside: 0 })
  })

  it('an SDK child under a server that itself has a claude ancestor is a Silos chat', () => {
    addProc({ pid: 100, ppid: 1, argv: ['claude'] })
    addProc({ pid: 110, ppid: 100, argv: ['bash', '-c', 'npm run dev'] })
    addProc({ pid: SELF, ppid: 110, argv: ['node', 'server.js'] })
    addProc({ pid: 501, ppid: SELF, argv: ['/sdk/claude'], env: { SILOS_SESSION_ID: 'c1' } })
    expect(classify(readProcTable(proc)!.procs).accounts[0]!.bySource).toEqual({ console: 0, silos: 1, nested: 0, outside: 1 })
  })

  it('`claude -p` inside a console is nested; the console stays a console', () => {
    addProc({ pid: 100, ppid: 1, argv: ['tmux', '-L', 'silos'] })
    addProc({ pid: 101, ppid: 100, argv: ['claude'], env: { TMUX: '/tmp/tmux-1000/silos,100,0', SILOS_SESSION_ID: 's1', SILOS_AGENT_ID: 'builder' } })
    addProc({
      pid: 102,
      ppid: 101,
      argv: ['claude', '-p', 'x'],
      env: { TMUX: '/tmp/tmux-1000/silos,100,0', SILOS_SESSION_ID: 's1', SILOS_AGENT_ID: 'builder' },
    })
    const a = classify(readProcTable(proc)!.procs).accounts[0]!
    expect(a.bySource).toEqual({ console: 1, silos: 0, nested: 1, outside: 0 })
    expect(a.consoles).toEqual([{ agentId: 'builder', count: 1 }])
  })

  it('the TMUX value is only a fallback when the ancestry names no launcher', () => {
    addProc({ pid: 101, ppid: 1, argv: ['claude'], env: { TMUX: '/tmp/tmux-1000/silos,100,0' } })
    expect(classify(readProcTable(proc)!.procs).accounts[0]!.bySource.console).toBe(1)
  })

  it('a rewritten title never leaks its arguments into the label', () => {
    addProc({ pid: 10, ppid: 1, argv: ['x.py --token=abc secret'] })
    addProc({ pid: 11, ppid: 10, argv: ['claude'] })
    addProc({ pid: 20, ppid: 1, argv: [`/opt/${'a'.repeat(60)}`] })
    addProc({ pid: 21, ppid: 20, argv: ['claude'] })
    const labels = classify(readProcTable(proc)!.procs).accounts[0]!.outside.map((o) => o.label)
    expect(labels).toContain('x.py')
    expect(labels).toContain('a'.repeat(32))
    expect(JSON.stringify(labels)).not.toContain('abc')
  })

  it('a nested run under an SDK chat is nested, not a Silos chat', () => {
    addProc({ pid: SELF, ppid: 1, argv: ['node', 'server.js'] })
    addProc({ pid: 501, ppid: SELF, argv: ['/sdk/claude'], env: { SILOS_SESSION_ID: 'c1' } })
    addProc({ pid: 502, ppid: 501, argv: ['claude', '-p', 'x'], env: { SILOS_SESSION_ID: 'c1' } })
    expect(classify(readProcTable(proc)!.procs).accounts[0]!.bySource).toEqual({ console: 0, silos: 1, nested: 1, outside: 0 })
  })

  it('outside with no named launcher (reparented, or only shells) is "terminal"', () => {
    addProc({ pid: 10, ppid: 1, argv: ['claude'] })
    addProc({ pid: 20, ppid: 1, argv: ['zsh'] })
    addProc({ pid: 21, ppid: 20, argv: ['claude'] })
    expect(classify(readProcTable(proc)!.procs).accounts[0]!.outside).toEqual([{ label: 'terminal', count: 2 }])
  })

  it('outside names the nearest non-shell launcher', () => {
    addProc({ pid: 10, ppid: 1, argv: ['/usr/share/code/code', '--type=extensionHost'] })
    addProc({ pid: 11, ppid: 10, argv: ['/bin/sh', '-c', 'x'] })
    addProc({ pid: 12, ppid: 11, argv: ['claude'] })
    expect(classify(readProcTable(proc)!.procs).accounts[0]!.outside).toEqual([{ label: 'code', count: 1 }])
  })

  it('CLAUDE_CONFIG_DIR set to ~/.claude is the default account; an unknown dir is named by its path', () => {
    addProc({ pid: 10, ppid: 1, argv: ['claude'], env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude/` } })
    addProc({ pid: 11, ppid: 1, argv: ['claude'], env: { CLAUDE_CONFIG_DIR: `${HOME}/other-claude` } })
    const r = classify(readProcTable(proc)!.procs)
    expect(r.accounts.map((a) => [a.account, a.total])).toEqual([
      ['default', 1],
      ['~/other-claude', 1],
    ])
  })

  it('no environ value other than the four names ever surfaces in the result', () => {
    seedMachine()
    const out = JSON.stringify(classify(readProcTable(proc)!.procs))
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain('ANTHROPIC_API_KEY')
    expect(out).not.toContain('/usr/bin') // PATH
  })
})

describe('AccountLoadService', () => {
  it('caches a snapshot for the ttl, then rescans', () => {
    seedMachine()
    let now = 1000
    const svc = new AccountLoadService({
      tmuxSocket: 'silos',
      accounts,
      home: HOME,
      procRoot: proc,
      selfPid: SELF,
      platform: 'linux',
      ttlMs: 5000,
      now: () => now,
    })
    const first = svc.snapshot()
    addProc({ pid: 700, ppid: 1, argv: ['claude'] })
    now = 3000
    expect(svc.snapshot()).toBe(first)
    now = 7000
    const again = svc.snapshot()
    expect(again.supported && again.accounts[0]!.total).toBe(8)
    expect(again.supported && again.truncated).toBe(false)
  })

  it('not Linux, or /proc unreadable → unsupported', () => {
    expect(new AccountLoadService({ tmuxSocket: 'silos', accounts, home: HOME, procRoot: proc, platform: 'darwin' }).snapshot()).toEqual({ supported: false })
    expect(new AccountLoadService({ tmuxSocket: 'silos', accounts, home: HOME, procRoot: join(base, 'nope'), platform: 'linux' }).snapshot()).toEqual({
      supported: false,
    })
  })
})

describe('GET /api/account-load', () => {
  let app: FastifyInstance, tokens: AgentTokens
  const LOCAL = { host: '127.0.0.1:3210' }
  beforeEach(async () => {
    seedMachine()
    const root = join(base, 'projects')
    const data = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(data, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(data, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(data, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder: base })
    const native = new NativeStore(join(data, 'native.json'))
    tokens = new AgentTokens(data)
    app = buildServer({
      index,
      registry,
      native,
      chat: new ChatService({
        registry,
        native,
        queryFn: () => {
          throw new Error('no sdk')
        },
      }),
      store: new SessionStore(root, data),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(data),
      memory: new MemoryService(root, data, registry),
      token: 't0k',
      liveMs: 120_000,
      agentTokens: tokens,
      accountLoad: new AccountLoadService({ tmuxSocket: 'silos', accounts, home: HOME, procRoot: proc, selfPid: SELF, platform: 'linux' }),
    })
  })
  afterEach(async () => {
    await app.close()
  })

  it('the owner reads it (200)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/account-load', headers: LOCAL })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.supported).toBe(true)
    expect(body.accounts[0].bySource.console).toBe(3)
    expect(r.body).not.toContain(SECRET)
  })

  it('an agent bearer cannot dodge it by encoding /api (GET /%61pi/account-load → 403)', async () => {
    const r = await app.inject({ method: 'GET', url: '/%61pi/account-load', headers: { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('builder')}` } })
    expect(r.statusCode).toBe(403)
    expect(r.body).not.toContain('bySource')
  })

  it('an absolute-form request target (GET http://x/api/account-load) is refused 400', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const lines = [
      'GET http://x/api/account-load HTTP/1.1',
      'Host: silos.example.com',
      'CF-Connecting-IP: 1.2.3.4',
      `Authorization: Bearer ${tokens.tokenFor('builder')}`,
      'Connection: close',
    ]
    const res = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`${lines.join('\r\n')}\r\n\r\n`))
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString()
      })
      sock.on('close', () => resolve(buf))
      sock.on('error', reject)
    })
    expect(res.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 400/)
    expect(res).not.toContain('bySource')
  })

  it('an agent bearer is refused (403)', async () => {
    const tok = tokens.tokenFor('builder')
    const r = await app.inject({ method: 'GET', url: '/api/account-load', headers: { ...LOCAL, authorization: `Bearer ${tok}` } })
    expect(r.statusCode).toBe(403)
  })
})
