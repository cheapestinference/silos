// vault-zone.test.tsx — the agent's vault zone: its own secret is deleted
// here, any other points to the Vault (one house per secret).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../src/store'
import { AgentVaultZone } from '../src/components/agent/VaultZone'
import { api } from '../src/lib/api'
import type { AgentView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const agent: AgentView = { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/p/alpha', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AgentVaultZone — one house per secret', () => {
  it("its own secret is deleted here; a shared, project or everyone's secret points to the Vault, open on that entry", async () => {
    mockedApi.vault.list.mockResolvedValue([
      { id: 'own', name: 'OWN_KEY', value: '••••', scope: { type: 'agents', agentIds: ['a1'] }, createdAt: '2026-11-01T00:00:00Z' },
      { id: 'shared', name: 'SHARED_KEY', value: '••••', scope: { type: 'agents', agentIds: ['a1', 'b2'] }, createdAt: '2026-11-01T00:00:00Z' },
      { id: 'all', name: 'ALL_KEY', value: '••••', scope: { type: 'global' }, createdAt: '2026-11-01T00:00:00Z' },
    ])
    render(<AgentVaultZone agent={agent} />)
    expect(await screen.findByRole('button', { name: 'delete secret OWN_KEY' })).toBeInTheDocument()
    const doors = screen.getAllByTestId('secret-in-vault')
    expect(doors).toHaveLength(2)
    fireEvent.click(doors[0]!)
    expect(useStore.getState().page).toMatchObject({ kind: 'vault' })
    expect(['shared', 'all']).toContain((useStore.getState().page as { entry?: string }).entry)
  })
})
