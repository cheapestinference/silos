// SilosPage (/silos) — the QUIET inventory (not the center of attention):
// the four groups + the install door, moved here from Settings › Silos.
// Same behaviors, new house; the live pulse term rides each active row.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SilosPage } from '../src/components/silo/SilosPage'
import { useStore } from '../src/store'
import { api, ApiError } from '../src/lib/api'

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>()
  const { vi: v } = await import('vitest')
  const mocked = v.mockObject ? v.mockObject(real) : real
  return { ...mocked, ApiError: real.ApiError }
})
const mockedApi = vi.mocked(api, { deep: true })

describe('SilosPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useStore.setState({ page: { kind: 'settings', tab: 'silos' }, siloTick: 0 })
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [] })
  })

  it('an active silo breathes its live pulse term in its row', async () => {
    mockedApi.silos.list.mockResolvedValue({
      silos: [
        {
          id: 'invoices',
          name: 'Invoices',
          description: null,
          version: '0.1.1',
          apiVersion: 'silo-standard/v0',
          state: 'active',
          reason: 'active',
          conventions: [],
          wants: [],
          kinds: ['invoices/invoice'],
          producer: { role: 'finance', sync: 'Ledgerly' },
          records: { parsed: 1161, failed: 0 },
          lastWrite: null,
          freshness: null,
          slots: { requested: [], granted: [], off: [] },
          observedAt: '',
          producers: ['finance'],
        },
      ],
      uninstalled: [],
    })
    mockedApi.board.mockResolvedValue({
      cards: [],
      needsYou: [],
      inbox: [],
      silos: { pulse: [{ silo: 'invoices', siloName: 'Invoices', term: '$39,540.56 outstanding' }], done: [] },
    })
    render(<SilosPage />)
    const row = await screen.findByTestId('silo-installed-invoices')
    expect(row).toHaveTextContent('$39,540.56 outstanding')
    expect(row).toHaveTextContent('1161')
  })

  it('with none yet, the install door still stands', async () => {
    mockedApi.silos.list.mockResolvedValue({ silos: [], uninstalled: [] })
    render(<SilosPage />)
    expect(await screen.findByTestId('silo-door-open')).toBeInTheDocument()
  })

  it('an optional silo Silos ships; Install… submits and opens the dialog', async () => {
    mockedApi.silos.list.mockResolvedValue({
      silos: [],
      uninstalled: [],
      available: [{ id: 'hierarchy', name: 'Hierarchy', description: 'who reports to whom', version: '0.1.0' }],
    })
    mockedApi.silos.installAvailable.mockResolvedValue({ submission: { id: 'hierarchy' } })
    render(<SilosPage />)
    const row = await screen.findByTestId('silo-available-hierarchy')
    expect(within(row).getByText('Hierarchy')).toBeInTheDocument()
    expect(within(row).getByText('who reports to whom')).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'Install…' }))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'hierarchy', review: true }))
    expect(mockedApi.silos.installAvailable).toHaveBeenCalledWith('hierarchy')
  })

  it("the door says a JSON typo in place, shows the validator's words, and a good paste opens the dialog", async () => {
    mockedApi.silos.list.mockResolvedValue({ silos: [], uninstalled: [] })
    render(<SilosPage />)
    fireEvent.click(await screen.findByTestId('silo-door-open'))
    const text = screen.getByTestId('silo-door-text')
    fireEvent.change(text, { target: { value: '{nope' } })
    fireEvent.click(screen.getByTestId('silo-door-submit'))
    expect(await screen.findByTestId('silo-door-error')).toHaveTextContent('That is not JSON yet')
    expect(mockedApi.silos.submitManifest).not.toHaveBeenCalled()
    // the server's exact words, where the paste happened
    mockedApi.silos.submitManifest.mockRejectedValueOnce(
      new ApiError('validation failed', 422, { validation: { errors: [{ where: 'metadata.id', message: 'is required' }] } }),
    )
    fireEvent.change(text, { target: { value: '{}' } })
    fireEvent.click(screen.getByTestId('silo-door-submit'))
    expect(await screen.findByTestId('silo-door-error')).toHaveTextContent('metadata.id: is required')
    // a valid manifest lands on the review dialog
    mockedApi.silos.submitManifest.mockResolvedValueOnce({ submission: { id: 'door' } })
    fireEvent.change(text, { target: { value: '{"metadata":{"id":"door"}}' } })
    fireEvent.click(screen.getByTestId('silo-door-submit'))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'door', review: true }))
  })

  // Settings › Silos: the three groups from GET /api/silos,
  // and the gestures hand over to the install dialog — never approve here.
  it('installed / waiting / uninstalled, and Reinstall… opens the dialog after submitting', async () => {
    const base = {
      description: null,
      apiVersion: 'silo-standard/v0',
      conventions: [],
      wants: [],
      kinds: [],
      lastWrite: null,
      freshness: null,
      slots: { requested: [], granted: [], off: [] },
      observedAt: '',
    }
    mockedApi.silos.list.mockResolvedValue({
      silos: [
        {
          ...base,
          id: 'invoices',
          name: 'Invoices',
          version: '0.1.0',
          state: 'active',
          reason: 'active',
          producer: { role: 'finance', sync: null },
          records: { parsed: 3, failed: 0 },
          producers: ['finance'],
          submission: null,
          automation: null,
        },
        {
          ...base,
          id: 'support',
          name: 'Support',
          version: '0.1.0',
          state: 'pending',
          reason: 'waiting',
          producer: { role: 'support', sync: null },
          records: { parsed: 0, failed: 0 },
          producers: null,
          submission: null,
          automation: null,
        },
      ],
      uninstalled: [
        {
          id: 'documents',
          name: 'Documents',
          uninstalledAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          producers: ['finance'],
          kept: { files: 4, records: null, conventions: [], overlayAndJournal: [] },
          grown: 0,
          manifest: { version: '0.1.0', keptAt: '' },
          automation: null,
          submission: null,
        },
      ],
    })
    mockedApi.silos.resubmit.mockResolvedValue({ submission: { id: 'documents', submittedBy: 'owner', at: '', state: 'pending' } })
    render(<SilosPage />)
    // one gallery of tiles, no group headings (never stacked lists) — each
    // tile says its state in its name line
    const installed = await screen.findByTestId('silo-installed-invoices')
    const waiting = screen.getByTestId('silo-waiting-support')
    const uninstalled = screen.getByTestId('silo-uninstalled-documents')
    for (const h of ['Installed', 'Waiting for approval', 'Available', 'Uninstalled']) expect(screen.queryByRole('heading', { name: h })).toBeNull()
    expect(installed).toHaveTextContent(/^Active/)
    expect(within(installed).getByText('3 records · written by finance')).toBeInTheDocument()
    // the installed tile is itself the door to the silo page
    expect(installed.tagName).toBe('BUTTON')
    expect(waiting).toHaveTextContent(/^Waiting for approval/)
    expect(within(waiting).getByRole('button', { name: 'Submit for approval…' })).toBeInTheDocument()
    expect(uninstalled).toHaveTextContent(/^Uninstalled/)
    expect(within(uninstalled).getByText(/4 files stay on disk/)).toBeInTheDocument()
    // order: installed, then what waits on you, then the uninstalled
    expect(installed.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(waiting.compareDocumentPosition(uninstalled) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(within(uninstalled).getByRole('button', { name: 'Reinstall 0.1.0…' }))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'documents', review: true }))
    expect(mockedApi.silos.resubmit).toHaveBeenCalledWith('documents')
  })
})
