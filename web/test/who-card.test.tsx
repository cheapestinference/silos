// who-card.test.tsx — the Who card names the agent and points at its mission;
// the folders it works in are the Runs on card's (runs-on-card.test.tsx).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WhoCard } from '../src/components/agent/WhoCard'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView } from '../src/lib/types'
import { fieldForError } from '../src/components/AgentModal'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function makeAgent(o: Partial<AgentView> = {}): AgentView {
  return { id: 'builder', name: 'Builder', emoji: '🛠', folder: '/home/u/ci', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...o }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.agents.update.mockResolvedValue(undefined)
  mockedApi.complete.mockResolvedValue([])
  mockedApi.providers.list.mockResolvedValue([])
  mockedApi.overview.mockImplementation(async () => ({ agents: useStore.getState().agents, now: 0, warming: false }))
})

// role and charter retired into the mission, which is
// said ONCE — at the head of the page; Who names the agent and points there
describe('WhoCard — the mission is said once, at the head of the page', () => {
  it('names the agent, never a role or a charter, nor its mission (the Mission card sits above it on Profile)', () => {
    render(
      <WhoCard
        agent={makeAgent({ mission: { text: 'Keeps the stack up. Always.', never: ['deploy on Fridays'], updatedAt: '2026-11-10T09:00:00Z' } })}
        editing={false}
        onEditingChange={() => {}}
      />,
    )
    expect(screen.getByText('🛠 Builder')).toBeInTheDocument()
    expect(screen.queryByText(/Keeps the stack up/)).not.toBeInTheDocument()
    expect(screen.queryByText(/charter|No role yet/i)).not.toBeInTheDocument()
  })
  it('its editor has no Role and no Charter field, and never sends one', async () => {
    render(<WhoCard agent={makeAgent()} editing onEditingChange={() => {}} />)
    expect(screen.queryByLabelText('Role')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Charter')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalled())
    for (const f of ['role', 'systemAppend', 'responsibility', 'mission']) expect(mockedApi.agents.update.mock.calls[0]![1]).not.toHaveProperty(f)
  })
})

describe('fieldForError — folders', () => {
  it('a folders error naming a path that contains "name" still lands under the textarea', () => {
    expect(fieldForError('folders must be absolute paths: home/u/username')).toBe('folders')
    expect(fieldForError('folders: duplicate entry /home/u/username')).toBe('folders')
    expect(fieldForError('name required')).toBe('name')
    expect(fieldForError('folder must be an absolute path')).toBe('folder')
  })
})
