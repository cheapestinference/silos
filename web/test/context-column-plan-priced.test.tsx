// context-column-plan-priced.test.tsx — a plan-priced OpenCode conversation
// (every assistant message reported $0: a subscription priced it) says so in
// plain words where the dollar amount would be — never "$0.00".
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ContextColumn } from '../src/components/ContextColumn'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, SessionContext, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const agent = { id: 'a1', name: 'Ana', emoji: '🧠', role: 'writer', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0 } as AgentView
const meta: SessionView = {
  id: 's1',
  folder: 'f',
  title: 'Session',
  skills: [],
  cwd: null,
  mtime: 0,
  size: 0,
  turnCount: 0,
  live: false,
  worktree: false,
  native: true,
  agentId: 'a1',
  harness: 'opencode',
}
function context(cost: SessionContext['cost']): SessionContext {
  return {
    plan: null,
    agents: [],
    pending: null,
    links: { prs: [], artifacts: [], worktree: null },
    events: [],
    files: [],
    tools: [],
    flags: { remote: false, permissionMode: null, gitBranch: null, effort: null, model: 'minimax-coding-plan/MiniMax-M2.7' },
    waiting: null,
    cost,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.patchPrefsContextScope.mockResolvedValue({})
  useStore.setState({
    chatMode: 'chat',
    agents: [agent],
    automations: [],
    automationsPending: [],
    nowTick: Date.now(),
    selectedAgentId: 'a1',
    selected: { folder: 'f', id: 's1' },
    active: null,
    modal: null,
    error: null,
    page: null,
    contextOpen: true,
    contextScope: 'conversation',
    convPrefs: {},
    pendingConvPrefs: {},
    turnOverrides: {},
    catalog: [],
    providers: [],
  })
})

describe('cost line — plan-priced', () => {
  it('shows the tokens and "plan-priced" instead of $0.00', () => {
    useStore.setState({
      detail: {
        meta,
        turns: [],
        total: 0,
        context: context({
          totalUsd: 0,
          unknownModels: false,
          planPriced: true,
          byModel: [
            { model: 'minimax-coding-plan/MiniMax-M2.7', usd: 0, inputTokens: 12_000, outputTokens: 3_000, cacheReadTokens: 30_000, cacheCreationTokens: 0 },
          ],
        }),
      },
    })
    render(<ContextColumn />)
    expect(screen.getByText(/plan-priced/)).toHaveTextContent('42k in · 3k out · plan-priced')
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument()
    expect(screen.queryByText(/API price/)).not.toBeInTheDocument()
  })

  it('the runs-on line names the OpenCode model and provider', () => {
    useStore.setState({
      detail: { meta, turns: [], total: 0, context: context({ totalUsd: 0, unknownModels: false, planPriced: true, byModel: [] }) },
    })
    render(<ContextColumn />)
    expect(screen.getByRole('button', { name: 'Change what it runs on' })).toHaveTextContent('MiniMax-M2.7 · minimax-coding-plan')
  })
})
