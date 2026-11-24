// background-page.test.tsx — the global background-work view: every recent session's
// subagents in one page, grouped by conversation, live first; a row
// navigates to its conversation (where the census column takes over).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BackgroundPage } from '../src/components/BackgroundPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const NOW = 1_700_000_000_000

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ nowTick: NOW })
})

describe('BackgroundPage', () => {
  it('groups background agents under their conversation and marks the live ones', async () => {
    mockedApi.tasks.mockResolvedValue({
      sessions: [
        {
          folder: 'f',
          id: 's1',
          title: 'Ultra review',
          agentId: 'a1',
          cwd: '/home/u/x',
          mtime: NOW - 60_000,
          subagents: [
            { id: 'v1', description: 'Verify finding 3', type: 'general-purpose', mtime: NOW - 30_000, lastTool: 'Read' },
            { id: 'v2', description: 'Verify finding 4', type: 'general-purpose', mtime: NOW - 3 * 3600_000 },
          ],
        },
      ],
    })
    render(<BackgroundPage />)
    await waitFor(() => expect(screen.getByText('Ultra review')).toBeInTheDocument())
    expect(screen.getByText('Verify finding 3')).toBeInTheDocument()
    expect(screen.getByText('Verify finding 4')).toBeInTheDocument()
    // the fresh one is at work (live derivation from mtime), the stale one is not
    expect(screen.getAllByText(/at work/)).toHaveLength(1)
    expect(screen.getByText(/Read/)).toBeInTheDocument()
  })

  it('a conversation header navigates to the session', async () => {
    mockedApi.tasks.mockResolvedValue({
      sessions: [
        {
          folder: 'f',
          id: 's1',
          title: 'Ultra review',
          agentId: 'a1',
          cwd: null,
          mtime: NOW,
          subagents: [{ id: 'v1', description: null, type: null, mtime: NOW }],
        },
      ],
    })
    const openSpy = vi.fn()
    useStore.setState({ openSession: openSpy as never })
    render(<BackgroundPage />)
    await waitFor(() => expect(screen.getByText('Ultra review')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Ultra review/ }))
    expect(openSpy).toHaveBeenCalledWith('f', 's1')
  })
})
