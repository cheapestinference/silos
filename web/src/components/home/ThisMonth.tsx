// ThisMonth — Home's month, drawn. The moment it
// serves: «What's happening?» asked of the last 30 days — the shape of what
// keeps happening, the miniature whose full plate is System. The whole block
// is the door to System, as This week's is to Usage; it clones This week's
// grammar: a head with its door, thin marks, today marked, no figure at rest
// — a day's figure lives under the cursor.
//
//   automations  runs a day, every automation's (bars, --use-set: Usage's
//                «Automations you set» hue, terracotta as a VALUE)
//   executions   the kernel's executions a day (bars, --use-task)
//   disk         used of the capacity, a day (an area from the base in
//                neutral ink; the dotted top line is the disk's capacity; the
//                last point terracotta)
//
// ADMISSION RULE: only a series that MOVES
// day to day earns a line here. The census (how many agents) is flat for
// weeks — it rides below as a quiet line of words with the kinds said
// (FleetLine), and its history lives in System, never as a spark here.
//
// Real data only: a series with nothing in it says quiet words, never a
// fake chart; a read that failed draws nothing but the door (This week's
// rule).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { orgProjects } from '../../lib/org'
import { systemLanding } from '../../lib/system-house'
import { diskUsed, fleetKinds, gbWords, monthDayWords, type Control, type DayCount, type SystemView, type Vitals } from '../../lib/vitals'

const POLL_MS = 5 * 60_000
const SLOTS = 30

function localYmd(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number]
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

export function ThisMonth() {
  const changePage = useStore((s) => s.changePage)
  const silos = useStore((s) => s.silos)
  const agents = useStore((s) => s.agents)
  const automations = useStore((s) => s.automations)
  const [vitals, setVitals] = useState<Vitals | null>(null)
  const [system, setSystem] = useState<SystemView | null>(null)
  const [failed, setFailed] = useState({ vitals: false, system: false })
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      Promise.resolve(api.vitals())
        .then((v) => {
          if (!cancelled && v) {
            setVitals(v)
            setFailed((f) => ({ ...f, vitals: false }))
          }
        })
        .catch(() => {
          if (!cancelled) setFailed((f) => ({ ...f, vitals: true })) /* what is on screen stays */
        })
      Promise.resolve(api.system())
        .then((s) => {
          if (!cancelled && s) {
            setSystem(s)
            setFailed((f) => ({ ...f, system: false }))
          }
        })
        .catch(() => {
          if (!cancelled) setFailed((f) => ({ ...f, system: true }))
        })
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])
  // the server's today (its local midnight, the runs' last day) — the browser's only while it has none
  const today = vitals?.runs[vitals.runs.length - 1]?.date ?? localYmd(Date.now())
  const waiting = (!vitals && !failed.vitals) || (!system && !failed.system)
  const nothing = !vitals && !system
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  return (
    <section aria-label="This month" className="flex min-w-0 flex-col">
      <button
        type="button"
        data-testid="home-this-month"
        onClick={() => changePage(systemLanding(silos))}
        className="group/m flex flex-col text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-terracotta"
      >
        <span className="flex items-baseline justify-between gap-3 border-b border-ink/80 pb-2.5 dark:border-ink/60">
          <span className="text-[15px] font-semibold text-ink">This month</span>
          <span className="text-[13px] text-ink-2 group-hover/m:text-terracotta">System ›</span>
        </span>
        {nothing ? (
          waiting ? (
            <span className="pt-4 text-[13px] text-ink-3">…</span>
          ) : null
        ) : (
          <span className="flex flex-col gap-3 pt-3.5">
            {vitals ? (
              <SparkRow label="automations">
                <DayBarSpark days={vitals.runs} today={today} fill="var(--use-set)" unit={['run', 'runs']} empty="no runs this month" />
              </SparkRow>
            ) : null}
            {vitals ? (
              <SparkRow label="executions">
                <DayBarSpark days={vitals.executions} today={today} fill="var(--use-task)" unit={['execution', 'executions']} empty="none this month" />
              </SparkRow>
            ) : null}
            {system ? (
              <SparkRow label="disk">
                <DiskSpark disk={system.disk} today={today} />
              </SparkRow>
            ) : null}
          </span>
        )}
      </button>
      {vitals ? (
        <FleetLine
          fleet={vitals.fleet}
          nameOf={nameOf}
          projects={orgProjects(agents).length}
          armed={automations.filter((a) => !a.paused && !a.autoPaused).length}
        />
      ) : null}
    </section>
  )
}

function SparkRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-2.5">
      <span className="text-[12.5px] text-ink-2">{label}</span>
      {children}
    </span>
  )
}

// a series onto the 30 slots, today the last; a day the server didn't list is no day
function slotted<T extends { date: string }>(days: readonly T[], today: string): Array<T | null> {
  const out: Array<T | null> = Array.from({ length: SLOTS }, () => null)
  for (const d of days) {
    const back = daysBetween(d.date, today)
    if (back >= 0 && back < SLOTS) out[SLOTS - 1 - back] = d
  }
  return out
}

const SPARK_H = 'h-[30px]'
// today marked as This week marks it: its column on a quiet ground
const TODAY_GROUND = 'bg-ink/[0.06] dark:bg-veil-light/[0.08]'

function DayBarSpark({ days, today, fill, unit, empty }: { days: readonly DayCount[]; today: string; fill: string; unit: [string, string]; empty: string }) {
  const slots = useMemo(() => slotted(days, today), [days, today])
  const max = Math.max(0, ...days.map((d) => d.count))
  if (max === 0) return <span className="text-[12px] text-ink-3">{empty}</span>
  const words = (d: DayCount): string => `${monthDayWords(d.date)} — ${d.count} ${d.count === 1 ? unit[0] : unit[1]}`
  return (
    <span
      role="img"
      aria-label={`${unit[1]} a day, last 30 days: ${days.map((d) => `${d.date === today ? 'today' : monthDayWords(d.date)} ${d.count}`).join(', ')}`}
      className={`flex ${SPARK_H} items-end gap-px`}
    >
      {slots.map((d, i) => (
        <span
          key={i}
          title={d ? words(d) : undefined}
          aria-hidden="true"
          className={`flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[2px] ${d?.date === today ? TODAY_GROUND : ''}`}
        >
          {d ? (
            <span
              className="block w-full rounded-t-[1.5px]"
              style={{
                height: d.count > 0 ? `${Math.max(8, (d.count / max) * 100)}%` : '1px',
                background: fill,
                opacity: d.count > 0 ? (d.date === today ? 1 : 0.82) : 0.35,
              }}
            />
          ) : null}
        </span>
      ))}
    </span>
  )
}

function DiskSpark({ disk, today }: { disk: SystemView['disk']; today: string }) {
  const cap = disk.capBytes
  const slots = useMemo(() => slotted(disk.days, today), [disk.days, today])
  const pts = slots.flatMap((d, i) => (d ? [{ i, used: diskUsed(d.bytes), date: d.date }] : []))
  if (pts.length === 0 || !(cap > 0)) return <span className="text-[12px] text-ink-3">not measured yet</span>
  // the plot: x the slot's centre (aligned with the bars above), y the
  // share of the capacity — 100 = the dotted capacity line at the top
  const X = (i: number): number => ((i + 0.5) / SLOTS) * 100
  const Y = (used: number): number => 100 - Math.min(1, Math.max(0, used / cap)) * 88
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.i).toFixed(2)} ${Y(p.used).toFixed(2)}`).join(' ')
  const area = `${line} L${X(pts[pts.length - 1]!.i).toFixed(2)} 100 L${X(pts[0]!.i).toFixed(2)} 100 Z`
  const last = pts[pts.length - 1]!
  const pct = (used: number): number => Math.round((used / cap) * 100)
  return (
    <span
      role="img"
      aria-label={`Disk, last 30 days: ${pct(last.used)}% of ${gbWords(cap)} used${last.date === today ? ' today' : ` on ${monthDayWords(last.date)}`}`}
      className={`relative block ${SPARK_H}`}
    >
      <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        <line x1="0" x2="100" y1="5" y2="5" stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        {pts.length > 1 ? (
          <>
            <path d={area} fill="var(--ink)" opacity="0.08" />
            <path d={line} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinejoin="round" opacity="0.75" vectorEffect="non-scaling-stroke" />
          </>
        ) : null}
      </svg>
      {/* the last point: HTML, so the stretched plot never makes it an oval */}
      <span
        aria-hidden="true"
        className="absolute h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-terracotta"
        style={{ left: `${X(last.i)}%`, top: `${Y(last.used)}%` }}
      />
      {/* the cursor's layer: one column per day that has a reading */}
      <span aria-hidden="true" className="absolute inset-0 flex">
        {slots.map((d, i) => (
          <span
            key={i}
            className="h-full min-w-0 flex-1"
            title={d ? `${monthDayWords(d.date)} — ${pct(diskUsed(d.bytes))}% · ${gbWords(diskUsed(d.bytes))} of ${gbWords(cap)}` : undefined}
          />
        ))}
      </span>
    </span>
  )
}

// The fleet line (moment 1, the census with its kinds said): quiet, below
// the door — each kind with its ink mark, its word and its count; the
// ladder is ordinal, so the mark is INK WEIGHT (solid · half · hollow),
// never three hues. Under the cursor, the agents of that kind. A kind with
// nobody is not listed. Below it, the counts of the house.
const MARK: Record<Control, string> = {
  proactive: 'bg-ink',
  own: 'bg-ink/40 ring-[1.5px] ring-inset ring-ink',
  told: 'ring-[1.5px] ring-inset ring-ink-3',
}

function FleetLine({ fleet, nameOf, projects, armed }: { fleet: Vitals['fleet']; nameOf: (id: string) => string; projects: number; armed: number }) {
  const kinds = fleetKinds(fleet.today, nameOf)
  const total = fleet.today.told + fleet.today.own + fleet.today.proactive
  if (total === 0) return null
  // One kind alone carries no contrast: a lone ink mark reads as a bullet,
  // not as a position on the ladder. So a fleet all of one kind is SAID as
  // one sentence, and the marks appear only when there are kinds to compare
  // — the same admission rule as the sparks (ink only where it tells).
  const oneKind = kinds.length === 1 ? kinds[0] : null
  const counts = [
    oneKind
      ? `${total} ${total === 1 ? 'agent' : 'agents'} — ${total === 1 ? '' : 'all '}${oneKind.word.toLowerCase()}`
      : `${total} ${total === 1 ? 'agent' : 'agents'}`,
    `${projects} ${projects === 1 ? 'project' : 'projects'}`,
    `${armed} ${armed === 1 ? 'automation' : 'automations'} armed`,
  ]
  return (
    <div data-testid="home-fleet-line" className="flex flex-col gap-1.5 pt-4 text-[12.5px] text-ink-3">
      {oneKind === null ? (
        <p className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
          {kinds.map((k) => (
            <span key={k.control} data-control={k.control} title={`${k.word}: ${k.names.join(' · ')}`} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={`inline-block h-[9px] w-[9px] rounded-full ${MARK[k.control]}`} />
              {k.word} <span className="font-medium tabular-nums text-ink">{k.count}</span>
            </span>
          ))}
        </p>
      ) : null}
      <p title={oneKind ? `${oneKind.word}: ${oneKind.names.join(' · ')}` : undefined}>{counts.join(' · ')}</p>
    </div>
  )
}
