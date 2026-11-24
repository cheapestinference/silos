// look.ts — the chosen look (theme + accent) kept per browser, the same way
// as light/dark (dark-mode.ts): two localStorage keys beside `silos-dark`,
// read and applied by the early bootstrap in main.tsx before React mounts, so
// the first paint is already themed. No server state.
//
// Applying a look = one <style id="silos-look"> carrying the overrides for
// both modes (themes.ts lookCss), so flipping light/dark needs no re-apply;
// the browser chrome (theme-color) and the favicon follow the resolved
// --canvas / --terracotta, and are re-synced whenever <html>'s class changes.
//
// A look that comes from a silo (themes.ts siloTheme) is only known once
// GET /api/silos answers — too late for the first paint. So choosing one also
// caches its resolved tokens (`silos-look-cache`): the bootstrap paints from
// the cache, and reconcileSiloLooks() settles it against the descriptors —
// refreshed when the silo still brings it, dropped (back to the default,
// silently) when the silo is gone or its theme with it.
import { useCallback, useSyncExternalStore } from 'react'
import {
  BUILTIN_ACCENTS,
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  OWN_ACCENT_ID,
  isSiloThemeId,
  listThemes,
  lookCss,
  pickLook,
  siloThemes,
  type Accent,
  type LookPref,
  type SiloThemeDecl,
  type Theme,
  type TokenMap,
} from './themes'

export const THEME_KEY = 'silos-theme'
export const ACCENT_KEY = 'silos-accent'
export const LOOK_CACHE_KEY = 'silos-look-cache'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // private mode / storage disabled
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode / storage disabled — the in-memory choice still applies */
  }
}

const isMap = (v: unknown): v is TokenMap => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')

// the silo look cached for the first paint — at most one, and only a silo's
export function cachedThemes(): Theme[] {
  const raw = read(LOOK_CACHE_KEY)
  if (!raw) return []
  try {
    const t = JSON.parse(raw) as Partial<Theme>
    if (typeof t.id === 'string' && isSiloThemeId(t.id) && typeof t.name === 'string' && isMap(t.light) && isMap(t.dark)) return [t as Theme]
  } catch {
    /* a broken cache paints nothing */
  }
  return []
}

// what the bootstrap can offer before /api/silos: the built-ins + the cache
export function bootThemes(): Theme[] {
  return listThemes(cachedThemes())
}

// the stored choice, resolved against what is offered: an unknown id falls
// back to the default silently.
export function readLookPref(themes: Theme[] = bootThemes(), accents: Accent[] = BUILTIN_ACCENTS): LookPref {
  const { theme, accent } = pickLook(themes, accents, { theme: read(THEME_KEY) ?? DEFAULT_THEME_ID, accent: read(ACCENT_KEY) ?? OWN_ACCENT_ID })
  return { theme: theme.id, accent: accent.id }
}

// keeps the choice; a silo look also keeps its resolved tokens for the next
// first paint, a built-in clears that cache
export function writeLookPref(pref: LookPref, themes: Theme[] = BUILTIN_THEMES): void {
  write(THEME_KEY, pref.theme)
  write(ACCENT_KEY, pref.accent)
  if (!isSiloThemeId(pref.theme)) {
    write(LOOK_CACHE_KEY, null)
    return
  }
  // a silo look not offered yet (the silos have not answered): the cache stays
  const t = themes.find((x) => x.id === pref.theme)
  if (t) write(LOOK_CACHE_KEY, JSON.stringify(t))
}

const STYLE_ID = 'silos-look'
const FAVICON_PATH = 'M12 3.8 A26 26 0 0 1 2.5 20.25 A26 26 0 0 1 21.5 20.25 A26 26 0 0 1 12 3.8 Z'
const FAVICON_DEFAULT = '#d97757'

function syncChrome(): void {
  const css = getComputedStyle(document.documentElement)
  const canvas = css.getPropertyValue('--canvas').trim()
  if (canvas) {
    // the page in force, whichever mode the system prefers: both tags
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = canvas
  }
  const accent = css.getPropertyValue('--terracotta').trim()
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!icon || !accent) return
  const href =
    accent.toLowerCase() === FAVICON_DEFAULT
      ? '/favicon.svg'
      : `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${accent}" d="${FAVICON_PATH}"/></svg>`)}`
  if (icon.getAttribute('href') !== href) icon.setAttribute('href', href)
}

let watching = false

export function applyLook(pref: LookPref, themes: Theme[] = bootThemes(), accents: Accent[] = BUILTIN_ACCENTS): void {
  if (typeof document === 'undefined') return
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = lookCss(themes, accents, pref)
  syncChrome()
  if (!watching && typeof MutationObserver !== 'undefined') {
    watching = true
    new MutationObserver(syncChrome).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
}

// every useLook in the page sees a choice made anywhere (Appearance, a
// silo's «Use this look»)
const listeners = new Set<() => void>()
let version = 0
function changed(): void {
  version++
  for (const l of listeners) l()
}
function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

// After GET /api/silos: the looks the active silos bring are now known.
// A chosen silo look still brought is re-cached (an update may have changed
// its colours) and re-applied; one no longer brought falls back to the
// default — the cache goes, the stored id is left (it resolves to the
// default everywhere, and comes back if the silo is reinstalled).
export function reconcileSiloLooks(silos: ReadonlyArray<{ id: string; state?: string; theme?: SiloThemeDecl | null }>): void {
  const themes = listThemes(siloThemes(silos))
  const stored = read(THEME_KEY)
  if (!stored || !isSiloThemeId(stored)) return
  const t = themes.find((x) => x.id === stored)
  const cached = read(LOOK_CACHE_KEY)
  const next = t ? JSON.stringify(t) : null
  if (cached === next) return
  write(LOOK_CACHE_KEY, next)
  applyLook(readLookPref(themes), themes)
  changed()
}

// Settings › Appearance and a silo's page: the choice in force (resolved
// against `themes`) and a setter that applies and keeps it.
export function useLook(themes: Theme[] = BUILTIN_THEMES, accents: Accent[] = BUILTIN_ACCENTS): [LookPref, (next: Partial<LookPref>) => void] {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  )
  const pref = readLookPref(themes, accents)
  const choose = useCallback(
    (next: Partial<LookPref>) => {
      // the STORED theme, not the resolved one: choosing an accent before the
      // silos have answered must not overwrite a silo look with the default
      const merged = { theme: next.theme ?? read(THEME_KEY) ?? DEFAULT_THEME_ID, accent: next.accent ?? read(ACCENT_KEY) ?? OWN_ACCENT_ID }
      writeLookPref(merged, themes)
      applyLook(merged, themes, accents)
      changed()
    },
    [themes, accents],
  )
  return [pref, choose]
}
