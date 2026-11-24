import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
import { buildServer } from '../src/server.js'
import { LineageStore } from '../src/lineage.js'
import { TerminalService } from '../src/terminal-service.js'

// Trashing a session must kill the claude that is WRITING it — which,
// after a /clear rotation, is the console keyed by an ANCESTOR id
// (consoleKeyFor), not by the trashed session's own id. Killing only the
// raw id left the live claude appending to the moved path, resurrecting
// the JSONL right after the owner deleted it (Settings › Maintenance,
// 27-08). The rule: no live console may keep writing a trashed session.
describe('trash kills the console resolved by lineage', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  it('trashing the /clear child kills the console keyed by its ancestor', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'p.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"before clear"}}\n')
    writeFileSync(join(root, '-tmp-p', 'n.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"after clear"}}\n')
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const lineage = new LineageStore(join(base, 'data', 'lineage.json'))
    lineage.record('-tmp-p/n', '-tmp-p/p')
    const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
    const killed: string[] = []
    terminals.listConsoles = async () => [{ key: 'p', attached: 0, createdMs: null }] // the rotated thread's claude lives under the ANCESTOR key
    terminals.killConsoleAndWait = async (key: string) => {
      killed.push(key)
    }
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(base, 'data', 'native.json')),
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, join(base, 'data')),
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      lineage,
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })

    const res = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-p/n/trash', headers: { 'x-token': 't0k' } })
    expect(res.statusCode).toBe(200)
    expect(killed).toContain('p') // the ancestor-keyed console dies
    expect(killed).toContain('n') // and the raw id too (a twin, if any)
  })

  it('trashing an ANCESTOR of a live thread kills NOTHING — burying history never stops live work', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'p.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"before clear"}}\n')
    writeFileSync(join(root, '-tmp-p', 'n.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"after clear"}}\n')
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const lineage = new LineageStore(join(base, 'data', 'lineage.json'))
    lineage.record('-tmp-p/n', '-tmp-p/p')
    const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
    const killed: string[] = []
    terminals.listConsoles = async () => [{ key: 'p', attached: 0, createdMs: null }] // that console is WRITING n now, not p
    terminals.killConsoleAndWait = async (key: string) => {
      killed.push(key)
    }
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(base, 'data', 'native.json')),
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, join(base, 'data')),
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      lineage,
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })

    const res = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-p/p/trash', headers: { 'x-token': 't0k' } })
    expect(res.statusCode).toBe(200)
    expect(killed).toEqual([]) // the live thread keeps its claude
  })

  // Burying history never breaks the chain: the walk from a session to its
  // console must go THROUGH ancestors the owner has already trashed (their
  // link survives in lineage.json even when the transcript is gone).
  // Otherwise the tip looks like a root, its console goes unfound, and the
  // running claude keeps writing a "deleted" conversation.
  it('trashing the tip reaches its console through a BURIED middle ancestor', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    // p (console key, still running) → b (trashed: no file) → n (the tip)
    writeFileSync(join(root, '-tmp-p', 'p.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"first"}}\n')
    writeFileSync(join(root, '-tmp-p', 'n.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"after two clears"}}\n')
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const lineage = new LineageStore(join(base, 'data', 'lineage.json'))
    lineage.record('-tmp-p/b', '-tmp-p/p')
    lineage.record('-tmp-p/n', '-tmp-p/b')
    const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
    const killed: string[] = []
    terminals.listConsoles = async () => [{ key: 'p', attached: 0, createdMs: null }]
    terminals.killConsoleAndWait = async (key: string) => {
      killed.push(key)
    }
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(base, 'data', 'native.json')),
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, join(base, 'data')),
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      lineage,
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })

    const res = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-p/n/trash', headers: { 'x-token': 't0k' } })
    expect(res.statusCode).toBe(200)
    expect(killed).toContain('p')
  })

  it('trashing a session whose live descendant hangs off it through a BURIED ancestor kills nothing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    // p (console key, still running) → b (trashed) → n (the tip, live)
    writeFileSync(join(root, '-tmp-p', 'p.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"first"}}\n')
    writeFileSync(join(root, '-tmp-p', 'n.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"after two clears"}}\n')
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const lineage = new LineageStore(join(base, 'data', 'lineage.json'))
    lineage.record('-tmp-p/b', '-tmp-p/p')
    lineage.record('-tmp-p/n', '-tmp-p/b')
    const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
    const killed: string[] = []
    terminals.listConsoles = async () => [{ key: 'p', attached: 0, createdMs: null }]
    terminals.killConsoleAndWait = async (key: string) => {
      killed.push(key)
    }
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(base, 'data', 'native.json')),
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, join(base, 'data')),
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      lineage,
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })

    const res = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-p/p/trash', headers: { 'x-token': 't0k' } })
    expect(res.statusCode).toBe(200)
    expect(killed).toEqual([]) // n still writes through p's console
  })

  it('refuses (409) to trash a conversation with a live SDK turn — the running claude would resurrect it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'n.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"live"}}\n')
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
    let killed = false
    terminals.killConsoleAndWait = async () => {
      killed = true
    }
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(base, 'data', 'native.json')),
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    chat.isSessionActive = (id: string) => id === 'n' // a chat turn is appending n's JSONL right now
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, join(base, 'data')),
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })

    const res = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-p/n/trash', headers: { 'x-token': 't0k' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('in progress')
    expect(existsSync(join(root, '-tmp-p', 'n.jsonl'))).toBe(true) // the file was NOT moved
    expect(killed).toBe(false) // and we bailed before touching consoles
  })
})
