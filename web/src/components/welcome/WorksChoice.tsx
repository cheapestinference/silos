// WorksChoice.tsx — how an agent works, asked at birth (BirthFields: Welcome
// and the New agent form): the control ladder's three rungs as one choice —
// when you give it work, also on its own, or proactive. The same rows
// wherever an agent is born, so the choice reads the same. Without the Task
// mode silo the two upper rungs have nothing behind them: the quiet door
// says so.
import type { Works } from '../../lib/first-run'
import { WORKS_OWN, WORKS_PROACTIVE, WORKS_TOLD, worksAsk } from '../../lib/new-agent'
import { ChoiceGroup, ChoiceRow } from './ChoiceRow'
import { SiloDoor, useSiloMissing } from '../silo/SiloDoor'

export function WorksChoice({ name, works, onPick, idPrefix = 'works' }: { name: string; works: Works; onPick: (w: Works) => void; idPrefix?: string }) {
  // «on its own» and «proactive» are Task mode's: without the silo the choice would mean nothing
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
        <ChoiceRow
          name={`${idPrefix}-kind`}
          value="proactive"
          checked={works === 'proactive'}
          title={WORKS_PROACTIVE.title}
          note={WORKS_PROACTIVE.note}
          onPick={() => onPick('proactive')}
        />
      </ChoiceGroup>
      {noTaskMode ? <SiloDoor silo="task-mode" says="Working on its own needs the Task mode silo" className="mt-1.5" /> : null}
    </div>
  )
}
