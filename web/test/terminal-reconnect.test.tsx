// terminal-reconnect.test.tsx — a server
// restart must never leave the console mute. The console's socket drops
// (the server kills every PTY client on shutdown) but the tmux with the
// real claude survives — so the view says "Reconnecting…" and reopens the
// SAME url with backoff until the server is back, then the band goes. A
// shell tab's PTY dies with the server: it retries a few times and then
// says so, instead of looping forever.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { TerminalView } from '../src/components/TerminalPanel'

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  url: string
  sent: string[] = []
  private listeners: Record<string, ((e: unknown) => void)[]> = {}
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED
  }
  // test drivers
  open(): void {
    this.readyState = FakeSocket.OPEN
    for (const cb of this.listeners.open ?? []) cb({})
  }
  drop(): void {
    this.readyState = FakeSocket.CLOSED
    for (const cb of this.listeners.close ?? []) cb({})
  }
  message(data: unknown): void {
    for (const cb of this.listeners.message ?? []) cb({ data })
  }
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TerminalView keeps its link', () => {
  it('a console drop shows Reconnecting…, reopens the same url with backoff, and clears on open', async () => {
    render(<TerminalView id="k1" endpoint="console" isActive />)
    const first = FakeSocket.instances[0]!
    act(() => first.open())
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument()

    act(() => first.drop())
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
    expect(FakeSocket.instances).toHaveLength(1) // not yet — backoff

    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(FakeSocket.instances).toHaveLength(2)
    const second = FakeSocket.instances[1]!
    expect(second.url).toBe(first.url)

    act(() => second.open())
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument()
    expect(second.sent.some((m) => m.includes('"resize"'))).toBe(true) // the reattached client is re-sized
  })

  it('keys typed while dropped go nowhere; after reconnect they reach the NEW socket', async () => {
    render(<TerminalView id="k2" endpoint="console" isActive />)
    const first = FakeSocket.instances[0]!
    act(() => first.open())
    act(() => first.drop())
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    const second = FakeSocket.instances[1]!
    act(() => second.open())
    // xterm's onData is internal — the seam we can assert is that sends target wsRef's CURRENT socket:
    // the resize on open landed on `second`, not `first`.
    expect(first.sent.filter((m) => m.includes('"resize"'))).toHaveLength(1)
    expect(second.sent.filter((m) => m.includes('"resize"'))).toHaveLength(1)
  })

  it('a shell tab gives up after a few attempts and says the terminal is closed', async () => {
    render(<TerminalView id="s1" endpoint="terminal" isActive />)
    for (let i = 0; i < 4; i++) {
      const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!
      act(() => sock.drop())
      await act(async () => {
        vi.advanceTimersByTime(5_000)
      }) // past any backoff step
    }
    expect(screen.getByText(/Terminal closed/)).toBeInTheDocument()
    const n = FakeSocket.instances.length
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(FakeSocket.instances).toHaveLength(n) // no more attempts
  })

  it('unmount closes deliberately — no reconnect after teardown', async () => {
    const { unmount } = render(<TerminalView id="k3" endpoint="console" isActive />)
    const first = FakeSocket.instances[0]!
    act(() => first.open())
    unmount()
    act(() => first.drop()) // the browser fires close on our own close() too
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(FakeSocket.instances).toHaveLength(1)
  })

  // half-open: the socket claims OPEN but nothing comes back — the pane
  // froze with no band until a reload.
  it('a socket whose pings go unanswered is abandoned and reopened (half-open link)', async () => {
    render(<TerminalView id="h1" endpoint="console" isActive />)
    const first = FakeSocket.instances[0]!
    act(() => first.open())
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(first.sent.some((m) => m.includes('"ping"'))).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    }) // two silent rounds
    expect(first.readyState).toBe(FakeSocket.CLOSED)
    await act(async () => {
      vi.advanceTimersByTime(10)
    })
    expect(FakeSocket.instances).toHaveLength(2)
    expect(FakeSocket.instances[1]!.url).toBe(first.url)
  })

  it('a link that answers stays — any frame (the empty binary pong included) counts as alive and is never written', async () => {
    render(<TerminalView id="h2" endpoint="console" isActive />)
    const first = FakeSocket.instances[0]!
    act(() => first.open())
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })
      act(() => first.message(new Blob([])))
    }
    expect(FakeSocket.instances).toHaveLength(1)
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument()
  })

  it('a handshake stuck in CONNECTING is abandoned and retried', async () => {
    render(<TerminalView id="h3" endpoint="console" isActive />)
    expect(FakeSocket.instances).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('back from a long hide, the open socket is not trusted: it reattaches at once', async () => {
    render(<TerminalView id="h4" endpoint="console" isActive />)
    const first = FakeSocket.instances[0]!
    act(() => first.open())
    const setVisibility = (v: 'hidden' | 'visible'): void => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    act(() => setVisibility('hidden'))
    // the browser froze the tab: timers did not run, the clock did
    vi.setSystemTime(Date.now() + 120_000)
    act(() => setVisibility('visible'))
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
