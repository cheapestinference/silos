// The keyboard's logic: which command a key is, when a key may not fire (typing,
// a console, something on top), where the cursor lands, and the held order.
import { beforeEach, describe, expect, it } from 'vitest'
import { cursorAfterClose, isTypingTarget, keyMayFire, readKey, stepCursor } from '../src/lib/task-keys'
import {
  GAP_MS,
  HOLD_IDLE_MS,
  engageHold,
  holdIdOfOrigin,
  readHold,
  reconcileHeld,
  releaseHold,
  resetHolds,
  tasksHoldId,
  type HeldRow,
} from '../src/lib/held-order'

const held = (...keys: string[]): HeldRow[] => keys.map((key) => ({ key, goneAt: null }))
const keysOf = (rows: readonly HeldRow[]): string[] => rows.map((r) => r.key)

describe('readKey', () => {
  it('a list moves with j/k and the arrows, opens with Enter and o', () => {
    for (const [k, c] of [
      ['j', 'next'],
      ['ArrowDown', 'next'],
      ['k', 'prev'],
      ['ArrowUp', 'prev'],
      ['Enter', 'open'],
      ['o', 'open'],
      ['d', 'done'],
      ['Escape', 'back'],
      ['?', 'help'],
    ] as const) {
      expect(readKey(k, 'list', false).command).toBe(c)
    }
  })
  it('a page leaves its arrows to scrolling, walks with [ ], and writes a note with n', () => {
    expect(readKey('ArrowDown', 'page', false).command).toBeNull()
    expect(readKey('Enter', 'page', false).command).toBeNull()
    expect(readKey('[', 'page', false).command).toBe('prev')
    expect(readKey(']', 'page', false).command).toBe('next')
    expect(readKey('n', 'page', false).command).toBe('note')
    expect(readKey('n', 'list', false).command).toBeNull()
  })
  it('g arms, h and t land; anything else disarms', () => {
    expect(readKey('g', 'list', false)).toEqual({ command: null, arm: true })
    expect(readKey('h', 'list', true).command).toBe('home')
    expect(readKey('t', 'page', true).command).toBe('tasks')
    expect(readKey('h', 'list', false).command).toBeNull()
    expect(readKey('x', 'list', true)).toEqual({ command: null, arm: false })
  })
  it('an object prototype name is no command', () => {
    expect(readKey('constructor', 'list', false).command).toBeNull()
  })
})

describe('keyMayFire: never while typing, in a console, or under something', () => {
  const el = (html: string, pick = '*'): Element => {
    const host = document.createElement('div')
    host.innerHTML = html
    return host.querySelector(pick)!
  }
  const event = (target: Element | null, over: Partial<KeyboardEvent> = {}) => ({
    key: 'j',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target,
    ...over,
  })
  const body = el('<button></button>')

  it.each([
    ['an input', '<input />', 'input'],
    ['a textarea', '<textarea></textarea>', 'textarea'],
    ['a select', '<select></select>', 'select'],
    ['an editable', '<div contenteditable="true"><p>x</p></div>', 'p'],
    ['a console', '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>', 'textarea'],
    ['inside a console, not its textarea', '<div class="xterm"><canvas></canvas></div>', 'canvas'],
  ])('%s', (_n, html, pick) => {
    expect(isTypingTarget(el(html, pick))).toBe(true)
    expect(keyMayFire(event(el(html, pick)), [], null, false)).toBe(false)
  })
  it('a row or the page body may', () => {
    expect(keyMayFire(event(body), [], null, false)).toBe(true)
  })
  it('a modifier, a key already taken, or a composition may not', () => {
    expect(keyMayFire(event(body, { metaKey: true }), [], null, false)).toBe(false)
    expect(keyMayFire(event(body, { ctrlKey: true }), [], null, false)).toBe(false)
    expect(keyMayFire(event(body, { defaultPrevented: true }), [], null, false)).toBe(false)
    expect(keyMayFire(event(body, { isComposing: true }), [], null, false)).toBe(false)
  })
  it('its own dialog does not block it; another dialog or the modal slot does', () => {
    const sheet = el('<div role="dialog"></div>')
    const other = el('<div role="dialog"></div>')
    expect(keyMayFire(event(body), [sheet], sheet, false)).toBe(true)
    expect(keyMayFire(event(body), [sheet, other], sheet, false)).toBe(false)
    expect(keyMayFire(event(body), [other], null, false)).toBe(false)
    expect(keyMayFire(event(body), [], null, true)).toBe(false)
  })
})

describe('stepCursor', () => {
  const none = new Set<string>()
  it('starts at the top from nowhere, either way', () => {
    expect(stepCursor(['a', 'b'], none, null, 1)).toBe('a')
    expect(stepCursor(['a', 'b'], none, null, -1)).toBe('a')
  })
  it('stays at the ends', () => {
    expect(stepCursor(['a', 'b'], none, 'b', 1)).toBe('b')
    expect(stepCursor(['a', 'b'], none, 'a', -1)).toBe('a')
  })
  it('walks past a row in its gap', () => {
    expect(stepCursor(['a', 'b', 'c'], new Set(['b']), 'a', 1)).toBe('c')
    expect(stepCursor(['a', 'b', 'c'], new Set(['b']), 'c', -1)).toBe('a')
  })
  it('a cursor whose row left restarts at the top, nothing to walk is null', () => {
    expect(stepCursor(['a'], none, 'zz', 1)).toBe('a')
    expect(stepCursor([], none, null, 1)).toBeNull()
  })
})

describe('cursorAfterClose', () => {
  it('goes to the row below, or above from the last, past what is closing', () => {
    expect(cursorAfterClose(['a', 'b', 'c'], new Set(), 'b')).toBe('c')
    expect(cursorAfterClose(['a', 'b', 'c'], new Set(), 'c')).toBe('b')
    expect(cursorAfterClose(['a', 'b', 'c'], new Set(['c']), 'b')).toBe('a')
    expect(cursorAfterClose(['a'], new Set(), 'a')).toBeNull()
  })
})

describe('reconcileHeld: the order under the cursor', () => {
  it('a fresh reorder changes nothing', () => {
    expect(keysOf(reconcileHeld(held('a', 'b', 'c'), ['c', 'a', 'b'], 0))).toEqual(['a', 'b', 'c'])
  })
  it('what closes keeps its gap, marked, and then goes', () => {
    const closing = reconcileHeld(held('a', 'b', 'c'), ['a', 'c'], 1_000)
    expect(closing).toEqual([
      { key: 'a', goneAt: null },
      { key: 'b', goneAt: 1_000 },
      { key: 'c', goneAt: null },
    ])
    expect(reconcileHeld(closing, ['a', 'c'], 1_000 + GAP_MS - 1)[1]).toEqual({ key: 'b', goneAt: 1_000 })
    expect(keysOf(reconcileHeld(closing, ['a', 'c'], 1_000 + GAP_MS))).toEqual(['a', 'c'])
  })
  it('a row under the cursor stays past its gap, so Enter never opens the one below', () => {
    const closing = reconcileHeld(held('a', 'b'), ['a'], 0, { pin: 'b' })
    expect(keysOf(reconcileHeld(closing, ['a'], GAP_MS * 10, { pin: 'b' }))).toEqual(['a', 'b'])
    expect(keysOf(reconcileHeld(closing, ['a'], GAP_MS * 10, { pin: 'a' }))).toEqual(['a'])
  })
  it('a row that comes back is whole again, where it was', () => {
    const closing = reconcileHeld(held('a', 'b', 'c'), ['a', 'c'], 0)
    expect(reconcileHeld(closing, ['c', 'b', 'a'], 10)).toEqual(held('a', 'b', 'c'))
  })
  it('a newcomer enters after what precedes it in the fresh order, or on top', () => {
    expect(keysOf(reconcileHeld(held('a', 'b'), ['a', 'n', 'b'], 0))).toEqual(['a', 'n', 'b'])
    expect(keysOf(reconcileHeld(held('a', 'b'), ['n', 'a', 'b'], 0))).toEqual(['n', 'a', 'b'])
    expect(keysOf(reconcileHeld(held('a', 'b'), ['b', 'a', 'n', 'm'], 0))).toEqual(['a', 'n', 'm', 'b'])
  })
  it('a reading of only some rows leaves the others as they are', () => {
    const rows = reconcileHeld(held('task/1', 'ask', 'task/2'), ['task/2'], 0, { inScope: (k) => k.startsWith('task/') })
    expect(rows).toEqual([
      { key: 'task/1', goneAt: 0 },
      { key: 'ask', goneAt: null },
      { key: 'task/2', goneAt: null },
    ])
  })
})

describe('a hold', () => {
  beforeEach(() => resetHolds())
  it('goes on holding what it started with, until released', () => {
    engageHold('v', ['a', 'b'], 0)
    expect(keysOf(engageHold('v', ['b', 'a'], 10).rows)).toEqual(['a', 'b'])
    releaseHold('v')
    expect(readHold('v', 20)).toBeNull()
  })
  it('lets go after idling, the attention boundary', () => {
    engageHold('v', ['a'], 0)
    expect(readHold('v', HOLD_IDLE_MS)).not.toBeNull()
    expect(readHold('v', HOLD_IDLE_MS + 1)).toBeNull()
  })
  it('a view of Tasks and the same view walked from a task are one list; another view is another', () => {
    const q = { view: 'open', layout: 'list', agent: ['finance'] } as const
    expect(holdIdOfOrigin({ kind: 'tasks', query: { ...q, from: { kind: 'org' } } })).toBe(tasksHoldId(q))
    expect(tasksHoldId({ ...q, agent: ['builder'] })).not.toBe(tasksHoldId(q))
    expect(holdIdOfOrigin({ kind: 'org' })).toBeNull()
    expect(holdIdOfOrigin({ kind: 'needs-you', folder: '/p' })).not.toBe(holdIdOfOrigin({ kind: 'needs-you' }))
  })
})
