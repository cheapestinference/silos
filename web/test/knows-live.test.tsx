// knows-live.test.tsx — the server's `knows` WS event on the client: an
// event for the visible agent's folder
// invalidates the Knows data (block AND drawer re-read their sources), pulses
// the kind's counter and shows ONE toast "+ <kind> · <name>" (the latest; auto-dismiss
// 6 s; click → openKnows(kind, {openItem: name})). Events for other
// folders/agents leave the state untouched. The server coalesces per
// (kind, folder), so an event means "re-read", not a change list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ContextColumn } from '../src/components/ContextColumn'
import { KnowsDrawer } from '../src/components/knows/KnowsDrawer'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { WsClient } from '../src/lib/ws'
import type { AgentView, KnowsEvent, MemoryLayers, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const FOLDER = '/home/user/ana'
const layers: MemoryLayers = {
  global: { name: 'CLAUDE.md', path: '/g', scope: 'global', mtime: 0, exists: true },
  project: { name: 'CLAUDE.md', path: '/p', scope: 'project', mtime: 0, exists: false },
  autoMemory: [{ name: 'a.md', path: '/a', scope: 'auto', mtime: 0, exists: true, author: 'a1' }],
  agent: { name: 'AGENT.md', path: '/ag', scope: 'agent', mtime: 0, exists: true },
}
function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: FOLDER, skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
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
const knows = (over: Partial<KnowsEvent> = {}): KnowsEvent => ({
  type: 'knows',
  folder: FOLDER,
  kind: 'memory',
  action: 'added',
  name: 'notes.md',
  scope: 'auto',
  ...over,
})
const send = (e: KnowsEvent): void => act(() => useStore.getState().applyWs({ ev: 'knows', knows: e }))
const liveSlice = () => {
  const s = useStore.getState()
  return { version: s.knowsVersion, toast: s.knowsToast, pulse: s.knowsPulse }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.memory.list.mockResolvedValue(layers)
  mockedApi.context.list.mockResolvedValue({ shared: [], agent: [] })
  mockedApi.skillsCatalog.mockResolvedValue([])
  mockedApi.context.produced.mockResolvedValue([])
  mockedApi.agents.loaded.mockResolvedValue(null)
  useStore.setState({
    agents: [makeAgent(), makeAgent({ id: 'b2', name: 'Bea', folder: '/home/user/bea' })],
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

afterEach(() => {
  // clears the toast AND its auto-dismiss timer
  useStore.getState().dismissKnowsToast()
  vi.useRealTimers()
})

describe('knows live — the WS event', () => {
  it('a plans event bumps plansVersion[folder] for any folder, without a toast or a knows refetch', () => {
    useStore.setState({ plansVersion: {} })
    const before = liveSlice()
    send({ type: 'knows', folder: '/somewhere/else', kind: 'plans', action: 'changed', name: 'x.plan.json', scope: 'project' })
    send({ type: 'knows', folder: '/somewhere/else', kind: 'plans', action: 'changed', name: 'x.plan.json', scope: 'project' })
    expect(useStore.getState().plansVersion).toEqual({ '/somewhere/else': 2 })
    expect(liveSlice()).toEqual(before)
  })

  it('(a) an event from another folder (or another agent) does not touch the state', () => {
    const before = liveSlice()
    send(knows({ folder: '/home/user/bea' }))
    send(knows({ agentId: 'b2', scope: 'agent' })) // same folder, someone else's agent memory
    expect(liveSlice()).toEqual(before)
    expect(useStore.getState().knowsToast).toBeNull()
  })

  it('(b) an event from the visible folder refreshes the block and queues the toast', async () => {
    render(<ContextColumn />)
    await screen.findByRole('button', { name: 'Open memory' })
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open memory' })).toHaveTextContent('1 learned by Ana'))
    const v = useStore.getState().knowsVersion.memory
    // what the server will answer once the note landed
    mockedApi.memory.list.mockResolvedValue({
      ...layers,
      autoMemory: [...layers.autoMemory, { name: 'notes.md', path: '/n', scope: 'auto', mtime: 0, exists: true, author: 'a1' }],
    })

    send(knows())

    expect(useStore.getState().knowsVersion.memory).toBe(v + 1)
    expect(useStore.getState().knowsPulse.memory).toEqual(expect.any(Number))
    expect(useStore.getState().knowsToast).toMatchObject({ kind: 'memory', name: 'notes.md' })
    // the block re-reads its sources and paints the new count
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open memory' })).toHaveTextContent('2 learned by Ana'))
    expect(screen.getByRole('button', { name: /\+ memory · notes\.md/ })).toBeInTheDocument()
  })

  it('a WS reconnect re-fetches every kind quietly — a fetch that failed while the server restarted does not leave Knows empty for good', async () => {
    mockedApi.memory.list.mockRejectedValueOnce(new Error('server restarting'))
    mockedApi.overview.mockResolvedValue({ agents: [makeAgent()], now: 0 } as never)
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession(), turns: [], total: 0 } as never)
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalledTimes(1))
    // the failed read is no row (never a count)
    // the agent's own listing (the column's «Given to this conversation»
    // reads the conversation's apart, with its session id)
    const agentReads = () => (mockedApi.context.list.mock.calls as unknown[][]).filter((c) => c[1] === undefined).length
    await waitFor(() => expect(agentReads()).toBe(1))
    expect(screen.queryByRole('button', { name: 'Open memory' })).toBeNull()

    await act(async () => {
      await useStore.getState().resync()
    })

    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalledTimes(2))
    expect(agentReads()).toBe(2)
    expect(mockedApi.skillsCatalog).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open memory' })).toHaveTextContent('1 learned by Ana'))
    expect(useStore.getState().knowsToast).toBeNull()
  })

  it("an event from a SECONDARY territory (Agent.folders) counts as the agent's", () => {
    useStore.setState({ agents: [makeAgent({ folders: ['/home/user/shared/'] }), makeAgent({ id: 'b2', name: 'Bea', folder: '/home/user/bea' })] })
    const v = useStore.getState().knowsVersion.context
    // the watcher emits the normalised territory (no trailing slash)
    send(knows({ folder: '/home/user/shared', kind: 'context', scope: 'shared', name: 'brief.md' }))
    expect(useStore.getState().knowsVersion.context).toBe(v + 1)
    expect(useStore.getState().knowsToast).toMatchObject({ kind: 'context', name: 'brief.md' })
  })

  it('a secondary territory of ANOTHER agent stays foreign', () => {
    useStore.setState({ agents: [makeAgent(), makeAgent({ id: 'b2', name: 'Bea', folder: '/home/user/bea', folders: ['/home/user/shared'] })] })
    const before = liveSlice()
    send(knows({ folder: '/home/user/shared', kind: 'context', scope: 'shared', name: 'brief.md' }))
    expect(liveSlice()).toEqual(before)
  })

  it('a global event (folder "") is visible to every agent', () => {
    send(knows({ folder: '', scope: 'global', name: 'CLAUDE.md' }))
    expect(useStore.getState().knowsToast).toMatchObject({ kind: 'memory', name: 'CLAUDE.md' })
  })

  it('with the drawer open on that kind, its list re-fetches', async () => {
    useStore.setState({ knowsDrawer: { kind: 'memory' } })
    render(<KnowsDrawer agent={makeAgent()} />)
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalledTimes(1))
    send(knows())
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalledTimes(2))
  })

  it('(c) two events in a row → a single visible toast (the last), gone after 6 s', () => {
    vi.useFakeTimers()
    render(<ContextColumn />)
    send(knows({ name: 'first.md' }))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    send(knows({ kind: 'context', name: 'brief.md', scope: 'shared' }))
    const toasts = screen.getAllByRole('button', { name: /^\+ / })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toHaveTextContent('+ context · brief.md')
    // the timer restarted with the last event: 3 s + 5.9 s later it's still there
    act(() => {
      vi.advanceTimersByTime(5900)
    })
    expect(screen.getByRole('button', { name: /\+ context · brief\.md/ })).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByRole('button', { name: /^\+ / })).toBeNull()
    expect(useStore.getState().knowsToast).toBeNull()
  })

  it('(d) a click on the toast opens the drawer on that item', () => {
    render(<ContextColumn />)
    send(knows({ kind: 'skills', name: 'deploy', scope: 'project' }))
    fireEvent.click(screen.getByRole('button', { name: /\+ skills · deploy/ }))
    expect(useStore.getState().knowsDrawer).toEqual({ kind: 'skills', openItem: 'deploy', openScope: 'project' })
    expect(useStore.getState().knowsToast).toBeNull()
  })

  it('(e) a click on a MEMORY toast lands on that note (matched by scope + basename of its path), not "Gone"', async () => {
    mockedApi.memory.list.mockResolvedValue({
      ...layers,
      autoMemory: [{ name: 'Deploy notes', path: '/home/x/.claude/projects/p/memory/note.md', scope: 'auto', mtime: 0, exists: true }],
    })
    mockedApi.memory.read.mockImplementation(async (p: string) => {
      if (p === '/home/x/.claude/projects/p/memory/note.md') return 'the note body'
      throw new Error('not allowed')
    })
    render(
      <>
        <ContextColumn />
        <KnowsDrawer agent={makeAgent()} />
      </>,
    )
    send(knows({ kind: 'memory', name: 'note.md', scope: 'auto' }))
    fireEvent.click(screen.getByRole('button', { name: /\+ memory · note\.md/ }))
    expect(await screen.findByText('the note body')).toBeInTheDocument()
    expect(screen.queryByText(/no longer exists/i)).toBeNull()
    expect(mockedApi.memory.read).not.toHaveBeenCalledWith('note.md')
  })

  it('(g) a click on a SKILLS toast, with the drawer mounted, lands on the skill (matched by name; skills have no path)', async () => {
    mockedApi.skillsCatalog.mockResolvedValue([{ name: 'deploy', source: 'project', state: 'active', description: 'Ship it' }] as never)
    mockedApi.skillReadme.mockResolvedValue({ name: 'deploy', description: 'Ship it', body: 'deploy readme body' })
    render(
      <>
        <ContextColumn />
        <KnowsDrawer agent={makeAgent()} />
      </>,
    )
    send(knows({ kind: 'skills', name: 'deploy', scope: 'project' }))
    fireEvent.click(screen.getByRole('button', { name: /\+ skills · deploy/ }))
    await waitFor(() => expect(mockedApi.skillReadme).toHaveBeenCalledWith('deploy'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByText(/deploy readme body/)).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('(h) a click on a REMOVED memory toast (item absent from the list) does not crash or hang on Loading', async () => {
    mockedApi.memory.read.mockRejectedValue(new Error('file not found'))
    render(
      <>
        <ContextColumn />
        <KnowsDrawer agent={makeAgent()} />
      </>,
    )
    send(knows({ kind: 'memory', action: 'removed', name: 'gone.md', scope: 'auto' }))
    fireEvent.click(screen.getByRole('button', { name: /− memory · gone\.md/ }))
    // nothing listed answers to it: the library opens on its list
    const drawer = await screen.findByRole('dialog')
    await waitFor(() => expect(within(drawer).queryByText('Reading…')).toBeNull())
    expect(mockedApi.memory.read).not.toHaveBeenCalled()
  })

  it('(f) a global CLAUDE.md toast opens the GLOBAL file, not the project one of the same name', async () => {
    mockedApi.memory.list.mockResolvedValue({
      ...layers,
      global: { name: 'CLAUDE.md', path: '/home/x/.claude/CLAUDE.md', scope: 'global', mtime: 0, exists: true },
      project: { name: 'CLAUDE.md', path: '/home/user/ana/CLAUDE.md', scope: 'project', mtime: 0, exists: true },
    })
    mockedApi.memory.read.mockImplementation(async (p: string) => {
      if (p === '/home/x/.claude/CLAUDE.md') return 'global body'
      if (p === '/home/user/ana/CLAUDE.md') return 'project body'
      throw new Error('not allowed')
    })
    render(
      <>
        <ContextColumn />
        <KnowsDrawer agent={makeAgent()} />
      </>,
    )
    send(knows({ kind: 'memory', folder: '', name: 'CLAUDE.md', scope: 'global' }))
    fireEvent.click(screen.getByRole('button', { name: /\+ memory · CLAUDE\.md/ }))
    expect(await screen.findByText('global body')).toBeInTheDocument()
    expect(screen.queryByText('project body')).toBeNull()
  })
})

describe('knows live — WsClient dispatch', () => {
  it('a {type:"knows"} message reaches onEvent as {ev:"knows"}', () => {
    type L = (e: unknown) => void
    const listeners: Record<string, L[]> = {}
    const fake = {
      readyState: 0,
      addEventListener: (t: string, cb: L) => {
        ;(listeners[t] ??= []).push(cb)
      },
      close: () => {},
      send: () => {},
    }
    const onEvent = vi.fn()
    const client = new WsClient(onEvent, { makeSocket: () => fake as unknown as WebSocket })
    client.connect()
    const e = knows()
    for (const cb of listeners.message ?? []) cb({ data: JSON.stringify(e) })
    expect(onEvent).toHaveBeenCalledWith({ ev: 'knows', knows: e })
    client.close()
  })
})
