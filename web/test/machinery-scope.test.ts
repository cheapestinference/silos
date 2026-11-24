// machinery-scope.test.ts — how wide the context column's machinery reaches.
// Default is the open conversation; the dial widens it.
import { describe, expect, it } from 'vitest'
import { automationsInScope, nextWiderScope, ownKindOf, type MachineryScope, type ScopeSession } from '../src/lib/automations'
import type { Automation } from '../src/lib/types'

const auto = (id: string, agentId: string, thread: Automation['thread'] = { mode: 'new' }): Automation => ({
  id,
  name: id,
  agentId,
  prompt: 'p',
  trigger: { kind: 'cron', expr: '0 9 * * *' },
  thread,
  approval: false,
  keepAlive: false,
  paused: false,
  createdAt: '2026-08-01T00:00:00.000Z',
})
const agents = [
  { id: 'builder', folder: '/home/u/ci' },
  { id: 'support', folder: '/home/u/ci' },
  { id: 'silos', folder: '/home/u/silos' },
  { id: 'master', folder: null },
]
const ALL = [
  auto('digest', 'builder'),
  auto('keepalive', 'builder', { mode: 'keep', sessionId: 'sess-keep' }),
  auto('tickets', 'support'),
  auto('build', 'silos'),
  auto('sweep', 'master', { mode: 'keep', folder: '/home/u/ci' }),
]
const session = (o: Partial<ScopeSession> = {}): ScopeSession => ({ id: 'sess-1', agentId: 'builder', cwd: '/home/u/ci', ...o })
const ids = (scope: MachineryScope, s: ScopeSession | null = session()) => automationsInScope(scope, ALL, { session: s, agents }).map((a) => a.id)

describe('automationsInScope', () => {
  it('conversation: the automation whose RUN produced it — provenance, one row', () => {
    expect(ids('conversation', session({ id: 'run-sess', origin: { kind: 'automation', automationId: 'digest', runId: 'r1' } }))).toEqual(['digest'])
  })

  it('conversation: a keep thread IS its automation, without any origin tag', () => {
    expect(ids('conversation', session({ id: 'sess-keep' }))).toEqual(['keepalive'])
  })

  it("conversation: the owner's own conversation belongs to no automation — empty, honestly", () => {
    expect(ids('conversation')).toEqual([])
  })

  it("agent: every automation of this conversation's agent, and nobody else's", () => {
    expect(ids('agent')).toEqual(['digest', 'keepalive'])
  })

  it("project: every agent living in this project, plus Anywhere's aimed at its folder", () => {
    expect(ids('project')).toEqual(['digest', 'keepalive', 'tickets', 'sweep'])
  })

  it('all: everything, everywhere', () => {
    expect(ids('all')).toEqual(['digest', 'keepalive', 'tickets', 'build', 'sweep'])
  })

  it('a conversation with no folder has no project — its agent is the honest answer', () => {
    expect(ids('project', session({ agentId: 'master', cwd: null }))).toEqual(['sweep'])
  })

  it('with no conversation open, only "all" can say anything', () => {
    expect(ids('conversation', null)).toEqual([])
    expect(ids('agent', null)).toEqual([])
    expect(ids('project', null)).toEqual([])
    expect(automationsInScope('all', ALL, { session: null, agents })).toHaveLength(5)
  })
})

describe('nextWiderScope — nothing is hidden without saying so', () => {
  it('from an empty conversation scope, points at the agent and counts what it hides — rows AND armed', () => {
    const paused = ALL.map((a) => (a.id === 'keepalive' ? { ...a, paused: true } : a))
    expect(nextWiderScope('conversation', paused, { session: session(), agents })).toEqual({ scope: 'agent', extra: 2, armed: 1 })
  })

  it('skips a radius that would add nothing', () => {
    // the silos agent is alone in its project: agent and project are the same set
    const ctx = { session: session({ agentId: 'silos', cwd: '/home/u/silos' }), agents }
    expect(nextWiderScope('agent', ALL, ctx)).toEqual({ scope: 'all', extra: 4, armed: 4 })
  })

  it('at the widest radius nothing is hidden', () => {
    expect(nextWiderScope('all', ALL, { session: session(), agents })).toBeNull()
  })
})

// The beat (heartbeat-<agent>) left every automations enumeration — the
// column's dial agrees with the Automations page: only at the CONVERSATION
// radius may the beat's own run conversation still name its provenance;
// wider radii never count or list it.
describe('the heartbeat and the radius dial', () => {
  const BEAT = auto('heartbeat-builder', 'builder')
  const WITH_BEAT = [...ALL, BEAT]
  const beatRun = session({ id: 'beat-run', origin: { kind: 'automation', automationId: 'heartbeat-builder', runId: 'r9' } })
  const idsOf = (scope: MachineryScope, s: ScopeSession | null = session()) => automationsInScope(scope, WITH_BEAT, { session: s, agents }).map((a) => a.id)

  it('conversation: the beat run conversation still shows its provenance', () => {
    expect(idsOf('conversation', beatRun)).toEqual(['heartbeat-builder'])
  })

  it('agent / project / all: the beat is never listed', () => {
    expect(idsOf('agent')).toEqual(['digest', 'keepalive'])
    expect(idsOf('project')).toEqual(['digest', 'keepalive', 'tickets', 'sweep'])
    expect(idsOf('all')).toEqual(['digest', 'keepalive', 'tickets', 'build', 'sweep'])
    expect(idsOf('agent', beatRun)).toEqual(['digest', 'keepalive'])
    expect(automationsInScope('all', WITH_BEAT, { session: null, agents }).map((a) => a.id)).not.toContain('heartbeat-builder')
  })

  it('the "+N wider" hint never counts the beat', () => {
    expect(nextWiderScope('conversation', WITH_BEAT, { session: session(), agents })).toEqual({ scope: 'agent', extra: 2, armed: 2 })
    expect(nextWiderScope('conversation', WITH_BEAT, { session: beatRun, agents })).toEqual({ scope: 'agent', extra: 2, armed: 2 })
    expect(nextWiderScope('project', WITH_BEAT, { session: session(), agents })).toEqual({ scope: 'all', extra: 1, armed: 1 })
  })
})

describe('ownKindOf — what this conversation is to an automation', () => {
  it("a run that produced it → 'run'; the keep thread it lives in → 'thread'; the thread wins when both", () => {
    const run = auto('digest', 'builder')
    const keep = auto('keepalive', 'builder', { mode: 'keep', sessionId: 'sess-keep' })
    expect(ownKindOf(run, session({ origin: { kind: 'automation', automationId: 'digest', runId: 'r1' } }))).toBe('run')
    expect(ownKindOf(keep, session({ id: 'sess-keep' }))).toBe('thread')
    expect(ownKindOf(keep, session({ id: 'sess-keep', origin: { kind: 'automation', automationId: 'keepalive', runId: 'r1' } }))).toBe('thread')
    expect(ownKindOf(run, session())).toBeNull()
    expect(ownKindOf(run, null)).toBeNull()
  })
})
