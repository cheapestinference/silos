// facets.ts — FacetFilter: a GENERIC facet engine.
//
// Doctrine (binding):
// - Facets are NOT navigation — they're a FILTER LAYER over a list that's
//   already in front of you (as primary navigation they have no use case;
//   as a filter layer over lists they do).
// - A single engine for Board, ⌘K, Conversations and Automations — this
//   module is the seed for v2's dimensions (framework and skill will
//   arrive as new extractors, without touching the engine).
// - Proof-of-life: each facet's values and counts are COMPUTED from the
//   real list being filtered — never from a static vocabulary.
// - AND semantics: several values WITHIN a facet = OR; between facets = AND.
// - The filter's state is PER SURFACE and lives in the UI session (a local
//   useState, never persisted): a filter is a gesture, not a setting.
//   Each surface (Board/Conversations, Board/Automations, the sidebar's
//   "Show all"…) has its own independent ActiveFilter.
//
// a ⌘K hook point (documented on purpose, no UI yet): the palette
// (CommandPalette.tsx) already flattens everything with allConversations()
// — when its turn comes, it defines its own FacetExtractor<ConversationItem>
// (the ones in facet-surfaces.ts serve as a template) and calls
// applyFilter/computeFacets over that same list. The engine knows nothing
// about React or surfaces: pure functions over arrays.

export interface FacetValue {
  value: string
  label: string
  count: number
}

export interface Facet {
  id: string
  label: string
  values: FacetValue[]
}

// the active selection: facetId -> the set of chosen values. A facet with
// no entry (or an empty set) restricts nothing.
export type ActiveFilter = Readonly<Record<string, ReadonlySet<string>>>

export const NO_FILTER: ActiveFilter = {}

export interface RawValue {
  value: string
  label?: string // absent = the value itself
}

// an extractor defines ONE axis over a surface's items: which values each
// item has on that axis (0..n — an item can contribute several values,
// e.g. several tools) and how to order the dropdown.
export interface FacetExtractor<T> {
  id: string
  label: string
  valuesOf: (item: T) => readonly RawValue[]
  // the dropdown's order; defaults to count desc, label asc.
  compare?: (a: FacetValue, b: FacetValue) => number
}

export function hasFilter(filter: ActiveFilter): boolean {
  return Object.values(filter).some((sel) => sel.size > 0)
}

export function selectionCount(filter: ActiveFilter, facetId: string): number {
  return filter[facetId]?.size ?? 0
}

function passesFacet<T>(item: T, ex: FacetExtractor<T>, selection: ReadonlySet<string>): boolean {
  // OR within the facet: it's enough for ONE of the item's values to be selected.
  return ex.valuesOf(item).some((v) => selection.has(v.value))
}

// AND between facets: the item must pass EVERY facet that has a
// selection. A facetId present in the filter with no extractor on this
// surface is ignored (leftover state from another surface never empties a
// list it doesn't belong to).
export function passesFilter<T>(item: T, extractors: readonly FacetExtractor<T>[], filter: ActiveFilter): boolean {
  return extractors.every((ex) => {
    const sel = filter[ex.id]
    return !sel || sel.size === 0 || passesFacet(item, ex, sel)
  })
}

export function applyFilter<T>(items: readonly T[], extractors: readonly FacetExtractor<T>[], filter: ActiveFilter): T[] {
  if (!hasFilter(filter)) return [...items]
  return items.filter((item) => passesFilter(item, extractors, filter))
}

const byDefault = (a: FacetValue, b: FacetValue): number => b.count - a.count || a.label.localeCompare(b.label)

// computes the facets (values + honest counts) for the given list. The
// classic faceted-search convention: facet F is counted over the items
// that pass EVERY OTHER facet — if it were counted over the final result,
// choosing a value would zero out its siblings and the OR within the
// facet would become unreachable. That way each value's count answers the
// honest question "how many would you see if you added/removed this value?".
// A SELECTED value stays listed even if other facets bring it down to 0
// (otherwise there'd be no way to deselect it); a value that is NOT
// selected with a count of 0 is omitted. A facet with no values (an empty
// list or an axis with no real data) comes out with values:[] — the UI hides it entirely.
export function computeFacets<T>(items: readonly T[], extractors: readonly FacetExtractor<T>[], filter: ActiveFilter): Facet[] {
  // labels from the WHOLE corpus (unfiltered) — so a selected value that
  // drops to 0 keeps its pretty label, not the raw value.
  const labels = new Map<string, Map<string, string>>()
  for (const ex of extractors) {
    const byValue = new Map<string, string>()
    for (const item of items) {
      for (const v of ex.valuesOf(item)) {
        if (!byValue.has(v.value)) byValue.set(v.value, v.label ?? v.value)
      }
    }
    labels.set(ex.id, byValue)
  }

  return extractors.map((ex) => {
    const others = extractors.filter((o) => o.id !== ex.id)
    const base = items.filter((item) => passesFilter(item, others, filter))
    const tally = new Map<string, FacetValue>()
    for (const item of base) {
      for (const v of ex.valuesOf(item)) {
        const previous = tally.get(v.value)
        if (previous) previous.count += 1
        else tally.set(v.value, { value: v.value, label: v.label ?? v.value, count: 1 })
      }
    }
    const sel = filter[ex.id]
    if (sel) {
      for (const value of sel) {
        if (!tally.has(value)) {
          tally.set(value, { value, label: labels.get(ex.id)?.get(value) ?? value, count: 0 })
        }
      }
    }
    const values = [...tally.values()].sort(ex.compare ?? byDefault)
    return { id: ex.id, label: ex.label, values }
  })
}

// --- immutable filter mutations (for each surface's useState) ---

export function toggleValue(filter: ActiveFilter, facetId: string, value: string): ActiveFilter {
  const current = new Set(filter[facetId] ?? [])
  if (current.has(value)) current.delete(value)
  else current.add(value)
  const next: Record<string, ReadonlySet<string>> = { ...filter }
  if (current.size === 0) delete next[facetId]
  else next[facetId] = current
  return next
}

export function clearFacet(filter: ActiveFilter, facetId: string): ActiveFilter {
  if (!(facetId in filter)) return filter
  const next: Record<string, ReadonlySet<string>> = { ...filter }
  delete next[facetId]
  return next
}
