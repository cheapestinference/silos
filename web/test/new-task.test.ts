// «New task» from other doors: ⌘K's words and the
// dialog's id/plan choices — the action's logic, shared by every door.
import { describe, expect, it } from 'vitest'
import { defaultPlan, defaultProject, parseNewTask, planChoices, planIdOf, projectsFor } from '../src/lib/new-task'
import { isStandingPlan, standingKeyOf } from '../src/lib/tasks'
import type { PlanStatus } from '../src/lib/team-plan'
import type { AgentView } from '../src/lib/types'

const agent = (id: string, name: string, folder: string | null = null, folders?: string[]): AgentView =>
  ({ id, name, folder, folders, sessions: [] }) as unknown as AgentView
const agents = [agent('finance', 'Finance', '/p/ci'), agent('builder', 'Builder', '/p/ci'), agent('silos', 'Silos', '/p/silos')]

describe('parseNewTask', () => {
  it('is null unless the verb leads', () => {
    expect(parseNewTask('ledgerly', agents)).toBeNull()
    expect(parseNewTask('a new task', agents)).toBeNull()
    expect(parseNewTask('new tasks', agents)).toBeNull()
  })
  it('takes the title with or without the colon, any case', () => {
    expect(parseNewTask('new task', agents)).toEqual({ title: '', owner: null })
    expect(parseNewTask('New Task: ship the 303', agents)).toEqual({ title: 'ship the 303', owner: null })
    expect(parseNewTask('new task ship it', agents)).toEqual({ title: 'ship it', owner: null })
  })
  it('one @word names the owner wherever it sits; me/you is the owner', () => {
    expect(parseNewTask('new task: file the 303 @finance', agents)).toEqual({ title: 'file the 303', owner: 'finance' })
    expect(parseNewTask('new task: @Silos fix the dialog', agents)).toEqual({ title: 'fix the dialog', owner: 'silos' })
    expect(parseNewTask('new task: call them @me', agents)).toEqual({ title: 'call them', owner: 'owner' })
    // only the first fitting @word: a second stays in the title
    expect(parseNewTask('new task: ping @builder about @finance', agents)).toEqual({ title: 'ping about @finance', owner: 'builder' })
  })
  it('an @word that fits nobody, or more than one, stays in the title — nothing guessed', () => {
    expect(parseNewTask('new task: mail @taxoffice', agents)).toEqual({ title: 'mail @taxoffice', owner: null })
    expect(parseNewTask('new task: x @c', agents)).toEqual({ title: 'x @c', owner: null })
  })
})

// the server assigns a new task's id from the raw
// file — the web names only the plan
describe('planIdOf', () => {
  it("a named plan's id in its project", () => {
    expect(planIdOf('folder:/p/ci/closing', '/p/ci')).toBe('closing')
    expect(planIdOf('folder:/p/ci/sub/plan', '/p/ci')).toBe('sub/plan')
  })
})

// «a task never needs a plan»: the dialog asks
// what and who; the project derives from the owner, the plan is a folded
// default — never a finished plan, never another project's
const tk = (planKey: string, planTitle: string, folder: string | null, owner: string, state: PlanStatus) => ({
  planKey,
  planTitle,
  folder,
  owner,
  state,
  standingList: planKey.endsWith('/tasks'),
})
const CI = '/p/ci'
const SILOS = '/p/silos'
const tasks = [
  tk(`folder:${CI}/closing`, 'Closing', CI, 'finance', 'pending'),
  tk(`folder:${CI}/closing`, 'Closing', CI, 'finance', 'in_progress'),
  tk(`folder:${CI}/launch`, 'Launch', CI, 'finance', 'pending'),
  tk(`folder:${CI}/old`, 'Old', CI, 'finance', 'done'),
  tk(`folder:${CI}/old`, 'Old', CI, 'finance', 'cancelled'),
  tk(`folder:${SILOS}/ux`, 'UX', SILOS, 'finance', 'pending'),
  tk(`folder:${SILOS}/ux`, 'UX', SILOS, 'finance', 'pending'),
  tk(`folder:${SILOS}/ux`, 'UX', SILOS, 'finance', 'pending'),
]

describe("the project's list", () => {
  it('is the reserved project list of a project folder', () => {
    expect(standingKeyOf(CI)).toBe('folder:/p/ci/tasks')
    expect(isStandingPlan('folder:/p/ci/tasks')).toBe(true)
    expect(isStandingPlan('folder:/p/ci/backlog')).toBe(false) // no old names
    expect(isStandingPlan('folder:/p/ci/taskss')).toBe(false)
    expect(isStandingPlan('agent:finance/tasks')).toBe(false)
  })
})

describe('projectsFor / defaultProject', () => {
  const people = [agent('finance', 'Finance', CI, [SILOS]), agent('writer', 'Writer', SILOS), { ...agent('old', 'Old', '/p/gone'), archived: true }]
  it("an agent's task lives in its own folders, primary first", () => {
    expect(projectsFor('finance', people)).toEqual([CI, SILOS])
  })
  it('yours may live in any in-play project; the last one you used wins, else where most of your open tasks are', () => {
    expect(projectsFor('owner', people)).toEqual([CI, SILOS])
    expect(defaultProject('owner', [CI, SILOS], tasks, SILOS)).toBe(SILOS)
    expect(defaultProject('owner', [CI, SILOS], [tk(`folder:${SILOS}/ux`, 'UX', SILOS, 'owner', 'pending')], null)).toBe(SILOS)
    expect(defaultProject('owner', [CI, SILOS], [], '/p/gone')).toBe(CI)
    expect(defaultProject('owner', [], [], null)).toBe('')
  })
})

describe('planChoices / defaultPlan', () => {
  it("offers the standing list first and only the OPEN plans of THAT project (the bug: another project's plan, a finished one)", () => {
    const c = planChoices(tasks, CI, 'finance')
    expect(c.map((x) => x.planKey)).toEqual([standingKeyOf(CI), `folder:${CI}/closing`, `folder:${CI}/launch`])
    expect(c[0]).toMatchObject({ standing: true, title: '' })
  })
  it("defaults to the project's standing list ALWAYS — even where the owner has open named plans", () => {
    expect(defaultPlan(planChoices(tasks, CI, 'finance'))).toBe(standingKeyOf(CI))
    expect(defaultPlan(planChoices(tasks, '/p/empty', 'finance'))).toBe(standingKeyOf('/p/empty'))
    expect(defaultPlan(planChoices(tasks, CI, 'writer'))).toBe(standingKeyOf(CI))
  })
  it('a named plan only when New task was opened from it (and it is still offered)', () => {
    expect(defaultPlan(planChoices(tasks, CI, 'finance'), `folder:${CI}/closing`)).toBe(`folder:${CI}/closing`)
    expect(defaultPlan(planChoices(tasks, CI, 'finance'), 'folder:/elsewhere/x')).toBe(standingKeyOf(CI))
  })
  it('the standing list is offered even when every task in it is finished', () => {
    const c = planChoices([tk(standingKeyOf(CI), 'Tasks', CI, 'finance', 'done')], CI, 'finance')
    expect(c.map((x) => x.planKey)).toEqual([standingKeyOf(CI)])
  })
})
