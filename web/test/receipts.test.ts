// receipts.test.ts — anchoring turn receipts: each receipt hangs after the
// LAST persisted turn with timestamp <= receipt.ts; with no possible
// anchor, it isn't painted (never at an invented spot).
import { describe, expect, it } from 'vitest'
import { assignReceipts } from '../src/lib/receipts'
import type { Turn } from '../src/lib/types'
import type { TurnReceipt } from '../src/store'

function turn(index: number, ts: string | null, role: 'user' | 'assistant' = 'assistant'): Turn {
  return { index, role, text: 'x', tools: [], ts }
}

function receipt(turnId: string, ts: number): TurnReceipt {
  return { turnId, verb: 'Brewed', elapsedMs: 1000, ts }
}

const T0 = Date.parse('2026-08-20T10:00:00.000Z')

describe('assignReceipts', () => {
  it('anchors after the last turn with ts <= receipt.ts', () => {
    const turns = [
      turn(0, '2026-08-20T10:00:00.000Z', 'user'),
      turn(1, '2026-08-20T10:00:10.000Z'),
      turn(2, '2026-08-20T10:05:00.000Z', 'user'),
      turn(3, '2026-08-20T10:05:20.000Z'),
    ]
    // the first turn's receipt arrived at 10:00:12 — between turn 1 and
    // the next user message: anchors at index 1, never at 2.
    const map = assignReceipts(turns, [receipt('a', T0 + 12_000)])
    expect([...map.keys()]).toEqual([1])
    expect(map.get(1)![0]!.turnId).toBe('a')
  })

  it('two receipts can anchor at different turns, in order', () => {
    const turns = [
      turn(0, '2026-08-20T10:00:00.000Z', 'user'),
      turn(1, '2026-08-20T10:00:10.000Z'),
      turn(2, '2026-08-20T10:05:00.000Z', 'user'),
      turn(3, '2026-08-20T10:05:20.000Z'),
    ]
    const map = assignReceipts(turns, [receipt('a', T0 + 12_000), receipt('b', T0 + 330_000)])
    expect(map.get(1)![0]!.turnId).toBe('a')
    expect(map.get(3)![0]!.turnId).toBe('b')
  })

  it("a turn with no ts inherits the previous one's (same time span)", () => {
    const turns = [turn(0, '2026-08-20T10:00:00.000Z', 'user'), turn(1, '2026-08-20T10:00:10.000Z'), turn(2, null)]
    const map = assignReceipts(turns, [receipt('a', T0 + 12_000)])
    // turn 2 (no ts) inherits 10:00:10 <= receipt.ts — it's the last one: anchors there.
    expect([...map.keys()]).toEqual([2])
  })

  it('a receipt earlier than every visible turn → not painted (no anchor)', () => {
    const turns = [turn(5, '2026-08-20T10:00:00.000Z', 'user')]
    const map = assignReceipts(turns, [receipt('a', T0 - 60_000)])
    expect(map.size).toBe(0)
  })

  it('no turns or no receipts → an empty map', () => {
    expect(assignReceipts([], [receipt('a', T0)]).size).toBe(0)
    expect(assignReceipts([turn(0, '2026-08-20T10:00:00.000Z')], []).size).toBe(0)
  })
})
