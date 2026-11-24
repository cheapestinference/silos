// silo-page.test.tsx — the `list` archetype (Task 8): rows speak the
// manifest's words (identity as the phrase, the state ALWAYS by its label),
// the server's honesty lines are painted verbatim (said, unreadable with
// reasons), the fold counts and unfolds, a facet filters through the server,
// a non-active silo says its state instead of records, and a row opens the
// record's page.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SiloPage } from '../src/components/silo/SiloPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { SiloDescriptor, SiloRecordsPage, SiloRecordRow } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const descriptor = (over: Partial<SiloDescriptor> = {}): SiloDescriptor => ({
  id: 'invoices',
  name: 'Invoices',
  description: 'Sales and purchase invoices synced from Ledgerly',
  version: '0.1.0',
  apiVersion: 'silo-standard/v0',
  state: 'active',
  reason: 'active',
  conventions: [],
  wants: [],
  kinds: ['invoices/invoice'],
  producer: { role: 'finance', sync: 'Ledgerly' },
  producers: ['finance'],
  records: { parsed: 9, failed: 2 },
  lastWrite: null,
  freshness: null,
  slots: { requested: ['pulse'], granted: ['pulse'], off: [] },
  observedAt: '2026-10-30T12:00:00Z',
  ...over,
})

const rowOf = (id: string, over: Partial<SiloRecordRow> = {}): SiloRecordRow => ({
  key: `agent:finance/${id}`,
  id,
  identity: `F-${id} · Acme SL`,
  state: 'open',
  stateLabel: 'outstanding',
  at: '2026-10-02',
  anchors: { agent: 'finance' },
  cells: [
    { column: 'identity', text: `F-${id} · Acme SL` },
    { column: 'state', text: over.stateLabel ?? 'outstanding' },
    { column: 'total', text: '€465.51' },
    { column: 'due', text: 'Nov 1' },
    { column: 'at', text: 'Oct 2' },
  ],
  row: `F-${id} · Acme SL — outstanding · due Nov 1`,
  folded: false,
  overlay: false,
  conflict: false,
  remarks: [],
  file: `/as/finance/silos/invoices/${id}.json`,
  ...over,
})

const pageOf = (records: SiloRecordRow[], over: Partial<SiloRecordsPage> = {}): SiloRecordsPage => ({
  silo: { id: 'invoices', name: 'Invoices', state: 'active', freshness: null },
  kind: {
    name: 'invoices/invoice',
    states: [
      { value: 'open', one: 'outstanding', many: 'outstanding', terminal: false },
      { value: 'paid', one: 'paid', many: 'paid', terminal: true },
    ],
    columns: ['identity', 'state', 'total', 'due', 'at'],
    columnTypes: { state: 'state', total: 'money', due: 'timestamp', at: 'timestamp' },
    facets: [
      {
        name: 'state',
        values: [
          { value: 'open', label: 'outstanding', count: 5 },
          { value: 'paid', label: 'paid', count: 2 },
        ],
      },
    ],
  },
  total: 7,
  matching: records.length,
  offset: 0,
  limit: 50,
  said: null,
  unreadable: { count: 0, items: [] },
  records,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ page: { kind: 'silo', id: 'invoices' }, connection: 'connected', silos: [descriptor()], siloTick: 0 })
  mockedApi.silos.list.mockResolvedValue({ silos: [descriptor()] })
  mockedApi.silos.records.mockImplementation((_id, q = {}) => {
    if (q.folded === 'only') return Promise.resolve(pageOf([rowOf('a9', { state: 'paid', stateLabel: 'paid', folded: true })], { matching: 2 }))
    return Promise.resolve(pageOf([rowOf('a1'), rowOf('a2', { conflict: true })], { matching: 5 }))
  })
})

describe('the list archetype', () => {
  it('rows speak the manifest: identity as the phrase, the state by its label, the facet chips with whole-set counts', async () => {
    render(<SiloPage />)
    expect((await screen.findAllByText('F-a1 · Acme SL')).length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeTruthy()
    // the header sentence: real counts + the producer
    expect(screen.getByText(/9 records · synced from Ledgerly by finance/)).toBeTruthy()
    // the state cell carries the plain word, never the raw value
    expect(screen.getAllByText('outstanding').length).toBeGreaterThan(0)
    expect(screen.queryByText(/^open$/)).toBeNull()
    // a conflict is marked in so many words
    expect(screen.getAllByText('conflict').length).toBeGreaterThan(0)
    // the facet chip exists with the declared label
    expect(screen.getByLabelText('filter by state')).toBeTruthy()
    // the live list excluded folded records (no filter active)
    expect(mockedApi.silos.records).toHaveBeenCalledWith('invoices', expect.objectContaining({ folded: 'exclude' }))
  })

  it('«N folded» comes from the server and unfolds into its own slice', async () => {
    render(<SiloPage />)
    const btn = await screen.findByRole('button', { name: /2 more · Show/ })
    fireEvent.click(btn)
    expect((await screen.findAllByText('F-a9 · Acme SL')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('paid').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /2 more · Hide/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('the fold line says what it folds when the view names it (fold.label)', async () => {
    mockedApi.silos.records.mockImplementation((_id, q = {}) => {
      const p = q.folded === 'only' ? pageOf([rowOf('a9', { folded: true })], { matching: 2 }) : pageOf([rowOf('a1')])
      return Promise.resolve({ ...p, kind: { ...p.kind, fold: { label: 'paid' } } })
    })
    render(<SiloPage />)
    expect(await screen.findByRole('button', { name: /2 paid · Show/ })).toBeInTheDocument()
  })

  it('a facet selection re-asks the server with facet.<name> and overrides the fold', async () => {
    render(<SiloPage />)
    fireEvent.click(await screen.findByLabelText('filter by state'))
    fireEvent.click(await screen.findByRole('option', { name: /paid/ }))
    await waitFor(() => {
      expect(mockedApi.silos.records).toHaveBeenCalledWith('invoices', expect.objectContaining({ facets: { state: 'paid' } }))
    })
    const filteredCall = mockedApi.silos.records.mock.calls.find((c) => c[1] && (c[1] as { facets?: Record<string, string> }).facets?.state === 'paid')!
    expect((filteredCall[1] as { folded?: string }).folded).toBeUndefined()
  })

  it('the cut and the unreadable files are said verbatim, with each reason', async () => {
    mockedApi.silos.records.mockResolvedValue(
      pageOf([rowOf('a1')], {
        said: 'showing 1 of 614',
        matching: 614,
        unreadable: {
          count: 2,
          items: [
            { file: '/x/bad.json', rel: 'bad.json', reason: 'total is required and missing' },
            { file: '/x/worse.json', rel: 'worse.json', reason: 'not valid JSON' },
          ],
        },
      }),
    )
    render(<SiloPage />)
    expect(await screen.findByText('showing 1 of 614')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /2 records can't be read — show which/ }))
    expect(screen.getByText('total is required and missing')).toBeTruthy()
    expect(screen.getByText('not valid JSON')).toBeTruthy()
  })

  it('a row opens the record page', async () => {
    render(<SiloPage />)
    fireEvent.click((await screen.findAllByText('F-a1 · Acme SL'))[0]!)
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'invoices', recordKey: 'agent:finance/a1' })
  })

  it('a pending silo says its state instead of pretending records', async () => {
    useStore.setState({ silos: [descriptor({ state: 'pending', reason: 'waiting for the owner to approve it' })] })
    mockedApi.silos.list.mockResolvedValue({ silos: [descriptor({ state: 'pending', reason: 'waiting for the owner to approve it' })] })
    render(<SiloPage />)
    expect(await screen.findByText(/waiting for the owner to approve it/)).toBeTruthy()
    expect(mockedApi.silos.records).not.toHaveBeenCalled()
  })

  it('an unknown silo id is said, never a blank page', async () => {
    useStore.setState({ page: { kind: 'silo', id: 'nope' } })
    mockedApi.silos.records.mockRejectedValue(new Error('no silo nope'))
    render(<SiloPage />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/no silo nope/)).toBeTruthy()
  })

  it("a version waiting for approval: a band on the silo's own page opens the dialog", async () => {
    mockedApi.silos.submissions.mockResolvedValue([
      { id: 'invoices', submittedBy: 'finance', at: '2026-10-31T10:00:00Z', source: 'body', name: 'Invoices', version: '0.2.0', update: true },
    ])
    render(<SiloPage />)
    const band = await screen.findByTestId('silo-waiting')
    expect(band.textContent).toContain('0.2.0')
    expect(band.textContent).toContain('finance')
    fireEvent.click(screen.getByRole('button', { name: 'Review the update ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'invoices', review: true })
  })

  it('a silo never installed, with a submission waiting: says so and offers the dialog — no records pretended', async () => {
    useStore.setState({ page: { kind: 'silo', id: 'support' } })
    mockedApi.silos.records.mockRejectedValue(new Error('no silo support'))
    mockedApi.silos.submissions.mockResolvedValue([
      { id: 'support', submittedBy: 'owner', at: '2026-10-31T10:00:00Z', source: 'body', name: 'Support', version: '0.1.0', update: false },
    ])
    render(<SiloPage />)
    expect((await screen.findByTestId('silo-waiting')).textContent).toContain('0.1.0')
    expect(screen.getByRole('heading', { name: 'Support' })).toBeTruthy()
    expect(screen.getByText(/Not installed — nothing of it reaches Home/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it("a pending silo with no submission says so and offers to submit the registry's manifest — then the dialog", async () => {
    useStore.setState({ silos: [descriptor({ state: 'pending', reason: 'waiting for the owner to approve it' })] })
    mockedApi.silos.list.mockResolvedValue({ silos: [descriptor({ state: 'pending', reason: 'waiting for the owner to approve it' })] })
    mockedApi.silos.submissions.mockResolvedValue([])
    mockedApi.silos.resubmit.mockResolvedValue({ submission: { id: 'invoices', submittedBy: 'owner', at: '2026-10-31T10:00:00Z', state: 'pending' } })
    mockedApi.silos.consequences.mockReturnValue(new Promise(() => {})) // the dialog this lands on (its own tests)
    render(<SiloPage />)
    expect(await screen.findByText(/No submission of it waits yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Submit it for approval…' }))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'invoices', review: true }))
    expect(mockedApi.silos.resubmit).toHaveBeenCalledWith('invoices')
  })
})

// support as a kernel silo: the shared list paints an agent by NAME,
// the state as a select when the owner may set it, and a record known only
// by id (/support/<caseId>) resolves to its page
describe("the list archetype — names, the row's state select, a record by id", () => {
  const supportPage = (): SiloRecordsPage => ({
    ...pageOf([]),
    silo: { id: 'support', name: 'Support', state: 'active', freshness: null },
    kind: {
      name: 'support/case',
      states: [
        { value: 'needs_owner', one: 'needs you', many: 'need you', terminal: false },
        { value: 'waiting_customer', one: 'waiting on the customer', many: 'waiting on customers', terminal: false },
      ],
      columns: ['agent', 'customerEmail', 'state', 'identity'],
      columnTypes: {},
      facets: [{ name: 'agent', values: [{ value: 'writer', label: 'writer', count: 1 }] }],
      stateEdit: { field: 'status', values: ['needs_owner', 'waiting_customer'] },
    },
    matching: 1,
    records: [
      {
        ...rowOf('c1'),
        key: 'agent:writer/c1',
        identity: '',
        state: 'needs_owner',
        stateLabel: 'needs you',
        anchors: { agent: 'writer' },
        cells: [
          { column: 'agent', text: 'writer' },
          { column: 'customerEmail', text: 'a@example.com' },
          { column: 'state', text: 'needs you' },
          { column: 'identity', text: '—' },
        ],
      },
    ],
  })
  beforeEach(() => {
    useStore.setState({
      page: { kind: 'silo', id: 'support' },
      silos: [descriptor({ id: 'support', name: 'Support' })],
      agents: [{ id: 'writer', name: 'Writer', emoji: '', role: '', folder: '/w', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }] as never,
    })
    mockedApi.silos.records.mockResolvedValue(supportPage())
    mockedApi.silos.submissions.mockResolvedValue([])
  })
  it("the agent column and its facet chip say the agent's name, not its id", async () => {
    render(<SiloPage />)
    expect((await screen.findAllByText('Writer')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^writer$/)).toBeNull()
  })
  it('the state is a select on the row: a change dispatches set-field and never opens the record', async () => {
    mockedApi.silos.setField.mockResolvedValue({})
    render(<SiloPage />)
    const select = (await screen.findAllByRole('combobox', { name: 'Set status' }))[0]!
    fireEvent.change(select, { target: { value: 'waiting_customer' } })
    await waitFor(() =>
      expect(mockedApi.silos.setField).toHaveBeenCalledWith('support', { key: 'agent:writer/c1', field: 'status', value: 'waiting_customer' }),
    )
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'support' })
  })
})

// The «retire» half of «Install, review and retire» (the endpoint must
// have a door): the silo's own page carries it, next to
// the operator's other controls.
describe('the uninstall door', () => {
  it('asks once before acting, uninstalls through the API, and lands back on the inventory', async () => {
    mockedApi.silos.uninstall.mockResolvedValue({ uninstalled: 'invoices' })
    render(<SiloPage />)
    fireEvent.click(await screen.findByTestId('silo-uninstall-open'))
    expect(mockedApi.silos.uninstall).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('silo-uninstall-confirm'))
    await waitFor(() => expect(mockedApi.silos.uninstall).toHaveBeenCalledWith('invoices'))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'silos' }))
  })

  it("a refusal stays on the page and says the server's words", async () => {
    mockedApi.silos.uninstall.mockRejectedValue(new Error('invoices is mid-approval — decide the submission first'))
    render(<SiloPage />)
    fireEvent.click(await screen.findByTestId('silo-uninstall-open'))
    fireEvent.click(screen.getByTestId('silo-uninstall-confirm'))
    expect(await screen.findByRole('alert')).toHaveTextContent('mid-approval')
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'invoices' })
  })
})

// a kernel-verb (catalogs.md «Kernel-verbs») declared on the kind: a door on
// the rows its `when` holds for, the catalog's word, behind a confirm
describe('the list archetype — a kernel-verb on the rows', () => {
  const withVerb = (records: SiloRecordRow[]): SiloRecordsPage => {
    const p = pageOf(records, { matching: records.length })
    return { ...p, kind: { ...p.kind, verbs: [{ name: 'stop-process', says: 'Stop', guard: 'stoppable' }] } }
  }
  beforeEach(() => {
    mockedApi.silos.records.mockImplementation((_id, q = {}) =>
      Promise.resolve(q.folded === 'only' ? pageOf([], { matching: 0 }) : withVerb([rowOf('a1', { verbs: ['stop-process'] }), rowOf('a2', { verbs: [] })])),
    )
  })

  it("only where it holds; confirmed, it sends {key, name} and says the kernel's words", async () => {
    mockedApi.silos.kernelVerb.mockResolvedValue({
      says: 'Stopped npm run dev — 2 processes.',
      name: 'stop-process',
      key: 'agent:finance/a1',
      outcome: 'stopped',
    })
    render(<SiloPage />)
    // the desktop table and the phone's stacked list each carry it
    const door = (await screen.findAllByRole('button', { name: 'Stop F-a1 · Acme SL' }))[0]!
    expect(screen.queryAllByRole('button', { name: 'Stop F-a2 · Acme SL' })).toEqual([])
    fireEvent.click(door)
    expect(mockedApi.silos.kernelVerb).not.toHaveBeenCalled() // the first click only arms
    fireEvent.click(screen.getByText('Stop it?'))
    expect(mockedApi.silos.kernelVerb).toHaveBeenCalledWith('invoices', { key: 'agent:finance/a1', name: 'stop-process' })
    expect(await screen.findByTestId('silo-verb-said')).toHaveTextContent('Stopped npm run dev — 2 processes.')
  })

  it('the door says the pending word from the confirm until the answer AND the re-read records', async () => {
    let answer: (v: { says: string; name: string; key: string; outcome: 'stopped' }) => void = () => {}
    mockedApi.silos.kernelVerb.mockReturnValue(
      new Promise((r) => {
        answer = r
      }),
    )
    const pending = { ...withVerb([rowOf('a1', { verbs: ['stop-process'] })]) }
    pending.kind = { ...pending.kind, verbs: [{ name: 'stop-process', says: 'Stop', pending: 'Stopping…', guard: 'stoppable' }] }
    mockedApi.silos.records.mockImplementation((_id, q = {}) => Promise.resolve(q.folded === 'only' ? pageOf([], { matching: 0 }) : pending))
    render(<SiloPage />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Stop F-a1 · Acme SL' }))[0]!)
    fireEvent.click(screen.getByText('Stop it?'))
    expect((await screen.findAllByTestId('silo-verb-pending'))[0]).toHaveTextContent('Stopping…')
    // answered, but the records not read again yet: still pending
    let reread: (p: SiloRecordsPage) => void = () => {}
    mockedApi.silos.records.mockImplementation((_id, q = {}) =>
      q.folded === 'only'
        ? Promise.resolve(pageOf([], { matching: 0 }))
        : new Promise((r) => {
            reread = r
          }),
    )
    answer({ says: 'Stopped npm run dev — 2 processes.', name: 'stop-process', key: 'agent:finance/a1', outcome: 'stopped' })
    expect(await screen.findByTestId('silo-verb-said')).toHaveTextContent('Stopped npm run dev')
    expect(screen.getAllByTestId('silo-verb-pending').length).toBeGreaterThan(0)
    reread(pageOf([], { matching: 0 }))
    await waitFor(() => expect(screen.queryAllByTestId('silo-verb-pending')).toEqual([]))
  })

  it('a refusal is said verbatim', async () => {
    mockedApi.silos.kernelVerb.mockRejectedValue(new Error('npm run dev: stop is not offered on it now (stoppable)'))
    render(<SiloPage />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Stop F-a1 · Acme SL' }))[0]!)
    fireEvent.click(screen.getByText('Stop it?'))
    expect(await screen.findByTestId('silo-verb-said')).toHaveTextContent('npm run dev: stop is not offered on it now (stoppable)')
  })
})

// list `groupBy`: a group whose value names something openable (group.opens)
// has its heading as the door; one without stays words
describe('the list archetype — a group heading opens what it names', () => {
  it('a conversation group opens it; a group with nothing to open is plain text', async () => {
    const openSession = vi.fn(async () => {})
    useStore.setState({ openSession } as never)
    const g = (value: string, label: string, opens?: { hub: 'conversation'; value: string }) => ({ value, label, count: 1, ...(opens ? { opens } : {}) })
    mockedApi.silos.records.mockImplementation((_id, q = {}) => {
      const p = pageOf(
        q.folded === 'only'
          ? []
          : [
              rowOf('a1', { group: g('Checkout', 'Checkout', { hub: 'conversation', value: '-w-p/s-1' }) }),
              rowOf('a2', { group: g('gone', 'a deleted conversation (4c44)') }),
            ],
        { matching: q.folded === 'only' ? 0 : 2 },
      )
      return Promise.resolve({ ...p, kind: { ...p.kind, groupBy: { field: 'conversation', label: 'conversation' } } })
    })
    render(<SiloPage />)
    const doors = await screen.findAllByTestId('silo-group-door')
    expect(new Set(doors.map((d) => d.textContent))).toEqual(new Set(['Checkout']))
    fireEvent.click(doors[0]!)
    expect(openSession).toHaveBeenCalledWith('-w-p', 's-1')
    expect(screen.getAllByText('a deleted conversation (4c44)')[0]!.tagName).toBe('SPAN')
  })
})
