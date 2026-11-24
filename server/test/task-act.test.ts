// task-act.test.ts — the task act verbs, over the real server, the real plans kernel on the
// REFERENCE manifest and a real session index (nothing is spawned, no claude
// runs): POST /api/tasks/act — each verb in ONE write (siloActions.writeFile
// called once), its condition refused with nothing written, `already` (F3),
// what the owner saw (F4: asked, state), the owner alone (C13a), the note's
// provenance event and `closes` (F8), an approve on a bound agent's task
// neither reopening nor waking, another task of the same plan written
// meanwhile refusing nothing; the release's reviewer rule (B1b/F6/F7).
// Generic fixtures: agents writer, builder, teller; a person, sam.
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
import type { SessionMeta } from '../src/types.js'
import { asOwner } from './helpers/owner.js'
import { bearerWritesCarryTurns } from './helpers/live-turn.js'

type Json = Record<string, any>
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json')
const LOCAL = { host: '127.0.0.1:3210' }
const socket = `silos-act-${process.pid}`
const AGENTS = ['writer', 'builder', 'teller']

let base: string
let app: FastifyInstance | undefined
let terminals: TerminalService | undefined
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-act-'))
})
afterEach(async () => {
  terminals?.killAll()
  terminals?.stopReaper()
  await app?.close()
  app = undefined
  rmSync(base, { recursive: true, force: true })
})

const t = (id: string, over: Json = {}): Json => ({ id, title: `Task ${id}`, owner: 'writer', status: 'pending', dependsOn: [], ...over })
const ask = (asked = 'Publish today?', owner = 'owner'): Json => ({ owner, action: 'decide', asked })

async function world(tasks: Json[], opts: { bound?: string[]; slug?: string; extra?: Json } = {}) {
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  const proj = join(base, 'alpha')
  const slug = opts.slug ?? 'p'
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(join(proj, 'plans'), { recursive: true })
  const file = join(proj, 'plans', `${slug}.plan.json`)
  writeFileSync(file, JSON.stringify({ title: slug === 'tasks' ? '' : slug, tasks, ...(opts.extra ?? {}) }, null, 2))
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), readFileSync(REF, 'utf8'))
  const siloRegistry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  siloRegistry.load()
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
  const lineage = new LineageStore(join(dataDir, 'lineage.json'))
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  for (const id of AGENTS) registry.create({ id, name: id.charAt(0).toUpperCase() + id.slice(1), folder: proj })
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
    agentMayReadLocation: (_id, loc) => loc === `folder:${proj}` /* every agent here works in proj (bearer-scope.ts) */,
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
  const ledger = new OwnerNoteLedger(join(siloRegistry.root, 'events.jsonl'), 'plans')
  const sent: Array<{ agentId: string; text: string }> = []
  const taskMode: TaskModeEngine = new TaskModeEngine({
    store,
    plans: () => {
      const reading = kernel.reading('plans')
      return reading ? { reading } : null
    },
    bound: () => new Set(opts.bound ?? []),
    setField: (k, f, v) => {
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
      isAgent: (v) => registry.list(true).some((a) => a.id === v),
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
  const key = (id: string): string => `folder:${proj}/${slug}/tasks/${id}`
  const read = (): Json => JSON.parse(readFileSync(file, 'utf8'))
  const task = (id: string): Json => read().tasks.find((x: Json) => x.id === id)
  const sha = (): string => createHash('sha256').update(readFileSync(file)).digest('hex')
  const bearer = (agent?: string): Json => (agent ? { authorization: `Bearer ${agentTokens.tokenFor(agent)}` } : {})
  const post = (url: string, payload: Json, agent?: string, headers: Json = {}) => {
    kernel.refresh()
    return app!.inject({ method: 'POST', url, headers: { ...LOCAL, ...bearer(agent), ...headers }, payload })
  }
  // the verb, counting the file writes it made (writeFile is the kernel's one write path)
  const writes = vi.spyOn(siloActions as unknown as { writeFile: (...a: unknown[]) => unknown }, 'writeFile')
  const act = async (id: string, verb: string, args: Json = {}, agent?: string, headers: Json = {}) => {
    writes.mockClear()
    const r = await post('/api/tasks/act', { key: key(id), verb, ...args }, agent, headers)
    return { r, body: r.json() as Json, writeCalls: writes.mock.calls.length }
  }
  const eventsOf = (id: string): Json[] => siloActions.events('plans', key(id)) as unknown as Json[]
  return { act, post, session, key, task, read, sha, eventsOf, siloActions, taskMode, kernel, store, sent, ledger, file, proj, registry }
}

describe('POST /api/tasks/act — answer (C14, F4, F5)', () => {
  it("blocked on you, nothing else holds it: the note, the wait out and pending — in ONE write; the note is the owner's by its event", async () => {
    const w = await world([t('t1', { status: 'blocked', waitingOn: ask() })])
    const { r, body, writeCalls } = await w.act('t1', 'answer', { text: 'Yes, today', asked: 'Publish today?' })
    expect(r.statusCode).toBe(200)
    expect(writeCalls).toBe(1)
    expect(body).toMatchObject({ already: false, holds: [] })
    const x = w.task('t1')
    expect([x.status, x.waitingOn, x.notes.map((n: Json) => [n.by, n.text])]).toEqual(['pending', undefined, [['owner', 'Yes, today']]])
    // provenance: ONE append-item event with the note's exact `at` and digest, then the fields
    const evs = w.eventsOf('t1')
    expect(evs.map((e) => e.verb)).toEqual(['append-item', 'set-field', 'set-field'])
    expect(evs[0]).toMatchObject({ by: 'owner', detail: { coll: 'notes', at: x.notes[0].at, digest: noteDigest('Yes, today') } })
    expect(evs[0]!.detail.closes).toBeUndefined()
    expect(w.ledger.checker()(w.key('t1'), x.notes).fromOwner).toEqual([true])
  })
  it('a dependency still open: the wait goes, it stays blocked — `holds` says on what (F2)', async () => {
    const w = await world([t('t0', { status: 'in_progress', owner: 'builder' }), t('t1', { status: 'blocked', dependsOn: ['t0'], waitingOn: ask() })])
    const { body } = await w.act('t1', 'answer', { text: 'ok', asked: 'Publish today?' })
    expect(body.holds).toEqual(['t0'])
    expect([w.task('t1').status, w.task('t1').waitingOn]).toEqual(['blocked', undefined])
  })
  it('in review: «Send back» is answer — the note, the wait out, pending; never left in review without a wait (B1c, F5)', async () => {
    const w = await world([t('t1', { status: 'in_review', waitingOn: { owner: 'owner', action: 'review it' } })])
    const { r } = await w.act('t1', 'answer', { text: 'Tighten the intro', asked: '' })
    expect(r.statusCode).toBe(200)
    expect([w.task('t1').status, w.task('t1').waitingOn]).toEqual(['pending', undefined])
  })
  it("a wait on another agent (the relay) is answered too; Silos' own unstick wait is not", async () => {
    const w = await world([
      t('t1', { status: 'blocked', waitingOn: { owner: 'builder', action: 'the numbers' } }),
      t('t2', { status: 'blocked', waitingOn: { owner: 'owner', action: 'unstick p#t9' } }),
    ])
    expect((await w.act('t1', 'answer', { text: 'they are 42', asked: '' })).r.statusCode).toBe(200)
    const before = w.sha()
    const s = await w.act('t2', 'answer', { text: 'hm', asked: '' })
    expect(s.r.statusCode).toBe(409)
    expect(w.sha()).toBe(before)
  })
  it('the question changed since the owner saw it → 409 «it asks something else now», nothing written, the task as it is now', async () => {
    const w = await world([t('t1', { status: 'blocked', waitingOn: ask('Deploy to production?') })])
    const before = w.sha()
    const { r, body } = await w.act('t1', 'answer', { text: 'Yes', asked: 'Publish today?' })
    expect(r.statusCode).toBe(409)
    expect(body.error).toBe('it asks something else now')
    expect(body.detail.task.waitingOn.asked).toBe('Deploy to production?')
    expect(w.sha()).toBe(before)
  })
  it('a question that appeared where none was painted is «something else» too', async () => {
    const w = await world([t('t1', { status: 'blocked', waitingOn: ask('Now a question?') })])
    expect((await w.act('t1', 'answer', { text: 'Yes', asked: '' })).body.error).toBe('it asks something else now')
  })
  it('no wait any more → 409 «it no longer waits on you» (answer has no `already`, F3); a closed one → 409 in its words', async () => {
    const w = await world([t('t1'), t('t2', { status: 'done' })])
    expect((await w.act('t1', 'answer', { text: 'Yes', asked: '' })).body).toMatchObject({ error: 'it no longer waits on you' })
    expect((await w.act('t2', 'answer', { text: 'Yes', asked: '' })).body).toMatchObject({ error: 'it is done already' })
  })
  it('the route asks what the owner saw: answer and approve without `asked`, done and drop without `state` → 400', async () => {
    const w = await world([t('t1', { status: 'blocked', waitingOn: ask() })])
    expect((await w.act('t1', 'answer', { text: 'Yes' })).r.statusCode).toBe(400)
    expect((await w.act('t1', 'approve', {})).r.statusCode).toBe(400)
    expect((await w.act('t1', 'done', {})).r.statusCode).toBe(400)
    expect((await w.act('t1', 'drop', {})).r.statusCode).toBe(400)
    // an EMPTY painted state is no state: the «it changed» check would be skipped (F4)
    expect((await w.act('t1', 'done', { state: '' })).r.statusCode).toBe(400)
    expect((await w.act('t1', 'drop', { state: ' ' })).r.statusCode).toBe(400)
    expect((await w.act('t1', 'answer', { text: '  ', asked: 'Publish today?' })).r.statusCode).toBe(400)
  })
})

describe('done, drop (F3, F4)', () => {
  it('done: done, its wait and next check out, ONE write; again → 200 already, nothing written', async () => {
    const w = await world([t('t1', { owner: 'owner', waitingOn: { owner: 'sam', action: 'x' }, nextCheckAt: '2030-01-01T09:00:00.000Z' })])
    const a = await w.act('t1', 'done', { state: 'pending' })
    expect([a.r.statusCode, a.writeCalls, a.body.already]).toEqual([200, 1, false])
    expect([w.task('t1').status, w.task('t1').waitingOn, w.task('t1').nextCheckAt]).toEqual(['done', undefined, undefined])
    const before = w.sha()
    const again = await w.act('t1', 'done', { state: 'pending' })
    expect([again.r.statusCode, again.body.already]).toEqual([200, true])
    expect(w.sha()).toBe(before)
  })
  it('done on a dropped one, drop on a done one → 409; the state painted is not the state now → 409 «it changed»', async () => {
    const w = await world([t('t1', { status: 'cancelled' }), t('t2', { status: 'done' }), t('t3', { status: 'in_progress' })])
    expect((await w.act('t1', 'done', { state: 'cancelled' })).r.statusCode).toBe(409)
    expect((await w.act('t2', 'drop', { state: 'done' })).body.error).toBe('it is done already')
    const before = w.sha()
    const c = await w.act('t3', 'done', { state: 'pending' })
    expect([c.r.statusCode, c.body.error]).toEqual([409, 'it changed — it is in progress now'])
    expect(w.sha()).toBe(before)
  })
  it('drop: «Dropped: <why>» + cancelled + the wait out in ONE write; its event says it closes; again → already', async () => {
    const w = await world([t('t1', { status: 'blocked', waitingOn: ask() })])
    const a = await w.act('t1', 'drop', { state: 'blocked', text: 'not needed' })
    expect([a.r.statusCode, a.writeCalls]).toEqual([200, 1])
    expect([w.task('t1').status, w.task('t1').waitingOn, w.task('t1').notes[0].text]).toEqual(['cancelled', undefined, 'Dropped: not needed'])
    expect(w.eventsOf('t1')[0]).toMatchObject({ verb: 'append-item', detail: { closes: true } })
    expect((await w.act('t1', 'drop', { state: 'blocked' })).body.already).toBe(true)
    expect(w.task('t1').notes).toHaveLength(1)
  })
  it("another task of the same plan written between the owner's read and the gesture refuses nothing (C13c)", async () => {
    const w = await world([t('t1', { owner: 'owner' }), t('t2')])
    expect(w.siloActions.appendItem('plans', w.key('t2'), 'notes', { text: 'progress' }, { by: 'writer', actor: { agentId: 'writer' } }).ok).toBe(true)
    expect((await w.act('t1', 'done', { state: 'pending' })).r.statusCode).toBe(200)
    expect(w.task('t1').status).toBe('done')
  })
  it('the answer names the tasks the Done made ready (nowReady, with whether each owner moves)', async () => {
    const w = await world([t('t1', { owner: 'owner' }), t('t2', { status: 'blocked', dependsOn: ['t1'] })])
    const { body } = await w.act('t1', 'done', { state: 'pending' })
    expect(body.nowReady).toEqual([expect.objectContaining({ id: 't2', owner: 'writer', wakes: 'never' })])
  })
})

describe('reopen, park, resume, remove-dependency (F10)', () => {
  it('reopen: pending — or blocked while a dependency is open or a wait is written (blockedHolds); open already → already', async () => {
    const w = await world([
      t('t0', { status: 'in_progress' }),
      t('t1', { status: 'done' }),
      t('t2', { status: 'cancelled', dependsOn: ['t0'] }),
      t('t3', { status: 'done', waitingOn: { owner: 'sam', action: 'sign' } }),
    ])
    expect((await w.act('t1', 'reopen')).writeCalls).toBe(1)
    expect(w.task('t1').status).toBe('pending')
    await w.act('t2', 'reopen')
    expect(w.task('t2').status).toBe('blocked')
    await w.act('t3', 'reopen')
    expect(w.task('t3').status).toBe('blocked')
    expect((await w.act('t1', 'reopen')).body.already).toBe(true)
  })
  it('a task rotated to plans/closed/ with its month → 404 in its words', async () => {
    const w = await world([t('t2', { owner: 'owner' })], { slug: 'tasks', extra: { retired: ['t1'], rotatedAt: '2026-11' } })
    const { r, body } = await w.act('t1', 'reopen')
    expect(r.statusCode).toBe(404)
    expect(body.error).toMatch(/rotated out to plans\/closed\//)
  })
  it("park: the owner's task gets its next check AND «Parked until <day>.»; an agent's only the check (a note would wake it); a past moment → 400", async () => {
    const w = await world([t('t1', { owner: 'owner' }), t('t2', { owner: 'sam' }), t('t3')])
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString()
    expect((await w.act('t1', 'park', { until, day: '2030-01-07' })).writeCalls).toBe(1)
    expect([w.task('t1').nextCheckAt, w.task('t1').notes[0].text]).toEqual([until, 'Parked until 2030-01-07.'])
    await w.act('t2', 'park', { until, day: 'Monday' })
    expect(w.task('t2').notes[0].text).toBe('Parked until Monday.')
    await w.act('t3', 'park', { until })
    expect([w.task('t3').nextCheckAt, w.task('t3').notes]).toEqual([until, undefined])
    expect((await w.act('t3', 'park', { until: new Date(Date.now() - 1000).toISOString() })).r.statusCode).toBe(400)
  })
  it('resume: the check out — and a blocked one nothing else holds back to pending; no check → already', async () => {
    const w = await world([
      t('t1', { owner: 'owner', nextCheckAt: '2030-01-01T09:00:00.000Z' }),
      t('t2', { status: 'blocked', nextCheckAt: '2030-01-01T09:00:00.000Z' }),
    ])
    expect((await w.act('t1', 'resume')).writeCalls).toBe(1)
    expect(w.task('t1').nextCheckAt).toBeUndefined()
    await w.act('t2', 'resume')
    expect([w.task('t2').status, w.task('t2').nextCheckAt]).toEqual(['pending', undefined])
    expect((await w.act('t1', 'resume')).body.already).toBe(true)
  })
  it('remove-dependency: dependsOn without it and blocked → pending when nothing else holds it, ONE write; one it does not have → already', async () => {
    const w = await world([
      t('t0', { status: 'cancelled' }),
      t('t1', { status: 'blocked', dependsOn: ['t0'] }),
      t('t5', { status: 'in_progress' }),
      t('t2', { status: 'blocked', dependsOn: ['t0', 't5'] }),
    ])
    const a = await w.act('t1', 'remove-dependency', { dep: 't0' })
    expect([a.writeCalls, w.task('t1').dependsOn, w.task('t1').status]).toEqual([1, [], 'pending'])
    const b = await w.act('t2', 'remove-dependency', { dep: 't0' })
    expect([b.body.holds, w.task('t2').status]).toEqual([['t5'], 'blocked'])
    expect((await w.act('t1', 'remove-dependency', { dep: 't0' })).body.already).toBe(true)
  })
})

describe('approve (B1c, C14a, F8)', () => {
  it("an agent's review waiting on you: «Approved.» + the wait out + done, ONE write; its note closes", async () => {
    const w = await world([t('t1', { status: 'in_review', waitingOn: { owner: 'owner', action: 'review it', asked: 'Good to ship?' } })])
    const a = await w.act('t1', 'approve', { asked: 'Good to ship?' })
    expect([a.r.statusCode, a.writeCalls]).toEqual([200, 1])
    expect([w.task('t1').status, w.task('t1').waitingOn, w.task('t1').notes[0].text]).toEqual(['done', undefined, 'Approved.'])
    expect(w.eventsOf('t1')[0]).toMatchObject({ verb: 'append-item', by: 'owner', detail: { closes: true } })
    expect((await w.act('t1', 'approve', { asked: 'Good to ship?' })).body.already).toBe(true)
  })
  it('a closing verb: approve clears the next check too, as done does', async () => {
    const w = await world([t('t1', { status: 'in_review', waitingOn: { owner: 'owner', action: 'review it' }, nextCheckAt: '2030-01-01T09:00:00.000Z' })])
    expect((await w.act('t1', 'approve', { asked: '' })).r.statusCode).toBe(200)
    expect([w.task('t1').status, w.task('t1').waitingOn, w.task('t1').nextCheckAt]).toEqual(['done', undefined, undefined])
  })
  it("on a BOUND agent's task it neither reopens it nor wakes it — its work is closed (F8)", async () => {
    const w = await world([t('t1', { status: 'in_review', waitingOn: { owner: 'owner', action: 'review it' } })], { bound: ['writer'] })
    w.taskMode.look()
    await w.act('t1', 'approve', { asked: '', text: 'Lovely' })
    for (let i = 0; i < 3; i++) {
      w.kernel.refresh()
      w.taskMode.look()
    }
    expect(w.task('t1').status).toBe('done')
    expect(w.sent).toEqual([])
    expect(w.store.queued().filter((x) => x.task === w.key('t1'))).toEqual([])
  })
  it("refused: the question changed, not in review, a person's task, a wait not on you — nothing written", async () => {
    const w = await world([
      t('t1', { status: 'in_review', waitingOn: { owner: 'owner', action: 'review', asked: 'Deploy?' } }),
      t('t2', { status: 'pending', waitingOn: { owner: 'owner', action: 'review' } }),
      t('t3', { owner: 'sam', status: 'in_review', waitingOn: { owner: 'owner', action: 'review' } }),
      t('t4', { status: 'in_review', waitingOn: { owner: 'sam', action: 'review' } }),
    ])
    const before = w.sha()
    expect((await w.act('t1', 'approve', { asked: 'Draft OK?' })).body.error).toBe('it asks something else now')
    expect((await w.act('t2', 'approve', { asked: '' })).body.error).toBe('it changed — it is pending now')
    expect((await w.act('t3', 'approve', { asked: '' })).r.statusCode).toBe(409)
    expect((await w.act('t4', 'approve', { asked: '' })).body.error).toBe('it no longer waits on you')
    expect(w.sha()).toBe(before)
  })
})

describe('only the owner (C13a)', () => {
  it("an agent bearer → 403; the owner's credential naming an agent (X-Silos-Agent) → 403; nothing written", async () => {
    const w = await world([t('t1', { status: 'blocked', waitingOn: ask() })])
    const before = w.sha()
    expect((await w.act('t1', 'answer', { text: 'Yes', asked: 'Publish today?' }, 'writer')).r.statusCode).toBe(403)
    expect((await w.act('t1', 'answer', { text: 'Yes', asked: 'Publish today?' }, undefined, { 'x-silos-agent': 'writer' })).r.statusCode).toBe(403)
    expect(w.sha()).toBe(before)
  })
  it('F1: act moves tasks only — the plan record itself is no task', async () => {
    const w = await world([t('t1')])
    const r = w.siloActions.taskGesture('plans', `folder:${w.proj}/p`, 'done')
    expect(r).toMatchObject({ ok: false, code: 400 })
  })
})

describe("respond closes the gate with the owner's Done (F11)", () => {
  it("the gate goes done with its wait and next check cleared, in one write; an archived agent's task is an agent's, never a gate", async () => {
    const w = await world([
      t('g', { owner: 'sam', waitingOn: { owner: 'sam', action: 'think' }, nextCheckAt: '2030-01-01T09:00:00.000Z' }),
      t('a', { status: 'blocked', dependsOn: ['g'] }),
      t('h', { owner: 'teller' }),
      t('b', { status: 'blocked', dependsOn: ['h'], owner: 'builder' }),
    ])
    const r = await w.post('/api/silos/plans/record/respond', { key: w.key('g'), text: 'Option A', state: 'pending' })
    expect(r.statusCode).toBe(200)
    expect([w.task('g').status, w.task('g').waitingOn, w.task('g').nextCheckAt]).toEqual(['done', undefined, undefined])
    w.registry.archive('teller')
    const arch = await w.post('/api/silos/plans/record/respond', { key: w.key('h'), text: 'x', state: 'pending' })
    expect(arch.statusCode).toBe(409)
    expect(w.task('h').status).toBe('pending')
  })
})

describe("the release's reviewer (B1b, F6, F7)", () => {
  it('an agent leaving its task in review without naming who reviews → 409 in its words, no release mark written', async () => {
    const w = await world([t('t1')])
    const s = await w.session('writer', 60 * 60_000)
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s }, 'writer')
    const before = w.sha()
    const r = await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'in_review' }, 'writer')
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('name who reviews first: write waitingOn {owner, action, asked}')
    expect(w.sha()).toBe(before)
    expect(w.task('t1').releases).toBeUndefined()
  })
  it('with the wait written first, the release leaves it in review', async () => {
    const w = await world([t('t1')])
    const s = await w.session('writer', 60 * 60_000)
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s }, 'writer')
    expect(w.siloActions.setField('plans', w.key('t1'), 'waitingOn', { owner: 'owner', action: 'review it', asked: 'Ship?' }).ok).toBe(true)
    const r = await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'in_review' }, 'writer')
    expect(r.json()).toMatchObject({ state: 'in_review', disposed: 'in_review' })
  })
  it("the OWNER leaving an agent's task in review is its reviewer: the wait rides the same write (F7)", async () => {
    const w = await world([t('t1')])
    const s = await w.session('writer', 60 * 60_000)
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s }, 'writer')
    const r = await w.post('/api/tasks/release', { key: w.key('t1'), session: s, state: 'in_review' })
    expect(r.json()).toMatchObject({ state: 'in_review', disposed: 'in_review' })
    expect(w.task('t1').waitingOn).toEqual({ owner: 'owner', action: 'review it' })
    expect(w.task('t1').releases).toHaveLength(1)
  })
  it('only when the dispose applies: another thread still current keeps the state, no refusal (M14)', async () => {
    const w = await world([t('t1')])
    const s1 = await w.session('writer', 60 * 60_000)
    const s2 = await w.session('writer', 50 * 60_000)
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s1 }, 'writer')
    await w.post('/api/tasks/claim', { key: w.key('t1'), session: s2, takeover: true }, 'writer')
    const r = await w.post('/api/tasks/release', { key: w.key('t1'), session: s1, state: 'in_review' }, 'writer')
    expect(r.json()).toMatchObject({ state: 'in_progress', kept: 'in_progress' })
  })
})
