// command-palette-answer.test.tsx — ⌘K «Answer «<asked>»»
// answers with the owner's ONE verb: `answer`
// with the choice and the question the row painted; a refusal is said in
// the palette, in the server's words (no «its page retries» any more).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommandPalette } from '../src/components/CommandPalette'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { resetTasksCache } from '../src/hooks/useTasks'
import type { AgentView, SiloRecordsPage } from '../src/lib/types'

vi.mock('../src/lib/api', async (orig) => {
  const real = await orig<typeof import('../src/lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      silos: { ...real.api.silos, records: vi.fn(), respond: vi.fn() },
      tasksAct: vi.fn(),
      tasksBySession: vi.fn(async () => ({})),
      taskSeen: { read: vi.fn(async () => ({ seen: {} })), mark: vi.fn(async () => null) },
    },
  }
})
const mocked = vi.mocked(api, { deep: true })
const PLAN = 'folder:/proj/ship'
const KEY = `${PLAN}/tasks/t1`
const agent: AgentView = { id: 'writer', name: 'Writer', emoji: '🛠', folder: '/proj', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  resetTasksCache()
  const page: SiloRecordsPage = {
    silo: { id: 'plans', name: 'Plans', state: 'active', freshness: null },
    kind: { name: 'plans/plan/task', states: [], columns: [], columnTypes: {}, facets: [], stateEdit: null },
    total: 1,
    matching: 1,
    offset: 0,
    limit: 200,
    said: null,
    unreadable: { count: 0, items: [] },
    records: [
      {
        key: KEY,
        id: 't1',
        identity: 'Write the page',
        state: 'blocked',
        stateLabel: 'blocked',
        at: null,
        anchors: { folder: '/proj' },
        cells: [],
        row: '',
        folded: false,
        overlay: false,
        conflict: false,
        remarks: [],
        file: '/proj/plans/ship.plan.json',
        parent: { key: PLAN, identity: 'Ship', at: '2026-11-01' },
        value: {
          id: 't1',
          title: 'Write the page',
          owner: 'writer',
          state: 'blocked',
          dependsOn: [],
          waitingOn: { owner: 'owner', action: 'decide', asked: 'Publish today?', options: ['Yes', 'No'] },
        },
      } as never,
    ],
  }
  mocked.silos.records.mockResolvedValue(page)
  useStore.setState({ modal: 'palette', silos: [], agents: [agent], page: null })
})

describe("⌘K — answer an agent's question", () => {
  it('a choice is the verb answer with its words and the question painted', async () => {
    mocked.tasksAct.mockResolvedValue({ key: KEY, record: { tasks: [{ id: 't1', state: 'pending' }] }, already: false, holds: [] })
    render(<CommandPalette />)
    fireEvent.click(await screen.findByTestId('palette-answer-ask'))
    fireEvent.click((await screen.findAllByTestId('palette-answer-option'))[0]!)
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'answer', text: 'Yes', asked: 'Publish today?' }))
  })
  it("a refusal is said in the palette in the server's words", async () => {
    mocked.tasksAct.mockRejectedValue(new Error('it asks something else now'))
    render(<CommandPalette />)
    fireEvent.click(await screen.findByTestId('palette-answer-ask'))
    fireEvent.click((await screen.findAllByTestId('palette-answer-option'))[0]!)
    expect(await screen.findByText('Not answered: it asks something else now')).toBeInTheDocument()
  })
})
