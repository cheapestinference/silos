import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CreateSkillDialog } from '../src/components/CreateSkillDialog'
import { useStore } from '../src/store'
import type { AgentView } from '../src/lib/types'

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',

    folder: '/x',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    agents: [],
    warming: false,
    selectedAgentId: null,
    selected: null,
    detail: null,
    filter: '',
    active: null,
    execOut: null,
    modal: null,
    error: null,
    selectAgent: vi.fn(),
    closeSession: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  })
})

// "Create skill" left the Sidebar footer — it now opens from AgentPage's
// Skills tab (see test/agent-page.test.tsx, describe "AgentPage —
// Skills") and from ProjectPage. This describe covers only the dialog
// itself (CreateSkillDialog), independent of who opens it.
describe('CreateSkillDialog', () => {
  it('with no "create-skill" modal, renders nothing', () => {
    render(<CreateSkillDialog />)
    expect(screen.queryByText('Create skill')).not.toBeInTheDocument()
  })

  it('with the modal open, lists only active non-master agents and preselects the current agent', () => {
    useStore.setState({
      modal: 'create-skill',
      selectedAgentId: 'finance',
      agents: [makeAgent({ id: 'finance', name: 'FINANCE' }), makeAgent({ id: 'master', name: 'Master' }), makeAgent({ id: 'builder', name: 'BUILDER' })],
    })
    render(<CreateSkillDialog />)
    expect(screen.queryByText('Master')).not.toBeInTheDocument()
    const select = screen.getByLabelText('Agent') as HTMLSelectElement
    expect(select.value).toBe('finance')
    expect(screen.getByText('BUILDER')).toBeInTheDocument()
  })

  it('with no description, the confirm button is disabled', () => {
    useStore.setState({
      modal: 'create-skill',
      selectedAgentId: 'finance',
      agents: [makeAgent({ id: 'finance', name: 'FINANCE' })],
    })
    render(<CreateSkillDialog />)
    expect(screen.getByRole('button', { name: /Start with FINANCE/i })).toBeDisabled()
  })

  it('confirming with agent finance and a description calls selectAgent, closeSession and send with the template (including the description and skill-creator) and closes the dialog', async () => {
    useStore.setState({
      modal: 'create-skill',
      selectedAgentId: 'finance',
      agents: [makeAgent({ id: 'finance', name: 'FINANCE' }), makeAgent({ id: 'builder', name: 'BUILDER' })],
    })
    render(<CreateSkillDialog />)

    fireEvent.change(screen.getByLabelText('What should this skill know how to do?'), {
      target: { value: 'reconcile Stripe with Ledgerly' },
    })
    const button = screen.getByRole('button', { name: /Start with FINANCE/i })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)

    expect(useStore.getState().selectAgent).toHaveBeenCalledWith('finance')
    expect(useStore.getState().closeSession).toHaveBeenCalled()
    expect(useStore.getState().send).toHaveBeenCalledTimes(1)
    const template = (useStore.getState().send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    expect(template).toContain('reconcile Stripe with Ledgerly')
    expect(template).toContain('/skill-creator:skill-creator')
    expect(template).toContain('skill-creator')
    expect(useStore.getState().modal).toBe(null)
  })

  it("choosing another agent in the select changes the confirm button's name", () => {
    useStore.setState({
      modal: 'create-skill',
      selectedAgentId: 'finance',
      agents: [makeAgent({ id: 'finance', name: 'FINANCE' }), makeAgent({ id: 'builder', name: 'BUILDER' })],
    })
    render(<CreateSkillDialog />)
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'builder' } })
    expect(screen.getByRole('button', { name: /Start with BUILDER/i })).toBeInTheDocument()
  })

  it('Esc closes the dialog', () => {
    useStore.setState({
      modal: 'create-skill',
      selectedAgentId: 'finance',
      agents: [makeAgent({ id: 'finance', name: 'FINANCE' })],
    })
    render(<CreateSkillDialog />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().modal).toBe(null)
  })
})
