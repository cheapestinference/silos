// Settings › Maintenance — the Sessions ledger: every transcript Silos
// knows, grouped by project, built to be READ and PRUNED quickly. A
// maintenance tool, not a surface: no rail entry, no ⌘K, nothing else in
// the product links here. Trashing moves files to ~/.silos/trash (never rm
// — invariant 3); the WS 'removed' event that follows drops each row from
// the store, exactly as the Sidebar's own single delete relies on.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Trash2 } from 'lucide-react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { basename } from '../../lib/routes'
import { closeAndDeleteLabel, trashRefusalOf, type TrashRefusal } from '../../lib/trash-refusal'
import { relTime } from '../../lib/rel-time'
import { countsOf, plural } from '../../lib/counts'
import {
  applySessionFilter,
  formatBytes,
  groupSessionsByProject,
  rangeSelect,
  sessionKey,
  type MaintenanceRow,
  type ProjectGroup,
} from '../../lib/sessions-maintenance'

type Quick = 'all' | 'stale' | 'empty'
const STALE_DAYS = 30
// same 3 s confirm window as AgentPage's session trash
const CONFIRM_TRASH_SESSIONS_MS = 3000

// the one quiet button style Settings uses (SettingsPage.QUIET_BTN) — kept
// verbatim so this tool reads as part of the page it lives in.
const QUIET_BTN =
  'rounded-md border border-line bg-panel px-2.5 py-1 text-xs font-medium text-ink transition-colors duration-150 hover:border-ink-2 disabled:opacity-50'

// `aside`: what else this install keeps out of its lists (the muted
// folders), folded under the totals
export function SessionsMaintenance({ aside }: { aside?: ReactNode } = {}) {
  const agents = useStore((s) => s.agents)
  const nowTick = useStore((s) => s.nowTick)
  const selectAgent = useStore((s) => s.selectAgent)
  const openSession = useStore((s) => s.openSession)

  const [text, setText] = useState('')
  const [quick, setQuick] = useState<Quick>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [checked, setChecked] = useState<Map<string, MaintenanceRow>>(new Map())
  const [confirm, setConfirm] = useState(false)
  const [trashing, setTrashing] = useState(false)
  const anchor = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const groups = useMemo(() => groupSessionsByProject(agents), [agents])
  const totalBytes = useMemo(() => groups.reduce((n, g) => n + g.bytes, 0), [groups])
  const totalCount = useMemo(() => groups.reduce((n, g) => n + g.rows.length, 0), [groups])
  // what EXISTS (the server's uncapped totals, lib/counts.ts) vs what this
  // ledger lists (the overview's capped lists): never one passed off as the other
  const totals = useMemo(
    () =>
      agents.reduce(
        (t, a) => {
          const c = countsOf(a)
          return { conversations: t.conversations + c.conversations, runs: t.runs + c.runs }
        },
        { conversations: 0, runs: 0 },
      ),
    [agents],
  )
  const heaviest = useMemo(() => groups.reduce((n, g) => Math.max(n, g.bytes), 0), [groups])

  const filter = { text, olderThanDays: quick === 'stale' ? STALE_DAYS : undefined, emptyOnly: quick === 'empty' }
  const visible: ProjectGroup[] = useMemo(
    () => groups.map((g) => ({ ...g, rows: applySessionFilter(g.rows, filter, nowTick) })).filter((g) => g.rows.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, text, quick, nowTick],
  )
  const orderedKeys = useMemo(() => visible.flatMap((g) => g.rows.map((r) => sessionKey(r.session))), [visible])

  // rows that vanished (trashed, or filtered out of sight) leave the
  // selection too — the count on the button never claims more than what
  // is on screen.
  useEffect(() => {
    setChecked((prev) => {
      const keep = new Set(orderedKeys)
      let changed = false
      const next = new Map<string, MaintenanceRow>()
      for (const [k, v] of prev) {
        if (keep.has(k)) next.set(k, v)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [orderedKeys])

  const rowByKey = useMemo(() => {
    const m = new Map<string, MaintenanceRow>()
    for (const g of visible) for (const r of g.rows) m.set(sessionKey(r.session), r)
    return m
  }, [visible])

  function setKeys(keys: readonly string[], on: boolean): void {
    setChecked((prev) => {
      const next = new Map(prev)
      for (const k of keys) {
        const row = rowByKey.get(k)
        if (!row) continue
        if (on) next.set(k, row)
        else next.delete(k)
      }
      return next
    })
    setConfirm(false)
  }

  function toggleRow(row: MaintenanceRow, shift: boolean): void {
    const key = sessionKey(row.session)
    const on = !checked.has(key)
    if (shift && anchor.current) setKeys(rangeSelect(orderedKeys, anchor.current, key), on)
    else setKeys([key], on)
    anchor.current = key
  }

  function toggleGroup(g: ProjectGroup): void {
    const keys = g.rows.map((r) => sessionKey(r.session))
    const allOn = keys.every((k) => checked.has(k))
    setKeys(keys, !allOn)
  }

  function toggleCollapsed(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function open(row: MaintenanceRow): void {
    selectAgent(row.agent.id)
    void openSession(row.session.folder, row.session.id)
  }

  const selectedBytes = [...checked.values()].reduce((n, r) => n + r.session.size, 0)

  async function trashSelected(targets = [...checked.entries()], opts: { closeHolders?: boolean } = {}): Promise<void> {
    setTrashing(true)
    // a partial failure must stay VISIBLE: each rejection used to overwrite
    // the same global error slot (N failures → one message) and the whole
    // selection was cleared anyway, so the survivors sat in the list with
    // nothing marking them. Now the failed rows KEEP their selection (the
    // action bar re-offers exactly them) and the error names the scale.
    // Rows a claude outside Silos still holds (the server names where it
    // lives) get one more offer: close those claudes and trash exactly them.
    const failed = new Map<string, MaintenanceRow>()
    const held = new Map<string, MaintenanceRow>()
    let firstError = ''
    let firstRefusal: TrashRefusal | null = null
    try {
      await Promise.all(
        targets.map(([key, r]) =>
          (opts.closeHolders ? api.trash(r.session.folder, r.session.id, opts) : api.trash(r.session.folder, r.session.id)).catch((e) => {
            failed.set(key, r)
            const refusal = trashRefusalOf(e)
            if (refusal?.canClose) {
              held.set(key, r)
              if (!firstRefusal) firstRefusal = refusal
            }
            if (!firstError) firstError = e instanceof Error ? e.message : String(e)
          }),
        ),
      )
    } finally {
      setTrashing(false)
      setChecked(failed)
      setConfirm(false)
      if (failed.size > 0) {
        const message = `${failed.size} of ${targets.length} could not be trashed — ${firstError}`
        const refusal: TrashRefusal | null = firstRefusal
        useStore.setState({
          error: message,
          errorAction:
            refusal && !opts.closeHolders
              ? {
                  forMessage: message,
                  label: `${closeAndDeleteLabel(refusal, 'trash')}${held.size > 1 ? ` (${held.size})` : ''}`,
                  run: () => void trashSelected([...held.entries()], { closeHolders: true }),
                }
              : null,
        })
      }
    }
  }

  function onTrash(): void {
    if (checked.size === 0) return
    if (confirm) {
      if (timer.current) clearTimeout(timer.current)
      setConfirm(false)
      void trashSelected()
      return
    }
    setConfirm(true)
    timer.current = setTimeout(() => setConfirm(false), CONFIRM_TRASH_SESSIONS_MS)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 px-6 pb-3 pt-8 md:px-10">
        <h2 className="font-display text-[19px] leading-tight text-ink">Sessions</h2>
        <p data-testid="sessions-totals" className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">
          Silos knows <span className="font-mono text-[12px] text-ink">{plural(totals.conversations, 'conversation')}</span> ·{' '}
          <span className="font-mono text-[12px] text-ink">{plural(totals.runs, 'automation run')}</span>. By project below, the newest of each agent:{' '}
          <span className="font-mono text-[12px] text-ink">{totalCount.toLocaleString('en-US')}</span> listed ·{' '}
          <span className="font-mono text-[12px] text-ink">{formatBytes(totalBytes)}</span> on disk. Trashed ones move to{' '}
          <span className="font-mono text-[12px]">~/.silos/trash</span>.
        </p>
        {aside}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            aria-label="filter sessions"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Title, skill or agent"
            className="min-w-[14rem] flex-1 rounded-md border border-line bg-canvas px-2.5 py-1 text-xs outline-none focus:border-terracotta"
          />
          <div role="radiogroup" aria-label="quick filter" className="inline-flex items-center gap-0.5 rounded-md bg-panel p-0.5 font-mono text-[11px]">
            {(
              [
                ['all', 'All'],
                ['stale', `Older than ${STALE_DAYS}d`],
                ['empty', 'Empty'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={quick === id}
                onClick={() => setQuick(id)}
                className={`rounded px-2 py-0.5 transition-colors duration-150 ${quick === id ? 'bg-canvas text-ink' : 'text-ink-2 hover:text-ink'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-24 md:px-10">
        {visible.length === 0 ? (
          <p className="py-8 text-sm text-ink-2">{totalCount === 0 ? 'No sessions yet.' : 'Nothing matches — clear the filter to see everything.'}</p>
        ) : (
          visible.map((g) => {
            const id = g.cwd ?? '∅'
            const isCollapsed = collapsed.has(id)
            const keys = g.rows.map((r) => sessionKey(r.session))
            const onCount = keys.filter((k) => checked.has(k)).length
            const allOn = onCount === keys.length
            return (
              <section key={id} className="border-t border-line py-3 first:border-t-0">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`select all in ${g.cwd ? basename(g.cwd) : 'no folder'}`}
                    checked={allOn}
                    ref={(el) => {
                      if (el) el.indeterminate = onCount > 0 && !allOn
                    }}
                    onChange={() => toggleGroup(g)}
                    className="shrink-0 accent-terracotta"
                  />
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(id)}
                    aria-expanded={!isCollapsed}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left hover:bg-canvas/60"
                  >
                    <ChevronRight
                      size={13}
                      aria-hidden="true"
                      className={`shrink-0 text-ink-2 transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{g.cwd ? basename(g.cwd) : 'No folder'}</span>
                      {g.cwd ? <span className="block truncate font-mono text-[10.5px] text-ink-2">{g.cwd}</span> : null}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-2">
                      {g.rows.length} · {formatBytes(g.bytes)} · {relTime(g.lastActivity, nowTick)}
                    </span>
                  </button>
                </div>
                {/* the weight bar: this project's share of the heaviest one —
                    where the disk actually goes, before reading a single title */}
                <div className="ml-6 mt-1 h-px w-full bg-line/60" aria-hidden="true">
                  <div className="h-px bg-terracotta/70" style={{ width: `${heaviest > 0 ? Math.max(2, (g.bytes / heaviest) * 100) : 0}%` }} />
                </div>
                {isCollapsed ? null : (
                  <ul role="list" className="ml-6 mt-1.5 space-y-px">
                    {g.rows.map((row) => {
                      const key = sessionKey(row.session)
                      const on = checked.has(key)
                      return (
                        <li key={key} className={`group flex items-center gap-2 rounded-md px-1 ${on ? 'bg-terracotta-soft/40' : 'hover:bg-canvas/60'}`}>
                          <input
                            type="checkbox"
                            aria-label={`select ${row.session.title}`}
                            checked={on}
                            onClick={(e) => toggleRow(row, e.shiftKey)}
                            onChange={() => {
                              /* handled in onClick to read shiftKey */
                            }}
                            className="shrink-0 accent-terracotta"
                          />
                          <button type="button" onClick={() => open(row)} className="flex min-w-0 flex-1 items-center gap-3 py-1.5 text-left">
                            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{row.session.title}</span>
                            <span className="hidden shrink-0 truncate text-[11px] text-ink-2 sm:inline">
                              {row.agent.emoji} {row.agent.name}
                            </span>
                            {!row.session.native ? (
                              <span className="shrink-0 rounded border border-line px-1 font-mono text-[10px] text-ink-2">terminal</span>
                            ) : null}
                            <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-2">{formatBytes(row.session.size)}</span>
                            <span className="w-16 shrink-0 whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-ink-2">
                              {relTime(row.session.mtime, nowTick)}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )
          })
        )}
      </div>

      {checked.size > 0 ? (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 border-t border-line bg-panel/95 px-6 py-3 backdrop-blur md:px-10">
          <span className="text-xs text-ink-2" aria-live="polite">
            <span className="font-mono text-ink">{checked.size}</span> selected · <span className="font-mono text-ink">{formatBytes(selectedBytes)}</span>
          </span>
          <button
            type="button"
            onClick={onTrash}
            disabled={trashing}
            className={`ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors duration-150 ${
              confirm ? 'bg-terracotta text-on-terracotta' : 'border border-terracotta text-terracotta hover:bg-terracotta-soft'
            }`}
          >
            <Trash2 size={13} aria-hidden="true" />
            {trashing ? 'Trashing…' : confirm ? `Sure? Trash ${checked.size}` : `Trash ${checked.size}`}
          </button>
          <button
            type="button"
            onClick={() => {
              setChecked(new Map())
              setConfirm(false)
            }}
            className={QUIET_BTN}
          >
            Clear
          </button>
        </div>
      ) : null}
    </div>
  )
}
