import { describe, expect, it } from 'vitest'
import { applySessionFilter, formatBytes, groupSessionsByProject, rangeSelect, sessionKey, type MaintenanceRow } from '../src/lib/sessions-maintenance'
import { MASTER_ID } from '../src/lib/constants'
import type { AgentView, SessionView } from '../src/lib/types'

const DAY = 24 * 3600 * 1000
const NOW = 1_700_000_000_000

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: '-home-u-alpha',
    title: 'Untitled',
    skills: [],
    cwd: '/home/u/alpha',
    mtime: NOW - DAY,
    size: 10_000,
    turnCount: 3,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...overrides,
  } as SessionView
}

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',
    role: 'writer',
    folder: '/home/u/alpha',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    ...overrides,
  } as AgentView
}

describe('groupSessionsByProject', () => {
  it('groups every agent session under its project cwd, newest group and newest row first', () => {
    const agents = [
      makeAgent({
        id: 'a1',
        sessions: [makeSession({ id: 'old', mtime: NOW - 10 * DAY }), makeSession({ id: 'new', mtime: NOW - DAY })],
      }),
      makeAgent({
        id: 'a2',
        name: 'Bo',
        folder: '/home/u/beta',
        sessions: [makeSession({ id: 'b1', folder: '-home-u-beta', cwd: '/home/u/beta', mtime: NOW - 2 * DAY, size: 500 })],
      }),
    ]
    const groups = groupSessionsByProject(agents)
    expect(groups.map((g) => g.cwd)).toEqual(['/home/u/alpha', '/home/u/beta'])
    expect(groups[0]!.rows.map((r) => r.session.id)).toEqual(['new', 'old'])
    expect(groups[0]!.bytes).toBe(20_000)
    expect(groups[0]!.lastActivity).toBe(NOW - DAY)
    expect(groups[1]!.rows[0]!.agent.name).toBe('Bo')
  })

  it('falls back to the agent folder when a session has no cwd, and to "No folder" when neither exists', () => {
    const agents = [
      makeAgent({ sessions: [makeSession({ id: 'x', cwd: null })] }),
      makeAgent({ id: MASTER_ID, name: 'Master', folder: null, sessions: [makeSession({ id: 'm', cwd: null, folder: '-nowhere' })] }),
    ]
    const groups = groupSessionsByProject(agents)
    expect(groups.find((g) => g.cwd === '/home/u/alpha')?.rows.map((r) => r.session.id)).toEqual(['x'])
    expect(groups.find((g) => g.cwd === null)?.rows.map((r) => r.session.id)).toEqual(['m'])
  })

  it('lists a session once even when two agents both carry it', () => {
    const shared = makeSession({ id: 'shared' })
    const agents = [makeAgent({ id: 'a1', sessions: [shared] }), makeAgent({ id: 'a2', sessions: [shared] })]
    const rows = groupSessionsByProject(agents).flatMap((g) => g.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agent.id).toBe('a1')
  })

  it('skips archived agents unless nothing else carries the session', () => {
    const agents = [makeAgent({ id: 'gone', archived: true, sessions: [makeSession({ id: 'orphan' })] })]
    const rows = groupSessionsByProject(agents).flatMap((g) => g.rows)
    expect(rows.map((r) => r.session.id)).toEqual(['orphan'])
  })
})

describe('applySessionFilter', () => {
  const rows: MaintenanceRow[] = [
    { session: makeSession({ id: 'fresh', title: 'Deploy to Railway', mtime: NOW - DAY, size: 50_000 }), agent: makeAgent() },
    { session: makeSession({ id: 'stale', title: 'Old thing', mtime: NOW - 45 * DAY, size: 900 }), agent: makeAgent({ name: 'Bo' }) },
    { session: makeSession({ id: 'skilled', title: 'x', skills: ['frontend-design'], mtime: NOW - 3 * DAY, size: 3_000 }), agent: makeAgent() },
  ]

  it('matches text against title, skills and agent name (case-insensitive)', () => {
    expect(applySessionFilter(rows, { text: 'railway' }, NOW).map((r) => r.session.id)).toEqual(['fresh'])
    expect(applySessionFilter(rows, { text: 'FRONTEND' }, NOW).map((r) => r.session.id)).toEqual(['skilled'])
    expect(applySessionFilter(rows, { text: 'bo' }, NOW).map((r) => r.session.id)).toEqual(['stale'])
  })

  it('"older than 30 days" and "empty" quick filters narrow the list', () => {
    expect(applySessionFilter(rows, { text: '', olderThanDays: 30 }, NOW).map((r) => r.session.id)).toEqual(['stale'])
    expect(applySessionFilter(rows, { text: '', emptyOnly: true }, NOW).map((r) => r.session.id)).toEqual(['stale'])
    expect(applySessionFilter(rows, { text: 'deploy', emptyOnly: true }, NOW)).toEqual([])
  })
})

describe('rangeSelect', () => {
  it('returns every key between anchor and target, inclusive, in either direction', () => {
    const keys = ['a', 'b', 'c', 'd', 'e']
    expect(rangeSelect(keys, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeSelect(keys, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeSelect(keys, 'zz', 'c')).toEqual(['c'])
  })
})

describe('helpers', () => {
  it('sessionKey pins a session to its folder + id', () => {
    expect(sessionKey(makeSession({ folder: 'f', id: 'i' }))).toBe('f/i')
  })

  it('formatBytes reads like a human', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(1_536)).toBe('1.5 KB')
    expect(formatBytes(2_500_000)).toBe('2.4 MB')
    expect(formatBytes(3_221_225_472)).toBe('3.0 GB')
  })
})
