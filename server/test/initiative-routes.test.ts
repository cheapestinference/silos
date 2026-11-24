// initiative-routes.test.ts — append-item through the REAL route: a bearer with its turn creates a plan task and
// the server stamps createdBy/origin/run (never the body); a heartbeat turn
// without a signal hears its 403 by the route; the owner's task is the
// owner's; a task that appeared outside Silos is not an order (assign 409).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'
import { TaskModeStore } from '../src/task-mode/store.js'
import { TaskModeEngine } from '../src/task-mode/engine.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { AutomationsStore } from '../src/automations-store.js'
import { CreationsStore } from '../src/creations.js'
import { PlansOrigins } from '../src/plans-origins.js'
import { PlansProvenance, plansSnapshotOf, SIGNAL_REQUIRED_HEARTBEAT } from '../src/plans-provenance.js'
import { Initiative, setInitiative, UNKNOWN_ASSIGN } from '../src/initiative.js'
import { SILOS_AUTHOR } from '../src/system-author.js'
import { asOwner } from './helpers/owner.js'

type Json = Record<string, any>
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json')
const LOCAL = { host: '127.0.0.1:3210' }

let base: string
let app: FastifyInstance | undefined
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'init-routes-'))
})
afterEach(async () => {
  setInitiative(null)
  await app?.close()
  app = undefined
  rmSync(base, { recursive: true, force: true })
})

async function world() {
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  const proj = join(base, 'proj')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const file = join(proj, 'plans', 'tasks.plan.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ title: '', tasks: [{ id: 't1', title: 'from before', owner: 'x', status: 'pending' }] }, null, 2))
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), readFileSync(REF, 'utf8'))
  const siloRegistry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  siloRegistry.load()
  const isAgent = (v: string): boolean => v === 'x' || v === 'y'
  const journal = new TransitionJournal(siloRegistry.conventionsDir)
  const box: { stamper: PlansProvenance | null } = { stamper: null }
  const kernel = new SiloKernel({
    registry: siloRegistry,
    journal,
    overlay: new OverlayStore(siloRegistry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [proj] }),
    onReading: (id, reading) => {
      if (id === 'plans') box.stamper?.onReading(plansSnapshotOf(reading.records))
    },
  })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'x', name: 'X', folder: proj })
  const native = new NativeStore(join(dataDir, 'native.json'))
  const agentTokens = new AgentTokens(dataDir)
  const siloActions = new SiloActions({
    registry: siloRegistry,
    kernel,
    events: new SiloEvents(siloRegistry.root),
    acks: new SiloAcks(siloRegistry.root),
    proposals: new SiloProposals(siloRegistry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent,
    agentMayReadLocation: () => false,
  })
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no turns here')
    },
    dataDir,
  })
  const taskMode = new TaskModeEngine({
    store: new TaskModeStore(dataDir),
    plans: () => {
      const reading = kernel.reading('plans')
      return reading ? { reading } : null
    },
    bound: () => new Set(['x']),
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    conversationOf: () => null,
    holdersOf: () => [],
    busyWhy: () => null,
    ready: () => true,
    send: () => {
      throw new Error('no turns in this test')
    },
  } as never)
  const automations = new AutomationsStore(dataDir)
  automations.load()
  const creations = new CreationsStore(dataDir)
  const origins = new PlansOrigins(join(dataDir, 'plans-origins.json'))
  const write = (key: string, mutate: Parameters<SiloActions['silosWriteChild']>[2], text: string) => {
    const r = siloActions.silosWriteChild('plans', key, mutate, { by: SILOS_AUTHOR, text })
    return r.ok ? { ok: true } : { ok: false, reason: r.reason }
  }
  box.stamper = new PlansProvenance({
    origins,
    creations,
    cursorFile: join(dataDir, 'plans-provenance.json'),
    agents: () => registry.list().map((a) => ({ id: a.id, name: a.name, folders: [proj] })),
    liveOf: (id) => chat.liveTurns.liveOf(id),
    probe: { wrote: async () => false },
    write,
    journal: () => (siloRegistry.get('plans')?.status.conventions ?? []).map((c) => ({ dir: c.dir, read: (n: number) => journal.linesFrom(c.dir, n) })),
    runVerdict: () => null,
    selfRecurrentLive: () => 0,
    cut: () => {},
  })
  const initiative = new Initiative({
    creations,
    origins,
    stamper: box.stamper,
    agent: (id) => registry.get(id) ?? null,
    agents: () => registry.list(),
    automations,
    trashDir: join(dataDir, 'trash', 'automations'),
    task: (key) => {
      const t = taskMode.tasks().find((x) => x.key === key)
      return t ? { status: t.state, title: t.title, owner: t.owner } : null
    },
    writeTask: (key, mutate, text) => write(key, (c) => mutate(c), text),
    stopTask: () => {},
    stopAutomation: () => false,
    cut: () => {},
  })
  setInitiative(initiative)
  kernel.refresh() // the first watch: the existing task is the baseline
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
    token: 't0k',
    liveMs: 120_000,
    siloActions,
    siloKernel: kernel,
    siloRegistry,
    taskMode,
    agentTokens,
    automations,
    initiative: { initiative, origins },
  })
  asOwner(app, 't0k')
  const planKey = `folder:${proj}/tasks`
  const tasks = (): Json[] => (JSON.parse(readFileSync(file, 'utf8')) as Json).tasks
  return { app, chat, agentTokens, planKey, tasks, origins, creations }
}

describe('append-item through the real route', () => {
  it('a heartbeat turn without a signal: 403 by the route, nothing written', async () => {
    const w = await world()
    const turn = w.chat.liveTurns.mintTurn({
      agentId: 'x',
      turnId: 'T1',
      turn: { class: 'heartbeat', kind: 'look', packetKeys: ['message:m1'], automationId: 'heartbeat-x', runId: 'R1' },
    })
    const r = await w.app.inject({
      method: 'POST',
      url: '/api/silos/plans/record/append',
      headers: { ...LOCAL, authorization: `Bearer ${w.agentTokens.tokenFor('x')}` },
      payload: { key: w.planKey, collection: 'tasks', values: { id: 't2', title: 'new', owner: 'x' }, turn },
    })
    expect([r.statusCode, r.json().error]).toEqual([403, SIGNAL_REQUIRED_HEARTBEAT])
    expect(w.tasks().map((t) => t.id)).toEqual(['t1'])
    expect(w.creations.list('x')[0]?.rejected).toBeDefined()
  })

  it("with a signal of its packet: created and stamped by the server — the body's stamps never reach the file", async () => {
    const w = await world()
    const turn = w.chat.liveTurns.mintTurn({
      agentId: 'x',
      turnId: 'T1',
      turn: { class: 'heartbeat', kind: 'look', packetKeys: ['message:m1'], automationId: 'heartbeat-x', runId: 'R1' },
    })
    const r = await w.app.inject({
      method: 'POST',
      url: '/api/silos/plans/record/append',
      headers: { ...LOCAL, authorization: `Bearer ${w.agentTokens.tokenFor('x')}` },
      payload: {
        key: w.planKey,
        collection: 'tasks',
        values: { id: 't2', title: 'new', owner: 'x', signal: 'message:m1', createdBy: 'owner', origin: 'pack', run: 'forged' },
        turn,
      },
    })
    expect(r.statusCode).toBe(200)
    expect(w.tasks().find((t) => t.id === 't2')).toMatchObject({ createdBy: 'x', origin: 'self', run: 'R1', signal: 'message:m1' })
    expect(w.origins.get(`${w.planKey}/tasks/t2`)).toMatchObject({ by: 'x', how: 'creation' })
    expect(w.creations.byRef('x', `${w.planKey}/tasks/t2`)).toMatchObject({ run: 'R1', signal: 'message:m1' })
  })

  it("the owner's task is stamped the owner's; the baseline task is no order for the bearer (409)", async () => {
    const w = await world()
    const r = await w.app.inject({
      method: 'POST',
      url: '/api/silos/plans/record/append',
      headers: { ...LOCAL, 'x-token': 't0k' },
      payload: { key: w.planKey, collection: 'tasks', values: { id: 't3', title: 'mine', owner: 'x', createdBy: 'x' } },
    })
    expect(r.statusCode).toBe(200)
    expect(w.tasks().find((t) => t.id === 't3')).toMatchObject({ createdBy: 'owner' })
    const turn = w.chat.liveTurns.mintTurn({ agentId: 'x', turnId: 'W1', turn: { class: 'wake', taskKey: 'k' } })
    const a = await w.app.inject({
      method: 'POST',
      url: '/api/tasks/assign',
      headers: { ...LOCAL, authorization: `Bearer ${w.agentTokens.tokenFor('x')}` },
      payload: { key: `${w.planKey}/tasks/t1`, turn },
    })
    expect([a.statusCode, a.json().error]).toEqual([409, UNKNOWN_ASSIGN])
  })
})
