// OwnerFilter.tsx — the «From» row, the ONE scope filter every list grouped
// by origin carries (spec scope-ui-review §3.3):
//
//   From   All 5   Project · acme 2   This machine 2   Your Claude account · sam@example.com 1
//
// A radio row: «All», then one chip per group head, in the heads' order —
// a chip's count is its head's count. No segmented Own / Inherited, no
// caption, no swatch: the labels carry it. The caller hides the row when
// the list has one origin (origin-filter.ts showsOriginRow).
import { pickOrigin, type OriginTally } from '../lib/origin-filter'

export function OriginFilter({
  tally,
  labelOf,
  value,
  onChange,
}: {
  tally: OriginTally
  /** a group's label, the same words its head says after «From» */
  labelOf: (group: string) => string
  value: string | null
  onChange: (group: string | null) => void
}) {
  const chip = (key: string, label: string, n: number, on: boolean, group: string | null) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      title={label}
      onClick={() => onChange(pickOrigin(value, group))}
      className={`flex max-w-[18rem] items-baseline gap-1.5 rounded-full border px-2 py-px text-[11.5px] transition-colors ${on ? 'border-ink-3 bg-canvas text-ink shadow-sm' : n === 0 ? 'border-transparent text-ink-3 hover:border-line' : 'border-transparent text-ink-2 hover:border-line hover:text-ink'}`}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{n}</span>
    </button>
  )
  return (
    <div role="radiogroup" aria-label="From" data-testid="scope-filter" className="flex flex-wrap items-baseline gap-x-1 gap-y-1">
      <span className="mr-1 font-mono text-[10.5px] text-ink-3">From</span>
      {chip('all', 'All', tally.all, value === null, null)}
      {tally.chips.map((c) => chip(c.group, labelOf(c.group), c.n, value === c.group, c.group))}
    </div>
  )
}
