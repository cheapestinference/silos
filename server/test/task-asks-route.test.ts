// task-asks-route.test.ts — task asks over the real server, the real
// plans kernel on the REFERENCE manifest and the real silo actions (the wait
// an ask writes and the note an answer writes must read with the manifest):
// POST /api/tasks/ask and POST /api/tasks/ask/answer — who may call them (the
// bearer of the task's owner; the bearer of the agent asked; the owner's
// credential gets 403 naming its own verb, H11), the turn every bearer write
// names, and GET /api/agents/<self>/asks. Nothing is spawned; no claude runs.
// Generic agents: writer, builder (bound to Task mode), teller (Only when told).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
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
import { TerminalService } from '../src/terminal-service.js'
import { buildServer } from '../src/server.js'
import { TaskModeStore } from '../src/task-mode/store.js'
import { TaskModeEngine } from '../src/task-mode/engine.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { TaskAsks } from '../src/task-asks.js'
import { agentMayRead, agentMayWrite, agentWriteNeedsTurn } from '../src/agent-authz.js'
import { SILOS_AUTHOR } from '../src/system-author.js'
import { asOwner } from './helpers/owner.js'
import { bearerWritesCarryTurns, withTurn } from './helpers/live-turn.js'

type Json = Record<string, any>
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json')
const LOCAL = { host: '127.0.0.1:3210' }
const socket = `silos-taskasks-${process.pid}`

let base: string
let app: FastifyInstance | undefined
let terminals: TerminalService | undefined
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-asks-route-'))
})
afterEach(async () => {
  terminals?.killAll()
  terminals?.stopReaper()
  await app?.close()
  app = undefined
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
  } catch {
    /* no server */
  }
  rmSync(base, { recursive: true, force: true })
})

const t = (id: string, owner: string, over: Json = {}): Json => ({ id, title: `Task ${id}`, owner, status: 'pending', dependsOn: [], ...over })

async function world(tasks: Json[]) {
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  const proj = join(base, 'proj')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const f = join(proj, 'plans', 'p.plan.json')
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ title: 'P', tasks }, null, 2))
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), readFileSync(REF, 'utf8'))
  const siloRegistry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  siloRegistry.load()
  const AGENTS = ['writer', 'builder', 'teller']
  const isAgent = (v: string): boolean => AGENTS.includes(v)
  const kernel = new SiloKernel({
    registry: siloRegistry,
    journal: new TransitionJournal(siloRegistry.conventionsDir),
    overlay: new OverlayStore(siloRegistry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [proj] }),
  })
  kernel.refresh()
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  for (const id of AGENTS) registry.create({ id, name: id[0]!.toUpperCase() + id.slice(1), folder: proj })
  const native = new NativeStore(join(dataDir, 'native.json'))
  const agentTokens = new AgentTokens(dataDir)
  terminals = new TerminalService(registry, index, undefined, undefined, {
    tmuxSocket: socket,
    appendDir: join(base, 'append'),
    envDir: join(base, 'env'),
    sessionsDir: join(base, 'claude-sessions'),
    consolesDir: join(dataDir, 'consoles'),
    command: () => ['bash', '-c', 'sleep 60'],
  })
  const events = new SiloEvents(siloRegistry.root)
  const siloActions = new SiloActions({
    registry: siloRegistry,
    kernel,
    events,
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
  const store = new TaskModeStore(dataDir)
  const BOUND = new Set(['writer', 'builder'])
  const sent: string[] = []
  const taskMode = new TaskModeEngine({
    store,
    plans: () => {
      const reading = kernel.reading('plans')
      return reading ? { reading } : null
    },
    bound: () => BOUND,
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    conversationOf: () => null,
    holdersOf: () => [],
    busyWhy: () => null,
    ready: () => true,
    send: (i) => {
      sent.push(`${i.agentId}: ${i.text}`)
      return { turnId: `turn-${sent.length}`, done: new Promise<void>(() => {}) }
    },
  })
  const marks: string[] = []
  const taskAsks = new TaskAsks({
    store,
    tasks: () => taskMode.tasks(),
    write: (key, mutate, text) => {
      const r = siloActions.silosWriteChild('plans', key, mutate, { by: SILOS_AUTHOR, text })
      return r.ok ? { ok: true } : { ok: false, code: r.code, reason: r.reason }
    },
    isAgent,
    inPlay: isAgent,
    nameOf: (id) => registry.get(id)?.name ?? id,
    bound: (id) => BOUND.has(id),
    seenBy: (to, at) => (BOUND.has(to) ? at + 3600_000 : null),
    markNote: (key, agent) => {
      marks.push(`note ${agent} ${key}`)
    },
    markAsk: (key, agent) => {
      marks.push(`ask ${agent} ${key}`)
    },
    look: () => taskMode.look(),
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
    terminals,
    token: 't0k',
    liveMs: 120_000,
    siloActions,
    siloKernel: kernel,
    siloRegistry,
    taskMode,
    taskAsks,
    agentTokens,
  })
  bearerWritesCarryTurns(app, chat, agentTokens)
  asOwner(app, 't0k')
  const key = (id: string): string => `folder:${proj}/p/tasks/${id}`
  const file = (): Json => JSON.parse(readFileSync(f, 'utf8'))
  const task = (id: string): Json => file().tasks.find((x: Json) => x.id === id)
  const bearer = (agent?: string): Json => (agent ? { authorization: `Bearer ${agentTokens.tokenFor(agent)}` } : {})
  const post = (url: string, payload: Json, agent?: string) => {
    kernel.refresh()
    return app!.inject({ method: 'POST', url, headers: { ...LOCAL, ...bearer(agent) }, payload })
  }
  const get = (url: string, agent?: string) => {
    kernel.refresh()
    return app!.inject({ method: 'GET', url, headers: { ...LOCAL, ...bearer(agent) } })
  }
  return { post, get, key, task, file, f, store, chat, events, marks, sent, proj }
}

describe("POST /api/tasks/ask — the bearer of the task's owner (B2.1, H11)", () => {
  it("200: the wait and blocked written through the manifest, the fact kept, `to` lists it; another's task 403", async () => {
    const w = await world([t('t1', 'writer'), t('t2', 'builder')])
    const r = await w.post('/api/tasks/ask', { plan: 'p', task: 't1', to: 'builder', action: 'review the draft', asked: 'Is the intro right?' }, 'writer')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, ref: expect.stringContaining('t1'), to: 'builder', state: 'blocked', sees: 'beat' })
    expect(w.task('t1')).toMatchObject({ status: 'blocked', waitingOn: { owner: 'builder', action: 'review the draft', asked: 'Is the intro right?' } })
    expect(w.store.armedOf(w.key('t1'))).toMatchObject({ to: 'builder', action: 'review the draft', asked: 'Is the intro right?' })
    // Silos' own write, signed Silos in the silo's events
    expect(w.events.list('plans', w.key('t1')).at(-1)).toMatchObject({ verb: 'silos-write', by: SILOS_AUTHOR })
    // `to` lists it — its own asks only
    const mine = await w.get('/api/agents/builder/asks', 'builder')
    expect(mine.statusCode).toBe(200)
    expect(mine.json().asks).toMatchObject([{ key: w.key('t1'), fromName: 'Writer', action: 'review the draft', asked: 'Is the intro right?' }])
    expect((await w.get('/api/agents/builder/asks', 'writer')).statusCode).toBe(403)
    expect((await w.get('/api/agents/builder/asks')).statusCode).toBe(200) // the owner reads anyone's
    // another's task
    const other = await w.post('/api/tasks/ask', { plan: 'p', task: 't2', to: 'writer', action: 'x' }, 'writer')
    expect(other.statusCode).toBe(403)
  })

  it("the owner's credential: 403 on both routes, naming the owner's own verb; a bearer write with a turn that is not live: refused", async () => {
    const w = await world([t('t1', 'writer')])
    const a = await w.post('/api/tasks/ask', { key: w.key('t1'), to: 'builder', action: 'x' })
    expect(a.statusCode).toBe(403)
    expect(a.json().error).toMatch(/POST \/api\/tasks\/act \{verb: "answer"\}/)
    const b = await w.post('/api/tasks/ask/answer', { key: w.key('t1'), text: 'x' })
    expect(b.statusCode).toBe(403)
    expect(b.json().error).toMatch(/POST \/api\/tasks\/act \{verb: "answer"\}/)
    const bad = await w.post('/api/tasks/ask', { key: w.key('t1'), to: 'builder', action: 'x', turn: 'f'.repeat(32) }, 'writer')
    expect([400, 403]).toContain(bad.statusCode)
    expect(w.task('t1').waitingOn).toBeUndefined()
  })
})

describe('POST /api/tasks/ask/answer — the bearer of the agent asked (B2.6, H1)', () => {
  it('the note by `to`, the wait out, pending — one write through the manifest; the fact consumed; the asker woken; twice: 409; the wrong bearer: 403', async () => {
    const w = await world([t('t1', 'writer')])
    expect((await w.post('/api/tasks/ask', { plan: 'p', task: 't1', to: 'builder', action: 'review the draft' }, 'writer')).statusCode).toBe(200)
    const wrong = await w.post('/api/tasks/ask/answer', { key: w.key('t1'), text: 'me?' }, 'teller')
    expect(wrong.statusCode).toBe(403)
    const r = await w.post('/api/tasks/ask/answer', { key: w.key('t1'), text: 'Looks right — ship it.' }, 'builder')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, state: 'pending', woke: true })
    const after = w.task('t1')
    expect(after.status).toBe('pending')
    expect(after.waitingOn).toBeUndefined()
    expect(after.notes).toMatchObject([{ by: 'builder', text: 'Looks right — ship it.' }])
    expect(w.store.armedOf(w.key('t1'))).toBeNull()
    expect(
      w.store
        .wakes()
        .filter((x) => x.reason === 'answered')
        .map((x) => x.agent),
    ).toEqual(['writer'])
    const again = await w.post('/api/tasks/ask/answer', { key: w.key('t1'), text: 'again' }, 'builder')
    expect(again.statusCode).toBe(409)
  })

  it("from an unattended turn: the note is marked (markNote) and the wake waits for that turn's audit (H3)", async () => {
    const w = await world([t('t1', 'writer')])
    await w.post('/api/tasks/ask', { plan: 'p', task: 't1', to: 'builder', action: 'review it' }, 'writer')
    const r = await w.post(
      '/api/tasks/ask/answer',
      withTurn(w.chat, 'builder', { key: w.key('t1'), text: 'fine' }, { class: 'heartbeat', kind: 'look', runId: 'run-1', automationId: 'hb-builder' }),
      'builder',
    )
    expect(r.statusCode).toBe(200)
    expect(w.marks).toEqual([`note builder ${w.key('t1')}`])
    expect(w.store.wakes().find((x) => x.reason === 'answered')).toMatchObject({
      state: 'queued',
      holdClass: 'turn',
      answeredIn: { agent: 'builder', run: 'run-1' },
    })
  })
})

describe("the allow-lists (H11): two bearer writes, each naming its turn; the agent's own asks are a read of its subtree", () => {
  it('agentMayWrite and agentWriteNeedsTurn', () => {
    for (const u of ['/api/tasks/ask', '/api/tasks/ask/answer']) {
      expect(agentMayWrite('builder', 'POST', u)).toBe(true)
      expect(agentWriteNeedsTurn('POST', u)).toBe(true)
    }
    expect(agentMayWrite('builder', 'POST', '/api/tasks/ask/other')).toBe(false)
    expect(agentMayWrite('builder', 'DELETE', '/api/tasks/ask')).toBe(false)
    expect(agentMayRead('builder', '/api/agents/builder/asks')).toBe(true)
    expect(agentMayRead('builder', '/api/agents/writer/asks')).toBe(false)
  })
})
