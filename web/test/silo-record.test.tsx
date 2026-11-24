// silo-record.test.tsx — the `record` page: the envelope in voice
// (identity title, state word, anchors as links), typed fields (money as
// money), the state select dispatches set-field with the CAS token and a 409
// is said in plain words, the overlay conflict resolves keep-mine /
// take-source, a message template is PREVIEWED filled before sending — Send
// to the inbox, or «Make it a task for X ›» (no wake) —,
// the extras fold, and the story speaks the journal's honesty.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SiloRecordPage } from '../src/components/silo/SiloRecordPage'
import { useStore } from '../src/store'
import { api, ApiError } from '../src/lib/api'
import type { SiloRecordDetail } from '../src/lib/types'

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>()
  const { api: realApi } = real
  const mock = (o: object): object =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : typeof v === 'object' && v !== null ? mock(v) : v]))
  return { ...real, api: mock(realApi) }
})
const mockedApi = vi.mocked(api, { deep: true })

const detailOf = (over: Partial<SiloRecordDetail> = {}): SiloRecordDetail => ({
  silo: { id: 'invoices', name: 'Invoices', state: 'active' },
  kind: {
    name: 'invoices/invoice',
    states: [
      { value: 'open', one: 'outstanding', many: 'outstanding', terminal: false },
      { value: 'partial', one: 'partially paid', many: 'partially paid', terminal: false },
      { value: 'paid', one: 'paid', many: 'paid', terminal: true },
    ],
  },
  record: {
    key: 'agent:finance/a1',
    id: 'a1',
    identity: 'F-a1 · Acme SL',
    state: 'open',
    stateLabel: 'outstanding',
    at: '2026-10-02',
    anchors: { agent: 'finance' },
    cells: [],
    row: '',
    folded: false,
    overlay: false,
    conflict: false,
    remarks: [],
    file: '/as/finance/silos/invoices/a1.json',
  },
  version: 'abc123',
  // NOTE: 'state' is deliberately NOT here — on the real server the state
  // lives in the envelope, not the kind's declared fields; the page must
  // still give the one writable field its row (writableExtras).
  fields: [
    { name: 'contactName', type: 'string', value: 'Acme SL', text: 'Acme SL' },
    { name: 'total', type: 'money', value: { amount: 465.51, currency: 'EUR' }, text: '€465.51' },
  ],
  extra: { ledgerlyRaw: { x: 1 } },
  children: [],
  overlay: null,
  needsYou: [{ entry: 0, urgency: 'due', clears: 'state in [paid, refunded]', actions: ['set-field', 'open', 'message-agent'] }],
  actions: [
    { verb: 'set-field', fields: [{ name: 'state', values: ['open', 'partial', 'paid'] }] },
    { verb: 'message-agent', templates: ['Chase payment for {{identity}} ({{total}})'] },
    { verb: 'ack' },
  ],
  history: [
    { at: '2026-10-29T09:00:00Z', event: 'baseline', to: 'open' },
    { at: '2026-10-30T12:00:00Z', event: 'transition', from: 'open', to: 'partial', prevSeenAt: '2026-10-29T09:00:00Z' },
  ],
  events: [
    { at: '2026-10-30T13:00:00Z', silo: 'invoices', key: 'agent:finance/a1', verb: 'set-field', by: 'owner', text: 'set-field state: open → paid · by owner' },
  ],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ page: { kind: 'silo', id: 'invoices', recordKey: 'agent:finance/a1' }, connection: 'connected', siloTick: 0, agents: [] })
  mockedApi.silos.record.mockResolvedValue(detailOf())
  mockedApi.silos.proposals.mockResolvedValue([])
})

describe('the record page', () => {
  it('paints the envelope in voice: identity, the state word, money as money, the extras folded', async () => {
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    expect(await screen.findByRole('heading', { name: 'F-a1 · Acme SL' })).toBeTruthy()
    expect(screen.getAllByText('outstanding').length).toBeGreaterThan(0)
    expect(screen.getByText('€465.51')).toBeTruthy()
    const fold = screen.getByRole('button', { name: /1 field preserved as written — show/ })
    fireEvent.click(fold)
    expect(screen.getByText(/"ledgerlyRaw"/)).toBeTruthy()
  })

  it('the story speaks the journal honesty: «arrived», the transition with its window, the action events', async () => {
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    expect(await screen.findByText(/arrived/)).toBeTruthy()
    expect(screen.getByText(/→ partially paid/)).toBeTruthy()
    expect(screen.getByText(/open → paid/)).toBeTruthy()
  })

  it('setting the state sends the CAS token; a 409 is said and the record re-read', async () => {
    mockedApi.silos.setField.mockRejectedValueOnce(new ApiError('version conflict', 409, {}))
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    const select = await screen.findByLabelText('Set state')
    fireEvent.change(select, { target: { value: 'paid' } })
    await waitFor(() =>
      expect(mockedApi.silos.setField).toHaveBeenCalledWith('invoices', { key: 'agent:finance/a1', field: 'state', value: 'paid', version: 'abc123' }),
    )
    expect(await screen.findByText(/Someone wrote this record first/)).toBeTruthy()
    // re-read after the refusal: the fresh version is already loaded
    expect(mockedApi.silos.record.mock.calls.length).toBeGreaterThan(1)
  })

  it('a conflict offers keep-mine / take-source in the row words', async () => {
    mockedApi.silos.record.mockResolvedValue(
      detailOf({
        overlay: {
          state: { value: 'paid', base: 'open', at: '2026-10-30T10:00:00Z', by: 'owner', conflict: { sourceValue: 'partial', seenAt: '2026-10-30T11:00:00Z' } },
        },
        needsYou: [],
      }),
    )
    mockedApi.silos.resolve.mockResolvedValue({})
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    const band = await screen.findByTestId('silo-conflict')
    expect(band.textContent).toContain('you set state to paid')
    expect(band.textContent).toContain('the source now says partially paid')
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(mockedApi.silos.resolve).toHaveBeenCalledWith('invoices', 'agent:finance/a1', 'state', 'keep-mine'))
  })

  it('a message template is previewed FILLED before sending; Send dispatches by index', async () => {
    mockedApi.silos.message.mockResolvedValue({ messageIds: ['m1'], to: ['finance'], text: 'x' })
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Chase payment for F-a1 · Acme SL \(€465\.51\)/ }))
    expect(screen.getByTestId('silo-template-preview').textContent).toBe('Chase payment for F-a1 · Acme SL (€465.51)')
    expect(mockedApi.silos.message).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(mockedApi.silos.message).toHaveBeenCalledWith('invoices', 'agent:finance/a1', 0))
    // what the send did, said: who got it, and when it is read
    expect((await screen.findByTestId('silo-sent-note')).textContent).toBe(
      'Sent to finance — it waits in the inbox; finance reads it at its next conversation.',
    )
  })

  // what «Wake the producer now» became: no wake
  // checkbox; «Make it a task for X ›» beside Send, X = the silo's producer
  const withProducer = (): void => {
    useStore.setState({
      agents: [{ id: 'finance', name: 'Finance', emoji: '·', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }] as never,
      silos: [{ id: 'invoices', name: 'Invoices', producer: { role: 'finance', sync: null }, producers: ['finance'] }] as never,
    })
  }

  it('the preview offers Send and «Make it a task for X ›» — never a wake checkbox; no producer, no button', async () => {
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Chase payment for F-a1/ }))
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText(/Wake the producer/)).toBeNull()
    // the store knows no producer for this silo: nobody to give it to
    expect(screen.queryByRole('button', { name: /Make it a task for/ })).toBeNull()
  })

  it('On its own: make-task gives it to the producer, and the page says so', async () => {
    withProducer()
    mockedApi.silos.makeTask.mockResolvedValue({
      to: 'finance',
      taskKey: 'folder:/x/plans/tasks/tasks/t4',
      ref: 'x#t4',
      title: 'Chase payment',
      assigned: true,
      control: 'own',
    })
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Chase payment for F-a1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Make it a task for Finance ›' }))
    await waitFor(() => expect(mockedApi.silos.makeTask).toHaveBeenCalledWith('invoices', 'agent:finance/a1', 0))
    expect((await screen.findByTestId('silo-sent-note')).textContent).toBe('Given to Finance — it starts on its own (x#t4).')
    expect(mockedApi.workOnTask).not.toHaveBeenCalled()
  })

  // the surface «Open» goes to: its console when the
  // agent has one in the index, chat when not
  it('Only when told, no console yet: make-task, then the page opens the producer in chat', async () => {
    withProducer()
    const openSession = vi.fn(async () => {})
    useStore.setState({ openSession: openSession as never })
    mockedApi.silos.makeTask.mockResolvedValue({
      to: 'finance',
      taskKey: 'folder:/x/plans/tasks/tasks/t4',
      ref: 'x#t4',
      title: 'Chase payment',
      assigned: false,
      control: 'told',
    })
    mockedApi.tasksTalk.mockResolvedValue({ folder: '-x', sessionId: 's2', isNew: false, folded: 0 } as never)
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Chase payment for F-a1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Make it a task for Finance ›' }))
    await waitFor(() => expect(mockedApi.tasksTalk).toHaveBeenCalledWith('folder:/x/plans/tasks/tasks/t4'))
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('-x', 's2'))
    expect(mockedApi.workOnTask).not.toHaveBeenCalled()
  })

  it('Only when told, with a console: make-task, then the page opens the producer in its console', async () => {
    withProducer()
    useStore.setState({
      agents: [
        {
          id: 'finance',
          name: 'Finance',
          emoji: '·',
          folder: '/x',
          skills: [],
          sessions: [],
          liveCount: 0,
          sessionCount: 0,
          open: { hasConsole: true, consoleBriefs: true },
        },
      ] as never,
    })
    const openSession = vi.fn(async () => {})
    useStore.setState({ openSession: openSession as never })
    mockedApi.silos.makeTask.mockResolvedValue({
      to: 'finance',
      taskKey: 'folder:/x/plans/tasks/tasks/t4',
      ref: 'x#t4',
      title: 'Chase payment',
      assigned: false,
      control: 'told',
    })
    mockedApi.workOnTask.mockResolvedValue({ mode: 'resumed', folder: '-x', sessionId: 's1' } as never)
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Chase payment for F-a1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Make it a task for Finance ›' }))
    await waitFor(() => expect(mockedApi.workOnTask).toHaveBeenCalledWith('folder:/x/plans/tasks/tasks/t4', expect.stringMatching(/^(light|dark)$/)))
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('-x', 's1'))
  })

  it('a writable field with no declared values edits in place — the same set-field, CAS version riding along', async () => {
    mockedApi.silos.record.mockResolvedValue(
      detailOf({
        fields: [
          { name: 'contactName', type: 'string', value: 'Acme SL', text: 'Acme SL' },
          { name: 'total', type: 'money', value: { amount: 465.51, currency: 'EUR' }, text: '€465.51' },
        ],
        actions: [{ verb: 'set-field', fields: [{ name: 'state', values: ['open', 'partial', 'paid'] }, { name: 'contactName' }, { name: 'total' }] }],
      }),
    )
    mockedApi.silos.setField.mockResolvedValue({})
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit contactName' }))
    const input = screen.getByLabelText('New contactName') as HTMLInputElement
    expect(input.value).toBe('Acme SL')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // not clearable: said, nothing sent
    expect(screen.getByRole('alert').textContent).toBe('this field can’t be left empty')
    expect(mockedApi.silos.setField).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Acme Holdings SL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(mockedApi.silos.setField).toHaveBeenCalledWith('invoices', {
        key: 'agent:finance/a1',
        field: 'contactName',
        value: 'Acme Holdings SL',
        version: 'abc123',
      }),
    )
    // money: its amount, the record's currency kept
    fireEvent.click(await screen.findByRole('button', { name: 'Edit total' }))
    fireEvent.change(screen.getByLabelText('New total'), { target: { value: '500,25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(mockedApi.silos.setField).toHaveBeenCalledWith('invoices', {
        key: 'agent:finance/a1',
        field: 'total',
        value: { amount: 500.25, currency: 'EUR' },
        version: 'abc123',
      }),
    )
  })

  it('an inline edit refused by the CAS is said in plain words, and the record re-read', async () => {
    mockedApi.silos.record.mockResolvedValue(detailOf({ actions: [{ verb: 'set-field', fields: [{ name: 'contactName' }] }] }))
    mockedApi.silos.setField.mockRejectedValueOnce(new ApiError('the record changed since you read it', 409, {}))
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit contactName' }))
    fireEvent.change(screen.getByLabelText('New contactName'), { target: { value: 'B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Someone wrote this record first/)).toBeTruthy()
    expect(mockedApi.silos.record.mock.calls.length).toBeGreaterThan(1)
  })

  it('a pending proposal shows its literal diff and Approve dispatches', async () => {
    mockedApi.silos.proposals.mockResolvedValue([
      {
        id: 'p1',
        silo: 'invoices',
        key: 'agent:finance/a1',
        verb: 'set-field',
        field: 'state',
        from: 'open',
        to: 'paid',
        by: 'finance',
        note: null,
        at: '2026-10-30T12:00:00Z',
        status: 'pending',
      },
    ])
    mockedApi.silos.decideProposal.mockResolvedValue({})
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    const band = await screen.findByTestId('silo-proposal')
    expect(band.textContent).toContain('set-field state: outstanding → paid · proposed by finance')
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(mockedApi.silos.decideProposal).toHaveBeenCalledWith('invoices', 'p1', 'approve'))
  })

  it('the needs-you band says its urgency and clears, and Seen acks', async () => {
    mockedApi.silos.ack.mockResolvedValue({})
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    const band = await screen.findByTestId('silo-needs-you')
    expect(band.textContent).toContain('due')
    expect(band.textContent).toContain('clears when state in [paid, refunded]')
    fireEvent.click(screen.getByRole('button', { name: 'Seen' }))
    await waitFor(() => expect(mockedApi.silos.ack).toHaveBeenCalledWith('invoices', 'agent:finance/a1'))
  })
})

// support as a kernel silo: what /support's open row did, on every
// record page — a child links to its own url, says who wrote it, moves to a
// sibling (move-item) and a sub-kind takes the owner's note (append-item)
describe('the record page — children with their verbs', () => {
  const support = (): SiloRecordDetail =>
    detailOf({
      silo: { id: 'support', name: 'Support', state: 'active' },
      kind: { name: 'support/case', states: [{ value: 'needs_owner', one: 'needs you', many: 'need you', terminal: false }] },
      record: {
        key: 'agent:support/c1',
        id: 'c1',
        identity: 'Wants a refund',
        state: 'needs_owner',
        stateLabel: 'needs you',
        at: '2026-10-28T09:05:00Z',
        anchors: { agent: 'support' },
        cells: [],
        row: '',
        folded: false,
        overlay: false,
        conflict: false,
        remarks: [],
        file: null,
      },
      fields: [],
      extra: {},
      needsYou: [],
      history: [],
      events: [],
      actions: [
        {
          verb: 'set-field',
          fields: [
            { name: 'status', values: ['needs_owner'] },
            { name: 'userId', clearable: true },
          ],
        },
      ],
      children: [
        {
          kind: 'support/thread',
          collection: 'threads',
          rows: [
            { id: 'th1', identity: 'Refund request', stateLabel: '', at: '2026-10-28T09:00:00Z', url: 'https://mail.example/th1' },
            { id: 'th2', identity: '(thread)', stateLabel: '', at: null },
          ],
          move: { targets: [{ key: 'agent:support/c2', label: 'b@example.com · Another case' }] },
        },
        {
          kind: 'support/note',
          collection: 'notes',
          rows: [{ id: '0', identity: 'Customer since March', stateLabel: '', at: '2026-10-28T09:05:00Z', by: 'agent' }],
          append: { fields: [{ name: 'text', required: true, max: 2000 }] },
        },
      ],
    })
  beforeEach(() => {
    useStore.setState({
      page: { kind: 'silo', id: 'support', recordKey: 'agent:support/c1' },
      agents: [{ id: 'support', name: 'Support', emoji: '', role: '', folder: '/w', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }] as never,
    })
    mockedApi.silos.record.mockResolvedValue(support())
  })
  it('the agent anchor is said by name; a thread links to its url, one without stays text; a note says who wrote it', async () => {
    render(<SiloRecordPage siloId="support" recordKey="agent:support/c1" />)
    expect(await screen.findByRole('button', { name: 'with Support' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Refund request' }).getAttribute('href')).toBe('https://mail.example/th1')
    expect(screen.queryByRole('link', { name: '(thread)' })).toBeNull()
    expect(screen.getByText('agent —')).toBeTruthy()
  })
  it('«move to…» dispatches move-item with the child key and the sibling', async () => {
    mockedApi.silos.move.mockResolvedValue({})
    render(<SiloRecordPage siloId="support" recordKey="agent:support/c1" />)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Move Refund request to' }), { target: { value: 'agent:support/c2' } })
    await waitFor(() => expect(mockedApi.silos.move).toHaveBeenCalledWith('support', 'agent:support/c1/threads/th1', 'agent:support/c2', 'abc123'))
  })
  it('the note box appends with the CAS token; the draft clears only once it landed', async () => {
    mockedApi.silos.append.mockRejectedValueOnce(new ApiError('conflict', 409, {})).mockResolvedValueOnce({})
    render(<SiloRecordPage siloId="support" recordKey="agent:support/c1" />)
    const box = await screen.findByRole('textbox', { name: 'Add a note' })
    fireEvent.change(box, { target: { value: 'refund ok' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() =>
      expect(mockedApi.silos.append).toHaveBeenCalledWith('support', {
        key: 'agent:support/c1',
        collection: 'notes',
        values: { text: 'refund ok' },
        version: 'abc123',
      }),
    )
    expect(await screen.findByText(/your note was not added/)).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Add a note' }) as HTMLInputElement).value).toBe('refund ok')
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Add a note' }) as HTMLInputElement).value).toBe(''))
  })
})

// the owner's note reopens a closed task of an
// agent in play in its own write — the record page's box says so, like the
// task page's; a person's or an archived agent's says nothing more
describe("the record page — a closed plan task's note box", () => {
  const taskDetail = (owner: string, state = 'done'): SiloRecordDetail =>
    detailOf({
      silo: { id: 'plans', name: 'Plans', state: 'active' },
      record: {
        key: 'folder:/p/alpha/p/tasks/t1',
        id: 't1',
        identity: 'Ship it',
        state,
        stateLabel: state,
        at: null,
        anchors: {},
        cells: [],
        row: '',
        folded: false,
        overlay: false,
        conflict: false,
        remarks: [],
        file: '/p/alpha/plans/p.plan.json',
      },
      value: { id: 't1', title: 'Ship it', owner, status: state },
      children: [{ kind: 'plan/note', collection: 'notes', rows: [], append: { fields: [{ name: 'text', required: true, max: 8000 }] } }],
      needsYou: [],
      actions: [],
    } as Partial<SiloRecordDetail>)
  it('an agent in play: «Write to Writer — reopens it»; the append is the plain append-item (the server reopens)', async () => {
    useStore.setState({ agents: [{ id: 'writer', name: 'Writer' } as never] })
    mockedApi.silos.record.mockResolvedValue(taskDetail('writer'))
    mockedApi.silos.append.mockResolvedValue({})
    render(<SiloRecordPage siloId="plans" recordKey="folder:/p/alpha/p/tasks/t1" />)
    const box = await screen.findByRole('textbox', { name: 'Write to Writer — reopens it' })
    fireEvent.change(box, { target: { value: 'one more thing' } })
    fireEvent.submit(box.closest('form')!)
    await waitFor(() =>
      expect(mockedApi.silos.append).toHaveBeenCalledWith('plans', {
        key: 'folder:/p/alpha/p/tasks/t1',
        collection: 'notes',
        values: { text: 'one more thing' },
        version: 'abc123',
      }),
    )
  })
  it("a person's task, an archived agent's, an open one: the plain box", async () => {
    useStore.setState({ agents: [{ id: 'writer', name: 'Writer' } as never, { id: 'retired', name: 'Retired', archived: true } as never] })
    for (const [owner, state] of [
      ['sam', 'done'],
      ['retired', 'done'],
      ['writer', 'pending'],
    ] as const) {
      mockedApi.silos.record.mockResolvedValue(taskDetail(owner, state))
      const { unmount } = render(<SiloRecordPage siloId="plans" recordKey="folder:/p/alpha/p/tasks/t1" />)
      expect(await screen.findByRole('textbox', { name: 'Add a note' })).toBeTruthy()
      unmount()
    }
  })
})

describe('the record page — a kernel-verb', () => {
  const withVerb = (applies: boolean): SiloRecordDetail =>
    detailOf({
      fields: [
        { name: 'command', type: 'string', value: 'npm run dev', text: 'npm run dev' },
        { name: 'stoppable', type: 'boolean', value: applies, text: applies ? 'yes' : 'no' },
      ],
      actions: [{ verb: 'open' }, { verb: 'kernel-verb', name: 'stop-process', says: 'Stop', guard: 'stoppable', applies }],
    })

  it('its guard field stays out of the voice; the door, confirmed, sends {key, name} and says the answer', async () => {
    mockedApi.silos.record.mockResolvedValue(withVerb(true))
    mockedApi.silos.kernelVerb.mockResolvedValue({
      says: 'Stopped npm run dev — 2 processes.',
      name: 'stop-process',
      key: 'agent:finance/a1',
      outcome: 'stopped',
    })
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(screen.queryByText('stoppable')).toBeNull()
    expect(mockedApi.silos.kernelVerb).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Stop it — sure?'))
    expect(mockedApi.silos.kernelVerb).toHaveBeenCalledWith('invoices', { key: 'agent:finance/a1', name: 'stop-process' })
    expect(await screen.findByTestId('silo-verb-said')).toHaveTextContent('Stopped npm run dev — 2 processes.')
  })

  it('no door where its when does not hold', async () => {
    mockedApi.silos.record.mockResolvedValue(withVerb(false))
    render(<SiloRecordPage siloId="invoices" recordKey="agent:finance/a1" />)
    await screen.findByText('npm run dev')
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })
})
