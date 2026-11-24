// run-row.test.tsx — one run, two ways in: READ its conversation as a window
// (SessionModal) or OPEN it as the real conversation.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RunRow, sessionOfRun } from '../src/components/RunRow'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { Run } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const run = (o: Partial<Run> = {}): Run => ({ id: 'r1', automationId: 'a', at: '2026-08-29T10:00:00.000Z', status: 'ok', durationMs: 12000, ...o })

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.sessionDetail.mockResolvedValue({
    meta: {
      id: 's1',
      folder: '-p',
      title: 'Run',
      skills: [],
      cwd: null,
      mtime: 0,
      size: 1,
      turnCount: 0,
      live: false,
      worktree: false,
      native: true,
      agentId: 'a1',
    } as never,
    turns: [],
    total: 0,
  })
  useStore.setState({ agents: [], selected: null, detail: null, readingSession: null })
})

describe('RunRow', () => {
  it('sessionOfRun splits "folder/id"; no sessionKey → null', () => {
    expect(sessionOfRun(run({ sessionKey: '-home-u-p/sess-1' }))).toEqual({ folder: '-home-u-p', id: 'sess-1' })
    expect(sessionOfRun(run())).toBeNull()
  })

  it('a run with a conversation: the row READS it (a window), "Open conversation" OPENS it', async () => {
    render(
      <ul>
        <RunRow run={run({ sessionKey: '-p/s1' })} />
      </ul>,
    )
    fireEvent.click(screen.getByTitle('Read the conversation'))
    expect(useStore.getState().readingSession).toEqual({ folder: '-p', id: 's1' })
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }))
    await waitFor(() => expect(useStore.getState().selected).toEqual({ folder: '-p', id: 's1' }))
    expect(mockedApi.sessionDetail).toHaveBeenCalledWith('-p', 's1')
  })

  it('a run that opened no conversation (skipped, queued) offers neither', () => {
    render(
      <ul>
        <RunRow run={run({ status: 'skipped', reason: 'no changes' })} />
      </ul>,
    )
    expect(screen.queryByTitle('Read the conversation')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open conversation' })).toBeNull()
  })
})

describe('RunRow — a result, not a status', () => {
  it('a run with an outcome shows its result, never the bare status', () => {
    render(
      <ul>
        <RunRow run={run({ outcome: 'acted', summary: 'Answered 2 cases.' })} />
      </ul>,
    )
    expect(screen.getByTitle('Answered 2 cases.')).toBeInTheDocument()
    expect(screen.queryByText('ok')).toBeNull()
  })
  it('a failed run keeps the raw error on its title', () => {
    const error = 'Claude Code returned an error result: API Error: 400 bad model'
    const { container } = render(
      <ul>
        <RunRow run={run({ status: 'failed', error })} />
      </ul>,
    )
    expect(container.querySelector(`[title="${error}"]`)).not.toBeNull()
  })
})
