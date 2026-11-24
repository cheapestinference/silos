// vault-binding-ask.test.tsx — the binding an agent proposes: the ask's
// door opens the Vault's editor PREFILLED and never saves — the owner's save
// is the only write; a broken ask never opens an editor; every live proposal
// for one entry is listed and choosing one is the owner's act; a save says
// what it let go. Security-bearing flow, so tested; layout is screenshot work.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { VaultPage } from '../src/components/VaultPage'
import { hostParts } from '../src/components/VaultSigning'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { BindingAsk, VaultEntry } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const agent = (id: string, name: string, folder: string) => ({
  id,
  name,
  emoji: '🧪',
  role: '',
  folder,
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
})

const KEY = 'folder:/home/u/acme/tasks/tasks/t5'
const entry: VaultEntry = {
  id: 'e1',
  name: 'LEDGER_API_KEY',
  value: '…abcd',
  scope: { type: 'agents', agentIds: ['finance'] },
  createdAt: '2026-01-01T00:00:00Z',
  binding: { baseUrl: 'https://api.ledgerly.com', inject: { header: 'key', format: '%s' } },
}
const ask = (over: Partial<BindingAsk> = {}): BindingAsk => ({
  key: KEY,
  ref: 'acme#t5',
  title: 'Sync invoices',
  owner: 'finance',
  folder: '/home/u/acme',
  asked: 'Sign it for MCP?',
  entry: 'LEDGER_API_KEY',
  baseUrl: 'https://mcp.ledgerly-api.com',
  inject: { header: 'authorization', format: 'Bearer %s' },
  host: 'mcp.ledgerly-api.com',
  registrable: 'ledgerly-api.com',
  neverSeen: true,
  entryId: 'e1',
  current: entry.binding!,
  problem: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ page: { kind: 'vault' }, agents: [agent('finance', 'Finance', '/home/u/acme'), agent('builder', 'Builder', '/home/u/acme')] as never })
  mockedApi.vault.list.mockResolvedValue([entry])
})

describe("the ask's door into the Vault", () => {
  it('opens the editor PREFILLED with the proposal — host as hero, never-seen, diff, provenance — and writes nothing until the owner saves', async () => {
    mockedApi.vault.asks.mockResolvedValue([ask()])
    mockedApi.vault.setBinding.mockResolvedValue({
      entry,
      warnings: [],
      resolved: { resolved: [{ key: KEY, ref: 'acme#t5', owner: 'finance', unblocked: true }], failed: [] },
    })
    render(<VaultPage sign={KEY} />)
    const editor = await screen.findByTestId('binding-editor')
    expect(within(editor).getByLabelText('LEDGER_API_KEY service URL')).toHaveValue('https://mcp.ledgerly-api.com')
    expect(within(editor).getByLabelText('LEDGER_API_KEY header')).toHaveValue('authorization')
    expect(within(editor).getByLabelText('LEDGER_API_KEY format')).toHaveValue('Bearer %s')
    expect(within(editor).getByTestId('never-seen')).toHaveTextContent('ledgerly-api.com')
    expect(within(editor).getByTestId('binding-diff')).toHaveTextContent('api.ledgerly.com')
    expect(within(editor).getByTestId('ask-provenance')).toHaveTextContent('acme#t5')
    // the row says what signing lets go, before the gesture
    expect(screen.getByTestId('vault-unblocks')).toHaveTextContent('unblocks acme#t5')
    expect(mockedApi.vault.setBinding).not.toHaveBeenCalled()
    fireEvent.click(within(editor).getByRole('button', { name: 'Save signing' }))
    await waitFor(() =>
      expect(mockedApi.vault.setBinding).toHaveBeenCalledWith('e1', {
        baseUrl: 'https://mcp.ledgerly-api.com',
        inject: { header: 'authorization', format: 'Bearer %s' },
      }),
    )
    expect(await screen.findByTestId('vault-released')).toHaveTextContent('Unblocked acme#t5 — Finance will check a first signed call.')
  })

  it("the owner may edit the prefill: the save carries the owner's values, and the never-seen mark leaves with the proposed host", async () => {
    mockedApi.vault.asks.mockResolvedValue([ask()])
    mockedApi.vault.setBinding.mockResolvedValue({ entry, warnings: [] })
    render(<VaultPage sign={KEY} />)
    const editor = await screen.findByTestId('binding-editor')
    fireEvent.change(within(editor).getByLabelText('LEDGER_API_KEY service URL'), { target: { value: 'https://mcp.ledgerly.com' } })
    expect(within(editor).queryByTestId('never-seen')).toBeNull()
    fireEvent.click(within(editor).getByRole('button', { name: 'Save signing' }))
    await waitFor(() =>
      expect(mockedApi.vault.setBinding).toHaveBeenCalledWith('e1', {
        baseUrl: 'https://mcp.ledgerly.com',
        inject: { header: 'authorization', format: 'Bearer %s' },
      }),
    )
  })

  it('a broken ask never opens an editor — it says why', async () => {
    mockedApi.vault.asks.mockResolvedValue([
      ask({ entryId: null, problem: 'LEDGER_API_KEY is not in the Vault. This ask names an entry that does not exist — add it first, then sign it.' }),
    ])
    render(<VaultPage sign={KEY} />)
    expect(await screen.findByTestId('vault-sign-broken')).toHaveTextContent('not in the Vault')
    expect(screen.queryByTestId('binding-editor')).toBeNull()
    expect(screen.queryByTestId('vault-unblocks')).toBeNull()
  })

  it('every live proposal for the entry is listed; choosing one fills the form; one entry = one binding is said', async () => {
    const other = ask({
      key: 'folder:/home/u/acme/tasks/tasks/t6',
      ref: 'acme#t6',
      owner: 'builder',
      baseUrl: 'https://api.ledgerly.com',
      host: 'api.ledgerly.com',
      registrable: 'ledgerly.com',
      neverSeen: false,
      inject: { header: 'key', format: '%s' },
    })
    mockedApi.vault.asks.mockResolvedValue([ask(), other])
    render(<VaultPage sign={KEY} />)
    const editor = await screen.findByTestId('binding-editor')
    const group = within(editor).getByRole('radiogroup', { name: 'proposals for LEDGER_API_KEY' })
    expect(within(group).getAllByRole('radio')).toHaveLength(2)
    expect(editor).toHaveTextContent('One entry has one binding')
    fireEvent.click(within(group).getByRole('radio', { name: /acme#t6/ }))
    expect(within(editor).getByLabelText('LEDGER_API_KEY service URL')).toHaveValue('https://api.ledgerly.com')
    expect(within(editor).getByLabelText('LEDGER_API_KEY header')).toHaveValue('key')
    expect(mockedApi.vault.setBinding).not.toHaveBeenCalled()
  })

  it('the hero splits the host: subdomain and path quiet, the registrable domain prominent', () => {
    expect(hostParts('https://mcp.ledgerly-api.com/v1', 'ledgerly-api.com')).toEqual({ insecure: false, sub: 'mcp', domain: 'ledgerly-api.com', path: '/v1' })
    expect(hostParts('http://a.b.example.co.uk', 'example.co.uk')).toEqual({ insecure: true, sub: 'a.b', domain: 'example.co.uk', path: '' })
    expect(hostParts('https://api.example.com')).toMatchObject({ sub: 'api', domain: 'example.com' })
  })
})
