import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { FastifyInstance } from 'fastify'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

// a genuinely LOCAL request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for the condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const TOKEN = 't0k'
let app: FastifyInstance, calls: QueryArgs[], folder: string, index: SessionIndex, native: NativeStore, root: string, store: SessionStore

function fakeQuery(script: SdkMessage[], sink: QueryArgs[]): (args: QueryArgs) => SdkQueryHandle {
  return (args) => {
    sink.push(args)
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of script) yield m
      },
      async interrupt() {
        return { status: 'interrupted' }
      },
    }
  }
}
const SCRIPT: SdkMessage[] = [
  { type: 'system', subtype: 'init', session_id: 'sess-9' },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.01 },
]

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  root = join(base, 'projects')
  folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  mkdirSync(root, { recursive: true })
  index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder })
  native = new NativeStore(join(base, 'data', 'native.json'))
  calls = []
  const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
  const exec = new ExecService(registry)
  const complete = new CompleteService(registry, index)
  const prefs = new PrefsStore(join(base, 'data'))
  const memory = new MemoryService(root, join(base, 'data'), registry)
  store = new SessionStore(root, join(base, 'data'))
  app = buildServer({ index, registry, store, native, chat, exec, complete, prefs, memory, token: TOKEN, liveMs: 120_000 })
})
afterEach(async () => {
  await app.close()
})

describe('POST /api/agents/:id/chat', () => {
  it('202 with a turnId and the ChatEvents go out over WS', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const seen: any[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`)
    ws.on('message', (d) => seen.push(JSON.parse(String(d))))
    await new Promise((r) => ws.once('open', r))

    const res = await app.inject({ method: 'POST', url: '/api/agents/writer/chat', headers: { 'x-token': TOKEN }, payload: { text: 'hi' } })
    expect(res.statusCode).toBe(202)
    const { turnId } = res.json()
    expect(typeof turnId).toBe('string')

    await until(() => seen.some((m) => m.ev === 'chat-done'))
    ws.close()
    const evs = seen.filter((m) => typeof m.ev === 'string' && m.ev.startsWith('chat-'))
    expect(evs.map((e) => e.ev)).toEqual(['chat-init', 'chat-delta', 'chat-done'])
    expect(evs[0].turnId).toBe(turnId)
  })

  it('empty text -> 400; a bad agent -> 400', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/agents/writer/chat', headers: { 'x-token': TOKEN }, payload: { text: '' } })
    expect(r1.statusCode).toBe(400)
    const r2 = await app.inject({ method: 'POST', url: '/api/agents/master/chat', headers: { 'x-token': TOKEN }, payload: { text: 'x' } })
    expect(r2.statusCode).toBe(400)
  })

  it('continuing: a native session -> append, a foreign one -> fork', async () => {
    // a real "foreign" session in the index
    const { mungePath } = await import('../src/agent-registry.js')
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(join(root, mf, 'ext.jsonl'), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"old"}}\n`)
    await index.refresh(mf, 'ext')

    await app.inject({
      method: 'POST',
      url: `/api/agents/writer/chat`,
      headers: { 'x-token': TOKEN },
      payload: { text: 'go on', session: { folder: mf, id: 'ext' } },
    })
    await until(() => calls.length > 0)
    expect(calls[0]!.options.resume).toBe('ext')
    expect(calls[0]!.options.forkSession).toBe(true) // foreign -> fork

    native.register(mf, 'nat', { agentId: 'writer', createdAt: 'x' })
    writeFileSync(join(root, mf, 'nat.jsonl'), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"mine"}}\n`)
    await index.refresh(mf, 'nat')
    calls.length = 0
    await app.inject({
      method: 'POST',
      url: `/api/agents/writer/chat`,
      headers: { 'x-token': TOKEN },
      payload: { text: 'go on', session: { folder: mf, id: 'nat' } },
    })
    await until(() => calls.length > 0)
    expect(calls[0]!.options.resume).toBe('nat')
    expect(calls[0]!.options.forkSession).toBeUndefined() // native -> append

    // the engine's --resume twin of a Silos-born session (its console
    // relaunched): a new file, no record of its own — still Silos' thread,
    // so chat appends to it instead of splitting the thread again
    writeFileSync(
      join(root, mf, 'twin.jsonl'),
      [
        JSON.stringify({ type: 'derived-from', v: 1, sessionId: 'twin', sessions: [{ type: 'claude_code_session', id: 'nat', via: 'fork' }] }),
        `{"type":"user","cwd":"${folder}","sessionId":"twin","message":{"role":"user","content":"after the relaunch"}}`,
      ].join('\n') + '\n',
    )
    await index.refresh(mf, 'twin')
    calls.length = 0
    await app.inject({
      method: 'POST',
      url: `/api/agents/writer/chat`,
      headers: { 'x-token': TOKEN },
      payload: { text: 'go on', session: { folder: mf, id: 'twin' } },
    })
    await until(() => calls.length > 0)
    expect(calls[0]!.options.resume).toBe('twin')
    expect(calls[0]!.options.forkSession).toBeUndefined() // a continuation of a native thread -> append

    // a twin of a FOREIGN session stays a fork: Silos never writes threads it did not start
    writeFileSync(
      join(root, mf, 'exttwin.jsonl'),
      [
        JSON.stringify({ type: 'derived-from', v: 1, sessionId: 'exttwin', sessions: [{ id: 'ext', via: 'fork' }] }),
        `{"type":"user","cwd":"${folder}","sessionId":"exttwin","message":{"role":"user","content":"x"}}`,
      ].join('\n') + '\n',
    )
    await index.refresh(mf, 'exttwin')
    calls.length = 0
    await app.inject({
      method: 'POST',
      url: `/api/agents/writer/chat`,
      headers: { 'x-token': TOKEN },
      payload: { text: 'go on', session: { folder: mf, id: 'exttwin' } },
    })
    await until(() => calls.length > 0)
    expect(calls[0]!.options.forkSession).toBe(true)
  })

  it('a nonexistent session -> 404', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/agents/writer/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'x', session: { folder: '-no', id: 'no' } },
    })
    expect(r.statusCode).toBe(404)
  })

  it('a session from another folder (another agent) -> 400, no cross-resume', async () => {
    const { mungePath } = await import('../src/agent-registry.js')
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(join(root, mf, 'from-dev.jsonl'), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"from the first agent"}}\n`)
    await index.refresh(mf, 'from-dev')

    const folder2 = mkdtempSync(join(tmpdir(), 'deck-folder2-'))
    const create = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { 'x-token': TOKEN },
      payload: { id: 'dev2', name: 'Dev2', folder: folder2 },
    })
    expect(create.statusCode).toBe(201)

    const r = await app.inject({
      method: 'POST',
      url: '/api/agents/dev2/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'crossed', session: { folder: mf, id: 'from-dev' } },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe("the session does not belong to this agent's folder")
  })

  it('a title on a new conversation lands as the manual rename once chat-init names the session', async () => {
    const { mungePath } = await import('../src/agent-registry.js')
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/writer/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'hi', title: '  My research  ' },
    })
    expect(res.statusCode).toBe(202)
    const mf = mungePath(folder)
    await until(() => store.titleOverride(mf, 'sess-9') !== null)
    // trimmed, stored on the manual tier — the titler can never overwrite it
    expect(store.titleOverride(mf, 'sess-9')).toBe('My research')
  })

  it('a blank title is ignored: no override is written', async () => {
    const { mungePath } = await import('../src/agent-registry.js')
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/writer/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'hi', title: '   ' },
    })
    expect(res.statusCode).toBe(202)
    await until(() => calls.length > 0)
    await new Promise((r) => setTimeout(r, 100)) // let the fake turn finish
    expect(store.titleOverride(mungePath(folder), 'sess-9')).toBeNull()
  })

  it('a title together with a session (resume) -> 400', async () => {
    const { mungePath } = await import('../src/agent-registry.js')
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(join(root, mf, 'nat.jsonl'), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"mine"}}\n`)
    await index.refresh(mf, 'nat')
    const r = await app.inject({
      method: 'POST',
      url: '/api/agents/writer/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'go on', title: 'new name', session: { folder: mf, id: 'nat' } },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('title only allowed for a new conversation')
  })
})

describe('master: choosing a cwd', () => {
  it('master + an absolute, existing cwd -> 202', async () => {
    const masterFolder = mkdtempSync(join(tmpdir(), 'deck-master-'))
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/master/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'hi', cwd: masterFolder },
    })
    expect(res.statusCode).toBe(202)
  })

  it('master with no cwd -> 400 "cwd required for master"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/master/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'hi' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('cwd required for master')
  })

  it('master + a relative cwd -> 400 "invalid cwd"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/master/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'hi', cwd: 'relative/no/slash' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid cwd')
  })

  it('master + an absolute but nonexistent cwd -> 400 "invalid cwd"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/master/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'hi', cwd: '/does/not/exist/for-sure-xyz-123' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid cwd')
  })

  it('an agent with a folder + a cwd in the body -> 400 "cwd only allowed for master"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/writer/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'hi', cwd: folder },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('cwd only allowed for master')
  })

  it("continuing a master session with no cwd -> 202, queryFn receives the session's cwd (meta.cwd)", async () => {
    const masterFolder = mkdtempSync(join(tmpdir(), 'deck-master-'))
    const { mungePath } = await import('../src/agent-registry.js')
    const mf = mungePath(masterFolder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(join(root, mf, 'm1.jsonl'), `{"type":"user","cwd":"${masterFolder}","message":{"role":"user","content":"old"}}\n`)
    await index.refresh(mf, 'm1')
    native.register(mf, 'm1', { agentId: 'master', createdAt: 'x' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/master/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'go on', session: { folder: mf, id: 'm1' } },
    })
    expect(res.statusCode).toBe(202)
    await until(() => calls.length > 0)
    expect(calls[0]!.options.cwd).toBe(masterFolder)
    expect(calls[0]!.options.resume).toBe('m1')
  })

  it('master tries to continue a session that classifies to another real agent -> 400, no cross-resume', async () => {
    // a session whose cwd falls inside "writer"'s folder -> classify() assigns it to writer, not master
    const { mungePath } = await import('../src/agent-registry.js')
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(join(root, mf, 'from-dev2.jsonl'), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"from writer"}}\n`)
    await index.refresh(mf, 'from-dev2')

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/master/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'crossed', session: { folder: mf, id: 'from-dev2' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe("the session does not belong to this agent's folder")
  })

  it("a session created via master inside another agent's folder -> still classifies as master (native-owner override)", async () => {
    const { mungePath } = await import('../src/agent-registry.js')
    const mf = mungePath(folder) // writer's real folder
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(join(root, mf, 'stolen.jsonl'), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"from master"}}\n`)
    await index.refresh(mf, 'stolen')
    native.register(mf, 'stolen', { agentId: 'master', createdAt: 'x' }) // override: master created it, not writer

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${mf}/stolen`, headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(200)
    expect(res.json().meta.agentId).toBe('master')
  })
})

describe('GET /api/projects', () => {
  it('returns distinct cwds with a count and last activity, sorted by activity desc', async () => {
    const { mungePath } = await import('../src/agent-registry.js')
    const folderA = mkdtempSync(join(tmpdir(), 'deck-proj-a-'))
    const folderB = mkdtempSync(join(tmpdir(), 'deck-proj-b-'))
    const mfA = mungePath(folderA)
    const mfB = mungePath(folderB)
    mkdirSync(join(root, mfA), { recursive: true })
    mkdirSync(join(root, mfB), { recursive: true })
    writeFileSync(join(root, mfA, 'a1.jsonl'), `{"type":"user","cwd":"${folderA}","message":{"role":"user","content":"a1"}}\n`)
    writeFileSync(join(root, mfA, 'a2.jsonl'), `{"type":"user","cwd":"${folderA}","message":{"role":"user","content":"a2"}}\n`)
    writeFileSync(join(root, mfB, 'b1.jsonl'), `{"type":"user","cwd":"${folderB}","message":{"role":"user","content":"b1"}}\n`)
    // Activity is the JSONL mtime: pin it explicitly. The three writes land
    // in the same few ms, so b1 (written last) could tie or beat a2 and the
    // order flipped now and then; refresh order never mattered.
    const t = Date.now() / 1000
    utimesSync(join(root, mfA, 'a1.jsonl'), t - 30, t - 30)
    utimesSync(join(root, mfB, 'b1.jsonl'), t - 20, t - 20) // B more recent than a1
    utimesSync(join(root, mfA, 'a2.jsonl'), t - 10, t - 10)
    // a2 is the most recent of all -> A ends up with the newest last-activity
    await index.refresh(mfA, 'a1')
    await index.refresh(mfB, 'b1')
    await index.refresh(mfA, 'a2')

    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(200)
    const { projects } = res.json()
    const cwds = projects.map((p: { cwd: string }) => p.cwd)
    expect(cwds).toEqual([folderA, folderB])
    const a = projects.find((p: { cwd: string }) => p.cwd === folderA)
    expect(a.sessions).toBe(2)
  })

  it('no token -> 401 (the same global hook as the rest of /api)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: REMOTE })
    expect(res.statusCode).toBe(401)
  })
})

describe('cancel and exec', () => {
  it('cancel of a nonexistent turn -> ok false', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/chat/ghost-turn/cancel', headers: { 'x-token': TOKEN } })
    expect(r.json()).toEqual({ ok: false })
  })
  it('alive of a nonexistent turn -> false', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/chat/ghost-turn/alive', headers: { 'x-token': TOKEN } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ alive: false })
  })
  it('alive with no token -> 401 (the same global hook as the rest of /api)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/chat/ghost-turn/alive', headers: REMOTE })
    expect(r.statusCode).toBe(401)
  })
  it("exec runs in the agent's folder", async () => {
    const r = await app.inject({ method: 'POST', url: '/api/agents/writer/exec', headers: { 'x-token': TOKEN }, payload: { command: 'pwd' } })
    expect(r.statusCode).toBe(200)
    expect(r.json().stdout).toContain(folder)
  })
  it('exec with no command -> 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/agents/writer/exec', headers: { 'x-token': TOKEN }, payload: {} })
    expect(r.statusCode).toBe(400)
  })
})

describe('a send against a session Silos is already working', () => {
  it("→ 409 with the courteous sentence, BEFORE any console handover — never the harness lock's raw error", async () => {
    const { mungePath } = await import('../src/agent-registry.js')
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(join(root, mf, 'busy-1.jsonl'), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"hello"}}\n`)
    await index.refresh(mf, 'busy-1')
    // a second app whose first turn HANGS until released — the live turn
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let first = true
    const registry2 = new AgentRegistry(join(mkdtempSync(join(tmpdir(), 'deck-')), 'agents.json'))
    registry2.load()
    registry2.create({ id: 'writer', name: 'Writer', folder })
    const chat2 = new ChatService({
      registry: registry2,
      native,
      queryFn: (args) => {
        calls.push(args)
        const hang = first
        first = false
        return {
          async *[Symbol.asyncIterator]() {
            if (hang) await gate
            for (const m of SCRIPT) yield m
          },
          async interrupt() {
            return { status: 'interrupted' as const }
          },
        }
      },
    })
    const app2 = buildServer({
      index,
      registry: registry2,
      store,
      native,
      chat: chat2,
      exec: new ExecService(registry2),
      complete: new CompleteService(registry2, index),
      prefs: new PrefsStore(mkdtempSync(join(tmpdir(), 'deck-'))),
      memory: new MemoryService(root, mkdtempSync(join(tmpdir(), 'deck-')), registry2),
      token: TOKEN,
      liveMs: 120_000,
    })
    try {
      const firstSend = app2.inject({
        method: 'POST',
        url: '/api/agents/writer/chat',
        headers: { 'x-token': TOKEN },
        payload: { text: 'one', session: { folder: mf, id: 'busy-1' } },
      })
      await until(() => chat2.liveOn('busy-1') !== null)
      const second = await app2.inject({
        method: 'POST',
        url: '/api/agents/writer/chat',
        headers: { 'x-token': TOKEN },
        payload: { text: 'two', session: { folder: mf, id: 'busy-1' } },
      })
      expect(second.statusCode).toBe(409)
      expect(second.json().error).toBe('A turn is already running in this conversation — wait for it to finish.')
      release()
      await firstSend
    } finally {
      await app2.close()
    }
  })
})

// Steering: the owner's message reaches the turn that is RUNNING on that
// conversation at its next step (the SDK's streaming input, priority next),
// as typed into a console — never a second turn, never a refusal.
describe('steering a running turn', () => {
  type Msg = { message: { content: string }; priority?: string }
  async function liveApp(opts: { unattended?: boolean; fresh?: boolean } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'deck-steer-'))
    const root2 = join(base, 'projects')
    mkdirSync(root2, { recursive: true })
    const folder2 = mkdtempSync(join(tmpdir(), 'deck-steer-folder-'))
    const idx = claudeSessionIndex(root2, join(base, 'cache.json'))
    await idx.init()
    const reg = new AgentRegistry(join(base, 'agents.json'))
    reg.load()
    reg.create({ id: 'writer', name: 'Writer', folder: folder2 })
    const nat = new NativeStore(join(base, 'native.json'))
    const read: Msg[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let queries = 0
    const queryFn = (args: { prompt: unknown; options: Record<string, unknown> }): SdkQueryHandle => {
      queries++
      // like the real CLI: a new conversation is born under the id Silos hands
      // it (sessionId); a continuation answers with the one it resumes
      const sid = typeof args.options.sessionId === 'string' ? args.options.sessionId : typeof args.options.resume === 'string' ? args.options.resume : 'live-1'
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: sid } as SdkMessage
          // the engine reads its prompt as a stream while it works
          const it = (args.prompt as AsyncIterable<Msg>)[Symbol.asyncIterator]()
          void (async () => {
            for (;;) {
              const n = await it.next()
              if (n.done) return
              read.push(n.value)
            }
          })()
          await gate
          yield { type: 'result', subtype: 'success', total_cost_usd: 0 } as SdkMessage
        },
        async interrupt() {
          return {}
        },
      }
    }
    const chatSvc = new ChatService({ registry: reg, native: nat, queryFn })
    const a = buildServer({
      index: idx,
      registry: reg,
      store: new SessionStore(root2, base),
      native: nat,
      chat: chatSvc,
      exec: new ExecService(reg),
      complete: new CompleteService(reg, idx),
      prefs: new PrefsStore(base),
      memory: new MemoryService(root2, base, reg),
      token: TOKEN,
      liveMs: 120_000,
    })
    // the conversation's transcript, so the route can find it
    const { mungePath } = await import('../src/agent-registry.js')
    const mf = mungePath(folder2)
    mkdirSync(join(root2, mf), { recursive: true })
    writeFileSync(join(root2, mf, 'live-1.jsonl'), `{"type":"user","cwd":"${folder2}","sessionId":"live-1","message":{"role":"user","content":"start"}}\n`)
    await idx.refresh(mf, 'live-1')
    nat.register(mf, 'live-1', { agentId: 'writer', createdAt: 'x' })
    // the running turn: an unattended run, a NEW conversation (live from its
    // chat-init on, under the id Silos mints), or a continuation of live-1
    const turn = opts.unattended
      ? (async () => {
          for await (const _ of chatSvc.send({
            turnId: 't-run',
            agentId: 'writer',
            text: 'scheduled work',
            unattended: true,
            turn: { class: 'run', automationId: 'a1', runId: 'r1' },
            resume: { sessionId: 'live-1', mode: 'append' },
          } as never)) {
            /* drive */
          }
        })()
      : opts.fresh
        ? a.inject({ method: 'POST', url: '/api/agents/writer/chat', headers: { 'x-token': TOKEN }, payload: { text: 'build the page' } })
        : a.inject({
            method: 'POST',
            url: '/api/agents/writer/chat',
            headers: { 'x-token': TOKEN },
            payload: { text: 'build the page', session: { folder: mf, id: 'live-1' } },
          })
    // the id the turn is live on: live-1, or the one minted for a new conversation
    const liveId = (): string | null =>
      opts.fresh
        ? (Object.keys((JSON.parse(readFileSync(join(base, 'native.json'), 'utf8')) as { sessions: Record<string, unknown> }).sessions)
            .map((k) => k.split('/')[1]!)
            .find((id) => id !== 'live-1') ?? null)
        : 'live-1'
    return { a, mf, read, release, turn, queries: () => queries, liveId, idx, root2, folder2, chatSvc }
  }

  it('a message sent while the turn works reaches THAT turn at its next step — one query, no second turn', async () => {
    const t = await liveApp()
    await until(() => t.read.length === 1)
    expect(t.read[0]).toMatchObject({ message: { content: 'build the page' } })
    const r = await t.a.inject({
      method: 'POST',
      url: '/api/agents/writer/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'make the title red', session: { folder: t.mf, id: 'live-1' }, steer: true },
    })
    expect([r.statusCode, r.json()]).toEqual([202, expect.objectContaining({ steered: true })])
    await until(() => t.read.length === 2)
    expect(t.read[1]).toMatchObject({ message: { content: 'make the title red' }, priority: 'next' })
    expect(t.queries()).toBe(1)
    t.release()
    await t.turn
    // the turn is over: a steer now finds nothing to take it and starts nothing
    const late = await t.a.inject({
      method: 'POST',
      url: '/api/agents/writer/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'too late', session: { folder: t.mf, id: 'live-1' }, steer: true },
    })
    expect(late.statusCode).toBe(409)
    expect(t.queries()).toBe(1)
    await t.a.close()
  })

  it('the FIRST turn of a new conversation can be steered too (live from its chat-init)', async () => {
    const t = await liveApp({ fresh: true })
    await until(() => t.read.length === 1 && t.liveId() !== null)
    const id = t.liveId()!
    writeFileSync(
      join(t.root2, t.mf, `${id}.jsonl`),
      `{"type":"user","cwd":"${t.folder2}","sessionId":"${id}","message":{"role":"user","content":"build the page"}}\n`,
    )
    await t.idx.refresh(t.mf, id)
    const r = await t.a.inject({
      method: 'POST',
      url: '/api/agents/writer/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'use blue', session: { folder: t.mf, id }, steer: true },
    })
    expect([r.statusCode, r.json()]).toEqual([202, expect.objectContaining({ steered: true })])
    await until(() => t.read.length === 2)
    expect(t.read[1]).toMatchObject({ message: { content: 'use blue' }, priority: 'next' })
    t.release()
    await t.turn
    await t.a.close()
  })

  it('an unattended turn (a run, a wake) is never steered: 409, nothing pushed', async () => {
    const t = await liveApp({ unattended: true })
    await until(() => t.queries() === 1)
    const r = await t.a.inject({
      method: 'POST',
      url: '/api/agents/writer/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'hey', session: { folder: t.mf, id: 'live-1' }, steer: true },
    })
    expect(r.statusCode).toBe(409)
    t.release()
    await t.turn
    await t.a.close()
  })
})
