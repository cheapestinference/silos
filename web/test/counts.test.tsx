// counts.test.tsx — every printed count reads the server's UNCAPPED totals
// (lib/counts.ts): the overview caps each agent's list (40 conversations +
// 10 runs per automation), so a count is never that list's length
// (otherwise Builder reads "1399 conversations" for 3 real + every run, an
// automation's badge reads 10 for 1,396 runs).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionsMaintenance } from '../src/components/settings/SessionsMaintenance'
import { useStore } from '../src/store'
import { countsOf, conversationsAndRuns } from '../src/lib/counts'
import { countsInFolder } from '../src/lib/home'
import type { AgentView, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')

const session = (o: Partial<SessionView> = {}): SessionView => ({
  id: 's',
  folder: 'f',
  title: 'S',
  skills: [],
  cwd: '/p',
  mtime: 1_700_000_000_000,
  size: 100,
  turnCount: 1,
  live: false,
  worktree: false,
  native: true,
  agentId: 'builder',
  ...o,
})
const agent = (o: Partial<AgentView> = {}): AgentView => ({
  id: 'builder',
  name: 'Builder',
  emoji: '🛠',
  folder: '/p',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  ...o,
})
const run = (i: number, automationId = 'hourly'): SessionView => session({ id: `r${i}`, origin: { kind: 'automation', automationId, runId: `run${i}` } })

beforeEach(() => {
  useStore.setState({ agents: [], automations: [], automationsPending: [], page: null, selected: null })
})

describe('countsOf / conversationsAndRuns / countsInFolder', () => {
  it('reads the server totals, never the capped list', () => {
    const a = agent({ sessions: [session(), run(1)], counts: { conversations: 3, runs: 1396, runsByAutomation: { hourly: 1396 }, byCwd: {} } })
    expect(conversationsAndRuns(countsOf(a))).toBe('3 conversations · 1,396 runs')
  })
  it('never counts the capped list — no totals, nothing counted', () => {
    expect(countsOf(agent({ sessions: [session(), session({ id: 's2' }), run(1)] }))).toMatchObject({ conversations: 0, runs: 0 })
  })
  it('countsInFolder: only cwds at or under the folder', () => {
    const a = agent({
      counts: {
        conversations: 9,
        runs: 2,
        runsByAutomation: {},
        byCwd: { '/p': { conversations: 1, runs: 2 }, '/p/x': { conversations: 3, runs: 0 }, '/px': { conversations: 5, runs: 0 } },
      },
    })
    expect(countsInFolder(a, '/p')).toMatchObject({ conversations: 4, runs: 2 })
  })
})

describe('Settings › Sessions — the header counts every transcript, split by kind', () => {
  it('conversations and runs come from the totals; the listed number is said as listed', () => {
    const a = agent({ sessions: [session(), run(1)], counts: { conversations: 3, runs: 1396, runsByAutomation: { hourly: 1396 }, byCwd: {} } })
    const m = agent({
      id: 'master',
      name: 'Anywhere',
      folder: null,
      sessions: [session({ id: 'm1', agentId: 'master', cwd: '/q' })],
      counts: { conversations: 12, runs: 0, runsByAutomation: {}, byCwd: {} },
    })
    useStore.setState({ agents: [a, m] })
    render(<SessionsMaintenance />)
    const header = screen.getByTestId('sessions-totals')
    expect(header).toHaveTextContent('15 conversations · 1,396 automation runs')
    expect(header).toHaveTextContent('3 listed')
  })
})
