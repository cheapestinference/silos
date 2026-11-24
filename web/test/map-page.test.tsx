// map-page.test.tsx — the Map's views (Uses · Org — the five-lane view and
// then the Wiring graph retired). Standalone the views
// drive `page.view` through the store (changePage), embedded (a project's
// Map tab) they are local state — see MapPage.tsx's `mode`/`localMode`.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MapPage } from '../src/components/MapPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ page: { kind: 'map' }, connection: 'connected', silos: [] })
  mockedApi.uses.mockResolvedValue({
    rows: [],
    cols: [],
    cells: [],
    sessions: [],
    measure: 'tokens',
    considered: 0,
    truncated: { rows: 0, cols: 0 },
    now: Date.now(),
  })
})

describe('MapPage — its views', () => {
  it('the bare Map is Uses; without a reporting silo there is no Org door', async () => {
    const { container } = render(<MapPage />)
    expect(await screen.findByRole('tab', { name: 'Uses' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Uses'])
    await waitFor(() => expect(mockedApi.uses).toHaveBeenCalled())
    expect(container.querySelector('[data-page="uses"]')).toBeTruthy()
  })

  it('embedded in a project, it opens on Uses for that folder only and the store page is untouched', async () => {
    render(<MapPage embedded projectFolder="/home/u/ci" />)
    expect(await screen.findByRole('tab', { name: 'Uses' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(mockedApi.uses).toHaveBeenCalledWith(expect.objectContaining({ folder: '/home/u/ci' })))
    expect(useStore.getState().page).toEqual({ kind: 'map' })
  })
})
