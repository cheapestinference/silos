// UsesView.tsx — Map › Uses: an N×N matrix of what was ACTUALLY used.
// Rows are agents, projects or conversations; columns are models, files,
// tools, MCP servers, skills or accounts; a cell is the number of
// conversations in which that row used that column, read from each
// conversation's own transcript (GET /api/uses, server/src/uses.ts). The
// Map's landing view since the wiring graph retired: it
// counts what did happen, not what the configuration says could.
//
// Literal on purpose: one number per cell, one accent whose strength is the
// cell's share of the busiest one, nothing inferred. A click on a cell opens
// the conversations behind it; each opens the conversation.
//
// Geometry: the controls stay put and the matrix is its own scroll box (both
// axes), so the row and column headers stick and the page itself never
// scrolls sideways — at 390px only the matrix pans.
import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { MASTER_ID, ANYWHERE_LABEL } from '../lib/constants'
import { relTime } from '../lib/rel-time'
import {
  COL_KINDS,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SINCE,
  ROW_KINDS,
  WINDOWS,
  columnHeadings,
  columnTitle,
  compact,
  intensity,
  measureWords,
  plural,
} from '../lib/uses'
import { MoreFold, useFold } from './MoreFold'
import type { AgentView, UsesAxis, UsesCell, UsesColKind, UsesRowKind, UsesView as UsesData } from '../lib/types'

// the same light backup poll as the Map's lanes (MAP_POLL_MS)
const USES_POLL_MS = 20_000
const COLS_SHOWN = 30
const ROWS_SHOWN = 40

// the column kinds whose `sub` is part of the name (which key a model runs
// through, which login an account is) — drawn beside the heading; a file's
// folder or nothing else stays in the hover title
const SUB_BESIDE: ReadonlySet<UsesColKind> = new Set(['model', 'provider'])

const MEASURE_NOTE: Record<NonNullable<UsesData['measure']>, string> = {
  tokens: 'tokens = input + output',
  changes: 'changes = edits + writes',
  calls: 'calls summed',
}

function Pills<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly { id: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-x-0.5 gap-y-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors duration-150 sm:px-2.5 ${
            value === o.id ? 'bg-terracotta-soft text-terracotta' : 'text-ink-2 hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`inline-flex items-center gap-1.5 font-mono text-[11px] transition-colors duration-150 ${on ? 'text-ink' : 'text-ink-2 hover:text-ink'}`}
    >
      <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-[3px] border ${on ? 'border-terracotta bg-terracotta' : 'border-ink-3'}`} />
      {children}
    </button>
  )
}

function agentLabel(agents: readonly AgentView[], id: string, fallback: string): string {
  if (id === MASTER_ID) return ANYWHERE_LABEL
  const a = agents.find((x) => x.id === id)
  return a ? `${a.emoji} ${a.name}` : fallback
}

export function UsesView({ embedded = false, folder }: { embedded?: boolean; folder?: string }) {
  const connection = useStore((s) => s.connection)
  const agents = useStore((s) => s.agents)
  const prefs = useStore((s) => s.usesPrefs)
  const setPrefs = useStore((s) => s.setUsesPrefs)
  const selectAgent = useStore((s) => s.selectAgent)
  const openSession = useStore((s) => s.openSession)
  const rows: UsesRowKind = prefs.rows ?? DEFAULT_ROWS
  const cols: UsesColKind = prefs.cols ?? DEFAULT_COLS
  const since = prefs.since ?? DEFAULT_SINCE
  // gestures, not settings: they reset with the page
  const [shared, setShared] = useState(false)
  const [runs, setRuns] = useState(true)
  const [data, setData] = useState<UsesData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<{ r: string; c: string } | null>(null)
  // where a column's thing comes from (its origin) — a gesture, reset with the columns
  const [origin, setOrigin] = useState<string>('')
  useEffect(() => {
    setOrigin('')
  }, [cols])

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      api
        .uses({ rows, cols, since, runs, min: shared ? 2 : 1, ...(folder !== undefined ? { folder } : {}) })
        .then((v) => {
          if (!cancelled) {
            setData(v)
            setError(null)
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        })
    }
    load()
    const interval = setInterval(load, USES_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [rows, cols, since, runs, shared, folder, connection])

  // a new question is a new matrix: the open cell belonged to the old one
  useEffect(() => {
    setSel(null)
  }, [rows, cols, since, runs, shared, folder])

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') setSel(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const set = (p: Partial<{ rows: UsesRowKind; cols: UsesColKind; since: string }>): void => setPrefs({ rows, cols, since, ...p })

  // the origins present, with how many columns each — the filter's options
  const origins = useMemo(() => {
    const n = new Map<string, number>()
    for (const c of data?.cols ?? []) if (c.origin) n.set(c.origin, (n.get(c.origin) ?? 0) + 1)
    return [...n.entries()].sort((a, b) => b[1] - a[1])
  }, [data])
  const shownCols = useMemo(() => (origin === '' ? (data?.cols ?? []) : (data?.cols ?? []).filter((c) => c.origin === origin)), [data, origin])
  const colFold = useFold(shownCols, COLS_SHOWN)
  const rowFold = useFold(data?.rows ?? [], ROWS_SHOWN)
  const byKey = useMemo(() => new Map((data?.cells ?? []).map((c) => [`${c.r}␟${c.c}`, c])), [data])
  const max = useMemo(() => (data?.cells ?? []).reduce((m, c) => Math.max(m, c.n), 0), [data])
  const headings = useMemo(() => columnHeadings(colFold.shown, cols), [colFold.shown, cols])

  const rowKind = ROW_KINDS.find((k) => k.id === rows)!
  const colKind = COL_KINDS.find((k) => k.id === cols)!
  const windowWords = WINDOWS.find((w) => w.id === since)?.words ?? ''
  const rowLabel = (r: UsesAxis): string => (rows === 'agent' ? agentLabel(agents, r.id, r.label) : r.label)
  const rowSub = (r: UsesAxis): string | undefined =>
    rows === 'conversation' && r.sub !== undefined ? agentLabel(agents, data?.sessions.find((s) => s.key === r.id)?.agentId ?? '', r.sub) : r.sub

  const selCell = sel ? (byKey.get(`${sel.r}␟${sel.c}`) ?? null) : null
  const selRow = sel ? (data?.rows.find((r) => r.id === sel.r) ?? null) : null
  const selCol = sel ? (data?.cols.find((c) => c.id === sel.c) ?? null) : null

  function openConversation(key: string, agentId: string): void {
    const slash = key.indexOf('/')
    if (slash <= 0) return
    selectAgent(agentId)
    void openSession(key.slice(0, slash), key.slice(slash + 1))
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-page="uses">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* the question, as controls: rows × columns, the window, two filters */}
        <div className={`flex shrink-0 flex-col gap-2 px-4 ${embedded ? 'pt-1 pb-2' : 'pt-3 pb-2'}`}>
          <div className="grid grid-cols-[3.75rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1">
            <span aria-hidden="true" className="pt-1 font-mono text-[10.5px] text-ink-3">
              rows
            </span>
            <Pills label="Rows" options={ROW_KINDS} value={rows} onChange={(v) => set({ rows: v })} />
            <span aria-hidden="true" className="pt-1 font-mono text-[10.5px] text-ink-3">
              columns
            </span>
            <Pills label="Columns" options={COL_KINDS} value={cols} onChange={(v) => set({ cols: v })} />
            <span aria-hidden="true" className="pt-1 font-mono text-[10.5px] text-ink-3">
              window
            </span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <Pills label="Window" options={WINDOWS} value={since} onChange={(v) => set({ since: v })} />
              <Toggle on={shared} onChange={setShared}>{`shared by 2+ ${rowKind.noun[1]}`}</Toggle>
              <Toggle on={runs} onChange={setRuns}>
                automation runs
              </Toggle>
            </div>
            {origins.length > 1 ? (
              <>
                <span aria-hidden="true" className="pt-1 font-mono text-[10.5px] text-ink-3">
                  from
                </span>
                <Pills
                  label="Origin"
                  options={[{ id: '', label: `all ${data?.cols.length ?? 0}` }, ...origins.map(([o, n]) => ({ id: o, label: `${o} ${n}` }))]}
                  value={origin}
                  onChange={setOrigin}
                />
              </>
            ) : null}
          </div>
          {data ? (
            <p data-testid="uses-summary" className="mt-1 font-mono text-[11px] text-ink-2">
              {plural(data.considered, ['conversation', 'conversations'])} {windowWords}
              {data.rows.length > 0 ? (
                <>
                  {' '}
                  · {plural(data.rows.length + data.truncated.rows, rowKind.noun)} × {plural(data.cols.length + data.truncated.cols, colKind.noun)}
                </>
              ) : null}
              {data.measure ? (
                <span className="text-ink-3"> · each cell counts conversations; {MEASURE_NOTE[data.measure]}</span>
              ) : (
                <span className="text-ink-3"> · each cell counts conversations</span>
              )}
            </p>
          ) : null}
        </div>

        {error ? <p className="px-4 py-2 text-sm text-ink-2">{error}</p> : null}
        {!data && !error ? <p className="px-4 py-2 text-sm text-ink-2">Loading…</p> : null}
        {data && data.rows.length === 0 ? (
          <div className="px-4 py-6">
            <p className="text-sm text-ink-2">
              {shared ? `No ${colKind.noun[0]} used by two or more ${rowKind.noun[1]} ${windowWords}.` : `No ${colKind.noun[1]} used ${windowWords}.`}
            </p>
            {since !== 'all' ? (
              <button type="button" onClick={() => set({ since: 'all' })} className="mt-1 font-mono text-[11px] text-ink-2 hover:text-terracotta">
                look at all time ›
              </button>
            ) : null}
          </div>
        ) : null}

        {data && data.rows.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-6" data-testid="uses-matrix">
            <table className="border-separate border-spacing-0">
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 top-0 z-20 bg-canvas align-bottom">
                    <span className="block pb-1.5 pr-3 text-left font-mono text-[10.5px] font-normal text-ink-3">
                      {rowKind.noun[1]} × {colKind.noun[1]}
                    </span>
                  </th>
                  {colFold.shown.map((c) => (
                    <th
                      key={c.id}
                      scope="col"
                      className="sticky top-0 z-10 bg-canvas px-0 align-bottom font-normal"
                      title={c.origin ? `${columnTitle(c, cols)} — from ${c.origin}` : columnTitle(c, cols)}
                    >
                      <div className="flex w-10 flex-col items-center gap-1 pb-1.5">
                        {/* one vertical block, read bottom-up: the name, and —
                            for models and accounts — what it runs through
                            beside it (a key's gateway, "Claude · this machine") */}
                        <span className="flex flex-col gap-[3px]" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                          <span
                            className={`block max-h-40 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] leading-none ${sel?.c === c.id ? 'text-terracotta' : 'text-ink'}`}
                          >
                            {headings.get(c.id) ?? c.label}
                          </span>
                          {SUB_BESIDE.has(cols) && c.sub ? (
                            <span className="block max-h-40 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[9.5px] leading-none text-ink-3">
                              {c.sub}
                            </span>
                          ) : null}
                        </span>
                        <span className="font-mono text-[10px] leading-none text-ink-3">{c.n}</span>
                      </div>
                    </th>
                  ))}
                  {colFold.hidden > 0 || colFold.open ? (
                    <th scope="col" className="sticky top-0 z-10 bg-canvas pl-2 align-bottom font-normal">
                      <MoreFold
                        hidden={colFold.hidden}
                        open={colFold.open}
                        onToggle={colFold.toggle}
                        noun={`more ${colKind.noun[1]}`}
                        className="whitespace-nowrap pb-1.5"
                      />
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rowFold.shown.map((r) => (
                  <tr key={r.id} className="group/row">
                    <th scope="row" className="sticky left-0 z-10 border-t border-line bg-canvas py-1 pr-3 text-left align-middle font-normal">
                      <div className="flex w-36 items-baseline gap-2 sm:w-56">
                        <div className="min-w-0 flex-1">
                          <p className={`truncate text-[12.5px] leading-snug ${sel?.r === r.id ? 'text-terracotta' : 'text-ink'}`} title={r.label}>
                            {rowLabel(r)}
                          </p>
                          {rowSub(r) ? (
                            <p className="truncate font-mono text-[10px] leading-snug text-ink-3" title={r.sub}>
                              {rowSub(r)}
                            </p>
                          ) : null}
                        </div>
                        <span className="shrink-0 font-mono text-[10px] text-ink-3" title={plural(r.n, ['conversation', 'conversations'])}>
                          {r.n}
                        </span>
                      </div>
                    </th>
                    {colFold.shown.map((c) => {
                      const cell = byKey.get(`${r.id}␟${c.id}`)
                      return (
                        <CellButton
                          key={c.id}
                          cell={cell}
                          max={max}
                          measure={data.measure}
                          selected={sel?.r === r.id && sel?.c === c.id}
                          label={`${rowLabel(r)} × ${headings.get(c.id) ?? c.label}`}
                          onSelect={() => setSel(cell ? { r: r.id, c: c.id } : null)}
                        />
                      )
                    })}
                    {colFold.hidden > 0 || colFold.open ? <td className="border-t border-line" /> : null}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="sticky left-0 mt-2 flex flex-col gap-1">
              <MoreFold hidden={rowFold.hidden} open={rowFold.open} onToggle={rowFold.toggle} noun={`more ${rowKind.noun[1]}`} className="self-start" />
              {data.truncated.rows + data.truncated.cols > 0 ? (
                <p className="font-mono text-[10.5px] text-ink-3">
                  The {data.truncated.rows > 0 ? `${data.truncated.rows} quietest ${rowKind.noun[1]}` : ''}
                  {data.truncated.rows > 0 && data.truncated.cols > 0 ? ' and ' : ''}
                  {data.truncated.cols > 0 ? `${data.truncated.cols} least-used ${colKind.noun[1]}` : ''} are left out of this matrix.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {selCell && selRow && selCol && data ? (
        <CellPanel
          data={data}
          cell={selCell}
          rowTitle={rowLabel(selRow)}
          colTitle={selCol.label}
          colSub={selCol.sub}
          agents={agents}
          onOpen={openConversation}
          onClose={() => setSel(null)}
        />
      ) : null}
    </div>
  )
}

function CellButton({
  cell,
  max,
  measure,
  selected,
  label,
  onSelect,
}: {
  cell: UsesCell | undefined
  max: number
  measure: UsesData['measure']
  selected: boolean
  label: string
  onSelect: () => void
}) {
  if (!cell) {
    return (
      <td className="border-t border-line p-0">
        <span aria-hidden="true" className="flex h-8 w-10 items-center justify-center text-[10px] text-ink-3/50">
          ·
        </span>
      </td>
    )
  }
  const a = intensity(cell.n, max)
  const total = measureWords(measure, cell.m)
  return (
    <td className="border-t border-line p-0.5">
      <button
        type="button"
        aria-label={`${label}: ${plural(cell.n, ['conversation', 'conversations'])}`}
        aria-pressed={selected}
        title={`${plural(cell.n, ['conversation', 'conversations'])}${total ? ` · ${total}` : ''}`}
        onClick={onSelect}
        className={`flex h-7 w-9 items-center justify-center rounded-[5px] font-mono text-[11px] tabular-nums text-ink transition-shadow duration-150 hover:ring-1 hover:ring-terracotta/60 ${selected ? 'ring-2 ring-terracotta' : ''}`}
        style={{ background: `color-mix(in srgb, var(--terracotta) ${Math.round(a * 100)}%, transparent)` }}
      >
        {compact(cell.n)}
      </button>
    </td>
  )
}

// the conversations behind one cell — a right-hand column on desktop, a
// bottom sheet under `lg` (one element, repositioned by CSS)
function CellPanel({
  data,
  cell,
  rowTitle,
  colTitle,
  colSub,
  agents,
  onOpen,
  onClose,
}: {
  data: UsesData
  cell: UsesCell
  rowTitle: string
  colTitle: string
  colSub: string | undefined
  agents: readonly AgentView[]
  onOpen: (key: string, agentId: string) => void
  onClose: () => void
}) {
  const total = measureWords(data.measure, cell.m)
  return (
    <aside
      role="complementary"
      aria-label="conversations in this cell"
      className="fixed inset-x-0 bottom-0 z-20 flex max-h-[60vh] w-full shrink-0 flex-col border-t border-line bg-canvas shadow-[0_-8px_24px_var(--shadow-soft)] lg:static lg:z-auto lg:max-h-none lg:w-[320px] lg:border-l lg:border-t-0 lg:shadow-none"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-line px-3 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] text-ink-2">{rowTitle}</p>
          <p className="break-words font-display text-base leading-snug text-ink">{colTitle}</p>
          {colSub ? <p className="break-all font-mono text-[10.5px] text-ink-3">{colSub}</p> : null}
          <p className="mt-1 font-mono text-[11px] text-ink-2">
            {plural(cell.n, ['conversation', 'conversations'])}
            {total ? ` · ${total}` : ''}
          </p>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="shrink-0 rounded-full p-1 text-ink-2 hover:bg-panel hover:text-ink">
          <X size={14} />
        </button>
      </header>
      <ul role="list" className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {cell.refs.map((ref) => {
          const s = data.sessions[ref.s]
          if (!s) return null
          const what = measureWords(data.measure, ref.m, ref.r)
          return (
            <li key={s.key}>
              <button type="button" onClick={() => onOpen(s.key, s.agentId)} className="group/c w-full rounded-md px-2 py-1.5 text-left hover:bg-panel">
                <p className="truncate text-[13px] text-ink group-hover/c:text-terracotta">{s.title || 'Untitled'}</p>
                <p className="truncate font-mono text-[10.5px] text-ink-2">
                  {agentLabel(agents, s.agentId, s.agentId)} · {relTime(s.mtime, data.now)}
                  {what ? ` · ${what}` : ''}
                  {s.run ? ' · run' : ''}
                </p>
              </button>
            </li>
          )
        })}
      </ul>
      {cell.n > cell.refs.length ? (
        <p className="shrink-0 border-t border-line px-3 py-2 font-mono text-[10.5px] text-ink-3">
          The {cell.refs.length} most recent of {cell.n}.
        </p>
      ) : null}
    </aside>
  )
}
