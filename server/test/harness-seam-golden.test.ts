// harness-seam-golden.test.ts — the characterization net under the harness
// registration seam (plans/2026-10-29-harness-registration-seam, Task 0):
// what neutral code decides by engine name TODAY, frozen as literals copied
// from a run of the code before any refactor. This file is never edited by a
// later task; a failure here means behaviour changed. Like
// claude-code-golden.test.ts, values are compared with toEqual AND
// serialized (key order is part of the contract).
//
// Only stable surfaces are touched: exported functions whose signatures the
// plan keeps, HTTP routes, and constructor arguments the plan does not
// rename. Where a later task renames a dependency (ChatService's OpenCode
// engine, HarnessService's per-engine options), BOTH spellings are passed
// through a loose cast so this file needs no edit when the rename lands.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { makeOpenCodeDb } from './helpers/opencode-db.js'
import { harnessForId, harnessIds, quotedIds, registeredHarnesses } from '../src/harnesses/index.js'
import { BUILT_INS } from './helpers/built-ins.js'
import { providerHarnessError, validateProviderCreate } from '../src/providers-validate.js'
import type { ResolvedProvider } from '../src/providers-store.js'
import { ProvidersStore } from '../src/providers-store.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { OpenCodeReader } from '../src/harnesses/opencode/reader.js'
import { AccountsService } from '../src/harnesses/claude-code/accounts.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { TerritoryStore } from '../src/territory-store.js'
import { makeTerritory } from '../src/territory.js'
import { AgentStateStore } from '../src/agent-state.js'
import { ModelCatalog } from '../src/model-catalog.js'
import { HarnessService } from '../src/harness.js'
import type { RunFn } from '../src/harness-run.js'
import { ContextService } from '../src/context-service.js'
import { buildServer } from '../src/server.js'
import type { QueryArgs, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import { asOwner } from './helpers/owner.js'
import { fakeIdentity } from './helpers/fake-claude-auth.js'

const same = (actual: unknown, expected: unknown): void => {
  expect(actual).toEqual(expected)
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
}

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const LOCAL = { host: '127.0.0.1:3210' }

describe('harnessForId', () => {
  it('routes a bare session id by prefix', () => {
    same(['ses_x', '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', 'agent-abc', ''].map(harnessForId), ['opencode', 'claude-code', 'claude-code', 'claude-code'])
  })
})

describe('providerHarnessError', () => {
  const MATRIX: ResolvedProvider[] = [
    { id: 'default', kind: 'claude-account', label: 'Claude (this machine)', configDir: null },
    { id: 'acct', kind: 'claude-account', label: 'Claude · acct', configDir: '/acc/acct' },
    { id: 'gw', kind: 'anthropic-compatible', label: 'GW', baseUrl: 'https://gw.example', apiKey: 'sk-gw' },
    { id: 'hp', kind: 'harness-provider', label: 'HP', harness: 'opencode', providerId: 'zai', apiKey: 'zk' },
    { id: 'hn', kind: 'harness-native', label: 'HN', harness: 'opencode', providerId: 'kimi-for-coding' },
  ]
  it('the matrix {default, claude account, anthropic-compatible, harness-provider, harness-native} × {claude-code, opencode}', () => {
    same(
      MATRIX.map((p) => [providerHarnessError(p, 'claude-code'), providerHarnessError(p, 'opencode')]),
      [
        [null, null],
        [null, 'a Claude account cannot run on OpenCode'],
        [null, null],
        ['this provider is for OpenCode agents', null],
        ['this provider is for OpenCode agents', null],
      ],
    )
  })
})

describe('validateProviderCreate — the harness field', () => {
  const err = (body: unknown): string | null => {
    try {
      validateProviderCreate(body)
      return null
    } catch (e) {
      return (e as Error).message
    }
  }
  it('missing or wrong harness on an OpenCode kind; any harness on an anthropic-compatible one', () => {
    same(
      [
        err({ kind: 'harness-provider', label: 'P', providerId: 'zai', apiKey: 'k' }),
        err({ kind: 'harness-provider', label: 'P', harness: 'x', providerId: 'zai', apiKey: 'k' }),
        err({ kind: 'harness-provider', label: 'P', harness: 'claude-code', providerId: 'zai', apiKey: 'k' }),
        err({ kind: 'harness-native', label: 'P', providerId: 'zai' }),
        err({ kind: 'harness-native', label: 'P', harness: 'x', providerId: 'zai' }),
        err({ kind: 'anthropic-compatible', label: 'P', harness: 'opencode', baseUrl: 'https://gw.example', apiKey: 'k' }),
        err({ kind: 'nope', label: 'P' }),
      ],
      [
        "harness required: 'opencode'",
        "harness required: 'opencode'",
        "harness required: 'opencode'",
        "harness required: 'opencode'",
        "harness required: 'opencode'",
        'providerId/harness are only for OpenCode providers',
        "invalid kind — 'anthropic-compatible', 'harness-provider' or 'harness-native'",
      ],
    )
    same(validateProviderCreate({ kind: 'harness-native', label: 'P', harness: 'opencode', providerId: 'zai' }), {
      kind: 'harness-native',
      label: 'P',
      harness: 'opencode',
      providerId: 'zai',
    })
  })
})

// A STRICT fake process runner: it answers only the exact commands today's
// code issues for the injected options below, each with a DISTINCT value, and
// throws on anything else. Every injected option is distinctive (never the
// default), so an option a later task stops reading falls back to a default
// command this runner refuses — and status() changes. `opencode --version`
// always throws: only the injected probe can produce 1.19.4.
const fakeRun: RunFn = async (cmd, args) => {
  const line = [cmd, ...args].join(' ')
  if (line === '/golden/bin/claude-golden --version') return { stdout: '2.1.319 (Claude Code)\n', stderr: '' }
  if (line === 'npm view @anthropic-ai/claude-code version') return { stdout: '2.1.320\n', stderr: '' }
  throw new Error(`unexpected ${line}`)
}
const ocProbe = { version: async () => '1.19.4', invalidate: () => {} }
const harnessDeps = (): ConstructorParameters<typeof HarnessService>[0] => ({
  run: fakeRun,
  now: () => Date.parse('2026-10-29T10:00:00.000Z'),
  engines: {
    'claude-code': { consoleCmd: 'claude-golden', resolve: (c: string) => `/golden/bin/${c}`, pairing: () => ({ library: '0.3.319', pairedWith: '2.1.319' }) },
    opencode: { cmd: '/golden/oc/opencode', probe: ocProbe },
  },
})

describe('HarnessService.status()', () => {
  it('keys, order and values with a fake run', async () => {
    const s = await new HarnessService(harnessDeps()).status()
    same(Object.keys(s), ['harness', 'name', 'console', 'library', 'latest', 'checkedAt', 'others', 'compat'])
    same(s, {
      harness: 'claude-code',
      name: 'Claude Code',
      console: { version: '2.1.319', path: '/golden/bin/claude-golden' },
      library: { name: 'Agent SDK', version: '0.3.319', pairedWith: '2.1.319' },
      latest: '2.1.320',
      checkedAt: '2026-10-29T10:00:00.000Z',
      others: [{ harness: 'opencode', name: 'OpenCode', version: '1.19.4', path: '/golden/oc/opencode', latest: null }],
      compat: [
        { harness: 'claude-code', name: 'Claude Code', installed: '2.1.319', needed: '2.1.319', state: 'ok', update: null, refuses: [], message: null },
        { harness: 'opencode', name: 'OpenCode', installed: '1.19.4', needed: '1.19.4', state: 'ok', update: null, refuses: [], message: null },
      ],
    })
  })
})

describe('ModelCatalog', () => {
  it('each engine reads its own cache file; refresh with no source names the source', async () => {
    const dataDir = tempDir('seam-catalog-')
    mkdirSync(join(dataDir, 'cache'))
    writeFileSync(
      join(dataDir, 'model-catalog.json'),
      JSON.stringify({ fetchedAt: '2026-10-01T00:00:00.000Z', models: [{ value: 'sonnet', displayName: 'Sonnet' }] }),
    )
    writeFileSync(
      join(dataDir, 'cache', 'models-opencode.json'),
      JSON.stringify({ fetchedAt: '2026-10-02T00:00:00.000Z', models: [{ value: 'zai/glm-5.3', displayName: 'glm-5.3' }] }),
    )
    const catalog = new ModelCatalog(dataDir)
    catalog.load()
    same(catalog.view(), { models: [{ value: 'sonnet', displayName: 'Sonnet' }], fetchedAt: '2026-10-01T00:00:00.000Z' })
    same(catalog.viewFor('claude-code'), { models: [{ value: 'sonnet', displayName: 'Sonnet' }], fetchedAt: '2026-10-01T00:00:00.000Z' })
    same(catalog.viewFor('opencode'), { models: [{ value: 'zai/glm-5.3', displayName: 'glm-5.3' }], fetchedAt: '2026-10-02T00:00:00.000Z' })
    const errs: string[] = []
    for (const h of ['claude-code', 'opencode'] as const) {
      try {
        await catalog.refresh(h)
      } catch (e) {
        errs.push((e as Error).message)
      }
    }
    try {
      await catalog.refresh()
    } catch (e) {
      errs.push((e as Error).message)
    }
    same(errs, [
      'model catalog has no the SDK source configured',
      'model catalog has no opencode models source configured',
      'model catalog has no the SDK source configured',
    ])
  })
})

describe('ChatService', () => {
  const base = () => {
    const dir = tempDir('seam-chat-')
    const registry = new AgentRegistry(join(dir, 'agents.json'))
    registry.load()
    registry.create({ id: 'oc', name: 'Oc', folder: dir, framework: 'opencode' })
    registry.create({ id: 'cc', name: 'Cc', folder: dir })
    return { registry, native: new NativeStore(join(dir, 'native.json')) }
  }

  it('an OpenCode agent with no OpenCode engine wired: the error text, the SDK never asked', async () => {
    const { registry, native } = base()
    const calls: QueryArgs[] = []
    const chat = new ChatService({
      registry,
      native,
      queryFn: (a) => {
        calls.push(a)
        throw new Error('no sdk')
      },
    })
    let msg: string | null = null
    try {
      for await (const _ of chat.send({ turnId: 't', agentId: 'oc', text: 'hi' })) void _
    } catch (e) {
      msg = (e as Error).message
    }
    same(msg, "no OpenCode chat engine wired — cannot run an OpenCode agent's turn")
    same(calls.length, 0)
  })

  it('cancel asks the OpenCode engine first, then Claude', async () => {
    const { registry, native } = base()
    const order: string[] = []
    let release = (): void => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const queryFn = (): SdkQueryHandle =>
      ({
        async *[Symbol.asyncIterator]() {
          await gate
          yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
        },
        async interrupt() {
          order.push('claude')
          release()
          return { status: 'interrupted' }
        },
      }) as unknown as SdkQueryHandle
    const ocEngine = {
      async cancel(id: string) {
        order.push(`opencode:${id}`)
        return id === 'oc-turn'
      },
      isInflight: () => false,
      isSessionActive: () => false,
      async *send() {
        /* never sent here */
      },
    }
    const deps = { registry, native, queryFn, opencodeHeadless: ocEngine, headless: { opencode: () => ocEngine } } as unknown as ConstructorParameters<
      typeof ChatService
    >[0]
    const chat = new ChatService(deps)
    const run = (async () => {
      for await (const _ of chat.send({ turnId: 'cc-turn', agentId: 'cc', text: 'hi' })) void _
    })()
    for (let i = 0; i < 200 && !chat.isInflight('cc-turn'); i++) await new Promise((r) => setTimeout(r, 5))
    same(chat.isInflight('cc-turn'), true)
    same(await chat.cancel('cc-turn'), true)
    await run
    same(await chat.cancel('oc-turn'), true)
    same(await chat.cancel('nobody'), false)
    same(order, ['opencode:cc-turn', 'claude', 'opencode:oc-turn', 'opencode:nobody'])
  })
})

describe('produced(): Silos bookkeeping left out of an agent state folder', () => {
  it('the excluded names, at the top level only', () => {
    const state = tempDir('seam-produced-')
    const names = [
      'runmode.json',
      'status.json',
      'status.log.jsonl',
      'watch-state.json',
      'token',
      'inbox',
      'asks',
      'births',
      'opencode',
      'support',
      'keep.md',
      'notes.txt',
    ]
    for (const n of names) writeFileSync(join(state, n), 'x')
    mkdirSync(join(state, 'deep'))
    writeFileSync(join(state, 'deep', 'token'), 'x')
    same(
      new ContextService().produced(state).map((f) => f.rel),
      ['deep/token', 'keep.md', 'notes.txt'],
    )
  })
})

describe('routes', () => {
  let app: FastifyInstance
  let reader: OpenCodeReader | null = null
  let providers: ProvidersStore
  let folderName: string
  const prevEnv = process.env.SILOS_OPENCODE_DATA

  beforeEach(async () => {
    const base = tempDir('seam-routes-')
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    mkdirSync(join(base, 'xdg', 'opencode'), { recursive: true })
    process.env.SILOS_OPENCODE_DATA = join(base, 'xdg')
    const folder = join(base, 'work')
    mkdirSync(folder)
    folderName = folder.replace(/[^a-zA-Z0-9]/g, '-')
    mkdirSync(join(base, 'oc'))
    const oc = makeOpenCodeDb(join(base, 'oc'))
    oc.insertSession({ id: 'ses_g1', project_id: 'p1', directory: folder, title: 'other', version: '1.14.22', time_created: 1, time_updated: 2 })
    oc.close()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder })
    registry.create({ id: 'oc', name: 'Oc', folder, framework: 'opencode' })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    reader = new OpenCodeReader({ dataDir, registry, globalDb: oc.path, muted: [], ephemeralPrefix: null })
    index.addReader(reader)
    await index.init()
    index.stopHeartbeat()
    const native = new NativeStore(join(dataDir, 'native.json'))
    providers = new ProvidersStore(dataDir)
    providers.load()
    const accounts = new AccountsService({ dataDir, defaultConfigDir: join(base, 'dot-claude'), identity: fakeIdentity(join(base, 'dot-claude')) })
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => {
        throw new Error('no sdk')
      },
      providers,
    })
    const store = new TerritoryStore(dataDir)
    store.load()
    const territory = makeTerritory({ registry, agentState: new AgentStateStore(join(dataDir, 'agent-state')), store, home: base, dataDir })
    const catalog = new ModelCatalog(dataDir)
    catalog.load()
    app = buildServer({
      index,
      registry,
      native,
      chat,
      store: new SessionStore(root, dataDir),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: 't0k',
      liveMs: 120_000,
      agentTokens: new AgentTokens(dataDir),
      territory,
      territoryStore: store,
      home: base,
      providers,
      accounts,
      catalog,
      harness: new HarnessService(harnessDeps()),
    })
    asOwner(app, 't0k')
  })
  afterEach(async () => {
    await app.close()
    reader?.close()
    reader = null
    if (prevEnv === undefined) delete process.env.SILOS_OPENCODE_DATA
    else process.env.SILOS_OPENCODE_DATA = prevEnv
  })
  const json = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const r = await app.inject({
      method,
      url,
      headers: { ...LOCAL, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    })
    return { status: r.statusCode, body: r.json() as unknown }
  }

  it('an unknown harness: the 400 bodies of the models, refresh and update routes', async () => {
    // models/refresh list every registered engine, update the ones that declare
    // versions; with only the built-ins both are today's exact text
    const error = `harness must be ${quotedIds(harnessIds())}`
    const updateError = `harness must be ${quotedIds(
      registeredHarnesses()
        .filter((h) => h.versions)
        .map((h) => h.id),
    )}`
    if (harnessIds().length === BUILT_INS.length) {
      same(error, "harness must be 'claude-code' or 'opencode'")
      same(updateError, "harness must be 'claude-code' or 'opencode'")
    }
    same(await json('GET', '/api/models?harness=x'), { status: 400, body: { error } })
    same(await json('POST', '/api/models/refresh?harness=x'), { status: 400, body: { error } })
    same(await json('POST', '/api/harness/update', { harness: 'x' }), { status: 400, body: { error: updateError } })
  })

  it('GET /api/territory agents rows: one agent per engine', async () => {
    const r = await json('GET', '/api/territory')
    same(r.status, 200)
    // scope (fenceScope) is covered in territory.test.ts; the seam pins the engine columns
    same(
      (r.body as { agents: Array<Record<string, unknown>> }).agents.map(({ scope: _s, ...row }) => row),
      [
        { id: 'builder', harness: 'claude-code', label: 'Claude Code', fenced: ['read', 'edit'] },
        { id: 'oc', harness: 'opencode', label: 'OpenCode', fenced: ['read', 'edit'] },
      ],
    )
  })

  it('trash on a ses_ id hides it', async () => {
    same(await json('POST', `/api/sessions/${folderName}/ses_g1/trash`), { status: 200, body: { ok: true, hidden: true } })
  })

  it('GET /api/providers/:id/export with an unknown target', async () => {
    const p = providers.create({ kind: 'anthropic-compatible', label: 'GW', baseUrl: 'https://gw.example', apiKey: 'sk-gw-123456' })
    same(await json('GET', `/api/providers/${p.id}/export?target=nope`), { status: 400, body: { error: "target must be 'opencode' or 'claude'" } })
  })
})
