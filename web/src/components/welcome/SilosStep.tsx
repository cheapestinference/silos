// SilosStep.tsx — the first run's silos. Two lists, the lineup Silos ships:
// the recommended ones come INCLUDED (ticked; unticking one says in one line
// what it gives up), the optional ones that need no agent of yours are
// offered to ADD (unticked). Each row says its silo in its first sentence.
// Nothing changes until Create.
import type { SiloRow } from '../../lib/first-run'
import { SILOS_ABOUT, SILOS_ADD, SILOS_ASK, SILOS_INCLUDED, SILOS_LATER } from '../../lib/new-agent'

// a manifest's description can run long: the tour says its first sentence
const firstSentence = (d: string | null): string => (d ?? '').split(/(?<=[.:;])\s/)[0]!.replace(/[:;]$/, '.')

function SiloSwitch({ row, on, onToggle }: { row: SiloRow; on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onToggle(e.target.checked)}
          aria-describedby={`silo-${row.id}-about`}
          className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-terracotta"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] text-ink">{row.name}</span>
          <span id={`silo-${row.id}-about`} className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-2" title={row.description ?? undefined}>
            {firstSentence(row.description)}
          </span>
          {/* a recommended one unticked: what goes with it, plainly */}
          {row.recommended && !on && row.loses ? (
            <span className="mt-1 block text-xs text-terracotta" data-testid={`silo-${row.id}-loses`}>
              {row.loses}
            </span>
          ) : null}
        </span>
      </label>
    </li>
  )
}

function List({
  title,
  rows,
  choice,
  onToggle,
}: {
  title: string
  rows: readonly SiloRow[]
  choice: Record<string, boolean>
  onToggle: (id: string, on: boolean) => void
}) {
  if (rows.length === 0) return null
  return (
    <div className="mt-4">
      <p className="mb-1.5 text-[12.5px] text-ink-3">{title}</p>
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
        {rows.map((r) => (
          <SiloSwitch key={r.id} row={r} on={choice[r.id] ?? r.on} onToggle={(on) => onToggle(r.id, on)} />
        ))}
      </ul>
    </div>
  )
}

export function SilosStep({
  rows,
  choice,
  onToggle,
}: {
  rows: readonly SiloRow[] | null
  choice: Record<string, boolean>
  onToggle: (id: string, on: boolean) => void
}) {
  return (
    <section data-testid="tour-silos">
      <h2 className="font-display text-[22px] leading-tight tracking-tight text-ink">{SILOS_ASK}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{SILOS_ABOUT}</p>
      {rows === null ? (
        <p className="mt-4 text-[13px] text-ink-3">Reading what this Silos has…</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-[13px] text-ink-2">Nothing to choose here yet — Settings › Silos has them all.</p>
      ) : (
        <>
          <List title={SILOS_INCLUDED} rows={rows.filter((r) => r.recommended)} choice={choice} onToggle={onToggle} />
          <List title={SILOS_ADD} rows={rows.filter((r) => !r.recommended)} choice={choice} onToggle={onToggle} />
        </>
      )}
      <p className="mt-2 text-xs leading-relaxed text-ink-3">{SILOS_LATER}</p>
    </section>
  )
}
