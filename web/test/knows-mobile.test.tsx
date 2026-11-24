// knows-mobile.test.tsx — Knows below `lg` (mobile): the context column
// is `hidden lg:flex`, so there the "Context"
// pill opens a bottom sheet with the KnowsBlock content instead of
// toggling the (invisible) `contextOpen` pref; tapping a count steps the
// sheet aside for the agent page's section (memory/skills/context open over
// the conversation), tapping Mission mutates it into the
// drawer content; closing either returns to the conversation. In
// `lg+` the pill keeps its semantics (toggle contextOpen, no sheet).
//
// The breakpoint is read with matchMedia('(min-width: 64rem)') — jsdom has
// no matchMedia, so each case stubs it (the same pattern as
// external-status.test.tsx); without it the app assumes desktop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AgentPage } from '../src/components/AgentPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, MemoryLayers, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const T0 = 1_760_000_000_000
const layers: MemoryLayers = {
  global: { name: 'CLAUDE.md', path: '/home/CLAUDE.md', scope: 'global', mtime: T0, exists: true },
  project: { name: 'CLAUDE.md', path: '/p/CLAUDE.md', scope: 'project', mtime: 0, exists: false },
  autoMemory: [{ name: 'deploy-notes.md', path: '/m/deploy-notes.md', scope: 'auto', mtime: T0, exists: true }],
  agent: { name: 'memory.md', path: '/s/memory.md', scope: 'agent', mtime: T0, exists: true },
}
const agent: AgentView = {
  id: 'a1',
  name: 'Ana',
  emoji: '🧠',
  folder: '/home/user/ana',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  mission: { text: 'Keep it running', never: [], updatedAt: '2026-11-10T09:00:00Z' },
}
const session: SessionView = {
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
// a responsibility set: In charge renders only when there is one

function stubViewport(lg: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('min-width') ? lg : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.memory.list.mockResolvedValue(layers)
  mockedApi.context.list.mockResolvedValue({ shared: [], agent: [] })
  mockedApi.skillsCatalog.mockResolvedValue([])
  mockedApi.context.produced.mockResolvedValue([])
  mockedApi.agents.loaded.mockResolvedValue(null)
  mockedApi.patchPrefsContext.mockResolvedValue({} as never)
  mockedApi.sessionDetail.mockResolvedValue({ meta: session, turns: [], total: 0 })
  useStore.setState({
    agents: [agent],
    automations: [],
    automationsPending: [],
    selected: { folder: 'f', id: 's1' },
    detail: { meta: session, turns: [], total: 0 },
    page: { kind: 'agent', id: 'a1' },
    contextOpen: false,
    knowsDrawer: null,
    catalog: [],
    chatMode: 'chat',
  })
})

afterEach(() => {
  // @ts-expect-error — jsdom has none; leave the next file as it found it
  delete window.matchMedia
})

describe('Knows on a narrow viewport (<lg): the Context pill opens a bottom sheet', () => {
  it('the pill opens the sheet with the KnowsBlock rows and does NOT toggle the pref', async () => {
    stubViewport(false)
    render(<AgentPage />)
    act(() => fireEvent.click(screen.getByLabelText('context tab')))
    const sheet = await screen.findByRole('dialog', { name: 'Knows' })
    expect(await within(sheet).findByRole('button', { name: 'Open memory' })).toBeInTheDocument()
    expect(await within(sheet).findByRole('button', { name: 'Open mission' })).toBeInTheDocument()
    expect(useStore.getState().contextOpen).toBe(false)
    expect(mockedApi.patchPrefsContext).not.toHaveBeenCalled()
    // a bottom sheet (NodePanel's pattern), never the desktop column
    expect(sheet.className).toMatch(/bottom-0/)
    expect(sheet.className).toMatch(/lg:hidden/)
  })

  it('tapping a count navigates to the agent page section, carrying the way back', async () => {
    stubViewport(false)
    render(<AgentPage />)
    act(() => fireEvent.click(screen.getByLabelText('context tab')))
    const sheet = await screen.findByRole('dialog', { name: 'Knows' })
    act(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Open memory' })))
    expect(await screen.findByTestId('return-chip')).toBeInTheDocument()
    expect(useStore.getState().tab).toBe('memory')
    expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
    expect(screen.queryByRole('dialog', { name: 'Knows' })).toBeNull()
  })

  it('tapping Mission mutates the sheet into the drawer content, presented as the same bottom sheet', async () => {
    stubViewport(false)
    render(<AgentPage />)
    act(() => fireEvent.click(screen.getByLabelText('context tab')))
    const sheet = await screen.findByRole('dialog', { name: 'Knows' })
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Open mission' }))
    const drawer = await screen.findByRole('dialog', { name: 'Mission · Ana' })
    expect(screen.queryByRole('dialog', { name: 'Knows' })).toBeNull()
    expect(drawer.className).toMatch(/bottom-0/)
    expect(drawer.className).toMatch(/inset-x-0/)
  })

  it('closing returns to the conversation: ✕ on the sheet unmounts it; closing what it opened does not bring the sheet back', async () => {
    stubViewport(false)
    render(<AgentPage />)
    act(() => fireEvent.click(screen.getByLabelText('context tab')))
    const sheet = await screen.findByRole('dialog', { name: 'Knows' })
    act(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Close knows' })))
    expect(screen.queryByRole('dialog', { name: 'Knows' })).toBeNull()

    // a section of the agent page
    act(() => fireEvent.click(screen.getByLabelText('context tab')))
    let again = await screen.findByRole('dialog', { name: 'Knows' })
    fireEvent.click(await within(again).findByRole('button', { name: 'Open memory' }))
    // the agent page's return chip brings the conversation back — not the sheet
    await act(async () => {
      fireEvent.click(await screen.findByTestId('return-chip'))
    })
    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's1' })
    expect(screen.queryByRole('dialog', { name: 'Knows' })).toBeNull()

    // the drawer
    act(() => fireEvent.click(screen.getByLabelText('context tab')))
    again = await screen.findByRole('dialog', { name: 'Knows' })
    fireEvent.click(await within(again).findByRole('button', { name: 'Open mission' }))
    const drawer = await screen.findByRole('dialog', { name: 'Mission · Ana' })
    act(() => fireEvent.click(within(drawer).getByRole('button', { name: 'Close mission' })))
    expect(screen.queryByRole('dialog', { name: 'Mission · Ana' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Knows' })).toBeNull()
    expect(useStore.getState().knowsDrawer).toBeNull()
  })
})

describe('Knows on lg+: the pill keeps its semantics', () => {
  it('toggles contextOpen and opens no sheet', () => {
    stubViewport(true)
    render(<AgentPage />)
    act(() => fireEvent.click(screen.getByLabelText('context tab')))
    expect(useStore.getState().contextOpen).toBe(true)
    expect(screen.queryByRole('dialog', { name: 'Knows' })).toBeNull()
  })
})
