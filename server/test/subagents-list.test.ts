import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'

// Claude Code files every Agent-tool transcript under
// root/<folder>/<id>/subagents/ — agent-<id>.jsonl plus agent-<id>.meta.json
// ({agentType, description, parentAgentId, spawnDepth, model}) and, for a
// backgrounded skill, agent-<id>.forked-skill.json ({skillName, effort}).
// The Task-tracking in context.ts only sees depth-1 spawns written to the
// MAIN transcript; a skill's own children (depth 2) never appear there, so
// the column reads this listing to show ALL the background work.
describe('listSubagents', () => {
  let base: string, root: string, index: SessionIndex, dir: string

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'deck-'))
    root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 's1.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"hi"}}\n')
    dir = join(root, '-tmp-p', 's1', 'subagents')
    mkdirSync(dir, { recursive: true })
    index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
  })

  const seed = (id: string, opts: { meta?: object; skill?: object; lines?: string[]; mtimeMsAgo?: number } = {}): void => {
    const lines = opts.lines ?? ['{"type":"user","timestamp":"2026-08-27T10:00:00.000Z","message":{"role":"user","content":"do the thing"}}']
    writeFileSync(join(dir, `agent-${id}.jsonl`), lines.join('\n') + '\n')
    if (opts.meta) writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(opts.meta))
    if (opts.skill) writeFileSync(join(dir, `agent-${id}.forked-skill.json`), JSON.stringify(opts.skill))
    if (opts.mtimeMsAgo !== undefined) {
      const t = (Date.now() - opts.mtimeMsAgo) / 1000
      utimesSync(join(dir, `agent-${id}.jsonl`), t, t)
    }
  }

  it('lists every agent with its meta, skill attribution and mtime', async () => {
    seed('a1b2c3d4e5f60718', {
      meta: {
        agentType: 'general-purpose',
        description: 'Finder: cross-file',
        toolUseId: 't1',
        parentAgentId: 'ffffffffffffffff',
        spawnDepth: 2,
        model: 'opus',
      },
    })
    seed('ffffffffffffffff', {
      meta: { agentType: 'general-purpose', description: 'code-review orchestrator', toolUseId: 't0', spawnDepth: 1 },
      skill: { skillName: 'code-review', effort: 'max' },
    })
    const subs = await index.listSubagents('-tmp-p', 's1')
    expect(subs).toHaveLength(2)
    const child = subs.find((s) => s.id === 'a1b2c3d4e5f60718')
    expect(child).toMatchObject({ description: 'Finder: cross-file', type: 'general-purpose', model: 'opus', parentId: 'ffffffffffffffff', depth: 2 })
    expect(child?.mtime).toBeGreaterThan(0)
    const parent = subs.find((s) => s.id === 'ffffffffffffffff')
    expect(parent).toMatchObject({ skill: 'code-review', depth: 1 })
    expect(parent?.parentId).toBeUndefined()
  })

  const assistant = (id: string, model: string, usage: Record<string, unknown>): string =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-27T10:00:01.000Z',
      message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage },
    })

  it('usage: sums the transcript bill, one assistant message id = one bill, model falls back to the transcript', async () => {
    seed('aaaaaaaaaaaaaaaa', {
      meta: { agentType: 'general-purpose', description: 'inherited launch', launchedWithDefaults: true },
      lines: [
        '{"type":"user","timestamp":"2026-08-27T10:00:00.000Z","message":{"role":"user","content":"go"}}',
        assistant('msg_1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
        assistant('msg_1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
        assistant('msg_2', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 20 }),
      ],
    })
    const subs = await index.listSubagents('-tmp-p', 's1')
    expect(subs[0]!.model).toBe('claude-opus-5-5')
    expect(subs[0]!.usage).toMatchObject({ input: 15, output: 120, cacheRead: 1000, cacheWrite: 50 })
    expect(subs[0]!.usage!.usd).toBeGreaterThan(0)
  })

  it('usage: each row is the sum Usage reads for its file — an id repeated far apart bills once, a nested agent counts in both', async () => {
    seed('eeeeeeeeeeeeeeee', {
      lines: [
        assistant('m1', 'claude-opus-5-5', { input_tokens: 3, output_tokens: 30, cache_read_input_tokens: 300, cache_creation_input_tokens: 7 }),
        assistant('m2', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 10 }),
        // the same message again AFTER another one (a resumed stream): one bill
        assistant('m1', 'claude-opus-5-5', { input_tokens: 3, output_tokens: 30, cache_read_input_tokens: 300, cache_creation_input_tokens: 7 }),
      ],
    })
    // a workflow agent's child, one folder down
    mkdirSync(join(dir, 'wf'), { recursive: true })
    writeFileSync(
      join(dir, 'wf', 'agent-ffffffff00000000.jsonl'),
      assistant('n1', 'claude-opus-5-5', { input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 200 }) + '\n',
    )
    const subs = await index.listSubagents('-tmp-p', 's1')
    const top = subs.find((s) => s.id === 'eeeeeeeeeeeeeeee')!
    const nested = subs.find((s) => s.id === 'ffffffff00000000')!
    expect(top.usage).toMatchObject({ input: 4, output: 40, cacheRead: 300, cacheWrite: 7 })
    expect(nested.usage).toMatchObject({ input: 2, output: 20, cacheRead: 200, cacheWrite: 0 })
    // Usage's records of the conversation: the same subagent tokens, every kind summed
    const recs = await index.usageRecords('-tmp-p', 's1')
    if (!Array.isArray(recs)) throw new Error('expected records')
    const sum = (session: string): number =>
      recs.filter((r) => r.session === session).reduce((n, r) => n + r.tokens.in + r.tokens.out + r.tokens.cacheRead + r.tokens.cacheWrite, 0)
    expect(sum('agent-eeeeeeeeeeeeeeee')).toBe(4 + 40 + 300 + 7)
    expect(sum('agent-ffffffff00000000')).toBe(2 + 20 + 200)
  })

  it('usage: grows incrementally on append and never re-bills what was already read', async () => {
    seed('bbbbbbbbbbbbbbbb', { lines: [assistant('m1', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 10 })] })
    const first = await index.listSubagents('-tmp-p', 's1')
    expect(first[0]!.usage).toMatchObject({ input: 1, output: 10 })
    const { appendFileSync } = await import('node:fs')
    appendFileSync(join(dir, 'agent-bbbbbbbbbbbbbbbb.jsonl'), assistant('m2', 'claude-opus-5-5', { input_tokens: 2, output_tokens: 20 }) + '\n')
    const again = await index.listSubagents('-tmp-p', 's1')
    expect(again[0]!.usage).toMatchObject({ input: 3, output: 30 })
  })

  it('usage: an unpriced model reports its tokens with usd null — never a lying partial figure', async () => {
    seed('cccccccccccccccc', { lines: [assistant('m1', 'some-unknown-model-9', { input_tokens: 7, output_tokens: 70 })] })
    const subs = await index.listSubagents('-tmp-p', 's1')
    expect(subs[0]!.usage).toMatchObject({ input: 7, output: 70, usd: null })
    expect(subs[0]!.model).toBe('some-unknown-model-9')
  })

  it('usage: a meta model wins the label; zero-usage and synthetic messages bill nothing', async () => {
    seed('dddddddddddddddd', {
      meta: { agentType: 'general-purpose', description: 'explicit', model: 'opus' },
      lines: [
        assistant('m1', '<synthetic>', { input_tokens: 99, output_tokens: 99 }),
        assistant('m2', 'claude-opus-5-5', { input_tokens: 0, output_tokens: 0 }),
      ],
    })
    const subs = await index.listSubagents('-tmp-p', 's1')
    expect(subs[0]!.model).toBe('opus')
    expect(subs[0]!.usage).toBeUndefined()
  })

  it('an agent with no meta.json still lists (id + mtime; the transcript is the fallback identity)', async () => {
    seed('abcdefabcdefabcd')
    const subs = await index.listSubagents('-tmp-p', 's1')
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ id: 'abcdefabcdefabcd', description: null, type: null })
  })

  it('a RECENT agent carries what it is doing now (last tool_use of the tail); a stale one is not tail-read', async () => {
    seed('1111111111111111', {
      lines: [
        '{"type":"user","timestamp":"2026-08-27T10:00:00.000Z","message":{"role":"user","content":"review"}}',
        '{"type":"assistant","timestamp":"2026-08-27T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"description":"Run the billing test suite"}}]}}',
      ],
    })
    seed('2222222222222222', {
      lines: ['{"type":"user","timestamp":"2026-08-01T00:00:00.000Z","message":{"role":"user","content":"old"}}'],
      mtimeMsAgo: 600_000,
    })
    const subs = await index.listSubagents('-tmp-p', 's1')
    const live = subs.find((s) => s.id === '1111111111111111')
    expect(live?.lastTool).toBe('Bash')
    expect(live?.lastToolDetail).toBe('Run the billing test suite')
    const stale = subs.find((s) => s.id === '2222222222222222')
    expect(stale?.lastTool).toBeUndefined()
  })

  it('what it is doing now comes from its own tool calls — a newer request blob replaying an older call never wins', async () => {
    seed('5555555555555555', {
      lines: [
        '{"type":"assistant","timestamp":"2026-08-27T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu2","name":"Grep","input":{"pattern":"needle"}}]}}',
        '{"type":"api-request-blob","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"description":"old call"}}]}}',
      ],
    })
    const subs = await index.listSubagents('-tmp-p', 's1')
    expect(subs.find((s) => s.id === '5555555555555555')).toMatchObject({ lastTool: 'Grep', lastToolDetail: 'needle' })
  })

  it('a session with no subagents dir → empty list, no error', async () => {
    expect(await index.listSubagents('-tmp-p', 'nope')).toEqual([])
  })

  it('newest first — the working set reads top-down', async () => {
    seed('3333333333333333', { mtimeMsAgo: 300_000 })
    seed('4444444444444444', { mtimeMsAgo: 1_000 })
    const subs = await index.listSubagents('-tmp-p', 's1')
    expect(subs.map((s) => s.id)).toEqual(['4444444444444444', '3333333333333333'])
  })
})

// The detail route serves the census — the column reads it from there.
import type { FastifyInstance } from 'fastify'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'

describe('detail route serves subagents', () => {
  it('GET /api/sessions/:folder/:id carries the disk census', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 's1.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"hi"}}\n')
    const dir = join(root, '-tmp-p', 's1', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent-aaaaaaaaaaaaaaaa.jsonl'),
      '{"type":"user","timestamp":"2026-08-27T10:00:00.000Z","message":{"role":"user","content":"go"}}\n',
    )
    writeFileSync(join(dir, 'agent-aaaaaaaaaaaaaaaa.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Finder A', spawnDepth: 1 }))
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
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
    const app: FastifyInstance = buildServer({
      index,
      registry,
      store: new SessionStore(root, join(base, 'data')),
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      token: 't0k',
      liveMs: 120_000,
    })
    const res = await app.inject({ url: '/api/sessions/-tmp-p/s1', headers: { 'x-token': 't0k' } })
    const body = res.json() as { subagents: { id: string; description: string | null }[] }
    expect(body.subagents).toHaveLength(1)
    expect(body.subagents[0]).toMatchObject({ id: 'aaaaaaaaaaaaaaaa', description: 'Finder A' })
    await app.close()
  })
})
