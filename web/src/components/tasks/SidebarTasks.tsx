// SidebarTasks — the sidebar's list body when its switch says «Tasks».
// The sidebar is navigation (docs/product.md): a way
// to move, never the whole list to read. On top, «All tasks · N open» opens
// exactly the set it counts (Tasks › Open). Then, unfolded, «Now» — the
// tasks a conversation is working and the owner's ready ones, the ready ones
// capped (the rest: «N more yours to do ›», Tasks › Yours to do). Below,
// project → plan: the project's
// project's list is no plan — its tasks hang straight from the project's name,
// no head, no fold —, and each named plan is ONE
// folded line with its counts; its chevron unfolds its task tree (remembered
// per viewer, lib/tasks-prefs.ts), its name opens the view on that plan and
// unfolds it too, and the plan of the task open in the main pane unfolds on
// its own. Finished work lives in the view's Done preset.
//
// The two switches (SidebarListSwitch) sit at the top of the list: the
// owner's choice is remembered per viewer (store.sidebarList → localStorage).
// «Tasks» is THE door to the Tasks page (the rail's icon is
// gone — one Tasks, not two): it shows the list and opens the page beside
// it, unless a task is already open. «Conversations» brings the tree back
// and leaves the page alone — it is the way back.
import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useStore } from '../../store'
import { useTasks } from '../../hooks/useTasks'
import { useNewTasks } from '../../hooks/useTaskSeen'
import { isFinished } from '../../lib/team-plan'
import {
  byActivity,
  isHumanOwner,
  isLiveTask,
  isYou,
  nowTasks,
  planFold,
  planHouse,
  siblingsOf,
  taskPage,
  taskTree,
  withLiveFlow,
  type TaskView,
  type TreeNode,
} from '../../lib/tasks'
import { readExpandedPlans, writeExpandedPlans } from '../../lib/tasks-prefs'
import { NewWord, TaskGlyph } from './TaskBits'
import type { AgentView } from '../../lib/types'
import { SiloDoor } from '../silo/SiloDoor'

export function SidebarListSwitch() {
  const list = useStore((s) => s.sidebarList)
  const setList = useStore((s) => s.setSidebarList)
  const pick = (v: 'conversations' | 'tasks'): void => {
    setList(v)
    const page = useStore.getState().page
    if (v === 'tasks' && page?.kind !== 'tasks' && page?.kind !== 'task') useStore.getState().changePage({ kind: 'tasks' })
  }
  return (
    <div
      role="tablist"
      aria-label="Sidebar list"
      className="mx-1 mb-2 flex items-center gap-0.5 rounded-lg bg-canvas/70 p-0.5 md:max-lg:hidden"
      data-testid="sidebar-list-switch"
    >
      {(['conversations', 'tasks'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={list === v}
          onClick={() => pick(v)}
          className={`flex-1 rounded-md py-1 text-[12px] transition-colors ${list === v ? 'bg-panel text-ink shadow-[0_0_0_1px_var(--line)]' : 'text-ink-2 hover:text-ink'}`}
        >
          {v === 'conversations' ? 'Conversations' : 'Tasks'}
        </button>
      ))}
    </div>
  )
}

// a plan's tree as rows, each with its depth (subtasks indented)
function flatten(nodes: readonly TreeNode[], depth: number): Array<{ n: TreeNode; depth: number }> {
  return nodes.flatMap((n) => [{ n, depth }, ...flatten(n.children, depth + 1)])
}

// one task as a sidebar row: its state, its title, and at the right edge
// the one thing worth knowing at a glance (live · on you · stalled)
// `person`: another human's task (not an agent, not you) — said by name in
// neutral ink, as OwnerMark does; «you» is the owner alone
function TaskLine({
  t,
  plan,
  agents,
  now,
  depth,
  active,
  live,
  mine,
  person,
  isNew,
  onOpen,
}: {
  t: TaskView
  plan: ReadonlyMap<string, TaskView>
  agents: readonly AgentView[]
  now: number
  depth: number
  active: boolean
  live: boolean
  mine: boolean
  person: string | null
  isNew: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="sidebar-task"
      {...(isNew ? { 'data-new': 'true' } : {})}
      aria-current={active ? 'page' : undefined}
      title={`${t.title} — ${t.ref}`}
      className={`flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[13px] ${active ? 'bg-canvas text-ink' : 'text-ink hover:bg-canvas/60'}`}
      style={{ paddingLeft: `${0.375 + depth * 0.875}rem` }}
    >
      <span className="text-[12px]">
        <TaskGlyph t={t} plan={plan} agents={agents} now={now} />
      </span>
      <span className={`min-w-0 flex-1 truncate ${isNew ? 'font-semibold' : ''}`}>
        <NewWord on={isNew} />
        {t.title}
      </span>
      {live ? (
        <span aria-label="a conversation is working on it" className="dot-blink h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta" />
      ) : mine ? (
        <span className="shrink-0 text-[10px] text-terracotta">you</span>
      ) : person ? (
        <span data-testid="sidebar-task-person" title={`${person} — not an agent here`} className="max-w-[5.5rem] shrink-0 truncate text-[10px] text-ink-3">
          {person}
        </span>
      ) : t.flow?.stalled ? (
        <span aria-label="untouched" title="untouched" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--health-amber)]" />
      ) : null}
    </button>
  )
}

export function SidebarTasks() {
  const reading = useTasks()
  const agents = useStore((s) => s.agents)
  const now = useStore((s) => s.nowTick)
  const page = useStore((s) => s.page)
  const changePage = useStore((s) => s.changePage)
  const agentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents])
  const all = useMemo(() => withLiveFlow(reading.tasks, agents, now), [reading.tasks, agents, now])
  const open = useMemo(
    () =>
      byActivity(
        all.filter((t) => !isFinished(t.state)),
        agents,
        now,
      ),
    [all, agents, now],
  )
  const tree = useMemo(() => taskTree(open), [open])
  const fresh = useNewTasks(all)
  const nowList = useMemo(() => nowTasks(all, agents, now), [all, agents, now])
  // the plans the viewer unfolded (remembered); the open task's plan unfolds
  // on its own until the viewer folds it while on that task
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(readExpandedPlans()))
  const [foldedOn, setFoldedOn] = useState<string | null>(null)
  const current = page?.kind === 'task' ? `${page.plan}/tasks/${page.task}` : null
  const currentPlan = page?.kind === 'task' ? page.plan : null
  const toggle = (planKey: string, isOpen: boolean): void => {
    const next = new Set(expanded)
    if (isOpen) next.delete(planKey)
    else next.add(planKey)
    setExpanded(next)
    writeExpandedPlans([...next])
    setFoldedOn(isOpen && planKey === currentPlan ? current : null)
  }
  const row = (t: TaskView, depth: number) => (
    <TaskLine
      t={t}
      plan={siblingsOf(all, t.planKey)}
      agents={agents}
      now={now}
      depth={depth}
      active={current === t.key}
      live={isLiveTask(t, agents, now)}
      mine={isYou(t.owner)}
      person={isHumanOwner(t.owner, agentIds) && !isYou(t.owner) ? t.owner : null}
      isNew={fresh.has(t.key)}
      onOpen={() => changePage(taskPage(t))}
    />
  )

  if (reading.state === 'loading') return <p className="px-3 py-2 text-[12px] text-ink-3">Reading tasks…</p>
  if (reading.state === 'absent') return <SiloDoor silo="plans" says="Tasks come with the Plans silo" className="px-3 py-2 text-[12px]" />
  if (reading.state === 'error' && reading.tasks.length === 0)
    return (
      <p role="alert" className="px-3 py-2 text-[12px] text-terracotta">
        The plans could not be read.
      </p>
    )

  return (
    <div data-testid="sidebar-tasks">
      <button
        type="button"
        data-testid="sidebar-all-tasks"
        onClick={() => changePage({ kind: 'tasks', view: 'open' })}
        aria-current={page?.kind === 'tasks' && page.view === 'open' && !page.agent?.length && !page.project?.length && !page.plan?.length ? 'page' : undefined}
        className="mb-2 flex w-full items-baseline justify-between rounded-md px-2 py-1 text-left text-[12.5px] text-ink-2 hover:bg-canvas/60 hover:text-ink aria-[current=page]:bg-canvas aria-[current=page]:text-ink"
      >
        <span>All tasks</span>
        <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{open.length} open</span>
      </button>
      {open.length === 0 ? <p className="px-2 text-[12px] text-ink-3">No open task in any project.</p> : null}

      {nowList.shown.length > 0 ? (
        <section aria-label="Now" data-testid="sidebar-tasks-now" className="mb-4">
          <div className="px-2 pb-0.5 text-[11px] text-ink-3">Now</div>
          <ul>
            {nowList.shown.map((t) => (
              <li key={t.key}>{row(t, 0)}</li>
            ))}
          </ul>
          {nowList.more > 0 ? (
            <button
              type="button"
              data-testid="sidebar-tasks-more"
              onClick={() => changePage({ kind: 'tasks', view: 'mine' })}
              className="flex w-full items-center gap-1 py-1 pl-2 pr-2 text-left text-[11px] text-ink-2 hover:text-ink"
            >
              <ChevronRight size={10} aria-hidden="true" />
              {nowList.more} more yours to do
            </button>
          ) : null}
        </section>
      ) : null}

      {tree.map((p) => (
        <div key={p.folder ?? '__outside__'} className="[&+&]:mt-3">
          <div className="px-2 pb-0.5 text-[11px] text-ink-3" title={p.folder ?? undefined}>
            {p.name}
          </div>
          {p.loose.length > 0 ? (
            <ul data-testid="sidebar-loose" className="mb-1">
              {flatten(p.loose, 0).map(({ n, depth }) => (
                <li key={n.task.key}>{row(n.task, depth)}</li>
              ))}
            </ul>
          ) : null}
          {p.plans.map((plan) => {
            const f = planFold(
              open.filter((t) => t.planKey === plan.planKey),
              agents,
              now,
            )
            const isOpen = expanded.has(plan.planKey) || (currentPlan === plan.planKey && foldedOn !== current)
            return (
              <div key={plan.planKey} data-testid="sidebar-plan" data-plan={plan.ref} data-open={isOpen ? 'true' : 'false'}>
                <div className="group flex w-full items-center rounded-md pr-2 hover:bg-canvas/60">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Fold' : 'Unfold'} ${plan.title}`}
                    onClick={() => toggle(plan.planKey, isOpen)}
                    data-testid="sidebar-plan-fold"
                    className="flex shrink-0 self-stretch items-center py-[3px] pl-1 pr-1"
                  >
                    <ChevronRight
                      size={11}
                      aria-hidden="true"
                      className={`text-ink-3 transition-transform duration-150 group-hover:text-ink-2 motion-reduce:transition-none ${isOpen ? 'rotate-90' : ''}`}
                    />
                  </button>
                  {/* the plan's name is a door: its open tasks, already filtered */}
                  <button
                    type="button"
                    title={`${plan.title} — its open tasks`}
                    data-testid="sidebar-plan-open"
                    onClick={() => {
                      if (!isOpen) toggle(plan.planKey, false)
                      changePage(planHouse(plan.planKey))
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1 py-[3px] text-left"
                  >
                    <span className={`min-w-0 flex-1 truncate text-[12.5px] ${isOpen ? 'text-ink' : 'text-ink-2 group-hover:text-ink'}`}>{plan.title}</span>
                    {f.live ? (
                      <span aria-label="a conversation is working on one" className="dot-blink h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta" />
                    ) : null}
                    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3" data-testid="sidebar-plan-counts">
                      {f.open} open
                      {f.onYou > 0 ? (
                        <>
                          {' '}
                          · <span className="text-terracotta">{f.onYou} yours to do</span>
                        </>
                      ) : null}
                    </span>
                  </button>
                </div>
                {isOpen ? (
                  <ul className="mb-1.5 ml-[0.6rem] mt-0.5 border-l border-line pl-0.5">
                    {flatten(plan.nodes, 0).map(({ n, depth }) => (
                      <li key={n.task.key}>{row(n.task, depth)}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
