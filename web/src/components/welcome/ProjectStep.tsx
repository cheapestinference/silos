// ProjectStep.tsx — the first run's first step: the project its first agent
// will work in, and what a project is, in one line. A fresh install knows
// no project, so it is a new one by name (made at <Projects folder>/<slug>, the
// folder said under it, its first part a door to Settings › Territory) — named like the agent until you name it yourself,
// so skipping straight to Who and Create still works. Drawn with the
// birth model's ProjectField (BirthFields over lib/birth.ts), the same the
// New agent form shows.
import type { AgentView } from '../../lib/types'
import type { Birth, BirthProblems } from '../../lib/birth'
import { PROJECT_IS, PROJECT_STEP_ASK } from '../../lib/new-agent'
import { ProjectField } from './BirthFields'

export function ProjectStep({
  birth,
  known,
  agents,
  problems,
  errors,
  onBirth,
  onEnter,
}: {
  birth: Birth
  known: readonly string[]
  agents: readonly Pick<AgentView, 'id' | 'name' | 'folder' | 'folders' | 'archived'>[]
  problems: BirthProblems
  errors?: { project?: string | null }
  onBirth: (patch: Partial<Birth>) => void
  onEnter: () => void
}) {
  return (
    <section data-testid="tour-project">
      <h1 className="font-display text-[26px] leading-tight tracking-tight text-ink">{PROJECT_STEP_ASK}</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{PROJECT_IS}</p>
      <div className="mt-5">
        <ProjectField
          birth={birth}
          onBirth={onBirth}
          known={known}
          agents={agents}
          problems={problems}
          errors={errors}
          onEnter={onEnter}
          choose={known.length > 0}
          autoFocus
          idPrefix="welcome"
        />
      </div>
    </section>
  )
}
