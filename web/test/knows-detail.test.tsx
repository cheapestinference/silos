// knows-detail.test.tsx — the drawer's library, item by item (every open
// lands in the library): a memory note reads and saves in place; an item no longer listed
// opens the list, never a crash; a new note lands under memory/ (the
// folder's) — Global/Project are only ever "Edit CLAUDE.md", never a
// new-note target; an «Only Ana» upload goes up as scope 'agent'; and Esc
// with an unsaved draft asks first — never a silent loss.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { KnowsDrawer } from '../src/components/knows/KnowsDrawer'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, ContextFile, MemoryLayers, SessionView, SkillCatalogEntry } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const T0 = 1_760_000_000_000
const MEMDIR = '/home/u/.claude/projects/-home-user-ana/memory'
const mem = (name: string, path: string, scope: 'global' | 'project' | 'auto' | 'agent', exists = true) => ({ name, path, scope, mtime: T0 - 10_000, exists })
const layers: MemoryLayers = {
  global: mem('CLAUDE.md', '/home/u/.claude/CLAUDE.md', 'global'),
  project: mem('CLAUDE.md', '/home/user/ana/CLAUDE.md', 'project', false),
  autoMemory: [mem('deploy-notes', `${MEMDIR}/deploy-notes.md`, 'auto')],
  agent: mem('Agent memory', '/s/agents/a1/memory.md', 'agent'),
}
const file = (name: string, scope: ContextFile['scope']): ContextFile => ({
  name,
  rel: name,
  folder: '/home/user/ana',
  path: `/ctx/${name}`,
  scope,
  size: 1,
  mtime: 0,
  kind: 'markdown',
})
const catalog: SkillCatalogEntry[] = [{ name: 'deploy', source: 'user', state: 'active', description: 'ship it' }]

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/home/user/ana', skills: ['deploy'], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}
function makeSession(): SessionView {
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
    startedAt: T0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.memory.list.mockResolvedValue(layers)
  mockedApi.memory.read.mockResolvedValue('# Deploy\n\nship on fridays')
  mockedApi.memory.write.mockResolvedValue({ ok: true, backup: null })
  mockedApi.context.list.mockResolvedValue({ shared: [file('brief.md', 'shared')], agent: [] })
  mockedApi.context.upload.mockResolvedValue(file('spec.md', 'agent'))
  mockedApi.skillsCatalog.mockResolvedValue(catalog)
  useStore.setState({
    agents: [makeAgent()],
    selected: { folder: 'f', id: 's1' },
    detail: { meta: makeSession(), turns: [], total: 0 },
    knowsDrawer: null,
    memoryMode: null,
  })
})

function openDrawer(kind: 'memory' | 'skills' | 'context', opts?: { add?: true; openItem?: string }): void {
  useStore.getState().openKnows(kind, opts?.openItem ? { openItem: opts.openItem } : undefined)
  render(<KnowsDrawer agent={makeAgent()} />)
}
// the library's own «+ Write a note» / «+ Upload»
async function startAdding(drawer: HTMLElement, kind: 'memory' | 'context'): Promise<void> {
  fireEvent.click(await within(drawer).findByRole('button', { name: kind === 'memory' ? 'Write a note' : 'Upload' }))
}

describe('KnowsDrawer — detail in place', () => {
  it('(a) a memory detail loads its content and Save writes the same path', async () => {
    openDrawer('memory', { openItem: `${MEMDIR}/deploy-notes.md` })
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('ship on fridays')).toBeInTheDocument()
    expect(mockedApi.memory.read).toHaveBeenCalledWith(`${MEMDIR}/deploy-notes.md`, makeAgent().folder)
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit' }))
    const editor = within(drawer).getByRole('textbox', { name: /edit deploy notes/i })
    fireEvent.change(editor, { target: { value: '# Deploy\n\nship on mondays' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(mockedApi.memory.write).toHaveBeenCalledWith(`${MEMDIR}/deploy-notes.md`, '# Deploy\n\nship on mondays', { folder: makeAgent().folder }),
    )
    expect(await within(drawer).findByText('ship on mondays')).toBeInTheDocument()
  })

  it('(b) an item no longer listed (deleted since): the library opens on its list, no throw', async () => {
    openDrawer('memory', { openItem: `${MEMDIR}/gone.md` })
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('Deploy notes')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})

describe('KnowsDrawer — skill and context details', () => {
  it('a skill shows its readme and where it loads from — no assigned toggle (agent.skills is retired)', async () => {
    mockedApi.skillReadme.mockResolvedValue({ name: 'deploy', description: 'ship it', body: '## Steps\n\nrun the pipeline' })
    openDrawer('skills', { openItem: 'deploy' })
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('run the pipeline')).toBeInTheDocument()
    expect(within(drawer).getByText(/Personal \(~\/.claude\/skills\)/)).toBeInTheDocument()
    expect(within(drawer).queryByRole('switch')).toBeNull()
    expect(mockedApi.agents.update).not.toHaveBeenCalled()
  })

  it('a plugin skill opened in the drawer says it comes with a plugin — never «Personal (~/.claude/skills)»', async () => {
    mockedApi.skillsCatalog.mockResolvedValue([{ name: 'superpowers:brainstorming', source: 'plugin', plugin: 'superpowers@official', state: 'active' }])
    mockedApi.skillReadme.mockResolvedValue({ name: 'superpowers:brainstorming', body: 'ideas' })
    openDrawer('skills', { openItem: 'superpowers:brainstorming' })
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('ideas')).toBeInTheDocument()
    expect(within(drawer).getByTestId('skill-where')).toHaveTextContent(/superpowers/)
    expect(within(drawer).queryByText(/Personal \(~\/.claude\/skills\)/)).toBeNull()
  })

  it('a context file: metadata, then delete arms and confirms without closing the drawer', async () => {
    mockedApi.file.meta.mockResolvedValue({
      path: '/ctx/brief.md',
      name: 'brief.md',
      ext: 'md',
      kind: 'markdown',
      mime: 'text/markdown',
      size: 2048,
      tooLarge: false,
      editable: true,
    })
    mockedApi.context.remove.mockResolvedValue({ ok: true })
    openDrawer('context', { openItem: '/ctx/brief.md' })
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('2 KB')).toBeInTheDocument()
    const del = within(drawer).getByRole('button', { name: 'Delete brief.md' })
    fireEvent.pointerDown(del)
    fireEvent.click(del) // arms
    expect(mockedApi.context.remove).not.toHaveBeenCalled()
    const confirm = within(drawer).getByRole('button', { name: 'Delete?' })
    fireEvent.pointerDown(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(mockedApi.context.remove).toHaveBeenCalledWith('a1', 'shared', 'brief.md'))
    expect(useStore.getState().knowsDrawer).not.toBeNull()
  })
})

describe('KnowsDrawer — Delete only where the bare-name remove route would hit THIS file', () => {
  const meta = (path: string) => ({ path, name: 'x.md', ext: 'md', kind: 'markdown' as const, mime: 'text/markdown', size: 5, tooLarge: false, editable: true })
  const cases: [string, ContextFile, boolean][] = [
    ['a deep row', { ...file('16-audit.md', 'agent'), rel: 'analysis/16-audit.md', path: '/deep/16-audit.md' }, false],
    ['a top-level row of a secondary territory', { ...file('plan.md', 'agent'), folder: '/home/user/other', path: '/other/plan.md' }, false],
    ['a top-level row of the primary folder', { ...file('main.md', 'agent'), path: '/main/main.md' }, true],
  ]
  for (const [what, f, deletable] of cases) {
    it(`${what} → ${deletable ? 'Delete' : 'no Delete'}`, async () => {
      mockedApi.context.list.mockResolvedValue({ shared: [], agent: [f] })
      mockedApi.file.meta.mockResolvedValue(meta(f.path))
      openDrawer('context', { openItem: f.path })
      const drawer = await screen.findByRole('dialog')
      expect(await within(drawer).findByText('5 B')).toBeInTheDocument()
      expect(within(drawer).queryByRole('button', { name: `Delete ${f.name}` }) !== null).toBe(deletable)
    })
  }
})

describe('KnowsDrawer — no silent loss (fix round 1)', () => {
  it('an unsaved edit in the inline FileViewer: Esc asks instead of closing', async () => {
    mockedApi.file.meta.mockResolvedValue({
      path: '/ctx/brief.md',
      name: 'brief.md',
      ext: 'md',
      kind: 'markdown',
      mime: 'text/markdown',
      size: 5,
      tooLarge: false,
      editable: true,
    })
    mockedApi.file.text.mockResolvedValue('hello')
    openDrawer('context', { openItem: '/ctx/brief.md' })
    const drawer = await screen.findByRole('dialog', { name: /what ana knows/i })
    fireEvent.click(await within(drawer).findByRole('button', { name: /^edit$/i }))
    fireEvent.change(within(drawer).getByRole('textbox'), { target: { value: 'hello, edited' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().knowsDrawer).not.toBeNull()
    expect(within(drawer).getByText(/discard unsaved changes/i)).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: /keep editing/i }))
    expect(within(drawer).getByRole('textbox')).toHaveValue('hello, edited')
  })

  it('Edit with chat from a CLAUDE.md opened while writing a note asks before dropping the half-written note', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    await startAdding(drawer, 'memory')
    fireEvent.change(await within(drawer).findByRole('textbox', { name: /note/i }), { target: { value: 'half a thought' } })
    fireEvent.click(within(drawer).getByRole('button', { name: /edit global claude\.md/i }))
    await within(drawer).findByRole('textbox', { name: /edit claude\.md/i })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(drawer).getByRole('button', { name: /edit with chat/i }))
    expect(useStore.getState().knowsDrawer).not.toBeNull()
    expect(useStore.getState().memoryMode).toBeNull()
    expect(within(drawer).getByText(/discard unsaved changes/i)).toBeInTheDocument()
    // discarding on purpose → memory mode + the drawer steps aside
    fireEvent.click(within(drawer).getByRole('button', { name: /^discard$/i }))
    expect(useStore.getState().memoryMode).toEqual({ path: '/home/u/.claude/CLAUDE.md', name: 'CLAUDE.md' })
    expect(useStore.getState().knowsDrawer).toBeNull()
  })
})

describe('KnowsDrawer — add in place', () => {
  it('(c) a new shared note PUTs a new path under memory/; Global/Project are never a new-note scope', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    await startAdding(drawer, 'memory')
    const scopes = await within(drawer).findByRole('radiogroup', { name: /who reads it/i })
    const offered = within(scopes)
      .getAllByRole('radio')
      .map((r) => r.getAttribute('aria-label'))
    expect(offered).toEqual(['Agent · Ana', 'Project · ana'])
    // Global/Project: a link to edit their one CLAUDE.md — the project one
    // reads from layers even though it does not exist yet
    expect(within(drawer).getByRole('button', { name: /edit global claude\.md/i })).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: /edit project claude\.md/i })).toBeInTheDocument()

    fireEvent.click(within(scopes).getByRole('radio', { name: 'Project · ana' }))
    fireEvent.change(within(drawer).getByRole('textbox', { name: /title/i }), { target: { value: 'Stripe webhooks' } })
    fireEvent.change(within(drawer).getByRole('textbox', { name: /note/i }), { target: { value: 'retry on 5xx' } })
    fireEvent.click(within(drawer).getByRole('button', { name: /save note/i }))
    await waitFor(() => expect(mockedApi.memory.write).toHaveBeenCalledTimes(1))
    const [path, content] = mockedApi.memory.write.mock.calls[0]!
    expect(path).toBe(`${MEMDIR}/stripe-webhooks.md`)
    expect(layers.autoMemory.map((f) => f.path)).not.toContain(path)
    expect(content).toContain('name: Stripe webhooks')
    expect(content).toContain('retry on 5xx')
  })

  it('Edit project CLAUDE.md opens the not-yet-created file in the full editor', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    await startAdding(drawer, 'memory')
    mockedApi.memory.read.mockClear()
    fireEvent.click(await within(drawer).findByRole('button', { name: /edit project claude\.md/i }))
    const editor = await within(drawer).findByRole('textbox', { name: /edit claude\.md/i })
    expect(mockedApi.memory.read).not.toHaveBeenCalled() // exists:false → no read that would 404
    fireEvent.change(editor, { target: { value: '# Ana project' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockedApi.memory.write).toHaveBeenCalledWith('/home/user/ana/CLAUDE.md', '# Ana project'))
  })

  it('(d) a context upload with «Only Ana» goes up as scope agent', async () => {
    openDrawer('context')
    const drawer = await screen.findByRole('dialog')
    await startAdding(drawer, 'context')
    fireEvent.click(within(drawer).getByRole('radio', { name: 'Agent · Ana' }))
    const input = within(drawer).getByLabelText(/choose a file/i)
    const f = new File(['hello'], 'spec.md', { type: 'text/markdown' })
    fireEvent.change(input, { target: { files: [f] } })
    await waitFor(() => expect(mockedApi.context.upload).toHaveBeenCalledWith('a1', 'agent', 'spec.md', btoa('hello')))
  })

  it('(e) Esc with an unsaved draft asks first and does NOT close on the first press', async () => {
    openDrawer('memory')
    const drawer = await screen.findByRole('dialog')
    await startAdding(drawer, 'memory')
    fireEvent.change(await within(drawer).findByRole('textbox', { name: /note/i }), { target: { value: 'half a thought' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().knowsDrawer).not.toBeNull()
    expect(within(drawer).getByText(/discard unsaved changes/i)).toBeInTheDocument()
    // a click outside does not slip past the guard either
    fireEvent.pointerDown(document.body)
    expect(useStore.getState().knowsDrawer).not.toBeNull()
    // keep editing → the draft is intact
    fireEvent.click(within(drawer).getByRole('button', { name: /keep editing/i }))
    expect(within(drawer).getByRole('textbox', { name: /note/i })).toHaveValue('half a thought')
    // asked again, and this time discarded on purpose → closes
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(drawer).getByRole('button', { name: /discard/i }))
    expect(useStore.getState().knowsDrawer).toBeNull()
  })
})
