// console-scroll.ts — the pure maths behind the real console's scroll.
//
// The console's history lives in tmux (`mouse on`, alternate-screen off):
// a wheel event never scrolls xterm.js locally, it is reported to tmux
// as a mouse wheel and tmux scrolls its copy-mode view. Two pieces make
// that feel like a native scroll instead of a firehose:
//
// - WheelAccumulator: browsers fire wheel events with wildly different
//   deltas (one 100px event per notch on a mouse, dozens of 3-8px events
//   per swipe on a trackpad). xterm.js would report EACH event as one tick
//   and tmux scrolled 5 rows per tick — a swipe flew hundreds of rows. The
//   accumulator turns pixel travel into ticks at ONE per row of travel
//   (the same rule as the touch handler), and tmux is bound to scroll one
//   row per tick, so the content follows the gesture 1:1.
//
// - thumbGeometry / positionFromThumbTop: tmux exposes `scroll_position`
//   (rows above the bottom; 0 = at the bottom), `history_size` (rows
//   above the screen) and `pane_height`. A scrollbar over the pane is drawn
//   from those and, when dragged, converted back into a scroll_position
//   for `goto-line`.

export type ScrollInfo = { position: number; history: number; rows: number }

export const THUMB_MIN_PX = 24

export class WheelAccumulator {
  private pending = 0

  // `gain` scales the travel: 1 = a row of content per row of gesture.
  constructor(private gain = 1) {}

  // deltaMode: 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode).
  // Returns the ticks to send now (negative = up); keeps the remainder.
  push(deltaY: number, deltaMode: number, rowPx: number, rows = 1): number {
    const row = Math.max(1, rowPx)
    const px = deltaMode === 1 ? deltaY * row : deltaMode === 2 ? deltaY * row * rows : deltaY
    // a change of direction starts fresh — a leftover from the other way
    // would eat the first honest row of the new gesture.
    if ((px < 0 && this.pending > 0) || (px > 0 && this.pending < 0)) this.pending = 0
    this.pending += px * this.gain
    const ticks = Math.trunc(this.pending / row)
    this.pending -= ticks * row
    return ticks
  }
}

// The thumb for a track of `trackPx` pixels, or null when there is no
// history (nothing to scroll → no bar at all).
export function thumbGeometry(info: ScrollInfo, trackPx: number): { top: number; height: number } | null {
  if (info.history <= 0 || info.rows <= 0 || trackPx <= 0) return null
  const total = info.history + info.rows
  const height = Math.min(trackPx, Math.max(THUMB_MIN_PX, Math.round((info.rows / total) * trackPx)))
  const travel = trackPx - height
  const top = Math.round(((info.history - info.position) / info.history) * travel)
  return { top, height }
}

// The inverse: a thumb dragged to `top` px → the scroll_position it means.
export function positionFromThumbTop(info: ScrollInfo, trackPx: number, top: number): number {
  const g = thumbGeometry(info, trackPx)
  if (!g) return 0
  const travel = trackPx - g.height
  if (travel <= 0) return 0
  const frac = Math.min(1, Math.max(0, top / travel))
  return Math.round((1 - frac) * info.history)
}
