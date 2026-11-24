// facets.test.ts — the generic FacetFilter engine: OR/AND semantics, an
// honest count convention (each facet is counted against the OTHERS),
// empty facets, and the filter's immutable mutations.
import { describe, expect, it } from 'vitest'
import {
  applyFilter,
  computeFacets,
  hasFilter,
  clearFacet,
  selectionCount,
  passesFilter,
  NO_FILTER,
  toggleValue,
  type FacetExtractor,
  type ActiveFilter,
} from '../src/lib/facets'

interface Item {
  color: string
  size: string
  tags: string[]
}

const items: Item[] = [
  { color: 'red', size: 'S', tags: ['a'] },
  { color: 'red', size: 'M', tags: ['a', 'b'] },
  { color: 'blue', size: 'M', tags: [] },
  { color: 'blue', size: 'L', tags: ['b'] },
]

const extractors: FacetExtractor<Item>[] = [
  { id: 'color', label: 'color', valuesOf: (i) => [{ value: i.color }] },
  { id: 'size', label: 'size', valuesOf: (i) => [{ value: i.size }] },
  { id: 'tag', label: 'tag', valuesOf: (i) => i.tags.map((t) => ({ value: t })) },
]

function filter(spec: Record<string, string[]>): ActiveFilter {
  return Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, new Set(v)]))
}

describe("applyFilter — the engine's semantics (∧ between facets, OR within)", () => {
  it('with no active filter, returns every item', () => {
    expect(applyFilter(items, extractors, NO_FILTER)).toHaveLength(4)
  })

  it('a value in one facet restricts to items with that value', () => {
    const out = applyFilter(items, extractors, filter({ color: ['red'] }))
    expect(out.map((i) => i.size)).toEqual(['S', 'M'])
  })

  it('several values WITHIN a facet are OR', () => {
    const out = applyFilter(items, extractors, filter({ size: ['S', 'L'] }))
    expect(out.map((i) => i.color)).toEqual(['red', 'blue'])
  })

  it('between facets it is AND (color=red ∧ size=M)', () => {
    const out = applyFilter(items, extractors, filter({ color: ['red'], size: ['M'] }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ color: 'red', size: 'M' })
  })

  it("a multi-value extractor (tags) matches if ANY of the item's values is chosen", () => {
    const out = applyFilter(items, extractors, filter({ tag: ['b'] }))
    expect(out).toHaveLength(2)
  })

  it('a facet id with no extractor on this surface is ignored (state left over from another surface)', () => {
    const out = applyFilter(items, extractors, filter({ nonexistent: ['x'] }))
    expect(out).toHaveLength(4)
  })

  it('passesFilter exposes the same criterion item by item', () => {
    expect(passesFilter(items[0]!, extractors, filter({ color: ['blue'] }))).toBe(false)
    expect(passesFilter(items[2]!, extractors, filter({ color: ['blue'] }))).toBe(true)
  })
})

describe('computeFacets — values and counts derived from the real list', () => {
  it('with no filter: counts = the real frequency in the list', () => {
    const [color, size, tag] = computeFacets(items, extractors, NO_FILTER)
    expect(color!.values).toEqual([
      { value: 'blue', label: 'blue', count: 2 },
      { value: 'red', label: 'red', count: 2 },
    ])
    expect(size!.values.find((v) => v.value === 'M')?.count).toBe(2)
    expect(tag!.values.map((v) => [v.value, v.count])).toEqual([
      ['a', 2],
      ['b', 2],
    ])
  })

  it('a facet is counted against the OTHER facets, not against itself (a reachable OR)', () => {
    const f = filter({ color: ['red'] })
    const [color, size] = computeFacets(items, extractors, f)
    // color's siblings stay counted over the full list — choosing 'red'
    // doesn't set 'blue' to 0.
    expect(color!.values.find((v) => v.value === 'blue')?.count).toBe(2)
    // size IS restricted by color=red: L disappears (count 0, not
    // selected → omitted).
    expect(size!.values.map((v) => v.value).sort()).toEqual(['M', 'S'])
  })

  it('a SELECTED value stays listed with count 0 if other facets empty it out', () => {
    const f = filter({ color: ['blue'], tag: ['a'] })
    // tag=a only exists on red items → with color=blue, 'a' drops to 0 but
    // stays listed (it must be possible to deselect it), with its original label.
    const tag = computeFacets(items, extractors, f).find((x) => x.id === 'tag')
    expect(tag!.values.find((v) => v.value === 'a')).toEqual({ value: 'a', label: 'a', count: 0 })
  })

  it('a facet with no real data comes out with values:[] (the UI hides it)', () => {
    const noTags = items.map((i) => ({ ...i, tags: [] }))
    const tag = computeFacets(noTags, extractors, NO_FILTER).find((x) => x.id === 'tag')
    expect(tag!.values).toEqual([])
  })

  it('an empty list → every facet empty', () => {
    for (const f of computeFacets([], extractors, NO_FILTER)) expect(f.values).toEqual([])
  })

  it('respects `compare` (a custom dropdown order)', () => {
    const order = ['S', 'M', 'L']
    const ex: FacetExtractor<Item>[] = [
      { id: 'size', label: 'size', valuesOf: (i) => [{ value: i.size }], compare: (a, b) => order.indexOf(a.value) - order.indexOf(b.value) },
    ]
    const [size] = computeFacets(items, ex, NO_FILTER)
    expect(size!.values.map((v) => v.value)).toEqual(['S', 'M', 'L'])
  })

  it("uses the extractor's label when it provides one", () => {
    const ex: FacetExtractor<Item>[] = [{ id: 'color', label: 'color', valuesOf: (i) => [{ value: i.color, label: i.color.toUpperCase() }] }]
    const [color] = computeFacets(items, ex, NO_FILTER)
    expect(color!.values.find((v) => v.value === 'red')?.label).toBe('RED')
  })
})

describe('filter mutations (immutable) + helpers', () => {
  it('toggleValue adds and removes; once empty, the facet disappears from the filter', () => {
    const f1 = toggleValue(NO_FILTER, 'color', 'red')
    expect([...f1.color!]).toEqual(['red'])
    const f2 = toggleValue(f1, 'color', 'blue')
    expect(f2.color!.size).toBe(2)
    const f3 = toggleValue(toggleValue(f2, 'color', 'red'), 'color', 'blue')
    expect('color' in f3).toBe(false)
    expect(hasFilter(f3)).toBe(false)
  })

  it('toggleValue does not mutate the original filter', () => {
    const f = filter({ color: ['red'] })
    toggleValue(f, 'color', 'blue')
    expect([...f.color!]).toEqual(['red'])
  })

  it('clearFacet clears only that facet', () => {
    const f = clearFacet(filter({ color: ['red'], size: ['M'] }), 'color')
    expect('color' in f).toBe(false)
    expect([...f.size!]).toEqual(['M'])
  })

  it('hasFilter / selectionCount', () => {
    expect(hasFilter(NO_FILTER)).toBe(false)
    const f = filter({ size: ['S', 'L'] })
    expect(hasFilter(f)).toBe(true)
    expect(selectionCount(f, 'size')).toBe(2)
    expect(selectionCount(f, 'color')).toBe(0)
  })
})
