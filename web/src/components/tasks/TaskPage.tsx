// TaskPage — one plan task as a page (/task/<plan key>/<task id>).
// The moment it serves (docs/product.md): «what's happening?» for
// ONE piece of work — who has it, what it waits on, which conversations
// worked it — and moment 2 when it is the owner's (Done / Drop / a note).
// Reached from a Tasks row, Home's Needs you («open task»), the column's
// PlanView rows and a conversation's header. It remembers which (`from`, in
// the URL; lib/task-origin.ts): the back link and Esc return THERE, a thin
// «‹ 3 of 13 ›» walks that list ([ ] or j k) and, on a task of the owner's,
// «Done and next» settles it and opens the next one (d). A hop to a related task
// keeps the origin — the way back stays where the walk began. The list holds its
// order while it is walked (lib/held-order.ts), so settling this task does not
// move the next one.
//
// In order: «Created from <plan> by <who>», the title and the wait/stall
// banner with its cause · subtasks with a progress strip · the conversations
// that worked it, each with its live state and one click to its console ·
// notes and activity (state changes from the silo journal as inline rows) ·
// deliverables (files its conversations wrote). Task mode: «Work
// on this» for an owner in task mode, its wakes as a panel; an agent in
// conversation mode gets one honest line and the door. Properties on the right
// (after the title on a phone). Every gesture on the task is ONE write — the
// owner's verb (lib/task-gesture.ts act: Done, Drop, Reopen, Park, Resume,
// Remove the dependency, Answer, Approve, Send back, Give to…), judged by the server on
// what this page painted; a plain note is append-item against the file's CAS
// version. A refusal is said beside the control that caused it. The
// transcripts are linked, never copied in.
import { useEffect, useMemo, useRef, useState } from 'react'
import { OriginMark, useOriginOutside } from './OriginMark'
import { GiveTo, handedWords } from './GiveTo'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useStore } from '../../store'
import { api, ApiError } from '../../lib/api'
import { PLANS_SILO } from '../../lib/plan-record'
import { relTime, untilTime } from '../../lib/rel-time'
import { basename } from '../../lib/routes'
import { openFileViewer, openPlanDoor } from '../../lib/file-refs'
import { isFinished, planProgress, type PlanStatus } from '../../lib/team-plan'
import { act, actError } from '../../lib/task-gesture'
import { useServerConversations, type ConversationRef } from '../../lib/conversation-refs'
import {
  causeWords,
  dependsLabel,
  planDoor,
  blockedBy,
  blocksOf,
  childrenOf,
  dropWarnings,
  droppedDependencies,
  dueWords,
  isHumanOwner,
  isYou,
  labelOf,
  labelOfKey,
  noteAuthorWords,
  linkedConversations,
  siblingsOf,
  stallLine,
  stateLabel,
  taskKeyOf,
  taskOfRow,
  taskPage,
  waitCarry,
  withLiveFlow,
  type LinkedConversation,
  type TaskView,
} from '../../lib/tasks'
import { answerKind, answerTask, droppedOf, paintedAsked, reviewWaitsOnYou, stuckWords } from '../../lib/answer-wait'
import { waitOptions } from '../../lib/task-lines'
import { ControlSwitch } from '../agent/ControlSwitch'
import { UnlinkSheet } from './UnlinkSheet'
import { refreshTasks, useTasks } from '../../hooks/useTasks'
import { markTaskSeen, useTaskSeen } from '../../hooks/useTaskSeen'
import { useHeldOrder, useTaskKeys } from '../../hooks/useTaskKeys'
import { engageHold, holdIdOfOrigin, readHold } from '../../lib/held-order'
import { KeyHelp, KeyHint } from './KeyHelp'
import { isNewToYou, newTaskKeys } from '../../lib/task-seen'
import { Progress } from '../PlanView'
import { DropConfirm, LiveMark, NewWord, NoteText, OriginBack, OwnerMark, StallText, TaskGlyph, TaskPeek, useOrigin } from './TaskBits'
import { PageHeader } from '../PageHeader'
import { neighbours, originList, originReadsInbox, taskPageOfKey } from '../../lib/task-origin'
import type { TaskOrigin } from '../../lib/routes'
import { OpeningLine, TaskDoor, WakeHistory, doorPlan, liveWhy, queuedWake, useTaskMode, useTaskOpen } from './TaskMode'
import { TaskLive } from './TaskLive'
import { useBindingAsks } from '../../hooks/useBindingAsks'
import { BindingAskCard } from '../VaultSigning'
import { controlOf, isPhone, surfaceOf, writeVoice } from '../../lib/give'
import { ExecutionRow } from './TaskExecutions'
import { useExecutions } from '../../hooks/useExecutions'
import { executionsOfTask } from '../../lib/executions'
import type { AgentView, InboxRow, SiloRecordDetail, SiloJournalLine, TaskFeedCard } from '../../lib/types'

// what a task's page reads of the list it was opened from
const ONLY_TASKS = { inScope: (k: string): boolean => k.includes('/tasks/') }

type Detail = { state: 'loading' } | { state: 'ready'; d: SiloRecordDetail } | { state: 'missing'; reason: string } | { state: 'error'; error: string }

function useTaskDetail(key: string): [Detail, () => void] {
  const tick = useStore((s) => s.siloTick)
  const [n, setN] = useState(0)
  const [detail, setDetail] = useState<Detail>({ state: 'loading' })
  useEffect(() => {
    let cancelled = false
    api.silos
      .record(PLANS_SILO, key)
      .then((d) => {
        if (!cancelled) setDetail({ state: 'ready', d })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 404) setDetail({ state: 'missing', reason: e.message })
        else setDetail((prev) => (prev.state === 'ready' ? prev : { state: 'error', error: e instanceof Error ? e.message : String(e) }))
      })
    return () => {
      cancelled = true
    }
  }, [key, tick, n])
  return [detail, () => setN((x) => x + 1)]
}

// the record detail → the task the views share (same reader as the list)
function taskOfDetail(d: SiloRecordDetail): TaskView | null {
  if (!d.parent) return null
  return taskOfRow({ ...d.record, parent: d.parent, value: d.value ?? {}, ...(d.flow ? { flow: d.flow } : {}), moved: null })
}

// deliverables: the files the linked conversations wrote (their context's
// writes and edits), the plan file itself left out — read once per page
function useDeliverables(
  convs: readonly LinkedConversation[],
  planFile: string | null,
  server: ReadonlyMap<string, ConversationRef>,
): { state: 'loading' | 'ready'; files: Array<{ path: string; by: string }> } {
  // a conversation the capped list lost still has deliverables: take the
  // server's whereabouts when the list has none
  const ids = convs
    .map((c) => (c.session ? `${c.session.folder}/${c.session.id}` : server.has(c.id) ? `${server.get(c.id)!.folder}/${server.get(c.id)!.sessionId}` : null))
    .filter((x): x is string => x !== null)
    .slice(0, 6)
    .join('|')
  const [out, setOut] = useState<{ state: 'loading' | 'ready'; files: Array<{ path: string; by: string }> }>({ state: 'loading', files: [] })
  useEffect(() => {
    let cancelled = false
    const pairs =
      ids === ''
        ? []
        : ids.split('|').map((p) => {
            const i = p.lastIndexOf('/')
            return [p.slice(0, i), p.slice(i + 1)] as const
          })
    Promise.all(
      pairs.map(([f, id]) =>
        Promise.resolve(api.sessionDetail(f, id, Number.MAX_SAFE_INTEGER))
          .then((r) => ({ id, files: r?.context?.files ?? [] }))
          .catch(() => ({ id, files: [] })),
      ),
    ).then((rs) => {
      if (cancelled) return
      const seen = new Map<string, string>()
      for (const r of rs) for (const f of r.files) if (f.writes + f.edits > 0 && f.path !== planFile && !seen.has(f.path)) seen.set(f.path, r.id)
      setOut({ state: 'ready', files: [...seen].map(([path, by]) => ({ path, by })) })
    })
    return () => {
      cancelled = true
    }
  }, [ids, planFile])
  return out
}

// the server's inbox, when the list a task came from is one of Home's: read
// again whenever its rows can have moved
function useInboxRows(wanted: boolean): InboxRow[] | null {
  const siloTick = useStore((s) => s.siloTick)
  const inboxTick = useStore((s) => s.inboxTick)
  const [rows, setRows] = useState<InboxRow[] | null>(null)
  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    Promise.resolve(api.board())
      .then((b) => {
        if (!cancelled && b) setRows(b.inbox ?? [])
      })
      .catch(() => {
        /* no list to walk: the back link still works */
      })
    return () => {
      cancelled = true
    }
  }, [wanted, siloTick, inboxTick])
  return rows
}

// the task feed: the visible replies of the turns the machinery sent for this
// task — re-read on the page's tick and when a
// working conversation goes quiet (a reply exists only once its turn closed)
function useTaskFeed(key: string, workingNow: boolean): TaskFeedCard[] {
  const tick = useStore((s) => s.siloTick)
  const [items, setItems] = useState<TaskFeedCard[]>([])
  useEffect(() => {
    let cancelled = false
    api
      .tasksFeed(key)
      .then((r) => {
        if (!cancelled) setItems(r.items)
      })
      .catch(() => {
        /* the notes still tell the story */
      })
    return () => {
      cancelled = true
    }
  }, [key, tick, workingNow])
  return items
}

function Section({ title, aside, children, testId }: { title: string; aside?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className="mt-9" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
        <h3 className="font-display text-[16px] text-ink">{title}</h3>
        {aside}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  )
}

const CONV_WORDS: Record<LinkedConversation['state'], string> = { working: 'working', waiting: 'waiting for you', idle: 'done', gone: 'gone' }

// a listed conversation: CURRENT (it holds the task — its live state, and
// «Unlink…» beside it) or history (let go: in ink-3, «unlinked · <date>»)
// — history never blinks and is never the task's life
function ConversationRow({
  c,
  agents,
  now,
  onOpen,
  history = null,
  unlink,
  serverRef = null,
  answered = true,
}: {
  c: LinkedConversation
  agents: readonly AgentView[]
  now: number
  onOpen: () => void
  history?: { at: number | null } | null
  unlink?: React.ReactNode
  serverRef?: ConversationRef | null
  answered?: boolean
}) {
  const a = agents.find((x) => x.id === (c.agentId ?? serverRef?.agentId))
  if (c.session && history) {
    return (
      <li data-testid="task-conversation" data-state="unlinked">
        <button type="button" onClick={onOpen} className="group flex w-full items-center gap-3 rounded-lg py-2 text-left hover:bg-panel/60 sm:px-2 sm:-mx-2">
          <span className="w-[7.5rem] shrink-0 font-mono text-[11px] text-ink-3" data-testid="task-conversation-unlinked">
            unlinked{history.at ? ` · ${new Date(history.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] text-ink-3 group-hover:text-ink-2">{c.session.title || c.id}</span>
            <span className="text-[11.5px] text-ink-3">
              {a ? a.name : 'unassigned'} · {relTime(c.session.mtime, now)}
            </span>
          </span>
          <span className="shrink-0 text-[12px] text-ink-3 group-hover:text-terracotta">Open ›</span>
        </button>
      </li>
    )
  }
  if (!c.session) {
    // the browser's list is CAPPED (overview-cap.ts): absence here is no
    // proof of absence. The server's index was asked (useServerConversations);
    // «gone» is said only once it answered without this id.
    if (serverRef) {
      return (
        <li data-testid="task-conversation" data-state={history ? 'unlinked' : 'resolved'}>
          <button type="button" onClick={onOpen} className="group flex w-full items-center gap-3 rounded-lg py-2 text-left hover:bg-panel/60 sm:px-2 sm:-mx-2">
            <span className={`w-[7.5rem] shrink-0 text-[11px] ${history ? 'font-mono' : ''} text-ink-3`}>
              {history ? `unlinked${history.at ? ` · ${new Date(history.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}` : ''}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[13.5px] ${history ? 'text-ink-3 group-hover:text-ink-2' : 'text-ink'}`}>{serverRef.title || c.id}</span>
              <span className="text-[11.5px] text-ink-3">{a ? a.name : 'unassigned'}</span>
            </span>
            <span className="shrink-0 text-[12px] text-ink-3 group-hover:text-terracotta">Open ›</span>
          </button>
        </li>
      )
    }
    if (!answered) {
      // asked, not answered yet (or the index still warms): no claim either way
      return (
        <li className="flex items-baseline gap-3 py-2 text-[13px] text-ink-3" data-testid="task-conversation" data-state="unresolved">
          <span className="min-w-0 truncate font-mono text-[11px]">{c.id}</span>
        </li>
      )
    }
    return (
      <li className="flex items-baseline gap-3 py-2 text-[13px] text-ink-3" data-testid="task-conversation" data-state="gone">
        <span className="w-[7.5rem] shrink-0 text-[11.5px]">gone</span>
        <span className="min-w-0 truncate font-mono text-[11px]">{c.id}</span>
        <span className="ml-auto text-[11.5px]">Silos no longer has this conversation</span>
      </li>
    )
  }
  return (
    <li data-testid="task-conversation" data-state={c.state}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2 text-left hover:bg-panel/60 sm:px-2 sm:-mx-2"
        >
          <span className="w-[7.5rem] shrink-0">
            {c.state === 'working' ? (
              <LiveMark label="working" />
            ) : c.state === 'waiting' ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-terracotta">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-terracotta" />
                waiting for you
              </span>
            ) : (
              <span className="text-[11.5px] text-ink-3">{CONV_WORDS[c.state]}</span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] text-ink">{c.session.title || c.id}</span>
            <span className="text-[11.5px] text-ink-2">
              {a ? `${a.emoji ? `${a.emoji} ` : ''}${a.name}` : 'unassigned'} · {relTime(c.session.mtime, now)}
            </span>
          </span>
          <span className="shrink-0 text-[12px] text-ink-2 group-hover:text-terracotta">Open ›</span>
        </button>
        {unlink}
      </div>
    </li>
  )
}

interface ActivityItem {
  at: number
  kind: 'note' | 'state' | 'reply'
  by?: string
  fromOwner?: boolean
  text: string
  undated?: boolean
  card?: TaskFeedCard
  readOutside?: string[]
}

// a stable identity per row — `key={i}` made a new card steal another note's
// open «more» (every index shifts when one arrives)
function activityKey(it: ActivityItem): string {
  if (it.kind === 'reply' && it.card) return `r:${it.card.sessionId}:${it.card.at}`
  return `${it.kind === 'note' ? 'n' : 's'}:${it.at}:${it.by ?? ''}:${it.text.slice(0, 24)}`
}

function stateWord(s: string | null | undefined): string {
  return s ? stateLabel(s as PlanStatus).toLowerCase() : 'nothing'
}

function activityOf(t: TaskView, history: readonly SiloJournalLine[]): ActivityItem[] {
  const items: ActivityItem[] = []
  t.notes.forEach((n, i) => {
    const ms = Date.parse(n.at)
    items.push({
      at: Number.isNaN(ms) ? -1 - (t.notes.length - i) : ms,
      kind: 'note',
      by: n.by,
      fromOwner: n.fromOwner,
      text: n.text,
      undated: Number.isNaN(ms),
      ...(n.readOutside ? { readOutside: n.readOutside } : {}),
    })
  })
  for (const l of history) {
    const ms = Date.parse(l.at)
    if (Number.isNaN(ms)) continue
    if (l.event === 'transition') items.push({ at: ms, kind: 'state', text: `${stateWord(l.from)} → ${stateWord(l.to)}` })
    else if (l.event === 'appeared') items.push({ at: ms, kind: 'state', text: `appeared as ${stateWord(l.to)}` })
  }
  return items.sort((a, b) => a.at - b.at)
}

// a long note folds to six lines with its own «more» (a page-long
// agent note was once the first thing a task showed) — short ones render as before
const NOTE_CLAMP_CHARS = 420
function NoteBody({ text, from, onOpen }: { text: string; from: Pick<TaskView, 'planKey' | 'folder'>; onOpen: (t: TaskView) => void }) {
  const [open, setOpen] = useState(false)
  const long = text.length > NOTE_CLAMP_CHARS || text.split('\n').length > 6
  return (
    <>
      <p className={`mt-0.5 max-w-[62ch] whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink ${long && !open ? 'line-clamp-6' : ''}`}>
        <NoteText text={text} from={from} onOpen={onOpen} />
      </p>
      {long ? (
        <button type="button" data-testid="task-note-more" onClick={() => setOpen((v) => !v)} className="mt-0.5 text-[11.5px] text-ink-3 hover:text-terracotta">
          {open ? 'less' : `more (${text.length.toLocaleString('en-US')} chars)`}
        </button>
      ) : null}
    </>
  )
}

// a reply card folds to the turn's LAST visible segment (the answer after the
// tools — the join starts with pre-tool narration and would hide it); «more»
// unfolds the whole visible turn
function ReplyBody({ texts }: { texts: string[] }) {
  const [open, setOpen] = useState(false)
  const last = texts[texts.length - 1] ?? ''
  const whole = texts.join('\n\n')
  const long = texts.length > 1 || last.length > NOTE_CLAMP_CHARS || last.split('\n').length > 6
  return (
    <>
      <p className={`mt-0.5 max-w-[62ch] whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink ${long && !open ? 'line-clamp-6' : ''}`}>
        {open ? whole : last}
      </p>
      {long ? (
        <button
          type="button"
          data-testid="task-reply-more"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-[11.5px] text-ink-3 hover:text-terracotta"
        >
          {open ? 'less' : `more (${whole.length.toLocaleString('en-US')} chars)`}
        </button>
      ) : null}
    </>
  )
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-baseline gap-2 py-1.5">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="min-w-0 text-[12.5px] text-ink">{children}</dd>
    </div>
  )
}

function TaskLink({
  t,
  plan,
  agents,
  now,
  onOpen,
}: {
  t: TaskView
  plan: ReadonlyMap<string, TaskView>
  agents: readonly AgentView[]
  now: number
  onOpen: (t: TaskView) => void
}) {
  return (
    <TaskPeek task={t}>
      <button
        type="button"
        onClick={() => onOpen(t)}
        className="flex min-w-0 max-w-full items-center gap-1.5 text-left hover:text-terracotta"
        data-testid="task-link"
      >
        <TaskGlyph t={t} plan={plan} agents={agents} now={now} />
        <span className="min-w-0 truncate">{t.title}</span>
      </button>
    </TaskPeek>
  )
}

export function TaskPage({ planKey, taskId, from }: { planKey: string; taskId: string; from?: TaskOrigin }) {
  const key = taskKeyOf(planKey, taskId)
  const [detail, reload] = useTaskDetail(key)
  const reading = useTasks()
  const agents = useStore((s) => s.agents)
  const now = useStore((s) => s.nowTick)
  const changePage = useStore((s) => s.changePage)
  const openSession = useStore((s) => s.openSession)
  // the binding this task asks the owner to sign — read only when its
  // wait on the owner carries one
  const signAsk =
    useBindingAsks(reading.tasks.some((x) => x.key === key && x.waitingOn?.owner === 'owner' && x.waitingOn.binding !== undefined)).get(key) ?? null
  const [note, setNote] = useState('')
  // your note, echoed the instant it is sent (the first
  // Send showed nothing near the box, so the owner sent it twice) — dropped
  // from the echo once the re-read brings it back as a real note
  const [justSent, setJustSent] = useState<Array<{ at: string; text: string }>>([])
  // where an «Answer & done» landed — the doors to the tasks it woke (no
  // link led there before)
  const [answeredTo, setAnsweredTo] = useState<Array<{ key: string; owner: string }>>([])
  const [dropping, setDropping] = useState(false)
  // an answer that landed while the task stays stuck (a dropped dependency)
  const [answerSaid, setAnswerSaid] = useState<string | null>(null)
  // «Unlink…» open on one current conversation, and what the server said
  const [unlinking, setUnlinking] = useState<string | null>(null)
  const [unlinked, setUnlinked] = useState<string | null>(null)
  // «Start X ›»: the server's answer when nothing was queued
  const [waking, setWaking] = useState<{ busy: boolean; said: string | null }>({ busy: false, said: null })
  const [parking, setParking] = useState<string | null>(null)
  // «Give to… ›» open, and what it did once given
  const [giving, setGiving] = useState(false)
  const [handed, setHanded] = useState<{ said: string } | null>(null)
  const origin0 = useOriginOutside(key)
  const [busy, setBusy] = useState(false)
  // a refused gesture, said beside the control that caused it: the
  // owner's actions, the dropped-blocker banner, Resume, the note box
  type Place = 'actions' | 'banner' | 'box' | 'resume' | 'hand'
  const [actionError, setActionError] = useState<{ at: Place; text: string } | null>(null)

  const d = detail.state === 'ready' ? detail.d : null
  // the page's task: the record's own reading (fresh), else the list's
  // the census's live facts over the kernel's read (lib/tasks.ts withLiveFlow)
  const all = useMemo(() => withLiveFlow(reading.tasks, agents, now), [reading.tasks, agents, now])
  const listed = all.find((x) => x.key === key) ?? null
  const read = d ? taskOfDetail(d) : null
  const t = useMemo(() => (read ? withLiveFlow([read, ...all.filter((x) => x.key !== read.key)], agents, now)[0]! : listed), [read, all, listed, agents, now])
  const plan = useMemo(() => siblingsOf(all, planKey), [all, planKey])
  const convs = useMemo(() => (t ? linkedConversations(t, agents, now) : []), [t, agents, now])
  // the life of the task is its CURRENT conversations only: a thread
  // it let go may be working on something else — never «working on it now»
  const currentSet = useMemo(() => new Set(t?.currentConversations ?? []), [t])
  const liveConvs = useMemo(() => convs.filter((c) => currentSet.has(c.id)), [convs, currentSet])
  const feed = useTaskFeed(
    key,
    liveConvs.some((c) => c.state === 'working'),
  )
  // ids the capped overview did not carry: ask the server before any row
  // says «gone» (overview-cap.ts trims 30 task-born conversations per agent)
  const unresolvedIds = useMemo(() => convs.filter((c) => !c.session).map((c) => c.id), [convs])
  const warming = useStore((s) => s.warming)
  const server = useServerConversations(unresolvedIds, warming)
  const whereIs = (id: string): { folder: string; id: string } | null => {
    const c = convs.find((x) => x.id === id)
    if (c?.session) return { folder: c.session.folder, id: c.session.id }
    const r = server.refs.get(id)
    return r ? { folder: r.folder, id: r.sessionId } : null
  }
  const deliverables = useDeliverables(convs, t?.file ?? null, server.refs)
  const mode = useTaskMode(key)
  // going in (the door, «Send and open ›»): one opener for the page
  const opener = useTaskOpen({
    taskKey: key,
    name: agents.find((a) => a.id === t?.owner)?.name ?? t?.owner ?? '',
    conversations: t?.conversations ?? [],
    onDone: () => {
      refreshTasks()
      reload()
      mode.reload()
    },
  })
  // the SDD executions hung from this task (the Executions silo)
  const execReading = useExecutions()
  const executions = useMemo(() => executionsOfTask(execReading.executions, key), [execReading.executions, key])

  // looking at it is what clears «new to you», on open and while it stays open
  const book = useTaskSeen()
  const isNew = t !== null && book !== null && isNewToYou(t, book, new Set(agents.map((a) => a.id)))
  useEffect(() => {
    if (isNew && t) markTaskSeen(key, t.state)
  }, [isNew, key, t])

  // where it came from: the way back, the list to walk
  const origin = useOrigin(from)
  const inbox = useInboxRows(originReadsInbox(from))
  // the list holds still while it is walked; only a task's keys are this page's
  // to speak about (Needs you holds other rows too)
  const holdId = holdIdOfOrigin(from)
  const list = useMemo(() => (reading.state === 'ready' ? originList(from, { all, inbox, agents, now }) : null), [reading.state, from, all, inbox, agents, now])
  // starting here holds it; opening another task of it is a touch, a mere redraw is not
  const hold = holdId && list ? (readHold(holdId, Date.now()) ?? engageHold(holdId, list, Date.now())) : null
  if (hold) hold.cursor = key
  useEffect(() => {
    if (holdId && hold) engageHold(holdId, [], Date.now())
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const held = useHeldOrder(list ? holdId : null, list ?? [], ONLY_TASKS)
  const walked = useMemo(() => (list ? held.keys.filter((k) => ONLY_TASKS.inScope(k)) : null), [list, held.keys])
  const walk = useMemo(() => neighbours(walked, key), [walked, key])
  const openKey = (k: string | null): void => {
    const p = k ? taskPageOfKey(k) : null
    if (p) changePage({ ...p, ...(from ? { from } : {}) })
  }
  const openTask = (x: TaskView): void => changePage({ ...taskPage(x), ...(from ? { from } : {}) })
  const back = origin.go
  // Esc returns to the origin; [ ] and j k walk its list; d settles a task of the
  // owner's; n opens the note — never while typing or under something (useTaskKeys).
  // A key here counts as the keyboard's walk: back on the list its cursor is waiting.
  const noteBox = useRef<HTMLTextAreaElement>(null)
  const settle = useRef<(() => void) | null>(null)
  settle.current = null
  const byKeyboard = (): void => {
    if (hold) hold.keyboard = true
  }
  const keys = useTaskKeys('page', {
    back: () => {
      byKeyboard()
      back()
    },
    next: () => {
      if (!walk?.next) return false
      byKeyboard()
      openKey(walk.next)
      return true
    },
    prev: () => {
      if (!walk?.prev) return false
      byKeyboard()
      openKey(walk.prev)
      return true
    },
    done: () => {
      if (!settle.current) return false
      byKeyboard()
      settle.current()
      return true
    },
    note: () => {
      const box = noteBox.current
      if (!box) return false
      box.focus({ preventScroll: true })
      box.scrollIntoView({ block: 'center' })
      return true
    },
  })

  if (!t) {
    // the project a link's plan key names (folder:<project>/<plan>): its
    // tasks are the door when the task itself is gone
    const place = planKey.startsWith('folder:') ? planKey.slice('folder:'.length) : null
    const missingFolder = place && place.lastIndexOf('/') > 0 ? place.slice(0, place.lastIndexOf('/')) : null
    return (
      <div className="flex flex-1 flex-col overflow-y-auto px-5 pt-5 sm:px-8">
        <OriginBack words={origin.words} onBack={back} testId="task-back" />
        <p className="mt-6 max-w-[62ch] text-[13.5px] text-ink-2" data-testid="task-missing">
          {detail.state === 'loading' ? (
            'Reading the task…'
          ) : detail.state === 'missing' ? (
            <>
              No task <span className="font-mono text-[12px]">{labelOfKey(all, `${planKey}/tasks/${taskId}`)}</span> — nothing Silos reads has it now.
              {missingFolder ? (
                <>
                  {' '}
                  <button
                    type="button"
                    data-testid="task-missing-door"
                    onClick={() => changePage({ kind: 'tasks', view: 'open', project: [missingFolder] })}
                    className="text-ink underline decoration-line underline-offset-2 hover:text-terracotta"
                  >
                    Open {basename(missingFolder)}&rsquo;s tasks ›
                  </button>
                </>
              ) : null}
            </>
          ) : detail.state === 'error' ? (
            <span role="alert" className="text-terracotta">
              The task could not be read: {detail.error}
            </span>
          ) : null}
        </p>
      </div>
    )
  }

  // a plan is a PLACE, not a file: its crumb opens its house
  // — its tasks in Tasks (planHouse, the same door everywhere); the JSON
  // underneath is an «Open file» sheet, secondary. A CLOSED plan's tasks are
  // in no list (the reader leaves plans/closed/ out), so Tasks would show it
  // empty: its read-only file is all there is of it, and the crumb says so
  const openPlanView = (): void => {
    const door = planDoor({ key: t.planKey, file: t.file, closed: d?.closed === true })
    if (door) openPlanDoor(door, changePage)
  }
  const finished = isFinished(t.state)
  // dropped is the STATE (cancelled), never read from the notes
  const dropped = t.state === 'cancelled'
  // the dependencies that were dropped — they never resolve; this page is
  // where the owner removes them or reopens them
  const dead = droppedDependencies(t, plan)
  const kids = childrenOf(t, all)
  const freshKids = book ? newTaskKeys(kids, book, new Set(agents.map((a) => a.id))) : new Set<string>()
  const blocks = blocksOf(t, all)
  const stuckOn = blockedBy(t, plan)
  // the task it waits on is not untouched: its agent opens with you, and it
  // lives in Start, not in Untouched — the banner says THAT, with its door
  const waitsStart = stuckOn !== null && plan.get(stuckOn.id)?.flow?.waitsStart === true
  const cause = !finished && t.flow?.stalled ? t.flow.stalledCause : null
  const writer = d?.writtenBy?.[0] ?? null
  const writers = [...new Set((d?.writtenBy ?? []).map((w) => w.agentId))].map((id) => agents.find((a) => a.id === id)?.name ?? id)
  const version = d?.version ?? null
  const canWrite = d !== null && version !== null && d.outside !== true
  const due = dueWords(t.due, now)
  const history = d?.history ?? []
  // the echo rows: only the sent notes the re-read has not brought back yet
  const echo = justSent.filter((s) => !t.notes.some((n) => (n.fromOwner || n.by === 'owner') && n.text === s.text))
  // ONE chronological feed: notes, state changes and the agents' replies —
  // sorted as a whole (the echo rows used to land after the sort and could
  // sit below the reply that answers them)
  const activity = [
    ...activityOf(t, history),
    ...echo.map((s) => ({ at: Date.parse(s.at), kind: 'note' as const, by: 'owner', fromOwner: true, text: s.text, undated: false })),
    ...feed.map((c) => ({ at: Date.parse(c.at) || 0, kind: 'reply' as const, by: c.agent ?? '', text: c.texts[c.texts.length - 1] ?? '', card: c })),
  ].sort((a, b) => a.at - b.at)
  const notesAppend = d?.children.find((c) => c.collection === 'notes')?.append
  const ownerAgent = agents.find((a) => a.id === t.owner)
  const inTaskMode = mode.view?.bound === true && ownerAgent !== undefined
  // the task's ONE door, for ANY agent owner; on
  // the owner's own task there is none (Done / Done and next below). While
  // DEPENDENCIES hold the task it stays, but quiet — no push on a task that
  // admits no work yet; a stalled one keeps it primary
  const work = !finished && ownerAgent && mode.view ? <TaskDoor owner={ownerAgent} door={mode.view.door} opener={opener} quiet={t.state === 'blocked'} /> : null
  // how its agent moves (the server's derived control) and where Open goes
  const control = controlOf(ownerAgent)
  const surface = surfaceOf({ hasConsole: mode.view?.door?.hasConsole === true, consoleBriefs: mode.view?.door?.consoleBriefs !== false })
  const phone = isPhone()

  async function write(fn: () => Promise<unknown>, at: Place = 'actions'): Promise<void> {
    setBusy(true)
    setActionError(null)
    try {
      await fn()
      refreshTasks()
      reload()
    } catch (e) {
      // a plain note's CAS (someone wrote the plan first) — every gesture
      // speaks in its own words («it asks something else now»)
      const text =
        e instanceof ApiError && e.status === 409 && e.message.startsWith('the record changed')
          ? 'Someone wrote this plan first — it was read again; try once more'
          : actError(e)
      setActionError({ at, text: text.charAt(0).toUpperCase() + text.slice(1) })
      refreshTasks()
      reload()
    } finally {
      setBusy(false)
    }
  }
  const errorAt = (at: Place) =>
    actionError?.at === at ? (
      <p role="alert" data-testid="task-action-error" className="text-[12px] text-terracotta">
        {actionError.text}
        {/[.!?]$/.test(actionError.text) ? '' : '.'}
      </p>
    ) : null
  // the next one on the list, for a task that is the owner's to settle
  const nextOne = walk?.next && !finished && isHumanOwner(t.owner, new Set(agents.map((a) => a.id))) ? walk.next : null
  // every gesture below is ONE write of the owner's verb (act), with the
  // state this page painted — the server judges it on the file as it is now
  const doneAndNext = (): Promise<void> =>
    write(async () => {
      await act(key, 'done', { state: t.state })
      openKey(nextOne)
    })
  const doneIt = (): Promise<void> => write(() => act(key, 'done', { state: t.state }))
  // d: the same verb as the button beside it, and only on what the owner holds
  if (canWrite && !finished && !busy && !dropping && isHumanOwner(t.owner, new Set(agents.map((a) => a.id)))) {
    settle.current = () => {
      void (nextOne ? doneAndNext() : doneIt())
    }
  }
  const addNote = (text: string): Promise<unknown> =>
    api.silos.append(PLANS_SILO, { key, collection: 'notes', values: { text }, ...(version ? { version } : {}) })
  // Drop: «Dropped: <why>» and cancelled — finished, but it resolves no
  // dependency (plans 0.5.3) — in one write
  const drop = (reason: string): Promise<void> =>
    write(async () => {
      await act(key, 'drop', { state: t.state, text: reason })
      setDropping(false)
    })
  // Reopen: the server sets it back to the state it is really in (blocked
  // while something holds it, else pending — task-flow.ts blockedHolds)
  const reopenTask = (b: TaskView, at: Place = 'actions'): Promise<void> => write(() => act(b.key, 'reopen'), at)
  // a dropped dependency's two ways out, on the DEPENDENT's page:
  // remove it from dependsOn — and, when nothing else holds the task, back
  // to pending, in the same write —, or reopen the dropped task itself
  const removeDependency = (id: string): Promise<void> => write(() => act(key, 'remove-dependency', { dep: id }), 'banner')
  // Park on a task of yours: its next check AND «Parked until
  // <day>.»; «Not now — until <date>» on an AGENT's task: the
  // check alone — the server leaves the note out (it would wake a bound one)
  const park = (day: string): Promise<void> =>
    write(async () => {
      await act(key, 'park', { until: new Date(`${day}T09:00:00`).toISOString(), day })
      setParking(null)
    })
  // Give to…: ONE write of the owner's verb, with what this page
  // painted — the owner, the state, and whether it said «added outside
  // Silos»; then the page says what happened (started, or why not;
  // «Open Y ›» for one that opens with you)
  const give = (to: { id: string; name: string; wakes: 'task' | 'never' | null }): Promise<void> =>
    write(async () => {
      const r = await act(key, 'hand', { to: to.id, owner: t.owner, state: t.state, outside: origin0.outside })
      setGiving(false)
      setHanded({ said: handedWords(to.name, to.id, r.assign) })
      if (r.blessed) origin0.kept()
      mode.reload()
    }, 'hand')

  const queued = !finished && inTaskMode ? queuedWake(mode.view) : null
  // whose turn it is, said at the top (the page opened with
  // machinery — nothing answered «where am I supposed to answer?»)
  const agentIdSet = new Set(agents.map((a) => a.id))
  const unblocksWords = (() => {
    const u = t.flow?.unblocks ?? []
    if (u.length === 0) return null
    const names = [...new Set(u.map((x) => agents.find((a) => a.id === x.owner)?.name ?? x.owner))]
    return `finishing it unblocks ${u.length === 1 ? '1 task' : `${u.length} tasks`} of ${names.join(' and ')}`
  })()
  // where the owner writes (give.ts writeVoice): the
  // box says what a note does on THIS task, by its agent's control — `own`:
  // the note wakes it (an owner-note wake, never held by a ceiling); `told`:
  // the note stays and X reads it in its next conversation, «Send and open ›»
  // goes in with it; held: the note waits, said in the box with «Open ›» —
  // and on a closed task the note reopens it. Yours: a note for the record.
  // something would hold the wake RIGHT NOW (a live turn, an open console)
  const heldNote = ownerAgent && control === 'own' ? (mode.view?.heldNow ?? null) : null
  const voice = writeVoice({ name: ownerAgent?.name ?? null, control, finished, held: heldNote, mobile: phone })
  // the live line above already says why it waits: the box says only what
  // that means for the note (said once at rest)
  const heldSaid = heldNote !== null && mode.view?.live != null && heldNote === liveWhy(mode.view)
  const heldHelper = heldNote
    ? heldSaid
      ? 'Your note is kept and lands at its next turn.'
      : `${heldNote[0]!.toUpperCase()}${heldNote.slice(1)} — your note is kept and lands at its next turn.`
    : null
  const yoursHelper =
    !ownerAgent && !finished && unblocksWords
      ? 'Notes here are the task’s memory. To answer the agents waiting on this, Answer & done sends your text to them and closes it in one gesture.'
      : null
  // what an answer IS here — the ONE pure choice the label comes from too
  // (lib/answer-wait.ts answerKind): a gate of yours answers-and-closes
  const answerAndDone = !finished && canWrite && answerKind(t, agentIdSet) === 'gate'
  // while the task waits on YOU (not Silos' own nudge) the box IS the answer:
  // the note, the wait out and the state, one write — on an agent's
  // review it is «Send back», beside «Approve»
  const shownWait = t.flow?.waitsOn !== undefined ? t.flow.waitsOn : t.waitingOn
  const answering = !finished && canWrite && !answerAndDone && shownWait?.owner === 'owner' && !shownWait.action.startsWith('unstick ')
  const reviewing = answering && reviewWaitsOnYou(t, agentIdSet)
  const ownerName = ownerAgent?.name ?? t.owner
  // the PRIMARY gesture of the box: on a gate of
  // yours it answers-and-closes; on a wait on you it answers; on an agent's
  // task it sends; only the pure-record case keeps a quiet «Add note».
  const waiterNames = [...new Set((t.flow?.unblocks ?? []).map((x) => agents.find((a) => a.id === x.owner)?.name ?? x.owner))].join(' and ')
  const boxVoice = answerAndDone
    ? {
        placeholder: waiterNames !== '' ? `Your answer — it lands on ${waiterNames} and closes this task` : 'Your answer — it closes this task',
        button: 'Answer & done',
        reaches: true,
        helper: 'Answer & done sends your text to the agents waiting on this and closes it. Add note keeps it open.',
        secondary: null as string | null,
      }
    : answering
      ? {
          placeholder: reviewing ? `What to change — it goes back to ${ownerName}` : `Your answer to ${ownerName}`,
          button: reviewing ? 'Send back' : 'Answer',
          reaches: true,
          helper: reviewing ? `Approve closes it; Send back returns it to ${ownerName} with your words.` : heldHelper,
          secondary: voice.secondary ? (reviewing ? 'Send back and open ›' : 'Answer and open ›') : null,
        }
      : {
          placeholder: heldSaid && ownerAgent ? `Write to ${ownerAgent.name}` : voice.placeholder,
          button: voice.primary,
          reaches: voice.primary === 'Send',
          helper: heldHelper ?? yoursHelper,
          secondary: voice.secondary,
        }
  // «Start X ›» — the owner's gesture on a task of an agent On its own (POST
  // /api/tasks/assign: it skips the ceiling and the throttle, never the live
  // caps, where it queues ahead of what Silos inferred). The live line
  // says what happens next; a refusal is said here in the server's words
  const startIt = async (): Promise<void> => {
    setWaking({ busy: true, said: null })
    try {
      const r = await api.tasksAssign(key)
      setWaking({ busy: false, said: r.queued ? null : (r.why ?? 'nothing was queued') })
      mode.reload()
      refreshTasks()
    } catch (e) {
      setWaking({ busy: false, said: e instanceof Error ? e.message : String(e) })
    }
  }
  // the banner's gesture on a task nobody is on: Start = without you (own),
  // Open = you go in (told) — the surface named on the button
  const startOrOpen = ownerAgent
    ? control === 'own'
      ? { testId: 'task-start-it', label: waking.busy ? `Starting ${ownerAgent.name}…` : `Start ${ownerAgent.name} ›`, run: () => void startIt() }
      : {
          testId: 'task-open-it',
          label: doorPlan({ name: ownerAgent.name, door: mode.view?.door }).label,
          run: () => {
            const p = doorPlan({ name: ownerAgent.name, door: mode.view?.door })
            void (p.kind === 'open' ? opener.open(p.to) : opener.go(p.mode))
          },
        }
    : null
  const startButton = startOrOpen ? (
    <button
      type="button"
      data-testid={startOrOpen.testId}
      disabled={waking.busy || opener.o.state === 'opening'}
      onClick={startOrOpen.run}
      className="rounded-full border border-terracotta/40 bg-terracotta-soft px-2.5 py-0.5 text-[12px] font-medium text-terracotta enabled:hover:border-terracotta disabled:opacity-60"
    >
      {startOrOpen.label}
    </button>
  ) : null
  // the last current conversation it was in, for «Nobody works it now — last in «…»»
  const lastConv = [...convs].filter((c) => c.session).sort((a, b) => b.session!.mtime - a.session!.mtime)[0] ?? null
  // the dropped blocker this page can act on: a direct dependency (both ways
  // out), or the kernel's first stuck task down the chain (reopen only)
  const deadHere = dead[0] ?? null
  const deadBelow = !deadHere && cause === 'blocker-cancelled' && stuckOn?.key ? (plan.get(stuckOn.id) ?? null) : null
  const deadOne = deadHere ?? deadBelow
  const banner =
    !finished && deadOne ? (
      <div
        data-testid="task-banner"
        data-kind="dropped-blocker"
        className="mt-4 rounded-lg border border-[color-mix(in_srgb,var(--health-amber)_35%,transparent)] bg-[color-mix(in_srgb,var(--health-amber)_7%,transparent)] px-3.5 py-2.5 text-[13px]"
      >
        <StallText>
          <span className="font-medium">Blocked</span> — it waits on a dropped task
        </StallText>
        <div className="mt-1 text-ink-2">
          {deadHere ? 'It waits on ' : 'Down the chain, a task waits on '}
          <TaskPeek task={deadOne}>
            <button type="button" onClick={() => openTask(deadOne)} className="text-ink underline underline-offset-2 hover:text-terracotta">
              {deadOne.label} {deadOne.title}
            </button>
          </TaskPeek>
          {dead.length > 1 ? ` and ${dead.length - 1} more` : ''}, which was dropped — that never resolves.
        </div>
        {canWrite ? (
          <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="task-dropped-exits">
            {deadHere ? (
              <button
                type="button"
                disabled={busy}
                data-testid="task-remove-dependency"
                onClick={() => void removeDependency(deadHere.id)}
                title={`Take ${deadHere.label} out of what this task waits on`}
                className="rounded-full border border-terracotta/40 bg-terracotta-soft px-2.5 py-0.5 text-[12px] font-medium text-terracotta enabled:hover:border-terracotta disabled:opacity-50"
              >
                Remove the dependency
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              data-testid="task-reopen-dependency"
              onClick={() => void reopenTask(deadOne, 'banner')}
              title={`Reopen ${deadOne.label} — this task waits on it again`}
              className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-ink hover:border-terracotta hover:text-terracotta disabled:opacity-50"
            >
              Reopen {deadOne.label}
            </button>
          </div>
        ) : null}
        {errorAt('banner')}
      </div>
    ) : cause && queued ? (
      <div data-testid="task-banner" data-kind="waking" className="mt-4 rounded-lg border border-line bg-panel/60 px-3.5 py-2.5 text-[13px] text-ink-2">
        {/* the headline keeps the reason; where the wake stands is said once —
          by the live line under it, else by its row in Wakes */}
        <span className="font-medium text-ink">Waking {ownerAgent?.name ?? t.owner}</span> — {causeWords(t)}
      </div>
    ) : !finished && t.flow?.idle && ownerAgent && !queued ? (
      // ready and nobody on it: its owner is an agent Silos wakes, and
      // no wake is on its way — the gesture, beside the door
      <div
        data-testid="task-banner"
        data-kind="idle"
        className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-panel/60 px-3.5 py-2.5 text-[13px]"
      >
        <span data-testid="task-turn-sentence">
          <span className="font-medium text-ink">Not started</span>
          <span className="text-ink-2">
            {' '}
            — nobody is on it
            {lastConv?.session ? (
              <>
                ; last in «{lastConv.session.title || 'a conversation'}» {relTime(lastConv.session.mtime, now)}
              </>
            ) : null}
            .
          </span>
        </span>
        {startButton}
        {waking.said ? (
          <span role="status" data-testid="task-start-why" className="basis-full text-[12px] text-ink-2">
            {waking.said.charAt(0).toUpperCase()}
            {waking.said.slice(1)}.
          </span>
        ) : null}
      </div>
    ) : cause ? (
      <div
        data-testid="task-banner"
        data-kind="stalled"
        className="mt-4 rounded-lg border border-[color-mix(in_srgb,var(--health-amber)_35%,transparent)] bg-[color-mix(in_srgb,var(--health-amber)_7%,transparent)] px-3.5 py-2.5 text-[13px]"
      >
        <StallText>
          <span className="font-medium">{cause === 'blocker-cancelled' ? 'Blocked' : waitsStart ? 'Waits' : 'Sits untouched'}</span> —{' '}
          {waitsStart ? 'on a task that is not started: its agent opens with you' : causeWords(t)}
        </StallText>
        {stuckOn ? (
          <div className="mt-1 text-ink-2">
            {waitsStart ? 'The task to start is' : 'The first untouched task down the chain is'}{' '}
            {stuckOn.key ? (
              <TaskPeek task={plan.get(stuckOn.id)}>
                <button
                  type="button"
                  onClick={() => {
                    const b = plan.get(stuckOn.id)
                    if (b) openTask(b)
                  }}
                  className="text-ink underline underline-offset-2 hover:text-terracotta"
                >
                  {stuckOn.ref}
                  {stuckOn.title ? ` ${stuckOn.title}` : ''}
                </button>
              </TaskPeek>
            ) : (
              <span className="font-mono text-[12px]">{stuckOn.ref} (no such task in its plan)</span>
            )}
            .
          </div>
        ) : null}
      </div>
    ) : !finished && t.turn && t.turn.sentence !== '' && t.turn.kind !== 'done' && t.turn.kind !== 'stalled' ? (
      // the SERVER's one sentence (silos/turn.ts): the page says what
      // the rows and the digest say, so they cannot drift apart — the web
      // composes no second sentence of its own
      (() => {
        const s = t.turn.sentence
        const i = s.indexOf(' — ')
        const head = i > 0 ? s.slice(0, i) : null
        const rest = i > 0 ? s.slice(i) : s
        const kind = t.turn.kind
        return (
          <div
            data-testid="task-banner"
            data-kind={kind === 'yours' ? 'your-turn' : kind === 'theirs' ? 'their-turn' : kind === 'start' ? 'waits-start' : kind}
            className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-panel/60 px-3.5 py-2.5 text-[13px]"
          >
            <span data-testid="task-turn-sentence">
              {head ? (
                <>
                  <span className={kind === 'yours' || kind === 'start' ? 'font-medium text-terracotta' : 'font-medium text-ink'}>{head}</span>
                  <span className="text-ink-2">{rest}</span>
                </>
              ) : (
                <span className={kind === 'start' ? 'text-ink' : 'text-ink-2'}>{s}</span>
              )}
            </span>
            {kind === 'idle' && ownerAgent ? startButton : null}
            {kind === 'idle' && waking.said ? (
              <span role="status" data-testid="task-start-why" className="basis-full text-[12px] text-ink-2">
                {waking.said.charAt(0).toUpperCase()}
                {waking.said.slice(1)}.
              </span>
            ) : null}
            {kind === 'parked' && canWrite ? (
              <button
                type="button"
                disabled={busy}
                data-testid="task-resume"
                onClick={() => void write(() => act(key, 'resume'), 'resume')}
                className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-ink hover:border-terracotta hover:text-terracotta disabled:opacity-50"
              >
                Resume — back into Needs you
              </button>
            ) : null}
            {kind === 'parked' && actionError?.at === 'resume' ? <span className="basis-full">{errorAt('resume')}</span> : null}
          </div>
        )
      })()
    ) : null

  const ownerActions = canWrite ? (
    <div className="flex flex-wrap items-center gap-2" data-testid="task-actions">
      {finished ? (
        <button
          type="button"
          disabled={busy}
          data-testid="task-reopen"
          onClick={() => void reopenTask(t)}
          className="rounded-full border border-line px-3 py-1 text-[12px] text-ink-2 hover:border-ink-3 hover:text-ink disabled:opacity-50"
        >
          Reopen
        </button>
      ) : dropping ? (
        // what it leaves hanging is said BEFORE the Drop
        <DropConfirm
          testId="task-drop-confirm"
          busy={busy}
          warnings={dropWarnings(t, all, agents, now)}
          onDrop={(reason) => void drop(reason)}
          onCancel={() => setDropping(false)}
        />
      ) : giving && mode.view?.handTo ? (
        <GiveTo
          handTo={mode.view.handTo}
          outside={origin0.outside}
          busy={busy}
          onGive={(to) => void give(to)}
          onCancel={() => setGiving(false)}
          error={errorAt('hand')}
        />
      ) : parking !== null ? (
        <form
          className="flex w-full flex-wrap items-center gap-2"
          data-testid={ownerAgent ? 'task-not-now-form' : undefined}
          onSubmit={(e) => {
            e.preventDefault()
            if (parking) void park(parking)
          }}
        >
          <label className="text-[12px] text-ink-2" htmlFor="task-park-date">
            {ownerAgent ? 'Not now — until' : 'Out of Needs you until'}
          </label>
          <input
            id="task-park-date"
            autoFocus
            type="date"
            value={parking}
            min={new Date(now).toISOString().slice(0, 10)}
            onChange={(e) => setParking(e.target.value)}
            aria-label={ownerAgent ? 'Not now — until' : 'Parked until'}
            className="rounded-md border border-line bg-canvas px-2 py-1 text-[12.5px] outline-none focus:border-terracotta"
          />
          {ownerAgent ? (
            <span className="text-[11.5px] text-ink-3">
              {mode.view?.wakes === 'task' ? `then Silos wakes ${ownerAgent.name} on it` : "then it's back with you to start"}
            </span>
          ) : null}
          <button
            type="submit"
            disabled={busy || parking === ''}
            className="rounded-full border border-line px-3 py-1 text-[12px] text-ink hover:border-ink-3 disabled:opacity-50"
          >
            {ownerAgent ? 'Not now' : 'Park'}
          </button>
          <button type="button" onClick={() => setParking(null)} className="text-[12px] text-ink-3 hover:text-ink">
            Cancel
          </button>
        </form>
      ) : (
        <>
          {nextOne ? (
            <>
              <button
                type="button"
                disabled={busy}
                data-testid="task-done-next"
                onClick={() => void doneAndNext()}
                className="rounded-full border border-terracotta/40 bg-terracotta-soft px-3 py-1 text-[12px] font-medium text-terracotta hover:border-terracotta disabled:opacity-50"
              >
                Done and next
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void doneIt()}
                className="rounded-full px-2 py-1 text-[12px] text-ink-2 hover:text-ink disabled:opacity-50"
              >
                Done
              </button>
            </>
          ) : isHumanOwner(t.owner, agentIdSet) ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void doneIt()}
              className="rounded-full border border-terracotta/40 bg-terracotta-soft px-3 py-1 text-[12px] font-medium text-terracotta hover:border-terracotta disabled:opacity-50"
            >
              Done
            </button>
          ) : (
            // on an agent's task Done is an operator override, never the main
            // move — quiet, beside Drop
            <button
              type="button"
              disabled={busy}
              onClick={() => void doneIt()}
              className="rounded-full px-2 py-1 text-[12px] text-ink-2 hover:text-ink disabled:opacity-50"
            >
              Done
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setDropping(true)}
            className="rounded-full px-2 py-1 text-[12px] text-ink-2 hover:text-ink disabled:opacity-50"
          >
            Drop…
          </button>
          {mode.view?.handTo ? (
            <button
              type="button"
              disabled={busy}
              data-testid="task-give-to-open"
              onClick={() => {
                setHanded(null)
                setGiving(true)
              }}
              className="rounded-full px-2 py-1 text-[12px] text-ink-2 hover:text-ink disabled:opacity-50"
            >
              Give to… ›
            </button>
          ) : null}
          {/* parking is the owner's gesture on THEIR task — an
              agent's next check is the agent's own; one park at a time */}
          {isHumanOwner(t.owner, agentIdSet) && !(t.nextCheckAt && Date.parse(t.nextCheckAt) > now) ? (
            <button
              type="button"
              disabled={busy}
              data-testid="task-park"
              onClick={() => setParking(new Date(now + 7 * 86_400_000).toISOString().slice(0, 10))}
              className="rounded-full px-2 py-1 text-[12px] text-ink-2 hover:text-ink disabled:opacity-50"
            >
              Park until…
            </button>
          ) : ownerAgent && t.state === 'pending' && !t.waitingOn && !(t.nextCheckAt && Date.parse(t.nextCheckAt) > now) ? (
            // an agent's task that can wait: later, on a date — never a
            // «Start X» invitation for work that is for later
            <button
              type="button"
              disabled={busy}
              data-testid="task-not-now"
              onClick={() => setParking(new Date(now + 7 * 86_400_000).toISOString().slice(0, 10))}
              className="rounded-full px-2 py-1 text-[12px] text-ink-2 hover:text-ink disabled:opacity-50"
            >
              Not now — until…
            </button>
          ) : null}
        </>
      )}
      {actionError?.at === 'actions' ? <span className="basis-full">{errorAt('actions')}</span> : null}
      {handed && !giving ? (
        // what happened, in words only: «Given to X — it opens with you» — the
        // page's own door (TaskDoor, «Open chat ›») is the one way in
        <p role="status" data-testid="task-handed" className="basis-full text-[12.5px] text-ink-2">
          {handed.said}
        </p>
      ) : null}
    </div>
  ) : d?.closed ? (
    <p data-testid="task-closed" className="text-[12px] text-ink-3">
      Its plan is closed (plans/closed/) — read only.
    </p>
  ) : d?.outside ? (
    <p className="text-[12px] text-ink-3">This plan lives outside Silos&apos; projects — open its file to change it.</p>
  ) : null
  const actions =
    work || ownerActions ? (
      <div className="flex flex-col gap-3">
        {work}
        {ownerActions}
      </div>
    ) : null

  const link = (x: TaskView) => <TaskLink t={x} plan={plan} agents={agents} now={now} onOpen={openTask} />
  const carry = finished ? null : waitCarry(t)
  const props = (
    <dl className="divide-y divide-line/60" data-testid="task-props">
      <Prop label="State">
        {/* which blocked it is lives in the turn banner — said once at rest */}
        <span className="inline-flex items-center gap-1.5">
          <TaskGlyph t={t} plan={plan} agents={agents} now={now} />
          {dropped ? 'dropped' : t.stateLabel.replace('_', ' ')}
        </span>
      </Prop>
      <Prop label="Owner">
        <OwnerMark owner={t.owner} agents={agents} />
      </Prop>
      {/* the project's list has no name: a task in it has no plan to say */}
      {t.standingList ? null : (
        <Prop label="Plan">
          <button type="button" onClick={openPlanView} className="text-left hover:text-terracotta">
            {t.planTitle}
          </button>
          {t.file ? (
            <>
              {' '}
              <button
                type="button"
                data-testid="plan-source"
                onClick={() => openFileViewer(t.file!)}
                title={t.file}
                className="text-[11px] text-ink-3 hover:text-terracotta"
              >
                Open file
              </button>
            </>
          ) : null}
        </Prop>
      )}
      {t.parent ? (
        <Prop label="Parent">
          {plan.get(t.parent) ? link(plan.get(t.parent)!) : <span className="font-mono text-[11.5px] text-ink-3">{labelOf(t, t.parent)}</span>}
        </Prop>
      ) : null}
      {t.dependsOn.length > 0 ? (
        <Prop label={dependsLabel(t)}>
          <ul className="flex flex-col gap-1">
            {t.dependsOn.map((id) => (
              <li key={id}>
                {plan.get(id) ? link(plan.get(id)!) : <span className="font-mono text-[11.5px] text-ink-3">{labelOf(t, id)} — no such task</span>}
              </li>
            ))}
          </ul>
        </Prop>
      ) : null}
      {blocks.length > 0 ? (
        <Prop label="Blocks">
          <ul className="flex flex-col gap-1">
            {blocks.map((b) => (
              <li key={b.key}>{link(b)}</li>
            ))}
          </ul>
        </Prop>
      ) : null}
      {t.waitingOn ? (
        <Prop label="Waiting on">
          {isYou(t.waitingOn.owner) ? 'you' : (agents.find((a) => a.id === t.waitingOn!.owner)?.name ?? t.waitingOn.owner)}
          {t.waitingOn.action ? <span className="text-ink-2"> — {t.waitingOn.action}</span> : null}
          {carry ? (
            // which of the two a wait on an agent is
            <span
              data-testid="task-wait-carry"
              className="block text-[11.5px] text-ink-3"
              title={
                carry.kind === 'beat'
                  ? `Silos carries the ask — its next heartbeat is ${untilTime(carry.seenBy, now)}`
                  : 'Silos does not carry this wait to the agent — tell it, or answer for it'
              }
            >
              {carry.kind === 'beat' ? `${agents.find((a) => a.id === carry.to)?.name ?? carry.to} sees it at its next beat` : 'you relay'}
            </span>
          ) : null}
        </Prop>
      ) : null}
      {t.nextCheckAt ? (
        <Prop label="Next check">
          <span className="font-mono text-[11.5px]">{Number.isNaN(Date.parse(t.nextCheckAt)) ? t.nextCheckAt : untilTime(Date.parse(t.nextCheckAt), now)}</span>
        </Prop>
      ) : null}
      {due ? (
        <Prop label="Due">
          <span className={due.startsWith('overdue') && !finished ? 'text-terracotta' : ''}>{due.replace(/^due /, '')}</span>
        </Prop>
      ) : null}
      <Prop label="Reference">
        <span className="font-mono text-[11.5px] text-ink-2" title={t.label !== t.ref ? `${t.ref} — its reference in the plan file` : undefined}>
          {t.label}
        </span>
      </Prop>
    </dl>
  )
  // the owner's agent's control — the same as on its page:
  // «On its own» · «Only when told», said where the task is
  const moves =
    ownerAgent && mode.view?.wakes && !finished ? (
      <div className="mt-4 border-t border-line/60 pt-3" data-testid="task-moves">
        <p className="mb-1.5 text-[12px] text-ink-3">Without you</p>
        <ControlSwitch agent={ownerAgent} compact testId="task-moves-control" onChanged={() => mode.reload()} />
      </div>
    ) : null

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <PageHeader
        testId="task-header"
        // the task's body is centred: the header shares its left edge
        measure="mx-auto max-w-[66rem] sm:px-3"
        // where it lives: project › plan (each a door up). Its list and the
        // walk through it are where you CAME from — the aside.
        crumbs={[
          ...(t.folder ? [{ label: basename(t.folder), title: t.folder, onClick: () => changePage({ kind: 'project', folder: t.folder! }) }] : []),
          // the project's list (plans/tasks.plan.json) has no name: the crumb is just the project
          ...(t.standingList
            ? []
            : [{ label: t.planTitle, title: `${t.planTitle} — ${d?.closed ? 'closed: its file, read only' : 'its tasks'}`, onClick: openPlanView }]),
        ]}
        aside={
          <>
            <OriginBack words={origin.words} onBack={back} testId="task-back" />
            {walk ? (
              <nav
                aria-label="The list this task came from"
                data-testid="task-neighbours"
                className="flex shrink-0 items-center font-mono text-[11px] tabular-nums text-ink-2"
              >
                <button
                  type="button"
                  disabled={!walk.prev}
                  onClick={() => openKey(walk.prev)}
                  aria-label="Previous task"
                  title={walk.prev ? `${all.find((x) => x.key === walk.prev)?.title ?? 'Previous task'} ( [ )` : undefined}
                  data-testid="task-prev"
                  className="rounded p-0.5 hover:text-ink disabled:opacity-30"
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span className="px-0.5">
                  {walk.index + 1} of {walk.total}
                </span>
                <button
                  type="button"
                  disabled={!walk.next}
                  onClick={() => openKey(walk.next)}
                  aria-label="Next task"
                  title={walk.next ? `${all.find((x) => x.key === walk.next)?.title ?? 'Next task'} ( ] )` : undefined}
                  data-testid="task-next"
                  className="rounded p-0.5 hover:text-ink disabled:opacity-30"
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </nav>
            ) : null}
            <KeyHint onOpen={() => keys.setHelp(true)} />
          </>
        }
        // a task is a sentence: it wraps to two lines instead of truncating
        wrapTitle
        title={
          <span data-testid="task-title" className={finished ? 'text-ink-2' : ''}>
            {t.title}
          </span>
        }
        facts={
          <span data-testid="task-origin" className="flex min-w-0 items-center gap-1.5">
            {/* the plan is already the crumb above — the facts say who wrote it */}
            {writers.length > 0 ? (
              <>
                <span className="shrink-0">written by</span>{' '}
                {writer ? (
                  <button
                    type="button"
                    onClick={() => void openSession(writer.folder, writer.id)}
                    className="min-w-0 truncate text-ink hover:text-terracotta"
                    title={writer.title}
                  >
                    {writers.join(' and ')}
                  </button>
                ) : (
                  <span className="min-w-0 truncate text-ink">{writers.join(' and ')}</span>
                )}{' '}
                <span aria-hidden="true" className="text-ink-3">
                  ·
                </span>{' '}
              </>
            ) : null}
            <span className="shrink-0 font-mono text-[11.5px] text-ink-3" title={t.ref}>
              {t.label}
            </span>
          </span>
        }
      />
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid max-w-[66rem] grid-cols-1 gap-x-12 px-5 pb-16 pt-5 sm:px-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0">
            {banner}
            {/* «added outside Silos ›»: opening never blesses — its button does */}
            <OriginMark taskKey={key} outside={origin0.outside} onKept={origin0.kept} />
            {/* presence without streaming:
                while a linked conversation is WORKING, the page says so with
                the door — unless the banner already says working */}
            {/* the live line: what is happening to a
                start on this task right now — Starting → on it · Stop → or
                couldn't start; queued on its own cap or the fleet's; a console */}
            {ownerAgent && mode.view?.live ? (
              <div className="mt-2 rounded-lg border border-line bg-panel/60 px-3.5 py-2">
                <TaskLive
                  name={ownerAgent.name}
                  agentId={ownerAgent.id}
                  fact={mode.view.live}
                  reload={mode.reload}
                  onOpen={(sid) => {
                    const w = whereIs(sid)
                    if (w) void openSession(w.folder, w.id)
                    else {
                      const p = doorPlan({ name: ownerAgent.name, door: mode.view?.door })
                      void (p.kind === 'open' ? opener.open(p.to) : opener.go(p.mode))
                    }
                  }}
                />
              </div>
            ) : null}
            {(() => {
              const live = liveConvs.find((c) => c.state === 'working' && c.session)
              if (finished || mode.view?.live || !live || (t.turn?.kind === 'theirs' && t.turn.sentence.endsWith('is working on it now.'))) return null
              return (
                <div
                  data-testid="task-live-strip"
                  className="mt-2 flex flex-wrap items-center gap-x-2 rounded-lg border border-terracotta/30 bg-terracotta-soft/40 px-3.5 py-2 text-[12.5px]"
                >
                  <LiveMark />
                  <span className="text-ink">
                    <span className="font-medium">{agents.find((a) => a.id === live.agentId)?.name ?? live.agentId ?? 'An agent'}</span> is working on it now
                    {live.session?.title ? <> — in «{live.session.title}»</> : null}.
                  </span>
                  <button
                    type="button"
                    onClick={() => live.session && void openSession(live.session.folder, live.session.id)}
                    className="text-[12px] text-terracotta underline decoration-terracotta/40 underline-offset-2 hover:decoration-terracotta"
                  >
                    Open ›
                  </button>
                </div>
              )
            })()}
            {/* the binding to sign reads at the page's own width, once — the host is
                read letter by letter, never broken in a 270 px column */}
            {signAsk && !finished ? (
              <div data-testid="task-to-sign" className="mt-4 max-w-[62ch]">
                <BindingAskCard
                  ask={signAsk}
                  nameOf={(id) => agents.find((a) => a.id === id)?.name ?? id}
                  onSign={() => changePage({ kind: 'vault', sign: key })}
                  onOpenVault={() => changePage({ kind: 'vault' })}
                />
              </div>
            ) : null}

            {/* the properties come right after the title on a phone */}
            <div className="mt-6 lg:hidden">
              {actions ? <div className="mb-3">{actions}</div> : null}
              {props}
              {moves}
            </div>

            {kids.length > 0 ? (
              <Section title="Subtasks" testId="task-subtasks" aside={<Progress {...planProgress(kids.map((k) => k.state))} />}>
                <ul className="flex flex-col">
                  {kids.map((k) => (
                    <li key={k.key} {...(freshKids.has(k.key) ? { 'data-new': 'true' } : {})}>
                      <button
                        type="button"
                        onClick={() => openTask(k)}
                        className="flex w-full items-center gap-2.5 rounded-md py-1.5 text-left hover:bg-panel/60 sm:-mx-2 sm:px-2"
                      >
                        <TaskGlyph t={k} plan={plan} agents={agents} now={now} />
                        <span
                          className={`min-w-0 flex-1 truncate text-[13.5px] ${freshKids.has(k.key) ? 'font-semibold text-ink' : isFinished(k.state) ? 'text-ink-2' : 'text-ink'}`}
                        >
                          <NewWord on={freshKids.has(k.key)} />
                          {k.title}
                        </span>
                        <OwnerMark owner={k.owner} agents={agents} compact />
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            <Section
              title="Conversations"
              testId="task-conversations"
              aside={convs.length > 0 ? <span className="font-mono text-[11px] text-ink-3">{convs.length}</span> : undefined}
            >
              {convs.length === 0 ? (
                <p className="text-[13px] text-ink-2">No conversation yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line/50">
                  {/* the current ones first; the let-go ones after, as history */}
                  {[...convs.filter((c) => currentSet.has(c.id)), ...convs.filter((c) => !currentSet.has(c.id))].map((c) => {
                    const current = currentSet.has(c.id)
                    const at = t.releasedAt[c.id] ? Date.parse(t.releasedAt[c.id]!) : NaN
                    return (
                      <ConversationRow
                        key={c.id}
                        c={c}
                        agents={agents}
                        now={now}
                        serverRef={server.refs.get(c.id) ?? null}
                        answered={server.answered}
                        onOpen={() => {
                          const w = whereIs(c.id)
                          if (w) void openSession(w.folder, w.id)
                        }}
                        history={current ? null : { at: Number.isNaN(at) ? null : at }}
                        unlink={
                          current && !finished && canWrite && c.session ? (
                            <button
                              type="button"
                              data-testid="task-unlink"
                              aria-expanded={unlinking === c.id}
                              onClick={() => {
                                setUnlinked(null)
                                setUnlinking(unlinking === c.id ? null : c.id)
                              }}
                              title="It stays in this task's history; it stops being the conversation working it"
                              className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-ink-3 hover:text-terracotta aria-expanded:text-ink"
                            >
                              Unlink…
                            </button>
                          ) : null
                        }
                      />
                    )
                  })}
                </ul>
              )}
              {unlinking && t ? (
                <UnlinkSheet
                  task={t}
                  sessionId={unlinking}
                  agents={agents}
                  title={convs.find((c) => c.id === unlinking)?.session?.title ?? server.refs.get(unlinking)?.title ?? ''}
                  onCancel={() => setUnlinking(null)}
                  onDone={(said) => {
                    setUnlinking(null)
                    setUnlinked(said)
                    refreshTasks()
                    reload()
                    mode.reload()
                  }}
                />
              ) : null}
              {unlinked ? (
                <p role="status" data-testid="task-unlinked" className="mt-2 text-[12.5px] text-ink-2">
                  {unlinked}
                </p>
              ) : null}
            </Section>

            {/* the SDD executions this task launched: absent when it has none */}
            {executions.length > 0 ? (
              <Section
                title={executions.length === 1 ? 'Execution' : 'Executions'}
                testId="task-executions"
                aside={executions.length > 1 ? <span className="font-mono text-[11px] text-ink-3">{executions.length}</span> : undefined}
              >
                <ul className="flex flex-col divide-y divide-line/50">
                  {executions.map((e) => (
                    <ExecutionRow key={e.key} e={e} agents={agents} now={now} />
                  ))}
                </ul>
              </Section>
            ) : null}

            {mode.view && (mode.view.bound || mode.view.history.length > 0) ? (
              <Section
                title="Wakes"
                testId="task-wake-history"
                aside={
                  mode.view.history.some((w) => w.state === 'queued') ? <span className="text-[11.5px] font-medium text-terracotta">waiting</span> : undefined
                }
              >
                <WakeHistory
                  view={mode.view}
                  ownerName={ownerAgent?.name ?? t.owner}
                  stuck={t.flow?.stalled && t.flow.stalledCause === 'blocker-cancelled' ? stallLine(t, plan) : null}
                  onOpen={(sid) => {
                    const w = whereIs(sid)
                    if (w) void openSession(w.folder, w.id)
                  }}
                />
              </Section>
            ) : null}

            <Section title="Notes and activity" testId="task-activity">
              {activity.length === 0 ? (
                <p className="text-[13px] text-ink-2">No notes yet, and Silos has not seen its state change.</p>
              ) : (
                <ol className="relative flex flex-col gap-3 border-l border-line pl-4">
                  {activity.map((it) =>
                    it.kind === 'reply' && it.card ? (
                      // the agent's own words from the turn this task woke — the
                      // feed reads the transcript; the full conversation is one
                      // click away and stays sovereign
                      <li key={activityKey(it)} className="relative" data-testid="task-reply">
                        <span
                          aria-hidden="true"
                          className="absolute -left-[21px] top-[7px] h-2 w-2 rounded-full border border-terracotta/50 bg-terracotta-soft"
                        />
                        <div className="max-w-[66ch] rounded-lg border border-line bg-panel px-3 py-2">
                          <div className="text-[11.5px] text-ink-3">
                            <span className="text-ink-2">{agents.find((a) => a.id === it.by)?.name ?? it.by ?? 'An agent'}</span>
                            {` · ${relTime(it.at, now)}`}
                            {' · '}
                            <button
                              type="button"
                              data-testid="reply-conversation-door"
                              onClick={() => void openSession(it.card!.folder, it.card!.sessionId, { exact: true })}
                              className="underline decoration-line underline-offset-2 hover:text-terracotta"
                            >
                              conversation ›
                            </button>
                          </div>
                          <ReplyBody texts={it.card.texts} />
                        </div>
                      </li>
                    ) : it.kind === 'note' ? (
                      <li key={activityKey(it)} className="relative" data-testid="task-note">
                        <span aria-hidden="true" className="absolute -left-[21px] top-[7px] h-2 w-2 rounded-full border border-ink-3 bg-canvas" />
                        <div className="text-[11.5px] text-ink-3">
                          <span className="text-ink-2">{noteAuthorWords({ by: it.by ?? '', fromOwner: it.fromOwner === true }, agents)}</span>
                          {it.undated ? ' · earlier' : ` · ${relTime(it.at, now)}`}
                          {/* the owner reads the note here — its provenance is said here */}
                          {'readOutside' in it && it.readOutside && it.readOutside.length > 0 ? (
                            <span data-testid="note-read-outside" className="text-terracotta">
                              {' '}
                              — written after reading the web ({it.readOutside.join(', ')})
                            </span>
                          ) : null}
                          {/* the agent's note carries the door to where it was said —
                            only when ONE conversation worked the task (unambiguous;
                            with several, the Conversations section is the list) */}
                          {it.by === t.owner && ownerAgent && convs.length === 1 && whereIs(convs[0]!.id) !== null ? (
                            <>
                              {' '}
                              ·{' '}
                              <button
                                type="button"
                                data-testid="note-conversation-door"
                                onClick={() => {
                                  const w = whereIs(convs[0]!.id)
                                  if (w) void openSession(w.folder, w.id)
                                }}
                                className="underline decoration-line underline-offset-2 hover:text-terracotta"
                              >
                                conversation ›
                              </button>
                            </>
                          ) : null}
                        </div>
                        <NoteBody text={it.text} from={t} onOpen={openTask} />
                      </li>
                    ) : (
                      <li key={activityKey(it)} className="relative text-[12px] text-ink-2" data-testid="task-state-change">
                        <span aria-hidden="true" className="absolute -left-[19.5px] top-[6px] h-[5px] w-[5px] rounded-full bg-ink-3" />
                        <span>{it.text}</span>
                        <span className="text-ink-3"> · {relTime(it.at, now)}</span>
                      </li>
                    ),
                  )}
                </ol>
              )}
              {answeredTo.length > 0 ? (
                <p className="mt-4 text-[12.5px] text-ink-2" data-testid="task-answered-doors" role="status">
                  Answered — it landed on{' '}
                  {answeredTo.map((a, i) => {
                    const page = taskPageOfKey(a.key)
                    const ref = labelOfKey(all, a.key)
                    return (
                      <span key={a.key}>
                        {i > 0 ? ' and ' : ''}
                        {page ? (
                          <button
                            type="button"
                            onClick={() => changePage(page)}
                            className="text-ink underline decoration-line underline-offset-2 hover:text-terracotta"
                          >
                            {ref} ({agents.find((x) => x.id === a.owner)?.name ?? a.owner}) ›
                          </button>
                        ) : (
                          ref
                        )}
                      </span>
                    )
                  })}{' '}
                  — {answeredTo.length === 1 ? 'it wakes on your note' : 'they wake on your note'}.
                </p>
              ) : null}
              {canWrite && notesAppend
                ? (() => {
                    // a note on a closed task of an agent in play reopens it
                    // («reopens it»): in the note's OWN write, the server's one rule
                    // for every door — nothing more is sent
                    // the box's text as the owner's answer — one write; what
                    // still holds it after is said with its door
                    const answerWith = async (text: string): Promise<void> => {
                      const r = await answerTask(t, text, agentIdSet)
                      // a gate of yours closed — the same landing as Answer & done
                      if (r.closed) setAnsweredTo(r.notified)
                      const stuck = droppedOf(r.holds, t, all)
                      // the way out is on THIS page (the dropped dependency's banner)
                      setAnswerSaid(
                        stuck.length > 0
                          ? `Answered — but ${stuckWords(stuck, (id) => labelOfKey(all, `${t.planKey}/tasks/${id}`, key))} — on this page.`
                          : null,
                      )
                      setJustSent((xs) => [...xs, { at: new Date().toISOString(), text }])
                    }
                    const sendNote = (then?: () => Promise<unknown>): void => {
                      const text = note.trim()
                      if (!text) return
                      void write(async () => {
                        if (answering) await answerWith(text)
                        else {
                          await addNote(text)
                          setJustSent((xs) => [...xs, { at: new Date().toISOString(), text }])
                        }
                        setNote('')
                        // «Send and open ›»: the note is on the task, then you go in
                        if (then) await then()
                      }, 'box')
                    }
                    // the Paperclip loop on a gate of yours: the text lands on the
                    // waiting agent tasks and THIS one closes, one gesture — and it
                    // IS the submit (Enter included): a demo showed two twin
                    // pills where the mute one was the default
                    const sendPrimary = (): void => {
                      if (!answerAndDone) {
                        sendNote()
                        return
                      }
                      const text = note.trim()
                      if (text)
                        void write(async () => {
                          const r = await api.silos.respond(PLANS_SILO, { key, text, state: t.state })
                          markTaskSeen(key, 'done')
                          setNote('')
                          setAnsweredTo(r.notified ?? [])
                        }, 'box')
                    }
                    // Approve: the review is closed — your words, if any, are its note
                    const approve = (): void => {
                      const text = note.trim()
                      void write(async () => {
                        await act(key, 'approve', { asked: paintedAsked(t), ...(text ? { text } : {}) })
                        setNote('')
                      }, 'box')
                    }
                    return (
                      <form
                        className="mt-4 flex flex-col gap-2"
                        onSubmit={(e) => {
                          e.preventDefault()
                          sendPrimary()
                        }}
                      >
                        {/* the ask's own choices, one tap to the box (waitingOn.options,
                      an optional convention the producer may write) */}
                        {!finished && t.waitingOn && waitOptions(t).length > 0 ? (
                          // the agent's closed choices: on a wait that is YOURS each
                          // one answers in one tap (one write — the note, the wait
                          // out, the state); on someone else's they only fill the box
                          <span className="flex flex-wrap items-center gap-1.5" data-testid="task-answer-options">
                            {isYou(t.waitingOn.owner) ? <span className="text-[11.5px] text-ink-3">Answer:</span> : null}
                            {waitOptions(t).map((o) => (
                              <button
                                key={o}
                                type="button"
                                disabled={busy}
                                data-testid="task-answer-option"
                                onClick={() => {
                                  if (!isYou(t.waitingOn!.owner)) {
                                    setNote(o)
                                    noteBox.current?.focus()
                                    return
                                  }
                                  void write(() => answerWith(o), 'box')
                                }}
                                className={
                                  isYou(t.waitingOn!.owner)
                                    ? 'rounded-full border border-terracotta/40 bg-terracotta-soft px-2.5 py-0.5 text-[12px] font-medium text-terracotta enabled:hover:border-terracotta disabled:opacity-50'
                                    : 'rounded-full border border-line px-2.5 py-0.5 text-[12px] text-ink-2 hover:border-terracotta hover:text-terracotta'
                                }
                              >
                                {o}
                              </button>
                            ))}
                          </span>
                        ) : null}
                        {answerSaid ? (
                          <p role="status" data-testid="task-answer-still-stuck" className="text-[12px] text-[var(--health-amber)]">
                            {answerSaid}
                          </p>
                        ) : null}
                        <textarea
                          ref={noteBox}
                          data-testid="task-note-box"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation()
                              e.currentTarget.blur()
                              return
                            }
                            // Enter sends (the box is a channel, not a form field); Shift+Enter keeps the newline
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault()
                              if (!busy) sendPrimary()
                            }
                          }}
                          rows={2}
                          maxLength={notesAppend.fields.find((f) => f.name === 'text')?.max ?? 8000}
                          placeholder={boxVoice.placeholder}
                          aria-label={boxVoice.placeholder}
                          className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-terracotta"
                        />
                        {boxVoice.helper ? <p className="text-[11.5px] text-ink-3">{boxVoice.helper}</p> : null}
                        {/* held: the note waits — the conversation that holds it, one click away */}
                        {heldNote && ownerAgent
                          ? (() => {
                              const to = mode.view?.door?.running ?? mode.view?.door?.thread ?? null
                              return to ? (
                                <button
                                  type="button"
                                  data-testid="task-held-open"
                                  onClick={() => void opener.open(to)}
                                  className="self-start text-[12px] font-medium text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
                                >
                                  Open ›
                                </button>
                              ) : null
                            })()
                          : null}
                        <span className="flex justify-end gap-2">
                          {boxVoice.secondary ? (
                            <button
                              type="button"
                              data-testid="task-send-open"
                              disabled={busy || note.trim() === '' || opener.o.state === 'opening'}
                              onClick={() =>
                                sendNote(async () => {
                                  const p = doorPlan({ name: ownerAgent?.name ?? '', door: mode.view?.door })
                                  if (p.kind === 'open') await opener.open(p.to)
                                  else await opener.go(p.mode)
                                })
                              }
                              title={`Your note lands on the task, then ${surface === 'console' ? 'its console' : 'a chat'} opens on it`}
                              className="rounded-full border border-line px-3 py-1 text-[12px] text-ink enabled:hover:border-terracotta enabled:hover:text-terracotta disabled:opacity-50"
                            >
                              {boxVoice.secondary}
                            </button>
                          ) : null}
                          {answerAndDone ? (
                            <button
                              type="button"
                              disabled={busy || note.trim() === ''}
                              onClick={() => sendNote()}
                              title="A note for the record — the task stays open"
                              className="rounded-full border border-line px-3 py-1 text-[12px] text-ink-2 enabled:hover:border-ink-3 enabled:hover:text-ink disabled:opacity-50"
                            >
                              Add note
                            </button>
                          ) : null}
                          <button
                            type="submit"
                            disabled={busy || note.trim() === ''}
                            {...(answerAndDone ? { 'data-testid': 'task-answer-done' } : reviewing ? { 'data-testid': 'task-send-back' } : {})}
                            className={
                              boxVoice.reaches && !reviewing
                                ? 'rounded-full border border-terracotta/40 bg-terracotta-soft px-3 py-1 text-[12px] font-medium text-terracotta enabled:hover:border-terracotta disabled:opacity-50'
                                : 'rounded-full border border-line px-3 py-1 text-[12px] text-ink enabled:hover:border-ink-3 disabled:opacity-50'
                            }
                          >
                            {boxVoice.button}
                          </button>
                          {reviewing ? (
                            <button
                              type="button"
                              disabled={busy}
                              data-testid="task-approve"
                              onClick={approve}
                              title="Closes the review — your words, if any, ride as its note"
                              className="rounded-full border border-terracotta/40 bg-terracotta-soft px-3 py-1 text-[12px] font-medium text-terracotta enabled:hover:border-terracotta disabled:opacity-50"
                            >
                              Approve
                            </button>
                          ) : null}
                        </span>
                        {errorAt('box')}
                        {/* «Send and open ›» opening: its proof of life (the door shows its own) */}
                        {!work ? <OpeningLine opener={opener} /> : null}
                      </form>
                    )
                  })()
                : null}
            </Section>

            {convs.some((c) => c.session) ? (
              <Section title="Deliverables" testId="task-deliverables">
                {deliverables.state === 'loading' ? (
                  <p className="text-[13px] text-ink-3">Reading what its conversations wrote…</p>
                ) : deliverables.files.length === 0 ? (
                  <p className="text-[13px] text-ink-2">Its conversations have not written a file yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {deliverables.files.map((f) => (
                      <li key={f.path}>
                        <button
                          type="button"
                          onClick={() => openFileViewer(f.path)}
                          className="flex w-full min-w-0 items-baseline gap-2 text-left hover:text-terracotta"
                          title={f.path}
                        >
                          <span className="min-w-0 truncate text-[13px] text-ink">{basename(f.path)}</span>
                          <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">{f.path.replace(/\/[^/]*$/, '')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            ) : null}
          </div>

          <aside className="hidden lg:block">
            <div className="sticky top-5 mt-[4.25rem]">
              {actions ? <div className="mb-4">{actions}</div> : null}
              {props}
              {moves}
            </div>
          </aside>
        </div>
      </div>
      {keys.help ? <KeyHelp onClose={() => keys.setHelp(false)} /> : null}
    </div>
  )
}
