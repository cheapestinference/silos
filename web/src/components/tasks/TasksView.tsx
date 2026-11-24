// TasksView — every plan task in one place (/tasks).
//
// The moment it serves (docs/product.md): «What's happening?» across plans —
// «where does each thing stand?» without opening a conversation — and moment 2's
// plan tasks on the owner (Mine, the default). Reached from the sidebar's
// «Conversations | Tasks» switch and ⌘K «Tasks»; each row opens its task's
// page. No rail icon (the rail diet).
//
// Presets (fixed views, the last one remembered per viewer): Mine · Active ·
// Stalled · Done. Layouts: list (default) · board (columns by state, done and
// cancelled collapsed, 10 cards then «show more») · tree (project → plan →
// parent/children). Project, agent and plan filter through the FacetBar
// engine. A view is an address (/tasks?view=open&agent=finance, lib/routes.ts):
// the URL wins over what is remembered, which fills only what it leaves out —
// so any counter in the house can open exactly the tasks it counted.
// Order: by last activity. Honest states: nothing is said before the plans
// are read; the conversations no task names are counted, never hidden.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronRight, Columns3, List, ListTree } from 'lucide-react'
import { openFileViewer, openPlanDoor } from '../../lib/file-refs'
import { useStore } from '../../store'
import { HeaderButton, PageHeader } from '../PageHeader'
import { HeaderTabs } from '../HeaderTabs'
import { FacetBar, NarrowChip } from '../FacetBar'
import { Progress, StatusGlyph } from '../PlanView'
import { refreshTasks, useClosedPlans, useTasks } from '../../hooks/useTasks'
import { useNewTasks } from '../../hooks/useTaskSeen'
import { useHeldOrder, useListCursor } from '../../hooks/useTaskKeys'
import { act, actError } from '../../lib/task-gesture'
import { releaseHold, tasksHoldId } from '../../lib/held-order'
import { drawnOrder } from '../../lib/task-origin'
import { KeyHelp, KeyHint } from './KeyHelp'
import { applyFilter, computeFacets, type ActiveFilter } from '../../lib/facets'
import { relTime } from '../../lib/rel-time'
import { isFinished } from '../../lib/team-plan'
import {
  BOARD_PAGE,
  TASK_PRESETS,
  activityOf,
  planHouse,
  planDoor,
  planProgress,
  closedPlanFolds,
  doneCountWords,
  type ClosedPlanFold,
  archiveFolds,
  archiveMonthOf,
  boardColumns,
  byActivity,
  conversationsWithoutTask,
  doneWords,
  dueWords,
  filterOfQuery,
  foldByAge,
  inPreset,
  isHumanOwner,
  isLiveTask,
  chainFacts,
  isYou,
  NO_PLAN_FACET,
  ownerSessionIds,
  presetCounts,
  queryOfFilter,
  readBlocked,
  runningBelow,
  siblingsOf,
  stallLine,
  taskFacets,
  taskKeyOf,
  taskPage,
  taskTree,
  waitFacts,
  waitWords,
  withLiveFlow,
  type ChainFacts,
  type TaskLayout,
  type TaskPreset,
  type TaskView,
  type TreeNode,
} from '../../lib/tasks'
import { linkConversation } from '../../lib/task-link'
import { TasksIcon } from '../../lib/icons'
import { readLayout, readLensOff, readPreset, writeLayout, writeLensOff, writePreset } from '../../lib/tasks-prefs'
import { useOrgEdges } from '../../hooks/useOrgEdges'
import { floorPanel, lensGroups, liveEdges, orgAgents, type LensReading } from '../../lib/org'
import type { AgentView, ClosedPlanEntry } from '../../lib/types'
import type { Page } from '../../store'
import { GiveDialog } from './GiveDialog'
import type { TaskDraft } from '../../lib/new-task'
import { LiveMark, NewWord, OriginBack, OwnerMark, StallText, TaskGlyph, useOrigin } from './TaskBits'
import { ExecutionLeaf, ExecutionMeter, SddMark } from './TaskExecutions'
import { useExecutions } from '../../hooks/useExecutions'
import { executionConversation, executionLine, executionsByTask, executionsWithoutTask, type ExecutionView } from '../../lib/executions'
import { basename } from '../../lib/routes'
import { SiloDoor } from '../silo/SiloDoor'

// What the view knows about its rows that a row cannot read from its task.
// `hideYou`: in Mine the tab already says whose they are, so «you» is not
// repeated on every row (panel, not detail); an agent's mark still distinguishes.
// `fresh`: the tasks new to the owner, their titles in semibold.
// `gone`: rows that left the list and keep their gap under the keyboard.
interface RowMarks {
  hideYou: boolean
  fresh: ReadonlySet<string>
  gone: ReadonlySet<string>
}
const RowMarksContext = createContext<RowMarks>({ hideYou: false, fresh: new Set(), gone: new Set() })

function RowOwner({ t, agents, compact }: { t: TaskView; agents: readonly AgentView[]; compact?: boolean }) {
  const { hideYou } = useContext(RowMarksContext)
  if (hideYou && t.owner !== '' && !agents.some((a) => a.id === t.owner)) return null
  return <OwnerMark owner={t.owner} agents={agents} {...(compact ? { compact } : {})} />
}

// what a task says of itself in a row: its reference, its state, what is
// below it, why it is stuck, its date — the second line of every row and card
function TaskFacts({
  t,
  all,
  agents,
  now,
  plan,
}: {
  t: TaskView
  all: readonly TaskView[]
  agents: readonly AgentView[]
  now: number
  plan: ReadonlyMap<string, TaskView>
}) {
  const below = runningBelow(t, all, agents, now)
  const stall = isFinished(t.state) ? null : stallLine(t, plan)
  const due = isFinished(t.state) ? null : dueWords(t.due, now)
  // why it waits, each fact once: a chain that ends in you says so outright
  // in the accent, a declared wait the reading already said is not repeated
  const waits = waitFacts(t, plan, chainFacts(agents, now))
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-2">
      <span className="font-mono text-[11px] text-ink-3" title={t.label !== t.ref ? t.ref : undefined}>
        {t.label}
      </span>
      <span>{t.stateLabel}</span>
      {below > 0 ? <span>{below} running below</span> : null}
      {stall ? <StallText>{stall}</StallText> : null}
      {waits.map((w) => (
        <span key={w.words} data-testid="task-wait" className={w.accent ? 'text-terracotta' : undefined}>
          {w.words}
        </span>
      ))}
      {due ? <span className={due.startsWith('overdue') ? 'text-terracotta' : ''}>{due}</span> : null}
    </div>
  )
}

function TaskRow({
  t,
  all,
  agents,
  now,
  plan,
  onOpen,
  depth = 0,
}: {
  t: TaskView
  all: readonly TaskView[]
  agents: readonly AgentView[]
  now: number
  plan: ReadonlyMap<string, TaskView>
  onOpen: (t: TaskView) => void
  depth?: number
}) {
  const live = isLiveTask(t, agents, now)
  const marks = useContext(RowMarksContext)
  const isNew = marks.fresh.has(t.key)
  return (
    <li
      data-testid="task-row"
      data-task={t.ref}
      data-nav-row={t.key}
      {...(isNew ? { 'data-new': 'true' } : {})}
      {...(marks.gone.has(t.key) ? { 'data-gone': 'true' } : {})}
    >
      <button
        type="button"
        data-nav-open
        onClick={() => onOpen(t)}
        className="group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-panel/70 focus-visible:bg-panel/70 focus-visible:outline-none"
        style={depth > 0 ? { paddingLeft: `${0.625 + depth * 1.25}rem` } : undefined}
      >
        <span className="flex text-[14px]">
          <TaskGlyph t={t} plan={plan} agents={agents} now={now} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={`min-w-0 truncate text-[14px] ${isNew ? 'font-semibold text-ink' : isFinished(t.state) ? 'text-ink-2' : 'text-ink'}`}>
              <NewWord on={isNew} />
              {t.title}
            </span>
            {live ? <LiveMark /> : null}
          </span>
          <TaskFacts t={t} all={all} agents={agents} now={now} plan={plan} />
        </span>
        <span className="mt-0.5 flex shrink-0 flex-col items-end gap-1">
          <RowOwner t={t} agents={agents} />
          <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{((at) => (at > 0 ? relTime(at, now) : ''))(activityOf(t, agents, now))}</span>
        </span>
      </button>
    </li>
  )
}

function TaskCard({
  t,
  all,
  agents,
  now,
  plan,
  onOpen,
}: {
  t: TaskView
  all: readonly TaskView[]
  agents: readonly AgentView[]
  now: number
  plan: ReadonlyMap<string, TaskView>
  onOpen: (t: TaskView) => void
}) {
  const live = isLiveTask(t, agents, now)
  const marks = useContext(RowMarksContext)
  const isNew = marks.fresh.has(t.key)
  return (
    <li
      data-testid="task-card"
      data-task={t.ref}
      data-nav-row={t.key}
      {...(isNew ? { 'data-new': 'true' } : {})}
      {...(marks.gone.has(t.key) ? { 'data-gone': 'true' } : {})}
    >
      <button
        type="button"
        data-nav-open
        onClick={() => onOpen(t)}
        className="block w-full rounded-lg border border-line bg-canvas px-3 py-2 text-left hover:border-ink-3 focus-visible:border-terracotta focus-visible:outline-none"
      >
        <span className="flex items-start gap-1.5">
          <span className="flex text-[13px] leading-snug">
            <TaskGlyph t={t} plan={plan} agents={agents} now={now} />
          </span>
          <span className={`min-w-0 flex-1 text-[13px] leading-snug text-ink ${isNew ? 'font-semibold' : ''}`}>
            <NewWord on={isNew} />
            {t.title}
          </span>
          <RowOwner t={t} agents={agents} compact />
        </span>
        <TaskFacts t={t} all={all} agents={agents} now={now} plan={plan} />
        {live ? (
          <span className="mt-1 flex">
            <LiveMark />
          </span>
        ) : null}
      </button>
    </li>
  )
}

function BoardLayout({
  tasks,
  all,
  agents,
  now,
  plans,
  onOpen,
}: {
  tasks: TaskView[]
  all: readonly TaskView[]
  agents: readonly AgentView[]
  now: number
  plans: (t: TaskView) => ReadonlyMap<string, TaskView>
  onOpen: (t: TaskView) => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [shown, setShown] = useState<Record<string, number>>({})
  const [coveredOpen, setCoveredOpen] = useState(false)
  const facts = chainFacts(agents, now)
  return (
    <div className="-mx-5 overflow-x-auto px-5 pb-2 sm:-mx-8 sm:px-8">
      <div className="flex min-w-max items-start gap-3">
        {boardColumns(tasks, (t) => readBlocked(t, plans(t), facts)).map((col) => {
          // a state that holds nothing here is a quiet header on its side —
          // its place in the order kept, no full column saying «None.»
          // (Yours to do once drew one column and three «None.»)
          if (col.tasks.length === 0) {
            return (
              <section
                key={col.state}
                data-testid={`board-col-${col.state}`}
                data-empty="true"
                aria-label={`${col.label}: none`}
                className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-lg py-2.5 text-ink-3"
              >
                {/* the state's glyph, still — nothing here is moving */}
                <span className="opacity-60 [&>span]:animate-none">
                  <StatusGlyph status={col.state} />
                </span>
                <span className="text-[12px] [writing-mode:vertical-rl]">{col.label}</span>
                <span className="font-mono text-[11px] tabular-nums">0</span>
              </section>
            )
          }
          const expanded = open[col.state] ?? !col.collapsed
          if (!expanded) {
            return (
              <button
                key={col.state}
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [col.state]: true }))}
                data-testid={`board-col-${col.state}`}
                className="flex w-10 flex-col items-center gap-2 rounded-lg border border-dashed border-line py-3 text-ink-2 hover:border-ink-3 hover:text-ink"
                title={`Show ${col.label.toLowerCase()}`}
              >
                <span className="font-mono text-[11px] tabular-nums">{col.tasks.length}</span>
                <span className="text-[12px] [writing-mode:vertical-rl]">{col.label}</span>
              </button>
            )
          }
          const limit = shown[col.state] ?? BOARD_PAGE
          // the Blocked column: what needs you on top, what is covered folded
          const folded = coveredOpen ? 0 : col.covered.length
          const needing = col.tasks.length - col.covered.length
          const cards = col.tasks.slice(0, col.tasks.length - folded)
          return (
            <section key={col.state} data-testid={`board-col-${col.state}`} className="w-[17rem] shrink-0 rounded-xl bg-panel/60 p-2">
              <header className="flex items-baseline justify-between px-1.5 pb-2 pt-1">
                <h3 className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                  <StatusGlyph status={col.state} attention={col.state === 'blocked' && needing > 0} />
                  {col.label}
                </h3>
                <span className="flex items-baseline gap-2">
                  {col.state === 'blocked' && needing > 0 ? (
                    <span data-testid="board-blocked-need" className="text-[11px] text-terracotta">
                      {needing} need you
                    </span>
                  ) : null}
                  <span className="font-mono text-[11px] tabular-nums text-ink-3">{col.tasks.length}</span>
                  {col.collapsed ? (
                    <button type="button" onClick={() => setOpen((o) => ({ ...o, [col.state]: false }))} className="text-[11px] text-ink-3 hover:text-ink">
                      fold
                    </button>
                  ) : null}
                </span>
              </header>
              <ul className="flex flex-col gap-1.5">
                {cards.slice(0, limit).map((t) => (
                  <TaskCard key={t.key} t={t} all={all} agents={agents} now={now} plan={plans(t)} onOpen={onOpen} />
                ))}
              </ul>
              {cards.length > limit ? (
                <button
                  type="button"
                  onClick={() => setShown((s) => ({ ...s, [col.state]: limit + BOARD_PAGE }))}
                  className="mt-2 w-full rounded-md py-1 text-[12px] text-ink-2 hover:bg-canvas hover:text-ink"
                >
                  Show more ({cards.length - limit})
                </button>
              ) : null}
              {col.covered.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={coveredOpen}
                  data-testid="board-covered-fold"
                  onClick={() => setCoveredOpen((o) => !o)}
                  className={`${cards.length > 0 ? 'mt-1.5' : ''} flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-ink-2 hover:bg-canvas hover:text-ink`}
                >
                  <ChevronRight
                    size={12}
                    aria-hidden="true"
                    className={`shrink-0 text-ink-3 transition-transform duration-150 motion-reduce:transition-none ${coveredOpen ? 'rotate-90' : ''}`}
                  />
                  {col.covered.length} waiting on agents
                </button>
              ) : null}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function TreeLayout({
  tasks,
  all,
  agents,
  now,
  plans,
  onOpen,
  onOpenPlan,
  executions,
}: {
  tasks: TaskView[]
  all: readonly TaskView[]
  agents: readonly AgentView[]
  now: number
  plans: (t: TaskView) => ReadonlyMap<string, TaskView>
  onOpen: (t: TaskView) => void
  onOpenPlan: (planKey: string) => void
  executions: ReadonlyMap<string, ExecutionView[]>
}) {
  // a task's SDD executions are leaves under it, before its subtasks
  const rows = (nodes: TreeNode[], depth: number): ReactElement[] =>
    nodes.flatMap((n) => [
      <TaskRow key={n.task.key} t={n.task} all={all} agents={agents} now={now} plan={plans(n.task)} onOpen={onOpen} depth={depth} />,
      ...(executions.get(n.task.key) ?? []).map((e) => <ExecutionLeaf key={e.key} e={e} agents={agents} now={now} depth={depth} />),
      ...rows(n.children, depth + 1),
    ])
  return (
    <div className="flex flex-col gap-8">
      {taskTree(tasks).map((p) => (
        <section key={p.folder ?? '__outside__'} data-testid="tree-project">
          <h3 className="font-display text-[17px] text-ink">{p.name}</h3>
          <div className="mt-2 flex flex-col gap-4">
            {/* the project's list is no plan: its tasks hang from the project,
                no head and no progress */}
            {p.loose.length > 0 ? (
              <ul data-testid="tree-loose" className="-ml-2.5">
                {rows(p.loose, 0)}
              </ul>
            ) : null}
            {p.plans.map((plan) => {
              const planAll = all.filter((t) => t.planKey === plan.planKey)
              return (
                <div key={plan.planKey} data-testid="tree-plan" className="border-l border-line pl-3">
                  <div className="flex items-center justify-between gap-3 py-1">
                    {/* the plan's name opens its house — Tasks narrowed to it */}
                    <button
                      type="button"
                      onClick={() => onOpenPlan(plan.planKey)}
                      title={`${plan.title} — its tasks`}
                      className="min-w-0 truncate text-left text-[13.5px] font-medium text-ink hover:text-terracotta"
                    >
                      {plan.title}
                    </button>
                    <Progress {...planProgress(planAll)} />
                  </div>
                  <ul className="-ml-2.5">{rows(plan.nodes, 0)}</ul>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

// The lens: the tasks grouped by team — each root's subtree, in
// the chart's order, folded to a count line. The kernel's floor first: what is
// stalled, escalated or yours to do is never folded under a team. As a panel:
// the urgent whole, three of yours and how many more, a
// strip over the columns on the Board so the teams stay on the first screen.
// Tasks of a person or of an agent outside the chart: «No team».
const WHY_WORDS = { stalled: 'untouched', escalated: 'escalated', yours: 'yours to do' } as const
function LensBody({
  lens,
  layout,
  all,
  agents,
  now,
  plans,
  onOpen,
  onOpenPlan,
  executions,
  floorOpen,
  onFloorMore,
  onFloorFold,
  moreGoesToMine,
}: {
  lens: LensReading<TaskView>
  layout: TaskLayout
  all: readonly TaskView[]
  agents: readonly AgentView[]
  now: number
  plans: (t: TaskView) => ReadonlyMap<string, TaskView>
  onOpen: (t: TaskView) => void
  onOpenPlan: (planKey: string) => void
  executions: ReadonlyMap<string, ExecutionView[]>
  floorOpen: boolean
  onFloorMore: () => void
  onFloorFold: () => void
  moreGoesToMine: boolean
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const byId = (id: string): AgentView | undefined => agents.find((a) => a.id === id)
  const body = (tasks: TaskView[]): ReactElement =>
    layout === 'board' ? (
      <BoardLayout tasks={tasks} all={all} agents={agents} now={now} plans={plans} onOpen={onOpen} />
    ) : layout === 'tree' ? (
      <TreeLayout tasks={tasks} all={all} agents={agents} now={now} plans={plans} onOpen={onOpen} onOpenPlan={onOpenPlan} executions={executions} />
    ) : (
      <ul className="-mx-2.5">
        {tasks.map((t) => (
          <TaskRow key={t.key} t={t} all={all} agents={agents} now={now} plan={plans(t)} onOpen={onOpen} />
        ))}
      </ul>
    )
  const group = (id: string, seal: string | null, name: string, sub: string | null, tasks: TaskView[]): ReactElement => {
    const expanded = open[id] === true
    const live = tasks.filter((t) => !isFinished(t.state) && isLiveTask(t, agents, now)).length
    return (
      <section key={id} data-testid="lens-group" data-group={id} className="border-t border-line/70 first:border-t-0">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setOpen((o) => ({ ...o, [id]: !expanded }))}
          className="flex w-full items-center gap-2.5 py-2.5 text-left hover:text-terracotta"
        >
          <ChevronRight size={13} aria-hidden="true" className={`shrink-0 text-ink-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          {seal !== null ? (
            <span
              aria-hidden="true"
              className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-terracotta-soft text-[12px] leading-none"
            >
              {seal || '·'}
            </span>
          ) : null}
          <span className="min-w-0 flex-1">
            <span className="text-[13.5px] font-medium text-ink">{name}</span>
            {sub ? <span className="ml-2 text-[12px] text-ink-3">{sub}</span> : null}
          </span>
          <span className="shrink-0 text-[12px] text-ink-2">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
            {live > 0 ? <span className="text-terracotta"> · {live} live</span> : null}
          </span>
        </button>
        {expanded ? <div className="pb-3">{body(tasks)}</div> : null}
      </section>
    )
  }
  const panel = floorPanel(lens.floor, floorOpen)
  const moreWords = `${panel.folded} more yours to do${moreGoesToMine ? ' ›' : ''}`
  return (
    <div data-testid="lens-body">
      {lens.floor.length > 0 ? (
        <section data-testid="lens-floor" className="mb-4 rounded-xl bg-panel/60 px-3 pb-1.5 pt-2.5">
          <h3 className="flex items-baseline justify-between px-0.5 text-[12.5px] font-medium text-ink">
            Before any team
            <span className="text-[11.5px] font-normal text-ink-2">
              {(['escalated', 'stalled', 'yours'] as const)
                .map((w) => [w, lens.floor.filter((f) => f.why === w).length] as const)
                .filter(([, n]) => n > 0)
                .map(([w, n]) => `${n} ${WHY_WORDS[w]}`)
                .join(' · ')}
            </span>
          </h3>
          {layout === 'board' ? (
            <ul
              data-testid="lens-floor-strip"
              className="-mx-1 mt-2 flex items-stretch gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin] [&>li]:w-[17rem] [&>li]:shrink-0 [&>li>button]:flex [&>li>button]:h-full [&>li>button]:flex-col [&>li>button]:justify-start"
            >
              {panel.rows.map((t) => (
                <TaskCard key={t.key} t={t} all={all} agents={agents} now={now} plan={plans(t)} onOpen={onOpen} />
              ))}
            </ul>
          ) : (
            <ul className="-mx-2.5 mt-1">
              {panel.rows.map((t) => (
                <TaskRow key={t.key} t={t} all={all} agents={agents} now={now} plan={plans(t)} onOpen={onOpen} />
              ))}
            </ul>
          )}
          {panel.folded > 0 ? (
            <button
              type="button"
              data-testid="lens-floor-more"
              onClick={onFloorMore}
              className="mb-1 flex items-center gap-1 px-0.5 py-1 text-[12.5px] text-ink-2 hover:text-ink"
            >
              <ChevronRight size={12} aria-hidden="true" className="text-ink-3" />
              {moreWords}
            </button>
          ) : null}
          {panel.foldable && panel.folded === 0 ? (
            <button type="button" data-testid="lens-floor-fold" onClick={onFloorFold} className="mb-1 px-0.5 py-1 text-[12px] text-ink-3 hover:text-ink">
              Show three of yours
            </button>
          ) : null}
        </section>
      ) : null}
      {lens.groups.map((g) => {
        const root = byId(g.root)
        const mates = g.members.length - 1
        return group(
          g.root,
          root?.emoji ?? '',
          mates > 0 ? `${root?.name ?? g.root}'s team` : (root?.name ?? g.root),
          mates > 0
            ? g.members
                .slice(1)
                .map((m) => byId(m)?.name ?? m)
                .join(', ')
            : null,
          g.tasks,
        )
      })}
      {lens.noTeam.length > 0 ? group('__no-team__', null, 'No team', 'people, and agents outside the chart', lens.noTeam) : null}
    </div>
  )
}

// an execution no task holds: its title and document, its line, the
// conversation it opens (or its record, when nobody is known to have run it)
function ExecutionWithout({ e, agents, now }: { e: ExecutionView; agents: readonly AgentView[]; now: number }) {
  const openSession = useStore((s) => s.openSession)
  const changePage = useStore((s) => s.changePage)
  const conv = executionConversation(e, agents, now)
  const agent = agents.find((a) => a.id === (e.agent ?? conv.agentId))
  return (
    <li data-testid="execution-without">
      <button
        type="button"
        onClick={() =>
          conv.session ? void openSession(conv.session.folder, conv.session.id) : changePage({ kind: 'silo', id: 'executions', recordKey: e.key })
        }
        className="group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-panel/70"
      >
        <span className="mt-[3px]">
          <SddMark />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink">{e.title}</span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <ExecutionMeter e={e} />
            <span className="text-[11.5px] text-ink-2" title={e.otherLedgersSay ?? undefined}>
              {executionLine(e, now)}
            </span>
          </span>
        </span>
        <span className="mt-0.5 shrink-0 text-[11.5px] text-ink-3">{agent ? agent.name : e.project ? basename(e.project) : ''}</span>
      </button>
    </li>
  )
}

const EMPTY: Record<TaskPreset, string> = {
  mine: 'Nothing open is yours to do, and none of your conversations is working a task.',
  open: 'No open task in any project.',
  untouched: 'No open task sits untouched: each one has a live conversation, a wake on the way, a person, a wait with an owner or a next check.',
  done: 'No task is finished yet.',
  idle: 'No task is ready and left alone: each one ready has someone on it or a wake on its way.',
  start: 'No task waits for you to start its agent.',
}

// the address-only views (no tab of their own): the words of their chip on Open
const NARROWS: Partial<Record<TaskPreset, string>> = { idle: 'ready, nobody on it', start: 'waits for you to start it' }

const LAYOUT_ICON: Record<TaskLayout, typeof List> = { list: List, board: Columns3, tree: ListTree }
// «Columns», not «Board»: Home's board already owns that word (one vocabulary);
// the id and the ?layout=board address do not change
const LAYOUT_WORDS: Record<TaskLayout, string> = { list: 'List', board: 'Columns', tree: 'Tree' }

// What the head sentence counts of the rows below it, kinds apart: «in N
// plans» covers only the tasks that are in a named plan, the project's list
// is said with its one word («no plan») and is never «a plan».
// `open` is every row counted (the Done view's rows too — its sentence says
// them as done/dropped); inPlans + noPlan === open, always.
export interface HeadCounts {
  open: number
  inPlans: number
  planCount: number
  noPlan: number
  stalled: number
  live: number
}
export function headCounts(shown: readonly TaskView[], isLive: (t: TaskView) => boolean): HeadCounts {
  const inPlan = shown.filter((t) => !t.standingList)
  return {
    open: shown.length,
    inPlans: inPlan.length,
    planCount: new Set(inPlan.map((t) => t.planKey)).size,
    noPlan: shown.filter((t) => t.standingList).length,
    stalled: shown.filter((t) => !isFinished(t.state) && t.flow?.stalled === true).length,
    live: shown.filter((t) => !isFinished(t.state) && isLive(t)).length,
  }
}

// The head of a plan's house: Tasks narrowed to exactly ONE named plan (never
// «No plan», never two) — its name, its progress over ALL its tasks (the
// shared planProgress, whatever the view shows), and the one wait that names
// you, when one does. Null when the view is not one named plan's.
export interface PlanHead {
  planKey: string
  title: string
  done: number
  total: number
  waitsOnYou: string | null
}
export function planHeadOf(planFilter: readonly string[] | undefined, all: readonly TaskView[], facts: ChainFacts): PlanHead | null {
  if (planFilter?.length !== 1) return null
  const planKey = planFilter[0]!
  if (planKey === NO_PLAN_FACET) return null
  const tasks = all.filter((t) => t.planKey === planKey)
  if (tasks.length === 0 || tasks.some((t) => t.standingList)) return null
  const plan = siblingsOf(all, planKey)
  // a declared wait on you, in the words every row says it (waitFacts: a
  // stalled task says its stall, never a wait)
  let waitsOnYou: string | null = null
  for (const t of tasks) {
    const w = t.waitingOn
    if (isFinished(t.state) || !w || !isYou(w.owner)) continue
    const words = waitWords(w, facts)
    if (waitFacts(t, plan, facts).some((f) => f.words === words)) {
      waitsOnYou = words
      break
    }
  }
  return { planKey, title: tasks[0]!.planTitle, ...planProgress(tasks), waitsOnYou }
}

// Done's Plans strip: each finished plan one line — name ✓ its done words ·
// the day it closed —, its door the read-only file (planDoor: closed → file).
// The current month in view, each earlier one behind its own fold.
function ClosedPlansStrip({
  folds,
  openMonths,
  onToggle,
  onOpen,
}: {
  folds: readonly ClosedPlanFold[]
  openMonths: Readonly<Record<string, boolean>>
  onToggle: (key: string, open: boolean) => void
  onOpen: (p: ClosedPlanEntry) => void
}) {
  const line = (p: ClosedPlanEntry) => (
    <li key={p.key}>
      <button
        type="button"
        data-testid="done-closed-plan"
        onClick={() => onOpen(p)}
        title={`${p.title} — open its file (read-only)`}
        className="flex w-full min-w-0 items-baseline gap-1.5 rounded-md px-1.5 py-[3px] text-left text-[13px] text-ink hover:bg-canvas/60"
      >
        <span className="min-w-0 truncate">{p.title}</span>
        <span aria-hidden="true" className="shrink-0 text-[12px] text-ink-3">
          ✓
        </span>
        <span className="shrink-0 text-[12px] text-ink-2">
          {doneCountWords(p.done, p.dropped)}
          {p.open > 0 ? (
            <>
              , <span className="text-[var(--health-amber)]">{p.open} still open</span>
            </>
          ) : null}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3">
          · {new Date(p.mtime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      </button>
    </li>
  )
  return (
    <section aria-label="Finished plans" data-testid="done-plans" className="mt-4 flex gap-3 border-b border-line pb-3">
      <div className="w-12 shrink-0 pt-[4px] text-[11px] text-ink-3">Plans</div>
      <div className="min-w-0 flex-1">
        {folds.map((f) => {
          if (f.label === null) return <ul key={f.month}>{f.plans.map(line)}</ul>
          const k = `plans:${f.month}`
          const open = openMonths[k] === true
          return (
            <div key={f.month}>
              <button
                type="button"
                onClick={() => onToggle(k, !open)}
                aria-expanded={open}
                className="flex items-center gap-1 px-1.5 py-[3px] text-[12px] text-ink-2 hover:text-ink"
              >
                <ChevronRight size={12} aria-hidden="true" className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                {f.label}
                <span className="font-mono text-[10.5px] text-ink-3">{f.plans.length}</span>
              </button>
              {open ? <ul>{f.plans.map(line)}</ul> : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function TasksView() {
  const reading = useTasks()
  const ready = reading.state === 'ready'
  const agents = useStore((s) => s.agents)
  const now = useStore((s) => s.nowTick)
  const changePage = useStore((s) => s.changePage)
  const setSidebarList = useStore((s) => s.setSidebarList)
  const backToMobileList = useStore((s) => s.backToMobileList)
  // the address names the view; what it leaves out is what was last chosen
  const page = useStore((s) => s.page)
  const here = useMemo((): Extract<Page, { kind: 'tasks' }> => (page?.kind === 'tasks' ? page : { kind: 'tasks' }), [page])
  const preset: TaskPreset = here.view ?? readPreset()
  // idle and start are addresses, not tabs: each narrows Open,
  // so Open stays lit and the narrowing is a chip with its ✕
  const narrow = NARROWS[preset]
  const tab: TaskPreset = narrow ? 'open' : preset
  const layout: TaskLayout = here.layout ?? readLayout()
  const filter = useMemo(() => filterOfQuery(here), [here])
  const [olderOpen, setOlderOpen] = useState<Record<string, boolean>>({})
  // another view is the attention boundary: the order held in this one lets go
  const letGo = (): void => releaseHold(holdId)
  const setPreset = (p: TaskPreset): void => {
    letGo()
    writePreset(p)
    changePage({ ...here, view: p })
  }
  const setLayout = (l: TaskLayout): void => {
    letGo()
    writeLayout(l)
    changePage({ ...here, layout: l })
  }
  const setFilter = (f: ActiveFilter): void => {
    letGo()
    changePage({ ...here, ...queryOfFilter(f) })
  }

  // the census's live facts over the kernel's read (lib/tasks.ts withLiveFlow)
  const all = useMemo(() => withLiveFlow(reading.tasks, agents, now), [reading.tasks, agents, now])
  const ctx = useMemo(() => ({ agentIds: new Set(agents.map((a) => a.id)), ownerSessions: ownerSessionIds(agents) }), [agents])
  const counts = useMemo(() => presetCounts(all, ctx), [all, ctx])
  const extractors = useMemo(() => taskFacets(agents), [agents])
  const inThis = useMemo(() => all.filter((t) => inPreset(t, preset, ctx)), [all, preset, ctx])
  const facets = useMemo(() => computeFacets(inThis, extractors, filter), [inThis, extractors, filter])
  const shown = useMemo(() => byActivity(applyFilter(inThis, extractors, filter), agents, now), [inThis, extractors, filter, agents, now])
  // under the keyboard the order holds still (lib/held-order.ts): what it draws is
  // the held keys read from the truth, what closed keeping its gap
  const holdId = tasksHoldId({
    view: preset,
    layout,
    ...(here.agent ? { agent: here.agent } : {}),
    ...(here.project ? { project: here.project } : {}),
    ...(here.plan ? { plan: here.plan } : {}),
  })
  const fresh = useMemo(() => drawnOrder(shown, layout, all, agents, now), [shown, layout, all, agents, now])
  const freshKeys = useMemo(() => fresh.map((t) => t.key), [fresh])
  const held = useHeldOrder(reading.state === 'ready' ? holdId : null, freshKeys, { arrivingAt: holdId })
  const rows = useMemo(() => {
    if (!held.held) return shown
    const byKey = new Map(all.map((t) => [t.key, t]))
    return held.keys.flatMap((k) => byKey.get(k) ?? [])
  }, [held.held, held.keys, shown, all])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh cache per new task list, on purpose
  const plansCache = useMemo(() => new Map<string, ReadonlyMap<string, TaskView>>(), [all])
  const planOf = (t: TaskView): ReadonlyMap<string, TaskView> => {
    let m = plansCache.get(t.planKey)
    if (!m) plansCache.set(t.planKey, (m = siblingsOf(all, t.planKey)))
    return m
  }
  // the lens: on by default while a silo grants it, off in one
  // click, remembered per viewer; it needs the chart's edges read first
  const org = useOrgEdges()
  // a view narrowed to an agent or a plan asked for those tasks, not for teams —
  // and «Yours» is already one person's list, where teams add 19 rows of floor
  // before any team: the lens applies to the shared presets
  const lensSilo = org.source?.lensOn && !here.agent?.length && !here.plan?.length && preset !== 'mine' ? org.source : null
  const [floorOpen, setFloorOpen] = useState(false)
  // the dialog open, with what a door handed it (⌘K «new task: … @agent»
  // leaves a taskDraft in the store: taken once, then cleared); n remounts it
  const [creating, setCreating] = useState<(TaskDraft & { conversation?: { folder: string; id: string }; n: number }) | null>(null)
  const taskDraft = useStore((s) => s.taskDraft)
  useEffect(() => {
    if (!taskDraft) return
    setCreating((c) => ({ ...taskDraft, n: (c?.n ?? 0) + 1 }))
    useStore.setState({ taskDraft: null })
  }, [taskDraft])
  // a task born from a conversation (⌘K «Make this a task»): it lists that
  // conversation, and its page's way back is the conversation
  const born = async (nt: { planKey: string; id: string; started?: boolean; linked?: boolean }): Promise<void> => {
    const conv = creating?.conversation
    setCreating(null)
    // «Give and open …» already opened the agent's console or chat on it
    if (nt.started) return
    if (conv && !nt.linked) {
      try {
        const l = await linkConversation(taskKeyOf(nt.planKey, nt.id), conv.id)
        if (l.warn) useStore.setState({ error: `Linked — but ${l.warn}.` })
      } catch (e) {
        useStore.setState({ error: `The task was created, but this conversation is not linked to it: ${e instanceof Error ? e.message : String(e)}` })
      }
    }
    changePage({ ...taskPage(nt), ...(conv ? { from: { kind: 'conversation' as const, folder: conv.folder, id: conv.id } } : {}) })
  }
  const [lensOffTick, setLensOffTick] = useState(0)
  const lensOff = useMemo(() => (lensSilo ? readLensOff(lensSilo.silo) : true), [lensSilo, lensOffTick]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleLens = (): void => {
    if (lensSilo) {
      writeLensOff(lensSilo.silo, !lensOff)
      setLensOffTick((n) => n + 1)
    }
  }
  const lens = useMemo(() => {
    if (!lensSilo || lensOff || org.edges === null) return null
    const placed = orgAgents(agents).map((a) => a.id)
    return lensGroups(rows, placed, liveEdges(org.edges, new Set(placed)), all, new Set(agents.map((a) => a.id)))
  }, [lensSilo, lensOff, org.edges, agents, rows, all])
  // a row opens its task with this view as the way back and the list to walk
  const open = (t: TaskView): void => {
    const { project, agent, plan, from } = here
    changePage({
      ...taskPage(t),
      from: {
        kind: 'tasks',
        query: { view: preset, layout, ...(agent ? { agent } : {}), ...(project ? { project } : {}), ...(plan ? { plan } : {}), ...(from ? { from } : {}) },
      },
    })
  }
  const origin = useOrigin(here.from)
  const newKeys = useNewTasks(all)
  const rowMarks = useMemo<RowMarks>(() => ({ hideYou: preset === 'mine', fresh: newKeys, gone: held.gone }), [preset, newKeys, held.gone])
  // the keyboard: the rows as drawn, Done on what is the owner's (the page's verb)
  const body = useRef<HTMLDivElement>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const doneRow = (key: string): boolean => {
    const t = all.find((x) => x.key === key)
    if (!t || isFinished(t.state) || !isHumanOwner(t.owner, ctx.agentIds)) return false
    setKeyError(null)
    // the owner's Done (lib/task-gesture.ts act): one write, judged on the state this row painted
    act(key, 'done', { state: t.state })
      .then(() => {
        refreshTasks()
      })
      .catch((e: unknown) => setKeyError(`«${t.title}» is not done: ${actError(e)}`))
    return true
  }
  const keys = useListCursor({ root: body, holdId, order: () => freshKeys, enabled: ready, onDone: doneRow, ...(here.from ? { onBack: origin.go } : {}) })
  // a plan's name opens its house: this view narrowed to it
  const openPlan = (planKey: string): void => {
    letGo()
    changePage({ ...planHouse(planKey), layout })
  }
  // narrowed to ONE plan, this is its house: its file is one explicit door
  // away — a sheet over Tasks, never a fall into Files
  const planFile = here.plan?.length === 1 ? (all.find((t) => t.planKey === here.plan![0])?.file ?? null) : null

  // Done's Plans strip (work-photograph §3.3): the finished plans, the one
  // house of them (the sidebar's «Finished plans ›» lands here). It follows
  // the Project narrowing; narrowed to a plan or an agent it asks for tasks,
  // which a closed listing does not answer — no strip
  const closedAll = useClosedPlans(preset === 'done')
  const closedShown = useMemo(() => {
    if (preset !== 'done' || here.plan?.length || here.agent?.length) return []
    const projects = here.project?.length ? new Set(here.project) : null
    return projects ? closedAll.filter((p) => projects.has(p.folder ?? '')) : closedAll
  }, [closedAll, preset, here.plan, here.agent, here.project])
  const closedFolds = useMemo(() => closedPlanFolds(closedShown, now), [closedShown, now])

  // the line under the title describes the rows below it, filter and all —
  // kinds apart: the project's list is no plan, never counted as one
  const head = headCounts(shown, (t) => isLiveTask(t, agents, now))
  const plansWord = (n: number): string => `${n} ${n === 1 ? 'plan' : 'plans'}`
  // narrowed to ONE named plan, this is its house: a head says its name,
  // how far along it is, and what waits on you
  const planHead = useMemo(() => planHeadOf(here.plan, all, chainFacts(agents, now)), [here.plan, all, agents, now])
  const without = ready ? conversationsWithoutTask(agents, all) : 0
  // the SDD executions: hung from their tasks in the tree; the
  // ones no task holds are counted beside the conversations, never hidden
  const execReading = useExecutions()
  const execByTask = useMemo(() => executionsByTask(execReading.executions), [execReading.executions])
  const execWithout = useMemo(() => (ready && execReading.state === 'ready' ? executionsWithoutTask(execReading.executions) : []), [ready, execReading])
  const [execOpen, setExecOpen] = useState(false)

  // the band's tabs are the presets — the page's views — whenever there are
  // tasks to show in them (and while the plans are still being read, so the
  // band doesn't grow under the owner's eyes when they arrive)
  const hasViews = reading.state === 'loading' || all.length > 0
  const layoutSwitch = (
    <>
      <div role="group" aria-label="Layout" className="flex items-center gap-0.5">
        {(['list', 'board', 'tree'] as const).map((l) => {
          const label = LAYOUT_WORDS[l]
          const Icon = LAYOUT_ICON[l]
          return (
            <button
              key={l}
              type="button"
              aria-pressed={layout === l}
              onClick={() => setLayout(l)}
              title={label}
              data-testid={`layout-${l}`}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] ${layout === l ? 'text-ink' : 'text-ink-3 hover:text-ink'}`}
            >
              <Icon size={14} aria-hidden="true" />
              <span className="max-sm:hidden">{label}</span>
            </button>
          )
        })}
      </div>
      <span className="ml-1.5 flex">
        <KeyHint onOpen={() => keys.setHelp(true)} />
      </span>
    </>
  )

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* the common band (the same band on every
          root page, its options never displaced). Yours to do · Open · Untouched ·
          Done are the page's views, so they are its tabs, left under the
          title; how they are drawn (list · columns · tree) is the row's
          quiet right edge — both fixed, whatever the line above says. That
          line is the facts: what the rows below hold, filter and all. The
          way back to where this view was opened from (Org, a project…) is
          the band's «where you came from». */}
      <PageHeader
        testId="tasks-header"
        aside={here.from ? <OriginBack words={origin.words} onBack={origin.go} testId="tasks-back" /> : null}
        title="Tasks"
        facts={
          <span className="min-w-0 truncate" data-testid="tasks-pulse">
            {reading.state === 'loading' ? (
              'Reading tasks…'
            ) : reading.state === 'absent' ? (
              'No tasks here.'
            ) : all.length === 0 && ready ? (
              'Nothing here yet.'
            ) : preset === 'idle' && shown.length > 0 ? (
              <>
                {shown.length} {shown.length === 1 ? 'task' : 'tasks'} ready, nobody on {shown.length === 1 ? 'it' : 'them'} — wake{' '}
                {shown.length === 1 ? 'its agent' : 'their agents'} from {shown.length === 1 ? 'its' : 'each'} page.
              </>
            ) : shown.length === 0 ? (
              'No task here.'
            ) : (
              // Done holds the dropped too, said apart — dropped is finished, never done
              // «in N plans» covers only what is in plans; the rest is said «in no plan»
              <>
                {preset === 'done' ? doneWords(shown) : `${head.open} open`}
                {head.planCount === 0 ? null : head.noPlan === 0 ? (
                  <> in {plansWord(head.planCount)}</>
                ) : (
                  <>
                    {' '}
                    — {head.inPlans} in {plansWord(head.planCount)}, {head.noPlan} in no plan
                  </>
                )}
                {head.stalled > 0 ? (
                  <>
                    , <StallText>{head.stalled} untouched</StallText>
                  </>
                ) : null}
                {head.live > 0 ? (
                  <>
                    , <span className="text-terracotta">{head.live} live now</span>
                  </>
                ) : null}
                .
              </>
            )}
          </span>
        }
        // always — the first task of a new install is made here
        actions={
          reading.state !== 'absent' ? (
            <>
              {planFile ? (
                <HeaderButton testId="tasks-open-file" onClick={() => openFileViewer(planFile)}>
                  Open file
                </HeaderButton>
              ) : null}
              <HeaderButton primary testId="new-task" label="New task" onClick={() => setCreating((c) => c ?? { title: '', owner: null, n: 0 })}>
                New task
              </HeaderButton>
            </>
          ) : null
        }
        tabs={
          hasViews ? (
            <HeaderTabs
              label="Task views"
              value={tab}
              onChange={setPreset}
              items={TASK_PRESETS.map((p) => ({
                id: p.id,
                label: p.label,
                testId: `preset-${p.id}`,
                signal: ready ? (
                  <span className={p.id === 'untouched' && counts.untouched > 0 ? 'text-[var(--health-amber)]' : undefined}>{counts[p.id]}</span>
                ) : null,
              }))}
              end={layoutSwitch}
            />
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`${layout === 'board' ? 'max-w-none' : 'max-w-[52rem]'} px-4 pb-14 pt-4 sm:px-5`}>
          {reading.state === 'absent' ? (
            <SiloDoor silo="plans" says="Tasks come with the Plans silo" className="text-[13px]" />
          ) : reading.state === 'error' && all.length === 0 ? (
            <p role="alert" className="text-[13px] text-terracotta">
              The plans could not be read: {reading.error}
            </p>
          ) : null}
          {/* the ONE dialog, mounted whatever the list holds — the first task
              of an install is made from here, by the header or by ⌘K */}
          {reading.state !== 'absent' ? (
            <>
              {/* born from a conversation (⌘K «Make this a task»): said before
                  Create, so the link it writes is never a surprise */}
              {creating?.conversation ? (
                <p data-testid="new-task-link-note" className="-mb-1 mt-3 flex max-w-[62ch] items-center gap-1.5 text-[12px] text-ink-2">
                  <TasksIcon size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-3" />
                  <span className="min-w-0 truncate">
                    Once created, the conversation{' '}
                    <span className="text-ink">
                      «
                      {agents.flatMap((a) => a.sessions).find((x) => x.folder === creating.conversation!.folder && x.id === creating.conversation!.id)?.title ??
                        'you came from'}
                      »
                    </span>{' '}
                    is linked to it.
                  </span>
                </p>
              ) : null}
              {creating ? (
                <GiveDialog
                  key={creating.n}
                  all={all}
                  agents={agents}
                  initialTitle={creating.title}
                  initialOwner={creating.owner}
                  initialPlan={here.plan?.length === 1 ? here.plan[0] : null}
                  conversation={creating.conversation ?? null}
                  onClose={() => setCreating(null)}
                  onCreated={(nt) => void born(nt)}
                />
              ) : null}
            </>
          ) : null}
          {reading.state === 'loading' || reading.state === 'absent' || (reading.state === 'error' && all.length === 0) ? null : all.length === 0 ? (
            // the first day: nothing to show yet, and the one way to start
            creating ? null : (
              <p data-testid="tasks-empty" className="mt-1 max-w-[62ch] text-[13.5px] leading-relaxed text-ink-2">
                {/* the word of the new model is Give */}
                Nothing here yet.{' '}
                <button
                  type="button"
                  data-testid="tasks-empty-new"
                  onClick={() => setCreating((c) => c ?? { title: '', owner: null, n: 0 })}
                  className="font-medium text-ink underline decoration-line underline-offset-2 hover:text-terracotta hover:decoration-terracotta/50"
                >
                  Give an agent something to do.
                </button>
              </p>
            )
          ) : (
            <>
              {planHead ? (
                <div data-testid="plan-head" className="mb-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <h2 className="min-w-0 font-display text-[22px] leading-tight text-ink">{planHead.title}</h2>
                    <Progress done={planHead.done} total={planHead.total} />
                  </div>
                  {planHead.waitsOnYou ? (
                    <p data-testid="plan-head-wait" className="mt-1 text-[13px] text-terracotta">
                      {planHead.waitsOnYou}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  {narrow ? <NarrowChip testId="tasks-narrow" label="Open" value={narrow} onClear={() => setPreset('open')} /> : null}
                  <FacetBar facets={facets} filter={filter} onChange={setFilter} />
                </div>
                {lensSilo ? (
                  lensOff ? (
                    <button
                      type="button"
                      onClick={toggleLens}
                      data-testid="lens-chip"
                      aria-pressed={false}
                      className="shrink-0 rounded-full border border-dashed border-line px-2.5 py-0.5 text-[12px] text-ink-2 hover:border-ink-3 hover:text-ink"
                    >
                      Group {lensSilo.label ?? 'by team'}
                    </button>
                  ) : (
                    <span
                      data-testid="lens-chip"
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-terracotta-soft py-0.5 pl-2.5 pr-1 text-[12px] text-terracotta"
                    >
                      Lens: {lensSilo.label ?? 'by team'}
                      <button
                        type="button"
                        onClick={toggleLens}
                        aria-label="Turn the lens off"
                        title="Turn the lens off"
                        className="flex h-[18px] w-[18px] items-center justify-center rounded-full hover:bg-canvas"
                      >
                        ×
                      </button>
                    </span>
                  )
                ) : null}
              </div>
              {reading.state === 'error' ? (
                <p role="alert" className="mt-2 text-[12px] text-terracotta">
                  Showing the last reading — the plans could not be read again: {reading.error}
                </p>
              ) : null}

              <RowMarksContext.Provider value={rowMarks}>
                {keyError ? (
                  <p role="alert" className="mt-2 text-[12px] text-terracotta">
                    {keyError}
                  </p>
                ) : null}
                {closedFolds.length > 0 ? (
                  <ClosedPlansStrip
                    folds={closedFolds}
                    openMonths={olderOpen}
                    onToggle={(k, v) => setOlderOpen((o) => ({ ...o, [k]: v }))}
                    onOpen={(p) => {
                      const d = planDoor({ key: p.key, file: p.file, closed: true })
                      if (d) openPlanDoor(d, changePage)
                    }}
                  />
                ) : null}
                <div ref={body} className="mt-4" data-testid="tasks-body">
                  {shown.length === 0 ? (
                    <p className="max-w-[62ch] text-[13px] text-ink-2">{inThis.length > 0 ? 'Nothing matches this filter.' : EMPTY[preset]}</p>
                  ) : lens ? (
                    <LensBody
                      lens={lens}
                      layout={layout}
                      all={all}
                      agents={agents}
                      now={now}
                      plans={planOf}
                      onOpen={open}
                      onOpenPlan={openPlan}
                      executions={execByTask}
                      floorOpen={floorOpen}
                      onFloorFold={() => setFloorOpen(false)}
                      moreGoesToMine={preset !== 'mine'}
                      onFloorMore={() => {
                        setFloorOpen(true)
                        if (preset !== 'mine') changePage({ ...here, view: 'mine' })
                      }}
                    />
                  ) : layout === 'board' ? (
                    <BoardLayout tasks={rows} all={all} agents={agents} now={now} plans={planOf} onOpen={open} />
                  ) : layout === 'tree' ? (
                    <TreeLayout tasks={rows} all={all} agents={agents} now={now} plans={planOf} onOpen={open} onOpenPlan={openPlan} executions={execByTask} />
                  ) : preset === 'done' ? (
                    <div className="flex flex-col gap-5">
                      {foldByAge(
                        rows.filter((t) => archiveMonthOf(t) === null),
                        agents,
                        now,
                        held.held,
                      ).map((f, i) => {
                        const expanded = i === 0 || olderOpen[f.label]
                        return (
                          <section key={f.label}>
                            <button
                              type="button"
                              onClick={() => setOlderOpen((o) => ({ ...o, [f.label]: !expanded }))}
                              aria-expanded={expanded}
                              disabled={i === 0}
                              className="flex items-center gap-1.5 text-[12.5px] text-ink-2 enabled:hover:text-ink"
                            >
                              {i === 0 ? null : <ChevronRight size={13} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />}
                              {f.label}
                              <span className="font-mono text-[10.5px] text-ink-3">{f.tasks.length}</span>
                            </button>
                            {expanded ? (
                              <ul className="mt-1">
                                {f.tasks.map((t) => (
                                  <TaskRow key={t.key} t={t} all={all} agents={agents} now={now} plan={planOf(t)} onOpen={open} />
                                ))}
                              </ul>
                            ) : null}
                          </section>
                        )
                      })}
                      {/* the project's list's monthly archive: folded by month, its links intact */}
                      {archiveFolds(rows, now).map((f) => {
                        const expanded = olderOpen[f.label] === true
                        return (
                          <section key={f.month} data-testid="done-archive">
                            <button
                              type="button"
                              onClick={() => setOlderOpen((o) => ({ ...o, [f.label]: !expanded }))}
                              aria-expanded={expanded}
                              className="flex items-center gap-1.5 text-[12.5px] text-ink-2 hover:text-ink"
                            >
                              <ChevronRight size={13} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
                              {f.label}
                              {expanded ? null : (
                                <span aria-hidden="true" className="text-ink-3">
                                  ›
                                </span>
                              )}
                              <span className="font-mono text-[10.5px] text-ink-3">{f.tasks.length}</span>
                            </button>
                            {expanded ? (
                              <ul className="mt-1">
                                {f.tasks.map((t) => (
                                  <TaskRow key={t.key} t={t} all={all} agents={agents} now={now} plan={planOf(t)} onOpen={open} />
                                ))}
                              </ul>
                            ) : null}
                          </section>
                        )
                      })}
                    </div>
                  ) : (
                    <ul className="-mx-2.5">
                      {rows.map((t) => (
                        <TaskRow key={t.key} t={t} all={all} agents={agents} now={now} plan={planOf(t)} onOpen={open} />
                      ))}
                    </ul>
                  )}
                </div>
              </RowMarksContext.Provider>
              {reading.state === 'ready' && reading.unreadable > 0 ? (
                <p className="mt-4 text-[12px] text-ink-3">
                  {reading.unreadable} plan {reading.unreadable === 1 ? 'file' : 'files'} could not be read — the Plans silo&apos;s page says why.
                </p>
              ) : null}
            </>
          )}

          {without > 0 ? (
            <p className="mt-10 border-t border-line pt-3 text-[12.5px] text-ink-2" data-testid="tasks-without">
              {without} {without === 1 ? 'conversation' : 'conversations'} without a task.{' '}
              <button
                type="button"
                onClick={() => {
                  setSidebarList('conversations')
                  backToMobileList()
                }}
                className="text-ink underline-offset-2 hover:text-terracotta hover:underline"
              >
                Show them in the list
              </button>
            </p>
          ) : null}
          {execWithout.length > 0 ? (
            <div className={`${without > 0 ? 'mt-2' : 'mt-10 border-t border-line pt-3'} text-[12.5px] text-ink-2`} data-testid="tasks-executions-without">
              {execWithout.length} SDD {execWithout.length === 1 ? 'execution' : 'executions'} without a task.{' '}
              <button
                type="button"
                onClick={() => setExecOpen((o) => !o)}
                aria-expanded={execOpen}
                className="text-ink underline-offset-2 hover:text-terracotta hover:underline"
              >
                {execOpen ? 'Hide them' : 'Show them'}
              </button>
              {execOpen ? (
                <ul className="-mx-2.5 mt-2">
                  {execWithout.map((e) => (
                    <ExecutionWithout key={e.key} e={e} agents={agents} now={now} />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {keys.help ? <KeyHelp onClose={() => keys.setHelp(false)} /> : null}
    </div>
  )
}
