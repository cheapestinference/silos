// The look of Silos (lib/themes.ts) and the contrast rule it must hold
// (lib/theme-contrast.ts): every built-in theme × accent × light/dark is
// measured; a failure is a bug in the theme, never a reason to loosen it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_ACCENTS,
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  SILOS_BASE,
  WEB_TOKEN,
  listThemes,
  lookCss,
  lookOverrides,
  lookTokens,
  pickLook,
  siloTheme,
  siloThemes,
  type Mode,
  type TokenMap,
} from '../src/lib/themes'
import { checkContrast, contrastFailures, parseColor, contrastRatio, composite, CONTRAST_RULE } from '../src/lib/theme-contrast'
import * as rule from '../../server/src/silos/theme-rule'
import { LOOK_CACHE_KEY, THEME_KEY, bootThemes, readLookPref, reconcileSiloLooks, writeLookPref } from '../src/lib/look'

const MODES: Mode[] = ['light', 'dark']

// theme.css's own :root and .dark custom properties
function themeCss(): Record<Mode, TokenMap> {
  const css = readFileSync(join(__dirname, '../src/theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const block = (sel: string) => {
    const m = new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css)
    const out: TokenMap = {}
    for (const d of (m?.[1] ?? '').matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim()
    return out
  }
  const light = block(':root')
  return { light, dark: { ...light, ...block('.dark') } }
}

describe('theme contrast', () => {
  it('measures alpha composited over its surface', () => {
    const half = parseColor('rgba(0, 0, 0, 0.5)')!
    const white = parseColor('#fff')!
    expect(contrastRatio(composite(half, white), white)).toBeCloseTo(3.98, 1)
    expect(checkContrast({ '--canvas': 'color-mix(in srgb, red, blue)' }).every((c) => !c.ok)).toBe(true)
  })

  it('every built-in theme other than Silos holds the rule with every accent, light and dark', () => {
    const failures: string[] = []
    for (const theme of BUILTIN_THEMES.filter((t) => t.id !== DEFAULT_THEME_ID)) {
      for (const accent of BUILTIN_ACCENTS) {
        for (const mode of MODES) {
          for (const f of contrastFailures(lookTokens(BUILTIN_THEMES, BUILTIN_ACCENTS, { theme: theme.id, accent: accent.id }, mode))) {
            failures.push(`${theme.id}/${accent.id}/${mode}: ${f.fg} on ${f.bg} ${f.ratio.toFixed(2)} < ${f.min}`)
          }
        }
      }
    }
    expect(failures).toEqual([])
  })

  // Silos is theme.css exactly, and theme.css predates the rule: its
  // terracotta is too pale for small text and for white on it, and the light
  // --ink-3 sits at 2.96. Pinned so nothing ELSE slips; the accents laid
  // over it must clear every accent pair.
  it('Silos fails only its known pairs, and every accent over it clears the accent pairs', () => {
    const known = {
      light: ['--ink-3 on --canvas', '--terracotta on --canvas', '--terracotta on --panel', '--on-terracotta on --terracotta'],
      dark: ['--terracotta on --panel', '--on-terracotta on --terracotta'],
    }
    for (const accent of BUILTIN_ACCENTS) {
      for (const mode of MODES) {
        const got = contrastFailures(lookTokens(BUILTIN_THEMES, BUILTIN_ACCENTS, { theme: DEFAULT_THEME_ID, accent: accent.id }, mode)).map(
          (f) => `${f.fg} on ${f.bg}`,
        )
        const expected = accent.id === 'own' ? known[mode] : known[mode].filter((k) => k.startsWith('--ink'))
        expect(got, `${accent.id}/${mode}`).toEqual(expected)
      }
    }
  })

  it('SILOS_BASE is theme.css', () => {
    const css = themeCss()
    for (const mode of MODES) for (const [k, v] of Object.entries(SILOS_BASE[mode])) expect(css[mode][k], `${mode} ${k}`).toBe(v)
  })
})

describe('look resolution', () => {
  it('Silos with its own accent is no override at all; an unknown id falls back to it', () => {
    for (const mode of MODES) expect(lookOverrides(BUILTIN_THEMES, BUILTIN_ACCENTS, { theme: 'silos', accent: 'own' }, mode)).toEqual({})
    expect(lookCss(BUILTIN_THEMES, BUILTIN_ACCENTS, { theme: 'gone-theme', accent: 'gone-accent' })).toBe('')
    const { theme, accent } = pickLook(BUILTIN_THEMES, BUILTIN_ACCENTS, { theme: 'gone-theme' })
    expect([theme.id, accent.id]).toEqual(['silos', 'own'])
  })

  it('an accent wins over the theme for its tokens only, per mode', () => {
    const t = lookOverrides(BUILTIN_THEMES, BUILTIN_ACCENTS, { theme: 'grain', accent: 'lake' }, 'dark')
    expect(t['--terracotta']).toBe(BUILTIN_ACCENTS.find((a) => a.id === 'lake')!.dark['--terracotta'])
    expect(t['--canvas']).toBe(BUILTIN_THEMES.find((x) => x.id === 'grain')!.dark['--canvas'])
  })

  it('a value cannot escape its declaration', () => {
    const evil = [{ id: 'x', name: 'X', light: { '--canvas': 'red; } body { display: none' }, dark: {} }]
    expect(lookCss(evil, BUILTIN_ACCENTS, { theme: 'x' })).toBe('')
  })
})

// the look a silo brings (spec.theme) — the rule has ONE source
// (server/src/silos/theme-rule.ts), the mapping to theme.css ONE place (WEB_TOKEN)
const heather = JSON.parse(readFileSync(join(__dirname, '../../docs/standard/reference/heather.silo.json'), 'utf8'))
const schema = JSON.parse(readFileSync(join(__dirname, '../../docs/standard/silo.schema.json'), 'utf8'))
const heatherDecl = () => ({ ...rule.resolveTheme(heather.spec.theme)! })

describe('one source for the rule', () => {
  it("the web measures with the kernel's own rule and maths — not a copy", () => {
    expect(CONTRAST_RULE).toBe(rule.CONTRAST_RULE)
    expect(contrastRatio).toBe(rule.contrastRatio)
    expect(parseColor).toBe(rule.parseColor)
  })
  it("the schema's token vocabulary and colour form are the rule module's", () => {
    const mode = schema.$defs.themeMode
    expect(mode.propertyNames.enum).toEqual([...rule.THEME_TOKENS])
    expect(mode.required).toEqual([...rule.THEME_TOKENS_REQUIRED])
    expect(schema.$defs.themeColor.pattern).toBe(rule.THEME_COLOR.source)
    expect(Object.keys(WEB_TOKEN).sort()).toEqual([...rule.THEME_TOKENS].sort())
  })
})

describe("a silo's look in the web", () => {
  beforeEach(() => localStorage.clear())
  const active = [{ id: 'heather', state: 'active', theme: heatherDecl() }]

  it("maps the standard's words onto theme.css, derives the rest, and holds the same rule the kernel checked", () => {
    const t = siloTheme('heather', heatherDecl())!
    expect(t.id).toBe('silo:heather')
    expect(t.light['--canvas']).toBe('#f7f5f8')
    expect(t.dark['--terracotta-soft']).toBe('rgba(229, 154, 201, 0.12)')
    expect(t.light['--console-dark-bg']).toBe('#1c1720')
    const themes = listThemes([t])
    for (const mode of MODES) expect(contrastFailures(lookTokens(themes, BUILTIN_ACCENTS, { theme: t.id, accent: 'own' }, mode))).toEqual([])
    // never a font, a status colour or the ANSI palette
    expect(Object.keys(t.light).every((k) => !/health|font|ansi|scope/.test(k))).toBe(true)
    // a value that is not a colour is dropped, never emitted
    expect(siloTheme('x', { name: 'X', light: { ...heatherDecl().light, text: 'red; } body {' }, dark: heatherDecl().dark })!.light['--ink']).toBeUndefined()
  })

  it('only active silos offer their look, namespaced so it cannot shadow a built-in', () => {
    expect(siloThemes([{ id: 'heather', state: 'pending', theme: heatherDecl() }])).toEqual([])
    expect(siloThemes([{ id: 'silos', state: 'active', theme: heatherDecl() }]).map((t) => t.id)).toEqual(['silo:silos'])
  })

  it('a chosen silo look paints the first frame from its cache; gone, it falls back to the default and the cache goes', () => {
    const themes = listThemes(siloThemes(active))
    writeLookPref({ theme: 'silo:heather', accent: 'own' }, themes)
    // the bootstrap cannot fetch: the cache alone resolves it
    expect(readLookPref(bootThemes()).theme).toBe('silo:heather')
    // the silo still brings it: kept
    reconcileSiloLooks(active)
    expect(localStorage.getItem(LOOK_CACHE_KEY)).not.toBeNull()
    // uninstalled (or its theme removed): silently the default, at once and at the next boot
    reconcileSiloLooks([])
    expect(localStorage.getItem(LOOK_CACHE_KEY)).toBeNull()
    expect(readLookPref(bootThemes()).theme).toBe(DEFAULT_THEME_ID)
    expect(localStorage.getItem(THEME_KEY)).toBe('silo:heather')
    // choosing a built-in clears the cache
    writeLookPref({ theme: 'silo:heather', accent: 'own' }, themes)
    writeLookPref({ theme: 'grain', accent: 'own' }, themes)
    expect(localStorage.getItem(LOOK_CACHE_KEY)).toBeNull()
  })
})
