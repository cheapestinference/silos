// knows-block.test.tsx — the column's «Its agent» zone (scope layers):
// what the agent reaches, its own share said —
// Memory (every note it reads · those ITS conversations learned · how many
// here), Files (its own, its working files, the shared ones), Skills (the
// ones that load), Tools (MCP servers of the project and your machine —
// never the claude.ai connectors, which are the conversation's), In charge
// only when set. A kind with nothing renders nothing (no placeholders); a
// failed read is no row, never an invented count. What THIS conversation
// started with is measured elsewhere (started-with-block.test.tsx). Every
// row opens the agent page's tab (store.openDossier navigates); In
// charge keeps the drawer's compact responsibility panel.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ContextColumn } from '../src/components/ContextColumn'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, ContextFile, MemoryLayers, SessionView, SkillCatalogEntry } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const layers: MemoryLayers = {
  global: { name: 'CLAUDE.md', path: '/g', scope: 'global', mtime: 0, exists: true },
  project: { name: 'CLAUDE.md', path: '/p', scope: 'project', mtime: 0, exists: false },
  autoMemory: [
    { name: 'a.md', path: '/a', scope: 'auto', mtime: 0, exists: true },
    { name: 'b.md', path: '/b', scope: 'auto', mtime: 0, exists: true },
  ],
  agent: { name: 'AGENT.md', path: '/ag', scope: 'agent', mtime: 0, exists: true },
}
const file = (name: string, scope: ContextFile['scope']): ContextFile => ({
  name,
  rel: name,
  folder: '/',
  path: `/${name}`,
  scope,
  size: 1,
  mtime: 0,
  kind: 'markdown',
})
const ctx = { shared: [file('brief.md', 'shared')], agent: [file('spec.md', 'agent'), file('x.md', 'agent')] }
// capability states: the catalog's ACTIVE entries sit in the prompt
// as name + description (Starts with); held/available never do, and
// agent.skills adds nothing
const catalog: SkillCatalogEntry[] = [
  { name: 'heartbeat', source: 'project', state: 'active' },
  { name: 'deploy', source: 'user', state: 'active' },
  { name: 'release', source: 'user', state: 'active' },
  { name: 'superpowers:brainstorming', source: 'plugin', state: 'available' },
  { name: 'dormant', state: 'held' },
]
const assigned = ['superpowers:brainstorming', 'loop'] // retired: paints nothing

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/home/user/ana', skills: assigned, sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
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
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.memory.list.mockResolvedValue(layers)
  mockedApi.context.list.mockResolvedValue(ctx)
  mockedApi.skillsCatalog.mockResolvedValue(catalog)
  mockedApi.context.produced.mockResolvedValue([])
  mockedApi.agents.loaded.mockResolvedValue(null)
  mockedApi.patchPrefsContextScope.mockResolvedValue({})
  useStore.setState({
    agents: [makeAgent()],
    automations: [],
    automationsPending: [],
    selected: { folder: 'f', id: 's1' },
    detail: { meta: makeSession(), turns: [], total: 0 },
    page: null,
    contextOpen: true,
    contextScope: 'conversation',
    knowsDrawer: null,
    catalog: [],
  })
})

describe('KnowsBlock — what is its own', () => {
  // two notes Ana's conversations learned (one in THIS conversation), one
  // Bea learned, one nobody claims
  const note = (name: string, over: Partial<MemoryLayers['autoMemory'][number]> = {}) => ({
    name,
    path: `/m/${name}`,
    scope: 'auto' as const,
    mtime: 0,
    exists: true,
    ...over,
  })
  const owned: MemoryLayers = {
    ...layers,
    autoMemory: [
      note('a.md', { author: 'a1', origin: 's1' }),
      note('b.md', { author: 'a1', origin: 'older' }),
      note('c.md', { author: 'b2', origin: 'bea-session' }),
      note('d.md'),
    ],
  }

  it("the agent's Memory row counts what it reads and what its conversations learned", async () => {
    mockedApi.memory.list.mockResolvedValue(owned)
    render(<ContextColumn />)
    const row = await screen.findByRole('button', { name: 'Open memory' })
    await waitFor(() => expect(row).toHaveTextContent(/4 .*2 /))
  })

  it('Files counts context/<agent> as its own, what it produced as working, and the shared ones apart', async () => {
    mockedApi.context.produced.mockResolvedValue([file('report.md', 'agent')])
    render(<ContextColumn />)
    const row = await screen.findByRole('button', { name: 'Open files' })
    await waitFor(() => expect(row).toHaveTextContent(/2 .*1 working.*1 shared/))
  })

  it('a kind with nothing renders nothing — no placeholder rows, no estimated «Starts with»', async () => {
    mockedApi.context.list.mockResolvedValue({ shared: [], agent: [] })
    mockedApi.memory.list.mockResolvedValue({ ...layers, autoMemory: [] })
    mockedApi.skillsCatalog.mockResolvedValue([])
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.skillsCatalog).toHaveBeenCalled())
    await waitFor(() => expect(mockedApi.context.produced).toHaveBeenCalled())
    // settle the reads, then nothing of the agent zone paints a row
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    for (const name of ['Open memory', 'Open files', 'Open skills', 'Open tools', 'Open in charge', 'Open starts with']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByText(/Nothing learned yet|No files yet|Needs a project folder/)).toBeNull()
    expect(screen.queryByTestId('knows-starts')).toBeNull()
  })

  it('a failed memory read is an honest empty — no Memory row, never a count', async () => {
    mockedApi.memory.list.mockRejectedValue(new Error('boom'))
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalled())
    // the rest of the zone lands; Memory never does
    await screen.findByRole('button', { name: 'Open skills' })
    expect(screen.queryByRole('button', { name: 'Open memory' })).toBeNull()
  })
})

describe('KnowsBlock — every row opens the agent page tab', () => {
  it('memory / files / skills navigate to their tab of the agent page, from the conversation (not the drawer)', async () => {
    let view = render(<ContextColumn />)
    for (const [label, facet] of [
      ['Open memory', 'memory'],
      ['Open files', 'context'],
      ['Open skills', 'skills'],
    ] as const) {
      fireEvent.click(await screen.findByRole('button', { name: label }))
      expect(useStore.getState().tab).toBe(facet)
      expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
      expect(useStore.getState().knowsDrawer).toBeNull()
      // back in the conversation (a fresh column, as on the way back)
      view.unmount()
      act(() => {
        useStore.setState({ page: null, selectedAgentId: null, selected: { folder: 'f', id: 's1' }, detail: { meta: makeSession(), turns: [], total: 0 } })
      })
      view = render(<ContextColumn />)
    }
  })

  it('the Mission row shows only with a mission (never the old responsibility), and opens the drawer on it', async () => {
    useStore.setState({ agents: [makeAgent({ mission: { text: 'Infrastructure. Always.', never: [], updatedAt: '2026-11-10T09:00:00Z' } })] })
    render(<ContextColumn />)
    const row = await screen.findByRole('button', { name: 'Open mission' })
    expect(row).toHaveTextContent('Infrastructure.')
    expect(screen.queryByText(/old duty/)).not.toBeInTheDocument()
    fireEvent.click(row)
    expect(useStore.getState().knowsDrawer).toEqual({ kind: 'mission' })
    expect(useStore.getState().page).toBeNull()
  })

  it('the Tools row counts the MCP servers of the project and your machine — never the claude.ai connectors — and opens its Tools tab', async () => {
    mockedApi.agents.loaded.mockResolvedValue({
      engine: 'Claude Code',
      folder: '/home/user/ana',
      toolsDoor: true,
      notes: [],
      instructions: [],
      injections: [],
      outputStyle: null,
      mcp: [
        { name: 'context7', source: 'plugin', from: 'context7' },
        { name: 'stripe', source: 'plugin', from: 'stripe' },
        { name: 'notion', source: 'project', from: '.mcp.json' },
        { name: 'Gmail', source: 'account', from: 'claude.ai' },
      ],
    })
    render(<ContextColumn />)
    const row = await screen.findByRole('button', { name: 'Open tools' })
    expect(row).toHaveTextContent('3')
    expect(row).not.toHaveTextContent('claude.ai')
    fireEvent.click(row)
    expect(useStore.getState().tab).toBe('tools')
    expect(useStore.getState().knowsDrawer).toBeNull()
  })

  it("only claude.ai connectors → no Tools row (they are the conversation's, said in its zone)", async () => {
    mockedApi.agents.loaded.mockResolvedValue({
      engine: 'Claude Code',
      folder: '/home/user/ana',
      toolsDoor: true,
      notes: [],
      instructions: [],
      injections: [],
      outputStyle: null,
      mcp: [{ name: 'Gmail', source: 'account', from: 'claude.ai' }],
    })
    render(<ContextColumn />)
    await screen.findByRole('button', { name: 'Open skills' })
    await waitFor(() => expect(mockedApi.agents.loaded).toHaveBeenCalled())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByRole('button', { name: 'Open tools' })).toBeNull()
  })

  it('the Skills row counts the skills that load (held and could-add never) and opens its Skills tab', async () => {
    render(<ContextColumn />)
    const row = await screen.findByRole('button', { name: 'Open skills' })
    // heartbeat, deploy, release — agent.skills (retired) adds nothing
    expect(row).toHaveTextContent('3 it can use')
    fireEvent.click(row)
    expect(useStore.getState().tab).toBe('skills')
    expect(useStore.getState().knowsDrawer).toBeNull()
  })

  it('a failed catalog read is no Skills row — never skills invented from agent.skills', async () => {
    mockedApi.skillsCatalog.mockRejectedValue(new Error('boom'))
    render(<ContextColumn />)
    await screen.findByRole('button', { name: 'Open memory' })
    expect(screen.queryByRole('button', { name: 'Open skills' })).toBeNull()
  })

  it('no Tools row when the engine cannot say (null)', async () => {
    mockedApi.agents.loaded.mockResolvedValue(null)
    render(<ContextColumn />)
    await screen.findByRole('button', { name: 'Open skills' })
    expect(screen.queryByRole('button', { name: 'Open tools' })).toBeNull()
  })
})

describe('store — knowsDrawer', () => {
  it('openKnows sets kind + options, closeKnows clears it, closing the session clears it too', () => {
    useStore.getState().openKnows('memory', { openItem: '/a', openScope: 'auto' })
    expect(useStore.getState().knowsDrawer).toEqual({ kind: 'memory', openItem: '/a', openScope: 'auto' })
    useStore.getState().closeKnows()
    expect(useStore.getState().knowsDrawer).toBeNull()
    useStore.getState().openKnows('context')
    useStore.getState().closeSession()
    expect(useStore.getState().knowsDrawer).toBeNull()
  })
})
