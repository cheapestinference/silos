import { describe, expect, it } from 'vitest'
import { diskUsed, fleetKinds } from '../src/lib/vitals'

describe("fleetKinds — Home's fleet line from /api/vitals", () => {
  it('walks the ladder top-down, leaves out a kind with nobody, and counts what the server counted', () => {
    const kinds = fleetKinds(
      {
        told: 2,
        own: 0,
        proactive: 1,
        agents: [
          { id: 'a', control: 'told' },
          { id: 'b', control: 'proactive' },
          { id: 'c', control: 'told' },
        ],
      },
      (id) => id.toUpperCase(),
    )
    expect(kinds.map((k) => [k.control, k.count, k.names])).toEqual([
      ['proactive', 1, ['B']],
      ['told', 2, ['A', 'C']],
    ])
  })
})

describe('diskUsed', () => {
  it('adds the attribution groups (other is the residue) and ignores a non-number', () => {
    expect(diskUsed({ transcripts: 10, trash: 2, worktrees: 3, agentState: 1, other: 4 })).toBe(20)
    expect(diskUsed({ transcripts: 10, trash: Number.NaN, worktrees: 0, agentState: 0, other: 5 })).toBe(15)
  })
})
