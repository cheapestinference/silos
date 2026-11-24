// The task feed: extraction of the
// visible replies of machinery-sent turns from transcript turns, thread
// membership closed over lineage, the prescan+cache gate, and the fence.
// Fixtures are GENERIC turn shapes as each reader emits them — never data
// from a real installation.
import { describe, expect, it } from 'vitest'
import { cardsOf, makeTaskFeed, type FeedIndex } from '../src/task-mode/feed.js'
import { conversationIdsOf, threadMembership } from '../src/task-threads.js'
import { agentMayRead } from '../src/agent-authz.js'
import type { SessionMeta, TranscriptTurn } from '../src/types.js'
import type { LineageStore } from '../src/lineage.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REF = 'demo-plan#t1'
const WAKE = `Silos woke you for ONE task — this turn is about ${REF} «Pick an animal». Don't switch tasks.`
const WORK = `The owner opened this conversation to work ONE task — ${REF} «Pick an animal» (pending). Stay on it.`

let n = 0
function turn(part: Partial<TranscriptTurn> & { role: TranscriptTurn['role'] }): TranscriptTurn {
  return { index: n++, text: '', tools: [], ts: `2026-11-08T10:00:${String(n).padStart(2, '0')}Z`, ...part }
}
const user = (text: string, extra: Partial<TranscriptTurn> = {}) => turn({ role: 'user', text, ...extra })
const say = (text: string, extra: Partial<TranscriptTurn> = {}) => turn({ role: 'assistant', text, ...extra })

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { id, folder: 'proj', title: 'T', skills: [], cwd: null, mtime: 1000, size: 10, turnCount: 1, ...extra }
}

describe('cardsOf — extraction over one transcript', () => {
  it('a wake briefing followed by a closed reply makes one wake card', () => {
    const cards = cardsOf([user(WAKE), say('Done: dog.', { turnEnded: true })], REF, 'proj', 's1', 'ana')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ via: 'wake', agent: 'ana', folder: 'proj', sessionId: 's1', texts: ['Done: dog.'] })
  })

  it('matches through the historical [silos-context] prelude', () => {
    const cards = cardsOf([user(`[silos-context] skills here [/silos-context]\n\n${WAKE}`), say('ok', { turnEnded: true })], REF, 'p', 's', null)
    expect(cards).toHaveLength(1)
  })

  it('a work/talk briefing makes a briefed card', () => {
    const cards = cardsOf([user(WORK), say('on it', { turnEnded: true })], REF, 'p', 's', null)
    expect(cards[0]?.via).toBe('briefed')
  })

  it('joins the segments of one engine turn; the last is the answer', () => {
    const cards = cardsOf(
      [user(WAKE), say('Let me check the plan.'), say('', { tools: ['Bash'] }), say('Done: the owner chose dog.', { turnEnded: true })],
      REF,
      'p',
      's',
      null,
    )
    expect(cards[0]?.texts).toEqual(['Let me check the plan.', 'Done: the owner chose dog.'])
  })

  it('an interjection, a peer message and a compaction do NOT cut the reply; a real user turn does', () => {
    const cards = cardsOf(
      [
        user(WAKE),
        say('part one'),
        user('wait, also check X', { interjection: true }),
        user('peer says hi', { interSession: { from: 'other' } }),
        user('', { compact: true }),
        say('part two', { turnEnded: true }),
        user('a real new message'),
        say('unrelated', { turnEnded: true }),
      ],
      REF,
      'p',
      's',
      null,
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]?.texts).toEqual(['part one', 'part two'])
  })

  it('a still-open turn (no close signal) emits NO card — never partial cards that grow', () => {
    expect(cardsOf([user(WAKE), say('streaming…')], REF, 'p', 's', null)).toHaveLength(0)
  })

  it('a duration marker closes (CLI sessions); a synthetic notice closes and is not quoted', () => {
    const byMarker = cardsOf([user(WAKE), say('answer'), say('', { durationMs: 1200 })], REF, 'p', 's', null)
    expect(byMarker[0]?.texts).toEqual(['answer'])
    const bySynthetic = cardsOf([user(WAKE), say('half'), say('API error', { synthetic: true })], REF, 'p', 's', null)
    expect(bySynthetic[0]?.texts).toEqual(['half'])
  })

  it('a turn with no visible text makes no card', () => {
    expect(cardsOf([user(WAKE), say('', { tools: ['Bash'] }), say('', { durationMs: 5 })], REF, 'p', 's', null)).toHaveLength(0)
  })

  it('another ref does not match, and demo-plan#t1 does not match demo-plan#t10', () => {
    const other = `Silos woke you for ONE task — this turn is about demo-plan#t10 «Ten». Don't switch.`
    expect(cardsOf([user(other), say('x', { turnEnded: true })], REF, 'p', 's', null)).toHaveLength(0)
    expect(cardsOf([user(WAKE.replace(REF, 'other-plan#t1')), say('x', { turnEnded: true })], REF, 'p', 's', null)).toHaveLength(0)
  })

  it('two wakes in one transcript make two cards (the real demo shape)', () => {
    const cards = cardsOf(
      [user(WAKE), say('first reply', { turnEnded: true }), user('wdym mate'), user(WAKE), say('second reply', { turnEnded: true })],
      REF,
      'p',
      's',
      null,
    )
    expect(cards.map((c) => c.texts[0])).toEqual(['first reply', 'second reply'])
  })
})

describe('threadMembership — which sessions belong to a task', () => {
  const lineageOf = (parents: Record<string, string>): LineageStore =>
    ({ parentIdOf: (id: string) => parents[id] ?? null, continuationParentIdOf: (id: string) => parents[id] ?? null }) as unknown as LineageStore

  it('conversationIdsOf reads string | {session} | {id}, session first', () => {
    expect(conversationIdsOf(['a', { session: 'b' }, { id: 'c' }, { session: 's', id: 'i' }, {}, 7, ''])).toEqual(['a', 'b', 'c', 's'])
  })

  it('the listed session, and a rotation DEEPER than 8, both belong', () => {
    // root ← c1 ← c2 … ← c12: the tip is 12 hops below the listed root
    const parents: Record<string, string> = {}
    const chain = ['root', ...Array.from({ length: 12 }, (_, i) => `c${i + 1}`)]
    for (let i = 1; i < chain.length; i++) parents[chain[i]!] = chain[i - 1]!
    const metas = chain.map((id) => meta(id))
    const member = threadMembership(metas, lineageOf(parents))
    expect(member.belongs(meta('root'), ['root'])).toBe(true)
    expect(member.belongs(metas[chain.length - 1]!, ['root'])).toBe(true)
    expect(member.sessionsOf(['root'])).toHaveLength(chain.length)
  })

  it('a trashed (unindexed) listed id still names its live descendants', () => {
    const parents = { kid: 'gone', kid2: 'kid' }
    const metas = [meta('kid'), meta('kid2'), meta('stranger')]
    const member = threadMembership(metas, lineageOf(parents))
    expect(
      member
        .sessionsOf(['gone'])
        .map((m) => m.id)
        .sort(),
    ).toEqual(['kid', 'kid2'])
  })

  it('an unrelated session does not belong', () => {
    const member = threadMembership([meta('a'), meta('b')], lineageOf({}))
    expect(member.belongs(meta('b'), ['a'])).toBe(false)
  })
})

describe('makeTaskFeed — prescan and cache', () => {
  function fakeIndex(dir: string, turnsOf: Record<string, TranscriptTurn[]>, counters: { reads: number }): FeedIndex {
    return {
      hasTranscriptFile: () => true,
      pathOf: (_f, id) => join(dir, `${id}.jsonl`),
      readTurns: async (_f, id) => {
        counters.reads++
        const t = turnsOf[id]
        if (!t) throw new Error('ENOENT')
        return t
      },
    }
  }

  it('a session whose raw file lacks the marker is never parsed; the cache skips unchanged sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feed-'))
    writeFileSync(join(dir, 'with.jsonl'), `x\n${WAKE}\ny`)
    writeFileSync(join(dir, 'without.jsonl'), 'nothing here')
    const counters = { reads: 0 }
    const feed = makeTaskFeed(fakeIndex(dir, { with: [user(WAKE), say('hello', { turnEnded: true })] }, counters))
    const sessions = [meta('with'), meta('without')]
    const first = await feed(sessions, REF, () => 'ana')
    expect(first).toHaveLength(1)
    expect(counters.reads).toBe(1) // `without` was prescanned away
    const second = await feed(sessions, REF, () => 'ana')
    expect(second).toHaveLength(1)
    expect(counters.reads).toBe(1) // unchanged (size, mtime): nothing re-read
    const third = await feed([meta('with', { mtime: 2000, size: 99 })], REF, () => 'ana')
    expect(third).toHaveLength(1)
    expect(counters.reads).toBe(2) // changed: re-read
  })

  it('a transcript that cannot be read (trashed mid-request) loses its cards, the feed goes on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feed-'))
    writeFileSync(join(dir, 'ok.jsonl'), WAKE)
    writeFileSync(join(dir, 'gone.jsonl'), WAKE)
    const counters = { reads: 0 }
    const feed = makeTaskFeed(fakeIndex(dir, { ok: [user(WAKE), say('fine', { turnEnded: true })] }, counters))
    const items = await feed([meta('gone'), meta('ok')], REF, () => null)
    expect(items.map((c) => c.sessionId)).toEqual(['ok'])
  })
})

describe('the fence', () => {
  it('an agent bearer may not read the feed (read allow-list)', () => {
    expect(agentMayRead('ana', '/api/tasks/feed?key=x')).toBe(false)
  })
})
