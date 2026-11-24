// providers-import.test.ts — Settings › Providers "Import from OpenCode" and
// "Copy config": the operator's auth.json (a temp one, through
// SILOS_OPENCODE_DATA) is read for ids and, on an explicit import, for ONE
// key — never written, never echoed; export snippets never carry a key.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
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
import { AgentTokens } from '../src/agent-tokens.js'
import { buildServer } from '../src/server.js'
import { authFilePath, readAuthIds, readAuthKey } from '../src/harnesses/opencode/auth-file.js'
import { validateProviderCreate, validateProviderPatch } from '../src/providers-validate.js'
import { asOwner } from './helpers/owner.js'
import { fakeIdentity } from './helpers/fake-claude-auth.js'

const LOCAL = { host: '127.0.0.1:3210' }
const AUTH = {
  zai: { type: 'api', key: 'sk-1' },
  'kimi-for-coding': { type: 'api', key: 'sk-kimi-secret-0001' },
  'github-copilot': { type: 'oauth', refresh: 'r', access: 'a' },
}

let app: FastifyInstance, providers: ProvidersStore, tokens: AgentTokens, ocData: string, authFile: string
const prevEnv = process.env.SILOS_OPENCODE_DATA

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-provimport-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  ocData = join(base, 'xdg')
  mkdirSync(join(ocData, 'opencode'), { recursive: true })
  authFile = join(ocData, 'opencode', 'auth.json')
  writeFileSync(authFile, JSON.stringify(AUTH), { mode: 0o600 })
  process.env.SILOS_OPENCODE_DATA = ocData
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'oc', name: 'Oc', folder: '/tmp/p', framework: 'opencode' })
  providers = new ProvidersStore(dataDir)
  providers.load()
  tokens = new AgentTokens(dataDir)
  const accounts = new AccountsService({ dataDir, defaultConfigDir: join(base, 'dot-claude'), identity: fakeIdentity(join(base, 'dot-claude')) })
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
    agentTokens: tokens,
    home: base,
  })
  asOwner(app, 't')
})
afterEach(async () => {
  await app.close()
  if (prevEnv === undefined) delete process.env.SILOS_OPENCODE_DATA
  else process.env.SILOS_OPENCODE_DATA = prevEnv
})

const get = (url: string) => app.inject({ url, headers: LOCAL })
const post = (url: string, body: unknown, headers: Record<string, string> = LOCAL) =>
  app.inject({ url, method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) })

describe('auth-file (read only)', () => {
  it('reads ids (sorted) and one key; the file is never modified', () => {
    const before = readFileSync(authFile, 'utf8')
    const mtime = statSync(authFile).mtimeMs
    expect(authFilePath()).toBe(authFile)
    expect(readAuthIds()).toEqual(['github-copilot', 'kimi-for-coding', 'zai'])
    expect(readAuthKey('/nowhere', 'zai')).toEqual({ ok: true, key: 'sk-1' })
    expect(readAuthKey('/nowhere', 'github-copilot')).toEqual({ ok: false, reason: 'not-api' })
    expect(readAuthKey('/nowhere', 'nope')).toEqual({ ok: false, reason: 'missing' })
    expect(readAuthKey('/nowhere', '../x')).toEqual({ ok: false, reason: 'missing' })
    expect(readFileSync(authFile, 'utf8')).toBe(before)
    expect(statSync(authFile).mtimeMs).toBe(mtime)
    expect(statSync(authFile).mode & 0o777).toBe(0o600)
  })
  it('no file or malformed JSON → no ids', () => {
    writeFileSync(authFile, '{nope')
    expect(readAuthIds()).toEqual([])
    process.env.SILOS_OPENCODE_DATA = join(ocData, 'missing')
    expect(readAuthIds()).toEqual([])
  })
})

describe('GET /api/providers/opencode/auth', () => {
  it('returns ids only — never a key', async () => {
    writeFileSync(authFile, JSON.stringify({ zai: { type: 'api', key: 'sk-1' } }))
    const res = await get('/api/providers/opencode/auth')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ids: ['zai'] })
    expect(res.body).not.toContain('sk-1')
  })
  it("is the owner's: an agent bearer gets 403", async () => {
    const res = await app.inject({ url: '/api/providers/opencode/auth', headers: { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('oc')}` } })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /api/providers/import-opencode', () => {
  it('creates a harness-provider with that key: 201 masked, store holds the key, auth.json untouched', async () => {
    const before = readFileSync(authFile, 'utf8')
    const res = await post('/api/providers/import-opencode', { providerId: 'zai', label: 'Z.ai' })
    expect(res.statusCode).toBe(201)
    const p = (res.json() as { provider: Record<string, unknown> }).provider
    expect(p).toMatchObject({ kind: 'harness-provider', harness: 'opencode', providerId: 'zai', label: 'Z.ai' })
    expect(res.body).not.toContain('sk-1"')
    expect(p.apiKey).toBe('…') // a 4-char key is masked whole
    expect(providers.get(p.id as string)).toMatchObject({ apiKey: 'sk-1' })
    expect(readFileSync(authFile, 'utf8')).toBe(before)
  })
  it('a longer key comes back as …last4', async () => {
    const res = await post('/api/providers/import-opencode', { providerId: 'kimi-for-coding', label: 'Kimi' })
    expect(res.statusCode).toBe(201)
    expect((res.json() as { provider: { apiKey: string } }).provider.apiKey).toBe('sk-…0001')
    expect(res.body).not.toContain('secret')
  })
  it('404 for an id auth.json does not hold; 400 for an OAuth login', async () => {
    expect((await post('/api/providers/import-opencode', { providerId: 'minimax-coding-plan', label: 'M' })).statusCode).toBe(404)
    const oauth = await post('/api/providers/import-opencode', { providerId: 'github-copilot', label: 'G' })
    expect(oauth.statusCode).toBe(400)
    expect(oauth.json().error).toMatch(/not an API key/)
  })
  it('409 when a Silos provider already has that providerId (either OpenCode kind)', async () => {
    providers.create({ kind: 'harness-native', label: 'zai login', harness: 'opencode', providerId: 'zai' })
    expect((await post('/api/providers/import-opencode', { providerId: 'zai', label: 'Z.ai' })).statusCode).toBe(409)
    expect((await post('/api/providers/import-opencode', { providerId: 'kimi-for-coding', label: 'K' })).statusCode).toBe(201)
    expect((await post('/api/providers/import-opencode', { providerId: 'kimi-for-coding', label: 'K' })).statusCode).toBe(409)
  })
  it('label required and brace-free; an agent bearer gets 403 and nothing is created', async () => {
    expect((await post('/api/providers/import-opencode', { providerId: 'zai', label: '' })).statusCode).toBe(400)
    expect((await post('/api/providers/import-opencode', { providerId: 'zai', label: 'Z {env:HOME}' })).statusCode).toBe(400)
    const res = await post('/api/providers/import-opencode', { providerId: 'zai', label: 'Z' }, { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('oc')}` })
    expect(res.statusCode).toBe(403)
    expect(providers.list()).toHaveLength(0)
  })
})

describe('GET /api/providers/:id/export', () => {
  it('anthropic-compatible → an opencode.json fragment (no key) and the Claude env block (no key)', async () => {
    const p = providers.create({
      kind: 'anthropic-compatible',
      label: 'cheapestinference',
      baseUrl: 'https://api.ci.test/anthropic',
      apiKey: 'sk-live-abcdef123456',
    })
    const oc = await get(`/api/providers/${p.id}/export?target=opencode`)
    expect(oc.statusCode).toBe(200)
    const snippet = (oc.json() as { snippet: string }).snippet
    const cfg = JSON.parse(snippet) as { provider: Record<string, { npm: string; name: string; options: { baseURL: string; apiKey: string } }> }
    expect(cfg.provider[`silos-${p.id}`]).toEqual({
      npm: '@ai-sdk/anthropic',
      name: 'cheapestinference',
      options: { baseURL: 'https://api.ci.test/anthropic/v1', apiKey: '<paste your key>' },
    })
    expect(oc.body).not.toContain('abcdef')
    const cl = await get(`/api/providers/${p.id}/export?target=claude`)
    expect(cl.statusCode).toBe(200)
    expect((cl.json() as { snippet: string }).snippet).toBe('ANTHROPIC_BASE_URL=https://api.ci.test/anthropic\nANTHROPIC_AUTH_TOKEN=<paste your key>\n')
    expect(cl.body).not.toContain('abcdef')
  })
  it('harness-provider → its catalogue id with a placeholder key; harness-native → the OpenCode login line; neither exports to Claude', async () => {
    const hp = providers.create({ kind: 'harness-provider', label: 'Z', harness: 'opencode', providerId: 'zai', apiKey: 'zai-secret-key-9999' })
    const res = await get(`/api/providers/${hp.id}/export?target=opencode`)
    expect(JSON.parse((res.json() as { snippet: string }).snippet)).toEqual({ provider: { zai: { options: { apiKey: '<paste your key>' } } } })
    expect(res.body).not.toContain('9999')
    const hn = providers.create({ kind: 'harness-native', label: 'K', harness: 'opencode', providerId: 'kimi-for-coding' })
    expect((await get(`/api/providers/${hn.id}/export?target=opencode`)).json()).toEqual({ snippet: 'opencode auth login   # choose kimi-for-coding\n' })
    expect((await get(`/api/providers/${hp.id}/export?target=claude`)).statusCode).toBe(400)
    expect((await get(`/api/providers/${hn.id}/export?target=claude`)).statusCode).toBe(400)
  })
  it("is the owner's: an agent bearer gets 403 (no snippet)", async () => {
    const p = providers.create({ kind: 'harness-native', label: 'K', harness: 'opencode', providerId: 'kimi-for-coding' })
    const res = await app.inject({
      url: `/api/providers/${p.id}/export?target=opencode`,
      headers: { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('oc')}` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('snippet')
  })
  it('404 unknown provider; 400 unknown target', async () => {
    expect((await get('/api/providers/nope/export?target=opencode')).statusCode).toBe(404)
    const p = providers.create({ kind: 'harness-native', label: 'K', harness: 'opencode', providerId: 'kimi-for-coding' })
    expect((await get(`/api/providers/${p.id}/export?target=vim`)).statusCode).toBe(400)
  })
})

describe('a `{` in a provider label/baseUrl is refused at write time (OpenCode substitutes over the config text)', () => {
  it('validator and store both refuse; the route answers 400', async () => {
    expect(() => validateProviderCreate({ label: 'a{b', baseUrl: 'https://x', apiKey: 'k-123456789012' })).toThrow(/\{/)
    expect(() => validateProviderCreate({ label: 'a', baseUrl: 'https://x/{env:HOME}', apiKey: 'k-123456789012' })).toThrow(/\{/)
    expect(() => validateProviderPatch({ label: 'x{' })).toThrow(/\{/)
    expect(() => validateProviderPatch({ baseUrl: 'https://{x}' })).toThrow(/\{/)
    expect(() => providers.create({ kind: 'harness-native', label: '{file:/etc/passwd}', harness: 'opencode', providerId: 'zai' })).toThrow(/\{/)
    const res = await post('/api/providers', { label: 'Z {env:HOME}', baseUrl: 'https://x', apiKey: 'k-123456789012' })
    expect(res.statusCode).toBe(400)
    const ok = providers.create({ kind: 'harness-native', label: 'fine', harness: 'opencode', providerId: 'zai' })
    const patch = await app.inject({
      url: `/api/providers/${ok.id}`,
      method: 'PATCH',
      headers: { ...LOCAL, 'content-type': 'application/json' },
      payload: JSON.stringify({ label: 'b{' }),
    })
    expect(patch.statusCode).toBe(400)
  })
})
