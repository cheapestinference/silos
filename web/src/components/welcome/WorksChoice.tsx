// WorksChoice.tsx — how an agent works, asked at birth (Welcome and the New
// agent form): when you give it work, or also on its own. The same two rows
// wherever an agent is born, so the choice reads the same. Without the Task
// mode silo «on its own» has nothing behind it: the quiet door says so.
import type { Works } from '../../lib/first-run'
import { WORKS_LATER, WORKS_OWN, WORKS_TOLD, worksAsk } from '../../lib/new-agent'
import { ChoiceGroup, ChoiceRow } from './ChoiceRow'
import { SiloDoor, useSiloMissing } from '../silo/SiloDoor'

export function WorksChoice({ name, works, onPick, idPrefix = 'works' }: { name: string; works: Works; onPick: (w: Works) => void; idPrefix?: string }) {
  // «on its own» is Task mode's: without the silo the choice would mean nothing
  const noTaskMode = useSiloMissing('task-mode')
  return (
    <div>
      <p className="text-[14px] text-ink">{worksAsk(name)}</p>
      <ChoiceGroup label={worksAsk(name)}>
        <ChoiceRow
          name={`${idPrefix}-kind`}
          value="told"
          checked={works === 'told'}
          recommended
          title={WORKS_TOLD.title}
          note={WORKS_TOLD.note}
          onPick={() => onPick('told')}
        />
        <ChoiceRow name={`${idPrefix}-kind`} value="own" checked={works === 'own'} title={WORKS_OWN.title} note={WORKS_OWN.note} onPick={() => onPick('own')} />
      </ChoiceGroup>
      {noTaskMode ? <SiloDoor silo="task-mode" says="Working on its own needs the Task mode silo" className="mt-1.5" /> : null}
      {/* the ladder's third rung, named so it is known — chosen later, on its page */}
      <p className="mt-2 text-xs text-ink-3">{WORKS_LATER}</p>
    </div>
  )
}
