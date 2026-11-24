// command-palette-artifacts.test.tsx — artifacts as a searchable source
// for the ⌘K palette (an aggregated list): "artifact: <title>" entries
// behind the conversations, filtered by the same `q`, Enter/click opens
// the URL in a new tab and closes the palette. Its own file (the
// palette's base suite doesn't mock lib/api — here the server's data is
// actually needed).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommandPalette } from '../src/components/CommandPalette'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, ArtifactItem, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/tmp/p', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}
function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'Fix the parser',
    skills: [],
    cwd: '/tmp/p',
    mtime: 1000,
    size: 1,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...overrides,
  }
}
function makeArtifact(overrides: Partial<ArtifactItem> = {}): ArtifactItem {
  return {
    title: 'report.html',
    url: 'https://claude.ai/a/1',
    path: '/tmp/out/report.html',
    ts: '2026-08-20T10:00:00.000Z',
    sessionKey: 'f/s1',
    sessionTitle: 'Fix the parser',
    agentId: 'a1',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    modal: 'palette',
    agents: [makeAgent({ sessions: [makeSession()] })],
  })
})

describe('CommandPalette — artifacts as a source', () => {
  it('lists the "artifact: <title>" entry with its source session', async () => {
    mockedApi.artifacts.mockResolvedValue({ artifacts: [makeArtifact()], total: 1 })
    render(<CommandPalette />)
    await waitFor(() => expect(screen.getByText(/report\.html/)).toBeInTheDocument())
    expect(screen.getByText('artifact:')).toBeInTheDocument()
    expect(screen.getByText('# Fix the parser')).toBeInTheDocument()
  })

  it('the same `q` filters artifacts (by title) alongside the other sources', async () => {
    mockedApi.artifacts.mockResolvedValue({
      artifacts: [makeArtifact(), makeArtifact({ url: 'https://claude.ai/a/2', title: 'dash.html', sessionTitle: 'Dashboard' })],
      total: 2,
    })
    render(<CommandPalette />)
    await waitFor(() => expect(screen.getByText(/dash\.html/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'dash' } })
    await waitFor(() => expect(screen.queryByText(/report\.html/)).not.toBeInTheDocument())
    expect(screen.getByText(/dash\.html/)).toBeInTheDocument()
  })

  it('activating an artifact opens the URL in a new tab and closes the palette', async () => {
    mockedApi.artifacts.mockResolvedValue({ artifacts: [makeArtifact()], total: 1 })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<CommandPalette />)
    await waitFor(() => expect(screen.getByText(/report\.html/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/report\.html/))
    expect(open).toHaveBeenCalledWith('https://claude.ai/a/1', '_blank', 'noopener,noreferrer')
    expect(useStore.getState().modal).toBeNull()
    open.mockRestore()
  })

  it('with no artifacts (or a failed fetch), the palette stays the same as always', async () => {
    mockedApi.artifacts.mockRejectedValue(new Error('boom'))
    render(<CommandPalette />)
    // the conversation is still listed; no artifact row
    expect(screen.getByText('Fix the parser')).toBeInTheDocument()
    await waitFor(() => expect(mockedApi.artifacts).toHaveBeenCalled())
    expect(screen.queryByText('artifact:')).not.toBeInTheDocument()
  })

  it('says how many OpenCode conversations the message search could not read, and nothing when all were read', async () => {
    mockedApi.artifacts.mockResolvedValue({ artifacts: [], total: 0 })
    mockedApi.search.mockResolvedValue({ hits: [], scanned: 4, truncated: false, unsearched: 2, unsearchedBy: { opencode: 2 } })
    render(<CommandPalette />)
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'deploy' } })
    expect(await screen.findByText(/not searched in 2 OpenCode conversations/)).toBeInTheDocument()
    mockedApi.search.mockResolvedValue({ hits: [], scanned: 4, truncated: false, unsearched: 0 })
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'deploys' } })
    await waitFor(() => expect(screen.queryByText(/not searched in/)).not.toBeInTheDocument())
  })
})
