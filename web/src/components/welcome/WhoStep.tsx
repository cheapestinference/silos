// WhoStep.tsx — the first run's agent, after its project (ProjectStep):
// drawn with the SAME fields as the New agent form (AgentFields over
// lib/birth.ts): a name, how it works, what it takes care of. The engine
// is the tour's own step, when there is a choice. A loose conversation is
// not offered here (the «+» menu keeps it). Every field starts on its
// default, so «a name + Create» is the whole first run.
import type { Birth, BirthProblems } from '../../lib/birth'
import { AGENT_IS, NEW_AGENT_ASK } from '../../lib/new-agent'
import { AgentFields } from './BirthFields'

export function WhoStep({
  birth,
  problems,
  errors,
  onBirth,
  onEnter,
}: {
  birth: Birth
  problems: BirthProblems
  errors?: { name?: string | null }
  onBirth: (patch: Partial<Birth>) => void
  onEnter: () => void
}) {
  return (
    <section data-testid="tour-who">
      <h1 className="font-display text-[26px] leading-tight tracking-tight text-ink">{NEW_AGENT_ASK}</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{AGENT_IS}</p>
      <div className="mt-5 flex flex-col gap-5">
        <AgentFields birth={birth} onBirth={onBirth} problems={problems} errors={errors} onEnter={onEnter} autoFocusName idPrefix="welcome" />
      </div>
    </section>
  )
}
