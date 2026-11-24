import { describe, expect, it } from 'vitest'
import { splitTaskRefs, taskOfRef } from '../src/lib/task-refs'
import type { TaskView } from '../src/lib/tasks'

const known = (ref: string): string | null => (['ship#t4', 'ship-it#r6'].includes(ref) ? ref.toUpperCase() : null)

describe('splitTaskRefs', () => {
  it('turns a known reference into a part and keeps the words around it', () => {
    expect(splitTaskRefs('blocked until ship#t4 lands', known)).toEqual(['blocked until ', { ref: 'ship#t4', task: 'SHIP#T4' }, ' lands'])
  })
  it('leaves trailing punctuation out of the reference', () => {
    expect(splitTaskRefs('see ship#t4.', known)).toEqual(['see ', { ref: 'ship#t4', task: 'SHIP#T4' }, '.'])
    expect(splitTaskRefs('(ship-it#r6)', known)).toEqual(['(', { ref: 'ship-it#r6', task: 'SHIP-IT#R6' }, ')'])
  })
  it('a reference no task has stays the plain text it was', () => {
    expect(splitTaskRefs('see other#t9 and ship#t4', known)).toEqual(['see other#t9 and ', { ref: 'ship#t4', task: 'SHIP#T4' }])
  })
  it('a URL fragment and an issue number are not references', () => {
    expect(splitTaskRefs('https://x.dev/ship#t4 and #12', known)).toEqual(['https://x.dev/ship#t4 and #12'])
  })
})

describe('taskOfRef', () => {
  const t = (ref: string, planKey: string, folder: string): TaskView => ({ ref, planKey, folder }) as TaskView
  const a = t('ship#t1', 'folder:/a/ship', '/a')
  const b = t('ship#t1', 'folder:/b/ship', '/b')
  it('two plans sharing a slug: its own plan, then its own project', () => {
    expect(taskOfRef('ship#t1', [a, b], { planKey: 'folder:/b/ship', folder: '/b' })).toBe(b)
    expect(taskOfRef('ship#t1', [a, b], { planKey: 'folder:/b/other', folder: '/b' })).toBe(b)
    expect(taskOfRef('ship#t1', [a, b])).toBe(a)
  })
  it('nothing known: null', () => {
    expect(taskOfRef('ship#t9', [a, b])).toBeNull()
  })
})
