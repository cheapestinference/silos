// terminal-panel.test.tsx — light coverage of mounting/unmounting the
// panel — with no terminals there is NOTHING in the DOM (no xterm, no WS);
// with one open, the panel mounts its container and cleans up on unmount.
// xterm's real WS is replaced by a simple double (jsdom brings a real
// WebSocket, which would try to actually connect) and ResizeObserver
// (absent in jsdom) by a stub — neither exists in src/ anymore, they're
// just test infrastructure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { TerminalPanel } from '../src/components/TerminalPanel'
import { useStore } from '../src/store'

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = FakeSocket.CONNECTING
  url: string
  sent: string[] = []
  closed = false
  private listeners: Record<string, ((e: unknown) => void)[]> = { open: [], message: [], close: [] }
  constructor(url: string) {
    this.url = url
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.readyState = FakeSocket.CLOSED
  }
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  // jsdom does not implement matchMedia — xterm.js uses it for devicePixelRatio.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(), // a legacy API — xterm.js still uses it
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  useStore.setState({
    terminals: [],
    activeTerminalId: null,
    terminalOpen: false,
    terminalHeight: 220,
    // the launch button now depends on a terminal target (an agent with a
    // folder / a session's cwd / a chosen project) — a baseline with no
    // target, each test seeds its own.
    agents: [],
    selectedAgentId: null,
    detail: null,
    chosenProject: null,
  })
})

// a minimal agent with a folder — a valid terminal target (the same shape as AgentView)
function agentWithFolder() {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',
    role: '',
    folder: '/tmp/ana',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TerminalPanel — mount/unmount', () => {
  // a persistent bar: with no terminals the panel no longer disappears, a
  // thin bottom bar stays whose only button starts the first console
  // (openTerminalPanel creates one if needed). The composer's terminal
  // button is gone; this is now the only launch point.
  it('with no terminals renders the collapsed bar with the launch button (enabled with a target)', () => {
    const openTerminalPanel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ openTerminalPanel, agents: [agentWithFolder()], selectedAgentId: 'a1' })
    const { container, getByLabelText, queryByLabelText } = render(<TerminalPanel />)
    expect(container.querySelector('[data-terminal-panel]')).not.toBeNull()
    expect(queryByLabelText('new terminal')).toBeNull() // no tabs: just the bar
    fireEvent.click(getByLabelText('open terminal'))
    expect(openTerminalPanel).toHaveBeenCalled()
  })

  // with no target (Anywhere with no project), the composer's old button
  // used to go disabled — the new bar had lost that guard and the click
  // was a silent no-op.
  it('with no terminal target the launch button goes disabled with an explanatory title', () => {
    const openTerminalPanel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ openTerminalPanel }) // no agent selected = no target
    const { getByLabelText } = render(<TerminalPanel />)
    const button = getByLabelText('open terminal')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('Pick a project'))
    fireEvent.click(button)
    expect(openTerminalPanel).not.toHaveBeenCalled()
  })

  it("the target can also come from the open session's cwd or the chosen project (Anywhere)", () => {
    useStore.setState({ chosenProject: '/tmp/project', selectedAgentId: 'master', agents: [{ ...agentWithFolder(), id: 'master', folder: null }] })
    const { getByLabelText } = render(<TerminalPanel />)
    expect(getByLabelText('open terminal')).toBeEnabled()
  })

  it('the + new-tab button respects the same target guard', () => {
    useStore.setState({
      terminals: [{ id: 't1', agentId: 'a1', title: 'Ana' }],
      activeTerminalId: 't1',
      terminalOpen: false, // collapsed: doesn't mount xterm, just the tab bar
    })
    const { getByLabelText } = render(<TerminalPanel />)
    expect(getByLabelText('new terminal')).toBeDisabled() // no target
    act(() => useStore.setState({ agents: [agentWithFolder()], selectedAgentId: 'a1' }))
    expect(getByLabelText('new terminal')).toBeEnabled()
  })

  it('with a terminal open, mounts the panel and its tab', () => {
    useStore.setState({
      terminals: [{ id: 't1', agentId: 'a1', title: 'Ana' }],
      activeTerminalId: 't1',
      terminalOpen: true,
    })
    const { container, getByText } = render(<TerminalPanel />)
    expect(container.querySelector('[data-terminal-panel]')).not.toBeNull()
    expect(getByText('Ana')).toBeInTheDocument()
  })

  it('collapsed (terminalOpen=false) shows the tab bar but not the terminal area', () => {
    useStore.setState({
      terminals: [{ id: 't1', agentId: 'a1', title: 'Ana' }],
      activeTerminalId: 't1',
      terminalOpen: false,
    })
    const { container } = render(<TerminalPanel />)
    expect(container.querySelector('[data-terminal-panel]')).not.toBeNull()
    expect(container.querySelector('[role="separator"]')).toBeNull() // the drag border only exists when expanded
  })

  it('unmounting the panel does not blow up (cleans up WS/xterm)', () => {
    useStore.setState({
      terminals: [{ id: 't1', agentId: 'a1', title: 'Ana' }],
      activeTerminalId: 't1',
      terminalOpen: true,
    })
    const { unmount } = render(<TerminalPanel />)
    expect(() => unmount()).not.toThrow()
  })

  it('going back to terminals:[] (the last tab closed) returns to the collapsed bar', () => {
    useStore.setState({
      terminals: [{ id: 't1', agentId: 'a1', title: 'Ana' }],
      activeTerminalId: 't1',
      terminalOpen: true,
    })
    const { container, rerender, queryByText, queryByLabelText } = render(<TerminalPanel />)
    expect(container.querySelector('[data-terminal-panel]')).not.toBeNull()

    useStore.setState({ terminals: [], activeTerminalId: null, terminalOpen: false })
    rerender(<TerminalPanel />)

    // the bar persists, but with no tab or terminal area
    expect(container.querySelector('[data-terminal-panel]')).not.toBeNull()
    expect(queryByText('Ana')).toBeNull()
    expect(queryByLabelText('open terminal')).not.toBeNull()
  })
})
