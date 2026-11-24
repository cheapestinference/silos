// task-keys.ts — the mail-client keyboard of Tasks, the Needs you sheet and a
// task's page. Only what maps to a verb that
// already exists; no archive, no «new task». Pure: which
// command a key is, whether a key may fire at all, where the cursor goes.

export type KeySurface = 'list' | 'page'
export type KeyCommand = 'next' | 'prev' | 'open' | 'back' | 'done' | 'note' | 'home' | 'tasks' | 'help'

const LIST: Readonly<Record<string, KeyCommand>> = {
  j: 'next',
  ArrowDown: 'next',
  k: 'prev',
  ArrowUp: 'prev',
  Enter: 'open',
  o: 'open',
  Escape: 'back',
  d: 'done',
  '?': 'help',
}
// on a page the arrows keep scrolling it
const PAGE: Readonly<Record<string, KeyCommand>> = {
  j: 'next',
  ']': 'next',
  k: 'prev',
  '[': 'prev',
  Escape: 'back',
  d: 'done',
  n: 'note',
  '?': 'help',
}
const AFTER_G: Readonly<Record<string, KeyCommand>> = { h: 'home', t: 'tasks' }

// `armed`: a `g` was just pressed. What comes back says which command this key is,
// and whether it arms the next one.
export function readKey(key: string, surface: KeySurface, armed: boolean): { command: KeyCommand | null; arm: boolean } {
  if (armed && AFTER_G[key]) return { command: AFTER_G[key]!, arm: false }
  if (key === 'g') return { command: null, arm: true }
  const map = surface === 'list' ? LIST : PAGE
  return { command: Object.hasOwn(map, key) ? map[key]! : null, arm: false }
}

export const CHORD_MS = 1_200

// typing, or inside a console: never ours
const TYPING = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], .xterm'
export function isTypingTarget(el: Element | null): boolean {
  return el?.closest(TYPING) != null
}

export interface KeyEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  isComposing?: boolean
  target: EventTarget | null
}

// Whether this keydown may be read at all. `overlays`: the dialogs open now, and
// `own`: the one this surface lives in, if any (the sheet): any other is on top.
export function keyMayFire(e: KeyEventLike, overlays: ReadonlyArray<Element>, own: Element | null, modalOpen: boolean): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false
  if (isTypingTarget(e.target instanceof Element ? e.target : null)) return false
  if (modalOpen) return false
  return overlays.every((o) => o === own)
}

// The next row a step lands on, in the order drawn. A row in its gap is walked
// past; from no cursor both directions start at the top; the ends stay put.
export function stepCursor(keys: readonly string[], gone: ReadonlySet<string>, current: string | null, dir: 1 | -1): string | null {
  const at = current === null ? -1 : keys.indexOf(current)
  if (at < 0) return keys.find((k) => !gone.has(k)) ?? null
  for (let i = at + dir; i >= 0 && i < keys.length; i += dir) if (!gone.has(keys[i]!)) return keys[i]!
  return current
}

// Where the cursor goes when its row closed: the row below, or above at the end.
export function cursorAfterClose(keys: readonly string[], gone: ReadonlySet<string>, current: string): string | null {
  const at = keys.indexOf(current)
  if (at < 0) return null
  for (let i = at + 1; i < keys.length; i++) if (!gone.has(keys[i]!)) return keys[i]!
  for (let i = at - 1; i >= 0; i--) if (!gone.has(keys[i]!)) return keys[i]!
  return null
}
