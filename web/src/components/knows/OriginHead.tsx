// OriginHead — the head of what one origin sends to a project (the skills,
// plugins or connectors your Claude account sends): whether this project
// loads it, and the one switch for all of it — «Turn all on» loads every
// one of them, later ones too; «Turn all off» none. One key in the
// project's local settings (spec tools-origin §7). Where the switch is
// refused, what decides it is said in its place (SwitchRefused). ▾ beside
// it opens the head's «Where it loads» (its key at every place).

import { WhereToggle } from './WhereItLoads'

const AMBER = 'text-[var(--health-amber)]'

export interface OriginHeadView {
  on: boolean
  switches: boolean
  refused: { short: string; long: string; update?: true } | null
  /** where it is off when that is not this project (the machine's head) */
  offWhere?: string
}

export function OriginHead({
  head,
  what,
  busy,
  onAct,
  onUpdate,
  where,
  className = 'ml-auto',
  bare = false,
}: {
  head: OriginHeadView
  /** what it turns on or off, for its title: «the plugins your Claude account sends» */
  what: string
  busy: boolean
  onAct: (to: 'on' | 'off') => void
  onUpdate?: () => void
  /** ▾ beside it: the head's «Where it loads» (machine · project · each agent) */
  where?: { open: boolean; onToggle: () => void }
  className?: string
  /** the head's «Turn all» is the group's bulk head beside it (BulkHead):
   *  only what it says here, and its ▾ */
  bare?: boolean
}) {
  const toggle = where ? <WhereToggle open={where.open} label={what} onToggle={where.onToggle} /> : null
  if (bare && !head.refused) {
    if (head.on && !toggle) return null
    return (
      <span className={`${className} flex shrink-0 items-baseline gap-2`} data-testid="origin-head">
        {head.on ? null : <span className={`text-[11px] ${AMBER}`}>{head.offWhere ?? 'Off in this project'}</span>}
        {toggle}
      </span>
    )
  }
  if (head.refused) {
    return (
      <span className={`${className} flex shrink-0 items-baseline gap-2`}>
        {head.on ? null : <span className={`text-[11px] ${AMBER}`}>{head.offWhere ?? 'Off in this project'}</span>}
        <SwitchRefused words={head.refused} onUpdate={onUpdate ?? (() => undefined)} />
        {toggle}
      </span>
    )
  }
  if (!head.switches) return toggle ? <span className={`${className} flex shrink-0 items-baseline gap-2`}>{toggle}</span> : null
  return (
    <span className={`${className} flex shrink-0 items-baseline gap-2`} data-testid="origin-head">
      {head.on ? null : <span className={`text-[11px] ${AMBER}`}>{head.offWhere ?? 'Off in this project'}</span>}
      <button
        type="button"
        data-origin-head
        disabled={busy}
        onClick={() => onAct(head.on ? 'off' : 'on')}
        aria-pressed={head.on}
        title={head.on ? `none of ${what} loads in new conversations here` : `all of ${what} loads here — what it sends later too`}
        className={`rounded-full border px-2 py-px text-[11px] disabled:opacity-50 ${head.on ? 'border-line text-ink-2 hover:text-ink' : 'border-terracotta/50 text-terracotta hover:bg-terracotta/10'}`}
      >
        {busy ? '…' : head.on ? 'Turn all off in this project' : 'Turn all on in this project'}
      </button>
      {toggle}
    </span>
  )
}

// Where a switch is refused, what decides it — said in the button's
// place: the file, your organization, an engine too old (with its door), a
// home folder. Never a button that would only fail.
export function SwitchRefused({ words, onUpdate }: { words: { short: string; long: string; update?: true }; onUpdate: () => void }) {
  if (words.update) {
    return (
      <button type="button" onClick={onUpdate} title={words.long} className="shrink-0 pt-px text-[11px] text-ink-2 hover:text-terracotta">
        {words.short} · Update ›
      </button>
    )
  }
  return (
    <span title={words.long || undefined} className="max-w-[45%] shrink-0 truncate pt-px font-mono text-[10.5px] text-ink-3">
      {words.short}
    </span>
  )
}
