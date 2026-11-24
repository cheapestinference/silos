// The harness (Claude Code | OpenCode) is chosen when an agent is created
// and never changed: the create modal offers it, the editor only states it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentModal } from '../src/components/AgentModal'
import { SettingsTab } from '../src/components/agent/SettingsTab'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/home/user/ana', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.agents.create.mockImplementation(async (input) => ({ agent: { id: String(input.name).toLowerCase(), name: input.name } as never }))
  mockedApi.agents.update.mockResolvedValue(undefined)
  mockedApi.complete.mockResolvedValue([])
  mockedApi.providers.list.mockResolvedValue([])
  mockedApi.overview.mockImplementation(async () => ({ agents: useStore.getState().agents, now: 0, warming: false }))
  useStore.setState({ agents: [], modal: null, error: null })
})

// the Engine field is drawn only when this machine can run more than one
describe('harness on create', () => {
  it('two usable engines: offers Claude Code (checked) and OpenCode', () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    expect(screen.getByRole('radio', { name: /Claude Code/ })).toBeChecked()
    expect(screen.getByLabelText('OpenCode')).not.toBeChecked()
  })

  it('sends framework: claude-code by default', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(mockedApi.agents.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pepe', framework: 'claude-code' })))
  })

  it('sends framework: opencode when OpenCode is picked', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.click(screen.getByLabelText('OpenCode'))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(mockedApi.agents.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pepe', framework: 'opencode' })))
  })

  it('one usable engine: no Engine field — the agent is born on the one this machine can run', async () => {
    mockedApi.harness.mockResolvedValue({
      compat: [{ harness: 'claude-code', state: 'missing', installed: null, message: 'Claude Code is not installed' }],
    } as never)
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    await waitFor(() => expect(screen.queryByLabelText('OpenCode')).toBeNull())
    expect(screen.queryByRole('radio', { name: /Claude Code/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(mockedApi.agents.create).toHaveBeenCalledWith(expect.objectContaining({ framework: 'opencode' })))
  })
})

describe('harness on edit', () => {
  it('states the harness as text, offers no radios, and never sends it', async () => {
    render(<SettingsTab agent={makeAgent({ framework: 'opencode' })} fields="runs" />)
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalled())
    expect(mockedApi.agents.update.mock.calls[0]![1]).not.toHaveProperty('framework')
  })

  it('a legacy agent without a harness reads as Claude Code', () => {
    render(<SettingsTab agent={makeAgent()} fields="runs" />)
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
  })
})
