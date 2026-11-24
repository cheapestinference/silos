// home.test.ts — Home's pure derivations: the unified inbox (one row per
// signal, engine-independent, ordered by who is literally waiting), the
// working list, and the pulse sentence.
import { describe, expect, it } from 'vitest'
import {
  HOME_CARDS,
  HOME_LIST_MAX,
  homeList,
  ceilingLine,
  doneToday,
  waitedWords,
  inboxKey,
  stillListed,
  knowsFolder,
  resolveProjectFolder,
  scopeInbox,
  scopeToFolder,
  workingNow,
  workingWord,
  type InboxItem,
} from '../src/lib/home'
import { approvalRow, askRow, escalatedRow, failedRunRow, planRow, supportRow } from './inbox-rows'
import type { AgentView, Automation, BoardCard, Run, SessionView } from '../src/lib/types'

const NOW = 1_800_000_000_000
function session(o: Partial<SessionView>): SessionView {
  return { id: 'x', folder: 'f', title: 't', mtime: NOW - 60_000, agentId: 'a', skills: [], live: false, worktree: false, native: true, ...o } as SessionView
}
function agent(id: string, sessions: SessionView[], extra: Partial<AgentView> = {}): AgentView {
  return { id, name: id.toUpperCase(), emoji: '·', folder: '/f', skills: [], sessions, liveCount: 0, sessionCount: sessions.length, ...extra }
}
function card(o: Partial<BoardCard>): BoardCard {
  return { folder: 'f', id: 'c', title: 'card', agentId: 'a', cwd: '/f', state: 'idle', mtime: NOW - 1000, ...o }
}
const run: Run = { id: 'r1', automationId: 'au1', at: new Date(NOW - 5000).toISOString(), status: 'waiting_approval' } as Run
const automation = { id: 'au1', name: 'Morning standup', agentId: 'a' } as Automation

describe("scopeInbox — the server's rows on a project page", () => {
  const proj = '/home/u/proj'
  it("by agent, Anywhere's asks by cwd, plan tasks by folder, the support summary counts only the folder's agents", () => {
    const rows: InboxItem[] = [
      askRow({ agentId: 'mine', id: 'a1' }),
      askRow({ agentId: 'master', id: 'a2', cwd: proj + '/sub' }),
      askRow({ agentId: 'master', id: 'a3', cwd: '/elsewhere' }),
      askRow({ agentId: 'other', id: 'a4', cwd: '/x' }),
      planRow({ folder: proj, file: 'a.plan.json', taskId: 't1', title: 'A', planTitle: 'P' }),
      planRow({ folder: '/x', file: 'b.plan.json', taskId: 't1', title: 'B', planTitle: 'Q' }),
      approvalRow(run, { ...automation, agentId: 'mine' }),
      approvalRow({ ...run, id: 'r2' }, { id: 'au2', name: 'Theirs', agentId: 'other' }),
      supportRow({ mine: 2, other: 3 }, NOW),
      failedRunRow({ agentId: 'mine', automationId: 'x1' }),
      failedRunRow({ agentId: 'other', automationId: 'x2' }),
      escalatedRow('master', new Date(NOW).toISOString()),
    ]
    const scoped = scopeInbox(rows, proj, new Set(['mine', 'master']), 'master')
    expect(scoped.map(inboxKey)).toEqual([
      'ask:f\0a1',
      'ask:f\0a2',
      'silo:entry:plans:folder:/home/u/proj/a/tasks/t1',
      'approval:r1',
      'silo-summary:support',
      'failed-run:x1',
      'escalated:master',
    ])
    // the folder sees only its agents' tickets, as the native summary did
    expect(scoped.find((r) => r.kind === 'siloSummary')).toMatchObject({ count: 2, agentIds: ['mine'] })
  })
  it("a support summary with none of the folder's cases leaves", () => {
    expect(scopeInbox([supportRow({ other: 1 }, NOW)], proj, new Set(['mine']), 'master')).toEqual([])
  })
})

describe('ceilingLine — past 12 loud rows the inbox says so once', () => {
  it('counts blocking + due, never routine, and names the oldest wait', () => {
    const rows = Array.from({ length: 13 }, (_, i) => failedRunRow({ automationId: `a${i}`, at: NOW - i * 3_600_000 }))
    expect(ceilingLine(rows, NOW)).toBe('13 rows — more than anyone reads; the oldest have waited 12 hours')
    expect(ceilingLine(rows.slice(0, 12), NOW)).toBeNull()
    expect(ceilingLine([...rows.slice(0, 12), planRow({ folder: '/f', file: 'p', taskId: 't', title: 't', planTitle: 'P' })], NOW)).toBeNull()
    const old = [...rows.slice(0, 12), failedRunRow({ automationId: 'z', at: NOW - 3 * 86_400_000 })]
    expect(ceilingLine(old, NOW)).toBe('13 rows — more than anyone reads; the oldest have waited 3 days')
  })
})

describe('workingNow / doneToday', () => {
  it('working = an open turn with recent activity, newest first, across agents', () => {
    const rows = workingNow(
      [
        agent('a', [session({ id: 'old', turnOpen: true, mtime: NOW - 30_000 }), session({ id: 'idle', lastRole: 'assistant' })]),
        agent('b', [session({ id: 'new', turnOpen: true, mtime: NOW - 1_000 })]),
      ],
      NOW,
    )
    expect(rows.map((r) => r.s.id)).toEqual(['new', 'old'])
  })
  // the turn closed, a background agent of it inside a long command —
  // Home's Working now lists it (the one rule, live.ts)
  it('working lists a closed-turn conversation whose background agent runs a silent tool; not one with nothing in flight', () => {
    const quiet = { turnOpen: false, lastRole: 'assistant' as const, mtime: NOW - 20 * 60_000, subMtime: NOW - 5 * 60_000 }
    const rows = workingNow([agent('a', [session({ id: 'bg', ...quiet, subToolSince: NOW - 5 * 60_000 }), session({ id: 'done', ...quiet })])], NOW)
    expect(rows.map((r) => r.s.id)).toEqual(['bg'])
  })
  it("doneToday = the Board's done_today cards, newest first", () => {
    expect(
      doneToday([card({ id: '1', state: 'done_today', mtime: 1 }), card({ id: '2', state: 'working' }), card({ id: '3', state: 'done_today', mtime: 2 })]).map(
        (c) => c.id,
      ),
    ).toEqual(['3', '1'])
  })
})

describe('workingWord — the Working now line', () => {
  it('working, its live background, or the plan step it executes', () => {
    expect(workingWord(0)).toBe('working')
    expect(workingWord(2)).toBe('working · 2 subagents')
    // a plan executed step by step names the step instead of counting it
    expect(workingWord(1, 'Step 12 · reviewing')).toBe('Step 12 · reviewing')
  })
})

describe('fleet', () => {
  it('one row per live agent, ordered: asks → working → in charge → done today → quiet; Anywhere only when it has something', async () => {
    const { fleet } = await import('../src/lib/home')
    const rows = fleet(
      [
        agent('quiet', [session({ id: 'q', lastRole: 'assistant', mtime: NOW - 5 * 86_400_000 })]),
        agent('duty', [], { mission: { text: 'keep it green', never: [], updatedAt: '2026-11-10T09:00:00Z' } }),
        agent('busy', [session({ id: 'w', turnOpen: true })]),
        agent('asking', [session({ id: 'a', pendingAsk: true, turnOpen: true })]),
        agent('master', []),
        agent('gone', [], { archived: true }),
        agent('finished', []),
      ],
      [card({ id: 'd', agentId: 'finished', state: 'done_today' })],
      NOW,
      'master',
    )
    expect(rows.map((r) => r.agent.id)).toEqual(['asking', 'busy', 'duty', 'finished', 'quiet'])
    expect(rows[3]!.done).toHaveLength(1)
  })
})

// births (plugin 0.7.0): a live nested run counts under its agent — the
// agent is working — but is never listed as one of its conversations.
describe('fleet — nested runs', () => {
  it('a working nested run lights its agent without becoming a conversation line', async () => {
    const { fleet } = await import('../src/lib/home')
    const rows = fleet(
      [agent('busy', [session({ id: 'n', turnOpen: true, origin: { kind: 'nested', parent: null, agentId: 'busy' } })]), agent('duty', [], {})],
      [],
      NOW,
      'master',
    )
    expect(rows.map((r) => r.agent.id)).toEqual(['busy', 'duty'])
    expect(rows[0]!.working).toEqual([])
    expect(rows[0]!.nested.map((s) => s.id)).toEqual(['n'])
  })
})

describe('headline', () => {
  const ago = (t: number, now: number): string => `${Math.round((now - t) / 3_600_000)}h ago`
  const name = (id: string): string => id.toUpperCase()
  // Home is a board: the tiles carry the counts, the pulse names the
  // ONE thing that matters most — never «and N more», never the plan tasks
  it("names who waits on you and since when — the counts are the tiles'", async () => {
    const { headline } = await import('../src/lib/home')
    const inbox = [
      askRow({ agentId: 'a', id: 'q', at: NOW - 4 * 3_600_000 }),
      askRow({ agentId: 'a', id: 'r', at: NOW - 3_600_000 }),
      planRow({ folder: '/f', file: 'p.plan.json', taskId: 't', title: 'Validate', planTitle: 'X' }),
    ]
    expect(headline({ inbox, working: [], agentName: name, now: NOW, ago })).toMatch(/^A .*4h ago/)
  })
  it('plan tasks alone never make the pulse — it says who works, or that all is quiet', async () => {
    const { headline } = await import('../src/lib/home')
    const inbox = [planRow({ folder: '/f', file: 'p.plan.json', taskId: 't', title: 'Validate', planTitle: 'X' })]
    expect(headline({ inbox, working: [], agentName: name, now: NOW, ago })).toBe('All quiet.')
  })
  it('falls back to who is working, then to quiet', async () => {
    const { headline } = await import('../src/lib/home')
    const w = workingNow([agent('a', [session({ turnOpen: true })]), agent('b', [session({ id: 'x', turnOpen: true })])], NOW)
    expect(headline({ inbox: [], working: w, agentName: name, now: NOW, ago })).toBe('A and B are working.')
    expect(headline({ inbox: [], working: [], agentName: name, now: NOW, ago })).toBe('All quiet.')
  })
})

// an engine Silos only has to catch up with stops nothing
describe('engineCompat — only a refusing engine waits', () => {
  const engine = (state: 'outdated' | 'missing' | 'ahead', refuses: Array<'console' | 'chat'>) => ({
    harness: 'claude-code' as const,
    name: 'Claude Code',
    state,
    installed: state === 'missing' ? null : '2.9.1',
    needed: '2.8.0',
    update: 'claude update',
    refuses,
    message: 'm',
    agentIds: ['a'],
  })
  const row = (engines: ReturnType<typeof engine>[]): InboxItem => ({
    kind: 'engineCompat',
    key: 'engine-compat',
    urgency: engines.some((e) => e.refuses.length > 0) ? 'due' : 'routine',
    at: NOW,
    voice: '',
    clears: '',
    engines,
    agentIds: ['a'],
  })
  const ago = (): string => ''
  it('ahead is routine: not waiting, never the pulse, a quiet note that blames Silos', async () => {
    const { headline, isWaiting, aheadEngines, engineHead } = await import('../src/lib/home')
    const r = row([engine('ahead', [])])
    expect(isWaiting(r)).toBe(false)
    expect(headline({ inbox: [r], working: [], agentName: (x) => x, now: NOW, ago })).toBe('All quiet.')
    expect(aheadEngines([r]).map(engineHead)).toEqual(['Silos needs an update — Claude Code 2.9.1 is newer than it was built for'])
  })
  it('outdated / missing wait and lead the pulse in their own words', async () => {
    const { headline, isWaiting } = await import('../src/lib/home')
    const out = row([engine('outdated', ['console', 'chat'])])
    expect(isWaiting(out)).toBe(true)
    expect(headline({ inbox: [out], working: [], agentName: (x) => x, now: NOW, ago })).toBe('Claude Code needs an update.')
    expect(headline({ inbox: [row([engine('missing', ['console', 'chat'])])], working: [], agentName: (x) => x, now: NOW, ago })).toBe(
      "Silos can't find Claude Code.",
    )
  })
})

// the support summary (ONE row, N tickets → /support) is
// composed by the server — server/test/inbox.test.ts
describe('headline: support summary at the top of the inbox', () => {
  it('counts the tickets instead of naming one case', async () => {
    const { headline } = await import('../src/lib/home')
    const inbox = [supportRow({ a: 1, b: 1 }, NOW - 3_600_000)]
    const ago = (t: number, now: number): string => `${Math.round((now - t) / 3_600_000)}h ago`
    const name = (id: string): string => id.toUpperCase()
    const sentence = headline({ inbox, working: [], agentName: name, now: NOW, ago })
    expect(sentence).toMatch(/^2 /)
  })
})

// the project page = Home scoped to a folder: the SAME derivations over a
// scoped input (docs/product.md surface map).
describe('scopeToFolder', () => {
  const proj = '/home/u/proj'
  it("keeps the project's agents whole, Anywhere only with its sessions inside the folder (subfolders count), drops the rest", () => {
    const scoped = scopeToFolder(
      {
        agents: [
          agent('mine', [session({ id: 'm1', cwd: '/elsewhere' })], { folder: proj }),
          agent('other', [session({ id: 'o1', cwd: proj })], { folder: '/home/u/other' }),
          agent(
            'master',
            [session({ id: 'orphan', cwd: proj + '/sub' }), session({ id: 'far', cwd: '/home/u/other' }), session({ id: 'trap', cwd: proj + 'ect' })],
            {
              folder: null,
              counts: {
                conversations: 3,
                runs: 0,
                runsByAutomation: {},
                byCwd: {
                  [proj + '/sub']: { conversations: 1, runs: 0 },
                  '/home/u/other': { conversations: 1, runs: 0 },
                  [proj + 'ect']: { conversations: 1, runs: 0 },
                },
              },
            },
          ),
        ],
        cards: [],
        needsYou: [],
        pending: [],
        automations: [],
      },
      proj,
      'master',
    )
    expect(scoped.agents.map((a) => a.id)).toEqual(['mine', 'master'])
    expect(scoped.agents[0]!.sessions.map((s) => s.id)).toEqual(['m1']) // a project agent keeps everything it owns
    expect(scoped.agents[1]!.sessions.map((s) => s.id)).toEqual(['orphan'])
    expect(scoped.agents[1]!.sessionCount).toBe(1)
  })
  it('an agent is a member through any declared territory (folders[]), not a sibling prefix', () => {
    const scoped = scopeToFolder(
      {
        agents: [agent('multi', [], { folder: '/home/u/ci', folders: [proj + '/'] }), agent('near', [], { folder: '/home/u/ci', folders: [proj + 'ect'] })],
        cards: [],
        needsYou: [],
        pending: [],
        automations: [],
      },
      proj,
      'master',
    )
    expect(scoped.agents.map((a) => a.id)).toEqual(['multi'])
  })
  it('a secondary territory is a known project folder (no "unknown project")', () => {
    const agents = [agent('multi', [], { folder: '/home/u/ci', folders: [proj] })]
    expect(knowsFolder(agents, proj)).toBe(true)
    expect(resolveProjectFolder(agents, '-home-u-proj')).toBe(proj)
  })
  it('cards by cwd; plan tasks by their folder; escalations and approvals by the agent/automation belonging to the project', () => {
    const scoped = scopeToFolder(
      {
        agents: [agent('mine', [], { folder: proj }), agent('other', [], { folder: '/x' })],
        cards: [card({ id: 'in', cwd: proj + '/pkg' }), card({ id: 'out', cwd: '/x' }), card({ id: 'none', cwd: null })],
        needsYou: [
          planRow({ folder: proj, file: 'a.plan.json', taskId: 't1', title: 'A', planTitle: 'P' }).item,
          planRow({ folder: '/x', file: 'b.plan.json', taskId: 't1', title: 'B', planTitle: 'Q' }).item,
          { kind: 'escalated', agentId: 'mine', summary: 'help', at: new Date(NOW).toISOString() },
          { kind: 'escalated', agentId: 'other', summary: 'help', at: new Date(NOW).toISOString() },
        ],
        pending: [run, { ...run, id: 'r2', automationId: 'au2' }],
        automations: [{ ...automation, agentId: 'mine' }, { id: 'au2', name: 'Theirs', agentId: 'other' } as Automation],
      },
      proj,
      'master',
    )
    expect(scoped.cards.map((c) => c.id)).toEqual(['in'])
    expect(scoped.needsYou.map((n) => (n.kind === 'silo' ? n.identity : n.agentId))).toEqual(['A', 'mine'])
    expect(scoped.pending.map((r) => r.id)).toEqual(['r1'])
    expect(scoped.automations.map((a) => a.id)).toEqual(['au1'])
  })
})

// Home learns about background work — per-conversation live/total
// counts derived from the same /api/tasks payload the Tasks page uses.
describe('backgroundBySession', () => {
  it('counts live vs total per conversation key', async () => {
    const { backgroundBySession } = await import('../src/lib/home')
    const map = backgroundBySession(
      [
        {
          folder: 'f',
          id: 's1',
          title: 'x',
          agentId: 'a',
          cwd: null,
          mtime: NOW,
          subagents: [
            { id: 'v1', description: null, type: null, mtime: NOW - 30_000 }, // live (<2min)
            { id: 'v2', description: null, type: null, mtime: NOW - 3 * 3600_000 }, // finished
          ],
        },
      ],
      NOW,
    )
    expect(map.get('f/s1')).toEqual({ live: 1, total: 2, execution: null })
    expect(map.get('f/nope')).toBeUndefined()
  })
})

describe('waitedWords — the same words as the server rows', () => {
  it('minutes, hours, days', () => {
    expect(waitedWords(40 * 60_000)).toBe('40 min')
    expect(waitedWords(3 * 3_600_000)).toBe('3 h')
    expect(waitedWords(49 * 3_600_000)).toBe('2 d')
  })
})

describe("stillListed — a row hidden on the owner's gesture", () => {
  const row = (key: string): InboxItem => ({ key }) as unknown as InboxItem
  it('stays hidden while the server still lists it; forgotten once it left — the same task asking again shows', () => {
    const hidden = new Set(['silo:entry:plans:t1', 'silo:entry:plans:t2'])
    // the write has not landed in this reading yet: both still hidden, same set
    expect(stillListed(hidden, [row('silo:entry:plans:t1'), row('silo:entry:plans:t2')])).toBe(hidden)
    // t1's row left (answered): its key is forgotten, so a second question on t1 is a new row
    expect([...stillListed(hidden, [row('silo:entry:plans:t2')])]).toEqual(['silo:entry:plans:t2'])
    expect(stillListed(new Set(), [row('x')]).size).toBe(0)
  })
})

describe("homeList — Home's one list: what holds someone up, then the owner's own", () => {
  const holds = ['h1', 'h2', 'h3', 'h4', 'h5']
  const yours = ['y1', 'y2', 'y3', 'y4']
  it("puts every row that holds someone up before the owner's own, in their order, bounded", () => {
    const l = homeList(holds, yours, () => false)
    expect(l.rows.map((r) => r.item)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'y1', 'y2'].slice(0, HOME_LIST_MAX))
    expect(l.rows.every((r, i) => r.holds === i < holds.length)).toBe(true)
  })
  it('drops nothing: what it leaves out is counted for its doors, by kind', () => {
    for (const [h, y] of [
      [holds, yours],
      [[...holds, ...holds, 'h0'], yours],
      [[], yours],
      [holds, []],
      [[], []],
    ] as const) {
      const l = homeList(h, y, () => false)
      expect(l.rows.length + l.hiddenHolds + l.hiddenYours).toBe(h.length + y.length)
      expect(l.rows.filter((r) => r.holds).length + l.hiddenHolds).toBe(h.length)
      expect(l.rows.length).toBe(Math.min(HOME_LIST_MAX, h.length + y.length))
    }
  })
  it('draws large at most the first two shown rows that hold someone up with a question — never an own task', () => {
    const l = homeList(['a', 'q1', 'q2', 'q3'], ['qy'], (i) => i.startsWith('q'))
    expect(l.rows.filter((r) => r.card).map((r) => r.item)).toEqual(['q1', 'q2'].slice(0, HOME_CARDS))
    const late = homeList([...Array.from({ length: HOME_LIST_MAX }, (_, i) => `h${i}`), 'q'], [], (i) => i === 'q')
    expect(late.rows.some((r) => r.card)).toBe(false)
  })
})
