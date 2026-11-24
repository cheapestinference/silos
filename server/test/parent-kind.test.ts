import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

// A console `/clear` is a NEW conversation: the session view
// says so with parentKind 'clear' — from the rotation hook's record, or from
// the transcript's own "SessionStart:clear" stamp for links filed before
// that record existed. A fork or a rotation continues its parent: no kind.
const F = '-tmp-p'
let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

const user = (text: string): string => JSON.stringify({ type: 'user', cwd: '/tmp/p', message: { role: 'user', content: text } })
const clearStamp = JSON.stringify({
  type: 'attachment',
  attachment: { type: 'hook_success', hookName: 'SessionStart:clear', hookEvent: 'SessionStart', content: '' },
})

const setup = async (files: Record<string, string[]>): Promise<LineageStore> => {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  const root = join(base, 'projects')
  mkdirSync(join(root, F), { recursive: true })
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  for (const [id, lines] of Object.entries(files)) writeFileSync(join(root, F, `${id}.jsonl`), lines.join('\n') + '\n')
  const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  const native = new NativeStore(join(base, 'data', 'native.json'))
  const lineage = new LineageStore(join(base, 'data', 'lineage.json'))
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
    store: new SessionStore(root, join(base, 'data')),
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(join(base, 'data')),
    memory: new MemoryService(root, join(base, 'data'), registry),
    lineage,
    token: 't0k',
    liveMs: 120_000,
  })
  return lineage
}

const viewOf = async (id: string): Promise<{ parentKey?: string; parentKind?: string } | undefined> => {
  const body = (await app.inject({ url: '/api/overview', headers: { 'x-token': 't0k' } })).json() as {
    agents: { sessions: { id: string; parentKey?: string; parentKind?: string }[] }[]
  }
  return body.agents.flatMap((a) => a.sessions).find((s) => s.id === id)
}

describe('parentKind — a /clear is its own conversation', () => {
  it('a child the transcript stamps as a /clear start → parentKind clear', async () => {
    const lineage = await setup({ p: [user('before')], n: [clearStamp, user('after')] })
    lineage.record(`${F}/n`, `${F}/p`)
    expect(await viewOf('n')).toMatchObject({ parentKey: `${F}/p`, parentKind: 'clear' })
  })

  it('a child the rotation hook recorded as a /clear → parentKind clear, even with no stamp', async () => {
    const lineage = await setup({ p: [user('before')], n: [user('after')] })
    const dir = mkdtempSync(join(tmpdir(), 'rot-'))
    writeFileSync(join(dir, 'n.json'), JSON.stringify({ from: 'p' }))
    lineage.absorbRotations(dir, (id) => (id === 'p' || id === 'n' ? F : null))
    expect(await viewOf('n')).toMatchObject({ parentKey: `${F}/p`, parentKind: 'clear' })
  })

  it('a fork or rotation continues its parent → no parentKind; a root has neither', async () => {
    const lineage = await setup({ p: [user('before')], n: [user('after')] })
    lineage.record(`${F}/n`, `${F}/p`)
    const n = await viewOf('n')
    expect(n?.parentKey).toBe(`${F}/p`)
    expect(n?.parentKind).toBeUndefined()
    expect(await viewOf('p')).not.toHaveProperty('parentKind')
  })
})
