// knows-drawer.test.tsx — the Knows Drawer over the conversation (the
// drawer shows the LIBRARY, narrow). A panel anchored to the
// context column's edge, over the transcript's edge only (never inset-0):
// kinds as tabs (Memory / Skills / Context …), search, facets that actually
// split the list (a note's type, "not in its index", "this week", "this
// conversation"), and groups by what decides how an item reaches the agent —
// "Always in its head" then the notes by era; skills by where they come from
// and whether the engine loads them. Esc / ✕ / a click outside close it and
// focus goes back to what opened it. The toast's openItem and the "+" add
// mode keep the older item panel (DrawerPanel); In charge keeps its panel.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { KnowsDrawer } from '../src/components/knows/KnowsDrawer'
import { KnowsLibrary } from '../src/components/knows/KnowsLibrary'
import type { KnowsSources } from '../src/components/knows/KnowsAnatomy'
import { AgentPage } from '../src/components/AgentPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { MASTER_ID } from '../src/lib/constants'
import type { AgentView, ContextFile, MemoryFileInfo, MemoryLayers, SessionView, SkillCatalogEntry } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const NOW = Date.now()
const DAY = 86_400_000
const mem = (name: string, path: string, scope: 'global' | 'project' | 'auto' | 'agent', extra: Partial<MemoryFileInfo> = {}): MemoryFileInfo => ({
  name,
  path,
  scope,
  mtime: NOW - 60 * DAY,
  exists: true,
  ...extra,
})
// two notes: an old reference the index does not name, and a project note
// written today BY THIS conversation (origin = the open session s1)
const layers: MemoryLayers = {
  global: mem('CLAUDE.md', '/home/CLAUDE.md', 'global', { size: 400 }),
  project: { name: 'CLAUDE.md', path: '/p/CLAUDE.md', scope: 'project', mtime: 0, exists: false },
  autoMemory: [
    mem('MEMORY.md', '/m/MEMORY.md', 'auto', { type: 'index', size: 120, lines: 2 }),
    mem('deploy-notes.md', '/m/deploy-notes.md', 'auto', { description: 'how prod ships', type: 'reference', inIndex: false }),
    mem('stripe.md', '/m/stripe.md', 'auto', { description: 'webhook gotchas', type: 'project', inIndex: true, mtime: NOW, origin: 's1' }),
  ],
  agent: mem('memory.md', '/s/memory.md', 'agent'),
}
const file = (name: string, scope: ContextFile['scope']): ContextFile => ({
  name,
  rel: name,
  folder: '/ctx',
  path: `/ctx/${name}`,
  scope,
  size: 1,
  mtime: 0,
  kind: 'markdown',
})
const catalog: SkillCatalogEntry[] = [{ name: 'deploy', source: 'user', description: 'ship it', state: 'active' }]

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/home/user/ana', skills: ['deploy'], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}
function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'S',
    skills: [],
    cwd: null,
    mtime: 0,
    size: 0,
    turnCount: 0,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    startedAt: NOW - DAY,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.memory.list.mockResolvedValue(layers)
  mockedApi.context.list.mockResolvedValue({ shared: [file('brief.md', 'shared')], agent: [] })
  mockedApi.context.produced.mockResolvedValue([])
  mockedApi.agents.loaded.mockResolvedValue(null)
  mockedApi.memory.read.mockResolvedValue('')
  mockedApi.skillsCatalog.mockResolvedValue(catalog)
  mockedApi.patchPrefsContextScope.mockResolvedValue({})
  useStore.setState({
    agents: [makeAgent()],
    automations: [],
    automationsPending: [],
    selected: { folder: 'f', id: 's1' },
    detail: { meta: makeSession(), turns: [], total: 0 },
    page: { kind: 'agent', id: 'a1' },
    contextOpen: false,
    knowsDrawer: null,
    catalog: [],
  })
})

function openDrawer(kind: 'memory' | 'skills' | 'context', agent: AgentView = makeAgent(), filter?: 'outside-index' | 'recent' | 'here'): void {
  useStore.getState().openKnows(kind, filter ? { filter } : undefined)
  render(<KnowsDrawer agent={agent} />)
}
const groupsOf = (root: HTMLElement): (string | null)[] =>
  within(root)
    .queryAllByRole('region')
    .map((g) => g.getAttribute('aria-label'))
const chip = (root: HTMLElement, name: RegExp) => within(root).getByRole('button', { name })

describe('KnowsDrawer — the library, narrow', () => {
  it('(a) opens on memory: what is always in its head first, then the notes by when they were learned', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog', { name: /what ana knows/i })
    await within(drawer).findByText('Deploy notes') // the slug said as words
    expect(groupsOf(drawer)).toEqual(['Always in its head', 'Today', 'Earlier'])
    const always = within(drawer).getByRole('region', { name: 'Always in its head' })
    // the instruction layers that exist (the project's does not) + the index
    expect(within(always).getByText('Its own memory')).toBeInTheDocument()
    expect(within(always).getByText('Your personal instructions')).toBeInTheDocument()
    expect(within(always).getByText('Memory index')).toBeInTheDocument()
    expect(within(always).queryByText('CLAUDE.md')).toBeNull()
    expect(within(within(drawer).getByRole('region', { name: 'Today' })).getByText('Stripe')).toBeInTheDocument()
    // the memory tab counts notes, never the index or the instruction files
    expect(within(drawer).getByRole('button', { name: /^Memory 2$/ })).toHaveAttribute('aria-current', 'true')
  })

  it('(b) a type facet splits the list, with an honest count; a second click clears it', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('Deploy notes')
    const ref = chip(drawer, /^type: reference 1$/)
    expect(chip(drawer, /^type: project 1$/)).toBeInTheDocument()
    fireEvent.click(ref)
    expect(ref).toHaveAttribute('aria-pressed', 'true')
    expect(within(drawer).getByText('Deploy notes')).toBeInTheDocument()
    expect(within(drawer).queryByText('Stripe')).toBeNull()
    fireEvent.click(ref)
    expect(within(drawer).getByText('Stripe')).toBeInTheDocument()
  })

  it('"not in its index" keeps only the notes its index does not name, and says what that means', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('Deploy notes')
    fireEvent.click(chip(drawer, /^not in its index 1$/))
    expect(within(drawer).getByText('Deploy notes')).toBeInTheDocument()
    expect(within(drawer).queryByText('Stripe')).toBeNull()
    expect(within(drawer).queryByText('Agent memory')).toBeNull()
    fireEvent.click(within(drawer).getByText('Deploy notes'))
    expect(await within(drawer).findByText(/its index doesn’t name this note/i)).toBeInTheDocument()
  })

  it('a filter in the store (a click on the anatomy) opens the library already filtered', async () => {
    openDrawer('memory', makeAgent(), 'outside-index')
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('Deploy notes')
    expect(chip(drawer, /^not in its index 1$/)).toHaveAttribute('aria-pressed', 'true')
    expect(within(drawer).queryByText('Stripe')).toBeNull()
  })

  it('"this conversation" marks and filters the notes whose origin is the open session', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    const stripe = await within(drawer).findByText('Stripe')
    // the ✦ sits on that note's row only
    expect(stripe.closest('button')!.querySelector('.lucide-sparkle')).not.toBeNull()
    expect(within(drawer).getByText('Deploy notes').closest('button')!.querySelector('.lucide-sparkle')).toBeNull()
    fireEvent.click(chip(drawer, /^this conversation 1$/))
    expect(within(drawer).getByText('Stripe')).toBeInTheDocument()
    expect(within(drawer).queryByText('Deploy notes')).toBeNull()
  })

  it('a note written by another conversation is never marked new — no facet, no ✦', async () => {
    useStore.setState({ selected: { folder: 'f', id: 'other' } })
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('Stripe')
    expect(within(drawer).queryByRole('button', { name: /this conversation/ })).toBeNull()
    expect(drawer.querySelector('.lucide-sparkle')).toBeNull()
  })

  it('sort: recent groups notes by era; a–z puts them in one alphabetical list', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('Deploy notes')
    expect(within(drawer).getByRole('button', { name: 'recent' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(drawer).getByRole('button', { name: 'a–z' }))
    expect(groupsOf(drawer)).toEqual(['Always in its head', 'Notes, A–Z'])
    const az = within(drawer).getByRole('region', { name: 'Notes, A–Z' })
    expect(
      within(az)
        .getAllByRole('listitem')
        .map((li) => (li.textContent?.startsWith('Deploy notes') ? 'deploy' : li.textContent?.startsWith('Stripe') ? 'stripe' : '?')),
    ).toEqual(['deploy', 'stripe'])
    fireEvent.click(within(drawer).getByRole('button', { name: 'recent' }))
    expect(groupsOf(drawer)).toEqual(['Always in its head', 'Today', 'Earlier'])
  })

  it('(c) the search filters by name and by description', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('Deploy notes')
    const search = within(drawer).getByPlaceholderText('Search memory')
    fireEvent.change(search, { target: { value: 'webhook' } }) // description of stripe.md
    expect(within(drawer).getByText('Stripe')).toBeInTheDocument()
    expect(within(drawer).queryByText('Deploy notes')).toBeNull()
    fireEvent.change(search, { target: { value: 'DEPLOY' } }) // name, case-insensitive
    expect(within(drawer).getByText('Deploy notes')).toBeInTheDocument()
    expect(within(drawer).queryByText('Stripe')).toBeNull()
    fireEvent.change(search, { target: { value: 'nothing-like-this' } })
    expect(within(drawer).queryAllByRole('region')).toHaveLength(0)
    expect(within(drawer).getByText(/nothing matches/i)).toBeInTheDocument()
  })

  it('(d) Esc calls closeKnows and focus returns to the trigger', async () => {
    function Harness() {
      const openKnows = useStore((s) => s.openKnows)
      return (
        <>
          <button type="button" onClick={() => openKnows('memory')}>
            Open memory
          </button>
          <KnowsDrawer agent={makeAgent()} />
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open memory' })
    trigger.focus()
    fireEvent.click(trigger)
    const drawer = await screen.findByRole('dialog')
    expect(drawer.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().knowsDrawer).toBeNull()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('✕ and a click outside close it too; a click inside does not', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    fireEvent.pointerDown(within(drawer).getByPlaceholderText('Search memory'))
    expect(useStore.getState().knowsDrawer).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(useStore.getState().knowsDrawer).toBeNull()
    useStore.getState().openKnows('memory')
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect(useStore.getState().knowsDrawer).toBeNull()
  })

  it('(e) master without a folder: kind context → an explained empty state, no Upload, no search', async () => {
    const master = makeAgent({ id: MASTER_ID, name: 'Anywhere', folder: null, skills: [] })
    useStore.setState({ agents: [master] })
    openDrawer('context', master)
    const drawer = await screen.findByRole('dialog', { name: /what anywhere knows/i })
    expect(within(drawer).getByText('No project folder')).toBeInTheDocument()
    expect(within(drawer).getByText(/context files live in a project folder/i)).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /upload/i })).toBeNull()
    expect(within(drawer).queryByPlaceholderText('Search context')).toBeNull()
    expect(mockedApi.context.list).not.toHaveBeenCalled()
  })

  it("with a folder, context offers Upload — the add form takes the list's place, with a way back", async () => {
    openDrawer('context')
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('brief.md')
    fireEvent.click(within(drawer).getByRole('button', { name: /upload/i }))
    expect(await within(drawer).findByLabelText('Choose a file')).toBeInTheDocument()
    // the way back names the kind — context files are called Files now
    fireEvent.click(within(drawer).getByRole('button', { name: /^Files$/ }))
    expect(await within(drawer).findByText('brief.md')).toBeInTheDocument()
  })

  describe('a deliverable sharing a basename with a top-level file', () => {
    const top: ContextFile = { ...file('x.md', 'agent'), path: '/ctx/x.md' }
    const deep: ContextFile = { ...file('x.md', 'agent'), rel: 'analysis/x.md', path: '/ctx/analysis/x.md' }
    const meta = (path: string) => ({
      path,
      name: 'x.md',
      ext: 'md',
      kind: 'markdown' as const,
      mime: 'text/markdown',
      size: 5,
      tooLarge: false,
      editable: true,
    })
    beforeEach(() => {
      // the deep row first, as the server sorts it by rel
      mockedApi.context.list.mockResolvedValue({ shared: [], agent: [deep, top] })
      mockedApi.file.meta.mockImplementation(async (p: string) => meta(p))
    })
    it('the rows are labelled by their relative path, so they read distinct', async () => {
      openDrawer('context')
      const drawer = await screen.findByRole('dialog')
      expect(await within(drawer).findByText('analysis/x.md')).toBeInTheDocument()
      expect(within(drawer).getByText('x.md')).toBeInTheDocument()
    })
    it('a bare basename request opens the top-level one', async () => {
      useStore.getState().openKnows('context', { openItem: 'x.md' })
      render(<KnowsDrawer agent={makeAgent()} />)
      await screen.findByRole('dialog')
      await waitFor(() => expect(mockedApi.file.meta).toHaveBeenCalled())
      expect(mockedApi.file.meta).toHaveBeenCalledWith('/ctx/x.md')
      expect(mockedApi.file.meta).not.toHaveBeenCalledWith('/ctx/analysis/x.md')
    })
    it("a live toast's basename (openScope) resolves to the top-level one", async () => {
      useStore.getState().openKnows('context', { openItem: 'x.md', openScope: 'agent' })
      render(<KnowsDrawer agent={makeAgent()} />)
      await waitFor(() => expect(mockedApi.file.meta).toHaveBeenCalledWith('/ctx/x.md'))
      expect(mockedApi.file.meta).not.toHaveBeenCalledWith('/ctx/analysis/x.md')
    })
    it('a live toast naming a deep deliverable by its relative path opens that one', async () => {
      useStore.getState().openKnows('context', { openItem: 'analysis/x.md', openScope: 'agent' })
      render(<KnowsDrawer agent={makeAgent()} />)
      await waitFor(() => expect(mockedApi.file.meta).toHaveBeenCalledWith('/ctx/analysis/x.md'))
      expect(mockedApi.file.meta).not.toHaveBeenCalledWith('/ctx/x.md')
    })
  })

  it('skills: grouped by where they come from and whether the engine loads them', async () => {
    mockedApi.skillsCatalog.mockResolvedValue([
      { name: 'heartbeat', source: 'project', state: 'active', description: 'beat' },
      { name: 'deploy', source: 'user', state: 'active', description: 'ship it' },
      { name: 'superpowers:brainstorming', source: 'plugin', state: 'active' },
      { name: 'dormant', source: 'project', state: 'held' },
      { name: 'loop', source: 'silos', state: 'available' },
      // seen elsewhere: neither the agent's nor the folder's — not listed
      { name: 'axiom', state: 'seen', seen: 'other-folder' },
    ])
    openDrawer('skills')
    const drawer = await screen.findByRole('dialog', { name: /what ana knows/i })
    await within(drawer).findByText('heartbeat')
    expect(groupsOf(drawer)).toEqual([
      'From Project — its folder',
      'From This machine',
      'From This machine — plugins',
      'Turned off',
      'From Silos platform — could add',
    ])
    const at = (g: string, n: string) => expect(within(within(drawer).getByRole('region', { name: g })).getByText(n)).toBeInTheDocument()
    at('From Project — its folder', 'heartbeat')
    at('From This machine', 'deploy')
    at('From This machine — plugins', 'superpowers:brainstorming')
    at('Turned off', 'dormant')
    at('From Silos platform — could add', 'loop')
    expect(within(drawer).queryByText('axiom')).toBeNull()
    expect(within(drawer).getByText('ship it')).toBeInTheDocument()
    // the tab counts what loads: the three active ones
    expect(within(drawer).getByRole('button', { name: /^Skills 3$/ })).toBeInTheDocument()
  })

  // one name twice — the operator's personal skill AND this folder's held
  // copy — is two rows with two keys (they shared `skill:<name>`), the held
  // one in words that stay true while the personal copy loads
  it('a name listed twice (Personal + Turned off) is two distinct rows, without a key collision', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockedApi.skillsCatalog.mockResolvedValue([
      { name: 'team-plan', source: 'user', state: 'active', description: 'personal copy' },
      { name: 'team-plan', state: 'held', description: 'folder copy', stillLoads: 'personal' },
    ])
    openDrawer('skills')
    const drawer = await screen.findByRole('dialog', { name: /what ana knows/i })
    await within(drawer).findByText('personal copy')
    expect(within(within(drawer).getByRole('region', { name: 'From This machine' })).getByText('team-plan')).toBeInTheDocument()
    expect(within(within(drawer).getByRole('region', { name: 'Turned off' })).getByText('team-plan')).toBeInTheDocument()
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false)
    errors.mockRestore()
  })

  it('a failed catalog is an honest empty — never skills invented from agent.skills', async () => {
    mockedApi.skillsCatalog.mockRejectedValue(new Error('boom'))
    openDrawer('skills')
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText(/no skills/i)).toBeInTheDocument()
    expect(within(drawer).queryByText('deploy')).toBeNull()
  })
})

describe('KnowsDrawer — facets open the agent page, never the drawer', () => {
  // a facet from a conversation navigates to the
  // agent page (with its way back), never a pane or the drawer over it
  function openFacetFromConversation(facet: 'memory' | 'identity'): void {
    // the built-in chat view, not the real console (agent-page.test.tsx does the same)
    useStore.setState({ chatMode: 'chat' })
    mockedApi.console.mockResolvedValue({ key: 'console-key', theme: 'dark' })
    useStore.getState().openDossier(facet)
  }

  it('the memory facet navigates to its section of the agent page, not the drawer', async () => {
    openFacetFromConversation('memory')
    render(<AgentPage />)
    expect(await screen.findByTestId('return-chip')).toBeInTheDocument()
    expect(useStore.getState().selected).toBeNull()
    expect(useStore.getState().tab).toBe('memory')
    expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
    expect(useStore.getState().knowsDrawer).toBeNull()
    expect(screen.queryByRole('dialog', { name: /what ana knows/i })).toBeNull()
  })

  it('the settings facet navigates to the agent page too', async () => {
    openFacetFromConversation('identity')
    render(<AgentPage />)
    expect(await screen.findByTestId('return-chip')).toBeInTheDocument()
    expect(useStore.getState().tab).toBe('identity')
    expect(useStore.getState().knowsDrawer).toBeNull()
    expect(screen.queryByRole('dialog', { name: /·/ })).toBeNull()
  })
})

// the conversation's Mission panel — the same head the
// agent page mounts, read and edited without leaving the conversation
describe('KnowsDrawer — Mission', () => {
  it('renders the compact mission panel in place; Edit opens the editor; Esc closes it', async () => {
    useStore.setState({ knowsDrawer: { kind: 'mission' } })
    render(<KnowsDrawer agent={makeAgent({ mission: { text: 'Support inbox.', never: ['refund anyone'], updatedAt: '2026-11-10T09:00:00Z' } })} />)
    const dialog = await screen.findByRole('dialog', { name: 'Mission · Ana' })
    expect(within(dialog).getByText('Support inbox.')).toBeInTheDocument()
    expect(within(dialog).getByTestId('mission-never')).toHaveTextContent('Never: refund anyone')
    expect(dialog.className).not.toMatch(/\binset-0\b/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }))
    expect(within(dialog).getByText('New conversations will use it.')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().knowsDrawer).toBeNull()
  })

  it('without a mission it says what that means, as the door to write one', async () => {
    useStore.setState({ knowsDrawer: { kind: 'mission' } })
    render(<KnowsDrawer agent={makeAgent({})} />)
    const dialog = await screen.findByRole('dialog', { name: 'Mission · Ana' })
    expect(within(dialog).getByRole('button', { name: 'Write what Ana takes care of ›' })).toBeInTheDocument()
    expect(within(dialog).queryByText(/old duty/)).toBeNull()
  })
})

// each page its own scope, everything it reaches (show it all, each with
// its scope): the library shows every layer and every note the
// agent reads; 'project' only leaves out an agent's own memory file. A note
// with an author says who learned it in every scope. `scoped` (the page it
// sits on) groups rows by OWNER — the agent · the project · Silos · you —
// with one scope filter, each group saying whom else it reaches and linking
// to its house when this page isn't it; switches only where the page IS it.
describe('KnowsLibrary — scope', () => {
  const bea = makeAgent({ id: 'b2', name: 'Bea', folder: '/home/user/ana' })
  const scoped: MemoryLayers = {
    global: mem('CLAUDE.md', '/home/CLAUDE.md', 'global', { size: 400 }),
    project: mem('CLAUDE.md', '/p/CLAUDE.md', 'project', { size: 200 }),
    autoMemory: [
      mem('MEMORY.md', '/m/MEMORY.md', 'auto', { type: 'index', size: 120, lines: 2 }),
      mem('deploy-notes.md', '/m/deploy-notes.md', 'auto', { description: 'how prod ships', author: 'a1' }),
      mem('stripe.md', '/m/stripe.md', 'auto', { description: 'webhook gotchas', author: 'b2' }),
      mem('orphan.md', '/m/orphan.md', 'auto', { description: 'nobody knows' }),
    ],
    agent: mem('memory.md', '/s/memory.md', 'agent'),
  }
  const src = (over: Partial<KnowsSources> = {}): KnowsSources => ({
    memory: scoped,
    catalog: [],
    context: { shared: [file('brief.md', 'shared')], agent: [file('spec.md', 'agent')] },
    produced: [],
    loaded: null,
    loads: null,
    ownTools: null,
    ready: true,
    failed: false,
    reload: () => {},
    ...over,
  })
  const lib = (props: Partial<Parameters<typeof KnowsLibrary>[0]> = {}) =>
    render(<KnowsLibrary agent={makeAgent()} src={src()} focus={{ kind: 'memory' }} wide={false} {...props} />)
  const scopeFilter = (root: HTMLElement) => within(root).getByRole('radiogroup', { name: 'From' })
  const header = (root: HTMLElement, owner: string) => within(within(root).getByRole('region', { name: owner })).getByTestId('owner-header')
  // the owners as lib/owners.ts writes them — type word first, never a bare name
  const AGENT = 'From Agent · 🧠 Ana'
  const PROJECT = 'From Project · ana'
  const YOU = 'From This machine'
  // the «From» chips as [label, count] — «All» first
  const chips = (f: HTMLElement) =>
    within(f)
      .getAllByRole('radio')
      .map((b) => [b.getAttribute('title'), Number(b.lastElementChild?.textContent)])
  const headCount = (root: HTMLElement, owner: string) => Number(within(header(root, owner)).getAllByText(/^\d+$/)[0]!.textContent)

  beforeEach(() => {
    useStore.setState({ agents: [makeAgent(), bea], page: { kind: 'agent', id: 'a1' }, projectTab: 'now' })
  })

  it('an opened note says when it was written relative to now, the exact moment on hover — never an absolute date', () => {
    const at = Date.now() - 2 * 86_400_000 - 60_000
    const withNote = { ...scoped, autoMemory: [mem('fresh.md', '/m/fresh.md', 'auto', { description: 'freshly learned', mtime: at })] }
    render(<KnowsLibrary agent={makeAgent()} src={src({ memory: withNote })} focus={{ kind: 'memory' }} wide={false} />)
    fireEvent.click(within(screen.getByTestId('knows-library')).getByText('freshly learned'))
    const written = screen.getByText('written 2d ago')
    expect(written).toHaveAttribute('title', new Date(at).toLocaleString())
  })

  it("project scope: only the agent's own memory file stays out — the folder's CLAUDE.md, its index, every note and yours are in; an author facet keeps one agent's share", () => {
    lib({ memoryScope: 'project' })
    const root = screen.getByTestId('knows-library')
    expect(within(root).getByText('Ana · how prod ships')).toBeInTheDocument()
    expect(within(root).getByText('Bea · webhook gotchas')).toBeInTheDocument()
    expect(within(root).getByText('nobody knows')).toBeInTheDocument()
    expect(within(root).getByText('CLAUDE.md')).toBeInTheDocument()
    expect(within(root).getByText('Memory index')).toBeInTheDocument()
    expect(within(root).getByText('Your personal instructions')).toBeInTheDocument()
    expect(within(root).queryByText('Its own memory')).toBeNull()
    // authorship is not ownership: who learned it is a facet, and the notes
    // whose author Silos can't know say so
    const byBea = chip(root, /^learned by Bea 1$/)
    expect(chip(root, /^learned by Ana 1$/)).toBeInTheDocument()
    expect(chip(root, /^author unknown 1$/)).toBeInTheDocument()
    fireEvent.click(byBea)
    expect(within(root).getByText('Stripe')).toBeInTheDocument()
    expect(within(root).queryByText('Deploy notes')).toBeNull()
    expect(within(root).queryByText('Orphan')).toBeNull()
  })

  it("agent scope: every layer and every note it reads — another agent's notes too, each with who learned it", () => {
    lib({ memoryScope: 'agent' })
    const root = screen.getByTestId('knows-library')
    for (const t of ['Its own memory', 'CLAUDE.md', 'Your personal instructions', 'Memory index', 'Deploy notes', 'Stripe', 'Orphan']) {
      expect(within(root).getByText(t)).toBeInTheDocument()
    }
    expect(within(root).getByText('Ana · how prod ships')).toBeInTheDocument()
    expect(within(root).getByText('Bea · webhook gotchas')).toBeInTheDocument()
    // unscoped (no page): no owner groups, no author facets
    expect(within(root).queryByRole('group', { name: 'Scope' })).toBeNull()
    expect(within(root).queryByRole('button', { name: /^learned by / })).toBeNull()
    expect(within(root).getByRole('button', { name: /^Memory 3$/ })).toBeInTheDocument()
  })

  it('all scope (the drawer default): every layer and every note, the author said in the line, no author facet', () => {
    lib()
    const root = screen.getByTestId('knows-library')
    for (const t of ['Its own memory', 'CLAUDE.md', 'Your personal instructions', 'Memory index', 'Deploy notes', 'Stripe', 'Orphan']) {
      expect(within(root).getByText(t)).toBeInTheDocument()
    }
    expect(within(root).getByText('Ana · how prod ships')).toBeInTheDocument()
    expect(within(root).getByText('nobody knows')).toBeInTheDocument()
    expect(within(root).queryByRole('button', { name: /^learned by / })).toBeNull()
    expect(within(root).queryByTestId('scope-filter')).toBeNull()
  })

  it('scoped: groups by origin in order (agent · project · machine); ONE «From» row — a chip narrows to its group, again or «All» clears it', () => {
    lib({ memoryScope: 'agent', scoped: 'agent' })
    const root = screen.getByTestId('knows-library')
    expect(groupsOf(root)).toEqual([AGENT, PROJECT, YOU])
    expect(within(within(root).getByRole('region', { name: AGENT })).getByText('Its own memory')).toBeInTheDocument()
    expect(within(within(root).getByRole('region', { name: YOU })).getByText('Your personal instructions')).toBeInTheDocument()
    const project = within(root).getByRole('region', { name: PROJECT })
    for (const t of ['CLAUDE.md', 'Memory index', 'Deploy notes', 'Stripe', 'Orphan']) expect(within(project).getByText(t)).toBeInTheDocument()
    const filter = scopeFilter(root)
    expect(filter).toHaveAttribute('data-testid', 'scope-filter')
    // one chip per head, each count its head's count
    expect(chips(filter)).toEqual([
      ['All', 7],
      ['Agent · 🧠 Ana', 1],
      ['Project · ana', 5],
      ['This machine', 1],
    ])
    for (const g of [AGENT, PROJECT, YOU]) expect(headCount(root, g)).toBe(chips(filter).find(([l]) => `From ${l}` === g)![1])
    expect(within(filter).getByRole('radio', { name: /^All/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(filter).getByRole('radio', { name: /^Project · ana/ }))
    expect(within(filter).getByRole('radio', { name: /^Project · ana/ })).toHaveAttribute('aria-checked', 'true')
    expect(groupsOf(root)).toEqual([PROJECT])
    expect(within(root).queryByText('Its own memory')).toBeNull()
    fireEvent.click(within(filter).getByRole('radio', { name: /^This machine/ }))
    expect(groupsOf(root)).toEqual([YOU])
    // the chosen chip again: everything
    fireEvent.click(within(filter).getByRole('radio', { name: /^This machine/ }))
    expect(groupsOf(root)).toEqual([AGENT, PROJECT, YOU])
    fireEvent.click(within(filter).getByRole('radio', { name: /^Agent/ }))
    expect(groupsOf(root)).toEqual([AGENT])
    fireEvent.click(within(filter).getByRole('radio', { name: /^All/ }))
    expect(groupsOf(root)).toEqual([AGENT, PROJECT, YOU])
    // no second scope control, no caption
    expect(within(root).queryByTestId('scope-caption')).toBeNull()
    expect(within(root).queryByRole('button', { name: /^(Own|Inherited)/ })).toBeNull()
    // scoped: the author facets appear — each agent's share of the folder's memory
    expect(chip(root, /^learned by Bea 1$/)).toBeInTheDocument()
    expect(chip(root, /^author unknown 1$/)).toBeInTheDocument()
  })

  it('«Only» counts under the chosen origin; with a condition on, what is left is counted the same on its chip and its head', () => {
    const outside = { ...scoped, autoMemory: [...scoped.autoMemory, mem('lost.md', '/m/lost.md', 'auto', { inIndex: false })] }
    lib({ memoryScope: 'agent', scoped: 'agent', src: src({ memory: outside }) })
    const root = screen.getByTestId('knows-library')
    expect(chip(root, /^not in its index 1$/)).toBeInTheDocument()
    fireEvent.click(within(scopeFilter(root)).getByRole('radio', { name: /^Agent/ }))
    expect(within(root).queryByRole('button', { name: /^not in its index/ })).toBeNull()
    fireEvent.click(within(scopeFilter(root)).getByRole('radio', { name: /^All/ }))
    fireEvent.click(chip(root, /^learned by Bea 1$/))
    expect(groupsOf(root)).toEqual([PROJECT])
    expect(headCount(root, PROJECT)).toBe(1)
    // one origin left: its head says it — no «From» row
    expect(within(root).queryByRole('radiogroup', { name: 'From' })).toBeNull()
  })

  it("the search narrows the filter's counts too; one origin left makes no row at all", () => {
    lib({ memoryScope: 'agent', scoped: 'agent' })
    const root = screen.getByTestId('knows-library')
    fireEvent.change(within(root).getByPlaceholderText('Search memory'), { target: { value: 'webhook' } })
    expect(groupsOf(root)).toEqual([PROJECT])
    expect(within(root).queryByRole('radiogroup', { name: 'From' })).toBeNull()
  })

  it("a head says its origin and nothing else — no reach words; a door only on what is not the page's own, named for its house", () => {
    lib({ memoryScope: 'agent', scoped: 'agent' })
    const root = screen.getByTestId('knows-library')
    for (const g of [AGENT, PROJECT, YOU]) {
      expect(header(root, g).textContent).toMatch(/^From /)
      expect(header(root, g)).not.toHaveTextContent(/only Ana|also Bea|every agent/)
    }
    expect(within(header(root, AGENT)).queryByRole('button')).toBeNull()
    // the project's → its Memory tab
    fireEvent.click(within(header(root, PROJECT)).getByRole('button', { name: /in ana ›$/ }))
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/user/ana' })
    expect(useStore.getState().projectTab).toBe('memory')
    // yours → Settings › Memories
    fireEvent.click(within(header(root, YOU)).getByRole('button', { name: /Settings ›$/ }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'memories' })
  })

  it('on the project page the project head has no door (it IS the house); yours does', () => {
    lib({ memoryScope: 'project', scoped: 'project' })
    const root = screen.getByTestId('knows-library')
    expect(groupsOf(root)).toEqual([PROJECT, YOU])
    expect(within(header(root, PROJECT)).queryByRole('button')).toBeNull()
    expect(chips(scopeFilter(root))).toEqual([
      ['All', 6],
      ['Project · ana', 5],
      ['This machine', 1],
    ])
    fireEvent.click(within(header(root, YOU)).getByRole('button', { name: /Settings ›$/ }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'memories' })
  })

  it('the open item says where it comes from and whom that reaches — only when scoped', () => {
    const { unmount } = lib({ memoryScope: 'agent', scoped: 'agent' })
    let root = screen.getByTestId('knows-library')
    fireEvent.click(within(root).getByText('Stripe'))
    expect(within(root).getByTestId('item-owner').textContent).toMatch(/^From Project · ana.*Ana · Bea/)
    unmount()
    lib({ memoryScope: 'agent', scoped: 'agent' })
    root = screen.getByTestId('knows-library')
    fireEvent.click(within(root).getByText('Its own memory'))
    expect(within(root).getByTestId('item-owner').textContent).toMatch(/^From Agent · 🧠 Ana/)
    cleanup()
    lib()
    root = screen.getByTestId('knows-library')
    fireEvent.click(within(root).getByText('Stripe'))
    expect(within(root).queryByTestId('item-owner')).toBeNull()
  })

  it('files kind: its own, its working files and the shared ones in one list, each under its owner', () => {
    const report: ContextFile = { ...file('report.md', 'own'), rel: 'reports/report.md', path: '/state/a1/reports/report.md' }
    render(<KnowsLibrary agent={makeAgent()} src={src({ produced: [report] })} focus={{ kind: 'files' }} kinds={['files']} scoped="agent" wide={false} />)
    const root = screen.getByTestId('knows-library')
    expect(groupsOf(root)).toEqual([AGENT, PROJECT])
    const own = within(root).getByRole('region', { name: AGENT })
    expect(within(own).getByText('spec.md')).toBeInTheDocument()
    expect(within(own).getByText('reports/report.md')).toBeInTheDocument()
    // the working file says so; a context file has no line
    expect(within(own).getByText('reports/report.md').parentElement).toHaveTextContent('working file')
    expect(within(own).getByText('spec.md').parentElement).not.toHaveTextContent('working file')
    expect(within(within(root).getByRole('region', { name: PROJECT })).getByText('brief.md')).toBeInTheDocument()
    expect(chips(scopeFilter(root))).toEqual([
      ['All', 3],
      ['Agent · 🧠 Ana', 2],
      ['Project · ana', 1],
    ])
    fireEvent.click(within(header(root, PROJECT)).getByRole('button', { name: /in ana ›$/ }))
    expect(useStore.getState().projectTab).toBe('files')
  })

  it("tools kind: the folder's .mcp.json servers are the project's, claude.ai connectors the Claude account's, the rest your machine's — each says where it is configured", () => {
    const loaded = {
      engine: 'Claude Code',
      folder: '/home/user/ana',
      instructions: [],
      injections: [],
      outputStyle: null,
      toolsDoor: true,
      notes: [],
      mcp: [
        { name: 'railway', source: 'project' as const, from: '.mcp.json' },
        { name: 'context7', source: 'plugin' as const, from: 'context7' },
        { name: 'Gmail', source: 'account' as const, from: 'claude.ai' },
        { name: 'notion', source: 'user' as const, from: '~/.claude.json' },
      ],
    }
    render(<KnowsLibrary agent={makeAgent()} src={src({ loaded })} focus={{ kind: 'tools' }} kinds={['tools']} scoped="agent" wide={false} />)
    const root = screen.getByTestId('knows-library')
    expect(groupsOf(root)).toEqual([PROJECT, YOU, 'From Your Claude account'])
    const project = within(root).getByRole('region', { name: PROJECT })
    expect(within(project).getByText('railway')).toBeInTheDocument()
    expect(within(project).getByText('in the folder’s .mcp.json')).toBeInTheDocument()
    const you = within(root).getByRole('region', { name: YOU })
    expect(within(you).getByText('from the context7 plugin')).toBeInTheDocument()
    expect(within(you).getByText('in your ~/.claude.json')).toBeInTheDocument()
    const account = within(root).getByRole('region', { name: 'From Your Claude account' })
    expect(within(account).getByText('Gmail')).toBeInTheDocument()
    expect(within(account).getByText('a claude.ai connector its conversations used')).toBeInTheDocument()
    expect(chips(scopeFilter(root))).toEqual([
      ['All', 4],
      ['Project · ana', 1],
      ['This machine', 2],
      ['Your Claude account', 1],
    ])
    // yours and the account's have no house for tools in Silos; the project's is its Tools tab
    expect(within(header(root, YOU)).queryByRole('button')).toBeNull()
    expect(within(header(root, 'From Your Claude account')).queryByRole('button')).toBeNull()
    fireEvent.click(within(header(root, PROJECT)).getByRole('button', { name: /in ana ›$/ }))
    expect(useStore.getState().projectTab).toBe('tools')
  })

  describe('skills', () => {
    const skills: SkillCatalogEntry[] = [
      { name: 'heartbeat', source: 'project', state: 'active' },
      { name: 'dormant', source: 'project', state: 'held' },
      { name: 'loop', source: 'silos', state: 'available' },
      { name: 'deploy', source: 'user', state: 'active' },
      { name: 'superpowers:brainstorming', source: 'plugin', plugin: 'superpowers@official', state: 'active' },
      { name: 'axiom', state: 'seen', seen: 'other-folder' },
    ]
    const skillLib = (scopedTo?: 'agent' | 'project') =>
      render(<KnowsLibrary agent={makeAgent()} src={src({ catalog: skills })} focus={{ kind: 'skills' }} kinds={['skills']} scoped={scopedTo} wide={false} />)

    it('on the agent page: only what loads (active), grouped by owner, never a switch', () => {
      skillLib('agent')
      const root = screen.getByTestId('knows-library')
      expect(groupsOf(root)).toEqual([PROJECT, YOU])
      expect(within(root).getByText('heartbeat')).toBeInTheDocument()
      expect(within(root).getByText('deploy')).toBeInTheDocument()
      expect(within(root).queryByText('dormant')).toBeNull()
      expect(within(root).queryByText('loop')).toBeNull()
      for (const b of [/^Turn off$/, /^Turn on$/, /^Add$/]) expect(within(root).queryByRole('button', { name: b })).toBeNull()
      expect(within(root).queryByText('personal')).toBeNull()
      // yours land on the machine's inventory — the door says so
      fireEvent.click(within(header(root, YOU)).getByRole('button', { name: 'Inventory ›' }))
      expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'skills' })
    })

    it('on the agent page the foot says what the folder holds back, with its door — even when every folder skill is off', () => {
      render(
        <KnowsLibrary
          agent={makeAgent()}
          src={src({ catalog: skills.filter((x) => x.name !== 'heartbeat') })}
          focus={{ kind: 'skills' }}
          kinds={['skills']}
          scoped="agent"
          wide={false}
        />,
      )
      const foot = screen.getByTestId('library-foot')
      expect(foot).toHaveTextContent(/1 turned off.*1 could be added/)
      fireEvent.click(within(foot).getByRole('button'))
      expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/user/ana' })
      expect(useStore.getState().projectTab).toBe('skills')
    })

    it("on the project page: the project's rows carry their switch (on, then held); what Silos could add is never the project's — its own group, with Add; yours never switch", () => {
      skillLib('project')
      const root = screen.getByTestId('knows-library')
      const project = within(root).getByRole('region', { name: PROJECT })
      // on first, then held
      expect(
        within(project)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(['heartbeatTurn off', 'dormantTurn on'])
      const silos = within(root).getByRole('region', { name: 'From Silos platform' })
      expect(
        within(silos)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(['loopAdd'])
      const you = within(root).getByRole('region', { name: YOU })
      expect(within(you).getByText('deploy')).toBeInTheDocument()
      expect(within(you).queryByRole('button', { name: /Turn|Add/ })).toBeNull()
      expect(within(you).queryByText('personal')).toBeNull()
    })

    it("unscoped (the drawer): never a switch — each skill points to its owner's page, the door named for it", () => {
      skillLib()
      const root = screen.getByTestId('knows-library')
      for (const b of [/^Turn off$/, /^Turn on$/, /^Add$/]) expect(within(root).queryByRole('button', { name: b })).toBeNull()
      expect(within(root).queryByText('personal')).toBeNull()
      expect(within(root).queryByText('plugin')).toBeNull()
      // a skill only SEEN elsewhere is not listed, so never offered
      expect(within(root).queryByText('axiom')).toBeNull()
      const rowOf = (name: string) => within(root).getByText(name).closest('li')!
      fireEvent.click(within(rowOf('heartbeat')).getByRole('button', { name: /in ana ›$/ }))
      expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/user/ana' })
      expect(useStore.getState().projectTab).toBe('skills')
      fireEvent.click(within(rowOf('deploy')).getByRole('button', { name: 'Inventory ›' }))
      expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'skills' })
    })

    it("a refused switch says the server's words where the click happened — never swallowed", async () => {
      mockedApi.agents.skillState.mockRejectedValue(new Error('a copy of "dormant" reappeared in the folder while this one was off — remove one first'))
      skillLib('project')
      const root = screen.getByTestId('knows-library')
      fireEvent.click(within(root).getByRole('button', { name: 'Turn on' }))
      expect(await within(root).findByRole('alert')).toHaveTextContent(
        'dormant: a copy of "dormant" reappeared in the folder while this one was off — remove one first',
      )
    })

    it('an opened skill says what its source really is — a plugin skill is never «Personal», Could add is Silos’ own', () => {
      render(<KnowsLibrary agent={makeAgent()} src={src({ catalog: skills })} focus={{ kind: 'skills' }} kinds={['skills']} wide />)
      const root = screen.getByTestId('knows-library')
      fireEvent.click(within(root).getByText('superpowers:brainstorming'))
      expect(screen.getByTestId('skill-where')).toHaveTextContent('superpowers')
      fireEvent.click(within(root).getByText('loop'))
      expect(screen.getByTestId('skill-where')).toHaveTextContent('Silos')
      fireEvent.click(within(root).getByText('deploy'))
      expect(screen.getByTestId('skill-where')).toHaveTextContent('~/.claude/skills')
      fireEvent.click(within(root).getByText('dormant'))
      expect(screen.getByTestId('skill-where')).toHaveTextContent('Turned off')
    })
  })

  it('files: grouped as shared in the project vs only the agent; filesScope keeps one side', () => {
    const { unmount } = lib({ focus: { kind: 'context' } })
    let root = screen.getByTestId('knows-library')
    expect(groupsOf(root)).toEqual(['From Agent · Ana', 'From Project'])
    expect(within(within(root).getByRole('region', { name: 'From Agent · Ana' })).getByText('spec.md')).toBeInTheDocument()
    expect(within(within(root).getByRole('region', { name: 'From Project' })).getByText('brief.md')).toBeInTheDocument()
    unmount()
    lib({ focus: { kind: 'context' }, filesScope: 'agent' })
    root = screen.getByTestId('knows-library')
    expect(groupsOf(root)).toEqual(['From Agent · Ana'])
    cleanup()
    lib({ focus: { kind: 'context' }, filesScope: 'project' })
    root = screen.getByTestId('knows-library')
    expect(groupsOf(root)).toEqual(['From Project'])
  })
})
