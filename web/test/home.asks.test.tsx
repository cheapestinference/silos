// home.asks.test.tsx — an OpenCode agent's permission ask in Needs you:
// one row per conversation (it takes over that conversation's plain "asks
// you" row), answered in place with Allow / Deny.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HomePage } from '../src/components/home/HomePage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { ANSWER_GRACE_MS, answerHidden, pruneAnswered } from '../src/lib/home'
import { askRow } from './inbox-rows'
import { openNeedsYou } from './home-tiles'
import type { AgentView, NeedsYouItem, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const NOW = Date.parse('2026-10-26T12:00:00.000Z')
const ask = (over: Partial<Extract<NeedsYouItem, { kind: 'ask' }>> = {}): NeedsYouItem => ({
  kind: 'ask',
  agentId: 'finance',
  sessionId: 'ses_1',
  folder: '-home-u-books',
  id: 'perm_1',
  title: 'bash rm -rf dist',
  pattern: 'rm -rf dist',
  type: 'bash',
  at: '2026-10-26T11:58:00.000Z',
  ...over,
})
// GET /api/board as the server returns it: the file-borne asks AND the inbox
// it composed from them
const board = (asks: NeedsYouItem[]) => ({
  cards: [],
  needsYou: asks,
  inbox: asks.flatMap((a) =>
    a.kind === 'ask'
      ? [
          askRow({
            agentId: a.agentId,
            folder: a.folder,
            id: a.sessionId,
            title: a.title,
            at: Date.parse(a.at),
            permission: { id: a.id, type: a.type, pattern: a.pattern },
          }),
        ]
      : [],
  ),
})
function makeAgent(sessions: SessionView[] = []): AgentView {
  return { id: 'finance', name: 'Finance', emoji: '💰', folder: '/home/u/books', skills: [], sessions, liveCount: 0, sessionCount: sessions.length }
}

// the composition (a permission ask wins its conversation's row) is the
// server's — server/test/inbox.test.ts

describe('answered asks — hidden only while the board still lists them, for a grace window', () => {
  it('pruneAnswered drops an id the current load no longer lists; a later re-appearance is a fresh row', () => {
    const answered = new Map([
      ['perm_1', NOW],
      ['perm_2', NOW],
    ])
    const pruned = pruneAnswered(answered, [ask({ id: 'perm_2' })])
    expect([...pruned.keys()]).toEqual(['perm_2'])
    expect(answerHidden(pruned, 'perm_1', NOW)).toBe(false) // shows again if it comes back
    expect(answerHidden(pruned, 'perm_2', NOW + ANSWER_GRACE_MS - 1)).toBe(true)
    expect(answerHidden(pruned, 'perm_2', NOW + ANSWER_GRACE_MS)).toBe(false)
  })
  it('pruneAnswered keeps the same Map when nothing changes (no re-render churn)', () => {
    const answered = new Map([['perm_1', NOW]])
    expect(pruneAnswered(answered, [ask()])).toBe(answered)
  })
})

describe('HomePage — Allow / Deny on a permission ask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedApi.tasks.mockResolvedValue({ sessions: [] })
    mockedApi.asks.reply.mockResolvedValue(undefined)
    useStore.setState({ agents: [makeAgent()], automations: [], automationsPending: [], nowTick: NOW, page: null })
  })

  it('names the agent and the command it asks to run, with Allow and Deny', async () => {
    mockedApi.board.mockResolvedValue(board([ask()]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    const code = await within(inbox).findByText('bash rm -rf dist')
    expect(within(code.parentElement!).getByText('Finance')).toBeInTheDocument()
    expect(within(inbox).getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    expect(within(inbox).getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('Allow posts the reply and the row leaves at once', async () => {
    mockedApi.board.mockResolvedValue(board([ask()]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    await within(inbox).findByText('bash rm -rf dist')
    mockedApi.board.mockResolvedValue(board([]))
    fireEvent.click(within(inbox).getByRole('button', { name: 'Allow' }))
    expect(within(inbox).queryByText('bash rm -rf dist')).not.toBeInTheDocument()
    expect(mockedApi.asks.reply).toHaveBeenCalledWith('finance', 'ses_1', 'perm_1', 'allow')
    await waitFor(() => expect(mockedApi.board.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it("Deny posts 'deny'", async () => {
    mockedApi.board.mockResolvedValue(board([ask()]))
    render(<HomePage />)
    fireEvent.click(within(await openNeedsYou()).getByRole('button', { name: 'Deny' }))
    expect(mockedApi.asks.reply).toHaveBeenCalledWith('finance', 'ses_1', 'perm_1', 'deny')
  })

  it('a failed reply brings the row back and says so', async () => {
    mockedApi.board.mockResolvedValue(board([ask()]))
    mockedApi.asks.reply.mockRejectedValue(new Error('no such ask — already answered or gone'))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(within(inbox).getByRole('button', { name: 'Allow' }))
    expect(await screen.findByText('no such ask — already answered or gone')).toBeInTheDocument()
    expect(within(inbox).getByText('bash rm -rf dist')).toBeInTheDocument()
  })

  it('an answer the plugin failed to deliver comes back: the ask still listed after the grace window shows again', async () => {
    mockedApi.board.mockResolvedValue(board([ask()])) // the plugin never collects the reply
    render(<HomePage />)
    const inbox = await openNeedsYou()
    await within(inbox).findByText('bash rm -rf dist')
    fireEvent.click(within(inbox).getByRole('button', { name: 'Allow' }))
    expect(within(inbox).queryByText('bash rm -rf dist')).not.toBeInTheDocument()
    await waitFor(() => expect(mockedApi.board.mock.calls.length).toBeGreaterThanOrEqual(2))
    // the reload still lists it, but within the grace window it stays hidden
    expect(within(inbox).queryByText('bash rm -rf dist')).not.toBeInTheDocument()
    act(() => useStore.setState({ nowTick: NOW + 16_000 }))
    expect(await within(inbox).findByText('bash rm -rf dist')).toBeInTheDocument()
  })

  it('a permission with nothing to quote reads "asks for a permission"', async () => {
    mockedApi.board.mockResolvedValue(board([ask({ title: '', pattern: null, type: '' })]))
    render(<HomePage />)
    expect(within(await openNeedsYou()).getByText(/asks for a permission/)).toBeInTheDocument()
    expect(screen.queryByText(/asks:/)).not.toBeInTheDocument()
  })

  it('the row itself opens the conversation', async () => {
    const openSession = vi.fn(async () => {})
    useStore.setState({ openSession } as never)
    mockedApi.board.mockResolvedValue(board([ask()]))
    render(<HomePage />)
    fireEvent.click(within(await openNeedsYou()).getByText('bash rm -rf dist'))
    expect(openSession).toHaveBeenCalledWith('-home-u-books', 'ses_1')
  })
})
