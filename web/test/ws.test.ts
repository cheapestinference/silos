import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsClient } from '../src/lib/ws'
import type { WsEvent } from '../src/lib/types'

type Listener = (ev: unknown) => void

class FakeSocket {
  static instances: FakeSocket[] = []
  url: string
  closed = false
  sent: string[] = []
  readyState = 0 // CONNECTING — triggerOpen() flips to OPEN, close to CLOSED
  private listeners: Record<'open' | 'close' | 'message', Listener[]> = { open: [], close: [], message: [] }

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  addEventListener(type: 'open' | 'close' | 'message', cb: Listener): void {
    this.listeners[type].push(cb)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  send(data: string): void {
    this.sent.push(data)
  }

  triggerOpen(): void {
    this.readyState = 1
    for (const cb of this.listeners.open) cb({})
  }

  triggerClose(): void {
    this.readyState = 3
    for (const cb of this.listeners.close) cb({})
  }

  triggerMessage(data: unknown): void {
    for (const cb of this.listeners.message) cb({ data: JSON.stringify(data) })
  }
}

const makeSocket = (url: string): WebSocket => new FakeSocket(url) as unknown as WebSocket

describe('WsClient', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    localStorage.clear()
    window.history.pushState({}, '', '/')
    localStorage.setItem('silos-token', 'my-token')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('the connection URL carries the token', () => {
    const client = new WsClient(() => {}, { makeSocket })
    client.connect()

    expect(FakeSocket.instances).toHaveLength(1)
    expect(FakeSocket.instances[0]?.url).toContain('token=my-token')
  })

  it('parsed events reach onEvent', () => {
    const onEvent = vi.fn()
    const client = new WsClient(onEvent, { makeSocket })
    client.connect()

    const socket = FakeSocket.instances[0]!
    socket.triggerOpen()
    const ev: WsEvent = { ev: 'hello' }
    socket.triggerMessage(ev)

    expect(onEvent).toHaveBeenCalledWith(ev)
  })

  it('after a close, retries with exponential backoff', () => {
    const client = new WsClient(() => {}, { makeSocket })
    client.connect()
    expect(FakeSocket.instances).toHaveLength(1)

    FakeSocket.instances[0]!.triggerOpen()
    FakeSocket.instances[0]!.triggerClose()

    // the delay hasn't passed yet
    vi.advanceTimersByTime(400)
    expect(FakeSocket.instances).toHaveLength(1)

    // the first delay passes (500ms)
    vi.advanceTimersByTime(100)
    expect(FakeSocket.instances).toHaveLength(2)

    // a second close: the next attempt waits longer (exponential backoff)
    FakeSocket.instances[1]!.triggerClose()
    vi.advanceTimersByTime(900)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(200)
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('the backoff resets the attempt count on opening again', () => {
    const client = new WsClient(() => {}, { makeSocket })
    client.connect()
    FakeSocket.instances[0]!.triggerClose()
    vi.advanceTimersByTime(500)
    expect(FakeSocket.instances).toHaveLength(2)

    // this time it does open successfully before closing again
    FakeSocket.instances[1]!.triggerOpen()
    FakeSocket.instances[1]!.triggerClose()

    // the attempt count reset to 0, so it takes 500ms again, not more
    vi.advanceTimersByTime(500)
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('close() disables reconnection', () => {
    const client = new WsClient(() => {}, { makeSocket })
    client.connect()
    client.close()

    expect(FakeSocket.instances[0]!.closed).toBe(true)

    FakeSocket.instances[0]!.triggerClose()
    vi.advanceTimersByTime(10000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('a deliberate close() does NOT trigger onStatus(reconnecting) — a real drop does', () => {
    const onStatus = vi.fn()
    const client = new WsClient(() => {}, { makeSocket, onStatus })
    client.connect()
    FakeSocket.instances[0]!.triggerOpen()
    onStatus.mockClear()

    // a deliberate close(): the socket's own close listener still fires
    // (the browser doesn't distinguish), but closing=true was already set
    // BEFORE socket.close() — the listener must see it and stay quiet.
    client.close()
    FakeSocket.instances[0]!.triggerClose()
    expect(onStatus).not.toHaveBeenCalled()

    // a real drop (without going through close()) of the next socket
    // must warn — the guard can't swallow legitimate closes.
    onStatus.mockClear()
    client.connect()
    FakeSocket.instances[1]!.triggerOpen()
    FakeSocket.instances[1]!.triggerClose()
    expect(onStatus).toHaveBeenCalledWith('reconnecting')
  })

  it('onStatus receives reconnecting on close and connected on reopening', () => {
    const onStatus = vi.fn()
    const client = new WsClient(() => {}, { makeSocket, onStatus })
    client.connect()

    FakeSocket.instances[0]!.triggerOpen()
    expect(onStatus).toHaveBeenCalledWith('connected')

    FakeSocket.instances[0]!.triggerClose()
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting')

    vi.advanceTimersByTime(500)
    FakeSocket.instances[1]!.triggerOpen()
    expect(onStatus).toHaveBeenLastCalledWith('connected')
  })
})

// Wake-up behavior (mobile): the browser suspends the page and may kill the
// socket without ever firing 'close' — waking must not sit on a suspended
// backoff timer or trust a half-open socket. Each test tracks ITS OWN
// sockets (per-test makeSocket) so listeners left by other tests can't
// contaminate the counts.
describe('WsClient — waking up', () => {
  function setVisibility(v: 'hidden' | 'visible'): void {
    Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  function freshClient(): { client: WsClient; mine: FakeSocket[]; statuses: string[] } {
    const mine: FakeSocket[] = []
    const statuses: string[] = []
    const client = new WsClient(() => {}, {
      makeSocket: (url) => {
        const s = new FakeSocket(url)
        mine.push(s)
        return s as unknown as WebSocket
      },
      onStatus: (st) => statuses.push(st),
    })
    return { client, mine, statuses }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a LONG hide makes even an "open" socket suspect: waking force-closes it', () => {
    const { client, mine } = freshClient()
    client.connect()
    mine[0]!.triggerOpen()
    setVisibility('hidden')
    vi.setSystemTime(31_000) // hidden past STALE_HIDDEN_MS
    setVisibility('visible')
    expect(mine[0]!.closed).toBe(true) // the half-open suspect is discarded
    mine[0]!.triggerClose()
    vi.advanceTimersByTime(500) // attempt was reset — first-retry delay, not a grown backoff
    expect(mine.length).toBe(2)
    client.close()
  })

  it('a short hide leaves an open socket alone (alt-tab friendly)', () => {
    const { client, mine } = freshClient()
    client.connect()
    mine[0]!.triggerOpen()
    setVisibility('hidden')
    vi.setSystemTime(5_000)
    setVisibility('visible')
    expect(mine[0]!.closed).toBe(false)
    expect(mine.length).toBe(1)
    client.close()
  })

  it('waking with a dead socket reconnects NOW, not after the suspended backoff', () => {
    const { client, mine, statuses } = freshClient()
    client.connect()
    mine[0]!.triggerOpen()
    mine[0]!.triggerClose() // a drop: backoff scheduled (500ms)
    setVisibility('visible') // wake before the timer — must not wait it out
    expect(mine.length).toBe(2) // reconnected immediately, no timer advance
    expect(statuses).toContain('reconnecting')
    client.close()
  })

  // heartbeat: a half-open socket (a tunnel that stops forwarding, a
  // server restart the browser never saw) fires no 'close' — without a
  // ping/pong the app sits "connected" receiving nothing forever.
  describe('heartbeat', () => {
    it('pings every 30s once open and reconnects after two unanswered pings', () => {
      const { client, mine, statuses } = freshClient()
      client.connect()
      mine[0]!.triggerOpen()
      vi.advanceTimersByTime(30_000)
      expect(mine[0]!.sent).toEqual([JSON.stringify({ op: 'ping' })])
      vi.advanceTimersByTime(30_000) // second ping, first still unanswered
      expect(mine[0]!.sent).toHaveLength(2)
      expect(mine[0]!.closed).toBe(false)
      vi.advanceTimersByTime(30_000) // two misses → the socket is declared dead
      expect(mine[0]!.closed).toBe(true)
      mine[0]!.triggerClose()
      expect(statuses).toContain('reconnecting')
      vi.advanceTimersByTime(500)
      expect(mine.length).toBe(2)
      client.close()
    })

    it('a pong resets the miss counter — a healthy socket is never closed', () => {
      const { client, mine } = freshClient()
      client.connect()
      mine[0]!.triggerOpen()
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(30_000)
        mine[0]!.triggerMessage({ ev: 'pong' })
      }
      expect(mine[0]!.closed).toBe(false)
      expect(mine.length).toBe(1)
      client.close()
    })

    it('close() stops the heartbeat', () => {
      const { client, mine } = freshClient()
      client.connect()
      mine[0]!.triggerOpen()
      client.close()
      vi.advanceTimersByTime(90_000)
      expect(mine[0]!.sent).toEqual([])
    })
  })
})
