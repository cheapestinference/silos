import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
vi.mock('../src/lib/api')
import { api } from '../src/lib/api'
import { findRefs, resetConversationRefs } from '../src/lib/conversation-refs'
import { Markdown } from '../src/components/Turn'
import { useStore } from '../src/store'

const mocked = vi.mocked(api, { deep: true })
const ID = '9c62c5c2-88a5-4545-9f5c-13b5bf311b4a'

describe('findRefs — what an agent writes about another conversation', () => {
  it('finds session names and ids, never one inside the other', () => {
    const f = findRefs(`ask silos-35 and ci-prune-old-rule-29 about ${ID}; acme-7a too`)
    expect(f.map((x) => [x.kind, x.token])).toEqual([
      ['name', 'silos-35'],
      ['name', 'ci-prune-old-rule-29'],
      ['id', ID],
      ['name', 'acme-7a'],
    ])
  })
  it('plain words are not candidates', () => {
    expect(findRefs('a well-known follow-up, version 2.1 and item-1')).toEqual([])
  })
})

describe('in a message, a known conversation reads as its title and opens it', () => {
  beforeEach(() => {
    resetConversationRefs()
    vi.clearAllMocks()
    mocked.conversationRefs.mockResolvedValue({
      'silos-3d': { sessionId: ID, folder: '-home-user-silos', agentId: 'silos', title: 'Bottom terminal disconnects', live: true },
    })
    useStore.setState({ agents: [] })
  })
  it('text and inline code both become the title; an unknown token stays as written', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ openSession: open } as never)
    render(<Markdown text={'silos-3d is on it; `silos-3d` too; silos-99 is not a conversation'} />)
    await waitFor(() => expect(screen.getAllByTestId('conversation-ref')).toHaveLength(2))
    expect(screen.getAllByText('Bottom terminal disconnects')).toHaveLength(2)
    expect(screen.getByText(/silos-99 is not a conversation/)).toBeTruthy()
    // one batched question for every token on the page
    expect(mocked.conversationRefs).toHaveBeenCalledTimes(1)
    expect(mocked.conversationRefs.mock.calls[0]![0].sort()).toEqual(['silos-3d', 'silos-99'])
    fireEvent.click(screen.getAllByTestId('conversation-ref')[0]!)
    expect(open).toHaveBeenCalledWith('-home-user-silos', ID)
  })
  it('a link the author wrote is left alone', async () => {
    render(<Markdown text={'[silos-3d](https://example.com)'} />)
    expect(screen.getByRole('link', { name: 'silos-3d' }).getAttribute('href')).toBe('https://example.com')
    expect(mocked.conversationRefs).not.toHaveBeenCalled()
  })
})
