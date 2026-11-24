// FacetBar.tsx — FacetFilter: the filter layer over lists. A row of
// dropdown chips, one per facet with real data (a facet with no values
// isn't painted — proof-of-life: the vocabulary ALWAYS comes from the
// list, never from a constant). Each SURFACE owns the filter's state
// (local useState, a UI session, never persisted — a filter is a gesture,
// not a setting); this component only paints it and mutates it via onChange.
//
// Visual language: mono, still, ink — the same calm chips as Badge / the
// Board card's metadata. Terracotta stays reserved (as throughout the app)
// for what's urgent; here an active selection only rises to ink and gains
// its count dot. A popover with the same pattern as RowMenu
// (Sidebar.tsx): clicking outside or Escape closes it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { hasFilter, clearFacet, selectionCount, toggleValue, type Facet, type ActiveFilter } from '../lib/facets'

function FacetChip({ facet, filter, onChange }: { facet: Facet; filter: ActiveFilter; onChange: (f: ActiveFilter) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  // a chip pinned to the viewport's right edge (narrow mobile) would open
  // its popover off-screen — measured on open (useLayoutEffect, before
  // paint) and if it overflows it anchors to the chip's right; the
  // popover's max-w covers the extreme case of a viewport narrower than the popover itself.
  const [anchorRight, setAnchorRight] = useState(false)
  useLayoutEffect(() => {
    if (!open) {
      setAnchorRight(false)
      return
    }
    const rect = popRef.current?.getBoundingClientRect()
    if (rect && rect.right > window.innerWidth - 8) setAnchorRight(true)
  }, [open])
  const selection = filter[facet.id]
  const n = selectionCount(filter, facet.id)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: globalThis.MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') {
        // stopPropagation() cuts the rest of the DOM path, but NOT the
        // other listeners already registered on `document` — AgentPage's
        // global Esc (mounted earlier) still runs, and its priority "a
        // turn in progress ALWAYS cancels first" is documented there on
        // purpose. The same pattern inherited from RowMenu.
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // a summary inside the active chip: the single chosen value's label, or
  // the count if there are several — the full detail lives in the dropdown.
  const summary = n === 0 ? null : n === 1 ? (facet.values.find((v) => selection?.has(v.value))?.label ?? '1') : String(n)

  return (
    <div ref={ref} className="relative shrink-0">
      <span
        className={`inline-flex items-center overflow-hidden rounded-full border font-mono text-[11px] transition-colors duration-150 ${
          n > 0 ? 'border-line bg-panel text-ink' : 'border-line text-ink-2 hover:text-ink'
        }`}
      >
        <button
          type="button"
          aria-label={`filter by ${facet.label}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 py-0.5 pl-2 pr-1.5 hover:bg-canvas/60"
        >
          <span>{facet.label}</span>
          {summary !== null ? (
            <>
              <span aria-hidden="true" className="text-ink-2">
                ·
              </span>
              <span className="max-w-[9rem] truncate">{summary}</span>
            </>
          ) : null}
          <ChevronDown size={10} aria-hidden="true" className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </button>
        {n > 0 ? (
          <button
            type="button"
            aria-label={`clear ${facet.label} filter`}
            onClick={() => onChange(clearFacet(filter, facet.id))}
            className="border-l border-line px-1 py-0.5 text-ink-2 hover:bg-canvas/60 hover:text-ink"
          >
            <X size={10} aria-hidden="true" />
          </button>
        ) : null}
      </span>

      {open ? (
        <div
          ref={popRef}
          role="listbox"
          aria-label={`${facet.label} values`}
          aria-multiselectable="true"
          className={`absolute top-full z-30 mt-1 max-h-64 min-w-[11rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-lg ${
            anchorRight ? 'right-0' : 'left-0'
          }`}
        >
          {facet.values.map((v) => {
            const active = selection?.has(v.value) ?? false
            return (
              <button
                key={v.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => onChange(toggleValue(filter, facet.id, v.value))}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left font-mono text-[11px] transition-colors duration-100 ${
                  active ? 'text-ink' : 'text-ink-2 hover:bg-canvas/60 hover:text-ink'
                }`}
              >
                <span className="w-3 shrink-0">{active ? <Check size={11} aria-hidden="true" /> : null}</span>
                <span className="min-w-0 flex-1 truncate">{v.label}</span>
                {/* an honest count, computed from the real list — 0 can
                    only be seen on a value that's still selected but that
                    other facets have emptied out (the engine omits
                    unselected zeros). */}
                <span className="shrink-0 text-[10px] text-ink-2">{v.count}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function FacetBar({
  facets,
  filter,
  onChange,
  className = '',
}: {
  facets: Facet[]
  filter: ActiveFilter
  onChange: (f: ActiveFilter) => void
  className?: string
}) {
  // only facets with real values; if none have data AND nothing is
  // selected, the whole bar disappears (the list doesn't gain empty chrome).
  const visible = facets.filter((f) => f.values.length > 0)
  const active = hasFilter(filter)
  if (visible.length === 0 && !active) return null

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {visible.map((f) => (
        <FacetChip key={f.id} facet={f} filter={filter} onChange={onChange} />
      ))}
      {active ? (
        <button
          type="button"
          onClick={() => onChange({})}
          className="rounded-full px-2 py-0.5 font-mono text-[11px] text-ink-2 underline-offset-2 hover:text-ink hover:underline"
        >
          Clear all
        </button>
      ) : null}
    </div>
  )
}

// A narrowing that is not a facet of the list — an address-only view of a
// tab (Tasks › Open narrowed to «ready, nobody on it»), or one agent on a
// page that has no facet bar (Usage): said as the active chip says a facet,
// ink on panel, its ✕ the way back to the whole tab.
export function NarrowChip({ label, value, onClear, testId }: { label: string; value: string; onClear: () => void; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex shrink-0 items-center overflow-hidden rounded-full border border-line bg-panel font-mono text-[11px] text-ink"
    >
      <span className="inline-flex items-center gap-1 py-0.5 pl-2 pr-1.5">
        <span>{label}</span>
        <span aria-hidden="true" className="text-ink-2">
          ·
        </span>
        <span className="max-w-[14rem] truncate">{value}</span>
      </span>
      <button
        type="button"
        aria-label={`clear ${label}: ${value}`}
        title={`Show all — clear «${value}»`}
        onClick={onClear}
        className="border-l border-line px-1 py-0.5 text-ink-2 hover:bg-canvas/60 hover:text-ink"
      >
        <X size={10} aria-hidden="true" />
      </button>
    </span>
  )
}
