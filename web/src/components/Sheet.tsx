// Sheet — where a tile's list opens (a summary page is tiles;
// the list is one click away). It slides over the right of the page, the
// board stays visible behind it so the owner never loses where they were;
// Esc, the ✕ or a click on the board closes it. Full screen on a phone.
// Dialog semantics come from useModalBehavior (Escape belongs to the topmost
// overlay: a file opened from inside the sheet closes alone).
import { useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useModalBehavior } from './Modal'

export function Sheet({
  title,
  sub,
  onClose,
  children,
  testId,
}: {
  title: string
  // one quiet line under the title: what the list holds
  sub?: ReactNode
  onClose: () => void
  children: ReactNode
  testId?: string
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  useModalBehavior(cardRef, onClose)
  return (
    <div
      className="fixed inset-0 z-40 bg-ink/15"
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
        data-testid={testId}
        className="sheet-in absolute inset-y-0 right-0 flex w-full flex-col border-l border-line bg-canvas outline-none sm:w-[min(40rem,92vw)]"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 pb-3 pt-4 sm:px-7">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[22px] leading-tight text-ink">{title}</h2>
            {sub ? <p className="mt-0.5 font-mono text-[11px] text-ink-2">{sub}</p> : null}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="mt-1 rounded-md p-1 text-ink-2 hover:bg-panel hover:text-ink">
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-2 sm:px-7">{children}</div>
      </div>
    </div>
  )
}
