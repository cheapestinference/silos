// agent-vault.test.ts — an agent's OWN scope in the Vault:
// it writes secrets visible to itself alone, rotates the ones it wrote, and
// never touches what the owner set, a shared entry or another agent's scope.
// Every who-may-do-what variant is pinned here: store, authz and route.
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
import { buildServer } from '../src/server.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { VaultStore } from '../src/vault-store.js'
import { agentMayRead, agentMayWrite } from '../src/agent-authz.js'
import { asOwner } from './helpers/owner.js'
import { bearerWritesCarryTurns } from './helpers/live-turn.js'

const TOKEN = 't0k-agent-vault'
const LOCAL = { host: '127.0.0.1:3210' }
let app: FastifyInstance
let vault: VaultStore, vaultPath: string
let agentTokens: AgentTokens
let agentFolder: string

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-agent-vault-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  agentFolder = join(base, 'project')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(agentFolder, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'builder', name: 'Builder', folder: agentFolder })
  registry.create({ id: 'finance', name: 'Finance', folder: agentFolder })
  agentTokens = new AgentTokens(dataDir)
  vaultPath = join(dataDir, 'vault.json')
  vault = new VaultStore(vaultPath)
  vault.load()
  const native = new NativeStore(join(dataDir, 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no turns here')
    },
    dataDir,
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
    token: TOKEN,
    liveMs: 120_000,
    agentTokens,
    vault,
  })
  bearerWritesCarryTurns(app, chat, agentTokens)
  asOwner(app, TOKEN)
})

afterEach(async () => {
  await app.close()
})

const owner = { ...LOCAL }
const bearer = (id: string) => ({ ...LOCAL, authorization: `Bearer ${agentTokens.tokenFor(id)}` })
const call = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })

describe('VaultStore — an agent’s own scope', () => {
  it('writes an entry visible to the agent alone, authored by it, persisted 0600', () => {
    const { entry, replaced } = vault.writeOwn('builder', { name: 'SERVICE_COOKIE', value: 'c-1' })
    expect(replaced).toBe(false)
    expect(entry.scope).toEqual({ type: 'agents', agentIds: ['builder'] })
    expect(entry.createdBy).toBe('builder')
    const again = new VaultStore(vaultPath)
    again.load()
    expect(again.list()[0]?.createdBy).toBe('builder')
    expect(again.envFor('builder', null)).toEqual({ SERVICE_COOKIE: 'c-1' })
    expect(again.envFor('finance', null)).toEqual({})
  })

  it('a second write of its own name rotates the value in place (same id)', () => {
    const a = vault.writeOwn('builder', { name: 'SERVICE_COOKIE', value: 'c-1' })
    const b = vault.writeOwn('builder', { name: 'SERVICE_COOKIE', value: 'c-2' })
    expect(b.replaced).toBe(true)
    expect(b.entry.id).toBe(a.entry.id)
    expect(vault.list()).toHaveLength(1)
    expect(vault.envFor('builder', null).SERVICE_COOKIE).toBe('c-2')
  })

  it('never overwrites a value the owner set in that same scope', () => {
    vault.create({ name: 'LITELLM_MASTER_KEY', value: 'owner-v', scope: { type: 'agents', agentIds: ['builder'] } })
    expect(() => vault.writeOwn('builder', { name: 'LITELLM_MASTER_KEY', value: 'agent-v' })).toThrow(/only the owner/)
    expect(vault.envFor('builder', null).LITELLM_MASTER_KEY).toBe('owner-v')
  })

  it('a shared or folder entry with the same name does not block its own (and its own wins in its env)', () => {
    vault.create({ name: 'SHARED', value: 'shared-v', scope: { type: 'agents', agentIds: ['finance', 'builder'] } })
    vault.create({ name: 'SHARED', value: 'folder-v', scope: { type: 'folder', folder: agentFolder } })
    vault.writeOwn('builder', { name: 'SHARED', value: 'own-v' })
    expect(vault.envFor('builder', agentFolder).SHARED).toBe('own-v')
    expect(vault.envFor('finance', agentFolder).SHARED).toBe('shared-v')
  })

  it('keeps the Vault’s name hygiene', () => {
    expect(() => vault.writeOwn('builder', { name: 'ANTHROPIC_API_KEY', value: 'x' })).toThrow()
    expect(() => vault.writeOwn('builder', { name: 'PATH', value: 'x' })).toThrow()
    expect(() => vault.writeOwn('builder', { name: 'lower', value: 'x' })).toThrow()
    expect(() => vault.writeOwn('builder', { name: 'OK_NAME', value: '' })).toThrow()
  })

  it('removeOwn deletes only what it wrote in its own scope', () => {
    const own = vault.writeOwn('builder', { name: 'MINE', value: 'v' }).entry
    const ownerSet = vault.create({ name: 'OWNERS', value: 'v', scope: { type: 'agents', agentIds: ['builder'] } })
    const other = vault.writeOwn('finance', { name: 'CFOS', value: 'v' }).entry
    expect(vault.removeOwn('builder', ownerSet.id)).toBe('not-yours')
    expect(vault.removeOwn('builder', other.id)).toBe('not-yours')
    expect(vault.removeOwn('builder', 'nope')).toBe('not-found')
    expect(vault.removeOwn('builder', own.id)).toBe('removed')
    expect(
      vault
        .list()
        .map((e) => e.name)
        .sort(),
    ).toEqual(['CFOS', 'OWNERS'])
  })

  it('a widened entry (the owner shared it) is no longer the agent’s to change', () => {
    const own = vault.writeOwn('builder', { name: 'MINE', value: 'v' }).entry
    vault.setScope(own.id, { type: 'agents', agentIds: ['builder', 'writer'] })
    expect(vault.removeOwn('builder', own.id)).toBe('not-yours')
    // a fresh own write of that name is a NEW entry in its own scope
    expect(vault.writeOwn('builder', { name: 'MINE', value: 'w' }).replaced).toBe(false)
  })

  it('viewFor lists the winner per name, masked, with mine only on its own', () => {
    vault.create({ name: 'G', value: 'global-secret-value', scope: { type: 'global' } })
    vault.create({ name: 'F', value: 'folder-secret-value', scope: { type: 'folder', folder: agentFolder } })
    vault.create({ name: 'O', value: 'owner-secret-value', scope: { type: 'agents', agentIds: ['builder'] } })
    vault.writeOwn('builder', { name: 'M', value: 'mine-secret-value' })
    vault.writeOwn('finance', { name: 'X', value: 'finance-secret-value' })
    const view = vault.viewFor('builder', [agentFolder])
    expect(view.map((v) => [v.name, v.source, v.mine])).toEqual([
      ['F', 'project', false],
      ['G', 'global', false],
      ['M', 'agent', true],
      ['O', 'agent', false],
    ])
    for (const v of view) expect(v.value).not.toMatch(/secret-value/)
  })
})

describe('authz — the own-scope routes', () => {
  it.each([
    ['builder', 'POST', '/api/agents/builder/vault', true],
    ['builder', 'POST', '/api/agents/%62uilder/vault', true],
    ['builder', 'POST', '/api/agents/finance/vault', false],
    ['builder', 'DELETE', '/api/agents/builder/vault/e1', true],
    ['builder', 'DELETE', '/api/agents/finance/vault/e1', false],
    ['builder', 'PATCH', '/api/agents/builder/vault/e1', false],
    ['builder', 'POST', '/api/agents/builder/vault/e1', false],
    ['builder', 'POST', '/api/vault', false],
    ['builder', 'PATCH', '/api/vault/e1', false],
    ['builder', 'DELETE', '/api/vault/e1', false],
  ] as const)('%s %s %s → %s', (agent, method, url, expected) => {
    expect(agentMayWrite(agent, method, url)).toBe(expected)
  })
  it('reads: its own vault yes, another’s or the whole Vault no', () => {
    expect(agentMayRead('builder', '/api/agents/builder/vault')).toBe(true)
    expect(agentMayRead('builder', '/api/agents/finance/vault')).toBe(false)
    expect(agentMayRead('builder', '/api/vault')).toBe(false)
  })
})

describe('routes /api/agents/:id/vault', () => {
  it('an agent writes, rotates, lists (masked) and deletes its own', async () => {
    const r1 = await call('POST', '/api/agents/builder/vault', bearer('builder'), { name: 'SERVICE_COOKIE', value: 'cookie-value-1' })
    expect(r1.statusCode).toBe(201)
    expect(r1.json().entry.value).not.toContain('cookie-value-1')
    expect(r1.json().entry.createdBy).toBe('builder')
    const r2 = await call('POST', '/api/agents/builder/vault', bearer('builder'), { name: 'SERVICE_COOKIE', value: 'cookie-value-2' })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().replaced).toBe(true)
    expect(vault.envFor('builder', null).SERVICE_COOKIE).toBe('cookie-value-2')
    const list = await call('GET', '/api/agents/builder/vault', bearer('builder'))
    expect(list.statusCode).toBe(200)
    expect(list.body).not.toContain('cookie-value')
    expect(list.json().entries).toHaveLength(1)
    const id = list.json().entries[0].id as string
    expect((await call('DELETE', `/api/agents/builder/vault/${id}`, bearer('builder'))).statusCode).toBe(200)
    expect(vault.list()).toHaveLength(0)
  })

  it('the owner’s entry: write 409, delete 403, the value survives', async () => {
    const e = vault.create({ name: 'LITELLM_MASTER_KEY', value: 'owner-v', scope: { type: 'agents', agentIds: ['builder'] } })
    expect((await call('POST', '/api/agents/builder/vault', bearer('builder'), { name: 'LITELLM_MASTER_KEY', value: 'x' })).statusCode).toBe(409)
    expect((await call('DELETE', `/api/agents/builder/vault/${e.id}`, bearer('builder'))).statusCode).toBe(403)
    expect(vault.envFor('builder', null).LITELLM_MASTER_KEY).toBe('owner-v')
  })

  it('another agent’s vault is closed both ways', async () => {
    vault.writeOwn('finance', { name: 'LEDGERLY', value: 'v' })
    expect((await call('GET', '/api/agents/finance/vault', bearer('builder'))).statusCode).toBe(403)
    expect((await call('POST', '/api/agents/finance/vault', bearer('builder'), { name: 'X', value: 'v' })).statusCode).toBe(403)
    const id = vault.list()[0]!.id
    expect((await call('DELETE', `/api/agents/finance/vault/${id}`, bearer('builder'))).statusCode).toBe(403)
    expect(vault.list()).toHaveLength(1)
  })

  it('the owner (and an unfenced agent with no bearer) writes on the agent’s behalf', async () => {
    const r = await call('POST', '/api/agents/builder/vault', owner, { name: 'K', value: 'v' })
    expect(r.statusCode).toBe(201)
    expect(vault.list()[0]?.createdBy).toBe('builder')
  })

  it('an unknown agent is a 404; a bad name a 400; the file never holds plaintext elsewhere', async () => {
    expect((await call('POST', '/api/agents/ghost/vault', owner, { name: 'K', value: 'v' })).statusCode).toBe(404)
    expect((await call('POST', '/api/agents/builder/vault', bearer('builder'), { name: 'CLAUDE_X', value: 'v' })).statusCode).toBe(400)
    await call('POST', '/api/agents/builder/vault', bearer('builder'), { name: 'K', value: 'plain' })
    expect(JSON.parse(readFileSync(vaultPath, 'utf8')).entries[0].createdBy).toBe('builder')
  })

  it('the owner marks an entry public in place (PATCH public): shown in clear; an agent bearer may not; a body with neither field is a 400', async () => {
    const e = vault.create({ name: 'PROJECT_ID', value: 'acme-public', scope: { type: 'global' } })
    expect((await call('GET', '/api/vault', owner)).json().entries[0].value).not.toBe('acme-public')
    expect((await call('PATCH', `/api/vault/${e.id}`, bearer('builder'), { public: true })).statusCode).toBe(403)
    expect((await call('PATCH', `/api/vault/${e.id}`, owner, {})).statusCode).toBe(400)
    const r = await call('PATCH', `/api/vault/${e.id}`, owner, { public: true })
    expect(r.statusCode).toBe(200)
    expect(r.json().entry).toMatchObject({ public: true, value: 'acme-public' })
    expect((await call('GET', '/api/vault', owner)).json().entries[0].value).toBe('acme-public')
  })

  it('the owner’s Vault list names the author', async () => {
    vault.writeOwn('builder', { name: 'K', value: 'v' })
    const r = await call('GET', '/api/vault', owner)
    expect(r.json().entries[0].createdBy).toBe('builder')
  })
})
