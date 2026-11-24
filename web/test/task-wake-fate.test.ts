// A held wake is said ONCE at rest: the live line says why
// it waits; its row in Wakes then says «Waiting» alone — never the same
// sentence twice on one page.
import { describe, expect, it } from 'vitest'
import { liveWhy, wakeFate } from '../src/components/tasks/TaskMode'
import type { TaskModeView, TaskWakeLine } from '../src/lib/types'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const HELD = 'a console has its conversation open — it gets this at its next turn'
const wake = (over: Partial<TaskWakeLine> = {}): TaskWakeLine => ({
  id: 'w1',
  reason: 'owner-note',
  says: 'a note from the owner',
  at: '2026-11-21T11:50:00Z',
  state: 'queued',
  held: HELD,
  ...over,
})
const view = (live: TaskModeView['live']): TaskModeView => ({ bound: true, owner: 'web', wakes: 'task', history: [wake()], live })

describe('a held wake is said once', () => {
  it("the live line's why is the held or failed fact, nothing else", () => {
    expect(liveWhy(view({ kind: 'held', why: HELD }))).toBe(HELD)
    expect(liveWhy(view({ kind: 'failed', why: 'its engine is too old' }))).toBe('its engine is too old')
    expect(liveWhy(view({ kind: 'starting' }))).toBeNull()
    expect(liveWhy(view(null))).toBeNull()
    expect(liveWhy(null)).toBeNull()
  })
  it('a queued row whose why the live line says reads «Waiting» alone; any other keeps its why', () => {
    expect(wakeFate(wake(), NOW, 'Web', HELD)).toBe('Waiting')
    expect(wakeFate(wake(), NOW, 'Web', null)).toBe(`Waiting: ${HELD}`)
    expect(wakeFate(wake({ held: 'the throttle' }), NOW, 'Web', HELD)).toBe('Waiting: the throttle')
    expect(wakeFate(wake({ held: undefined }), NOW, 'Web', HELD)).toBe('Waiting: its turn comes next')
    expect(wakeFate(wake({ state: 'delivered', deliveredAt: '2026-11-21T11:00:00Z' }), NOW, 'Web', HELD)).toBe('Woke Web 1h ago')
  })
})
