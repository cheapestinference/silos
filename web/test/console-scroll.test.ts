// console-scroll.test.ts — the pure pieces behind the real console's scroll:
// the wheel accumulator (browser wheel deltas → tmux wheel ticks, one per
// row of travel, so a trackpad and a notched mouse feel the same) and the
// scrollbar geometry (tmux's scroll_position/history_size/pane_height →
// a thumb, and a dragged thumb → a scroll_position back).
import { describe, expect, it } from 'vitest'
import { WheelAccumulator, thumbGeometry, positionFromThumbTop } from '../src/lib/console-scroll'

describe('WheelAccumulator', () => {
  it('a notched mouse (≈100px per notch) at 17px rows gives ~6 ticks per notch and keeps the remainder', () => {
    const acc = new WheelAccumulator()
    // 100 / 17 = 5.88 → 5 ticks, 15px left over
    expect(acc.push(100, 0, 17)).toBe(5)
    // the leftover 15px + 100 = 115 → 6 ticks, 13px left over
    expect(acc.push(100, 0, 17)).toBe(6)
  })

  it('a trackpad spraying small deltas emits nothing until a full row has travelled', () => {
    const acc = new WheelAccumulator()
    expect(acc.push(4, 0, 17)).toBe(0)
    expect(acc.push(4, 0, 17)).toBe(0)
    expect(acc.push(4, 0, 17)).toBe(0)
    expect(acc.push(4, 0, 17)).toBe(0)
    expect(acc.push(4, 0, 17)).toBe(1) // 20px ≥ 17
  })

  it('negative deltas (wheel up) yield negative ticks', () => {
    const acc = new WheelAccumulator()
    expect(acc.push(-34, 0, 17)).toBe(-2)
  })

  it('a direction change discards the opposite leftover instead of cancelling against it', () => {
    const acc = new WheelAccumulator()
    acc.push(16, 0, 17) // 16px down pending
    expect(acc.push(-17, 0, 17)).toBe(-1) // an honest row up, not (16-17) = nothing
  })

  it('deltaMode LINE (Firefox) counts rows directly; PAGE counts a viewport of rows', () => {
    const acc = new WheelAccumulator()
    expect(acc.push(3, 1, 17)).toBe(3)
    expect(acc.push(1, 2, 17, 40)).toBe(40)
  })

  it('a gain scales the travel (0.5 = half a row of content per row of gesture)', () => {
    const acc = new WheelAccumulator(0.5)
    expect(acc.push(68, 0, 17)).toBe(2) // 4 rows of gesture → 2 ticks
  })
})

describe('thumbGeometry', () => {
  it('no history → no thumb (nothing to scroll)', () => {
    expect(thumbGeometry({ position: 0, history: 0, rows: 40 }, 400)).toBeNull()
  })

  it('at the bottom the thumb sits at the end; its size is the visible share of the whole', () => {
    // 40 visible of 200 total → 20% of 400px = 80px, top at 320
    expect(thumbGeometry({ position: 0, history: 160, rows: 40 }, 400)).toEqual({ top: 320, height: 80 })
  })

  it('at the top (position = history) the thumb sits at 0', () => {
    expect(thumbGeometry({ position: 160, history: 160, rows: 40 }, 400)).toEqual({ top: 0, height: 80 })
  })

  it('the thumb never shrinks below the minimum, and the travel shrinks to fit it', () => {
    // 40 of 100040 → 0.04% of 400px would be a sliver: clamped to 24px
    const g = thumbGeometry({ position: 0, history: 100000, rows: 40 }, 400)!
    expect(g.height).toBe(24)
    expect(g.top).toBe(376)
  })
})

describe('positionFromThumbTop', () => {
  it('inverts thumbGeometry: top 0 → the top of history, bottom → 0', () => {
    const info = { position: 0, history: 160, rows: 40 }
    expect(positionFromThumbTop(info, 400, 0)).toBe(160)
    expect(positionFromThumbTop(info, 400, 320)).toBe(0)
    expect(positionFromThumbTop(info, 400, 160)).toBe(80)
  })

  it('clamps outside the track', () => {
    const info = { position: 0, history: 160, rows: 40 }
    expect(positionFromThumbTop(info, 400, -50)).toBe(160)
    expect(positionFromThumbTop(info, 400, 900)).toBe(0)
  })
})
