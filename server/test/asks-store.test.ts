import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'
import { AsksStore } from '../src/asks-store.js'
import { asksNeedsYou } from '../src/needs-you.js'
import type { Agent } from '../src/types.js'

let base: string, data: string, agentState: AgentStateStore, asks: AsksStore
// replies live in a Silos-owned dir under the data dir — never in the agent's
// own state dir, which the agent can write (it could approve its own asks)
const replyDir = (agentId: string, sessionId: string): string => join(data, 'asks-replies', agentId, sessionId)

function writeAsk(agentId: string, sessionId: string, id: string, over: Record<string, unknown> = {}): string {
  const dir = join(base, agentId, 'asks', sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.json`)
  writeFileSync(
    file,
    JSON.stringify({ id, sessionId, type: 'bash', pattern: 'rm -rf dist', title: null, metadata: {}, askedAt: '2026-10-26T10:00:00.000Z', ...over }),
  )
  return file
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'asks-'))
  data = mkdtempSync(join(tmpdir(), 'asks-data-'))
  agentState = new AgentStateStore(base)
  asks = new AsksStore(agentState, { dataDir: data, ttlMs: 0 })
})

describe('AsksStore', () => {
  it('lists asks across agents, newest first, with the fields Silos shows', () => {
    writeAsk('finance', 'ses_1', 'perm_1', { askedAt: '2026-10-26T10:00:00.000Z' })
    writeAsk('writer', 'ses_2', 'perm_2', { type: 'edit', pattern: ['src/*', 'web/*'], title: 'Edit files', askedAt: '2026-10-26T11:00:00.000Z' })
    expect(asks.all()).toEqual([
      { agentId: 'writer', sessionId: 'ses_2', id: 'perm_2', type: 'edit', pattern: 'src/* web/*', title: 'Edit files', askedAt: '2026-10-26T11:00:00.000Z' },
      { agentId: 'finance', sessionId: 'ses_1', id: 'perm_1', type: 'bash', pattern: 'rm -rf dist', title: null, askedAt: '2026-10-26T10:00:00.000Z' },
    ])
  })

  it('forSession filters to one session', () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    writeAsk('finance', 'ses_2', 'perm_2')
    expect(asks.forSession('ses_2').map((a) => a.id)).toEqual(['perm_2'])
    expect(asks.forSession('ses_none')).toEqual([])
  })

  it('ignores .reply.json files, corrupt files and files whose ids disagree with their path', () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    const dir = join(base, 'finance', 'asks', 'ses_1')
    writeFileSync(join(dir, 'perm_9.reply.json'), JSON.stringify({ status: 'allow' })) // stale reply, no ask
    writeFileSync(join(dir, 'perm_bad.json'), '{nope')
    writeAsk('finance', 'ses_1', 'perm_x', { id: 'perm_other' })
    writeAsk('finance', 'ses_1', 'perm_y', { sessionId: 'ses_other' })
    expect(asks.all().map((a) => a.id)).toEqual(['perm_1'])
  })

  it('an answered ask (its reply waiting for the plugin) is no longer pending', () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    expect(asks.reply('finance', 'ses_1', 'perm_1', 'deny')).toBe('ok')
    expect(asks.all()).toEqual([])
    expect(asks.forSession('ses_1')).toEqual([])
  })

  it("reply writes <dataDir>/asks-replies/<agent>/<session>/<id>.reply.json { status, at } 0600 in 0700 dirs, never in the agent's state dir", () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    expect(asks.reply('finance', 'ses_1', 'perm_1', 'allow')).toBe('ok')
    const file = join(replyDir('finance', 'ses_1'), 'perm_1.reply.json')
    const body = JSON.parse(readFileSync(file, 'utf8'))
    expect(body).toEqual({ status: 'allow', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    for (const d of [join(data, 'asks-replies'), join(data, 'asks-replies', 'finance'), replyDir('finance', 'ses_1')])
      expect(statSync(d).mode & 0o777).toBe(0o700)
    expect(existsSync(join(base, 'finance', 'asks', 'ses_1', 'perm_1.reply.json'))).toBe(false)
  })

  it('a reply file the agent planted in its own state dir is no answer: the ask stays pending', () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    writeFileSync(join(base, 'finance', 'asks', 'ses_1', 'perm_1.reply.json'), JSON.stringify({ status: 'allow', at: 'x' }))
    expect(asks.all().map((a) => a.id)).toEqual(['perm_1'])
    expect(asks.reply('finance', 'ses_1', 'perm_1', 'deny')).toBe('ok')
    expect(JSON.parse(readFileSync(join(replyDir('finance', 'ses_1'), 'perm_1.reply.json'), 'utf8')).status).toBe('deny')
  })

  it('a second reply never overwrites the first: answered, the file keeps the first status', () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    expect(asks.reply('finance', 'ses_1', 'perm_1', 'allow')).toBe('ok')
    expect(asks.reply('finance', 'ses_1', 'perm_1', 'deny')).toBe('answered')
    expect(JSON.parse(readFileSync(join(replyDir('finance', 'ses_1'), 'perm_1.reply.json'), 'utf8')).status).toBe('allow')
    expect(readdirSync(replyDir('finance', 'ses_1'))).toEqual(['perm_1.reply.json']) // no temp file left behind
    expect(readdirSync(join(base, 'finance', 'asks', 'ses_1'))).toEqual(['perm_1.json'])
  })

  it('reply returns missing and writes nothing when the ask file is absent', () => {
    expect(asks.reply('finance', 'ses_1', 'perm_1', 'allow')).toBe('missing')
    expect(existsSync(join(base, 'finance'))).toBe(false)
    expect(existsSync(join(data, 'asks-replies'))).toBe(false)
    writeAsk('finance', 'ses_1', 'perm_1')
    expect(asks.reply('finance', 'ses_1', 'perm_2', 'allow')).toBe('missing')
    expect(existsSync(join(replyDir('finance', 'ses_1'), 'perm_2.reply.json'))).toBe(false)
  })

  it('reply refuses unsafe segments and statuses', () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    expect(asks.reply('finance', 'ses_1', '../perm_1', 'allow')).toBe('invalid')
    expect(asks.reply('finance', '..', 'perm_1', 'allow')).toBe('invalid')
    expect(asks.reply('../finance', 'ses_1', 'perm_1', 'allow')).toBe('invalid')
    expect(asks.reply('finance', 'ses_1', 'p'.repeat(129), 'allow')).toBe('invalid')
    expect(asks.reply('finance', 'ses_1', 'perm_1', 'maybe' as never)).toBe('invalid')
  })

  it('caches a scan for ttlMs, and a reply refreshes it at once', () => {
    const cached = new AsksStore(agentState, { dataDir: data, ttlMs: 60_000 })
    expect(cached.all()).toEqual([])
    writeAsk('finance', 'ses_1', 'perm_1')
    expect(cached.all()).toEqual([]) // still inside the TTL
    // a reply invalidates: the owner's own answer never lingers
    expect(cached.reply('finance', 'ses_1', 'perm_1', 'allow')).toBe('ok')
    expect(cached.all()).toEqual([])
  })
})

describe('asksNeedsYou', () => {
  const agent = (id: string): Agent => ({ id, name: id, emoji: '·', role: '', folder: '/home/u/books', skills: [] })
  const sessions = {
    ownerOf: (sid: string) => (({ ses_cfo: 'finance', ses_dev: 'writer' }) as Record<string, string>)[sid] ?? null,
    folderOf: (sid: string) => (sid === 'ses_cfo' || sid === 'ses_dev' ? '-home-u-books' : null),
  }

  it("only asks whose session the server resolves to the asking agent; peers' and unknown sessions are dropped (warned once)", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeAsk('finance', 'ses_cfo', 'perm_1', { title: 'Edit the ledger', type: 'edit', pattern: null, askedAt: '2026-10-26T12:00:00.000Z' })
    writeAsk('writer', 'ses_dev', 'perm_2')
    writeAsk('writer', 'ses_cfo', 'perm_3') // writer naming finance's session
    writeAsk('writer', 'ses_gone', 'perm_4') // a session the index cannot see
    writeAsk('ghost', 'ses_dev', 'perm_5') // not an agent
    const agents = [agent('finance'), agent('writer')]
    expect(asksNeedsYou(agents, asks.all(), sessions)).toEqual([
      {
        kind: 'ask',
        agentId: 'finance',
        sessionId: 'ses_cfo',
        folder: '-home-u-books',
        id: 'perm_1',
        title: 'Edit the ledger',
        pattern: null,
        type: 'edit',
        at: '2026-10-26T12:00:00.000Z',
      },
      {
        kind: 'ask',
        agentId: 'writer',
        sessionId: 'ses_dev',
        folder: '-home-u-books',
        id: 'perm_2',
        title: 'bash rm -rf dist',
        pattern: 'rm -rf dist',
        type: 'bash',
        at: '2026-10-26T10:00:00.000Z',
      },
    ])
    expect(warn).toHaveBeenCalledTimes(2)
    asksNeedsYou(agents, asks.all(), sessions)
    expect(warn).toHaveBeenCalledTimes(2) // once per dropped ask
    warn.mockRestore()
  })
})

// OpenCode's question tool rides the ask channel: type 'question', its
// questions and tool call; answered with label lists or rejected, never «allowed».
describe('AsksStore — questions', () => {
  const questions = [
    {
      question: 'Deploy now?',
      header: 'Deploy',
      options: [
        { label: 'Now', description: 'ship' },
        { label: 'Wait', description: '' },
      ],
    },
    {
      question: 'Regions?',
      header: '',
      options: [
        { label: 'eu', description: '' },
        { label: 'us', description: '' },
      ],
      multiple: true,
    },
  ]
  const writeQ = (over: Record<string, unknown> = {}) =>
    writeAsk('writer', 'ses_q', 'que_1', { type: 'question', pattern: null, title: 'Deploy now?', questions, callId: 'call_1', ...over })

  it('reads a question ask with its questions and tool call', () => {
    writeQ()
    expect(asks.all()).toEqual([
      {
        agentId: 'writer',
        sessionId: 'ses_q',
        id: 'que_1',
        type: 'question',
        pattern: null,
        title: 'Deploy now?',
        askedAt: '2026-10-26T10:00:00.000Z',
        questions,
        callId: 'call_1',
      },
    ])
  })

  it('a question ask without well-formed questions is no ask', () => {
    writeQ({ questions: [] })
    writeAsk('writer', 'ses_q', 'que_2', { type: 'question', questions: [{ question: 'x', options: [{ nope: 1 }] }] })
    expect(asks.all()).toEqual([])
  })

  it('answers a question with one label list per question, written for the plugin', () => {
    writeQ()
    expect(asks.reply('writer', 'ses_q', 'que_1', { answers: [['Now'], ['eu', 'us']] })).toBe('ok')
    const r = JSON.parse(readFileSync(join(replyDir('writer', 'ses_q'), 'que_1.reply.json'), 'utf8'))
    expect(r).toEqual({ status: 'answer', answers: [['Now'], ['eu', 'us']], at: expect.any(String) })
    expect(asks.all()).toEqual([])
  })

  it('a deny rejects the question', () => {
    writeQ()
    expect(asks.reply('writer', 'ses_q', 'que_1', 'deny')).toBe('ok')
    expect(JSON.parse(readFileSync(join(replyDir('writer', 'ses_q'), 'que_1.reply.json'), 'utf8')).status).toBe('deny')
  })

  it('a question is never «allowed», nor answered with the wrong number of lists; a permission never takes answers', () => {
    writeQ()
    writeAsk('writer', 'ses_q', 'perm_1')
    expect(asks.reply('writer', 'ses_q', 'que_1', 'allow')).toBe('invalid')
    expect(asks.reply('writer', 'ses_q', 'que_1', { answers: [['Now']] })).toBe('invalid')
    expect(asks.reply('writer', 'ses_q', 'que_1', { answers: [['Now'], []] })).toBe('invalid')
    expect(asks.reply('writer', 'ses_q', 'perm_1', { answers: [['Allow']] })).toBe('invalid')
    expect(existsSync(replyDir('writer', 'ses_q'))).toBe(false)
  })

  it("a question is not an Allow/Deny row on Home (it reads as its conversation's question)", () => {
    writeQ()
    writeAsk('writer', 'ses_q', 'perm_1')
    const agents = [{ id: 'writer' } as Agent]
    const rows = asksNeedsYou(agents, asks.all(), { ownerOf: () => 'writer', folderOf: () => 'f' })
    expect(rows.map((r) => r.id)).toEqual(['perm_1'])
  })
})
