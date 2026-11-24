import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

// Burying history never changes who a thread belongs to (session-owner.ts).
// The two moments the server itself must honour: trashing an ancestor
// writes the owner down for its descendants FIRST; and a chain whose root
// is already in the trash (buried before the rule existed) is read from
// there — the overview lists the thread under its real agent either way.
const user = (text: string): string =>
  JSON.stringify({ type: 'user', cwd: '/tmp/p', timestamp: '2026-10-21T10:00:00Z', message: { role: 'user', content: text } }) + '\n'
const skillCall = (skill: string): string =>
  JSON.stringify({
    type: 'assistant',
    cwd: '/tmp/p',
    timestamp: '2026-10-21T10:00:01Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] },
  }) + '\n'

async function harness() {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  const root = join(base, 'projects')
  const data = join(base, 'data')
  mkdirSync(join(root, '-tmp-p'), { recursive: true })
  mkdirSync(join(data, 'trash', '-tmp-p'), { recursive: true })
  const registry = new AgentRegistry(join(data, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder: '/tmp/p', default: true })
  registry.create({ id: 'builder', name: 'Builder', folder: '/tmp/p', skills: ['builder-skill'] })
  const index = claudeSessionIndex(root, join(data, 'cache.json'))
  const lineage = new LineageStore(join(data, 'lineage.json'))
  const native = new NativeStore(join(data, 'native.json'))
  const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
  terminals.killConsoleAndWait = async () => {}
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
  const build = () =>
    buildServer({
      index,
      registry,
      store: new SessionStore(root, data),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(data),
      memory: new MemoryService(root, data, registry),
      lineage,
      terminals,
      dataDir: data,
      token: 't0k',
      liveMs: 120_000,
    })
  const agentOf = async (app: FastifyInstance, id: string): Promise<string | undefined> => {
    const res = await app.inject({ method: 'GET', url: '/api/overview', headers: { 'x-token': 't0k' } })
    for (const a of res.json().agents as { id: string; sessions: { id: string }[] }[]) if (a.sessions.some((s) => s.id === id)) return a.id
    return undefined
  }
  return { root, data, index, lineage, build, agentOf }
}

describe('thread ownership survives the trash', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  it('trashing the root writes the owner down for its /clear child, which stays listed under that agent', async () => {
    const h = await harness()
    writeFileSync(join(h.root, '-tmp-p', 'r.jsonl'), user('you are my builder') + skillCall('builder-skill'))
    writeFileSync(join(h.root, '-tmp-p', 'c.jsonl'), user('after clear'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    app = h.build()
    expect(await h.agentOf(app, 'c')).toBe('builder')
    const res = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-p/r/trash', headers: { 'x-token': 't0k' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(readFileSync(join(h.data, 'lineage.json'), 'utf8')).owners).toEqual({ c: 'builder' })
    expect(await h.agentOf(app, 'c')).toBe('builder')
  })

  it('a root buried before the rule existed is read from the trash: the child is listed under its real agent', async () => {
    const h = await harness()
    writeFileSync(join(h.data, 'trash', '-tmp-p', 'r.jsonl'), user('you are my builder') + skillCall('builder-skill'))
    writeFileSync(join(h.root, '-tmp-p', 'c.jsonl'), user('after clear'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    app = h.build()
    expect(await h.agentOf(app, 'c')).toBe('builder')
    expect(h.lineage.ownerOf('c')).toBe('builder')
  })
})
