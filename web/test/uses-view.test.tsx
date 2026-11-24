// uses-view.test.tsx — Map › Uses: the matrix draws exactly what GET
// /api/uses says (row/column labels, one number per cell, nothing in an
// empty one), the axis pickers persist through the store and re-ask the
// server, the "shared by 2+" filter asks for min=2, a cell opens the
// conversations behind it and each opens its conversation. Plus the pure
// words/scale in lib/uses.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { UsesView } from '../src/components/UsesView'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { columnHeadings, columnTitle, compact, intensity, measureWords } from '../src/lib/uses'
import type { AgentView, UsesView as UsesData } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const NOW = Date.parse('2026-11-02T12:00:00Z')

function agent(over: Partial<AgentView>): AgentView {
  return { id: 'a', name: 'A', emoji: '🙂', folder: '/p', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...over }
}

function view(over: Partial<UsesData> = {}): UsesData {
  return {
    rows: [
      { id: 'builder', label: 'Builder', n: 3, m: 900 },
      { id: 'writer', label: 'Writer', n: 1, m: 10 },
    ],
    cols: [
      { id: 'claude-opus-5-5', label: 'claude-opus-5-5', n: 3, m: 800, rows: 2 },
      { id: 'silos-k1/kimi-k3', label: 'kimi-k3', sub: 'cheapestinference', n: 1, m: 110, rows: 1 },
    ],
    cells: [
      {
        r: 'builder',
        c: 'claude-opus-5-5',
        n: 2,
        m: 790,
        refs: [
          { s: 0, m: 700 },
          { s: 1, m: 90 },
        ],
      },
      { r: 'builder', c: 'silos-k1/kimi-k3', n: 1, m: 110, refs: [{ s: 1, m: 110 }] },
      { r: 'writer', c: 'claude-opus-5-5', n: 1, m: 10, refs: [{ s: 2, m: 10 }] },
    ],
    sessions: [
      { key: '-home-u-ci/s1', title: 'Rotate the VPS keys', agentId: 'builder', mtime: NOW - 3600_000, run: false },
      { key: '-home-u-ci/s2', title: 'Nightly check', agentId: 'builder', mtime: NOW - 7200_000, run: true },
      { key: '-home-u-silos/s3', title: 'Fix the parser', agentId: 'writer', mtime: NOW - 86_400_000, run: false },
    ],
    measure: 'tokens',
    considered: 5,
    truncated: { rows: 0, cols: 0 },
    now: NOW,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    usesPrefs: {},
    connection: 'connected',
    agents: [agent({ id: 'builder', name: 'Builder', emoji: '🛠' }), agent({ id: 'writer', name: 'Writer', emoji: '🧪' })],
  })
  mockedApi.uses.mockResolvedValue(view())
  mockedApi.patchPrefsUses.mockResolvedValue({})
})

describe('UsesView', () => {
  it('asks for agents × models over 30 days by default and draws rows, columns and cells literally', async () => {
    render(<UsesView />)
    expect(await screen.findByText('🛠 Builder')).toBeInTheDocument()
    expect(mockedApi.uses).toHaveBeenCalledWith({ rows: 'agent', cols: 'model', since: '30', runs: true, min: 1 })
    expect(screen.getByText('kimi-k3')).toBeInTheDocument()
    expect(screen.getByTestId('uses-summary')).toHaveTextContent('5 conversations in the last 30 days · 2 agents × 2 models')
    expect(screen.getByTestId('uses-summary')).toHaveTextContent('tokens = input + output')
    // three filled cells, the fourth (writer × kimi) is no button at all
    expect(screen.getAllByRole('button', { name: /: \d+ conversations?$/ })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /Dev × kimi-k3/ })).toBeNull()
  })

  it('the pickers persist through the store and re-ask the server; shared asks for min=2', async () => {
    render(<UsesView />)
    await screen.findByText('🛠 Builder')
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Columns' })).getByRole('radio', { name: 'Files' }))
    expect(mockedApi.patchPrefsUses).toHaveBeenCalledWith({ rows: 'agent', cols: 'file', since: '30' })
    await waitFor(() => expect(mockedApi.uses).toHaveBeenLastCalledWith({ rows: 'agent', cols: 'file', since: '30', runs: true, min: 1 }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Window' })).getByRole('radio', { name: '7d' }))
    fireEvent.click(screen.getByRole('switch', { name: /shared by 2\+ agents/ }))
    fireEvent.click(screen.getByRole('switch', { name: 'automation runs' }))
    await waitFor(() => expect(mockedApi.uses).toHaveBeenLastCalledWith({ rows: 'agent', cols: 'file', since: '7', runs: false, min: 2 }))
  })

  it('a cell opens the conversations behind it, newest first, each opening its conversation', async () => {
    const openSession = vi.fn().mockResolvedValue(undefined)
    const selectAgent = vi.fn()
    useStore.setState({ openSession, selectAgent })
    render(<UsesView />)
    fireEvent.click(await screen.findByRole('button', { name: '🛠 Builder × claude-opus-5-5: 2 conversations' }))
    const panel = screen.getByRole('complementary', { name: 'conversations in this cell' })
    expect(panel).toHaveTextContent('2 conversations · 790 tokens')
    const items = within(panel).getAllByRole('listitem')
    expect(items.map((li) => li.querySelector('p')?.textContent)).toEqual(['Rotate the VPS keys', 'Nightly check'])
    expect(items[1]).toHaveTextContent('· run')
    fireEvent.click(within(items[0]!).getByRole('button'))
    expect(selectAgent).toHaveBeenCalledWith('builder')
    expect(openSession).toHaveBeenCalledWith('-home-u-ci', 's1')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('an empty window says so and offers all time', async () => {
    mockedApi.uses.mockResolvedValue(view({ rows: [], cols: [], cells: [], sessions: [], considered: 0 }))
    render(<UsesView />)
    expect(await screen.findByText('No models used in the last 30 days.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'look at all time ›' }))
    expect(mockedApi.patchPrefsUses).toHaveBeenCalledWith({ rows: 'agent', cols: 'model', since: 'all' })
  })

  it('scoped to a project, it asks for that folder only', async () => {
    render(<UsesView embedded folder="/home/u/ci" />)
    await screen.findByText('🛠 Builder')
    expect(mockedApi.uses).toHaveBeenCalledWith(expect.objectContaining({ folder: '/home/u/ci' }))
  })
})

describe('lib/uses', () => {
  it('compact keeps a count inside a cell', () => {
    expect([compact(7), compact(1234), compact(45_600), compact(4_100_000), compact(42_000_000)]).toEqual(['7', '1.2k', '46k', '4.1M', '42M'])
  })
  it('measure words per kind', () => {
    expect(measureWords('tokens', 12_300)).toBe('12k tokens')
    expect(measureWords('tokens', 4_300)).toBe('4.3k tokens')
    expect(measureWords('calls', 1)).toBe('1 call')
    expect(measureWords('changes', 2, 1)).toBe('2 changes · 1 read')
    expect(measureWords('changes', 0, 0)).toBeNull()
    expect(measureWords(null, 3)).toBeNull()
  })
  it('intensity: blank when empty, one accent from faint to strong on a square-root scale', () => {
    expect(intensity(0, 10)).toBe(0)
    expect(intensity(10, 10)).toBeCloseTo(0.42)
    expect(intensity(1, 100)).toBeCloseTo(0.105)
    expect(intensity(1, 100)).toBeGreaterThan(0.07)
  })
  it('a file name two columns share gets its folder in front; nothing else changes', () => {
    const cols = [
      { id: '/h/ci/context/builder/README.md', label: 'README.md', sub: '~/ci/context/builder', n: 2 },
      { id: '/h/my-project/README.md', label: 'README.md', sub: '~/my-project', n: 1 },
      { id: '/h/my-project/CLAUDE.md', label: 'CLAUDE.md', sub: '~/my-project', n: 1 },
    ]
    expect([...columnHeadings(cols, 'file').values()]).toEqual(['builder/README.md', 'my-project/README.md', 'CLAUDE.md'])
    expect(columnTitle(cols[0]!, 'file')).toBe('~/ci/context/builder/README.md')
    expect(columnTitle({ id: 'silos-k1/kimi-k3', label: 'kimi-k3', sub: 'cheapestinference', n: 1 }, 'model')).toBe('kimi-k3 · cheapestinference')
  })
})
