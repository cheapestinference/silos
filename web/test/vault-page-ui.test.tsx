// vault-page-ui.test.tsx — the Vault page: the ledger renders with the
// pulse line, a collision group says who wins, a row expands in place to
// manage (visibility / replace value / delete that names who loses it),
// the composer leads with visibility, and the empty vault is an invitation.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VaultPage } from '../src/components/VaultPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { VaultEntry } from '../src/lib/types'

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

let seq = 0
function entry(name: string, scope: VaultEntry['scope'], createdAt = '2026-01-01T00:00:00Z'): VaultEntry {
  seq += 1
  return { id: `id-${seq}`, name, value: '…abcd', scope, createdAt }
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    page: { kind: 'vault' },
    agents: [agent('finance', 'Finance', '/home/u/money'), agent('writer', 'Writer', '/home/u/silos')] as never,
  })
})

describe('VaultPage — the ledger', () => {
  it('renders the rows, the pulse line and the scope language', async () => {
    mockedApi.vault.list.mockResolvedValue([entry('STRIPE_KEY', { type: 'agents', agentIds: ['finance'] }), entry('RAILWAY_TOKEN', { type: 'global' })])
    render(<VaultPage />)
    expect(await screen.findByText('STRIPE_KEY')).toBeInTheDocument()
    expect(screen.getByText('RAILWAY_TOKEN')).toBeInTheDocument()
    expect(screen.getByText(/^2 secrets/)).toBeInTheDocument()
    expect(screen.getByText('Agent · Finance')).toBeInTheDocument() // the agent pill
  })

  it('a name collision becomes a group that says the most specific wins — and who is shadowed', async () => {
    mockedApi.vault.list.mockResolvedValue([entry('TOKEN', { type: 'global' }), entry('TOKEN', { type: 'agents', agentIds: ['finance'] })])
    render(<VaultPage />)
    expect(await screen.findByText(/^2 entries/)).toBeInTheDocument()
    expect(screen.getByText('except Agent · Finance')).toBeInTheDocument()
  })

  it('a row expands in place: reach sentence, visibility editor, and a delete that names who loses it', async () => {
    mockedApi.vault.list.mockResolvedValue([entry('STRIPE_KEY', { type: 'agents', agentIds: ['finance'] })])
    mockedApi.vault.remove.mockResolvedValue({ ok: true })
    render(<VaultPage />)
    fireEvent.click(await screen.findByRole('button', { name: /STRIPE_KEY/ }))
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Reaches Finance.')).toBeInTheDocument()
    // arm the delete: the confirm label carries the loss, in plain words
    fireEvent.click(screen.getByRole('button', { name: 'delete STRIPE_KEY' }))
    const armed = screen.getByText('Finance loses it — sure?')
    fireEvent.click(armed)
    await waitFor(() => expect(mockedApi.vault.remove).toHaveBeenCalledWith(expect.stringMatching(/^id-/)))
  })

  it('an agent named in a row is the door to its Secrets tab (what reaches it, and why)', async () => {
    mockedApi.vault.list.mockResolvedValue([entry('STRIPE_KEY', { type: 'agents', agentIds: ['finance'] })])
    render(<VaultPage />)
    fireEvent.click(await screen.findByRole('button', { name: /STRIPE_KEY/ }))
    fireEvent.click(screen.getByTitle(/^Finance’s Secrets/))
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'finance' })
    expect(useStore.getState().tab).toBe('vault')
  })

  it("arriving for one entry (?entry=, an agent's Secrets row) opens that entry", async () => {
    mockedApi.vault.list.mockResolvedValue([entry('STRIPE_KEY', { type: 'agents', agentIds: ['finance'] }), entry('OTHER', { type: 'global' })])
    const list = await Promise.resolve(mockedApi.vault.list())
    render(<VaultPage entry={list[0]!.id} />)
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('button', { expanded: true })
          .map((b) => b.textContent)
          .join(' '),
      ).toContain('STRIPE_KEY'),
    )
    expect(
      screen
        .getAllByRole('button', { expanded: true })
        .map((b) => b.textContent)
        .join(' '),
    ).not.toContain('OTHER')
  })

  it('saving a visibility change PATCHes the scope — the value never travels', async () => {
    mockedApi.vault.list.mockResolvedValue([entry('STRIPE_KEY', { type: 'agents', agentIds: ['finance'] })])
    mockedApi.vault.setScope.mockResolvedValue({ entry: entry('STRIPE_KEY', { type: 'global' }), warnings: [] })
    render(<VaultPage />)
    fireEvent.click(await screen.findByRole('button', { name: /STRIPE_KEY/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Every agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save visibility' }))
    await waitFor(() => expect(mockedApi.vault.setScope).toHaveBeenCalledWith(expect.stringMatching(/^id-/), { type: 'global' }))
  })

  it('replacing a value keeps the delete+create discipline', async () => {
    const old = entry('API_KEY', { type: 'agents', agentIds: ['writer'] })
    mockedApi.vault.list.mockResolvedValue([old])
    mockedApi.vault.remove.mockResolvedValue({ ok: true })
    mockedApi.vault.create.mockResolvedValue(entry('API_KEY', { type: 'agents', agentIds: ['writer'] }))
    render(<VaultPage />)
    fireEvent.click(await screen.findByRole('button', { name: /API_KEY/ }))
    fireEvent.change(screen.getByLabelText('new value for API_KEY'), { target: { value: 'fresh-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace value' }))
    await waitFor(() => expect(mockedApi.vault.remove).toHaveBeenCalledWith(old.id))
    await waitFor(() => expect(mockedApi.vault.create).toHaveBeenCalledWith({ name: 'API_KEY', value: 'fresh-secret', scope: old.scope }))
  })

  it('the composer leads with visibility and creates with the chosen scope', async () => {
    mockedApi.vault.list.mockResolvedValue([entry('EXISTING', { type: 'global' })])
    mockedApi.vault.create.mockResolvedValue(entry('NEW_KEY', { type: 'agents', agentIds: ['finance'] }))
    render(<VaultPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Add a secret/ }))
    // from the Vault itself nothing is picked for you
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    // visibility first: pick the agent before any name is typed
    fireEvent.click(screen.getByRole('radio', { name: 'Specific agents' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finance' }))
    fireEvent.change(screen.getByLabelText('secret name'), { target: { value: 'new_key' } })
    fireEvent.change(screen.getByLabelText('secret value'), { target: { value: 's3cret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to vault' }))
    await waitFor(() =>
      expect(mockedApi.vault.create).toHaveBeenCalledWith({
        name: 'NEW_KEY',
        value: 's3cret',
        scope: { type: 'agents', agentIds: ['finance'] },
      }),
    )
  })

  it('opened from a project, «Add a secret» starts on that project and creates there', async () => {
    mockedApi.vault.list.mockResolvedValue([entry('EXISTING', { type: 'global' })])
    mockedApi.vault.create.mockResolvedValue(entry('NEW_KEY', { type: 'folder', folder: '/home/u/money' }))
    render(<VaultPage add="project:/home/u/money" />)
    expect(await screen.findByRole('radio', { name: 'One project' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.change(screen.getByLabelText('secret name'), { target: { value: 'new_key' } })
    fireEvent.change(screen.getByLabelText('secret value'), { target: { value: 's3cret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to vault' }))
    await waitFor(() =>
      expect(mockedApi.vault.create).toHaveBeenCalledWith({ name: 'NEW_KEY', value: 's3cret', scope: { type: 'folder', folder: '/home/u/money' } }),
    )
  })

  it('an empty vault is an invitation — the composer is already open', async () => {
    mockedApi.vault.list.mockResolvedValue([])
    render(<VaultPage />)
    expect(await screen.findByLabelText('secret name')).toBeInTheDocument()
  })

  it('search narrows the ledger and says so when nothing matches', async () => {
    mockedApi.vault.list.mockResolvedValue([entry('STRIPE_KEY', { type: 'agents', agentIds: ['finance'] }), entry('RAILWAY_TOKEN', { type: 'global' })])
    render(<VaultPage />)
    await screen.findByText('STRIPE_KEY')
    fireEvent.change(screen.getByLabelText('search the vault'), { target: { value: 'stripe' } })
    expect(screen.queryByText('RAILWAY_TOKEN')).toBeNull()
    fireEvent.change(screen.getByLabelText('search the vault'), { target: { value: 'zzz' } })
    expect(screen.getByText('Nothing named like that in the vault.')).toBeInTheDocument()
  })
})
