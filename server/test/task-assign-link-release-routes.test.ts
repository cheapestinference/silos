// task-assign-link-release-routes.test.ts — task routes over the real
// server, the real plans kernel on the REFERENCE manifest and a real session
// index (nothing is spawned, no claude ever runs): the owner's gesture (POST
// /api/tasks/assign), the owner's link (POST /api/tasks/link, ownerLink), the
// release's disposition, the claim's task lookup, the claim's `set` for an
// unknown conversation, the threads' cache dropped on every write, the day's
// wakes (GET /api/task-mode/today) and how each agent moves on the roster
// (GET /api/agents `wakes` + `duty`). Generic fixtures only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { taskThreads } from '../src/task-threads.js'
import { agentMayWrite } from '../src/agent-authz.js'
import type { SessionMeta } from '../src/types.js'
import { asOwner } from './helpers/owner.js'
import { bearerWritesCarryTurns } from './helpers/live-turn.js'

type Json = Record<string, any>
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json')
const LOCAL = { host: '127.0.0.1:3210' }
const socket = `silos-taskflow2-${process.pid}`
// the shipped Plans already declares the release's disposition (block B2 of
// task-flow round 2): only then does the state ride the release's write
const SHIPPED_DISPOSE = (JSON.parse(readFileSync(REF, 'utf8')) as Json).spec.actions.some((a: Json) => a.verb === 'release' && a.dispose)

let base: string
let app: FastifyInstance | undefined
let terminals: TerminalService | undefined
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'taskflow2-'))
})
afterEach(async () => {
  terminals?.killAll()
  terminals?.stopReaper()
  await app?.close()
  app = undefined
  rmSync(base, { recursive: true, force: true })
})

const t = (id: string, over: Json = {}): Json => ({ id, title: `Task ${id}`, owner: 'writer', status: 'pending', dependsOn: [], ...over })

type Plan = { project?: 'a' | 'b'; slug: string; tasks: Json[] }
async function world(plans: Plan[], opts: { manifest?: (m: Json) => void; bound?: string[]; devFolder?: 'a' | 'b' } = {}) {
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  const proj = { a: join(base, 'alpha'), b: join(base, 'beta') }
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const fileOf = (p: Plan): string => join(proj[p.project ?? 'a'], 'plans', `${p.slug}.plan.json`)
  for (const p of plans) {
    mkdirSync(join(fileOf(p), '..'), { recursive: true })
    writeFileSync(fileOf(p), JSON.stringify({ title: p.slug, tasks: p.tasks }, null, 2))
  }
  mkdirSync(proj.b, { recursive: true })
  const manifest = JSON.parse(readFileSync(REF, 'utf8')) as Json
  opts.manifest?.(manifest)
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(manifest))
  const siloRegistry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  siloRegistry.load()
  const isAgent = (v: string): boolean => ['writer', 'ops', 'builder'].includes(v)
  const kernel = new SiloKernel({
    registry: siloRegistry,
    journal: new TransitionJournal(siloRegistry.conventionsDir),
    overlay: new OverlayStore(siloRegistry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [proj.a, proj.b] }),
  })
  kernel.refresh()
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const lineage = new LineageStore(join(dataDir, 'lineage.json'))
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder: proj[opts.devFolder ?? 'a'] })
  registry.create({ id: 'ops', name: 'Ops', folder: proj.a })
  registry.create({ id: 'builder', name: 'Builder', folder: proj.a })
  const agentState = new AgentStateStore(join(dataDir, 'agent-state'))
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
  const siloActions = new SiloActions({
    registry: siloRegistry,
    kernel,
    events,
    acks: new SiloAcks(siloRegistry.root),
    proposals: new SiloProposals(siloRegistry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent,
    agentMayReadLocation: () => false,
    threadKey: (id) => threads().threadKey(id),
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
  const sent: Array<{ agentId: string; text: string }> = []
  let finish: Array<(v: { costUsd: number | null }) => void> = []
  const taskMode: TaskModeEngine = new TaskModeEngine({
    store,
    plans: () => {
      const reading = kernel.reading('plans')
      return reading ? { reading } : null
    },
    bound: () => new Set(opts.bound ?? []),
    setField: () => ({ ok: true }),
    appendConversation: (k, s) => {
      const r = siloActions.appendItem('plans', k, 'conversations', { session: s })
      return r.ok ? { ok: true } : { ok: false, reason: r.reason }
    },
    conversationOf: (a, ids) => threads().tipOf(a, ids),
    holdersOf: (a, ids) => threads().holdersOf(a, ids),
    busyWhy: () => null,
    ready: () => true,
    // a turn that never runs anything: it is born (its session joins the
    // task at chat-init, a moment later in life) and ends when the test says
    send: (i) => {
      sent.push({ agentId: i.agentId, text: i.text })
      let done!: (v: { costUsd: number | null }) => void
      const p = new Promise<{ costUsd: number | null }>((r) => {
        done = r
      })
      finish.push(done)
      return { turnId: `turn-${sent.length}`, done: p }
    },
    nameOf: (id) => registry.get(id)?.name ?? id,
    currentOf: (l, r) => threads().currentOf(l, r),
  })
  let invalidated = 0
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
    agentTokens,
    lineage,
    agentState,
    dataDir,
    invalidateTaskThreads: () => {
      invalidated += 1
    },
  })
  bearerWritesCarryTurns(app, chat, agentTokens)
  asOwner(app, 't0k')
  // a conversation of `agent` in project `p`, last moved `agoMs` ago
  const session = async (agent: string, agoMs: number, p: 'a' | 'b' = 'a', id = randomUUID()): Promise<string> => {
    const mf = mungePath(proj[p])
    mkdirSync(join(root, mf), { recursive: true })
    native.register(mf, id, { agentId: agent, createdAt: new Date(Date.now() - agoMs - 5_000).toISOString() })
    const at = (ms: number): string => new Date(Date.now() - ms).toISOString()
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          sessionId: id,
          cwd: proj[p],
          timestamp: at(agoMs + 5_000),
          uuid: 'u1',
          message: { role: 'user', content: `work for ${agent}` },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: id,
          cwd: proj[p],
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
  const key = (id: string, slug = 'p', p: 'a' | 'b' = 'a'): string => `folder:${proj[p]}/${slug}/tasks/${id}`
  const read = (slug = 'p', p: 'a' | 'b' = 'a'): Json => JSON.parse(readFileSync(join(proj[p], 'plans', `${slug}.plan.json`), 'utf8'))
  const task = (id: string, slug = 'p', p: 'a' | 'b' = 'a'): Json => read(slug, p).tasks.find((x: Json) => x.id === id)
  const bearer = (agent?: string): Json => (agent ? { authorization: `Bearer ${agentTokens.tokenFor(agent)}` } : {})
  const post = (url: string, payload: Json, agent?: string, headers: Json = {}) => {
    kernel.refresh()
    return app!.inject({ method: 'POST', url, headers: { ...LOCAL, ...bearer(agent), ...headers }, payload })
  }
  const get = (url: string, agent?: string) => {
    kernel.refresh()
    return app!.inject({ method: 'GET', url, headers: { ...LOCAL, ...bearer(agent) } })
  }
  return {
    post,
    get,
    session,
    key,
    task,
    read,
    proj,
    store,
    sent,
    siloActions,
    taskMode,
    kernel,
    dataDir,
    invalidated: () => invalidated,
    finishAll: async (cost: number | null) => {
      for (const f of finish) f({ costUsd: cost })
      finish = []
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

describe('POST /api/tasks/assign — the gesture', () => {
  it('1a · New task with a description for a bound agent: the note woke it; assign after it answers queued:false — one turn, with the note', async () => {
    const w = await world([{ slug: 'p', tasks: [] }], { bound: ['writer'] })
    w.taskMode.look()
    // New task: the task, then its description as the owner's note (each write looks)
    expect(w.siloActions.appendItem('plans', `folder:${w.proj.a}/p`, 'tasks', { id: 't1', title: 'logo', owner: 'writer' }).ok).toBe(true)
    w.taskMode.look()
    expect(w.siloActions.appendItem('plans', w.key('t1'), 'notes', { text: 'make it orange' }).ok).toBe(true)
    w.taskMode.look()
    const r = await w.post('/api/tasks/assign', { key: w.key('t1') })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ queued: false, why: 'it is already on its way', wakes: 'task' })
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.text).toContain('make it orange')
  })

  it('1b · without a description the gesture is the wake: one turn, «the owner handed it to you»', async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1')] }], { bound: ['writer'] })
    w.taskMode.look()
    const r = await w.post('/api/tasks/assign', { key: w.key('t1') })
    expect(r.json()).toEqual({ queued: true, wakes: 'task' })
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.text).toContain('the owner handed it to you')
  })

  it('1c · the task named by its ref — {plan, task}, as claim and release take it — is the same task as by key (review D3)', async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1')] }], { bound: ['writer'] })
    w.taskMode.look()
    const r = await w.post('/api/tasks/assign', { plan: 'p', task: 't1' })
    expect(r.json()).toEqual({ queued: true, wakes: 'task' })
    expect(w.sent).toHaveLength(1)
    expect((await w.post('/api/tasks/assign', { plan: 'p', task: 'zz' })).statusCode).toBe(404)
  })

  it("A1.8 · an id IN the file whose task can't be read: the 404 of assign, claim and release says why, in the reader's words", async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1'), t('t7', { notes: 'remember this' })] }], { bound: ['writer'] })
    const s = await w.session('writer', 60 * 60_000)
    const why = "t7 is in the file but can't be read: notes is not an array"
    for (const [url, body] of [
      ['/api/tasks/assign', { key: w.key('t7') }],
      ['/api/tasks/assign', { plan: 'p', task: 't7' }],
      ['/api/tasks/claim', { plan: 'p', task: 't7', session: s }],
      ['/api/tasks/release', { key: w.key('t7'), session: s }],
    ] as const) {
      const r = await w.post(url, body)
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe(why)
    }
    // an id the file does not hold at all: as before
    expect((await w.post('/api/tasks/assign', { plan: 'p', task: 'zz' })).json().error).toBe('no such task in the plans Silos reads')
  })

  it('2 · an agent Only when told: nothing queued, and why — the owner opens it', async () => {
    const w = await world([{ slug: 'p', tasks: [t('a', { owner: 'builder' }), t('c'), t('d', { owner: 'sam' })] }])
    expect((await w.post('/api/tasks/assign', { key: w.key('a') })).json()).toEqual({
      queued: false,
      wakes: 'never',
      why: 'Builder waits for you — open its console on it',
    })
    expect((await w.post('/api/tasks/assign', { key: w.key('c') })).json()).toEqual({
      queued: false,
      wakes: 'never',
      why: 'Writer waits for you — open its console on it',
    })
    expect((await w.post('/api/tasks/assign', { key: w.key('d') })).json()).toMatchObject({ queued: false })
    expect(w.store.wakes()).toEqual([])
    expect(w.sent).toEqual([])
  })

  it('3 · twice in a row → one wake', async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1')] }], { bound: ['writer'] })
    expect((await w.post('/api/tasks/assign', { key: w.key('t1') })).json()).toMatchObject({ queued: true })
    expect((await w.post('/api/tasks/assign', { key: w.key('t1') })).json()).toMatchObject({ queued: false, why: 'it is already on its way' })
    expect(w.store.wakes()).toHaveLength(1)
  })

  it('4 · a task with a current conversation: nothing', async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1')] }], { bound: ['writer'] })
    const s = await w.session('writer', 60 * 60_000)
    expect((await w.post('/api/tasks/link', { key: w.key('t1'), session: s })).statusCode).toBe(200)
    expect((await w.post('/api/tasks/assign', { key: w.key('t1') })).json()).toEqual({ queued: false, wakes: 'task', why: 'Writer is on it already — open it' })
    expect(w.sent).toEqual([])
  })

  // a bearer starts ITS OWN task, On its own,
  // through the same pipe (never a gesture); another's task is a 403 in the
  // words of its owner's class; Only when told is a 409
  it("5 · an agent bearer: its own task queues (not a gesture); another's is 403 by owner class; told is 409; 400/404 as before", async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1'), t('t2', { owner: 'builder' }), t('t3', { owner: 'owner' }), t('t4', { owner: 'sam' })] }], {
      bound: ['writer'],
    })
    expect(agentMayWrite('writer', 'POST', '/api/tasks/assign')).toBe(true)
    expect(agentMayWrite('writer', 'POST', '/api/tasks/link')).toBe(false)
    const other = await w.post('/api/tasks/assign', { key: w.key('t1') }, 'ops')
    expect(other.statusCode).toBe(403)
    expect(other.json().error).toBe("p#t1 is Writer's task, not yours — message its owner (POST /api/agents/writer/messages)")
    expect((await w.post('/api/tasks/assign', { key: w.key('t3') }, 'writer')).json().error).toBe("p#t3 is the owner's task, not yours — leave a note on it")
    expect((await w.post('/api/tasks/assign', { key: w.key('t4') }, 'writer')).json().error).toBe("p#t4 is sam's task, not yours — leave a note on it")
    const told = await w.post('/api/tasks/assign', { key: w.key('t2') }, 'builder')
    expect(told.statusCode).toBe(409)
    expect(told.json().error).toBe(
      'You are Only when told: the owner starts your tasks — claim it to work it here with them, or leave it pending and say so in a note',
    )
    const own = await w.post('/api/tasks/assign', { key: w.key('t1') }, 'writer')
    expect(own.statusCode).toBe(200)
    expect(own.json()).toMatchObject({ queued: true, wakes: 'task' })
    expect(w.store.wakes()).toHaveLength(1)
    expect(w.store.wakes()[0]!.gesture).toBeUndefined()
    expect(w.sent[0]!.text).toContain('you started it yourself')
    expect((await w.post('/api/tasks/assign', {})).statusCode).toBe(400)
    expect((await w.post('/api/tasks/assign', { key: w.key('zz') })).statusCode).toBe(404)
  })
})

describe('POST /api/tasks/link — ownerLink', () => {
  it('pending → linked and in progress in one write (the claim); blocked or in review → listed, its state kept; closed → 409', async () => {
    const w = await world([
      {
        slug: 'p',
        tasks: [t('a'), t('b', { status: 'blocked', waitingOn: { owner: 'owner', action: 'x' } }), t('c', { status: 'in_review' }), t('d', { status: 'done' })],
      },
    ])
    const s = await w.session('writer', 60 * 60_000)
    const r = await w.post('/api/tasks/link', { key: w.key('a'), session: s })
    expect(r.json()).toMatchObject({ ok: true, linked: true, state: 'in_progress', claimed: true })
    expect(w.task('a')).toMatchObject({ status: 'in_progress', conversations: [s] })
    for (const id of ['b', 'c']) {
      const before = w.task(id).status
      expect((await w.post('/api/tasks/link', { key: w.key(id), session: s })).json()).toMatchObject({ ok: true, linked: true, state: before, claimed: false })
      expect(w.task(id).status).toBe(before)
      expect(w.task(id).conversations.map((c: Json) => c.session ?? c)).toEqual([s])
    }
    expect((await w.post('/api/tasks/link', { key: w.key('d'), session: s })).statusCode).toBe(409)
    expect((await w.post('/api/tasks/link', { key: w.key('a'), session: s }, 'writer')).statusCode).toBe(403)
    expect((await w.post('/api/tasks/link', { key: w.key('a'), session: '../x' })).statusCode).toBe(400)
  })

  it('A1.5 · a blocked task whose declared dependencies are all done (no wait, no check ahead) reads as pending: the link claims it', async () => {
    const w = await world([
      { slug: 'p', tasks: [t('b0', { owner: 'ops', status: 'done' }), t('a', { status: 'blocked', dependsOn: ['b0'] }), t('n', { status: 'blocked' })] },
    ])
    const s = await w.session('writer', 60 * 60_000)
    expect((await w.post('/api/tasks/link', { key: w.key('a'), session: s })).json()).toMatchObject({
      ok: true,
      linked: true,
      state: 'in_progress',
      claimed: true,
    })
    expect(w.task('a').status).toBe('in_progress')
    // blocked naming nothing stays the agent's disposition: only listed
    expect((await w.post('/api/tasks/link', { key: w.key('n'), session: s })).json()).toMatchObject({ ok: true, state: 'blocked', claimed: false })
  })

  it('R2 · a task closed meanwhile is never reopened by a link: linkAndSet refuses a terminal state (on the file as written)', async () => {
    const w = await world([{ slug: 'p', tasks: [t('a'), t('b', { status: 'cancelled' })] }])
    const s = await w.session('writer', 60 * 60_000)
    // the agent closes it after the door read it — the owner's link lands later
    expect(w.siloActions.setField('plans', w.key('a'), 'status', 'done', { by: 'writer' }).ok).toBe(true)
    const r = w.siloActions.linkAndSet('plans', w.key('a'), 'conversations', s, 'status', 'in_progress', { by: 'owner', actor: {} })
    expect(r).toMatchObject({ ok: false, code: 409 })
    expect(w.task('a')).toMatchObject({ status: 'done' })
    expect(w.task('a').conversations).toBeUndefined()
    expect(w.siloActions.linkAndSet('plans', w.key('b'), 'conversations', s, 'status', 'in_progress', { by: 'owner', actor: {} })).toMatchObject({
      ok: false,
      code: 409,
    })
    // the route says it too
    expect((await w.post('/api/tasks/link', { key: w.key('a'), session: s })).statusCode).toBe(409)
  })

  it("P4 · linking another agent's conversation to a task says what the claim says", async () => {
    const w = await world([{ slug: 'p', tasks: [t('a')] }])
    const s = await w.session('ops', 60 * 60_000)
    const r = await w.post('/api/tasks/link', { key: w.key('a'), session: s })
    expect(r.json()).toMatchObject({
      ok: true,
      linked: true,
      warn: "this conversation is Ops's, not Writer's — it's linked, but Writer's door and wakes won't see it",
    })
    const mine = await w.session('writer', 60 * 60_000)
    expect((await w.post('/api/tasks/link', { key: w.key('a'), session: mine })).json().warn).toBeUndefined()
  })

  it("m4 · claim, release and link drop the threads' cache in the same request", async () => {
    const w = await world([{ slug: 'p', tasks: [t('a'), t('b')] }])
    const s = await w.session('writer', 60 * 60_000)
    await w.post('/api/tasks/link', { key: w.key('a'), session: s })
    expect(w.invalidated()).toBe(1)
    await w.post('/api/tasks/claim', { key: w.key('b'), session: s }, 'writer')
    expect(w.invalidated()).toBe(2)
    await w.post('/api/tasks/release', { key: w.key('b'), session: s }, 'writer')
    expect(w.invalidated()).toBe(3)
  })
})

describe('POST /api/tasks/release {state?} — the disposition', () => {
  it.runIf(SHIPPED_DISPOSE)("a state outside dispose.allowed → 400 in its words (appendRelease's); not a string → 400; nothing written", async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1')] }])
    const s = await w.session('writer', 60 * 60_000)
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s }, 'writer')
    // a Drop on release is allowed since plans 0.6.1 (cancelled is in dispose.allowed); in_progress is not
    const r = await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'in_progress' }, 'writer')
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('state must be one of pending, in_review, blocked, done, cancelled — omit it to leave it pending')
    expect(w.task('t1').releases).toBeUndefined()
  })
  it('a state that is not a string → 400, nothing written; a Plans without dispose releases as before, the state kept', async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1')] }], {
      manifest: (m) => {
        delete m.spec.actions.find((a: Json) => a.verb === 'release').dispose
      },
    })
    const s = await w.session('writer', 60 * 60_000)
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s }, 'writer')
    expect((await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 3 }, 'writer')).statusCode).toBe(400)
    expect(w.task('t1').releases).toBeUndefined()
    const r = await w.post('/api/tasks/release', { key: w.key('t1'), session: s }, 'writer')
    expect(r.json()).toMatchObject({ ok: true, written: true, state: 'in_progress', kept: 'in_progress' })
  })
  it('a mark already there: nothing changes — kept + already: released (N3)', async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1')] }])
    const s = await w.session('writer', 60 * 60_000)
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s }, 'writer')
    await w.post('/api/tasks/release', { key: w.key('t1'), session: s }, 'writer')
    const again = await w.post('/api/tasks/release', { key: w.key('t1'), session: s }, 'writer')
    expect(again.json()).toMatchObject({ ok: true, written: false, kept: w.task('t1').status, already: 'released' })
  })
  it.runIf(SHIPPED_DISPOSE)(
    'the last current thread released: the state goes with it — pending by default, the asked one when sent; another current thread keeps it',
    async () => {
      const w = await world([{ slug: 'p', tasks: [t('a'), t('b'), t('c')] }])
      const s1 = await w.session('writer', 60 * 60_000)
      const s2 = await w.session('writer', 50 * 60_000)
      for (const id of ['a', 'b', 'c']) await w.post('/api/tasks/claim', { key: w.key(id), session: s1 }, 'writer')
      expect((await w.post('/api/tasks/release', { key: w.key('a'), session: s1 }, 'writer')).json()).toMatchObject({ state: 'pending' })
      expect((await w.post('/api/tasks/release', { key: w.key('b'), session: s1, state: 'done' }, 'writer')).json()).toMatchObject({ state: 'done' })
      await w.post('/api/tasks/claim', { key: w.key('c'), session: s2, takeover: true }, 'writer')
      expect((await w.post('/api/tasks/release', { key: w.key('c'), session: s1, state: 'done' }, 'writer')).json()).toMatchObject({
        state: 'in_progress',
        kept: 'in_progress',
      })
    },
  )
})

describe("the claim's task lookup and its set for an unknown conversation", () => {
  it("#38 · several projects hold plan#task and no folder: the known conversation's project wins, else the agent's", async () => {
    const w = await world(
      [
        { slug: 'p', project: 'a', tasks: [t('t1')] },
        { slug: 'p', project: 'b', tasks: [t('t1')] },
      ],
      { devFolder: 'b' },
    )
    const inB = await w.session('writer', 60 * 60_000, 'b')
    const r = await w.post('/api/tasks/claim', { plan: 'p', task: 't1', session: inB }, 'writer')
    expect(r.statusCode).toBe(200)
    expect(r.json().key).toBe(w.key('t1', 'p', 'b'))
    // no conversation: the agent's own folders decide
    const r2 = await w.post('/api/tasks/claim', { plan: 'p', task: 't1' }, 'writer')
    expect(r2.json().key).toBe(w.key('t1', 'p', 'b'))
    // the owner, naming nobody: still two — 409 with both keys
    const r3 = await w.post('/api/tasks/claim', { plan: 'p', task: 't1' })
    expect(r3.statusCode).toBe(409)
    expect(r3.json().keys).toHaveLength(2)
  })
  it("m9 · the ref the screen paints, `<project>#t3`, names the project list's t3", async () => {
    const w = await world([{ slug: 'tasks', tasks: [t('t3')] }])
    const project = basename(w.proj.a)
    const r = await w.post('/api/tasks/claim', { plan: project, task: 't3' }, 'writer')
    expect(r.statusCode).toBe(200)
    expect(r.json().key).toBe(w.key('t3', 'tasks'))
  })
  it('m9 · a real plan named like the project still wins over the project list', async () => {
    const w2 = await world([
      { slug: 'tasks', tasks: [t('t3')] },
      { slug: 'alpha', tasks: [t('t3')] },
    ])
    const r2 = await w2.post('/api/tasks/claim', { plan: 'alpha', task: 't3' }, 'writer')
    expect(r2.json().key).toBe(w2.key('t3', 'alpha'))
  })
  it('M9/B2 · `<project>/<plan>` — the label painted when a plan is named like its project — names that plan of that project', async () => {
    const w = await world([
      { slug: 'tasks', tasks: [t('t3')] },
      { slug: 'alpha', tasks: [t('t3')] },
    ])
    expect((await w.post('/api/tasks/claim', { plan: 'alpha/tasks', task: 't3' }, 'writer')).json().key).toBe(w.key('t3', 'tasks'))
    expect((await w.post('/api/tasks/claim', { plan: 'alpha/alpha', task: 't3' }, 'writer')).json().key).toBe(w.key('t3', 'alpha'))
    expect((await w.post('/api/tasks/claim', { plan: 'beta/tasks', task: 't3' }, 'writer')).statusCode).toBe(404)
  })
  it("G2/B3 · `<project>#t3`: the claimant's own project list wins over a plan of that name in ANOTHER project", async () => {
    const w = await world(
      [
        { project: 'a', slug: 'beta', tasks: [t('t3')] },
        { project: 'b', slug: 'tasks', tasks: [t('t3')] },
      ],
      { devFolder: 'b' },
    )
    expect((await w.post('/api/tasks/claim', { plan: 'beta', task: 't3' }, 'writer')).json().key).toBe(w.key('t3', 'tasks', 'b'))
  })
  it("G2/B3 · …a conversation in that project says the same, whoever claims; nobody's place known: the plan of that name, as before", async () => {
    const w = await world(
      [
        { project: 'a', slug: 'beta', tasks: [t('t3'), t('t4')] },
        { project: 'b', slug: 'tasks', tasks: [t('t3'), t('t4')] },
      ],
      { devFolder: 'b' },
    )
    const inB = await w.session('writer', 60 * 60_000, 'b')
    expect((await w.post('/api/tasks/claim', { plan: 'beta', task: 't3', session: inB })).json().key).toBe(w.key('t3', 'tasks', 'b'))
    expect((await w.post('/api/tasks/claim', { plan: 'beta', task: 't4' })).json().key).toBe(w.key('t4', 'beta', 'a'))
  })
  it("no alias: a plan id no file has (an old name of the project's list) names nothing", async () => {
    const w = await world([{ slug: 'tasks', tasks: [t('t1')] }])
    expect((await w.post('/api/tasks/claim', { plan: 'backlog', task: 't1' }, 'writer')).statusCode).toBe(404)
    expect((await w.post('/api/tasks/claim', { key: `folder:${w.proj.a}/backlog/tasks/t1` }, 'writer')).statusCode).toBe(404)
    expect(w.task('t1', 'tasks').status).toBe('pending')
  })
  it("B1 · one ref form: the conversation's tasks (the /clear reminder) say the project's list as `<project>#t3` — and the release reads it back", async () => {
    const w = await world([{ slug: 'tasks', tasks: [t('t3')] }])
    const a = await w.session('writer', 1_000)
    expect((await w.post('/api/tasks/claim', { key: w.key('t3', 'tasks'), session: a }, 'writer')).statusCode).toBe(200)
    const line = (await w.get(`/api/tasks/by-session?session=${a}`)).json()[a][0]
    expect(line.ref).toBe('alpha#t3')
    const [plan, task] = line.ref.split('#')
    const rel = await w.post('/api/tasks/release', { plan, task, session: a }, 'writer')
    expect(rel.statusCode).toBe(200)
    expect(rel.json().key).toBe(w.key('t3', 'tasks'))
  })
  it('B1/B2 · …`<project>/tasks#t3` when the project has a plan named like it — read back the same', async () => {
    const w2 = await world([
      { slug: 'tasks', tasks: [t('t3')] },
      { slug: 'alpha', tasks: [] },
    ])
    const b = await w2.session('writer', 1_000)
    await w2.post('/api/tasks/claim', { key: w2.key('t3', 'tasks'), session: b }, 'writer')
    const line2 = (await w2.get(`/api/tasks/by-session?session=${b}`)).json()[b][0]
    expect(line2.ref).toBe('alpha/tasks#t3')
    const [plan2, task2] = line2.ref.split('#')
    expect((await w2.post('/api/tasks/release', { plan: plan2, task: task2, session: b }, 'writer')).json().key).toBe(w2.key('t3', 'tasks'))
  })
  it("m6 ·a conversation Silos does not know: not linked, but the verb's own `set` lands", async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1')] }], {
      manifest: (m) => {
        m.spec.actions.find((a: Json) => a.verb === 'claim').set = { status: 'in_review' }
      },
    })
    const r = await w.post('/api/tasks/claim', { key: w.key('t1'), session: randomUUID() }, 'writer')
    expect(r.json()).toMatchObject({ ok: true, linked: false, state: 'in_review' })
    expect(w.task('t1').status).toBe('in_review')
  })
})

describe('GET /api/task-mode/today and the roster', () => {
  it("today: what the agent's wake turns cost, as their engine priced them; owner-only", async () => {
    const w = await world([{ slug: 'p', tasks: [t('t1')] }], { bound: ['writer'] })
    await w.post('/api/tasks/assign', { key: w.key('t1') })
    await w.finishAll(0.42)
    const r = await w.get('/api/task-mode/today?agent=writer')
    // the owner's assign is a gesture: never charged to the agent's day (R1),
    // its turn's price said all the same
    expect(r.json()).toMatchObject({ agent: 'writer', woke: 0, costUsd: 0.42, unpriced: 0, running: 0, heldByCeiling: 0 })
    expect((await w.get('/api/task-mode/today')).json()).toEqual({ agents: [expect.objectContaining({ agent: 'writer', woke: 0 })] })
    expect((await w.get('/api/task-mode/today?agent=nobody')).statusCode).toBe(404)
    expect((await w.get('/api/task-mode/today?agent=writer', 'writer')).statusCode).toBe(403)
  })
  it("ownTurnsPerDay: the owner's ceiling per agent — a whole number 1..200, null back to the default", async () => {
    const w = await world([{ slug: 'p', tasks: [] }], { bound: ['writer'] })
    const patch = (v: unknown) => app!.inject({ method: 'PATCH', url: '/api/agents/writer', headers: LOCAL, payload: { ownTurnsPerDay: v } })
    for (const bad of [0, 2.5, 201, '5']) {
      const r = await patch(bad)
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('ownTurnsPerDay must be a whole number from 1 to 200 — or null for the default (10)')
    }
    expect((await patch(5)).statusCode).toBe(200)
    expect((await w.get('/api/agents')).json().agents.find((a: Json) => a.id === 'writer').ownTurnsPerDay).toBe(5)
    expect((await patch(null)).statusCode).toBe(200)
    expect((await w.get('/api/agents')).json().agents.find((a: Json) => a.id === 'writer').ownTurnsPerDay).toBeUndefined()
    expect((await w.get('/api/agents')).json()).toMatchObject({ ownTurnsPerDayDefault: 10, unattendedSpendPerDayDefault: 5 })
  })
})
