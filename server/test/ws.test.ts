import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
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

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

const fakeChat = (registry: AgentRegistry, native: NativeStore): ChatService =>
  new ChatService({
    registry,
    native,
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {},
      async interrupt() {
        return undefined
      },
    }),
  })

describe('ws', () => {
  it('hello on connect and session on index refresh', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const store = new SessionStore(root, join(base, 'data'))
    const native = new NativeStore(join(base, 'data', 'native.json'))
    const prefs = new PrefsStore(join(base, 'data'))
    const memory = new MemoryService(root, join(base, 'data'), registry)
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat: fakeChat(registry, native),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs,
      memory,
      token: 't0k',
      liveMs: 120_000,
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port

    const seen: { ev: string }[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=t0k`)
    ws.on('message', (d) => seen.push(JSON.parse(String(d))))
    await new Promise((r) => ws.once('open', r))

    writeFileSync(join(root, '-tmp-p', 'n.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"hi"}}\n')
    await index.refresh('-tmp-p', 'n') // no watcher in this test: direct refresh

    await new Promise((r) => setTimeout(r, 200))
    ws.close()
    expect(seen[0]).toMatchObject({ ev: 'hello' })
    expect(seen.some((m) => m.ev === 'session')).toBe(true)
    // every session event carries the agents' uncapped totals: the client's
    // lists are capped, it can't count from them
    const ev = seen.find((m) => m.ev === 'session') as { counts?: Record<string, { conversations: number; runs: number }> }
    expect(Object.values(ev.counts ?? {}).reduce((n, c) => n + c.conversations + c.runs, 0)).toBe(1)
  })

  it('a bad token -> connection rejected without hello', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const store = new SessionStore(root, join(base, 'data'))
    const native = new NativeStore(join(base, 'data', 'native.json'))
    const prefs = new PrefsStore(join(base, 'data'))
    const memory = new MemoryService(root, join(base, 'data'), registry)
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat: fakeChat(registry, native),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs,
      memory,
      token: 't0k',
      liveMs: 120_000,
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port

    const seen: unknown[] = []
    // the upgrade must look REMOTE (tunnel header) — a local WS with a bad
    // token already gets in without auth by design (isLocalRequest).
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=MAL`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })
    ws.on('message', (d) => seen.push(JSON.parse(String(d))))
    ws.on('error', () => {
      /* the rejection may arrive as an error: we wait for close either way */
    })
    await new Promise<void>((resolve) => ws.once('close', () => resolve()))
    expect(seen).toHaveLength(0) // hello never arrived
  })

  it("a console's /clear rotation is absorbed BEFORE the session event is broadcast — the new session carries parentKey", async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const store = new SessionStore(root, join(base, 'data'))
    const native = new NativeStore(join(base, 'data', 'native.json'))
    const prefs = new PrefsStore(join(base, 'data'))
    const memory = new MemoryService(root, join(base, 'data'), registry)
    const lineage = new LineageStore(join(base, 'data', 'lineage.json'))
    const rotationsDir = join(base, 'data', 'console-rotations')
    const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock'), rotationsDir })
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat: fakeChat(registry, native),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs,
      memory,
      lineage,
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port

    // the parent session (the console's claude before /clear) is indexed
    writeFileSync(join(root, '-tmp-p', 'p.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"before clear"}}\n')
    await index.refresh('-tmp-p', 'p')

    const seen: { ev: string; meta?: { id: string; parentKey?: string } }[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=t0k`)
    ws.on('message', (d) => seen.push(JSON.parse(String(d))))
    await new Promise((r) => ws.once('open', r))

    // /clear: the SessionStart hook files the rotation, then claude writes the new JSONL
    writeFileSync(join(rotationsDir, 'n.json'), JSON.stringify({ from: 'p' }))
    writeFileSync(join(root, '-tmp-p', 'n.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"after clear"}}\n')
    await index.refresh('-tmp-p', 'n')

    await new Promise((r) => setTimeout(r, 200))
    ws.close()
    const ev = seen.find((m) => m.ev === 'session' && m.meta?.id === 'n')
    expect(ev?.meta?.parentKey).toBe('-tmp-p/p')
  })
})
