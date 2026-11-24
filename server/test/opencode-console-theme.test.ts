// opencode-console-theme.test.ts — the OpenCode console follows Silos'
// light/dark: theme `system` through a Silos-owned tui.json (the operator's
// own settings kept, read-only) and the pane styled with Silos' colours.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONSOLE_COLORS,
  CONSOLE_PALETTE,
  consoleSkinFor,
  paneStyleFor,
  readOperatorTuiConfig,
  stripJsonComments,
  writeSilosTuiConfig,
} from '../src/harnesses/opencode/console-theme.js'

describe('console theme', () => {
  it("pane style = Silos' console colours per birth theme (theme.css --canvas/--ink)", () => {
    expect(paneStyleFor('light')).toBe('bg=#faf9f5,fg=#141413')
    expect(paneStyleFor('dark')).toBe('bg=#262624,fg=#f5f4ef')
    expect(CONSOLE_COLORS.dark.bg).toBe('#262624')
  })

  it('the palette Silos answers: 16 colours per theme, terracotta on the two accent slots OpenCode reads (5 secondary/Build, 6 primary)', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(CONSOLE_PALETTE[mode]).toHaveLength(16)
      for (const c of CONSOLE_PALETTE[mode]) expect(c).toMatch(/^#[0-9a-f]{6}$/)
      expect(consoleSkinFor(mode)).toEqual({ paneStyle: paneStyleFor(mode), palette: CONSOLE_PALETTE[mode] })
    }
    expect(CONSOLE_PALETTE.light[6]).toBe('#d97757') // theme.css --terracotta
    expect(CONSOLE_PALETTE.dark[5]).toBe('#d97757')
    // nothing blue on the accents (the owner's complaint: OpenCode's own #5c9cf5)
    for (const mode of ['light', 'dark'] as const)
      for (const slot of [5, 6]) {
        const h = CONSOLE_PALETTE[mode][slot]!
        expect(parseInt(h.slice(1, 3), 16)).toBeGreaterThan(parseInt(h.slice(5, 7), 16))
      }
  })

  it('stripJsonComments drops // and /* */ outside strings, never inside them', () => {
    const src = '{\n  // keybinds\n  "a": "http://x", /* x */ "b": 1\n}'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ a: 'http://x', b: 1 })
  })

  it("writeSilosTuiConfig keeps the operator's tui settings, overlays theme: system, never writes ~/.config", () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-home-'))
    const data = mkdtempSync(join(tmpdir(), 'oc-data-'))
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    const op = join(home, '.config', 'opencode', 'tui.jsonc')
    writeFileSync(op, '{ // mine\n "theme": "gruvbox", "scroll_speed": 3 }')
    const file = writeSilosTuiConfig(data, home)
    expect(file).toBe(join(data, 'opencode-tui', 'tui.json'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'system', scroll_speed: 3 })
    expect(readFileSync(op, 'utf8')).toContain('gruvbox') // untouched
  })

  it('an absent or broken operator file is {} — the console still gets theme: system', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-home-'))
    expect(readOperatorTuiConfig(home)).toEqual({})
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(join(home, '.config', 'opencode', 'tui.json'), '{ nope')
    expect(readOperatorTuiConfig(home)).toEqual({})
  })
})
