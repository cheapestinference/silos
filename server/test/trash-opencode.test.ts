import { makeOpenCodeDb } from './helpers/opencode-db.js'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
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
import { TerminalService } from '../src/terminal-service.js'
import { OpenCodeReader } from '../src/harnesses/opencode/reader.js'

// An OpenCode session lives in a database Silos never writes (invariant 3):
// Delete HIDES it (<dataDir>/hidden/opencode.json) instead of moving a
// JSONL that does not exist.
describe('trash of an OpenCode session', () => {
  let app: FastifyInstance
  let reader: OpenCodeReader
  afterEach(async () => {
    await app?.close()
    reader?.close()
  })

  it('hides it: 200 { hidden: true }, no file moved, gone from the index', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-oc-'))
    const root = join(base, 'projects')
    const data = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(data)
    mkdirSync(join(base, 'oc'))
    const oc = makeOpenCodeDb(join(base, 'oc'))
    oc.insertSession({ id: 'ses_g1', project_id: 'p1', directory: '/home/u/other', title: 'other', version: '1.14.22', time_created: 1, time_updated: 2 })
    oc.close()
    const registry = new AgentRegistry(join(data, 'agents.json'))
    registry.load()
    const index = claudeSessionIndex(root, join(data, 'cache.json'))
    reader = new OpenCodeReader({ dataDir: data, registry, globalDb: oc.path, muted: [], ephemeralPrefix: null })
    index.addReader(reader)
    await index.init()
    index.stopHeartbeat()
    const store = new SessionStore(root, data)
    const trashSpy = vi.spyOn(store, 'trash')
    const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
    const holdersSpy = vi.spyOn(terminals, 'holdersOf')
    terminals.killConsoleAndWait = async () => {}
    const native = new NativeStore(join(data, 'native.json'))
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
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(data),
      memory: new MemoryService(root, data, registry),
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })
    const removed = vi.fn()
    index.on('removed', removed)

    const res = await app.inject({ method: 'POST', url: '/api/sessions/-home-u-other/ses_g1/trash', headers: { 'x-token': 't0k' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ hidden: true })
    expect(trashSpy).not.toHaveBeenCalled()
    expect(holdersSpy).not.toHaveBeenCalled()
    expect(removed).toHaveBeenCalledTimes(1)
    expect(index.allSessions().some((m) => m.id === 'ses_g1')).toBe(false)
    expect(Object.keys(JSON.parse(readFileSync(join(data, 'hidden', 'opencode.json'), 'utf8')))).toEqual(['ses_g1'])
    expect(existsSync(join(data, 'trash'))).toBe(false)

    const unknown = await app.inject({ method: 'POST', url: '/api/sessions/-home-u-other/ses_nope/trash', headers: { 'x-token': 't0k' } })
    expect(unknown.statusCode).toBe(404)
  })
})
