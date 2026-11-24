// OrgTree.tsx — the `tree` archetype (Silo Standard relations), sculpted once:
// an agent → agent relation drawn as an org chart. Roots are the agents that
// report to nobody; each node is its seal, name and role, and one live line
// (its open tasks · how many are stalled). Hairline elbows carry the
// structure — they ARE the relation, nothing decorative.
//
// Two placements, one component (docs/product.md: each thing once):
//   the silo's page   editable — «Reports to Builder · Change» per node, the ONE
//                     editor of the relation (PUT …/relations/:name)
//   Map › Org         read-only, with the door to the silo's page
// Nothing here knows a relation by name; the descriptor says which.
//
// Live: the sidebar's blinking dot beside an agent that is
// working now — the same census, the one accent, nothing when it is not.
import { useMemo, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { agentWorking } from '../../lib/live'
import { useTasks } from '../../hooks/useTasks'
import { useAgentPositions } from '../../hooks/useAgentMoves'
import { MovesGlyphs, ON_ITS_OWN_WORDS, PROACTIVE_WORDS } from '../MovesGlyphs'
import { flatten, liveCounts, liveEdges, orgAgents, orgForest, reportCandidates, type OrgNode } from '../../lib/org'
import { basename } from '../../lib/routes'
import { territoriesOf } from '../../lib/territory'
import type { AgentView, SiloRelationEdge } from '../../lib/types'
import { missionLine } from '../../lib/mission'

// whether the agent is On its own: ⟳ — or Proactive:
// its radar; the card says it in words, the chip in
// its glyph
function OrgMoves({ id, compact = false }: { id: string; compact?: boolean }) {
  const position = useAgentPositions().get(id)
  const period = useStore((s) => s.agents.find((a) => a.id === id)?.heartbeat?.period ?? null)
  if (!position) return null
  return (
    <span data-testid="org-moves" className="inline-flex items-center gap-1 text-[12px] text-ink-3">
      <MovesGlyphs position={position} period={period} size={11} testId="org-moves-glyphs" />
      {compact ? null : <span>{position === 'proactive' ? PROACTIVE_WORDS : ON_ITS_OWN_WORDS}</span>}
    </span>
  )
}

function WorkingDot({ agent, now }: { agent: AgentView | undefined; now: number }) {
  if (!agent || !agentWorking(agent, now)) return null
  return (
    <span
      role="img"
      aria-label={`${agent.name} is working now`}
      title="Working now"
      data-testid="org-working"
      className="dot-blink h-1.5 w-1.5 shrink-0 self-center rounded-full bg-terracotta"
    />
  )
}

export function OrgTree({
  silo,
  relation,
  edges,
  folder,
  editable = false,
  onChanged,
}: {
  silo: string
  relation: string
  edges: readonly SiloRelationEdge[]
  // one org per project: only this folder's agents, and «Change»
  // offers only them
  folder?: string
  editable?: boolean
  onChanged?: (edges: SiloRelationEdge[]) => void
}) {
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const now = useStore((s) => s.nowTick)
  const tasks = useTasks()
  const placed = useMemo(() => orgAgents(agents).filter((a) => folder === undefined || territoriesOf(a).includes(folder)), [agents, folder])
  const ids = useMemo(() => placed.map((a) => a.id), [placed])
  const live = useMemo(() => liveEdges(edges, new Set(ids)), [edges, ids])
  // teams first (a root with someone under it, drawn as a tree), then the
  // agents on their own — one compact cluster, never a column of lone rows
  const forest = useMemo(() => orgForest(ids, live), [ids, live])
  const rows = useMemo(() => flatten(forest.filter((r) => r.children.length > 0)), [forest])
  const loners = useMemo(() => forest.filter((r) => r.children.length === 0).map((r) => r.id), [forest])
  const byId = (id: string): AgentView | undefined => agents.find((a) => a.id === id)
  const nameOf = (id: string): string => byId(id)?.name ?? id
  // an edge whose far end was archived or deleted since: kept, said, clearable
  const dead = new Map(edges.filter((e) => e.note).map((e) => [e.from, e]))
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ agent: string; text: string } | null>(null)

  async function set(from: string, to: string | null): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await api.silos.setRelation(silo, relation, from, to)
      onChanged?.(r.edges)
      setEditing(null)
    } catch (e) {
      setError({ agent: from, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (placed.length === 0) return <p className="mt-4 text-[13px] text-ink-2">No agents yet — the chart draws itself as you add them.</p>
  const roots = rows.filter((n) => n.depth === 0).length
  const laterSibling = (i: number): boolean => {
    const d = rows[i]!.depth
    const after = rows.slice(i + 1).find((r) => r.depth <= d)
    return after !== undefined && after.depth === d && d > 0
  }
  // a counter is a door: the tasks it counted, the way back on the view's head
  const openTasks = (agent: string, view: 'open' | 'untouched'): void =>
    changePage({ kind: 'tasks', view, agent: [agent], from: editable ? { kind: 'silo', id: silo } : { kind: 'org' } })
  const counted = (id: string): { open: number; stalled: number } | null => (tasks.state === 'ready' ? liveCounts(tasks.tasks, id) : null)
  const lonerEditing = editing !== null && loners.includes(editing) ? editing : null
  const teamSize = (n: OrgNode): number => n.children.reduce((sum, c) => sum + 1 + teamSize(c), 0)

  return (
    <div data-testid="org-tree">
      {Object.keys(live).length === 0 ? (
        <p className="mb-3 max-w-[62ch] text-[13px] text-ink-2">
          {editable
            ? 'Nobody reports to anybody yet — every agent stands on its own. Pick who each one reports to.'
            : 'Nobody reports to anybody yet — every agent stands on its own.'}
        </p>
      ) : null}
      <ol className="flex flex-col">
        {rows.map((n, i) => {
          const a = byId(n.id)
          const up = live[n.id]
          const counts = counted(n.id)
          // a later sibling (the next row back at this depth, before the
          // parent's level) keeps the parent's trunk running past this row
          const sibling = laterSibling(i)
          // the trunks of this row's ancestors that run on past it
          const trunks: number[] = []
          for (let level = 1; level < n.depth; level++) {
            let j = i - 1
            while (j >= 0 && rows[j]!.depth !== level) j--
            if (j >= 0 && laterSibling(j)) trunks.push(level)
          }
          const isRoot = n.depth === 0
          // a new root opens a new team: a little air above it
          const gap = isRoot && i > 0 ? 'mt-4' : ''
          const mate = isRoot ? teamSize(n) : 0
          return (
            <li key={n.id} className={`relative ${gap}`} style={{ paddingLeft: `${n.depth * 28}px` }} data-testid="org-node" data-agent={n.id}>
              {trunks.map((level) => (
                <span
                  key={level}
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-0 top-0 w-px bg-line"
                  style={{ left: `${(level - 1) * 28 + 13}px` }}
                />
              ))}
              {/* the elbow: a hairline down from the parent's seal, then across */}
              {n.depth > 0 ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 h-[22px] w-[14px] rounded-bl-md border-b border-l border-line"
                  style={{ left: `${(n.depth - 1) * 28 + 13}px` }}
                />
              ) : null}
              {/* a sibling below continues the parent's line past this row */}
              {n.depth > 0 && sibling ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-0 top-[22px] w-px bg-line"
                  style={{ left: `${(n.depth - 1) * 28 + 13}px` }}
                />
              ) : null}
              <div className="flex items-start gap-3 py-1.5">
                <span
                  aria-hidden="true"
                  className={`relative z-[1] flex shrink-0 items-center justify-center bg-terracotta-soft leading-none ${isRoot ? 'h-[28px] w-[28px] rounded-lg text-[15px]' : 'h-[26px] w-[26px] rounded-md text-[13px]'}`}
                >
                  {a?.emoji ?? '·'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <button
                      type="button"
                      onClick={() => changePage({ kind: 'agent', id: n.id })}
                      className={`text-left hover:text-terracotta ${isRoot ? 'text-[14.5px] font-semibold text-ink' : 'text-[14px] font-medium text-ink'}`}
                    >
                      {a?.name ?? n.id}
                    </button>
                    <WorkingDot agent={a} now={now} />
                    {missionLine(a) ? <span className="text-[12.5px] text-ink-2">{missionLine(a)}</span> : null}
                    {a?.folder && folder === undefined ? <span className="font-mono text-[11px] text-ink-3">in {basename(a.folder)}</span> : null}
                    {isRoot && mate > 0 ? <span className="text-[12px] text-ink-3">· team of {mate + 1}</span> : null}
                    <OrgMoves id={n.id} />
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-2">
                    {counts === null ? (
                      <span className="text-ink-3">reading tasks…</span>
                    ) : counts.open === 0 ? (
                      <span className="text-ink-3">no open tasks</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => openTasks(n.id, 'open')}
                          data-testid="org-open-tasks"
                          className="underline-offset-2 hover:text-terracotta hover:underline"
                        >
                          {counts.open} open task{counts.open === 1 ? '' : 's'}
                        </button>
                        {counts.stalled > 0 ? (
                          <>
                            {' '}
                            ·{' '}
                            <button
                              type="button"
                              onClick={() => openTasks(n.id, 'untouched')}
                              data-testid="org-untouched-tasks"
                              className="text-[var(--health-amber)] underline-offset-2 hover:underline"
                            >
                              {counts.stalled} untouched
                            </button>
                          </>
                        ) : null}
                      </>
                    )}
                  </p>
                  {editable ? (
                    editing === n.id ? (
                      <ReportsToPicker
                        current={up ?? null}
                        options={reportCandidates(ids, live, n.id).map((id) => ({ id, name: nameOf(id) }))}
                        busy={busy}
                        onPick={(to) => void set(n.id, to)}
                        onCancel={() => {
                          setEditing(null)
                          setError(null)
                        }}
                      />
                    ) : (
                      <p className="mt-0.5 text-[12px] text-ink-2">
                        {dead.has(n.id) ? (
                          <>
                            Reports to an archived agent <span className="text-ink-3">({dead.get(n.id)!.to})</span>
                          </>
                        ) : up ? (
                          <>
                            Reports to <span className="text-ink">{nameOf(up)}</span>
                          </>
                        ) : (
                          <span className="text-ink-3">Reports to nobody</span>
                        )}
                        <span className="text-ink-3"> · </span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(n.id)
                            setError(null)
                          }}
                          className="text-ink-2 underline-offset-2 hover:text-terracotta hover:underline"
                        >
                          Change
                        </button>
                      </p>
                    )
                  ) : null}
                  {error?.agent === n.id ? (
                    <p role="alert" className="mt-1 max-w-[60ch] text-[12px] text-terracotta">
                      {error.text}
                    </p>
                  ) : null}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      {loners.length > 0 ? (
        <section className={rows.length > 0 ? 'mt-6' : ''} data-testid="org-loners">
          {rows.length > 0 ? <p className="mb-2 text-[12px] text-ink-3">On their own — nobody reports to them and they report to nobody</p> : null}
          <ul className="flex flex-wrap gap-1.5">
            {loners.map((id) => {
              const a = byId(id)
              const c = counted(id)
              return (
                <li
                  key={id}
                  data-testid="org-node"
                  data-agent={id}
                  className={`flex items-center gap-1.5 rounded-full border py-[3px] pl-[3px] pr-2.5 ${lonerEditing === id ? 'border-terracotta/50 bg-terracotta-soft/50' : 'border-line hover:border-ink-3'}`}
                >
                  <button
                    type="button"
                    aria-pressed={editable ? lonerEditing === id : undefined}
                    title={editable ? `Choose whom ${a?.name ?? id} reports to` : missionLine(a) || undefined}
                    onClick={() => (editable ? (setEditing(lonerEditing === id ? null : id), setError(null)) : changePage({ kind: 'agent', id }))}
                    className="flex items-center gap-1.5"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] bg-terracotta-soft text-[11px] leading-none"
                    >
                      {a?.emoji ?? '·'}
                    </span>
                    <span className="text-[12.5px] text-ink">{a?.name ?? id}</span>
                    <OrgMoves id={id} compact />
                    {a?.folder && folder === undefined ? <span className="font-mono text-[10.5px] text-ink-3">{basename(a.folder)}</span> : null}
                  </button>
                  <WorkingDot agent={a} now={now} />
                  {c && c.open > 0 ? (
                    <span className="text-[11.5px] text-ink-2">
                      <button
                        type="button"
                        onClick={() => openTasks(id, 'open')}
                        data-testid="org-open-tasks"
                        className="underline-offset-2 hover:text-terracotta hover:underline"
                      >
                        {c.open} open
                      </button>
                      {c.stalled > 0 ? (
                        <>
                          {' '}
                          ·{' '}
                          <button
                            type="button"
                            onClick={() => openTasks(id, 'untouched')}
                            data-testid="org-untouched-tasks"
                            className="text-[var(--health-amber)] underline-offset-2 hover:underline"
                          >
                            {c.stalled} untouched
                          </button>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {lonerEditing ? (
            <div className="mt-2">
              <p className="text-[12px] text-ink-2">
                {nameOf(lonerEditing)} — {missionLine(byId(lonerEditing)) || 'no mission yet'}
              </p>
              <ReportsToPicker
                current={null}
                options={reportCandidates(ids, live, lonerEditing).map((id) => ({ id, name: nameOf(id) }))}
                busy={busy}
                onPick={(to) => void set(lonerEditing, to)}
                onCancel={() => {
                  setEditing(null)
                  setError(null)
                }}
              />
              {error?.agent === lonerEditing ? (
                <p role="alert" className="mt-1 max-w-[60ch] text-[12px] text-terracotta">
                  {error.text}
                </p>
              ) : null}
            </div>
          ) : editable ? (
            <p className="mt-2 text-[12px] text-ink-3">Click one to choose whom it reports to.</p>
          ) : null}
        </section>
      ) : null}
      <p className="mt-5 text-[12px] text-ink-3">
        {roots === 0 ? 'No team yet' : roots === 1 ? 'One team' : `${roots} teams`} · {placed.length} agent{placed.length === 1 ? '' : 's'}
        {!editable ? (
          <>
            {' '}
            ·{' '}
            <button type="button" onClick={() => changePage({ kind: 'silo', id: silo })} className="underline-offset-2 hover:text-terracotta hover:underline">
              change who reports to whom
            </button>
          </>
        ) : null}
      </p>
    </div>
  )
}

// the one editor: a select of who it may report to (never itself, never
// below itself — the server refuses a loop too), «nobody» to make it a root
function ReportsToPicker({
  current,
  options,
  busy,
  onPick,
  onCancel,
}: {
  current: string | null
  options: Array<{ id: string; name: string }>
  busy: boolean
  onPick: (to: string | null) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(current ?? '')
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
      <label className="text-ink-2" htmlFor="reports-to">
        Reports to
      </label>
      <select
        id="reports-to"
        autoFocus
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        className="rounded border border-line bg-panel px-1.5 py-0.5 text-[12.5px] text-ink"
      >
        <option value="">nobody (leads a team)</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy || value === (current ?? '')}
        onClick={() => onPick(value === '' ? null : value)}
        className="rounded-full border border-terracotta/40 bg-canvas px-2.5 py-0.5 font-medium text-terracotta hover:border-terracotta disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" disabled={busy} onClick={onCancel} className="text-ink-2 hover:text-ink">
        Cancel
      </button>
    </div>
  )
}
