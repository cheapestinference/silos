// CreateSkillDialog.tsx — a guided skill-creation flow: master asks what
// skill for what project, loads context and lists options. It doesn't
// create the skill directly: it selects the chosen agent, starts a new
// chat and sends it the template that invokes /skill-creator:skill-creator
// — the real conversation (questions, name, scope) happens in the normal
// chat with streaming, like any other turn.
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useStore } from '../store'
import { MASTER_ID } from '../lib/constants'
import type { AgentView } from '../lib/types'
import { Modal } from './Modal'

// the EXACT draft template — this is chat content, not UI chrome, so it's
// the message actually sent to the agent.
export function createSkillTemplate(description: string): string {
  return `I want to create a new skill for this project. Use the /skill-creator:skill-creator skill to guide me.

What I want it to do: ${description}

Before writing anything: ask me whatever questions you need, propose a name and a scope, and show me options whenever there's a decision to make.`
}

export function CreateSkillDialog() {
  const modal = useStore((s) => s.modal)
  const setModal = useStore((s) => s.setModal)
  const agents = useStore((s) => s.agents)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const selectAgent = useStore((s) => s.selectAgent)
  const closeSession = useStore((s) => s.closeSession)
  const send = useStore((s) => s.send)

  const open = modal === 'create-skill'
  const candidates = agents.filter((a) => a.id !== MASTER_ID)

  const [agentId, setAgentId] = useState('')
  const [description, setDescription] = useState('')
  const descriptionRef = useRef<HTMLTextAreaElement>(null)

  // on open: preselects the currently selected agent if it's valid
  // (active, non-master), otherwise the first in the list; clears the
  // previous run's description and focuses the textarea.
  useEffect(() => {
    if (!open) return
    const byDefault = candidates.find((a) => a.id === selectedAgentId) ?? candidates[0]
    setAgentId(byDefault?.id ?? '')
    setDescription('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Escape, focus trap, focus restore and body scroll-lock are all handled by
  // <Modal> (initial focus goes to the description textarea via initialFocusRef).

  if (!open) return null

  const agent: AgentView | undefined = candidates.find((a) => a.id === agentId)
  const cleanDescription = description.trim()
  const canConfirm = cleanDescription !== '' && agent !== undefined

  function onSubmit(e: FormEvent): void {
    e.preventDefault()
    if (!canConfirm || !agent) return
    selectAgent(agent.id)
    closeSession()
    void send(createSkillTemplate(cleanDescription))
    setModal(null)
  }

  return (
    <Modal onClose={() => setModal(null)} label="Create skill" initialFocusRef={descriptionRef}>
      <h2 className="font-display text-lg">Create skill</h2>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
        <div>
          <label htmlFor="create-skill-agent" className="mb-1 block text-xs text-ink-2">
            Agent
          </label>
          <select
            id="create-skill-agent"
            aria-label="Agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
          >
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="create-skill-description" className="mb-1 block text-xs text-ink-2">
            What should this skill know how to do?
          </label>
          <textarea
            ref={descriptionRef}
            id="create-skill-description"
            required
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="describe what this skill should be able to do"
            className="w-full resize-none rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
          />
        </div>

        <div className="mt-2 flex items-center justify-end gap-3">
          <button type="button" onClick={() => setModal(null)} className="text-sm text-ink-2 hover:text-ink">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canConfirm}
            className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
          >
            {agent ? `Start with ${agent.name}` : 'Start'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
