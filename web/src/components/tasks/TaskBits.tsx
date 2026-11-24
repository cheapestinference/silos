// TaskBits.tsx — the small marks every task surface shares (the Tasks view's
// rows and cards, the sidebar's Tasks list, a task's page), so a task reads
// the same wherever it is drawn:
//   OwnerMark  the agent's emoji seal with its name, or «you» on the house's
//              person tint (terracotta-soft — PlanView's OwnerChip language)
//   LiveMark   «Live»: the one terracotta signal, blinking like the sidebar's
//              working dot — a linked conversation is working right now
//   StallText  why it is stuck, in amber (a health colour, not an alarm):
//              the kernel's cause and the FIRST stuck task, a door to it
//   OriginBack the way back to where a task or a view was opened from: its
//              words, its destination (lib/task-origin.ts)
//   TaskGlyph  a task's status: the one glyph, and a blocked task says which
//              blocked it is (muted when covered, the accent when it needs
//              you or is stuck), its cause on hover
//   TaskPeek   the card a reference to a task shows on hover — what you
//              would look at before opening it
//   NoteText   a note's words, each plan#id in them a door with that card
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronLeft } from 'lucide-react'
import { TasksIcon } from '../../lib/icons'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { orgSource } from '../../lib/org'
import { useTasks } from '../../hooks/useTasks'
import {
  NO_PLAN_FACET,
  blockedLabel,
  chainFacts,
  conversationWork,
  isLiveTask,
  isOpenWork,
  isYou,
  noteWhen,
  noteAuthorWords,
  readBlocked,
  siblingsOf,
  stallLine,
  taskPage,
  workWord,
  workedTasks,
  type DropWarnings,
  type TaskView,
  type WorkedTask,
} from '../../lib/tasks'
import { basename } from '../../lib/routes'
import { splitTaskRefs, taskOfRef } from '../../lib/task-refs'
import { isFinished } from '../../lib/team-plan'
import { originWords, taskPageOfKey } from '../../lib/task-origin'
import { taskOriginRoute, type TaskOrigin } from '../../lib/routes'
import { goBackTo } from '../../lib/router'
import { StatusGlyph } from '../PlanView'
import type { AgentView } from '../../lib/types'

export function OwnerMark({ owner, agents, compact = false }: { owner: string; agents: readonly AgentView[]; compact?: boolean }) {
  const a = agents.find((x) => x.id === owner)
  if (!a) {
    // «you» is the owner alone; another person is said by
    // name, on the quiet person tint — not the accent that means «yours»
    if (owner === '' || isYou(owner)) {
      return (
        <span
          className="inline-flex shrink-0 items-center rounded-full bg-terracotta-soft px-1.5 py-px text-[10.5px] font-medium text-terracotta"
          title={owner ? 'yours' : 'nobody owns it'}
        >
          {owner ? 'you' : 'nobody'}
        </span>
      )
    }
    return (
      <span
        data-testid="owner-person"
        className="inline-flex min-w-0 shrink-0 items-center rounded-full border border-line px-1.5 py-px text-[10.5px] font-medium text-ink-2"
        title={`${owner} — not an agent here`}
      >
        <span className="truncate">{owner}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1 text-[11.5px] text-ink-2" title={a.name}>
      <span aria-hidden="true" className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-panel text-[11px] leading-none">
        {a.emoji || '·'}
      </span>
      {compact ? null : <span className="truncate">{a.name}</span>}
    </span>
  )
}

// where an origin says, and how to go there
export function useOrigin(o: TaskOrigin | undefined): { words: string; go: () => void } {
  const agents = useStore((s) => s.agents)
  const silos = useStore((s) => s.silos)
  const reading = useTasks()
  const words = originWords(o, {
    agent: (id) => agents.find((a) => a.id === id)?.name,
    // the project's list has no name: its facet says «No plan»,
    // and its key — an older address — says only its project
    plan: (key) => {
      if (key === NO_PLAN_FACET) return 'No plan'
      const t = reading.tasks.find((x) => x.planKey === key)
      return t?.standingList ? (t.folder ? basename(t.folder) : 'No plan') : t?.planTitle
    },
    // the reporting silo's page is where the Org is drawn and edited: its
    // way back says «Org», the one word of tile, tab and section
    silo: (id) => (orgSource(silos)?.silo === id ? 'Org' : (silos.find((s) => s.id === id)?.name ?? undefined)),
    conversation: (folder, id) => agents.flatMap((a) => a.sessions).find((s) => s.folder === folder && s.id === id)?.title,
  })
  // a «back» (the link, Esc on the task's page): the browser's Back when the
  // origin is right below — over the tasks stepped through — else it goes
  // there replacing; it never stacks
  const go = (): void => goBackTo(taskOriginRoute(o), navigate)
  const navigate = (): void => {
    const st = useStore.getState()
    switch (o?.kind) {
      case undefined:
        st.changePage({ kind: 'tasks' })
        break
      case 'needs-you':
      case 'yours':
        st.changePage(o.folder !== undefined ? { kind: 'project', folder: o.folder } : null)
        useStore.getState().setHomeSheet(o.kind)
        break
      case 'tasks':
        st.changePage({ kind: 'tasks', ...o.query })
        break
      case 'org':
        st.changePage({ kind: 'map', view: 'org' })
        break
      case 'silo':
        st.changePage({ kind: 'silo', id: o.id })
        break
      case 'conversation':
        void st.openSession(o.folder, o.id)
        break
    }
  }
  return { words, go }
}

export function OriginBack({ words, onBack, testId }: { words: string; onBack: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onBack}
      data-testid={testId}
      title={words}
      className="flex min-w-0 max-w-full items-center gap-0.5 text-[12px] text-ink-2 hover:text-ink"
    >
      <ChevronLeft size={14} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{words}</span>
    </button>
  )
}

export function TaskGlyph({ t, plan, agents, now }: { t: TaskView; plan: ReadonlyMap<string, TaskView>; agents: readonly AgentView[]; now: number }) {
  const blocked = readBlocked(t, plan, chainFacts(agents, now))
  if (blocked) return <StatusGlyph status={t.state} attention={blocked.tone !== 'covered'} label={blockedLabel(blocked)} />
  const stall = isFinished(t.state) ? null : stallLine(t, plan)
  return <StatusGlyph status={t.state} {...(stall ? { label: `${t.stateLabel} · ${stall}` } : {})} />
}

export function LiveMark({ label = 'Live' }: { label?: string }) {
  return (
    <span data-testid="task-live" className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-terracotta">
      <span aria-hidden="true" className="dot-blink h-1.5 w-1.5 rounded-full bg-terracotta" />
      {label}
    </span>
  )
}

// «new to you» said to a screen reader; the eye gets the weight
export function NewWord({ on }: { on: boolean }) {
  return on ? <span className="sr-only">New to you: </span> : null
}

// a task reference (plan#id) as a quiet door
export function TaskRef({ children, onOpen }: { children: ReactNode; onOpen?: () => void }) {
  if (!onOpen) return <span className="font-mono text-[11px] text-ink-3">{children}</span>
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      className="font-mono text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
    >
      {children}
    </button>
  )
}

// ── the card on a reference ───────────────────────────────────────────────

const PEEK_WIDTH = 280
const PEEK_INTENT_MS = 280
const PEEK_LEAVE_MS = 100
// one card at a time, in the whole house
let openPeek: { current: () => void } | null = null

function PeekCard({ t, x, y, above }: { t: TaskView; x: number; y: number; above: boolean }) {
  const reading = useTasks()
  const agents = useStore((s) => s.agents)
  const now = useStore((s) => s.nowTick)
  const last = t.notes[t.notes.length - 1]
  const when = last ? noteWhen(last, now) : ''
  return createPortal(
    <div
      role="tooltip"
      data-testid="task-peek"
      className="peek-in pointer-events-none fixed z-50 rounded-xl border border-line bg-canvas px-3.5 py-3 shadow-[0_8px_28px_var(--shadow-float)]"
      style={{ left: x, width: PEEK_WIDTH, ...(above ? { bottom: window.innerHeight - y } : { top: y }) }}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
        <TaskGlyph t={t} plan={siblingsOf(reading.tasks, t.planKey)} agents={agents} now={now} />
        <span className="shrink-0">{t.stateLabel}</span>
        {isLiveTask(t, agents, now) ? <LiveMark /> : null}
        <span className="ml-auto min-w-0 truncate font-mono text-[10.5px] text-ink-3" title={t.ref}>
          {t.label}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[13.5px] font-medium leading-snug text-ink">{t.title}</p>
      <div className="mt-1.5 flex">
        <OwnerMark owner={t.owner} agents={agents} />
      </div>
      {last ? (
        <div className="mt-2.5 border-t border-line/70 pt-2">
          <p className="line-clamp-3 text-[12.5px] leading-snug text-ink-2">{last.text}</p>
          <p className="mt-1 text-[11px] text-ink-3">
            {noteAuthorWords(last, agents)}
            {when ? `, ${when}` : ''}
          </p>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}

// Wraps a reference to a task (one element). Hover with a real mouse, after a
// moment, or keyboard focus; a phone has no hover and a tap opens the page, as
// ever. Never on a list's own rows: they already say what they say.
export function TaskPeek({ task, children }: { task: TaskView | null | undefined; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [at, setAt] = useState<{ x: number; y: number; above: boolean } | null>(null)
  const clear = (): void => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
  }
  const close = (): void => {
    clear()
    setAt(null)
    if (openPeek === closer) openPeek = null
  }
  const closer = useRef(close)
  closer.current = close
  const open = (): void => {
    const el = ref.current?.firstElementChild
    if (!el || !task) return
    const r = el.getBoundingClientRect()
    openPeek?.current()
    openPeek = closer
    const above = r.bottom + 220 > window.innerHeight && r.top > 220
    setAt({ x: Math.max(8, Math.min(r.left, window.innerWidth - PEEK_WIDTH - 8)), y: above ? r.top - 6 : r.bottom + 6, above })
  }
  const later = (fn: () => void, ms: number): void => {
    clear()
    timer.current = window.setTimeout(fn, ms)
  }
  // Esc takes the card away first, and nothing else
  useEffect(() => {
    if (!at) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    const onScroll = (): void => close()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  })
  // leaving the page (the click that opens it) takes the card along
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (openPeek === closer) openPeek = null
    },
    [],
  )
  if (!task) return <>{children}</>
  return (
    <span
      ref={ref}
      className="contents"
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') later(open, PEEK_INTENT_MS)
      }}
      onPointerLeave={() => later(close, PEEK_LEAVE_MS)}
      onPointerDown={close}
      onFocus={(e) => {
        if (e.target.matches(':focus-visible')) later(open, PEEK_INTENT_MS)
      }}
      onBlur={close}
    >
      {children}
      {at ? <PeekCard t={task} {...at} /> : null}
    </span>
  )
}

// a note's words: each plan#id a task the reading knows is a door with its card
export function NoteText({ text, from, onOpen }: { text: string; from: Pick<TaskView, 'planKey' | 'folder'>; onOpen: (t: TaskView) => void }) {
  const reading = useTasks()
  return (
    <>
      {splitTaskRefs(text, (r) => taskOfRef(r, reading.tasks, from)).map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <TaskPeek key={i} task={part.task}>
            {/* the task's label, never the raw words: `tasks#t3` paints as
              what the task is called on screen */}
            <button
              type="button"
              onClick={() => onOpen(part.task)}
              data-testid="note-task-ref"
              title={part.ref !== part.task.label ? `the note says ${part.ref}` : undefined}
              className="font-mono text-[12.5px] text-ink underline decoration-line underline-offset-2 hover:text-terracotta hover:decoration-terracotta"
            >
              {part.task.label}
            </button>
          </TaskPeek>
        ),
      )}
    </>
  )
}

// The Drop's small confirm — ONE form for the task page and Home's row:
// why (optional; the note says «Dropped: <why>»), and,
// before anything is written, what it leaves hanging — a dropped task never
// resolves, so whatever waits on it stalls until someone removes that
// dependency. Enter drops, Esc (or Cancel) keeps it.
export function DropConfirm({
  warnings,
  busy,
  onDrop,
  onCancel,
  testId = 'drop-confirm',
}: {
  // what the Drop leaves as it is (lib/tasks.ts dropWarnings), said before it
  warnings: DropWarnings | null
  busy: boolean
  onDrop: (reason: string) => void
  onCancel: () => void
  testId?: string
}) {
  const [reason, setReason] = useState('')
  const openSession = useStore((s) => s.openSession)
  const live = warnings?.live?.session ?? null
  return (
    <form
      data-testid={testId}
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy) onDrop(reason)
      }}
    >
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why it is dropped"
        aria-label="Why it is dropped"
        maxLength={500}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
        className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-[12.5px] outline-none focus:border-terracotta"
      />
      {warnings && warnings.lines.length > 0 ? (
        <p data-testid={`${testId}-hangs`} className="text-[12px] leading-snug text-[var(--health-amber)]">
          {warnings.lines.map((l) => `${l.charAt(0).toUpperCase()}${l.slice(1)}.`).join(' ')}
        </p>
      ) : null}
      {warnings?.liveWords ? (
        <p data-testid={`${testId}-live`} className="text-[12px] leading-snug text-[var(--health-amber)]">
          {warnings.liveWords}
          {live ? (
            <>
              ;{' '}
              <button
                type="button"
                onClick={() => void openSession(live.folder, live.id)}
                className="underline decoration-[var(--health-amber)]/40 underline-offset-2 hover:text-terracotta"
              >
                open ›
              </button>
            </>
          ) : (
            '.'
          )}
        </p>
      ) : null}
      <span className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="rounded-full border border-line px-3 py-1 text-[12px] text-ink hover:border-ink-3 disabled:opacity-50">
          Drop
        </button>
        <button type="button" onClick={onCancel} className="text-[12px] text-ink-3 hover:text-ink">
          Cancel
        </button>
      </span>
    </form>
  )
}

export function StallText({ children }: { children: ReactNode }) {
  return <span className="text-[var(--health-amber)]">{children}</span>
}

export function useAgents(): AgentView[] {
  return useStore((s) => s.agents)
}

// A conversation's header names the task it works — «☑ Working on «title» ›»
// (the link shows on both sides, the same ☑ and the
// same words as the sidebar row). The tasks: the server's inverse of
// conversations[] (closed over rotations — a task may list an ancestor while
// this is the thread's tip — and over closed plans, read-only), the reading's
// direct match as the fallback. An OPEN task this conversation is still
// CURRENT on leads; when every one is finished — or the conversation was
// unlinked from it (history, not work) — it says «Worked on
// «title» ✓»; «+N» opens the others in a small list, never a mute number.
// Nothing when no task names it.
// The tasks the open conversation works, as its header reads them — one
// reading for the header and the column's «Continue in a new conversation».
export function useConversationWork(sessionId: string | null): ReturnType<typeof conversationWork> {
  const reading = useTasks()
  const selected = useStore((s) => s.selected)
  const [served, setServed] = useState<Parameters<typeof workedTasks>[0]>(null)
  // asked again whenever the reading moved: a link written from ⌘K (or by
  // an agent) shows without reopening the conversation
  useEffect(() => {
    let cancelled = false
    if (!sessionId || !selected) {
      setServed(null)
      return
    }
    // tests mock the api piecemeal — a missing method means «no closure»,
    // and the direct match answers while there is none
    const closure = (api as { sessionTasks?: typeof api.sessionTasks }).sessionTasks
    const p = closure?.(selected.folder, selected.id)
    if (!p || typeof p.then !== 'function') {
      setServed(null)
      return
    }
    p.then((r) => {
      if (!cancelled) setServed(r.tasks)
    }).catch(() => {
      if (!cancelled) setServed(null)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, selected?.folder, selected?.id, reading.tasks]) // eslint-disable-line react-hooks/exhaustive-deps
  // another conversation: the old list never hangs over it
  useEffect(() => {
    setServed(null)
  }, [sessionId])
  if (!sessionId) return null
  return conversationWork(workedTasks(served, reading.tasks, sessionId))
}

// `unlanded`: the conversation's branch holds work its default branch does
// not have — said only beside a task that reads done («done, not there yet»)
export function ConversationTask({ sessionId, unlanded = null }: { sessionId: string | null; unlanded?: string | null }) {
  const changePage = useStore((s) => s.changePage)
  const selected = useStore((s) => s.selected)
  const [peek, setPeek] = useState<DOMRect | null>(null)
  const work = useConversationWork(sessionId)
  useEffect(() => {
    setPeek(null)
  }, [sessionId])
  if (!sessionId || !work) return null
  const from = selected ? { from: { kind: 'conversation' as const, folder: selected.folder, id: selected.id } } : {}
  const open = (t: WorkedTask): void => {
    const page = t.view ? taskPage(t.view) : taskPageOfKey(t.key)
    if (page) changePage({ ...page, ...from })
  }
  const { lead, rest } = work
  const said = workWord(lead)
  return (
    <span className="inline-flex min-w-0 shrink items-center gap-1.5 md:ml-1">
      <TaskPeek task={lead.view}>
        <button
          type="button"
          onClick={() => open(lead)}
          data-testid="conversation-task"
          data-working={said.word === 'working' ? 'true' : 'false'}
          data-word={said.word}
          title={
            lead.closed
              ? `${lead.ref} — its plan is closed (read only)`
              : lead.state === 'cancelled'
                ? `${lead.ref} — dropped`
                : said.word === 'worked'
                  ? `${lead.ref} — this conversation was unlinked from it`
                  : said.word === 'linked'
                    ? `${lead.ref} — linked; it stays ${lead.state.replace('_', ' ')}`
                    : lead.ref
          }
          className="group/task inline-flex min-w-0 shrink items-center gap-1 text-[12px] text-ink-2 hover:text-terracotta"
        >
          <TasksIcon size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-3 group-hover/task:text-terracotta" />
          <span className="shrink-0">{said.lead}</span>
          <span className={`min-w-0 max-w-[40ch] truncate group-hover/task:text-terracotta ${said.word === 'worked' ? 'text-ink-2' : 'text-ink'}`}>
            {lead.title}
          </span>
          {said.word === 'working' || said.word === 'linked' ? (
            <span aria-hidden="true" className="shrink-0 text-ink-3 group-hover/task:text-terracotta">
              ›
            </span>
          ) : // finished: the house's green ✓; let go while still open: its
          // state in words and no ✓ — it is not done
          said.word === 'done' ? (
            <>
              <Check size={12} strokeWidth={2.25} aria-label="finished" className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              {unlanded ? (
                <span data-testid="conversation-task-unlanded" className="shrink-0 text-terracotta">
                  · {unlanded}
                </span>
              ) : null}
            </>
          ) : (
            <span data-testid="conversation-task-state" className="shrink-0 text-ink-3">
              · {said.state}
            </span>
          )}
        </button>
      </TaskPeek>
      {rest.length > 0 ? (
        <button
          type="button"
          data-testid="conversation-task-more"
          aria-haspopup="menu"
          aria-expanded={peek !== null}
          title={`${rest.length} more ${rest.length === 1 ? 'task' : 'tasks'} this conversation works`}
          onClick={(e) => setPeek(peek ? null : e.currentTarget.getBoundingClientRect())}
          // said in words, in the line's own voice, with the glyph of what it
          // does: «›» on the task goes to it, «⌄» here opens the list
          className="group/more inline-flex shrink-0 items-center gap-0.5 rounded-sm text-[12px] tabular-nums text-ink-2 hover:text-terracotta aria-expanded:text-terracotta"
        >
          <span aria-hidden="true" className="pr-1 text-ink-3/70">
            ·
          </span>
          <span data-count={rest.length}>{rest.length} more</span>
          <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-ink-3 group-hover/more:text-terracotta group-aria-expanded/more:text-terracotta" />
        </button>
      ) : null}
      {peek ? (
        <WorkedList
          tasks={[lead, ...rest]}
          at={peek}
          onOpen={(t) => {
            setPeek(null)
            open(t)
          }}
          onClose={() => setPeek(null)}
        />
      ) : null}
    </span>
  )
}

const LIST_WIDTH = 344
// «+N»: every task the conversation works, the lead first — each a door with
// its state glyph and ref; a closed plan's task says so (read only)
function WorkedList({ tasks, at, onOpen, onClose }: { tasks: readonly WorkedTask[]; at: DOMRect; onOpen: (t: WorkedTask) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!box.current?.contains(e.target as Node)) close.current()
    }
    // Esc closes the list and is NOT taken from the engine: in a
    // conversation Esc always cancels the turn too
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close.current()
    }
    const onScroll = (e: Event): void => {
      if (!box.current?.contains(e.target as Node)) close.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [])
  useEffect(() => {
    box.current?.querySelector('button')?.focus({ preventScroll: true })
  }, [])
  const left = Math.max(8, Math.min(at.left - 8, window.innerWidth - LIST_WIDTH - 8))
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label="Tasks this conversation works"
      data-testid="conversation-task-list"
      className="peek-in fixed z-50 rounded-xl border border-line bg-canvas p-1 shadow-[0_8px_28px_var(--shadow-float)]"
      style={{ left, top: at.bottom + 6, width: LIST_WIDTH }}
    >
      <p className="px-2.5 pb-1 pt-1.5 text-[11px] text-ink-3">This conversation works on</p>
      {tasks.map((t) => (
        <button
          key={t.key}
          type="button"
          role="menuitem"
          onClick={() => onOpen(t)}
          data-testid="conversation-task-item"
          data-task={t.ref}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-panel focus-visible:bg-panel focus-visible:outline-none"
        >
          <StatusGlyph status={t.state} />
          <span className={`min-w-0 flex-1 truncate text-[12.5px] ${isOpenWork(t) ? 'text-ink' : 'text-ink-2'}`}>{t.title}</span>
          <span
            className="max-w-[38%] shrink-0 truncate font-mono text-[10.5px] text-ink-3"
            title={!t.closed && !t.current ? 'this conversation was unlinked from it' : t.ref}
          >
            {t.closed ? 'plan closed' : !t.current && !isFinished(t.state) ? `unlinked · ${t.view?.label ?? t.ref}` : (t.view?.label ?? t.ref)}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
