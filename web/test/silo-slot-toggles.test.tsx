// silo-slot-toggles.test.tsx — the owner's on/off for each place a silo
// shows in (support's pulse is born off and turns on from here).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RecordsTable, SlotToggles } from '../src/components/silo/SiloPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>()
  return { ...real, api: { ...real.api, silos: { ...real.api.silos, operator: vi.fn() } } }
})

const operator = vi.mocked(api.silos.operator)

beforeEach(() => {
  operator.mockReset()
  useStore.setState({ loadSilos: vi.fn(async () => {}) } as never)
})

const support = { id: 'support', slots: { requested: ['pulse', 'needs-you', 'rail'], granted: ['needs-you', 'rail'], off: ['pulse'] } }

describe('SlotToggles', () => {
  it('a button for every requested place, the off one not pressed', () => {
    render(<SlotToggles silo={support} />)
    const pulse = screen.getByRole('button', { name: "Home's pulse" })
    expect(pulse).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Needs you' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'the rail' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('turning the pulse on sends slotsOff without it and re-reads the silos', async () => {
    operator.mockResolvedValue({})
    render(<SlotToggles silo={support} />)
    fireEvent.click(screen.getByRole('button', { name: "Home's pulse" }))
    await waitFor(() => expect(operator).toHaveBeenCalledWith('support', { slotsOff: [] }))
    expect(useStore.getState().loadSilos).toHaveBeenCalled()
  })

  it('turning a place off adds it to slotsOff', async () => {
    operator.mockResolvedValue({})
    render(<SlotToggles silo={support} />)
    fireEvent.click(screen.getByRole('button', { name: 'the rail' }))
    await waitFor(() => expect(operator).toHaveBeenCalledWith('support', { slotsOff: ['pulse', 'rail'] }))
  })

  it("the server's refusal is said in its own words", async () => {
    operator.mockRejectedValue(new Error('support is not installed'))
    render(<SlotToggles silo={support} />)
    fireEvent.click(screen.getByRole('button', { name: "Home's pulse" }))
    expect(await screen.findByText('support is not installed')).toBeInTheDocument()
  })

  it('a silo that asks for no places renders nothing', () => {
    const { container } = render(<SlotToggles silo={{ id: 'x', slots: { requested: [], granted: [], off: [] } }} />)
    expect(container).toBeEmptyDOMElement()
  })
})

// A past moment in a silo's list reads relative, the exact
// moment one hover away — every silo, not only support.
describe('RecordsTable — the at column', () => {
  it('says how long ago, with the exact moment as the title', () => {
    const now = Date.parse('2026-11-02T18:00:00Z')
    useStore.setState({ nowTick: now, agents: [] } as never)
    const at = '2026-11-02T16:00:00Z'
    render(
      <RecordsTable
        page={{
          silo: { id: 's', name: 'S', state: 'active', freshness: null },
          kind: { name: 'case', states: [], columns: ['identity', 'at'], facets: [] },
          total: 1,
          matching: 1,
          offset: 0,
          limit: 50,
          said: null,
          unreadable: { count: 0, items: [] },
          records: [
            {
              key: 'k',
              id: 'k',
              identity: 'A case',
              state: null,
              stateLabel: '',
              at,
              anchors: {},
              cells: [
                { column: 'identity', text: 'A case' },
                { column: 'at', text: 'Nov 2, 16:00 UTC' },
              ],
              row: '',
              folded: false,
              overlay: false,
              conflict: false,
              remarks: [],
              file: null,
            },
          ],
        }}
        onOpen={() => {}}
      />,
    )
    const cell = screen.getAllByText('2h ago')[0] as HTMLElement
    expect(cell.closest('td')).toHaveAttribute('title', 'Nov 2, 16:00 UTC')
  })
})
