// console-palette.ts — answering a console TUI's palette question from Silos.
//
// A TUI that themes itself from the terminal's 16 ANSI colours (OpenCode's
// `system` theme) asks for them with OSC 4 (`ESC ] 4 ; <n> ; ? BEL`). Inside
// tmux that question has no good answer on its own (verified 27-10, tmux 3.4
// + OpenCode 1.19.4):
//   · tmux 3.4 answers OSC 4 from `pane-colours` but drops the index from the
//     reply (`ESC ] 4 ; rgb:…`), which OpenCode's parser requires — so
//     OpenCode treats tmux < 3.6 as "legacy" and wraps the question in DCS
//     passthrough for the OUTER terminal instead;
//   · with passthrough off (tmux's default) nobody answers, OpenCode's
//     palette detection fails and `system` silently falls back to OpenCode's
//     own theme (its blue `#5c9cf5` on the prompt bar);
//   · a late answer does not help: once the first detection failed, the TUI
//     stays on its own theme for the life of the process.
// So the answer cannot hinge on when a browser happens to attach. Silos
// attaches its own short-lived tmux client to a newborn console (`-f
// ignore-size`: it never sizes the window), answers every palette question
// with the palette Silos chose for that console, and leaves. The browser's
// xterm swallows the same questions (TerminalView), so exactly one palette
// is ever reported.

/** `ESC ] 4 ; <n> ; rgb:RRRR/GGGG/BBBB BEL` — the xterm reply format. */
export function paletteReply(index: number, hex: string): string {
  const h = hex.replace(/^#/, '').toLowerCase()
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)]
  return `\x1b]4;${index};rgb:${r}${r}/${g}${g}/${b}${b}\x07`
}

const OSC4 = /\x1b\]4;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
const OSC4_START = '\x1b]4;'

/** Finds OSC 4 palette QUERIES in a tmux client's output stream. Fed chunk
 *  by chunk: a question split across chunks is carried to the next feed.
 *  One OSC may ask several slots (`4;1;?;2;?`); a set (`4;1;#fff`) is not a
 *  question and is ignored. */
export class PaletteQueryScanner {
  private tail = ''

  feed(chunk: string): number[] {
    const buf = this.tail + chunk
    const asked: number[] = []
    let consumed = 0
    OSC4.lastIndex = 0
    for (let m = OSC4.exec(buf); m; m = OSC4.exec(buf)) {
      const parts = m[1]!.split(';')
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const n = Number(parts[i])
        if (parts[i + 1] === '?' && Number.isInteger(n) && n >= 0 && n < 256) asked.push(n)
      }
      consumed = OSC4.lastIndex
    }
    // keep an unterminated question (or the bytes that may begin one) for
    // the next chunk; bounded so a stray ESC ] never grows the buffer
    const rest = buf.slice(consumed)
    const open = rest.lastIndexOf(OSC4_START)
    this.tail = open >= 0 ? rest.slice(open).slice(-512) : rest.slice(-(OSC4_START.length - 1))
    return asked
  }
}

/** The slice of a node-pty process the responder needs. */
export interface PaletteClient {
  onData(cb: (data: string) => void): unknown
  onExit(cb: () => void): unknown
  write(data: string): void
  kill(): void
}

export interface PaletteResponderOptions {
  /** spawns the tmux client attached to the console (`-f ignore-size`) */
  spawn: () => PaletteClient
  /** 16 `#rrggbb` colours, ANSI slot order */
  palette: readonly string[]
  /** leave this long after the last question answered (default 4 s) */
  quietMs?: number
  /** leave no later than this, questions or not (default 30 s) */
  maxMs?: number
}

/** Attaches, answers every palette question from `palette`, and detaches
 *  after `quietMs` without a new question (or at `maxMs`). Never throws: a
 *  console whose client cannot attach just keeps OpenCode's own theme. */
export function startPaletteResponder(opts: PaletteResponderOptions): { stop(): void } {
  const quietMs = opts.quietMs ?? 4_000
  const maxMs = opts.maxMs ?? 30_000
  let client: PaletteClient
  try {
    client = opts.spawn()
  } catch {
    return { stop() {} }
  }
  let done = false
  let quiet: ReturnType<typeof setTimeout> | null = null
  const stop = (): void => {
    if (done) return
    done = true
    clearTimeout(deadline)
    if (quiet) clearTimeout(quiet)
    try {
      client.kill()
    } catch {
      /* already gone */
    }
  }
  const deadline = setTimeout(stop, maxMs)
  deadline.unref?.()
  const scanner = new PaletteQueryScanner()
  client.onData((data) => {
    if (done) return
    const asked = scanner.feed(data)
    if (asked.length === 0) return
    const reply = asked.map((n) => (opts.palette[n] ? paletteReply(n, opts.palette[n]!) : '')).join('')
    if (reply) client.write(reply)
    if (quiet) clearTimeout(quiet)
    quiet = setTimeout(stop, quietMs)
    quiet.unref?.()
  })
  client.onExit(() => {
    done = true
    clearTimeout(deadline)
    if (quiet) clearTimeout(quiet)
  })
  return { stop }
}
