// useBottomLock.ts — keeps a scrollable container "pinned" to the bottom
// while the user hasn't scrolled up. Used in Transcript for chat-style
// auto-scroll during streaming.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

const THRESHOLD_PX = 48

export interface BottomLock {
  pinned: boolean
  scrollToBottom(): void
}

export function useBottomLock(ref: RefObject<HTMLElement | null>, deps: unknown[]): BottomLock {
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned

  function scrollToBottom(): void {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setPinned(true)
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    function onScroll(): void {
      if (!el) return
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      setPinned(distance <= THRESHOLD_PX)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    if (!pinnedRef.current) return
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { pinned, scrollToBottom }
}
