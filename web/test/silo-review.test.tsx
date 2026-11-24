// silo-review.test.tsx — the install dialog (Silo Standard: install, approve): it paints
// the server's consequences and derives nothing — the author's words apart,
// as a quote; what Silos derived as the authority (the preview with its
// basis, exact paths, requirements); a binding change re-asks the server;
// the automation is opt-in (off by default); Install lands on the silo's
// page, Reject says the decision in place.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SiloReviewPage } from '../src/components/silo/SiloReviewPage'
import { useStore } from '../src/store'
import { api, ApiError } from '../src/lib/api'
import type { AgentView, SiloConsequences } from '../src/lib/types'

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>()
  const mock = (o: object): object =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : typeof v === 'object' && v !== null ? mock(v) : v]))
  return { ...real, api: mock(real.api) }
})
const mockedApi = vi.mocked(api, { deep: true })

const agent = (id: string, name: string, emoji: string): AgentView => ({ id, name, emoji, archived: false, sessions: [] }) as unknown as AgentView

const consequences = (over: Partial<SiloConsequences> = {}, derived: Partial<SiloConsequences['derived']> = {}): SiloConsequences => ({
  id: 'invoices',
  name: 'Invoices',
  submittedBy: 'finance',
  at: '2026-10-31T10:00:00Z',
  source: 'draft',
  kind: 'install',
  version: { from: null, to: '0.1.0' },
  authorSays: {
    name: 'Invoices',
    description: 'Sales and purchase invoices synced from Ledgerly',
    summary: 'Every day: produce the Ledgerly export',
    protocol: ['Read the export', 'Write one file per invoice'],
    sync: { service: 'Ledgerly', contract: ['Idempotent: same id → same file'], stateMap: { paid: 'paid' } },
  },
  derived: {
    producerRole: 'finance',
    proposedProducers: ['finance'],
    forProducers: ['finance'],
    reads: [
      {
        source: 'invoices',
        root: 'agent-state',
        glob: 'silos/invoices/*.json',
        parser: 'json',
        convention: 'agent-state:silos/invoices',
        locations: [{ location: 'agent:finance', path: '/data/agent-state/finance/silos/invoices', exists: false, files: 0 }],
      },
    ],
    slots: [
      { slot: 'pulse', says: '€465.51 outstanding' },
      { slot: 'needs-you', says: 'due: …' },
      { slot: 'rail', says: 'an entry «Invoices» in the rail' },
    ],
    preview: {
      from: 'examples',
      basis: 'from the 2 examples — no records on disk yet',
      pulse: '€465.51 outstanding',
      needsYou: [{ urgency: 'due', matches: 1, row: 'F2026-0412 · Acme SL — outstanding · due Jan 1', sample: null }],
      list: 'F2026-0412 · Acme SL · outstanding · €465.51',
    },
    requirements: [{ what: "requires finance's token", agentId: 'finance', met: true }],
    wants: [],
    notes: [],
    errors: [],
    update: null,
    proposedAutomation: {
      agentId: 'finance',
      name: 'Invoices — Ledgerly sync',
      cadence: '24h',
      cron: '0 0 * * *',
      says: 'every 24h, at 00:00 server time',
      prompt: 'Run the Ledgerly sync of the silo Invoices (invoices) now.\n\nthe brief…',
    },
    ...derived,
  },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    page: { kind: 'silo', id: 'invoices', review: true },
    connection: 'connected',
    siloTick: 0,
    agents: [agent('finance', 'Finance', '💶'), agent('writer', 'Writer', '🛠'), agent('master', 'Master', '✳')],
    nowTick: Date.parse('2026-10-31T12:00:00Z'),
  })
  mockedApi.silos.consequences.mockImplementation((_id, producers) => Promise.resolve(consequences({}, producers ? { forProducers: [...producers] } : {})))
  mockedApi.silos.list.mockResolvedValue({ silos: [] })
})

describe('the install dialog', () => {
  it('derived first, as authority: the preview rendered with its basis, the exact paths; the author quoted apart', async () => {
    render(<SiloReviewPage siloId="invoices" />)
    expect(await screen.findByRole('heading', { name: 'Install Invoices 0.1.0?' })).toBeTruthy()
    expect(screen.getByText(/submitted by finance, from a draft/)).toBeTruthy()
    expect(screen.getByTestId('silo-review-basis').textContent).toBe('from the 2 examples — no records on disk yet')
    const preview = screen.getByTestId('silo-review-preview')
    expect(within(preview).getByText('Invoices: €465.51 outstanding.')).toBeTruthy() // the pulse as Home will say it
    expect(within(preview).getByText('F2026-0412 · Acme SL — outstanding · due Jan 1')).toBeTruthy()
    expect(within(preview).getByText('an entry «Invoices» in the rail')).toBeTruthy()
    // an empty place is counted, folded — never hidden: it unfolds in place
    expect(screen.queryByText('/data/agent-state/finance/silos/invoices')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '1 place with nothing there yet — show' }))
    expect(screen.getByText('/data/agent-state/finance/silos/invoices')).toBeTruthy()
    expect(screen.getByText('not there yet')).toBeTruthy()
    // the author's words: a quote, attributed, never mixed with what Silos derived
    expect(screen.getByRole('heading', { name: 'In finance’s words' })).toBeTruthy()
    const quote = screen.getByTestId('silo-review-author')
    expect(quote.tagName).toBe('BLOCKQUOTE')
    expect(quote.textContent).toContain('Sales and purchase invoices synced from Ledgerly')
    expect(quote.textContent).toContain('Idempotent: same id → same file')
    expect(within(preview).queryByText(/synced from Ledgerly/)).toBeNull()
  })

  it('the producers: real agents (never the master), the proposed pre-checked; a change re-asks the server', async () => {
    render(<SiloReviewPage siloId="invoices" />)
    const finance = (await screen.findByRole('checkbox', { name: 'Bind Finance' })) as HTMLInputElement
    expect(finance.checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Bind Writer' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByRole('checkbox', { name: 'Bind Master' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bind Writer' }))
    await waitFor(() => expect(mockedApi.silos.consequences).toHaveBeenLastCalledWith('invoices', ['finance', 'writer']))
  })

  it('the automation is opt-in — off by default; Install sends the binding and the choice, then lands on the silo page', async () => {
    mockedApi.silos.approve.mockResolvedValue({ kind: 'installed', silo: null })
    render(<SiloReviewPage siloId="invoices" />)
    const card = await screen.findByTestId('silo-review-automation')
    expect(card.textContent).toContain('Invoices — Ledgerly sync')
    expect(card.textContent).toContain('every 24h, at 00:00 server time · run by Finance')
    expect(card.textContent).toContain('It would ask: «Run the Ledgerly sync of the silo Invoices (invoices) now.»')
    expect((within(card).getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Install Invoices' }))
    await waitFor(() => expect(mockedApi.silos.approve).toHaveBeenCalledWith('invoices', { producers: ['finance'], automation: false, slotsOff: [] }))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'invoices' }))
  })

  // a builtin's reinstall used to turn its born-off pulse
  // back on — the dialog now says which slots start off and sends exactly that
  it('a slot that starts off says so, and Install sends that list (what the dialog shows is what lands)', async () => {
    mockedApi.silos.approve.mockResolvedValue({ kind: 'reinstalled', silo: null })
    mockedApi.silos.consequences.mockImplementation(() =>
      Promise.resolve(
        consequences(
          { kind: 'reinstall' },
          {
            slots: [
              { slot: 'pulse', says: '€465.51 outstanding', off: true },
              { slot: 'needs-you', says: 'due: …', off: false },
              { slot: 'rail', says: 'an entry «Invoices» in the rail', off: false },
            ],
          },
        ),
      ),
    )
    render(<SiloReviewPage siloId="invoices" />)
    const offs = await screen.findAllByTestId('silo-review-slot-off')
    expect(offs).toHaveLength(1)
    expect(offs[0]!.textContent).toBe('starts off — turn it on from its page')
    fireEvent.click(screen.getByRole('button', { name: /^\w+ Invoices$/ }))
    await waitFor(() => expect(mockedApi.silos.approve).toHaveBeenCalledWith('invoices', { producers: ['finance'], automation: false, slotsOff: ['pulse'] }))
  })

  it('what stands in the way is said, and Install waits for it', async () => {
    mockedApi.silos.consequences.mockResolvedValue(
      consequences({}, { requirements: [{ what: "requires finance's token — finance is archived, so it holds none", agentId: 'finance', met: false }] }),
    )
    render(<SiloReviewPage siloId="invoices" />)
    expect((await screen.findByTestId('silo-review-blockers')).textContent).toContain("requires finance's token — finance is archived, so it holds none")
    expect((screen.getByRole('button', { name: 'Install Invoices' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('an update: the title says from → to, each loosening on its own line, the button says Update', async () => {
    mockedApi.silos.consequences.mockResolvedValue(
      consequences(
        { kind: 'update', version: { from: '0.1.0', to: '0.2.0' } },
        {
          update: {
            from: '0.1.0',
            lines: ['every record on disk still reads'],
            loosening: ['asks for a new slot: rail', 'set-field may now write description'],
          },
        },
      ),
    )
    render(<SiloReviewPage siloId="invoices" />)
    expect(await screen.findByRole('heading', { name: /0\.1\.0.*0\.2\.0/ })).toBeTruthy()
    const loosening = screen.getAllByTestId('silo-review-loosening')
    expect(loosening).toHaveLength(2)
    expect(loosening[0]).toHaveTextContent('asks for a new slot: rail')
    expect(loosening[1]).toHaveTextContent('set-field may now write description')
    expect(screen.getByRole('button', { name: 'Update Invoices' })).toBeTruthy()
  })

  it('Reject with a reason: the decision said in place, the submitter told', async () => {
    mockedApi.silos.reject.mockResolvedValue({ rejected: 'invoices', reason: 'not this month' })
    render(<SiloReviewPage siloId="invoices" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }))
    fireEvent.change(screen.getByLabelText(/Why not\?/), { target: { value: 'not this month' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reject Invoices' }))
    await waitFor(() => expect(mockedApi.silos.reject).toHaveBeenCalledWith('invoices', 'not this month'))
    expect((await screen.findByTestId('silo-review-rejected')).textContent).toContain(
      'You rejected Invoices 0.1.0. Nothing of it was installed; finance was told — «not this month».',
    )
  })

  it('a refusal from the server is said, and the consequences re-read', async () => {
    mockedApi.silos.approve.mockRejectedValue(new ApiError('the submission no longer validates', 409, {}))
    render(<SiloReviewPage siloId="invoices" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install Invoices' }))
    expect((await screen.findByRole('alert')).textContent).toBe('the submission no longer validates')
    expect(mockedApi.silos.consequences.mock.calls.length).toBeGreaterThan(1)
  })

  it('nothing waiting (decided already): said, with the way to the silo page', async () => {
    mockedApi.silos.consequences.mockRejectedValue(new ApiError('no pending submission of invoices', 404, {}))
    render(<SiloReviewPage siloId="invoices" />)
    expect(await screen.findByText(/decided already/)).toBeTruthy()
  })
})

describe('a kernel source', () => {
  it("reads no paths: the catalog's words and what Silos holds; nobody to bind; Install sends no producer", async () => {
    const kernel = consequences(
      {
        id: 'system',
        name: 'System',
        submittedBy: 'owner',
        source: 'body',
        authorSays: { name: 'System', description: 'What conversations left on this machine', summary: null, protocol: [], sync: null },
      },
      {
        producerRole: 'kernel',
        proposedProducers: [],
        forProducers: [],
        reads: [
          {
            source: 'processes',
            root: 'kernel',
            glob: '',
            parser: '',
            kind: 'process',
            convention: 'kernel:process',
            says: 'the processes your conversations started on this machine and the ports they listen on',
            records: 2,
            locations: [],
          },
        ],
        slots: [
          { slot: 'pulse', says: '2 processes left running' },
          { slot: 'needs-you', says: 'routine: npm run dev — left running' },
        ],
        preview: {
          from: 'records',
          basis: 'from 2 records Silos holds',
          pulse: '2 processes left running',
          needsYou: [{ urgency: 'routine', matches: 1, row: 'npm run dev — left running', sample: null }],
          list: null,
        },
        requirements: [],
        proposedAutomation: null,
      },
    )
    mockedApi.silos.consequences.mockResolvedValue(kernel)
    mockedApi.silos.approve.mockResolvedValue({ silo: null, kind: 'installed', automation: null } as never)
    useStore.setState({ page: { kind: 'silo', id: 'system', review: true } })
    render(<SiloReviewPage siloId="system" />)
    expect(await screen.findByRole('heading', { name: 'Install System 0.1.0?' })).toBeTruthy()
    expect(screen.getByTestId('silo-review-kernel-read').textContent).toContain(
      'the processes your conversations started on this machine and the ports they listen on · 2 records Silos holds now',
    )
    expect(screen.getByText(/Silos itself keeps these records — kernel data, read-only/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Bind / })).toBeNull()
    expect(within(screen.getByTestId('silo-review-preview')).getByText('System: 2 processes left running.')).toBeTruthy()
    const install = screen.getByRole('button', { name: 'Install System' }) as HTMLButtonElement
    expect(install.disabled).toBe(false)
    fireEvent.click(install)
    await waitFor(() => expect(mockedApi.silos.approve).toHaveBeenCalledWith('system', { producers: [], automation: false, slotsOff: [] }))
  })
})
