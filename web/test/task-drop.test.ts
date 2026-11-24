// task-drop.test.ts — the owner's ONE Drop (lib/task-drop.ts): the
// «Dropped: <why>» note, then the drop state, each at the version of
// the read before it — and a retry after a lost race writes the state again,
// never a second note.
import { describe, expect, it } from 'vitest'
import { dropNoteText, dropTask, type DropApi } from '../src/lib/task-drop'

function fake(notes: Array<{ text: string }>, opts: { failState?: number } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = []
  let v = 1
  let fails = opts.failState ?? 0
  const deps: DropApi = {
    record: async () => ({ version: `v${v}`, value: { notes } }),
    append: async (_s, b) => {
      calls.push(['append', b])
      notes.push({ text: b.values.text! })
      v += 1
      return {}
    },
    setField: async (_s, b) => {
      calls.push(['setField', b])
      if (fails > 0) {
        fails -= 1
        throw new Error('409')
      }
      return { nowReady: [] }
    },
  }
  return { deps, calls }
}
const how = { field: 'status', value: 'cancelled', note: 'notes' }

describe('dropTask', () => {
  it('the note first (at the version the owner saw), then the state at the version the note produced', async () => {
    const { deps, calls } = fake([{ text: 'started' }])
    await dropTask('plans', 'k', 'superseded', how, 'v0', deps)
    expect(calls).toEqual([
      ['append', { key: 'k', collection: 'notes', values: { text: 'Dropped: superseded' }, version: 'v0' }],
      ['setField', { key: 'k', field: 'status', value: 'cancelled', version: 'v2' }],
    ])
  })
  it('a retry after the state write lost a race writes the state again — never a second note', async () => {
    const { deps, calls } = fake([], { failState: 1 })
    await expect(dropTask('plans', 'k', '', how, null, deps)).rejects.toThrow('409')
    await dropTask('plans', 'k', '', how, null, deps)
    expect(calls.filter((c) => c[0] === 'append')).toHaveLength(1)
    expect(calls.filter((c) => c[0] === 'setField')).toHaveLength(2)
  })
  it('Drop → Reopen → Drop with the same words leaves a note for each Drop', async () => {
    const { deps, calls } = fake([])
    await dropTask('plans', 'again', '', how, null, deps)
    await dropTask('plans', 'again', '', how, null, deps)
    expect(calls.filter((c) => c[0] === 'append')).toHaveLength(2)
  })
  it('one default reason for every surface; a different reason later is a new note', async () => {
    expect(dropNoteText('  ')).toBe('Dropped: by the owner')
    const { deps, calls } = fake([{ text: 'Dropped: by the owner' }])
    await dropTask('plans', 'k', 'not needed after all', how, null, deps)
    expect(calls[0]).toEqual(['append', { key: 'k', collection: 'notes', values: { text: 'Dropped: not needed after all' }, version: 'v1' }])
  })
})
