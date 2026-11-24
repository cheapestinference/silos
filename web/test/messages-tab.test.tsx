// messages-tab.test.tsx — the agent page's Messages tab: received and sent
// merged into one list with a direction, the filters that narrow it, and the
// owner's settle of what was handed to them (it lands in the RECIPIENT's inbox).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MessagesTab } from '../src/components/agent/MessagesTab'
import { applyFilters, bands, mergeMessages, NO_FILTERS, tallies } from '../src/lib/messages-view'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentMessage, AgentView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function agent(id: string, name: string): AgentView {
  return { id, name, emoji: '·', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }
}
function msg(o: Partial<AgentMessage>): AgentMessage {
  return { id: 'm', from: 'builder', to: 'finance', at: '2026-10-23T10:00:00.000Z', text: 't', state: 'new', ...o }
}
const name = (id: string): string => id

describe('messages-view', () => {
  const inbox = [
    msg({ id: 'r1', from: 'builder', to: 'finance', text: 'invoice ready?', at: '2026-10-20T10:00:00.000Z' }),
    msg({ id: 'self', from: 'finance', to: 'finance', text: 'note to self', at: '2026-10-21T10:00:00.000Z' }),
  ]
  const sent = [
    msg({ id: 's1', from: 'finance', to: 'writer', text: 'draft the memo', state: 'answered', answer: 'done', at: '2026-10-22T10:00:00.000Z' }),
    msg({ id: 'self', from: 'finance', to: 'finance', text: 'note to self', at: '2026-10-21T10:00:00.000Z' }),
  ]
  const rows = mergeMessages('finance', inbox, sent)

  it('merges both feeds newest first, with direction and the other side; a message to itself shows once', () => {
    expect(rows.map((r) => [r.m.id, r.dir, r.with])).toEqual([
      ['s1', 'sent', 'writer'],
      ['self', 'received', 'finance'],
      ['r1', 'received', 'builder'],
    ])
  })

  it('filters by direction, state, person and text (answers included); counts follow the other filters', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, dir: 'sent' }, name).map((r) => r.m.id)).toEqual(['s1'])
    expect(applyFilters(rows, { ...NO_FILTERS, state: 'open' }, name).map((r) => r.m.id)).toEqual(['self', 'r1'])
    expect(applyFilters(rows, { ...NO_FILTERS, with: 'builder' }, name).map((r) => r.m.id)).toEqual(['r1'])
    expect(applyFilters(rows, { ...NO_FILTERS, q: 'DONE' }, name).map((r) => r.m.id)).toEqual(['s1'])
    const t = tallies(rows, { ...NO_FILTERS, dir: 'received' }, name)
    expect(t.dir).toEqual({ all: 3, received: 2, sent: 1 })
    expect(t.state).toEqual({ any: 2, open: 2, answered: 0 })
    expect(t.people.map((p) => p.id).sort()).toEqual(['builder', 'finance'])
  })

  it('bands by date: Today, Yesterday, This week, then by month', () => {
    const now = new Date('2026-11-23T15:00:00').getTime()
    const at = (s: string) => ({ m: msg({ at: new Date(s).toISOString() }), dir: 'received' as const, with: 'b' })
    const b = bands([at('2026-11-23T09:00:00'), at('2026-11-22T09:00:00'), at('2026-11-19T09:00:00'), at('2026-10-02T09:00:00')], now)
    expect(b.map((x) => x.label)).toEqual(['Today', 'Yesterday', 'This week', 'October 2026'])
  })
})

describe('MessagesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useStore.setState({ agents: [agent('finance', 'Finance'), agent('builder', 'Builder'), agent('writer', 'Writer')] })
  })

  it("pins what waits on the owner and settles it in the recipient's inbox", async () => {
    const handed = msg({ id: 'h1', from: 'finance', to: 'writer', text: 'sign the contract', state: 'needs_owner' })
    mockedApi.messages.list.mockResolvedValue([])
    mockedApi.messages.sent.mockResolvedValue([handed])
    mockedApi.messages.setState.mockResolvedValue({ ...handed, state: 'answered' })
    render(<MessagesTab agent={agent('finance', 'Finance')} />)
    const pinned = await screen.findByRole('region', { name: 'Waiting on you' })
    fireEvent.click(within(pinned).getByRole('button', { name: 'Answered' }))
    await waitFor(() => expect(mockedApi.messages.setState).toHaveBeenCalledWith('writer', 'h1', 'answered'))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull())
  })

  it('pages long lists and a filter narrows the rows', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      msg({ id: `r${i}`, from: i % 2 ? 'builder' : 'writer', at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() }),
    )
    mockedApi.messages.list.mockResolvedValue(many)
    mockedApi.messages.sent.mockResolvedValue([])
    render(<MessagesTab agent={agent('finance', 'Finance')} />)
    await waitFor(() => expect(screen.getAllByTestId('message-row')).toHaveLength(25))
    fireEvent.click(screen.getByRole('button', { name: /Show 5 more/ }))
    expect(screen.getAllByTestId('message-row')).toHaveLength(30)
    fireEvent.click(within(screen.getByRole('group', { name: 'With' })).getByRole('button', { name: /Builder/ }))
    expect(screen.getAllByTestId('message-row')).toHaveLength(15)
  })
})
