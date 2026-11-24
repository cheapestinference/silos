// ProposalReview.tsx — /automation/new?proposal=<id>: the automation editor
// opened by a proposal's «Review ›». A command
// on a clock has no one-touch accept: the owner reads it in the editor, may
// change it, and its «Create automation» resolves the proposal (accepted —
// edited and saved by the owner). Cancel leaves it waiting in Needs you.
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { Automation, ProposalView } from '../../lib/types'
import { AutomationEditor } from './AutomationEditor'

/** The proposal's input as the editor's starting automation. */
export function seedOfProposal(p: ProposalView): Automation {
  const i = p.input as Partial<Automation>
  return {
    id: 'new',
    createdAt: '',
    name: typeof i.name === 'string' ? i.name : '',
    agentId: p.by,
    prompt: typeof i.prompt === 'string' ? i.prompt : '',
    trigger: i.trigger ?? { kind: 'cron', expr: '0 9 * * *' },
    thread: i.thread ?? { mode: 'new' },
    approval: i.approval === true,
    keepAlive: i.keepAlive !== false,
    paused: false,
    ...(typeof i.maxRunsPerDay === 'number' ? { maxRunsPerDay: i.maxRunsPerDay } : {}),
    ...(i.runsOn ? { runsOn: i.runsOn } : {}),
    ...(i.run ? { run: i.run } : {}),
  }
}

export function ProposalReview({ proposalId }: { proposalId: string }) {
  const [state, setState] = useState<{ p: ProposalView } | { error: string } | null>(null)
  useEffect(() => {
    let live = true
    api.proposals
      .list()
      .then((all) => {
        if (!live) return
        const p = all.find((x) => x.id === proposalId && x.kind === 'automation')
        setState(p ? (p.state === 'pending' ? { p } : { error: `This suggestion was already ${p.state}.` }) : { error: 'This suggestion is gone.' })
      })
      .catch((e: unknown) => {
        if (live) setState({ error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      live = false
    }
  }, [proposalId])
  if (state === null)
    return (
      <p className="px-6 py-8 text-sm text-ink-2" data-testid="proposal-review-loading">
        Reading the suggestion…
      </p>
    )
  if ('error' in state)
    return (
      <p className="px-6 py-8 text-sm text-ink-2" data-testid="proposal-review-gone">
        {state.error}
      </p>
    )
  const p = state.p
  return (
    <AutomationEditor
      key={p.id}
      mode="create"
      agentId={p.by}
      review={{ proposalId: p.id, agentName: p.agentName, reason: p.reason, seed: seedOfProposal(p) }}
    />
  )
}
