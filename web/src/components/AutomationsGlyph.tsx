// AutomationsGlyph — an agent's automations, as ONE small ⚡ on the agent's
// own row in the sidebar (the folded "⚡ N automations" row
// under each agent was a second door to the same page, in the same voice
// as "N older" — a pointer dressed as a fold).
//
// The sidebar is for navigation — agents and their conversations: an
// automation is not a place, and its runs are not the owner's threads. So
// the agent's row carries a glyph only when it has automations:
//
//   🛠 Builder                        ⚡    ← muted: it has some, nothing to do
//   🛠 Builder                        ⚡    ← terracotta: one failed / waits for you
//   🛠 Builder                        ⚡    ← blinking: one runs, nothing needs you
//
// Clicking it opens the Automations page narrowed to this agent
// (/automations?agent=<id>), its chip naming the agent — so the bolt means
// one thing everywhere: "<agent>'s automations". The states are the
// sidebar's two-state vocabulary (SessionDot), carried by the glyph itself
// instead of an extra dot. No count pill, no row, no runs. A KEPT thread
// (thread.mode 'keep') lives on the automation's page and is a sidebar row
// only while open or found by a search (lib/sidebar-show.ts), with its
// muted ⚡ mark.
import { useMemo } from 'react'
import { AutomationIcon } from '../lib/icons'
import { useStore } from '../store'
import { automationsSignal } from '../lib/automations-signal'
import type { AgentView } from '../lib/types'

export function AutomationsGlyph({ agent, visibleName }: { agent: AgentView; visibleName: string }) {
  const automations = useStore((s) => s.automations)
  const pending = useStore((s) => s.automationsPending)
  const changePage = useStore((s) => s.changePage)

  const signal = useMemo(() => automationsSignal(automations, pending, agent.id), [automations, pending, agent.id])
  if (signal.count === 0) return null

  const needsYou = signal.state === 'needs-you'
  const working = signal.state === 'working'
  const label = `${visibleName}'s automations: ${signal.label}`

  return (
    <button
      type="button"
      data-testid="automations-glyph"
      data-agent-id={agent.id}
      data-signal={signal.state ?? 'quiet'}
      onClick={(e) => {
        e.stopPropagation()
        changePage({ kind: 'automations', agent: agent.id })
        // on a phone the sidebar IS the first screen; the page must come up
        useStore.setState({ mobileView: 'chat' })
      }}
      aria-label={label}
      title={label}
      className={`shrink-0 rounded p-0.5 transition-colors md:max-lg:hidden ${
        needsYou ? 'text-terracotta' : working ? 'text-ink-2 dot-blink' : 'text-ink-3 hover:text-ink'
      }`}
    >
      <AutomationIcon size={11} strokeWidth={2} fill={needsYou ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
  )
}
