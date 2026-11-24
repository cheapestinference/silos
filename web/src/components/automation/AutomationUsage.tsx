// AutomationUsage — what an automation spent, said where it lives. Usage already cuts the day by agent and by class; the
// grain it cannot give is WHICH automation eats — that lives here, on the
// Automations list (each row's month) and on /automation/:id (its 30 days).
//
//   UsageSpark   a list row's month: whole weeks as a spark and the month's
//                tokens in quiet mono — «no tokens» for a command (it runs
//                without Claude: that is information too)
//   UsageBlock   the page's 30 days in bars (hover a day for its figure) and
//                Usage's summary line: runs · tokens this month — money
//
// One hue, the value of «Automations you set» (UsageBars FILL), so the colour
// means the same thing on every page. Real figures only: a month with no
// runs says so in words, never a flat chart; a figure still being read says
// it is being counted.
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import type { Automation, AutomationUsage, Run } from '../../lib/types'
import { automationMoneyWords, automationUsageWords, dayWords, runsInWindow, tokenWords, weeksOf } from '../../lib/usage'
import { FILL } from '../UsageBars'

const HUE = FILL['your-automation']

/** Arriving at the list or a page reads the month fresh: the spend rides on
 *  the list's read, so it is read again and ONLY its figures are taken —
 *  the rest of the store (an edit in flight, a run's state) is left as is. */
export function useFreshUsage(key: string | null): void {
  useEffect(() => {
    if (key === null || key === 'new') return
    let cancelled = false
    Promise.resolve(api.automations.list())
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return
        const by = new Map(list.filter((a) => a.usage30d !== undefined).map((a) => [a.id, a.usage30d]))
        if (by.size === 0) return
        useStore.setState((s) => ({ automations: s.automations.map((a) => (by.has(a.id) ? { ...a, usage30d: by.get(a.id) } : a)) }))
      })
      .catch(() => {
        /* the figure on screen stays; the next arrival reads again */
      })
    return () => {
      cancelled = true
    }
  }, [key])
}
const DAY_MS = 24 * 3600_000

// a run it finished in the window but the figure holds none yet: the
// server is still reading its conversation
function countingFromLastRun(a: Automation, u: AutomationUsage, nowMs: number): boolean {
  if (u.runsCounted > 0 || !a.lastRun) return false
  const at = Date.parse(a.lastRun.at)
  return (a.lastRun.status === 'ok' || a.lastRun.status === 'failed') && Number.isFinite(at) && nowMs - at < 30 * DAY_MS
}

/** The list row's month: its weeks and its tokens, or the word that stands for them. */
export function UsageSpark({ automation, nowMs }: { automation: Automation; nowMs: number }) {
  const u = automation.usage30d
  if (u === undefined) return null
  const quiet = (text: string, testId: string) => (
    <span data-testid={testId} className="block text-right text-[11px] text-ink-3">
      {text}
    </span>
  )
  if (u === null) return quiet('no tokens', 'automation-row-no-tokens')
  if (u.tokens === 0)
    return quiet(countingFromLastRun(automation, u, nowMs) ? 'counting…' : u.runsCounted > 0 ? '0 tokens' : 'no runs', 'automation-row-no-spend')
  const weeks = weeksOf(u.days)
  const max = Math.max(1, ...weeks)
  const label = `${tokenWords(u.tokens)} tokens in the last 30 days${weeks.length > 0 ? `; a week at a time: ${weeks.map(tokenWords).join(', ')}` : ''}`
  return (
    <span data-testid="automation-row-usage" className="flex items-center justify-end gap-2.5" title={`${automationUsageWords(u)}`}>
      {weeks.length > 0 ? (
        <span role="img" aria-label={label} data-testid="automation-row-spark" className="flex h-[18px] w-[94px] items-end justify-end gap-[2px]">
          {weeks.map((v, i) => (
            <span
              key={i}
              aria-hidden="true"
              className="block w-[6px] rounded-[1.5px]"
              style={{
                height: v > 0 ? `${Math.max(8, (v / max) * 100)}%` : '1px',
                background: v > 0 ? HUE : 'var(--ink-3)',
                opacity: v > 0 ? (i === weeks.length - 1 ? 1 : 0.8) : 0.4,
              }}
            />
          ))}
        </span>
      ) : null}
      <span className="w-11 text-right font-mono text-[11px] tabular-nums text-ink">{tokenWords(u.tokens)}</span>
    </span>
  )
}

/** The month a tile line can carry beside its next run: «· 4.1M», only when it spent. */
export function monthMeta(a: Automation): string | null {
  const u = a.usage30d
  return u && u.tokens > 0 ? tokenWords(u.tokens) : null
}

/** «12M tokens this month» over the rows a page lists — null when none was served. */
export function listedMonthTokens(list: readonly Automation[]): number | null {
  let served = false
  let n = 0
  for (const a of list) {
    if (a.usage30d === undefined) continue
    served = true
    n += a.usage30d?.tokens ?? 0
  }
  return served ? n : null
}

/** The automation page's spend: 30 days in bars and Usage's summary line. */
export function UsageBlock({ automation, runs }: { automation: Automation; runs: readonly Run[] }) {
  const u = automation.usage30d
  const [hover, setHover] = useState<number | null>(null)
  if (!u) return null // not served, or a command — its page already says it runs no Claude
  const mine = runs.filter((r) => r.automationId === automation.id)
  const expected = u.days.length > 0 ? runsInWindow(mine, u.days[0]!.date) : 0
  const counting = expected > u.runsCounted
  const frame = (children: ReactNode) => (
    <section aria-label="This month’s spend" data-testid="automation-usage" className="shrink-0 border-b border-line px-4 py-3">
      {children}
    </section>
  )
  if (u.tokens === 0 && u.runsCounted === 0) {
    return frame(
      <p data-testid="automation-usage-empty" className="text-[12.5px] text-ink-2">
        {counting ? 'Its runs of the last 30 days are being counted…' : 'No runs in the last 30 days — nothing spent.'}
      </p>,
    )
  }
  const max = Math.max(1, ...u.days.map((d) => d.tokens))
  const money = automationMoneyWords(u)
  const last = u.days.length - 1
  return frame(
    <div className="max-w-xl">
      {u.tokens > 0 ? (
        <div className="relative mb-2.5">
          {/* the one gridline: the busiest day, said once */}
          <div aria-hidden="true" className="absolute inset-x-0 top-0 flex items-center gap-2 text-[10.5px] text-ink-3">
            <span className="h-px flex-1 bg-line" />
            <span className="tabular-nums">{tokenWords(max)}</span>
          </div>
          <div data-testid="automation-usage-bars" className="flex h-[68px] items-end gap-[2px] pr-9 pt-3" onMouseLeave={() => setHover(null)}>
            {u.days.map((d, i) => (
              <button
                key={d.date}
                type="button"
                data-testid="automation-usage-day"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${i === last ? 'Today' : dayWords(d.date)}: ${tokenWords(d.tokens)} tokens`}
                className={`flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[3px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-terracotta ${hover !== null && hover !== i ? 'opacity-55' : ''}`}
              >
                <span
                  className="block w-full rounded-t-[2px]"
                  style={{
                    height: d.tokens > 0 ? `${Math.max(3, (d.tokens / max) * 100)}%` : '1px',
                    background: d.tokens > 0 ? HUE : 'var(--line)',
                    opacity: d.tokens > 0 && i !== last ? 0.85 : 1,
                  }}
                />
              </button>
            ))}
          </div>
          {hover !== null ? (
            <div
              role="tooltip"
              data-testid="automation-usage-tip"
              className="pointer-events-none absolute -top-2 z-10 -translate-y-full whitespace-nowrap rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12px] text-ink-2 shadow-sm"
              style={{ left: `clamp(0px, calc(${((hover + 0.5) / u.days.length) * 100}% - 4.5rem), calc(100% - 9rem))` }}
            >
              {hover === last ? 'Today' : dayWords(u.days[hover]!.date)} —{' '}
              <span className="font-mono tabular-nums text-ink">{tokenWords(u.days[hover]!.tokens)}</span> tokens
            </div>
          ) : null}
          <div aria-hidden="true" className="mt-1 flex justify-between pr-9 text-[10.5px] text-ink-3">
            <span>{dayWords(u.days[0]!.date)}</span>
            <span>Today</span>
          </div>
        </div>
      ) : null}
      <p data-testid="automation-usage-line" className="text-[12.5px] text-ink-2">
        {u.runsCounted === 1 ? '1 run' : `${u.runsCounted} runs`} · <span className="font-mono tabular-nums text-ink">{tokenWords(u.tokens)}</span> tokens this
        month{money ? ` — ${money}` : ''}
        {counting ? <span className="text-ink-3"> · {expected - u.runsCounted} more still being counted</span> : null}
      </p>
    </div>,
  )
}
