// harness-fake-engine.test.ts — "adding an agent engine = one folder + one
// registerHarness line", proven with NO change in src: the test-only fake
// third harness (fixtures/fake-harness.ts) is registered next to Claude
// Code and OpenCode, booted through compose.ts bootHarnesses (tmp data
// dir) the way index.ts boots, and the real buildServer runs it — its
// descriptor, agents on it, its sessions in the overview, its (empty) model
// catalogue, its console through console-open.ts's generic open (new and
// resume), deletion by hiding, its chat engine, and its Territory row.
// A second fake whose console reports its id later ('reported-by-plugin')
// and brings no hooks gets the honest 400. Terminals are a stub: nothing
// is spawned.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { harnessForId, registerHarness } from '../src/harnesses/index.js'
import { bootHarnesses, type Booted } from '../src/compose.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { AgentStateStore } from '../src/agent-state.js'
import { AsksStore } from '../src/asks-store.js'
import { BirthsStore } from '../src/births-store.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { ProvidersStore } from '../src/providers-store.js'
import { TerritoryStore } from '../src/territory-store.js'
import { ModelCatalog } from '../src/model-catalog.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import type { TerminalService } from '../src/terminal-service.js'
import { buildServer } from '../src/server.js'
import { AccountsService } from '../src/harnesses/claude-code/accounts.js'
import type { ChatEvent } from '../src/chat-types.js'
import { fakeHarness, makeFakeHarness } from './fixtures/fake-harness.js'
import { registeredIds } from './helpers/built-ins.js'
import { handOverConsoleForChat } from '../src/console-handover.js'
import { TuiPinFollower } from '../src/pin-follower.js'
import type { Harness } from '../src/harnesses/contract.js'
import { asOwner } from './helpers/owner.js'
import { fakeIdentity } from './helpers/fake-claude-auth.js'

const fakePlugin = makeFakeHarness({ id: 'fake-plugin', label: 'Fake plugin', prefix: 'fakep_', idDiscovery: 'reported-by-plugin' })
// a third engine that owns engine providers (keys and its own login) and
// hands a session between console and chat: neutral messages name IT
const fakeKeysBase = makeFakeHarness({ id: 'fake-keys', label: 'Fake Keys', prefix: 'fakek_' })
const fakeKeys: Harness = {
  ...fakeKeysBase,
  providers: { kinds: ['harness-provider', 'harness-native'] },
  traits: { ...fakeKeysBase.traits, handover: true, consolePinsModel: true },
  // its own model-id dialect: `<provider>:<model>`, the provider a Silos id
  requestedModelPin: (ref) => {
    const i = ref.indexOf(':')
    return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : null
  },
}

describe('a fake third harness, registered through the seam', () => {
  let base: string
  let app: FastifyInstance
  let chat: ChatService
  let booted: Booted
  const unregister: (() => void)[] = []
  // the consoles "running": ensureConsole starts one, hasConsole sees it
  const live = new Set<string>()
  const ensureConsole = vi.fn((o: { key: string; theme?: 'light' | 'dark' }) => {
    live.add(o.key)
    return { key: o.key, theme: o.theme ?? 'dark' }
  })
  // what buildServer and the generic open reach; nothing runs
  const terminals = {
    ensureConsole,
    reattachConsole: () => null,
    hasConsole: (key: string) => live.has(key),
    keyOfNativeId: () => null,
    consoleRecord: () => null,
    listConsoles: () => [],
    consoleRecords: () => [],
    holdersOf: () => [],
    holderDetailsOf: () => [],
    killConsole: () => {},
    killConsoleAndWait: async () => {},
    killConsoles: async () => {},
    on: () => {},
    off: () => {},
  } as unknown as TerminalService

  beforeAll(async () => {
    // registered BEFORE anything reads the registry (the catalogue and the
    // chat engines are built over the harnesses registered at first use)
    unregister.push(registerHarness(fakeHarness), registerHarness(fakePlugin), registerHarness(fakeKeys))
    base = mkdtempSync(join(tmpdir(), 'fake-engine-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    const home = join(base, 'home')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    mkdirSync(join(dataDir, 'cache'), { recursive: true }) // config.ts makes it in production
    mkdirSync(join(dataDir, 'claude-accounts', 'alt'), { recursive: true })
    mkdirSync(home, { recursive: true })
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    const agentState = new AgentStateStore(join(dataDir, 'agent-state'))
    const asks = new AsksStore(agentState, { dataDir })
    booted = bootHarnesses({ dataDir, home, root, port: 47999, registry, asks, muted: [], ephemeral: null, modelCatalog: false, log: () => {} })
    await booted.ready()
    const index = booted.index
    const native = new NativeStore(join(dataDir, 'native.json'))
    const convPrefs = new ConversationPrefsStore(dataDir)
    const providers = new ProvidersStore(dataDir)
    providers.load()
    const territoryStore = new TerritoryStore(dataDir)
    territoryStore.load()
    const catalog = new ModelCatalog(dataDir, booted.modelSources())
    chat = new ChatService({
      registry,
      native,
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
      dataDir,
      providers,
      convPrefs,
      catalog,
      agentState,
      headlessOptions: booted.headlessOptions(),
    })
    const start = { index, terminals, births: new BirthsStore(agentState), native, convPrefs, root, muted: [], ephemeral: null }
    const engines = booted.beforeServer(start)
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
      terminals,
      token: 't0k',
      liveMs: 120_000,
      dataDir,
      home,
      providers,
      convPrefs,
      catalog,
      agentState,
      territoryStore,
      engines,
      // the provider routes (Settings › Providers) are served only with the accounts
      accounts: new AccountsService({ dataDir, defaultConfigDir: join(base, 'dot-claude'), identity: fakeIdentity(join(base, 'dot-claude')) }),
    })
    asOwner(app, 't0k')
    booted.afterServer(start)
    await index.init()
    booted.indexReady()
  })

  afterAll(async () => {
    await app?.close()
    await Promise.allSettled(booted?.stop() ?? [])
    for (const u of unregister.splice(0)) u()
    rmSync(base, { recursive: true, force: true })
  })

  let agentId = ''
  let pluginAgentId = ''

  it('GET /api/harnesses lists it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/harnesses' })
    expect(res.statusCode).toBe(200)
    const list = (res.json() as { harnesses: { id: string; label: string; default: boolean }[] }).harnesses
    // the built-ins first (any engine the registration list adds), then the three fakes registered above
    const ids = registeredIds()
    expect(list.map((h) => h.id)).toEqual(ids)
    expect(ids.slice(-3)).toEqual(['fake', 'fake-plugin', 'fake-keys'])
    expect(list.find((h) => h.id === 'fake')).toMatchObject({ label: 'Fake', default: false, providerKinds: ['anthropic-compatible'], modeSwitch: false })
  })

  it("POST /api/agents {framework:'fake'} → 201", async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agents', payload: { id: 'faker', name: 'Faker', folder: '/p', framework: 'fake' } })
    expect(res.statusCode).toBe(201)
    agentId = 'faker'
    expect((res.json() as { agent: { framework: string } }).agent.framework).toBe('fake')
    const other = await app.inject({ method: 'POST', url: '/api/agents', payload: { id: 'plugged', name: 'Plugged', folder: '/q', framework: 'fake-plugin' } })
    expect(other.statusCode).toBe(201)
    pluginAgentId = 'plugged'
  })

  it('that agent with a Claude account provider → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, payload: { provider: 'account:alt' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'a Claude account cannot run on Fake' })
  })

  it("the overview lists fake_1, stamped harness 'fake', under its agent", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview' })
    expect(res.statusCode).toBe(200)
    const agents = (res.json() as { agents: { id: string; sessions: { id: string; harness?: string }[] }[] }).agents
    const s = agents.find((a) => a.id === agentId)?.sessions.find((x) => x.id === 'fake_1')
    expect(s).toBeDefined()
    expect(s!.harness).toBe('fake')
  })

  it('GET /api/search counts its sessions as unsearched under its own id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=anything' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { unsearchedBy: Record<string, number> }).unsearchedBy).toMatchObject({ fake: 1, 'fake-keys': 1 })
    expect((res.json() as { unsearchedBy: Record<string, number> }).unsearchedBy).not.toHaveProperty('opencode')
  })

  it('GET /api/models?harness=fake → 200, honestly empty', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models?harness=fake' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ models: [], fetchedAt: null })
  })

  it('POST /api/models/refresh?harness=fake → 400: it declares no model list', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/models/refresh?harness=fake' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Fake has no model list to refresh' })
  })

  it('POST /api/console {agentId} → 201 through the generic open (a new conversation)', async () => {
    ensureConsole.mockClear()
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId } })
    expect(res.statusCode).toBe(201)
    const { key } = res.json() as { key: string }
    // born under an id its own harness claims, never a bare UUID the fallback would take
    expect(harnessForId(key)).toBe('fake')
    expect(ensureConsole).toHaveBeenCalledTimes(1)
    expect(ensureConsole.mock.calls[0]![0]).toMatchObject({
      key,
      cwd: '/p',
      agentId,
      command: ['fake-cli', '--session', key],
      harness: 'fake',
      extraEnv: { FAKE_HOME: '/tmp/fake' },
    })
  })

  it("a second 'New conversation' reuses the agent's idle console; a typed-into or dead one is never reused", async () => {
    ensureConsole.mockClear()
    const first = (await app.inject({ method: 'POST', url: '/api/console', payload: { agentId } })).json() as { key: string }
    const again = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId } })
    expect(again.statusCode).toBe(201)
    expect((again.json() as { key: string }).key).toBe(first.key)
    // its session is listed now (something was typed): a fresh id
    const spy = vi.spyOn(booted.index, 'allSessions').mockImplementation(() => [{ id: first.key } as never])
    const typed = (await app.inject({ method: 'POST', url: '/api/console', payload: { agentId } })).json() as { key: string }
    spy.mockRestore()
    expect(typed.key).not.toBe(first.key)
    expect(harnessForId(typed.key)).toBe('fake')
    // the waiting console died: a fresh id again
    live.delete(typed.key)
    const dead = (await app.inject({ method: 'POST', url: '/api/console', payload: { agentId } })).json() as { key: string }
    expect(dead.key).not.toBe(typed.key)
    expect(ensureConsole.mock.calls.map((c) => c[0].key)).toEqual([first.key, first.key, typed.key, dead.key])
  })

  // third review round, defect 3: an archived agent's beat door once opened
  // a NEW real console for it — the agent is out of play, so no console is
  // ever born for it (nor for an id the registry doesn't know)
  it('POST /api/console {agentId} for an archived or unknown agent → 404, no console started', async () => {
    await app.inject({ method: 'POST', url: '/api/agents', payload: { id: 'retired', name: 'Retired', folder: '/p', framework: 'fake' } })
    expect((await app.inject({ method: 'POST', url: '/api/agents/retired/archive' })).statusCode).toBe(200)
    ensureConsole.mockClear()
    const archived = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'retired' } })
    expect(archived.statusCode).toBe(404)
    expect((archived.json() as { error: string }).error).toContain('archived or removed')
    const unknown = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'nobody' } })
    expect(unknown.statusCode).toBe(404)
    expect(ensureConsole).not.toHaveBeenCalled()
  })

  it('POST /api/console {id: fake_1} → 201 through the generic open (a resume under its own id)', async () => {
    ensureConsole.mockClear()
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'fake_1' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ key: 'fake_1', theme: 'dark' })
    expect(ensureConsole.mock.calls[0]![0]).toMatchObject({ key: 'fake_1', cwd: '/p', agentId, command: ['fake-cli', '--session', 'fake_1'], harness: 'fake' })
  })

  it("a harness whose console reports its id, with no hooks of its own → 400 '<label> has no console in Silos yet'", async () => {
    ensureConsole.mockClear()
    const fresh = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: pluginAgentId } })
    expect(fresh.statusCode).toBe(400)
    expect(fresh.json()).toEqual({ error: 'Fake plugin has no console in Silos yet' })
    const resume = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'fakep_1' } })
    expect(resume.statusCode).toBe(400)
    expect(resume.json()).toEqual({ error: 'Fake plugin has no console in Silos yet' })
    expect(ensureConsole).not.toHaveBeenCalled()
  })

  it("chat.send yields the fake's events and emits a chat-event for each", async () => {
    const emitted: { agentId: string; event: ChatEvent }[] = []
    const onEvent = (e: { agentId: string; event: ChatEvent }): void => {
      emitted.push(e)
    }
    chat.on('chat-event', onEvent)
    const yielded: ChatEvent[] = []
    for await (const ev of chat.send({ turnId: 'tf1', agentId, text: 'hi' })) yielded.push(ev)
    chat.off('chat-event', onEvent)
    expect(yielded).toEqual([
      { ev: 'chat-delta', turnId: 'tf1', text: 'fake says hi' },
      { ev: 'chat-done', turnId: 'tf1', subtype: 'success', costUsd: null },
    ])
    expect(emitted).toEqual(yielded.map((event) => ({ agentId, event })))
  })

  it('GET /api/territory has its row, labelled Fake', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/territory' })
    expect(res.statusCode).toBe(200)
    const rows = (res.json() as { agents: { id: string; harness: string; label: string; fenced: string[] }[] }).agents
    expect(rows.find((r) => r.id === agentId)).toEqual({ id: agentId, harness: 'fake', label: 'Fake', fenced: [], scope: null })
  })

  it("its console colours are its own pref (consoleTheme.fake), never OpenCode's", async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { consoleTheme: { fake: 'own' } } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ consoleTheme: { fake: 'own' } })
    expect((res.json() as { consoleTheme: Record<string, string> }).consoleTheme).not.toHaveProperty('opencode')
    const prefs = new PrefsStore(join(base, 'data'))
    expect(prefs.consoleThemeOf('fake')).toBe('own')
    expect(prefs.consoleThemeOf('opencode')).toBe('silos')
    // an engine without a Console colours setting stores nothing
    const none = await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { consoleTheme: { 'claude-code': 'own' } } })
    expect(none.statusCode).toBe(400)
    expect(none.json().error).toBe('consoleTheme: Claude Code has no console colours setting')
    const bad = await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { consoleTheme: { fake: 'neon' } } })
    expect(bad.statusCode).toBe(400)
  })

  // Neutral provider messages name the engine that owns the provider —
  // OpenCode's texts are the ones it always had; Fake Keys gets its own name.
  describe('provider messages name the owning engine', () => {
    const create = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/providers', payload })
    const errorOf = async (res: Promise<{ statusCode: number; json(): unknown }>): Promise<string> => {
      const r = await res
      expect(r.statusCode).toBe(400)
      return (r.json() as { error: string }).error
    }
    let ocKey = ''
    let fkKey = ''

    it('create: the provider-id format, baseUrl and models refusals', async () => {
      for (const [harness, label] of [
        ['opencode', 'OpenCode'],
        ['fake-keys', 'Fake Keys'],
      ] as const) {
        expect(await errorOf(create({ kind: 'harness-provider', harness, providerId: 'Not An Id', apiKey: 'k-1234567890', label: 'x' }))).toBe(
          `providerId required: a lowercase ${label} provider id (a-z, 0-9, -)`,
        )
        expect(
          await errorOf(create({ kind: 'harness-provider', harness, providerId: 'zai', apiKey: 'k-1234567890', label: 'x', baseUrl: 'https://x.example' })),
        ).toBe(`baseUrl is only for anthropic-compatible providers — ${label} knows its providers' endpoints`)
        expect(await errorOf(create({ kind: 'harness-provider', harness, providerId: 'zai', apiKey: 'k-1234567890', label: 'x', models: ['m'] }))).toBe(
          `models are only for anthropic-compatible providers — ${label} lists its own`,
        )
      }
      // no engine named: every engine that owns engine providers
      expect(
        await errorOf(create({ kind: 'anthropic-compatible', harness: 'opencode', label: 'x', baseUrl: 'https://x.example', apiKey: 'k-1234567890' })),
      ).toBe('providerId/harness are only for OpenCode or Fake Keys providers')
      expect(() =>
        new ProvidersStore(join(base, 'data')).create({
          kind: 'anthropic-compatible',
          providerId: 'zai',
          label: 'x',
          baseUrl: 'https://x.example',
          apiKey: 'k',
        }),
      ).toThrow('providerId/harness are only for OpenCode or Fake Keys providers')
    })

    it('connect, verify and models refuse an engine provider in its engine’s words', async () => {
      const oc = await create({ kind: 'harness-provider', harness: 'opencode', providerId: 'zai', apiKey: 'zai-1234567890', label: 'Z' })
      const fk = await create({ kind: 'harness-provider', harness: 'fake-keys', providerId: 'acme', apiKey: 'acme-1234567890', label: 'A' })
      expect(oc.statusCode).toBe(201)
      expect(fk.statusCode).toBe(201)
      ocKey = (oc.json() as { provider: { id: string } }).provider.id
      fkKey = (fk.json() as { provider: { id: string } }).provider.id
      expect(
        await errorOf(
          app.inject({
            method: 'POST',
            url: '/api/providers/connect',
            payload: { kind: 'harness-provider', harness: 'opencode', providerId: 'zai', apiKey: 'zai-1234567890', label: 'Z' },
          }),
        ),
      ).toBe('connect takes an Anthropic-compatible endpoint and its key — OpenCode providers are imported or added, not connected')
      expect(
        await errorOf(
          app.inject({
            method: 'POST',
            url: '/api/providers/connect',
            payload: { kind: 'harness-provider', harness: 'fake-keys', providerId: 'acme', apiKey: 'acme-1234567890', label: 'A' },
          }),
        ),
      ).toBe('connect takes an Anthropic-compatible endpoint and its key — Fake Keys providers are imported or added, not connected')
      expect(await errorOf(app.inject({ method: 'POST', url: `/api/providers/${ocKey}/verify` }))).toBe(
        'an OpenCode provider is verified by OpenCode itself, not from here',
      )
      expect(await errorOf(app.inject({ method: 'POST', url: `/api/providers/${fkKey}/verify` }))).toBe(
        'a Fake Keys provider is verified by Fake Keys itself, not from here',
      )
      expect(await errorOf(app.inject({ method: 'POST', url: `/api/providers/${ocKey}/models` }))).toBe(
        'an OpenCode provider lists its models through OpenCode (GET /api/models?harness=opencode)',
      )
      expect(await errorOf(app.inject({ method: 'POST', url: `/api/providers/${fkKey}/models` }))).toBe(
        'a Fake Keys provider lists its models through Fake Keys (GET /api/models?harness=fake-keys)',
      )
    })

    it("a model picked in its console becomes the pin in ITS dialect, never OpenCode's", () => {
      const patches: unknown[] = []
      const convPrefs = {
        get: () => null,
        writtenAt: () => null,
        patch: (_f: string, _i: string, v: unknown) => {
          patches.push(v)
          return v as never
        },
      }
      const follower = new TuiPinFollower({ providers: { list: () => [], get: () => undefined } as never, convPrefs: convPrefs as never })
      const meta = (harness: string, requestedModel: string) => ({ id: 'x', folder: '-p', harness, requestedModel, requestedModelAt: 1 }) as never
      expect(follower.onSession(meta('fake-keys', 'acme:big-1'))).toEqual({ provider: 'acme', model: 'big-1' })
      // OpenCode's `provider/model` means nothing to it
      expect(follower.onSession(meta('fake-keys', 'acme/big-1'))).toBeNull()
      // an engine whose console does not pin: nothing
      expect(follower.onSession(meta('fake', 'acme:big-1'))).toBeNull()
      expect(patches).toEqual([{ provider: 'acme', model: 'big-1' }])
    })

    it('the console handover log names the engine of the session', async () => {
      const lines: string[] = []
      const terminals = { keyOfNativeId: () => 'k1', hasConsole: () => true, killConsoleAndWait: async () => {} }
      expect(await handOverConsoleForChat(terminals, 'fakek_1', (l) => lines.push(l))).toBe('k1')
      expect(await handOverConsoleForChat(terminals, 'ses_1', (l) => lines.push(l))).toBe('k1')
      expect(await handOverConsoleForChat(terminals, 'fake_1', (l) => lines.push(l))).toBeNull() // no handover trait
      expect(lines).toEqual([
        'console k1 closed: the chat engine takes session fakek_1 (one Fake Keys process per session)',
        'console k1 closed: the chat engine takes session ses_1 (one OpenCode process per session)',
      ])
    })

    afterAll(async () => {
      for (const id of [ocKey, fkKey]) if (id) await app.inject({ method: 'DELETE', url: `/api/providers/${id}` })
    })
  })

  it('POST …/fake_1/trash → hidden (deletion: hide), and it leaves the overview', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions/-p/fake_1/trash' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, hidden: true })
    const after = await app.inject({ method: 'GET', url: '/api/overview' })
    const agents = (after.json() as { agents: { id: string; sessions: { id: string }[] }[] }).agents
    expect(agents.flatMap((a) => a.sessions).some((s) => s.id === 'fake_1')).toBe(false)
  })
})
