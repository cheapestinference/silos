// Dark-mode preference persisted in localStorage. ONE key, shared by the early
// bootstrap (main.tsx, before React, to avoid a flash of the wrong theme) and
// the Sidebar toggle — a single source so the two can never drift.
export const DARK_KEY = 'silos-dark'

export function readDarkPref(): '1' | '0' | null {
  try {
    const v = localStorage.getItem(DARK_KEY)
    return v === '1' ? '1' : v === '0' ? '0' : null
  } catch {
    return null // private mode / storage disabled
  }
}

export function writeDarkPref(dark: boolean): void {
  try {
    localStorage.setItem(DARK_KEY, dark ? '1' : '0')
  } catch {
    /* private mode / storage disabled — the in-memory toggle still works */
  }
}
