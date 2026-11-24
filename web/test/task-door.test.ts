// task-door.test.ts — the task page's ONE door: a console only when the
// agent HAS one in the index and its
// engine's console takes the briefing, chat otherwise; a turn running in the
// thread: the door only opens it; a run working it is read-only.
import { describe, it, expect } from 'vitest'
import { doorPlan } from '../src/components/tasks/TaskMode'

const thread = { sessionId: 's1', folder: '-f' }
const facts = (o: { hasConsole: boolean; consoleBriefs?: boolean; thread?: typeof thread | null; running?: typeof thread | null }) => ({
  thread: o.thread === undefined ? thread : o.thread,
  running: o.running ?? null,
  consoleBriefs: o.consoleBriefs ?? true,
  hasConsole: o.hasConsole,
})

describe('doorPlan — console or chat', () => {
  it('a console of the agent in the index: Open console — whether it continues a thread or starts one', () => {
    expect(doorPlan({ name: 'Finance', door: facts({ hasConsole: true }) })).toMatchObject({ kind: 'go', mode: 'console', note: null })
    expect(doorPlan({ name: 'Finance', door: facts({ hasConsole: true, thread: null }) })).toMatchObject({ kind: 'go', mode: 'console', note: null })
  })

  it("no console yet: chat — the first console is the owner's to open by hand", () => {
    expect(doorPlan({ name: 'Finance', door: facts({ hasConsole: false }) })).toMatchObject({ kind: 'go', mode: 'chat', note: null })
    // facts unknown (an old server): chat, never a console on a guess
    expect(doorPlan({ name: 'Finance', door: null })).toMatchObject({ kind: 'go', mode: 'chat' })
  })

  it('an engine whose console opens without the briefing: always chat, and it says so', () => {
    const plan = doorPlan({ name: 'Writer', door: facts({ hasConsole: true, consoleBriefs: false }), engineLabel: 'OpenCode' })
    expect(plan).toMatchObject({ kind: 'go', mode: 'chat' })
    expect(plan.note).toContain('OpenCode')
  })

  it('a turn running in the thread: «X is on it already» — the door only opens it', () => {
    const plan = doorPlan({ name: 'Finance', door: facts({ hasConsole: true, running: thread }) })
    expect(plan).toMatchObject({ kind: 'open', to: thread })
    expect(plan.note).toContain('Finance')
  })

  // a run working the task is read-only — the door reads it and
  // never says «your words land in it»
  it("an automation run working the task: «Read it ›» with the server's words", () => {
    const run = { sessionId: 'run-1', folder: '-f', readOnly: true as const, error: 'an automation run of Finance is working this task — read it' }
    const plan = doorPlan({ name: 'Finance', door: { thread, running: run, consoleBriefs: true, hasConsole: true } })
    expect(plan).toMatchObject({ kind: 'open', to: { sessionId: 'run-1', folder: '-f' } })
    // read-only: never invites the owner's words into the run
    expect(plan.note).not.toMatch(/your words/)
  })
})
