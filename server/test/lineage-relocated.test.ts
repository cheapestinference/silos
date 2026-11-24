import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { LineageStore } from '../src/lineage.js'

// Claude Code RELOCATES a transcript when the session enters a worktree
// (`relocated` / `worktree-state` records): the parent's JSONL moves from
// `-home-x` to `-home-x--claude-worktrees-w`, while its `/clear` rotation
// is born back in `-home-x`. A parentKey that bakes the folder in stops
// matching anything in the overview and the sidebar shows the SAME thread
// twice under two URLs. Session ids are UUIDs, so
// the id alone is the identity: the parent must be resolved by id to
// wherever it lives NOW.
const WT = '-tmp-p--claude-worktrees-w'
const MAIN = '-tmp-p'

let app: FastifyInstance
afterEach(async () => {
  await app?.close()
})

const setup = async (): Promise<{ lineage: LineageStore; index: SessionIndex }> => {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  const root = join(base, 'projects')
  mkdirSync(join(root, MAIN), { recursive: true })
  mkdirSync(join(root, WT), { recursive: true })
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  writeFileSync(join(root, WT, 'p.jsonl'), '{"type":"user","cwd":"/tmp/p/.claude/worktrees/w","message":{"role":"user","content":"before clear"}}\n')
  writeFileSync(join(root, MAIN, 'n.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"after clear"}}\n')
  const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  const store = new SessionStore(root, join(base, 'data'))
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
    store,
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
  return { lineage, index }
}

const parentKeyOf = async (id: string): Promise<string | null | undefined> => {
  const body = (await app.inject({ url: '/api/overview', headers: { 'x-token': 't0k' } })).json() as {
    agents: { sessions: { id: string; parentKey?: string | null }[] }[]
  }
  return body.agents.flatMap((a) => a.sessions).find((s) => s.id === id)?.parentKey
}

describe('lineage across a relocated transcript', () => {
  it('parent recorded under its OLD folder (indexed there before the worktree relocation) → parentKey points where it lives now', async () => {
    const { lineage } = await setup()
    lineage.record(`${MAIN}/n`, `${MAIN}/p`)
    expect(await parentKeyOf('n')).toBe(`${WT}/p`)
  })

  it("child recorded under the PARENT's folder (absorbRotations' same-folder assumption) → still resolved by id", async () => {
    const { lineage } = await setup()
    lineage.record(`${WT}/n`, `${WT}/p`)
    expect(await parentKeyOf('n')).toBe(`${WT}/p`)
  })

  // Burying history never breaks the chain: a parentKey must name a session
  // the client HAS — pointing at a trashed one split ONE console into two
  // sidebar rows (a conversation and its /clear child, both
  // hanging off an ancestor removed in Maintenance).
  it('a parent no longer indexed anywhere → parentKey is the nearest ancestor that still is', async () => {
    const { lineage, index } = await setup()
    lineage.record(`${MAIN}/n`, `${MAIN}/gone`) // `gone` was trashed…
    lineage.record(`${MAIN}/gone`, `${WT}/p`) // …but it descended from p, which is still here
    expect(index.allSessions().some((m) => m.id === 'gone')).toBe(false)
    expect(await parentKeyOf('n')).toBe(`${WT}/p`)
  })

  it('no ancestor indexed at all → no parentKey (an honest root, not a dangling link)', async () => {
    const { lineage } = await setup()
    lineage.record(`${MAIN}/n`, `${MAIN}/gone`)
    expect(await parentKeyOf('n')).toBeUndefined()
  })
})
