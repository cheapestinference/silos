// nav-store.test.ts — the store's v1→v2 contract (nav/page/tab/
// contextOpen). Light mode: only what's genuinely used — nav.filter/
// groupBy/preset with their defaults + a minimal selectFilter (no UI
// yet), page/tab on selecting an agent, and contextOpen
// (default + persisted toggle).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { MASTER_ID } from '../src/lib/constants'
import type { AgentView } from '../src/lib/types'

vi.mock('../src/lib/api')

const mockedApi = vi.mocked(api, { deep: true })

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',

    folder: '/x',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    agents: [],
    selectedAgentId: null,
    selected: null,
    nav: { filter: {}, groupBy: 'project', preset: 'default' },
    page: null,
    tab: 'threads',
    projectTab: 'now',
    lastAgentId: null,
    lastProjectFolder: null,
    contextOpen: true,
    setupOpen: false,
    projectsPrefs: {},
  })
})

describe('nav — v1→v2 contract defaults', () => {
  it('starts with an empty filter, groupBy project and a preset', () => {
    const { nav } = useStore.getState()
    expect(nav.filter).toEqual({})
    expect(nav.groupBy).toBe('project')
    expect(typeof nav.preset).toBe('string')
  })

  it('selectFilter sets one axis without touching the others', () => {
    useStore.getState().selectFilter('project', ['/x'])
    useStore.getState().selectFilter('skill', ['finance'])
    expect(useStore.getState().nav.filter).toEqual({ project: ['/x'], skill: ['finance'] })
  })

  it('page starts as null (a cold start, before any selection)', () => {
    expect(useStore.getState().page).toBeNull()
  })
})

describe('page/tab — navigating to an agent', () => {
  it('selectAgent sets page={kind:"agent",id} and resets tab to threads (the dossier landing)', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', sessions: [] })], tab: 'identity' })
    useStore.getState().selectAgent('a1')
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'a1' })
    expect(useStore.getState().tab).toBe('threads')
  })

  it('changeTab only changes the active tab', () => {
    useStore.getState().changeTab('identity')
    expect(useStore.getState().tab).toBe('identity')
  })

  it('changePage navigates to a project or to settings', () => {
    useStore.getState().changePage({ kind: 'project', folder: '/x' })
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/x' })
    useStore.getState().changePage({ kind: 'settings' })
    expect(useStore.getState().page).toEqual({ kind: 'settings' })
  })
})

describe('contextOpen — the context column', () => {
  it('starts open by default', () => {
    expect(useStore.getState().contextOpen).toBe(true)
  })

  it('toggleContext collapses/expands optimistically and persists it', () => {
    mockedApi.patchPrefsContext.mockResolvedValue({})
    useStore.getState().toggleContext()
    expect(useStore.getState().contextOpen).toBe(false)
    expect(mockedApi.patchPrefsContext).toHaveBeenCalledWith(false)
    useStore.getState().toggleContext()
    expect(useStore.getState().contextOpen).toBe(true)
    expect(mockedApi.patchPrefsContext).toHaveBeenCalledWith(true)
  })

  it('loadPrefs applies the persisted context if the server brings it', async () => {
    mockedApi.prefs.mockResolvedValue({ contextOpen: false })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().contextOpen).toBe(false)
  })

  it('loadPrefs with no `contextOpen` in the response leaves the current value untouched', async () => {
    useStore.setState({ contextOpen: false })
    mockedApi.prefs.mockResolvedValue({})
    await useStore.getState().loadPrefs()
    expect(useStore.getState().contextOpen).toBe(false)
  })
})

// the context column's "Agent setup" zone: the same contract as contextOpen
// (optimistic + fire-and-forget persistence), but with the default INVERTED:
// collapsed (the column is operational-first).
describe("setupOpen — the context column's Setup zone", () => {
  it('starts collapsed by default', () => {
    expect(useStore.getState().setupOpen).toBe(false)
  })

  it('toggleSetup collapses/expands optimistically and persists it', () => {
    mockedApi.patchPrefsSetup.mockResolvedValue({})
    useStore.getState().toggleSetup()
    expect(useStore.getState().setupOpen).toBe(true)
    expect(mockedApi.patchPrefsSetup).toHaveBeenCalledWith(true)
    useStore.getState().toggleSetup()
    expect(useStore.getState().setupOpen).toBe(false)
    expect(mockedApi.patchPrefsSetup).toHaveBeenCalledWith(false)
  })

  it('loadPrefs applies the persisted `setup` if the server brings it', async () => {
    mockedApi.prefs.mockResolvedValue({ setup: true })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().setupOpen).toBe(true)
  })

  it('loadPrefs with no `setup` in the response leaves the current value untouched', async () => {
    mockedApi.prefs.mockResolvedValue({})
    await useStore.getState().loadPrefs()
    expect(useStore.getState().setupOpen).toBe(false)
  })
})

describe('askAgentAboutFile — edit-by-chat', () => {
  it('targets the agent whose folder contains the file, opens a new chat and seeds the composer', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', folder: '/proj' })] })
    useStore.getState().askAgentAboutFile('/proj/src/app.ts')
    const s = useStore.getState()
    expect(s.selectedAgentId).toBe('a1')
    expect(s.newChatOpen).toBe(true)
    expect(s.page).toEqual({ kind: 'agent', id: 'a1' })
    expect(s.composerSeed).toEqual({ agentId: 'a1', text: '`/proj/src/app.ts`\n\n' })
    // an owning agent already runs in its own folder — no cwd override.
    expect(s.chosenProject).toBeNull()
  })

  it('picks the DEEPEST owning folder when agents nest', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'outer', folder: '/proj' }), makeAgent({ id: 'inner', folder: '/proj/pkg' })],
    })
    useStore.getState().askAgentAboutFile('/proj/pkg/x.ts')
    expect(useStore.getState().selectedAgentId).toBe('inner')
  })

  it("falls back to the inbox (master) scoped to the file's directory when no agent owns it", () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', folder: '/other' })] })
    useStore.getState().askAgentAboutFile('/loose/notes.md')
    const s = useStore.getState()
    expect(s.selectedAgentId).toBe(MASTER_ID)
    expect(s.chosenProject).toBe('/loose') // the inbox runs where the file lives
    expect(s.newChatOpen).toBe(true)
    expect(s.composerSeed).toEqual({ agentId: MASTER_ID, text: '`/loose/notes.md`\n\n' })
  })

  it('does not treat a sibling folder with a shared prefix as the owner (path boundary)', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', folder: '/a/foo' })] })
    useStore.getState().askAgentAboutFile('/a/foobar/x.ts')
    // /a/foo is NOT a parent of /a/foobar → the inbox, not a1.
    expect(useStore.getState().selectedAgentId).toBe(MASTER_ID)
  })
})
