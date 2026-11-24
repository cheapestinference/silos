// OutputStyleRow.tsx — the cockpit's output style inside "Run on" (e.g.
// explanatory, settable per agent or per conversation). One row in the panel's own grammar (a group that opens to
// its choices, the current one checked): what voice this conversation
// answers in, and where that comes from — pinned here, the agent's default,
// or the operator's own Claude Code setting. Shown only for an engine whose
// caps.outputStyles says so (the caller checks). The choices are DATA: the
// engine's built-ins plus the style files on disk (useOutputStyles).
import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { OutputStyleInfo } from '../lib/types'

/** What the row shows as current, and why. */
export interface StyleNow {
  /** the effective style; null = nobody set one (the operator's setting) */
  style: string | null
  /** where it comes from */
  from: 'conversation' | 'agent' | 'operator'
}

export function styleNow(pinned: string | undefined, agentStyle: string | undefined): StyleNow {
  if (pinned) return { style: pinned, from: 'conversation' }
  if (agentStyle) return { style: agentStyle, from: 'agent' }
  return { style: null, from: 'operator' }
}

const SOURCE_WORD: Record<OutputStyleInfo['source'], string | null> = { 'built-in': null, user: 'yours', project: 'this project' }

const display = (id: string): string => (id === 'default' ? 'Default' : id)

export function OutputStyleRow({
  agentName,
  agentStyle,
  styles,
  now,
  started = false,
  onChoose,
}: {
  agentName: string
  /** the conversation already has answers: a new style only shapes the
   *  ones that follow — the earlier ones stay in its history and pull. */
  started?: boolean
  agentStyle: string | undefined
  styles: OutputStyleInfo[] | null
  now: StyleNow
  /** a style's id, or null = follow the agent (unpin) */
  onChoose: (style: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const title = now.style ? display(now.style) : 'Claude Code’s setting'
  const meta =
    now.from === 'conversation'
      ? 'chosen for this conversation'
      : now.from === 'agent'
        ? `${agentName}’s default`
        : 'not set in Silos — your own config decides'
  return (
    <div className="border-t border-line" data-testid="output-style-row">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-panel ${open ? 'bg-panel/60' : ''}`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 text-sm text-ink-2">Answers in</span>
            <span className="truncate text-sm text-ink">{title}</span>
          </span>
          <span className="block truncate font-mono text-[11px] text-ink-2">{meta}</span>
        </span>
        <ChevronDown size={13} aria-hidden="true" className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <ul className="px-4 pb-3" role="menu" aria-label="Output style">
          {styles === null ? <li className="py-1 text-xs text-ink-2">Reading the styles…</li> : null}
          {styles?.map((s) => {
            const checked = now.style === s.id
            const where = SOURCE_WORD[s.source]
            return (
              <li key={s.id}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  onClick={() => onChoose(s.id)}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel ${checked ? 'text-ink' : 'text-ink-2'}`}
                >
                  <span className={`mt-0.5 w-3.5 shrink-0 ${checked ? 'text-terracotta' : 'invisible'}`} aria-hidden="true">
                    <Check size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm">{display(s.id)}</span>
                      {where ? <span className="shrink-0 text-[11px] text-ink-3">{where}</span> : null}
                    </span>
                    {s.description ? <span className="block text-xs leading-snug text-ink-3">{s.description}</span> : null}
                  </span>
                </button>
              </li>
            )
          })}
          {started && styles?.length ? (
            <li className="px-2 pt-1 text-[11px] leading-snug text-ink-3" data-testid="output-style-started">
              Earlier answers stay in this conversation and can keep their voice — a new conversation starts clean.
            </li>
          ) : null}
          {now.from === 'conversation' ? (
            <li className="mt-1 border-t border-line/70 pt-1.5">
              <button type="button" onClick={() => onChoose(null)} className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-panel hover:text-ink">
                {agentStyle ? `Follow ${agentName}’s default (${display(agentStyle)})` : 'Back to your own Claude Code setting'}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
