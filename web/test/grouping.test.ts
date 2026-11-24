// grouping.test.ts — groupTurns groups consecutive assistant turns that
// are "tools only" (no text) into streaks to compact the transcript
// (many tool calls, one per line, is ugly).
import { describe, expect, it } from 'vitest'
import {
  splitArchived,
  chainTip,
  applyAgentOrder,
  orderWithSlots,
  fixAt,
  releaseSlot,
  moveBefore,
  groupChains,
  groupTurns,
  INACTIVE_MS,
  MAX_RECENT_TOPICS,
  MIN_RECENT_TOPICS,
  sortGroups,
  splitRecent,
  type SortableGroup,
} from '../src/lib/grouping'
import type { SessionView, Turn } from '../src/lib/types'

function t(overrides: Partial<Turn>): Turn {
  return { index: 0, role: 'assistant', text: '', tools: [], ts: null, ...overrides }
}

describe('groupTurns', () => {
  it('groups consecutive tools-only assistant turns into a streak; the rest stays loose', () => {
    const turns: Turn[] = [
      t({ index: 0, role: 'user', text: 'hello', tools: [] }),
      t({ index: 1, role: 'assistant', text: '', tools: ['Bash'] }),
      t({ index: 2, role: 'assistant', text: '', tools: ['Grep'] }),
      t({ index: 3, role: 'assistant', text: 'reply', tools: [] }),
      t({ index: 4, role: 'assistant', text: '', tools: ['Read'] }),
    ]
    const out = groupTurns(turns)
    expect(out).toHaveLength(4)
    expect(out[0]).toEqual({ kind: 'turn', turn: turns[0] })
    expect(out[1]).toEqual({ kind: 'streak', turns: [turns[1], turns[2]] })
    expect(out[2]).toEqual({ kind: 'turn', turn: turns[3] })
    expect(out[3]).toEqual({ kind: 'streak', turns: [turns[4]] })
  })

  it('respects order — does not merge streaks separated by a normal turn', () => {
    const turns: Turn[] = [
      t({ index: 0, role: 'assistant', text: '', tools: ['A'] }),
      t({ index: 1, role: 'assistant', text: 'text', tools: [] }),
      t({ index: 2, role: 'assistant', text: '', tools: ['B'] }),
    ]
    const out = groupTurns(turns)
    expect(out.map((b) => b.kind)).toEqual(['streak', 'turn', 'streak'])
  })

  it('an assistant turn with empty text but NO tools does not count as a streak', () => {
    const turns: Turn[] = [t({ index: 0, role: 'assistant', text: '', tools: [] })]
    const out = groupTurns(turns)
    expect(out).toEqual([{ kind: 'turn', turn: turns[0] }])
  })

  it('a user turn never enters a streak even with no text', () => {
    const turns: Turn[] = [t({ index: 0, role: 'user', text: '', tools: [] })]
    const out = groupTurns(turns)
    expect(out).toEqual([{ kind: 'turn', turn: turns[0] }])
  })

  it('an empty array → []', () => {
    expect(groupTurns([])).toEqual([])
  })
})

// sortGroups decides the order + tray of the Sidebar's per-folder groups —
// a pure function, no DOM. MANUAL only: projects never
// reorder by activity or liveness; the incoming (registry) order is kept
// unless the owner pinned/dragged.
const NOW = 1_700_000_000_000

function g(folder: string | null): SortableGroup {
  return { folder }
}

describe('sortGroups', () => {
  it('with no prefs, keeps the incoming order untouched (no activity/live reorder)', () => {
    const groups = [g('/c'), g('/a'), g('/b')]
    const { active, inactive } = sortGroups(groups, {})
    expect(active.map((x) => x.folder)).toEqual(['/c', '/a', '/b'])
    expect(inactive).toEqual([])
  })

  it('pinned goes first, in `order`; the rest keep their incoming order', () => {
    const groups = [g('/x'), g('/a'), g('/y'), g('/b')]
    const { active } = sortGroups(groups, { pinned: ['/a', '/b'], order: ['/b', '/a'] })
    expect(active.map((x) => x.folder)).toEqual(['/b', '/a', '/x', '/y'])
  })

  it('a pinned key missing from `order` goes after the ordered pinned ones, before the unpinned', () => {
    const groups = [g('/u'), g('/p2'), g('/p1')]
    const { active } = sortGroups(groups, { pinned: ['/p1', '/p2'], order: ['/p1'] })
    expect(active.map((x) => x.folder)).toEqual(['/p1', '/p2', '/u'])
  })

  it('inPool (by hand) → goes to inactive, whatever its activity', () => {
    const groups = [g('/normal'), g('/stashed')]
    const { active, inactive } = sortGroups(groups, { inPool: ['/stashed'] })
    expect(active.map((x) => x.folder)).toEqual(['/normal'])
    expect(inactive.map((x) => x.folder)).toEqual(['/stashed'])
  })

  it('folder null (agents with no folder) uses the "" key and can be pinned like any other group', () => {
    const groups = [g('/a'), g(null)]
    const { active, inactive } = sortGroups(groups, { pinned: [''], order: [''] })
    expect(active.map((x) => x.folder)).toEqual([null, '/a'])
    expect(inactive).toEqual([])
  })

  it('an empty array → empty active and inactive', () => {
    expect(sortGroups([], {})).toEqual({ active: [], inactive: [] })
  })
})

// --- chains ---------------------------------------------------------

function s(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'session',
    skills: [],
    cwd: null,
    mtime: NOW,
    size: 10,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...overrides,
  }
}

describe('groupChains — detached', () => {
  it('a detached child ignores its parent link and heads its own chain; its own ancestors still hang from it', () => {
    const sessions = [
      s({ id: 'root', mtime: NOW - 3000 }),
      s({ id: 'mid', mtime: NOW - 2000, parentKey: 'f/root' }),
      s({ id: 'leaf', mtime: NOW - 1000, parentKey: 'f/mid' }),
    ]
    const chains = groupChains(sessions, new Set(['f/mid']))
    expect(chains.map((c) => [c.head.id, c.earlier.map((e) => e.id)])).toEqual([
      ['leaf', ['mid']],
      ['root', []],
    ])
  })
})

describe('groupChains — a /clear is its own conversation', () => {
  it('a child started by /clear heads its own chain; a continuation still joins', () => {
    const a = s({ id: 'a', mtime: NOW - 30_000 })
    const b = s({ id: 'b', mtime: NOW - 20_000, parentKey: 'f/a' }) // --resume of a
    const c = s({ id: 'c', mtime: NOW - 10_000, parentKey: 'f/b', parentKind: 'clear' }) // /clear in b's console
    const chains = groupChains([a, b, c])
    expect(chains.map((ch) => [ch.head.id, ch.earlier.map((x) => x.id)])).toEqual([
      ['c', []],
      ['b', ['a']],
    ])
  })
})

describe('groupChains', () => {
  it('with no parentKey, each session is its own single-member chain', () => {
    const sessions = [s({ id: 'a', mtime: NOW }), s({ id: 'b', mtime: NOW - 1000 })]
    const chains = groupChains(sessions)
    expect(chains).toHaveLength(2)
    expect(chains.every((c) => c.earlier.length === 0)).toBe(true)
  })

  it('a simple fork (a child with parentKey) forms a chain of 2: head=the most recent', () => {
    const original = s({ id: 'orig', mtime: NOW - 5000 })
    const fork = s({ id: 'fork', mtime: NOW, parentKey: 'f/orig' })
    const chains = groupChains([original, fork])
    expect(chains).toHaveLength(1)
    expect(chains[0]!.head.id).toBe('fork')
    expect(chains[0]!.earlier.map((x) => x.id)).toEqual(['orig'])
  })

  it('rotation after rotation resolves transitively: a chain of 3, head is the newest', () => {
    const a = s({ id: 'a', mtime: NOW - 20_000 })
    const b = s({ id: 'b', mtime: NOW - 10_000, parentKey: 'f/a' })
    const c = s({ id: 'c', mtime: NOW, parentKey: 'f/b' })
    // input order deliberately shuffled — it must not matter
    const chains = groupChains([b, c, a])
    expect(chains).toHaveLength(1)
    expect(chains[0]!.head.id).toBe('c')
    expect(chains[0]!.earlier.map((x) => x.id)).toEqual(['b', 'a']) // mtime desc
  })

  it('a parentKey pointing outside the set (another agent, or deleted) joins nothing', () => {
    const fork = s({ id: 'fork', mtime: NOW, parentKey: 'f/not-here' })
    const loose = s({ id: 'loose', mtime: NOW - 1000 })
    const chains = groupChains([fork, loose])
    expect(chains).toHaveLength(2)
    expect(chains.every((c) => c.earlier.length === 0)).toBe(true)
  })

  it("sorts chains by the head's mtime, desc", () => {
    const old = s({ id: 'old', mtime: NOW - 5000 })
    const recent = s({ id: 'recent', mtime: NOW })
    const chains = groupChains([old, recent])
    expect(chains.map((c) => c.head.id)).toEqual(['recent', 'old'])
  })

  it('an empty array → no chains', () => {
    expect(groupChains([])).toEqual([])
  })
})

// --- recent vs older topics ---

function chain(id: string, mtime: number): { head: SessionView; earlier: SessionView[] } {
  return { head: s({ id, mtime }), earlier: [] }
}

describe('splitRecent', () => {
  it('MAX_RECENT_TOPICS=5, MIN_RECENT_TOPICS=3', () => {
    expect(MAX_RECENT_TOPICS).toBe(5)
    expect(MIN_RECENT_TOPICS).toBe(3)
  })

  it('fewer chains than the minimum (3): all go to recent, nothing folds', () => {
    const chains = [chain('a', NOW), chain('b', NOW - 1000)]
    const { recent, old } = splitRecent(chains, NOW)
    expect(recent).toEqual(chains)
    expect(old).toEqual([])
  })

  it('more active chains than the maximum (5): caps at 5, the rest folds', () => {
    const chains = Array.from({ length: 8 }, (_, i) => chain(`c${i}`, NOW - i * 1000))
    const { recent, old } = splitRecent(chains, NOW)
    expect(recent.map((c) => c.head.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(old.map((c) => c.head.id)).toEqual(['c5', 'c6', 'c7'])
  })

  it('few active chains (within INACTIVE_MS) but more inactive ones: fills up to the minimum (3)', () => {
    const chains = [
      chain('active', NOW - 1000), // within INACTIVE_MS
      chain('inactive1', NOW - INACTIVE_MS - 1000),
      chain('inactive2', NOW - INACTIVE_MS - 2000),
      chain('inactive3', NOW - INACTIVE_MS - 3000),
    ]
    const { recent, old } = splitRecent(chains, NOW)
    // 1 active + filled up to 3 (the floor) — not up to 4.
    expect(recent.map((c) => c.head.id)).toEqual(['active', 'inactive1', 'inactive2'])
    expect(old.map((c) => c.head.id)).toEqual(['inactive3'])
  })

  it('all inactive and fewer than 3: does not blow up, shows whatever there is', () => {
    const chains = [chain('a', NOW - INACTIVE_MS - 1), chain('b', NOW - INACTIVE_MS - 2)]
    const { recent, old } = splitRecent(chains, NOW)
    expect(recent).toEqual(chains)
    expect(old).toEqual([])
  })

  it('does not reorder — respects input order (already mtime desc, see groupChains)', () => {
    const chains = [chain('z', NOW), chain('a', NOW - 500), chain('m', NOW - 999)]
    const { recent } = splitRecent(chains, NOW)
    expect(recent.map((c) => c.head.id)).toEqual(['z', 'a', 'm'])
  })

  it('an empty array → both empty', () => {
    expect(splitRecent([], NOW)).toEqual({ recent: [], old: [] })
  })
})

describe('orderWithSlots / fixAt / releaseSlot', () => {
  const NOW = 1_700_000_000_000
  const chain = (id: string, mtime: number, earlier: string[] = []) => ({
    head: { folder: 'f', id, mtime },
    earlier: earlier.map((e) => ({ folder: 'f', id: e })),
  })
  const ids = (cs: { head: { id: string } }[]) => cs.map((c) => c.head.id)
  it('no slots → newest activity first', () => {
    const { ordered, fixed } = orderWithSlots([chain('a', NOW - 9), chain('b', NOW), chain('c', NOW - 3)], [])
    expect(ids(ordered)).toEqual(['b', 'c', 'a'])
    expect(fixed.size).toBe(0)
  })
  it('a fixed conversation holds its index; the others flow around it by activity', () => {
    const chains = [chain('a', NOW), chain('b', NOW - 1), chain('c', NOW - 2), chain('old', NOW - 99)]
    expect(ids(orderWithSlots(chains, [{ key: 'f/old', at: 1 }]).ordered)).toEqual(['a', 'old', 'b', 'c'])
    // c becomes the newest: it rises above a, old stays second
    const moved = [chain('a', NOW), chain('b', NOW - 1), chain('c', NOW + 5), chain('old', NOW - 99)]
    expect(ids(orderWithSlots(moved, [{ key: 'f/old', at: 1 }]).ordered)).toEqual(['c', 'old', 'a', 'b'])
  })
  it('an index past the end lands last; a clash takes the next free place', () => {
    const chains = [chain('a', NOW), chain('b', NOW - 1), chain('c', NOW - 2)]
    expect(ids(orderWithSlots(chains, [{ key: 'f/a', at: 9 }]).ordered)).toEqual(['b', 'c', 'a'])
    expect(
      ids(
        orderWithSlots(chains, [
          { key: 'f/c', at: 0 },
          { key: 'f/b', at: 0 },
        ]).ordered,
      ),
    ).toEqual(['c', 'b', 'a'])
  })
  it('a rotated chain (new head, old head among its earlier) keeps its fixed place', () => {
    const { ordered } = orderWithSlots([chain('a', NOW), chain('b2', NOW - 5, ['b'])], [{ key: 'f/b', at: 0 }])
    expect(ids(ordered)).toEqual(['b2', 'a'])
  })
  it('fixAt: fixed ones in the way (contiguous from the drop) move one place down; others stay', () => {
    expect(
      fixAt(
        [
          { key: 'f/x', at: 0 },
          { key: 'f/y', at: 1 },
          { key: 'f/z', at: 4 },
        ],
        chain('c', NOW),
        0,
      ),
    ).toEqual([
      { key: 'f/c', at: 0 },
      { key: 'f/x', at: 1 },
      { key: 'f/y', at: 2 },
      { key: 'f/z', at: 4 },
    ])
    // moving an already-fixed one: its old slot is freed first
    expect(fixAt([{ key: 'f/c', at: 3 }], chain('c', NOW), 1)).toEqual([{ key: 'f/c', at: 1 }])
  })
  it('releaseSlot drops every key of the chain, old head included', () => {
    expect(
      releaseSlot(
        [
          { key: 'f/a', at: 0 },
          { key: 'f/b', at: 2 },
        ],
        chain('b2', NOW, ['b']),
      ),
    ).toEqual([{ key: 'f/a', at: 0 }])
  })
})

// The owner pins a PLACE for their work, not a session id: when a /clear
// continues the thread in a new conversation, the pin follows it and the
// cleared-away transcript goes back to flowing by activity (otherwise a
// pinned check-in keeps its slot after the /clear while the live terminal
// flows below it). Resolution at read time — stored prefs stay as written.
describe('slots follow a /clear to the living conversation', () => {
  const NOW = 1_700_000_000_000
  const chain = (id: string, mtime: number, earlier: string[] = []) => ({
    head: { folder: 'f', id, mtime },
    earlier: earlier.map((e) => ({ folder: 'f', id: e })),
  })
  const ids = (cs: { head: { id: string } }[]) => cs.map((c) => c.head.id)
  // old was /cleared into live; other is unrelated and naturally newest.
  const sessions = [
    s({ id: 'old', mtime: NOW - 10_000 }),
    s({ id: 'live', mtime: NOW - 5_000, parentKey: 'f/old', parentKind: 'clear' }),
    s({ id: 'other', mtime: NOW }),
  ]
  const chains = [chain('other', NOW), chain('live', NOW - 5_000), chain('old', NOW - 10_000)]

  it('a slot keyed to the cleared-away conversation fixes its SUCCESSOR; the old one flows', () => {
    const { ordered, fixed } = orderWithSlots(chains, [{ key: 'f/old', at: 0 }], sessions)
    expect(ids(ordered)).toEqual(['live', 'other', 'old'])
    expect([...fixed].map((c) => c.head.id)).toEqual(['live'])
  })

  it('follows a chain of /clears to the latest conversation', () => {
    const three = [
      s({ id: 'old', mtime: NOW - 10_000 }),
      s({ id: 'mid', mtime: NOW - 6_000, parentKey: 'f/old', parentKind: 'clear' }),
      s({ id: 'live', mtime: NOW - 5_000, parentKey: 'f/mid', parentKind: 'clear' }),
      s({ id: 'other', mtime: NOW }),
    ]
    const cs = [chain('other', NOW), chain('live', NOW - 5_000), chain('mid', NOW - 6_000), chain('old', NOW - 10_000)]
    const { ordered, fixed } = orderWithSlots(cs, [{ key: 'f/old', at: 0 }], three)
    expect(ids(ordered)).toEqual(['live', 'other', 'mid', 'old'])
    expect([...fixed].map((c) => c.head.id)).toEqual(['live'])
  })

  it('when the successor is not among the drawn chains, the raw key still holds the pin', () => {
    const noLive = [chain('other', NOW), chain('old', NOW - 10_000)]
    const { ordered } = orderWithSlots(noLive, [{ key: 'f/old', at: 0 }], sessions)
    expect(ids(ordered)).toEqual(['old', 'other'])
  })

  it('releaseSlot on the successor also drops the slot keyed to the conversation it cleared away', () => {
    expect(releaseSlot([{ key: 'f/old', at: 0 }], chain('live', NOW - 5_000), sessions)).toEqual([])
  })

  it('fixAt on the successor frees the predecessor-keyed slot first — never two pins for one thread', () => {
    expect(fixAt([{ key: 'f/old', at: 0 }], chain('live', NOW - 5_000), 2, sessions)).toEqual([{ key: 'f/live', at: 2 }])
  })

  it('without sessions, slots match by raw key exactly as before', () => {
    const { ordered } = orderWithSlots(chains, [{ key: 'f/old', at: 0 }])
    expect(ids(ordered)).toEqual(['old', 'other', 'live'])
  })
})

describe('applyAgentOrder / moveBefore', () => {
  const a = (id: string) => ({ id })
  it('known ids first in the given order; unknown keep the registry order after', () => {
    expect(applyAgentOrder([a('x'), a('b'), a('y'), a('a')], ['a', 'b']).map((x) => x.id)).toEqual(['a', 'b', 'x', 'y'])
  })
  it('an empty order leaves everything untouched', () => {
    expect(applyAgentOrder([a('x'), a('y')], []).map((x) => x.id)).toEqual(['x', 'y'])
  })
  it('moveBefore puts the dragged id right before the target', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveBefore(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c'])
  })
  it('moveBefore is a no-op for the same id or unknown ids', () => {
    expect(moveBefore(['a', 'b'], 'a', 'a')).toEqual(['a', 'b'])
    expect(moveBefore(['a', 'b'], 'zz', 'a')).toEqual(['a', 'b'])
  })
})

describe('chainTip — continuation only', () => {
  it('never crosses a /clear with { continuation }; the whole thread without it', () => {
    const a = s({ id: 'a', mtime: NOW - 30_000 })
    const b = s({ id: 'b', mtime: NOW - 20_000, parentKey: 'f/a' })
    const c = s({ id: 'c', mtime: NOW - 10_000, parentKey: 'f/b', parentKind: 'clear' })
    const d = s({ id: 'd', mtime: NOW, parentKey: 'f/c' })
    expect(chainTip([a, b, c, d], 'f', 'a', { continuation: true })).toEqual({ folder: 'f', id: 'b' })
    expect(chainTip([a, b, c, d], 'f', 'c', { continuation: true })).toEqual({ folder: 'f', id: 'd' })
    expect(chainTip([a, b, c, d], 'f', 'a')).toEqual({ folder: 'f', id: 'd' })
  })
})

describe('chainTip', () => {
  it('follows parentKey links to the newest descendant; a session nobody continues is its own tip', () => {
    const sessions = [
      s({ id: 'root', mtime: NOW - 3000 }),
      s({ id: 'mid', mtime: NOW - 2000, parentKey: 'f/root' }),
      s({ id: 'leaf', mtime: NOW - 1000, parentKey: 'f/mid' }),
      s({ id: 'side', mtime: NOW - 1500, parentKey: 'f/root' }),
      s({ id: 'alone', mtime: NOW }),
    ]
    // the newest descendant wins, not the deepest: leaf (NOW-1000) over side (NOW-1500)
    expect(chainTip(sessions, 'f', 'root')).toEqual({ folder: 'f', id: 'leaf' })
    expect(chainTip(sessions, 'f', 'mid')).toEqual({ folder: 'f', id: 'leaf' })
    expect(chainTip(sessions, 'f', 'alone')).toEqual({ folder: 'f', id: 'alone' })
  })

  // a live console (written every minute) with a recorded
  // child that is OLDER (an SDK fork born at once, untouched for hours).
  // The tip is the most recently active of the session ITSELF and its
  // descendants — the stale child never wins.
  it('an OLDER child never wins: the session itself is the tip', () => {
    const sessions = [s({ id: 'live', mtime: NOW }), s({ id: 'stale', mtime: NOW - 3 * 3_600_000, parentKey: 'f/live' })]
    expect(chainTip(sessions, 'f', 'live')).toEqual({ folder: 'f', id: 'live' })
    // a NEWER child (a real /clear rotation) still takes over
    const rotated = [s({ id: 'old', mtime: NOW - 60_000 }), s({ id: 'new', mtime: NOW, parentKey: 'f/old' })]
    expect(chainTip(rotated, 'f', 'old')).toEqual({ folder: 'f', id: 'new' })
  })

  it('deep chain: the most recent anywhere below wins, unless the session itself is newer', () => {
    const sessions = [
      s({ id: 'a', mtime: NOW - 500 }),
      s({ id: 'b', mtime: NOW - 900, parentKey: 'f/a' }), // stale fork under a
      s({ id: 'c', mtime: NOW - 100, parentKey: 'f/b' }), // but its own child moved later
      s({ id: 'd', mtime: NOW - 800, parentKey: 'f/c' }),
    ]
    expect(chainTip(sessions, 'f', 'a')).toEqual({ folder: 'f', id: 'c' })
    expect(chainTip(sessions, 'f', 'b')).toEqual({ folder: 'f', id: 'c' })
    expect(chainTip(sessions, 'f', 'c')).toEqual({ folder: 'f', id: 'c' }) // d is older
    expect(chainTip(sessions, 'f', 'd')).toEqual({ folder: 'f', id: 'd' })
  })
})

describe('isSuperseded — an old rotation reads as transcript, never the live console', () => {
  it('true only when some session continues it (parentKey points at it)', async () => {
    const { isSuperseded } = await import('../src/lib/grouping')
    const sessions = [
      { folder: 'f', id: 'old', mtime: 1 },
      { folder: 'f', id: 'new', mtime: 2, parentKey: 'f/old' },
    ] as never[]
    expect(isSuperseded(sessions, { folder: 'f', id: 'old' })).toBe(true)
    expect(isSuperseded(sessions, { folder: 'f', id: 'new' })).toBe(false)
  })

  it('a child OLDER than the session does not supersede it', async () => {
    const { isSuperseded } = await import('../src/lib/grouping')
    const sessions = [
      { folder: 'f', id: 'live', mtime: 500 },
      { folder: 'f', id: 'stale', mtime: 100, parentKey: 'f/live' },
    ] as never[]
    expect(isSuperseded(sessions, { folder: 'f', id: 'live' })).toBe(false)
    // the stale fork is not the thread's tip either: it shows its transcript,
    // never the thread's live console (else two sessions would show the
    // same conversation)
    expect(isSuperseded(sessions, { folder: 'f', id: 'stale' })).toBe(true)
  })
})

// A console /clear starts a NEW conversation; the one it left behind is
// done by the owner's own hand — archived, not listed with the living ones
// (so they don't pile up there).
describe('splitArchived — what a /clear left behind is archived', () => {
  it('the chain a /clear left behind goes to archived; the new conversation and the rest stay live', () => {
    const a = s({ id: 'a', mtime: NOW - 30_000 })
    const b = s({ id: 'b', mtime: NOW - 20_000, parentKey: 'f/a' }) // --resume of a
    const c = s({ id: 'c', mtime: NOW - 10_000, parentKey: 'f/b', parentKind: 'clear' }) // /clear in b's console
    const d = s({ id: 'd', mtime: NOW })
    const { live, archived } = splitArchived(groupChains([a, b, c, d]), [a, b, c, d])
    expect(live.map((x) => x.head.id)).toEqual(['d', 'c'])
    expect(archived.map((x) => [x.head.id, x.earlier.map((e) => e.id)])).toEqual([['b', ['a']]])
  })

  it('a continuation (no /clear) archives nothing', () => {
    const a = s({ id: 'a', mtime: NOW - 20_000 })
    const b = s({ id: 'b', mtime: NOW, parentKey: 'f/a' })
    const { live, archived } = splitArchived(groupChains([a, b]), [a, b])
    expect(live).toHaveLength(1)
    expect(archived).toHaveLength(0)
  })

  it('a /clear chained twice archives both conversations left behind', () => {
    const a = s({ id: 'a', mtime: NOW - 30_000 })
    const b = s({ id: 'b', mtime: NOW - 20_000, parentKey: 'f/a', parentKind: 'clear' })
    const c = s({ id: 'c', mtime: NOW, parentKey: 'f/b', parentKind: 'clear' })
    const { live, archived } = splitArchived(groupChains([a, b, c]), [a, b, c])
    expect(live.map((x) => x.head.id)).toEqual(['c'])
    expect(archived.map((x) => x.head.id)).toEqual(['b', 'a'])
  })
})
