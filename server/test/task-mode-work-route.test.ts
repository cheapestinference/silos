// task-mode-work-route.test.ts — «Work on this» (POST /api/tasks/work) and
// the task page's panel (GET /api/tasks/mode), over the real server and the
// real TerminalService with a STUB console command (nothing real is spawned:
// no claude ever runs here). A bound owner's task opens a console with the
// scoped briefing as its first prompt — resuming the (agent, task)
// conversation, or a new one whose id joins conversations[]; a console
// already running is reattached with nothing typed. The
// door is for ANY agent owner (bound or not); a turn
// running in that agent's thread refuses, and a person's task has no door.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
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
import type { ConsoleCommandOpts } from '../src/harnesses/claude-code/console.js'
import type { SiloReading } from '../src/silos/reader.js'
import type { SiloActions } from '../src/silos/actions.js'
import { asOwner } from './helpers/owner.js'

const socket = `silos-taskwork-${process.pid}`
let app: FastifyInstance | undefined
let terminals: TerminalService | undefined

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
  try {
    rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
  } catch {
    /* best effort */
  }
})

async function world(opts: { bound?: string[]; conversations?: string[] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'taskwork-'))
  const root = join(base, 'projects')
  const folder = mkdtempSync(join(tmpdir(), 'taskwork-folder-'))
  mkdirSync(root, { recursive: true })
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'Finance', folder })
  const native = new NativeStore(join(base, 'data', 'native.json'))
  const launched: ConsoleCommandOpts[] = []
  terminals = new TerminalService(registry, index, undefined, undefined, {
    tmuxSocket: socket,
    appendDir: join(base, 'append'),
    envDir: join(base, 'env'),
    sessionsDir: join(base, 'claude-sessions'),
    // the STUB: records what claude would have been launched with, runs nothing real
    command: (o) => {
      launched.push(o)
      return ['bash', '-c', 'sleep 60']
    },
  })
  const planKey = `folder:${folder}/month-end`
  const taskKey = `${planKey}/tasks/t3`
  const tasks = [
    { id: 't2', title: 'Confirm the figure', owner: 'sam', state: 'done', dependsOn: [], notes: [], conversations: [] },
    {
      id: 't3',
      title: 'Close the month in the ERP',
      owner: 'finance',
      state: 'pending',
      dependsOn: ['t2'],
      notes: [{ at: '2026-11-03T09:00:00Z', by: 'owner', text: 'Use the new rate' }],
      conversations: (opts.conversations ?? []).map((s) => ({ session: s })),
    },
    { id: 't4', title: 'Tell the accountant', owner: 'ops', state: 'pending', dependsOn: [], notes: [], conversations: [] },
  ]
  const reading = {
    records: [
      {
        silo: 'plans',
        kind: 'plan',
        source: 'plans',
        file: join(folder, 'plans', 'month-end.plan.json'),
        rel: 'plans/month-end.plan.json',
        location: `folder:${folder}`,
        anchors: {},
        mtimeMs: 0,
        raw: {},
        record: { id: 'month-end', title: 'Cierre', tasks },
        remarks: [],
        partial: [],
      },
    ],
    unreadable: [],
    problems: [],
    sources: {},
    lastWrite: null,
  } as unknown as SiloReading
  const store = new TaskModeStore(join(base, 'data'))
  const appended: Array<[string, string, unknown]> = []
  // the owner's link (ownerLink): a pending/in_progress task is
  // CLAIMED — linked and in progress in one write (linkAndSet)
  const claimed: Array<[string, string, string]> = []
  // the release verb's marks, and the order of every write (link before release)
  const released: Array<[string, string, unknown]> = []
  const writes: string[] = []
  const siloActions = {
    appendItem: (_id: string, key: string, coll: string, values: unknown) => {
      appended.push([key, coll, values])
      writes.push(`append ${(values as { session?: string }).session ?? ''}`)
      return { ok: true, value: {} }
    },
    linkAndSet: (_id: string, key: string, _coll: string, idValue: string, _f: string, _v: unknown) => {
      claimed.push([key, idValue, 'in_progress'])
      writes.push(`link ${idValue}`)
      return { ok: true, value: { linked: true, set: true, revived: false } }
    },
    appendRelease: (_id: string, key: string, session: string, _rel: boolean, o: { state?: string }) => {
      released.push([key, session, o.state])
      writes.push(`release ${session}`)
      return { ok: true, value: { written: true, state: 'in_progress', kept: 'in_progress' } }
    },
  } as unknown as SiloActions
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {},
      async interrupt() {
        return undefined
      },
    }),
  })
  const taskMode = new TaskModeEngine({
    store,
    plans: () => ({ reading }),
    bound: () => new Set(opts.bound ?? ['finance']),
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    conversationOf: () => null,
    holdersOf: () => [],
    busyWhy: () => null,
    ready: () => true,
    send: () => {
      throw new Error('no turns in this test')
    },
  })
  app = buildServer({
    index,
    registry,
    store: new SessionStore(root, join(base, 'data')),
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(join(base, 'data')),
    memory: new MemoryService(root, join(base, 'data'), registry),
    terminals,
    token: 't0k',
    liveMs: 120_000,
    siloActions,
    taskMode,
  })
  asOwner(app, 't0k')
  // a conversation of finance's on disk (the resumable one)
  const session = async (id: string): Promise<void> => {
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    native.register(mf, id, { agentId: 'finance', createdAt: '2026-11-03T08:00:00Z' })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          sessionId: id,
          cwd: folder,
          timestamp: '2026-11-03T08:00:00Z',
          uuid: 'u1',
          message: { role: 'user', content: 'start' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: id,
          cwd: folder,
          timestamp: '2026-11-03T08:00:05Z',
          uuid: 'a1',
          parentUuid: 'u1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        }),
      ].join('\n') + '\n',
    )
    await index.refresh(mf, id)
  }
  return { app: app!, taskKey, launched, appended, claimed, released, writes, store, session, folder, planKey, chat, root, native, index }
}

describe('POST /api/tasks/work — «Work on this»', () => {
  it('a bound owner with no conversation yet: a NEW console born with the briefing; its id joins conversations[]', async () => {
    const w = await world()
    // a wake waiting for it (an owner's note) is folded into the briefing
    w.store.update((s) => {
      s.wakes.push({
        id: 'finance~month-end~t3~owner-note~1',
        agent: 'finance',
        task: w.taskKey,
        ref: 'month-end#t3',
        title: 'Close the month in the ERP',
        reason: 'owner-note',
        says: 'a note from the owner',
        at: '2026-11-03T09:00:01.000Z',
        state: 'queued',
        held: 'a console has its conversation open',
        notes: [{ at: '2026-11-03T09:00:00Z', by: 'owner', text: 'Use the new rate' }],
        bypassThrottle: true,
      })
    })
    const res = await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: w.taskKey } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ mode: 'new', briefed: true, linked: true })
    expect(w.launched).toHaveLength(1)
    expect(w.launched[0]!.sessionId).toBe(body.sessionId)
    expect(w.launched[0]!.resumeId).toBeUndefined()
    expect(w.launched[0]!.prompt).toContain('The owner opened this conversation to work ONE task — month-end#t3 «Close the month in the ERP»')
    expect(w.launched[0]!.prompt).toContain('Use the new rate')
    // ownerLink: the pending task is claimed by the door (E3) — linked and in progress
    expect(w.claimed).toEqual([[w.taskKey, body.sessionId, 'in_progress']])
    expect(w.appended).toEqual([])
    expect(w.store.wakes()[0]).toMatchObject({ state: 'delivered', via: 'work', session: body.sessionId })
  })

  it('the (agent, task) conversation exists: it is RESUMED with the briefing (--resume <id> "…"), nothing appended', async () => {
    const id = randomUUID()
    const w = await world({ conversations: [id] })
    await w.session(id)
    const res = await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: w.taskKey } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ mode: 'resumed', sessionId: id, briefed: true })
    expect(w.launched[0]).toMatchObject({ resumeId: id })
    expect(w.launched[0]!.prompt).toContain('month-end#t3')
    expect(w.appended).toEqual([])
    // the resumed branch links too (E3 ownerLink): the pending task is claimed there
    expect(w.claimed).toEqual([[w.taskKey, id, 'in_progress']])
    expect(res.json()).toMatchObject({ linked: true, state: 'in_progress' })
    // its console now runs: a second press reattaches, types nothing, says so
    const again = await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: w.taskKey } })
    expect(again.json()).toMatchObject({ mode: 'resumed', sessionId: id, briefed: false, why: 'its console was already open — nothing was typed into it' })
    expect(w.launched).toHaveLength(1)
  })

  it('an UNBOUND agent works its task too (t6): a new console born with the briefing, linked — no wakes to fold', async () => {
    const w = await world({ bound: [] })
    const res = await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: w.taskKey } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ mode: 'new', briefed: true, linked: true })
    expect(w.launched).toHaveLength(1)
    expect(w.launched[0]!.prompt).toContain('month-end#t3 «Close the month in the ERP»')
    // ownerLink: the pending task is claimed by the door (E3) — linked and in progress
    expect(w.claimed).toEqual([[w.taskKey, body.sessionId, 'in_progress']])
    expect(w.appended).toEqual([])
    // a person's task has no agent door
    const p = await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: `${w.planKey}/tasks/t2` } })
    expect(p.statusCode).toBe(409)
    expect(p.json()).toEqual({ error: "sam is not an agent — a person's task is theirs to do", notAgent: true })
    expect((await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: 'nope' } })).statusCode).toBe(404)
  })

  it("an UNBOUND agent's existing thread is resumed with the briefing", async () => {
    const id = randomUUID()
    const w = await world({ bound: [], conversations: [id] })
    await w.session(id)
    const res = await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: w.taskKey } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ mode: 'resumed', sessionId: id, briefed: true })
    expect(w.launched[0]).toMatchObject({ resumeId: id })
  })

  it("a turn RUNNING in the agent's thread refuses — said, with the conversation to open; nothing launched or written", async () => {
    const id = randomUUID()
    const w = await world({ bound: [], conversations: [id] })
    await w.session(id)
    w.chat.isSessionActive = (s: string) => s === id
    const res = await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: w.taskKey } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({
      error: "a turn is running in Finance's conversation on this task — open it; your words land there",
      running: true,
      sessionId: id,
      folder: mungePath(w.folder),
    })
    expect(w.launched).toEqual([])
    expect(w.appended).toEqual([])
    expect(w.claimed).toEqual([])
    // the door says so before it is pressed
    const mode = await w.app.inject({ method: 'GET', url: `/api/tasks/mode?key=${encodeURIComponent(w.taskKey)}` })
    expect(mode.json().door).toEqual({
      thread: { sessionId: id, folder: mungePath(w.folder) },
      running: { sessionId: id, folder: mungePath(w.folder) },
      consoleBriefs: true,
      hasConsole: false,
    })
  })
})

describe('POST /api/tasks/work {instead} — «Continue in a new conversation ›»', () => {
  it('a NEW briefed console (never the tip), linked FIRST, then the old one released with no state asked — a running turn does not refuse', async () => {
    const old = randomUUID()
    const w = await world({ bound: [], conversations: [old] })
    await w.session(old)
    w.chat.isSessionActive = (s: string) => s === old
    const res = await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: w.taskKey, instead: old } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ mode: 'new', briefed: true, linked: true, released: true, instead: old })
    expect(body.sessionId).not.toBe(old)
    expect(w.launched).toHaveLength(1)
    expect(w.launched[0]!.resumeId).toBeUndefined()
    expect(w.launched[0]!.prompt).toContain('month-end#t3 «Close the month in the ERP»')
    // the new thread holds the task before the old lets go: the release
    // never disposes (no state asked), the status stays the link's
    expect(w.writes).toEqual([`link ${body.sessionId}`, `release ${old}`])
    expect(w.released).toEqual([[w.taskKey, old, undefined]])
  })

  it('a conversation not on the task (or no id): refused, nothing launched or written', async () => {
    const old = randomUUID()
    const w = await world({ bound: [], conversations: [old] })
    await w.session(old)
    const other = randomUUID()
    const res = await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: w.taskKey, instead: other } })
    expect(res.statusCode).toBe(409)
    expect((await w.app.inject({ method: 'POST', url: '/api/tasks/work', payload: { key: w.taskKey, instead: 'not an id!' } })).statusCode).toBe(400)
    expect(w.launched).toEqual([])
    expect(w.writes).toEqual([])
  })
})

describe('GET /api/tasks/mode — the panel', () => {
  it('says whether the owner is bound, how it wakes and its last wakes', async () => {
    const w = await world()
    w.store.update((s) => {
      s.wakes.push({
        id: 'w1',
        agent: 'finance',
        task: w.taskKey,
        ref: 'month-end#t3',
        title: 'x',
        reason: 'unblocked',
        says: 'its blockers are done (t2)',
        at: '2026-11-03T09:00:00.000Z',
        state: 'delivered',
        deliveredAt: '2026-11-03T09:00:02.000Z',
        session: 's1',
        notes: [{ at: '', by: 'owner', text: 'secret' }],
        bypassThrottle: false,
      })
    })
    const res = await w.app.inject({ method: 'GET', url: `/api/tasks/mode?key=${encodeURIComponent(w.taskKey)}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      heldNow: null,
      live: null,
      bound: true,
      owner: 'finance',
      wakes: 'task',
      history: [
        {
          id: 'w1',
          reason: 'unblocked',
          says: 'its blockers are done (t2)',
          at: '2026-11-03T09:00:00.000Z',
          state: 'delivered',
          deliveredAt: '2026-11-03T09:00:02.000Z',
          session: 's1',
        },
      ],
      // the door: no thread yet (it starts one), nothing running, the console takes the briefing
      door: { thread: null, running: null, consoleBriefs: true, hasConsole: false },
      // where «Give to… ›» may take it
      handTo: expect.any(Array),
    })
    const t4 = await w.app.inject({ method: 'GET', url: `/api/tasks/mode?key=${encodeURIComponent(`${w.planKey}/tasks/t4`)}` })
    expect(t4.json()).toMatchObject({ bound: false, owner: 'ops', wakes: null, history: [], door: null })
  })

  it('the door names the thread to continue once the agent has one', async () => {
    const id = randomUUID()
    const w = await world({ bound: [], conversations: [id] })
    await w.session(id)
    const res = await w.app.inject({ method: 'GET', url: `/api/tasks/mode?key=${encodeURIComponent(w.taskKey)}` })
    expect(res.json().door).toEqual({ thread: { sessionId: id, folder: mungePath(w.folder) }, running: null, consoleBriefs: true, hasConsole: false })
  })

  // «Open» goes to a console only when the agent has one in the index:
  // a transcript its console wrote (entrypoint cli) — the
  // door, the overview and every reader say the same
  it('a console of the agent in the index: hasConsole — on the door and in the overview', async () => {
    const w = await world({ bound: [] })
    const before = await w.app.inject({ method: 'GET', url: '/api/overview' })
    expect(before.json().agents.find((a: { id: string }) => a.id === 'finance').open).toEqual({ hasConsole: false, consoleBriefs: true })
    const id = randomUUID()
    const mf = mungePath(w.folder)
    mkdirSync(join(w.root, mf), { recursive: true })
    writeFileSync(
      join(w.root, mf, `${id}.jsonl`),
      JSON.stringify({
        type: 'user',
        entrypoint: 'cli',
        sessionId: id,
        cwd: w.folder,
        timestamp: '2026-11-03T08:00:00Z',
        uuid: 'u1',
        message: { role: 'user', content: 'hello' },
      }) + '\n',
    )
    w.native.register(mf, id, { agentId: 'finance', createdAt: '2026-11-03T08:00:00Z' })
    await w.index.refresh(mf, id)
    const res = await w.app.inject({ method: 'GET', url: `/api/tasks/mode?key=${encodeURIComponent(w.taskKey)}` })
    expect(res.json().door).toMatchObject({ hasConsole: true, consoleBriefs: true })
    const after = await w.app.inject({ method: 'GET', url: '/api/overview' })
    expect(after.json().agents.find((a: { id: string }) => a.id === 'finance').open).toEqual({ hasConsole: true, consoleBriefs: true })
  })
})
