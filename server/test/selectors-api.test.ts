// selectors-api.test.ts — cockpit (model/effort/permissionMode/fastMode
// cascade): chat body validation, the cascade applied to query options,
// per-conversation prefs routes (GET/PATCH + pruning), and the model catalog.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { FastifyInstance } from 'fastify'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { ModelCatalog, type ModelInfo } from '../src/model-catalog.js'
import { buildServer } from '../src/server.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

// a genuinely LOCAL request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for the condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const TOKEN = 't0k'
const MODELS: ModelInfo[] = [
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'haiku', displayName: 'Haiku' },
]

let app: FastifyInstance, calls: QueryArgs[], folder: string, index: SessionIndex, native: NativeStore, root: string
let convPrefs: ConversationPrefsStore, catalog: ModelCatalog, catalogFetch: () => Promise<ModelInfo[]>
let chat: ChatService

function fakeQuery(script: SdkMessage[], sink: QueryArgs[]): (args: QueryArgs) => SdkQueryHandle {
  return (args) => {
    sink.push(args)
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of script) yield m
      },
      async interrupt() {
        return { status: 'interrupted' }
      },
    }
  }
}
const SCRIPT: SdkMessage[] = [
  // an echo of the real process: the effective model + permissionMode on init
  { type: 'system', subtype: 'init', session_id: 'sess-9', model: 'claude-sonnet-5', permissionMode: 'bypassPermissions' },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.01 },
]

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-sel-'))
  root = join(base, 'projects')
  folder = mkdtempSync(join(tmpdir(), 'deck-sel-folder-'))
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  mkdirSync(root, { recursive: true })
  index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder })
  registry.update('writer', { model: 'claude-sonnet-5' }) // the agent's default for the cascade
  native = new NativeStore(join(base, 'data', 'native.json'))
  calls = []
  convPrefs = new ConversationPrefsStore(join(base, 'data'))
  convPrefs.load()
  catalogFetch = async () => MODELS
  catalog = new ModelCatalog(join(base, 'data'), () => catalogFetch())
  catalog.load()
  chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), convPrefs, catalog })
  const exec = new ExecService(registry)
  const complete = new CompleteService(registry, index)
  const prefs = new PrefsStore(join(base, 'data'))
  const memory = new MemoryService(root, join(base, 'data'), registry)
  app = buildServer({
    index,
    registry,
    store: new SessionStore(root, join(base, 'data')),
    native,
    chat,
    exec,
    complete,
    prefs,
    memory,
    token: TOKEN,
    liveMs: 120_000,
    convPrefs,
    catalog,
  })
})
afterEach(async () => {
  await app.close()
})

function chatPost(payload: unknown) {
  return app.inject({ method: 'POST', url: '/api/agents/writer/chat', headers: { 'x-token': TOKEN }, payload: payload as never })
}

// a native session seeded in the index so it can be resumed
async function seedNative(id: string): Promise<string> {
  const mf = mungePath(folder)
  mkdirSync(join(root, mf), { recursive: true })
  writeFileSync(join(root, mf, `${id}.jsonl`), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"hi"}}\n`)
  await index.refresh(mf, id)
  native.register(mf, id, { agentId: 'writer', createdAt: 'x' })
  return mf
}

describe('POST /chat with overrides (turn level)', () => {
  it('invalid overrides -> 400, the query never starts', async () => {
    const cases: Array<[unknown, string]> = [
      [{ permissionMode: 'dontAsk' }, 'overrides.permissionMode must be one of: bypassPermissions, plan, acceptEdits'],
      [{ effort: 'ultra' }, 'overrides.effort must be one of: low, medium, high, xhigh, max'],
      [{ turbo: true }, 'unknown field in overrides: turbo'],
      [{ model: '' }, 'overrides.model must be a non-empty string'],
      [{ fastMode: 'yes' }, 'overrides.fastMode must be a boolean'],
      [{ model: null }, 'overrides.model does not accept null'],
      ['plan', 'overrides must be an object'],
    ]
    for (const [overrides, error] of cases) {
      const res = await chatPost({ text: 'hi', overrides })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(error)
    }
    expect(calls.length).toBe(0)
  })

  it("with no overrides: the original behavior (bypass + allowDangerously + the agent's model)", async () => {
    await chatPost({ text: 'hi' })
    await until(() => calls.length > 0)
    const o = calls[0]!.options
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o.allowDangerouslySkipPermissions).toBe(true)
    expect(o.model).toBe('claude-sonnet-5')
    expect(o.effort).toBeUndefined()
    expect(o.settings).toBeUndefined()
  })

  it('turn overrides reach the options: model/effort/permissionMode; plan does NOT carry allowDangerously', async () => {
    await chatPost({ text: 'hi', overrides: { model: 'haiku', effort: 'low', permissionMode: 'plan' } })
    await until(() => calls.length > 0)
    const o = calls[0]!.options
    expect(o.model).toBe('haiku')
    expect(o.effort).toBe('low')
    expect(o.permissionMode).toBe('plan')
    expect(o.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('fastMode travels as settings.fastMode (there is no dedicated Options field)', async () => {
    await chatPost({ text: 'hi', overrides: { fastMode: true } })
    await until(() => calls.length > 0)
    expect(calls[0]!.options.settings).toEqual({ fastMode: true })
  })

  it('the init echo (model/permissionMode) goes out over WS in chat-init', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const seen: any[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`)
    ws.on('message', (d) => seen.push(JSON.parse(String(d))))
    await new Promise((r) => ws.once('open', r))
    await chatPost({ text: 'hi' })
    await until(() => seen.some((m) => m.ev === 'chat-init'))
    ws.close()
    const init = seen.find((m) => m.ev === 'chat-init')
    expect(init.model).toBe('claude-sonnet-5')
    expect(init.permissionMode).toBe('bypassPermissions')
  })
})

describe('cascade at the conversation level (resume)', () => {
  it("the conversation's prefs override the agent on a resume", async () => {
    const mf = await seedNative('nat1')
    convPrefs.patch(mf, 'nat1', { model: 'haiku', permissionMode: 'acceptEdits', fastMode: true })
    await chatPost({ text: 'continue', session: { folder: mf, id: 'nat1' } })
    await until(() => calls.length > 0)
    const o = calls[0]!.options
    expect(o.model).toBe('haiku')
    expect(o.permissionMode).toBe('acceptEdits')
    expect(o.allowDangerouslySkipPermissions).toBeUndefined()
    expect(o.settings).toEqual({ fastMode: true })
  })

  it('a turn override wins over the conversation, field by field', async () => {
    const mf = await seedNative('nat2')
    convPrefs.patch(mf, 'nat2', { model: 'haiku', effort: 'low' })
    await chatPost({ text: 'continue', session: { folder: mf, id: 'nat2' }, overrides: { effort: 'max' } })
    await until(() => calls.length > 0)
    const o = calls[0]!.options
    expect(o.model).toBe('haiku') // inherited from the conversation
    expect(o.effort).toBe('max') // the turn wins
  })

  it("a new chat (no resume) reads no conversation's prefs at all", async () => {
    convPrefs.patch(mungePath(folder), 'foreign', { model: 'haiku' })
    await chatPost({ text: 'hi' })
    await until(() => calls.length > 0)
    expect(calls[0]!.options.model).toBe('claude-sonnet-5')
  })
})

describe('routes /api/sessions/:folder/:id/prefs', () => {
  it('GET with no token -> 401; GET with no prefs -> {} (always 200)', async () => {
    const r401 = await app.inject({ method: 'GET', url: '/api/sessions/-p/s1/prefs', headers: REMOTE })
    expect(r401.statusCode).toBe(401)
    const r = await app.inject({ method: 'GET', url: '/api/sessions/-p/s1/prefs', headers: { 'x-token': TOKEN } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ prefs: {} })
  })

  it('PATCH validates (400), sets it and GET returns it; null clears the field', async () => {
    const bad = await app.inject({ method: 'PATCH', url: '/api/sessions/-p/s1/prefs', headers: { 'x-token': TOKEN }, payload: { permissionMode: 'default' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toContain('overrides.permissionMode must be one of')

    const set = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/-p/s1/prefs',
      headers: { 'x-token': TOKEN },
      payload: { model: 'sonnet', permissionMode: 'plan' },
    })
    expect(set.statusCode).toBe(200)
    expect(set.json().prefs).toEqual({ model: 'sonnet', permissionMode: 'plan' })

    const clear = await app.inject({ method: 'PATCH', url: '/api/sessions/-p/s1/prefs', headers: { 'x-token': TOKEN }, payload: { permissionMode: null } })
    expect(clear.json().prefs).toEqual({ model: 'sonnet' })

    const get = await app.inject({ method: 'GET', url: '/api/sessions/-p/s1/prefs', headers: { 'x-token': TOKEN } })
    expect(get.json()).toEqual({ prefs: { model: 'sonnet' } })
  })

  it('invalid params -> 400', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/sessions/with%20space/s1/prefs', headers: { 'x-token': TOKEN } })
    expect(r.statusCode).toBe(400)
  })

  it('PATCH no longer prunes — the prefs of a freshly-created session (not yet indexed) survive an unrelated PATCH', async () => {
    const mf = await seedNative('alive')
    // a new chat gets assigned: its key isn't in the index yet (watcher
    // latency window) — before the fix, the next PATCH would sweep it away.
    await app.inject({ method: 'PATCH', url: '/api/sessions/-born/n1/prefs', headers: { 'x-token': TOKEN }, payload: { model: 'haiku' } })
    await app.inject({ method: 'PATCH', url: `/api/sessions/${mf}/alive/prefs`, headers: { 'x-token': TOKEN }, payload: { effort: 'high' } })
    expect(convPrefs.get('-born', 'n1')).toEqual({ model: 'haiku' })
    expect(convPrefs.get(mf, 'alive')).toEqual({ effort: 'high' })
  })
})

// ChatService-level regressions (the generator directly, without a route)
async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('real inheritance on a fork', () => {
  it("a fork's chat-init copies the SOURCE's prefs to the new key, and turn 2 resolves with them", async () => {
    const mf = mungePath(folder)
    convPrefs.patch(mf, 'origin', { permissionMode: 'plan' })
    await drain(chat.send({ turnId: 'tf1', agentId: 'writer', text: 'continue', resume: { sessionId: 'origin', mode: 'fork' } }))
    // the fake script's init assigns session_id 'sess-9' — the new key
    expect(convPrefs.get(mf, 'sess-9')).toEqual({ permissionMode: 'plan' })

    calls.length = 0
    await drain(chat.send({ turnId: 'tf2', agentId: 'writer', text: 'turn 2', resume: { sessionId: 'sess-9', mode: 'append' } }))
    expect(calls[0]!.options.permissionMode).toBe('plan')
    expect(calls[0]!.options.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('forking a source with NO prefs -> a clean new key (an honest null)', async () => {
    const mf = mungePath(folder)
    await drain(chat.send({ turnId: 'tf3', agentId: 'writer', text: 'continue', resume: { sessionId: 'no-prefs', mode: 'fork' } }))
    expect(convPrefs.get(mf, 'sess-9')).toBeNull()
  })

  it('an append (not a fork) never copies anything', async () => {
    const mf = mungePath(folder)
    convPrefs.patch(mf, 'thread', { effort: 'low' })
    await drain(chat.send({ turnId: 'tf4', agentId: 'writer', text: 'continue', resume: { sessionId: 'thread', mode: 'append' } }))
    // sess-9 (the init's id) must not have received a copy: an append
    // resume is still the SAME conversation (the init's key matches for
    // real; here it only differs because of the fake script).
    expect(convPrefs.get(mf, 'sess-9')).toBeNull()
  })
})

describe('unattended runs stay byte-identical', () => {
  it('unattended:true + isolation (the isolated resident): the conversation level is IGNORED', async () => {
    const mf = mungePath(folder)
    convPrefs.patch(mf, 'thread', { permissionMode: 'plan', model: 'haiku', effort: 'low', fastMode: true })
    await drain(
      chat.send({
        turnId: 'ti1',
        agentId: 'writer',
        text: 'run',
        resume: { sessionId: 'thread', mode: 'append' },
        unattended: true,
        turn: { class: 'run' },
        isolation: { settingSources: [], disableAllHooks: true },
      }),
    )
    const o = calls[0]!.options
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o.allowDangerouslySkipPermissions).toBe(true)
    expect(o.model).toBe('claude-sonnet-5') // the agent's default, not the thread's
    expect(o.effort).toBeUndefined()
    expect(o.settings).toEqual({ disableAllHooks: true }) // no fastMode leaking through
  })

  it('unattended:true WITHOUT isolation (inheritHooks:true) also ignores the conversation level', async () => {
    const mf = mungePath(folder)
    convPrefs.patch(mf, 'thread2', { permissionMode: 'plan', model: 'haiku' })
    await drain(
      chat.send({
        turnId: 'ti2',
        agentId: 'writer',
        text: 'run',
        resume: { sessionId: 'thread2', mode: 'append' },
        unattended: true,
        turn: { class: 'run' }, // the resident ALWAYS passes this — isolation is no longer the proxy for it
      }),
    )
    const o = calls[0]!.options
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o.model).toBe('claude-sonnet-5')
  })

  it("the flag is the ONLY key — isolation without unattended (doesn't happen in prod) does NOT skip the prefs", async () => {
    const mf = mungePath(folder)
    convPrefs.patch(mf, 'thread3', { permissionMode: 'plan' })
    await drain(
      chat.send({
        turnId: 'ti3',
        agentId: 'writer',
        text: 'x',
        resume: { sessionId: 'thread3', mode: 'append' },
        isolation: { settingSources: [], disableAllHooks: true },
      }),
    )
    expect(calls[0]!.options.permissionMode).toBe('plan')
  })
})

describe('catalog-gated effort/fastMode support on the server', () => {
  it('a model the catalog KNOWS has no support: effort and fastMode are dropped', async () => {
    await catalog.refresh() // sonnet (effort: yes) + haiku (nothing)
    await drain(chat.send({ turnId: 'tc1', agentId: 'writer', text: 'x', overrides: { model: 'haiku', effort: 'max', fastMode: true } }))
    const o = calls[0]!.options
    expect(o.model).toBe('haiku')
    expect(o.effort).toBeUndefined()
    expect(o.settings).toBeUndefined()
  })

  it('a model UNKNOWN to the catalog: passes through as-is (no invented validation)', async () => {
    await catalog.refresh()
    await drain(chat.send({ turnId: 'tc2', agentId: 'writer', text: 'x', overrides: { model: 'model-custom', effort: 'max', fastMode: true } }))
    const o = calls[0]!.options
    expect(o.effort).toBe('max')
    expect(o.settings).toEqual({ fastMode: true })
  })

  it('an empty catalog (never refreshed): passes through as-is — neither support nor lack of it is asserted', async () => {
    await drain(chat.send({ turnId: 'tc3', agentId: 'writer', text: 'x', overrides: { model: 'haiku', effort: 'low' } }))
    expect(calls[0]!.options.effort).toBe('low')
  })
})

describe('defense in depth inside send()', () => {
  it('an invalid override that bypasses the route throws at the choke point', async () => {
    await expect(drain(chat.send({ turnId: 'tv1', agentId: 'writer', text: 'x', overrides: { permissionMode: 'dontAsk' } as never }))).rejects.toThrow(
      'overrides.permissionMode must be one of',
    )
    expect(calls.length).toBe(0) // the query never started
  })
})

describe('routes /api/models', () => {
  it("GET is honestly empty before the first refresh; after a refresh it returns the SDK's catalog", async () => {
    const r0 = await app.inject({ method: 'GET', url: '/api/models', headers: { 'x-token': TOKEN } })
    expect(r0.json()).toEqual({ models: [], fetchedAt: null })

    const refresh = await app.inject({ method: 'POST', url: '/api/models/refresh', headers: { 'x-token': TOKEN } })
    expect(refresh.statusCode).toBe(200)
    const r1 = await app.inject({ method: 'GET', url: '/api/models', headers: { 'x-token': TOKEN } })
    expect(r1.json().models.map((m: ModelInfo) => m.value)).toEqual(['sonnet', 'haiku'])
    expect(typeof r1.json().fetchedAt).toBe('string')
  })

  it('a failed refresh -> 502 with an error message, the previous catalog stays intact', async () => {
    await app.inject({ method: 'POST', url: '/api/models/refresh', headers: { 'x-token': TOKEN } })
    catalogFetch = async () => {
      throw new Error('CLI down')
    }
    const r = await app.inject({ method: 'POST', url: '/api/models/refresh', headers: { 'x-token': TOKEN } })
    expect(r.statusCode).toBe(502)
    expect(r.json().error).toBe('CLI down')
    const models = (await app.inject({ method: 'GET', url: '/api/models', headers: { 'x-token': TOKEN } })).json().models
    expect(models).toHaveLength(2)
  })

  it('no token -> 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/models', headers: REMOTE })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/models/refresh', headers: REMOTE })).statusCode).toBe(401)
  })
})
