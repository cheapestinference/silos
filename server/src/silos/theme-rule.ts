// silos/theme-rule.ts — the ONE source of a look's vocabulary and its
// contrast rule (Silo Standard: catalogs.md «Theme tokens», conformance §12).
// The kernel checks a silo's spec.theme with it at validation, and the web
// (web/src/lib/theme-contrast.ts re-exports it) measures its built-in themes
// with the same function — the thresholds and the maths exist here only.
// Pure, no imports: both toolchains (NodeNext here, Vite there) read it as is.
//
// The rule (WCAG 2.x relative-luminance ratios), for light and for dark:
//   text     on background and on panel     ≥ 7    (body text)
//   text-2   on background and on panel     ≥ 4.5  (secondary text)
//   text-3   on background                  ≥ 3    (hints, timestamps)
//   accent as text on background and panel  ≥ 4.5  (links, counts, the live line)
//   on-accent on accent                     ≥ 4.5  (a solid button's label)
// A colour with alpha (the web's built-ins use some; a manifest cannot) is
// composited over what it sits on before measuring: panel and accent over
// background, inks over the surface they are read on. background itself must
// be opaque. A value this module cannot read is a failure, never a pass.

// The closed vocabulary a silo's theme declares (the standard's words, never
// the web's internal names). accent-soft is optional: absent, it is derived.
export const THEME_TOKENS_REQUIRED = ['background', 'panel', 'text', 'text-2', 'text-3', 'border', 'accent', 'on-accent'] as const
export const THEME_TOKENS_OPTIONAL = ['accent-soft'] as const
export const THEME_TOKENS = [...THEME_TOKENS_REQUIRED, ...THEME_TOKENS_OPTIONAL] as const
export type ThemeToken = (typeof THEME_TOKENS)[number]
export type ThemeMode = 'light' | 'dark'
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark']
// a manifest's colour: #rrggbb, nothing else (no alpha, names or functions)
export const THEME_COLOR = /^#[0-9a-fA-F]{6}$/

// the soft accent a theme gets when it declares none — the accent at the
// strength the built-ins' soft accents carry (0.10–0.15)
export const ACCENT_SOFT_ALPHA = 0.12
export function accentSoftOf(accent: string): string {
  const c = parseColor(accent)
  if (!c) return accent
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${ACCENT_SOFT_ALPHA})`
}

export const CONTRAST_RULE: ReadonlyArray<{ fg: ThemeToken; bg: 'background' | 'panel' | 'accent'; min: number }> = [
  { fg: 'text', bg: 'background', min: 7 },
  { fg: 'text', bg: 'panel', min: 7 },
  { fg: 'text-2', bg: 'background', min: 4.5 },
  { fg: 'text-2', bg: 'panel', min: 4.5 },
  { fg: 'text-3', bg: 'background', min: 3 },
  { fg: 'accent', bg: 'background', min: 4.5 },
  { fg: 'accent', bg: 'panel', min: 4.5 },
  { fg: 'on-accent', bg: 'accent', min: 4.5 },
]

export type Rgba = { r: number; g: number; b: number; a: number }

export function parseColor(value: string | undefined): Rgba | null {
  if (!value) return null
  const v = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)
  if (hex) {
    const h = hex[1] ?? ''
    if (h.length === 3 || h.length === 4) {
      const n = (i: number) => parseInt(h.charAt(i) + h.charAt(i), 16)
      return { r: n(0), g: n(1), b: n(2), a: h.length === 4 ? n(3) / 255 : 1 }
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
    }
    return null
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v)
  if (fn) {
    const [r, g, b] = [Number(fn[1]), Number(fn[2]), Number(fn[3])]
    let a = 1
    if (fn[4] !== undefined) a = fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : Number(fn[4])
    if ([r, g, b, a].some((x) => !Number.isFinite(x)) || r > 255 || g > 255 || b > 255 || a < 0 || a > 1) return null
    return { r, g, b, a }
  }
  if (v === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  return null
}

// fg painted over an opaque bg
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }
}

function channel(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// a ratio as words say it: floored to two decimals, so 4.499 never reads «4.50»
export function sayRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`
}

export type ContrastCheck = { fg: string; bg: string; ratio: number; min: number; ok: boolean }

// Every pair of the rule, measured on a full set of tokens. `key` names, for
// each word of the vocabulary, the key it has in `tokens` (identity for a
// manifest; the web passes its own custom-property names) — and the result
// reports pairs by those keys.
export function checkContrast(tokens: Record<string, string | undefined>, key: (t: ThemeToken) => string = (t) => t): ContrastCheck[] {
  const background = parseColor(tokens[key('background')])
  const opaque = background && background.a === 1 ? background : null
  const surface = (t: ThemeToken): Rgba | null => {
    if (!opaque) return null
    if (t === 'background') return opaque
    const c = parseColor(tokens[key(t)])
    return c ? composite(c, opaque) : null
  }
  return CONTRAST_RULE.map(({ fg, bg, min }) => {
    const under = surface(bg)
    const ink = parseColor(tokens[key(fg)])
    const ratio = under && ink ? contrastRatio(composite(ink, under), under) : 0
    return { fg: key(fg), bg: key(bg), ratio, min, ok: ratio >= min }
  })
}

export function contrastFailures(tokens: Record<string, string | undefined>, key?: (t: ThemeToken) => string): ContrastCheck[] {
  return checkContrast(tokens, key).filter((c) => !c.ok)
}

// A declared theme (spec.theme) resolved: every token of the vocabulary,
// accent-soft derived when absent. null when the shape is not a theme's (the
// schema refuses it first; the registry re-checks a file it reads off disk).
export interface ResolvedTheme {
  name: string
  light: Record<ThemeToken, string>
  dark: Record<ThemeToken, string>
}

export function resolveTheme(raw: unknown): ResolvedTheme | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const t = raw as Record<string, unknown>
  if (typeof t.name !== 'string' || t.name.trim() === '') return null
  const mode = (m: unknown): Record<ThemeToken, string> | null => {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return null
    const src = m as Record<string, unknown>
    if (Object.keys(src).some((k) => !(THEME_TOKENS as readonly string[]).includes(k))) return null
    const out: Partial<Record<ThemeToken, string>> = {}
    for (const k of THEME_TOKENS_REQUIRED) {
      const v = src[k]
      if (typeof v !== 'string' || !THEME_COLOR.test(v)) return null
      out[k] = v.toLowerCase()
    }
    const soft = src['accent-soft']
    if (soft !== undefined && (typeof soft !== 'string' || !THEME_COLOR.test(soft))) return null
    out['accent-soft'] = typeof soft === 'string' ? soft.toLowerCase() : accentSoftOf(out.accent!)
    return out as Record<ThemeToken, string>
  }
  const light = mode(t.light)
  const dark = mode(t.dark)
  return light && dark ? { name: t.name, light, dark } : null
}

// The pairs of a resolved theme that fail, per mode — what check 12 says.
export function themeFailures(theme: ResolvedTheme): Array<ContrastCheck & { mode: ThemeMode }> {
  return THEME_MODES.flatMap((mode) => contrastFailures(theme[mode]).map((f) => ({ ...f, mode })))
}

// The pair closest to its minimum, per mode — what silo-check prints so an
// author sees how much room the look has.
export function closestPair(theme: ResolvedTheme, mode: ThemeMode): ContrastCheck {
  return checkContrast(theme[mode]).reduce((a, b) => (b.ratio / b.min < a.ratio / a.min ? b : a))
}

// A theme the kernel offers: well-formed AND holding the rule in both modes.
export function offerableTheme(raw: unknown): ResolvedTheme | null {
  const t = resolveTheme(raw)
  return t && themeFailures(t).length === 0 ? t : null
}
