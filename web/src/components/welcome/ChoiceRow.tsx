// ChoiceRow.tsx — one option of a first-run step: a real radio (keyboard
// and screen readers get a radio group), its name, what it means in one
// line, and — when the machine can't take it — why, in place of the line.
import { useId, type ReactNode } from 'react'

export function ChoiceRow({
  name,
  value,
  checked,
  disabled = false,
  title,
  note,
  recommended = false,
  children,
  onPick,
}: {
  name: string
  value: string
  checked: boolean
  disabled?: boolean
  title: ReactNode
  note?: ReactNode
  recommended?: boolean
  children?: ReactNode // what opens under the row while it is picked
  onPick: () => void
}) {
  // the radio is named by its title alone; the line describes it
  const uid = useId()
  return (
    <div className={`px-3.5 py-3 ${checked ? 'bg-panel' : ''}`}>
      <label className={`flex items-start gap-3 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={onPick}
          aria-labelledby={`${uid}-t`}
          aria-describedby={note ? `${uid}-n` : undefined}
          className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-terracotta disabled:opacity-40"
        />
        <span className="min-w-0 flex-1">
          <span id={`${uid}-t`} className={`flex flex-wrap items-baseline gap-x-2 text-[14px] ${disabled ? 'text-ink-3' : 'text-ink'}`}>
            {title}
            {recommended ? <span className="text-[11.5px] text-terracotta">Recommended</span> : null}
          </span>
          {note ? (
            <span id={`${uid}-n`} className="mt-0.5 block text-xs leading-relaxed text-ink-2">
              {note}
            </span>
          ) : null}
        </span>
      </label>
      {checked && children ? <div className="mt-3 pl-[26px]">{children}</div> : null}
    </div>
  )
}

// the group's frame: one bordered list, rows divided — never a card per row
export function ChoiceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="mt-4 divide-y divide-line overflow-hidden rounded-lg border border-line">
      {children}
    </div>
  )
}
