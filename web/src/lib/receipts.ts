// receipts.ts — anchors each turn receipt (store.receipts, turns that
// finished in this view) to the persisted turn it belongs to: the LAST
// turn with a timestamp <= receipt.ts. This holds because everything that
// turn wrote to the JSONL carries a ts before chat-done, and the user's
// next message (including a drained queue) always gets sent AFTER
// chat-done — same clock on the same machine in a local product, no skew
// to compensate for. A pure function, testable with no DOM.
import type { Turn } from './types'
import type { TurnReceipt } from '../store'

export function assignReceipts(turns: Turn[], receipts: TurnReceipt[]): Map<number, TurnReceipt[]> {
  const out = new Map<number, TurnReceipt[]>()
  if (turns.length === 0 || receipts.length === 0) return out

  // the effective ts per turn: turns with no timestamp inherit the
  // previous one's (a turn with no ts between two timestamped ones belongs
  // to the same time span).
  const effectiveTs: number[] = new Array(turns.length)
  let previous = Number.NEGATIVE_INFINITY
  for (let i = 0; i < turns.length; i++) {
    const ms = turns[i]!.ts ? Date.parse(turns[i]!.ts!) : NaN
    if (Number.isFinite(ms)) previous = ms
    effectiveTs[i] = previous
  }

  for (const r of receipts) {
    let idx = -1
    for (let i = turns.length - 1; i >= 0; i--) {
      if (effectiveTs[i]! <= r.ts) {
        idx = i
        break
      }
    }
    // no anchor (the turn fell outside the visible window, or the session
    // has no timestamps): the receipt is not rendered — never at a made-up spot.
    if (idx === -1) continue
    const index = turns[idx]!.index
    const list = out.get(index)
    if (list) list.push(r)
    else out.set(index, [r])
  }
  return out
}
