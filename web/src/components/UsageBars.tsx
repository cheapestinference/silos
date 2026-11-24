// UsageBars — the day bars of a usage report, ONE
// drawing shared by the Usage page and Home's Usage tile, so the two can
// never disagree on a class's colour or a day's height.
//
//   stacking  what the bars stack by: the classes (With you, Task starts,
//             Heartbeat, Its automations, Automations you set, then what fell
//             in no window — hatched neutrals), or, By agent over the whole
//             fleet, the agents (the period's six heaviest in their own
//             colour, the rest one dotted neutral)
//   DayBars   one bar a day, stacked; a single day is one strip across.
//             `compact` (Home's tile): shorter, no hover layer of its own —
//             the whole tile is one door, so each segment says itself in its
//             native title and the figure is labelled for a reader — and
//             `today` names today's column «Today» on a quiet ground.
import { useState } from 'react'
import {
  ATTENDANCE_LABEL,
  CLASS_LABEL,
  NO_ONES,
  SERIES_CLASSES,
  agentDaySegments,
  agentStack,
  attendanceDay,
  dayWords,
  tokenWords,
  type Attendance,
  type SeriesClass,
  type UsageReport,
} from '../lib/usage'

// the class's fill: the five validated hues, then the neutrals of what is
// no one's turn — hatched, so identity never rests on grey alone
export const FILL: Record<SeriesClass, string> = {
  'with-you': 'var(--use-you)',
  task: 'var(--use-task)',
  heartbeat: 'var(--use-beat)',
  'own-automation': 'var(--use-own)',
  'your-automation': 'var(--use-set)',
  unattributed: 'repeating-linear-gradient(135deg, var(--ink-3) 0 2px, transparent 2px 5px)',
  silos: 'var(--ink-3)',
  before: 'repeating-linear-gradient(45deg, var(--ink-3) 0 1px, transparent 1px 4px)',
}

// What the day bars stack by: the classes — or, By agent over the whole
// fleet, the agents. One layer per series, bottom up, each with its
// name and fill; what is no one's keeps the class bars' neutrals either way,
// so a day's bar is the same height whichever way it is cut.
export interface Layer {
  key: string
  label: string
  fill: string
}
export interface Stacking {
  by: 'class' | 'agent'
  layers: Layer[]
  valueOf: (day: number, key: string) => number
  agentFill: Map<string, string>
}

// the agents' rest: one quiet dotted neutral — no hue, never taken for an agent
const REST_FILL = 'radial-gradient(circle, var(--ink-3) 0.9px, transparent 1.2px) 0 0 / 4px 4px'

function classLabel(c: SeriesClass, report: UsageReport): string {
  return c === 'before' && report.sinceDay ? `Before ${dayWords(report.sinceDay)}` : CLASS_LABEL[c]
}

export function stackingOf(report: UsageReport, byAgent: boolean, registryOrder: readonly string[], nameOf: (id: string) => string): Stacking {
  if (!byAgent || !report.series.some((d) => d.agents)) {
    const present = SERIES_CLASSES.filter((c) => report.series.some((d) => (d.classes[c] ?? 0) > 0))
    return {
      by: 'class',
      layers: present.map((c) => ({ key: c, label: classLabel(c, report), fill: FILL[c] })),
      valueOf: (i, key) => report.series[i]!.classes[key as SeriesClass] ?? 0,
      agentFill: new Map(),
    }
  }
  const stack = agentStack(report.series, registryOrder)
  const segments = report.series.map((d) => new Map(agentDaySegments(d, stack).map((x) => [x.key, x.value])))
  const agentFill = new Map<string, string>(stack.colored.map((id, i) => [id, `var(--use-agent-${i + 1})`]))
  for (const id of stack.rest) agentFill.set(id, REST_FILL)
  const valueOf = (i: number, key: string): number => segments[i]!.get(key) ?? 0
  const all: Layer[] = [
    ...stack.colored.map((id) => ({ key: `agent:${id}`, label: nameOf(id), fill: agentFill.get(id)! })),
    { key: 'rest', label: stack.rest.length === 1 ? '1 other agent' : `${stack.rest.length} other agents`, fill: REST_FILL },
    ...NO_ONES.map((c) => ({ key: c, label: classLabel(c, report), fill: FILL[c] })),
  ]
  return { by: 'agent', layers: all.filter((l) => report.series.some((_, i) => valueOf(i, l.key) > 0)), valueOf, agentFill }
}

// Home's «This week»: the class stack cut in two (lib/usage.ts attendanceDay)
// — with you, on their own — the same day totals as the class bars
export const ATTENDANCE_FILL: Record<Attendance, string> = { 'with-you': 'var(--use-you)', 'on-their-own': 'var(--use-alone)' }
export function attendanceStacking(report: UsageReport): Stacking {
  const days = report.series.map(attendanceDay)
  const keys = (['with-you', 'on-their-own'] as const).filter((k) => days.some((d) => d[k] > 0))
  return {
    by: 'class',
    layers: keys.map((k) => ({ key: k, label: ATTENDANCE_LABEL[k], fill: ATTENDANCE_FILL[k] })),
    valueOf: (i, key) => days[i]![key as Attendance] ?? 0,
    agentFill: new Map(),
  }
}

export const Chip = ({ fill }: { fill: string }) => (
  <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: fill }} />
)

// one bar a day, stacked by class (or by agent); a single day is one strip across
export function DayBars({ report, stacking, compact = false, today }: { report: UsageReport; stacking: Stacking; compact?: boolean; today?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const { layers, valueOf } = stacking
  const what = stacking.by === 'agent' ? 'agent' : 'class'
  const legendName = stacking.by === 'agent' ? 'Agents' : 'Classes'
  const totals = report.series.map((_, i) => layers.reduce((s, l) => s + valueOf(i, l.key), 0))
  const max = Math.max(1, ...totals)
  if (layers.length === 0) return null
  const legend = compact ? (
    // inside a door (a button holds phrasing content only): spans
    <span
      className="mt-3 grid gap-x-3 gap-y-1 text-[11.5px] text-ink-2 [grid-template-columns:repeat(auto-fill,minmax(8.25rem,1fr))]"
      data-testid="usage-legend"
    >
      {layers.map((l) => (
        <span key={l.key} className="flex min-w-0 items-center gap-1.5">
          <Chip fill={l.fill} />
          <span className="truncate">{l.label}</span>
        </span>
      ))}
    </span>
  ) : (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2" aria-label={legendName} data-testid="usage-legend">
      {layers.map((l) => (
        <li key={l.key} className="flex items-center gap-1.5">
          <Chip fill={l.fill} />
          {l.label}
        </li>
      ))}
    </ul>
  )
  if (report.series.length === 1) {
    const total = totals[0]!
    return (
      <figure className={compact ? '' : 'mt-6'} data-testid="usage-bars" data-by={stacking.by} aria-label={`Today, by ${what}`}>
        <div className="flex h-4 w-full gap-[2px] overflow-hidden rounded-[4px]">
          {layers.map((l) => {
            const v = valueOf(0, l.key)
            return v > 0 ? (
              <div
                key={l.key}
                title={`${l.label} — ${tokenWords(v)} tokens`}
                className="h-full min-w-[3px]"
                style={{ flexGrow: v / total, background: l.fill }}
              />
            ) : null
          })}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-2" aria-label={legendName} data-testid="usage-legend">
          {layers.map((l) => {
            const v = valueOf(0, l.key)
            return v > 0 ? (
              <li key={l.key} className="flex items-baseline gap-1.5">
                <Chip fill={l.fill} />
                <span>{l.label}</span>
                <span className="tabular-nums text-ink">{tokenWords(v)}</span>
              </li>
            ) : null
          })}
        </ul>
      </figure>
    )
  }
  const many = report.series.length > 10
  if (compact) {
    // inside a door: no buttons, no hover layer — each segment's title says
    // it, and the figure's label says the week for a reader
    const label = `Tokens a day, by ${what}: ${report.series.map((d, i) => `${d.day === today ? 'today' : dayWords(d.day)} ${tokenWords(totals[i]!)}`).join(', ')}`
    return (
      <span className="block" data-testid="usage-bars" data-by={stacking.by}>
        <span role="img" className="relative block" aria-label={label}>
          {/* the one gridline: the busiest day's height, said once */}
          <span aria-hidden="true" className="absolute inset-x-0 top-0 flex items-center gap-2 text-[10.5px] text-ink-3">
            <span className="h-px flex-1 bg-line" />
            <span className="tabular-nums">{tokenWords(max)}</span>
          </span>
          <span aria-hidden="true" className="flex h-[116px] items-end gap-[3px] pr-9 pt-3.5 sm:gap-1.5">
            {report.series.map((d, i) => (
              <span
                key={d.day}
                title={`${dayWords(d.day)} — ${tokenWords(totals[i]!)} tokens`}
                className={`flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[5px] ${d.day === today ? 'bg-ink/[0.045] dark:bg-veil-light/[0.06]' : ''}`}
              >
                <span className="flex w-full flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]" style={{ height: `${(totals[i]! / max) * 100}%` }}>
                  {layers.map((l) => {
                    const v = valueOf(i, l.key)
                    return v > 0 ? (
                      <span
                        key={l.key}
                        title={`${l.label} — ${tokenWords(v)} tokens`}
                        className="block w-full min-h-[2px]"
                        style={{ flexGrow: v, background: l.fill }}
                      />
                    ) : null
                  })}
                </span>
              </span>
            ))}
          </span>
          <span aria-hidden="true" className="mt-1.5 flex gap-[3px] pr-9 text-[11px] sm:gap-1.5">
            {report.series.map((d) => (
              <span key={d.day} className={`min-w-0 flex-1 truncate text-center ${d.day === today ? 'font-medium text-ink' : 'text-ink-3'}`}>
                {d.day === today ? 'Today' : dayWords(d.day).split(' ')[0]}
              </span>
            ))}
          </span>
        </span>
        {legend}
      </span>
    )
  }
  return (
    <figure className="mt-6" data-testid="usage-bars" data-by={stacking.by} aria-label={`Tokens a day, by ${what}`}>
      <div className="relative">
        {/* the one gridline: the busiest day's height, said once */}
        <div aria-hidden="true" className="absolute inset-x-0 top-0 flex items-center gap-2 text-[11px] text-ink-3">
          <span className="h-px flex-1 bg-line" />
          <span className="tabular-nums">{tokenWords(max)}</span>
        </div>
        <div className="flex h-[150px] items-end gap-[3px] pr-10 pt-4" onMouseLeave={() => setHover(null)}>
          {report.series.map((d, i) => (
            <button
              key={d.day}
              type="button"
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${dayWords(d.day)}: ${tokenWords(totals[i]!)} tokens`}
              className={`flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[4px] focus-visible:outline-2 focus-visible:outline-terracotta ${hover !== null && hover !== i ? 'opacity-55' : ''}`}
            >
              <span className="flex w-full flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]" style={{ height: `${(totals[i]! / max) * 100}%` }}>
                {layers.map((l) => {
                  const v = valueOf(i, l.key)
                  return v > 0 ? (
                    <span
                      key={l.key}
                      title={`${l.label} — ${tokenWords(v)} tokens`}
                      className="block w-full min-h-[2px]"
                      style={{ flexGrow: v, background: l.fill }}
                    />
                  ) : null
                })}
              </span>
            </button>
          ))}
        </div>
        {hover !== null ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-0 z-10 w-52 rounded-md border border-line bg-canvas px-3 py-2 text-[12px] shadow-sm"
            style={{ left: `clamp(0px, calc(${((hover + 0.5) / report.series.length) * 100}% - 104px), calc(100% - 13rem))` }}
          >
            <p className="mb-1 font-medium text-ink">
              {dayWords(report.series[hover]!.day)} · {tokenWords(totals[hover]!)}
            </p>
            {layers
              .filter((l) => valueOf(hover, l.key) > 0)
              .map((l) => (
                <p key={l.key} className="flex items-center gap-1.5 text-ink-2">
                  <Chip fill={l.fill} />
                  <span className="min-w-0 flex-1 truncate">{l.label}</span>
                  <span className="tabular-nums text-ink">{tokenWords(valueOf(hover, l.key))}</span>
                </p>
              ))}
          </div>
        ) : null}
      </div>
      <div aria-hidden="true" className="mt-1.5 flex gap-[3px] pr-10 text-[10.5px] text-ink-3">
        {report.series.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 truncate text-center">
            {!many || i % 5 === 0 || i === report.series.length - 1 ? dayWords(d.day) : ''}
          </span>
        ))}
      </div>
      {legend}
    </figure>
  )
}
