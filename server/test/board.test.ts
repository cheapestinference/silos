import { describe, expect, it } from 'vitest'
import { boardCardOf, boardStateOf, MAX_BOARD_TOOLS } from '../src/board.js'
import type { SessionContext, SessionMeta } from '../src/types.js'

const LIVE_MS = 120_000

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    plan: null,
    agents: [],
    pending: null,
    links: { prs: [], artifacts: [], worktree: null },
    events: [],
    files: [],
    tools: [],
    flags: { remote: false, permissionMode: null, gitBranch: null, effort: null, model: null },
    waiting: null,
    ...overrides,
  }
}

describe('boardStateOf', () => {
  const now = Date.parse('2026-08-19T12:00:00.000Z')

  it("the agent's own pending rules over everything else -> needs_you", () => {
    const c = ctx({ pending: { question: '?', options: [], askedAt: '' }, waiting: { kind: 'monitor', since: '', label: '' } })
    expect(boardStateOf({ mtime: now }, c, now, LIVE_MS)).toBe('needs_you')
  })

  it('recent activity (within liveMs) -> working', () => {
    expect(boardStateOf({ mtime: now - 1000 }, null, now, LIVE_MS)).toBe('working')
  })

  it('waiting on a Monitor/wakeup/workflow (not live) -> waiting', () => {
    const c = ctx({ waiting: { kind: 'monitor', since: '', label: 'watching x' } })
    expect(boardStateOf({ mtime: now - 300_000 }, c, now, LIVE_MS)).toBe('waiting')
  })

  it('touched today, not live, no waiting -> done_today', () => {
    expect(boardStateOf({ mtime: now - 300_000 }, null, now, LIVE_MS)).toBe('done_today')
  })

  it('turn closed, a background agent silent 5 min inside a tool -> working; with nothing in flight -> done_today (work-live.ts)', () => {
    const quiet = { mtime: now - 600_000, turnOpen: false, subMtime: now - 300_000 }
    expect(boardStateOf({ ...quiet, subToolSince: now - 300_000 }, null, now, LIVE_MS)).toBe('working')
    expect(boardStateOf(quiet, null, now, LIVE_MS)).toBe('done_today')
    // a background agent outranks a Monitor wait too: it is working
    expect(boardStateOf({ ...quiet, subToolSince: now - 300_000 }, ctx({ waiting: { kind: 'monitor', since: '', label: '' } }), now, LIVE_MS)).toBe('working')
  })

  it('touched another day -> idle', () => {
    const yesterday = now - 2 * 24 * 3600_000
    expect(boardStateOf({ mtime: yesterday }, null, now, LIVE_MS)).toBe('idle')
  })
})

describe('boardCardOf', () => {
  it('includes plan done/total when there is a plan', () => {
    const meta: SessionMeta = { id: 's1', folder: 'f1', title: 'T', skills: [], cwd: '/tmp/x', mtime: 1000, size: 0, turnCount: 1 }
    const c = ctx({ plan: { tasks: [], done: 2, total: 5 } })
    const card = boardCardOf(meta, c, 2000, LIVE_MS, 'ag1', 'T')
    expect(card).toMatchObject({ folder: 'f1', id: 's1', title: 'T', agentId: 'ag1', cwd: '/tmp/x', planDone: 2, planTotal: 5 })
  })

  // Home's Working now names what a waiting conversation waits on
  it('a waiting card carries what it waits on; a live one does not', () => {
    const meta: SessionMeta = { id: 's1', folder: 'f1', title: 'T', skills: [], cwd: null, mtime: 1000, size: 0, turnCount: 1 }
    const c = ctx({ waiting: { kind: 'monitor', since: '2026-08-19T11:00:00.000Z', label: 'the deploy log' } })
    expect(boardCardOf(meta, c, 1000 + 300_000, LIVE_MS, 'ag1', 'T').waiting).toEqual({
      kind: 'monitor',
      since: '2026-08-19T11:00:00.000Z',
      label: 'the deploy log',
    })
    expect(boardCardOf(meta, c, 2000, LIVE_MS, 'ag1', 'T').waiting).toBeUndefined()
  })

  it('with no plan, carries no planDone/planTotal', () => {
    const meta: SessionMeta = { id: 's1', folder: 'f1', title: 'T', skills: [], cwd: null, mtime: 1000, size: 0, turnCount: 1 }
    const card = boardCardOf(meta, null, 2000, LIVE_MS, 'ag1', 'T')
    expect(card.planDone).toBeUndefined()
    expect(card.planTotal).toBeUndefined()
  })

  // FacetFilter: the client's "tool" facet is fed from here — real names
  // from ctx.tools, deduplicated; absent when there are none.
  it('includes tools by name (dedup) when ctx.tools has something', () => {
    const meta: SessionMeta = { id: 's1', folder: 'f1', title: 'T', skills: [], cwd: null, mtime: 1000, size: 0, turnCount: 1 }
    const c = ctx({
      tools: [
        { name: 'Bash', server: null, count: 3 },
        { name: 'Read', server: null, count: 1 },
        { name: 'Read', server: 'mcp-x', count: 2 },
      ],
    })
    expect(boardCardOf(meta, c, 2000, LIVE_MS, 'ag1', 'T').tools).toEqual(['Bash', 'Read'])
  })

  // The board payload is deliberately lean — a session with dozens of
  // distinct tools gets capped at MAX_BOARD_TOOLS.
  it('caps tools at MAX_BOARD_TOOLS names (dedup first)', () => {
    const meta: SessionMeta = { id: 's1', folder: 'f1', title: 'T', skills: [], cwd: null, mtime: 1000, size: 0, turnCount: 1 }
    const many = Array.from({ length: MAX_BOARD_TOOLS + 8 }, (_, i) => ({ name: `tool-${i}`, server: null, count: 1 }))
    const card = boardCardOf(meta, ctx({ tools: many }), 2000, LIVE_MS, 'ag1', 'T')
    expect(card.tools).toHaveLength(MAX_BOARD_TOOLS)
    expect(card.tools![0]).toBe('tool-0')
  })

  it('with no tools in the context, the field does not travel', () => {
    const meta: SessionMeta = { id: 's1', folder: 'f1', title: 'T', skills: [], cwd: null, mtime: 1000, size: 0, turnCount: 1 }
    expect(boardCardOf(meta, ctx(), 2000, LIVE_MS, 'ag1', 'T').tools).toBeUndefined()
    expect(boardCardOf(meta, null, 2000, LIVE_MS, 'ag1', 'T').tools).toBeUndefined()
  })
})
