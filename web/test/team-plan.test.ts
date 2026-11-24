// team-plan.test.ts — the pure questions the plan views ask of a plan (the
// plan arrives from the Plans silo through lib/plan-record.ts; parsing and
// writing the file are the kernel's since the plans kernelectomy): ready /
// parallel, human tasks, what a Done unblocks, the v-next states.
import { describe, expect, it } from 'vitest'
import {
  isClosedPlanPath,
  isFinished,
  isPlanFile,
  planHomeWords,
  planIsOf,
  readyTasks,
  humanTasks,
  humanReadyTasks,
  unblocksOf,
  type TeamPlan,
} from '../src/lib/team-plan'

function plan(): TeamPlan {
  return {
    title: 'August close',
    updatedAt: '2026-08-25',
    tasks: [
      { id: 't1', title: 'Export sales', owner: 'finance', status: 'done', dependsOn: [] },
      { id: 't2', title: 'Confirm the figure', owner: 'sam', status: 'pending', dependsOn: ['t1'] },
      { id: 't3', title: 'Close the month', owner: 'finance', status: 'blocked', dependsOn: ['t2'] },
      { id: 't4', title: 'Tell the team', owner: 'finance', status: 'pending', dependsOn: [] },
    ],
  }
}

describe('isPlanFile', () => {
  it('matches only *.plan.json', () => {
    expect(isPlanFile('closing.plan.json')).toBe(true)
    expect(isPlanFile('closing.json')).toBe(false)
    expect(isPlanFile('plan.md')).toBe(false)
  })
})

describe('derived views', () => {
  it('readyTasks = actionable now = parallelizable set', () => {
    expect(readyTasks(plan()).map((t) => t.id)).toEqual(['t2', 't4'])
  })

  it('an unknown dependency id counts as unmet (honest reading of a lying file)', () => {
    const p = plan()
    p.tasks[3]!.dependsOn = ['ghost']
    expect(readyTasks(p).map((t) => t.id)).toEqual(['t2'])
  })

  it('humanTasks = owner is not a known agent id', () => {
    const mine = humanTasks(plan(), new Set(['finance', 'builder']))
    expect(mine.map((t) => t.id)).toEqual(['t2'])
  })

  it('humanReadyTasks = ready AND on a human — a blocked human task does not count', () => {
    const p = plan()
    p.tasks[2]!.owner = 'sam'
    expect(humanReadyTasks(p, new Set(['finance', 'builder'])).map((t) => t.id)).toEqual(['t2'])
  })

  it('unblocksOf tells what completing a task frees', () => {
    expect(unblocksOf(plan(), 't2').map((t) => t.id)).toEqual(['t3'])
    expect(unblocksOf(plan(), 't4')).toEqual([])
  })
})

describe('the v-next states (plans 0.2.0)', () => {
  it('done and cancelled are finished; in review is not ready; a cancelled blocker resolves nothing', () => {
    expect(['done', 'cancelled', 'in_review', 'pending'].map((s) => isFinished(s as never))).toEqual([true, true, false, false])
    const p = plan()
    p.tasks[3]!.status = 'in_review'
    p.tasks[0]!.status = 'cancelled'
    expect(readyTasks(p).map((t) => t.id)).toEqual([])
    expect(unblocksOf(p, 't3')).toEqual([])
  })
})

describe("planIsOf — whose plan a conversation's column shows", () => {
  const task = (id: string, sessions: string[]) => ({ id, title: id, owner: 'a', status: 'pending' as const, dependsOn: [], sessions })
  it("a plan is the conversation's when it holds one of its tasks; writing into a plan others hold is a visit; reading is nothing", () => {
    const held = { tasks: [task('t1', ['other-session']), task('t2', [])] }
    expect(planIsOf(held, 'this-session', true)).toBe(false)
    expect(planIsOf({ tasks: [task('t1', ['other-session', 'this-session'])] }, 'this-session', false)).toBe(true)
    const fresh = { tasks: [task('t1', [])] }
    expect(planIsOf(fresh, 'this-session', true)).toBe(true)
    expect(planIsOf(fresh, 'this-session', false)).toBe(false)
  })
})

// A plan the protocol moved to <project>/plans/closed/ is that project's own
// (read only) — never «outside Silos' projects», though the reader leaves
// plans/closed/ out of its locations and serves it as outside.
describe('a closed plan path belongs to its project', () => {
  it('classifies plans/closed/ as closed, plans/ as not', () => {
    expect(isClosedPlanPath('/w/proj/plans/closed/ship.plan.json')).toBe(true)
    expect(isClosedPlanPath('/w/proj/plans/ship.plan.json')).toBe(false)
  })
  it('the home line: own project says nothing, another project is named, closed is never «outside»', () => {
    const closed = '/w/proj/plans/closed/ship.plan.json'
    expect(planHomeWords({ path: closed, outside: true }, '/w/proj')).toBeNull()
    expect(planHomeWords({ path: closed, outside: true, closed: true }, '/w/other')).toBe('in proj')
    expect(planHomeWords({ path: '/w/proj/plans/ship.plan.json', outside: false }, '/w/proj')).toBeNull()
    expect(planHomeWords({ path: '/w/other/plans/ship.plan.json', outside: false }, '/w/proj')).toBe('in other')
    expect(planHomeWords({ path: '/tmp/x/plans/ship.plan.json', outside: true }, '/w/proj')).toBe("outside Silos' projects")
  })
})
