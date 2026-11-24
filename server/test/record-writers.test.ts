// The conversations that wrote a record's file — what «Created from <plan>
// by <who>» reads (task-view phase 2): a Write/Edit or a disk change during a
// turn counts; a read never does; newest first, bounded.
import { describe, expect, it } from 'vitest'
import { recordWriters } from '../src/record-writers.js'
import type { SessionMeta } from '../src/types.js'

const meta = (id: string, mtime: number): SessionMeta =>
  ({ id, folder: 'f', title: `T ${id}`, skills: [], cwd: null, mtime, size: 1, turnCount: 1 }) as SessionMeta
const FILE = '/p/plans/ship.plan.json'

describe('recordWriters', () => {
  it('writes, edits and disk changes count; reads and other files do not; newest first', () => {
    const files: Record<string, Array<{ path: string; edits: number; writes: number; reads?: number; disk?: number }>> = {
      a: [{ path: FILE, edits: 0, writes: 1 }],
      b: [{ path: FILE, edits: 0, writes: 0, reads: 3 }],
      c: [{ path: FILE, edits: 2, writes: 0 }],
      d: [{ path: '/p/plans/other.plan.json', edits: 1, writes: 1 }],
      e: [{ path: FILE, edits: 0, writes: 0, disk: 1 }],
    }
    const out = recordWriters(FILE, [meta('a', 10), meta('b', 50), meta('c', 30), meta('d', 40), meta('e', 20)], {
      filesOf: (_f, id) => files[id],
      agentOf: (m) => (m.id === 'c' ? 'writer' : 'builder'),
    })
    expect(out.map((w) => [w.id, w.agentId])).toEqual([
      ['c', 'writer'],
      ['e', 'builder'],
      ['a', 'builder'],
    ])
  })
  it('bounded; a conversation with no context is skipped', () => {
    const many = Array.from({ length: 9 }, (_, i) => meta(`s${i}`, i))
    expect(recordWriters(FILE, many, { filesOf: () => [{ path: FILE, edits: 1, writes: 0 }], agentOf: () => 'x' }, 3)).toHaveLength(3)
    expect(recordWriters(FILE, many, { filesOf: () => undefined, agentOf: () => 'x' })).toEqual([])
  })
})
