// MoreFold.tsx — the one rule for long lists on a page (a page never shows
// thousands of items): a handful in view, the rest behind ONE line
// that says how many and unfolds in place. `useFold` cuts the list;
// `<MoreFold>` is that line. Folding never hides that something exists —
// the count is always said.
import { useState } from 'react'

export function useFold<T>(items: readonly T[], limit: number): { shown: readonly T[]; hidden: number; open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(false)
  const over = items.length > limit
  return {
    shown: open || !over ? items : items.slice(0, limit),
    hidden: over ? items.length - limit : 0,
    open,
    toggle: () => setOpen((v) => !v),
  }
}

export function MoreFold({
  hidden,
  open,
  onToggle,
  noun = 'more',
  className = '',
}: {
  hidden: number
  open: boolean
  onToggle: () => void
  noun?: string
  className?: string
}) {
  if (hidden === 0) return null
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className={`font-mono text-[11px] text-ink-2 hover:text-terracotta ${className}`}>
      {open ? 'show fewer' : `${hidden} ${noun} ›`}
    </button>
  )
}
