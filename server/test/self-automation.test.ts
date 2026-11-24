// self-automation.test.ts — an agent's own recurring work through the API
// («Create own recurring work»): only
// its weekly think creates it, validated «self» (a weekly cron, a prompt,
// its shape fixed at birth — per field), stamped origin:'self' with where it
// was decided, in the ledger; every other turn hears its row's 403 by
// control; quotas 429 counted as rejected, never a cut. A bearer's PATCH on
// it is an allow-list (only a pause, registered) — per field; its DELETE
// withdraws it to the trash, registered. projectSettings is forced on every
// agent automation with a folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
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
import { AutomationsStore } from '../src/automations-store.js'
import { Resident } from '../src/resident.js'
import { AutomationTemplates } from '../src/automation-templates.js'
import { CreationsStore } from '../src/creations.js'
import { PlansOrigins } from '../src/plans-origins.js'
import { Initiative, SELF_RECURRENT_MAX_WORDS, SIGNAL_REQUIRED_SELF_AUTOMATION } from '../src/initiative.js'
import { SELF_RECURRING_NEVER, SELF_RECURRING_OUTSIDE_THINK, SELF_RECURRING_TOLD, type Control } from '../src/control.js'
import { SELF_NOT_COMMAND, SELF_SHAPE_AT_BIRTH, SELF_SHAPE_PATCH, SELF_UNPAUSE, SELF_WEEKLY } from '../src/automations-validate.js'
import { DELETE_NOT_OWN } from '../src/routes/automations.js'
import { cutWords, weekWords } from '../src/plans-provenance.js'
import type { TurnDeclaration } from '../src/live-turns.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

const LOCAL = { host: '127.0.0.1:3210' }
const TOKEN = 't0k-self'
let app: FastifyInstance, registry: AgentRegistry, chat: ChatService, tokens: AgentTokens
let automations: AutomationsStore, resident: Resident, creations: CreationsStore, dataDir: string
const control = new Map<string, Control>()

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'silos-self-auto-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  const folder = join(base, 'work')
  for (const d of [root, join(dataDir, 'trash'), folder]) mkdirSync(d, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'x', name: 'X', folder })
  registry.create({ id: 'y', name: 'Y', folder })
  control.clear()
  control.set('x', 'own')
  control.set('y', 'own')
  const native = new NativeStore(join(dataDir, 'native.json'))
  chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no sdk')
    },
    dataDir,
  })
  tokens = new AgentTokens(dataDir)
  automations = new AutomationsStore(dataDir)
  automations.load()
  resident = new Resident({ store: automations, registry, chat, native, index, root, dataDir, broadcast: () => {}, tickIntervalMs: 999_999_999 })
  creations = new CreationsStore(dataDir)
  const origins = new PlansOrigins(join(dataDir, 'plans-origins.json'))
  const initiative = new Initiative({
    creations,
    origins,
    stamper: { expectOrigin: (k, o) => origins.set(k, o) },
    agent: (id) => {
      const a = registry.get(id)
      return a ? { id: a.id, name: a.name, ...(a.cut ? { cut: a.cut } : {}) } : null
    },
    agents: () => registry.list().map((a) => ({ id: a.id, name: a.name })),
    automations,
    trashDir: join(dataDir, 'trash', 'automations'),
    task: () => null,
    writeTask: () => ({ ok: true }),
    stopTask: () => {},
    stopAutomation: () => false,
    cut: () => {},
  })
  app = buildServer({
    index,
    registry,
    native,
    chat,
    automations,
    resident,
    store: new SessionStore(root, dataDir),
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    token: TOKEN,
    liveMs: 120_000,
    agentTokens: tokens,
    home: base,
    automationTemplates: new AutomationTemplates(dataDir),
    controlOf: (id: string) => control.get(id) ?? 'told',
    initiative: { initiative, origins },
  })
  asOwner(app, TOKEN)
})
afterEach(async () => {
  resident.stop()
  await app.close()
})

const THINK: TurnDeclaration = { class: 'heartbeat', kind: 'think', runId: 'R1', automationId: 'heartbeat-x', packetKeys: ['message:m1'] }
const turnOf = (agentId: string, turn: TurnDeclaration = THINK): string =>
  chat.liveTurns.mintTurn({ agentId, turnId: `T-${agentId}-${Math.random()}`, turn, sessionId: 'S1' })
const bearer = (id: string) => ({ ...LOCAL, authorization: `Bearer ${tokens.tokenFor(id)}` })
const weekly = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Read new tax law',
  agentId: 'x',
  prompt: 'read what changed',
  trigger: { kind: 'cron', expr: '0 9 * * 1' },
  signal: 'mission',
  ...over,
})
const create = (body: Record<string, unknown>, agentId = 'x', turn: TurnDeclaration = THINK) =>
  app.inject({ method: 'POST', url: '/api/automations', headers: bearer(agentId), payload: { ...body, turn: turnOf(agentId, turn) } })

describe('POST /api/automations from its weekly think', () => {
  it('creates it stamped origin:self, createdBy, createdIn, signal, missionLine — its shape set by Silos — and in the ledger', async () => {
    const r = await create(weekly({ maxRunsPerDay: 5, approval: true, missionLine: 'keep up with the law' }))
    expect(r.statusCode).toBe(201)
    const a = r.json().automation
    expect(a).toMatchObject({
      origin: 'self',
      createdBy: 'x',
      createdIn: { run: 'R1', session: 'S1' },
      signal: 'mission',
      missionLine: 'keep up with the law',
      maxRunsPerDay: 1,
      approval: false,
      keepAlive: true,
      thread: { mode: 'new' },
      projectSettings: true,
    })
    expect(a.inheritHooks).toBeUndefined()
    expect(a.runsOn).toBeUndefined()
    const ledger = creations.list('x')
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ kind: 'automation', ref: a.id, title: 'Read new tax law', run: 'R1', by: 'x', signal: 'mission' })
    expect(ledger[0]!.rejected).toBeUndefined()
  })

  it('a command: 400 with its words, nothing made', async () => {
    const r = await create(weekly({ run: { kind: 'command', argv: ['echo', 'hi'], onFailure: 'inbox' } }))
    expect(r.statusCode).toBe(400)
    expect(r.json()).toEqual({ error: SELF_NOT_COMMAND })
    expect(automations.list()).toHaveLength(0)
  })

  for (const [field, value] of [
    ['runsOn', { model: 'm' }],
    ['inheritHooks', false],
    ['keepAlive', true],
    ['thread', { mode: 'new' }],
  ] as const) {
    it(`its shape is fixed at birth: ${field} in the body ⇒ 400 (G7-r7)`, async () => {
      const r = await create(weekly({ [field]: value }))
      expect(r.statusCode).toBe(400)
      expect(r.json()).toEqual({ error: SELF_SHAPE_AT_BIRTH })
      expect(automations.list()).toHaveLength(0)
    })
  }

  for (const trigger of [
    { kind: 'cron', expr: '0 9 * * *' },
    { kind: 'cron', expr: '0 9 * * 1,4' },
    { kind: 'once', at: '2030-01-01T00:00:00Z' },
    { kind: 'webhook' },
  ]) {
    it(`fires closer than a week apart (${JSON.stringify(trigger)}) ⇒ 400`, async () => {
      const r = await create(weekly({ trigger }))
      expect(r.statusCode).toBe(400)
      expect(r.json()).toEqual({ error: SELF_WEEKLY })
    })
  }

  it('a monthly cron is weekly or rarer: allowed', async () => {
    expect((await create(weekly({ trigger: { kind: 'cron', expr: '0 9 1 * *' } }))).statusCode).toBe(201)
  })

  it('no signal: 403 with its words, counted as rejected', async () => {
    const r = await create(weekly({ signal: undefined }))
    expect(r.statusCode).toBe(403)
    expect(r.json()).toEqual({ error: SIGNAL_REQUIRED_SELF_AUTOMATION })
    expect(automations.list()).toHaveLength(0)
    expect(creations.list('x')[0]).toMatchObject({ kind: 'automation', rejected: { why: SIGNAL_REQUIRED_SELF_AUTOMATION } })
  })

  it('the 4th recurring thing of its own: 429, rejected, never a cut', async () => {
    for (let i = 0; i < 3; i++) expect((await create(weekly({ name: `r${i}`, signal: 'message:m1' }))).statusCode).toBe(201)
    const r = await create(weekly({ name: 'r3', signal: 'message:m1' }))
    expect(r.statusCode).toBe(429)
    expect(r.json()).toEqual({ error: SELF_RECURRENT_MAX_WORDS })
    expect(automations.list()).toHaveLength(3)
    expect(creations.list('x').filter((c) => c.rejected)).toHaveLength(1)
    expect(registry.get('x')!.cut).toBeUndefined()
  })

  it('an automation and a task share the ONE weekly initiative', async () => {
    creations.add('x', { kind: 'task', ref: 'p/plan/tasks/t1', title: 'A', createdAt: new Date().toISOString(), by: 'x', signal: 'mission' })
    const r = await create(weekly())
    expect(r.statusCode).toBe(429)
    expect(r.json()).toEqual({ error: weekWords(new Date().toISOString().slice(0, 10)) })
  })

  it('the cut: 403 with its words', async () => {
    registry.update('x', { cut: { at: '2026-11-01T10:00:00Z', why: "used the owner's credential" } })
    const r = await create(weekly())
    expect(r.statusCode).toBe(403)
    expect(r.json()).toEqual({ error: cutWords('2026-11-01', "used the owner's credential") })
  })
})

describe('any other turn hears its row of the control table, by control', () => {
  it('Only when told', async () => {
    control.set('x', 'told')
    const r = await create(weekly())
    expect(r.statusCode).toBe(403)
    expect(r.json()).toEqual({ error: SELF_RECURRING_TOLD })
  })
  it('On its own · never', async () => {
    registry.update('x', { heartbeat: { rhythm: 'never' } })
    const r = await create(weekly(), 'x', { class: 'chat' })
    expect(r.json()).toEqual({ error: SELF_RECURRING_NEVER })
  })
  for (const turn of [
    { class: 'chat' },
    { class: 'heartbeat', kind: 'look', runId: 'R2' },
    { class: 'wake', taskKey: 'p/plan/tasks/t1' },
    { class: 'run', automationId: 'a1', runId: 'R3' },
  ] as TurnDeclaration[]) {
    it(`On its own, a ${turn.class}${turn.kind ? ` ${turn.kind}` : ''} turn — attended included — ⇒ 403`, async () => {
      const r = await create(weekly(), 'x', turn)
      expect(r.statusCode).toBe(403)
      expect(r.json()).toEqual({ error: SELF_RECURRING_OUTSIDE_THINK })
      expect(automations.list()).toHaveLength(0)
    })
  }
  it('a template used by a bearer goes through the same gate', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/automations/templates/monthly-close/use',
      headers: bearer('x'),
      payload: { params: {}, turn: turnOf('x', { class: 'chat' }) },
    })
    expect(r.statusCode).toBe(403)
    expect(r.json()).toEqual({ error: SELF_RECURRING_OUTSIDE_THINK })
  })
})

describe('PATCH by the bearer on its own recurring work: an allow-list (M2-r6)', () => {
  const mine = async (): Promise<string> => (await create(weekly())).json().automation.id
  const patch = (id: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/automations/${id}`, headers: bearer('x'), payload: { ...body, turn: turnOf('x', { class: 'chat' }) } })

  const FIELDS: Array<[string, unknown]> = [
    ['trigger', { kind: 'cron', expr: '0 9 * * 2' }],
    ['prompt', 'other'],
    ['run', { kind: 'agent' }],
    ['thread', { mode: 'new' }],
    ['projectSettings', false],
    ['name', 'renamed'],
    ['maxRunsPerDay', 3],
    ['runsOn', { model: 'm' }],
    ['approval', true],
    ['keepAlive', false],
    ['inheritHooks', true],
  ]
  for (const [field, value] of FIELDS) {
    it(`${field} ⇒ 403, nothing changed`, async () => {
      const id = await mine()
      const before = automations.get(id)
      const r = await patch(id, { [field]: value })
      expect(r.statusCode).toBe(403)
      expect(r.json()).toEqual({ error: SELF_SHAPE_PATCH })
      expect(automations.get(id)).toEqual(before)
    })
  }

  it("paused:true is allowed and registered in the ledger; paused:false is the owner's", async () => {
    const id = await mine()
    const r = await patch(id, { paused: true })
    expect(r.statusCode).toBe(200)
    expect(automations.get(id)!.paused).toBe(true)
    expect(creations.list('x').find((c) => c.action === 'paused')).toMatchObject({ kind: 'automation', ref: id, by: 'x' })
    const back = await patch(id, { paused: false })
    expect(back.statusCode).toBe(403)
    expect(back.json()).toEqual({ error: SELF_UNPAUSE })
    expect(automations.get(id)!.paused).toBe(true)
  })

  it('an automation the owner made for it keeps the old rules (not its own recurring work)', async () => {
    const owners = (await app.inject({ method: 'POST', url: '/api/automations', headers: LOCAL, payload: weekly() })).json().automation
    expect(owners.origin).toBeUndefined()
    expect((await patch(owners.id, { name: 'renamed' })).statusCode).toBe(200)
  })
})

describe('DELETE by the bearer', () => {
  const del = (id: string, agentId = 'x') =>
    app.inject({ method: 'DELETE', url: `/api/automations/${id}`, headers: { ...bearer(agentId), 'x-silos-turn': turnOf(agentId, { class: 'chat' }) } })

  it('its own: to the trash, registered as withdrawn', async () => {
    const id = (await create(weekly())).json().automation.id
    const r = await del(id)
    expect(r.statusCode).toBe(200)
    expect(automations.get(id)).toBeNull()
    expect(existsSync(join(dataDir, 'trash', 'automations', `${id}.json`))).toBe(true)
    expect(creations.list('x').find((c) => c.action === 'withdrew')).toMatchObject({ ref: id, title: 'Read new tax law' })
  })

  it("the owner's automation of the agent, and another agent's own: 403", async () => {
    const owners = (await app.inject({ method: 'POST', url: '/api/automations', headers: LOCAL, payload: weekly() })).json().automation
    expect((await del(owners.id)).json()).toEqual({ error: DELETE_NOT_OWN })
    const theirs = (await create(weekly({ agentId: 'y' }), 'y')).json().automation
    const r = await del(theirs.id, 'x')
    expect(r.statusCode).toBe(403)
    expect(automations.get(owners.id)).not.toBeNull()
    expect(automations.get(theirs.id)).not.toBeNull()
  })
})

describe('projectSettings forced on every agent automation with a folder', () => {
  it("the owner's create too", async () => {
    const r = await app.inject({ method: 'POST', url: '/api/automations', headers: LOCAL, payload: weekly({ signal: undefined }) })
    expect(r.json().automation.projectSettings).toBe(true)
  })
})
