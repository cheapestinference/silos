// TerminalPanel.tsx — the terminal panel under the chat (Chat.tsx, between
// Transcript and Composer) — a real server PTY (terminal-service.ts) per
// tab, shown with xterm.js. Every tab stays MOUNTED as long as it exists
// (only the inactive one is hidden via CSS): a background terminal keeps
// receiving its output and keeps its scrollback when you return to it —
// truly turning it off is ALWAYS an explicit action (a tab's ✕), never a
// side effect of switching tabs or agents. Nothing mounts (neither the WS
// nor xterm) until there's at least one terminal open — with `terminals`
// empty the component returns null.
import { registerConversationLinks } from '../lib/terminal-conversation-links'
import { registerFileLinks } from '../lib/terminal-file-links'
import { isPaletteQuery, legibleExtendedAnsi } from '../lib/terminal-palette'
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { ShellIcon } from '../lib/icons'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { useStore, TERMINAL_HEIGHT_MIN } from '../store'
import { api, getToken } from '../lib/api'
import { WheelAccumulator, thumbGeometry, positionFromThumbTop, type ScrollInfo } from '../lib/console-scroll'
import { useDarkMode } from './Sidebar'

const TERMINAL_HEIGHT_MAX_VH = 0.6

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// the xterm palette — built from the claude tokens (canvas=background,
// ink=text/cursor, selection with a VERY soft terracotta) + a muted ANSI
// set of our own (never xterm's default neons: saturated red/green/yellow
// clash against this editorial palette). Two fixed variants (not derived
// from var(), which xterm doesn't resolve reliably in its cell measurer).
const ANSI_LIGHT = {
  black: '#141413',
  red: '#b3543d',
  green: '#6b8f5a',
  yellow: '#a8823a',
  blue: '#4d6f99',
  magenta: '#a2638c',
  cyan: '#4c8a86',
  white: '#e8e6dd',
  brightBlack: '#8a887f',
  brightRed: '#c56a4f',
  brightGreen: '#7fa06d',
  brightYellow: '#bd9750',
  brightBlue: '#6486ad',
  brightMagenta: '#b57aa3',
  brightCyan: '#5fa19c',
  brightWhite: '#141413',
}
const ANSI_DARK = {
  black: '#f5f4ef',
  red: '#d99a6c',
  green: '#9bc48a',
  yellow: '#d0b273',
  blue: '#8fb0d6',
  magenta: '#c993b8',
  cyan: '#8fc9c4',
  white: '#46453f',
  brightBlack: '#a8a69d',
  brightRed: '#e3ac85',
  brightGreen: '#add99e',
  brightYellow: '#ddc38f',
  brightBlue: '#a5c3e2',
  brightMagenta: '#d8abcb',
  brightCyan: '#a8d9d4',
  brightWhite: '#f5f4ef',
}

// `bgToken`: the shell terminal sits on --panel; the real console in light
// sits on --canvas ("almost white", not the menu's cream).
// In light, the 256-color cube is remapped for contrast against that exact
// background (lib/terminal-palette.ts) — TUIs like claude downsample to it
// inside tmux, and its light lilacs/yellows were unreadable on cream.
function xtermTheme(dark: boolean, bgToken: '--panel' | '--canvas' = '--panel'): Record<string, string | string[]> {
  const ansi = dark ? ANSI_DARK : ANSI_LIGHT
  const bg = readToken(bgToken)
  return {
    background: bg,
    foreground: readToken('--ink'),
    cursor: readToken('--ink'),
    cursorAccent: bg,
    selectionBackground: readToken('--console-selection'), // a soft terracotta — never a system blue
    ...ansi,
    // the 256 cube remapped for contrast in BOTH themes — the lib darkens
    // on a light bg and lightens on a dark one (terminal-palette.ts).
    ...extendedFor(bg),
  }
}

// the contrast remap needs a concrete #rrggbb background; a token that
// resolves to anything else keeps xterm's own cube
function extendedFor(bg: string): { extendedAnsi?: string[] } {
  return /^#[0-9a-f]{6}$/i.test(bg) ? { extendedAnsi: legibleExtendedAnsi(bg) } : {}
}

// the real console's light palette (see xtermTheme) — exported for Chat.tsx.
export function consoleLightTheme(): Record<string, string | string[]> {
  return xtermTheme(false, '--canvas')
}

// Real Claude Code console in DARK: Silos' OWN warm dark (the dark-theme
// --canvas/--ink), not a generic cool slate, so it reads as "Silos in the
// dark" and matches its already-warm ANSI text. In light, the console uses
// xtermTheme(false) like the shell terminal, and the server tells claude to
// use its own light theme (see Chat.tsx ConsoleView). The
// container must paint this same background so no other-colored edges show
// (Chat.tsx paints var(--console-dark-bg)). The frame comes from the
// --console-dark-* tokens, read when asked, so a theme recolours it; the
// result is kept while the tokens are unchanged, so the pane gets the same
// object on every render (a new one would re-apply the theme each time).
let consoleThemeMemo: { key: string; theme: Record<string, string | string[]> } | null = null
export function consoleTheme(): Record<string, string | string[]> {
  const bg = readToken('--console-dark-bg') // warm charcoal
  const ink = readToken('--console-dark-ink') // warm off-white
  const selection = readToken('--console-selection') // terracotta
  const key = `${bg}|${ink}|${selection}`
  if (consoleThemeMemo?.key !== key) {
    consoleThemeMemo = {
      key,
      theme: {
        background: bg,
        foreground: ink,
        cursor: ink,
        cursorAccent: bg,
        selectionBackground: selection,
        ...ANSI_DARK,
        // claude's dim 256-cube greys (the ✻ spinner 241, the caret 239) were
        // murky on charcoal — the same contrast remap light has, lightening.
        ...extendedFor(bg),
      },
    }
  }
  return consoleThemeMemo.theme
}

// one tab — its own Terminal/WS, mounted as long as it exists in
// `terminals`. Exported to reuse in the real-console spike (Chat.tsx): the
// same xterm ↔ /ws/terminal/:id pipe, no wiring duplicated.
// `endpoint`: 'terminal' (a shell PTY, /ws/terminal/:id — the PTY outlives
// the socket) or 'console' (the real console, /ws/console/:key — the
// server spawns ONE tmux client per socket, at the size this tab measured
// before connecting, so the first paint is already right and no other
// tab's size can leak in).
// `paneDark`: whether the pane is painted dark — the console's BIRTH theme
// (Chat.tsx ConsoleView), which can differ from the UI's; the scrollbar's
// ink must match the pane it sits on, not the page.
// reconnect pacing for a dropped terminal socket (see connect() below)
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 5000] as const
const SHELL_RECONNECT_TRIES = 3
// A half-open socket — a laptop that slept, a network change, a tunnel leg
// that stopped forwarding — fires no 'close': the pane just freezes, with
// no band and no retry, until a reload. Same policy as the main /ws
// (lib/ws.ts): the client pings ({op:'ping'}, answered by the server with an
// EMPTY BINARY frame, never text — text is the pane's output); any frame
// counts as alive; two silent rounds (~60s) → the socket is abandoned and
// reopened. A tab hidden longer than STALE_HIDDEN_MS reattaches on return
// (cheap: the new tmux client repaints the screen). A handshake that never
// completes is abandoned too — CONNECTING forever is the same freeze.
const TERM_HEARTBEAT_MS = 30_000
const TERM_HEARTBEAT_MAX_MISSES = 2
const TERM_STALE_HIDDEN_MS = 30_000
const TERM_CONNECT_TIMEOUT_MS = 10_000

export function TerminalView({
  id,
  isActive,
  theme,
  endpoint = 'terminal',
  paneDark,
  onClosed,
}: {
  id: string
  isActive: boolean
  theme?: Record<string, string | string[]>
  endpoint?: 'terminal' | 'console'
  paneDark?: boolean
  onClosed?: () => void
}) {
  const [dark] = useDarkMode()
  const fontSize = useStore((s) => s.terminalFontSize)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // the real console's scroll position, as tmux reports it (null until the
  // first read, and always null for a shell tab — xterm scrolls those itself).
  const [scroll, setScroll] = useState<ScrollInfo | null>(null)
  // the socket's health, for the band over the pane: a console drop is a
  // server restart (its tmux survives — we reattach), a shell drop is
  // final after a few tries (its PTY died with the server).
  const [link, setLink] = useState<'live' | 'reconnecting' | 'closed'>('live')
  const isConsole = endpoint === 'console'

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      // JetBrains Mono ships here as a latin-only webfont subset, so it has
      // no glyph for the TUI gutter markers the real `claude` prints at the
      // start of lines (● message, ⎿ tool output, ❯ prompt, ✻ status — from
      // Geometric Shapes / Dingbats / Misc Technical). Without a fallback
      // that covers them the browser draws tofu boxes. Chain OS monospaces
      // that DO carry those blocks (and box-drawing) so every glyph resolves.
      fontFamily:
        '"JetBrains Mono", ui-monospace, "SF Mono", "SFMono-Regular", Menlo, "Cascadia Mono", "Segoe UI Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Symbols2", "Segoe UI Symbol", monospace',
      fontSize,
      cursorBlink: true,
      // NO convertEol: it turns a bare \n into \r\n, but tmux uses a bare
      // \n to move DOWN one row keeping the column during incremental
      // repaints (e.g. `\e[2;2H\e[K\n⚠ …`); with it on, the cursor jumped to
      // column 0 and the real console shredded itself on every scroll
      // (stray fragments at line starts, lost indentation).
      // A real PTY already converts program newlines (ONLCR), so nothing
      // needs it.
      scrollback: 5000,
      theme: theme ?? xtermTheme(dark),
      // term.unicode (the width tables below) is a proposed API in xterm 5
      allowProposedApi: true,
      // OSC 8 hyperlinks (claude prints its sign-in link and others this
      // way): a click opens it in a new tab — http(s) only, never a
      // javascript: or file: target from whatever runs in the pane.
      linkHandler: {
        activate: (_event, uri) => {
          if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer')
        },
      },
    })
    // OSC 52 → the OS clipboard: tmux (set-clipboard on) emits every copy
    // — a mouse selection included — as this escape; without the handler it
    // died inside tmux's own buffer and the system clipboard stayed empty.
    term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(';')
      const b64 = semi >= 0 ? data.slice(semi + 1) : data
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
        void navigator.clipboard.writeText(text)
      } catch {
        /* denied or malformed: nothing to do */
      }
      return true
    })
    // a console TUI's palette question (OSC 4 `n;?`) is answered by the
    // server, with the palette Silos chose for that console (server
    // console-palette.ts) — this xterm stays quiet, so exactly one palette
    // is ever reported. A palette SET still goes to xterm's own handler.
    if (isConsole) term.parser.registerOscHandler(4, isPaletteQuery)
    // emoji are two columns wide for tmux and the TUIs (Unicode 11+
    // wcwidth); xterm's default tables (Unicode 6) count them as one, so the
    // glyph got a single cell and the next cell painted over its right half.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    // session names and ids the TUI prints → their conversation (title on hover)
    const unlinkRefs = registerConversationLinks(term)
    // paths it prints → the file viewer, relative ones against the conversation's cwd
    const unlinkFiles = registerFileLinks(term, () => useStore.getState().detail?.meta.cwd)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    // Rule 1: a server restart must never leave the console mute.
    // The server kills every PTY client on shutdown, so this socket drops
    // — but the console's tmux (the real claude) survives, and the
    // /ws/console route only needs that tmux to exist. So a drop that we
    // did not ask for reopens the SAME url with backoff (waking at once on
    // focus/online, like lib/ws.ts) and the pane repaints on reattach; the
    // xterm buffer stays as it was meanwhile. A shell's PTY does die with
    // the server: a few tries, then the band says so.
    let closing = false
    let attempt = 0
    let retryTimer: number | null = null
    let heartbeat: number | null = null
    let connectTimer: number | null = null
    let pongsMissed = 0
    let hiddenAt: number | null = null
    const stopLiveness = (): void => {
      if (heartbeat !== null) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
    }
    // a drop of the CURRENT socket — reported by the browser ('close') or
    // detected by us (dead heartbeat, stale after a hide, stuck handshake).
    // One retry per drop: the socket is let go first (wsRef → null), so its
    // own late 'close' is ignored and no second timer races this one.
    const onDrop = (ws: WebSocket, code: number | undefined, immediate: boolean): void => {
      if (closing || wsRef.current !== ws || retryTimer !== null) return
      stopLiveness()
      wsRef.current = null
      // 4404 = the server says this console is GONE (its claude exited via
      // /exit or crashed, so its tmux session died) — NOT a transient
      // server-restart drop. Stop reconnecting: otherwise the pane loops
      // "Reconnecting to the console…" forever, hammering a handshake every
      // ~5s, with no hint that "Restart console" is the way out.
      if (isConsole && code === 4404) {
        setLink('closed')
        return
      }
      if (!isConsole && attempt >= SHELL_RECONNECT_TRIES) {
        setLink('closed')
        return
      }
      setLink('reconnecting')
      const delay = immediate ? 0 : RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]!
      attempt += 1
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        connect()
      }, delay)
    }
    // we know it is dead, the browser does not: drop it now, close it after
    const abandon = (ws: WebSocket, immediate: boolean): void => {
      onDrop(ws, undefined, immediate)
      try {
        ws.close()
      } catch {
        /* already closing */
      }
    }
    const connect = (): void => {
      // the size goes in the URL too: a console client is BORN at this size
      // (the resize on open stays as a belt-and-braces for the shells).
      const params = new URLSearchParams({ token: getToken(), cols: String(term.cols), rows: String(term.rows) })
      const ws = new WebSocket(`${proto}://${window.location.host}/ws/${endpoint}/${id}?${params.toString()}`)
      wsRef.current = ws
      connectTimer = window.setTimeout(() => {
        connectTimer = null
        if (ws.readyState === WebSocket.CONNECTING) abandon(ws, false)
      }, TERM_CONNECT_TIMEOUT_MS)
      ws.addEventListener('open', () => {
        if (wsRef.current !== ws) return
        attempt = 0
        stopLiveness()
        pongsMissed = 0
        heartbeat = window.setInterval(() => {
          if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return
          if (pongsMissed >= TERM_HEARTBEAT_MAX_MISSES) {
            abandon(ws, true)
            return
          }
          pongsMissed += 1
          ws.send(JSON.stringify({ op: 'ping' }))
        }, TERM_HEARTBEAT_MS)
        setLink('live')
        ws.send(JSON.stringify({ op: 'resize', cols: term.cols, rows: term.rows }))
        refreshScroll()
      })
      ws.addEventListener('message', (ev: MessageEvent) => {
        pongsMissed = 0 // any frame proves the link
        if (typeof ev.data !== 'string') return // the server's pong (an empty binary frame)
        term.write(ev.data)
        if (isConsole && refreshTimer === null && Date.now() - lastRefresh > 1000) refreshScroll()
      })
      // a socket can fire close more than once (the browser's own after
      // ours) — onDrop takes only the current one, once.
      ws.addEventListener('close', (ev) => onDrop(ws, ev.code, false))
    }
    // waking up (tab back, network back) must not sit out a backoff timer,
    // nor trust a socket that sat through a long hide (see TERM_STALE_HIDDEN_MS)
    const wake = (): void => {
      if (closing) return
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      const hiddenFor = hiddenAt !== null ? Date.now() - hiddenAt : 0
      hiddenAt = null
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN && hiddenFor > TERM_STALE_HIDDEN_MS) {
        abandon(ws, true)
        return
      }
      if (retryTimer === null) return
      clearTimeout(retryTimer)
      retryTimer = null
      connect()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    // where tmux's view stands, for the console's own scrollbar: read after
    // every scroll gesture (debounced — one tmux query per burst, not per
    // tick) and, while output flows, at most once a second (history grows,
    // the thumb shrinks). Shell tabs never ask: xterm owns their scroll.
    let refreshTimer: number | null = null
    let lastRefresh = 0
    const refreshScroll = (): void => {
      if (!isConsole) return
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        lastRefresh = Date.now()
        api
          .consoleScroll(id)
          .then(setScroll)
          .catch(() => {
            /* console gone: the bar just stays put */
          })
      }, 80)
    }
    connect()
    const dataListener = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'write', data }))
    })

    // wheel scrolling: with the app owning the mouse (tmux `mouse on`),
    // xterm.js reports EVERY browser wheel event to tmux as one tick, and
    // tmux scrolled 5 rows per tick — a mouse notch jumped, a trackpad
    // swipe (dozens of tiny events) flew off. Intercepted here (capture,
    // ahead of xterm's own handler): pixel travel is accumulated and sent
    // as ONE tick per row of travel (WheelAccumulator), and the server
    // binds tmux to one row per tick — the content follows the gesture
    // 1:1, notch or swipe alike. Same SGR reports the touch path sends.
    const rowHeight = (): number => Math.max(8, el!.clientHeight / Math.max(1, term.rows))
    const cellAt = (clientX: number, clientY: number): { x: number; y: number } => {
      const r = el!.getBoundingClientRect()
      return {
        x: Math.min(term.cols, Math.max(1, Math.floor((clientX - r.left) / (r.width / Math.max(1, term.cols))) + 1)),
        y: Math.min(term.rows, Math.max(1, Math.floor((clientY - r.top) / rowHeight()) + 1)),
      }
    }
    const sendWheel = (ticks: number, cell: { x: number; y: number }): void => {
      const ws = wsRef.current
      if (ticks === 0 || !ws || ws.readyState !== WebSocket.OPEN) return
      const button = ticks > 0 ? 65 : 64 // 65 = wheel DOWN (content moves up), 64 = wheel UP
      const seq = `\x1b[<${button};${cell.x};${cell.y}M`
      ws.send(JSON.stringify({ op: 'write', data: seq.repeat(Math.min(30, Math.abs(ticks))) }))
      refreshScroll()
    }
    const wheelAcc = new WheelAccumulator()
    const onWheel = (e: WheelEvent): void => {
      if (term.modes.mouseTrackingMode === 'none') return // a shell tab: xterm scrolls its own buffer
      e.preventDefault()
      e.stopPropagation()
      sendWheel(wheelAcc.push(e.deltaY, e.deltaMode, rowHeight(), term.rows), cellAt(e.clientX, e.clientY))
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })

    // touch scrolling: xterm.js turns a swipe into a scroll of ITS OWN
    // viewport, which is meaningless while the app owns the mouse (tmux
    // with `mouse on` reports wheel events and scrolls its real history).
    // So while mouse tracking is on, a swipe is translated into SGR wheel
    // reports (button 64 = up, 65 = down — what xterm.js itself sends for
    // a wheel) at one tick per cell of travel — the phone scrolls the same
    // history the desktop's wheel does, and nothing scrolls locally.
    let touchY: number | null = null
    let touchCell: { x: number; y: number } = { x: 1, y: 1 }
    const onTouchStart = (e: TouchEvent): void => {
      if (term.modes.mouseTrackingMode === 'none' || e.touches.length !== 1) {
        touchY = null
        return
      }
      const t = e.touches[0]!
      touchY = t.clientY
      touchCell = cellAt(t.clientX, t.clientY)
    }
    const onTouchMove = (e: TouchEvent): void => {
      if (touchY === null || e.touches.length !== 1 || wsRef.current?.readyState !== WebSocket.OPEN) return
      const y = e.touches[0]!.clientY
      const ticks = Math.trunc((touchY - y) / rowHeight())
      if (ticks === 0) return
      e.preventDefault()
      touchY -= ticks * rowHeight()
      sendWheel(ticks, touchCell) // finger up = content moves down = wheel DOWN, and vice versa
    }
    const onTouchEnd = (): void => {
      touchY = null
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)

    return () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      el.removeEventListener('wheel', onWheel, { capture: true })
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      dataListener.dispose()
      closing = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      stopLiveness()
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      wsRef.current?.close()
      unlinkRefs.dispose()
      unlinkFiles.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mounting/unmounting the tab: `dark` and `fontSize` are applied separately, below
  }, [id, endpoint])

  // a live theme swap if light/dark changes while the terminal is already open.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme ?? xtermTheme(dark)
  }, [dark, theme])

  // refits when it becomes visible (a background tab may have gotten out
  // of sync with the panel's size), on any container resize (dragging
  // the panel's edge, resizing the window) and when the font size changes
  // (Settings › Appearance): a bigger cell means fewer cols/rows, and tmux
  // has to hear the new grid or it keeps painting the old one.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    function refit(): void {
      if (!isActive) return
      const term = termRef.current
      if (term && term.options.fontSize !== fontSize) term.options.fontSize = fontSize
      fitRef.current?.fit()
      const ws = wsRef.current
      if (term && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'resize', cols: term.cols, rows: term.rows }))
    }
    refit()
    const ro = new ResizeObserver(refit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isActive, fontSize])

  // dragging the bar: the thumb follows the pointer at once (optimistic),
  // tmux is asked to follow at most every 50 ms (each ask is a tmux
  // round-trip), and the last position always lands (trailing call).
  const scrollToTimer = useRef<number | null>(null)
  const scrollToPending = useRef<number | null>(null)
  function scrollTo(position: number): void {
    setScroll((s) => (s ? { ...s, position } : s))
    scrollToPending.current = position
    if (scrollToTimer.current !== null) return
    const flush = (): void => {
      scrollToTimer.current = null
      const p = scrollToPending.current
      scrollToPending.current = null
      if (p === null) return
      api
        .consoleScrollTo(id, p)
        .then(setScroll)
        .catch(() => {
          /* console gone */
        })
    }
    scrollToTimer.current = window.setTimeout(flush, 50)
  }

  return (
    <div className="absolute inset-0" style={{ display: isActive ? 'block' : 'none' }}>
      <div ref={containerRef} className={`absolute inset-0 px-2 py-1 ${isConsole ? 'console-pane' : ''}`} />
      {isConsole ? <ConsoleScrollbar info={scroll} dark={paneDark ?? dark} onScrollTo={scrollTo} /> : null}
      {link === 'reconnecting' ? (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-ink-2 shadow-sm"
        >
          {isConsole ? 'Reconnecting to the console…' : 'Reconnecting…'}
        </div>
      ) : link === 'closed' ? (
        isConsole && onClosed ? (
          // the console's claude exited (or its tmux died): offer a restart,
          // instead of the shell's "open a new one" (there is no new console tab).
          <button
            type="button"
            onClick={onClosed}
            className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-ink hover:text-terracotta shadow-sm"
          >
            Console closed — Restart
          </button>
        ) : (
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-ink-2 shadow-sm"
          >
            Terminal closed — the shell died with the server. Open a new one.
          </div>
        )
      ) : null}
    </div>
  )
}

// The real console's scrollbar — the pane's OWN, drawn from tmux's scroll
// position (xterm's is hidden, see theme.css: it tracked a buffer that
// isn't what's on screen). A hairline thumb at rest that thickens under
// the pointer; grab it and the tmux view follows (goto-line), click the
// track to jump. No bar at all while there's nothing to scroll.
function ConsoleScrollbar({ info, dark, onScrollTo }: { info: ScrollInfo | null; dark: boolean; onScrollTo: (position: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [trackPx, setTrackPx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startY: number; startTop: number } | null>(null)

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const measure = (): void => setTrackPx(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const thumb = info ? thumbGeometry(info, trackPx) : null
  if (!info || !thumb) return null

  function onThumbDown(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault() // keeps the keyboard focus in the console
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.clientY, startTop: thumb!.top }
    setDragging(true)
  }
  function onThumbMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!drag.current) return
    onScrollTo(positionFromThumbTop(info!, trackPx, drag.current.startTop + (e.clientY - drag.current.startY)))
  }
  function onThumbUp(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!drag.current) return
    onScrollTo(positionFromThumbTop(info!, trackPx, drag.current.startTop + (e.clientY - drag.current.startY)))
    drag.current = null
    setDragging(false)
  }
  // a click on the track centres the thumb there
  function onTrackDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    onScrollTo(positionFromThumbTop(info!, trackPx, e.clientY - r.top - thumb!.height / 2))
  }

  const ink = dark ? 'var(--veil-light)' : 'var(--veil-dark)'
  // the track starts at top-10: clear of the Restart button ConsoleView
  // pins at the pane's top-right corner.
  return (
    <div
      ref={trackRef}
      role="scrollbar"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={info.history}
      aria-valuenow={info.history - info.position}
      aria-label="console history"
      onPointerDown={onTrackDown}
      className="group absolute bottom-1 right-0 top-10 w-3 cursor-default"
    >
      <div
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
        className="absolute right-[3px] rounded-full transition-[width,opacity,background-color] duration-150 group-hover:w-[7px] motion-reduce:transition-none"
        style={{
          top: thumb.top,
          height: thumb.height,
          width: dragging ? 7 : 3,
          backgroundColor: `color-mix(in srgb, ${ink} ${dragging ? 55 : 28}%, transparent)`,
          opacity: dragging || info.position > 0 ? 1 : 0.7,
        }}
      />
    </div>
  )
}

function TerminalTab({ id, title, active }: { id: string; title: string; active: boolean }) {
  const selectTerminalTab = useStore((s) => s.selectTerminalTab)
  const closeTerminal = useStore((s) => s.closeTerminal)
  const terminalOpen = useStore((s) => s.terminalOpen)
  const toggleTerminalPanel = useStore((s) => s.toggleTerminalPanel)

  // Two REAL buttons in a flex container — not a <button> with a nested
  // role="button" span (invalid interactive-in-interactive, and its tabIndex={-1}
  // close was unreachable by keyboard). Both are now tab-reachable.
  return (
    <div
      className={`flex shrink-0 items-center gap-1 rounded-md pl-2 pr-1 py-1 text-xs font-mono ${active ? 'bg-canvas text-ink' : 'text-ink-2 hover:text-ink'}`}
    >
      <button
        type="button"
        onClick={() => {
          selectTerminalTab(id)
          if (!terminalOpen) toggleTerminalPanel()
        }}
        aria-current={active ? 'true' : undefined}
        className="min-w-0 truncate"
      >
        {title}
      </button>
      <button
        type="button"
        aria-label={`close ${title}`}
        onClick={() => closeTerminal(id)}
        className="shrink-0 rounded p-0.5 hover:bg-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-terracotta/40"
      >
        <X size={11} aria-hidden="true" />
      </button>
    </div>
  )
}

export function TerminalPanel() {
  const terminals = useStore((s) => s.terminals)
  const activeTerminalId = useStore((s) => s.activeTerminalId)
  const terminalOpen = useStore((s) => s.terminalOpen)
  const terminalHeight = useStore((s) => s.terminalHeight)
  const newTerminal = useStore((s) => s.newTerminal)
  const toggleTerminalPanel = useStore((s) => s.toggleTerminalPanel)
  const openTerminalPanel = useStore((s) => s.openTerminalPanel)
  const resizeTerminal = useStore((s) => s.resizeTerminal)
  // mirrors store.newTerminal's destination guard (terminalDestination) —
  // with no destination (Anywhere with no project chosen and no session
  // with a cwd), the launch button used to go to a silent no-op. Disabled
  // with a title explaining why, as the old composer button did.
  const hasTerminalDestination = useStore((s) => {
    if (!s.selectedAgentId) return false
    const agent = s.agents.find((a) => a.id === s.selectedAgentId)
    if (agent && agent.folder !== null) return true
    return (s.detail?.meta.cwd ?? s.chosenProject) != null
  })
  const noDestinationTitle = 'Pick a project first — the terminal needs a folder to run in'

  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  function onDragStart(e: React.PointerEvent<HTMLDivElement>): void {
    dragRef.current = { startY: e.clientY, startHeight: terminalHeight }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onDragMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return
    const delta = dragRef.current.startY - e.clientY // the top edge moves up → the panel grows
    const max = window.innerHeight * TERMINAL_HEIGHT_MAX_VH
    const next = Math.min(max, Math.max(TERMINAL_HEIGHT_MIN, dragRef.current.startHeight + delta))
    resizeTerminal(next)
  }
  function onDragEnd(): void {
    if (!dragRef.current) return
    dragRef.current = null
    resizeTerminal(useStore.getState().terminalHeight, true) // only persists on release
  }

  // a persistent bar: the console ALWAYS lives at the bottom of the column
  // as a thin bar — starting the first console happens from here, not from
  // the composer. With no terminals: the whole bar is the launch button;
  // with no terminal destination it's disabled with an explanatory title
  // instead of a silent no-op.
  if (terminals.length === 0)
    return (
      <div data-terminal-panel="" className="shrink-0 border-t border-line bg-panel">
        <button
          type="button"
          aria-label="open terminal"
          disabled={!hasTerminalDestination}
          title={hasTerminalDestination ? undefined : noDestinationTitle}
          onClick={() => void openTerminalPanel()}
          className="flex w-full items-center gap-1.5 px-3 py-1 font-mono text-[11px] text-ink-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-ink-2"
        >
          <ShellIcon size={12} aria-hidden="true" />
          Terminal
        </button>
      </div>
    )

  return (
    <div data-terminal-panel="" className="flex shrink-0 flex-col border-t border-line bg-panel">
      {terminalOpen ? (
        <div
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          role="separator"
          aria-orientation="horizontal"
          aria-label="resize terminal panel"
          className="h-1.5 shrink-0 cursor-row-resize hover:bg-terracotta/30"
        />
      ) : null}

      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
        {terminals.map((t) => (
          <TerminalTab key={t.id} id={t.id} title={t.title} active={terminalOpen && t.id === activeTerminalId} />
        ))}
        <button
          type="button"
          aria-label="new terminal"
          disabled={!hasTerminalDestination}
          title={hasTerminalDestination ? 'New terminal' : noDestinationTitle}
          onClick={() => void newTerminal()}
          className="shrink-0 rounded-md p-1 text-ink-2 hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          aria-label={terminalOpen ? 'collapse terminal panel' : 'expand terminal panel'}
          title={terminalOpen ? 'Hide the terminal' : 'Show the terminal'}
          onClick={toggleTerminalPanel}
          className="ml-auto shrink-0 rounded-md p-1 text-ink-2 hover:bg-canvas hover:text-ink"
        >
          {terminalOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>

      {terminalOpen ? (
        // NEVER flex-1 here: the panel (shrink-0) isn't stretched by its
        // parent, so flex-1 would give it flex-basis 0 (no extra space to
        // distribute) and this container — and the absolute inset-0 xterm
        // inside it — would collapse to 0px tall despite the inline
        // `height` (a real bug, seen in a screenshot: the terminal painted
        // out of flow, behind/under the composer). A genuinely fixed height, no flex.
        <div className="relative w-full overflow-hidden" style={{ height: terminalHeight }}>
          {terminals.map((t) => (
            <TerminalView key={t.id} id={t.id} isActive={t.id === activeTerminalId} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
