// output-style.test.tsx — the cockpit's output style on the web:
// one row in "Run on" (the control both chat and console share), the agent's
// default beside it, a word on the runs-on line when it is not the plain
// voice, and nothing at all on an engine without styles (OpenCode).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ProviderPanel } from '../src/components/ProviderPanel'
import { ContextColumn } from '../src/components/ContextColumn'
import { styleNow } from '../src/components/OutputStyleRow'
import { resolveEffective } from '../src/lib/cockpit'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, OutputStyleInfo, SessionDetail } from '../src/lib/types'

vi.mock('../src/lib/api')
class IdleSocket {
  static OPEN = 1
  readyState = 0
  constructor(public url: string) {}
  addEventListener() {}
  send() {}
  close() {}
}
vi.stubGlobal('WebSocket', IdleSocket)
const mockedApi = vi.mocked(api, { deep: true })

const STYLES: OutputStyleInfo[] = [
  { id: 'default', description: 'Claude Code’s usual voice', source: 'built-in' },
  { id: 'Explanatory', description: 'Explains its implementation choices and codebase patterns', source: 'built-in' },
  { id: 'Learning', description: 'Pauses and asks you to write small pieces of code', source: 'built-in' },
  { id: 'Team Voice', description: 'ours', source: 'project' },
]
const DEFAULT_ACCOUNT = {
  id: 'default',
  kind: 'claude-account',
  label: 'Claude (this machine)',
  window: null,
  account: { name: 'default', configDir: null, providerId: 'default', loggedIn: true, email: 'd@x.com', plan: 'max', shared: true },
}

function agent(over: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Smoke', emoji: '🧪', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...over }
}
function detail(harness: 'opencode' | 'claude-code'): SessionDetail {
  return {
    meta: {
      id: 's1',
      folder: 'f',
      title: 'S',
      skills: [],
      cwd: null,
      mtime: 0,
      size: 1,
      turnCount: 1,
      live: false,
      worktree: false,
      native: true,
      agentId: 'a1',
      harness,
    } as SessionDetail['meta'],
    turns: [],
    total: 0,
  }
}
const dialog = () => screen.getByRole('dialog', { name: 'Run on' })

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.conversationPrefs.patchApplied.mockResolvedValue({ prefs: {}, applied: 'next-turn' })
  mockedApi.providers.list.mockResolvedValue([DEFAULT_ACCOUNT] as never)
  mockedApi.agents.outputStyles.mockResolvedValue(STYLES)
  mockedApi.agents.update.mockResolvedValue(undefined)
  useStore.setState({
    providers: [DEFAULT_ACCOUNT] as never,
    catalog: [] as never,
    agents: [agent()],
    selectedAgentId: 'a1',
    selected: { folder: 'f', id: 's1' },
    convPrefs: {},
    pendingConvPrefs: {},
    turnOverrides: {},
    providerPanel: null,
    detail: detail('claude-code'),
    chatMode: 'chat',
    consoleRestartRequest: 0,
  })
})

describe('the cascade, mirrored', () => {
  it('turn › conversation › agent; nothing when nobody set one', () => {
    expect(resolveEffective(undefined, {}, {}).outputStyle).toBeUndefined()
    expect(resolveEffective(undefined, {}, {}, undefined, 'Explanatory').outputStyle).toBe('Explanatory')
    expect(resolveEffective(undefined, { outputStyle: 'default' }, {}, undefined, 'Explanatory').outputStyle).toBe('default')
    expect(resolveEffective(undefined, { outputStyle: 'default' }, { outputStyle: 'Learning' }, undefined, 'Explanatory').outputStyle).toBe('Learning')
    expect(styleNow(undefined, undefined)).toEqual({ style: null, from: 'operator' })
    expect(styleNow(undefined, 'Explanatory')).toEqual({ style: 'Explanatory', from: 'agent' })
    expect(styleNow('Learning', 'Explanatory')).toEqual({ style: 'Learning', from: 'conversation' })
  })
})

describe('Run on — the style row', () => {
  it('an OpenCode conversation never shows it nor asks for styles', () => {
    useStore.setState({ detail: detail('opencode'), agents: [agent({ framework: 'opencode' })] })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode', outputStyle: 'Explanatory' })} />)
    expect(within(dialog()).queryByTestId('output-style-row')).toBeNull()
    expect(mockedApi.agents.outputStyles).not.toHaveBeenCalled()
  })

  it("unset: says the operator's own setting decides; the list is the engine's, a pick pins it for the next message and closes", async () => {
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent()} />)
    const row = within(dialog()).getByTestId('output-style-row')
    expect(row).toHaveTextContent('Answers in')
    expect(row).toHaveTextContent('Claude Code’s setting')
    expect(row).toHaveTextContent('not set in Silos — your own config decides')
    expect(mockedApi.agents.outputStyles).toHaveBeenCalledWith('a1', { folder: 'f', id: 's1' })
    fireEvent.click(within(row).getByRole('button', { name: /Answers in/ }))
    const menu = await within(row).findByRole('menu', { name: 'Output style' })
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole('menuitemradio')
          .map((el) => el.textContent),
      ).toEqual([
        'DefaultClaude Code’s usual voice',
        'ExplanatoryExplains its implementation choices and codebase patterns',
        'LearningPauses and asks you to write small pieces of code',
        'Team Voicethis projectours',
      ]),
    )
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /^Learning/ }))
    await waitFor(() => expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { outputStyle: 'Learning' }))
    await waitFor(() => expect(useStore.getState().providerPanel).toBeNull())
    expect(useStore.getState().convPrefs.outputStyle).toBe('Learning')
    expect(useStore.getState().consoleRestartRequest).toBe(0)
    expect(mockedApi.agents.update).not.toHaveBeenCalled()
  })

  it("the agent's default shows as such; a pin can be dropped back to it", async () => {
    useStore.setState({ convPrefs: { outputStyle: 'default' } })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ outputStyle: 'Explanatory' })} />)
    const row = within(dialog()).getByTestId('output-style-row')
    expect(row).toHaveTextContent('Default')
    expect(row).toHaveTextContent('chosen for this conversation')
    fireEvent.click(within(row).getByRole('button', { name: /Answers in/ }))
    fireEvent.click(await within(row).findByRole('button', { name: 'Follow Smoke’s default (Explanatory)' }))
    await waitFor(() => expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { outputStyle: null }))
  })

  it('a live console relaunches on it (the server answers restart); "also the default" saves it on the agent', async () => {
    mockedApi.conversationPrefs.patchApplied.mockResolvedValue({ prefs: {}, applied: 'restart' })
    useStore.setState({ chatMode: 'console' })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent()} />)
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: /Also make it Smoke’s default/ }))
    const row = within(dialog()).getByTestId('output-style-row')
    fireEvent.click(within(row).getByRole('button', { name: /Answers in/ }))
    fireEvent.click(await within(row).findByRole('menuitemradio', { name: /^Explanatory/ }))
    await waitFor(() => expect(useStore.getState().consoleRestartRequest).toBe(1))
    expect(mockedApi.agents.update).toHaveBeenCalledWith('a1', { outputStyle: 'Explanatory' })
  })
})

describe('the runs-on line', () => {
  const line = () => screen.getByRole('button', { name: 'Change what it runs on' }).textContent ?? ''
  it('names a style in a word (the pin › the agent), never the plain one, never on OpenCode', () => {
    useStore.setState({ agents: [agent({ outputStyle: 'Explanatory' })] })
    const { unmount } = render(<ContextColumn />)
    expect(line()).toMatch(/· Explanatory$/)
    unmount()
    useStore.setState({ convPrefs: { outputStyle: 'default' } })
    const second = render(<ContextColumn />)
    expect(line()).not.toMatch(/Explanatory|default$/)
    second.unmount()
    useStore.setState({ convPrefs: {}, agents: [agent({ framework: 'opencode', outputStyle: 'Explanatory' })], detail: detail('opencode') })
    render(<ContextColumn />)
    expect(line()).not.toContain('Explanatory')
  })
})
