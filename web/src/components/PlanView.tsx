// PlanView.tsx — the renderer for team plans (plans/*.plan.json, written by
// the team-plan skill): tasks with owners (agent ids or humans) and
// dependencies. Two densities over the same data: `compact` rides in the
// conversation's context column as a live preview; the full view renders
// inside the file viewer. Marking done goes through the caller (it owns the
// file write) — this component never touches the network.
import { useMemo, type ReactNode } from 'react'
import { useStore } from '../store'
import {
  humanTasks,
  isFinished,
  planProgress,
  readyTasks,
  unblocksOf,
  taskConversation,
  taskConversationLine,
  type PlanStatus,
  type TeamPlan,
  type TeamPlanTask,
} from '../lib/team-plan'
import { layoutPlan, G, LABEL_W, NH, NW, type LayoutLane, type NodeState, type PoolLayout } from '../lib/plan-layout'
import { executionLine, executionsByTask, type ExecutionView } from '../lib/executions'
import { useExecutions } from '../hooks/useExecutions'
import { useTasks } from '../hooks/useTasks'
import { currentConversationOf, dependsLabel, doneWords, isStandingPlan, isYou, planHeading, siblingsOf } from '../lib/tasks'
import { relTime } from '../lib/rel-time'
import { useServerConversations } from '../lib/conversation-refs'
import { OwnerMark, TaskGlyph } from './tasks/TaskBits'

// Row glyphs with real contrast (○ used to read as "done"): done ✓
// green · in progress ● pulsing accent · ready ▸ accent (actionable, the
// same arrow Ready-now uses) · blocked · dimmed. The v-next states (plans
// 0.2.0): in review ◐ (half there, someone else's eye) · cancelled ✕ dimmed.
const STATUS_GLYPH: Record<PlanStatus, string> = { done: '✓', in_progress: '●', in_review: '◐', pending: '▸', blocked: '·', cancelled: '✕' }

// the same six shapes, drawn: a geometric glyph (▸ ◐ ✕) is not in every
// font a browser falls back to (a headless Linux showed tofu boxes) —
// an SVG in currentColor reads the same everywhere, at one width, and the
// character stays in the title for whoever copies the row.
function GlyphShape({ status }: { status: PlanStatus }) {
  switch (status) {
    case 'done':
      return <path d="M3 8.2 6.4 11.4 13 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    case 'in_progress':
      return <circle cx="8" cy="8" r="3.6" fill="currentColor" />
    case 'in_review':
      return (
        <g>
          <circle cx="8" cy="8" r="3.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 4.1a3.9 3.9 0 0 0 0 7.8z" fill="currentColor" />
        </g>
      )
    case 'pending':
      return <path d="M6 4.4 11 8l-5 3.6z" fill="currentColor" />
    case 'blocked':
      return <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    case 'cancelled':
      return <path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  }
}

// `attention`: a blocked task that needs you or is stuck — the accent, and a
// ring around its dot so it reads without colour. `label`: its cause in a
// line, as tooltip and accessible name; a glyph without one is decoration.
export function StatusGlyph({ status, attention = false, label }: { status: PlanStatus; attention?: boolean; label?: string }) {
  const needs = status === 'blocked' && attention
  const cls = needs
    ? 'text-terracotta'
    : status === 'done'
      ? 'text-emerald-600 dark:text-emerald-400'
      : status === 'in_progress'
        ? 'text-terracotta animate-pulse'
        : status === 'in_review'
          ? 'text-terracotta'
          : status === 'blocked' || status === 'cancelled'
            ? 'text-ink-3'
            : 'text-terracotta'
  return (
    <span
      {...(label
        ? { role: 'img', 'aria-label': label, title: label }
        : { 'aria-hidden': true, title: `${STATUS_GLYPH[status]} ${status === 'cancelled' ? 'dropped' : status.replace('_', ' ')}` })}
      data-glyph={status}
      data-attention={needs ? 'true' : undefined}
      className={`inline-flex h-[1.35em] w-4 shrink-0 items-center justify-center transition-colors ${cls}`}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" className="block">
        {needs ? (
          <g>
            <circle cx="8" cy="8" r="2" fill="currentColor" />
            <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </g>
        ) : (
          <GlyphShape status={status} />
        )}
      </svg>
    </span>
  )
}

// exported: InChargeOf.tsx's mission zone reuses this exact visual for the
// agent's plan progress (the autonomy view's `planProgress` field) — one
// progress-bar language across the app, not a second implementation.
export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-terracotta transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[10px] tabular-nums text-ink-2">
        {done}/{total}
      </span>
    </div>
  )
}

// ---- dependency map (BPMN swimlanes) --------------------------------------
// The old graph (columns by depth, nodes stacked in FILE order,
// no lanes) was unreadable at 31 tasks in two branches. Now the layout of
// the team-plan skill's render-bpmn.py, ported to
// lib/plan-layout.ts: lanes by owner, columns by depth, barycenter order
// within a column, ◇+ gateways, start/end events, dashed pills for deps in
// another track. This component only draws what the layout returns.

// lane hues for AGENT owners (in lane order); HUMAN lanes are terracotta,
// the same "this is a person" language as OwnerChip. Bands are the hue
// at low opacity so they read in both themes; the label bar is solid.
const LANE_HUES = ['var(--lane-1)', 'var(--lane-2)', 'var(--lane-3)', 'var(--lane-4)', 'var(--lane-5)']

function nodeStrokeOf(state: NodeState): { stroke: string; width: number; dash?: string; opacity?: number } {
  switch (state) {
    case 'done':
      return { stroke: 'var(--health-green)', width: 2 }
    case 'ready':
      return { stroke: 'var(--terracotta)', width: 2.6 }
    case 'active':
      return { stroke: 'var(--terracotta)', width: 1.6, dash: '4 2' }
    case 'blocked':
      return { stroke: 'var(--line)', width: 1.2, opacity: 0.55 }
    case 'dropped':
      return { stroke: 'var(--ink-3)', width: 1, dash: '2 3', opacity: 0.45 }
    default:
      return { stroke: 'var(--line)', width: 1.4 }
  }
}

function Pool({ pool, agentIds, title, nameOf }: { pool: PoolLayout; agentIds: ReadonlySet<string>; title: string | null; nameOf: (owner: string) => string }) {
  const hueOf = (lane: LayoutLane): string => (agentIds.has(lane.owner) ? LANE_HUES[lane.idx % LANE_HUES.length]! : 'var(--terracotta)')
  return (
    <figure className="m-0 mt-2 rounded-lg border border-line bg-panel p-2">
      {title ? <figcaption className="mb-1 px-1 text-[11px] font-medium text-ink-2">{title}</figcaption> : null}
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${pool.width} ${pool.height}`}
          width={pool.width}
          height={pool.height}
          className="block max-w-none text-ink"
          role="img"
          aria-label={`${title ?? 'plan'}: swimlanes by owner, columns by dependency depth`}
        >
          <defs>
            <marker id="plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>
          {pool.lanes.map((lane) => (
            <g key={lane.owner} data-lane={lane.owner}>
              <rect x="0" y={lane.y} width={pool.width} height={lane.h} fill={hueOf(lane)} fillOpacity="0.13" />
              <rect x="0" y={lane.y} width={LABEL_W} height={lane.h} fill={hueOf(lane)} />
              <text
                transform={`translate(${LABEL_W / 2 + 4}, ${lane.y + lane.h / 2}) rotate(-90)`}
                textAnchor="middle"
                fontSize="10.5"
                fontWeight="600"
                letterSpacing="0.06em"
                fill="var(--on-lane)"
                style={{ textTransform: 'uppercase' }}
              >
                {nameOf(lane.owner)}
              </text>
              <line x1="0" y1={lane.y} x2={pool.width} y2={lane.y} stroke="var(--line)" strokeWidth="1" />
            </g>
          ))}
          {pool.flows.map((f, k) => {
            const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.7, markerEnd: f.arrow ? 'url(#plan-arrow)' : undefined }
            if (f.kind === 'line') return <line key={k} x1={f.from.x} y1={f.from.y} x2={f.to.x} y2={f.to.y} {...common} />
            const mx = (f.from.x + f.to.x) / 2
            return <path key={k} d={`M ${f.from.x} ${f.from.y} C ${mx} ${f.from.y}, ${mx} ${f.to.y}, ${f.to.x - 1} ${f.to.y}`} {...common} />
          })}
          <circle cx={pool.start.x} cy={pool.start.y} r="9" fill="var(--panel)" stroke="currentColor" strokeWidth="1.6" />
          {pool.ends.map((e, k) => (
            <circle key={k} cx={e.x} cy={e.y} r="8" fill="var(--panel)" stroke="currentColor" strokeWidth="3.2" />
          ))}
          {pool.gates.map((g, k) => (
            <g key={k}>
              <polygon
                points={`${g.x},${g.y - G} ${g.x + G},${g.y} ${g.x},${g.y + G} ${g.x - G},${g.y}`}
                fill="var(--panel)"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <text x={g.x} y={g.y + 4} textAnchor="middle" fontSize="13" fontWeight="600" fill="currentColor">
                +
              </text>
            </g>
          ))}
          {pool.nodes.map((n) => {
            const st = nodeStrokeOf(n.state)
            const extLabel = n.ext.length > 0 ? `needs ${n.ext.join(', ')}` : null
            const w = extLabel ? Math.max(60, 6.2 * extLabel.length + 12) : 0
            return (
              <g key={n.id} data-node={n.id} data-state={n.state} opacity={st.opacity ?? 1}>
                <rect x={n.x} y={n.y} width={NW} height={NH} rx="6" fill="var(--panel)" stroke={st.stroke} strokeWidth={st.width} strokeDasharray={st.dash} />
                <text x={n.x + 8} y={n.y + 13} fontSize="9.5" fontFamily="ui-monospace, monospace" fill="var(--ink-2)">
                  {n.id}
                </text>
                {n.lines.map((ln, k) => (
                  <text
                    key={k}
                    x={n.x + 8}
                    y={n.y + 27 + k * 12}
                    fontSize="10.5"
                    fill={n.state === 'done' || n.state === 'dropped' ? 'var(--ink-2)' : 'var(--ink)'}
                    textDecoration={n.state === 'dropped' ? 'line-through' : undefined}
                  >
                    {ln}
                  </text>
                ))}
                {n.state === 'done' ? (
                  <text x={n.x + NW - 8} y={n.y + 13} textAnchor="end" fontSize="10" fill="var(--health-green)">
                    ✓
                  </text>
                ) : null}
                {n.state === 'dropped' ? (
                  <text x={n.x + NW - 8} y={n.y + 13} textAnchor="end" fontSize="10" fill="var(--ink-3)">
                    <title>dropped</title>✕
                  </text>
                ) : null}
                {extLabel ? (
                  <g>
                    <rect
                      x={n.x + NW - w - 2}
                      y={n.y - 9}
                      width={w}
                      height="14"
                      rx="7"
                      fill="var(--panel)"
                      stroke="var(--ink-2)"
                      strokeDasharray="3 2"
                      strokeWidth="1"
                    />
                    <text x={n.x + NW - 2 - w / 2} y={n.y + 1.5} textAnchor="middle" fontSize="8.5" fontFamily="ui-monospace, monospace" fill="var(--ink-2)">
                      {extLabel}
                    </text>
                  </g>
                ) : null}
                <title>{`${n.id} · ${nameOf(n.owner)} · ${n.status === 'cancelled' ? 'dropped' : n.status.replace('_', ' ')}`}</title>
              </g>
            )
          })}
        </svg>
      </div>
    </figure>
  )
}

// The legend: ○ read as "done" before — every
// state now has a distinct stroke, spelled out right above the map.
function MapLegend() {
  const sw = (style: string) => <i className={`inline-block h-3 w-5 rounded-[3px] border ${style}`} aria-hidden="true" />
  // the event/gateway/message glyphs are drawn, not typed: ◉ and ┄ are
  // missing from the UI font (they rendered as tofu).
  const icon = (children: ReactNode, w = 14) => (
    <svg width={w} height="14" viewBox={`0 0 ${w} 14`} className="inline-block text-ink" aria-hidden="true">
      {children}
    </svg>
  )
  return (
    <ul role="list" className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-2">
      <li className="flex items-center gap-1.5">{sw('border-[2.5px] border-terracotta')} ready now</li>
      <li className="flex items-center gap-1.5">{sw('border-2 border-emerald-600 dark:border-emerald-400')} done</li>
      <li className="flex items-center gap-1.5">{sw('border border-dashed border-terracotta')} in progress</li>
      <li className="flex items-center gap-1.5">{sw('border border-line opacity-50')} blocked</li>
      <li className="flex items-center gap-1.5">{sw('border border-dotted border-ink-3 opacity-45')} dropped</li>
      <li className="flex items-center gap-1.5">
        {icon(
          <>
            <polygon points="7,1 13,7 7,13 1,7" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <text x="7" y="10.5" textAnchor="middle" fontSize="9" fontWeight="600" fill="currentColor">
              +
            </text>
          </>,
        )}
        parallel gateway
      </li>
      <li className="flex items-center gap-1.5">
        {icon(<circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" />)} start
        <span className="text-ink-3">·</span>
        {icon(<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="2.6" />)} end
      </li>
      <li className="flex items-center gap-1.5">
        {icon(<rect x="1" y="3" width="26" height="8" rx="4" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" />, 28)}
        needs a task from another track
      </li>
    </ul>
  )
}

function PlanMap({ plan, agentIds, nameOf }: { plan: TeamPlan; agentIds: ReadonlySet<string>; nameOf: (owner: string) => string }) {
  const pools = useMemo(() => layoutPlan(plan), [plan])
  return (
    <div>
      <MapLegend />
      {pools.map((pool) => (
        <Pool key={pool.name} pool={pool} agentIds={agentIds} nameOf={nameOf} title={pools.length > 1 ? `Track ${pool.name}` : null} />
      ))}
    </div>
  )
}

export function PlanView({
  plan,
  planPath,
  planKey,
  onMarkDone,
  onOpen,
  onOpenTask,
  onOpenPlan,
  compact = false,
}: {
  plan: TeamPlan
  // the plan's record key in the Plans silo: a task's SDD executions hang
  // from `<planKey>/tasks/<id>` (the Executions silo, task-view phase 5).
  // Absent → the json's status only.
  planKey?: string
  // the plan file's absolute path: finds the conversation a task names
  planPath?: string
  // marks a task done (the caller rewrites the file). Absent → read-only.
  onMarkDone?: (id: string) => void
  // compact only: click-through to the full viewer.
  onOpen?: () => void
  // a row's title opens its task's page (task-view phase 2) — given when the
  // plan is the Plans silo's record (its key names the task). Absent → text.
  onOpenTask?: (id: string) => void
  // full view: the plan's name opens its house (Tasks narrowed to it — B4)
  onOpenPlan?: () => void
  compact?: boolean
}) {
  const agents = useStore((s) => s.agents)
  // the plan's tasks as Tasks reads them (B6): the same glyph, the same names
  // and the CURRENT conversation every other task surface shows. Absent (a
  // plan outside Silos, or not read yet) → the file's own fields.
  const reading = useTasks(planKey !== undefined)
  const views = useMemo(() => (planKey ? siblingsOf(reading.tasks, planKey) : new Map()), [reading.tasks, planKey])
  const nameOf = (owner: string): string => (owner === '' ? 'nobody' : isYou(owner) ? 'you' : (agents.find((a) => a.id === owner)?.name ?? owner))
  const openSession = useStore((s) => s.openSession)
  const agentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents])
  const byId = useMemo(() => new Map(plan.tasks.map((t) => [t.id, t])), [plan])
  const now = useStore((s) => s.nowTick)
  // conversations the capped overview did not carry (lib/tasks reads the
  // browser's list): ask the server once per view before any row says gone
  const goneIds = useMemo(() => {
    const out: string[] = []
    for (const t of plan.tasks) {
      const tv = views.get(t.id)
      if (tv) {
        const c = currentConversationOf(tv, agents, now)
        if (c && !c.session) out.push(c.id)
        continue
      }
      // a plan Silos' task silo does not track (team-plan.ts's line): same class
      if (taskConversationLine(t, planPath, agents, now)?.state === 'gone') {
        const id = taskConversation(t)
        if (id) out.push(id)
      }
    }
    return out
  }, [plan, planPath, views, agents, now])
  const warming = useStore((s) => s.warming)
  const server = useServerConversations(goneIds, warming)
  // a task's SDD execution (the newest hung from it — by the conversation that
  // ran it, or by the document its `source` names): the Executions silo's
  // records, one reading for every plan (phase 5; it was one fetch per task)
  const execReading = useExecutions()
  const executions = useMemo((): Record<string, ExecutionView> => {
    if (!planKey) return {}
    const by = executionsByTask(execReading.executions)
    const out: Record<string, ExecutionView> = {}
    for (const t of plan.tasks) {
      const e = by.get(`${planKey}/tasks/${t.id}`)?.[0]
      if (e) out[t.id] = e
    }
    return out
  }, [execReading.executions, planKey, plan])
  // executing = an OPEN task with an execution: a dropped one is not running
  const executing = plan.tasks.find((t) => !isFinished(t.status) && executions[t.id])

  // progress counts what is still meant to be done: a dropped task leaves
  // the total (4 done + 1 dropped is 4/4, finished)
  const { done, total: progressTotal } = planProgress(plan.tasks.map((t) => t.status))
  // every task dropped: nothing is left to do and nothing was done — said,
  // never a 0/0 bar nor «all tasks done»
  const progressMark =
    progressTotal === 0 && plan.tasks.length > 0 ? (
      <span data-testid="plan-all-dropped" className="font-mono text-[10px] text-ink-3">
        ✕ all dropped
      </span>
    ) : (
      <Progress done={done} total={progressTotal} />
    )
  // how the finished plan reads: «3 done, 1 dropped» — the one word Tasks uses
  const finishedWords = doneWords(plan.tasks.map((t) => ({ state: t.status })))
  // the project's list has no name: by its file it is «Tasks of <project>»
  const heading = planHeading(plan.title, planPath)
  // a finished plan is a third state, not "nothing on you": every task
  // done — the strip says so instead of handing a ball nobody holds.
  const finished = plan.tasks.length > 0 && plan.tasks.every((t) => isFinished(t.status))
  const mine = humanTasks(plan, agentIds).filter((t) => !isFinished(t.status))
  const ready = readyTasks(plan)

  // what a blocked task waits on; a dropped one never resolves, and says so
  const depNote = (t: TeamPlanTask): string | null => {
    if (t.status !== 'blocked') return null
    const unmet = t.dependsOn.filter((d) => byId.get(d)?.status !== 'done')
    if (unmet.length === 0) return null
    const dropped = unmet.filter((d) => byId.get(d)?.status === 'cancelled')
    const open = unmet.filter((d) => !dropped.includes(d))
    const names = (ids: string[]): string => ids.map((d) => byId.get(d)?.title ?? d).join(' · ')
    // the task page's label for its dependencies (lib/tasks dependsLabel) — one word for one fact
    const label = dependsLabel({ state: t.status })
    return [open.length > 0 ? `${label} ${names(open)}` : '', dropped.length > 0 ? `${label} dropped: ${names(dropped)}` : ''].filter(Boolean).join(' — ')
  }

  const row = (t: TeamPlanTask) => {
    const human = !agentIds.has(t.owner)
    const note = depNote(t)
    const unblocks = onMarkDone && !isFinished(t.status) ? unblocksOf(plan, t.id) : []
    // the conversation working on it (the task's `conversation`): working
    // now, its last activity, or gone (text, no link)
    const tv = views.get(t.id)
    const conv = tv
      ? (() => {
          const c = currentConversationOf(tv, agents, now)
          if (!c) return null
          if (!c.session) {
            const ref = server.refs.get(c.id)
            if (ref) return { state: 'resolved' as const, folder: ref.folder, id: ref.sessionId }
            return server.answered ? { state: 'gone' as const } : null
          }
          return {
            state: c.state === 'working' ? ('working' as const) : ('idle' as const),
            folder: c.session.folder,
            id: c.session.id,
            ago: relTime(c.session.mtime, now),
          }
        })()
      : (() => {
          const line = taskConversationLine(t, planPath, agents, now)
          if (line?.state !== 'gone') return line
          const id = taskConversation(t)
          const ref = id ? server.refs.get(id) : undefined
          if (ref) return { state: 'resolved' as const, folder: ref.folder, id: ref.sessionId }
          return server.answered ? line : null
        })()
    return (
      <li key={t.id} className="flex items-start gap-2 py-1">
        {tv ? <TaskGlyph t={tv} plan={views} agents={agents} now={now} /> : <StatusGlyph status={t.status} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {onOpenTask ? (
              <button
                type="button"
                data-testid={`plan-task-${t.id}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenTask(t.id)
                }}
                title="Open this task"
                className={`min-w-0 truncate text-left text-[13px] underline-offset-2 hover:text-terracotta hover:underline ${isFinished(t.status) ? 'text-ink-3 line-through' : 'text-ink'}`}
              >
                {t.title}
              </button>
            ) : (
              <span className={`min-w-0 truncate text-[13px] ${isFinished(t.status) ? 'text-ink-3 line-through' : 'text-ink'}`}>{t.title}</span>
            )}
            <OwnerMark owner={t.owner} agents={agents} />
            {conv?.state === 'gone' ? (
              <span
                data-testid={`plan-conversation-${t.id}`}
                className="shrink-0 text-[11px] text-ink-3"
                title="The task names a conversation Silos no longer has"
              >
                conversation gone
              </span>
            ) : conv ? (
              <button
                type="button"
                data-testid={`plan-conversation-${t.id}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void openSession(conv.folder, conv.id)
                }}
                title="Open the conversation working on this task"
                className="shrink-0 text-[11px] text-ink-2 hover:text-terracotta"
              >
                Conversation
                {conv.state === 'working' ? (
                  <>
                    {' '}
                    · <span className="text-terracotta">working now</span>
                  </>
                ) : conv.state === 'idle' ? (
                  <> · {conv.ago}</>
                ) : null}{' '}
                ›
              </button>
            ) : null}
          </div>
          {note ? <div className="text-[11px] text-ink-3">{note}</div> : null}
          {executions[t.id] ? (
            <div data-testid={`plan-exec-${t.id}`} className="text-[11px] text-ink-2">
              {executionLine(executions[t.id]!, now)}
            </div>
          ) : null}
          {/* compact: a task's notes can be a wall of text (a Finance dossier
              in a real plan pushed the whole column down) — two
              clamped lines in the strip; the full viewer shows it all. */}
          {t.notes ? (
            <div className={`text-[11px] text-ink-2 ${compact ? 'line-clamp-2' : ''}`} title={compact ? t.notes : undefined}>
              {t.notes}
            </div>
          ) : null}
        </div>
        {onMarkDone && !isFinished(t.status) && human ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onMarkDone(t.id)
            }}
            title={unblocks.length > 0 ? `Unblocks: ${unblocks.map((u) => u.title).join(', ')}` : 'Mark done'}
            className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:border-terracotta hover:text-terracotta"
          >
            Done
          </button>
        ) : null}
      </li>
    )
  }

  if (compact) {
    // The live strip: title + progress, then YOUR pending tasks (the ones
    // blocking the plan on you), then how much is ready to run in parallel.
    return (
      <div className="text-sm">
        {/* the header is a button only when the caller gives it its own
            click (legacy); the column's card is clickable as a whole and
            passes no onOpen, so the header is plain text there. */}
        {onOpen ? (
          <button type="button" onClick={onOpen} className="flex w-full items-center justify-between gap-2 text-left hover:text-terracotta">
            <span data-testid="team-plan-title" className="min-w-0 truncate text-[13px] font-medium text-ink">
              {heading}
            </span>
            {progressMark}
          </button>
        ) : (
          <div className="flex w-full items-center justify-between gap-2 text-left">
            <span data-testid="team-plan-title" className={`min-w-0 truncate text-[13px] font-medium ${finished ? 'text-ink-2' : 'text-ink'}`}>
              {heading}
            </span>
            {progressMark}
          </div>
        )}
        {/* the document being executed: its ledger's progress, whatever is
            on you (your tasks usually wait on exactly this one) */}
        {executing ? (
          <p data-testid="plan-exec-compact" className="mt-1 text-[11px] text-ink-2">
            {executions[executing.id]!.state === 'stopped' ? (
              <>
                {nameOf(executing.owner)}: {executionLine(executions[executing.id]!, now)}
              </>
            ) : (
              <>
                <span className="text-terracotta">●</span> {nameOf(executing.owner)} executing: {executionLine(executions[executing.id]!, now)}
              </>
            )}
          </p>
        ) : null}
        {finished ? (
          <p className="mt-1 text-[11px] text-ink-3">
            {done > 0 ? <span className="text-emerald-600 dark:text-emerald-400">✓</span> : <span>✕</span>} {finishedWords}
          </p>
        ) : mine.length > 0 ? (
          <ul role="list" className="mt-1.5">
            {mine.slice(0, 3).map(row)}
          </ul>
        ) : (
          <p className="mt-1.5 text-[11px] text-ink-3">
            {planPath && isStandingPlan(planPath) ? 'Nothing yours to do here.' : 'Nothing yours to do — the agent has the ball.'}
          </p>
        )}
        {!finished && ready.length > 0 ? (
          <p className="mt-1 flex items-center gap-0.5 text-[11px] text-ink-2">
            <StatusGlyph status="pending" /> {ready.length} ready now{ready.length > 1 ? ' — can run in parallel' : ''}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-5">
      <div className="flex items-baseline justify-between gap-3">
        {onOpenPlan ? (
          <h2 className="font-display text-lg font-semibold text-ink">
            <button
              type="button"
              data-testid="plan-view-house"
              onClick={onOpenPlan}
              title={`${heading} — its tasks`}
              className="text-left hover:text-terracotta"
            >
              {heading}
            </button>
          </h2>
        ) : (
          <h2 className="font-display text-lg font-semibold text-ink">{heading}</h2>
        )}
        {progressMark}
      </div>
      {plan.updatedAt ? <p className="mt-0.5 font-mono text-[11px] text-ink-3">updated {plan.updatedAt}</p> : null}

      {plan.tasks.some((t) => t.dependsOn.length > 0) ? (
        <section className="mt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Dependency map</h3>
          <PlanMap plan={plan} agentIds={agentIds} nameOf={nameOf} />
        </section>
      ) : null}

      {mine.length > 0 ? (
        <section className="mt-4 rounded-lg border border-terracotta/50 bg-terracotta-soft/30 px-3 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-terracotta">Yours to do</h3>
          <ul role="list">{mine.map(row)}</ul>
        </section>
      ) : null}

      <section className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">All tasks</h3>
          {/* drawn with the rows' own glyphs — a typed ◐ ▸ ✕ is tofu in some fonts */}
          <ul role="list" className="flex flex-wrap items-center justify-end gap-x-2.5 text-[10.5px] text-ink-3">
            {(['done', 'in_progress', 'in_review', 'pending', 'blocked', 'cancelled'] as const).map((st) => (
              <li key={st} className="flex items-center gap-0.5">
                <StatusGlyph status={st} />
                {st === 'pending' ? 'ready' : st === 'cancelled' ? 'dropped' : st.replace('_', ' ')}
              </li>
            ))}
          </ul>
        </div>
        <ul role="list" className="mt-1">
          {plan.tasks.map(row)}
        </ul>
      </section>

      {ready.length > 0 ? (
        <p className="mt-3 border-t border-line pt-2 text-[12px] text-ink-2">
          <span className="relative top-[2px] inline-flex align-baseline">
            <StatusGlyph status="pending" />
          </span>{' '}
          Ready now{ready.length > 1 ? ' (parallelizable)' : ''}: {ready.map((t) => t.title).join(' · ')}
        </p>
      ) : null}
    </div>
  )
}
