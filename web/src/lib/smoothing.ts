// smoothing.ts — a smooth reveal of streaming text (Claude Code, even when
// it isn't fast, reads as fluid, unlike a jerky reveal). The cause of the
// jerkiness is structural: the store batches deltas in 80ms lots, so the
// text grows in whole-sentence jumps. Here the component paints a delayed
// view that drains the backlog at a steady pace: each frame advances just
// enough to catch up within ~RAMP_MS, with a minimum so it doesn't crawl
// when the backlog is short. Direct jumps (no animation): a non-streaming
// turn, prefers-reduced-motion, the text going backwards (a new turn), or
// a huge backlog (don't punish the user with seconds of teletype for a
// block that landed all at once).
import { useEffect, useRef, useState } from 'react'

const RAMP_MS = 350
const MIN_CPS = 90
const JUMP_CHARS = 4000
// paint at most every ~33ms (~30fps): re-parsing the live turn's markdown
// at 60fps adds no perceptible smoothness, only cost.
const MIN_PAINT_MS = 33

// don't split a surrogate pair (an emoji outside the BMP) in half — a
// slice in the middle paints the replacement character for one frame and flickers.
function safeCut(text: string, n: number): number {
  if (n > 0 && n < text.length) {
    const c = text.charCodeAt(n - 1)
    if (c >= 0xd800 && c <= 0xdbff) return n - 1
  }
  return n
}

export function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(() => text.length)
  const ref = useRef({ shown: text.length, lastPaint: 0 })

  useEffect(() => {
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const backlog = text.length - ref.current.shown
    if (!streaming || reduced || backlog < 0 || backlog > JUMP_CHARS) {
      ref.current.shown = text.length
      setShown(text.length)
      return
    }
    if (backlog === 0) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.max(1, now - last)
      last = now
      const pending = text.length - ref.current.shown
      if (pending <= 0) return // the next delta re-runs the effect
      const byRamp = (pending / RAMP_MS) * dt
      const byMin = (MIN_CPS / 1000) * dt
      ref.current.shown = Math.min(text.length, ref.current.shown + Math.max(1, Math.ceil(Math.max(byRamp, byMin))))
      if (now - ref.current.lastPaint >= MIN_PAINT_MS || ref.current.shown >= text.length) {
        ref.current.lastPaint = now
        setShown(ref.current.shown)
      }
      if (ref.current.shown < text.length) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [text, streaming])

  return text.slice(0, safeCut(text, Math.min(shown, text.length)))
}
