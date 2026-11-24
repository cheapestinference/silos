// own-limits.test.tsx — the two limits on what an agent does without you
// (starts a day, spend a day), a row of the control block: each is edited
// in place and written with PATCH /api/agents/:id; empty = the default.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { OwnLimits } from '../src/components/agent/OwnLimits'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const agent = (o: Partial<AgentView> = {}): AgentView => ({
  id: 'builder',
  name: 'Builder',
  emoji: '🛠',
  folder: '/home/u/builder',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  ...o,
})
const change = (row: string): void => {
  fireEvent.click(within(screen.getByTestId(row)).getByRole('button', { name: 'change' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.agentDefaults.mockResolvedValue({ turns: 10, spend: 5 })
  mockedApi.agents.update.mockResolvedValue(undefined)
  mockedApi.overview.mockImplementation(async () => ({ agents: useStore.getState().agents, now: 0, warming: false }))
})

describe('OwnLimits', () => {
  it("an agent without its own limits reads the server's defaults, never a figure of the web's", async () => {
    render(<OwnLimits agent={agent()} testId="control-limits" />)
    await waitFor(() => expect(screen.getByTestId('control-limits-turns')).toHaveTextContent('10'))
    expect(screen.getByTestId('control-limits-spend')).toHaveTextContent('$5')
  })

  it('saving a limit writes that field alone, as a number', async () => {
    render(<OwnLimits agent={agent()} testId="control-limits" />)
    change('control-limits-turns')
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('builder', { ownTurnsPerDay: 25 }))
    await waitFor(() => expect(screen.queryByRole('spinbutton')).toBeNull())
  })

  it("saving empty clears the agent's own limit (null = back to the default)", async () => {
    render(<OwnLimits agent={agent({ unattendedSpendPerDay: 12 })} testId="control-limits" />)
    change('control-limits-spend')
    expect(screen.getByRole('spinbutton')).toHaveValue(12)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('builder', { unattendedSpendPerDay: null }))
  })

  it("a refused value says the server's words and keeps the editor open", async () => {
    mockedApi.agents.update.mockRejectedValueOnce(new Error('ownTurnsPerDay must be between 1 and 200'))
    render(<OwnLimits agent={agent()} testId="control-limits" />)
    change('control-limits-turns')
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('ownTurnsPerDay must be between 1 and 200')
    expect(screen.getByRole('spinbutton')).toBeInTheDocument()
  })
})
