// «New to you»: who counts as another, from when, and that a reading from the
// server never takes back a mark made here.
import { describe, expect, it } from 'vitest'
import { isNewToYou, mergeBook, newTaskKeys, type SeenBook } from '../src/lib/task-seen'
import type { TaskView } from '../src/lib/tasks'

const AGENTS = new Set(['finance'])
const SINCE = Date.parse('2026-11-01T00:00:00Z')
const iso = (h: number): string => new Date(SINCE + h * 3_600_000).toISOString()
const at = (h: number): number => Date.parse(iso(h))
const task = (over: Partial<TaskView> = {}): TaskView =>
  ({ key: 'p/tasks/t1', owner: 'finance', state: 'pending', notes: [], moved: null, ...over }) as TaskView
const book = (seen: SeenBook['seen'] = {}): SeenBook => ({ since: SINCE, seen })

describe('isNewToYou', () => {
  it('never looked at, nothing since the book opened: quiet, the first day is not all bold', () => {
    expect(isNewToYou(task({ moved: SINCE - 1000, notes: [{ at: iso(-5), by: 'finance', text: 'old', fromOwner: false }] }), book(), AGENTS)).toBe(false)
  })
  it('never looked at, and it moved or an agent wrote since: new', () => {
    expect(isNewToYou(task({ moved: at(1) }), book(), AGENTS)).toBe(true)
    expect(isNewToYou(task({ notes: [{ at: iso(1), by: 'finance', text: 'x', fromOwner: false }] }), book(), AGENTS)).toBe(true)
  })
  it('a note by an agent or by Silos after the mark is new; before it is not', () => {
    const b = book({ 'p/tasks/t1': { at: at(2), state: 'pending' } })
    expect(isNewToYou(task({ notes: [{ at: iso(3), by: 'finance', text: 'x', fromOwner: false }] }), b, AGENTS)).toBe(true)
    expect(isNewToYou(task({ notes: [{ at: iso(3), by: 'silos', text: 'escalated', fromOwner: false }] }), b, AGENTS)).toBe(true)
    expect(isNewToYou(task({ notes: [{ at: iso(1), by: 'finance', text: 'x', fromOwner: false }] }), b, AGENTS)).toBe(false)
  })
  it("the owner's own note is never news — one the server saw the owner write, or under the plan's name for them; a note merely signed «owner» is news", () => {
    const b = book({ 'p/tasks/t1': { at: at(2), state: 'pending' } })
    expect(isNewToYou(task({ notes: [{ at: iso(3), by: 'owner', text: 'x', fromOwner: true }] }), b, AGENTS)).toBe(false)
    expect(isNewToYou(task({ notes: [{ at: iso(3), by: 'owner', text: 'x', fromOwner: false }] }), b, AGENTS)).toBe(true)
    expect(isNewToYou(task({ owner: 'sam', notes: [{ at: iso(3), by: 'sam', text: 'x', fromOwner: false }] }), b, AGENTS)).toBe(false)
  })
  it('a state other than the one left is new, whenever the journal noticed it', () => {
    const b = book({ 'p/tasks/t1': { at: at(2), state: 'pending' } })
    expect(isNewToYou(task({ state: 'in_review', moved: at(1) }), b, AGENTS)).toBe(true)
  })
  it("the owner's own Done: the state matches the mark, even if the journal stamps it later", () => {
    const b = book({ 'p/tasks/t1': { at: at(2), state: 'done' } })
    expect(isNewToYou(task({ state: 'done', moved: at(2) + 5_000 }), b, AGENTS)).toBe(false)
  })
  it('an undated note is no event', () => {
    expect(isNewToYou(task({ notes: [{ at: '', by: 'finance', text: 'x', fromOwner: false }] }), book(), AGENTS)).toBe(false)
  })
})

describe('newTaskKeys', () => {
  it('nothing is new before the book is read', () => {
    expect(newTaskKeys([task({ moved: at(1) })], null, AGENTS).size).toBe(0)
  })
})

describe('mergeBook', () => {
  it('a reading that left before a mark made here does not take it back', () => {
    const here = book({ a: { at: 10, state: 'done' }, b: { at: 1, state: 'pending' } })
    const server = book({ a: { at: 5, state: 'pending' }, b: { at: 9, state: 'in_review' } })
    expect(mergeBook(here, server).seen).toEqual({ a: { at: 10, state: 'done' }, b: { at: 9, state: 'in_review' } })
  })
})
