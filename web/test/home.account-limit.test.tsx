// A usage limit is the ACCOUNT's (server inbox.ts accountLimitRows): Home says
// the account, the window and when it frees up, in ONE row however many
// automations it stopped; Seen = this episode; a project sees only its own.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, within } from '@testing-library/react'
import { HomePage } from '../src/components/home/HomePage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { headline, limitWords, resetWords, scopeInbox, stoppedWords } from '../src/lib/home'
import type { AgentView, InboxRow } from '../src/lib/types'
import { accountLimitRow } from './inbox-rows'
import { openNeedsYou } from './home-tiles'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })
const NOW = Date.parse('2026-10-19T12:00:00.000Z')
const local = new Date(NOW)
const at = (d: Date) => `at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const TOMORROW_6 = new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1, 6, 0)

function agent(o: Partial<AgentView>): AgentView {
  return { id: 'builder', name: 'Builder', emoji: '🛠', folder: '/proj', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...o }
}
const board = (inbox: InboxRow[]) => ({ cards: [], needsYou: [], inbox })

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.tasks.mockResolvedValue({ sessions: [] })
  mockedApi.needsYou.ack.mockResolvedValue(undefined)
  useStore.setState({
    agents: [agent({}), agent({ id: 'finance', name: 'Finance', emoji: '💶' })],
    automations: [],
    automationsPending: [],
    nowTick: NOW,
    page: null,
  })
})

describe('the words', () => {
  it('the window and its reset; without a reading, the plain fact', () => {
    expect(resetWords(TOMORROW_6.toISOString(), NOW)).toBe(`tomorrow ${at(TOMORROW_6)}`)
    const row = accountLimitRow({ resetsAt: TOMORROW_6.toISOString() })
    expect(limitWords(row, NOW)).toBe(`Your Claude account: Fable at 100% — resets tomorrow ${at(TOMORROW_6)}`)
    expect(limitWords(accountLimitRow({ window: false }), NOW)).toBe('Your Claude account hit its usage limit')
    expect(stoppedWords(['A'])).toBe("A couldn't run")
    expect(stoppedWords(['A', 'B'])).toBe("2 automations couldn't run: A and B")
    expect(stoppedWords(['A', 'B', 'C', 'D'])).toBe("4 automations couldn't run: A, B and 2 more")
  })

  it('the pulse sentence leads with the account', () => {
    const row = accountLimitRow({ resetsAt: TOMORROW_6.toISOString() })
    expect(headline({ inbox: [row], working: [], agentName: (id) => id, now: NOW, ago: () => '' })).toBe(
      `Your Claude account: Fable at 100% — resets tomorrow ${at(TOMORROW_6)}.`,
    )
  })
})

describe('scopeInbox — a project sees the account only through its own automations', () => {
  it("keeps the row with only the folder's automations, or drops it", () => {
    const row = accountLimitRow()
    const mine = scopeInbox([row], '/proj', new Set(['finance']), 'master')
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ automations: [{ id: 'fiscal' }], agentIds: ['finance'] })
    expect(scopeInbox([row], '/proj', new Set(['writer']), 'master')).toEqual([])
  })
})

describe('HomePage — the account row', () => {
  it('one row: the window, what it stopped; Seen acks this episode; it opens the automations', async () => {
    mockedApi.board.mockResolvedValue(board([accountLimitRow({ resetsAt: TOMORROW_6.toISOString(), at: NOW - 60_000 })]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    const body = await within(inbox).findByText(/^Your Claude account: Fable at 100%/)
    expect(body.textContent).toBe(
      `Your Claude account: Fable at 100% — resets tomorrow ${at(TOMORROW_6)} · 2 automations couldn't run: Tax watch and 3DS watch`,
    )
    expect(within(inbox).getByText(/^usage limit ·/)).toBeInTheDocument()
    fireEvent.click(body)
    expect(useStore.getState().page).toEqual({ kind: 'automations' })
    // navigating closed the sheet: Seen is one more open away
    fireEvent.click(within(await openNeedsYou()).getByRole('button', { name: 'Seen' }))
    expect(mockedApi.needsYou.ack).toHaveBeenCalledWith({ kind: 'limit', key: 'default', version: TOMORROW_6.toISOString() })
  })

  it("a row for one agent opens that agent's automations", async () => {
    mockedApi.board.mockResolvedValue(board([accountLimitRow({ automations: [{ id: 'fiscal', name: 'Tax watch', agentId: 'finance' }] })]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByText(/^Your Claude account/))
    expect(useStore.getState().page).toEqual({ kind: 'automations', agent: 'finance' })
  })
})
