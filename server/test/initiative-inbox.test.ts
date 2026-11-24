// initiative-inbox.test.ts — the Needs you rows the ledger needs: the baseline's block door (one row
// per folder), the plan task's question marked when its run read outside,
// and the cut row.
import { describe, expect, it } from 'vitest'
import { composeInbox, type InboxInput } from '../src/inbox.js'
import { kernelInboxRows } from '../src/inbox-source.js'
import type { Agent } from '../src/types.js'

const NOW = Date.parse('2026-11-11T10:00:00Z')
const nameOf = (id: string): string => id.toUpperCase()
const empty: InboxInput = { nameOf, asks: [], needsYou: [], pending: [], automations: [], kernel: [], now: NOW }

describe('the baseline door (M13-r6)', () => {
  it('one due row per folder with its tasks; none without tasks', () => {
    const rows = kernelInboxRows({
      agents: [],
      nameOf,
      now: NOW,
      plansBaseline: () => [
        {
          folder: '/w/a',
          tasks: [
            { key: 'folder:/w/a/p/tasks/t1', title: 'One' },
            { key: 'folder:/w/a/p/tasks/t2', title: 'Two' },
          ],
        },
        { folder: '/w/b', tasks: [] },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'plansBaseline',
      urgency: 'due',
      folder: '/w/a',
      tasks: [{ title: 'One' }, { title: 'Two' }],
      voice: '2 tasks existed before Silos watched this folder — Keep them all ›',
    })
    const composed = composeInbox({ ...empty, kernel: rows })
    expect(composed.map((r) => r.kind)).toEqual(['plansBaseline'])
  })
})

describe('a question asked after reading outside (m15)', () => {
  const task = {
    kind: 'silo' as const,
    reason: 'entry' as const,
    silo: 'plans',
    siloName: 'Plans',
    key: 'folder:/x/p/tasks/t1',
    recordKind: 'plan/task',
    urgency: 'due' as const,
    text: 'X asks: publish today? — Publish',
    at: new Date(NOW).toISOString(),
    file: '/x/plans/p.plan.json',
    parent: { key: 'folder:/x/p', kind: 'plan', identity: 'P', at: '' },
  }
  it('the row carries the tools its run read', () => {
    const rows = composeInbox({ ...empty, needsYou: [task], askedOutside: (k) => (k === task.key ? ['WebFetch'] : null) })
    expect(rows[0]).toMatchObject({ kind: 'silo', readOutside: 'asked after reading the web (WebFetch)' })
  })
  it('no mark, no words', () => {
    const rows = composeInbox({ ...empty, needsYou: [task], askedOutside: () => null })
    expect(rows[0]).not.toHaveProperty('readOutside')
  })
})

describe('the cut row', () => {
  it('names who and why; its Seen is the cut', () => {
    const agent = { id: 'x', name: 'X', cut: { at: '2026-11-10T09:00:00Z', why: 'restored work Silos had cancelled' } } as unknown as Agent
    const rows = kernelInboxRows({ agents: [agent], nameOf: () => 'X', now: NOW })
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'cut',
        urgency: 'due',
        voice: 'Silos stopped X from creating work on its own — restored work Silos had cancelled',
        ack: { kind: 'cut', key: 'x', version: '2026-11-10T09:00:00Z' },
      }),
    ])
  })
})
