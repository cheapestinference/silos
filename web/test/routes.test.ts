// routes.test.ts — the pure URL router: stateToRoute/routeToState and
// their round-trip for EVERY Page variant + conversation + facet + tabs +
// encoding folders with special characters + an unknown path → home.
import { describe, expect, it } from 'vitest'
import { stateToRoute, routeToState, intentToSnapshot, contextKey, returnSteps, taskOriginRoute, type RouteSnapshot, type RouteIntent } from '../src/lib/routes'

// the canonical base snapshot (home) — each case overrides what it needs.
function snap(over: Partial<RouteSnapshot>): RouteSnapshot {
  return {
    page: null,
    selected: null,
    newChatOpen: false,
    tab: 'threads',
    projectTab: 'now',
    ...over,
  }
}

describe('stateToRoute — every variant', () => {
  it('home (null) → /', () => {
    expect(stateToRoute(snap({ page: null }))).toBe('/')
  })
  it('the agent dossier landing (threads) → /agent/<id>', () => {
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' } }))).toBe('/agent/a1')
  })
  it('the agent dossier with a facet → /agent/<id>/<facet>', () => {
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, tab: 'memory' }))).toBe('/agent/a1/memory')
  })
  it("Settings and Secrets are addressed by their tab's name; the other facets by id", () => {
    const at = (tab: 'identity' | 'vault' | 'control') => stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, tab }))
    expect(at('identity')).toBe('/agent/a1/settings')
    expect(at('vault')).toBe('/agent/a1/secrets')
    expect(at('control')).toBe('/agent/a1/control')
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, tab: 'vault', from: { folder: '/home/x', id: 's9' } }))).toBe(
      '/agent/a1/secrets?from=%2Fhome%2Fx/s9',
    )
  })
  it("the agent's new chat → /agent/<id>/new", () => {
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, newChatOpen: true }))).toBe('/agent/a1/new')
  })
  it('the agent page reached from a conversation → /agent/<id>[/<facet>]?from=<folder>/<id>', () => {
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, tab: 'memory', from: { folder: '/home/x', id: 's9' } }))).toBe(
      '/agent/a1/memory?from=%2Fhome%2Fx/s9',
    )
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, from: { folder: '-home-x', id: 's9' } }))).toBe('/agent/a1?from=-home-x/s9')
  })
  it('a conversation → /agent/<id>/c/<folder>/<sessionId>', () => {
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, selected: { folder: '/home/x', id: 's9' } }))).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
  })
  it('a conversation is the conversation alone (no facet segment)', () => {
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, selected: { folder: '/home/x', id: 's9' } }))).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
  })
  it('the project overview (landing) → /project/<folder>', () => {
    expect(stateToRoute(snap({ page: { kind: 'project', folder: '/home/p' } }))).toBe('/project/%2Fhome%2Fp')
  })
  it('a project with a machinery piece unfolded → /project/<folder>/<piece>', () => {
    expect(stateToRoute(snap({ page: { kind: 'project', folder: '/home/p' }, projectTab: 'map' }))).toBe('/project/%2Fhome%2Fp/map')
  })
  it('settings with no tab → /settings', () => {
    expect(stateToRoute(snap({ page: { kind: 'settings' } }))).toBe('/settings')
  })
  it('settings with a tab → /settings/<tab>', () => {
    expect(stateToRoute(snap({ page: { kind: 'settings', tab: 'accounts' } }))).toBe('/settings/accounts')
  })
  it('automation → /automation/<id>', () => {
    expect(stateToRoute(snap({ page: { kind: 'automation', id: 'auto-7' } }))).toBe('/automation/auto-7')
  })
  it('the automations list → /automations', () => {
    expect(stateToRoute(snap({ page: { kind: 'automations' } }))).toBe('/automations')
  })
  it("the automations list narrowed to one agent → /automations?agent=<id> (Tasks' grammar)", () => {
    expect(stateToRoute(snap({ page: { kind: 'automations', agent: 'a b' } }))).toBe('/automations?agent=a%20b')
  })
  it('map with no view (Wiring, the landing) → /map', () => {
    expect(stateToRoute(snap({ page: { kind: 'map' } }))).toBe('/map')
  })
  it("System's landing (Vitals) → /system, and back", () => {
    expect(stateToRoute(snap({ page: { kind: 'system' } }))).toBe('/system')
    expect(routeToState('/system')).toEqual({ page: { kind: 'system' } })
    expect(routeToState('/system/x')).toEqual({ page: null })
  })
  it('files with no open file → /files', () => {
    expect(stateToRoute(snap({ page: { kind: 'files' } }))).toBe('/files')
  })
  it('files with an open file → /files?path=<enc>', () => {
    expect(stateToRoute(snap({ page: { kind: 'files', path: '/home/x/a.md' } }))).toBe('/files?path=%2Fhome%2Fx%2Fa.md')
  })
  it('a silo → /silo/<id>', () => {
    expect(stateToRoute(snap({ page: { kind: 'silo', id: 'support' } }))).toBe('/silo/support')
  })
})

describe('routeToState — parsing', () => {
  it('/ → home', () => {
    expect(routeToState('/')).toEqual({ page: null })
  })
  it('/agent/a1 → the dossier landing (no facet)', () => {
    expect(routeToState('/agent/a1')).toEqual({ page: { kind: 'agent', id: 'a1' } })
  })
  it('/agent/a1/memory → a facet', () => {
    expect(routeToState('/agent/a1/memory')).toEqual({ page: { kind: 'agent', id: 'a1' }, facet: 'memory' })
  })
  it('/agent/a1/settings → the Settings tab; /secrets → the Secrets tab; /control → its control block on Now', () => {
    const page = { kind: 'agent', id: 'a1' }
    expect(routeToState('/agent/a1/settings')).toEqual({ page, facet: 'identity' })
    expect(routeToState('/agent/a1/secrets')).toEqual({ page, facet: 'vault' })
    // a task whose owner works in another project opens on «Give to…» — the address round-trips
    expect(routeToState('/task/plan%3Ap/t1?give=1')).toEqual({ page: { kind: 'task', plan: 'plan:p', task: 't1', give: true } })
    expect(stateToRoute(snap({ page: { kind: 'task', plan: 'plan:p', task: 't1', give: true } }))).toBe('/task/plan%3Ap/t1?give=1')
    // «Add a secret» opened from a project starts on it — the address round-trips
    expect(routeToState('/vault?add=project%3A%2Fhome%2Fuser%2Facme')).toEqual({ page: { kind: 'vault', add: 'project:/home/user/acme' } })
    expect(stateToRoute(snap({ page: { kind: 'vault', add: 'agent:builder' } }))).toBe('/vault?add=agent%3Abuilder')
    expect(routeToState('/agent/a1/control')).toEqual({ page, facet: 'control' })
    expect(routeToState('/agent/a1/secrets?from=%2Fhome%2Fx/s9')).toEqual({ page, facet: 'vault', from: { folder: '/home/x', id: 's9' } })
  })
  it('the retired addresses have no alias: sub-sections of Settings and the raw facet ids land on Home', () => {
    for (const p of [
      '/agent/a1/settings/identity',
      '/agent/a1/settings/runs-on',
      '/agent/a1/settings/secrets',
      '/agent/a1/settings/automations',
      '/agent/a1/settings/nope',
      '/agent/a1/identity',
      '/agent/a1/vault',
      '/agent/a1/machinery',
      '/agent/a1/machinery?from=%2Fhome%2Fx/s9',
      '/agent/a1/toString',
      // the agent's automations live on the Automations page (?agent=)
      '/agent/a1/automations',
    ])
      expect(routeToState(p), p).toEqual({ page: null })
    // facets addressed by their id keep their own address
    const canon = (p: string) => stateToRoute(intentToSnapshot(routeToState(p)))
    expect(canon('/agent/a1/memory')).toBe('/agent/a1/memory')
    expect(canon('/agent/a1/mission')).toBe('/agent/a1/mission')
  })
  it('/agent/a1/new → a new chat', () => {
    expect(routeToState('/agent/a1/new')).toEqual({ page: { kind: 'agent', id: 'a1' }, newChat: true })
  })
  it('?from=<folder>/<id> → the agent page with its way back', () => {
    expect(routeToState('/agent/a1/memory?from=%2Fhome%2Fx/s9')).toEqual({
      page: { kind: 'agent', id: 'a1' },
      facet: 'memory',
      from: { folder: '/home/x', id: 's9' },
    })
    expect(routeToState('/agent/a1?from=%2Fhome%2Fx/s9')).toEqual({ page: { kind: 'agent', id: 'a1' }, from: { folder: '/home/x', id: 's9' } })
    // a malformed from is ignored, never a crash
    expect(routeToState('/agent/a1?from=nosession')).toEqual({ page: { kind: 'agent', id: 'a1' } })
  })
  it('a conversation', () => {
    expect(routeToState('/agent/a1/c/%2Fhome%2Fx/s9')).toEqual({
      page: { kind: 'agent', id: 'a1' },
      session: { folder: '/home/x', id: 's9' },
    })
  })
  it('a project with a tab', () => {
    expect(routeToState('/project/%2Fhome%2Fp/memory')).toEqual({
      page: { kind: 'project', folder: '/home/p' },
      projectTab: 'memory',
    })
  })
  it('/project/<folder>/<tab> → the tab by its name: skills, tools, files', () => {
    for (const tab of ['skills', 'tools', 'files'] as const) {
      expect(routeToState(`/project/%2Fhome%2Fp/${tab}`)).toEqual({ page: { kind: 'project', folder: '/home/p' }, projectTab: tab })
    }
  })
  it('the Files tab on Artifacts is an address on both pages', () => {
    expect(routeToState('/project/%2Fhome%2Fp/files/artifacts')).toEqual({
      page: { kind: 'project', folder: '/home/p' },
      projectTab: 'files',
      filesPart: 'artifacts',
    })
    expect(stateToRoute(snap({ page: { kind: 'project', folder: '/home/p' }, projectTab: 'files', filesPart: 'artifacts' }))).toBe(
      '/project/%2Fhome%2Fp/files/artifacts',
    )
    expect(routeToState('/agent/a1/context/artifacts')).toEqual({ page: { kind: 'agent', id: 'a1' }, facet: 'context', filesPart: 'artifacts' })
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, tab: 'context', filesPart: 'artifacts' }))).toBe('/agent/a1/context/artifacts')
    // the part only rides its own tab
    expect(stateToRoute(snap({ page: { kind: 'agent', id: 'a1' }, tab: 'memory', filesPart: 'artifacts' }))).toBe('/agent/a1/memory')
  })
  it('the Files page rooted at a folder → /files?folder=, an open file beside it', () => {
    expect(routeToState('/files?folder=%2Fhome%2Fp')).toEqual({ page: { kind: 'files', folder: '/home/p', path: undefined } })
    expect(stateToRoute(snap({ page: { kind: 'files', folder: '/home/p', path: '/home/p/a.md' } }))).toBe('/files?folder=%2Fhome%2Fp&path=%2Fhome%2Fp%2Fa.md')
  })
  it('/project/<folder>/map → the map tab', () => {
    expect(routeToState('/project/%2Fhome%2Fp/map')).toEqual({
      page: { kind: 'project', folder: '/home/p' },
      projectTab: 'map',
    })
  })
  it('/map → the Map, no view (Uses, the landing)', () => {
    expect(routeToState('/map')).toEqual({ page: { kind: 'map' } })
  })

  it('/automations → every automation, one list', () => {
    expect(routeToState('/automations')).toEqual({ page: { kind: 'automations' } })
  })
  it('/automations?agent=<id> → the same list narrowed to that agent; the old /automations/<id> has no alias', () => {
    expect(routeToState('/automations?agent=a%20b')).toEqual({ page: { kind: 'automations', agent: 'a b' } })
    expect(routeToState('/automations/a%20b')).toEqual({ page: null })
    expect(routeToState('/automations/a/b')).toEqual({ page: null })
  })
  it('/files → files mode, no open file', () => {
    expect(routeToState('/files')).toEqual({ page: { kind: 'files' } })
  })
  it('/files?path=<enc> → files mode with the open file', () => {
    expect(routeToState('/files?path=%2Fhome%2Fx%2Fa.md')).toEqual({ page: { kind: 'files', path: '/home/x/a.md' } })
  })
  // retired addresses have no alias (no legacy compat):
  // each one is unknown now, and an unknown path lands on Home
  it('the retired addresses land on Home: the Board, Constellation, Support, Settings › Vault, facets over a conversation or a new chat', () => {
    for (const p of [
      '/board',
      '/board/automations',
      '/board/conversations',
      '/board?view=waiting',
      '/constellation',
      '/support',
      '/support/c1',
      '/silo/support/id/c1',
      '/settings/vault',
      '/agent/a1/new/identity',
      '/agent/a1/new/memory',
      '/agent/a1/c/%2Fhome%2Fx/s9/identity',
      '/agent/a1/c/%2Fhome%2Fx/s9/memory',
    ])
      expect(routeToState(p), p).toEqual({ page: null })
  })
})

describe('routeToState — unknown / invalid → home', () => {
  const bad = [
    '/whatever',
    '/agent', // no id
    '/agent/a1/badfacet',
    '/agent/a1/c/onlythefolder', // no sessionId
    '/agent/a1/c/f/s/badfacet',
    '/agent/a1/new/badfacet',
    '/agent/a1/new/memory/extra',
    '/project', // no folder
    '/project/%2Fx/badtab',
    // retired names are gone, not aliased
    '/project/%2Fx/overview',
    '/project/%2Fx/vault',
    '/project/%2Fx/artifacts',
    '/project/%2Fx/settings',
    '/project/%2Fx/memory/artifacts',
    '/agent/a1/memory/artifacts',
    '/map/graph',
    '/constellation',
    '/settings/badtab',
    '/automation', // no id
    '/automation/x/extra',
    '/map/extra',
    '/map/uses', // Uses is the bare Map since the Wiring view retired
  ]
  for (const p of bad) {
    it(`${p} → home`, () => {
      expect(routeToState(p)).toEqual({ page: null })
    })
  }
})

describe('round-trip state→url→state (every variant)', () => {
  const routes = [
    '/',
    '/agent/a1',
    '/agent/a1/memory',
    '/agent/a1/settings',
    '/agent/a1/secrets',
    '/agent/a1/control',
    '/agent/a1/new',
    '/agent/a1/settings?from=%2Fhome%2Fx/s9',
    '/agent/a1/memory?from=%2Fhome%2Fx/s9',
    '/agent/a1?from=-home-x/s9',
    '/agent/a1/c/%2Fhome%2Fx/s9',
    '/project/%2Fhome%2Fp',
    '/project/%2Fhome%2Fp/memory',
    '/project/%2Fhome%2Fp/map',
    '/project/%2Fhome%2Fp/skills',
    '/project/%2Fhome%2Fp/tools',
    '/project/%2Fhome%2Fp/files',
    '/project/%2Fhome%2Fp/files/artifacts',
    '/agent/a1/context/artifacts',
    '/files?folder=%2Fhome%2Fp',
    '/settings',
    '/settings/accounts',
    '/settings/engines',
    '/automation/auto-7',
    '/automations',
    '/automations?agent=builder',
    '/map',
    '/vault?entry=e1',
    '/map/org',
    '/vault',
    '/settings/silos',
  ]
  for (const route of routes) {
    it(`${route} survives the round-trip`, () => {
      // url → intent → canonical snapshot → url ⇒ must be identical
      expect(stateToRoute(intentToSnapshot(routeToState(route)))).toBe(route)
    })
  }
})

describe('encoding folders/ids with special characters', () => {
  const cases: { folder: string; id: string }[] = [
    { folder: '/home/user/my project', id: 's 1' },
    { folder: '/home/user/year#2', id: 'a/b' },
    { folder: '/home/user/100%', id: 'x?y=z' },
    { folder: '/home/user/π-λ', id: 'ç' },
  ]
  for (const { folder, id } of cases) {
    it(`${folder} · ${id} round-trips`, () => {
      const s = snap({ page: { kind: 'agent', id: 'a1' }, selected: { folder, id } })
      const url = stateToRoute(s)
      // each dynamic segment is a single component (no raw '/' that would
      // break the split) except for the /agent/a1/c/ prefix
      expect(url.startsWith('/agent/a1/c/')).toBe(true)
      const parsed = routeToState(url)
      expect(parsed.session).toEqual({ folder, id })
    })
  }

  it('a project folder with spaces and # survives', () => {
    const s = snap({ page: { kind: 'project', folder: '/home/a b/c#d' }, projectTab: 'tools' })
    const url = stateToRoute(s)
    const parsed = routeToState(url)
    expect(parsed.page).toEqual({ kind: 'project', folder: '/home/a b/c#d' })
    expect(parsed.projectTab).toBe('tools')
  })
})

describe('parse robustness', () => {
  it('discards the query string and hash', () => {
    expect(routeToState('/agent/a1/memory?foo=bar#section')).toEqual({
      page: { kind: 'agent', id: 'a1' },
      facet: 'memory',
    })
  })
  it('a corrupt %-encoding does not blow up', () => {
    expect(() => routeToState('/project/%zz')).not.toThrow()
  })
  it('trailing/double slashes are tolerated', () => {
    expect(routeToState('/agent/a1//settings/')).toEqual({ page: { kind: 'agent', id: 'a1' }, facet: 'identity' })
  })
})

// the history's grammar: the browser's history is
// the only stack. Same stop ⇒ replace; another stop ⇒ push.
describe('contextKey — push vs replace', () => {
  it('a tab of a place is its own stop (⇒ push): agent, project, Settings', () => {
    expect(contextKey('/agent/a1')).not.toBe(contextKey('/agent/a1/settings'))
    expect(contextKey('/project/%2Fp')).not.toBe(contextKey('/project/%2Fp/memory'))
    expect(contextKey('/settings/access')).not.toBe(contextKey('/settings/accounts'))
  })
  it('every Settings section by one criterion — Silos included', () => {
    expect(contextKey('/settings/silos')).toBe('settings:silos')
    expect(contextKey('/settings/silos')).not.toBe(contextKey('/settings/skills'))
    // a bare /settings is the section it paints (⇒ replace)
    expect(contextKey('/settings')).toBe(contextKey('/settings/access'))
  })
  // no aliases: the old tab ids and the old /silos address are gone —
  // an unknown path falls to Home
  it('the retired Settings addresses fall to Home', () => {
    for (const old of [
      '/settings/account',
      '/settings/providers',
      '/settings/agents',
      '/settings/projects',
      '/settings/memory',
      '/settings/tools',
      '/settings/sessions',
      '/silos',
    ]) {
      expect(routeToState(old).page, old).toBeNull()
    }
  })
  it("a sheet over Home or a project's Now is a stop (⇒ push, Back closes it)", () => {
    expect(contextKey('/')).not.toBe(contextKey('/?sheet=needs-you'))
    expect(contextKey('/?sheet=needs-you')).not.toBe(contextKey('/?sheet=yours'))
    expect(contextKey('/project/%2Fp')).not.toBe(contextKey('/project/%2Fp?sheet=yours'))
  })
  it('filters, views and values riding along are the same stop (⇒ replace)', () => {
    expect(contextKey('/tasks')).toBe(contextKey('/tasks?view=untouched&layout=board&agent=builder'))
    expect(contextKey('/map')).toBe(contextKey('/map/org'))
    expect(contextKey('/automations')).toBe(contextKey('/automations?agent=builder'))
    expect(contextKey('/automation/new')).toBe(contextKey('/automation/new?agent=builder'))
  })
  it('a thing opened over its list is a stop (⇒ push): a file, a template', () => {
    expect(contextKey('/files')).not.toBe(contextKey('/files?path=%2Fa'))
    expect(contextKey('/files?path=%2Fa')).not.toBe(contextKey('/files?path=%2Fb'))
    expect(contextKey('/automation/new')).not.toBe(contextKey('/automation/new?template=t1'))
  })
  it('leaving a conversation for its agent page DOES change the context (⇒ push, so Back returns)', () => {
    expect(contextKey('/agent/a1/c/f/s')).not.toBe(contextKey('/agent/a1/settings?from=f/s'))
  })
  it('the return chip (?from=) is not a place: the same tab with or without it is one stop', () => {
    expect(contextKey('/agent/a1/memory')).toBe(contextKey('/agent/a1/memory?from=f/s'))
  })
  it('a conversation is one stop whichever agent the URL names (its owner canonicalizes by replace)', () => {
    expect(contextKey('/agent/a1/c/f/s')).toBe(contextKey('/agent/a2/c/f/s'))
  })
  it('changing agent DOES change the context (⇒ push)', () => {
    expect(contextKey('/agent/a1')).not.toBe(contextKey('/agent/a2'))
  })
  it('the dossier vs a new chat of the same agent are different contexts', () => {
    expect(contextKey('/agent/a1')).not.toBe(contextKey('/agent/a1/new'))
  })
  it('different conversations of the same agent are different contexts', () => {
    expect(contextKey('/agent/a1/c/f/s1')).not.toBe(contextKey('/agent/a1/c/f/s2'))
  })
})

// a UI «back» link walks the browser's own stack when its target is below
// — over entries of the current place only — and otherwise navigates
describe('returnSteps — a «back» link is Back when its origin is below', () => {
  it('the entry right below is the origin → 1', () => {
    expect(returnSteps(['/', '/agent/a1/c/f/s'], '/agent/a1/memory?from=f/s', '/agent/a1/c/f/s')).toBe(1)
  })
  it('walks back over the tabs of the same place', () => {
    const trail = ['/', '/agent/a1/c/f/s', '/agent/a1/memory?from=f/s', '/agent/a1/skills?from=f/s']
    expect(returnSteps(trail, '/agent/a1/tools?from=f/s', '/agent/a1/c/f/s')).toBe(3)
  })
  it('walks back over the tasks stepped through (‹ n of N ›)', () => {
    const trail = ['/?sheet=needs-you', '/task/p/t1?from=needs-you', '/task/p/t2?from=needs-you']
    expect(returnSteps(trail, '/task/p/t3?from=needs-you', '/?sheet=needs-you')).toBe(3)
  })
  it('the conversation is recognised whichever agent its URL names', () => {
    expect(returnSteps(['/agent/a1/c/f/s'], '/agent/a1?from=f/s', '/agent/master/c/f/s')).toBe(1)
  })
  it('another place in between → 0 (navigate, never jump over it)', () => {
    const trail = ['/agent/a1/c/f/s', '/vault', '/agent/a1/memory?from=f/s']
    expect(returnSteps(trail, '/agent/a1/skills?from=f/s', '/agent/a1/c/f/s')).toBe(0)
  })
  it('a cold entry (no trail: a pasted link, a push notification) → 0', () => {
    expect(returnSteps([], '/task/p/t1?from=needs-you', '/?sheet=needs-you')).toBe(0)
  })
  it('closing a sheet: Back when the page under it is right below', () => {
    expect(returnSteps(['/'], '/?sheet=yours', '/')).toBe(1)
    expect(returnSteps(['/vault'], '/?sheet=yours', '/')).toBe(0)
  })
  it('a filter of the origin still counts as the origin (the same stop)', () => {
    expect(returnSteps(['/tasks?view=untouched'], '/task/p/t1?from=tasks%3Aview%3Duntouched', '/tasks?view=untouched&layout=list')).toBe(1)
  })
})

describe("taskOriginRoute — where a task's «back» leads", () => {
  it('each origin as its address', () => {
    expect(taskOriginRoute(undefined)).toBe('/tasks')
    expect(taskOriginRoute({ kind: 'needs-you' })).toBe('/?sheet=needs-you')
    expect(taskOriginRoute({ kind: 'yours', folder: '/p' })).toBe('/project/%2Fp?sheet=yours')
    expect(taskOriginRoute({ kind: 'tasks', query: { view: 'untouched' } })).toBe('/tasks?view=untouched')
    expect(taskOriginRoute({ kind: 'org' })).toBe('/map/org')
    expect(taskOriginRoute({ kind: 'silo', id: 'plans' })).toBe('/silo/plans')
    expect(contextKey(taskOriginRoute({ kind: 'conversation', folder: 'f', id: 's' }))).toBe(contextKey('/agent/a1/c/f/s'))
  })
})

// a type echo: RouteIntent is trivially serializable (a compile-time guard).
const _exampleIntent: RouteIntent = { page: { kind: 'agent', id: 'x' }, newChat: true }
void _exampleIntent

// the Vault page (its own view, out of Settings).
describe('vault page route', () => {
  it('/vault round-trips; deeper paths fall to home', () => {
    expect(stateToRoute(snap({ page: { kind: 'vault' } }))).toBe('/vault')
    expect(routeToState('/vault')).toEqual({ page: { kind: 'vault' } })
    expect(routeToState('/vault/extra')).toEqual({ page: null })
  })
  it('the Vault is its own context (⇒ push from anywhere else)', () => {
    expect(contextKey('/vault')).toBe('vault')
    expect(contextKey('/vault')).not.toBe(contextKey('/settings'))
  })
})

// the Silo Standard's pages (Task 8): a silo's list and one record's page.
describe('silo pages routes', () => {
  it('/silo/<id> and /silo/<id>/r/<key> round-trip; the key is one encoded segment', () => {
    expect(stateToRoute(snap({ page: { kind: 'silo', id: 'invoices' } }))).toBe('/silo/invoices')
    expect(routeToState('/silo/invoices')).toEqual({ page: { kind: 'silo', id: 'invoices' } })
    // the record key 'agent:finance/a1' holds ':' and '/'
    const url = stateToRoute(snap({ page: { kind: 'silo', id: 'invoices', recordKey: 'agent:finance/a1' } }))
    expect(url).toBe('/silo/invoices/r/agent%3Afinance%2Fa1')
    expect(routeToState(url)).toEqual({ page: { kind: 'silo', id: 'invoices', recordKey: 'agent:finance/a1' } })
    expect(stateToRoute(intentToSnapshot(routeToState(url)))).toBe(url)
  })
  it('malformed silo paths fall to home', () => {
    expect(routeToState('/silo')).toEqual({ page: null })
    expect(routeToState('/silo/invoices/r')).toEqual({ page: null })
    expect(routeToState('/silo/invoices/x/y')).toEqual({ page: null })
  })
  it('the record page is its own stop — Back from a record returns to the list', () => {
    expect(contextKey('/silo/invoices')).toBe('silo:invoices')
    expect(contextKey('/silo/invoices/r/agent%3Afinance%2Fa1')).not.toBe(contextKey('/silo/invoices'))
    expect(contextKey('/silo/invoices')).not.toBe(contextKey('/silo/documents'))
  })
  it('/silo/<id>/review is the install dialog — its own stop, round-trips', () => {
    const url = stateToRoute(snap({ page: { kind: 'silo', id: 'support', review: true } }))
    expect(url).toBe('/silo/support/review')
    expect(routeToState(url)).toEqual({ page: { kind: 'silo', id: 'support', review: true } })
    expect(stateToRoute(intentToSnapshot(routeToState(url)))).toBe(url)
    expect(contextKey(url)).toBe('silo:support:review')
    expect(routeToState('/silo/support/reviews')).toEqual({ page: null })
  })
})

// task-view phase 2: «Tasks» names plan tasks (the view + one task's page);
// the background-work page (c1) moved to /background — never two Tasks.
describe('tasks and background routes', () => {
  it('/tasks round-trips', () => {
    expect(stateToRoute(snap({ page: { kind: 'tasks' } }))).toBe('/tasks')
    expect(routeToState('/tasks')).toEqual({ page: { kind: 'tasks' } })
    expect(routeToState('/tasks/extra')).toEqual({ page: null })
    expect(contextKey('/tasks')).toBe('tasks')
  })

  it('/task/<plan key>/<task id>: the plan key (with / and :) is ONE encoded segment', () => {
    const plan = 'folder:/home/u/proj/ship-public-repo'
    const url = stateToRoute(snap({ page: { kind: 'task', plan, task: 't2' } }))
    expect(url).toBe(`/task/${encodeURIComponent(plan)}/t2`)
    expect(routeToState(url)).toEqual({ page: { kind: 'task', plan, task: 't2' } })
    expect(stateToRoute(intentToSnapshot(routeToState(url)))).toBe(url)
    // two tasks are two stops (Back returns from one to the other)
    expect(contextKey(url)).not.toBe(contextKey(stateToRoute(snap({ page: { kind: 'task', plan, task: 't3' } }))))
    expect(routeToState('/task/x')).toEqual({ page: null })
    expect(routeToState('/task/x/t1/extra')).toEqual({ page: null })
  })

  it('/background is the background-work page (c1)', () => {
    expect(stateToRoute(snap({ page: { kind: 'background' } }))).toBe('/background')
    expect(routeToState('/background')).toEqual({ page: { kind: 'background' } })
    expect(routeToState('/background/x')).toEqual({ page: null })
  })
})

// Usage: an address — period, view and agent ride
// the query; the defaults (today, by agent) are left out
describe('usage route', () => {
  it('round-trips /usage with its period, view and agent', () => {
    expect(stateToRoute(snap({ page: { kind: 'usage' } }))).toBe('/usage')
    expect(stateToRoute(snap({ page: { kind: 'usage', agent: 'builder', period: 'today' } }))).toBe('/usage?agent=builder')
    expect(stateToRoute(snap({ page: { kind: 'usage', period: '30d', by: 'automation' } }))).toBe('/usage?period=30d&by=automation')
    expect(routeToState('/usage?period=7d&by=conversation&agent=builder')).toEqual({
      page: { kind: 'usage', period: '7d', by: 'conversation', agent: 'builder' },
    })
    expect(routeToState('/usage?period=year&by=mood')).toEqual({ page: { kind: 'usage' } })
    expect(routeToState('/usage/x')).toEqual({ page: null })
  })
})
