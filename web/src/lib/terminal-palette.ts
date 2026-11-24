// terminal-palette.ts — the 256-color cube, made legible on a LIGHT background.
//
// Claude Code (and most TUIs) don't only use the 16 ANSI slots we theme in
// TerminalPanel.tsx: inside tmux they downsample their colors to the xterm
// 256-color cube (indices 16–255) — e.g. the lilac 105 (#8787ff) for links
// and bright yellows for warnings like "% usage". Those were tuned for a
// dark terminal; on Silos' cream --panel they wash out (light blues and
// loud yellows you can't read).
//
// Rather than hunt indices one by one, remap the WHOLE cube: keep each
// color's hue and saturation, lower its lightness until it reaches a
// minimum WCAG contrast against the background. Colors already dark enough
// pass through untouched. The result feeds xterm's `theme.extendedAnsi`.

export const MIN_CONTRAST = 4.5 // WCAG AA for normal text

// Colors LIGHTER than this (HSL lightness) are left untouched: in a light
// TUI they are backgrounds, not text — claude paints the sent-message box
// with the near-white grey 255 (48;5;255) and diffs with pastel green/red.
// Darkening those turned the box black behind black text.
// xterm has ONE table for fg and bg, so this heuristic is the split: mid
// and vivid colors (lilac 105, loud yellows) are text and get darkened;
// near-white pastels are boxes and stay.
export const BG_LIGHTNESS = 0.85

// The DARK mirror of BG_LIGHTNESS: on a dark console, colors DARKER than
// this are box/background duty (claude dark paints its input box with
// 48;5;237 l≈0.23 and the sent box with 235) and stay subtle; anything
// above is text and gets LIGHTENED to contrast — the murky spinner grey
// 241 and the caret 239 ("✻ Crunched" unreadable on charcoal).
export const BG_DARKNESS = 0.25

type RGB = [number, number, number]

// the standard xterm 256-color table (16–255): a 6×6×6 cube + 24 greys.
export function xterm256(i: number): RGB {
  if (i < 16 || i > 255) throw new Error(`index ${i} is outside the extended range 16–255`)
  if (i >= 232) {
    const v = 8 + (i - 232) * 10
    return [v, v, v]
  }
  const n = i - 16
  const levels = [0, 95, 135, 175, 215, 255] as const
  return [levels[Math.floor(n / 36)]!, levels[Math.floor(n / 6) % 6]!, levels[n % 6]!]
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export function rgbToHex([r, g, b]: RGB): string {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a),
    lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const R = r / 255,
    G = g / 255,
    B = b / 255
  const max = Math.max(R, G, B),
    min = Math.min(R, G, B),
    l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  h /= 6
  return [h, s, l]
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
    p = 2 * l - q
  const f = (t: number) => {
    t = (t + 1) % 1
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

// Move `color` (same hue/saturation) just enough to reach `min` contrast
// against `bg` — DARKEN on a light background, LIGHTEN on a dark one.
// Colors that already pass, and colors on background duty (near-white
// pastels on light, near-black greys on dark), come back unchanged.
export function ensureContrast(color: RGB, bg: RGB, min = MIN_CONTRAST): RGB {
  if (contrast(color, bg) >= min) return color
  const darkBg = luminance(bg) < 0.5
  const [h, s, l0] = rgbToHsl(color)
  if (!darkBg && l0 > BG_LIGHTNESS) return color // a pastel: background duty, never darken
  if (darkBg && l0 < BG_DARKNESS) return color // a dark box grey: background duty, never lighten
  // bisect the lightness: contrast grows monotonically as lightness moves
  // away from the background, so the first L that passes is the least change.
  // (checked on the ROUNDED color — the 8-bit value is what gets painted)
  const at = (l: number): RGB => hslToRgb([h, s, l]).map(Math.round) as RGB
  let lo = darkBg ? l0 : 0,
    hi = darkBg ? 1 : l0
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const passes = contrast(at(mid), bg) >= min
    if (darkBg) {
      if (passes) hi = mid
      else lo = mid
    } else {
      if (passes) lo = mid
      else hi = mid
    }
  }
  return at(darkBg ? hi : lo)
}

// Grey pastels (the sent-message box is grey 255) read as METALLIC against
// Silos' warm paper (it should match the theme, like the menu background).
// Keep each grey's lightness but adopt the hue/saturation
// of the page background, so the box lands on the same warm family as
// --panel/--canvas. Chromatic pastels (diff green/red) keep their own hue.
export function warmGreyPastel(color: RGB, bg: RGB): RGB {
  const [, sat, l] = rgbToHsl(color)
  if (sat >= 0.15) return color // chromatic pastel — leave its hue alone
  const [bh, bs] = rgbToHsl(bg)
  return hslToRgb([bh, bs, l]).map(Math.round) as RGB
}

// xterm `theme.extendedAnsi`: 240 hex colors for indices 16–255. Works for
// both directions: darkens on a light background, lightens on a dark one.
export function legibleExtendedAnsi(bgHex: string, min = MIN_CONTRAST): string[] {
  const bg = hexToRgb(bgHex)
  const lightBg = luminance(bg) >= 0.5
  const out: string[] = []
  for (let i = 16; i <= 255; i++) {
    const c = xterm256(i)
    const legible = ensureContrast(c, bg, min)
    // Light bg only: untouched by the contrast pass AND still low-contrast
    // ⇒ a pastel exempted as background duty — warm it to Silos' paper.
    // Dark bg: exempted dark greys are claude's own subtle boxes on an
    // already-warm charcoal — they stay exactly as painted.
    out.push(rgbToHex(lightBg && legible === c && contrast(c, bg) < min ? warmGreyPastel(c, bg) : legible))
  }
  return out
}

// OSC 4 payload (`n;spec[;n;spec…]`) that only ASKS for colours (`spec` =
// `?`) — the console swallows those (the server answers them); anything
// that sets a colour returns false and reaches xterm's own handler.
export function isPaletteQuery(data: string): boolean {
  const parts = data.split(';')
  if (parts.length < 2 || parts.length % 2 !== 0) return false
  return parts.every((p, i) => (i % 2 === 0 ? /^\d+$/.test(p) : p === '?'))
}
