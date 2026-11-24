// The two trigger fields a requester may leave out — a
// `files` trigger's folder (the agent's main folder) and a `webhook`'s secret
// (generated, 32 random bytes base64url). The requester's 201/200 carries a
// generated secret ONCE (`generatedSecret`); afterwards an agent never reads
// it back (shownTo). On the proposals path, the owner sees it at create.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
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
import { AutomationsStore } from '../src/automations-store.js'
import { Resident } from '../src/resident.js'
import { buildServer } from '../src/server.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { ProvidersStore } from '../src/providers-store.js'
import { ProposalsStore } from '../src/proposals.js'
import { validateAutomationCreate, validateAutomationPatch, type ValidateExtras } from '../src/automations-validate.js'
import type { Automation } from '../src/automations-types.js'
import { bearerWritesCarryTurns } from './helpers/live-turn.js'

const TOKEN = 't0k-proposals'
const LOCAL = { host: '127.0.0.1:3210' }
let app: FastifyInstance
let dataDir: string, agentFolder: string
let registry: AgentRegistry
let automations: AutomationsStore
let resident: Resident
let agentTokens: AgentTokens
let proposals: ProposalsStore

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'silos-trigger-defaults-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  agentFolder = join(base, 'project')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(agentFolder, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'Finance', folder: agentFolder })
  registry.create({ id: 'builder', name: 'Builder', folder: agentFolder })
  agentTokens = new AgentTokens(dataDir)
  const store = new SessionStore(root, dataDir)
  const native = new NativeStore(join(dataDir, 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no turns here')
    },
    dataDir,
  })
  automations = new AutomationsStore(dataDir)
  automations.load()
  resident = new Resident({ store: automations, registry, chat, native, index, root, dataDir, broadcast: () => {}, tickIntervalMs: 999_999_999 })
  const providers = new ProvidersStore(dataDir)
  providers.load()
  proposals = new ProposalsStore(dataDir)
  proposals.load()
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
    automations,
    resident,
    agentTokens,
    providers,
    proposals,
  })
  bearerWritesCarryTurns(app, chat, agentTokens)
})

afterEach(() => {
  resident.stop()
})

const owner = { ...LOCAL, 'x-token': TOKEN }
const bearer = (id: string) => ({ ...LOCAL, authorization: `Bearer ${agentTokens.tokenFor(id)}` })
const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })

const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/ // 32 bytes, base64url, no padding

const webhookBody = (o: Record<string, unknown> = {}) => ({ name: 'Hook', agentId: 'builder', prompt: 'p', trigger: { kind: 'webhook' }, ...o })
const filesBody = (o: Record<string, unknown> = {}) => ({
  name: 'Inbox folder',
  agentId: 'builder',
  prompt: 'p',
  trigger: { kind: 'files', glob: '*.pdf' },
  ...o,
})

describe('validators fill the missing trigger fields from the agent', () => {
  it("files without folder → the agent's main folder; an explicit one is kept", () => {
    expect(validateAutomationCreate(filesBody(), registry).trigger).toEqual({ kind: 'files', folder: agentFolder, glob: '*.pdf' })
    expect(validateAutomationCreate(filesBody({ trigger: { kind: 'files', folder: '/elsewhere', glob: '*' } }), registry).trigger).toMatchObject({
      folder: '/elsewhere',
    })
  })

  it('webhook without secret → a generated one, reported once in extras; an explicit one is kept and not reported', () => {
    const extras: ValidateExtras = {}
    const t = validateAutomationCreate(webhookBody(), registry, extras).trigger
    expect(t.kind).toBe('webhook')
    expect(extras.generatedSecret).toMatch(SECRET_SHAPE)
    expect(t).toEqual({ kind: 'webhook', secret: extras.generatedSecret })
    const other: ValidateExtras = {}
    expect(validateAutomationCreate(webhookBody(), registry, other).trigger).not.toEqual(t) // random each time
    const given: ValidateExtras = {}
    expect(validateAutomationCreate(webhookBody({ trigger: { kind: 'webhook', secret: 'mine' } }), registry, given).trigger).toEqual({
      kind: 'webhook',
      secret: 'mine',
    })
    expect(given.generatedSecret).toBeUndefined()
  })

  it('an agent with no folder (Anywhere): files still needs one', () => {
    const anywhere = { get: (id: string) => (id === 'nomad' ? { id: 'nomad', name: 'Nomad', folder: null } : null) } as unknown as AgentRegistry
    expect(() => validateAutomationCreate(filesBody({ agentId: 'nomad', thread: { mode: 'keep', folder: agentFolder } }), anywhere)).toThrow(
      /trigger.folder must be an absolute path/,
    )
  })

  it("PATCH: a missing field keeps the stored trigger's first (no moved watch, no rotated secret), else fills", () => {
    const base = {
      id: 'x',
      createdAt: '2026-11-09T00:00:00.000Z',
      approval: false,
      keepAlive: false,
      paused: false,
      thread: { mode: 'new' as const },
      name: 'n',
      agentId: 'builder',
      prompt: 'p',
    }
    const hook: Automation = { ...base, trigger: { kind: 'webhook', secret: 'stored' } }
    const e1: ValidateExtras = {}
    expect(validateAutomationPatch({ trigger: { kind: 'webhook' } }, registry, hook, e1).trigger).toEqual({ kind: 'webhook', secret: 'stored' })
    expect(e1.generatedSecret).toBeUndefined()
    const cron: Automation = { ...base, trigger: { kind: 'cron', expr: '0 6 * * *' } }
    const e2: ValidateExtras = {}
    expect(validateAutomationPatch({ trigger: { kind: 'webhook' } }, registry, cron, e2).trigger).toEqual({ kind: 'webhook', secret: e2.generatedSecret })
    expect(e2.generatedSecret).toMatch(SECRET_SHAPE)
    const watching: Automation = { ...base, trigger: { kind: 'files', folder: '/watched', glob: '*' } }
    expect(validateAutomationPatch({ trigger: { kind: 'files', glob: '*.csv' } }, registry, watching).trigger).toEqual({
      kind: 'files',
      folder: '/watched',
      glob: '*.csv',
    })
    expect(validateAutomationPatch({ trigger: { kind: 'files', glob: '*.csv' } }, registry, cron).trigger).toEqual({
      kind: 'files',
      folder: agentFolder,
      glob: '*.csv',
    })
  })
})

describe('the requester hears a generated secret once', () => {
  it("the owner creates an agent's webhook without secret → 201 with generatedSecret; the agent's reads never show it", async () => {
    // a bearer may not create (it proposes) — the owner does
    expect((await call('POST', '/api/automations', bearer('builder'), webhookBody())).statusCode).toBe(403)
    const res = await call('POST', '/api/automations', owner, webhookBody())
    expect(res.statusCode).toBe(201)
    const { automation, generatedSecret } = res.json()
    expect(generatedSecret).toMatch(SECRET_SHAPE)
    expect(automations.get(automation.id)?.trigger).toEqual({ kind: 'webhook', secret: generatedSecret })
    const read = await call('GET', `/api/automations/${automation.id}`, bearer('builder'))
    expect(read.json()).toEqual({ automation: expect.objectContaining({ trigger: { kind: 'webhook' } }) })
    expect(JSON.stringify((await call('GET', '/api/automations', bearer('builder'))).json())).not.toContain(generatedSecret)
  })

  it('a create with its own secret, or a files trigger, carries no generatedSecret', async () => {
    const own = await call('POST', '/api/automations', owner, webhookBody({ trigger: { kind: 'webhook', secret: 'given' } }))
    expect(own.statusCode).toBe(201)
    expect(own.json().generatedSecret).toBeUndefined()
    const files = await call('POST', '/api/automations', owner, filesBody())
    expect(files.statusCode).toBe(201)
    expect(files.json().generatedSecret).toBeUndefined()
    expect(files.json().automation.trigger).toEqual({ kind: 'files', folder: agentFolder, glob: '*.pdf' })
  })

  it('PATCH to a webhook without secret → 200 with generatedSecret, to whoever sent the PATCH', async () => {
    const created = (
      await call('POST', '/api/automations', owner, { name: 'n', agentId: 'builder', prompt: 'p', trigger: { kind: 'cron', expr: '0 6 * * *' } })
    ).json().automation
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/automations/${created.id}`,
      headers: bearer('builder'),
      payload: { trigger: { kind: 'webhook' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().generatedSecret).toMatch(SECRET_SHAPE)
    expect(res.json().automation.trigger).toEqual({ kind: 'webhook' })
    // a later PATCH keeps it — never rotated, never shown again
    const again = await app.inject({
      method: 'PATCH',
      url: `/api/automations/${created.id}`,
      headers: bearer('builder'),
      payload: { trigger: { kind: 'webhook' } },
    })
    expect(again.json().generatedSecret).toBeUndefined()
    expect(automations.get(created.id)?.trigger).toEqual({ kind: 'webhook', secret: res.json().generatedSecret })
  })

  it('proposals: the proposal stores no secret; the owner sees the one generated at create', async () => {
    const p = await call('POST', '/api/proposals', bearer('builder'), { kind: 'automation', reason: 'callers need a hook', input: webhookBody() })
    expect(p.statusCode).toBe(201)
    expect(p.json().generatedSecret).toBeUndefined()
    expect(p.json().proposal.input.trigger).toEqual({ kind: 'webhook' })
    const accepted = await call('POST', `/api/proposals/${p.json().proposal.id}/accept`, owner)
    expect(accepted.statusCode).toBe(201)
    const { automation, generatedSecret } = accepted.json()
    expect(generatedSecret).toMatch(SECRET_SHAPE)
    expect(automation.trigger).toEqual({ kind: 'webhook', secret: generatedSecret })
  })
})
