// AtStartStep.tsx — the first run's «At start» (spec tools-origin §8): what
// a new project loads before its first conversation, in the grammar of the
// silos step. INCLUDED: what you set up on this machine (a fact, counted —
// no tick: the engine has no switch for it as a whole) and the classes
// Silos recommends on (ticked; unticking one says what goes). ADD IF YOU
// LIKE: the classes Silos recommends off. Each class names what its origin
// sends when that was read. Drawn only for an engine that declares classes
// (lib/first-run.ts tourSteps); nothing is saved until Create.
import { Check } from 'lucide-react'
import type { StartingFacts } from '../../lib/types'
import { classOffWords, classOn, classOnWords, classTitle, machineWords, sendsWords, type ChosenClass } from '../../lib/starting-set'
import { AT_START_ABOUT, AT_START_LATER, AT_START_MACHINE, SILOS_ADD, SILOS_INCLUDED, atStartAsk } from '../../lib/new-agent'

function ClassTick({ c, on, sends, onToggle }: { c: ChosenClass; on: boolean; sends: string | null; onToggle: (on: boolean) => void }) {
  // a recommended one unticked says what goes, plainly (the silos step's
  // grammar); an optional one says where it waits, or that it comes
  const line = on ? (c.recommended ? null : classOnWords(c)) : classOffWords(c)
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onToggle(e.target.checked)}
          aria-describedby={`start-${c.id}-about`}
          className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-terracotta"
        />
        <span className="min-w-0 flex-1" id={`start-${c.id}-about`}>
          <span className="block text-[14px] text-ink">{classTitle(c)}</span>
          {sends ? (
            <span className="mt-0.5 block truncate text-xs leading-relaxed text-ink-2" title={sends}>
              {sends}
            </span>
          ) : null}
          {line ? (
            <span
              data-testid={`start-${c.id}-line`}
              className={`mt-0.5 block text-xs leading-relaxed ${c.recommended && !on ? 'text-terracotta' : 'text-ink-2'}`}
            >
              {line}
            </span>
          ) : null}
        </span>
      </label>
    </li>
  )
}

export function AtStartStep({
  name,
  classes,
  facts,
  ticks,
  onToggle,
}: {
  name: string
  classes: readonly ChosenClass[]
  facts: StartingFacts | null
  ticks: Readonly<Record<string, boolean>>
  onToggle: (id: string, on: boolean) => void
}) {
  const row = (c: ChosenClass) => (
    <ClassTick key={c.id} c={c} on={classOn(c, ticks)} sends={sendsWords(facts?.sends[c.id])} onToggle={(on) => onToggle(c.id, on)} />
  )
  const optional = classes.filter((c) => !c.recommended)
  return (
    <section data-testid="tour-at-start">
      <h2 className="font-display text-[22px] leading-tight tracking-tight text-ink">{atStartAsk(name)}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{AT_START_ABOUT}</p>
      <div className="mt-4">
        <p className="mb-1.5 text-[12.5px] text-ink-3">{SILOS_INCLUDED}</p>
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {/* a fact, not a choice: no box to untick */}
          <li data-testid="start-machine" className="flex items-start gap-3 px-3.5 py-3">
            <Check size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] text-ink">{AT_START_MACHINE}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{machineWords(facts?.machine)}</span>
            </span>
          </li>
          {classes.filter((c) => c.recommended).map(row)}
        </ul>
      </div>
      {optional.length > 0 ? (
        <div className="mt-4">
          <p className="mb-1.5 text-[12.5px] text-ink-3">{SILOS_ADD}</p>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">{optional.map(row)}</ul>
        </div>
      ) : null}
      <p className="mt-2 text-xs leading-relaxed text-ink-3">{AT_START_LATER}</p>
    </section>
  )
}
