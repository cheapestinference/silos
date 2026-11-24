// A Tasks view, a task's origin and a Home sheet as addresses: what the URL says survives a round trip, and what
// it should not say never gets through.
import { describe, expect, it } from 'vitest'
import { intentToSnapshot, parseTaskOrigin, routeToState, stateToRoute, taskOriginToken, type RouteSnapshot, type TaskOrigin } from '../src/lib/routes'
import { filterOfQuery, queryOfFilter } from '../src/lib/tasks'

const snap = (page: RouteSnapshot['page'], over: Partial<RouteSnapshot> = {}): RouteSnapshot => ({
  page,
  selected: null,
  newChatOpen: false,
  tab: 'threads',
  projectTab: 'now',
  ...over,
})
const roundTrip = (p: string): string => stateToRoute(intentToSnapshot(routeToState(p)))

describe('/tasks as an address', () => {
  it('a bare /tasks says nothing — the view falls back to what was remembered', () => {
    expect(routeToState('/tasks').page).toEqual({ kind: 'tasks' })
    expect(stateToRoute(snap({ kind: 'tasks' }))).toBe('/tasks')
  })

  it('view, layout and facets are read, in a fixed order, and repeat', () => {
    expect(stateToRoute(snap({ kind: 'tasks', agent: ['finance'], view: 'open' }))).toBe('/tasks?view=open&agent=finance')
    expect(routeToState('/tasks?agent=finance&agent=builder&layout=board&view=untouched').page).toEqual({
      kind: 'tasks',
      view: 'untouched',
      layout: 'board',
      agent: ['finance', 'builder'],
    })
  })

  it.each([
    '/tasks?view=open&agent=finance',
    '/tasks?view=mine&layout=tree',
    '/tasks?view=open&plan=folder%3A%2Fhome%2Fu%2Fproj%2Fship',
    '/tasks?project=%2Fhome%2Fu%2Fmy+project&project=%2Fhome%2Fu%2Fb',
    '/tasks?view=untouched&agent=builder&from=org',
    '/tasks?view=open&agent=writer&from=silo%3Ahierarchy',
  ])('%s survives the round trip', (p) => {
    expect(roundTrip(p)).toBe(p)
  })

  it('a word the view does not know is dropped, never a crash', () => {
    expect(routeToState('/tasks?view=nope&layout=grid&from=nowhere').page).toEqual({ kind: 'tasks' })
  })

  it('facets ⇄ the filter engine', () => {
    const f = filterOfQuery({ agent: ['finance', 'builder'], plan: ['k'] })
    expect([...f.agent!]).toEqual(['finance', 'builder'])
    expect(f.project).toBeUndefined()
    expect(queryOfFilter(f)).toEqual({ agent: ['finance', 'builder'], plan: ['k'], project: undefined })
    expect(queryOfFilter({})).toEqual({ agent: undefined, plan: undefined, project: undefined })
  })
})

describe("a task's origin", () => {
  const origins: TaskOrigin[] = [
    { kind: 'needs-you' },
    { kind: 'needs-you', folder: '/home/u/proj' },
    { kind: 'yours' },
    { kind: 'yours', folder: '/home/u/my proj' },
    { kind: 'org' },
    { kind: 'silo', id: 'hierarchy' },
    { kind: 'conversation', folder: '-home-u-proj', id: 'abc/def' },
    { kind: 'tasks', query: {} },
    { kind: 'tasks', query: { view: 'open', layout: 'board', agent: ['finance'] } },
    { kind: 'tasks', query: { view: 'untouched', project: ['/home/u/a&b=c'], from: { kind: 'org' } } },
  ]
  it.each(origins)('%j → token → the same origin', (o) => {
    expect(parseTaskOrigin(taskOriginToken(o))).toEqual(o)
  })

  it.each(origins)("%j rides a task's URL", (o) => {
    const page = { kind: 'task' as const, plan: 'folder:/home/u/proj/ship', task: 't1', from: o }
    const url = stateToRoute(snap(page))
    expect(routeToState(url).page).toEqual(page)
    expect(roundTrip(url)).toBe(url)
  })

  it('a task with no origin keeps its plain address; a corrupt one is dropped', () => {
    expect(stateToRoute(snap({ kind: 'task', plan: 'p', task: 't' }))).toBe('/task/p/t')
    expect(routeToState('/task/p/t?from=martian').page).toEqual({ kind: 'task', plan: 'p', task: 't' })
    expect(parseTaskOrigin('conversation:no-slash')).toBeUndefined()
    expect(parseTaskOrigin('silo:')).toBeUndefined()
  })
})

describe('a Home sheet', () => {
  it.each(['/?sheet=needs-you', '/?sheet=yours', '/project/%2Fhome%2Fu%2Fproj?sheet=needs-you'])('%s survives the round trip', (p) => {
    expect(roundTrip(p)).toBe(p)
  })
  it('an unknown sheet opens nothing; another project tab carries none', () => {
    expect(routeToState('/?sheet=nope').sheet).toBeUndefined()
    expect(stateToRoute(snap({ kind: 'project', folder: '/p' }, { projectTab: 'memory', sheet: 'yours' }))).toBe('/project/%2Fp/memory')
  })
})
