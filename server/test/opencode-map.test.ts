// node:sqlite loads through the helper (and src/harnesses/opencode/sqlite.ts).
import { DatabaseSync, makeOpenCodeDb } from './helpers/opencode-db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OpenCodeDb } from '../src/harnesses/opencode/db.js'
import { contextOf, metaOf, turnsOf } from '../src/harnesses/opencode/map.js'

// Row shapes copied from the real OpenCode DB (values synthetic).
const SESSION = {
  id: 'ses_2437',
  project_id: 'p1',
  parent_id: null,
  slug: 'curious-cactus',
  directory: '/home/u/proj',
  title: 'Uncommitted changes',
  version: '1.14.22',
  time_created: 1776984076759,
  time_updated: 1776984185646,
}
const TOKENS = { total: 16019, input: 121, output: 282, reasoning: 0, cache: { write: 0, read: 15616 } }
const USER = { role: 'user', agent: 'build', model: { providerID: 'minimax-coding-plan', modelID: 'MiniMax-M2.7' }, time: { created: 1776984169015 } }
const assistant = (over: Record<string, unknown> = {}) => ({
  role: 'assistant',
  agent: 'build',
  cost: 0,
  tokens: TOKENS,
  modelID: 'MiniMax-M2.7',
  providerID: 'minimax-coding-plan',
  time: { created: 1776984179457, completed: 1776984185638 },
  finish: 'stop',
  ...over,
})

let dir: string
let fake: ReturnType<typeof makeOpenCodeDb>
let n = 0
const part = (message_id: string, data: unknown, t = 1776984180000) =>
  fake.insertPart({ id: `prt_${++n}`, message_id, session_id: SESSION.id, time_created: t + n, data })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opencode-'))
  fake = makeOpenCodeDb(dir)
  fake.insertSession(SESSION)
  fake.insertMessage({ id: 'msg_1', session_id: SESSION.id, time_created: 1776984169015, data: USER })
  part('msg_1', { type: 'text', text: 'analyze the code' }, 1776984169015)
})
afterEach(() => {
  fake.close()
  rmSync(dir, { recursive: true, force: true })
})

function read() {
  const db = new OpenCodeDb(fake.path)
  try {
    const s = db.session(SESSION.id)!
    return { s, msgs: db.messages(SESSION.id), parts: db.parts(SESSION.id) }
  } finally {
    db.close()
  }
}

describe('opencode row → Silos mapping', () => {
  it('maps a finished user/assistant exchange into meta, turns and context', () => {
    fake.insertMessage({ id: 'msg_2', session_id: SESSION.id, time_created: 1776984179457, data: assistant() })
    part('msg_2', { type: 'reasoning', text: 'thinking about the code' })
    part('msg_2', { type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'completed', input: { filePath: '/home/u/proj/a.ts' }, output: 'x' } })
    part('msg_2', { type: 'patch', files: ['/home/u/proj/b.ts'] })
    part('msg_2', { type: 'step-finish', tokens: TOKENS, cost: 0 })
    part('msg_2', { type: 'text', text: 'There are 3 bugs' })
    const { s, msgs, parts } = read()

    const meta = metaOf(s, msgs, parts, {})
    expect(meta).toMatchObject({
      id: 'ses_2437',
      harness: 'opencode',
      folder: '-home-u-proj',
      cwd: '/home/u/proj',
      title: 'Uncommitted changes',
      model: 'minimax-coding-plan/MiniMax-M2.7',
      contextTokens: 15737,
      lastRole: 'assistant',
      turnOpen: false,
      turnCount: 1,
      startedAt: 1776984076759,
      mtime: 1776984185646,
      skills: [],
    })
    expect(meta.resumedFrom).toBeUndefined()

    const turns = turnsOf(msgs, parts)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ index: 0, role: 'user', text: 'analyze the code', ts: new Date(1776984169015).toISOString() })
    expect(turns[1].toolUses?.[0]).toMatchObject({ name: 'read', skill: null, input: '{"filePath":"/home/u/proj/a.ts"}', result: 'x', isError: false })
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      thinking: 'thinking about the code',
      text: 'There are 3 bugs',
      turnEnded: true,
      outputTokens: 282,
      tools: ['read'],
    })

    const ctx = contextOf(s, msgs, parts, null)
    expect(ctx.cost).toMatchObject({ planPriced: true, totalUsd: 0, unknownModels: false })
    expect(ctx.cost!.byModel[0]).toMatchObject({ model: 'minimax-coding-plan/MiniMax-M2.7', usd: 0, inputTokens: 121, outputTokens: 282 })
    expect(ctx.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/home/u/proj/a.ts', reads: 1 }),
        expect.objectContaining({ path: '/home/u/proj/b.ts', writes: 1 }),
      ]),
    )
    expect(ctx.tools).toEqual([{ name: 'read', server: null, count: 1 }])
    expect(ctx).toMatchObject({
      pending: null,
      agents: [],
      plan: null,
      links: { prs: [], artifacts: [], worktree: null },
      flags: { remote: false, permissionMode: null, gitBranch: null, effort: null, model: 'minimax-coding-plan/MiniMax-M2.7' },
      waiting: null,
      documents: [],
      fileHistory: [],
    })
  })

  it('keeps the turn open on tool-calls, marks compactions, and leaves priced sessions unflagged', () => {
    part('msg_1', { type: 'compaction', auto: true })
    fake.insertMessage({ id: 'msg_2', session_id: SESSION.id, time_created: 1776984179457, data: assistant({ finish: 'tool-calls', cost: 0.0123 }) })
    part('msg_2', { type: 'tool', tool: 'bash', callID: 'call_2', state: { status: 'running', input: { command: 'ls' } } })
    const { s, msgs, parts } = read()

    expect(metaOf(s, msgs, parts, {}).turnOpen).toBe(true)
    const turns = turnsOf(msgs, parts)
    expect(turns.filter((t) => t.compact)).toEqual([expect.objectContaining({ compact: true, text: '' })])
    const bash = turns.find((t) => t.toolUses)!.toolUses![0]
    expect(bash).toMatchObject({ name: 'bash', result: null, isError: false })
    expect(turns.at(-1)!.turnEnded).toBe(false)

    const ctx = contextOf(s, msgs, parts, null)
    expect(ctx.events).toEqual([expect.objectContaining({ kind: 'compact' })])
    expect(ctx.cost!.planPriced).toBeUndefined()
    expect(ctx.cost!.totalUsd).toBe(0.0123)
  })

  it('a provider refusal (assistant message with `error`, no finish) closes the turn and reads as a system band naming the cause', () => {
    // Real shape from the smoke agent's DB: Z.ai answered 429 to the owner's first prompt and
    // the column blinked "Working · model not reported yet" for good.
    const err = { name: 'APIError', data: { message: 'Insufficient balance or no resource package. Please recharge.', statusCode: 429, isRetryable: true } }
    fake.insertMessage({
      id: 'msg_2',
      session_id: SESSION.id,
      time_created: 1776984179457,
      data: assistant({
        providerID: 'zai',
        modelID: 'glm-5.1',
        finish: undefined,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        error: err,
      }),
    })
    const { s, msgs, parts } = read()
    const meta = metaOf(s, msgs, parts, {})
    expect(meta.turnOpen).toBe(false)
    expect(meta.lastRole).toBe('assistant')
    expect(meta.model).toBe('zai/glm-5.1')
    const turns = turnsOf(msgs, parts)
    expect(turns.at(-1)).toMatchObject({
      role: 'assistant',
      synthetic: true,
      turnEnded: true,
      text: 'zai: Insufficient balance or no resource package. Please recharge. (429)',
    })
    // the runs-on line reads the context flag, which must name the model even when the turn failed
    expect(contextOf(s, msgs, parts, null).flags.model).toBe('zai/glm-5.1')
  })

  it("the context flags carry the model OpenCode last answered with (the column's runs-on line reads the flag, not the meta)", () => {
    fake.insertMessage({ id: 'msg_2', session_id: SESSION.id, time_created: 1776984179457, data: assistant() })
    part('msg_2', { type: 'step-finish', tokens: TOKENS, cost: 0 })
    const { s, msgs, parts } = read()
    expect(contextOf(s, msgs, parts, null).flags.model).toBe('minimax-coding-plan/MiniMax-M2.7')
  })

  it("requestedModel: the LAST user message's provider/model and its time — what the TUI runs next", () => {
    fake.insertMessage({ id: 'msg_2', session_id: SESSION.id, time_created: 1776984179457, data: assistant() })
    fake.insertMessage({
      id: 'msg_3',
      session_id: SESSION.id,
      time_created: 1776984190000,
      data: { role: 'user', agent: 'build', model: { providerID: 'zai', modelID: 'glm-5.1' }, time: { created: 1776984190000 } },
    })
    const { s, msgs, parts } = read()
    const meta = metaOf(s, msgs, parts, {})
    expect(meta.requestedModel).toBe('zai/glm-5.1')
    expect(meta.requestedModelAt).toBe(1776984190000)
    expect(meta.model).toBe('minimax-coding-plan/MiniMax-M2.7') // the last ANSWER's model, unchanged
  })

  it('reports a model change between assistant messages as an event', () => {
    fake.insertMessage({ id: 'msg_2', session_id: SESSION.id, time_created: 1776984179457, data: assistant() })
    fake.insertMessage({
      id: 'msg_3',
      session_id: SESSION.id,
      time_created: 1776984190000,
      data: assistant({ providerID: 'anthropic', modelID: 'claude-x', time: { created: 1776984190000 } }),
    })
    const { s, msgs, parts } = read()
    const ctx = contextOf(s, msgs, parts, null)
    expect(ctx.events).toEqual([expect.objectContaining({ kind: 'model', text: 'anthropic/claude-x' })])
    expect(ctx.cost!.byModel.map((m) => m.model)).toEqual(['minimax-coding-plan/MiniMax-M2.7', 'anthropic/claude-x'])
    expect(metaOf(s, msgs, parts, {}).model).toBe('anthropic/claude-x')
  })

  it('maps an untitled child session', () => {
    fake.insertSession({ ...SESSION, id: 'ses_child', parent_id: 'ses_2437', title: '' })
    const db = new OpenCodeDb(fake.path)
    const child = db.session('ses_child')!
    db.close()
    const meta = metaOf(child, [], [], {})
    expect(meta).toMatchObject({ title: '(untitled)', resumedFrom: 'ses_2437', turnCount: 0 })
    expect(meta.lastRole).toBeUndefined()
  })

  it('lists sessions and what changed since a moment', () => {
    fake.insertSession({ ...SESSION, id: 'ses_old', time_updated: 1000 })
    const db = new OpenCodeDb(fake.path)
    try {
      expect(
        db
          .sessions()
          .map((s) => s.id)
          .sort(),
      ).toEqual(['ses_2437', 'ses_old'])
      expect(db.session('nope')).toBeNull()
      expect(db.updatedSince(5000)).toEqual([{ id: 'ses_2437', time_updated: 1776984185646 }])
      expect(db.messages(SESSION.id)[0].data.role).toBe('user')
    } finally {
      db.close()
    }
  })

  it('a read-only open refuses writes', () => {
    const db = new OpenCodeDb(fake.path)
    const ro = new DatabaseSync(fake.path, { readOnly: true })
    try {
      expect(() => ro.exec('delete from session')).toThrow()
      expect(db.sessions()).toHaveLength(1)
    } finally {
      ro.close()
      db.close()
    }
  })

  it('an assistant row without tokens maps with zeros instead of throwing', () => {
    const { tokens: _drop, ...noTokens } = assistant()
    fake.insertMessage({ id: 'msg_2', session_id: SESSION.id, time_created: 1776984179457, data: noTokens })
    fake.insertMessage({ id: 'msg_3', session_id: SESSION.id, time_created: 1776984179458, data: assistant({ tokens: { input: 5, output: 7 } }) })
    const { s, msgs, parts } = read()
    expect(metaOf(s, msgs, parts, {}).contextTokens).toBe(5)
    expect(turnsOf(msgs, parts).map((t) => t.outputTokens)).toEqual([undefined, 0, 7])
    expect(contextOf(s, msgs, parts, null).cost!.byModel[0]).toMatchObject({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })

  it('planPriced reads only finished assistant messages (a streaming one reports $0 until it completes)', () => {
    fake.insertMessage({
      id: 'msg_2',
      session_id: SESSION.id,
      time_created: 1776984179457,
      data: assistant({ time: { created: 1776984179457 }, finish: undefined }),
    })
    let { s, msgs, parts } = read()
    expect(contextOf(s, msgs, parts, null).cost!.planPriced).toBeUndefined()
    fake.insertMessage({ id: 'msg_3', session_id: SESSION.id, time_created: 1776984179458, data: assistant() })
    ;({ s, msgs, parts } = read())
    expect(contextOf(s, msgs, parts, null).cost!.planPriced).toBe(true)
  })
})
