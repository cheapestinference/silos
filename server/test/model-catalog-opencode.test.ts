// model-catalog-opencode.test.ts — the model catalogue per harness:
// OpenCode's list is `opencode models` (one provider/model per line),
// cached apart from Claude's, filtered to the providers an agent can reach;
// and the OpenCode row of Settings › Account (HarnessService.others,
// `opencode upgrade`). Fake runs only: nothing real is spawned.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { ModelCatalog, type ModelInfo } from '../src/model-catalog.js'
import { fetchOpenCodeModels } from '../src/harnesses/opencode/models.js'
import { HarnessService } from '../src/harness.js'
import type { RunFn } from '../src/harness-run.js'
import { OpencodeVersionProbe } from '../src/harnesses/opencode/tui-auth.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { ProvidersStore } from '../src/providers-store.js'
import { AccountsService } from '../src/harnesses/claude-code/accounts.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'
import { fakeIdentity } from './helpers/fake-claude-auth.js'

// `opencode models`, 25 lines in the shape captured on this machine 26-10 (1.14.22)
const LINES = [
  'opencode/big-pickle',
  'opencode/deepseek-v4.1-flash-free',
  'opencode/flint-40b-free',
  'opencode/glm-5.3-flash-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free',
  'minimax-coding-plan/MiniMax-M2.7',
  'minimax-coding-plan/MiniMax-M3',
  'minimax-coding-plan/MiniMax-M3.1-Flash',
  'kimi-for-coding/k3',
  'kimi-for-coding/kimi-k2-thinking',
  'zai-coding-plan/glm-5.3',
  'zai-coding-plan/glm-5.3-flash',
  'zai-coding-plan/glm-5.3-highspeed',
  'zai/glm-5.1',
  'zai/glm-5',
  'zai/glm-5-turbo',
  'zai/glm-4.5',
  'zai/glm-4.5-air',
  'zai/glm-4.5-flash',
  'zai/glm-4.5v',
  'zai/glm-4.6',
  'zai/glm-4.6v',
  'zai/glm-4.7',
]
const modelsRun =
  (stdout: string): RunFn =>
  async (cmd, args) => {
    if (args[0] === 'models') return { stdout, stderr: '' }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`)
  }

describe('fetchOpenCodeModels', () => {
  it('parses one provider/model per line into ModelInfo', async () => {
    expect(LINES).toHaveLength(25)
    const models = await fetchOpenCodeModels(modelsRun(LINES.join('\n') + '\n'), 'opencode')
    expect(models).toHaveLength(25)
    expect(models[0]).toEqual({ value: 'opencode/big-pickle', displayName: 'big-pickle', description: 'opencode' })
    expect(models[24]).toEqual({ value: 'zai/glm-4.7', displayName: 'glm-4.7', description: 'zai' })
  })
  it('skips noise (warnings, colour, blanks) and duplicates', async () => {
    const out = '\x1b[33mWARN\x1b[0m something happened\n\nzai/glm-5.1\r\nzai/glm-5.1\nnot a model\n'
    expect(await fetchOpenCodeModels(modelsRun(out), 'opencode')).toEqual([{ value: 'zai/glm-5.1', displayName: 'glm-5.1', description: 'zai' }])
  })
})

describe('ModelCatalog.viewFor', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deck-catalog-oc-'))
  })
  const CLAUDE: ModelInfo[] = [{ value: 'sonnet', displayName: 'Sonnet' }]

  it('claude-code is the long-standing view; opencode is cached apart in cache/models-opencode.json', async () => {
    const c = new ModelCatalog(
      dir,
      { 'claude-code': async () => CLAUDE, opencode: () => fetchOpenCodeModels(modelsRun(LINES.join('\n')), 'opencode') },
      () => new Date('2026-10-26T10:00:00Z'),
    )
    c.load()
    await c.refresh()
    expect(c.viewFor('claude-code')).toEqual(c.view())
    expect(c.view().models.map((m) => m.value)).toEqual(['sonnet'])
    expect(c.viewFor('opencode')).toEqual({ models: [], fetchedAt: null })
    const v = await c.refresh('opencode')
    expect(v.models).toHaveLength(25)
    expect(v.fetchedAt).toBe('2026-10-26T10:00:00.000Z')
    expect(c.view().models.map((m) => m.value)).toEqual(['sonnet'])
    const file = join(dir, 'cache', 'models-opencode.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).models).toHaveLength(25)
    const again = new ModelCatalog(dir)
    again.load()
    expect(again.viewFor('opencode').models).toHaveLength(25)
    expect(again.view().models.map((m) => m.value)).toEqual(['sonnet'])
  })
  it("maybeRefreshOnBoot also fetches OpenCode's list when cache/models-opencode.json is missing — once, never blocking on a failure", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const oc = vi.fn(() => fetchOpenCodeModels(modelsRun(LINES.join('\n')), 'opencode'))
    const c = new ModelCatalog(dir, { 'claude-code': async () => CLAUDE, opencode: oc })
    c.load()
    await c.maybeRefreshOnBoot()
    expect(oc).toHaveBeenCalledTimes(1)
    expect(existsSync(join(dir, 'cache', 'models-opencode.json'))).toBe(true)
    const c2 = new ModelCatalog(dir, { 'claude-code': async () => CLAUDE, opencode: oc })
    c2.load()
    await c2.maybeRefreshOnBoot()
    expect(oc).toHaveBeenCalledTimes(1) // the file exists: nothing spawned

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const empty = mkdtempSync(join(tmpdir(), 'deck-catalog-oc-fail-'))
    const failing = new ModelCatalog(empty, {
      'claude-code': async () => CLAUDE,
      opencode: async () => {
        throw new Error('opencode: not found')
      },
    })
    failing.load()
    await expect(failing.maybeRefreshOnBoot()).resolves.toBeUndefined()
    expect(failing.view().models.map((m) => m.value)).toEqual(['sonnet']) // Claude's list still came in
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('opencode models'), 'opencode: not found')
  })
  it('opencode without a source: refresh rejects, nothing written', async () => {
    const c = new ModelCatalog(dir)
    await expect(c.refresh('opencode')).rejects.toThrow(/opencode models/)
    expect(existsSync(join(dir, 'cache', 'models-opencode.json'))).toBe(false)
  })
})

describe('GET /api/models?harness=opencode — filtered to what an agent can reach', () => {
  let app: FastifyInstance, providers: ProvidersStore, registry: AgentRegistry
  let ocData: string,
    opencodeCalls = 0
  const prev = process.env.SILOS_OPENCODE_DATA

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-models-oc-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    ocData = join(base, 'xdg')
    mkdirSync(join(ocData, 'opencode'), { recursive: true })
    writeFileSync(
      join(ocData, 'opencode', 'auth.json'),
      JSON.stringify({ zai: { type: 'api', key: 'sk-zai-0000000000' }, 'kimi-for-coding': { type: 'api', key: 'sk-kimi-000000000' } }),
    )
    process.env.SILOS_OPENCODE_DATA = ocData
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    providers = new ProvidersStore(dataDir)
    providers.load()
    const accounts = new AccountsService({ dataDir, defaultConfigDir: join(base, 'dot-claude'), identity: fakeIdentity(join(base, 'dot-claude')) })
    opencodeCalls = 0
    const catalog = new ModelCatalog(dataDir, {
      'claude-code': async () => [{ value: 'sonnet', displayName: 'Sonnet' }],
      opencode: async () => {
        opencodeCalls++
        return fetchOpenCodeModels(modelsRun(LINES.join('\n')), 'opencode')
      },
    })
    catalog.load()
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
      providers,
    })
    app = buildServer({
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
      providers,
      accounts,
      catalog,
      home: base,
    })
    asOwner(app, 't')
  })
  afterEach(async () => {
    await app.close()
    if (prev === undefined) delete process.env.SILOS_OPENCODE_DATA
    else process.env.SILOS_OPENCODE_DATA = prev
  })
  const H = { host: '127.0.0.1:3210' }
  const values = async (url: string) => ((await app.inject({ url, headers: H })).json() as { models: ModelInfo[] }).models.map((m) => m.value)
  const providersOf = async (url: string) => [...new Set((await values(url)).map((v) => v.split('/')[0]))].sort()

  it('POST /api/models/refresh?harness=opencode runs `opencode models`; the Claude list is untouched', async () => {
    expect(await values('/api/models?harness=opencode')).toEqual([])
    const r = await app.inject({ method: 'POST', url: '/api/models/refresh?harness=opencode', headers: H })
    expect(r.statusCode).toBe(200)
    expect(opencodeCalls).toBe(1)
    expect(await values('/api/models?harness=opencode')).toHaveLength(25)
    expect(await values('/api/models')).toEqual([])
    expect((await app.inject({ url: '/api/models?harness=vim', headers: H })).statusCode).toBe(400)
  })

  it('provider=default → every auth.json login + the free opencode tier; a harness-provider → its id; anthropic-compatible → silos-<id>', async () => {
    await app.inject({ method: 'POST', url: '/api/models/refresh?harness=opencode', headers: H })
    expect(await providersOf('/api/models?harness=opencode&provider=default')).toEqual(['kimi-for-coding', 'opencode', 'zai'])
    const mm = providers.create({
      kind: 'harness-provider',
      label: 'MiniMax',
      harness: 'opencode',
      providerId: 'minimax-coding-plan',
      apiKey: 'mm-secret-key-123456',
    })
    expect(await providersOf(`/api/models?harness=opencode&provider=${mm.id}`)).toEqual(['minimax-coding-plan'])
    const hn = providers.create({ kind: 'harness-native', label: 'Z', harness: 'opencode', providerId: 'zai-coding-plan' })
    expect(await providersOf(`/api/models?harness=opencode&provider=${hn.id}`)).toEqual(['zai-coding-plan'])
    const ac = providers.create({ kind: 'anthropic-compatible', label: 'CI', baseUrl: 'https://x.test', apiKey: 'sk-live-abcdef123456' })
    expect(await values(`/api/models?harness=opencode&provider=${ac.id}`)).toEqual([]) // silos-<id> is injected per process, not in `opencode models`
    expect((await app.inject({ url: '/api/models?harness=opencode&provider=nope', headers: H })).statusCode).toBe(400)
  })

  it("agentId → the union over the agent's provider and fallback", async () => {
    await app.inject({ method: 'POST', url: '/api/models/refresh?harness=opencode', headers: H })
    const mm = providers.create({
      kind: 'harness-provider',
      label: 'MiniMax',
      harness: 'opencode',
      providerId: 'minimax-coding-plan',
      apiKey: 'mm-secret-key-123456',
    })
    const hn = providers.create({ kind: 'harness-native', label: 'K', harness: 'opencode', providerId: 'kimi-for-coding' })
    registry.create({ id: 'oc', name: 'Oc', folder: '/tmp/p', framework: 'opencode', provider: mm.id, fallback: [hn.id] })
    expect(await providersOf('/api/models?harness=opencode&agentId=oc')).toEqual(['kimi-for-coding', 'minimax-coding-plan'])
    registry.create({ id: 'oc2', name: 'Oc2', folder: '/tmp/p', framework: 'opencode' })
    expect(await providersOf('/api/models?harness=opencode&agentId=oc2')).toEqual(['kimi-for-coding', 'opencode', 'zai'])
    expect((await app.inject({ url: '/api/models?harness=opencode&agentId=ghost', headers: H })).statusCode).toBe(404)
  })
})

describe('HarnessService — the OpenCode row', () => {
  function fake(opts: { opencode?: string | null; upgradeTo?: string } = {}) {
    const calls: string[] = []
    const state = { oc: opts.opencode === undefined ? '1.14.22' : opts.opencode }
    const run: RunFn = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === '/home/u/.local/bin/claude' && args[0] === '--version') return { stdout: '2.1.319 (Claude Code)\n', stderr: '' }
      if (cmd === 'which' && args[0] === 'opencode') {
        if (state.oc === null) throw new Error('not found')
        return { stdout: '/home/u/.opencode/bin/opencode\n', stderr: '' }
      }
      if (cmd === 'npm') return { stdout: '2.1.310\n', stderr: '' }
      if (cmd === 'opencode' && args[0] === '--version') {
        if (state.oc === null) throw Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
        return { stdout: `${state.oc}\n`, stderr: '' }
      }
      if (cmd === 'opencode' && args[0] === 'upgrade') {
        const from = state.oc
        state.oc = opts.upgradeTo ?? state.oc
        return { stdout: `Upgrading from ${from} to ${state.oc}\nDone\n`, stderr: '' }
      }
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`)
    }
    return { run, calls, state }
  }

  it('status().others[0]: OpenCode version (via the shared probe) and path, latest null', async () => {
    const f = fake()
    const probe = new OpencodeVersionProbe({ run: f.run, bin: () => 'opencode' })
    const s = await new HarnessService({
      run: f.run,
      engines: { 'claude-code': { resolve: () => '/home/u/.local/bin/claude' }, opencode: { cmd: 'opencode', probe } },
    }).status()
    expect(s.others).toEqual([{ harness: 'opencode', name: 'OpenCode', version: '1.14.22', path: '/home/u/.opencode/bin/opencode', latest: null }])
    expect(s.console.version).toBe('2.1.319')
  })

  it('not installed → version and path null', async () => {
    const f = fake({ opencode: null })
    const s = await new HarnessService({
      run: f.run,
      engines: { 'claude-code': { resolve: () => '/home/u/.local/bin/claude' }, opencode: { cmd: 'opencode' } },
    }).status()
    expect(s.others[0]).toEqual({ harness: 'opencode', name: 'OpenCode', version: null, path: null, latest: null })
  })

  it('an absolute SILOS_OPENCODE_BIN is its own path (no `which`)', async () => {
    const f = fake()
    const run: RunFn = async (cmd, args, o) => f.run(cmd === '/opt/oc/opencode' ? 'opencode' : cmd, args, o)
    const s = await new HarnessService({
      run,
      engines: { 'claude-code': { resolve: () => '/home/u/.local/bin/claude' }, opencode: { cmd: '/opt/oc/opencode' } },
    }).status()
    expect(s.others[0]!.path).toBe('/opt/oc/opencode')
    expect(f.calls).not.toContain('which /opt/oc/opencode')
  })

  it("update('opencode') runs `opencode upgrade`, re-reads the version through the probe; claude is never touched", async () => {
    const f = fake({ upgradeTo: '1.15.0' })
    const probe = new OpencodeVersionProbe({ run: f.run, bin: () => 'opencode' })
    const h = new HarnessService({
      run: f.run,
      engines: { 'claude-code': { resolve: () => '/home/u/.local/bin/claude' }, opencode: { cmd: 'opencode', probe } },
    })
    const r = await h.update('opencode')
    expect(r).toMatchObject({ before: '1.14.22', after: '1.15.0' })
    expect(r.output).toContain('Done')
    expect(f.calls).toContain('opencode upgrade')
    expect(f.calls).not.toContain('claude update')
    expect(await probe.version()).toBe('1.15.0') // the console's auth gate sees the new version too
  })

  it('POST /api/harness/update { harness: "opencode" } → opencode upgrade; an unknown harness → 400', async () => {
    const f = fake({ upgradeTo: '1.15.0' })
    const base = mkdtempSync(join(tmpdir(), 'harness-oc-api-'))
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
    const app = buildServer({
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
      harness: new HarnessService({ run: f.run, engines: { 'claude-code': { resolve: () => '/home/u/.local/bin/claude' }, opencode: { cmd: 'opencode' } } }),
    })
    asOwner(app, 't')
    const H = { host: '127.0.0.1:3210', 'content-type': 'application/json' }
    const res = await app.inject({ method: 'POST', url: '/api/harness/update', headers: H, payload: JSON.stringify({ harness: 'opencode' }) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ before: '1.14.22', after: '1.15.0' })
    expect((await app.inject({ method: 'POST', url: '/api/harness/update', headers: H, payload: JSON.stringify({ harness: 'vim' }) })).statusCode).toBe(400)
    const status = await app.inject({ url: '/api/harness', headers: { host: '127.0.0.1:3210' } })
    expect(status.json().others[0]).toMatchObject({ name: 'OpenCode', version: '1.15.0' })
    await app.close()
  })
})
