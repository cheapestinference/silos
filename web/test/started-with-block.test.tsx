// started-with-block.test.tsx — what THIS conversation started with,
// measured from its own transcript. Behaviour only (tests proportional to
// importance — data, owner attribution, actions, guards; never layout or
// copy): the measured total and its split by owner; a part opens the exact
// text it received (api.startedWithPart); a cut start hook offers its text;
// an MCP failure sends you to the project's Tools; «Tools now» lists the
// tools of the account it runs on — and says nothing of them when Silos'
// console runs on another account than the transcript's last writer.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StartedWithBlock } from '../src/components/StartedWithBlock'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { FolderLoads, LoadsRow, ProviderView, SessionView, StartedWith, StartedWithPart } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const part = (over: Partial<StartedWithPart>): StartedWithPart => ({ owner: 'engine', kind: 'system', label: 'system', chars: 100, tokens: 100, ...over })
function measured(over: Partial<StartedWith> = {}): StartedWith {
  return {
    totalTokens: 88_094,
    at: '2026-10-27T10:00:00Z',
    measured: true,
    mode: 'console',
    parts: [
      part({ owner: 'engine', kind: 'system', label: 'system', tokens: 37_600 }),
      part({ owner: 'project', kind: 'instructions', label: '/home/user/ana/CLAUDE.md', tokens: 25_200, ref: 'instructions:0' }),
      part({ owner: 'agent', kind: 'system', label: 'charter', tokens: 158 }),
      part({ owner: 'conversation', kind: 'first', label: 'first', tokens: 80, ref: 'first' }),
      part({ owner: 'you', kind: 'hook', label: 'claude-mem', tokens: 24_056, ref: 'hook:0', truncated: { savedTo: '/tmp/out.txt', size: '10.1KB' } }),
    ],
    pendingMcp: 0,
    pendingMcpServers: [],
    failedMcpServers: [],
    now: null,
    contextNow: null,
    accounts: [{ email: 'owner@example.com', at: '2026-10-27T10:00:00Z' }],
    ...over,
  }
}
const acct = (id: string, email: string): ProviderView =>
  ({ id, kind: 'claude-account', label: id, account: { name: id, email, displayName: 'sam', plan: null, loggedIn: true } }) as unknown as ProviderView
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
}
const ctx = { agentName: 'Ana', agentEmoji: '🧠', folder: '/home/user/ana' }

const openDetail = () => fireEvent.click(within(screen.getByTestId('started-with')).getByRole('button', { name: /Context size|Started with/ }))

function renderBlock() {
  return render(<StartedWithBlock folder="f" id="s1" ctx={ctx} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  // the rows as the folder reads them now: nothing turned off since
  mockedApi.folders.loads.mockResolvedValue({ folder: '/home/user/ana', rows: [] } as unknown as FolderLoads)
  useStore.setState({
    page: null,
    selected: { folder: 'f', id: 's1' },
    detail: { meta: session, turns: [], total: 0 },
    providers: [acct('default', 'owner@example.com'), acct('account:kai', 'second@example.com')],
  })
})

describe('StartedWithBlock — the measurement', () => {
  it("reads THIS conversation's measurement and says its real total, split by owner", async () => {
    mockedApi.startedWith.mockResolvedValue(measured())
    renderBlock()
    const block = await screen.findByTestId('started-with')
    expect(mockedApi.startedWith).toHaveBeenCalledWith('f', 's1')
    expect(block).toHaveTextContent('88,094')
    // the bar carries every owner present with its tokens, in display order
    expect(within(block).getByRole('img').getAttribute('aria-label')).toBe(
      'conversation 80 tokens, agent 158 tokens, project 25,200 tokens, you 24,056 tokens, engine 37,600 tokens',
    )
    // folded: the bar alone — the owner groups read on expand
    expect(block.querySelectorAll('[data-owner]')).toHaveLength(0)
    fireEvent.click(within(block).getByRole('button', { name: /Started with/ }))
    const legend = Array.from(block.querySelectorAll('[data-owner]')).map((e) => e.getAttribute('data-owner'))
    expect(legend).toEqual(['conversation', 'agent', 'project', 'you', 'engine'])
  })

  it('in a conversation the bar weighs the LAST reply: inherited as measured at the start, «this conversation» = the rest (grows, shrinks on compact)', async () => {
    // inherited = 88,094 − 80 = 88,014; the last reply carried 120,000 → this conversation 31,986
    mockedApi.startedWith.mockResolvedValue(measured({ contextNow: { tokens: 120_000, at: '2026-10-27T12:00:00Z' } }))
    renderBlock()
    const block = await screen.findByTestId('started-with')
    expect(block).toHaveTextContent('120,000')
    expect(within(block).getByRole('img').getAttribute('aria-label')).toMatch(/^conversation 31,986 tokens, /)
    fireEvent.click(within(block).getByRole('button', { name: /Context size/ }))
    expect(within(screen.getByTestId('started-with-parts')).getByText(/Turns since/)).toBeInTheDocument()
  })

  it("off a conversation (the agent's At start) it stays the first reply, whatever the conversation weighs now", async () => {
    mockedApi.startedWith.mockResolvedValue(measured({ contextNow: { tokens: 120_000, at: null } }))
    render(<StartedWithBlock folder="f" id="s1" ctx={{ ...ctx, offConversation: true }} own="agent" />)
    const block = await screen.findByTestId('started-with')
    expect(block).toHaveTextContent('88,094')
    expect(within(block).getByRole('img').getAttribute('aria-label')).toMatch(/^conversation 80 tokens, /)
  })

  it("no measurement (an engine that can't say, or no first reply yet) → nothing", async () => {
    mockedApi.startedWith.mockResolvedValue(null)
    renderBlock()
    await waitFor(() => expect(mockedApi.startedWith).toHaveBeenCalled())
    expect(screen.queryByTestId('started-with')).toBeNull()
  })

  it('expanding lists the parts grouped by owner; a part opens the exact text it received', async () => {
    mockedApi.startedWith.mockResolvedValue(measured())
    mockedApi.startedWithPart.mockResolvedValue({ ref: 'instructions:0', text: '# Project rules' })
    renderBlock()
    const block = await screen.findByTestId('started-with')
    fireEvent.click(within(block).getByRole('button', { name: /Started with/ }))
    const parts = within(block).getByTestId('started-with-parts')
    // one group per owner present, in display order
    expect(Array.from(parts.querySelectorAll(':scope > div [data-owner]')).map((e) => e.getAttribute('data-owner'))).toEqual([
      'conversation',
      'agent',
      'project',
      'you',
      'engine',
    ])
    // a part without recorded text can't be opened
    for (const b of within(parts).getAllByRole('button', { name: /System prompt/ })) expect(b).toBeDisabled()
    fireEvent.click(within(parts).getByRole('button', { name: /Instructions › CLAUDE\.md/ }))
    await waitFor(() => expect(mockedApi.startedWithPart).toHaveBeenCalledWith('f', 's1', 'instructions:0'))
    expect(await screen.findByText('# Project rules')).toBeInTheDocument()
  })
})

describe('StartedWithBlock — start problems: one folded alert (a panel, never the error text)', () => {
  const noCut = () => measured().parts.map(({ truncated: _t, ...p }) => p)
  const ROW = 'server:00000000-0000-4000-8000-00000000000b:research@synced:webstats'
  const failing = () =>
    measured({
      parts: noCut(),
      failedMcpServers: [{ name: 'plugin:research:webstats', error: 'Dynamic Client Registration rejected (HTTP 403): <!DOCTYPE HTML PUBLIC …' }],
      problems: [{ kind: 'failed', name: 'plugin:research:webstats', label: 'webstats', row: ROW }],
    })

  it('folded, one name; open, its door lands on the row KEY the server gave — never the error, never a derived name', async () => {
    mockedApi.startedWith.mockResolvedValue(failing())
    renderBlock()
    const alert = await screen.findByTestId('start-problems')
    expect(alert).toHaveAttribute('data-tone', 'amber')
    fireEvent.click(within(alert).getByRole('button', { name: /webstats didn’t start/ }))
    expect(alert).not.toHaveTextContent('403')
    expect(alert).not.toHaveTextContent('DOCTYPE')
    fireEvent.click(within(alert).getByRole('button', { name: 'Turn off ›' }))
    const s = useStore.getState()
    expect(s.tab).toBe('tools')
    expect(s.dossierItem).toBe(ROW)
  })

  // the class (owner 24-11): a door leaving the column carries the
  // conversation as the Knows doors do — its agent's tab, «‹ <title>»
  it("the alert's doors open the agent's Tools tab carrying the conversation, like the Knows doors", async () => {
    mockedApi.startedWith.mockResolvedValue(failing())
    renderBlock()
    const alert = await screen.findByTestId('start-problems')
    fireEvent.click(within(alert).getByRole('button', { name: /webstats didn’t start/ }))
    fireEvent.click(within(alert).getByRole('button', { name: 'Turn off ›' }))
    const s = useStore.getState()
    expect(s.agentFrom).toEqual({ folder: 'f', id: 's1' })
    expect(s.selectedAgentId).toBe('a1')
    expect(s.page?.kind).not.toBe('project')
  })

  it('a row turned off since that start (its conversation line says off): no «Turn off», said so, its door stays; the folded line is no longer amber', async () => {
    const row = (state: 'active' | 'held', line?: 'on' | 'off'): LoadsRow =>
      ({
        key: ROW,
        engine: 'claude-code',
        kind: 'mcp',
        name: 'webstats',
        label: 'webstats',
        exact: true,
        origin: { owner: 'you', carrier: 'research' },
        state,
        ...(line ? { at: [{ place: 'conversation', conversation: 't1', result: line }] } : {}),
      }) as LoadsRow
    const loads = (r: LoadsRow): FolderLoads => ({ folder: '/home/user/ana', rows: [r], conversation: { thread: 't1' } }) as unknown as FolderLoads
    for (const r of [row('active', 'off'), row('held')]) {
      mockedApi.folders.loads.mockResolvedValue(loads(r))
      mockedApi.startedWith.mockResolvedValue(failing())
      const { unmount } = renderBlock()
      const alert = await screen.findByTestId('start-problems')
      await waitFor(() => expect(alert).toHaveAttribute('data-tone', 'quiet'))
      expect(mockedApi.folders.loads).toHaveBeenCalledWith('/home/user/ana', undefined, 's1')
      fireEvent.click(within(alert).getByRole('button', { name: /webstats didn’t start/ }))
      expect(within(alert).queryByRole('button', { name: 'Turn off ›' })).toBeNull()
      expect(alert.querySelector('[data-held="true"]')).not.toBeNull()
      fireEvent.click(within(alert).getByRole('button', { name: 'See it ›' }))
      expect(useStore.getState().dossierItem).toBe(ROW)
      unmount()
    }
    // its own line keeps it on here: still a «Turn off»
    mockedApi.folders.loads.mockResolvedValue(loads(row('held', 'on')))
    mockedApi.startedWith.mockResolvedValue(failing())
    renderBlock()
    const alert = await screen.findByTestId('start-problems')
    await waitFor(() => expect(mockedApi.folders.loads).toHaveBeenCalledTimes(3))
    fireEvent.click(within(alert).getByRole('button', { name: /webstats didn’t start/ }))
    expect(within(alert).getByRole('button', { name: 'Turn off ›' })).toBeInTheDocument()
  })

  it('a sign-in whose server is turned off since leaves the sign-in line: said on its own, no sign-in door', async () => {
    const S0 = 'connector:sam@example.com:claude.ai S0'
    const auth = (i: number) => ({ kind: 'needs-auth' as const, name: `claude.ai S${i}`, label: `S${i}`, row: `connector:sam@example.com:claude.ai S${i}` })
    mockedApi.folders.loads.mockResolvedValue({
      folder: '/home/user/ana',
      rows: [{ key: S0, state: 'held', heldHere: { by: 'item', names: ['x'] } }],
      conversation: { thread: 't1' },
    } as unknown as FolderLoads)
    mockedApi.startedWith.mockResolvedValue(measured({ parts: noCut(), problems: [auth(0), auth(1)] }))
    renderBlock()
    const alert = await screen.findByTestId('start-problems')
    fireEvent.click(within(alert).getByRole('button', { name: /2 tools need your sign-in/ }))
    await waitFor(() => expect(alert.querySelector('[data-held="true"]')).not.toBeNull())
    // the open line names the one still waiting: its own row
    fireEvent.click(within(alert).getByRole('button', { name: /S1 needs your sign-in ›/ }))
    expect(useStore.getState().dossierItem).toBe('connector:sam@example.com:claude.ai S1')
  })

  it('sign-ins: not amber; ONE line, to Tools narrowed to them (one sign-in: its own row)', async () => {
    const auth = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: 'needs-auth' as const,
        name: `claude.ai S${i}`,
        label: `S${i}`,
        row: `connector:sam@example.com:claude.ai S${i}`,
      }))
    mockedApi.startedWith.mockResolvedValue(
      measured({ parts: noCut(), problems: [{ kind: 'failed', name: 'plugin:research:webstats', label: 'webstats', row: ROW }, ...auth(3)] }),
    )
    const { unmount } = renderBlock()
    let alert = await screen.findByTestId('start-problems')
    expect(alert).toHaveAttribute('data-tone', 'amber')
    fireEvent.click(within(alert).getByRole('button', { name: /1 tool didn’t start · 3 need your sign-in/ }))
    expect(within(alert).getAllByRole('button', { name: 'Turn off ›' })).toHaveLength(1)
    fireEvent.click(within(alert).getByRole('button', { name: /3 tools need your sign-in ›/ }))
    expect(useStore.getState().tab).toBe('tools')
    expect(useStore.getState().dossierFilter).toBe('sign-in')
    expect(useStore.getState().dossierItem).toBeNull()
    unmount()
    mockedApi.startedWith.mockResolvedValue(measured({ parts: noCut(), problems: auth(1) }))
    renderBlock()
    alert = await screen.findByTestId('start-problems')
    expect(alert).toHaveAttribute('data-tone', 'quiet')
    fireEvent.click(within(alert).getByRole('button', { name: /S0 needs your sign-in/ }))
    fireEvent.click(within(alert).getByRole('button', { name: /S0 needs your sign-in ›/ }))
    expect(useStore.getState().dossierItem).toBe('connector:sam@example.com:claude.ai S0')
  })

  // the owner's walk (24-11): connectors are connected in claude.ai, never
  // from a chat — a set of them only: that page; mixed: Tools narrowed
  it("sign-ins all at one outside page: the line's door is that page; mixed with a server: Tools narrowed to them", async () => {
    const LINK = { via: 'link' as const, url: 'https://connectors.example.com/settings', where: 'example.com' }
    const conn = (i: number) => ({
      kind: 'needs-auth' as const,
      name: `claude.ai S${i}`,
      label: `S${i}`,
      row: `connector:sam@example.com:claude.ai S${i}`,
      signIn: LINK,
    })
    mockedApi.startedWith.mockResolvedValue(measured({ parts: noCut(), problems: [conn(0), conn(1)] }))
    const { unmount } = renderBlock()
    let alert = await screen.findByTestId('start-problems')
    fireEvent.click(within(alert).getByRole('button', { name: /2 tools need your sign-in/ }))
    const link = within(alert).getByTestId('sign-in')
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', LINK.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(within(alert).queryByRole('button', { name: /need your sign-in ›/ })).toBeNull()
    unmount()
    const server = {
      kind: 'needs-auth' as const,
      name: 'plugin:research:webstats',
      label: 'webstats',
      row: ROW,
      signIn: { via: 'console' as const, draft: 'x' },
    }
    mockedApi.startedWith.mockResolvedValue(measured({ parts: noCut(), problems: [conn(0), server] }))
    renderBlock()
    alert = await screen.findByTestId('start-problems')
    fireEvent.click(within(alert).getByRole('button', { name: /2 tools need your sign-in/ }))
    expect(within(alert).queryByTestId('sign-in')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: /2 tools need your sign-in ›/ }))
    expect(useStore.getState().dossierFilter).toBe('sign-in')
  })

  it('a problem with no row (a folder that is no project): its name, no door', async () => {
    mockedApi.startedWith.mockResolvedValue(measured({ parts: noCut(), problems: [{ kind: 'failed', name: 'tracker', label: 'tracker' }] }))
    renderBlock()
    const alert = await screen.findByTestId('start-problems')
    fireEvent.click(within(alert).getByRole('button', { name: /tracker didn’t start/ }))
    expect(within(alert).queryByRole('button', { name: 'Turn off ›' })).toBeNull()
  })

  it("a cut start hook's «Show it» opens what reached the model", async () => {
    mockedApi.startedWith.mockResolvedValue(measured())
    mockedApi.startedWithPart.mockResolvedValue({ ref: 'hook:0', text: 'Output too large (10.1KB). Full output saved to /tmp/out.txt' })
    renderBlock()
    const alert = await screen.findByTestId('start-problems')
    fireEvent.click(within(alert).getByRole('button', { name: /start output cut/ }))
    fireEvent.click(within(alert).getByRole('button', { name: 'Show it' }))
    await waitFor(() => expect(mockedApi.startedWithPart).toHaveBeenCalledWith('f', 's1', 'hook:0'))
    expect(await screen.findByText(/Full output saved to/)).toBeInTheDocument()
  })

  it('no problems → no alert', async () => {
    mockedApi.startedWith.mockResolvedValue(measured({ parts: measured().parts.map(({ truncated: _t, ...p }) => p) }))
    renderBlock()
    await screen.findByTestId('started-with')
    expect(screen.queryByTestId('start-problems')).toBeNull()
  })
})

describe("MCP servers now — a count, and a door to its agent's Tools tab opened from this conversation", () => {
  const now: StartedWith['now'] = {
    approx: true,
    ratio: 4,
    parts: [],
    tools: 60,
    pendingMcpServers: [],
    failedMcpServers: [],
    mcp: [{ server: 'github', label: 'github', owner: 'project', tools: 12, item: 'mcp:project:github' }],
  }

  it("the count opens the agent's Tools tab — the conversation is carried, the column holds no list", async () => {
    mockedApi.startedWith.mockResolvedValue(measured({ now }))
    const openDossier = vi.fn()
    useStore.setState({ openDossier })
    renderBlock()
    await screen.findByTestId('started-with')
    openDetail()
    fireEvent.click(await screen.findByTestId('tools-now-door'))
    expect(openDossier).toHaveBeenCalledWith('tools')
  })
})
