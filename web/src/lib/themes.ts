// themes.ts — the LOOK of Silos as data (Settings › Appearance › Look and
// Accent). A theme is an id, a name and two maps token → value (light, dark)
// that override theme.css's custom properties and nothing else: no layout,
// no fonts (step 2). An accent overrides only the accent tokens. Everything
// here is pure and takes the list of themes/accents as an argument, so themes
// that arrive from a silo are listed, resolved and checked (theme-contrast.ts)
// by the same functions as the built-ins.
//
// A silo's theme is declared in the standard's own words (catalogs.md «Theme
// tokens»: background, panel, text…). WEB_TOKEN + siloTheme below are the ONE
// place those words become theme.css's names, and where what a silo never
// declares is derived (the shimmer, the dark console frame, the selection).
// A silo's theme never reaches fonts, layout, status colours or the ANSI
// palette: those tokens are simply not in the mapping.
import type { ThemeToken } from '../../../server/src/silos/theme-rule'

export type Mode = 'light' | 'dark'
export type TokenMap = Record<string, string>

export type Theme = { id: string; name: string; light: TokenMap; dark: TokenMap }
export type Accent = { id: string; name: string; light: TokenMap; dark: TokenMap }

export const DEFAULT_THEME_ID = 'silos'
export const OWN_ACCENT_ID = 'own'

// The tokens an accent owns. The console's selection is tinted with the
// accent too, so a chosen accent never leaves the old one behind in a pane.
export const ACCENT_TOKENS = ['--terracotta', '--terracotta-soft', '--on-terracotta', '--glow-base', '--glow-band', '--console-selection'] as const

// theme.css's own values for the tokens a swatch draws and the contrast rule
// measures — what «Silos» (no overrides) looks like. Kept equal to theme.css
// by the contrast test, which reads the stylesheet.
export const SILOS_BASE: Record<Mode, TokenMap> = {
  light: {
    '--canvas': '#faf9f5',
    '--panel': '#f0eee6',
    '--ink': '#141413',
    '--ink-2': 'rgba(20, 20, 19, 0.62)',
    '--ink-3': 'rgba(20, 20, 19, 0.45)',
    '--line': '#e8e6dd',
    '--terracotta': '#d97757',
    '--terracotta-soft': 'rgba(217, 119, 87, 0.12)',
    '--on-terracotta': '#fff',
    '--console-dark-bg': '#262624',
  },
  dark: {
    '--canvas': '#262624',
    '--panel': '#30302e',
    '--ink': '#f5f4ef',
    '--ink-2': '#cfc0ad',
    '--ink-3': '#a3968a',
    '--line': '#46453f',
    '--terracotta': '#d97757',
    '--terracotta-soft': 'rgba(217, 119, 87, 0.12)',
    '--on-terracotta': '#fff',
    '--console-dark-bg': '#262624',
  },
}

const SILOS: Theme = { id: DEFAULT_THEME_ID, name: 'Silos', light: {}, dark: {} }

// Grain — the public website's palette: a grain elevator's galvanized zinc
// and paper, bottle-green paint for the ink, and grain for what is live. In
// light the grain darkens to ochre so it can be read as small text; in dark
// the page turns bottle green and the grain shines at full strength with
// the green ink on it, like the site's buttons.
const GRAIN: Theme = {
  id: 'grain',
  name: 'Grain',
  light: {
    '--canvas': '#f4f6f4',
    '--panel': '#e2e7e4',
    '--ink': '#12362f',
    '--ink-2': '#3f5a54',
    '--ink-3': '#62786f',
    '--line': '#cbd3cf',
    '--terracotta': '#7c5000',
    '--terracotta-soft': 'rgba(232, 174, 27, 0.15)',
    '--on-terracotta': '#ffffff',
    '--glow-base': '#7c5000',
    '--glow-band': '#e8ae1b',
    '--console-dark-bg': '#12362f',
    '--console-dark-ink': '#eef3f0',
    '--console-dark-ink-2': '#9fb5ae',
    '--console-selection': 'rgba(232, 174, 27, 0.3)',
  },
  dark: {
    '--canvas': '#0f2c26',
    '--panel': '#153a32',
    '--ink': '#eef3f0',
    '--ink-2': '#b9c9c4',
    '--ink-3': '#86a199',
    '--line': '#25493f',
    '--terracotta': '#e8ae1b',
    '--terracotta-soft': 'rgba(232, 174, 27, 0.14)',
    '--on-terracotta': '#12362f',
    '--glow-base': '#e8ae1b',
    '--glow-band': '#f7dc8f',
    '--console-dark-bg': '#0f2c26',
    '--console-dark-ink': '#eef3f0',
    '--console-dark-ink-2': '#9fb5ae',
    '--console-selection': 'rgba(232, 174, 27, 0.28)',
  },
}

// Steel — cool and neutral: blue-grey surfaces with no warmth in them and a
// petrol teal for the accent, quiet enough to disappear behind the work.
const STEEL: Theme = {
  id: 'steel',
  name: 'Steel',
  light: {
    '--canvas': '#f7f8fa',
    '--panel': '#eceff3',
    '--ink': '#151a21',
    '--ink-2': '#4a5461',
    '--ink-3': '#6e7885',
    '--line': '#dde2e8',
    '--terracotta': '#0d6577',
    '--terracotta-soft': 'rgba(13, 101, 119, 0.1)',
    '--on-terracotta': '#ffffff',
    '--glow-base': '#0d6577',
    '--glow-band': 'rgba(13, 101, 119, 0.4)',
    '--console-dark-bg': '#171b21',
    '--console-dark-ink': '#e9edf2',
    '--console-dark-ink-2': '#8d97a3',
    '--console-selection': 'rgba(13, 101, 119, 0.25)',
  },
  dark: {
    '--canvas': '#15181d',
    '--panel': '#1d2128',
    '--ink': '#e9edf2',
    '--ink-2': '#aab4c0',
    '--ink-3': '#7f8a97',
    '--line': '#2d333c',
    '--terracotta': '#5cc3d6',
    '--terracotta-soft': 'rgba(92, 195, 214, 0.13)',
    '--on-terracotta': '#0b1e23',
    '--glow-base': '#5cc3d6',
    '--glow-band': '#c4eef5',
    '--console-dark-bg': '#15181d',
    '--console-dark-ink': '#e9edf2',
    '--console-dark-ink-2': '#8d97a3',
    '--console-selection': 'rgba(92, 195, 214, 0.26)',
  },
}

// Signal — high contrast, the grammar of road signs: pure white and black,
// borders you can see, and a sign's colour for the accent — blue by day,
// yellow at night with black on it.
const SIGNAL: Theme = {
  id: 'signal',
  name: 'Signal',
  light: {
    '--canvas': '#ffffff',
    '--panel': '#f0f0ee',
    '--ink': '#000000',
    '--ink-2': '#2e2e2e',
    '--ink-3': '#575757',
    '--line': '#a9a9a5',
    '--terracotta': '#0038a8',
    '--terracotta-soft': 'rgba(0, 56, 168, 0.1)',
    '--on-terracotta': '#ffffff',
    '--glow-base': '#0038a8',
    '--glow-band': 'rgba(0, 56, 168, 0.35)',
    '--console-dark-bg': '#000000',
    '--console-dark-ink': '#ffffff',
    '--console-dark-ink-2': '#b0b0b0',
    '--console-selection': 'rgba(0, 56, 168, 0.3)',
  },
  dark: {
    '--canvas': '#000000',
    '--panel': '#141414',
    '--ink': '#ffffff',
    '--ink-2': '#d6d6d6',
    '--ink-3': '#a0a0a0',
    '--line': '#5c5c5c',
    '--terracotta': '#ffd60a',
    '--terracotta-soft': 'rgba(255, 214, 10, 0.15)',
    '--on-terracotta': '#000000',
    '--glow-base': '#ffd60a',
    '--glow-band': '#fff3b0',
    '--console-dark-bg': '#000000',
    '--console-dark-ink': '#ffffff',
    '--console-dark-ink-2': '#b0b0b0',
    '--console-selection': 'rgba(255, 214, 10, 0.3)',
  },
}

export const BUILTIN_THEMES: Theme[] = [SILOS, GRAIN, STEEL, SIGNAL]

// the standard's word → the web's custom property
export const WEB_TOKEN: Record<ThemeToken, string> = {
  background: '--canvas',
  panel: '--panel',
  text: '--ink',
  'text-2': '--ink-2',
  'text-3': '--ink-3',
  border: '--line',
  accent: '--terracotta',
  'on-accent': '--on-terracotta',
  'accent-soft': '--terracotta-soft',
}

// a look from a silo is namespaced: it can never collide with a built-in
export const SILO_THEME_PREFIX = 'silo:'
export const siloThemeId = (siloId: string): string => `${SILO_THEME_PREFIX}${siloId}`
export const isSiloThemeId = (id: string): boolean => id.startsWith(SILO_THEME_PREFIX)

// what GET /api/silos carries for an active silo's look (the kernel checked
// it: well-formed, the contrast rule held in both modes, accent-soft filled)
export type SiloThemeDecl = { name: string; light: Record<string, string>; dark: Record<string, string> }

function rgbOf(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}
const alpha = (hex: string, a: number) => `rgba(${rgbOf(hex).join(', ')}, ${a})`
// the accent lifted toward white — the dark shimmer's bright band
function lift(hex: string, t: number): string {
  return `#${rgbOf(hex)
    .map((c) =>
      Math.round(c + (255 - c) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

// A silo's declared theme as a look of the web: its words mapped, the rest
// derived. Values were checked by the kernel (#rrggbb); anything else here
// is dropped, never emitted.
export function siloTheme(siloId: string, decl: SiloThemeDecl): Theme | null {
  const hex = /^#[0-9a-f]{6}$/i
  const mode = (m: Record<string, string>): TokenMap | null => {
    const out: TokenMap = {}
    for (const [word, prop] of Object.entries(WEB_TOKEN)) {
      const v = m[word]
      if (typeof v === 'string' && (hex.test(v) || (word === 'accent-soft' && /^rgba\([\d., ]+\)$/.test(v)))) out[prop] = v
    }
    return out['--canvas'] && out['--terracotta'] ? out : null
  }
  const light = mode(decl.light)
  const dark = mode(decl.dark)
  if (!light || !dark) return null
  const frame = {
    '--console-dark-bg': dark['--canvas']!,
    '--console-dark-ink': dark['--ink'] ?? '#ffffff',
    '--console-dark-ink-2': dark['--ink-2'] ?? dark['--ink'] ?? '#ffffff',
  }
  const la = light['--terracotta']!
  const da = dark['--terracotta']!
  return {
    id: siloThemeId(siloId),
    name: decl.name,
    light: {
      ...light,
      '--terracotta-soft': light['--terracotta-soft'] ?? alpha(la, 0.12),
      '--glow-base': la,
      '--glow-band': alpha(la, 0.4),
      '--console-selection': alpha(la, 0.26),
      ...frame,
    },
    dark: {
      ...dark,
      '--terracotta-soft': dark['--terracotta-soft'] ?? alpha(da, 0.12),
      '--glow-base': da,
      '--glow-band': lift(da, 0.6),
      '--console-selection': alpha(da, 0.28),
      ...frame,
    },
  }
}

// the looks the active silos bring, from GET /api/silos descriptors
export function siloThemes(silos: ReadonlyArray<{ id: string; state?: string; theme?: SiloThemeDecl | null }>): Theme[] {
  return silos.flatMap((s) => (s.state === 'active' && s.theme ? [siloTheme(s.id, s.theme)].filter((t): t is Theme => t !== null) : []))
}

// the themes offered: the built-ins first, then any that arrive (step 3);
// a later theme never shadows a built-in's id.
export function listThemes(extra: Theme[] = []): Theme[] {
  const ids = new Set(BUILTIN_THEMES.map((t) => t.id))
  return [...BUILTIN_THEMES, ...extra.filter((t) => !ids.has(t.id) && (ids.add(t.id), true))]
}

// An accent: ink-strength in light (it is read as small text on pale
// surfaces) and luminous in dark, each with the label colour it carries.
function accent(id: string, name: string, light: string, lightOn: string, dark: string, darkOn: string, darkBand: string): Accent {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')
  return {
    id,
    name,
    light: {
      '--terracotta': light,
      '--terracotta-soft': `rgba(${rgb(light)}, 0.11)`,
      '--on-terracotta': lightOn,
      '--glow-base': light,
      '--glow-band': `rgba(${rgb(light)}, 0.4)`,
      '--console-selection': `rgba(${rgb(light)}, 0.26)`,
    },
    dark: {
      '--terracotta': dark,
      '--terracotta-soft': `rgba(${rgb(dark)}, 0.13)`,
      '--on-terracotta': darkOn,
      '--glow-base': dark,
      '--glow-band': darkBand,
      '--console-selection': `rgba(${rgb(dark)}, 0.28)`,
    },
  }
}

const OWN: Accent = { id: OWN_ACCENT_ID, name: 'Theme’s own', light: {}, dark: {} }

export const BUILTIN_ACCENTS: Accent[] = [
  OWN,
  accent('clay', 'Clay', '#9c3f1c', '#ffffff', '#e8916f', '#2a1208', '#f6c9b6'),
  accent('ochre', 'Ochre', '#7c5000', '#ffffff', '#e8ae1b', '#1f1600', '#f7dc8f'),
  accent('moss', 'Moss', '#3b6a1e', '#ffffff', '#a3d16e', '#142305', '#d6efb8'),
  accent('lake', 'Lake', '#1b5ea6', '#ffffff', '#8dbdf2', '#0a1d33', '#cfe4fb'),
  accent('iris', 'Iris', '#6440bb', '#ffffff', '#b9a2f5', '#1d1238', '#e2d8fc'),
  accent('rose', 'Rose', '#a3305c', '#ffffff', '#f08fb2', '#33101e', '#f9cbdc'),
  accent('graphite', 'Graphite', '#3a3f45', '#ffffff', '#d3d8de', '#16191c', '#f2f4f6'),
]

export function listAccents(extra: Accent[] = []): Accent[] {
  const ids = new Set(BUILTIN_ACCENTS.map((a) => a.id))
  return [...BUILTIN_ACCENTS, ...extra.filter((a) => !ids.has(a.id) && (ids.add(a.id), true))]
}

export type LookPref = { theme: string; accent: string }

// the theme and accent actually in force: an id no longer offered (a theme
// removed later) falls back to the default, silently.
export function pickLook(themes: Theme[], accents: Accent[], pref: Partial<LookPref>): { theme: Theme; accent: Accent } {
  const theme = themes.find((t) => t.id === pref.theme) ?? themes.find((t) => t.id === DEFAULT_THEME_ID) ?? SILOS
  const accent = accents.find((a) => a.id === pref.accent) ?? accents.find((a) => a.id === OWN_ACCENT_ID) ?? OWN
  return { theme, accent }
}

// the overrides for one mode: the theme's tokens, then the accent's on top.
// Empty for «Silos» + «Theme's own» — theme.css exactly.
export function lookOverrides(themes: Theme[], accents: Accent[], pref: Partial<LookPref>, mode: Mode): TokenMap {
  const { theme, accent } = pickLook(themes, accents, pref)
  return { ...theme[mode], ...accent[mode] }
}

// the full token set a mode resolves to (theme.css's values under the
// overrides) — what a swatch draws and what the contrast rule measures.
export function lookTokens(themes: Theme[], accents: Accent[], pref: Partial<LookPref>, mode: Mode, base: Record<Mode, TokenMap> = SILOS_BASE): TokenMap {
  return { ...base[mode], ...lookOverrides(themes, accents, pref, mode) }
}

// the stylesheet that carries a look: one rule per mode, specific enough
// (two classes' worth) to win over theme.css's :root / .dark whatever the
// order the stylesheets load in. Values are emitted as given: a theme from
// outside is checked before it is offered, and a value with «;», «{» or «}»
// is dropped so it can never escape its declaration.
export function lookCss(themes: Theme[], accents: Accent[], pref: Partial<LookPref>): string {
  const block = (sel: string, map: TokenMap) => {
    const decls = Object.entries(map)
      .filter(([k, v]) => /^--[a-z0-9-]+$/i.test(k) && !/[;{}<>]/.test(v))
      .map(([k, v]) => `${k}: ${v};`)
    return decls.length ? `${sel} { ${decls.join(' ')} }` : ''
  }
  return [block(':root:not(.dark)', lookOverrides(themes, accents, pref, 'light')), block(':root.dark', lookOverrides(themes, accents, pref, 'dark'))]
    .filter(Boolean)
    .join('\n')
}
