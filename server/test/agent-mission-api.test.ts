// The mission through the API: the
// owner writes it on POST and PATCH (null clears it), with the exact 400
// words; the fields it retired are refused with the pointer to it; an agent
// never writes its own (or anyone's) mission; and what was saved is what
// the next conversation's append carries.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
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
import { AgentTokens } from '../src/agent-tokens.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

const LOCAL = { host: '127.0.0.1:3210' }
let app: FastifyInstance, registry: AgentRegistry, chat: ChatService, tokens: AgentTokens, dataDir: string, folder: string

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'silos-mission-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  folder = mkdtempSync(join(tmpdir(), 'silos-mission-folder-'))
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(root, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'x', name: 'X', folder })
  registry.create({ id: 'y', name: 'Y', folder })
  const native = new NativeStore(join(dataDir, 'native.json'))
  chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no sdk')
    },
  })
  tokens = new AgentTokens(dataDir)
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
    agentTokens: tokens,
    home: base,
  })
  asOwner(app, 't0k')
})
afterEach(async () => {
  await app.close()
})

const onDisk = (id: string): Record<string, unknown> =>
  (JSON.parse(readFileSync(join(dataDir, 'agents.json'), 'utf8')) as { agents: Record<string, unknown>[] }).agents.find((a) => a.id === id)!

describe('POST /api/agents with a mission', () => {
  it('creates the agent with its mission, trimmed and stamped; its first conversation hears it', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: LOCAL,
      payload: { id: 'z', name: 'Z', folder, mission: { text: ' Taxes and accounts. ', never: ['file or pay anything', ''] } },
    })
    expect(r.statusCode).toBe(201)
    const m = r.json().agent.mission
    expect(m).toEqual({ text: 'Taxes and accounts.', never: ['file or pay anything'], updatedAt: expect.any(String) })
    expect(onDisk('z').mission).toEqual(m)
    expect(chat.systemAppendFor('z', [])!.startsWith("Your mission: Taxes and accounts.\nNever, without the owner's word:\n- file or pay anything\n\n")).toBe(
      true,
    )
  })

  it('without a mission the agent is born with none', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/agents', headers: LOCAL, payload: { id: 'z', name: 'Z', folder } })
    expect(r.statusCode).toBe(201)
    expect(r.json().agent.mission).toBeUndefined()
  })

  it('a bad mission is a 400 with its words, and no agent is left behind', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: LOCAL,
      payload: { id: 'z', name: 'Z', folder, mission: { text: '', never: ['a'] } },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('mission.text must be 1–2000 characters')
    expect(registry.get('z')).toBeNull()
  })
})

describe('PATCH /api/agents/:id — the owner edits the mission', () => {
  it('sets, replaces and clears it (null); each save is what the next conversation hears', async () => {
    let r = await app.inject({ method: 'PATCH', url: '/api/agents/x', headers: LOCAL, payload: { mission: { text: 'Answers the inbox.' } } })
    expect(r.statusCode).toBe(200)
    expect(r.json().agent.mission).toEqual({ text: 'Answers the inbox.', never: [], updatedAt: expect.any(String) })
    expect(chat.systemAppendFor('x', [])!.startsWith('Your mission: Answers the inbox.\n\n')).toBe(true)

    r = await app.inject({ method: 'PATCH', url: '/api/agents/x', headers: LOCAL, payload: { mission: { text: 'Books.', never: ['pay'] } } })
    expect(r.json().agent.mission.never).toEqual(['pay'])
    expect(chat.systemAppendFor('x', [])!.startsWith("Your mission: Books.\nNever, without the owner's word:\n- pay\n\n")).toBe(true)

    r = await app.inject({ method: 'PATCH', url: '/api/agents/x', headers: LOCAL, payload: { mission: null } })
    expect(r.statusCode).toBe(200)
    expect(r.json().agent.mission).toBeUndefined()
    expect('mission' in onDisk('x')).toBe(false)
    expect(chat.systemAppendFor('x', [])).not.toContain('Your mission')
  })

  it('400s with the exact words and leaves the saved mission alone', async () => {
    await app.inject({ method: 'PATCH', url: '/api/agents/x', headers: LOCAL, payload: { mission: { text: 'Books.' } } })
    const long = await app.inject({ method: 'PATCH', url: '/api/agents/x', headers: LOCAL, payload: { mission: { text: 'x'.repeat(2001) } } })
    expect(long.statusCode).toBe(400)
    expect(long.json().error).toBe('mission.text must be 1–2000 characters')
    const never = await app.inject({
      method: 'PATCH',
      url: '/api/agents/x',
      headers: LOCAL,
      payload: { mission: { text: 'ok', never: Array.from({ length: 11 }, () => 'n') } },
    })
    expect(never.statusCode).toBe(400)
    expect(never.json().error).toBe('mission.never must be up to 10 lines of up to 200 characters')
    expect((onDisk('x').mission as { text: string }).text).toBe('Books.')
  })
})

// R3: the mission is the owner's — the agent proposes, it never edits its
// own (agent-authz: a bearer never reaches PATCH /api/agents; the fence
// keeps agents.json out of its file tools, t1)
describe('an agent never writes a mission', () => {
  it('its bearer cannot PATCH its own mission, nor another agent’s', async () => {
    for (const target of ['x', 'y']) {
      const r = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${target}`,
        headers: { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('x')}` },
        payload: { mission: { text: 'I decide now.' } },
      })
      expect(r.statusCode).toBe(403)
      expect(registry.get(target)!.mission).toBeUndefined()
    }
  })

  it('nor can it create an agent with one', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('x')}` },
      payload: { id: 'z', name: 'Z', folder, mission: { text: 'Mine.' } },
    })
    expect(r.statusCode).toBe(403)
    expect(registry.get('z')).toBeNull()
  })
})
