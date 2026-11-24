// artifacts-block.test.tsx — the aggregated artifacts list block (an
// agent's Sessions facet / ProjectPage): row rendering with real
// (mocked) server data, fetch scoping, an honest empty state, and the two
// click paths (the URL in a new tab via <a>, the source conversation via a button).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactsBlock } from '../src/components/ArtifactsBlock'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { ArtifactItem } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function makeArtifact(overrides: Partial<ArtifactItem> = {}): ArtifactItem {
  return {
    title: 'report.html',
    url: 'https://claude.ai/a/1',
    path: '/tmp/out/report.html',
    ts: '2026-08-20T10:00:00.000Z',
    sessionKey: '-tmp-p/s1',
    sessionTitle: 'FINANCE Report',
    agentId: 'finance',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ArtifactsBlock', () => {
  it('requests the right scope and paints title + source session', async () => {
    mockedApi.artifacts.mockResolvedValue({ artifacts: [makeArtifact()], total: 1 })
    render(<ArtifactsBlock agentId="finance" />)
    await waitFor(() => expect(screen.getByText('report.html')).toBeInTheDocument())
    expect(mockedApi.artifacts).toHaveBeenCalledWith({ agent: 'finance' })
    expect(screen.getByText('FINANCE Report')).toBeInTheDocument()
    // the main row is a real link to the artifact's URL, a new tab
    const link = screen.getByText('report.html').closest('a')
    expect(link).toHaveAttribute('href', 'https://claude.ai/a/1')
    expect(link).toHaveAttribute('target', '_blank')
    // an explicit noopener as a belt-and-suspenders (the server already filters schemes)
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('scoped by folder (ProjectPage)', async () => {
    mockedApi.artifacts.mockResolvedValue({ artifacts: [], total: 0 })
    render(<ArtifactsBlock folder="/tmp/p" />)
    await waitFor(() => expect(mockedApi.artifacts).toHaveBeenCalledWith({ folder: '/tmp/p' }))
  })

  it('a failed fetch → an honest empty state, without breaking the tab', async () => {
    mockedApi.artifacts.mockRejectedValue(new Error('boom'))
    render(<ArtifactsBlock agentId="finance" />)
    await waitFor(() => expect(screen.getByText('No artifacts yet')).toBeInTheDocument())
  })

  it('the secondary affordance opens the source conversation (agent + session)', async () => {
    mockedApi.artifacts.mockResolvedValue({ artifacts: [makeArtifact()], total: 1 })
    const selectAgent = vi.fn()
    const openSession = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ selectAgent, openSession })
    render(<ArtifactsBlock agentId="finance" />)
    await waitFor(() => expect(screen.getByText('FINANCE Report')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Open the conversation that produced it'))
    expect(selectAgent).toHaveBeenCalledWith('finance')
    expect(openSession).toHaveBeenCalledWith('-tmp-p', 's1')
  })

  it('an honest foot when the response comes capped ("the latest N of total")', async () => {
    mockedApi.artifacts.mockResolvedValue({
      artifacts: [makeArtifact(), makeArtifact({ url: 'https://claude.ai/a/2', title: 'dash.html' })],
      total: 5,
    })
    render(<ArtifactsBlock agentId="finance" />)
    await waitFor(() => expect(screen.getByText(/2 of 5/)).toBeInTheDocument())
  })
})
