// plan-view-conversation.test.tsx — a plan task names the conversation
// working on it (`conversation`, team-plan skill 0.7.8): the row says
// whether it is working now or when it last moved, and opens it — or that
// it is gone, as plain text.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PlanView } from '../src/components/PlanView'
import { useStore } from '../src/store'
import { taskConversation, taskConversationTarget, planProjectFolder, type TeamPlan } from '../src/lib/team-plan'

vi.mock('../src/lib/api', () => ({
  api: { executions: { forPlan: async () => ({ record: null }) }, conversationRefs: vi.fn() },
  ApiError: class ApiError extends Error {
    status = 0
  },
}))
import { api } from '../src/lib/api'
const mockedRefs = () => vi.mocked((api as unknown as { conversationRefs: ReturnType<typeof vi.fn> }).conversationRefs)

const CONV = '3f1c2a9e-1b2c-4d5e-8f90-123456789abc'
const sess = (id: string, folder: string) => ({ id, folder })
const agents = [
  { id: 'builder', sessions: [sess(CONV, '-p'), sess('other-session-1', '-p')] },
  { id: 'writer', sessions: [sess('ses_devsession01', '-p--claude-worktrees-x')] },
]

describe('taskConversation / taskConversationTarget', () => {
  it('only a plausible session id', () => {
    expect(taskConversation({ conversation: CONV })).toBe(CONV)
    expect(taskConversation({ conversation: '../x' })).toBeNull()
    expect(taskConversation({ conversation: 7 })).toBeNull()
    expect(taskConversation({})).toBeNull()
  })
  it("the plan's project folder, also under plans/closed/", () => {
    expect(planProjectFolder('/p/plans/q4.plan.json')).toBe('/p')
    expect(planProjectFolder('/p/plans/closed/q4.plan.json')).toBe('/p')
    expect(planProjectFolder('/p/q4.plan.json')).toBe('')
  })
  it("the owner's session in the plan's folder; else the owner's anywhere; else anyone's; unknown → null", () => {
    expect(taskConversationTarget({ owner: 'builder', conversation: CONV }, '/p/plans/q4.plan.json', agents)).toEqual({ folder: '-p', id: CONV })
    expect(taskConversationTarget({ owner: 'writer', conversation: 'ses_devsession01' }, '/p/plans/q4.plan.json', agents)).toEqual({
      folder: '-p--claude-worktrees-x',
      id: 'ses_devsession01',
    })
    expect(taskConversationTarget({ owner: 'sam', conversation: CONV }, '/p/plans/q4.plan.json', agents)).toEqual({ folder: '-p', id: CONV })
    expect(taskConversationTarget({ owner: 'builder', conversation: 'not-in-the-index' }, '/p/plans/q4.plan.json', agents)).toBeNull()
    expect(taskConversationTarget({ owner: 'builder' }, '/p/plans/q4.plan.json', agents)).toBeNull()
  })
})

describe('PlanView — «Conversation ›» says how the conversation is', () => {
  const plan: TeamPlan = {
    title: 'Q4',
    tasks: [
      { id: 't1', title: 'Migrate billing', owner: 'builder', status: 'in_progress', dependsOn: [], conversation: CONV },
      { id: 't2', title: 'Ghost link', owner: 'builder', status: 'pending', dependsOn: [], conversation: 'not-in-the-index' },
      { id: 't3', title: 'No link', owner: 'builder', status: 'pending', dependsOn: [] },
    ],
  }
  const NOW = 10 * 3_600_000
  const openSession = vi.fn(async () => {})
  const setSession = (s: Record<string, unknown>) =>
    useStore.setState({
      agents: [
        {
          id: 'builder',
          name: 'Builder',
          emoji: '🛠',
          role: 'r',
          folder: '/p',
          skills: [],
          sessions: [{ id: CONV, folder: '-p', ...s }],
          liveCount: 0,
          sessionCount: 1,
        },
      ] as never,
      openSession: openSession as never,
      nowTick: NOW,
    })
  beforeEach(() => {
    openSession.mockClear()
    mockedRefs().mockReset()
    mockedRefs().mockImplementation(() => new Promise(() => {}))
  })

  it('idle: its last activity, and it opens', () => {
    setSession({ mtime: NOW - 2 * 3_600_000, lastRole: 'assistant' })
    render(<PlanView plan={plan} planPath="/p/plans/q4.plan.json" />)
    const links = screen.getAllByTestId('plan-conversation-t1')
    expect(links[0]!.textContent).toContain('2h')
    expect(screen.queryByTestId('plan-conversation-t3')).toBeNull()
    fireEvent.click(links[0]!)
    expect(openSession).toHaveBeenCalledWith('-p', CONV)
  })

  it('working now while its turn is live', () => {
    setSession({ mtime: NOW - 5_000, lastRole: 'user' })
    render(<PlanView plan={plan} planPath="/p/plans/q4.plan.json" />)
    expect(screen.getAllByTestId('plan-conversation-t1')[0]!.textContent).toContain('working now')
  })

  it('a conversation the index no longer has is said as text, with no link — once the server answered', async () => {
    mockedRefs().mockImplementation(async () => ({}))
    setSession({ mtime: NOW })
    render(<PlanView plan={plan} planPath="/p/plans/q4.plan.json" />)
    const gone = (await screen.findAllByTestId('plan-conversation-t2'))[0]!
    expect(gone.textContent).toContain('gone')
    expect(gone.tagName).toBe('SPAN')
    fireEvent.click(gone)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('a conversation only the server has gets a door that opens it', async () => {
    mockedRefs().mockImplementation(async () => ({
      'not-in-the-index': { sessionId: 'not-in-the-index', folder: '-q', agentId: 'builder', title: 'Old thread', live: false },
    }))
    setSession({ mtime: NOW })
    render(<PlanView plan={plan} planPath="/p/plans/q4.plan.json" />)
    const link = (await screen.findAllByTestId('plan-conversation-t2'))[0]!
    expect(link.tagName).toBe('BUTTON')
    fireEvent.click(link)
    expect(openSession).toHaveBeenCalledWith('-q', 'not-in-the-index')
  })

  it('before the server answers, the row claims nothing', () => {
    setSession({ mtime: NOW })
    render(<PlanView plan={plan} planPath="/p/plans/q4.plan.json" />)
    expect(screen.queryByTestId('plan-conversation-t2')).toBeNull()
  })
})
