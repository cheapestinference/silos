// SystemPage — System's landing, Vitals:
// the machine told in Silos' terms. The moment it serves: «Is this machine
// keeping up?» — asked from the rail's System door. In order:
//
//   Disk · last 30 days   who eats the disk (transcripts, trash, worktrees,
//                         agent state, the rest) — GET /api/system
//   Memory · 7 days       by the hour; the server's downtime is a gap
//   Fleet · 90 days       the agents by control — GET /api/vitals
//   Automation runs · Executions   a bar a day
//   the quiet row         the trash's size, Worktrees ›, uptime and load
//
// Real data only: a short history draws the days there are and says so in
// one quiet sentence; nothing measured is words, never a fake chart; a read
// that failed draws nothing of its own (ThisWeek's rule) — the doors stay.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { systemListOf } from '../../lib/system-house'
import { bytesWords, shortHistoryWords, uptimeWords, type SystemReport, type VitalsReport } from '../../lib/vitals'
import { PageHeader } from '../PageHeader'
import { SystemTabs } from '../SystemTabs'
import { SiloDoor, useSiloMissing } from '../silo/SiloDoor'
import { DayCountBars, DiskChart, DiskLegend, FleetChart, FleetLegend, MemoryChart } from './charts'

const POLL_MS = 60_000
const HOUR = 3600_000

// one read, polled while the tab is visible; a figure on screen stays when
// a later read fails — `failed` only says the FIRST never came
function usePolled<T>(read: () => Promise<T>): { data: T | null; failed: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      Promise.resolve(read())
        .then((r) => {
          if (!cancelled && r) {
            setData(r)
            setFailed(false)
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [read])
  return { data, failed }
}

const readSystem = (): Promise<SystemReport> => api.system()
const readVitals = (): Promise<VitalsReport> => api.vitals()

export function SystemPage() {
  const silos = useStore((s) => s.silos)
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const system = usePolled(readSystem)
  const vitals = usePolled(readVitals)
  const nowMs = Date.now()
  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  const nameOf = (id: string): string => names.get(id) ?? id
  const worktrees = systemListOf(silos, 'worktree')
  const noLists = useSiloMissing('system')
  const sys = system.data
  const vit = vitals.data
  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="system-page">
      <PageHeader
        testId="system-header"
        title="System"
        tabs={<SystemTabs />}
        facts={<span className="min-w-0 truncate">What this machine holds and runs, counted in Silos’ terms</span>}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-6 sm:px-6">
          {sys ? <DiskBlock sys={sys} /> : <Pending failed={system.failed} />}
          <div className="mt-8 grid gap-x-8 gap-y-8 md:grid-cols-2">
            {sys ? <MemoryBlock sys={sys} nowMs={nowMs} /> : null}
            {vit ? (
              <Block title="Fleet · 90 days" detail={agentsWords(vit.fleet.today)} testId="system-fleet">
                {vit.fleet.days.length > 0 ? (
                  <>
                    <FleetChart fleet={vit.fleet} nameOf={nameOf} />
                    <FleetLegend today={vit.fleet.today} />
                  </>
                ) : (
                  <Words>No agent yet — the fleet’s history starts with the first one.</Words>
                )}
              </Block>
            ) : null}
            {vit ? (
              <Block title="Automation runs" detail={monthWords(vit.runs)} testId="system-runs">
                {vit.runs.some((d) => d.count > 0) ? (
                  <DayCountBars days={vit.runs} fill="var(--use-set)" unit={['run', 'runs']} testId="system-runs-chart" />
                ) : (
                  <Words>No automation ran in the last 30 days.</Words>
                )}
              </Block>
            ) : null}
            {vit ? (
              <Block title="Executions" detail={monthWords(vit.executions)} testId="system-executions">
                {vit.executions.some((d) => d.count > 0) ? (
                  <DayCountBars days={vit.executions} fill="var(--use-task)" unit={['execution', 'executions']} testId="system-executions-chart" />
                ) : (
                  <Words>No execution in the last 30 days.</Words>
                )}
              </Block>
            ) : null}
          </div>
          <div className="mt-9 flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t border-line pt-4 text-[13px]" data-testid="system-footer">
            {sys ? (
              <span className="text-ink-2" data-testid="system-trash">
                The trash holds <span className="font-mono text-[12px] tabular-nums text-ink">{bytesWords(sys.trash.bytes)}</span>; it empties itself after 30
                days.
              </span>
            ) : null}
            {worktrees ? (
              <button
                type="button"
                data-testid="system-worktrees"
                onClick={() => changePage(worktrees)}
                className="rounded-sm text-ink-2 hover:text-terracotta focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
              >
                Worktrees ›
              </button>
            ) : noLists ? (
              // the Processes and Worktrees tabs are the System silo's
              <SiloDoor silo="system" says="Processes and worktrees come with the System silo" className="text-[13px]" />
            ) : null}
            {sys ? (
              <span className="text-[12.5px] text-ink-3 sm:ml-auto" data-testid="system-uptime">
                {uptimeWords(sys.server.since, nowMs)} · load {sys.load.toFixed(1)}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function Block({ title, detail, testId, children, note }: { title: string; detail?: string; testId: string; children: ReactNode; note?: string | null }) {
  return (
    <section aria-label={title} data-testid={testId} className="flex min-w-0 flex-col">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {detail ? <span className="text-[12px] tabular-nums text-ink-3">{detail}</span> : null}
      </div>
      {children}
      {note ? (
        <p className="mt-2 text-[12px] text-ink-3" data-testid={`${testId}-short`}>
          {note}
        </p>
      ) : null}
    </section>
  )
}

const Words = ({ children }: { children: ReactNode }) => <p className="py-6 font-display text-[17px] leading-snug text-ink-2">{children}</p>

function Pending({ failed }: { failed: boolean }) {
  return failed ? null : <p className="text-[13px] text-ink-3">…</p>
}

function DiskBlock({ sys }: { sys: SystemReport }) {
  const { days, capBytes, now } = sys.disk
  const detail = capBytes > 0 ? `${bytesWords(now.usedBytes)} of ${bytesWords(capBytes)}` : bytesWords(now.usedBytes)
  return (
    <Block title="Disk · last 30 days" detail={detail} testId="system-disk" note={shortHistoryWords(days.length, 30, days[0]?.date ?? null, 'days')}>
      {days.length === 0 ? (
        <Words>No sample of the disk yet — the first one lands within the hour.</Words>
      ) : (
        <>
          <DiskChart disk={sys.disk} />
          <DiskLegend bytes={now.bytes} />
        </>
      )}
    </Block>
  )
}

function MemoryBlock({ sys, nowMs }: { sys: SystemReport; nowMs: number }) {
  const pts = sys.memory.points
  const last = pts[pts.length - 1]
  const first = pts[0]
  const heldHours = first ? Math.round((nowMs - Date.parse(first.at)) / HOUR) : 0
  return (
    <Block
      title="Memory · 7 days"
      detail={last ? `now ${bytesWords(last.usedBytes)} of ${bytesWords(sys.memory.totalBytes)}` : undefined}
      testId="system-memory"
      note={first ? shortHistoryWords(heldHours, 7 * 24 - 1, first.at, 'hours') : null}
    >
      {pts.length === 0 ? <Words>No sample of the memory yet — one lands every hour.</Words> : <MemoryChart memory={sys.memory} nowMs={nowMs} />}
    </Block>
  )
}

function agentsWords(t: VitalsReport['fleet']['today']): string {
  const n = t.told + t.own + t.proactive
  return `${n} ${n === 1 ? 'agent' : 'agents'}`
}

const monthWords = (days: VitalsReport['runs']): string => `${days.reduce((s, d) => s + d.count, 0)} in 30 days`
