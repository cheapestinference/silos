// facet-bar.test.tsx — FacetBar (the component): chips per facet with
// data, empty facets hidden, toggling values, clearing a single facet (×)
// and "Clear all". The engine (OR/AND, counts) has its own suite in
// facets.test.ts — here only the UI ↔ ActiveFilter contract.
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { FacetBar } from '../src/components/FacetBar'
import type { Facet, ActiveFilter } from '../src/lib/facets'

const facets: Facet[] = [
  {
    id: 'state',
    label: 'state',
    values: [
      { value: 'working', label: 'Working', count: 2 },
      { value: 'idle', label: 'Idle', count: 1 },
    ],
  },
  { id: 'tool', label: 'tool', values: [] }, // no data → not painted
  { id: 'project', label: 'project', values: [{ value: 'silos', label: 'silos', count: 3 }] },
]

// a harness with real state, the way surfaces mount it (a local useState).
function Harness({ initial = {} }: { initial?: ActiveFilter }) {
  const [filter, setFilter] = useState<ActiveFilter>(initial)
  return <FacetBar facets={facets} filter={filter} onChange={setFilter} />
}

describe('FacetBar', () => {
  it('paints a chip per facet WITH values; the empty facet hides itself', () => {
    render(<Harness />)
    expect(screen.getByLabelText('filter by state')).toBeInTheDocument()
    expect(screen.getByLabelText('filter by project')).toBeInTheDocument()
    expect(screen.queryByLabelText('filter by tool')).not.toBeInTheDocument()
  })

  it('with no facets carrying values and no active filter, the whole bar disappears', () => {
    const { container } = render(<FacetBar facets={[{ id: 'x', label: 'x', values: [] }]} filter={{}} onChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('opening the chip lists values with their count; clicking toggles the selection', () => {
    render(<Harness />)
    fireEvent.click(screen.getByLabelText('filter by state'))
    const option = screen.getByRole('option', { name: /Working/ })
    expect(option).toHaveTextContent('2')
    expect(option).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(option)
    expect(screen.getByRole('option', { name: /Working/ })).toHaveAttribute('aria-selected', 'true')
    // the active chip summarizes the selection
    expect(screen.getByLabelText('filter by state')).toHaveTextContent('state·Working')
  })

  it("the active chip's × clears ONLY that facet, in one click", () => {
    render(<Harness initial={{ state: new Set(['working']), project: new Set(['silos']) }} />)
    fireEvent.click(screen.getByLabelText('clear state filter'))
    expect(screen.queryByLabelText('clear state filter')).not.toBeInTheDocument()
    expect(screen.getByLabelText('clear project filter')).toBeInTheDocument()
  })

  it('"Clear all" only appears with something active and clears everything', () => {
    render(<Harness />)
    expect(screen.queryByText('Clear all')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('filter by state'))
    fireEvent.click(screen.getByRole('option', { name: /Idle/ }))
    fireEvent.click(screen.getByText('Clear all'))
    expect(screen.queryByText('Clear all')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('clear state filter')).not.toBeInTheDocument()
  })

  // an honest name — stopPropagation does NOT shield other listeners on
  // `document` itself (AgentPage's global Esc runs before it, and its
  // cancel-turn-first priority is intentional); here only the dropdown
  // closing is contracted.
  it('Escape closes the dropdown (the global Esc priority lives in AgentPage, not here)', () => {
    render(<Harness />)
    fireEvent.click(screen.getByLabelText('filter by state'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  // a viewport edge case: if the popover would overflow on the right, it
  // anchors right-0 to the chip instead of spilling off-screen.
  it('the dropdown anchors to the right when it would overflow the viewport', () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ right: window.innerWidth + 100, left: 0, top: 0, bottom: 0, width: 176, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    try {
      render(<Harness />)
      fireEvent.click(screen.getByLabelText('filter by state'))
      expect(screen.getByRole('listbox').className).toContain('right-0')
    } finally {
      spy.mockRestore()
    }
  })

  it('with no overflow, the dropdown stays anchored to the left (the normal case)', () => {
    render(<Harness />)
    fireEvent.click(screen.getByLabelText('filter by state'))
    expect(screen.getByRole('listbox').className).toContain('left-0')
  })
})
