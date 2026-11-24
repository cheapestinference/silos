// useTaskKeys — the keyboard over a surface (lib/task-keys.ts says what each key
// is): the guard, the `g` chord, the two house-wide jumps and the cheat sheet's state.
// useListCursor — the cursor over a list, on what the list DRAWS: rows are found
// in the DOM ([data-nav-row]=<key>), so a fold, a lens, a layout or «show more» is
// what it walks without being told. The opening part of a row says
// [data-nav-open], a row's Done [data-nav-done]; a row with neither does nothing,
// so Enter can never press Allow on an approval.
//   the hover selects only after the mouse really moved (a scroll by keyboard does
//   not steal it); the ring is painted only when the keyboard put it there; the
//   cursor is a key, not an index, so it follows the logical row.
// useHeldOrder — the order under the cursor (lib/held-order.ts).
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react'
import { useStore } from '../store'
import { GAP_MS, engageHold, readHold, reconcileHeld, releaseHold, type ReconcileOpts } from '../lib/held-order'
import { CHORD_MS, cursorAfterClose, keyMayFire, readKey, stepCursor, type KeyCommand, type KeySurface } from '../lib/task-keys'

// a handler that returns false did not take the key: the browser keeps it
type Handlers = Partial<Record<KeyCommand, (e: KeyboardEvent) => boolean | void>>

export function useTaskKeys(
  surface: KeySurface,
  handlers: Handlers,
  opts: { root?: RefObject<HTMLElement | null>; enabled?: boolean } = {},
): { help: boolean; setHelp: (on: boolean) => void } {
  const [help, setHelp] = useState(false)
  const latest = useRef(handlers)
  latest.current = handlers
  const armedAt = useRef<number | null>(null)
  const enabled = opts.enabled ?? true
  const root = opts.root
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      const own = root?.current?.closest('[role="dialog"]') ?? null
      const overlays = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      if (!keyMayFire(e, overlays, own, useStore.getState().modal !== null)) return
      const armed = armedAt.current !== null && Date.now() - armedAt.current < CHORD_MS
      const { command, arm } = readKey(e.key, surface, armed)
      armedAt.current = arm ? Date.now() : null
      if (!command) return
      // a held key may walk; it never settles or opens one row after another
      if (e.repeat && command !== 'next' && command !== 'prev') return
      const st = useStore.getState()
      if (command === 'home') st.changePage(null)
      else if (command === 'tasks') st.changePage({ kind: 'tasks' })
      else if (command === 'help') setHelp(true)
      else if (latest.current[command]?.(e) === false || !latest.current[command]) return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [surface, enabled, root])
  return { help, setHelp }
}

const ROW = '[data-nav-row]'
const openOf = (row: Element): HTMLElement | null => row.querySelector<HTMLElement>('[data-nav-open]')
const isGone = (row: Element): boolean => row.hasAttribute('data-gone')

// a key press focuses the row's door, so a screen reader follows and Tab goes on
// from there; a row with no door takes the focus itself
function reveal(row: HTMLElement): void {
  const el = openOf(row) ?? row
  if (el === row) row.tabIndex = -1
  el.focus({ preventScroll: true })
  row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

export function useListCursor({
  root,
  holdId,
  order,
  enabled = true,
  onDone,
  onBack,
}: {
  root: RefObject<HTMLElement | null>
  // the list's id for its hold, and the fresh order to start holding
  holdId: string
  order: () => readonly string[]
  enabled?: boolean
  // settles a row that has no Done of its own; false: not this one
  onDone?: (key: string) => boolean
  onBack?: () => void
}): { help: boolean; setHelp: (on: boolean) => void } {
  // coming back from a task: a keyboard walk carries on where it stood
  const [restored] = useState(() => readHold(holdId, Date.now())?.cursor ?? null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const cursor = useRef<{ key: string | null; via: 'key' | 'mouse' | null; index: number; reveal: boolean }>({
    key: restored,
    via: restored ? 'key' : null,
    index: -1,
    reveal: restored !== null,
  })

  const rows = useCallback((): HTMLElement[] => [...(root.current?.querySelectorAll<HTMLElement>(ROW) ?? [])], [root])
  const paint = useCallback((): void => {
    const all = rows()
    const c = cursor.current
    let at = c.key === null ? -1 : all.findIndex((r) => r.dataset.navRow === c.key)
    // its row left the list: the cursor falls on what took its place
    if (at < 0 && c.key !== null && c.via === 'key' && c.index >= 0 && all.length > 0) {
      const live = all.filter((r) => !isGone(r))
      const next = live[Math.min(c.index, live.length - 1)]
      if (next) {
        c.key = next.dataset.navRow ?? null
        c.reveal = true
        at = all.indexOf(next)
      }
    }
    all.forEach((r, i) => {
      if (i === at && c.via === 'key') r.setAttribute('data-cursor', 'key')
      else r.removeAttribute('data-cursor')
    })
    if (at >= 0) c.index = at
    if (at >= 0 && c.reveal) {
      c.reveal = false
      reveal(all[at]!)
    }
  }, [rows])
  // every render of the host may have redrawn the rows
  useLayoutEffect(paint)

  const put = (key: string | null): void => {
    cursor.current.key = key
    cursor.current.via = key === null ? null : 'key'
    cursor.current.reveal = key !== null
    const h = engageHold(holdId, order(), Date.now())
    h.cursor = key
    h.keyboard = true
    paint()
  }
  const drawn = (): { keys: string[]; gone: Set<string> } => {
    const all = rows()
    return { keys: all.map((r) => r.dataset.navRow ?? ''), gone: new Set(all.filter(isGone).map((r) => r.dataset.navRow ?? '')) }
  }
  const move = (dir: 1 | -1): boolean => {
    const { keys, gone } = drawn()
    const next = stepCursor(keys, gone, cursor.current.key, dir)
    if (next === null) return false
    put(next)
    return true
  }
  const rowOfCursor = (): HTMLElement | null => rows().find((r) => r.dataset.navRow === cursor.current.key) ?? null

  const keys = useTaskKeys(
    'list',
    {
      next: () => move(1),
      prev: () => move(-1),
      open: (e) => {
        const row = rowOfCursor()
        const door = row ? openOf(row) : null
        // Enter on some other control (a tab, an action of the row) is that control's
        const target = e.target instanceof Element ? e.target.closest('button, a, summary, [role="button"]') : null
        if (target && target !== door) return false
        if (!door) return false
        engageHold(holdId, order(), Date.now()).keyboard = cursor.current.via === 'key'
        door.click()
        return true
      },
      done: () => {
        // only on the row the ring shows: a resting mouse settles nothing
        const c = cursor.current
        if (c.via !== 'key' || c.key === null) return false
        const row = rowOfCursor()
        if (!row || isGone(row)) return false
        const own = row.querySelector<HTMLElement>('[data-nav-done]')
        if (own) own.click()
        else if (!onDone?.(c.key)) return false
        const { keys: all, gone } = drawn()
        const after = cursorAfterClose(all, gone, c.key)
        if (after) put(after)
        return true
      },
      back: () => {
        if (cursor.current.key !== null && cursor.current.via === 'key') {
          put(null)
          releaseHold(holdId)
          redraw()
          return true
        }
        if (!onBack) return false
        onBack()
        return true
      },
    },
    { root, enabled },
  )

  // another view of the same host starts with no cursor
  const firstId = useRef(holdId)
  useEffect(() => {
    if (firstId.current === holdId) return
    firstId.current = holdId
    cursor.current = { key: null, via: null, index: -1, reveal: false }
    paint()
  }, [holdId, paint])

  useEffect(() => {
    const el = root.current
    if (!el || !enabled) return
    const onMove = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse' || (e.movementX === 0 && e.movementY === 0)) return
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>(ROW) : null
      if (!row || isGone(row) || (row.dataset.navRow === cursor.current.key && cursor.current.via === 'mouse')) return
      cursor.current = { key: row.dataset.navRow ?? null, via: 'mouse', index: -1, reveal: false }
      paint()
    }
    el.addEventListener('pointermove', onMove)
    return () => el.removeEventListener('pointermove', onMove)
  }, [root, enabled, paint])

  return keys
}

// The order to draw: the held one while a hold stands, else the fresh one as it
// is. Reads the hold on every render, so a hold engaged by a key takes effect at
// the next render of the host, and redraws by itself when a gap closes.
// `arrivingAt`: this host is that list itself. Coming back to it by mouse is the
// boundary where the fresh order returns; a keyboard walk carries on.
export function useHeldOrder(
  holdId: string | null,
  fresh: readonly string[],
  opts: Pick<ReconcileOpts, 'inScope'> & { arrivingAt?: string } = {},
): { keys: readonly string[]; gone: ReadonlySet<string>; held: boolean } {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const now = Date.now()
  useState(() => {
    if (!opts.arrivingAt) return
    const h = readHold(opts.arrivingAt, now)
    if (h && !h.keyboard) releaseHold(opts.arrivingAt)
  })
  const hold = holdId ? readHold(holdId, now) : null
  if (hold) hold.rows = reconcileHeld(hold.rows, fresh, now, { pin: hold.cursor, ...(opts.inScope ? { inScope: opts.inScope } : {}) })
  const rows = hold?.rows ?? null
  const nextClose = rows ? Math.min(Infinity, ...rows.flatMap((r) => (r.goneAt !== null && r.key !== hold?.cursor ? [r.goneAt] : []))) : Infinity
  useEffect(() => {
    if (nextClose === Infinity) return
    const t = window.setTimeout(redraw, Math.max(50, nextClose + GAP_MS - Date.now() + 20))
    return () => window.clearTimeout(t)
  }, [nextClose])
  if (!rows) return { keys: fresh, gone: NOTHING, held: false }
  return { keys: rows.map((r) => r.key), gone: new Set(rows.filter((r) => r.goneAt !== null).map((r) => r.key)), held: true }
}
const NOTHING: ReadonlySet<string> = new Set()
