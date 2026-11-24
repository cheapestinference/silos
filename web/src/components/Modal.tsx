import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

// Shared modal primitive. Before this, each dialog re-implemented (or forgot) the
// backdrop, Escape-to-close, focus trap, focus restore, and body scroll-lock —
// FileViewer did it right, most others missed pieces. useModalBehavior is the
// single correct implementation (extracted from FileViewer); <Modal> wraps it in
// the common centered, responsive, scrollable card. Odd-shaped overlays
// (CommandPalette's top-aligned list, etc.) call the hook directly with their own layout.

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Locks body scroll, traps Tab within `cardRef`, closes on Escape, and restores
// focus to whatever was focused before, on unmount. `cardRef` must point at the
// dialog container. Pass `initialFocusRef` to focus a specific element on open
// (otherwise the card itself is focused).
// Open overlays, oldest first. Escape belongs to the TOPMOST one only: a
// dialog opened over a side panel closes alone, the panel stays.
const openStack: symbol[] = []
const isTop = (id: symbol): boolean => openStack[openStack.length - 1] === id

export function useModalBehavior(
  cardRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  opts: { initialFocusRef?: RefObject<HTMLElement | null>; enabled?: boolean } = {},
): void {
  const { initialFocusRef, enabled = true } = opts
  // keep the latest onClose without re-running the effect (which would steal
  // focus back to the card on every parent render)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    // a component that keeps this hook mounted while it's closed (early-returns
    // null AFTER its hooks) passes enabled=false so we don't lock scroll/trap
    // focus behind a dialog that isn't on screen.
    if (!enabled) return
    const id = Symbol('overlay')
    openStack.push(id)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const previouslyFocused = document.activeElement as HTMLElement | null
    ;(initialFocusRef?.current ?? cardRef.current)?.focus()

    // Escape pressed with focus OUTSIDE the overlay (the real console's
    // terminal, the composer…): caught on the way down, before the terminal
    // can swallow it — and never handed to claude, where Esc interrupts.
    function onKeyCapture(e: globalThis.KeyboardEvent): void {
      if (e.key !== 'Escape' || !isTop(id)) return
      const t = e.target
      if (t instanceof Node && cardRef.current?.contains(t)) return // inside: the bubble path below
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    function onKey(e: globalThis.KeyboardEvent): void {
      if (!isTop(id)) return
      if (e.key === 'Escape') {
        e.preventDefault() // don't also cancel a turn in progress
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const cont = cardRef.current
      if (!cont) return
      const f = cont.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (f.length === 0) {
        e.preventDefault()
        cont.focus()
        return
      }
      const first = f[0]!
      const last = f[f.length - 1]!
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || active === cont) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyCapture, true)
    document.addEventListener('keydown', onKey)
    return () => {
      const i = openStack.indexOf(id)
      if (i >= 0) openStack.splice(i, 1)
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKeyCapture, true)
      document.removeEventListener('keydown', onKey)
      previouslyFocused?.focus?.()
    }
  }, [cardRef, initialFocusRef, enabled])
}

// A side panel (no scrim) closes when the press lands anywhere outside it.
// Caught on the way down (capture), so a terminal or a canvas that stops
// the event still counts as «somewhere else». Not outside: the panel's own
// openers (`data-panel-owned="<owner>"` — a press on its opener does not
// close→reopen it), a dialog stacked on top
// (`aria-modal="true"`), and a node the press itself removed.
export function useDismissOnOutside(panelRef: RefObject<HTMLElement | null>, onOutside: () => void, opts: { enabled?: boolean; owner?: string } = {}): void {
  const { enabled = true, owner } = opts
  const cbRef = useRef(onOutside)
  cbRef.current = onOutside
  useEffect(() => {
    if (!enabled) return
    function onDown(e: PointerEvent): void {
      const t = e.target
      if (!(t instanceof Node) || !panelRef.current || panelRef.current.contains(t)) return
      if (!t.isConnected) return
      if (t instanceof Element && t.closest('[aria-modal="true"]')) return
      if (owner && t instanceof Element && t.closest(`[data-panel-owned="${owner}"]`)) return
      cbRef.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [panelRef, enabled, owner])
}

const SIZE: Record<string, string> = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-2xl' }

// The common case: a centered card that scrolls if it's taller than the viewport
// (so its footer/buttons are always reachable), full-width on a phone, with the
// backdrop, Escape, focus trap, scroll-lock and focus restore all handled.
export function Modal({
  onClose,
  label,
  children,
  size = 'md',
  className = '',
  initialFocusRef,
}: {
  onClose: () => void
  label: string
  children: ReactNode
  size?: keyof typeof SIZE
  className?: string
  initialFocusRef?: RefObject<HTMLElement | null>
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  useModalBehavior(cardRef, onClose, { ...(initialFocusRef ? { initialFocusRef } : {}) })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`modal-pop max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-line bg-canvas p-6 shadow-lg outline-none ${SIZE[size]} ${className}`}
      >
        {children}
      </div>
    </div>
  )
}
