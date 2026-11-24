// ThisWeek — Home's week, drawn. The moment it
// serves: «What's happening?» asked of the plan — how much ran this week,
// how much of it with you and how much on its own, and how close each plan
// account is to its weekly window. The whole block is the door to Usage.
//
//   bars    the last 7 days in TWO colours — with you / on their own — the
//           Usage page's classes cut in two (lib/usage.ts attendanceDay,
//           UsageBars attendanceStacking: one rule beside the class
//           drawing, so a day's height is the same on both pages), today
//           marked
//   meters  each plan account's weekly window as one meter when Silos can
//           read it; Usage's own words when it cannot
//   total   the week's tokens, quiet, in Usage's summary grammar
//
// Real data only: a fleet with nothing measured says Usage's empty words,
// never a fake chart; a read that failed draws nothing but the door.
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { accountWords, moneyWords, sumTokens, tokenWords, usageEmptyWords, type UsageReport } from '../../lib/usage'
import { usageDoor } from '../../lib/usage-door'
import { DayBars, attendanceStacking } from '../UsageBars'

const USAGE_POLL_MS = 60_000

export function ThisWeek() {
  const changePage = useStore((s) => s.changePage)
  const [report, setReport] = useState<UsageReport | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      Promise.resolve(api.usage({ period: '7d', by: 'agent' }))
        .then((r) => {
          if (!cancelled && r) {
            setReport(r)
            setFailed(false)
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true) /* a figure on screen stays; the next read retries */
        })
    }
    load()
    const t = setInterval(load, USAGE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])
  const stacking = useMemo(() => (report ? attendanceStacking(report) : null), [report])
  const total = report ? sumTokens(report.totals.tokens) : 0
  const empty = report !== null && report.rows.length === 0 && total === 0
  const money = report ? moneyWords(report.totals) : ''
  return (
    <section aria-label="This week" className="flex min-w-0 flex-col">
      <button
        type="button"
        data-testid="home-this-week"
        onClick={() => changePage(usageDoor)}
        className="group/w flex flex-col text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-terracotta"
      >
        <span className="flex items-baseline justify-between gap-3 border-b border-ink/80 pb-2.5 dark:border-ink/60">
          <span className="text-[15px] font-semibold text-ink">This week</span>
          <span className="text-[13px] text-ink-2 group-hover/w:text-terracotta">Usage ›</span>
        </span>
        {!report ? (
          failed ? null : (
            <span className="pt-4 text-[13px] text-ink-3">…</span>
          )
        ) : empty ? (
          <span data-testid="this-week-empty" className="pt-4 font-display text-[18px] leading-snug text-ink-2">
            {usageEmptyWords(null, 'in the last 7 days', report.since !== null)}
          </span>
        ) : stacking ? (
          <span className="flex flex-col gap-4 pt-4">
            <DayBars report={report} stacking={stacking} compact today={report.today} />
            {report.accounts.length > 0 ? <WeeklyMeters accounts={report.accounts} /> : null}
            <span className="text-[12.5px] text-ink-2">
              <span className="tabular-nums text-ink">{tokenWords(total)}</span> tokens{money ? ` — ${money}` : ''}
            </span>
          </span>
        ) : null}
      </button>
    </section>
  )
}

// each plan account's weekly window: one meter when Silos can read it,
// Usage's own words when it cannot
function WeeklyMeters({ accounts }: { accounts: UsageReport['accounts'] }) {
  return (
    <span className="flex flex-col gap-2.5 border-t border-line/80 pt-3.5" data-testid="usage-meters">
      {accounts.map((a) => {
        if (a.weeklyPercent === null)
          return (
            <span key={a.account} className="block text-[12px] text-ink-2">
              {accountWords(a)}
            </span>
          )
        const pct = Math.max(0, Math.min(100, Math.round(a.weeklyPercent)))
        const near = pct >= 90
        return (
          <span key={a.account} className="flex flex-col gap-1.5 text-[12.5px]" title={`${a.label} — weekly window ${pct}% used`}>
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-ink-2">{accounts.length > 1 ? `${a.label} · weekly window` : 'This week’s window'}</span>
              <span className={`shrink-0 font-medium tabular-nums ${near ? 'text-[var(--health-amber)]' : 'text-ink'}`}>{pct}%</span>
            </span>
            <span
              role="meter"
              aria-label={`${a.label}, weekly window`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="relative block h-1.5 overflow-hidden rounded-full bg-ink/[0.08] dark:bg-veil-light/[0.1]"
            >
              <span className={`absolute inset-y-0 left-0 rounded-full ${near ? 'bg-[var(--health-amber)]' : 'bg-ink/75'}`} style={{ width: `${pct}%` }} />
            </span>
          </span>
        )
      })}
    </span>
  )
}
