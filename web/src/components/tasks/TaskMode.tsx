// TaskMode — the task page's task-mode pieces. The moment it serves: «work a
// task from beginning to end» — reached from the task page, which Tasks,
// Needs you and a conversation's header all open.
//
//   useTaskMode(key)  GET /api/tasks/mode: whether the owner is in task mode,
//                     how it wakes, its last wakes — re-read on every silo tick
//   TaskDoor          the task's ONE door, for any agent owner: «Open console ›»
//                     or «Open chat ›» — the task's own
//                     conversation or a new one, briefed and linked.
//                     doorPlan = its words; useTaskOpen = the going in, shared
//                     with «Send and open ›»; OpeningLine = its proof of life
//   TurnOnWakes       the quiet «turn on ›» beside «Wakes when»
//   WakeHistory       panel, not detail: the last 3 wakes, the rest folded
//   wakesWords        how an owner moves, in the house's words
import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api, ApiError } from '../../lib/api'
import { relTime } from '../../lib/rel-time'
import { sessionSignal } from '../../lib/live'
import { useDarkMode } from '../Sidebar'
import { openLabel, surfaceOf } from '../../lib/give'
import { useHarness } from '../../lib/harnesses'
import type { AgentView, AgentWakes, TaskDoorFacts, TaskModeStatus, TaskModeView, TaskWakeLine } from '../../lib/types'

export function useTaskMode(key: string): { view: TaskModeView | null; status: TaskModeStatus | null; reload: () => void } {
  const tick = useStore((s) => s.siloTick)
  const [n, setN] = useState(0)
  const [view, setView] = useState<TaskModeView | null>(null)
  const [status, setStatus] = useState<TaskModeStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    api
      .taskWakes(key)
      .then((v) => {
        if (!cancelled) setView(v)
      })
      .catch(() => {
        if (!cancelled) setView(null)
      })
    api
      .taskMode()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [key, tick, n])
  const reload = useCallback(() => setN((x) => x + 1), [])
  return { view, status, reload }
}

// behavior, never a mode name — «task mode» stays the silo's name in its own
// house (Settings › Silos), not daily vocabulary
export function wakesWords(w: AgentWakes): string {
  switch (w) {
    case 'task':
      return 'when its task moves — Silos wakes it'
    default:
      return 'only when someone talks to it'
  }
}

export type Opening = { state: 'idle' } | { state: 'opening'; words: string } | { state: 'note'; words: string } | { state: 'error'; words: string }

// the new console's conversation appears once claude writes its first line
export async function waitForSession(folder: string, id: string, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      await api.sessionDetail(folder, id, Number.MAX_SAFE_INTEGER)
      return true
    } catch {
      /* not listed yet */
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  return false
}

// ── the task's ONE door: «Open console ›» / «Open chat ›» ──
// «Open» = you go in. For ANY agent owner, whatever its control: its console
// briefed on the task when the agent HAS a console in the index (the first
// one is always opened by the owner by hand) and its engine's console takes
// the briefing; chat otherwise — and the button names the surface, so the
// switch is never a silent surprise. An engine whose console opens without
// the briefing says it opens in chat. It continues the agent's tip of
// the task's thread when there is one, else starts it — briefed and linked
// either way. A turn running in the thread: «X is on it already · Open ›».
// A run working the task is read-only: «Read it ›».
export type DoorMode = 'console' | 'chat'
export type DoorPlan =
  { kind: 'open'; label: string; note: string; to: { sessionId: string; folder: string } } | { kind: 'go'; mode: DoorMode; label: string; note: string | null }

export function doorPlan(o: { name: string; door: TaskDoorFacts | null | undefined; engineLabel?: string }): DoorPlan {
  const door = o.door ?? null
  // a run working the task is read-only: the door reads it, never «your words land in it»
  if (door?.running?.readOnly) {
    const w = (door.running.error ?? `an automation run of ${o.name} is working this task`).replace(/\s*—\s*read it\.?$/, '')
    return {
      kind: 'open',
      label: 'Read it ›',
      note: `${w.charAt(0).toUpperCase()}${w.slice(1)}.`,
      to: { sessionId: door.running.sessionId, folder: door.running.folder },
    }
  }
  if (door?.running)
    return {
      kind: 'open',
      label: 'Open ›',
      note: `${o.name} is on it already — your words land there.`,
      to: { sessionId: door.running.sessionId, folder: door.running.folder },
    }
  const mode = surfaceOf({ hasConsole: door?.hasConsole === true, consoleBriefs: door?.consoleBriefs !== false })
  const note = door?.consoleBriefs === false ? `${o.engineLabel ?? 'Its engine'} opens in chat` : null
  return { kind: 'go', mode, label: openLabel(mode), note }
}

// Opening the task's conversation, on either surface — the ONE way the door,
// «Send and open ›» and «Give and open …» go in (POST /api/tasks/work for the
// console, /api/tasks/talk for chat), with its proof of life while it opens
// (a console takes a moment to write its first line) and the server's
// refusals said with their door.
export interface TaskOpener {
  o: Opening
  refusedTo: { sessionId: string; folder: string; read?: true } | null
  readOnly: boolean
  go: (mode: DoorMode, forKey?: string, instead?: string) => Promise<boolean>
  open: (to: { sessionId: string; folder: string }) => Promise<void>
}

export function useTaskOpen({
  taskKey,
  name,
  conversations = [],
  onDone,
}: {
  taskKey: string
  name: string
  conversations?: readonly string[]
  onDone: () => void
}): TaskOpener {
  const openSession = useStore((s) => s.openSession)
  const agents = useStore((s) => s.agents)
  const setChatMode = useStore((s) => s.setChatMode)
  const [dark] = useDarkMode()
  const [o, setO] = useState<Opening>({ state: 'idle' })
  // a refusal that names the conversation to open (a turn started meanwhile)
  // — or, `read`, the run that holds the task (its console is never resumed)
  const [refusedTo, setRefusedTo] = useState<{ sessionId: string; folder: string; read?: true } | null>(null)
  const [readOnly, setReadOnly] = useState(false)

  async function open(to: { sessionId: string; folder: string }): Promise<void> {
    await openSession(to.folder, to.sessionId)
  }
  // true once the conversation is open
  // `instead` (console only): a NEW conversation takes the task from that one
  async function go(mode: DoorMode, forKey: string = taskKey, instead?: string): Promise<boolean> {
    setRefusedTo(null)
    setReadOnly(false)
    setO({ state: 'opening', words: mode === 'console' ? `Opening ${name}'s console on this task…` : `Opening a chat with ${name} on this task…` })
    try {
      if (mode === 'console') {
        const r = await api.workOnTask(forKey, dark ? 'dark' : 'light', instead)
        onDone()
        if (r.mode === 'new') {
          setO({ state: 'opening', words: `${name} is reading the task…` })
          if (!(await waitForSession(r.folder, r.sessionId))) {
            setO({
              state: 'note',
              words: `${name}'s console is open but has not written its first line yet — it shows under Conversations as soon as it does.`,
            })
            return false
          }
        }
        setChatMode('console')
        await openSession(r.folder, r.sessionId)
        // the link's warning (if any) said beside what the opening says
        const said = [
          r.briefed ? null : (r.why ?? 'Opened without the briefing.'),
          r.warn && r.warn !== '' ? `Linked — ${r.warn}.` : null,
          r.released === false ? `The old conversation is still linked — ${r.releaseError ?? 'unlink it from ⌘K'}.` : null,
        ].filter((x): x is string => x !== null)
        setO(said.length > 0 ? { state: 'note', words: said.join(' ') } : { state: 'idle' })
        return true
      }
      const r = await api.tasksTalk(forKey)
      if (r.isNew) await waitForSession(r.folder, r.sessionId)
      setChatMode('chat')
      await openSession(r.folder, r.sessionId)
      setO({ state: 'idle' })
      onDone()
      return true
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { running?: unknown; readOnly?: unknown; sessionId?: unknown; folder?: unknown }) : null
      if (body?.readOnly === true) {
        // a run is working it: not a failure — say who, and read it
        const run = runToRead(body, conversations, agents)
        setReadOnly(true)
        if (run) setRefusedTo({ ...run, read: true })
        setO({ state: 'note', words: e instanceof Error ? e.message : String(e) })
        onDone()
        return false
      }
      if (body?.running === true && typeof body.sessionId === 'string' && typeof body.folder === 'string')
        setRefusedTo({ sessionId: body.sessionId, folder: body.folder })
      setO({ state: 'error', words: e instanceof Error ? e.message : String(e) })
      onDone()
      return false
    }
  }
  return { o, refusedTo, readOnly, go, open }
}

// the run a readOnly refusal points at: the server's own session when it
// names one, else the task's conversation that is a run and is working now
// (the census's blink), else its newest run
export function runToRead(
  body: { sessionId?: unknown; folder?: unknown } | null,
  conversations: readonly string[],
  agents: readonly AgentView[],
  now = Date.now(),
): { sessionId: string; folder: string } | null {
  if (body && typeof body.sessionId === 'string' && typeof body.folder === 'string') return { sessionId: body.sessionId, folder: body.folder }
  const listed = new Set(conversations)
  const runs = agents.flatMap((a) => a.sessions).filter((x) => listed.has(x.id) && x.origin && x.origin.kind !== 'message')
  const pick = runs.find((x) => sessionSignal(x, now, false) === 'working') ?? [...runs].sort((a, b) => b.mtime - a.mtime)[0]
  return pick ? { sessionId: pick.id, folder: pick.folder } : null
}

// what an opening says under whatever opened it (the door, the composer)
export function OpeningLine({ opener }: { opener: TaskOpener }) {
  const { o, refusedTo, readOnly, open } = opener
  if (o.state === 'opening') {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-2" role="status">
        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-terracotta motion-reduce:animate-none" />
        {o.words}
      </p>
    )
  }
  if (o.state === 'note' && readOnly) {
    return (
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-ink-2" role="status" data-testid="task-door-read-only">
        <span className="inline-flex items-baseline gap-1.5">
          <span aria-hidden="true" className="dot-blink relative top-[-1px] h-1.5 w-1.5 shrink-0 self-center rounded-full bg-terracotta" />
          <span>
            {o.words.charAt(0).toUpperCase()}
            {o.words.slice(1)}.
          </span>
        </span>
        {refusedTo?.read ? (
          <button
            type="button"
            data-testid="task-door-read"
            onClick={() => void open(refusedTo)}
            className="font-medium text-ink underline decoration-line underline-offset-2 hover:text-terracotta hover:decoration-terracotta/50"
          >
            Read it ›
          </button>
        ) : null}
      </p>
    )
  }
  if (o.state === 'note')
    return (
      <p className="mt-1.5 text-[11.5px] text-ink-2" role="status">
        {o.words}
      </p>
    )
  if (o.state === 'error') {
    return (
      <p className="mt-1.5 text-[11.5px] text-terracotta" role="alert">
        {o.words}
        {refusedTo ? (
          <>
            {' '}
            <button
              type="button"
              onClick={() => void open(refusedTo)}
              className="underline decoration-terracotta/40 underline-offset-2 hover:decoration-terracotta"
            >
              Open it ›
            </button>
          </>
        ) : null}
      </p>
    )
  }
  return null
}

export function TaskDoor({
  owner,
  door,
  opener,
  quiet = false,
}: {
  owner: AgentView
  door: TaskDoorFacts | null | undefined
  opener: TaskOpener
  quiet?: boolean
}) {
  const engine = useHarness(owner.framework)
  const plan = doorPlan({ name: owner.name, door, engineLabel: engine.label })
  const busy = opener.o.state === 'opening'
  const pill = quiet
    ? 'rounded-full border border-line px-3 py-1 text-[12.5px] text-ink enabled:hover:border-terracotta enabled:hover:text-terracotta'
    : 'rounded-full bg-terracotta px-3.5 py-1 text-[12.5px] font-medium text-on-terracotta shadow-[0_1px_0_var(--shadow-soft)] enabled:hover:brightness-105'
  return (
    <div
      data-testid="task-door"
      data-kind={plan.kind}
      {...(plan.kind === 'go' ? { 'data-mode': plan.mode, 'data-thread': door?.thread ? 'continue' : 'start' } : {})}
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
        <button
          type="button"
          data-testid="task-door-primary"
          disabled={busy}
          onClick={() => void (plan.kind === 'open' ? opener.open(plan.to) : opener.go(plan.mode))}
          className={`${pill} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 disabled:opacity-60`}
        >
          {plan.label}
        </button>
        {plan.kind === 'go' && plan.note ? (
          <span className="text-[11.5px] text-ink-3" data-testid="task-door-note">
            {plan.note}
          </span>
        ) : null}
      </div>
      {plan.kind === 'open' ? (
        <p className="mt-1.5 text-[11.5px] text-ink-2" role="status">
          {plan.note}
        </p>
      ) : null}
      <OpeningLine opener={opener} />
    </div>
  )
}

// «Wakes when … · turn on ›»: the quiet door to let Silos wake an agent that
// only moves when spoken to (Task mode's own house, or Settings › Silos when
// it is not running) — a property, never a sentence in the way of the work
export function TurnOnWakes({ status }: { status: TaskModeStatus | null }) {
  const changePage = useStore((s) => s.changePage)
  const active = status?.active === true
  return (
    <button
      type="button"
      data-testid="task-wakes-turn-on"
      title="Let Silos wake it when its task moves"
      onClick={() => changePage(active ? { kind: 'silo', id: status!.silo } : { kind: 'settings', tab: 'silos' })}
      className="ml-1.5 text-[12px] text-ink-3 hover:text-terracotta"
    >
      turn on ›
    </button>
  )
}

const REASON_WORDS: Record<TaskWakeLine['reason'], string> = {
  unblocked: 'Blockers done',
  'children-done': 'Subtasks done',
  'owner-note': 'Your note',
  'next-check': 'Next check came',
  stalled: 'Sat untouched — one more try',
  assigned: 'Handed to it',
  // another agent answered what it asked through Silos
  answered: 'Its ask was answered',
}

// the wake Silos has queued for this task, if any — the task page says
// «Waking X» instead of a bare «Sits untouched» while one is on its way
export function queuedWake(view: TaskModeView | null): TaskWakeLine | null {
  return view?.history.find((w) => w.state === 'queued') ?? null
}

// what the task's live line already says of a held wake (TaskLive: «X
// waits — <why>», «X couldn't start: <why>») — the server takes that why
// from the first queued wake that carries one (task-mode engine liveOf)
export function liveWhy(view: TaskModeView | null): string | null {
  const l = view?.live
  return l && (l.kind === 'held' || l.kind === 'failed') ? l.why : null
}

// a wake's fate in the list. `said`: the why the live line above already
// says — a queued wake held for it reads «Waiting» alone, so the page says
// the fact once at rest (banner, live line and this row
// once said the same sentence three times)
export function wakeFate(w: TaskWakeLine, now: number, ownerName: string, said: string | null = null): string {
  const when = relTime(Date.parse(w.deliveredAt ?? w.at), now)
  if (w.state === 'delivered') {
    if (w.via === 'work') return `Reached ${ownerName} in your console ${when}`
    // handed over in the claim's own answer: the conversation
    // that took the task read it as it took it
    if (w.via === 'claim') return `Reached ${ownerName} as it took the task ${when}`
    return `Woke ${ownerName} ${when}`
  }
  // «Skipped», never «Dropped»: that word is a task's Drop
  if (w.state === 'superseded') return `Skipped: ${w.held ?? 'the task moved on first'}`
  const until = w.until && !Number.isNaN(Date.parse(w.until)) ? ` (until ${relTime(Date.parse(w.until), now)})` : ''
  if (w.held && w.held === said) return `Waiting${until}`
  return `Waiting: ${w.held ?? 'its turn comes next'}${until}`
}

// `stuck`: the task's stall when it is one no wake will move (a dropped
// task before it — lib/tasks.ts stallLine): the empty history says that,
// never that a wake comes when its blockers finish
export function WakeHistory({
  view,
  ownerName,
  onOpen,
  stuck = null,
}: {
  view: TaskModeView
  ownerName: string
  onOpen: (sessionId: string) => void
  stuck?: string | null
}) {
  const said = liveWhy(view)
  const now = useStore((s) => s.nowTick)
  const [all, setAll] = useState(false)
  const lines = all ? view.history : view.history.slice(0, 3)
  if (view.history.length === 0) {
    return stuck ? (
      <p data-testid="task-wakes-stuck" className="text-[13px] text-ink-2">
        No wake yet, and none comes on its own — {stuck}. Remove the dependency or reopen that task — both are on this page.
      </p>
    ) : (
      <p className="text-[13px] text-ink-2">No wake yet — the next comes when its blockers or subtasks finish, when you add a note, or at its next check.</p>
    )
  }
  return (
    <>
      <ol className="flex flex-col" data-testid="task-wakes">
        {lines.map((w) => (
          <li key={w.id} className="grid grid-cols-[7.5rem_1fr] items-baseline gap-3 py-1.5 text-[13px]" data-testid="task-wake" data-state={w.state}>
            <span className={`text-[11.5px] ${w.state === 'queued' ? 'font-medium text-terracotta' : 'text-ink-3'}`}>{REASON_WORDS[w.reason] ?? w.reason}</span>
            <span className="min-w-0 text-ink-2">
              <span className={w.state === 'superseded' ? 'text-ink-3' : w.state === 'queued' ? 'text-ink' : 'text-ink-2'}>
                {wakeFate(w, now, ownerName, said)}
              </span>
              {w.reason === 'unblocked' || w.reason === 'children-done' ? <span className="text-ink-3"> · {w.says}</span> : null}
              {w.session && w.state === 'delivered' ? (
                <button type="button" onClick={() => onOpen(w.session!)} className="ml-1.5 text-[12px] text-ink-2 hover:text-terracotta">
                  Open ›
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {view.history.length > 3 ? (
        <button type="button" onClick={() => setAll((x) => !x)} className="mt-1 text-[12px] text-ink-3 hover:text-ink">
          {all ? 'Fewer' : `${view.history.length - 3} earlier`}
        </button>
      ) : null}
    </>
  )
}
