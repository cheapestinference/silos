// Section.tsx — the agent page's one card grammar: an uppercase label on
// the left, at most one action on the right, the body underneath. The
// SAME shape InChargeOf already had, so Now/Who/Knows & can/Machinery read
// as one system with it. `live` spends the page's single accent (a
// terracotta left rule) — only the thing that is alive gets it.
import type { ReactNode } from 'react'

export function Section({
  id,
  label,
  action,
  live = false,
  children,
  className = '',
}: {
  id?: string
  label: ReactNode
  action?: ReactNode
  live?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <section
      id={id}
      aria-label={typeof label === 'string' ? label : undefined}
      className={`scroll-mt-4 rounded-lg border border-line bg-panel px-4 py-3 ${live ? 'border-l-[3px] border-l-terracotta' : ''} ${className}`.trim()}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{label}</h3>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  )
}

// A quiet text action for a Section header ("Edit", "＋ Add", "Show") —
// the same pill the page uses everywhere, never a filled button: filled
// terracotta is reserved for send/save.
export function SectionAction({ onClick, children, pressed, ariaLabel }: { onClick: () => void; children: ReactNode; pressed?: boolean; ariaLabel?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      className="rounded-full border border-line px-2.5 py-0.5 text-[11px] text-ink-2 transition-colors duration-150 hover:border-terracotta hover:text-terracotta"
    >
      {children}
    </button>
  )
}
