// charts.tsx — the System page's drawings.
// Drawn in real pixels (the box is measured), so a label is 10 px
// at any width; the house's chart grammar: one quiet axis, gridlines in
// --line, figures in mono, today marked, the figure at the cursor.
//
//   DiskChart     area stacked by who eats the disk, 2 px of ground between
//                 bands, crosshair + the day's breakdown at the cursor
//   MemoryChart   one ink line by the hour; an hour without a sample between
//                 two is the server down — drawn as a gap, under a soft veil
//   FleetChart    the fleet stacked by control: ink weight is the ladder
//                 (Proactive darkest, at the bottom); births are terracotta
//                 ticks with a name, changes of control hollow circles
//   DayCountBars  one bar a day (runs, executions)
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  CONTROLS,
  CONTROL_INK,
  CONTROL_LABEL,
  DISK_FILL,
  DISK_GROUPS,
  DISK_LABEL,
  bytesWords,
  diskStack,
  diskTotal,
  gbFigure,
  hourWords,
  memoryRuns,
  niceTicks,
  shortDay,
  type DayCount,
  type SystemReport,
  type VitalsReport,
} from '../../lib/vitals'

function useWidth<T extends HTMLElement>(fallback = 640): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => {
      const next = Math.round(el.clientWidth)
      if (next > 0) setW((cur) => (cur === next ? cur : next))
    }
    read()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])
  return [ref, w]
}

const AXIS = { fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--ink-3)' } as const
const NOTE = { fontFamily: 'var(--font-body)', fontSize: 10.5 } as const

// the tooltip: beside the cursor's column, flipped near the right edge
function Tip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const TW = 216
  const left = x + 14 + TW > width ? Math.max(0, x - 14 - TW) : x + 14
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute top-1 z-10 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12px] leading-[1.45] text-ink shadow-sm"
      style={{ left, width: TW }}
    >
      {children}
    </div>
  )
}
const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[11px] tabular-nums text-ink-2">{children}</span>
const Swatch = ({ fill }: { fill: string }) => <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-[2px]" style={{ background: fill }} />

// a time axis's labels: the first day, a few in between, «Today» at the end
function dayLabels(dates: readonly string[], X: (i: number) => number, width: number): Array<{ i: number; text: string; anchor: 'start' | 'middle' | 'end' }> {
  const n = dates.length
  if (n === 0) return []
  const out: Array<{ i: number; text: string; anchor: 'start' | 'middle' | 'end' }> = [{ i: n - 1, text: 'Today', anchor: 'end' }]
  if (n === 1) return out
  const room = width > 520 ? 4 : 2
  const step = Math.max(1, Math.ceil((n - 1) / room))
  for (let i = n - 1 - step; i > 0; i -= step) if (X(i) - X(0) > 56 && X(n - 1) - X(i) > 48) out.push({ i, text: shortDay(dates[i]!), anchor: 'middle' })
  out.push({ i: 0, text: shortDay(dates[0]!), anchor: 'start' })
  return out
}

// an axis figure in GB: whole numbers when the step allows it
const axisGb = (bytes: number): string => {
  const g = bytes / 1e9
  return Number.isInteger(Math.round(g * 100) / 100) ? String(Math.round(g)) : gbFigure(bytes)
}

const indexAt = (clientX: number, box: DOMRect, X: (i: number) => number, n: number): number => {
  const px = clientX - box.left
  let best = 0
  for (let i = 1; i < n; i++) if (Math.abs(X(i) - px) < Math.abs(X(best) - px)) best = i
  return best
}

// ---------------------------------------------------------------------------
// Disk · last 30 days
// ---------------------------------------------------------------------------

export function DiskChart({ disk }: { disk: SystemReport['disk'] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const days = disk.days
  const n = days.length
  if (n === 1) return <DiskStrip bytes={days[0]!.bytes} />
  const H = 240,
    L = 38,
    R = 6,
    T = 20,
    B = 22
  const pw = width - L - R,
    ph = H - T - B
  const stack = diskStack(days)
  const max = Math.max(1, ...days.map((d) => diskTotal(d.bytes)))
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1]!
  const X = (i: number): number => L + (i / (n - 1)) * pw
  const Y = (v: number): number => T + ph - (v / top) * ph
  const area = (g: (typeof DISK_GROUPS)[number]): string => {
    let d = ''
    for (let i = 0; i < n; i++) d += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(stack[i]![g][1]).toFixed(1)} `
    for (let i = n - 1; i >= 0; i--) d += `L${X(i).toFixed(1)} ${Y(stack[i]![g][0]).toFixed(1)} `
    return d + 'Z'
  }
  const label = `Disk by group over ${n} days; today ${DISK_GROUPS.map((g) => `${DISK_LABEL[g]} ${bytesWords(days[n - 1]!.bytes[g])}`).join(', ')}`
  return (
    <div ref={ref} className="relative" data-testid="system-disk-chart" data-days={n}>
      <svg
        role="img"
        aria-label={label}
        width={width}
        height={H}
        className="block"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => setHover(indexAt(e.clientX, e.currentTarget.getBoundingClientRect(), X, n))}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={width - R} y1={Y(t)} y2={Y(t)} stroke="var(--line)" strokeWidth={t ? 0.75 : 1} />
            <text x={L - 6} y={Y(t) + 3} textAnchor="end" style={AXIS}>
              {axisGb(t)}
            </text>
          </g>
        ))}
        <text x={L - 6} y={Y(top) - 9} textAnchor="end" style={AXIS}>
          GB
        </text>
        {DISK_GROUPS.map((g) => (
          <path key={g} d={area(g)} fill={DISK_FILL[g]} stroke="var(--canvas)" strokeWidth={2} strokeLinejoin="round" opacity={0.92} />
        ))}
        {dayLabels(
          days.map((d) => d.date),
          X,
          width,
        ).map((l) => (
          <text key={l.i} x={X(l.i)} y={H - 6} textAnchor={l.anchor} style={AXIS}>
            {l.text}
          </text>
        ))}
        {hover !== null ? <line x1={X(hover)} x2={X(hover)} y1={T} y2={T + ph} stroke="var(--ink-2)" strokeWidth={1} opacity={0.55} /> : null}
      </svg>
      {hover !== null ? (
        <Tip x={X(hover)} width={width}>
          <p className="mb-0.5">
            <span className="font-medium">{shortDay(days[hover]!.date)}</span> — {bytesWords(diskTotal(days[hover]!.bytes))}
          </p>
          {[...DISK_GROUPS].reverse().map((g) => (
            <p key={g} className="flex items-center gap-1.5 text-ink-2">
              <Swatch fill={DISK_FILL[g]} />
              <span className="min-w-0 flex-1">{DISK_LABEL[g]}</span>
              <Mono>{bytesWords(days[hover]!.bytes[g])}</Mono>
            </p>
          ))}
        </Tip>
      ) : null}
    </div>
  )
}

// one day only: a single strip across, Usage's grammar for a lone day
function DiskStrip({ bytes }: { bytes: SystemReport['disk']['now']['bytes'] }) {
  const total = Math.max(1, diskTotal(bytes))
  return (
    <div data-testid="system-disk-chart" data-days={1} className="flex h-4 w-full gap-[2px] overflow-hidden rounded-[4px]">
      {DISK_GROUPS.map((g) =>
        bytes[g] > 0 ? (
          <div
            key={g}
            title={`${DISK_LABEL[g]} — ${bytesWords(bytes[g])}`}
            className="h-full min-w-[3px]"
            style={{ flexGrow: bytes[g] / total, background: DISK_FILL[g] }}
          />
        ) : null,
      )}
    </div>
  )
}

export function DiskLegend({ bytes }: { bytes: SystemReport['disk']['now']['bytes'] }) {
  return (
    <ul aria-label="Disk groups" className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
      {DISK_GROUPS.map((g) => (
        <li key={g} className="flex items-center gap-1.5">
          <Swatch fill={DISK_FILL[g]} />
          {DISK_LABEL[g]}
          <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{bytesWords(bytes[g])}</span>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Memory · 7 days
// ---------------------------------------------------------------------------

const HOUR = 3600_000

export function MemoryChart({ memory, nowMs }: { memory: SystemReport['memory']; nowMs: number }) {
  const [ref, width] = useWidth<HTMLDivElement>(380)
  const [hover, setHover] = useState<number | null>(null)
  const { runs, gaps } = memoryRuns(memory.points)
  const all = runs.flat()
  const H = 150,
    L = 26,
    R = 6,
    T = 8,
    B = 18
  const pw = width - L - R,
    ph = H - T - B
  const first = all[0]?.ms ?? nowMs
  const start = Math.min(Math.max(nowMs - 7 * 24 * HOUR, first), nowMs - HOUR)
  const end = Math.max(nowMs, all[all.length - 1]?.ms ?? nowMs)
  const X = (ms: number): number => L + ((ms - start) / (end - start)) * pw
  const totalGb = memory.totalBytes
  const top = totalGb > 0 ? totalGb : Math.max(1, ...all.map((p) => p.usedBytes))
  const Y = (v: number): number => T + ph - (v / top) * ph
  const ticks = [0, top / 2, top]
  const last = all[all.length - 1]
  let saidAt = -Infinity
  const at =
    hover === null
      ? null
      : (() => {
          const inGap = gaps.find((g) => hover > g.fromMs && hover < g.toMs)
          if (inGap) return { ms: hover, gap: true as const }
          let best = all[0]
          for (const p of all) if (best && Math.abs(p.ms - hover) < Math.abs(best.ms - hover)) best = p
          return best ? { ms: best.ms, gap: false as const, usedBytes: best.usedBytes } : null
        })()
  const label = last
    ? `Memory by the hour; now ${bytesWords(last.usedBytes)} of ${bytesWords(memory.totalBytes)}${gaps.length ? `; the server was down ${gaps.length === 1 ? 'once' : `${gaps.length} times`}` : ''}`
    : 'Memory: no sample yet'
  return (
    <div ref={ref} className="relative" data-testid="system-memory-chart" data-points={all.length} data-gaps={gaps.length}>
      <svg
        role="img"
        aria-label={label}
        width={width}
        height={H}
        className="block"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left
          setHover(start + ((px - L) / pw) * (end - start))
        }}
      >
        {ticks.map((t, k) => (
          <g key={k}>
            <line x1={L} x2={width - R} y1={Y(t)} y2={Y(t)} stroke="var(--line)" strokeWidth={t ? 0.75 : 1} />
            <text x={L - 5} y={Y(t) + 3} textAnchor="end" style={AXIS}>
              {Math.round(t / 1e9)}
            </text>
          </g>
        ))}
        {gaps.map((g) => {
          const x0 = X(g.fromMs),
            x1 = X(g.toMs)
          // the words ride the veil's top, centred — over the gap, never over
          // the last ones said
          const cx = Math.min(Math.max((x0 + x1) / 2, L + 30), width - R - 30)
          const say = x1 - x0 >= 6 && cx - saidAt > 72
          if (say) saidAt = cx
          return (
            <g key={g.fromMs} data-testid="system-memory-gap">
              <rect x={x0} y={T} width={Math.max(1, x1 - x0)} height={ph} fill="var(--health-red)" opacity={0.08} />
              {say ? (
                <text x={cx} y={T + 11} textAnchor="middle" style={{ ...NOTE, fill: 'var(--health-red)' }}>
                  server down
                </text>
              ) : null}
            </g>
          )
        })}
        {runs.map((r) =>
          r.length === 1 ? (
            <circle key={r[0]!.ms} cx={X(r[0]!.ms)} cy={Y(r[0]!.usedBytes)} r={1.4} fill="var(--ink)" opacity={0.8} />
          ) : (
            <path
              key={r[0]!.ms}
              d={r.map((p, i) => `${i ? 'L' : 'M'}${X(p.ms).toFixed(1)} ${Y(p.usedBytes).toFixed(1)}`).join(' ')}
              fill="none"
              stroke="var(--ink)"
              strokeWidth={1.6}
              strokeLinejoin="round"
              opacity={0.8}
            />
          ),
        )}
        {last ? <circle cx={X(last.ms)} cy={Y(last.usedBytes)} r={2.5} fill="var(--terracotta)" /> : null}
        <text x={L} y={H - 4} textAnchor="start" style={AXIS}>
          {shortDay(isoDay(start))}
        </text>
        <text x={width - R} y={H - 4} textAnchor="end" style={AXIS}>
          Today
        </text>
        {at ? <line x1={X(at.ms)} x2={X(at.ms)} y1={T} y2={T + ph} stroke="var(--ink-2)" strokeWidth={1} opacity={0.55} /> : null}
      </svg>
      {at ? (
        <Tip x={X(at.ms)} width={width}>
          {at.gap ? (
            <p>
              <span className="font-medium">{hourWords(at.ms)}</span> — no sample <span className="text-[var(--health-red)]">· server down</span>
            </p>
          ) : (
            <p>
              <span className="font-medium">{hourWords(at.ms)}</span> — {bytesWords(at.usedBytes)} <Mono>of {bytesWords(memory.totalBytes)}</Mono>
            </p>
          )}
        </Tip>
      ) : null}
    </div>
  )
}

function isoDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Fleet · 90 days
// ---------------------------------------------------------------------------

// the ink mark of a step of the ladder — the same three as Home's dots
export function InkMark({ control }: { control: (typeof CONTROLS)[number] }) {
  const style =
    control === 'proactive'
      ? { background: 'var(--ink)' }
      : control === 'own'
        ? { background: 'color-mix(in srgb, var(--ink) 38%, transparent)', boxShadow: 'inset 0 0 0 1.5px var(--ink)' }
        : { boxShadow: 'inset 0 0 0 1.5px var(--ink-3)' }
  return <span aria-hidden="true" className="inline-block h-[9px] w-[9px] shrink-0 rounded-full" style={style} />
}

export function FleetChart({ fleet, nameOf }: { fleet: VitalsReport['fleet']; nameOf: (id: string) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>(380)
  const [hover, setHover] = useState<number | null>(null)
  const days = fleet.days
  const n = days.length
  const H = 150,
    L = 22,
    R = 6,
    T = 16,
    B = 18
  const pw = width - L - R,
    ph = H - T - B
  const cPro = days.map((d) => d.proactive)
  const cOwn = days.map((d) => d.proactive + d.own)
  const cTot = days.map((d) => d.proactive + d.own + d.told)
  const ticks = niceTicks(Math.max(1, ...cTot), 3)
  const top = ticks[ticks.length - 1]!
  // a day is a step: its column runs from i to i+1
  const X = (i: number): number => L + (i / Math.max(1, n)) * pw
  const Y = (v: number): number => T + ph - (v / top) * ph
  const edge = (a: readonly number[], rev: boolean): string => {
    const idx = rev ? [...a.keys()].reverse() : [...a.keys()]
    let d = ''
    for (const i of idx) {
      const [xa, xb] = rev ? [X(i + 1), X(i)] : [X(i), X(i + 1)]
      d += `${d ? 'L' : rev ? 'L' : 'M'}${xa.toFixed(1)} ${Y(a[i]!).toFixed(1)} L${xb.toFixed(1)} ${Y(a[i]!).toFixed(1)} `
    }
    return d
  }
  const zero = days.map(() => 0)
  const bands: Array<[readonly number[], readonly number[], (typeof CONTROLS)[number]]> = [
    [zero, cPro, 'proactive'],
    [cPro, cOwn, 'own'],
    [cOwn, cTot, 'told'],
  ]
  const byDate = new Map(days.map((d, i) => [d.date, i]))
  const events = fleet.events.map((e) => ({ e, i: byDate.get(e.date) })).filter((x): x is { e: typeof x.e; i: number } => x.i !== undefined)
  // a birth's name, only where it has room (never over the last one)
  let lastLabel = -Infinity
  const eventWords = (e: VitalsReport['fleet']['events'][number]): string =>
    e.kind === 'birth' ? `${nameOf(e.agent)} joined` : `${nameOf(e.agent)} › ${CONTROL_LABEL[e.to].toLowerCase()}`
  const today = fleet.today
  const label = `The fleet by control over ${n} days; today ${today.proactive} proactive, ${today.own} on their own, ${today.told} only when told`
  return (
    <div ref={ref} className="relative" data-testid="system-fleet-chart" data-days={n} data-events={events.length}>
      <svg
        role="img"
        aria-label={label}
        width={width}
        height={H}
        className="block"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left
          setHover(Math.max(0, Math.min(n - 1, Math.floor(((px - L) / pw) * n))))
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={width - R} y1={Y(t)} y2={Y(t)} stroke="var(--line)" strokeWidth={t ? 0.75 : 1} />
            <text x={L - 5} y={Y(t) + 3} textAnchor="end" style={AXIS}>
              {t}
            </text>
          </g>
        ))}
        {bands.map(([b, t, c]) => (
          <path
            key={c}
            d={`${edge(t, false)}${edge(b, true)}Z`}
            fill="var(--ink)"
            opacity={CONTROL_INK[c]}
            stroke="var(--canvas)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ))}
        {events.map(({ e, i }, k) => {
          const x = X(i) + (X(i + 1) - X(i)) / 2
          if (e.kind === 'control') {
            const y = e.to === 'proactive' || e.from === 'proactive' ? Y(cPro[i]!) : Y(cOwn[i]!)
            return <circle key={k} cx={x} cy={y} r={3} fill="var(--canvas)" stroke="var(--terracotta)" strokeWidth={1.5} />
          }
          const y = Y(cTot[i]!)
          const name = nameOf(e.agent)
          const room = x - lastLabel > 64
          if (room) lastLabel = x
          const nearEnd = x > width - R - 60
          return (
            <g key={k}>
              <line x1={x} x2={x} y1={y - 4} y2={y + 4} stroke="var(--terracotta)" strokeWidth={2} />
              {room ? (
                <text x={nearEnd ? x - 3 : x + 3} y={y - 6} textAnchor={nearEnd ? 'end' : 'start'} style={{ ...NOTE, fill: 'var(--ink-2)' }}>
                  {name}
                </text>
              ) : null}
            </g>
          )
        })}
        {n > 0 ? (
          <text x={L} y={H - 4} textAnchor="start" style={AXIS}>
            {shortDay(days[0]!.date)}
          </text>
        ) : null}
        <text x={width - R} y={H - 4} textAnchor="end" style={AXIS}>
          Today
        </text>
        {hover !== null ? (
          <line
            x1={X(hover) + (X(hover + 1) - X(hover)) / 2}
            x2={X(hover) + (X(hover + 1) - X(hover)) / 2}
            y1={T}
            y2={T + ph}
            stroke="var(--ink-2)"
            strokeWidth={1}
            opacity={0.55}
          />
        ) : null}
      </svg>
      {hover !== null && days[hover] ? (
        <Tip x={X(hover)} width={width}>
          <p>
            <span className="font-medium">{shortDay(days[hover].date)}</span> — {cTot[hover]} {cTot[hover] === 1 ? 'agent' : 'agents'}
          </p>
          <p>
            <Mono>
              {days[hover].proactive} proactive · {days[hover].own} on their own · {days[hover].told} only when told
            </Mono>
          </p>
          {events
            .filter((x) => x.i === hover)
            .map(({ e }, k) => (
              <p key={k} className="text-ink-2">
                {eventWords(e)}
              </p>
            ))}
        </Tip>
      ) : null}
    </div>
  )
}

export function FleetLegend({ today }: { today: VitalsReport['fleet']['today'] }) {
  return (
    <ul aria-label="Control" className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
      {CONTROLS.map((c) => (
        <li key={c} className="flex items-center gap-1.5">
          <InkMark control={c} />
          {CONTROL_LABEL[c]}
          <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{today[c]}</span>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Automation runs · Executions — one bar a day
// ---------------------------------------------------------------------------

export function DayCountBars({ days, fill, unit, testId }: { days: readonly DayCount[]; fill: string; unit: [string, string]; testId: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(380)
  const [hover, setHover] = useState<number | null>(null)
  const n = days.length
  const H = 120,
    L = 22,
    R = 6,
    T = 8,
    B = 16
  const pw = width - L - R,
    ph = H - T - B
  const max = Math.max(1, ...days.map((d) => d.count))
  const slot = pw / Math.max(1, n)
  const bw = Math.max(1, slot - 2)
  const X = (i: number): number => L + i * slot + slot / 2
  const words = (c: number): string => `${c} ${c === 1 ? unit[0] : unit[1]}`
  return (
    <div ref={ref} className="relative" data-testid={testId} data-days={n} data-total={days.reduce((s, d) => s + d.count, 0)}>
      <svg
        role="img"
        aria-label={`${unit[1]} a day: ${days.map((d) => `${shortDay(d.date)} ${d.count}`).join(', ')}`}
        width={width}
        height={H}
        className="block"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left
          setHover(Math.max(0, Math.min(n - 1, Math.floor((px - L) / slot))))
        }}
      >
        <text x={L - 5} y={T + 3} textAnchor="end" style={AXIS}>
          {max}
        </text>
        <line x1={L} x2={width - R} y1={T} y2={T} stroke="var(--line)" strokeWidth={0.75} strokeDasharray="2 3" />
        <line x1={L} x2={width - R} y1={T + ph} y2={T + ph} stroke="var(--line)" />
        {days.map((d, i) => {
          const h = (d.count / max) * ph
          return (
            <rect
              key={d.date}
              x={L + i * slot + 1}
              y={T + ph - Math.max(h, 0.8)}
              width={bw}
              height={Math.max(h, 0.8)}
              rx={Math.min(2, bw / 2)}
              fill={fill}
              opacity={hover !== null && hover !== i ? 0.45 : i === n - 1 ? 1 : 0.85}
            />
          )
        })}
        {n > 0 ? (
          <text x={L} y={H - 3} textAnchor="start" style={AXIS}>
            {shortDay(days[0]!.date)}
          </text>
        ) : null}
        <text x={width - R} y={H - 3} textAnchor="end" style={AXIS}>
          Today
        </text>
      </svg>
      {hover !== null && days[hover] ? (
        <Tip x={X(hover)} width={width}>
          <p>
            <span className="font-medium">{shortDay(days[hover].date)}</span> — {words(days[hover].count)}
          </p>
        </Tip>
      ) : null}
    </div>
  )
}
