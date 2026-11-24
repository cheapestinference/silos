// task-claim-route.test.ts — the claim and release verbs (POST
// /api/tasks/claim and /api/tasks/release) over the real server, the real plans kernel on the
// REFERENCE manifest and a real session index (nothing is spawned, no claude
// ever runs — the console command is a stub). A claim links the conversation
// and sets in_progress in one write and answers with the briefing; another
// LIVE conversation of the task's thread refuses it with an explained 409,
// `takeover` passes with a hand-over note Silos writes; with an agent bearer
// the task and the session must be the agent's (403 otherwise); without one
// it is trusted, like the owner's curl; a stale conversation never blocks.
// Then: the claim's identity (R3), authorship and warnings (R4), the wakes a
// claim folds in, the release and what it makes history (R13), the
// session→tasks routes and the agent allow-lists, and the door's one rule
// (R5: a run is read, never opened over). Generic fixtures only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { agentMayRead, agentMayWrite } from '../src/agent-authz.js'
import type { SessionMeta } from '../src/types.js'
import { asOwner } from './helpers/owner.js'
import { bearerWritesCarryTurns } from './helpers/live-turn.js'

type Json = Record<string, any>
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json')
const LOCAL = { host: '127.0.0.1:3210' }
const socket = `silos-taskclaim-${process.pid}`

let base: string
let app: FastifyInstance | undefined
let terminals: TerminalService | undefined
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-claim-'))
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

const t = (id: string, over: Json = {}): Json => ({ id, title: `Task ${id}`, owner: 'writer', status: 'pending', dependsOn: [], ...over })

async function world(tasks: Json[], opts: { manifest?: (m: Json) => void; bound?: string[]; runs?: Record<string, 'automation' | 'nested'> } = {}) {
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  const proj = join(base, 'proj')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const f = join(proj, 'plans', 'p.plan.json')
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ title: 'P', tasks }, null, 2))
  const manifest = JSON.parse(readFileSync(REF, 'utf8')) as Json
  opts.manifest?.(manifest)
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(manifest))
  const siloRegistry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  siloRegistry.load()
  const isAgent = (v: string): boolean => v === 'writer' || v === 'ops'
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
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder: proj })
  registry.create({ id: 'ops', name: 'Ops', folder: proj })
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
  const taskMode = new TaskModeEngine({
    store,
    plans: () => {
      const reading = kernel.reading('plans')
      return reading ? { reading } : null
    },
    bound: () => new Set(opts.bound ?? []),
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    conversationOf: (a, ids) => threads().tipOf(a, ids),
    holdersOf: (a, ids) => threads().holdersOf(a, ids),
    busyWhy: () => null,
    ready: () => true,
    send: () => {
      throw new Error('no turns in this test')
    },
    currentOf: (l, r) => threads().currentOf(l, r),
  })
  const runs = opts.runs ?? {}
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
    // a run's transcript (an automation's, a nested `claude -p`): read, never opened
    transcriptOnly: (m) =>
      runs[m.id] === 'automation'
        ? { error: 'an automation run — read its transcript', automationId: 'a1', runId: 'r1' }
        : runs[m.id] === 'nested'
          ? { error: 'nested run', nested: true, parent: null, agentId: 'writer' }
          : null,
  })
  bearerWritesCarryTurns(app, chat, agentTokens)
  asOwner(app, 't0k')
  const mf = mungePath(proj)
  // a conversation of `agent` whose last message is `agoMs` old
  const session = async (agent: string, agoMs: number, id = randomUUID()): Promise<string> => {
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
  const key = (id: string): string => `folder:${proj}/p/tasks/${id}`
  const file = (): Json => JSON.parse(readFileSync(f, 'utf8'))
  const bearer = (agent?: string): Json => (agent ? { authorization: `Bearer ${agentTokens.tokenFor(agent)}` } : {})
  const post = (url: string, payload: Json, agent?: string, headers: Json = {}) => {
    kernel.refresh()
    return app!.inject({ method: 'POST', url, headers: { ...LOCAL, ...bearer(agent), ...headers }, payload })
  }
  const get = (url: string, agent?: string) => {
    kernel.refresh()
    return app!.inject({ method: 'GET', url, headers: { ...LOCAL, ...bearer(agent) } })
  }
  const claim = (payload: Json, agent?: string, headers: Json = {}) => post('/api/tasks/claim', payload, agent, headers)
  const release = (payload: Json, agent?: string, headers: Json = {}) => post('/api/tasks/release', payload, agent, headers)
  return { claim, release, get, post, session, key, file, f, chat, events, siloActions, store, proj, mf, dataDir, lineage, terminals: terminals!, index }
}

describe('POST /api/tasks/claim', () => {
  it('links the conversation AND sets in_progress in one write; answers with the briefing', async () => {
    const w = await world([t('t1', { notes: [{ at: '2026-11-08T10:00:00Z', by: 'owner', text: 'check the log first' }] })])
    const a = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: a }, 'writer')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ ok: true, ref: 'p#t1', state: 'in_progress', session: a, linked: true, tookOver: false, others: [] })
    expect(body.briefing).toContain('You claimed ONE task — p#t1 «Task t1»')
    expect(body.briefing).toContain('check the log first')
    expect(w.file().tasks[0]).toMatchObject({ status: 'in_progress', conversations: [a] })
    // said in the record's story, by the agent
    expect(w.events.list('plans', w.key('t1')).map((e) => [e.verb, e.by])).toEqual([
      ['append-item', 'writer'],
      ['set-field', 'writer'],
    ])
    // claiming again from the same conversation: nothing to change, still yes
    const again = await w.claim({ key: w.key('t1'), session: a }, 'writer')
    expect(again.statusCode).toBe(200)
    expect(w.file().tasks[0].conversations).toEqual([a])
  })

  it('a second claim while another conversation of the task is live → 409 saying who and how long ago; nothing written', async () => {
    const w = await world([t('t1')])
    const a = await w.session('writer', 2 * 60_000)
    expect((await w.claim({ key: w.key('t1'), session: a })).statusCode).toBe(200)
    const b = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: b })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toMatch(/^Writer's conversation «work for writer» \(2 min ago\) is working p#t1 — don't start it here/)
    expect(body.live).toEqual([expect.objectContaining({ sessionId: a, agent: 'writer', running: false, live: true })])
    expect(w.file().tasks[0].conversations).toEqual([a])
  })

  it('a turn running in the other conversation refuses too, however old its transcript', async () => {
    const w = await world([t('t1')])
    const a = await w.session('writer', 3 * 3600_000)
    expect((await w.claim({ key: w.key('t1'), session: a })).statusCode).toBe(200)
    w.chat.isSessionActive = (s: string) => s === a
    const b = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: b })
    expect(res.statusCode).toBe(409)
    expect(res.json().live[0]).toMatchObject({ sessionId: a, running: true })
  })

  it('takeover: true passes — linked, in_progress, and Silos writes the hand-over note', async () => {
    const w = await world([t('t1')])
    const a = await w.session('writer', 60_000)
    expect((await w.claim({ key: w.key('t1'), session: a })).statusCode).toBe(200)
    const b = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: b, takeover: true }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ tookOver: true, linked: true })
    expect(res.json().briefing).toContain("You took it over from: Writer's conversation «work for writer»")
    const task = w.file().tasks[0]
    expect(task).toMatchObject({ status: 'in_progress', conversations: [a, b] })
    expect(task.notes).toHaveLength(1)
    expect(task.notes[0]).toMatchObject({ by: 'Silos' })
    expect(task.notes[0].text).toContain(`Taken over by Writer in conversation ${b} from Writer's conversation «work for writer»`)
    expect(task.notes[0].text).toContain(a)
  })

  it('stale (moved > 10 min ago, no turn running): the claim goes in and says who else worked it', async () => {
    const w = await world([t('t1', { status: 'in_progress' })])
    const a = await w.session('ops', 30 * 60_000)
    expect((await w.claim({ key: w.key('t1'), session: a })).statusCode).toBe(200)
    const b = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: b }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(res.json().others).toEqual([expect.objectContaining({ sessionId: a, agent: 'ops', live: false })])
    expect(res.json().briefing).toContain("Also worked by: Ops's conversation «work for ops» (30 min ago)")
    expect(w.file().tasks[0].conversations).toEqual([a, b])
    expect(w.file().tasks[0].notes ?? []).toEqual([])
  })

  it("an agent bearer may not claim another agent's task → 403 «message its owner»", async () => {
    const w = await world([t('t1')])
    const a = await w.session('ops', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: a }, 'ops')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: "p#t1 is Writer's task, not yours — message its owner instead (POST /api/agents/writer/messages)", owner: 'writer' })
    expect(w.file().tasks[0]).toMatchObject({ status: 'pending' })
    expect(w.file().tasks[0].conversations).toBeUndefined()
  })

  it('an agent bearer naming a session that is not its own → 403 (spoofed $SILOS_SESSION_ID)', async () => {
    const w = await world([t('t1')])
    const theirs = await w.session('ops', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: theirs }, 'writer')
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe(`conversation ${theirs} is not one of yours — claim with your own $SILOS_SESSION_ID`)
    expect(w.file().tasks[0].conversations).toBeUndefined()
  })

  it('a console Silos just launched for the agent (not indexed yet) is its own', async () => {
    const w = await world([t('t1')])
    const key = randomUUID()
    mkdirSync(join(w.dataDir, 'consoles'), { recursive: true })
    writeFileSync(join(w.dataDir, 'consoles', `${key}.json`), JSON.stringify({ key, agentId: 'writer', harness: 'claude-code', createdMs: Date.now() }))
    const res = await w.claim({ key: w.key('t1'), session: key }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(w.file().tasks[0].conversations).toEqual([key])
  })

  it('without a bearer (the owner, a local curl) it is trusted: any task, any session', async () => {
    const w = await world([t('t1', { owner: 'sam' })])
    const a = await w.session('ops', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: a })
    expect(res.statusCode).toBe(200)
    expect(w.file().tasks[0]).toMatchObject({ status: 'in_progress', conversations: [a] })
  })

  it('names the task by plan + task (+ folder, a worktree reads as its main checkout); refuses a done task and bad input', async () => {
    const w = await world([t('t1'), t('t2', { status: 'done' })])
    const a = await w.session('writer', 1_000)
    const res = await w.claim({ plan: 'p', task: 't1', folder: w.proj, session: a }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(res.json().key).toBe(w.key('t1'))
    expect((await w.claim({ plan: 'p', task: 't9' })).statusCode).toBe(404)
    const done = await w.claim({ plan: 'p', task: 't2', session: a }, 'writer')
    expect(done.statusCode).toBe(409)
    expect(done.json().error).toBe('p#t2 is done — more work on it is a new task (or the owner reopens it)')
    expect((await w.claim({})).statusCode).toBe(400)
    expect((await w.claim({ key: w.key('t1'), session: '../../etc' })).statusCode).toBe(400)
    expect((await w.claim({ key: w.key('t1'), takeover: 'yes' })).statusCode).toBe(400)
  })

  it('a task written a moment ago (the file watch has not re-read it yet) is found', async () => {
    const w = await world([t('t1')])
    writeFileSync(w.f, JSON.stringify({ title: 'P', tasks: [t('t1'), t('t2')] }, null, 2))
    const res = await w.claim({ plan: 'p', task: 't2' }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(w.file().tasks[1].status).toBe('in_progress')
  })

  it('without a session: in_progress only, nothing linked', async () => {
    const w = await world([t('t1')])
    const res = await w.claim({ key: w.key('t1') }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ linked: false, session: null })
    expect(w.file().tasks[0].status).toBe('in_progress')
    expect(w.file().tasks[0].conversations).toBeUndefined()
  })

  it('the agent allow-list opens exactly POST /api/tasks/claim', () => {
    expect(agentMayWrite('writer', 'POST', '/api/tasks/claim')).toBe(true)
    expect(agentMayWrite('writer', 'POST', '/api/tasks/%63laim')).toBe(true)
    expect(agentMayWrite('writer', 'POST', '/api/tasks/work')).toBe(false)
    expect(agentMayWrite('writer', 'POST', '/api/tasks/talk')).toBe(false)
    expect(agentMayWrite('writer', 'PUT', '/api/tasks/claim')).toBe(false)
  })
})

describe("siloActions.linkAndSet — the claim's one write", () => {
  it('a stale version (CAS) writes neither half', async () => {
    const w = await world([t('t1')])
    const r = w.siloActions.linkAndSet('plans', w.key('t1'), 'conversations', 'aaaaaaaa-0001', 'status', 'in_progress', { version: 'not-the-file' })
    expect(r.ok).toBe(false)
    expect(w.file().tasks[0]).toMatchObject({ status: 'pending' })
    expect(w.file().tasks[0].conversations).toBeUndefined()
  })
  it("keeps the list's shape (strings stay strings, objects get objects) and refuses a field the owner may not set", async () => {
    const w = await world([t('t1', { conversations: [{ session: 'aaaaaaaa-0001' }] }), t('t2', { conversations: ['aaaaaaaa-0001'] })])
    expect(w.siloActions.linkAndSet('plans', w.key('t1'), 'conversations', 'bbbbbbbb-0002', 'status', 'in_progress').ok).toBe(true)
    expect(w.siloActions.linkAndSet('plans', w.key('t2'), 'conversations', 'bbbbbbbb-0002', 'status', 'in_progress').ok).toBe(true)
    expect(w.file().tasks[0].conversations).toEqual([{ session: 'aaaaaaaa-0001' }, { session: 'bbbbbbbb-0002' }])
    expect(w.file().tasks[1].conversations).toEqual(['aaaaaaaa-0001', 'bbbbbbbb-0002'])
    // plans 0.5.1 declares `claim`: the fields come from its `set` — a field
    // the caller names is never written (the claim sets status, nothing else)
    expect(w.siloActions.linkAndSet('plans', w.key('t1'), 'conversations', 'cccccccc-0003', 'owner', 'ops').ok).toBe(true)
    expect(w.file().tasks[0]).toMatchObject({ owner: 'writer', status: 'in_progress' })
    expect(w.file().tasks[0].conversations).toHaveLength(3)
  })
})

describe('POST /api/tasks/claim — who the conversation is (R3)', () => {
  it('a session Silos does not know: 200 linked:false with why, in_progress, the link unwritten — with and without a bearer', async () => {
    const w = await world([t('t1'), t('t2')])
    for (const [id, agent] of [
      ['t1', undefined],
      ['t2', 'writer'],
    ] as const) {
      const res = await w.claim({ key: w.key(id), session: randomUUID() }, agent)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        ok: true,
        linked: false,
        why: "this conversation isn't known to Silos yet (claude -c / --resume without an id gives the startup id) — the task is in_progress; link it from ⌘K",
      })
    }
    expect(w.file().tasks.map((x: Json) => [x.status, x.conversations])).toEqual([
      ['in_progress', undefined],
      ['in_progress', undefined],
    ])
  })
  it('an OpenCode console key whose id is sealed is stored as the ses_…', async () => {
    const w = await world([t('t1')])
    const k = 'consolekey-0001'
    mkdirSync(join(w.dataDir, 'consoles'), { recursive: true })
    writeFileSync(join(w.dataDir, 'consoles', `${k}.json`), JSON.stringify({ key: k, agentId: 'writer', harness: 'opencode', createdMs: Date.now() }))
    w.terminals.bindNativeId(k, 'ses_sealed0001')
    const res = await w.claim({ key: w.key('t1'), session: k }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ linked: true, session: 'ses_sealed0001' })
    expect(w.file().tasks[0].conversations).toEqual(['ses_sealed0001'])
  })
})

describe('POST /api/tasks/claim — authorship and warnings (R4)', () => {
  it('without a bearer, a valid X-Silos-Agent names the author (journal + warning); an invalid one is the owner', async () => {
    const w = await world([t('t1'), t('t2')])
    const a = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: a }, undefined, { 'x-silos-agent': 'ops' })
    expect(res.statusCode).toBe(200)
    expect(res.json().warn).toBe("you (Ops) claimed Writer's task — Writer is still its owner")
    expect(w.events.list('plans', w.key('t1')).map((e) => e.by)).toEqual(['ops', 'ops'])
    const b = await w.session('writer', 1_000)
    const res2 = await w.claim({ key: w.key('t2'), session: b }, undefined, { 'x-silos-agent': 'ghost' })
    expect(res2.json().warn).toBeUndefined()
    expect(w.events.list('plans', w.key('t2')).map((e) => e.by)).toEqual(['owner', 'owner'])
  })
  it('the header never grants: a bearer of another agent stays 403 whatever it names', async () => {
    const w = await world([t('t1')])
    const a = await w.session('ops', 1_000)
    expect((await w.claim({ key: w.key('t1'), session: a }, 'ops', { 'x-silos-agent': 'writer' })).statusCode).toBe(403)
  })
  it('a blocked task: the claim links the conversation and leaves it blocked (keep), saying so — linked or not', async () => {
    const w = await world([t('t0'), t('t1', { status: 'blocked', dependsOn: ['t0'] }), t('t2', { status: 'blocked', dependsOn: ['t0'] })])
    const mine = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: mine }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ linked: true, state: 'blocked', warn: expect.stringContaining('stays blocked') })
    const unknown = await w.claim({ key: w.key('t2'), session: randomUUID() }, 'writer')
    expect(unknown.json()).toMatchObject({ linked: false, state: 'blocked' })
    const tasks = w.file().tasks
    expect(tasks[1].status).toBe('blocked')
    expect(tasks[1].conversations).toEqual([mine])
    expect(tasks[2].status).toBe('blocked')
  })

  it('keep holds only while the task really waits (G7): a blocked task whose dependencies are all done is claimed — in progress, no warning', async () => {
    const w = await world([
      t('t0', { status: 'done' }),
      t('t1', { status: 'blocked', dependsOn: ['t0'] }),
      t('t2', { status: 'blocked', dependsOn: ['t0'] }),
      t('t3', { status: 'blocked' }),
    ])
    const mine = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: mine }, 'writer')
    expect(res.json()).toMatchObject({ linked: true, state: 'in_progress' })
    expect(res.json().warn).toBeUndefined()
    expect(res.json().briefing).toContain('It is in progress and this conversation is linked to it')
    // not linked: the same rule
    expect((await w.claim({ key: w.key('t2'), session: randomUUID() }, 'writer')).json()).toMatchObject({ linked: false, state: 'in_progress' })
    // blocked naming nothing it waits on: claimed too
    expect((await w.claim({ key: w.key('t3') }, 'writer')).json()).toMatchObject({ state: 'in_progress' })
    expect(w.file().tasks.map((x: Json) => x.status)).toEqual(['done', 'in_progress', 'in_progress', 'in_progress'])
  })
  it('a blocked task waiting on someone (waitingOn) or on a dependency not done stays blocked — the warning and the briefing say on what', async () => {
    const w = await world([
      t('t0'),
      t('t1', { status: 'blocked', waitingOn: { owner: 'owner', action: 'approve the budget' } }),
      t('t2', { status: 'blocked', dependsOn: ['t0', 'gone'] }),
    ])
    const a = await w.session('writer', 1_000)
    const r1 = (await w.claim({ key: w.key('t1'), session: a }, 'writer')).json()
    expect(r1).toMatchObject({
      linked: true,
      state: 'blocked',
      warn: 'p#t1 stays blocked — it still waits on owner (approve the budget); work toward that, or change what it waits on, then set its status',
    })
    expect(r1.briefing).toContain('It stays blocked (what it waits on is still open) and this conversation is linked to it')
    const b = await w.session('writer', 1_000)
    expect((await w.claim({ key: w.key('t2'), session: b }, 'writer')).json().warn).toContain('it still waits on t0, gone')
    expect(w.file().tasks.map((x: Json) => x.status)).toEqual(['pending', 'blocked', 'blocked'])
  })

  it('a conversation of another agent, claimed by the owner: linked, with the warning', async () => {
    const w = await world([t('t1')])
    const a = await w.session('ops', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: a })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ linked: true, warn: "this conversation is Ops's, not Writer's — it's linked, but Writer's door and wakes won't see it" })
  })
  it("the owner's own task, worked in an agent's conversation: linked, no warning (no door or wakes to miss)", async () => {
    const w = await world([{ ...t('t1'), owner: 'owner' }])
    const a = await w.session('ops', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: a })
    expect(res.statusCode).toBe(200)
    expect(res.json().linked).toBe(true)
    expect(res.json().warn).toBeUndefined()
  })
  it('the wakes that waited for a bound owner reach it in the claim (via: claim)', async () => {
    const w = await world([t('t1')], { bound: ['writer'] })
    w.store.update((s) => {
      s.wakes.push({
        id: 'w1',
        agent: 'writer',
        task: w.key('t1'),
        ref: 'p#t1',
        title: 'Task t1',
        reason: 'owner-note',
        says: 'a note from the owner',
        at: '2026-11-08T09:00:00.000Z',
        state: 'queued',
        notes: [{ at: '2026-11-08T09:00:00Z', by: 'owner', text: 'check the log first' }],
        bypassThrottle: true,
      })
    })
    const a = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: a }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(res.json().briefing).toContain('Waiting for you on it: a note from the owner.')
    expect(res.json().briefing).toContain('check the log first')
    expect(res.json().briefing.split('\n').at(-1)).toBe('Leave the task with an explicit disposition (your task-mode protocol).')
    expect(w.store.wakes()[0]).toMatchObject({ state: 'delivered', via: 'claim', session: a })
  })
  it("an unbound owner's claim says the dispositions in its last line", async () => {
    const w = await world([t('t1')])
    const a = await w.session('writer', 1_000)
    const res = await w.claim({ key: w.key('t1'), session: a }, 'writer')
    expect(res.json().briefing.split('\n').at(-1)).toMatch(/^Leave the task with an explicit disposition: done \(finished and verified\)/)
  })
})

describe('POST /api/tasks/release (R13)', () => {
  it('release → history: no tip, holder or live; the header says current:false, the sidebar no ☑; it stays listed', async () => {
    const w = await world([t('t1')])
    const a = await w.session('writer', 30 * 60_000)
    expect((await w.claim({ key: w.key('t1'), session: a }, 'writer')).statusCode).toBe(200)
    expect((await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/${a}/tasks`)).json().tasks).toEqual([
      expect.objectContaining({ ref: 'p#t1', current: true, file: expect.stringMatching(/\/plans\/p\.plan\.json$/) }),
    ])
    expect((await w.get(`/api/tasks/mode?key=${encodeURIComponent(w.key('t1'))}`)).json().door.thread).toMatchObject({ sessionId: a })
    const res = await w.release({ plan: 'p', task: 't1', session: a }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, released: true, written: true, session: a })
    const t1 = w.file().tasks[0]
    expect(t1.conversations).toEqual([a])
    // plans 0.5.2 (E4): the last current thread let go leaves it to pick up
    expect(t1.status).toBe('pending')
    expect((await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/${a}/tasks`)).json().tasks).toEqual([
      expect.objectContaining({ ref: 'p#t1', current: false }),
    ])
    expect((await w.get('/api/tasks/by-session')).json()).toEqual({})
    expect((await w.get(`/api/tasks/mode?key=${encodeURIComponent(w.key('t1'))}`)).json().door.thread).toBeNull()
    // a second claim of the task by another conversation: the released one does not refuse it
    const b = await w.session('writer', 1_000)
    expect((await w.claim({ key: w.key('t1'), session: b }, 'writer')).json().others).toEqual([])
  })
  it('release → claim with the same id → current, in one write; release → claim → release inside two minutes → history', async () => {
    const w = await world([t('t1')])
    const a = await w.session('writer', 1_000)
    await w.claim({ key: w.key('t1'), session: a }, 'writer')
    await w.release({ key: w.key('t1'), session: a }, 'writer')
    expect((await w.claim({ key: w.key('t1'), session: a }, 'writer')).json()).toMatchObject({ linked: true })
    expect(w.file().tasks[0].conversations).toEqual([a])
    expect(w.file().tasks[0].releases.map((x: Json) => x.released)).toEqual([true, false])
    expect((await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/${a}/tasks`)).json().tasks[0].current).toBe(true)
    await w.release({ key: w.key('t1'), session: a }, 'writer')
    expect(w.file().tasks[0].releases.map((x: Json) => x.released)).toEqual([true, false, true])
    expect((await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/${a}/tasks`)).json().tasks[0].current).toBe(false)
  })
  it('/clear: the rotation stays current; a release named by an unlisted rotation id lets the listed thread go', async () => {
    const w = await world([t('t1')])
    const anc = await w.session('writer', 10 * 60_000)
    const tip = await w.session('writer', 1_000)
    w.lineage.record(`${w.mf}/${tip}`, `${w.mf}/${anc}`)
    await w.claim({ key: w.key('t1'), session: anc }, 'writer')
    expect((await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/${tip}/tasks`)).json().tasks).toEqual([expect.objectContaining({ current: true })])
    const res = await w.release({ key: w.key('t1'), session: tip }, 'writer')
    expect(res.statusCode).toBe(200)
    expect(w.file().tasks[0].conversations).toEqual([anc])
    expect((await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/${anc}/tasks`)).json().tasks[0].current).toBe(false)
  })
  it("refusals: not on the task → 409, nothing written; another agent's task → 403", async () => {
    const w = await world([t('t1', { conversations: [] })])
    const a = await w.session('writer', 1_000)
    const res = await w.release({ key: w.key('t1'), session: a }, 'writer')
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'this conversation is not on p#t1 — nothing to release' })
    expect(w.file().tasks[0].releases).toBeUndefined()
    expect((await w.release({ key: w.key('t1'), session: a }, 'ops')).statusCode).toBe(403)
    expect((await w.release({ key: w.key('t1') })).statusCode).toBe(400)
  })
  it('a Plans without the release verb → 501', async () => {
    const old = await world([t('t1', { conversations: ['aaaaaaaa-0001'] })], {
      manifest: (m) => {
        m.spec.actions = m.spec.actions.filter((x: Json) => x.verb !== 'release')
      },
    })
    const r501 = await old.release({ key: old.key('t1'), session: 'aaaaaaaa-0001' })
    expect(r501.statusCode).toBe(501)
    expect(r501.json()).toEqual({ error: 'this Plans has no release — update it' })
  })
})

describe('the session → tasks routes (session-tasks.ts) and the agent allow-lists', () => {
  it("by-session?session= is GET /api/sessions/:f/:id/tasks; without a parameter, every conversation on an open task's current thread", async () => {
    const w = await world([t('t1'), t('t2', { status: 'done' })])
    const a = await w.session('writer', 1_000)
    await w.claim({ key: w.key('t1'), session: a }, 'writer')
    // t2 is done: listed by hand, history for the sidebar, still in the header
    const file = w.file()
    file.tasks[1].conversations = [a]
    writeFileSync(w.f, JSON.stringify(file))
    const header = (await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/${a}/tasks`)).json().tasks
    expect(header.map((x: Json) => x.ref)).toEqual(['p#t1', 'p#t2'])
    expect((await w.get(`/api/tasks/by-session?session=${a}`)).json()).toEqual({ [a]: header })
    expect((await w.get('/api/tasks/by-session')).json()).toEqual({
      [a]: [{ key: w.key('t1'), ref: 'p#t1', title: 'Task t1', state: 'in_progress', current: true, file: w.f }],
    })
    // an id the index does not hold: {} (the hook stays quiet); the header route 404s
    expect((await w.get(`/api/tasks/by-session?session=${randomUUID()}`)).json()).toEqual({})
  })
  it("a bearer of A sees only its own conversations; another's answers as none: 404 (header) or nothing (by-session)", async () => {
    const w = await world([t('t1'), t('t2', { owner: 'ops' })])
    const a = await w.session('writer', 1_000)
    const b = await w.session('ops', 1_000)
    await w.claim({ key: w.key('t1'), session: a }, 'writer')
    await w.claim({ key: w.key('t2'), session: b }, 'ops')
    expect((await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/${a}/tasks`, 'writer')).statusCode).toBe(200)
    const other = await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/${b}/tasks`, 'writer')
    const none = await w.get(`/api/sessions/${encodeURIComponent(w.mf)}/no-such-id/tasks`, 'writer')
    expect(other.statusCode).toBe(404)
    expect(other.json()).toEqual(none.json())
    expect(Object.keys((await w.get('/api/tasks/by-session', 'writer')).json())).toEqual([a])
    expect((await w.get(`/api/tasks/by-session?session=${b}`, 'writer')).json()).toEqual({})
    expect(Object.keys((await w.get('/api/tasks/by-session')).json()).sort()).toEqual([a, b].sort())
  })
  it('agent-authz: release is writable, the two session → tasks reads are readable', () => {
    expect(agentMayWrite('writer', 'POST', '/api/tasks/release')).toBe(true)
    expect(agentMayWrite('writer', 'POST', '/api/tasks/%72elease')).toBe(true)
    expect(agentMayWrite('writer', 'PUT', '/api/tasks/release')).toBe(false)
    expect(agentMayRead('writer', '/api/tasks/by-session?session=x')).toBe(true)
    expect(agentMayRead('writer', '/api/sessions/f/x/tasks')).toBe(true)
    expect(agentMayRead('writer', '/api/sessions/f/x')).toBe(false)
    expect(agentMayRead('writer', '/api/tasks/feed')).toBe(false)
  })
})

describe('the door: one rule, the continuable tip (R5)', () => {
  it('6 · a run claims and the door does not resume it', async () => {
    const run = randomUUID()
    const w = await world([t('t1')], { runs: { [run]: 'automation' } })
    await w.session('writer', 1_000, run)
    expect((await w.claim({ key: w.key('t1'), session: run }, 'writer')).json()).toMatchObject({ linked: true })
    expect((await w.get(`/api/tasks/mode?key=${encodeURIComponent(w.key('t1'))}`)).json().door).toMatchObject({ thread: null, running: null })
  })
  it('7 · a run working the task: /work answers 409 readOnly «read it»; the door says so', async () => {
    const run = randomUUID()
    const w = await world([t('t1')], { runs: { [run]: 'nested' } })
    await w.session('writer', 1_000, run)
    await w.claim({ key: w.key('t1'), session: run }, 'writer')
    w.chat.isSessionActive = (s: string) => s === run
    const res = await w.post('/api/tasks/work', { key: w.key('t1') })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ readOnly: true, error: 'a nested run of Writer is working this task — read it', sessionId: run, folder: w.mf })
    expect((await w.get(`/api/tasks/mode?key=${encodeURIComponent(w.key('t1'))}`)).json().door.running).toMatchObject({ sessionId: run, readOnly: true })
  })
  it("/work over a listed ancestor resumes the thread's tip", async () => {
    const w = await world([t('t1')])
    const anc = await w.session('writer', 10 * 60_000)
    const tip = await w.session('writer', 1_000)
    w.lineage.record(`${w.mf}/${tip}`, `${w.mf}/${anc}`)
    await w.claim({ key: w.key('t1'), session: anc }, 'writer')
    const res = await w.post('/api/tasks/work', { key: w.key('t1') })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ mode: 'resumed', sessionId: tip })
  })
})

describe('TerminalService native-bound — only a NEW pair with key ≠ id', () => {
  it('emits once; never for bindNativeId(id, id) nor a re-bind of the same pair', async () => {
    const w = await world([t('t1')])
    const seen: Array<[string, string]> = []
    w.terminals.on('native-bound', (k: string, id: string) => seen.push([k, id]))
    w.terminals.bindNativeId('key-0001', 'ses_0001')
    w.terminals.bindNativeId('key-0001', 'ses_0001')
    w.terminals.bindNativeId('ses_0002', 'ses_0002')
    expect(seen).toEqual([['key-0001', 'ses_0001']])
  })
})

describe('GET /api/tasks/closed-plans (work-photograph R2)', () => {
  it('lists the finished plans to the owner, adds no task to the open reading, and is refused to an agent', async () => {
    const w = await world([t('t1')])
    const closedFile = join(w.proj, 'plans', 'closed', 'beta.plan.json')
    mkdirSync(join(closedFile, '..'), { recursive: true })
    writeFileSync(closedFile, JSON.stringify({ title: 'Beta invites', tasks: [t('b1', { status: 'done' }), t('b2', { status: 'cancelled' })] }))
    const res = await w.get('/api/tasks/closed-plans')
    expect(res.statusCode).toBe(200)
    expect(res.json().plans).toEqual([expect.objectContaining({ title: 'Beta invites', file: closedFile, done: 1, dropped: 1, open: 0 })])
    const tasks = (await w.get('/api/silos/plans/records?kind=plan/task&values=1')).json().records as Array<{ key: string }>
    expect(tasks.map((r) => r.key)).toEqual([w.key('t1')])
    expect(agentMayRead('writer', '/api/tasks/closed-plans')).toBe(false)
  })
})
