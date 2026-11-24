// project-boundary.test.ts — the canary of the project boundary (stage 1:
// told and reach). An agent knows and reaches only its own projects.
//
// Two projects that share no agent, on one install: acme (builder, finance)
// and zbeta (maker). Everything of zbeta carries a marker. As builder, the
// test collects what Silos hands it — the roster of both engines, its
// heartbeat facts and inbox, the body of every GET its bearer reads, and the
// body of every bearer write, accepted or refused, the reflection cases
// included (builder writes maker's id in a wait and a zbeta conversation id
// in its own task) — and asserts no marker comes back, and that each refusal
// is the refusal for a name that names nothing.
//
// A regression net over the channels listed here, not a proof: a channel
// nobody added to the collector, the wiring in index.ts, the engine's own
// matching and anything after launch are outside it. The route table below
// narrows the first gap: every GET route a bearer may read is listed with its
// bound; any other is refused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { TerminalService } from '../src/terminal-service.js'
import { LineageStore } from '../src/lineage.js'
import { MessageStore } from '../src/messages.js'
import { MessageReads } from '../src/message-reads.js'
import { LiveTurns } from '../src/live-turns.js'
import { buildServer } from '../src/server.js'
import { TaskModeStore } from '../src/task-mode/store.js'
import { TaskModeEngine } from '../src/task-mode/engine.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { bearerMayReadLocation } from '../src/silos/bearer-scope.js'
import { territoriesOf } from '../src/territory.js'
import { TaskAsks } from '../src/task-asks.js'
import { taskThreads } from '../src/task-threads.js'
import { heartbeatFacts } from '../src/heartbeat-facts.js'
import { silosBriefing } from '../src/harnesses/briefing.js'
import { agentMayRead } from '../src/agent-authz.js'
import { mayName, ofProject, ownerOutside, servable } from '../src/project-scope.js'
import { SILOS_AUTHOR } from '../src/system-author.js'
import type { SessionMeta } from '../src/types.js'
import { asOwner } from './helpers/owner.js'
import { bearerWritesCarryTurns } from './helpers/live-turn.js'

type Json = Record<string, any>
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json')
const ROSTER_PY = fileURLToPath(new URL('../../plugin/hooks/roster.py', import.meta.url))
const LOCAL = { host: '127.0.0.1:3210' }
const socket = `silos-boundary-${process.pid}`
// every marker of the other project — none may reach builder
const MARKERS = ['zbeta', 'ZMAKERNAME', 'ZMISSION', 'ZTITLE', 'ZMSG', 'ZASK', 'ZCONV', 'zplan']

let base: string
let app: FastifyInstance | undefined
let terminals: TerminalService | undefined
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'project-boundary-'))
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

async function world() {
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  const acme = join(base, 'acme')
  const beta = join(base, 'zbeta')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const bSession = randomUUID()
  const plan = (dir: string, id: string, tasks: Json[]): void => {
    mkdirSync(join(dir, 'plans'), { recursive: true })
    writeFileSync(join(dir, 'plans', `${id}.plan.json`), JSON.stringify({ title: id, tasks }, null, 2))
  }
  plan(acme, 'p', [
    t('a1', 'builder'),
    // reflection: builder wrote maker's id in its own wait, and a zbeta
    // conversation in its own task
    t('a2', 'builder', { status: 'blocked', waitingOn: { owner: 'maker', action: 'look' } }),
    t('a3', 'builder', { conversations: [bSession] }),
    t('a4', 'finance'),
    t('a5', 'maker'),
  ])
  plan(beta, 'zplan', [t('b1', 'maker', { title: 'ZTITLE one' }), t('b2', 'maker', { title: 'ZTITLE two' })])
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), readFileSync(REF, 'utf8'))
  const siloRegistry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  siloRegistry.load()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'builder', name: 'Builder', folder: acme })
  registry.create({ id: 'finance', name: 'Finance', folder: acme, mission: { text: 'Keeps the books.', never: [] } } as never)
  registry.create({ id: 'maker', name: 'ZMAKERNAME', folder: beta, mission: { text: 'ZMISSION makes beta.', never: [] } } as never)
  const all = () => registry.list(true)
  const isAgent = (v: string): boolean => all().some((a) => a.id === v)
  const kernel = new SiloKernel({
    registry: siloRegistry,
    journal: new TransitionJournal(siloRegistry.conventionsDir),
    overlay: new OverlayStore(siloRegistry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [acme, beta] }),
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
  const owner = (m: SessionMeta): string => native.get(m.folder, m.id)?.agentId ?? 'builder'
  const threads = () => taskThreads({ metas: index.allSessions(), lineage, ownerOf: owner, nativeIdOf: (id) => terminals!.nativeIdOf(id) })
  const events = new SiloEvents(siloRegistry.root)
  const territoriesOfAgent = (id: string): string[] => {
    const a = registry.get(id)
    return a ? territoriesOf(a) : []
  }
  const siloActions = new SiloActions({
    registry: siloRegistry,
    kernel,
    events,
    acks: new SiloAcks(siloRegistry.root),
    proposals: new SiloProposals(siloRegistry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent,
    agentMayReadLocation: (agentId, loc) => bearerMayReadLocation(agentId, loc, territoriesOfAgent),
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
  const BOUND = new Set(['builder', 'finance', 'maker'])
  const taskMode = new TaskModeEngine({
    store,
    plans: () => {
      const reading = kernel.reading('plans')
      return reading ? { reading } : null
    },
    bound: () => BOUND,
    ownerOutside: (o, folder) => folder !== null && ownerOutside(registry.get(o), `folder:${folder}`),
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    conversationOf: (a, ids) => threads().tipOf(a, ids),
    holdersOf: (a, ids) => threads().holdersOf(a, ids),
    busyWhy: () => null,
    ready: () => true,
    send: () => ({ turnId: 'turn-x', done: new Promise<void>(() => {}) }),
    currentOf: (l, r) => threads().currentOf(l, r),
  })
  const taskAsks = new TaskAsks({
    store,
    tasks: () => taskMode.tasks(),
    write: (key, mutate, text) => {
      const r = siloActions.silosWriteChild('plans', key, mutate, { by: SILOS_AUTHOR, text })
      return r.ok ? { ok: true } : { ok: false, code: r.code, reason: r.reason }
    },
    isAgent,
    inPlay: (id) => isAgent(id) && !registry.get(id)?.archived,
    nameOf: (id) => registry.get(id)?.name ?? id,
    bound: (id) => BOUND.has(id),
    seenBy: (_to, at) => at + 3600_000,
    ofProject: (id, folder) => ofProject(registry.get(id), folder),
    mayName: (reader, id) => mayName(reader, id, all()),
    look: () => taskMode.look(),
  })
  const messages = new MessageStore(dataDir)
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
    lineage,
    messages,
  })
  bearerWritesCarryTurns(app, chat, agentTokens)
  asOwner(app, 't0k')
  // a conversation of `agent` in `dir`, moving now (live)
  const session = async (agent: string, dir: string, text: string, id = randomUUID()): Promise<string> => {
    const mf = mungePath(dir)
    mkdirSync(join(root, mf), { recursive: true })
    native.register(mf, id, { agentId: agent, createdAt: new Date(Date.now() - 10_000).toISOString() })
    const at = (ms: number): string => new Date(Date.now() - ms).toISOString()
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', sessionId: id, cwd: dir, timestamp: at(5_000), uuid: 'u1', message: { role: 'user', content: text } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: id,
          cwd: dir,
          timestamp: at(1_000),
          uuid: 'a1',
          parentUuid: 'u1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
        }),
      ].join('\n') + '\n',
    )
    await index.refresh(mf, id)
    return id
  }
  await session('maker', beta, 'ZCONV the beta launch', bSession)
  // what zbeta already holds: a message maker wrote to builder (straight
  // into the store — its bearer could not), an ask maker armed on its own task
  messages.send({ from: 'maker', to: 'builder', text: 'ZMSG ask finance about it' })
  messages.send({ from: 'finance', to: 'builder', text: 'hello from acme' })
  store.update((s) => {
    s.armed[`folder:${beta}/zplan/tasks/b1`] = { to: 'builder', action: 'ZASK review', asked: 'ZASK?', at: new Date().toISOString() }
  }, Date.now())
  const bearer = (agent: string): Json => ({ authorization: `Bearer ${agentTokens.tokenFor(agent)}` })
  const post = (url: string, payload: Json, agent: string) => {
    kernel.refresh()
    return app!.inject({ method: 'POST', url, headers: { ...LOCAL, ...bearer(agent) }, payload })
  }
  const patch = (url: string, payload: Json, agent: string) => app!.inject({ method: 'PATCH', url, headers: { ...LOCAL, ...bearer(agent) }, payload })
  const get = (url: string, agent: string) => {
    kernel.refresh()
    return app!.inject({ method: 'GET', url, headers: { ...LOCAL, ...bearer(agent) } })
  }
  const served = {
    list: (id: string, state?: Parameters<MessageStore['list']>[1]) => messages.list(id, state).filter((m) => servable(id, m.from, all())),
    markRead: (id: string, ids: Iterable<string>) => messages.markRead(id, ids),
  }
  return {
    post,
    patch,
    get,
    session,
    registry,
    messages,
    served,
    taskMode,
    acme,
    beta,
    bSession,
    dataDir,
    all,
    liveTurns: new LiveTurns({ file: join(dataDir, 'lt.json') }),
  }
}

const leaks = (text: string): string[] => MARKERS.filter((m) => text.includes(m))

describe('the project boundary — what builder (acme) is handed of zbeta', () => {
  it('told: the roster of both engines, the API roster, the inbox and the heartbeat facts carry nothing of zbeta', async () => {
    const w = await world()
    const seen: string[] = []
    // the system append's briefing + roster (hooks-off turns, OpenCode)
    seen.push(silosBriefing(w.registry.list(), 'builder', { withBearer: true, has: [], cwd: w.acme }))
    // the hook's renderer on the raw agents.json, and on the API's answer
    const raw = readFileSync(join(w.dataDir, 'agents.json'), 'utf8')
    seen.push(execFileSync('python3', [ROSTER_PY], { input: raw, env: { ...process.env, SILOS_AGENT_ID: 'builder' }, encoding: 'utf8' }))
    const roster = await w.get('/api/agents', 'builder')
    expect(roster.statusCode).toBe(200)
    seen.push(roster.body)
    expect(roster.json().agents.map((a: Json) => a.id)).toEqual(['builder', 'finance'])
    seen.push(execFileSync('python3', [ROSTER_PY], { input: roster.body, env: { ...process.env, SILOS_AGENT_ID: 'builder' }, encoding: 'utf8' }))
    // ?all=1 is the owner's
    seen.push((await w.get('/api/agents?all=1', 'builder')).body)
    // its inbox: the message from zbeta is held — finance's is served
    const inbox = await w.get('/api/agents/builder/messages?state=new', 'builder')
    expect(inbox.json().messages.map((m: Json) => m.from)).toEqual(['finance'])
    seen.push(inbox.body, (await w.get('/api/agents/builder/messages', 'builder')).body)
    seen.push(new MessageReads(w.served, w.liveTurns).inboxFor('builder', {}))
    // the asks it is shown, and the heartbeat's facts
    seen.push((await w.get('/api/agents/builder/asks', 'builder')).body)
    seen.push(
      JSON.stringify(
        heartbeatFacts(
          {
            messages: w.served,
            automations: { list: () => [], listRuns: () => [] },
            tasks: () => w.taskMode.tasks(),
            nameOf: (id) => w.registry.get(id)?.name ?? id,
            mayName: (r, id) => mayName(r, id, w.all()),
          },
          w.registry.get('builder')!,
          0,
          Date.now(),
        ),
      ),
    )
    seen.push((await w.get('/api/tasks/by-session', 'builder')).body)
    for (const s of seen) expect(leaks(s), s.slice(0, 400)).toEqual([])
    // the held message is untouched: unread, unmarked
    expect(w.messages.list('builder', 'new').some((m) => m.from === 'maker')).toBe(true)
    // the owner reads the whole inbox
    const owner = await app!.inject({ url: '/api/agents/builder/messages', headers: { ...LOCAL, 'x-token': 't0k' } })
    expect(owner.json().messages.length).toBe(2)
  })

  it('reach: every write at zbeta is refused exactly as one at a name that names nothing', async () => {
    const w = await world()
    const gone = join(base, 'zgone')
    // each pair: the request at zbeta, and the same request at nothing
    const pairs: Array<[string, Json, Json]> = [
      ['/api/agents/maker/messages', { text: 'hi' }, { text: 'hi' }],
      ['/api/tasks/claim', { plan: 'zplan', task: 'b1' }, { plan: 'zgone', task: 'b1' }],
      ['/api/tasks/claim', { key: `folder:${w.beta}/zplan/tasks/b1` }, { key: `folder:${gone}/zplan/tasks/b1` }],
      ['/api/tasks/release', { plan: 'zplan', task: 'b1', session: w.bSession }, { plan: 'zgone', task: 'b1', session: w.bSession }],
      ['/api/tasks/assign', { plan: 'zplan', task: 'b1' }, { plan: 'zgone', task: 'b1' }],
      ['/api/tasks/ask', { plan: 'zplan', task: 'b1', to: 'finance', action: 'x' }, { plan: 'zgone', task: 'b1', to: 'finance', action: 'x' }],
      ['/api/tasks/ask/answer', { plan: 'zplan', task: 'b1', text: 'x' }, { plan: 'zgone', task: 'b1', text: 'x' }],
      // an ask on its own task, to the other project's agent
      ['/api/tasks/ask', { plan: 'p', task: 'a1', to: 'maker', action: 'x' }, { plan: 'p', task: 'a1', to: 'nobody', action: 'x' }],
      // append into zbeta's plan — by its key, and through the folder that holds both projects
      [
        '/api/silos/plans/record/append',
        { key: `folder:${w.beta}/zplan/tasks/b1`, collection: 'notes', values: { text: 'x' } },
        { key: `folder:${gone}/zplan/tasks/b1`, collection: 'notes', values: { text: 'x' } },
      ],
      [
        '/api/silos/plans/record/append',
        { key: `folder:${w.beta}/zplan`, collection: 'tasks', values: { id: 'b9', title: 'x', owner: 'maker' } },
        { key: `folder:${gone}/zplan`, collection: 'tasks', values: { id: 'b9', title: 'x', owner: 'maker' } },
      ],
    ]
    const norm = (s: string): string =>
      s
        .split(w.beta)
        .join('<P>')
        .split(gone)
        .join('<P>')
        .split('zplan')
        .join('<plan>')
        .split('zgone')
        .join('<plan>')
        .split('maker')
        .join('<id>')
        .split('nobody')
        .join('<id>')
    for (const [url, at, none] of pairs) {
      const a = await w.post(url, at, 'builder')
      const b = await w.post(url, none, 'builder')
      expect(a.statusCode, `${url} ${JSON.stringify(at)}`).toBeGreaterThanOrEqual(400)
      expect([a.statusCode, norm(a.body)], `${url} ${JSON.stringify(at)}`).toEqual([b.statusCode, norm(b.body)])
      expect(leaks(a.body.split(w.beta).join('').split('zplan').join('')), url).toEqual([])
    }
    // nothing was written in zbeta's plan
    expect(JSON.parse(readFileSync(join(w.beta, 'plans', 'zplan.plan.json'), 'utf8')).tasks.every((x: Json) => x.notes === undefined)).toBe(true)
    // a held message is not builder's to mark either
    const held = w.messages.list('builder').find((m) => m.from === 'maker')!
    const r = await w.patch(`/api/agents/builder/messages/${held.id}`, { state: 'read' }, 'builder')
    expect([r.statusCode, r.json()]).toEqual([404, { error: 'message not found' }])
  })

  it('reflection: an id builder wrote in its own task comes back as written, never decorated', async () => {
    const w = await world()
    // a2 waits on maker (written by builder): asking on it names the wait as the id
    const ask = await w.post('/api/tasks/ask', { plan: 'p', task: 'a2', to: 'finance', action: 'check' }, 'builder')
    expect(ask.json().error).toContain('waits on maker already')
    // a3 lists a zbeta conversation, live: the claim's 409 says it is live, nothing of it
    const claim = await w.post('/api/tasks/claim', { plan: 'p', task: 'a3', session: await w.session('builder', w.acme, 'mine') }, 'builder')
    expect(claim.statusCode).toBe(409)
    // a5 is owned by maker, in acme's plan: «not an agent here», no name, no door to it
    const assign = await w.post('/api/tasks/assign', { plan: 'p', task: 'a5' }, 'builder')
    expect(assign.statusCode).toBe(403)
    const claim5 = await w.post('/api/tasks/claim', { plan: 'p', task: 'a5' }, 'builder')
    expect(claim5.json().error).toContain('not an agent here')
    expect(claim5.json().error).not.toContain('/messages')
    for (const r of [ask, claim, assign, claim5]) expect(leaks(r.body), r.body).toEqual([])
    // the heartbeat's wait line names the id as written
    const facts = heartbeatFacts(
      {
        messages: w.served,
        automations: { list: () => [], listRuns: () => [] },
        tasks: () => w.taskMode.tasks(),
        nameOf: (id) => w.registry.get(id)?.name ?? id,
        mayName: (r, id) => mayName(r, id, w.all()),
      },
      w.registry.get('builder')!,
      0,
      Date.now(),
    )
    expect(facts.waits.map((x) => x.who)).toEqual(['maker'])
  })

  it("acts (R3): acme's task written as maker's is never moved for maker — no wake, no packet line, no door", async () => {
    const w = await world()
    const tasks = w.taskMode.tasks()
    const a5 = tasks.find((x) => x.id === 'a5')!
    expect(a5.ownerOutside).toBe(true)
    expect(tasks.filter((x) => x.ownerOutside).map((x) => x.id)).toEqual(['a5'])
    // the owner's Give and the door refuse it with the way out
    expect(w.taskMode.assign(a5.key, Date.now(), { ownerGesture: true })).toMatchObject({
      queued: false,
      why: expect.stringContaining("does not work in this task's project"),
    })
    expect(await w.taskMode.openTalk(a5.key)).toMatchObject({ ok: false, code: 409 })
    // the page is told so: no door to offer, «Give to…» the only move
    expect(w.taskMode.view(a5.key)?.ownerOutside).toBe(true)
    expect(w.taskMode.view(tasks.find((x) => x.id !== 'a5')!.key)?.ownerOutside).toBeUndefined()
    // maker's packet never lists it (its key is acme's path), whatever its state
    const waiting = () => w.taskMode.tasks().map((x) => (x.id === 'a5' ? { ...x, state: 'blocked', waitingFor: { owner: 'finance', action: 'x' } } : x))
    const facts = (tasks: () => ReturnType<typeof waiting>) =>
      heartbeatFacts({ automations: { list: () => [], listRuns: () => [] }, tasks, nameOf: (id) => id }, w.registry.get('maker')!, 0, Date.now())
    expect(facts(waiting).waits).toEqual([])
    expect(facts(() => waiting().map((x) => ({ ...x, ownerOutside: false }))).waits.map((x) => x.ref)).toEqual(['p#a5'])
    expect(JSON.stringify(facts(waiting))).not.toContain(w.acme)
  })

  it('inside its project everything still reaches: message, ask, claim, append; the owner reaches across', async () => {
    const w = await world()
    expect((await w.post('/api/agents/finance/messages', { text: 'hi' }, 'builder')).statusCode).toBe(201)
    expect((await w.post('/api/tasks/ask', { plan: 'p', task: 'a1', to: 'finance', action: 'review' }, 'builder')).statusCode).toBe(200)
    expect(
      (await w.post('/api/silos/plans/record/append', { key: `folder:${w.acme}/p/tasks/a4`, collection: 'notes', values: { text: 'seen' } }, 'builder'))
        .statusCode,
    ).toBe(200)
    // the owner's credential messages across projects
    const owner = await app!.inject({
      method: 'POST',
      url: '/api/agents/maker/messages',
      headers: { ...LOCAL, 'x-token': 't0k' },
      payload: { text: 'from you' },
    })
    expect(owner.statusCode).toBe(201)
    // and a message from finance served, maker's held, until they share a project
    w.registry.update('maker', { folders: [join(w.acme, 'lab')] } as never)
    const inbox = await w.get('/api/agents/builder/messages?state=new', 'builder')
    expect(
      inbox
        .json()
        .messages.map((m: Json) => m.from)
        .sort(),
    ).toEqual(['finance', 'maker'])
  })
})

// Every GET a bearer may read, with the bound it is served with — the
// route table of agentMayRead. A route outside it is refused.
describe('the bearer read list', () => {
  const allowed: Array<[string, string]> = [
    ['/api/agents', 'itself + the agents of its projects (roster rows)'],
    ['/api/agents/builder/messages', 'its inbox, servable only'],
    ['/api/agents/builder/messages/sent', 'what it sent'],
    ['/api/agents/builder/asks', 'the asks of its projects'],
    ['/api/agents/builder/vault', 'the entries that reach it; a shared one says «shared»'],
    ['/api/automations', 'its own'],
    ['/api/automations/pending', 'its own'],
    ['/api/automations/a1', 'its own'],
    ['/api/automations/a1/runs', 'its own'],
    ['/api/automations/templates', 'the built-in ones'],
    ['/api/automations/templates/t1', 'the built-in ones'],
    ['/api/automations/templates/t1/file', 'the built-in ones'],
    ['/api/tasks/by-session', 'its own conversations'],
    ['/api/sessions/f/s1/tasks', "its own conversations (another's answers as none)"],
    ['/api/silos/plans/agents/builder/merged', 'its projects'],
    ['/api/silos/plans/agents/builder/proposals', 'its projects'],
  ]
  it.each(allowed)('%s — %s', (url) => {
    expect(agentMayRead('builder', url)).toBe(true)
  })
  const refused = [
    '/api/agents/builder',
    '/api/agents/builder/territory',
    '/api/agents/builder/complete',
    '/api/agents/builder/output-styles',
    '/api/agents/builder/loaded',
    '/api/agents/builder/started-with',
    '/api/agents/builder/context',
    '/api/agents/builder/tools',
    '/api/agents/finance/messages',
    '/api/agents/finance/asks',
    '/api/automations/a1/runs/r1/log',
    '/api/board',
    '/api/projects',
    '/api/vault',
    '/api/proposals',
    '/api/territory',
    '/api/prefs',
    '/api/file?path=/home/user/x',
    '/api/tasks/feed',
  ]
  it.each(refused)("%s — the owner's", (url) => {
    expect(agentMayRead('builder', url)).toBe(false)
  })
})
