// task-owner-write-routes.test.ts — the owner's task writes over the real
// server, the real plans kernel on the REFERENCE manifest and a real session
// index (nothing is spawned, no claude runs):
//   - the owner's note that reopens — ONE rule, in the note's own write,
//     for every door; Task mode no longer writes a reopen
//   - respond — the gate closes first, then the notes
//   - release with a wait
//   - `new` — a new task in ONE request
//   - `hand` — give a task to another
//   - every owner write on a task is registered with the stamper
// Generic fixtures: agents writer, builder, teller (bound or not), an
// archived one (retired), one fenced elsewhere (outsider); a person, sam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { AgentStateStore } from '../src/agent-state.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { TerminalService } from '../src/terminal-service.js'
import { LineageStore } from '../src/lineage.js'
import { buildServer } from '../src/server.js'
import { TaskModeStore } from '../src/task-mode/store.js'
import { TaskModeEngine } from '../src/task-mode/engine.js'
import { OwnerNoteLedger, noteDigest } from '../src/task-mode/owner-notes.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { SiloSurfaces } from '../src/silos/surfaces.js'
import { TransitionJournal as Journal } from '../src/silos/journal.js'
import { taskThreads } from '../src/task-threads.js'
import { PlansOrigins } from '../src/plans-origins.js'
import { CreationsStore } from '../src/creations.js'
import { Initiative, setInitiative } from '../src/initiative.js'
import type { SessionMeta } from '../src/types.js'
import { TaskAsks } from '../src/task-asks.js'
import { openFromMissionRoot } from '../src/proactive.js'
import { asOwner } from './helpers/owner.js'
import { bearerWritesCarryTurns } from './helpers/live-turn.js'

type Json = Record<string, any>
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json')
const LOCAL = { host: '127.0.0.1:3210' }
const socket = `silos-partd-${process.pid}`
const AGENTS = ['writer', 'builder', 'teller', 'retired', 'outsider']

let base: string
let app: FastifyInstance | undefined
let terminals: TerminalService | undefined
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-writes-'))
})
afterEach(async () => {
  terminals?.killAll()
  terminals?.stopReaper()
  await app?.close()
  app = undefined
  setInitiative(null)
  rmSync(base, { recursive: true, force: true })
})

const t = (id: string, over: Json = {}): Json => ({ id, title: `Task ${id}`, owner: 'writer', status: 'pending', dependsOn: [], ...over })
const unstick = { owner: 'builder', action: 'unstick p#t9' }

async function world(tasks: Json[], opts: { bound?: string[]; slug?: string; extra?: Json; initiative?: boolean } = {}) {
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  const proj = join(base, 'alpha')
  const elsewhere = join(base, 'beta')
  const slug = opts.slug ?? 'p'
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(join(proj, 'plans'), { recursive: true })
  mkdirSync(elsewhere, { recursive: true })
  const file = join(proj, 'plans', `${slug}.plan.json`)
  writeFileSync(file, JSON.stringify({ title: slug === 'tasks' ? '' : slug, tasks, ...(opts.extra ?? {}) }, null, 2))
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), readFileSync(REF, 'utf8'))
  const siloRegistry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  siloRegistry.load()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  for (const id of AGENTS) registry.create({ id, name: id.charAt(0).toUpperCase() + id.slice(1), folder: id === 'outsider' ? elsewhere : proj })
  registry.archive('retired')
  const isAgent = (v: string): boolean => registry.list(true).some((a) => a.id === v)
  const inPlay = (v: string): boolean => registry.list().some((a) => a.id === v)
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
  const lineage = new LineageStore(join(dataDir, 'lineage.json'))
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
  const owner = (m: SessionMeta): string => native.get(m.folder, m.id)?.agentId ?? 'writer'
  const threads = () => taskThreads({ metas: index.allSessions(), lineage, ownerOf: owner, nativeIdOf: (id) => terminals!.nativeIdOf(id) })
  const events = new SiloEvents(siloRegistry.root)
  // (J3) what each owner write registered with the stamper, in order
  const owned: Array<{ key: string; shape: Json }> = []
  const siloActions = new SiloActions({
    registry: siloRegistry,
    kernel,
    events,
    acks: new SiloAcks(siloRegistry.root),
    proposals: new SiloProposals(siloRegistry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent,
    inPlay,
    agentMayReadLocation: () => false,
    threadKey: (id) => threads().threadKey(id),
    currentOf: (l, r) => threads().currentOf(l, r),
    locations: { projects: () => [proj] },
    ownWrite: (_silo, key, shape) => {
      const e = { key, shape: JSON.parse(JSON.stringify(shape)) as Json }
      owned.push(e)
      return () => {
        owned.splice(owned.indexOf(e), 1)
      }
    },
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
  const ledger = new OwnerNoteLedger(join(siloRegistry.root, 'events.jsonl'), 'plans')
  const sent: Array<{ agentId: string; text: string }> = []
  const plansWrites: Array<[string, string, unknown]> = []
  const taskMode: TaskModeEngine = new TaskModeEngine({
    store,
    plans: () => {
      const reading = kernel.reading('plans')
      return reading ? { reading } : null
    },
    bound: () => new Set(opts.bound ?? []),
    setField: (k, f, v) => {
      plansWrites.push([k, f, v])
      const r = siloActions.setField('plans', k, f, v, { by: 'silos' })
      return r.ok ? { ok: true } : { ok: false, reason: r.reason }
    },
    appendConversation: (k, s) => {
      const r = siloActions.appendItem('plans', k, 'conversations', { session: s })
      return r.ok ? { ok: true } : { ok: false, reason: r.reason }
    },
    conversationOf: (a, ids) => threads().tipOf(a, ids),
    holdersOf: (a, ids) => threads().holdersOf(a, ids),
    busyWhy: () => null,
    ready: () => true,
    send: (i) => {
      sent.push({ agentId: i.agentId, text: i.text })
      return { turnId: `turn-${sent.length}`, done: new Promise(() => {}) }
    },
    nameOf: (id) => registry.get(id)?.name ?? id,
    currentOf: (l, r) => threads().currentOf(l, r),
    ownerNotes: () => ledger.checker(),
  })
  // the initiative (origins, bless, prepareTask) — only where a test reads it
  const origins = new PlansOrigins(join(dataDir, 'plans-origins.json'))
  const creations = new CreationsStore(dataDir)
  const stopped: string[] = []
  if (opts.initiative !== false) {
    const initiative = new Initiative({
      creations,
      origins,
      stamper: { expectOrigin: (k: string, o: Parameters<PlansOrigins['set']>[1]) => origins.set(k, o) } as never,
      agent: (id) => registry.get(id) ?? null,
      agents: () => registry.list(),
      automations: { list: () => [], get: () => undefined } as never,
      trashDir: join(dataDir, 'trash', 'automations'),
      task: (k) => {
        const x = taskMode.tasks().find((y) => y.key === k)
        return x ? { status: x.state, title: x.title, owner: x.owner, ...(x.file ? { file: x.file } : {}) } : null
      },
      writeTask: () => ({ ok: true }),
      stopTask: (k) => {
        stopped.push(k)
      },
      stopAutomation: () => {},
      cut: () => {},
      proposals: {} as never,
      messages: {} as never,
      considered: {} as never,
    } as never)
    setInitiative(initiative)
  }
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
    siloSurfaces: new SiloSurfaces({
      registry: siloRegistry,
      kernel,
      journal: new Journal(siloRegistry.conventionsDir),
      isAgent,
      proposals: (id) => siloActions.proposalsNeedsYou(id),
      submissions: () => [],
    }),
    agentTokens,
    lineage,
    agentState: new AgentStateStore(join(dataDir, 'agent-state')),
    dataDir,
    invalidateTaskThreads: () => {},
  })
  bearerWritesCarryTurns(app, chat, agentTokens)
  asOwner(app, 't0k')
  const session = async (agent: string, agoMs: number, id = randomUUID()): Promise<string> => {
    const mf = mungePath(proj)
    mkdirSync(join(root, mf), { recursive: true })
    native.register(mf, id, { agentId: agent, createdAt: new Date(Date.now() - agoMs - 5_000).toISOString() })
    const at = (ms: number): string => new Date(Date.now() - ms).toISOString()
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          sessionId: id,
          cwd: proj,
          timestamp: at(agoMs + 5_000),
          uuid: 'u1',
          message: { role: 'user', content: `work for ${agent}` },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: id,
          cwd: proj,
          timestamp: at(agoMs),
          uuid: 'a1',
          parentUuid: 'u1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
        }),
      ].join('\n') + '\n',
    )
    await index.refresh(mf, id)
    return id
  }
  const planKey = `folder:${proj}/${slug}`
  const key = (id: string): string => `${planKey}/tasks/${id}`
  const read = (): Json => JSON.parse(readFileSync(file, 'utf8'))
  const task = (id: string): Json => read().tasks.find((x: Json) => x.id === id)
  const sha = (): string => createHash('sha256').update(readFileSync(file)).digest('hex')
  const bearer = (agent?: string): Json => (agent ? { authorization: `Bearer ${agentTokens.tokenFor(agent)}` } : {})
  const post = (url: string, payload: Json, agent?: string, headers: Json = {}) => {
    kernel.refresh()
    return app!.inject({ method: 'POST', url, headers: { ...LOCAL, ...bearer(agent), ...headers }, payload })
  }
  const get = (url: string) => {
    kernel.refresh()
    return app!.inject({ method: 'GET', url, headers: LOCAL })
  }
  // the file writes a request made (writeFile is the kernel's one write path)
  const writes = vi.spyOn(siloActions as unknown as { writeFile: (...a: unknown[]) => unknown }, 'writeFile')
  const counted = async <T>(fn: () => Promise<T>): Promise<{ out: T; writeCalls: number }> => {
    writes.mockClear()
    const out = await fn()
    return { out, writeCalls: writes.mock.calls.length }
  }
  const act = async (id: string, verb: string, args: Json = {}, agent?: string, headers: Json = {}) => {
    const { out: r, writeCalls } = await counted(() => post('/api/tasks/act', { key: key(id), verb, ...args }, agent, headers))
    return { r, body: r.json() as Json, writeCalls }
  }
  const note = async (id: string, text: string, agent?: string, headers: Json = {}) => {
    const { out: r, writeCalls } = await counted(() =>
      post('/api/silos/plans/record/append', { key: key(id), collection: 'notes', values: { text } }, agent, headers),
    )
    return { r, body: r.json() as Json, writeCalls }
  }
  const eventsOf = (id: string): Json[] => siloActions.events('plans', key(id)) as unknown as Json[]
  return {
    act,
    note,
    post,
    get,
    counted,
    session,
    key,
    planKey,
    task,
    read,
    sha,
    eventsOf,
    siloActions,
    taskMode,
    kernel,
    store,
    sent,
    ledger,
    file,
    proj,
    elsewhere,
    registry,
    owned,
    plansWrites,
    origins,
    creations,
    stopped,
    threads,
    native,
    dataDir,
  }
}

// ── the owner's note that reopens: one rule, in the write ─────────────

describe("the owner's note reopens its task in the SAME write", () => {
  it('a done task of an agent in play: the note and pending in ONE write — by every door (the record route and the kernel verb itself)', async () => {
    const w = await world([t('t1', { status: 'done' }), t('t2', { status: 'cancelled' })])
    const a = await w.note('t1', 'Not quite — the intro too')
    expect([a.r.statusCode, a.writeCalls, a.body.reopened]).toEqual([200, 1, 'pending'])
    expect([w.task('t1').status, w.task('t1').notes.map((n: Json) => n.text)]).toEqual(['pending', ['Not quite — the intro too']])
    // its events: the note's provenance, then the state in set-field's words
    const evs = w.eventsOf('t1')
    expect(evs.map((e) => e.verb)).toEqual(['append-item', 'set-field'])
    expect(evs[0]).toMatchObject({ by: 'owner', detail: { coll: 'notes', digest: noteDigest('Not quite — the intro too') } })
    expect(evs[1]!.text).toMatch(/^set-field status: done → pending/)
    // the kernel's verb, called by any other door, reopens the same way
    const r = w.siloActions.appendItem('plans', w.key('t2'), 'notes', { text: 'we need it after all' })
    expect(r).toMatchObject({ ok: true, value: { reopened: 'pending' } })
    expect(w.task('t2').status).toBe('pending')
  })
  it("the destination is reopen's: blocked while an open dependency holds it, else pending", async () => {
    const w = await world([t('t0', { status: 'in_progress', owner: 'builder' }), t('t1', { status: 'done', dependsOn: ['t0'] })])
    expect((await w.note('t1', 'one more thing')).body.reopened).toBe('blocked')
    expect(w.task('t1').status).toBe('blocked')
  })
  it('blocked with nothing holding it reopens; blocked on an open dependency, a wait or a check ahead stays', async () => {
    const w = await world([
      t('t0', { status: 'pending', owner: 'builder' }),
      t('t5', { status: 'done', owner: 'builder' }),
      t('t1', { status: 'blocked', dependsOn: ['t5'] }),
      t('t2', { status: 'blocked', dependsOn: ['t0'] }),
      t('t3', { status: 'blocked', waitingOn: { owner: 'owner', action: 'A or B?' } }),
      t('t4', { status: 'blocked', nextCheckAt: new Date(Date.now() + 86_400_000).toISOString() }),
    ])
    expect((await w.note('t1', 'go')).body.reopened).toBe('pending')
    for (const id of ['t2', 't3', 't4']) {
      const n = await w.note(id, 'any news?')
      expect([n.body.reopened, w.task(id).status]).toEqual([undefined, 'blocked'])
    }
  })
  it("J1 — Silos' unstick wait goes in the same write and the destination is computed without it; someone else's wait still holds it blocked", async () => {
    const w = await world([
      t('t1', { status: 'blocked', waitingOn: unstick }),
      t('t2', { status: 'blocked', waitingOn: { owner: 'teller', action: 'sign the invoice' } }),
    ])
    const a = await w.note('t1', 'try X')
    expect([a.writeCalls, a.body.reopened, w.task('t1').status, w.task('t1').waitingOn]).toEqual([1, 'pending', 'pending', undefined])
    expect(w.eventsOf('t1').map((e) => e.text.split(':')[0])).toEqual(['added to notes', 'set-field waitingOn', 'set-field status'])
    await w.note('t2', 'any news?')
    expect([w.task('t2').status, w.task('t2').waitingOn]).toEqual(['blocked', { owner: 'teller', action: 'sign the invoice' }])
  })
  it("J7 — a person's task, an archived agent's, nobody's: the note is for the record, nothing reopens", async () => {
    const w = await world([
      t('t1', { owner: 'sam', status: 'done' }),
      t('t2', { owner: 'retired', status: 'done' }),
      t('t3', { owner: '', status: 'cancelled' }),
      t('t4', { owner: 'owner', status: 'done' }),
    ])
    for (const id of ['t1', 't2', 't3', 't4']) {
      const n = await w.note(id, 'for the record')
      expect([n.r.statusCode, n.writeCalls, n.body.reopened]).toEqual([200, 1, undefined])
    }
    expect(['t1', 't2', 't3', 't4'].map((id) => w.task(id).status)).toEqual(['done', 'done', 'cancelled', 'done'])
  })
  it("a «Dropped: …» note never reopens; an agent's note never; the owner's credential naming an agent writes an agent's note — no reopen", async () => {
    const w = await world([t('t1', { status: 'cancelled' }), t('t2', { status: 'done' }), t('t3', { status: 'done' })])
    await w.note('t1', 'Dropped: really not needed')
    expect(w.task('t1').status).toBe('cancelled')
    await w.note('t2', 'reopening myself', 'writer')
    expect(w.task('t2').status).toBe('done')
    await w.note('t3', 'as the builder', undefined, { 'x-silos-agent': 'builder' })
    expect(w.task('t3').status).toBe('done')
  })
  it('a note that CLOSES (approve) never reopens, at the write nor at a later look', async () => {
    const w = await world([t('t1', { status: 'in_review', waitingOn: { owner: 'owner', action: 'review it' } })], { bound: ['writer'] })
    w.taskMode.look()
    await w.act('t1', 'approve', { asked: '', text: 'Lovely' })
    for (let i = 0; i < 2; i++) {
      w.kernel.refresh()
      w.taskMode.look()
    }
    expect(w.task('t1').status).toBe('done')
  })
  it('without the inPlay option nobody is in play: the kernel never reopens (K11)', async () => {
    const w = await world([t('t1', { status: 'done' })])
    const bare = new SiloActions({ ...(w.siloActions as unknown as { o: ConstructorParameters<typeof SiloActions>[0] }).o, inPlay: undefined })
    expect(bare.appendItem('plans', w.key('t1'), 'notes', { text: 'hm' })).toMatchObject({ ok: true })
    expect(w.task('t1').status).toBe('done')
  })
  it('J10.18 — the 120 s dedupe never swallows a note that would reopen', async () => {
    const w = await world([t('t1', { status: 'in_progress' })])
    expect((await w.note('t1', 'ship it')).body.reopened).toBeUndefined()
    // the agent closes it a moment later; the owner sends the same words again
    expect(w.siloActions.setField('plans', w.key('t1'), 'status', 'done', { by: 'writer' }).ok).toBe(true)
    const again = await w.note('t1', 'ship it')
    expect([again.writeCalls, again.body.reopened, w.task('t1').status, w.task('t1').notes.length]).toEqual([1, 'pending', 'pending', 2])
    // an identical note on an open task within the window is still one gesture
    const third = await w.note('t1', 'ship it')
    expect([third.writeCalls, w.task('t1').notes.length]).toEqual([0, 2])
  })
  it("Task mode no longer writes: a bound agent's note reopens in the note's write, the look only wakes", async () => {
    const w = await world([t('t1', { status: 'done' })], { bound: ['writer'] })
    w.taskMode.look()
    await w.note('t1', 'not over')
    for (let i = 0; i < 2; i++) {
      w.kernel.refresh()
      w.taskMode.look()
    }
    expect(w.plansWrites).toEqual([])
    expect(w.task('t1').status).toBe('pending')
    expect(w.store.wakes().map((x) => x.reason)).toEqual(['owner-note'])
  })
  it("the note (and its reopen) is the owner's write for the stamper (J3)", async () => {
    const w = await world([t('t1', { status: 'done' })])
    await w.note('t1', 'again')
    expect(w.owned.map((o) => [o.key, o.shape.status, o.shape.notes.length])).toEqual([[w.key('t1'), 'pending', 1]])
  })
})

// ── unlink with a wait ───────────────────────────────────────────────

describe("the owner's release to blocked carries its wait in the SAME write", () => {
  const claimed = async (tasks: Json[]) => {
    const w = await world(tasks)
    const s = await w.session('writer', 60 * 60_000)
    expect((await w.post('/api/tasks/claim', { key: w.key('t1'), session: s }, 'writer')).statusCode).toBe(200)
    return { w, s }
  }
  it('blocked + wait: the mark, the state and the wait — ONE write; the answer says the wait', async () => {
    const { w, s } = await claimed([t('t1')])
    const { out: r, writeCalls } = await w.counted(() =>
      w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'blocked', wait: { owner: 'sam', action: 'sign the contract', asked: 'Signed?' } }),
    )
    expect([r.statusCode, writeCalls]).toEqual([200, 1])
    expect(r.json()).toMatchObject({ state: 'blocked', disposed: 'blocked', wait: { owner: 'sam', action: 'sign the contract', asked: 'Signed?' } })
    expect([w.task('t1').status, w.task('t1').waitingOn, w.task('t1').releases.length]).toEqual([
      'blocked',
      { owner: 'sam', action: 'sign the contract', asked: 'Signed?' },
      1,
    ])
  })
  it('the wait replaces the one there; bounded like an ask (action 80, question 500)', async () => {
    const { w, s } = await claimed([t('t1', { waitingOn: { owner: 'teller', action: 'old' } })])
    await w.post('/api/tasks/release', {
      key: w.key('t1'),
      session: s,
      state: 'blocked',
      wait: { owner: 'owner', action: 'x'.repeat(200), asked: 'q'.repeat(900) },
    })
    const wait = w.task('t1').waitingOn
    expect([wait.owner, wait.action.length, wait.asked.length]).toEqual(['owner', 80, 500])
  })
  it('no wait when it does not stay blocked: another thread still current keeps it in progress — no wait written', async () => {
    const w = await world([t('t1')])
    const s1 = await w.session('writer', 60 * 60_000)
    const s2 = await w.session('writer', 50 * 60_000)
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s1 }, 'writer')
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s2, takeover: true }, 'writer')
    const r = await w.post('/api/tasks/release', { key: w.key('t1'), session: s1, state: 'blocked', wait: { owner: 'owner', action: 'decide' } })
    expect(r.json()).toMatchObject({ kept: 'in_progress' })
    expect(r.json().wait).toBeUndefined()
    expect(w.task('t1').waitingOn).toBeUndefined()
  })
  it('K9 — without a wait: the default «on you» when nothing else would hold it', async () => {
    const a = await claimed([t('t1')])
    await a.w.post('/api/tasks/release', { key: a.w.key('t1'), session: a.s, state: 'blocked' })
    expect(a.w.task('t1').waitingOn).toEqual({ owner: 'owner', action: 'unblock it' })
  })
  it('K9 — an open dependency already holds it: no second brake', async () => {
    const b = await claimed([t('t0', { owner: 'builder' }), t('t1', { dependsOn: ['t0'] })])
    await b.w.post('/api/tasks/release', { key: b.w.key('t1'), session: b.s, state: 'blocked' })
    expect([b.w.task('t1').status, b.w.task('t1').waitingOn]).toEqual(['blocked', undefined])
  })
  it('K9 — a wait that was there stays', async () => {
    const c = await claimed([t('t1', { waitingOn: { owner: 'sam', action: 'the numbers' } })])
    await c.w.post('/api/tasks/release', { key: c.w.key('t1'), session: c.s, state: 'blocked' })
    expect(c.w.task('t1').waitingOn).toEqual({ owner: 'sam', action: 'the numbers' })
  })
  it("refused (400, nothing written): a bearer sending a wait, the owner's credential naming an agent, a wait without blocked, Silos' unstick prefix, a wait naming no one", async () => {
    const { w, s } = await claimed([t('t1')])
    const before = w.sha()
    const wait = { owner: 'owner', action: 'decide' }
    expect((await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'blocked', wait }, 'writer')).statusCode).toBe(400)
    expect(
      (await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'blocked', wait }, undefined, { 'x-silos-agent': 'writer' })).statusCode,
    ).toBe(400)
    expect((await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'pending', wait })).statusCode).toBe(400)
    expect(
      (await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'blocked', wait: { owner: 'owner', action: 'unstick p#t3' } })).statusCode,
    ).toBe(400)
    expect((await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'blocked', wait: { owner: '', action: 'x' } })).statusCode).toBe(400)
    expect(w.sha()).toBe(before)
  })
  it("the owner's release (with or without its wait) is the owner's write for the stamper (J3, K4)", async () => {
    const { w, s } = await claimed([t('t1')])
    w.owned.length = 0
    await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'blocked', wait: { owner: 'owner', action: 'decide' } })
    expect(w.owned.map((o) => [o.key, o.shape.status, o.shape.waitingOn])).toEqual([[w.key('t1'), 'blocked', { owner: 'owner', action: 'decide' }]])
  })
})

// ── new: a new task in ONE request ───────────────────────────────────

describe("POST /api/tasks/new: ONE write, the id the server's", () => {
  const month = new Date().toISOString().slice(0, 7)
  it('the id comes from the RAW file: a task the reader cannot build and the retired ids keep theirs', async () => {
    const w = await world([t('t2', { owner: 'owner' }), { id: 't7', title: 'no state it knows', status: 'nonsense' }], {
      slug: 'tasks',
      extra: { retired: ['t9'], rotatedAt: month },
    })
    const r = await w.post('/api/tasks/new', { folder: w.proj, plan: 'tasks', title: 'Write the brief', owner: 'writer' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ id: 't10', key: w.key('t10') })
    expect(w.task('t10')).toMatchObject({ title: 'Write the brief', owner: 'writer', status: 'pending', createdBy: 'owner' })
  })
  it('details and a conversation: ONE write — the note born with it, the conversation listed, in progress; the events of its parts, no set-field', async () => {
    const w = await world([t('t1', { owner: 'owner' })])
    const s = await w.session('writer', 60_000)
    const { out: r, writeCalls } = await w.counted(() =>
      w.post('/api/tasks/new', { folder: w.proj, plan: 'p', title: 'Ship the page', owner: 'writer', details: 'The hero first', session: s }),
    )
    expect([r.statusCode, writeCalls]).toEqual([200, 1])
    const x = w.task('t2')
    expect([x.status, x.conversations, x.notes.map((n: Json) => [n.by, n.text])]).toEqual(['in_progress', [s], [['owner', 'The hero first']]])
    expect(w.eventsOf('t2').map((e) => [e.verb, e.text.split(':')[0]])).toEqual([
      ['append-item', 'added to conversations'],
      ['append-item', 'added to notes'],
    ])
    expect(w.eventsOf('t2')[1]).toMatchObject({ by: 'owner', detail: { coll: 'notes', at: x.notes[0].at, digest: noteDigest('The hero first') } })
    expect((w.siloActions.events('plans', w.planKey) as unknown as Json[]).map((e) => e.text)).toEqual(['added to tasks: Ship the page'])
    // born the owner's: its origin is known (prepareTask), the shape the stamper's (J3)
    expect(w.origins.get(w.key('t2'))).toMatchObject({ by: 'owner', how: 'owner' })
    expect(w.owned.map((o) => o.key)).toEqual([w.key('t2')])
  })
  it("the project's list is made first when it is not there (ensure) — then the one write", async () => {
    const w = await world([t('t1', { owner: 'owner' })])
    const r = await w.post('/api/tasks/new', { folder: w.proj, plan: 'tasks', title: 'Loose task', owner: 'owner' })
    expect(r.statusCode).toBe(200)
    expect(r.json().key).toBe(`folder:${w.proj}/tasks/tasks/t1`)
    expect(JSON.parse(readFileSync(join(w.proj, 'plans', 'tasks.plan.json'), 'utf8')).tasks.map((x: Json) => x.title)).toEqual(['Loose task'])
  })
  it('a named plan that does not exist → 404, nothing written', async () => {
    const w = await world([t('t1')])
    const before = w.sha()
    const r = await w.post('/api/tasks/new', { folder: w.proj, plan: 'nope', title: 'x', owner: 'writer' })
    expect(r.statusCode).toBe(404)
    expect(w.sha()).toBe(before)
  })
  it('the owner: you, or an agent in play whose fence holds the folder — never one fenced elsewhere, an archived one, one without a folder, a person', async () => {
    const w = await world([t('t1')])
    const before = w.sha()
    for (const [owner, code] of [
      ['outsider', 409],
      ['retired', 409],
      ['master', 409],
      ['sam', 400],
    ] as const) {
      expect((await w.post('/api/tasks/new', { folder: w.proj, plan: 'p', title: 'x', owner })).statusCode).toBe(code)
    }
    expect(w.sha()).toBe(before)
  })
  it("the owner's only: a bearer, or the owner's credential naming an agent → 403", async () => {
    const w = await world([t('t1')])
    expect((await w.post('/api/tasks/new', { folder: w.proj, plan: 'p', title: 'x', owner: 'writer' }, 'writer')).statusCode).toBe(403)
    expect(
      (await w.post('/api/tasks/new', { folder: w.proj, plan: 'p', title: 'x', owner: 'writer' }, undefined, { 'x-silos-agent': 'writer' })).statusCode,
    ).toBe(403)
  })
  it('a prepare that refuses writes nothing and registers nothing (the kernel verb)', async () => {
    const w = await world([t('t1')])
    const before = w.sha()
    const r = w.siloActions.newTask('plans', w.planKey, { title: 'x', owner: 'writer', prepare: () => ({ ok: false, code: 403, error: 'not today' }) })
    expect(r).toMatchObject({ ok: false, code: 403, reason: 'not today' })
    expect(w.sha()).toBe(before)
    expect(w.owned).toEqual([])
  })
  it('D18b — the details wake nobody on a save without Give: they are born with the task', async () => {
    const w = await world([t('t1', { owner: 'owner' })], { bound: ['writer'] })
    w.taskMode.look()
    await w.post('/api/tasks/new', { folder: w.proj, plan: 'p', title: 'Later', owner: 'writer', details: 'Context for later' })
    for (let i = 0; i < 2; i++) {
      w.kernel.refresh()
      w.taskMode.look()
    }
    expect(w.store.wakes()).toEqual([])
    expect(w.sent).toEqual([])
  })
  it("give, bound: the owner's assign — and its wake carries the details as the owner's note", async () => {
    const w = await world([t('t1', { owner: 'owner' })], { bound: ['writer'] })
    w.taskMode.look()
    const r = await w.post('/api/tasks/new', { folder: w.proj, plan: 'p', title: 'Now', owner: 'writer', details: 'Use the new rate', give: true })
    expect(r.json().assign).toMatchObject({ queued: true, wakes: 'task' })
    const wake = w.store.wakes().find((x) => x.reason === 'assigned')!
    expect(wake.notes.map((n) => [n.by, n.text])).toEqual([['owner', 'Use the new rate']])
    expect(w.sent[0]!.text).toContain('Use the new rate')
  })
  it('give, told: nothing queued, it waits for you; give, yours: «it is yours»', async () => {
    const w = await world([t('t1', { owner: 'owner' })])
    expect((await w.post('/api/tasks/new', { folder: w.proj, plan: 'p', title: 'a', owner: 'builder', give: true })).json().assign).toMatchObject({
      queued: false,
      wakes: 'never',
    })
    expect((await w.post('/api/tasks/new', { folder: w.proj, plan: 'p', title: 'b', owner: 'owner', give: true })).json().assign).toEqual({
      queued: false,
      why: 'it is yours',
    })
  })
})

// ── hand: give a task to another ─────────────────────────────────────

describe('hand: ONE write, every refusal writes nothing', () => {
  const known = (w: Awaited<ReturnType<typeof world>>, id: string): void => {
    w.origins.set(w.key(id), { by: 'owner', how: 'owner', at: new Date().toISOString() })
  }
  const hand = (w: Awaited<ReturnType<typeof world>>, id: string, to: string, painted: Json = {}) =>
    w.act(id, 'hand', { to, owner: w.task(id).owner ?? '', state: w.task(id).status, outside: false, ...painted })

  it('a stale conversation of the outgoing owner: ONE write — the owner, its note, the conversation let go, the state; the events of its parts', async () => {
    const w = await world([t('t1', { status: 'in_progress' })])
    known(w, 't1')
    const s = await w.session('writer', 60 * 60_000)
    expect(w.siloActions.appendItem('plans', w.key('t1'), 'conversations', { session: s }).ok).toBe(true)
    const a = await hand(w, 't1', 'builder')
    expect([a.r.statusCode, a.writeCalls]).toEqual([200, 1])
    const x = w.task('t1')
    expect([x.owner, x.status, x.notes.map((n: Json) => [n.by, n.text]), x.releases.map((m: Json) => [m.session, m.released])]).toEqual([
      'builder',
      'pending',
      [['owner', 'Handed from Writer to Builder.']],
      [[s, true]],
    ])
    expect(a.body.released).toEqual([s])
    expect(
      w
        .eventsOf('t1')
        .slice(-4)
        .map((e) => e.verb),
    ).toEqual(['append-item', 'release', 'set-field', 'set-field'])
    expect(w.eventsOf('t1').slice(-4)[0]).toMatchObject({ by: 'owner', detail: { coll: 'notes', digest: noteDigest('Handed from Writer to Builder.') } })
    // the stamper is told it is the owner's write (J3): an unattended turn of
    // the outgoing owner that touched the plan never reverts it as a steal
    expect(w.owned.at(-1)).toMatchObject({ key: w.key('t1'), shape: { owner: 'builder', status: 'pending' } })
  })
  it('J10.14 — handed to whom it is already: 200 already, nothing written, no assign', async () => {
    const w = await world([t('t1')])
    known(w, 't1')
    const before = w.sha()
    const a = await hand(w, 't1', 'writer')
    expect([a.r.statusCode, a.body.already, a.body.assign]).toEqual([200, true, undefined])
    expect(w.sha()).toBe(before)
  })
  it('refused, nothing written: what was painted changed (owner, state), a closed task, a person, an archived agent, one fenced elsewhere, one without a folder, {outside} missing', async () => {
    const w = await world([t('t1'), t('t2', { status: 'done' })])
    known(w, 't1')
    known(w, 't2')
    const before = w.sha()
    expect((await hand(w, 't1', 'builder', { owner: 'teller' })).body.error).toBe("it changed — it is writer's now")
    expect((await hand(w, 't1', 'builder', { state: 'in_progress' })).body.error).toBe('it changed — it is pending now')
    expect((await hand(w, 't2', 'builder')).body.error).toBe('it is done — reopen it first')
    expect((await hand(w, 't1', 'sam')).r.statusCode).toBe(400)
    for (const to of ['retired', 'outsider', 'master']) expect((await hand(w, 't1', to)).r.statusCode).toBe(409)
    expect((await w.act('t1', 'hand', { to: 'builder', owner: 'writer', state: 'pending' })).r.statusCode).toBe(400)
    expect(w.sha()).toBe(before)
  })
  it('J5, K8 — an unknown origin needs outside:true (then hand blesses it); a provisional one is refused', async () => {
    const w = await world([t('t1'), t('t2')], { bound: ['builder'] })
    const before = w.sha()
    expect((await hand(w, 't1', 'builder')).body.error).toBe('its origin is unknown — look at it first')
    w.origins.set(w.key('t2'), { by: 'unknown', how: 'unclaimed', at: 'x', provisional: { candidates: [], since: 'x' } } as never)
    expect((await hand(w, 't2', 'builder', { outside: true })).r.statusCode).toBe(409)
    expect(w.sha()).toBe(before)
    // nothing blessed while nothing was written
    expect(w.origins.get(w.key('t1'))).toBeNull()
    const ok = await hand(w, 't1', 'builder', { outside: true })
    expect([ok.r.statusCode, ok.body.blessed]).toEqual([200, true])
    expect(w.origins.get(w.key('t1'))).toMatchObject({ by: 'owner', how: 'give' })
  })
  it("bound → the owner's assign queued, after the write; told → nothing starts, it waits for you; to you → «it is yours»", async () => {
    const w = await world([t('t1'), t('t2'), t('t3')], { bound: ['builder'] })
    for (const id of ['t1', 't2', 't3']) known(w, id)
    const b = await hand(w, 't1', 'builder')
    expect(b.body.assign).toMatchObject({ queued: true, wakes: 'task' })
    expect(w.store.wakes().find((x) => x.reason === 'assigned')).toMatchObject({ agent: 'builder', task: w.key('t1'), gesture: true })
    expect((await hand(w, 't2', 'teller')).body.assign).toMatchObject({ queued: false, wakes: 'never' })
    const mine = await hand(w, 't3', 'owner')
    expect([mine.body.assign, w.task('t3').owner, w.task('t3').status]).toEqual([{ queued: false, why: 'it is yours' }, 'owner', 'pending'])
    expect(w.task('t3').notes[0].text).toBe('Handed from Writer to you.')
  })
  it("J2, K6 — a current conversation working it by the claim's rule (moved 2 min ago) refuses, naming it; one that moved an hour ago is let go", async () => {
    const w = await world([t('t1', { owner: 'retired', status: 'in_progress' }), t('t2', { owner: 'retired', status: 'in_progress' })])
    known(w, 't1')
    known(w, 't2')
    const fresh = await w.session('retired', 2 * 60_000)
    const old = await w.session('retired', 60 * 60_000)
    w.siloActions.appendItem('plans', w.key('t1'), 'conversations', { session: fresh })
    w.siloActions.appendItem('plans', w.key('t2'), 'conversations', { session: old })
    const before = w.sha()
    const r = await hand(w, 't1', 'builder')
    expect(r.r.statusCode).toBe(409)
    expect(r.body.error).toMatch(/^\w+'s conversation «work for retired» \(.*\) is on it now — stop or unlink that conversation first$/)
    expect(w.sha()).toBe(before)
    const ok = await hand(w, 't2', 'builder')
    expect([ok.r.statusCode, ok.body.released, w.task('t2').owner, w.task('t2').status]).toEqual([200, [old], 'builder', 'pending'])
    expect(w.task('t2').notes[0].text).toBe('Handed from Retired to Builder.')
  })
  it('K6 — a Task mode turn starting on it (no conversation yet) refuses, naming its agent', async () => {
    const w = await world([t('t1')], { bound: ['writer'] })
    known(w, 't1')
    expect((await w.post('/api/tasks/assign', { key: w.key('t1') })).json()).toMatchObject({ queued: true })
    expect(w.sent).toHaveLength(1)
    const before = w.sha()
    const r = await hand(w, 't1', 'builder')
    expect([r.r.statusCode, r.body.error]).toEqual([409, "Writer's turn on it is starting — stop it first, then give it"])
    expect(w.sha()).toBe(before)
  })
  it("J6, K3 — a current conversation of `to` stays and the task stays in progress; the outgoing owner's is let go", async () => {
    const w = await world([t('t1', { owner: 'owner', status: 'in_progress' })])
    known(w, 't1')
    const hers = await w.session('builder', 60_000)
    const mine = await w.session('writer', 60 * 60_000)
    w.siloActions.appendItem('plans', w.key('t1'), 'conversations', { session: hers })
    w.siloActions.appendItem('plans', w.key('t1'), 'conversations', { session: mine })
    const a = await hand(w, 't1', 'builder')
    expect([a.r.statusCode, a.body.released, w.task('t1').status, w.task('t1').owner]).toEqual([200, [mine], 'in_progress', 'builder'])
    expect(w.task('t1').notes[0].text).toBe('Handed from you to Builder.')
  })
  it("J4 — Silos' wait and a wait naming `to` go; a wait on a person stays; a review whose reviewer stays stays in review; the next check stays; an open dependency still holds it", async () => {
    const check = new Date(Date.now() + 86_400_000).toISOString()
    const w = await world([
      t('t0', { owner: 'teller' }),
      t('t1', { status: 'blocked', waitingOn: unstick }),
      t('t2', { status: 'blocked', waitingOn: { owner: 'builder', action: 'the numbers' } }),
      t('t3', { status: 'blocked', waitingOn: { owner: 'sam', action: 'sign' } }),
      t('t4', { status: 'in_review', waitingOn: { owner: 'owner', action: 'review it' }, nextCheckAt: check }),
      t('t5', { status: 'in_review', waitingOn: { owner: 'builder', action: 'review it' } }),
      t('t6', { status: 'blocked', dependsOn: ['t0'] }),
    ])
    for (const id of ['t1', 't2', 't3', 't4', 't5', 't6']) known(w, id)
    for (const id of ['t1', 't2', 't3', 't4', 't5', 't6']) expect((await hand(w, id, 'builder')).r.statusCode).toBe(200)
    expect(['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => [w.task(id).status, w.task(id).waitingOn?.owner ?? null])).toEqual([
      ['pending', null],
      ['pending', null],
      ['blocked', 'sam'],
      ['in_review', 'owner'],
      ['pending', null],
      ['blocked', null],
    ])
    expect(w.task('t4').nextCheckAt).toBe(check)
  })
  it('J4, J9 — the B2 fact of a wait that stays is kept; set-field of `owner` stays refused (hand is no manifest verb)', async () => {
    const w = await world([t('t1', { status: 'blocked', waitingOn: { owner: 'teller', action: 'the numbers' } })])
    known(w, 't1')
    w.store.update((st) => {
      st.armed[w.key('t1')] = { to: 'teller', action: 'the numbers', asked: '', at: new Date().toISOString(), by: 'writer' }
    })
    await hand(w, 't1', 'builder')
    expect(w.store.armedOf(w.key('t1'))).toMatchObject({ to: 'teller', by: 'writer' })
    expect(w.siloActions.setField('plans', w.key('t1'), 'owner', 'writer')).toMatchObject({ ok: false, code: 403 })
  })
  it("K13 — a handed task leaves its creator's open count; an answer to what the previous owner asked says who asked", async () => {
    const w = await world([t('t1', { status: 'blocked', waitingOn: { owner: 'teller', action: 'the numbers' } })], { bound: ['builder'] })
    // writer created it from its mission (the ledger), and asked teller through Silos
    const entry = w.creations.add('writer', {
      kind: 'task',
      ref: w.key('t1'),
      title: 'Task t1',
      createdAt: new Date().toISOString(),
      by: 'writer',
      root: 'mission',
    })
    w.origins.set(w.key('t1'), { by: 'writer', how: 'creation', at: new Date().toISOString(), creation: { agent: 'writer', id: entry.id } })
    w.store.update((st) => {
      st.armed[w.key('t1')] = { to: 'teller', action: 'the numbers', asked: '', at: new Date().toISOString(), by: 'writer' }
    })
    expect(openFromMissionRoot(w.creations.list('writer'), () => true)).toBe(1)
    await hand(w, 't1', 'builder')
    expect(openFromMissionRoot(w.creations.list('writer'), () => true)).toBe(0)
    const asks = new TaskAsks({
      store: w.store,
      tasks: () => w.taskMode.tasks(),
      write: (k, mutate, text) => {
        const r = w.siloActions.silosWriteChild('plans', k, mutate, { by: 'silos', text })
        return r.ok ? { ok: true } : { ok: false, code: r.code, reason: r.reason }
      },
      isAgent: (id) => w.registry.list(true).some((a) => a.id === id),
      inPlay: (id) => w.registry.list().some((a) => a.id === id),
      nameOf: (id) => w.registry.get(id)?.name ?? id,
      bound: (id) => id === 'builder',
      seenBy: () => null,
    })
    w.kernel.refresh()
    expect(asks.answer({ agentId: 'teller', turn: null, key: w.key('t1'), text: '42' })).toMatchObject({ ok: true })
    expect(w.store.wakes().find((x) => x.reason === 'answered')).toMatchObject({ agent: 'builder', says: 'Teller answered what Writer asked on this task' })
  })
})

describe('the task page reads where it may go', () => {
  it('GET /api/tasks/mode lists you and the agents in play whose fence holds its project — never its owner, an archived one, one fenced elsewhere, one without a folder', async () => {
    const w = await world([t('t1')], { bound: ['builder'] })
    const v = (await w.get(`/api/tasks/mode?key=${encodeURIComponent(w.key('t1'))}`)).json()
    expect(v.handTo.map((x: Json) => [x.id, x.wakes])).toEqual([
      ['owner', null],
      ['builder', 'task'],
      ['teller', 'never'],
    ])
  })
})
