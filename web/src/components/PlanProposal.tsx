// PlanProposal.tsx — c6: a plan-mode plan (ExitPlanMode) painted as what it
// is, a DOCUMENT the agent put in front of you, not one more tool chip. The
// sheet carries the plan's markdown (folded past ~12 lines) and, as its
// signature line, what happened to it: approved by you, still waiting on
// you (answered in the console — the CLI's own dialog), or not approved
// (the CLI's answer quoted, never a guessed word: no rejection sample exists).
// The column's PlanModeBlock jumps to the LAST sheet ([data-plan-block]).
// Named «Plan mode · Claude's plan» wherever it shows: it is
// Claude Code's proposal before acting, never a Silos plan (plans/).
export const PLAN_MODE_WORDS = "Plan mode · Claude's plan"
import { useState } from 'react'
import { Check, Hourglass, X } from 'lucide-react'
import type { PlanProposal as Plan, SessionContext } from '../lib/types'
import { Markdown } from './Turn'
import { relTime } from '../lib/rel-time'

const FOLD_LINES = 12

export function PlanSheet({ plan, ts, answer }: { plan: Plan; ts: string | null; answer: string | null }) {
  const long = plan.text.split('\n').length > FOLD_LINES
  const [open, setOpen] = useState(!long)
  const waiting = plan.state === 'proposed'
  return (
    <section
      data-plan-block
      aria-label={PLAN_MODE_WORDS}
      className={`scroll-mt-6 rounded-md border bg-canvas ${waiting ? 'border-terracotta/60' : 'border-line'}`}
    >
      <p className="px-4 pt-2.5 font-mono text-[10.5px] tracking-wide text-ink-3">{PLAN_MODE_WORDS}</p>
      <div className="relative px-4 pt-1.5">
        <div className={open ? '' : 'max-h-[19rem] overflow-hidden'}>
          <Markdown text={plan.text} />
        </div>
        {!open ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-canvas to-transparent" /> : null}
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mx-4 mt-1 text-sm text-ink-2 underline decoration-dotted underline-offset-2 hover:text-terracotta focus-visible:outline focus-visible:outline-1 focus-visible:outline-terracotta"
        >
          {open ? 'Fold the plan' : 'Show the whole plan'}
        </button>
      ) : null}
      <footer className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-4 py-2 text-sm">
        <PlanVerdict plan={plan} answer={answer} />
        {ts ? (
          <span className="ml-auto text-xs text-ink-3" title={new Date(ts).toLocaleString()}>
            {relTime(Date.parse(ts), Date.now())}
          </span>
        ) : null}
      </footer>
    </section>
  )
}

function PlanVerdict({ plan, answer }: { plan: Plan; answer: string | null }) {
  if (plan.state === 'approved')
    return (
      <span className="inline-flex items-center gap-1.5 text-ink">
        <Check size={14} aria-hidden="true" className="text-ink-2" /> Approved by you
      </span>
    )
  if (plan.state === 'proposed')
    return (
      <span className="inline-flex items-center gap-1.5 text-terracotta">
        <Hourglass size={14} aria-hidden="true" /> Waiting for your approval — answer it in the console
      </span>
    )
  // not approved: the CLI's own words (first line), whatever they say
  const said = (answer ?? '')
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim()
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-ink-2">
      <X size={14} aria-hidden="true" className="shrink-0" /> Not approved
      {said ? (
        <span className="truncate text-ink-3" title={said}>
          — {said}
        </span>
      ) : null}
    </span>
  )
}

// the column's pointer to the latest plan: one row, a click scrolls the
// transcript to its sheet
export function PlanModeRow({ planMode }: { planMode: NonNullable<SessionContext['planMode']> }) {
  const word = planMode.state === 'approved' ? 'Approved' : planMode.state === 'proposed' ? 'Waiting for you' : 'Not approved'
  const go = () => {
    const sheets = document.querySelectorAll('[data-plan-block]')
    sheets[sheets.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <button
      type="button"
      onClick={go}
      title="Show Claude's plan in the conversation"
      className={`flex w-full items-baseline gap-2 border-b border-line px-3 py-2.5 text-left hover:bg-panel focus-visible:outline focus-visible:outline-1 focus-visible:outline-terracotta ${planMode.state === 'proposed' ? 'border-l-2 border-l-terracotta' : ''}`}
    >
      {planMode.title ? (
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[10.5px] tracking-wide text-ink-3">{PLAN_MODE_WORDS}</span>
          <span className="mt-0.5 block truncate text-sm text-ink">{planMode.title}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{PLAN_MODE_WORDS}</span>
      )}
      <span className={`shrink-0 text-xs ${planMode.state === 'proposed' ? 'text-terracotta' : 'text-ink-2'}`}>{word}</span>
    </button>
  )
}
