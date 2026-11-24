// harness.test.ts — the harness (Claude Code): ONE `claude` on PATH runs the
// consoles and the chat turns, the Agent SDK library it is paired with, what
// npm says is published (cached), the compatibility verdicts and the gate,
// and the one-at-a-time `claude update`. A fake `run` stands in for every
// process: nothing real is spawned, no network.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessService } from '../src/harness.js'
import { compareVersions, parseVersion, type RunFn } from '../src/harness-run.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'

interface FakeState {
  installed: string
  latest: string | Error
  update: 'ok' | 'fail' | 'hang'
}
interface Fake {
  run: RunFn
  calls: string[]
  state: FakeState
  release: () => void
}

const CLAUDE = '/home/u/.local/bin/claude'
const PAIRING = { library: '0.3.319', pairedWith: '2.1.319' }

function fake(installed = '2.1.319', latest: string | Error = '2.1.320'): Fake {
  const calls: string[] = []
  let release = (): void => {}
  const state: FakeState = { installed, latest, update: 'ok' }
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === CLAUDE && args[0] === '--version') return { stdout: `${state.installed} (Claude Code)\n`, stderr: '' }
    if (cmd === 'npm') {
      if (state.latest instanceof Error) throw state.latest
      return { stdout: `${state.latest}\n`, stderr: '' }
    }
    if (cmd === 'claude' && args[0] === 'update') {
      if (state.update === 'hang')
        await new Promise<void>((r) => {
          release = r
        })
      if (state.update === 'fail')
        throw Object.assign(new Error('Command failed'), { stdout: 'Checking for updates...\n', stderr: '\x1b[31mError: permission denied\x1b[0m\n' })
      const from = state.installed
      if (typeof state.latest === 'string') state.installed = state.latest
      return { stdout: `Current version: ${from}\r\nChecking for updates...\nSuccessfully updated to version ${state.installed}\n`, stderr: '' }
    }
    throw new Error(`unexpected ${cmd}`)
  }
  return { run, calls, state, release: () => release() }
}

const svc = (f: Fake, now = () => 0, onPath: string | null = CLAUDE) =>
  new HarnessService({ run: f.run, engines: { 'claude-code': { resolve: () => onPath, pairing: () => PAIRING } }, now })

describe('versions', () => {
  it('parses `claude --version` and compares numerically', () => {
    expect(parseVersion('2.1.304 (Claude Code)')).toBe('2.1.304')
    expect(parseVersion('nothing here')).toBeNull()
    expect(compareVersions('2.1.310', '2.1.304')).toBeGreaterThan(0)
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
    expect(compareVersions('2.1.304', '2.1.304')).toBe(0)
  })
})

describe('HarnessService.status', () => {
  it('reports the one claude (consoles and chats), the SDK library and its pairing, and the latest published', async () => {
    const s = await svc(fake()).status()
    expect(s).toMatchObject({
      harness: 'claude-code',
      name: 'Claude Code',
      console: { version: '2.1.319', path: CLAUDE },
      library: { name: 'Agent SDK', version: '0.3.319', pairedWith: '2.1.319' },
      latest: '2.1.320',
    })
    expect(s).not.toHaveProperty('chat')
    expect(typeof s.checkedAt).toBe('string')
    expect(s.compat.find((c) => c.harness === 'claude-code')).toMatchObject({ state: 'ok', installed: '2.1.319', needed: '2.1.319', refuses: [] })
  })

  it('caches the npm lookup ~10 min', async () => {
    let t = 0
    const f = fake()
    const h = svc(f, () => t)
    await h.status()
    await h.status()
    expect(f.calls.filter((c) => c.startsWith('npm'))).toHaveLength(1)
    t = 11 * 60_000
    await h.status()
    expect(f.calls.filter((c) => c.startsWith('npm'))).toHaveLength(2)
  })

  it('npm unreachable → latest null (retried after a minute), the rest still reported', async () => {
    let t = 0
    const f = fake('2.1.319', new Error('ENOTFOUND registry.npmjs.org'))
    const h = svc(f, () => t)
    const s = await h.status()
    expect(s.latest).toBeNull()
    expect(s.console.version).toBe('2.1.319')
    t = 61_000
    f.state.latest = '2.1.320'
    expect((await h.status()).latest).toBe('2.1.320')
  })

  it('no claude on PATH → no version, never run', async () => {
    const f = fake()
    const s = await svc(f, () => 0, null).status()
    expect(s.console).toEqual({ version: null, path: null })
    expect(f.calls.some((c) => c.includes('--version') && c.startsWith(CLAUDE))).toBe(false)
  })
})

describe('compatibility — Claude Code against the SDK pairing', () => {
  const verdict = async (installed: string, onPath: string | null = CLAUDE) => (await svc(fake(installed), () => 0, onPath).compatOf('claude-code'))!

  it('older than the pairing → outdated: consoles and chats refused, «claude update»', async () => {
    const c = await verdict('2.1.304')
    expect(c).toMatchObject({ state: 'outdated', installed: '2.1.304', needed: '2.1.319', update: 'claude update', refuses: ['console', 'chat'] })
    expect(c.message).toBe('Claude Code 2.1.304 is older than Silos needs (2.1.319) — update it: claude update')
  })

  it('missing → refused, with the native installer', async () => {
    const c = await verdict('2.1.319', null)
    expect(c).toMatchObject({ state: 'missing', installed: null, refuses: ['console', 'chat'] })
    expect(c.message).toContain('Silos needs Claude Code 2.1.319 or newer')
  })

  it('a newer 2.1 patch → ahead: chats keep running, Silos is told the matching SDK', async () => {
    const c = await verdict('2.1.322')
    expect(c).toMatchObject({
      state: 'ahead',
      installed: '2.1.322',
      refuses: [],
      update: 'npm install -w server --save-exact @anthropic-ai/claude-agent-sdk@0.3.322',
    })
    expect(c.message).toBe(
      "Claude Code 2.1.322 is newer than Silos' Agent SDK 0.3.319 (paired with Claude Code 2.1.319) — chats keep running; update Silos to Agent SDK 0.3.322: npm install -w server --save-exact @anthropic-ai/claude-agent-sdk@0.3.322",
    )
  })

  it('a newer line (2.2.x) → ahead, nothing refused (an auto-update never stops Silos)', async () => {
    const c = await verdict('2.2.0')
    expect(c).toMatchObject({ state: 'ahead', refuses: [] })
    expect(c.message).toContain('chats keep running, but Silos is not yet verified with 2.2.x')
  })

  it('the gate: refusal() says the line for a refused part, null otherwise; a refusing verdict is re-read first', async () => {
    let t = 0
    const f = fake('2.1.304')
    const h = svc(f, () => t)
    expect(await h.refusal('claude-code', 'console')).toBe('Claude Code 2.1.304 is older than Silos needs (2.1.319) — update it: claude update')
    // the owner updates in a shell: the next gate re-reads before refusing
    f.state.installed = '2.1.319'
    expect(await h.refusal('claude-code', 'chat')).toBeNull()
    // an ok verdict is cached (no probe per turn) for a minute
    const probes = f.calls.filter((c) => c.endsWith('--version')).length
    await h.refusal('claude-code', 'chat')
    expect(f.calls.filter((c) => c.endsWith('--version')).length).toBe(probes)
    expect(h.peekCompatibility().find((c) => c.harness === 'claude-code')?.state).toBe('ok')
    t = 61_000
    await h.refusal('claude-code', 'chat')
    expect(f.calls.filter((c) => c.endsWith('--version')).length).toBe(probes + 1)
  })
})

describe('HarnessService.update', () => {
  it('runs `claude update` and returns before/after with clean output; the verdict is read again', async () => {
    const f = fake('2.1.304', '2.1.319')
    const h = svc(f)
    expect((await h.compatOf('claude-code'))?.state).toBe('outdated')
    const r = await h.update()
    expect(r.before).toBe('2.1.304')
    expect(r.after).toBe('2.1.319')
    expect(r.output).toContain('Successfully updated to version 2.1.319')
    expect(r.output).not.toContain('\r')
    expect(f.calls).toContain('claude update')
    expect((await h.compatOf('claude-code'))?.state).toBe('ok')
  })
})

describe('/api/harness routes', () => {
  async function app(f: Fake | null) {
    const base = mkdtempSync(join(tmpdir(), 'harness-api-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    const native = new NativeStore(join(dataDir, 'native.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    return buildServer({
      index,
      registry,
      store: new SessionStore(root, dataDir),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: 't',
      liveMs: 120_000,
      ...(f ? { harness: svc(f) } : {}),
    })
  }
  const H = { 'x-token': 't' }

  it('GET /api/harness returns the status', async () => {
    const a = await app(fake())
    const res = await a.inject({ url: '/api/harness', headers: H })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ console: { version: '2.1.319' }, library: { version: '0.3.319', pairedWith: '2.1.319' }, latest: '2.1.320' })
  })

  it('POST /api/harness/update updates; a second one while running → 409', async () => {
    const f = fake()
    f.state.update = 'hang'
    const a = await app(f)
    const first = a.inject({ method: 'POST', url: '/api/harness/update', headers: H })
    await new Promise((r) => setTimeout(r, 20))
    const second = await a.inject({ method: 'POST', url: '/api/harness/update', headers: H })
    expect(second.statusCode).toBe(409)
    f.release()
    const done = await first
    expect(done.statusCode).toBe(200)
    expect(done.json()).toMatchObject({ before: '2.1.319', after: '2.1.320' })
    // the lock is released: another update runs again
    f.state.update = 'ok'
    expect((await a.inject({ method: 'POST', url: '/api/harness/update', headers: H })).statusCode).toBe(200)
  })

  it('a failed `claude update` → 502 saying what failed, output attached', async () => {
    const f = fake()
    f.state.update = 'fail'
    const a = await app(f)
    const res = await a.inject({ method: 'POST', url: '/api/harness/update', headers: H })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('claude update failed: Error: permission denied')
    expect(res.json().output).toContain('Checking for updates...')
  })

  it('without a harness the routes are not registered', async () => {
    const a = await app(null)
    expect((await a.inject({ url: '/api/harness', headers: H })).statusCode).toBe(404)
  })
})
