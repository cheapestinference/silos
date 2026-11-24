// FloatingWindow — a draggable window imitating a desktop one: title bar
// as the drag handle, ✕ to close, dialog semantics
// (Escape, focus trap, focus restore via useModalBehavior). The home of
// the lineage and file-history trees — anything that wants to be
// looked at WHILE the conversation stays visible underneath, hence the
// near-transparent backdrop instead of Modal's dim.
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useModalBehavior } from './Modal'

export function FloatingWindow({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const cardRef = useRef<HTMLDivElement>(null)
  useModalBehavior(cardRef, onClose)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  // drag bookkeeping in a ref: pointermove must never re-render more than
  // the position itself.
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  function onPointerDown(e: ReactPointerEvent): void {
    // the ✕ lives inside the bar: a click on it must close, not drag
    if ((e.target as Element).closest('button')) return
    drag.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y }
    // jsdom has no pointer capture — optional on purpose
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  function onPointerMove(e: ReactPointerEvent): void {
    if (!drag.current) return
    setPos({ x: drag.current.baseX + (e.clientX - drag.current.startX), y: drag.current.baseY + (e.clientY - drag.current.startY) })
  }
  function onPointerUp(): void {
    drag.current = null
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/10"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ transform: `translate(calc(-50% + ${pos.x}px), ${pos.y}px)` }}
        className="modal-pop absolute left-1/2 top-[16vh] flex max-h-[70vh] w-[26rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-xl outline-none"
      >
        <div
          data-testid="window-titlebar"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="flex shrink-0 cursor-grab touch-none select-none items-center gap-2 border-b border-line bg-panel px-3 py-2 active:cursor-grabbing"
        >
          <span className="min-w-0 flex-1 truncate font-display text-sm text-ink">{title}</span>
          <button type="button" aria-label="Close window" onClick={onClose} className="shrink-0 rounded-md p-0.5 text-ink-2 hover:bg-canvas hover:text-ink">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
      </div>
    </div>
  )
}
