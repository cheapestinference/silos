// Providers v1 — /api/providers* and /api/accounts* routes (masking in
// EVERY response, verify with an injected fetch — zero real network) and
// provider/fallback validation on the agent routes.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
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
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { buildServer } from '../src/server.js'
import { PlatformSettingsStore } from '../src/platform-settings.js'
import { fakeIdentity, fakeSignIn } from './helpers/fake-claude-auth.js'

// a genuinely LOCAL request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

let app: FastifyInstance
let base: string, dataDir: string
let registry: AgentRegistry
let providers: ProvidersStore
let verifyCalls: Array<{ url: string; init: RequestInit }>
let verifyResponse: () => Response | Promise<Response>
const TOKEN = 'testtoken'
const KEY = 'sk-live-abcdef123456'

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-provapi-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder: '/tmp/project-x' })
  const store = new SessionStore(root, dataDir)
  const native = new NativeStore(join(dataDir, 'native.json'))
  providers = new ProvidersStore(dataDir)
  providers.load()
  const accounts = new AccountsService({
    dataDir,
    defaultConfigDir: join(base, 'dot-claude'),
    identity: fakeIdentity(join(base, 'dot-claude')),
  })
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
  verifyCalls = []
  verifyResponse = () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 })
  const verifyFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    verifyCalls.push({ url: String(url), init: init ?? {} })
    return verifyResponse()
  }) as typeof fetch
  app = buildServer({
    index,
    registry,
    store,
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    token: TOKEN,
    liveMs: 120_000,
    providers,
    accounts,
    verifyFetch,
    convPrefs: new ConversationPrefsStore(dataDir),
    platformSettings: (() => {
      const p = new PlatformSettingsStore(dataDir)
      p.load()
      return p
    })(),
  })
})
afterEach(() => vi.restoreAllMocks())

const get = (url: string) => app.inject({ url, headers: { 'x-token': TOKEN } })
const post = (url: string, body?: unknown) =>
  app.inject({
    url,
    method: 'POST',
    // content-type only when there's a body — Fastify rejects (400) an
    // empty body declared as application/json.
    headers: { 'x-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  })
const patch = (url: string, body: unknown) =>
  app.inject({ url, method: 'PATCH', headers: { 'x-token': TOKEN, 'content-type': 'application/json' }, payload: JSON.stringify(body) })

describe('/api/providers', () => {
  it('requires a token (401 without it)', async () => {
    expect((await app.inject({ url: '/api/providers', headers: REMOTE })).statusCode).toBe(401)
  })

  it('GET lists default + derived accounts + persisted providers, with keys ALWAYS masked', async () => {
    mkdirSync(join(dataDir, 'claude-accounts', 'alt'), { recursive: true })
    providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: KEY })
    const res = await get('/api/providers')
    expect(res.statusCode).toBe(200)
    const { providers: list } = res.json() as { providers: Array<Record<string, unknown>> }
    expect(list.map((p) => p.id)).toEqual(['default', 'account:alt', providers.list()[0]!.id])
    expect(res.body).not.toContain(KEY)
    expect(list[2]!.apiKey).toBe('sk-…3456')
  })

  it('POST creates (201, key masked in the response) and validates the body', async () => {
    const res = await post('/api/providers', { label: 'ci', baseUrl: 'https://api.ci.test/anthropic/', apiKey: KEY })
    expect(res.statusCode).toBe(201)
    const { provider } = res.json() as { provider: Record<string, unknown> }
    expect(provider.apiKey).toBe('sk-…3456')
    expect(provider.baseUrl).toBe('https://api.ci.test/anthropic') // no trailing slash
    expect(res.body).not.toContain(KEY)
    // and on disk the FULL key is stored (it's what gets injected into the env)
    expect(readFileSync(join(dataDir, 'providers.json'), 'utf8')).toContain(KEY)

    expect((await post('/api/providers', { label: '', baseUrl: 'https://x', apiKey: 'k-123456789' })).statusCode).toBe(400)
    expect((await post('/api/providers', { label: 'x', baseUrl: 'ftp://x', apiKey: 'k-123456789' })).statusCode).toBe(400)
    expect((await post('/api/providers', { label: 'x', baseUrl: 'https://x' })).statusCode).toBe(400)
  })

  it('PATCH updates (masked) and rejects the echo of a masked key', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://a.test', apiKey: KEY })
    const res = await patch(`/api/providers/${id}`, { label: 'ci2' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { provider: { label: string; apiKey: string } }).provider).toMatchObject({ label: 'ci2', apiKey: 'sk-…3456' })
    expect(providers.get(id)?.apiKey).toBe(KEY) // the real key survives a patch with no apiKey

    const echo = await patch(`/api/providers/${id}`, { apiKey: 'sk-…3456' })
    expect(echo.statusCode).toBe(400)
    expect((echo.json() as { error: string }).error).toContain('masked')

    expect((await patch('/api/providers/missing', { label: 'x' })).statusCode).toBe(404)
  })

  it('DELETE removes it; 404 if it does not exist', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://a.test', apiKey: KEY })
    expect((await app.inject({ url: `/api/providers/${id}`, method: 'DELETE', headers: { 'x-token': TOKEN } })).statusCode).toBe(200)
    expect((await app.inject({ url: `/api/providers/${id}`, method: 'DELETE', headers: { 'x-token': TOKEN } })).statusCode).toBe(404)
  })
})

describe('/api/providers/:id/verify', () => {
  it('calls <baseUrl>/v1/messages with Bearer and max_tokens=1 via the injected fetch', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: KEY })
    const res = await post(`/api/providers/${id}/verify`, { model: 'glm-5.2' })
    expect(res.json()).toEqual({ ok: true })
    expect(verifyCalls).toHaveLength(1)
    expect(verifyCalls[0]!.url).toBe('https://api.ci.test/anthropic/v1/messages')
    const headers = verifyCalls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(String(verifyCalls[0]!.init.body)) as { model: string; max_tokens: number }
    expect(body).toMatchObject({ model: 'glm-5.2', max_tokens: 1 })
  })

  it('a 401 from the provider -> ok:false with an error message, without leaking the key', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: KEY })
    verifyResponse = () => new Response('unauthorized', { status: 401 })
    const res = await post(`/api/providers/${id}/verify`)
    expect(res.json()).toEqual({ ok: false, error: 'the provider rejected the key (HTTP 401)' })
    expect(res.body).not.toContain(KEY)
  })

  it('a network failure -> an honest ok:false', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: KEY })
    verifyResponse = () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    const res = await post(`/api/providers/${id}/verify`)
    const out = res.json() as { ok: boolean; error: string }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('could not contact')
  })

  it('404 if the provider does not exist', async () => {
    expect((await post('/api/providers/nothing/verify')).statusCode).toBe(404)
  })

  // closes the PATCH-baseUrl+verify exfiltration bypass — the key only
  // ever travels to the endpoint it was pasted for.
  it('a PATCH of baseUrl invalidates the key; verify with no key = 400 and ZERO network calls', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: KEY })
    const res = await patch(`/api/providers/${id}`, { baseUrl: 'https://collector.evil' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { provider: { apiKey: string } }).provider.apiKey).toBe('') // the UI sees "no key"
    expect(providers.get(id)?.apiKey).toBe('')

    const v = await post(`/api/providers/${id}/verify`)
    expect(v.statusCode).toBe(400)
    expect((v.json() as { error: string }).error).toContain('paste the key again')
    expect(verifyCalls).toHaveLength(0) // the new endpoint was never contacted

    // re-pasting the key (or changing baseUrl WITH a key) restores the normal flow
    await patch(`/api/providers/${id}`, { apiKey: 'sk-new-abcdef123456' })
    expect((await post(`/api/providers/${id}/verify`)).json()).toEqual({ ok: true })
    expect(verifyCalls).toHaveLength(2) // the models listing (nothing we understand here), then the ping
    expect(verifyCalls[0]!.url).toBe('https://collector.evil/v1/models')
    expect(verifyCalls[1]!.url).toBe('https://collector.evil/v1/messages')
  })

  it("with no model given, verify lists the key's models first and pings with the FIRST one it reaches (a pool key only runs its pool)", async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: KEY })
    verifyResponse = () =>
      verifyCalls.length === 1
        ? new Response(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3' }, { id: 'minimax-m3' }] }), { status: 200 })
        : new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 })
    const res = await post(`/api/providers/${id}/verify`)
    expect(res.json()).toEqual({ ok: true, models: ['glm-5.3', 'minimax-m3'] })
    expect(verifyCalls.map((c) => c.url)).toEqual(['https://api.ci.test/v1/models', 'https://api.ci.test/anthropic/v1/messages'])
    expect(JSON.parse(String(verifyCalls[1]!.init.body))).toMatchObject({ model: 'glm-5.3', max_tokens: 1 })
    const stored = providers.get(id)
    expect(stored?.kind === 'anthropic-compatible' ? stored.models : null).toEqual(['glm-5.3', 'minimax-m3'])
    expect(res.body).not.toContain(KEY)
  })
})

describe('POST /api/providers/connect — verify first, store only what works', () => {
  const list = (ids: string[]) => new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }), { status: 200 })
  const pong = () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 })

  it('a working key is stored ONCE, named after what it reaches, with its models; 201 then 200 for the same key', async () => {
    verifyResponse = () => (verifyCalls.length % 2 === 1 ? list(['mimo-v2.6-flash', 'deepseek-v4.1-flash']) : pong())
    const r1 = await post('/api/providers/connect', { label: 'cheapestinference', baseUrl: 'https://api.cheapestinference.com/anthropic', apiKey: KEY })
    expect(r1.statusCode).toBe(201)
    const b1 = r1.json() as { provider: Record<string, unknown>; models: string[] }
    expect(b1.models).toEqual(['mimo-v2.6-flash', 'deepseek-v4.1-flash'])
    expect(b1.provider.label).toBe('cheapestinference · mimo-v2.6-flash, deepseek-v4.1-flash')
    expect(b1.provider.models).toEqual(['mimo-v2.6-flash', 'deepseek-v4.1-flash'])
    expect(b1.provider.apiKey).toBe('sk-…3456')
    expect(r1.body).not.toContain(KEY)
    // the ping used the FIRST listed model, not a Claude id
    expect(JSON.parse(String(verifyCalls[1]!.init.body))).toMatchObject({ model: 'mimo-v2.6-flash', max_tokens: 1 })
    // the same key pasted again = the same row, not a twin
    const r2 = await post('/api/providers/connect', { label: 'cheapestinference', baseUrl: 'https://api.cheapestinference.com/anthropic', apiKey: KEY })
    expect(r2.statusCode).toBe(200)
    expect((r2.json() as { provider: { id: string } }).provider.id).toBe(b1.provider.id)
    expect(providers.list().filter((p) => p.kind === 'anthropic-compatible')).toHaveLength(1)
  })

  it("a key the gateway refuses stores NOTHING and answers with the provider's words", async () => {
    verifyResponse = () => new Response(JSON.stringify({ type: 'error', error: { message: 'The model `x` does not exist' } }), { status: 404 })
    const res = await post('/api/providers/connect', {
      label: 'cheapestinference',
      baseUrl: 'https://api.cheapestinference.com/anthropic',
      apiKey: 'sk-live-wrong-key-123456',
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain('HTTP 404')
    expect(providers.list()).toHaveLength(0)
    expect(res.body).not.toContain('sk-live-wrong')
  })

  it('a typed name is kept; an unlisted gateway keeps the host as its name; OpenCode kinds are refused', async () => {
    verifyResponse = () => (verifyCalls.length % 2 === 1 ? new Response('nope', { status: 404 }) : pong())
    const named = await post('/api/providers/connect', { label: 'my proxy', baseUrl: 'https://byok.test', apiKey: KEY })
    expect((named.json() as { provider: { label: string; models?: string[] } }).provider).toMatchObject({ label: 'my proxy' })
    expect((named.json() as { models: string[] }).models).toEqual([])
    const bad = await post('/api/providers/connect', { kind: 'harness-native', label: 'k', harness: 'opencode', providerId: 'kimi-for-coding' })
    expect(bad.statusCode).toBe(400)
  })
})

describe('POST /api/providers/:id/models — what the key reaches', () => {
  it('asks <root>/v1/models with the stored key, persists the ids, and GET lists them', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: KEY })
    verifyResponse = () =>
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'kimi-k3' }, { id: 'qwen3.8-max' }, { id: 'kimi-k3' }] }), { status: 200 })
    const res = await post(`/api/providers/${id}/models`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, models: ['kimi-k3', 'qwen3.8-max'] })
    expect(verifyCalls).toHaveLength(1)
    expect(verifyCalls[0]!.url).toBe('https://api.ci.test/v1/models') // the passthrough segment stripped
    expect((verifyCalls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    expect(res.body).not.toContain(KEY)
    const stored = providers.get(id)
    expect(stored?.kind === 'anthropic-compatible' ? stored.models : null).toEqual(['kimi-k3', 'qwen3.8-max'])
    const list = (await get('/api/providers')).json() as { providers: Array<Record<string, unknown>> }
    expect(list.providers.find((p) => p.id === id)?.models).toEqual(['kimi-k3', 'qwen3.8-max'])
  })

  it('a gateway without a listing (HTTP 404, or an unreadable body) leaves the provider as it was', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://proxy.test', apiKey: KEY, models: ['old-model'] })
    verifyResponse = () => new Response('nope', { status: 404 })
    const r1 = (await post(`/api/providers/${id}/models`)).json() as { ok: boolean; models: string[]; error: string }
    expect(r1.ok).toBe(false)
    expect(r1.models).toEqual(['old-model'])
    expect(r1.error).toContain('listed no models')
    verifyResponse = () => new Response('not json', { status: 200 })
    const r2 = (await post(`/api/providers/${id}/models`)).json() as { ok: boolean; models: string[] }
    expect(r2).toMatchObject({ ok: false, models: ['old-model'] }) // answered, but listed nothing we understand — the old list stays
  })

  it('refuses an OpenCode provider (400) and a keyless one (400, zero network)', async () => {
    const oc = providers.create({
      kind: 'harness-provider',
      label: 'mm',
      harness: 'opencode',
      providerId: 'minimax-coding-plan',
      apiKey: 'mm-key-abcdef123456',
    })
    expect((await post(`/api/providers/${oc.id}/models`)).statusCode).toBe(400)
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: KEY })
    await patch(`/api/providers/${id}`, { baseUrl: 'https://elsewhere.test' })
    expect((await post(`/api/providers/${id}/models`)).statusCode).toBe(400)
    expect(verifyCalls).toHaveLength(0)
    expect((await post('/api/providers/nope/models')).statusCode).toBe(404)
  })

  it('PATCH models validates; a baseUrl change drops the list with the key; create accepts a list', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: KEY })
    expect((await patch(`/api/providers/${id}`, { models: 'kimi-k3' })).statusCode).toBe(400)
    expect((await patch(`/api/providers/${id}`, { models: ['{env:X}'] })).statusCode).toBe(400)
    const ok = await patch(`/api/providers/${id}`, { models: [' kimi-k3 ', 'glm-5.3'] })
    expect((ok.json() as { provider: { models: string[] } }).provider.models).toEqual(['kimi-k3', 'glm-5.3'])
    const moved = await patch(`/api/providers/${id}`, { baseUrl: 'https://other.test/anthropic' })
    expect((moved.json() as { provider: Record<string, unknown> }).provider.models).toBeUndefined()
    const created = await post('/api/providers', { label: 'x', baseUrl: 'https://p.test', apiKey: KEY, models: ['a', 'a', 'b'] })
    expect((created.json() as { provider: { models: string[] } }).provider.models).toEqual(['a', 'b'])
    // models never land on an OpenCode provider
    const bad = await post('/api/providers', { kind: 'harness-native', label: 'k', harness: 'opencode', providerId: 'kimi-for-coding', models: ['a'] })
    expect(bad.statusCode).toBe(400)
  })
})

describe('/api/accounts', () => {
  it('GET lists default + extras; POST creates a dir + a login command; verify reports status', async () => {
    const res = await get('/api/accounts')
    expect((res.json() as { accounts: Array<{ name: string }> }).accounts.map((a) => a.name)).toEqual(['default'])

    const created = await post('/api/accounts', { name: 'work' })
    expect(created.statusCode).toBe(201)
    const body = created.json() as { configDir: string; command: string }
    expect(body.command).toBe(`CLAUDE_CONFIG_DIR=${body.configDir} claude auth login`)

    // still not logged in
    const v1 = await post('/api/accounts/work/verify')
    expect((v1.json() as { account: { loggedIn: boolean } }).account.loggedIn).toBe(false)

    fakeSignIn(body.configDir, { email: 'w@test.dev', subscriptionType: 'pro' })
    const v2 = await post('/api/accounts/work/verify')
    expect((v2.json() as { account: unknown }).account).toMatchObject({ loggedIn: true, email: 'w@test.dev', plan: 'Pro' })
  })

  it('POST validates: no name -> 400, duplicate -> 400, verify of a nonexistent one -> 404', async () => {
    expect((await post('/api/accounts', {})).statusCode).toBe(400)
    await post('/api/accounts', { name: 'two' })
    expect((await post('/api/accounts', { name: 'two' })).statusCode).toBe(400)
    expect((await post('/api/accounts/nothing/verify')).statusCode).toBe(404)
  })
})

describe('provider/fallback validation on the agent routes', () => {
  it('PATCH with a known provider (or the default) passes; an unknown one -> 400', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://a.test', apiKey: KEY })
    expect((await patch('/api/agents/finance', { provider: id })).statusCode).toBe(200)
    expect((await patch('/api/agents/finance', { provider: 'default' })).statusCode).toBe(200)
    const bad = await patch('/api/agents/finance', { provider: 'ghost' })
    expect(bad.statusCode).toBe(400)
    expect((bad.json() as { error: string }).error).toContain('unknown')
  })

  it('fallback: an array of known ids passes and persists; an unknown id or a weird shape -> 400', async () => {
    const { id } = providers.create({ label: 'ci', baseUrl: 'https://a.test', apiKey: KEY })
    expect((await patch('/api/agents/finance', { fallback: [id] })).statusCode).toBe(200)
    expect(registry.get('finance')?.fallback).toEqual([id])
    expect((await patch('/api/agents/finance', { fallback: ['ghost'] })).statusCode).toBe(400)
    expect((await patch('/api/agents/finance', { fallback: 'no-array' })).statusCode).toBe(400)
  })

  it('POST /api/agents validates the same way', async () => {
    const res = await post('/api/agents', { id: 'new', name: 'New', folder: '/tmp/n', provider: 'ghost' })
    expect(res.statusCode).toBe(400)
  })
})

// OpenCode provider kinds over HTTP, and the one
// cross-harness rule everywhere a provider id is written.
describe('OpenCode provider kinds — routes', () => {
  const MM = { kind: 'harness-provider', label: 'MiniMax', harness: 'opencode', providerId: 'minimax-coding-plan', apiKey: 'mm-secret-key-123456' }

  it('POST creates both kinds (key masked; the full key only on disk); GET lists them masked', async () => {
    const res = await post('/api/providers', MM)
    expect(res.statusCode).toBe(201)
    expect((res.json() as { provider: Record<string, unknown> }).provider).toMatchObject({
      kind: 'harness-provider',
      harness: 'opencode',
      providerId: 'minimax-coding-plan',
      apiKey: '…3456',
    })
    expect(res.body).not.toContain('mm-secret')
    expect(readFileSync(join(dataDir, 'providers.json'), 'utf8')).toContain('mm-secret-key-123456')
    const nat = await post('/api/providers', { kind: 'harness-native', label: 'Z.ai', harness: 'opencode', providerId: 'zai' })
    expect(nat.statusCode).toBe(201)
    expect((nat.json() as { provider: Record<string, unknown> }).provider.apiKey).toBeUndefined()
    const list = await get('/api/providers')
    expect(list.body).not.toContain('mm-secret')
    expect((list.json() as { providers: Array<{ kind: string }> }).providers.map((p) => p.kind)).toEqual([
      'claude-account',
      'harness-provider',
      'harness-native',
    ])
  })

  it('POST validates per kind (400)', async () => {
    expect((await post('/api/providers', { ...MM, providerId: undefined })).statusCode).toBe(400)
    expect((await post('/api/providers', { ...MM, providerId: 'Mini Max' })).statusCode).toBe(400)
    expect((await post('/api/providers', { ...MM, apiKey: undefined })).statusCode).toBe(400)
    expect((await post('/api/providers', { ...MM, baseUrl: 'https://x.test' })).statusCode).toBe(400)
    expect((await post('/api/providers', { ...MM, harness: undefined })).statusCode).toBe(400)
    expect(
      (await post('/api/providers', { kind: 'harness-native', label: 'Z', harness: 'opencode', providerId: 'zai', apiKey: 'k-1234567890' })).statusCode,
    ).toBe(400)
    expect((await post('/api/providers', { kind: 'claude-account', label: 'x' })).statusCode).toBe(400)
    expect(providers.list()).toEqual([])
  })

  it('PATCH: providerId of a harness-provider; baseUrl refused on it; verify refuses with zero network', async () => {
    const { id } = providers.create(MM as never)
    expect((await patch(`/api/providers/${id}`, { baseUrl: 'https://evil.test' })).statusCode).toBe(400)
    const moved = await patch(`/api/providers/${id}`, { providerId: 'zai' })
    expect(moved.statusCode).toBe(200)
    expect(providers.get(id)).toMatchObject({ providerId: 'zai', apiKey: '' })
    expect((await post(`/api/providers/${id}/verify`)).statusCode).toBe(400)
    expect(verifyCalls).toHaveLength(0)
  })

  it('agents: a Claude account on an OpenCode agent -> 400 (provider or fallback); the default stays neutral', async () => {
    mkdirSync(join(dataDir, 'claude-accounts', 'main'), { recursive: true })
    const mm = providers.create(MM as never)
    const acct = await post('/api/agents', { id: 'oc', name: 'Oc', folder: '/tmp/oc', framework: 'opencode', provider: 'account:main' })
    expect(acct.statusCode).toBe(400)
    expect((acct.json() as { error: string }).error).toBe('a Claude account cannot run on OpenCode')
    expect(
      (await post('/api/agents', { id: 'oc', name: 'Oc', folder: '/tmp/oc', framework: 'opencode', provider: mm.id, fallback: ['account:main'] })).statusCode,
    ).toBe(400)
    expect(registry.get('oc')).toBeNull()
    expect((await post('/api/agents', { id: 'oc', name: 'Oc', folder: '/tmp/oc', framework: 'opencode', provider: 'default' })).statusCode).toBe(201)
    const pmm = await patch('/api/agents/oc', { provider: mm.id })
    expect(pmm.statusCode).toBe(200)
    expect(registry.get('oc')?.provider).toBe(mm.id)
    const pf = await patch('/api/agents/oc', { fallback: ['account:main'] })
    expect(pf.statusCode).toBe(400)
    expect((pf.json() as { error: string }).error).toBe('a Claude account cannot run on OpenCode')
  })

  it('agents: an OpenCode provider on a Claude Code agent -> 400 (provider or fallback)', async () => {
    const mm = providers.create(MM as never)
    const zai = providers.create({ kind: 'harness-native', label: 'Z.ai', harness: 'opencode', providerId: 'zai' })
    for (const body of [{ provider: mm.id }, { provider: zai.id }, { fallback: [mm.id] }]) {
      const res = await patch('/api/agents/finance', body)
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toBe('this provider is for OpenCode agents')
    }
    expect((await post('/api/agents', { id: 'cc', name: 'Cc', folder: '/tmp/cc', provider: mm.id })).statusCode).toBe(400)
    expect(registry.get('finance')?.provider).not.toBe(mm.id)
  })

  it("a conversation pin must suit the conversation's harness (its id says which)", async () => {
    mkdirSync(join(dataDir, 'claude-accounts', 'main'), { recursive: true })
    const mm = providers.create(MM as never)
    const folder = '-tmp-oc'
    const oc = await patch(`/api/sessions/${folder}/ses_abc123/prefs`, { provider: 'account:main' })
    expect(oc.statusCode).toBe(400)
    expect((oc.json() as { error: string }).error).toBe('a Claude account cannot run on OpenCode')
    expect((await patch(`/api/sessions/${folder}/ses_abc123/prefs`, { provider: mm.id })).statusCode).toBe(200)
    const cl = await patch(`/api/sessions/${folder}/0b8f8a8e-1111-4222-8333-444455556666/prefs`, { provider: mm.id })
    expect(cl.statusCode).toBe(400)
    expect((cl.json() as { error: string }).error).toBe('this provider is for OpenCode agents')
    expect((await patch(`/api/sessions/${folder}/0b8f8a8e-1111-4222-8333-444455556666/prefs`, { provider: 'account:main' })).statusCode).toBe(200)
  })

  it("a turn override must suit the agent's harness", async () => {
    const mm = providers.create(MM as never)
    const res = await post('/api/agents/finance/chat', { text: 'hi', overrides: { provider: mm.id } })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toBe('this provider is for OpenCode agents')
  })
})

describe('/api/settings — the unattended provider', () => {
  it("starts at null (each agent's own account); PATCH sets it, persisted 0600, and null clears it", async () => {
    expect((await get('/api/settings')).json()).toMatchObject({ unattendedProvider: null, keepOwnAccount: [] })
    const id = providers.create({ kind: 'anthropic-compatible', label: 'Gateway', baseUrl: 'https://gw.example', apiKey: KEY }).id
    const r = await patch('/api/settings', { unattendedProvider: id })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ unattendedProvider: id, keepOwnAccount: [] })
    const file = join(dataDir, 'settings.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ unattendedProvider: id })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const again = new PlatformSettingsStore(dataDir)
    again.load()
    expect(again.unattendedProvider()).toBe(id)
    expect((await patch('/api/settings', { unattendedProvider: null })).json()).toMatchObject({ unattendedProvider: null })
  })

  it('400 «no such provider» for an id that does not exist (or no field at all)', async () => {
    const r = await patch('/api/settings', { unattendedProvider: 'nope' })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('no such provider')
    expect((await patch('/api/settings', {})).statusCode).toBe(400)
  })

  it("per engine: 400 only when it runs on NONE of the agents' engines; otherwise the rest keep their own account", async () => {
    const zai = providers.create({ kind: 'harness-provider', harness: 'opencode', providerId: 'zai', label: 'Zai', apiKey: KEY }).id
    // only a Claude Code agent: an OpenCode key runs on none of them
    const refused = await patch('/api/settings', { unattendedProvider: zai })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error).toBe("Zai runs on none of your agents' engines — pick one that does")
    // a mixed fleet: it applies to the OpenCode agent, the Claude one keeps its own
    registry.create({ id: 'oc', name: 'Oc', folder: '/tmp/project-x', framework: 'opencode' })
    const ok = await patch('/api/settings', { unattendedProvider: zai })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().keepOwnAccount).toEqual(['Claude Code'])
  })
})
