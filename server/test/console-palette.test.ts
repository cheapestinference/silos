// console-palette.test.ts — Silos answers a console TUI's palette question
// (OSC 4) itself: one short-lived tmux client, exactly the palette Silos
// chose, gone after the questions stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaletteQueryScanner, paletteReply, startPaletteResponder, type PaletteClient } from '../src/console-palette.js'

describe('paletteReply', () => {
  it("is the xterm reply WITH its index (OpenCode's parser requires it; tmux 3.4 drops it)", () => {
    expect(paletteReply(6, '#D97757')).toBe('\x1b]4;6;rgb:d9d9/7777/5757\x07')
  })
})

describe('PaletteQueryScanner', () => {
  it('finds questions ended by BEL or ST, several per OSC, and ignores colour sets', () => {
    const s = new PaletteQueryScanner()
    expect(s.feed('frame\x1b]4;0;?\x07more\x1b]4;5;?;6;?\x1b\\\x1b]4;1;#ffffff\x07')).toEqual([0, 5, 6])
  })

  it('carries a question split across chunks to the next feed, never twice', () => {
    const s = new PaletteQueryScanner()
    expect(s.feed('screen \x1b]4;1')).toEqual([])
    expect(s.feed('2;?\x07 rest')).toEqual([12])
    expect(s.feed(' and on')).toEqual([])
    expect(s.feed('\x1b')).toEqual([])
    expect(s.feed(']4;3;?\x07')).toEqual([3])
  })

  it('a stray unterminated ESC ] 4 never grows past its bound', () => {
    const s = new PaletteQueryScanner()
    s.feed('\x1b]4;' + 'x'.repeat(5000))
    expect(s.feed('\x1b]4;2;?\x07')).toEqual([2])
  })
})

describe('startPaletteResponder', () => {
  let data: ((d: string) => void) | null
  let exit: (() => void) | null
  let written: string[]
  let killed: number
  const client = (): PaletteClient => ({
    onData: (cb) => {
      data = cb
    },
    onExit: (cb) => {
      exit = cb
    },
    kill: () => {
      killed++
    },
  })
  const deliver = (d: string): void => {
    written.push(d)
  }
  const palette = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`)

  beforeEach(() => {
    vi.useFakeTimers()
    data = null
    exit = null
    written = []
    killed = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers each question from the palette and leaves after the questions go quiet', () => {
    startPaletteResponder({ spawn: client, deliver, palette, quietMs: 1000, maxMs: 30_000 })
    data!('\x1b]4;6;?\x07\x1b]4;99;?\x07')
    expect(written).toEqual([paletteReply(6, '#000006')]) // no slot 99: no reply
    vi.advanceTimersByTime(900)
    data!('\x1b]4;5;?\x07') // a second round re-arms the quiet timer
    vi.advanceTimersByTime(900)
    expect(killed).toBe(0)
    vi.advanceTimersByTime(200)
    expect(killed).toBe(1)
    data!('\x1b]4;1;?\x07') // gone: nothing more is answered
    expect(written).toHaveLength(2)
  })

  it('leaves at maxMs when the TUI never asks, and stops cleanly if the console dies first', () => {
    startPaletteResponder({ spawn: client, deliver, palette, maxMs: 5000 })
    vi.advanceTimersByTime(5000)
    expect(killed).toBe(1)
    startPaletteResponder({ spawn: client, deliver, palette, maxMs: 5000 })
    exit!()
    vi.advanceTimersByTime(10_000)
    expect(killed).toBe(1) // exited on its own: never killed again
  })

  it("a client that cannot attach is no error (the console keeps OpenCode's own theme)", () => {
    expect(() =>
      startPaletteResponder({
        spawn: () => {
          throw new Error('no tmux')
        },
        deliver,
        palette,
      }).stop(),
    ).not.toThrow()
  })
})
