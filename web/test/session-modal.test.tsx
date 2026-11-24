// session-modal.test.tsx — a conversation read as a window over everything,
// without leaving the one you are in (the subagent-transcript pattern).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionModal } from '../src/components/SessionModal'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.sessionDetail.mockResolvedValue({
    meta: {
      id: 's1',
      folder: '-p',
      title: 'Digest run',
      skills: [],
      cwd: null,
      mtime: 0,
      size: 1,
      turnCount: 2,
      live: false,
      worktree: false,
      native: true,
      agentId: 'a1',
    } as never,
    turns: [
      { index: 0, role: 'user', text: 'hello', tools: [], ts: null },
      { index: 1, role: 'assistant', text: 'done', tools: [], ts: null },
    ],
    total: 2,
  })
  useStore.setState({ agents: [], selected: null, detail: null, readingSession: null, active: null })
})

describe('SessionModal', () => {
  it('nothing to read → nothing rendered', () => {
    render(<SessionModal />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reads the conversation in a dialog named after it; Esc puts it down', async () => {
    useStore.setState({ readingSession: { folder: '-p', id: 's1' } })
    render(<SessionModal />)
    expect(await screen.findByText('hello')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Conversation · Digest run' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().readingSession).toBeNull()
  })

  it('"Open conversation →" makes it the real open conversation and closes the window', async () => {
    useStore.setState({ readingSession: { folder: '-p', id: 's1' } })
    render(<SessionModal />)
    await screen.findByText('hello')
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation →' }))
    expect(useStore.getState().readingSession).toBeNull()
    await waitFor(() => expect(useStore.getState().selected).toEqual({ folder: '-p', id: 's1' }))
  })

  it('the ✕ closes it too', async () => {
    useStore.setState({ readingSession: { folder: '-p', id: 's1' } })
    render(<SessionModal />)
    await screen.findByText('hello')
    fireEvent.click(screen.getByLabelText('Close conversation window'))
    expect(useStore.getState().readingSession).toBeNull()
  })
})
