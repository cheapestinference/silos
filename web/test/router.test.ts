// router.test.ts — the store⇄URL bridge: a store navigation updates
// location.pathname; popstate applies the URL to the store; booting with a
// seeded URL restores the state. history/location are jsdom's.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { connectRouter, restoreFromUrl, closeHomeSheet, goBackTo, replacing, routeOf, __resetRouterForTests } from '../src/lib/router'
import type { AgentView, Automation, SessionDetail, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function agent(id: string, over: Partial<AgentView> = {}): AgentView {
  return { id, name: id, emoji: '🧠', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...over }
}

function sessionView(over: Partial<SessionView>): SessionView {
  return {
    id: 's9',
    folder: '/home/x',
    title: 't',
    skills: [],
    cwd: '/home/x',
    mtime: 0,
    size: 0,
    turnCount: 0,
    live: false,
    worktree: false,
    native: false,
    agentId: 'a1',
    ...over,
  }
}

let cleanup: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  __resetRouterForTests()
  window.history.replaceState(null, '', '/')
  useStore.setState({
    agents: [agent('a1'), agent('a2')],
    selectedAgentId: null,
    selected: null,
    detail: null,
    newChatOpen: false,
    agentFrom: null,
    knowsDrawer: null,
    page: null,
    tab: 'threads',
    projectTab: 'now',
    convPrefs: {},
    pendingConvPrefs: {},
    turnOverrides: {},
    unreadAgentIds: new Set(),
  })
})

afterEach(() => {
  cleanup?.()
  cleanup = null
})

// the store→URL sync only activates after boot (restoreFromUrl): we boot
// at '/' (navigates nowhere) to leave the router "live", same as App's real
// boot.
async function bootLive(): Promise<void> {
  cleanup = connectRouter()
  await restoreFromUrl()
}

// the store→URL sync coalesces into a microtask (a single history write
// per set() burst). A setTimeout(0) drains all pending microtasks before
// resolving, so after `tick()` the URL reflects the FINAL settled state —
// the exact point to measure.
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('store → URL', () => {
  it('selecting an agent pushes /agent/<id>', async () => {
    await bootLive()
    useStore.getState().selectAgent('a1')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1')
  })

  // a tab of a place is a stop — Back returns to it
  it('switching the dossier tab pushes (a tab is a stop)', async () => {
    await bootLive()
    useStore.getState().selectAgent('a1')
    await tick()
    const before = window.history.length
    useStore.getState().changeTab('identity')
    await tick()
    // identity lives under the Settings tab
    expect(window.location.pathname).toBe('/agent/a1/settings')
    expect(window.history.length).toBe(before + 1)
  })

  it('a Tasks filter or a Map view replaces (a view of one list)', async () => {
    await bootLive()
    useStore.getState().changePage({ kind: 'map' })
    await tick()
    const before = window.history.length
    useStore.getState().changePage({ kind: 'map', view: 'org' })
    await tick()
    useStore.getState().changePage({ kind: 'tasks' })
    await tick()
    useStore.getState().changePage({ kind: 'tasks', view: 'untouched' })
    await tick()
    expect(window.location.pathname + window.location.search).toBe('/tasks?view=untouched')
    expect(window.history.length).toBe(before + 1) // only the Map → Tasks move
  })

  it('the Knows Drawer is in-place UI, never an address: the conversation URL stays', async () => {
    await bootLive()
    useStore.setState({ page: { kind: 'agent', id: 'a1' }, selectedAgentId: 'a1', selected: { folder: '/home/x', id: 's9' }, knowsDrawer: null })
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
    useStore.getState().openKnows('mission')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
  })

  // an agent thing from a conversation NAVIGATES —
  // one pushed entry carrying ?from=, so Back returns to the conversation
  it('openDossier from a conversation pushes /agent/<id>/<facet>?from=<folder>/<id>; Back returns to the conversation', async () => {
    mockedApi.sessionDetail.mockResolvedValue({ meta: sessionView({ agentId: 'a1' }), turns: [], total: 0 })
    useStore.setState({ agents: [agent('a1', { sessions: [sessionView({})] }), agent('a2')] })
    await bootLive()
    await useStore.getState().openSession('/home/x', 's9')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
    const before = window.history.length
    useStore.getState().openDossier('memory')
    await tick()
    expect(window.location.pathname + window.location.search).toBe('/agent/a1/memory?from=%2Fhome%2Fx/s9')
    expect(window.history.length).toBe(before + 1) // a real page change: pushState
    const st = useStore.getState()
    expect(st.selected).toBeNull()
    expect(st.tab).toBe('memory')
    expect(st.agentFrom).toEqual({ folder: '/home/x', id: 's9' })
    // the browser's Back: the conversation again
    window.history.back()
    await new Promise((r) => setTimeout(r, 30))
    await tick()
    expect(useStore.getState().selected).toEqual({ folder: '/home/x', id: 's9' })
    expect(useStore.getState().agentFrom).toBeNull()
  })

  it('navigating to settings and its tab', async () => {
    await bootLive()
    useStore.getState().changePage({ kind: 'settings', tab: 'accounts' })
    await tick()
    expect(window.location.pathname).toBe('/settings/accounts')
  })

  it('automations and map (its views)', async () => {
    await bootLive()
    useStore.getState().changePage({ kind: 'automations' })
    await tick()
    expect(window.location.pathname).toBe('/automations')
    useStore.getState().changePage({ kind: 'map' })
    await tick()
    expect(window.location.pathname).toBe('/map')
    useStore.getState().changePage({ kind: 'map', view: 'org' })
    await tick()
    expect(window.location.pathname).toBe('/map/org')
  })

  // the dossier's facets are deep-linkable; 'board' is no longer a facet
  // (it's now the Threads toggle).
  // Settings and Secrets are addressed by their tab's name
  it("the agent page's Settings and Secrets tabs write /agent/<id>/settings and /secrets; a part of Now writes its id", async () => {
    await bootLive()
    useStore.getState().selectAgent('a1')
    await tick()
    useStore.getState().changeTab('identity')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/settings')
    useStore.getState().changeTab('vault')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/secrets')
    useStore.getState().changeTab('control')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/control')
  })

  it("a project's tab pushes /project/<folder>/<tab>; its Files on Artifacts is its own address", async () => {
    await bootLive()
    useStore.getState().changePage({ kind: 'project', folder: '/home/p' })
    await tick()
    useStore.getState().changeProjectTab('tools')
    await tick()
    expect(window.location.pathname).toBe('/project/%2Fhome%2Fp/tools')
    useStore.getState().changeProjectTab('files')
    useStore.getState().setFilesPart('artifacts')
    await tick()
    expect(window.location.pathname).toBe('/project/%2Fhome%2Fp/files/artifacts')
    useStore.getState().changeProjectTab('map')
    await tick()
    expect(window.location.pathname).toBe('/project/%2Fhome%2Fp/map')
  })

  it('pushes nothing BEFORE boot (the subscription is inert until restoreFromUrl)', async () => {
    cleanup = connectRouter()
    // with no restoreFromUrl yet: an early selection (e.g. loadOverview's
    // candidate) must NOT touch the URL.
    useStore.getState().selectAgent('a1')
    await tick()
    expect(window.location.pathname).toBe('/')
  })
})

// COMPOUND navigation gestures (several set() calls per gesture) must
// produce EXACTLY ONE history entry — previously each intermediate set()
// pushed its own and Back would land on a dossier nobody ever visited. The
// delta of window.history.length around the gesture is measured, which is
// the gap the older tests (single-set() actions only) didn't cover.
describe('compound gestures → a single history entry', () => {
  it('startNewConversation with a conversation open → one entry; Back returns to the conversation', async () => {
    const detail: SessionDetail = { meta: sessionView({ agentId: 'a1' }), turns: [], total: 0 }
    mockedApi.sessionDetail.mockResolvedValue(detail)
    useStore.setState({ agents: [agent('a1', { sessions: [sessionView({})] }), agent('a2')] })
    await bootLive()
    // open a conversation (the "before" state)
    useStore.getState().selectAgent('a1')
    await useStore.getState().openSession('/home/x', 's9')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
    const before = window.history.length
    // a compound gesture: closeSession + set(newChatOpen) in the same tick
    useStore.getState().startNewConversation()
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/new')
    expect(window.history.length - before).toBe(1) // ONE entry, not two
    // Back → the previous conversation (not an intermediate dossier)
    window.history.back()
    await tick()
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
    expect(useStore.getState().selected).toEqual({ folder: '/home/x', id: 's9' })
  })

  it('TWO separate gestures (open agent, then click a session) → two entries; Back returns to the dossier, not home', async () => {
    const detail: SessionDetail = { meta: sessionView({ agentId: 'a1' }), turns: [], total: 0 }
    mockedApi.sessionDetail.mockResolvedValue(detail)
    useStore.setState({ agents: [agent('a1', { sessions: [sessionView({})] }), agent('a2')] })
    await bootLive()
    // gesture 1: open the agent (one entry, /agent/a1)
    useStore.getState().selectAgent('a1')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1')
    const before = window.history.length
    // gesture 2, SEPARATE: click one of its sessions from the dossier
    await useStore.getState().openSession('/home/x', 's9')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
    // stacks ONE entry (does NOT collapse the dossier with replaceState)
    expect(window.history.length - before).toBe(1)
    // Back → the agent's dossier is still a stop (doesn't jump to home)
    window.history.back()
    await tick()
    await tick()
    expect(window.location.pathname).toBe('/agent/a1')
    expect(useStore.getState().selected).toBeNull()
  })

  it('⌘K: selectAgent + openSession (with await) → one entry', async () => {
    const detail: SessionDetail = { meta: sessionView({ agentId: 'a1' }), turns: [], total: 0 }
    mockedApi.sessionDetail.mockResolvedValue(detail)
    useStore.setState({ agents: [agent('a1', { sessions: [sessionView({})] }), agent('a2')] })
    await bootLive()
    // baseline: viewing another agent
    useStore.getState().selectAgent('a2')
    await tick()
    const before = window.history.length
    // the ⌘K jump: two actions, the second async (await api.sessionDetail)
    useStore.getState().selectAgent('a1')
    await useStore.getState().openSession('/home/x', 's9')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
    expect(window.history.length - before).toBe(1)
    // Back → the agent visible before the jump (not a1's intermediate dossier)
    window.history.back()
    await tick()
    await tick()
    expect(window.location.pathname).toBe('/agent/a2')
  })

  it('a link to the control block: selectAgent + changeTab → one entry', async () => {
    useStore.setState({ agents: [agent('a1'), agent('a2')] })
    await bootLive()
    useStore.getState().selectAgent('a2')
    await tick()
    const before = window.history.length
    useStore.getState().selectAgent('a1')
    useStore.getState().changeTab('control')
    await tick()
    expect(window.location.pathname).toBe('/agent/a1/control')
    expect(window.history.length - before).toBe(1)
  })
})

describe('URL → store (popstate)', () => {
  it('a popstate to /agent/a1/settings applies page+facet to the store', async () => {
    cleanup = connectRouter()
    window.history.pushState(null, '', '/agent/a1/settings')
    window.dispatchEvent(new PopStateEvent('popstate'))
    // the apply path is async (even though it touches no network here) — wait one tick
    await Promise.resolve()
    const st = useStore.getState()
    expect(st.page).toEqual({ kind: 'agent', id: 'a1' })
    expect(st.selectedAgentId).toBe('a1')
    expect(st.tab).toBe('identity')
  })

  it('a popstate to /agent/a1/control applies page+the control facet', async () => {
    cleanup = connectRouter()
    window.history.pushState(null, '', '/agent/a1/control')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await Promise.resolve()
    const st = useStore.getState()
    expect(st.page).toEqual({ kind: 'agent', id: 'a1' })
    expect(st.tab).toBe('control')
  })

  // the munged session-folder form lands on the known folder
  // and the address bar becomes the canonical one (replaceState).
  it('booting at /project/<munged folder> lands on the known folder and canonicalizes the URL', async () => {
    useStore.setState({ agents: [agent('a1', { folder: '/home/user/acme' })] })
    window.history.replaceState(null, '', '/project/-home-user-acme')
    await bootLive()
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/user/acme' })
    expect(window.location.pathname).toBe('/project/%2Fhome%2Fuser%2Facme')
  })

  it('a munged folder no one knows stays as typed (the page says so)', async () => {
    window.history.replaceState(null, '', '/project/-home-user-nowhere')
    await bootLive()
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '-home-user-nowhere' })
  })

  it('a popstate to /project/<folder>/map applies project+the map tab', async () => {
    cleanup = connectRouter()
    window.history.pushState(null, '', '/project/%2Fhome%2Fp/map')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await Promise.resolve()
    const st = useStore.getState()
    expect(st.page).toEqual({ kind: 'project', folder: '/home/p' })
    expect(st.projectTab).toBe('map')
  })

  // a retired address (the Board) is an unknown path: Home, and the
  // address is REWRITTEN in place — never a second entry
  it('booting at /board?view=… lands on Home and replaces the address with /', async () => {
    window.history.replaceState(null, '', '/board?view=waiting')
    const before = window.history.length
    await bootLive()
    expect(useStore.getState().page).toBeNull()
    expect(window.location.pathname + window.location.search).toBe('/')
    expect(window.history.length).toBe(before)
  })

  it('a popstate to a retired address (/board/automations, /constellation) lands on Home, rewritten in place', async () => {
    cleanup = connectRouter()
    for (const old of ['/board/automations', '/constellation']) {
      useStore.setState({ page: { kind: 'tasks' } })
      window.history.pushState(null, '', old)
      const before = window.history.length
      window.dispatchEvent(new PopStateEvent('popstate'))
      await tick()
      expect(useStore.getState().page, old).toBeNull()
      expect(window.location.pathname).toBe('/')
      expect(window.history.length).toBe(before)
    }
  })

  it('a popstate to a nonexistent agent falls back to home without breaking', async () => {
    cleanup = connectRouter()
    window.history.pushState(null, '', '/agent/DOESNOTEXIST')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await Promise.resolve()
    expect(useStore.getState().page).toBeNull()
    // the URL is canonicalized to '/' (a replaceState of the real final state)
    expect(window.location.pathname).toBe('/')
  })
})

describe('boot deep-link (restoreFromUrl)', () => {
  it('a seeded agent URL restores the dossier', async () => {
    window.history.replaceState(null, '', '/agent/a2/settings')
    cleanup = connectRouter()
    await restoreFromUrl()
    const st = useStore.getState()
    expect(st.selectedAgentId).toBe('a2')
    expect(st.page).toEqual({ kind: 'agent', id: 'a2' })
    expect(st.tab).toBe('identity')
  })

  it('a conversation URL calls openSession (fetches the detail)', async () => {
    const detail: SessionDetail = { meta: sessionView({ agentId: 'a1' }), turns: [], total: 0 }
    mockedApi.sessionDetail.mockResolvedValue(detail)
    // seed: the session exists on the agent
    useStore.setState({ agents: [agent('a1', { sessions: [sessionView({})] }), agent('a2')] })
    window.history.replaceState(null, '', '/agent/a1/c/%2Fhome%2Fx/s9')
    cleanup = connectRouter()
    await restoreFromUrl()
    expect(mockedApi.sessionDetail).toHaveBeenCalledWith('/home/x', 's9')
    const st = useStore.getState()
    expect(st.selected).toEqual({ folder: '/home/x', id: 's9' })
    expect(st.selectedAgentId).toBe('a1')
    // the canonical URL is kept (the real owner === the url)
    expect(window.location.pathname).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
  })

  it('a refresh on the agent page keeps the way back (?from=)', async () => {
    window.history.replaceState(null, '', '/agent/a1/memory?from=%2Fhome%2Fx/s9')
    cleanup = connectRouter()
    await restoreFromUrl()
    expect(useStore.getState().agentFrom).toEqual({ folder: '/home/x', id: 's9' })
    expect(useStore.getState().tab).toBe('memory')
    expect(window.location.pathname + window.location.search).toBe('/agent/a1/memory?from=%2Fhome%2Fx/s9')
  })

  it("a deleted conversation (sessionDetail rejects) falls back to the agent's dossier", async () => {
    mockedApi.sessionDetail.mockRejectedValue(new Error('deleted'))
    window.history.replaceState(null, '', '/agent/a1/c/%2Fhome%2Fx/sZ')
    cleanup = connectRouter()
    await restoreFromUrl()
    const st = useStore.getState()
    expect(st.selected).toBeNull()
    expect(st.selectedAgentId).toBe('a1')
    // canonicalizes to the agent's dossier
    expect(window.location.pathname).toBe('/agent/a1')
  })

  it('a seeded /files?path=<enc> URL restores the open file (the query is part of the deep-link)', async () => {
    window.history.replaceState(null, '', '/files?path=%2Fhome%2Fx%2Fplans%2Fa.plan.json')
    await bootLive()
    expect(useStore.getState().page).toEqual({ kind: 'files', path: '/home/x/plans/a.plan.json' })
  })

  it('booting at / navigates nowhere', async () => {
    window.history.replaceState(null, '', '/')
    cleanup = connectRouter()
    await restoreFromUrl()
    expect(useStore.getState().page).toBeNull()
    expect(window.location.pathname).toBe('/')
  })

  // no aliases — a retired address is an unknown path: Home, the
  // address bar rewritten in place, never a second entry
  it('a retired agent-settings URL lands on Home and REPLACES itself', async () => {
    for (const old of ['/agent/a1/identity', '/agent/a1/machinery', '/agent/a1/vault', '/agent/a1/settings/runs-on', '/agent/a1/settings/secrets']) {
      window.history.replaceState(null, '', old)
      const before = window.history.length
      cleanup?.()
      cleanup = connectRouter()
      await restoreFromUrl()
      expect(useStore.getState().page, old).toBeNull()
      expect(window.location.pathname).toBe('/')
      expect(window.history.length).toBe(before)
    }
  })
})

describe('automation — an honest deep-link', () => {
  it('a nonexistent automation id falls back to home (no dead end)', async () => {
    // with no automations loaded → an unknown id → home + canonicalizes to '/'
    useStore.setState({ automations: [] })
    window.history.replaceState(null, '', '/automation/DOESNOTEXIST')
    cleanup = connectRouter()
    await restoreFromUrl()
    expect(useStore.getState().page).toBeNull()
    expect(window.location.pathname).toBe('/')
  })

  it('an existing automation id navigates to its page', async () => {
    mockedApi.automations.runs.mockResolvedValue([])
    useStore.setState({ automations: [{ id: 'auto1' } as unknown as Automation] })
    window.history.replaceState(null, '', '/automation/auto1')
    cleanup = connectRouter()
    await restoreFromUrl()
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'auto1' })
    expect(window.location.pathname).toBe('/automation/auto1')
  })
})

// the browser's history is the only stack — a UI
// «back» walks it when its origin is below, and never stacks otherwise
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30))
  await tick()
}

describe('honest history — sheets, «back» links, redirects', () => {
  it('opening a sheet pushes; closing it is Back (the stack shrinks)', async () => {
    await bootLive()
    const before = window.history.length
    useStore.getState().setHomeSheet('needs-you')
    await tick()
    expect(window.location.search).toBe('?sheet=needs-you')
    expect(window.history.length).toBe(before + 1)
    closeHomeSheet()
    await settle()
    expect(window.location.pathname + window.location.search).toBe('/')
    expect(useStore.getState().homeSheet).toBeNull()
  })

  it('a sheet opened cold (its URL pasted) closes by replacing — never a new entry', async () => {
    window.history.replaceState(null, '', '/?sheet=yours')
    cleanup = connectRouter()
    await restoreFromUrl()
    expect(useStore.getState().homeSheet).toBe('yours')
    const before = window.history.length
    closeHomeSheet()
    await tick()
    expect(window.location.pathname + window.location.search).toBe('/')
    expect(window.history.length).toBe(before)
  })

  it("the agent page's «‹ conversation» after visiting tabs walks back to the conversation", async () => {
    mockedApi.sessionDetail.mockResolvedValue({ meta: sessionView({ agentId: 'a1' }), turns: [], total: 0 })
    useStore.setState({ agents: [agent('a1', { sessions: [sessionView({})] }), agent('a2')] })
    await bootLive()
    await useStore.getState().openSession('/home/x', 's9')
    await tick()
    const atConversation = window.history.length
    useStore.getState().openDossier('memory')
    await tick()
    useStore.getState().changeTab('skills')
    await tick()
    const from = useStore.getState().agentFrom!
    const open = vi.fn()
    goBackTo(routeOf({ page: { kind: 'agent', id: 'a1' }, selected: from }), open)
    await settle()
    expect(open).not.toHaveBeenCalled() // it was the browser's Back, not a new navigation
    expect(window.location.pathname).toBe('/agent/a1/c/%2Fhome%2Fx/s9')
    expect(useStore.getState().selected).toEqual({ folder: '/home/x', id: 's9' })
    // the next push drops the forward entries: the stack did not grow
    useStore.getState().changePage({ kind: 'vault' })
    await tick()
    expect(window.history.length).toBe(atConversation + 1)
  })

  it('a «back» whose origin is not below navigates by REPLACING (it never stacks)', async () => {
    await bootLive()
    useStore.getState().changePage({ kind: 'vault' })
    await tick()
    useStore.getState().changePage({ kind: 'task', plan: 'p', task: 't1', from: { kind: 'needs-you' } })
    await tick()
    const before = window.history.length
    goBackTo('/?sheet=needs-you', () => {
      useStore.getState().changePage(null)
      useStore.getState().setHomeSheet('needs-you')
    })
    await tick()
    expect(window.location.pathname + window.location.search).toBe('/?sheet=needs-you')
    expect(window.history.length).toBe(before)
    // and the flag does not leak: the next gesture pushes as usual
    useStore.getState().changePage({ kind: 'background' })
    await tick()
    expect(window.history.length).toBe(before + 1)
  })

  it('a redirect replaces: a page that resolves itself to another leaves no trap behind', async () => {
    await bootLive()
    useStore.getState().changePage({ kind: 'silo', id: 'support' })
    await tick()
    const before = window.history.length
    replacing(() => useStore.getState().changePage({ kind: 'silo', id: 'support', recordKey: 'agent:builder/c1' }))
    await tick()
    expect(window.location.pathname).toBe('/silo/support/r/agent%3Abuilder%2Fc1')
    expect(window.history.length).toBe(before)
  })

  it('a replacing gesture that changes nothing does not turn the next push into a replace', async () => {
    await bootLive()
    replacing(() => {})
    await tick()
    const before = window.history.length
    useStore.getState().changePage({ kind: 'vault' })
    await tick()
    expect(window.history.length).toBe(before + 1)
  })
})

describe('no store⇄URL loop', () => {
  it('applying a URL does not push history again', async () => {
    cleanup = connectRouter()
    window.history.pushState(null, '', '/agent/a1')
    const before = window.history.length
    window.dispatchEvent(new PopStateEvent('popstate'))
    await Promise.resolve()
    await Promise.resolve()
    // the state was applied but NO extra entry was pushed on top
    expect(window.history.length).toBe(before)
    expect(useStore.getState().selectedAgentId).toBe('a1')
  })
})
