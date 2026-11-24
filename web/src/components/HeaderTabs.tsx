// HeaderTabs — a root page's views, in PageHeader's tabs row. Every root
// page's header is the same, and its options never shift. So a view
// switch lives HERE — left-aligned under the title, the same underlined tabs
// as a project's or an agent's sections — and never beside a legend whose
// length changes with the view (the Map's toggle used to slide between Lanes
// and Org). Whatever the view needs to say goes in the header's facts line.
//
// `end` is the row's right edge: a page's quiet second control (the Tasks
// layout), pinned there so it never rides on the width of the tabs either.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export interface HeaderTab<T extends string> {
  id: T
  label: ReactNode
  // a count beside the label (tabular, muted) — never part of its name
  signal?: ReactNode
  about?: string
  testId?: string
}

// A narrow tab row (a phone) scrolls sideways — every label whole, never cut
// to «Untouche…» — with no scrollbar drawn, and the open tab always in view:
// also when a link lands on one past the edge, and again when the counts
// arrive and widen the tabs before it. One rule for both rows below (the
// sections of an agent or a project already scrolled so).
const SCROLL_ROW = 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
function useOpenInView(row: React.RefObject<HTMLElement | null>, openSelector: string, deps: readonly unknown[]): void {
  useEffect(() => {
    const nav = row.current
    const el = nav?.querySelector<HTMLElement>(openSelector)
    if (!nav || !el) return
    // only the row scrolls (scrollIntoView would also move the page)
    const left = el.offsetLeft - nav.offsetLeft
    const right = left + el.offsetWidth
    if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth + 20
    else if (left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 20)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
// …and a view row cut by the edge fades out there (and at the start once
// scrolled), so a half-shown label reads as «more this way», never as a
// broken word. Nothing when the row fits. (A section row is a banded nav —
// its hairline and panel would fade with it — so it only scrolls.)
function useEdgeFade(row: React.RefObject<HTMLElement | null>): CSSProperties | undefined {
  const [edges, setEdges] = useState({ start: false, end: false })
  useEffect(() => {
    const el = row.current
    if (!el) return
    const read = (): void => {
      const start = el.scrollLeft > 1
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }))
    }
    read()
    el.addEventListener('scroll', read, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null
    ro?.observe(el)
    for (const c of Array.from(el.children)) ro?.observe(c)
    return () => {
      el.removeEventListener('scroll', read)
      ro?.disconnect()
    }
  }, [row])
  if (!edges.start && !edges.end) return undefined
  const mask = `linear-gradient(to right, ${edges.start ? 'transparent 0, black 24px' : 'black 0'}, ${edges.end ? 'black calc(100% - 32px), transparent 100%' : 'black 100%'})`
  return { maskImage: mask, WebkitMaskImage: mask }
}
const signalKey = (items: ReadonlyArray<{ signal?: ReactNode }>): string =>
  items.map((t) => (typeof t.signal === 'string' || typeof t.signal === 'number' ? String(t.signal) : t.signal ? '•' : '')).join('|')

export function HeaderTabs<T extends string>({
  value,
  onChange,
  items,
  label,
  end,
}: {
  value: T
  onChange: (v: T) => void
  items: readonly HeaderTab<T>[]
  label: string
  end?: ReactNode
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  useOpenInView(rowRef, '[aria-selected="true"]', [value, signalKey(items)])
  const fade = useEdgeFade(rowRef)
  return (
    <div className="flex items-end gap-4">
      <div ref={rowRef} role="tablist" aria-label={label} style={fade} className={`flex min-w-0 gap-6 ${SCROLL_ROW}`}>
        {items.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={value === t.id}
            title={t.about}
            data-testid={t.testId}
            onClick={() => onChange(t.id)}
            className={`-mb-px flex shrink-0 items-baseline gap-1.5 whitespace-nowrap border-b-2 py-2.5 text-[13.5px] transition-colors ${
              value === t.id ? 'border-terracotta text-ink' : 'border-transparent text-ink-2 hover:text-ink'
            }`}
          >
            <span>{t.label}</span>
            {t.signal !== undefined && t.signal !== null ? <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{t.signal}</span> : null}
          </button>
        ))}
      </div>
      {end ? <div className="ml-auto flex shrink-0 items-center gap-0.5 self-center pb-px">{end}</div> : null}
    </div>
  )
}

// SectionTabs — the sections of a place (an agent, a project): the band's
// last row, under a PageHeader that passes `joined`, so the tabs sit where
// HeaderTabs puts a root page's views — one tab row in the product, in one
// place. A section is an address (aria-current), not a view of one
// list (role=tab). `end` pins a section to the row's right edge (an agent's
// Settings).
export interface SectionTab<T extends string> {
  id: T
  label: ReactNode
  signal?: ReactNode
  end?: boolean
}

export function SectionTabs<T extends string>({
  value,
  onGo,
  items,
  label,
}: {
  value: T
  onGo: (v: T) => void
  items: readonly SectionTab<T>[]
  label: string
}) {
  // a narrow row scrolls sideways, the open section in view (useOpenInView)
  const navRef = useRef<HTMLElement>(null)
  useOpenInView(navRef, '[aria-current="page"]', [value, signalKey(items)])
  return (
    <nav ref={navRef} aria-label={label} className={`flex shrink-0 gap-6 border-b border-line bg-panel px-4 sm:px-5 ${SCROLL_ROW}`}>
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onGo(t.id)}
          aria-current={value === t.id ? 'page' : undefined}
          className={`-mb-px flex shrink-0 items-baseline gap-1.5 whitespace-nowrap border-b-2 py-2.5 text-[13.5px] transition-colors ${t.end ? 'ml-auto' : ''} ${value === t.id ? 'border-terracotta text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
        >
          <span>{t.label}</span>
          {t.signal ? <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{t.signal}</span> : null}
        </button>
      ))}
    </nav>
  )
}
