// conversations.test.ts — the flat timeline used by the Conversations
// dimension and the ⌘K palette.
import { describe, expect, it } from 'vitest'
import { timeBucket, matchesConversation, allConversations } from '../src/lib/conversations'
import type { AgentView } from '../src/lib/types'

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/tmp/proj', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}

describe('allConversations', () => {
  it('flattens sessions from all agents, sorted by mtime desc', () => {
    const agents: AgentView[] = [
      makeAgent({
        id: 'a1',
        name: 'Ana',
        sessions: [
          {
            id: 's1',
            folder: 'f1',
            title: 'Old',
            skills: [],
            cwd: '/tmp/proj',
            mtime: 1000,
            size: 0,
            turnCount: 1,
            live: false,
            worktree: false,
            native: true,
            agentId: 'a1',
          },
        ],
      }),
      makeAgent({
        id: 'a2',
        name: 'Bob',
        emoji: '🤖',
        sessions: [
          {
            id: 's2',
            folder: 'f2',
            title: 'Recent',
            skills: [],
            cwd: null,
            mtime: 2000,
            size: 0,
            turnCount: 1,
            live: false,
            worktree: false,
            native: true,
            agentId: 'a2',
          },
        ],
      }),
    ]
    const out = allConversations(agents)
    expect(out.map((c) => c.title)).toEqual(['Recent', 'Old'])
    expect(out[0]).toMatchObject({ agentId: 'a2', agentName: 'Bob', agentEmoji: '🤖' })
  })

  it('master shows up as Anywhere/✳', () => {
    const agents: AgentView[] = [
      makeAgent({
        id: 'master',
        name: 'Master',
        folder: null,
        sessions: [
          {
            id: 's1',
            folder: 'f1',
            title: 'X',
            skills: [],
            cwd: '/tmp/y',
            mtime: 1,
            size: 0,
            turnCount: 1,
            live: false,
            worktree: false,
            native: true,
            agentId: 'master',
          },
        ],
      }),
    ]
    const out = allConversations(agents)
    expect(out[0]).toMatchObject({ agentName: 'Anywhere', agentEmoji: '✳' })
  })
})

describe('matchesConversation', () => {
  const item = {
    folder: 'f',
    id: 's',
    title: 'Fix the parser',
    agentId: 'a1',
    agentName: 'Ana',
    agentEmoji: '🧠',
    project: '/tmp/project-x',
    skills: ['finance-acme'],
    mtime: 1,
  }

  it('empty matches everything', () => expect(matchesConversation(item, '')).toBe(true))
  it('matches by title', () => expect(matchesConversation(item, 'parser')).toBe(true))
  it('matches by agent name', () => expect(matchesConversation(item, 'ana')).toBe(true))
  it('matches by project basename', () => expect(matchesConversation(item, 'project-x')).toBe(true))
  it('matches by skill', () => expect(matchesConversation(item, 'finance')).toBe(true))
  it('does not match if absent from every field', () => expect(matchesConversation(item, 'nothing-to-do-with-it')).toBe(false))
})

describe('timeBucket', () => {
  const now = 10 * 24 * 3600_000 // day 10, to have margin below zero
  it('less than 24h → today', () => expect(timeBucket(now - 3600_000, now)).toBe('today'))
  it('between 1 and 7 days → week', () => expect(timeBucket(now - 3 * 24 * 3600_000, now)).toBe('week'))
  it('more than 7 days → older', () => expect(timeBucket(now - 8 * 24 * 3600_000, now)).toBe('older'))
})
