// inbox-held-task-rows.test.ts — the owner rows about held tasks, as the web
// scopes and words them (the server composes them — server/test/inbox-held-task-rows):
// a task waiting on an agent the owner relays, the closed plans still
// holding open tasks, a plan's tasks that can't be read.
import { describe, expect, it } from 'vitest'
import { headline, isWaiting, scopeInbox } from '../src/lib/home'
import { folderOfRow } from '../src/lib/home-projects'
import { inboxTaskKey } from '../src/lib/task-origin'
import type { InboxRow } from '../src/lib/types'

const relay: InboxRow = {
  kind: 'waitsOnRelay',
  key: 'waits-on-relay:folder:/p/a/ship/tasks/t2',
  urgency: 'due',
  at: 0,
  voice: 'Writer waits on Builder — deploy it',
  clears: '',
  task: { key: 'folder:/p/a/ship/tasks/t2', ref: 'ship#t2', title: 'Publish', owner: 'writer' },
  on: 'builder',
  action: 'deploy it',
  agentIds: ['writer', 'builder'],
}
const closed: InboxRow = {
  kind: 'closedPlansOpen',
  key: 'closed-plans-open',
  urgency: 'routine',
  at: 0,
  voice: '2 closed plans still have open tasks',
  clears: '',
  count: 2,
  plans: [
    { key: 'folder:/p/a/old', title: 'Old', folder: '/p/a', file: '/p/a/plans/closed/old.plan.json', open: 1 },
    { key: 'folder:/p/b/older', title: 'Older', folder: '/p/b', file: '/p/b/plans/closed/older.plan.json', open: 3 },
  ],
}
const unread: InboxRow = {
  kind: 'tasksUnreadable',
  key: 'tasks-unreadable:folder:/p/b/ship',
  urgency: 'due',
  at: 0,
  voice: "1 task in Ship can't be read — t7: notes is not an array",
  clears: '',
  plan: { key: 'folder:/p/b/ship', id: 'ship', title: 'Ship', folder: '/p/b', file: '/p/b/plans/ship.plan.json' },
  count: 1,
  reason: 'notes is not an array',
  first: 't7',
}
const name = (id: string): string => (({ writer: 'Writer', builder: 'Builder' }) as Record<string, string>)[id] ?? id

describe('held-task owner rows on the web', () => {
  it("scoped to a project by their task's or plan's folder; the closed plans keep only the folder's", () => {
    expect(scopeInbox([relay, unread], '/p/a', new Set(), 'master').map((r) => r.kind)).toEqual(['waitsOnRelay'])
    expect(scopeInbox([relay, unread], '/p/b', new Set(), 'master').map((r) => r.kind)).toEqual(['tasksUnreadable'])
    const b = scopeInbox([closed], '/p/b', new Set(), 'master')
    expect(b).toEqual([expect.objectContaining({ kind: 'closedPlansOpen', count: 1, plans: [expect.objectContaining({ title: 'Older' })] })])
    expect(scopeInbox([closed], '/p/c', new Set(), 'master')).toEqual([])
  })
  it("their project for the eyebrow, and the relay row's door is its task", () => {
    expect(folderOfRow(relay, [])).toBe('/p/a')
    expect(folderOfRow(unread, [])).toBe('/p/b')
    expect(folderOfRow(closed, [])).toBeNull()
    expect(inboxTaskKey(relay)).toBe('folder:/p/a/ship/tasks/t2')
  })
  it('they wait (Needs you), and the headline says them', () => {
    expect([relay, closed, unread].every(isWaiting)).toBe(true)
    const say = (r: InboxRow): string => headline({ inbox: [r], working: [], agentName: name, now: 0, ago: () => '' })
    expect(say(relay)).toContain('Writer')
    expect(say(relay)).toContain('Builder')
    expect(say(unread)).toContain('Ship')
    expect(say(closed)).toContain('2')
  })
})
