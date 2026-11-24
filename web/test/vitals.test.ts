// vitals.test.ts — the System page's readings that can break unseen: an hour
// without a sample between two is the server down (a gap, never joined), the
// disk's stack sums to the day's attributed total, and the System house's
// landing is Vitals with Worktrees reached by kind.
import { describe, expect, it } from 'vitest'
import { diskStack, diskTotal, memoryRuns } from '../src/lib/vitals'
import { systemLanding, systemListOf, systemTabOf } from '../src/lib/system-house'
import type { SiloDescriptor } from '../src/lib/types'

const at = (h: number): string => new Date(Date.UTC(2026, 10, 20, h)).toISOString()

describe('memoryRuns', () => {
  it('cuts the line where hours are missing between two samples, and only there', () => {
    const points = [0, 1, 2, 6, 7, 9].map((h) => ({ at: at(h), usedBytes: h }))
    const { runs, gaps } = memoryRuns(points)
    expect(runs.map((r) => r.length)).toEqual([3, 2, 1])
    expect(gaps).toEqual([
      { fromMs: Date.parse(at(2)), toMs: Date.parse(at(6)) },
      { fromMs: Date.parse(at(7)), toMs: Date.parse(at(9)) },
    ])
  })
  it('reads out of order and drops an unreadable hour', () => {
    const { runs, gaps } = memoryRuns([
      { at: at(1), usedBytes: 1 },
      { at: 'nope', usedBytes: 9 },
      { at: at(0), usedBytes: 0 },
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.map((p) => p.usedBytes)).toEqual([0, 1])
    expect(gaps).toEqual([])
  })
})

describe('diskStack', () => {
  it("stacks the groups bottom up to the day's total", () => {
    const bytes = { transcripts: 5, trash: 2, worktrees: 3, agentState: 1, other: 10 }
    const [row] = diskStack([{ date: '2026-11-21', bytes }])
    expect(row!.transcripts).toEqual([0, 5])
    expect(row!.other).toEqual([11, 21])
    expect(row!.other[1]).toBe(diskTotal(bytes))
  })
})

describe('the System house', () => {
  const silo = {
    id: 'system',
    state: 'active',
    lists: [
      { id: 'processes', kind: 'process', label: 'Processes' },
      { id: 'worktrees', kind: 'worktree', label: 'Worktrees' },
    ],
  } as unknown as SiloDescriptor
  it('lands on Vitals, with or without the silo', () => {
    expect(systemLanding([silo])).toEqual({ kind: 'system' })
    expect(systemLanding([])).toEqual({ kind: 'system' })
    expect(systemTabOf({ kind: 'system' }, [])).toBe('vitals')
  })
  it('finds the Worktrees list by kind — no door when the silo is off', () => {
    expect(systemListOf([silo], 'worktree')).toEqual({ kind: 'silo', id: 'system', view: 'worktrees' })
    expect(systemListOf([{ ...silo, state: 'inactive' } as unknown as SiloDescriptor], 'worktree')).toBeNull()
  })
})
