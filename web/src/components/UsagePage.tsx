// UsagePage — what the fleet spent: /usage.
// The moment it serves: «What's happening?» (product.md moment 1), asked of
// money and tokens — who spent, on what, on which account.
//
//   header   «Usage» · its views as the band's tabs (By agent · By task · By
//            automation · By conversation · By account — one dimension each,
//            the rows below) and the period (Today · 7 days · 30 days) at
//            the tabs' quiet right edge, as Tasks keeps its layout.
//            Narrowed to one agent, the title stays and the agent is a
//            removable chip, as Tasks says a facet
//   where    the plan accounts' limits and each priced provider's dollars
//   bars     one bar a day, stacked by class — With you, Task starts,
//            Heartbeat, Its automations, Automations you set, then what
//            fell in no window (a single day: one strip across). By agent
//            over the whole fleet, the bars follow the view: each day by
//            AGENT — the period's six heaviest in their own colour, the
//            others as one rest, what is no one's in the same neutrals
//   rows     the view's rows; every row says its share of what the view
//            lists in one quiet bar
//
// Reached from Home's Usage tile, an agent's Measured, the caps' «See today
// ›», Automations' header. Never the sidebar.
// A turn on a plan shows no dollars: tokens and «on plan».
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import type { UsagePeriod, UsageView } from '../store/types'
import {
  CLASS_LABEL,
  accountWords,
  dayWords,
  dollarWords,
  moneyWords,
  shareOf,
  shareWords,
  sumTokens,
  tokenParts,
  tokenWords,
  turnsCell,
  turnsWords,
  usageEmptyWords,
  type SeriesClass,
  type UsageReport,
  type UsageRow,
} from '../lib/usage'
import { Chip, DayBars, FILL, stackingOf } from './UsageBars'
import { PageHeader } from './PageHeader'
import { AgentMeasures } from './AgentMeasures'
import { MASTER_ID } from '../lib/constants'
import { HeaderTabs } from './HeaderTabs'
import { NarrowChip } from './FacetBar'

const PERIODS: Array<{ id: UsagePeriod; label: string; words: string }> = [
  { id: 'today', label: 'Today', words: 'today' },
  { id: '7d', label: '7 days', words: 'in the last 7 days' },
  { id: '30d', label: '30 days', words: 'in the last 30 days' },
]
const VIEWS: Array<{ id: UsageView; label: string }> = [
  { id: 'agent', label: 'By agent' },
  { id: 'task', label: 'By task' },
  { id: 'automation', label: 'By automation' },
  { id: 'conversation', label: 'By conversation' },
  { id: 'account', label: 'By account' },
]

const Swatch = ({ cls }: { cls: SeriesClass }) => (
  <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: FILL[cls] }} />
)

export function UsagePage() {
  const page = useStore((s) => s.page)
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const p = page?.kind === 'usage' ? page : { kind: 'usage' as const }
  const period: UsagePeriod = p.period ?? 'today'
  const view: UsageView = p.by ?? 'agent'
  const agentId = p.agent
  const agentName = agentId ? (agents.find((a) => a.id === agentId)?.name ?? agentId) : null
  const go = (patch: { period?: UsagePeriod; by?: UsageView; agent?: string | null }): void => {
    const next = { period, by: view, agent: agentId ?? null, ...patch }
    changePage({
      kind: 'usage',
      ...(next.period !== 'today' ? { period: next.period } : {}),
      ...(next.by !== 'agent' ? { by: next.by } : {}),
      ...(next.agent ? { agent: next.agent } : {}),
    })
  }

  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    // a new question clears the old answer: never one period's figures
    // under another's name, never stale rows under an error
    setError(null)
    setReport(null)
    api
      .usage({ period, by: view, ...(agentId ? { agent: agentId } : {}) })
      .then((r) => {
        if (!cancelled) setReport(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setReport(null)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      cancelled = true
    }
  }, [period, view, agentId])

  // the bars follow By agent over the whole fleet; every other read, by class
  const stacking = useMemo(() => {
    if (!report) return null
    const names = new Map(agents.map((a) => [a.id, a.name]))
    const rowName = new Map(report.rows.filter((r) => r.key.startsWith('agent:')).map((r) => [r.key.slice('agent:'.length), r.label]))
    return stackingOf(
      report,
      view === 'agent' && !agentId,
      agents.map((a) => a.id),
      (id) => rowName.get(id) ?? names.get(id) ?? id,
    )
  }, [report, view, agentId, agents])

  const periodWords = PERIODS.find((x) => x.id === period)!.words
  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="usage-page">
      <PageHeader
        testId="usage-header"
        title="Usage"
        tabs={
          <HeaderTabs
            label="Usage views"
            value={view}
            onChange={(id) => go({ by: id })}
            items={VIEWS.map((v) => ({ id: v.id, label: v.label, testId: `usage-view-${v.id}` }))}
            end={<PeriodSwitch value={period} onChange={(id) => go({ period: id })} />}
          />
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-4 sm:px-6">
          {agentName ? (
            <div className="mb-3 flex">
              <NarrowChip testId="usage-agent" label="Agent" value={agentName} onClear={() => go({ agent: null })} />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-[13px] text-terracotta">
              Usage can't be read: {error}
            </p>
          ) : null}
          {!report && !error ? <p className="text-[13px] text-ink-3">Reading the transcripts…</p> : null}
          {report ? (
            report.rows.length === 0 && sumTokens(report.totals.tokens) === 0 ? (
              <Empty agentName={agentName} periodWords={periodWords} ever={report.since !== null} />
            ) : (
              <>
                <Summary report={report} periodWords={periodWords} />
                <WhereItRan report={report} />
                {stacking ? <DayBars report={report} stacking={stacking} /> : null}
                <Rows report={report} view={view} agentFill={stacking?.agentFill ?? null} onAgent={(id) => go({ agent: id })} />
                {report.notMeasured.length > 0 ? (
                  <p className="mt-4 text-[12px] text-ink-3" data-testid="usage-not-measured">
                    Turns on {report.notMeasured.join(' and ')} are counted but not measured: their tokens aren't in these figures.
                  </p>
                ) : null}
                {report.gone > 0 ? (
                  <p className="mt-1.5 text-[12px] text-ink-3" data-testid="usage-gone">
                    {report.gone === 1 ? '1 turn is' : `${report.gone} turns are`} counted but not measured:{' '}
                    {report.gone === 1 ? 'its transcript is' : 'their transcripts are'} gone.
                  </p>
                ) : null}
                {view === 'agent' ? (
                  <OnTheirOwn
                    agents={agents.filter((a) => !a.archived && a.id !== MASTER_ID && (!agentId || a.id === agentId))}
                    thirtyDays={period === '30d'}
                    onThirtyDays={() => go({ period: '30d' })}
                  />
                ) : null}
              </>
            )
          ) : null}
        </div>
      </div>
    </div>
  )
}

// where the period ran: each plan account with its limits, each priced
// provider with its dollars — one per line on a phone, never cut
function WhereItRan({ report }: { report: UsageReport }) {
  const bits = [
    ...report.accounts.map((a) => ({ key: `a:${a.account}`, text: accountWords(a) })),
    ...report.priced.map((p) => ({ key: `p:${p.provider}`, text: `${p.label} — ${dollarWords(p.costUsd)}` })),
  ]
  if (bits.length === 0) return null
  return (
    <ul
      data-testid="usage-where"
      aria-label="Accounts and providers"
      className="mt-2 flex flex-col gap-0.5 text-[12.5px] text-ink-2 sm:flex-row sm:flex-wrap sm:gap-x-4"
    >
      {bits.map((b) => (
        <li key={b.key}>{b.text}</li>
      ))}
    </ul>
  )
}

// the period: how the views are read, not a view — the tabs' quiet right
// edge, drawn as Tasks draws its layout switch
function PeriodSwitch({ value, onChange }: { value: UsagePeriod; onChange: (id: UsagePeriod) => void }) {
  return (
    <span role="radiogroup" aria-label="Period" data-testid="usage-period" className="flex items-center gap-0.5">
      {PERIODS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          aria-label={o.label}
          onClick={() => onChange(o.id)}
          className={`whitespace-nowrap rounded-md px-2 py-1 text-[12px] max-sm:px-1.5 ${o.id === value ? 'text-ink' : 'text-ink-3 hover:text-ink'}`}
        >
          {/* a phone keeps the views' room: «7d», not «7 days» */}
          <span className="max-sm:hidden">{o.label}</span>
          <span className="sm:hidden" aria-hidden="true">
            {o.id === 'today' ? 'Today' : o.id}
          </span>
        </button>
      ))}
    </span>
  )
}

// What the agents created without you, beside what they spent (not in
// Settings: a report is not a setting).
// Its window is fixed at 30 days, so it is drawn only when the period IS 30
// days; on a shorter period one quiet line opens it.
function OnTheirOwn({
  agents,
  thirtyDays,
  onThirtyDays,
}: {
  agents: Parameters<typeof AgentMeasures>[0]['agents']
  thirtyDays: boolean
  onThirtyDays: () => void
}) {
  if (agents.length === 0) return null
  if (!thirtyDays) {
    return (
      <p className="mt-8 text-[12.5px] text-ink-2" data-testid="usage-own-door">
        What {agents.length === 1 ? 'it' : 'they'} created on {agents.length === 1 ? 'its' : 'their'} own is measured over 30 days —{' '}
        <button type="button" onClick={onThirtyDays} className="font-medium text-terracotta hover:underline">
          30 days ›
        </button>
      </p>
    )
  }
  return (
    <section className="mt-10" data-testid="usage-own" aria-label="On their own">
      <h2 className="font-display text-[19px] leading-tight text-ink">On their own</h2>
      <p className="mb-4 mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">
        What each agent created without you in these 30 days. Kept: a task done, or recurring work that produced something, and not undone for 14 days.
      </p>
      <AgentMeasures agents={agents} />
    </section>
  )
}

function Empty({ agentName, periodWords, ever }: { agentName: string | null; periodWords: string; ever: boolean }) {
  return (
    <div data-testid="usage-empty" className="mt-16 flex flex-col items-center gap-2 text-center">
      <p className="text-sm text-ink">{usageEmptyWords(agentName, periodWords, ever)}</p>
    </div>
  )
}

// the period in one sentence — the figures the rows below add up to
function Summary({ report, periodWords }: { report: UsageReport; periodWords: string }) {
  const t = report.totals
  const money = moneyWords(t)
  return (
    <>
      <p data-testid="usage-summary" className="font-display text-[22px] leading-snug text-ink">
        {tokenWords(sumTokens(t.tokens))} tokens {periodWords}
        <span className="text-ink-2">
          , in {turnsWords(t.turns, t.consoles)}
          {money ? ` — ${money}` : ''}
        </span>
      </p>
      <p className="mt-0.5 text-[12px] tabular-nums text-ink-3" data-testid="usage-summary-parts">
        {tokenParts(t.tokens)}
      </p>
    </>
  )
}

const CLASS_OF_CHILD: Record<string, SeriesClass> = {
  'with-you': 'with-you',
  task: 'task',
  heartbeat: 'heartbeat',
  'own-automation': 'own-automation',
  'your-automation': 'your-automation',
}

// `agentFill`: the day bars stack by agent — each agent row wears its colour
// beside its name (the bars' table view), and its classes go by name alone
// (their colours are not on the page then)
function Rows({
  report,
  view,
  agentFill,
  onAgent,
}: {
  report: UsageReport
  view: UsageView
  agentFill: Map<string, string> | null
  onAgent: (id: string) => void
}) {
  const openSession = useStore((s) => s.openSession)
  const byAgentBars = agentFill !== null && agentFill.size > 0
  const since = report.sinceDay ? dayWords(report.sinceDay) : null
  return (
    <div role="table" aria-label="Usage rows" className="mt-8 text-[13px]" data-testid="usage-rows">
      <div role="row" className="hidden grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_7.5rem] gap-x-3 border-b border-line py-2 text-[11.5px] text-ink-3 sm:grid">
        <span role="columnheader">
          {VIEWS.find((v) => v.id === view)!
            .label.replace('By ', '')
            .replace(/^./, (c) => c.toUpperCase())}
        </span>
        <span role="columnheader" className="text-right">
          Turns
        </span>
        <span role="columnheader" className="text-right">
          Tokens
        </span>
        <span role="columnheader" className="text-right">
          Spent
        </span>
      </div>
      {report.rows.map((r) => {
        const agentId = r.key.startsWith('agent:') ? r.key.slice('agent:'.length) : null
        const isTail = r.key === 'unattributed' || r.key === 'silos' || r.key === 'before' || r.key === 'none' || r.key === 'more'
        const label = r.ref ? (
          <button type="button" onClick={() => void openSession(r.ref!.folder, r.ref!.id)} className="min-w-0 truncate text-left hover:text-terracotta">
            {r.label}
          </button>
        ) : agentId && !report.agent ? (
          <button type="button" onClick={() => onAgent(agentId)} className="min-w-0 truncate text-left hover:text-terracotta">
            {r.label}
          </button>
        ) : (
          <span className={`min-w-0 truncate ${r.hidden ? 'italic text-ink-2' : ''}`}>{r.label}</span>
        )
        return (
          <div key={r.key} role="rowgroup" className="border-b border-line/70 py-2.5" data-testid={`usage-row-${r.key}`}>
            <Line row={r} label={label} tone={isTail ? 'tail' : 'main'} swatch={agentId && byAgentBars ? agentFill.get(agentId) : undefined} />
            {/* its share of what the view lists — one grammar in every view */}
            <ShareBar share={shareOf(r, report.rows)} />
            {r.key === 'before' && since ? (
              <p className="mt-1 text-[11.5px] text-ink-3">Before Silos kept its register ({since}) — whole, without class.</p>
            ) : null}
            {r.key === 'unattributed' ? (
              <p className="mt-1 text-[11.5px] text-ink-3">In no turn Silos opened — a conversation run outside it, or a window it never saw.</p>
            ) : null}
            {r.children && r.children.length > 0 ? (
              <div className="mt-1.5">
                {r.children.map((c) => {
                  const cls = CLASS_OF_CHILD[c.key]
                  const clabel = c.ref ? (
                    <button
                      type="button"
                      onClick={() => void openSession(c.ref!.folder, c.ref!.id)}
                      className="min-w-0 truncate text-left hover:text-terracotta"
                    >
                      {c.label}
                    </button>
                  ) : (
                    <span className={`min-w-0 truncate ${c.hidden ? 'italic' : ''}`}>{c.label}</span>
                  )
                  return <Line key={c.key} row={c} label={clabel} tone="child" swatch={cls && !byAgentBars ? FILL[cls] : undefined} />
                })}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

// One row. A table from the small tablet up; on a phone the label takes the
// whole width and the three figures sit under it, named — nothing shrinks
// to a letter, nothing prints over a figure.
function Line({ row, label, tone, swatch }: { row: UsageRow; label: ReactNode; tone: 'main' | 'tail' | 'child'; swatch?: string }) {
  const total = sumTokens(row.tokens)
  const money = moneyWords(row)
  const notes: ReactNode[] = []
  // a conversation says whose it is, what it ran as and when (two may share a title)
  if (row.agents)
    notes.push(
      <span key="agents" data-testid="usage-row-agents">
        {row.agents.join(', ')}
      </span>,
    )
  if (row.classes && row.classes.length > 0)
    notes.push(
      <span key="classes" className="inline-flex items-center gap-1">
        {row.classes.map((c) => (
          <Swatch key={c} cls={c} />
        ))}
        <span>{row.classes.map((c) => CLASS_LABEL[c]).join(', ')}</span>
      </span>,
    )
  if (row.day) notes.push(<span key="day">{dayWords(row.day)}</span>)
  if (row.notMeasured) notes.push(<span key="nm">not measured on {row.notMeasured.join(', ')}</span>)
  if (row.gone) notes.push(<span key="gone">not measured — {row.gone === 1 ? 'its transcript is' : `${row.gone} transcripts are`} gone</span>)
  // where a class mixes both: what its daily max does not count (the caps' row counts the rest)
  if (row.outsideMax && row.key === 'task') notes.push(<span key="out">{row.outsideMax} you started</span>)
  if (row.outsideMax && row.key === 'own-automation') notes.push(<span key="out">{row.outsideMax} accepted by you</span>)
  // what the total is made of — cache reads usually dominate it
  if (tone !== 'child' && total > 0)
    notes.push(
      <span key="parts" className="tabular-nums">
        {tokenParts(row.tokens)}
      </span>,
    )
  const turns = turnsCell(row.turns, row.consoles)
  return (
    <div
      role="row"
      className={`grid grid-cols-3 gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_7.5rem] sm:items-baseline ${tone === 'child' ? 'py-1 pl-4 text-[12.5px] text-ink-2 sm:py-0.5' : tone === 'tail' ? 'text-ink-2' : 'text-ink'}`}
    >
      <span role="cell" className="col-span-3 min-w-0 sm:col-span-1">
        <span className="flex min-w-0 items-center gap-2">
          {swatch ? <Chip fill={swatch} /> : null}
          {label}
        </span>
        {notes.length > 0 ? (
          <span className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-3 ${swatch ? 'pl-[18px]' : ''}`}>
            {notes.flatMap((n, i) =>
              i > 0
                ? [
                    <span key={`s${i}`} aria-hidden="true">
                      ·
                    </span>,
                    n,
                  ]
                : [n],
            )}
          </span>
        ) : null}
      </span>
      <span
        role="cell"
        className={`tabular-nums sm:text-right ${swatch ? 'pl-[18px] sm:pl-0' : ''}`}
        title={row.consoles ? 'A console lives for days: it is no count of turns' : undefined}
      >
        {turns}
        {row.turns - (row.consoles ?? 0) > 0 ? <span className="text-ink-3 sm:hidden"> {row.turns - (row.consoles ?? 0) === 1 ? 'turn' : 'turns'}</span> : null}
      </span>
      <span role="cell" className="tabular-nums sm:text-right">
        {tokenWords(total)}
        <span className="text-ink-3 sm:hidden"> tokens</span>
      </span>
      <span role="cell" className="tabular-nums sm:text-right">
        {money || '—'}
      </span>
    </div>
  )
}

// A row's share of what the view lists: one hairline track the
// row's width, filled to its share in the quiet ink, the share said in
// small figures at its end — the same in every view, never louder than the
// row's own figures, never a limit (there is none to show).
function ShareBar({ share }: { share: number }) {
  if (share <= 0) return null
  return (
    <div className="mt-1.5 flex items-center gap-2" data-testid="usage-row-share">
      <span aria-hidden="true" className="relative h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-line/70">
        <span className="absolute inset-y-0 left-0 rounded-full bg-ink-3" style={{ width: `${Math.max(0.6, share * 100)}%` }} />
      </span>
      <span className="w-8 shrink-0 text-right text-[11px] leading-none tabular-nums text-ink-3">
        <span className="sr-only">Share of the listed tokens: </span>
        {shareWords(share)}
      </span>
    </div>
  )
}
