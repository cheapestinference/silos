// harnesses/opencode/console-theme.ts — the OpenCode console follows Silos'
// theme the way the Claude console does (one dark and one light,
// matching Claude Code; no stray blue that doesn't look like Silos).
//
// Verified on 1.19.4 + tmux 3.4 (throwaway TUIs on a private tmux):
//   · OPENCODE_TUI_CONFIG=<file> is read per process (a `theme` there wins —
//     gruvbox applied); the operator's ~/.config/opencode is never written.
//   · The built-in `system` theme derives EVERYTHING from the terminal: the
//     background (OSC 11 — inside tmux, the pane's `window-style`; its panel
//     greys are generated from it) and the 16 ANSI colours (OSC 4: primary,
//     accent and info = cyan, secondary — the Build agent and the prompt bar
//     — = magenta, success/warning/error = green/yellow/red, links = blue).
//   · If the palette question goes unanswered, `system` silently falls back
//     to OpenCode's own theme — the blue the owner saw. Inside tmux < 3.6 it
//     is asked through DCS passthrough, so the pane gets allow-passthrough
//     and Silos answers it itself (console-palette.ts) with CONSOLE_PALETTE.
//   · COLORTERM=truecolor + the RGB terminal feature (xterm.js renders
//     24-bit) let the exact colours through; without them tmux rounds Silos'
//     terracotta to the 256-colour cube's pink 167.
// Choice (prefs.consoleTheme.opencode): 'silos' (default) = the above;
// 'own' = OpenCode's own theme and the operator's /theme picks, untouched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { declareDataDirEntry } from '../../seal-regimes.js'

export type ConsoleThemeMode = 'light' | 'dark'
export type OpencodeConsoleTheme = 'silos' | 'own'

/** Silos' console colours (web/src/theme.css --canvas/--ink, the same the
 *  xterm paints): the pane's window-style, which OpenCode reads as "the
 *  terminal background". */
export const CONSOLE_COLORS: Record<ConsoleThemeMode, { bg: string; fg: string }> = {
  light: { bg: '#faf9f5', fg: '#141413' },
  dark: { bg: '#262624', fg: '#f5f4ef' },
}

export function paneStyleFor(mode: ConsoleThemeMode): string {
  const c = CONSOLE_COLORS[mode]
  return `bg=${c.bg},fg=${c.fg}`
}

/** The 16 ANSI colours Silos reports to an OpenCode console (ANSI slot
 *  order). Silos' own terminal palette (web TerminalPanel ANSI_LIGHT /
 *  ANSI_DARK) — except the two slots OpenCode's `system` theme reads as its
 *  accents, which carry Silos' terracotta (theme.css --terracotta) in the
 *  shades Silos already uses on that background: magenta (5) = secondary,
 *  the Build agent and the prompt bar; cyan (6) = primary/accent/info. */
export const CONSOLE_PALETTE: Record<ConsoleThemeMode, readonly string[]> = {
  light: [
    '#141413',
    '#b3543d',
    '#6b8f5a',
    '#a8823a',
    '#4d6f99',
    '#c56a4f',
    '#d97757',
    '#e8e6dd',
    '#8a887f',
    '#c56a4f',
    '#7fa06d',
    '#bd9750',
    '#6486ad',
    '#b57aa3',
    '#5fa19c',
    '#141413',
  ],
  dark: [
    '#f5f4ef',
    '#d99a6c',
    '#9bc48a',
    '#d0b273',
    '#8fb0d6',
    '#d97757',
    '#e3ac85',
    '#46453f',
    '#a8a69d',
    '#e3ac85',
    '#add99e',
    '#ddc38f',
    '#a5c3e2',
    '#d8abcb',
    '#a8d9d4',
    '#f5f4ef',
  ],
}

/** How a console that follows Silos is dressed: the pane's colours (the
 *  background OpenCode reads) and the palette Silos answers it with. */
export interface ConsoleSkin {
  paneStyle: string
  palette: readonly string[]
}

export function consoleSkinFor(mode: ConsoleThemeMode): ConsoleSkin {
  return { paneStyle: paneStyleFor(mode), palette: CONSOLE_PALETTE[mode] }
}

/** `// …` and `/* … *\/` stripped outside strings — enough to read a tui.jsonc. */
export function stripJsonComments(text: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inStr) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += c
  }
  return out
}

/** The operator's own tui.json(c) (keybinds, scroll…), read-only; {} when
 *  absent or unreadable — Silos only ever overlays the theme on it. */
export function readOperatorTuiConfig(home: string): Record<string, unknown> {
  for (const name of ['tui.json', 'tui.jsonc']) {
    const file = join(home, '.config', 'opencode', name)
    if (!existsSync(file)) continue
    try {
      const v = JSON.parse(stripJsonComments(readFileSync(file, 'utf8'))) as unknown
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {}
}

// its data-dir entry, declared for the seal's regime table (seal-regimes.ts):
// Silos writes it at each launch, from the
// operator's own tui settings — not a control file, outside the seal
declareDataDirEntry('opencode-tui', { regime: 'out-of-seal', why: "Silos' tui config for this engine, rewritten at every launch", specNamed: false })

/** Writes Silos' tui config (the operator's settings + `theme: system`) under
 *  the data dir and returns its path, for OPENCODE_TUI_CONFIG. */
export function writeSilosTuiConfig(dataDir: string, home: string): string {
  const dir = join(dataDir, 'opencode-tui')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'tui.json')
  const config = { ...readOperatorTuiConfig(home), theme: 'system' }
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o644 })
  return file
}
