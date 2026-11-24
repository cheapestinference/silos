import { describe, expect, it } from 'vitest'
import { baseRecordOf, recordsOfKind, type KindInfo } from '../src/silos/voice.js'

// A silo may hold several top-level kinds (the System silo: processes and
// worktrees). Each kind's page, pulse and predicates read ITS records only.
describe('recordsOfKind — several top-level kinds in one silo', () => {
  const kinds = new Map<string, KindInfo>([
    ['alpha', { name: 'alpha' } as KindInfo],
    ['beta', { name: 'beta' } as KindInfo],
  ])
  const read = (kind: string | undefined, id: string) => baseRecordOf({ record: { id }, anchors: {}, location: 'kernel', file: '', ...(kind ? { kind } : {}) })

  it('a kind gets only the records read as that kind', () => {
    const base = [read('alpha', 'a1'), read('beta', 'b1'), read('alpha', 'a2')]
    expect(recordsOfKind(kinds, base, 'alpha').map((r) => r.rec.id)).toEqual(['a1', 'a2'])
    expect(recordsOfKind(kinds, base, 'beta').map((r) => r.rec.id)).toEqual(['b1'])
  })

  it("records that carry no kind belong to the silo's one kind, as before", () => {
    const base = [read(undefined, 'x1'), read(undefined, 'x2')]
    expect(recordsOfKind(kinds, base, 'alpha').map((r) => r.rec.id)).toEqual(['x1', 'x2'])
  })
})
