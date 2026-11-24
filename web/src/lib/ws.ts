import { getToken } from './api'
import type { KnowsEvent, WsEvent } from './types'

export type ConnectionStatus = 'connected' | 'reconnecting'

export interface WsClientOptions {
  makeSocket?: (url: string) => WebSocket
  onStatus?: (status: ConnectionStatus) => void
}

// Hidden longer than this and the socket is treated as suspect even if it
// still claims OPEN: mobile browsers freeze pages and drop connections
// without ever firing 'close' (a half-open socket), so the app would sit
// "connected" receiving nothing. Short hides (alt-tab) leave it alone.
const STALE_HIDDEN_MS = 30_000

// Heartbeat for the main /ws: the server answers {op:'ping'} with
// {ev:'pong'} (server.ts). A half-open socket — a tunnel that stopped
// forwarding, a server restart the browser never saw — fires no 'close',
// so without this the app sits "connected" receiving no 'session' events:
// the sidebar's order, pulses and unread dots freeze until a reload. Two
// unanswered pings (~60s) → the socket is discarded and the reconnect
// path (reconnecting→connected → store.resync) refetches everything.
// Same policy /ws/terminal already applies server-side.
const HEARTBEAT_MS = 30_000
const HEARTBEAT_MAX_MISSES = 2

export class WsClient {
  private readonly onEvent: (ev: WsEvent) => void
  private readonly makeSocket: (url: string) => WebSocket
  private readonly onStatus: (status: ConnectionStatus) => void
  private socket: WebSocket | null = null
  private timer: number | null = null
  private attempt = 0
  private closing = false
  private hiddenAt: number | null = null
  private listenersInstalled = false
  private heartbeat: number | null = null
  private pongsMissed = 0

  constructor(onEvent: (ev: WsEvent) => void, options: WsClientOptions = {}) {
    this.onEvent = onEvent
    this.makeSocket = options.makeSocket ?? ((url) => new WebSocket(url))
    this.onStatus = options.onStatus ?? (() => {})
  }

  connect(): void {
    this.closing = false
    this.installWakeListeners()
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(getToken())}`
    const socket = this.makeSocket(url)
    this.socket = socket

    socket.addEventListener('open', () => {
      this.attempt = 0
      this.startHeartbeat(socket)
      this.onStatus('connected')
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as WsEvent | KnowsEvent
        // the knows watcher broadcasts {type:'knows'} with no `ev` envelope
        // (server/src/knows-watcher.ts) — wrapped so onEvent sees one shape.
        const ev: WsEvent = 'type' in msg && msg.type === 'knows' ? { ev: 'knows', knows: msg } : (msg as WsEvent)
        if (ev.ev === 'pong') {
          this.pongsMissed = 0
          return
        }
        this.onEvent(ev)
      } catch {
        // ignore unparseable messages
      }
    })
    socket.addEventListener('close', () => {
      this.stopHeartbeat()
      // a deliberate close() sets this.closing = true BEFORE socket.close()
      // — the browser still fires this listener either way, but a
      // deliberate close is not a drop: no need to announce
      // 'reconnecting' or schedule a retry (scheduleReconnect already
      // guards itself, but onStatus didn't).
      if (this.closing) return
      this.onStatus('reconnecting')
      this.scheduleReconnect()
    })
  }

  // Waking up (tab back to foreground, network back) must not wait out a
  // suspended backoff timer: reconnect NOW when the socket is not open, or
  // when a long hide makes an "open" socket suspect (see STALE_HIDDEN_MS).
  // The reconnecting→connected transition then drives the store's resync,
  // so everything missed while asleep is refetched.
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now()
      return
    }
    const hiddenFor = this.hiddenAt !== null ? Date.now() - this.hiddenAt : 0
    this.hiddenAt = null
    if (this.closing) return
    const open = this.socket?.readyState === WebSocket.OPEN
    if (!open || hiddenFor > STALE_HIDDEN_MS) this.forceReconnect()
  }

  private readonly onOnline = (): void => {
    if (this.closing) return
    if (this.socket?.readyState !== WebSocket.OPEN) this.forceReconnect()
  }

  private installWakeListeners(): void {
    if (this.listenersInstalled) return
    this.listenersInstalled = true
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('online', this.onOnline)
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat()
    this.pongsMissed = 0
    this.heartbeat = window.setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      if (this.pongsMissed >= HEARTBEAT_MAX_MISSES) {
        this.forceReconnect()
        return
      }
      this.pongsMissed += 1
      socket.send(JSON.stringify({ op: 'ping' }))
    }, HEARTBEAT_MS) as unknown as number
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      window.clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  private forceReconnect(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    this.attempt = 0
    const s = this.socket
    if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) {
      // closing fires the 'close' listener → 'reconnecting' + an immediate
      // first retry (attempt was just reset).
      s.close()
    } else {
      this.onStatus('reconnecting')
      this.connect()
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return
    const delay = Math.min(500 * 2 ** this.attempt, 8000)
    this.attempt += 1
    this.timer = window.setTimeout(() => this.connect(), delay) as unknown as number
  }

  close(): void {
    this.closing = true
    if (this.listenersInstalled) {
      document.removeEventListener('visibilitychange', this.onVisibility)
      window.removeEventListener('online', this.onOnline)
      this.listenersInstalled = false
    }
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    this.stopHeartbeat()
    this.socket?.close()
    this.socket = null
  }
}
