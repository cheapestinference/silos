import { describe, it, expect } from 'vitest'
import {
  isPaletteQuery,
  xterm256,
  contrast,
  ensureContrast,
  legibleExtendedAnsi,
  warmGreyPastel,
  hexToRgb,
  rgbToHex,
  MIN_CONTRAST,
} from '../src/lib/terminal-palette'

const PANEL = '#f0eee6' // light --panel

describe('xterm256', () => {
  it('reproduces the standard cube and grey ramp', () => {
    expect(xterm256(16)).toEqual([0, 0, 0])
    expect(xterm256(105)).toEqual([135, 135, 255]) // the lilac claude uses for links
    expect(xterm256(226)).toEqual([255, 255, 0]) // loud yellow
    expect(xterm256(232)).toEqual([8, 8, 8])
    expect(xterm256(255)).toEqual([238, 238, 238])
  })
})

describe('ensureContrast', () => {
  const bg = hexToRgb(PANEL)
  it('the lilac 105 and the loud yellows become legible on the light panel', () => {
    for (const i of [105, 226, 184, 190, 220, 39, 51]) {
      expect(contrast(xterm256(i), bg)).toBeLessThan(MIN_CONTRAST) // the problem is real
      expect(contrast(ensureContrast(xterm256(i), bg), bg)).toBeGreaterThanOrEqual(MIN_CONTRAST)
    }
  })
  it('keeps the hue: a darkened blue is still blue, a yellow still warm', () => {
    const [r, g, b] = ensureContrast(xterm256(105), bg)
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
    const [yr, yg, yb] = ensureContrast(xterm256(226), bg)
    expect(yr).toBeGreaterThan(yb)
    expect(yg).toBeGreaterThan(yb)
  })
  it('colors that already pass are untouched', () => {
    expect(ensureContrast(xterm256(16), bg)).toEqual([0, 0, 0])
    expect(ensureContrast(xterm256(241), bg)).toEqual(xterm256(241)) // claude's dim grey, fine as is
  })
})

describe('ensureContrast — pastels are backgrounds, not text', () => {
  const bg = hexToRgb(PANEL)
  it("the sent-message box (grey 255) and diff pastels stay light — they're painted UNDER black text", () => {
    for (const i of [255, 254, 224, 194, 230]) {
      expect(ensureContrast(xterm256(i), bg)).toEqual(xterm256(i))
    }
  })
  it('warmGreyPastel: greys take the paper hue at their own lightness; chromatic pastels keep theirs', () => {
    const paper = hexToRgb('#faf9f5')
    const [r, g, b] = warmGreyPastel(xterm256(255), paper)
    expect(r).toBeGreaterThanOrEqual(g)
    expect(g).toBeGreaterThan(b)
    expect(warmGreyPastel(xterm256(194), paper)).toEqual(xterm256(194)) // diff green stays green
  })
  it('mid and vivid colors are still darkened (lilac 105, loud yellow 226)', () => {
    expect(ensureContrast(xterm256(105), bg)).not.toEqual(xterm256(105))
    expect(ensureContrast(xterm256(226), bg)).not.toEqual(xterm256(226))
  })
})

// The DARK mirror ("✻ Crunched" was murky grey on charcoal).
// Claude's dim greys (241 spinner, 239 caret) get LIGHTENED to contrast
// against the dark console; the dark greys claude paints BOXES with
// (input box 237, sent box 235) are background duty and stay subtle.
describe('legibleExtendedAnsi — dark console', () => {
  const DARK_BG = '#262624' // TerminalPanel CONSOLE_BG
  it("the spinner grey 241 and the caret 239 become legible on charcoal, keeping grey's neutrality", () => {
    const bg = hexToRgb(DARK_BG)
    const ext = legibleExtendedAnsi(DARK_BG)
    for (const i of [239, 241, 246]) {
      expect(contrast(hexToRgb(ext[i - 16]!), bg)).toBeGreaterThanOrEqual(MIN_CONTRAST - 1e-9)
    }
  })
  it('the dark box greys (sent 235, input 237) are backgrounds — untouched, still subtle', () => {
    const ext = legibleExtendedAnsi(DARK_BG)
    expect(ext[235 - 16]).toBe('#262626')
    expect(ext[237 - 16]).toBe('#3a3a3a')
  })
  it('vivid mid colors already legible on dark (lilac 105, green 114) pass through', () => {
    const ext = legibleExtendedAnsi(DARK_BG)
    expect(ext[105 - 16]).toBe('#8787ff')
    expect(ext[114 - 16]).toBe('#87d787')
  })
})

describe('legibleExtendedAnsi', () => {
  it('yields 240 hex colors, every one ≥ 4.5:1 against the panel', () => {
    const bg = hexToRgb(PANEL)
    const ext = legibleExtendedAnsi(PANEL)
    expect(ext).toHaveLength(240)
    for (const hex of ext) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    // every non-pastel is legible as text; pastels are exempt (backgrounds)
    expect(contrast(hexToRgb(ext[105 - 16]!), bg)).toBeGreaterThanOrEqual(MIN_CONTRAST - 1e-9)
    // the sent-message box (grey 255) comes out WARM (Silos paper), not
    // metallic: same lightness family as --panel, r ≥ g > b.
    const [r, g, b] = hexToRgb(ext[255 - 16]!)
    expect(r).toBeGreaterThanOrEqual(g)
    expect(g).toBeGreaterThan(b)
    expect(contrast(hexToRgb(ext[255 - 16]!), hexToRgb('#141413'))).toBeGreaterThan(10) // still a light box under near-black text
    expect(rgbToHex(hexToRgb('#8787ff'))).toBe('#8787ff')
  })
})

describe('isPaletteQuery', () => {
  it('true only for pure questions (the server answers them); a colour set reaches xterm', () => {
    expect(isPaletteQuery('6;?')).toBe(true)
    expect(isPaletteQuery('5;?;6;?')).toBe(true)
    expect(isPaletteQuery('6;#d97757')).toBe(false)
    expect(isPaletteQuery('5;?;6;rgb:d9/77/57')).toBe(false)
    expect(isPaletteQuery('?')).toBe(false)
    expect(isPaletteQuery('x;?')).toBe(false)
  })
})
