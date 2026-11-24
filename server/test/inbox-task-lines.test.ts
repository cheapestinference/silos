// inbox-task-lines.test.ts — Home and the digest: the
// routine task lines (wait for you to start · coming to you · ready with
// nobody on them), the ONE due row of stalls nobody moves (never a start, nor
// a task parked by one — F12), and an agent's task wakes at its ceiling.
import { describe, expect, it } from 'vitest'
import { composeInbox, inboxSignature, taskLineRows, tasksStalledRow, ownTurnsCeilingRow, type TaskFlowFact } from '../src/inbox.js'
import { kernelInboxRows } from '../src/inbox-source.js'
import type { Agent } from '../src/types.js'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const PLAN = 'folder:/w/p'
const flow = (over: Partial<TaskFlowFact['flow']> = {}): TaskFlowFact['flow'] => ({
  stalled: false,
  stalledCause: null,
  stalledBy: null,
  stalledAt: null,
  waitsStart: false,
  idle: false,
  ...over,
})
const fact = (id: string, over: Partial<TaskFlowFact> = {}): TaskFlowFact => ({
  key: `${PLAN}/tasks/${id}`,
  planKey: PLAN,
  ref: `p#${id}`,
  title: `Task ${id}`,
  owner: 'writer',
  state: 'pending',
  ready: true,
  flow: flow(),
  ...over,
})
const AGENTS = new Set(['writer', 'ops', 'builder'])

describe('the routine task lines', () => {
  const facts = [
    fact('s1', { flow: flow({ waitsStart: true }) }),
    fact('s2', { state: 'in_progress', flow: flow({ waitsStart: true }) }),
    fact('c1', { owner: 'owner', ready: false, sentence: 'Waiting — waits on p#s1 (Writer).' }),
    fact('c2', { owner: 'owner', ready: true }),
    fact('i1', { flow: flow({ idle: true }) }),
    fact('done', { state: 'done', flow: flow({ idle: true }) }),
  ]
  it('one row per line with tasks — routine, keyed by the line, no Seen, with its door and the tasks in words', () => {
    const rows = taskLineRows(facts, NOW)
    expect(rows.map((r) => r.kind === 'taskLine' && [r.line, r.count, r.keys.map((k) => k.split('/').pop()), r.door, r.voice])).toEqual([
      ['waitsStart', 2, ['s1', 's2'], '/tasks?view=start', '2 tasks not started — they open with you'],
      ['comingToYou', 1, ['c1'], '/tasks?view=mine', 'Coming to you · 1'],
      ['idle', 1, ['i1'], '/tasks?view=idle', '1 task not started — nobody is on it'],
    ])
    expect(rows.every((r) => r.urgency === 'routine' && r.ack === undefined && r.key === `task-line:${(r as { line: string }).line}`)).toBe(true)
    expect(rows[1]).toMatchObject({
      items: [{ key: `${PLAN}/tasks/c1`, ref: 'p#c1', title: 'Task c1', owner: 'owner', says: 'Waiting — waits on p#s1 (Writer).' }],
    })
    expect(taskLineRows([], NOW)).toEqual([])
  })
  it("composed: never loud (no blocking/due), so never the bell nor Needs you's lead; the signature moves with the count", () => {
    const inbox = composeInbox({ nameOf: (id) => id, asks: [], needsYou: [], pending: [], automations: [], kernel: taskLineRows(facts, NOW), now: NOW })
    expect(inbox.map((r) => r.urgency)).toEqual(['routine', 'routine', 'routine'])
    const fewer = composeInbox({
      nameOf: (id) => id,
      asks: [],
      needsYou: [],
      pending: [],
      automations: [],
      kernel: taskLineRows(facts.slice(1), NOW),
      now: NOW,
    })
    expect(inboxSignature(fewer)).not.toBe(inboxSignature(inbox))
  })
})

describe('«N tasks sit untouched — nobody is moving them» (B3, F12)', () => {
  const opts = { isAgent: (id: string) => AGENTS.has(id), isBound: (id: string) => id === 'builder', now: NOW }
  it("the distinct SEATS nobody is woken for (A2.5) — an unbound agent's, a person's, nobody's; never a start, one parked BY a start, a bound seat (its wake), nor a task seated elsewhere; one due row with a Seen for the set", () => {
    const st = (cause: string, by: string, at: string) => flow({ stalled: true, stalledCause: cause, stalledBy: by, stalledAt: at })
    const facts = [
      fact('a', { flow: st('review-without-reviewer', 'a', 'a') }),
      fact('b', { owner: 'ops', flow: st('owner-cannot-run', 'b', 'b') }),
      fact('start', { flow: flow({ waitsStart: true }) }),
      fact('parked', { flow: st('blocker-parked', 'start', 'start') }),
      fact('bound', { owner: 'builder', flow: st('in-progress-nothing-live', 'bound', 'bound') }),
      fact('human', { owner: 'sam', flow: st('blocker-missing', 'x', 'human') }),
      fact('nobody', { owner: '', flow: st('unowned', 'nobody', 'nobody') }),
      fact('above', { flow: st('unowned', 'nobody', 'nobody') }),
      fact('closed', { state: 'done', flow: st('blocker-missing', 'x', 'closed') }),
    ]
    const row = tasksStalledRow(facts, opts)!
    expect(row).toMatchObject({
      kind: 'tasksStalled',
      key: 'tasks-stalled',
      urgency: 'due',
      count: 4,
      door: '/tasks?view=untouched',
      agentIds: ['writer', 'ops'],
      voice: '4 tasks sit untouched — nobody is moving them',
    })
    expect(row.ack).toEqual({ kind: 'tasksStalled', key: 'tasks', version: ['a', 'b', 'human', 'nobody'].map((id) => `${PLAN}/tasks/${id}`).join(',') })
    expect(tasksStalledRow([fact('start', { flow: flow({ waitsStart: true }) })], opts)).toBeNull()
  })
})

describe("an agent's task wakes at its ceiling (E6)", () => {
  it('one due row per agent, Seen for the day', () => {
    const r = ownTurnsCeilingRow({
      agentId: 'writer',
      agentName: 'Writer',
      used: 30,
      perDay: 30,
      waiting: 2,
      until: '2026-11-10T00:00:00.000Z',
      day: '2026-11-09',
      now: NOW,
    })
    expect(r).toMatchObject({
      kind: 'ownTurnsCeiling',
      key: 'own-turns-ceiling:writer',
      urgency: 'due',
      voice: 'Writer started 30 times without you today — its max · 2 wait for tomorrow',
      ack: { kind: 'ownTurns', key: 'writer', version: '2026-11-09' },
    })
  })
})

describe('kernelInboxRows reads them (inbox-source)', () => {
  it('taskFlows → the lines and the stall row; ownTurnsCeilings → the ceiling rows (agents in play only)', () => {
    const agents = [...AGENTS].map((id) => ({ id, name: id.toUpperCase(), folder: '/w' })) as unknown as Agent[]
    const rows = kernelInboxRows({
      agents,
      nameOf: (id) => id.toUpperCase(),
      now: NOW,
      taskFlows: () => [
        fact('i1', { flow: flow({ idle: true }) }),
        fact('a', { flow: flow({ stalled: true, stalledCause: 'review-without-reviewer', stalledBy: 'a', stalledAt: 'a' }) }),
      ],
      isBoundToTasks: () => false,
      ownTurnsCeilings: () => [
        { agent: 'writer', used: 5, perDay: 5, waiting: 0, until: 'x', day: '2026-11-09', cap: 'ceiling' as const, spentUsd: 0 },
        { agent: 'gone', used: 5, perDay: 5, waiting: 0, until: 'x', day: '2026-11-09', cap: 'ceiling' as const, spentUsd: 0 },
      ],
    })
    expect(rows.map((r) => r.kind)).toEqual(['taskLine', 'tasksStalled', 'ownTurnsCeiling'])
  })
})
