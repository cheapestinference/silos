// HomePage.tsx — '/' (docs/product.md, moments 1 + 2). The pulse sentence
// and its calm facts, then two zones: ONE
// list, «Needs you» — what holds someone up, then the owner's own tasks —
// and beside it «This week» (the week drawn, the door to Usage) over «This
// month» (the month drawn and the fleet's line, the door to System). Right
// now left Home: the pulse opens Working now. Scoped to a folder (the
// project page) the same list, then a tile per agent. The full lists
// open in Sheets over the page (or on their pages).
// Map, Graph and Uses are lenses on the date line, not destinations here
// (the Board retired into this page: its Waiting rides Working now,
// its Done today the digest's sheet).
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Gauge, Hourglass, Square } from 'lucide-react'
import { AutomationIcon, SiloIcon } from '../../lib/icons'
import { useStore } from '../../store'
import { openAgentControl, openAgentSettings } from '../agent/doors'
import { ApiError, api } from '../../lib/api'
import { MASTER_ID, ANYWHERE_LABEL } from '../../lib/constants'
import { relTime, relTimeOf } from '../../lib/rel-time'
import { basename } from '../../lib/routes'
import type { TaskOrigin } from '../../lib/routes'
import { closeHomeSheet, navigateToRoute } from '../../lib/router'
import { controlOf, openLabel, surfaceOfAgent } from '../../lib/give'
import { useTaskOpen } from '../tasks/TaskMode'
import { askWords, linesOf, stalledTasksDoor, stalledTasksWords, taskLineDoor, taskLineWords, wakeCeilingWords, type TaskLineRow } from '../../lib/task-lines'
import { seeTodayDoor } from '../../lib/usage-door'
import { answerTask, droppedOf, paintedAsked, reviewWaitsOnYou, stuckWords } from '../../lib/answer-wait'
import { act, actError } from '../../lib/task-gesture'
import { PLANS_SILO } from '../../lib/plan-record'
import { useOpenTasksBySession, useTasks } from '../../hooks/useTasks'
import { causeWords, conversationCause } from '../../lib/sidebar-show'
import { markTaskSeen, useNewTasks } from '../../hooks/useTaskSeen'
import { useHeldOrder, useListCursor } from '../../hooks/useTaskKeys'
import { inboxHoldId, releaseHold } from '../../lib/held-order'
import { KeyHelp, KeyHint } from '../tasks/KeyHelp'
import { dropHangs, dropWarnings, isYou, labelOfKey, planDoor, siblingsOf, stallLine, taskPage, type TaskView } from '../../lib/tasks'
import { openPlanDoor } from '../../lib/file-refs'
import { dropTask } from '../../lib/task-drop'
import { inboxTaskKey, taskPageOfKey } from '../../lib/task-origin'
import { baselineKeepWords, baselineWords } from '../../lib/initiative'
import { DropConfirm, NewWord, TaskGlyph } from '../tasks/TaskBits'
import {
  aheadEngines,
  engineHead,
  refusingEngines,
  answerHidden,
  backgroundBySession,
  ceilingLine,
  failedTimes,
  pruneAnswered,
  stillListed,
  fleet,
  headline,
  inboxKey,
  isWaiting,
  handoffWords,
  homeList,
  limitWords,
  stoppedWords,
  taskWhy,
  scopeInbox,
  scopeToFolder,
  siloSummaryWords,
  siloDoneInFolder,
  siloGrowthLines,
  workingNow,
  workingWord,
  waitingNow,
  notParked,
  waitingOnWords,
  doneToday,
  aroundFolder,
  type FleetRow,
  type InboxItem,
} from '../../lib/home'
import { accountLoadGroups, accountLoadLines } from '../../lib/account-load'
import { mapPageOf, mapViewsFor } from '../../lib/map-views'
import { OrgTile } from './OrgTile'
import { ThisWeek } from './ThisWeek'
import { ThisMonth } from './ThisMonth'
import { HoldCard, ListRow, NeedsYouSection, type CardAnswer } from './HomeList'
import { ProposalDetail } from './ProposalDetail'
import { startMissionReview } from '../../lib/mission-review'
import {
  folderOfRow,
  isTaskRow,
  namedPlans,
  projectSections,
  splitPlans,
  taskPageOf,
  taskRefOf,
  taskTitle,
  type PlanGroup,
  type TaskItem,
  type ProjectSection,
} from '../../lib/home-projects'
import { handoffOf } from '../../lib/plan-record'
import { SessionDot } from '../SessionDot'
import { FileViewer } from '../FileViewer'
import { ListButton } from '../Chat'
import type {
  AccountLoad,
  AgentView,
  HeartbeatView,
  ProposalView,
  BoardCard,
  SessionView,
  DigestBand as DigestBandData,
  NeedsYouItem,
  PlanHandoff,
  SiloBoard,
  TasksSession,
} from '../../lib/types'
import { DigestBand } from './DigestBand'
import { SinceBand, SinceSheet } from './SinceBand'
import { nextWords, sinceShows, type HomeSince } from '../../lib/since'
import { Tile, TileGrid, PREVIEW_MAX, type TileLine } from '../Tile'
import { Sheet } from '../Sheet'
import { inboxDestination } from '../../lib/inbox-destination'
import { agentInPlay } from '../../lib/beat-home'
import { useBindingAsks } from '../../hooks/useBindingAsks'
import { BindingAskCard } from '../VaultSigning'

const BOARD_POLL_MS = 20_000
const HEARTBEAT_POLL_MS = 30_000
const ACCOUNT_LOAD_POLL_MS = 15_000

// a row marked seen is THAT version of it: its key + the version its ack names
// (a newer escalation, a new failed run… is a different version and shows).
function projectName(folder: string | null): string | null {
  return folder ? basename(folder) : null
}

function seenKey(i: InboxItem): string | null {
  return i.ack ? `${i.key}=${i.ack.version}` : null
}
type SeenItem = InboxItem & { ack: NonNullable<InboxItem['ack']> }

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}
function agentName(a: AgentView | undefined): string {
  if (!a) return 'unknown agent'
  return a.id === MASTER_ID ? ANYWHERE_LABEL : a.name
}

// the seal: the agent's emoji on the house tint, ringed with its signal —
// blinking while it works, solid when a conversation waits for you.
function Seal({ agent, signal, size = 'md' }: { agent: AgentView | undefined; signal?: 'working' | 'attention' | null; size?: 'sm' | 'md' }) {
  const cls = size === 'md' ? 'h-9 w-9 rounded-xl text-[18px]' : 'h-6 w-6 rounded-md text-[13px]'
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center bg-terracotta-soft leading-none ${cls} ${
        signal ? `ring-2 ring-terracotta ring-offset-2 ring-offset-canvas ${signal === 'working' ? 'dot-blink' : ''}` : ''
      }`}
    >
      {agent?.emoji ?? '·'}
    </span>
  )
}

// an action in the log's voice: quiet text, terracotta on hover. Approve is
// the one filled pill (the automations' own convention); a refusal (Deny)
// is quiet text already in terracotta — the colour says what it does.
function Act({
  onClick,
  children,
  primary = false,
  refuse = false,
  navDone = false,
}: {
  onClick: () => void
  children: string
  primary?: boolean
  refuse?: boolean
  navDone?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...(navDone ? { 'data-nav-done': true } : {})}
      className={
        primary
          ? 'shrink-0 rounded-full border border-terracotta/40 bg-terracotta-soft px-2.5 py-0.5 text-[11px] font-medium text-terracotta hover:border-terracotta'
          : refuse
            ? 'shrink-0 text-[11px] text-terracotta/80 underline-offset-2 hover:text-terracotta hover:underline'
            : 'shrink-0 text-[11px] text-ink-2 underline-offset-2 hover:text-terracotta hover:underline'
      }
    >
      {children}
    </button>
  )
}

// what «Let it continue today» lifts, said beside it — the max is
// never called «turns» (product.md, one word per thing)
const CONTINUE_LIFTS = 'Letting it continue lifts today’s max and spend cap.'

// «Let it continue today» on a cap's row: the owner's exemption for the
// day. A refused PATCH says so beside the button — never a silent no-op.
function ContinueToday({ agentId, day }: { agentId: string; day: string }) {
  const [state, setState] = useState<{ busy: boolean; refused: string | null }>({ busy: false, refused: null })
  const go = (): void => {
    setState({ busy: true, refused: null })
    api.agents
      .update(agentId, { ownExemptDay: day })
      .then(() => useStore.getState().loadOverview())
      .then(() => setState({ busy: false, refused: null }))
      .catch((e: unknown) => setState({ busy: false, refused: e instanceof Error ? e.message : String(e) }))
  }
  return (
    <>
      <Act primary onClick={state.busy ? () => {} : go}>
        Let it continue today
      </Act>
      {state.refused ? (
        <span role="alert" className="basis-full text-[12px] text-terracotta">
          It still waits — {state.refused.replace(/\.$/, '')}.
        </span>
      ) : null}
    </>
  )
}

type AskItem = Extract<InboxItem, { kind: 'ask' }>
type ProposalItem = Extract<InboxItem, { kind: 'proposal' }>
type BaselineItem = Extract<InboxItem, { kind: 'plansBaseline' }>
// a proposal read whole, as the row the handlers take (a folded agent's
// proposals have no row of their own)
function proposalItemOf(v: ProposalView): ProposalItem {
  return {
    kind: 'proposal',
    key: `proposal:${v.id}`,
    urgency: 'due',
    at: Date.parse(v.at) || 0,
    voice: '',
    clears: '',
    agentId: v.by,
    proposalId: v.id,
    proposalKind: v.kind,
    reason: v.reason,
    review: v.review,
    inputHash: v.inputHash,
    ...v.words,
  }
}
export type ProposalAct = 'accept' | 'dismiss' | 'review'

// words with `code` spans (the server's automation-words.ts quotes a
// command between backticks): the code drawn as code, the rest as is
function withCode(text: string): ReactNode {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded bg-panel px-1 py-px font-mono text-[12.5px] text-ink">
        {part}
      </code>
    ) : (
      part
    ),
  )
}

// «Answer and open ›» (answering, told): the answer
// lands on the task — note, wait cleared, pending, one write — and then you
// go in, at the agent's door (its console when it has one, else a chat) —
// ONLY when the answer went in: a refusal stays on the row, said.
// Answering alone (the choice itself) leaves the task in view, «Not started
// · Open with X ›». The highlighted choice is the one it answers.
function AnswerAndOpen({
  item,
  owner,
  text,
  onAnswer,
}: {
  item: TaskItem
  owner: AgentView
  text: string
  onAnswer: (item: TaskItem, text: string) => Promise<boolean>
}) {
  const opener = useTaskOpen({ taskKey: item.item.key, name: owner.name, onDone: () => {} })
  return (
    <span title={`Answers «${text}», then opens ${owner.name} on it`}>
      <Act
        onClick={() => {
          void onAnswer(item, text).then((went) => {
            if (went) void opener.go(surfaceOfAgent(owner))
          })
        }}
      >
        Answer and open ›
      </Act>
    </span>
  )
}

// «Send back…» on an agent's review that waits on you: what to
// change, in words — the verb `answer`, which hands it back pending
function SendBackBox({ owner, onSend, onCancel }: { owner: string; onSend: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('')
  return (
    <form
      data-testid="home-send-back"
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim() !== '') onSend(text.trim())
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`What to change — it goes back to ${owner}`}
        aria-label="What to change"
        maxLength={8000}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
        className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-[12.5px] outline-none focus:border-terracotta"
      />
      <span className="flex items-center gap-2">
        <button
          type="submit"
          disabled={text.trim() === ''}
          className="rounded-full border border-line px-3 py-1 text-[12px] text-ink hover:border-ink-3 disabled:opacity-50"
        >
          Send back
        </button>
        <button type="button" onClick={onCancel} className="text-[12px] text-ink-3 hover:text-ink">
          Cancel
        </button>
      </span>
    </form>
  )
}

function InboxRow({
  item,
  agents,
  project,
  origin,
  onOpenFile,
  onPlan,
  onSeen,
  onAnswer,
  onDecided,
  onProposal,
  onBaseline,
  onAnswerWait,
  onApprove,
  rowError,
  proposalViews,
}: {
  item: InboxItem
  // a task opened from this row comes back here (lib/task-origin.ts)
  origin: TaskOrigin
  // the project the row belongs to, said in its eyebrow on the unscoped
  // Home (rows without their project read as a jumble)
  project?: string | null
  agents: readonly AgentView[]
  onOpenFile: (path: string) => void
  // `seen`: a Drop's record version as the owner opened its confirm (CAS)
  onPlan: (item: TaskItem, action: 'done' | 'drop', reason?: string, seen?: string | null) => void
  onSeen: (item: SeenItem) => void
  onAnswer: (item: AskItem, status: 'allow' | 'deny') => void
  onDecided: (item: Extract<InboxItem, { kind: 'approval' }>) => void
  onProposal: (item: ProposalItem, act: ProposalAct) => void
  // «Keep them all ›» of a folder's baseline, but the ones left out
  onBaseline: (item: BaselineItem, exclude: string[]) => void
  // the proposals read whole (GET /api/proposals): the rows paint all of it
  proposalViews: ReadonlyMap<string, ProposalView>
  // a choice of an agent's question, answered here — true when it went in
  onAnswerWait?: (item: TaskItem, text: string) => Promise<boolean>
  // Approve on an agent's review that waits on you
  onApprove?: (item: TaskItem) => Promise<boolean>
  // a refused gesture on THIS row, said under it
  rowError?: string | null
}) {
  const openSession = useStore((s) => s.openSession)
  const changePage = useStore((s) => s.changePage)
  const setChatMode = useStore((s) => s.setChatMode)
  // rows about automations and beats land through ONE rule (inbox-destination.ts)
  const go = (row: InboxItem): void => {
    const dest = inboxDestination(row, (id) => agentInPlay(agents, id))
    if (!dest) return
    else changePage(dest.page)
  }
  const approveRun = useStore((s) => s.approveRun)
  const skipRun = useStore((s) => s.skipRun)
  const nowTick = useStore((s) => s.nowTick)
  const byId = (id: string): AgentView | undefined => agents.find((a) => a.id === id)

  // the tasks' reading, for a task row's status glyph
  const tasksReading = useTasks()
  // the bindings agents ask the owner to sign — read only while some
  // ask carries one
  const bindingAsks = useBindingAsks(tasksReading.tasks.some((t) => t.waitingOn?.owner === 'owner' && t.waitingOn.binding !== undefined))
  // Drop… opens the same small confirm as the task page:
  // why, and what it leaves hanging — never a one-click Drop
  const [dropping, setDropping] = useState(false)
  // «Send back…» open on an agent's review
  const [sendingBack, setSendingBack] = useState(false)
  // a folded «X suggests <n> things» opened in place — also a baseline's sheet
  const [unfolded, setUnfolded] = useState(false)
  // the baseline tasks the owner leaves out of «Keep them all»
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  // the version of the task the owner was looking at when they opened the
  // Drop confirm: the Drop is written against it, like the task page's
  const [dropSeen, setDropSeen] = useState<string | null>(null)
  const startDrop = (silo: string, key: string): void => {
    setDropSeen(null)
    setDropping(true)
    Promise.resolve(api.silos.record(silo, key))
      .then((r) => setDropSeen(r.version))
      .catch(() => {
        /* the Drop reads it itself */
      })
  }
  const glyphOf = (key: string): ReactNode => {
    const t = tasksReading.tasks.find((x) => x.key === key)
    return t ? <TaskGlyph t={t} plan={siblingsOf(tasksReading.tasks, t.planKey)} agents={agents} now={nowTick} /> : <Square size={11} />
  }
  // one grammar for every row: [seal] [who · what kind · when] [the thing] [actions]
  // `note`: a quiet line under the body, outside its two-line clamp (an
  // agent's own words of why — never cut by what came before it)
  // A null eyebrow: the row leads with its title (a task's, whose reference
  // and project ride its note).
  const row = (
    seal: ReactNode,
    eyebrow: string | null,
    body: ReactNode,
    actions: ReactNode,
    onClick?: () => void,
    note?: ReactNode,
    stack = false,
  ): ReactNode => {
    const main = (
      <>
        {seal}
        <span className="min-w-0 flex-1">
          {eyebrow !== null ? (
            <span className="block font-mono text-[11px] text-ink-2">
              {eyebrow}
              {project ? <span className="text-ink-3"> · in {project}</span> : null}
            </span>
          ) : null}
          <span className={`${stack ? '' : 'line-clamp-2 '}block max-w-[62ch] text-[14px] leading-snug text-ink`}>{body}</span>
          {note ? <span className={`mt-0.5 ${stack ? '' : 'line-clamp-2 '}block max-w-[62ch] text-[13px] leading-snug text-ink-2`}>{note}</span> : null}
        </span>
      </>
    )
    // a row whose job is to say WHY (the caps' rows): its words at full
    // width, never squeezed beside its buttons — the actions on their own
    // line under the text, aligned with it
    if (stack) {
      return (
        <div className="-mx-2 w-[calc(100%+1rem)] rounded-lg px-2 py-2.5 hover:bg-panel">
          {onClick ? (
            <button type="button" data-nav-open onClick={onClick} className="flex w-full min-w-0 items-start gap-3 text-left">
              {main}
            </button>
          ) : (
            <div className="flex w-full min-w-0 items-start gap-3">{main}</div>
          )}
          {actions ? <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-9">{actions}</div> : null}
        </div>
      )
    }
    const acts = <span className="flex shrink-0 items-center gap-3 self-center">{actions}</span>
    // a row that opens AND carries actions: the opening part is its own
    // button beside them (a button never nests another).
    if (onClick && actions) {
      return (
        <div className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-panel">
          <button type="button" data-nav-open onClick={onClick} className="flex min-w-0 flex-1 items-start gap-3 text-left">
            {main}
          </button>
          {acts}
        </div>
      )
    }
    const inner = (
      <>
        {main}
        {acts}
      </>
    )
    return onClick ? (
      <button
        type="button"
        data-nav-open
        onClick={onClick}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-panel"
      >
        {inner}
      </button>
    ) : (
      <div className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 px-2 py-2.5">{inner}</div>
    )
  }

  switch (item.kind) {
    case 'ask': {
      const a = byId(item.agentId)
      const p = item.permission
      if (p) {
        // an OpenCode agent waiting on a permission: what it wants to run,
        // literally, answered right here (the conversation opens from the row).
        const what = p.pattern ? `${p.type} ${p.pattern}` : null
        return row(
          <Seal agent={a} size="sm" />,
          `permission · ${relTime(item.at, nowTick)}`,
          <>
            <strong className="font-semibold">{agentName(a)}</strong>
            {what ? (
              <>
                {' '}
                asks to run <code className="rounded bg-panel px-1 py-px font-mono text-[12.5px] text-ink">{what}</code>
              </>
            ) : item.title.trim() ? (
              <> asks: {item.title}</>
            ) : (
              <> asks for a permission</>
            )}
          </>,
          <>
            <Act onClick={() => onAnswer(item, 'allow')} primary>
              Allow
            </Act>
            <Act onClick={() => onAnswer(item, 'deny')} refuse>
              Deny
            </Act>
          </>,
          () => void openSession(item.folder, item.id),
        )
      }
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} asks you · ${relTime(item.at, nowTick)}`,
        item.title,
        null,
        () => void openSession(item.folder, item.id),
      )
    }
    case 'escalated': {
      const a = byId(item.item.agentId)
      // "Seen": the owner read it — THAT status leaves the inbox (a newer
      // escalation from the same agent comes back on its own).
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} escalated${item.at ? ` · ${relTime(item.at, nowTick)}` : ''}`,
        item.item.summary,
        <Act onClick={() => onSeen(item as SeenItem)}>Seen</Act>,
        () => go(item),
      )
    }
    case 'message': {
      // a message between agents its recipient handed to you — it opens
      // the recipient's page, where the inbox is read and marked.
      const a = byId(item.item.agentId)
      const from = byId(item.item.from)
      const sender = item.item.from === 'owner' ? 'you' : from ? agentName(from) : item.item.from
      return row(<Seal agent={a} size="sm" />, `${agentName(a)} needs you · from ${sender} · ${relTime(item.at, nowTick)}`, item.item.text, null, () =>
        changePage({ kind: 'agent', id: item.item.agentId }),
      )
    }
    case 'approval': {
      const a = item.automation ? byId(item.automation.agentId) : undefined
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} wants to run · ${relTime(item.at, nowTick)}`,
        <>
          {item.automation?.name ?? item.run.automationId}
          {item.run.promptOverride ? <span className="text-ink-2"> — {item.run.promptOverride}</span> : null}
        </>,
        <>
          <Act
            onClick={() => {
              onDecided(item)
              void approveRun(item.run.id)
            }}
            primary
          >
            Approve
          </Act>
          <Act
            onClick={() => {
              onDecided(item)
              void skipRun(item.run.id)
            }}
          >
            Skip
          </Act>
        </>,
      )
    }
    case 'proposal': {
      // what an agent proposed: who, what,
      // the brake of the provider it would spend on, the agent's own why —
      // and, under the row, ALL of it (ProposalDetail) before the touch.
      // A mission and a command are «Review ›» only: their editor decides.
      const a = byId(item.agentId)
      const view = proposalViews.get(item.proposalId)
      const skill = item.proposalKind === 'skill'
      // a proposal that crosses the agent's projects says it in its first
      // line, beside its title (R6); what it reaches is the card's «Crosses»
      const marks = [item.territoryOff, item.readOutside].filter((x): x is string => !!x)
      return (
        <>
          {row(
            <Seal agent={a} size="sm" />,
            `${agentName(a)} · ${skill ? (item.skillOf ? 'changed a skill' : 'wrote a skill') : 'suggests'} · ${relTime(item.at, nowTick)}`,
            <>
              <span className="font-medium">{item.title}</span>
              {item.crosses ? (
                <span className="text-terracotta" data-testid="proposal-crosses" title={item.crosses}>
                  {' '}
                  — outside its projects: {item.crosses}
                </span>
              ) : null}
              {item.brake ? <span className="text-ink-2"> — {item.brake}</span> : null}
              {item.skillOf ? <span className="text-ink-2"> — in {item.skillOf}</span> : null}
            </>,
            item.review ? (
              <>
                <Act onClick={() => onProposal(item, 'review')} primary>
                  Review ›
                </Act>
                <Act onClick={() => onProposal(item, 'dismiss')}>Dismiss</Act>
              </>
            ) : (
              <>
                <Act onClick={() => onProposal(item, 'accept')} primary>
                  Accept
                </Act>
                <Act onClick={() => onProposal(item, 'dismiss')}>Dismiss</Act>
              </>
            ),
            undefined,
            <>
              <span className="italic">“{item.reason}”</span>
              {marks.map((m) => (
                <span key={m} className="text-terracotta/90">
                  {' '}
                  · {m}
                </span>
              ))}
            </>,
          )}
          {view ? <ProposalDetail view={view} /> : null}
        </>
      )
    }
    case 'proposalSummary': {
      // an agent's proposals past the budget, folded: one line that
      // opens — in place — each of them with its own Accept/Dismiss
      const a = byId(item.agentId)
      const views = item.proposalIds.flatMap((id) => {
        const v = proposalViews.get(id)
        return v ? [v] : []
      })
      return (
        <>
          {row(
            <Seal agent={a} size="sm" />,
            `${agentName(a)} · suggests · ${relTime(item.at, nowTick)}`,
            <>
              {agentName(a)} suggests {item.count} things ›
            </>,
            null,
            () => setUnfolded((u) => !u),
          )}
          {unfolded
            ? views.map((v) => (
                <div key={v.id} className="ml-9" data-testid={`proposal-unfolded-${v.id}`}>
                  <div className="flex items-baseline gap-3 py-1.5 text-[13.5px]">
                    <span className="min-w-0 flex-1 text-ink">
                      <span className="font-medium">{v.words.title}</span>
                      <span className="text-ink-2"> — “{v.reason}”</span>
                    </span>
                    {v.review ? (
                      <Act onClick={() => onProposal(proposalItemOf(v), 'review')} primary>
                        Review ›
                      </Act>
                    ) : (
                      <Act onClick={() => onProposal(proposalItemOf(v), 'accept')} primary>
                        Accept
                      </Act>
                    )}
                    <Act onClick={() => onProposal(proposalItemOf(v), 'dismiss')}>Dismiss</Act>
                  </div>
                  <ProposalDetail view={v} />
                </div>
              ))
            : null}
        </>
      )
    }
    case 'silo': {
      const it = item.item
      // a task of yours in an active silo (a plan's: `parent` set) that waits
      // here because it gates an agent's work or its date is near (the
      // manifest's `due` entry). The title leads (it is the inbox: what is
      // not read is not decided): status · title and why, then plan#id, its
      // moment and its project; the plan's name is on hover and on the page.
      // Done / Drop settle it in place through the silo's set-field
      if (isTaskRow(item)) {
        const p = item.item.parent
        const path = item.item.file
        // the row opens the TASK's page — its plan, its
        // conversations, its notes; the plan file stays one click from there
        const tp = taskPageOf(item)
        const ref = tasksReading.tasks.find((x) => x.key === it.key)?.label ?? taskRefOf(item)
        const where = project ?? (it.folder ? basename(it.folder) : null)
        // an agent's task waiting on YOU (waitsOnHuman): its question is the
        // row, its choices the buttons — one tap answers it
        const tv = tasksReading.tasks.find((x) => x.key === it.key)
        const owner = tv ? byId(tv.owner) : undefined
        // the server's sentence for the row (it.text, voice.ts rowOf) is the words
        const ask = tv && owner ? askWords(tv, agentName(owner), it.text) : null
        // the binding it asks to sign: the host in clear, the door to
        // the Vault's editor prefilled — never a write from here
        const signAsk = bindingAsks.get(it.key)
        const signCard = signAsk ? (
          <div className="mb-2 ml-9" key="sign">
            <BindingAskCard
              ask={signAsk}
              nameOf={(id) => {
                const a = byId(id)
                return a ? agentName(a) : id
              }}
              onSign={() => changePage({ kind: 'vault', sign: it.key })}
              onOpenVault={() => changePage({ kind: 'vault' })}
            />
          </div>
        ) : null
        if (ask && signCard) {
          return (
            <>
              {row(
                <Seal agent={owner} size="sm" />,
                null,
                <span data-testid="needs-you-ask">{ask.text}</span>,
                tp ? <Act onClick={() => changePage({ ...tp, from: origin })}>Open task</Act> : null,
                tp ? () => changePage({ ...tp, from: origin }) : undefined,
                <span data-testid="task-row-facts" className="flex min-w-0 items-baseline gap-x-2 font-mono text-[11px] text-ink-3">
                  <span className="min-w-0 truncate" title={taskTitle(item)}>
                    {ref ?? taskTitle(item)}
                  </span>
                  {item.at > 0 ? <span className="shrink-0">{relTime(item.at, nowTick)}</span> : null}
                  {where ? <span className="min-w-0 truncate max-sm:hidden">in {where}</span> : null}
                </span>,
              )}
              {signCard}
            </>
          )
        }
        const errorLine = rowError ? (
          <div className="mb-2 ml-9 max-w-[62ch]">
            <RowError text={rowError} />
          </div>
        ) : null
        // an agent's review waiting on you: Approve closes it, Send
        // back hands it back with your words — where the answers sit
        const review = ask && tv && reviewWaitsOnYou(tv, new Set(agents.map((a) => a.id)))
        if (ask && review) {
          const facts = (
            <span data-testid="task-row-facts" className="flex min-w-0 items-baseline gap-x-2 font-mono text-[11px] text-ink-3">
              <span className="min-w-0 truncate" title={taskTitle(item)}>
                {ref ?? taskTitle(item)}
              </span>
              {item.at > 0 ? <span className="shrink-0">{relTime(item.at, nowTick)}</span> : null}
              {where ? <span className="min-w-0 truncate max-sm:hidden">in {where}</span> : null}
            </span>
          )
          return (
            <div data-testid="needs-you-review">
              {row(
                <Seal agent={owner} size="sm" />,
                null,
                <span data-testid="needs-you-ask">{ask.text}</span>,
                sendingBack ? null : (
                  <>
                    <Act onClick={() => void onApprove?.(item)} primary>
                      Approve
                    </Act>
                    <Act onClick={() => setSendingBack(true)}>Send back…</Act>
                  </>
                ),
                tp ? () => changePage({ ...tp, from: origin }) : undefined,
                facts,
              )}
              {sendingBack ? (
                <div className="mb-2 ml-9 max-w-[62ch]">
                  <SendBackBox
                    owner={agentName(owner)}
                    onCancel={() => setSendingBack(false)}
                    onSend={(text) => {
                      void onAnswerWait?.(item, text).then((went) => {
                        if (went) setSendingBack(false)
                      })
                    }}
                  />
                </div>
              ) : null}
              {errorLine}
            </div>
          )
        }
        if (ask) {
          // its choices are answers, not row actions: they
          // sit under the question at its full width — pills that wrap, as
          // on the task page; on a phone each a full-width row a thumb can hit
          const choices = ask.options.length > 0
          return (
            <>
              {row(
                <Seal agent={owner} size="sm" />,
                null,
                <span data-testid="needs-you-ask">
                  {ask.text}
                  {ask.silent && tp ? (
                    <>
                      {' '}
                      ·{' '}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          changePage({ ...tp, from: origin })
                        }}
                        className="text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
                      >
                        open ›
                      </button>
                    </>
                  ) : null}
                </span>,
                choices ? (
                  <>
                    <span
                      role="group"
                      aria-label="Answers"
                      data-testid="needs-you-choices"
                      className="flex w-full flex-col gap-1.5 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:gap-2"
                    >
                      {ask.options.map((o) => (
                        <button
                          key={o}
                          type="button"
                          onClick={() => void onAnswerWait?.(item, o)}
                          title={`Answers «${o}»`}
                          className="flex min-h-11 w-full items-center rounded-lg border border-terracotta/35 bg-canvas px-3 py-2 text-left text-[13.5px] font-medium leading-snug text-terracotta hover:border-terracotta active:bg-terracotta-soft sm:min-h-0 sm:w-auto sm:rounded-full sm:bg-terracotta-soft sm:px-2.5 sm:py-0.5 sm:text-[11.5px]"
                        >
                          {o}
                        </button>
                      ))}
                    </span>
                    {onAnswerWait && owner && controlOf(owner) === 'told' ? (
                      <AnswerAndOpen item={item} owner={owner} text={ask.options[0]!} onAnswer={onAnswerWait} />
                    ) : null}
                  </>
                ) : tp ? (
                  <Act onClick={() => changePage({ ...tp, from: origin })}>Open task</Act>
                ) : null,
                tp ? () => changePage({ ...tp, from: origin }) : undefined,
                <span data-testid="task-row-facts" className="flex min-w-0 items-baseline gap-x-2 font-mono text-[11px] text-ink-3">
                  {/* the server's sentence already names the task: its ref here, its title on hover */}
                  <span className="min-w-0 truncate" title={taskTitle(item)}>
                    {ref ?? taskTitle(item)}
                  </span>
                  {item.at > 0 ? <span className="shrink-0">{relTime(item.at, nowTick)}</span> : null}
                  {where ? <span className="min-w-0 truncate max-sm:hidden">in {where}</span> : null}
                </span>,
                choices,
              )}
              {errorLine}
            </>
          )
        }
        const seal = (
          <span
            title={`${p.kind.split('/').pop()}: ${p.identity}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-ink-2"
          >
            {glyphOf(it.key)}
          </span>
        )
        const words = (
          <>
            <TaskWords itemKey={it.key}>{taskTitle(item)}</TaskWords>
            {taskWhy(item) ? <span className="text-ink-2">{taskWhy(item)}</span> : null}
          </>
        )
        if (dropping && it.resolve) {
          return (
            <div data-testid="needs-you-drop">
              {row(seal, null, words, null)}
              <div className="mb-2 ml-9 max-w-[62ch]">
                <DropConfirm
                  testId="home-drop-confirm"
                  busy={false}
                  warnings={tv ? dropWarnings(tv, tasksReading.tasks, agents, nowTick) : null}
                  onDrop={(reason) => {
                    setDropping(false)
                    onPlan(item, 'drop', reason, dropSeen)
                  }}
                  onCancel={() => setDropping(false)}
                />
              </div>
            </div>
          )
        }
        return (
          <>
            {row(
              seal,
              null,
              words,
              <>
                {it.resolve ? (
                  <>
                    <Act onClick={() => onPlan(item, 'done')} primary navDone>
                      Done
                    </Act>
                    {it.resolve.note ? <Act onClick={() => startDrop(it.silo, it.key)}>Drop…</Act> : null}
                  </>
                ) : null}
                {tp ? <Act onClick={() => changePage({ ...tp, from: origin })}>Open task</Act> : null}
              </>,
              tp ? () => changePage({ ...tp, from: origin }) : path ? () => onOpenFile(path) : undefined,
              <span data-testid="task-row-facts" title={p.identity} className="flex min-w-0 items-baseline gap-x-2 font-mono text-[11px] text-ink-3">
                {ref ? <span className="min-w-0 truncate">{ref}</span> : null}
                {item.at > 0 ? <span className="shrink-0">{relTime(item.at, nowTick)}</span> : null}
                {where ? <span className="min-w-0 truncate max-sm:hidden">in {where}</span> : null}
              </span>,
            )}
            {errorLine}
          </>
        )
      }
      // an escalated task (hierarchy): its one wake changed nothing
      // and nobody up the chain moved it — the owner's, blocking. The
      // owner's seal is the agent whose task it stays; the door is the task.
      if (it.reason === 'escalation') {
        const cut = it.key.lastIndexOf('/tasks/')
        const tp = cut > 0 ? { kind: 'task' as const, plan: it.key.slice(0, cut), task: it.key.slice(cut + '/tasks/'.length), from: origin } : null
        const a = it.agentId ? byId(it.agentId) : undefined
        return row(
          <Seal agent={a} size="sm" />,
          `${a ? agentName(a) : 'task'} · escalated · untouched ${relTime(it.escalated ? Date.parse(it.escalated.since) : item.at, nowTick)}`,
          <>
            {it.identity ? (
              <span className="font-medium">
                <TaskWords itemKey={it.key}>{it.identity}</TaskWords>
              </span>
            ) : null}
            {it.identity ? <span className="text-ink-2"> — </span> : null}
            <span className={it.identity ? 'text-ink-2' : ''}>{it.text}</span>
          </>,
          tp ? (
            <Act onClick={() => changePage(tp)} primary>
              Open task
            </Act>
          ) : null,
          tp ? () => changePage(tp) : undefined,
        )
      }
      // a submission waiting for the approval click: it opens the install
      // dialog (/silo/<id>/review), where Install / Reject live
      if (it.reason === 'submission') {
        return row(
          <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-terracotta/40 text-terracotta">
            <SiloIcon size={11} />
          </span>,
          `${it.siloName.toLowerCase()} · ${it.submission?.kind ?? 'install'}${item.at ? ` · ${relTime(item.at, nowTick)}` : ''}`,
          it.text,
          <Act onClick={() => changePage({ kind: 'silo', id: it.silo, review: true })} primary>
            Review
          </Act>,
          () => changePage({ kind: 'silo', id: it.silo, review: true }),
        )
      }
      // an active silo's row, in the manifest's own words; it opens the
      // record's own page (/silo/<id>/r/<key>), where the dispatch lives —
      // set-field, resolve, message, Seen (Task 8).
      const what = it.reason === 'conflict' ? 'conflict' : it.reason === 'proposal' ? 'proposal' : it.escalated ? 'escalated' : it.urgency
      // a routed row that rose to the owner past its window: whose it was and who was asked
      const rose = it.escalated
        ? `with ${it.escalated.with ? agentName(byId(it.escalated.with)) : 'its producer'} since ${relTime(Date.parse(it.escalated.since), nowTick)}${it.escalated.asked.length > 0 ? ` · asked ${it.escalated.asked.map((x) => agentName(byId(x))).join(', then ')}` : ''} · nobody cleared it`
        : null
      return row(
        <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-ink-2">
          <SiloIcon size={11} />
        </span>,
        `${it.siloName.toLowerCase()} · ${what}${item.at ? ` · ${relTime(item.at, nowTick)}` : ''}`,
        it.text,
        null,
        () => changePage({ kind: 'silo', id: it.silo, recordKey: it.key }),
        // a question asked after reading the web says so where it is decided
        [rose, item.readOutside ? `${item.readOutside} ›` : null].filter((x): x is string => x !== null).join(' · ') || null,
      )
    }
    case 'siloSummary': {
      // it counts and it points — the silo's list page is where the folded
      // and over-budget rows are read one by one. The kind's noun when the
      // manifest says it: «13 support tickets wait on you»
      return row(
        <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-ink-2">
          <SiloIcon size={11} />
        </span>,
        `${item.siloName.toLowerCase()}${item.at ? ` · ${relTime(item.at, nowTick)}` : ''}`,
        siloSummaryWords(item),
        null,
        () => changePage({ kind: 'silo', id: item.silo }),
      )
    }
    case 'failedRun': {
      // an automation failing in a way that won't heal on its own (the
      // server's admission table): it opens the automation's one home,
      // where its runs are; Seen = THIS failed run.
      const a = byId(item.agentId)
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} · ${failedTimes(item.streak)} · ${relTime(item.at, nowTick)}`,
        <>
          {item.automation.name}
          <span className="text-ink-2"> — {item.failure.text}</span>
        </>,
        <Act onClick={() => onSeen(item as SeenItem)}>Seen</Act>,
        () => go(item),
      )
    }
    case 'accountLimit': {
      // one account at its limit, however many automations it stopped: it
      // says the window and when it frees up; Seen = this episode (its reset)
      return row(
        <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-ink-2">
          <Gauge size={11} />
        </span>,
        `usage limit · ${relTime(item.at, nowTick)}`,
        <>
          {limitWords(item, nowTick)}
          <span className="text-ink-2"> · {stoppedWords(item.automations.map((a) => a.name))}</span>
        </>,
        <Act onClick={() => onSeen(item as SeenItem)}>Seen</Act>,
        () => go(item),
      )
    }
    case 'missedRetry': {
      // Silos promised a retry after a usage limit and it didn't happen
      const a = byId(item.agentId)
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} · retry missed · ${relTime(item.at, nowTick)}`,
        <>
          {item.automation.name}
          <span className="text-ink-2"> was due to retry at {hhmm(item.dueAt)} and didn't</span>
        </>,
        <Act onClick={() => onSeen(item as SeenItem)}>Seen</Act>,
        () => go(item),
      )
    }
    case 'territoryOff': {
      // an agent On its own whose territory
      // turned off: Only when told until it is on — the door is its Settings,
      // where the switch is
      const a = byId(item.agentId)
      const toRuns = (): void => openAgentSettings(item.agentId)
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} · territory off`,
        <>{item.voice.replace(/ ›$/, '')}</>,
        <Act onClick={toRuns}>Turn it on ›</Act>,
        toRuns,
      )
    }
    case 'folderRefused': {
      // an agent in a folder no project may have (the server's audit): the
      // reason in the check's words; the door is its Profile, where Runs on is
      const a = byId(item.agentId)
      const toProfile = (): void => openAgentSettings(item.agentId)
      return row(<Seal agent={a} size="sm" />, `${agentName(a)} · folder`, <>{item.reason}</>, <Act onClick={toProfile}>Change its folder ›</Act>, toProfile)
    }
    case 'cut': {
      // Silos cut its capability of creating work on its own
      const a = byId(item.agentId)
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} · stopped from creating work · ${relTime(item.at, nowTick)}`,
        <>{item.voice}</>,
        <span className="flex gap-2">
          <Act
            onClick={() => {
              void api.agents.update(item.agentId, { cut: null }).then(() => useStore.getState().loadOverview())
            }}
          >
            Allow again
          </Act>
          <Act onClick={() => onSeen(item as SeenItem)}>Keep stopped</Act>
        </span>,
        () => changePage({ kind: 'agent', id: item.agentId }),
      )
    }
    case 'spend': {
      // its unpriced turns: said, never held
      const a = byId(item.agentId)
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} · spend · ${relTime(item.at, nowTick)}`,
        <>{item.voice}</>,
        <Act onClick={() => onSeen(item as SeenItem)}>Seen</Act>,
        () => changePage({ kind: 'agent', id: item.agentId }),
      )
    }
    case 'auditUnreadable': {
      // (fail closed) the audit could not read the run's transcript:
      // it counts as having read outside — said, never a silent verdict
      const a = byId(item.agentId)
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} · transcript unreadable · ${relTime(item.at, nowTick)}`,
        <>{item.voice}</>,
        <Act onClick={() => onSeen(item as SeenItem)}>Seen</Act>,
        () => go(item),
      )
    }
    case 'unreadMessages': {
      // messages from one sender its recipient hasn't read past its next
      // chance (no message wakes anyone): the words
      // are the server's; the door opens a NEW conversation of the
      // recipient — any conversation starts with its inbox, and Silos marks
      // them read. Seen = up to its newest message (a newer one brings it back).
      const a = byId(item.agentId)
      // the surface Open goes to (give.ts): its console when the agent has
      // one in the index (server open-surface.ts), chat when not
      const surface = surfaceOfAgent(a)
      const open = (): void => {
        setChatMode(surface)
        useStore.getState().selectAgent(item.agentId)
        useStore.getState().startNewConversation()
      }
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} · unread ${item.count === 1 ? 'message' : 'messages'} · ${relTime(item.at, nowTick)}`,
        <>{item.voice}</>,
        <span className="flex gap-2">
          {/* a held message (they share no project) is never served: no door opens a conversation for it */}
          {a && item.why !== 'noProject' ? (
            <Act primary onClick={open}>
              {openLabel(surface)}
            </Act>
          ) : null}
          <Act onClick={() => onSeen(item as SeenItem)}>Seen</Act>
        </span>,
        () => changePage({ kind: 'agent', id: item.agentId }),
      )
    }
    case 'tasksStalled': {
      // the stalls of agents Silos does not wake, one row: it counts
      // and opens the stalled view — never one row per task
      return row(
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--health-amber)_45%,transparent)] text-[var(--health-amber)]"
        >
          <Square size={10} />
        </span>,
        `tasks · untouched${item.at > 0 ? ` · ${relTime(item.at, nowTick)}` : ''}`,
        stalledTasksWords(item),
        null,
        () => navigateToRoute(stalledTasksDoor(item)),
      )
    }
    case 'waitsOnRelay': {
      // an agent's task waits on another agent that
      // nothing carries the question to yet: the owner relays it — the
      // server's words, the door is the task
      const a = byId(item.task.owner)
      const open = (): void => {
        const p = taskPageOfKey(item.task.key)
        if (p) changePage({ ...p, from: origin })
      }
      return row(
        a ? (
          <Seal agent={a} size="sm" />
        ) : (
          <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-ink-2">
            <Square size={10} />
          </span>
        ),
        `${item.task.ref} · you relay`, // who waits on whom is the sentence's, said once
        <>{item.voice}</>,
        <Act onClick={open}>Open ›</Act>,
        open,
      )
    }
    case 'consoleIdle': {
      // an open console nobody uses holds its task's
      // wakes: the server's words; the door is that conversation; Seen for
      // this hold (a new one comes back)
      const a = byId(item.agentId)
      const open = item.session.folder ? (): void => void openSession(item.session.folder!, item.session.id) : undefined
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} · console open and idle · ${relTime(Date.parse(item.heldSince), nowTick)}`,
        <>{item.voice}</>,
        <span className="flex flex-wrap gap-2">
          {open ? <Act onClick={open}>Open ›</Act> : null}
          <Act onClick={() => onSeen(item as SeenItem)}>Seen</Act>
        </span>,
        open,
      )
    }
    case 'tasksUnreadable': {
      // tasks a plan file holds that can't be read: in no list, no
      // flow, no wake — the reason of the first; fixed only in its file, so
      // the door is the plan's read-only file (planDoor)
      const door = planDoor({ key: item.plan.key, file: item.plan.file, unreadable: true })
      const open = door ? (): void => openPlanDoor(door, changePage) : undefined
      return row(
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--health-amber)_45%,transparent)] text-[var(--health-amber)]"
        >
          <Square size={10} />
        </span>,
        `tasks · can't be read`,
        <>{item.voice}</>,
        open ? <Act onClick={open}>Open file ›</Act> : null,
        open,
      )
    }
    case 'closedPlansOpen': {
      // closed plans still holding open tasks: one quiet row, a door
      // per plan — its read-only file (planDoor: a closed plan is in no list)
      return row(
        <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-ink-2">
          <Square size={10} />
        </span>,
        'plans · closed',
        <>{item.voice}</>,
        <span className="flex flex-wrap gap-2">
          {item.plans.map((p) => {
            const door = planDoor({ key: p.key, file: p.file, closed: true })
            return door ? <Act key={p.key} onClick={() => openPlanDoor(door, changePage)}>{`${p.title} (${p.open}) ›`}</Act> : null
          })}
        </span>,
      )
    }
    case 'ownTurnsCeiling': {
      // an agent's own starts at its daily max, or its spend at its cap:
      // the next waits for tomorrow; the max lives in the
      // agent's control block, on its Now. The row says WHY: the server's line under the head — what the count, or the
      // money, was made of — and «See today ›» opens that day
      const a = byId(item.agentId)
      const why = typeof item.why === 'string' && item.why.trim() !== '' ? item.why : null
      const seeToday = (): void => changePage(seeTodayDoor(item.agentId))
      return row(
        <Seal agent={a} size="sm" />,
        `${agentName(a)} · ${item.cap === 'spend' ? 'spend cap' : 'daily max'} · ${relTime(item.at, nowTick)}`,
        wakeCeilingWords(item, agentName(a)),
        <>
          {/* nothing is lifted unsaid — what the button lifts is said
              in the row's words above it, the label stays short */}
          <ContinueToday agentId={item.agentId} day={item.day} />
          <Act onClick={() => openAgentControl(item.agentId)}>Raise ›</Act>
          <Act onClick={seeToday}>See today ›</Act>
        </>,
        () => changePage({ kind: 'agent', id: item.agentId }),
        <>
          {why ? `${why.trim().replace(/([^.])$/, '$1.')} ` : ''}
          {CONTINUE_LIFTS}
        </>,
        true,
      )
    }
    case 'integrity': {
      // the seal: «changed outside Silos» and its doors — Keep the
      // edit adopts after validation, Discard trashes the set-aside copy;
      // what appeared in a plugin goes back or away file by file; an edited
      // plugin is held out of load right here, one touch — the row
      // says the consequence: its engine loads it on its next conversation
      const seal = item.seal
      const done = (p: Promise<unknown>): void => {
        void p.then(() => useStore.getState().loadOverview()).catch(() => {})
      }
      const a = item.agentId ? byId(item.agentId) : undefined
      const acts: ReactNode[] = []
      for (const d of item.doors) {
        if (d === 'Keep the edit')
          acts.push(
            <Act key="k" onClick={() => done(api.seals.act(seal.id, 'keep'))}>
              Keep the edit
            </Act>,
          )
        else if (d === 'Discard')
          acts.push(
            <Act key="d" onClick={() => done(api.seals.act(seal.id, 'discard'))}>
              Discard
            </Act>,
          )
        else if (seal.kind === 'pluginAppeared') {
          for (const f of seal.files) {
            acts.push(<Act key={`p:${f.path}`} onClick={() => done(api.seals.file(seal.id, 'put-back', f.path))}>{`Put back ${f.path}`}</Act>)
            acts.push(
              <Act key={`x:${f.path}`} onClick={() => done(api.seals.file(seal.id, 'delete', f.path))}>
                Delete
              </Act>,
            )
          }
        } else if (seal.kind === 'pluginChanged' && d === 'Hold')
          acts.push(
            <Act key="h" onClick={() => done(api.seals.act(seal.id, 'hold'))}>
              Hold
            </Act>,
          )
        else if (seal.kind === 'unverified')
          acts.push(
            <Act key="r" onClick={() => done(api.seals.act(seal.id, 'keep'))}>
              Keep the edit
            </Act>,
          )
      }
      acts.push(
        <Act key="seen" onClick={() => done(api.seals.act(seal.id, 'seen'))}>
          Seen
        </Act>,
      )
      return row(
        a ? (
          <Seal agent={a} size="sm" />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--health-amber)_45%,transparent)] text-[var(--health-amber)]"
          >
            <Gauge size={11} />
          </span>
        ),
        `changed outside Silos · ${relTime(item.at, nowTick)}`,
        <>{item.voice}</>,
        <span className="flex flex-wrap gap-2">{acts}</span>,
      )
    }
    case 'engineCompat': {
      // the engines Silos refuses (older than it needs, missing) or must
      // catch up with (server inbox.ts engineCompatRow): ONE row — the
      // verdict's own line when it is one engine, the engines by name when
      // several — naming who can't run; the door is Settings › Engines,
      // where each engine's Update is
      // A row here is one Silos refuses work on (isWaiting); an engine it
      // only has to catch up with is the quiet note beside the pulse.
      const engines = refusingEngines(item.engines)
      const refused = [...new Set(engines.flatMap((e) => e.agentIds))]
      const who = refused.map((id) => agentName(byId(id)))
      const toSettings = (): void => changePage({ kind: 'settings', tab: 'engines' })
      return row(
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--health-amber)_45%,transparent)] text-[var(--health-amber)]"
        >
          <Gauge size={11} />
        </span>,
        `${engines.length === 1 ? 'engine' : 'engines'} · ${who.length <= 2 ? who.join(' and ') : `${who.slice(0, 2).join(', ')} and ${who.length - 2} more`} can't run`,
        engines.length === 1 ? (
          <>{engines[0]!.message}</>
        ) : (
          <>
            {engines.map((e, i) => (
              <Fragment key={e.harness}>
                {i > 0 ? ', ' : ''}
                {e.name} <span className="font-mono">{e.installed ?? 'missing'}</span>
              </Fragment>
            ))}
            <span className="text-ink-2"> — Silos needs {engines.map((e) => `${e.name} ${e.needed}`).join(', ')}</span>
          </>
        ),
        <Act onClick={toSettings}>{engines.every((e) => e.state === 'missing') ? 'Install ›' : 'Update ›'}</Act>,
        toSettings,
      )
    }
    case 'engineUnwired': {
      // the engine is on the machine but not wired to Silos (its two hooks
      // are not installed): without them a conversation the owner opens
      // starts without the agent's inbox, the birth marker or the cron
      // gate. The door is Settings › Engines; Silos never installs them by
      // itself — the first run's Create is the gesture that does.
      const toSettings = (): void => changePage({ kind: 'settings', tab: 'engines' })
      return row(
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--health-amber)_45%,transparent)] bg-[color-mix(in_srgb,var(--health-amber)_12%,transparent)] text-[color-mix(in_srgb,var(--health-amber)_80%,var(--ink))]"
        >
          <Gauge size={12} aria-hidden="true" />
        </span>,
        `engine · ${item.engine} isn't wired`,
        <>{item.voice}</>,
        <Act onClick={toSettings}>Wire it ›</Act>,
        toSettings,
      )
    }
    case 'plansBaseline': {
      // the tasks a folder had before Silos watched it: no
      // agent starts them on its own until the owner keeps them — in ONE
      // gesture, not N touches for their own history. The sheet lists them
      // and leaves some out; those stay «added outside Silos», one by one.
      const n = item.tasks.length
      const toggle = (k: string): void =>
        setExcluded((prev) => {
          const next = new Set(prev)
          if (next.has(k)) next.delete(k)
          else next.add(k)
          return next
        })
      const left = item.tasks.filter((t) => excluded.has(t.key)).map((t) => t.key)
      return (
        <>
          {row(
            <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-ink-2">
              <Square size={10} />
            </span>,
            'tasks · before Silos',
            <>{baselineWords(n)}</>,
            <Act onClick={() => setUnfolded((u) => !u)} primary>
              Keep them all ›
            </Act>,
            () => setUnfolded((u) => !u),
          )}
          {unfolded ? (
            <div className="mb-2 ml-9 max-w-[62ch] rounded-lg border border-line/70 bg-panel/50 px-3.5 py-2.5" data-testid="baseline-sheet">
              <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                {item.tasks.map((t) => {
                  const p = taskPageOfKey(t.key)
                  return (
                    <li key={t.key} className="flex items-baseline gap-2.5 text-[13px]">
                      <input
                        type="checkbox"
                        checked={!excluded.has(t.key)}
                        onChange={() => toggle(t.key)}
                        aria-label={`Keep ${t.title}`}
                        data-testid="baseline-task"
                        className="translate-y-[1px] accent-[var(--terracotta)]"
                      />
                      {p ? (
                        <button
                          type="button"
                          onClick={() => changePage({ ...p, from: origin })}
                          className={`min-w-0 truncate text-left hover:text-terracotta ${excluded.has(t.key) ? 'text-ink-3 line-through decoration-ink-3/60' : 'text-ink'}`}
                        >
                          {t.title}
                        </button>
                      ) : (
                        <span className={`min-w-0 truncate ${excluded.has(t.key) ? 'text-ink-3 line-through' : 'text-ink'}`}>{t.title}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="mt-2.5 flex items-center gap-3">
                <Act onClick={() => onBaseline(item, left)} primary>
                  {baselineKeepWords(n, left.length)}
                </Act>
                <Act
                  onClick={() => {
                    setUnfolded(false)
                    setExcluded(new Set())
                  }}
                >
                  Not now
                </Act>
              </div>
            </div>
          ) : null}
        </>
      )
    }
    case 'taskLine':
      return null
    case 'agentSummary': {
      // one agent's rows past its budget: it counts and it points — to its
      // automations when they are all failing runs, else to the agent
      const a = byId(item.agentId)
      return row(
        <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-ink-2">
          <AutomationIcon size={11} />
        </span>,
        `${agentName(a)} · ${relTime(item.at, nowTick)}`,
        <>
          {item.count} {item.runsOnly ? 'automations failing' : 'things need you'}
          <span className="text-ink-2"> — newest: {item.newest}</span>
        </>,
        null,
        () => go(item),
      )
    }
  }
}

// what an agent row says in one word, most alive first: asks you · working
// · nested · done today · its next beat · quiet
function agentWord(row: FleetRow, view: HeartbeatView | null, now: number): { text: string; live: boolean } {
  if (row.asks.length > 0) return { text: 'asks you', live: true }
  if (row.working.length > 0) return { text: `${row.working.length} working`, live: true }
  if (row.nested.length > 0) return { text: `${row.nested.length} nested`, live: true }
  // a dropped record closed today is not «done today»
  const done = row.done.length + row.siloDone.filter((d) => !d.drop).length
  if (done > 0) return { text: `${done} done today`, live: false }
  if (view?.next && !view.sleeping) return { text: `next ${hhmm(view.next)}`, live: false }
  return { text: row.lastActive ? relTime(row.lastActive, now) : 'quiet', live: false }
}

function signalOf(row: FleetRow): 'working' | 'attention' | null {
  return row.asks.length > 0 ? 'attention' : row.working.length > 0 || row.nested.length > 0 ? 'working' : null
}

// a Needs you row's mark in a tile preview: its agent's emoji, else its kind's glyph
function rowMark(i: InboxItem, byId: (id: string) => AgentView | undefined): ReactNode {
  const id = 'agentId' in i && typeof i.agentId === 'string' ? i.agentId : null
  if (id && byId(id)) return byId(id)!.emoji
  if (isTaskRow(i)) return <Square size={11} className="text-ink-3" />
  if (i.kind === 'siloSummary' || i.kind === 'silo') return <SiloIcon size={12} className="text-ink-3" />
  if (i.kind === 'accountLimit' || i.kind === 'engineCompat' || i.kind === 'engineUnwired') return <Gauge size={12} className="text-ink-3" />
  return <AutomationIcon size={11} className="text-ink-3" />
}

// a task's status in a Tile's preview line: its glyph once the plans are read
// a task's title on Home: in semibold while it is new to the owner
function TaskWords({ itemKey, children }: { itemKey: string; children: ReactNode }) {
  const reading = useTasks()
  const fresh = useNewTasks(reading.tasks)
  const on = fresh.has(itemKey)
  return (
    <span data-task-words {...(on ? { 'data-new': 'true' } : {})} className={on ? 'font-semibold' : undefined}>
      <NewWord on={on} />
      {children}
    </span>
  )
}

function TaskRowGlyph({ rowKey, agents, now }: { rowKey: string; agents: readonly AgentView[]; now: number }) {
  const reading = useTasks()
  const t = reading.tasks.find((x) => x.key === rowKey)
  return t ? <TaskGlyph t={t} plan={siblingsOf(reading.tasks, t.planKey)} agents={agents} now={now} /> : <Square size={11} className="text-ink-3" />
}

// an agent on its project's page: its seal and name, its duty, and what is
// true of it today — the tile is the door to the agent's page.
function AgentTile({ row, view, now, folder }: { row: FleetRow; view: HeartbeatView | null; now: number; folder?: string }) {
  const changePage = useStore((s) => s.changePage)
  const a = row.agent
  const w = agentWord(row, view, now)
  const lines: TileLine[] = [
    ...row.asks.map((s) => ({ key: `a:${s.id}`, mark: <SessionDot signal="attention" />, text: s.title, meta: 'asks you' })),
    ...row.working.map((s) => ({ key: `w:${s.id}`, mark: <SessionDot signal="working" />, text: s.title, meta: relTime(s.mtime, now) })),
    ...row.done.map((c) => ({ key: `d:${c.id}`, mark: <span className="text-[11px] text-ink-3">✓</span>, text: c.title, meta: 'done' })),
    // closed without being done (a dropped task): ✕ and its own word, never ✓ done
    ...row.siloDone.map((d, i) =>
      d.drop
        ? { key: `s:${i}`, mark: <span className="text-[11px] text-ink-3">✕</span>, text: d.identity, meta: d.toLabel }
        : { key: `s:${i}`, mark: <span className="text-[11px] text-ink-3">✓</span>, text: `${d.identity} ${d.toLabel}`, meta: 'done' },
    ),
  ]
  // its mission, under its name (the duty is no longer shown)
  const duty = (a.mission?.text ?? '').trim()
  // of this project through a folder AROUND this one (folders that nest are
  // one project): said «from acme», so the page never reads as its own
  const around = folder ? aroundFolder(a, folder) : null
  return (
    <Tile
      testId="agent-tile"
      name={w.text}
      live={row.asks.length > 0}
      door="Open"
      onOpen={() => changePage({ kind: 'agent', id: a.id })}
      lead={
        <span className="flex items-center gap-2.5">
          <Seal agent={a} signal={signalOf(row)} />
          {agentName(a)}
          {around ? (
            <span data-testid="agent-tile-from" title={around} className="self-end pb-[3px] font-body text-[12px] text-ink-3">
              from {basename(around)}
            </span>
          ) : null}
        </span>
      }
      lines={lines}
      more={lines.length > PREVIEW_MAX ? `${lines.length - PREVIEW_MAX} more` : null}
    >
      {duty ? <span className="line-clamp-2 text-[12.5px] leading-snug text-ink-2">{duty}</span> : null}
    </Tile>
  )
}

// what the last Done/Drop handed to agents (and whether they will move) —
// and, after a Drop, what it left hanging: the tasks that now wait on a
// dropped task, one door to them
export interface Stranded {
  words: string
  door: { kind: 'task'; plan: string; task: string }
}
function Handoff({ handoff, stranded = null, onClear }: { handoff: PlanHandoff[]; stranded?: Stranded | null; onClear: () => void }) {
  const changePage = useStore((s) => s.changePage)
  if (handoff.length === 0 && !stranded) return null
  return (
    <div data-testid="plan-handoff" className="mt-2 flex items-start gap-2 text-xs text-ink-2">
      <ul className="min-w-0 flex-1 space-y-0.5">
        {handoffWords(handoff).map((h) => (
          <li key={h.agentId}>
            {h.text}
            {h.open ? (
              <>
                {' '}
                <button type="button" onClick={() => changePage({ kind: 'agent', id: h.agentId })} className="font-medium text-terracotta hover:underline">
                  Open {handoff.find((x) => x.agentId === h.agentId)?.agentName} ›
                </button>
              </>
            ) : null}
          </li>
        ))}
        {stranded ? (
          <li data-testid="plan-stranded" className="text-[var(--health-amber)]">
            <button type="button" onClick={() => changePage(stranded.door)} className="text-left hover:underline">
              {stranded.words} ›
            </button>
          </li>
        ) : null}
      </ul>
      <button type="button" aria-label="Dismiss" onClick={onClear} className="shrink-0 rounded p-0.5 text-ink-3 hover:text-ink">
        ✕
      </button>
    </div>
  )
}

// The head's one calm line: whatever the caller leads with
// (silo rows routed to a producer, platform closes) and then "who is on my
// Claude subscription right now", one phrase per account
// in use, counted from the
// process table — consoles, Silos' chats and runs, nested runs, and the
// claudes outside Silos (a plugin's daemon, the owner's own terminal).
// It unfolds in place into the groups behind the counts. Nothing running,
// or a machine whose /proc can't be read → no line at all.
function AmbientLine({ agents, lead }: { agents: readonly AgentView[]; lead: readonly ReactNode[] }) {
  const changePage = useStore((s) => s.changePage)
  const [load, setLoad] = useState<AccountLoad | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    const fetchLoad = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      Promise.resolve(api.accountLoad())
        .then((r) => {
          if (!cancelled && r) setLoad(r)
        })
        .catch(() => {
          if (!cancelled) setLoad(null) /* no line beats a stale count */
        })
    }
    fetchLoad()
    const t = setInterval(fetchLoad, ACCOUNT_LOAD_POLL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') fetchLoad()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  const lines = load && load.supported ? accountLoadLines(load) : []
  const items: ReactNode[] = [...lead]
  if (load && lines.length > 0) {
    items.push(
      // a span, not a <button>: Chrome lays a button out as one atomic box
      // whatever its display, so the long phrase could never wrap mid-line
      <span
        key="load"
        role="button"
        tabIndex={0}
        data-testid="account-load"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
        }}
        className="cursor-pointer rounded-sm hover:text-terracotta focus-visible:outline focus-visible:outline-1 focus-visible:outline-terracotta"
      >
        {lines.map((l, i) => (
          <span key={l.account}>
            {i > 0 ? (
              <span aria-hidden="true" className="text-ink-3">
                {' '}
                ·{' '}
              </span>
            ) : null}
            {l.text}
          </span>
        ))}
      </span>,
    )
  }
  if (items.length === 0) return null
  const nameOf = (id: string): string | null => {
    const a = agents.find((x) => x.id === id)
    return a ? agentName(a) : null
  }
  return (
    <div data-testid="home-ambient" className="border-t border-line/70 pt-4 text-[12px] leading-relaxed text-ink-3">
      {/* running text, so a long line wraps mid-phrase and a separator never
          opens a line on its own */}
      <p>
        {items.map((it, i) => (
          <Fragment key={i}>
            {i > 0 ? (
              <span aria-hidden="true" className="text-ink-3">
                {' '}
                ·{' '}
              </span>
            ) : null}
            {it}
          </Fragment>
        ))}
      </p>
      {open && load && load.supported ? (
        <div className="mt-1.5 flex flex-col gap-2 border-l border-line pl-3">
          {load.accounts
            .filter((e) => lines.some((l) => l.account === e.account))
            .map((e) => (
              <ul key={e.account} aria-label={`On ${e.account}`} className="flex flex-col gap-0.5 text-[12px]">
                {lines.length > 1 ? <li className="text-ink-3">{e.account}</li> : null}
                {accountLoadGroups(e, nameOf).map((g) => (
                  <li key={g.key} className="flex items-baseline gap-2">
                    {g.agentId ? (
                      <button type="button" onClick={() => changePage({ kind: 'agent', id: g.agentId! })} className="text-ink hover:text-terracotta">
                        {g.label}
                      </button>
                    ) : (
                      <span className="text-ink">{g.label}</span>
                    )}
                    <span className="text-ink-3">{g.what}</span>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      ) : null}
    </div>
  )
}

// One plan, one row (a plan's tasks were a row EACH — the
// fiscal plan alone filled a screen). The row names the plan and the next
// thing of yours in it; a click unfolds its tasks in place, each with Done.
function PlanGroupRow({
  plan,
  now,
  origin,
  onDone,
  rowError,
}: {
  plan: PlanGroup
  now: number
  origin: TaskOrigin
  onDone: (item: TaskItem) => void
  rowError?: { key: string; text: string } | null
}) {
  const [open, setOpen] = useState(false)
  const changePage = useStore((s) => s.changePage)
  const n = plan.tasks.length
  const first = plan.tasks[0]!
  return (
    <li className="py-2.5" data-testid="plan-group">
      <div className="flex items-start gap-3">
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="group/p flex min-w-0 flex-1 items-start gap-3 text-left">
          <span
            aria-hidden="true"
            className={`flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border px-1 font-mono text-[11px] ${open ? 'border-ink-3 text-ink' : 'border-line text-ink-2'}`}
          >
            {n}
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 max-w-[62ch] text-[14px] leading-snug text-ink group-hover/p:text-terracotta">{plan.title}</span>
            {!open ? (
              <span className="mt-0.5 block max-w-[62ch] truncate font-mono text-[11px] text-ink-2">
                {n === 1 ? 'yours: ' : 'next: '}
                {taskTitle(first)}
              </span>
            ) : null}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-3 pt-0.5">
          {plan.updatedAt !== null ? <span className="hidden font-mono text-[11px] text-ink-3 sm:inline">{relTime(plan.updatedAt, now)}</span> : null}
          {/* the plan's house — Tasks narrowed to it; its file is a door from there */}
          <Act onClick={() => openPlanDoor(planDoor({ key: plan.key })!, changePage)}>{`Open ${plan.kind} ›`}</Act>
        </span>
      </div>
      {open ? (
        <ul className="ml-9 mt-1 divide-y divide-line/50">
          {plan.tasks.map((t) => (
            <li key={inboxKey(t)} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
              <Square size={11} aria-hidden="true" className="mt-1 shrink-0 text-ink-3" />
              {taskPageOf(t) ? (
                <button
                  type="button"
                  onClick={() => changePage({ ...taskPageOf(t)!, from: origin })}
                  className="min-w-0 flex-1 text-left text-[13.5px] leading-snug text-ink hover:text-terracotta"
                >
                  <TaskWords itemKey={t.item.key}>{taskTitle(t)}</TaskWords>
                </button>
              ) : (
                <span className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink">{taskTitle(t)}</span>
              )}
              {t.item.resolve ? <Act onClick={() => onDone(t)}>Done</Act> : null}
              {rowError?.key === t.item.key ? <RowError text={rowError.text} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

// a refused gesture, under the row whose control caused it
function RowError({ text }: { text: string }) {
  return (
    <p role="alert" data-testid="needs-you-row-error" className="basis-full text-[12px] text-terracotta">
      {text.charAt(0).toUpperCase()}
      {text.slice(1)}
      {/[.!?]$/.test(text) ? '' : '.'}
    </p>
  )
}

// The project's list is no plan: its tasks hang straight
// from the project in the sheet — a row each, the same row a plan's unfolded
// task is, with the plan row's measure (the count box's column holds the
// task's own state) — never a plan head, never a count
function LooseTaskRow({
  item,
  now,
  origin,
  onDone,
  rowError,
}: {
  item: TaskItem
  now: number
  origin: TaskOrigin
  onDone: (item: TaskItem) => void
  rowError?: { key: string; text: string } | null
}) {
  const changePage = useStore((s) => s.changePage)
  const agents = useStore((s) => s.agents)
  const page = taskPageOf(item)
  const at = item.at > 0 ? item.at : null
  return (
    <li className="py-2.5" data-testid="loose-task">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex h-6 min-w-6 shrink-0 items-center justify-center text-[12px]">
          <TaskRowGlyph rowKey={item.item.key} agents={agents} now={now} />
        </span>
        {page ? (
          <button
            type="button"
            onClick={() => changePage({ ...page, from: origin })}
            className="min-w-0 flex-1 pt-[3px] text-left text-[14px] leading-snug text-ink hover:text-terracotta"
          >
            <TaskWords itemKey={item.item.key}>{taskTitle(item)}</TaskWords>
          </button>
        ) : (
          <span className="min-w-0 flex-1 pt-[3px] text-[14px] leading-snug text-ink">{taskTitle(item)}</span>
        )}
        <span className="flex shrink-0 items-center gap-3 pt-0.5">
          {at !== null ? <span className="hidden font-mono text-[11px] text-ink-3 sm:inline">{relTime(at, now)}</span> : null}
          {item.item.resolve ? <Act onClick={() => onDone(item)}>Done</Act> : null}
        </span>
      </div>
      {rowError?.key === item.item.key ? (
        <div className="ml-9">
          <RowError text={rowError.text} />
        </div>
      ) : null}
    </li>
  )
}

// The Needs you sheet's list under the keyboard: j k Enter, d on a task of yours;
// the order holds still while it is worked (hooks/useTaskKeys). A row that left
// keeps its gap, drawn from what it last said. A task's row answers to the task's
// key, so the walk from its page and this list are one list.
const navKeyOf = (i: InboxItem): string => inboxTaskKey(i) ?? inboxKey(i)
function NeedsYouList({ waiting, folder, renderRow }: { waiting: readonly InboxItem[]; folder: string | undefined; renderRow: (i: InboxItem) => ReactNode }) {
  const root = useRef<HTMLUListElement>(null)
  const holdId = inboxHoldId('needs-you', folder)
  const known = useRef(new Map<string, InboxItem>())
  for (const i of waiting) known.current.set(navKeyOf(i), i)
  const fresh = useMemo(() => waiting.map(navKeyOf), [waiting])
  const held = useHeldOrder(holdId, fresh, { arrivingAt: holdId })
  const { help, setHelp } = useListCursor({ root, holdId, order: () => fresh })
  return (
    <>
      <p className="mt-1 hidden justify-end md:flex">
        <KeyHint onOpen={() => setHelp(true)} />
      </p>
      <ul ref={root} className="divide-y divide-line/60">
        {held.keys.map((k) => {
          const i = known.current.get(k)
          return i ? (
            <li key={k} data-nav-row={k} className="-mx-2 px-2" {...(held.gone.has(k) ? { 'data-gone': 'true' } : {})}>
              {renderRow(i)}
            </li>
          ) : null
        })}
      </ul>
      {help ? <KeyHelp onClose={() => setHelp(false)} /> : null}
    </>
  )
}

// «Coming to you · N»: your tasks that are not ready yet — a still
// fold in the Yours to do sheet, each with its wait in the server's words;
// never counted as yours to do, never in the pulse. One that will never be
// ready on its own (the kernel's stall — a dropped task before it) is not
// «coming»: it says it is stuck, and why, and its page has the way out.
function ComingToYou({ line, tasks, origin }: { line: TaskLineRow; tasks: readonly TaskView[]; origin: TaskOrigin }) {
  const [open, setOpen] = useState(false)
  const changePage = useStore((s) => s.changePage)
  const items = line.items.map((i) => {
    const t = tasks.find((x) => x.key === i.key)
    const stuck = t ? stallLine(t, siblingsOf(tasks, t.planKey)) : null
    return { key: i.key, title: i.title, says: stuck ? `untouched — ${stuck}` : (i.says ?? ''), stuck: stuck !== null }
  })
  const stuck = items.filter((i) => i.stuck).length
  return (
    <div data-testid="yours-coming-fold" className="py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 py-1.5 text-left text-[13px] text-ink-2 hover:text-ink"
      >
        <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center font-mono text-[11px] text-ink-3">
          →
        </span>
        <span className="min-w-0 flex-1">
          {taskLineWords(line)}
          {stuck > 0 ? (
            <span data-testid="yours-coming-stuck" className="text-terracotta">
              {' '}
              · {stuck} untouched
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <ul className="ml-9 divide-y divide-line/50">
          {items.map((t) => (
            <li key={t.key}>
              <button
                type="button"
                onClick={() => {
                  const p = taskPageOfKey(t.key)
                  if (p) changePage({ ...p, from: origin })
                }}
                className="flex w-full min-w-0 items-baseline gap-3 py-1.5 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink hover:text-terracotta">{t.title}</span>
                <span title={t.says} className={`min-w-0 max-w-[55%] truncate font-mono text-[11px] ${t.stuck ? 'text-terracotta' : 'text-ink-3'}`}>
                  {t.says}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// «3 conversations finished today»
function finishedWords(n: number): string {
  return `${n} ${n === 1 ? 'conversation' : 'conversations'} finished today`
}

// `scope`: the project page is this SAME page scoped to a folder
// (docs/product.md surface map) — every signal filtered once at the input
// (lib/home.ts scopeToFolder), the sections unchanged. Scoped, the date
// line and the lenses are the project header's business, not ours.
// `after`: what the scoped page appends below the agents, inside the same
// measure and scroll (the project's orphans and its machinery line).
export function HomePage({ scope, after }: { scope?: { folder: string }; after?: ReactNode } = {}) {
  const allAgents = useStore((s) => s.agents)
  const allAutomations = useStore((s) => s.automations)
  const allPending = useStore((s) => s.automationsPending)
  const nowTick = useStore((s) => s.nowTick)
  const changePage = useStore((s) => s.changePage)

  const [allCards, setAllCards] = useState<BoardCard[]>([])
  const [allNeedsYou, setAllNeedsYou] = useState<NeedsYouItem[]>([])
  // THE inbox, composed by the server (server/src/inbox.ts)
  const [allInbox, setAllInbox] = useState<InboxItem[]>([])
  // until the first board answer the inbox is unknown — never "nothing waits"
  const [inboxLoaded, setInboxLoaded] = useState(false)
  // the FIRST board read failed (nothing on screen yet): the pulse must say
  // so instead of asserting quiet — the poll keeps retrying on its own
  const [boardFailed, setBoardFailed] = useState(false)
  // what the active silos add (pulse terms, Done today) — null while none is active
  const [siloBoard, setSiloBoard] = useState<SiloBoard | null>(null)
  // background work (c1): the Tasks payload, for the per-conversation
  // "· N background" suffix on working lines. Same poll cadence as the board.
  const [tasksSessions, setTasksSessions] = useState<TasksSession[]>([])
  // each On-its-own agent's heartbeat (its next fire, «next 09:07»)
  const [autonomy, setAutonomy] = useState<Record<string, HeartbeatView>>({})
  const [viewerPath, setViewerPath] = useState<string | null>(null)
  const [planNotice, setPlanNotice] = useState<string | null>(null)
  const [doneGone, setDoneGone] = useState<Set<string>>(new Set())
  // permission asks answered here (optimistic), by permission id → when;
  // hidden only for a grace window while still listed (lib/home.ts answerHidden)
  const [answered, setAnswered] = useState<Map<string, number>>(new Map())
  // rows marked seen, by key + the version their ack names — a newer version
  // of the same row (a new escalation, a new failed run) shows.
  const [seenGone, setSeenGone] = useState<Set<string>>(new Set())
  const [inboxNotice, setInboxNotice] = useState<string | null>(null)
  // what the last Done/Drop handed to agents (and whether they will move)
  const [handoff, setHandoff] = useState<PlanHandoff[]>([])
  const [stranded, setStranded] = useState<Stranded | null>(null)
  // bumped after an ack: re-runs the board load below (and restarts its poll)
  const [boardTick, setBoardTick] = useState(0)
  // a `silos` WS event (an active silo's rows changed, the clock included)
  const siloTick = useStore((s) => s.siloTick)
  // the server's inbox moved (an `inbox` WS event) or a run ended
  const inboxTick = useStore((s) => s.inboxTick)
  // the daily digest band (server/src/digest-job.ts): unscoped Home only —
  // the digest is fleet-wide. Re-read with the inbox (a `digest` WS event
  // bumps the same tick); Seen hides it at once and posts the date.
  const [digest, setDigest] = useState<DigestBandData | null>(null)
  const [digestBusy, setDigestBusy] = useState(false)
  // Home's «Since …»: read ONCE per tab — reading
  // stamps the visit — unscoped Home only (it is the whole install's)
  const [since, setSince] = useState<HomeSince | null>(null)
  useEffect(() => {
    if (scope) return
    let cancelled = false
    Promise.resolve(api.home?.since())
      .then((r) => {
        if (!cancelled && r) setSince(r)
      })
      .catch(() => {
        /* no band rather than a wrong one */
      })
    return () => {
      cancelled = true
    }
  }, [scope])
  useEffect(() => {
    if (scope) return
    let cancelled = false
    Promise.resolve(api.digest?.get())
      .then((r) => {
        if (!cancelled && r) setDigest(r.band)
      })
      .catch(() => {
        /* unread: no band rather than a stale one */
      })
    return () => {
      cancelled = true
    }
  }, [scope, inboxTick])

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      Promise.resolve(api.board())
        .then((b) => {
          if (!cancelled && b) {
            setAllCards(b.cards)
            setAllNeedsYou(b.needsYou)
            setAllInbox(b.inbox)
            setInboxLoaded(true)
            setBoardFailed(false)
            setSiloBoard(b.silos ?? null)
            setAnswered((prev) => pruneAnswered(prev, b.needsYou))
            setDoneGone((prev) => stillListed(prev, b.inbox))
          }
        })
        .catch(() => {
          if (!cancelled) setBoardFailed(true) /* with an answer on screen it stays; the next poll retries */
        })
      Promise.resolve(api.tasks())
        .then((r) => {
          if (!cancelled && r) setTasksSessions(r.sessions)
        })
        .catch(() => {
          /* without it the working lines just omit the background counts */
        })
    }
    load()
    const t = setInterval(load, BOARD_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [boardTick, siloTick, inboxTick])

  const folder = scope?.folder
  const { agents, cards } = useMemo(() => {
    const all = { agents: allAgents, cards: allCards, needsYou: allNeedsYou, pending: allPending, automations: allAutomations }
    return folder ? scopeToFolder(all, folder, MASTER_ID) : all
  }, [folder, allAgents, allCards, allNeedsYou, allPending, allAutomations])

  const inCharge = useMemo(() => agents.filter((a) => !a.archived && a.control === 'own'), [agents])
  const inChargeIds = inCharge.map((a) => a.id).join('\0')
  useEffect(() => {
    let cancelled = false
    const ids = inChargeIds ? inChargeIds.split('\0') : []
    const load = (): void => {
      for (const id of ids) {
        Promise.resolve(api.agents.heartbeat?.(id))
          .then((v) => {
            if (!cancelled && v) setAutonomy((prev) => ({ ...prev, [id]: v }))
          })
          .catch(() => {
            /* an agent without state: the row says so */
          })
      }
    }
    load()
    const t = setInterval(load, HEARTBEAT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [inChargeIds])

  // the server's rows — scoped to the folder on a project page — minus what
  // the owner just resolved here (optimistic: a plan task done, a row Seen,
  // a permission answered, an approval decided)
  const inbox = useMemo(() => {
    const rows = folder ? scopeInbox(allInbox, folder, new Set(agents.map((a) => a.id)), MASTER_ID) : allInbox
    return rows.filter((i) => {
      if (doneGone.has(inboxKey(i))) return false
      const seen = seenKey(i)
      if (seen !== null && seenGone.has(seen)) return false
      return !(i.kind === 'ask' && i.permission && answerHidden(answered, i.permission.id, nowTick))
    })
  }, [folder, allInbox, agents, doneGone, seenGone, answered, nowTick])
  // a `due` plan task (a gate, or a near date) waits in Needs you; routine
  // ones stay in their project's «yours to do» (lib/home.ts isWaiting)
  const waiting = inbox.filter(isWaiting)
  // the quiet task lines: Yours to do's and Working now's, never rows of their own
  // (an engine Silos only has to catch up with is no task: the quiet note beside the pulse)
  const todo = inbox.filter((i) => !isWaiting(i) && isTaskRow(i))
  const waitsStart = linesOf(inbox, 'waitsStart')
  const comingToYou = linesOf(inbox, 'comingToYou')
  const idleLine = linesOf(inbox, 'idle')[0] ?? null
  // a gesture a row refused, said under THAT row — the row came back
  const [rowError, setRowError] = useState<{ key: string; text: string } | null>(null)
  // a question answered while its task stays stuck (a dropped dependency)
  const [stillStuck, setStillStuck] = useState<{ key: string; words: string } | null>(null)
  const stillStuckLine = stillStuck ? (
    <p role="status" data-testid="answer-still-stuck" className="mt-1 text-xs text-[var(--health-amber)]">
      {stillStuck.words} —{' '}
      <button
        type="button"
        onClick={() => {
          const p = taskPageOfKey(stillStuck.key)
          setStillStuck(null)
          if (p) changePage(p)
        }}
        className="underline decoration-[var(--health-amber)]/40 underline-offset-2 hover:text-terracotta"
      >
        on its page ›
      </button>
    </p>
  ) : null
  const ceiling = ceilingLine(waiting, nowTick)
  const siloDone = useMemo(() => {
    const all = siloBoard?.done ?? []
    return folder ? siloDoneInFolder(all, folder, new Set(agents.map((a) => a.id))) : all
  }, [siloBoard, folder, agents])
  const rows = useMemo(() => fleet(agents, cards, nowTick, MASTER_ID, siloDone), [agents, cards, nowTick, siloDone])
  const working = useMemo(() => workingNow(agents, nowTick), [agents, nowTick])
  // the parked ones — waiting on a monitor, a wakeup, a workflow — said
  // inside Working now (the retired Board's Waiting column)
  const parked = useMemo(() => waitingNow(cards), [cards])
  // the tile and its sheet say each conversation once: working, or parked
  const moving = useMemo(() => notParked(working, parked), [working, parked])
  // what finished today, listed in the digest's sheet (the Board's Done today)
  const finished = useMemo(() => doneToday(cards), [cards])
  const bg = useMemo(() => backgroundBySession(tasksSessions, nowTick), [tasksSessions, nowTick])
  const byId = (id: string): AgentView | undefined => agents.find((a) => a.id === id)
  const homeTasks = useTasks()
  // the silos' pulse terms ride the unscoped Home's sentence only (a total, not a folder's share)
  // the base sentence; the silos' clauses render as DOORS beside it (the
  // pulse named a silo as dead text — the most natural click)
  // before the first board answer nothing is asserted — «All quiet» was a
  // lie while loading, and a lie forever if the first read failed
  const sentence = inboxLoaded
    ? headline({ inbox, working, agentName: (id) => agentName(byId(id)), now: nowTick, ago: (t, now) => `${relTime(t, now)}` })
    : boardFailed
      ? 'The board couldn’t be read — retrying.'
      : 'Reading the board…'
  // the pulse by priority: an install with no agent of its own says
  // its one door — the same word as Welcome's button; after who needs you
  // and who works comes what was decided without you, then «All quiet.»
  // with what comes next — or alone when nothing does
  const noAgents = !allAgents.some((a) => a.id !== MASTER_ID && !a.archived)
  const quietPulse = inboxLoaded && sentence === 'All quiet.'
  const decidedPulse = !scope && quietPulse && since && since.decided.length > 0 ? since.decided : null
  const nextUp = useMemo((): { at: number; what: string } | null => {
    const out: Array<{ at: number; what: string }> = []
    for (const [id, v] of Object.entries(autonomy)) {
      const t = v.next ? Date.parse(v.next) : NaN
      if (Number.isFinite(t)) out.push({ at: t, what: `${agentName(agents.find((a) => a.id === id))}'s heartbeat` })
    }
    for (const a of allAutomations) {
      if (a.paused || a.id.startsWith('heartbeat-') || !a.nextRunAt) continue
      const t = Date.parse(a.nextRunAt)
      if (Number.isFinite(t)) out.push({ at: t, what: a.name })
    }
    return out.filter((x) => x.at > nowTick).sort((x, y) => x.at - y.at)[0] ?? null
  }, [autonomy, allAutomations, agents, nowTick])
  const quietNext = quietPulse && !decidedPulse ? nextWords(nextUp, nowTick) : null
  const growth = siloGrowthLines(siloBoard?.growth)
  const silos = useStore((s) => s.silos)
  const loadSilos = useStore((s) => s.loadSilos)
  useEffect(() => {
    if (!scope) void loadSilos()
  }, [scope, loadSilos])
  const sections = useMemo(() => projectSections({ rows, planItems: todo.filter(isTaskRow), waiting, agents }), [rows, todo, waiting, agents])
  async function digestSeen(band: DigestBandData): Promise<void> {
    setDigestBusy(true)
    setDigest(null) // optimistic
    try {
      await api.digest.seen(band.through)
      setInboxNotice(null)
    } catch (e) {
      setDigest(band)
      setInboxNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setDigestBusy(false)
    }
  }

  async function markSeen(item: SeenItem): Promise<void> {
    const key = seenKey(item)!
    setSeenGone((prev) => new Set(prev).add(key)) // optimistic
    try {
      await api.needsYou.ack(item.ack)
      setInboxNotice(null)
      setBoardTick((n) => n + 1)
    } catch (e) {
      setSeenGone((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      setInboxNotice(e instanceof Error ? e.message : String(e))
    }
  }

  // the pending proposals read whole (GET /api/proposals) — fetched again
  // whenever the inbox names a different set of them
  const [proposalViews, setProposalViews] = useState<ReadonlyMap<string, ProposalView>>(new Map())
  const proposalIdsKey = allInbox
    .flatMap((i) => (i.kind === 'proposal' ? [i.proposalId] : i.kind === 'proposalSummary' ? i.proposalIds : []))
    .sort()
    .join(',')
  useEffect(() => {
    if (proposalIdsKey === '') {
      setProposalViews(new Map())
      return
    }
    let cancelled = false
    Promise.resolve(api.proposals?.list())
      .then((all) => {
        if (!cancelled && all) setProposalViews(new Map(all.map((p) => [p.id, p])))
      })
      .catch(() => {
        /* the rows still say who, what and why */
      })
    return () => {
      cancelled = true
    }
  }, [proposalIdsKey])

  // Approve / Skip: the store decides the run; the row leaves at once
  function decided(item: Extract<InboxItem, { kind: 'approval' }>): void {
    setDoneGone((prev) => new Set(prev).add(inboxKey(item)))
  }

  // an agent's proposal: Accept makes it as proposed
  // — an automation lands on its page, a skill loads from the agent's next
  // conversation; Dismiss drops it. «Review ›» opens the editor that decides
  // (a mission's, preloaded with the change; the automation editor for a
  // command) — the row stays until its save resolves it. The row leaves at
  // once and comes back, with the server's words below, if that failed.
  async function proposal(item: ProposalItem, act: ProposalAct): Promise<void> {
    if (act === 'review') {
      if (item.proposalKind === 'mission') {
        const view = proposalViews.get(item.proposalId)
        if (!view || !startMissionReview(view)) {
          setInboxNotice('This suggestion could not be read — try again in a moment.')
          return
        }
        changePage({ kind: 'agent', id: item.agentId })
        useStore.getState().changeTab('mission')
      } else {
        changePage({ kind: 'automation', id: 'new', proposal: item.proposalId, agent: item.agentId })
      }
      return
    }
    const key = inboxKey(item)
    setDoneGone((prev) => new Set(prev).add(key)) // optimistic
    try {
      if (act === 'accept') {
        const r = await api.proposals.accept(item.proposalId, item.inputHash)
        setInboxNotice(null)
        if (r.automation) {
          void useStore.getState().loadAutomations()
          changePage({ kind: 'automation', id: r.automation.id })
        }
      } else {
        await api.proposals.dismiss(item.proposalId)
        setInboxNotice(null)
      }
    } catch (e) {
      setDoneGone((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      setInboxNotice(e instanceof Error ? e.message : String(e))
    }
    setBoardTick((n) => n + 1)
  }

  // «Keep them all ›»: the owner's gesture stamps them
  // createdBy owner; the ones left out stay outside, one by one
  async function keepBaseline(item: BaselineItem, exclude: string[]): Promise<void> {
    const key = inboxKey(item)
    setDoneGone((prev) => new Set(prev).add(key)) // optimistic
    try {
      await api.initiative.keepAll(item.folder, exclude)
      setInboxNotice(null)
    } catch (e) {
      setDoneGone((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      setInboxNotice(e instanceof Error ? e.message : String(e))
    }
    setBoardTick((n) => n + 1)
  }

  async function answer(item: AskItem, status: 'allow' | 'deny'): Promise<void> {
    const p = item.permission
    if (!p) return
    setAnswered((prev) => new Map(prev).set(p.id, useStore.getState().nowTick)) // optimistic
    try {
      await api.asks.reply(item.agentId, item.id, p.id, status)
      setInboxNotice(null)
    } catch (e) {
      setAnswered((prev) => {
        const next = new Map(prev)
        next.delete(p.id)
        return next
      })
      setInboxNotice(e instanceof Error ? e.message : String(e))
    }
    setBoardTick((n) => n + 1)
  }

  // a task of yours (a plan's), Done or Dropped. A Plans task is the
  // owner's verb (lib/task-gesture.ts act — ONE write, judged on the state
  // the row painted); a row of ANOTHER silo keeps its manifest's own
  // set-field and note (`resolve`, lib/task-drop.ts).
  // Its answer names what the click made ready and whether each agent will
  // move (the handoff line). The row leaves at once (the WS `silos` event
  // confirms) and comes back, with the server's words under it, if that
  // failed. `notice`: where a row of the project sections says it.
  async function resolvePlan(
    item: TaskItem,
    action: 'done' | 'drop',
    notice: (s: string | null) => void,
    reason = '',
    seen: string | null = null,
  ): Promise<void> {
    const key = inboxKey(item)
    setDoneGone((prev) => new Set(prev).add(key)) // optimistic
    setRowError(null)
    try {
      const it = item.item
      const how = it.resolve
      if (!how) throw new Error('this row can only be settled on its page')
      const value = action === 'drop' ? (how.drop ?? how.done) : how.done
      // what a Drop leaves hanging, read BEFORE it (the dependents still open)
      const tv = homeTasks.tasks.find((x) => x.key === it.key)
      const hangs = action === 'drop' && tv ? dropHangs(tv, homeTasks.tasks, (id) => byId(id)?.name) : null
      let r: { nowReady?: Parameters<typeof handoffOf>[0] }
      // the state the ROW was composed with: what the owner saw, so
      // the server says «it changed» — never the tasks reading, which may not
      // have loaded (an empty state skipped that check)
      if (it.silo === PLANS_SILO) r = await act(it.key, action, { state: it.state ?? '', ...(action === 'drop' ? { text: reason } : {}) })
      else {
        r =
          action === 'drop'
            ? await dropTask(it.silo, it.key, reason, { field: how.field, value, note: how.note }, seen)
            : await api.silos.setField(it.silo, { key: it.key, field: how.field, value })
        markTaskSeen(it.key, String(value)) // the owner's own Done is not news to the owner
      }
      setHandoff(handoffOf(r.nowReady ?? [], (id) => agentName(byId(id))))
      const first = hangs?.tasks[0]
      setStranded(
        hangs && first
          ? {
              words: `${hangs.tasks.length === 1 ? `«${first.title}» now waits` : `${hangs.tasks.length} tasks now wait`} on a dropped task`,
              door: taskPage(hangs.tasks.length === 1 ? first : tv!),
            }
          : null,
      )
      notice(null)
    } catch (e) {
      setDoneGone((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      const words =
        e instanceof ApiError && e.status === 409 && e.message.startsWith('the record changed')
          ? 'Someone wrote this plan first — it was read again; try once more.'
          : actError(e)
      if (item.item.silo === PLANS_SILO) setRowError({ key: item.item.key, text: words })
      else notice(words)
    }
    setBoardTick((n) => n + 1)
  }

  // an agent's question answered here — one of its choices, «Send back…»
  // on a review (lib/answer-wait.ts answerTask: the gate's respond, or the
  // verb answer with the question the row painted — ONE write). The row
  // leaves at once and comes back with the server's words under it if the
  // answer was refused. True when it went in («Answer and open ›» opens then).
  async function answerRow(item: TaskItem, text: string): Promise<boolean> {
    const key = inboxKey(item)
    const tv = homeTasks.tasks.find((x) => x.key === item.item.key)
    setDoneGone((prev) => new Set(prev).add(key)) // optimistic
    setRowError(null)
    try {
      if (!tv) throw new Error('the task is not read yet — open it')
      const r = await answerTask(tv, text, new Set(useStore.getState().agents.map((a) => a.id)))
      // answered, and still stuck on a dropped dependency: said, with its
      // labels and the door to its page (both ways out are there) — never a
      // row that vanishes as if it moved
      const stuck = droppedOf(r.holds, tv, homeTasks.tasks)
      const k = item.item.key
      setInboxNotice(null)
      setStillStuck(
        stuck.length > 0
          ? {
              key: k,
              words: `Answered — but ${stuckWords(stuck, (id) => labelOfKey(homeTasks.tasks, `${k.slice(0, k.lastIndexOf('/tasks/'))}/tasks/${id}`, k))}`,
            }
          : null,
      )
      setBoardTick((n) => n + 1)
      return true
    } catch (e) {
      setDoneGone((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      setRowError({ key: item.item.key, text: actError(e) })
      setBoardTick((n) => n + 1)
      return false
    }
  }
  // Approve an agent's review that waits on you: one write — its note,
  // the wait out, done; the review's question as the row painted it
  async function approveRow(item: TaskItem): Promise<boolean> {
    const key = inboxKey(item)
    const tv = homeTasks.tasks.find((x) => x.key === item.item.key)
    setDoneGone((prev) => new Set(prev).add(key)) // optimistic
    setRowError(null)
    try {
      const r = await act(item.item.key, 'approve', { asked: tv ? paintedAsked(tv) : '' })
      setHandoff(handoffOf(r.nowReady ?? [], (id) => agentName(byId(id))))
      setBoardTick((n) => n + 1)
      return true
    } catch (e) {
      setDoneGone((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      setRowError({ key: item.item.key, text: actError(e) })
      setBoardTick((n) => n + 1)
      return false
    }
  }
  // a quiet line's door (its view of /tasks), closing the sheet it sits in
  const goLine = (r: TaskLineRow): void => {
    setSheet(null)
    navigateToRoute(taskLineDoor(r))
  }

  // which tile's list is open (a Sheet over the board)
  // (an address: /?sheet=needs-you — the store holds it, the router writes it)
  const sheet = useStore((s) => s.homeSheet)
  // C1: a row the sidebar would not list says WHY it exists on its quiet
  // line (a task wake, a run, a heartbeat, a nested `claude -p` and a
  // conversation of the owner's read identical without it). One facts
  // bundle for the working, parked and finished rows; the tasks map is
  // fetched only while a sheet that paints it is open.
  const tasksBySession = useOpenTasksBySession(sheet === 'working' || sheet === 'digest')
  const keptByFleet = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of allAutomations) if (a.thread.mode === 'keep' && a.thread.sessionId) m.set(a.thread.sessionId, a.name)
    return m
  }, [allAutomations])
  const sessionsByKey = useMemo(() => {
    const m = new Map<string, SessionView>()
    for (const a of agents) for (const s of a.sessions) m.set(`${s.folder}/${s.id}`, s)
    return m
  }, [agents])
  const sessionsById = useMemo(() => {
    const m = new Map<string, SessionView>()
    for (const a of agents) for (const s of a.sessions) m.set(s.id, s)
    return m
  }, [agents])
  const causeOf = (s: SessionView | undefined): string | null =>
    s === undefined
      ? null
      : causeWords(
          conversationCause(s, {
            tasks: tasksBySession.get(s.id),
            keptBy: keptByFleet,
            automationName: (id) => allAutomations.find((a) => a.id === id)?.name ?? null,
            parentTitle: (pid) => sessionsById.get(pid)?.title ?? null,
          }),
        )
  const setSheet = useStore((s) => s.setHomeSheet)
  // every plan of yours, project by project (the sections' order), with its project's name
  // idle plans (2+ weeks untouched) go last, in the tile and the sheet alike
  // the project's list first — its tasks are the project's own, never idle
  const sectionPlans = (sec: ProjectSection): PlanGroup[] => {
    const sp = splitPlans(namedPlans(sec.plans), nowTick)
    return [...sec.plans.filter((p) => p.standing), ...sp.shown, ...sp.folded]
  }
  const planGroups = sections.flatMap((sec) => sectionPlans(sec).map((plan) => ({ plan, project: sec.name })))
  // the project's list is no plan: never counted as one
  const namedCount = namedPlans(planGroups.map((g) => g.plan)).length
  const inPlans = (n: number): string => (n > 0 ? ` in ${n} ${n === 1 ? 'plan' : 'plans'}` : '')
  // the sheet's one line says every count the sheet holds — your tasks, the
  // ones waiting on you to start their agent, the ones coming to you — and
  // your tasks that wait in Needs you instead (the same «yours» Tasks counts)
  const dueMine = waiting.filter(isTaskRow).length
  const lineCount = (rs: readonly TaskLineRow[]): number => rs.reduce((n, r) => n + r.count, 0)
  const yoursAlso = [
    lineCount(waitsStart) > 0 ? `${lineCount(waitsStart)} waiting for you to start ${lineCount(waitsStart) === 1 ? 'its' : 'their'} agent` : '',
    lineCount(comingToYou) > 0 ? `${lineCount(comingToYou)} coming to you` : '',
  ].filter((w) => w !== '')
  const yoursSub = [
    ...(todo.length > 0 || yoursAlso.length === 0 ? [`${todo.length} ${todo.length === 1 ? 'task' : 'tasks'}${inPlans(namedCount)}`] : []),
    ...yoursAlso,
  ]
  // the quiet ones, in one tile: projects with nothing to say (Home), or a
  // project's agents with nothing to say (its page)
  const quietTile: { lead: string; lines: TileLine[]; more: string | null } | null = (() => {
    if (scope) {
      const q = sections.flatMap((sec) => sec.quiet)
      if (q.length === 0) return null
      return {
        lead: `${q.length} ${q.length === 1 ? 'agent has' : 'agents have'} nothing to say.`,
        lines: q.map((r) => ({
          key: r.agent.id,
          mark: r.agent.emoji,
          text: agentName(r.agent),
          meta: r.lastActive ? relTime(r.lastActive, nowTick) : undefined,
        })),
        more: q.length > PREVIEW_MAX ? `${q.length - PREVIEW_MAX} more` : null,
      }
    }
    return null
  })()

  // ── Home's ONE list: what holds someone up,
  // then the owner's own tasks — the order and the bound are lib/home.ts
  // homeList's; this composes each row from the gestures this page holds
  const needsOrigin: TaskOrigin = { kind: 'needs-you', ...(folder !== undefined ? { folder } : {}) }
  const yoursOrigin: TaskOrigin = { kind: 'yours', ...(folder !== undefined ? { folder } : {}) }
  const agentIds = new Set(agents.map((a) => a.id))
  const taskViewOf = (key: string): TaskView | undefined => homeTasks.tasks.find((x) => x.key === key)
  // a row that holds someone up AND carries its question in words: drawn as
  // a card — an agent's task waiting on you (its asked or its action), or a
  // permission (what it wants to run). A conversation's own question lives
  // in the conversation: its row is the door there.
  const cardOf = (i: InboxItem): { question: ReactNode; answers: CardAnswer[]; door: { label: string; onClick: () => void } | null } | null => {
    if (i.kind === 'ask' && i.permission) {
      const p = i.permission
      const what = p.pattern ? `${p.type} ${p.pattern}` : null
      return {
        question: what ? (
          <>
            May it run <code className="rounded-md bg-panel px-1.5 py-0.5 font-mono text-[0.78em]">{what}</code>?
          </>
        ) : i.title.trim() ? (
          i.title
        ) : (
          'May it go ahead?'
        ),
        answers: [
          { label: 'Allow', onClick: () => void answer(i, 'allow') },
          { label: 'Deny', primary: false, onClick: () => void answer(i, 'deny') },
        ],
        door: { label: 'Open the conversation', onClick: () => void useStore.getState().openSession(i.folder, i.id) },
      }
    }
    if (!isTaskRow(i)) return null
    const tv = taskViewOf(i.item.key)
    const owner = tv ? byId(tv.owner) : undefined
    const ask = tv && owner ? askWords(tv, agentName(owner), i.item.text) : null
    if (!tv || !ask || ask.silent) return null
    const w = tv.flow?.waitsOn !== undefined ? tv.flow.waitsOn : tv.waitingOn
    const question = w?.asked?.trim() || ask.text
    const tp = taskPageOf(i)
    const door = tp ? { label: 'Open the task', onClick: () => changePage({ ...tp, from: needsOrigin }) } : null
    if (reviewWaitsOnYou(tv, agentIds)) return { question, answers: [{ label: 'Approve', onClick: () => void approveRow(i) }], door }
    return { question, answers: ask.options.map((o) => ({ label: o, onClick: () => void answerRow(i, o) })), door }
  }
  // who a row holds up: the agent whose work stops on it
  const heldUp = (i: InboxItem): AgentView | undefined => {
    if (isTaskRow(i)) {
      const tv = taskViewOf(i.item.key)
      return tv ? byId(tv.owner) : undefined
    }
    if (i.kind === 'silo' && i.item.agentId) return byId(i.item.agentId)
    const id = 'agentId' in i && typeof i.agentId === 'string' ? i.agentId : null
    return id ? byId(id) : undefined
  }
  // a row's door: where it is settled — its task, its conversation, its
  // agent, its install review; a row decided by the buttons only the Needs
  // you list carries (Approve/Skip, Accept, Seen, Keep them all…) opens there
  const openNeedsYou = (): void => setSheet('needs-you')
  const doorOf = (i: InboxItem): (() => void) => {
    if (i.kind === 'ask') return () => void useStore.getState().openSession(i.folder, i.id)
    if (isTaskRow(i)) {
      const tp = taskPageOf(i)
      return tp ? () => changePage({ ...tp, from: needsOrigin }) : openNeedsYou
    }
    if (i.kind === 'silo' && i.item.reason === 'escalation') {
      const tp = taskPageOfKey(i.item.key)
      return tp ? () => changePage({ ...tp, from: needsOrigin }) : openNeedsYou
    }
    if (i.kind === 'silo' && i.item.reason === 'submission') {
      const id = i.item.silo
      return () => changePage({ kind: 'silo', id, review: true })
    }
    if (i.kind === 'message') {
      const id = i.item.agentId
      return () => changePage({ kind: 'agent', id })
    }
    if (i.kind === 'approval' || i.kind === 'proposal' || i.kind === 'proposalSummary' || i.kind === 'escalated' || i.kind === 'plansBaseline')
      return openNeedsYou
    const dest = inboxDestination(i, (id) => agentInPlay(agents, id))
    return dest ? () => changePage(dest.page) : openNeedsYou
  }
  // what a row says on Home: its title or its question, never the plumbing
  const holdText = (i: InboxItem): ReactNode => {
    if (isTaskRow(i)) {
      const tv = taskViewOf(i.item.key)
      const ask = tv && byId(tv.owner) ? askWords(tv, agentName(byId(tv.owner)), i.item.text) : null
      if (ask) return <span data-testid="tile-ask">{ask.text}</span>
      return (
        <>
          <TaskWords itemKey={i.item.key}>{taskTitle(i)}</TaskWords>
          {taskWhy(i) ? <span className="text-ink-2">{taskWhy(i)}</span> : null}
        </>
      )
    }
    if (i.kind === 'silo' && i.item.reason === 'escalation' && i.item.identity)
      return (
        <>
          <TaskWords itemKey={i.item.key}>{i.item.identity}</TaskWords>
          <span className="text-ink-2"> — {i.item.text}</span>
        </>
      )
    return withCode(i.voice)
  }
  const dueWords = (due: string): string => {
    const d = new Date(`${due.slice(0, 10)}T00:00:00`)
    return Number.isNaN(d.getTime()) ? due : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  const ownTasks = planGroups.flatMap((g) => g.plan.tasks)
  const list = homeList<InboxItem>(waiting, ownTasks, (i) => cardOf(i) !== null)
  const errorUnder = (key: string): ReactNode => (rowError?.key === key ? <RowError text={rowError.text} /> : null)
  const listRows = list.rows.map(({ item: i, holds, card }) => {
    const when = i.at > 0 ? relTime(i.at, nowTick) : null
    const errKey = isTaskRow(i) || i.kind === 'silo' ? i.item.key : inboxKey(i)
    if (holds) {
      const who = heldUp(i)
      const c = card ? cardOf(i) : null
      if (c) {
        return (
          <HoldCard
            key={inboxKey(i)}
            mark={who?.emoji ?? rowMark(i, byId)}
            who={who ? `${agentName(who)} is stopped on this` : 'Work is stopped on this'}
            when={when}
            question={c.question}
            answers={c.answers}
            door={c.door}
            error={errorUnder(errKey)}
          />
        )
      }
      // a task of yours that leads because of a gate or a near date: yours,
      // with its project — its text already says why it is in front
      const own = isTaskRow(i) && isYou(taskViewOf(i.item.key)?.owner ?? '')
      const ownWhere = own && !scope ? projectName(folderOfRow(i, agents)) : null
      return (
        <ListRow
          key={inboxKey(i)}
          holds
          mark={isTaskRow(i) ? <TaskRowGlyph rowKey={i.item.key} agents={agents} now={nowTick} /> : rowMark(i, byId)}
          text={holdText(i)}
          word={
            own ? (
              <>yours{ownWhere ? <span className="text-ink-3"> · {ownWhere}</span> : null}</>
            ) : (
              <>
                {who ? `holds up ${agentName(who)}` : 'waits on you'}
                {when ? <span className="text-ink-3"> · {when}</span> : null}
              </>
            )
          }
          onOpen={doorOf(i)}
          error={errorUnder(errKey)}
        />
      )
    }
    const t = i as TaskItem
    const tv = taskViewOf(t.item.key)
    const tp = taskPageOf(t)
    const where = tv?.due ? `due ${dueWords(tv.due)}` : !scope ? projectName(folderOfRow(t, agents)) : when
    return (
      <ListRow
        key={inboxKey(t)}
        holds={false}
        mark={<TaskRowGlyph rowKey={t.item.key} agents={agents} now={nowTick} />}
        text={<TaskWords itemKey={t.item.key}>{taskTitle(t)}</TaskWords>}
        word={<>yours{where ? <span className="text-ink-3"> · {where}</span> : null}</>}
        action={t.item.resolve ? { label: 'Done', onClick: () => void resolvePlan(t, 'done', setPlanNotice) } : null}
        onOpen={tp ? () => changePage({ ...tp, from: yoursOrigin }) : null}
        error={errorUnder(t.item.key)}
      />
    )
  })
  const yoursRest = list.hiddenYours > 0 ? `${list.hiddenYours} more of your own` : yoursAlso.length > 0 ? yoursAlso.join(' · ') : null
  const listFoot =
    list.hiddenHolds > 0 || yoursRest ? (
      <p data-testid="needs-you-foot" className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-3 text-[13.5px] text-ink-2">
        {list.hiddenHolds > 0 ? (
          <button type="button" data-testid="needs-you-more" onClick={openNeedsYou} className="min-h-9 hover:text-terracotta">
            {list.hiddenHolds} more holding someone up ›
          </button>
        ) : null}
        {yoursRest ? (
          <button type="button" data-testid="yours-more" onClick={() => setSheet('yours')} className="min-h-9 hover:text-terracotta">
            {yoursRest} ›
          </button>
        ) : null}
      </p>
    ) : null
  // the head's counts by kind, each the door to the whole list of its kind
  // (the Needs you sheet — every row with all its buttons, walked with j k —
  // and your own tasks, plan by plan): they stay reachable whatever shows
  const listSummary = (
    <>
      {list.holds > 0 ? (
        <button type="button" data-testid="needs-you-all" onClick={openNeedsYou} className="hover:text-terracotta">
          {list.holds} {list.holds === 1 ? 'holds' : 'hold'} someone up
        </button>
      ) : null}
      {list.holds > 0 && list.yours > 0 ? (
        <span aria-hidden="true" className="text-ink-3">
          {' '}
          ·{' '}
        </span>
      ) : null}
      {list.yours > 0 ? (
        <button type="button" data-testid="yours-all" onClick={() => setSheet('yours')} className="hover:text-terracotta">
          {list.yours} {list.yours === 1 ? 'is' : 'are'} your own
        </button>
      ) : null}
    </>
  )
  const needsList = (
    <NeedsYouSection summary={listSummary} foot={listFoot} empty={!inboxLoaded ? null : list.rows.length === 0 ? 'Nothing needs you.' : null}>
      {!inboxLoaded ? null : listRows}
    </NeedsYouSection>
  )

  // «Right now» left Home: the sidebar and the pulse
  // already read what is alive. Its two doors moved to the pulse: the
  // sentence «X is working on…» opens the Working now sheet, and the quiet
  // line under the pulse carries «N conversations finished today ›» — and
  // the sheet's door when the pulse speaks of something else while some
  // conversation still waits on something (its rows must keep a way in).
  const nBackground = [...bg.values()].reduce((n, b) => n + b.live, 0)
  const workingSheet = moving.length + parked.length > 0 || idleLine !== null || nBackground > 0
  const pulseWorks = inboxLoaded && waiting.length === 0 && working.length > 0
  const workingWords =
    [moving.length > 0 ? `${moving.length} working` : '', parked.length > 0 ? `${parked.length} waiting on something` : ''].filter(Boolean).join(' · ') ||
    'Working now'
  const hasDone = finished.length > 0 || (!scope && digest !== null)
  const pulseDoors =
    (workingSheet && !pulseWorks) || hasDone ? (
      <p data-testid="pulse-doors" className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px] text-ink-2">
        {workingSheet && !pulseWorks ? (
          <button type="button" data-testid="working-now-door" onClick={() => setSheet('working')} className="min-h-8 text-left hover:text-terracotta">
            {workingWords} ›
          </button>
        ) : null}
        {hasDone ? (
          <button type="button" data-testid="today-done" onClick={() => setSheet('digest')} className="min-h-8 text-left hover:text-terracotta">
            {finished.length > 0 ? `${finished.length} ${finished.length === 1 ? 'conversation' : 'conversations'} finished today` : 'While you were away'}
            {!scope && digest && finished.length > 0 ? <span className="text-ink-3"> · while you were away</span> : null} ›
          </button>
        ) : null}
      </p>
    ) : null
  const today = new Date(nowTick)
  const dateLabel = today.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
  const shortDateLabel = today.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
  const timeLabel = today.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="h-full overflow-y-auto">
        {/* Home keeps its own head: its title IS the pulse
            sentence — a «Home» band above it would only demote the one line
            the page exists for. What it shares with the band is the left
            edge (px-4 / sm:px-5, PageHeader's), so going Home ⇄ Tasks ⇄ Map
            the first word never jumps; and its one row of doors (the lenses,
            silos ›) is pinned right, never pushed by the date before it. */}
        <div className="flex max-w-[76rem] flex-col gap-7 px-4 pb-12 pt-5 sm:px-5">
          {/* the date line, with the lenses — mono, the log's own voice.
              The Map's views are lenses, not rail doors: this line and ⌘K are how they are
              reached — one line, one family (the Board's word left it
              when its views landed on this page). Lenses are desk tools, so the line hides on a phone,
              where Home is the first screen and the list sits one tap away.
              Scoped (the project page), the project header already carries
              back/plate, and its machinery line unfolds the folder's Map. */}
          <header>
            {!scope ? (
              <div className="flex min-h-7 items-center gap-2 text-[12px] text-ink-3">
                <ListButton />
                <span className="truncate">
                  <span className="max-sm:hidden">{dateLabel}</span>
                  <span className="sm:hidden">{shortDateLabel}</span>
                  <span className="ml-2 font-mono text-[11px] tabular-nums">{timeLabel}</span>
                </span>
                {/* an engine Silos only has to catch up with stops nothing:
                    ONE folded alert on the date line, its door to Settings ›
                    Engines (the whole sentence on hover) — never a line in
                    the pulse's way (panel, not detail) */}
                {aheadEngines(inbox)
                  .slice(0, 1)
                  .map((e) => (
                    <button
                      key={`engine:${e.harness}`}
                      type="button"
                      data-testid="engine-ahead"
                      title={[engineHead(e), e.message].filter(Boolean).join('\n')}
                      onClick={() => changePage({ kind: 'settings', tab: 'engines' })}
                      className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[11.5px] text-ink-2 hover:border-ink-3 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-terracotta md:ml-3"
                    >
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--health-amber)]" />
                      {engineHead(e).split(' — ')[0]} ›
                    </button>
                  ))}
                <span data-testid="home-lenses" className="ml-auto hidden items-center gap-3 md:flex">
                  {/* the Map's views, from the MAP_VIEWS registry (docs/product.md:
                      a view that exists is reachable by name) — org appears only
                      while a reporting silo is active */}
                  {mapViewsFor(silos).map((v) => (
                    <button key={v.id} type="button" title={v.about} onClick={() => changePage(mapPageOf(v))} className="hover:text-terracotta">
                      {v.word}
                    </button>
                  ))}
                </span>
                {/* the Silos page's one standing door (a quiet
                    line, not a rail entry) — it rides the lenses' line
                    (a shorter head), and stays on a phone */}
                <button
                  type="button"
                  onClick={() => changePage({ kind: 'settings', tab: 'silos' })}
                  className={`${aheadEngines(inbox).length > 0 ? 'ml-3' : 'ml-auto'} shrink-0 hover:text-terracotta md:ml-1`}
                  data-testid="home-silos-door"
                >
                  silos ›
                </button>
              </div>
            ) : null}
            <p
              data-testid="pulse"
              className={`text-pretty font-display text-ink ${scope ? 'max-w-[38ch] text-[21px] leading-snug' : 'mt-3 max-w-[40ch] text-[24px] leading-[1.22] tracking-[-0.01em] sm:text-[29px]'}`}
            >
              {!scope && noAgents ? (
                <button
                  type="button"
                  data-testid="pulse-create"
                  onClick={() => useStore.getState().setModal('create')}
                  className="text-left hover:text-terracotta"
                >
                  Create your first agent ›
                </button>
              ) : decidedPulse ? (
                <button type="button" data-testid="pulse-decided" onClick={() => setSheet('since')} className="text-left hover:text-terracotta">
                  {new Set(decidedPulse.map((c) => c.by)).size === 1
                    ? `${agentName(byId(decidedPulse[0]!.by))} decided something ›`
                    : `${new Set(decidedPulse.map((c) => c.by)).size} agents decided something ›`}
                </button>
              ) : pulseWorks ? (
                <button type="button" data-testid="pulse-working" onClick={() => setSheet('working')} className="text-left hover:text-terracotta">
                  {sentence}
                </button>
              ) : (
                sentence
              )}
              {quietNext ? (
                <span data-testid="pulse-next" className="mt-1 block text-[15px] tracking-normal text-ink-2">
                  {quietNext}
                </span>
              ) : null}
            </p>
            {pulseDoors}
            {/* while you were away: after a day, or whenever something
                was decided without you — its door opens what was decided,
                each with its Undo */}
            {!scope && since && sinceShows(since, nowTick) ? (
              <SinceBand since={since} now={nowTick} nameOf={(id) => agentName(byId(id))} onOpen={() => setSheet('since')} />
            ) : null}
            {/* records an uninstalled silo's producers keep writing — files no
                surface shows, said beside the pulse (a fleet total: unscoped) */}
            {!scope && growth.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-0.5" data-testid="silo-growth">
                {growth.map((g) => (
                  <li key={g.silo} className="flex max-w-[62ch] items-baseline gap-2 text-[12.5px] text-ink-2">
                    <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-[var(--health-amber)]" />
                    {/* the growth line's door: the Silos page
                        lists the uninstalled silo with what stayed and Reinstall… */}
                    <button type="button" onClick={() => changePage({ kind: 'settings', tab: 'silos' })} className="text-left hover:text-terracotta">
                      {g.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {/* the calm facts share ONE line (the head stacked
                five lines before Needs you): rows a silo routed to a producer
                (audience: producer-agent), records a silo closed today that
                belong to no agent (platform data), and who is on each Claude
                account (global, so only the unscoped Home says it) */}
          </header>

          {/* two zones: at a desk the ONE
              list, wide, and a narrow column for what only time can say —
              This week over This month and the fleet's line (Right now left
              Home: the sidebar and the pulse read what is alive); on a phone
              one column in the order of intent — the pulse, Needs you, This
              week, This month, the fleet. Scoped (the project page) the list
              alone, the week and month left to Usage and System (fleet
              figures), and the project's own tiles below. */}
          {!sheet && (inboxNotice || planNotice) ? (
            <p role="alert" className="-mb-3 text-xs text-terracotta">
              {inboxNotice ?? planNotice}
            </p>
          ) : null}
          {!sheet ? stillStuckLine : null}
          <div className={`flex flex-col gap-10 ${scope ? '' : 'xl:grid xl:grid-cols-[minmax(0,1fr)_21.5rem] xl:items-start xl:gap-12'}`}>
            <div className="flex min-w-0 flex-col">
              {needsList}
              {!sheet ? (
                <Handoff
                  handoff={handoff}
                  stranded={stranded}
                  onClear={() => {
                    setHandoff([])
                    setStranded(null)
                  }}
                />
              ) : null}
            </div>
            {!scope ? (
              <div className="grid min-w-0 gap-10 md:grid-cols-2 md:gap-8 xl:flex xl:flex-col xl:gap-10">
                <ThisWeek />
                <ThisMonth />
              </div>
            ) : null}
          </div>
          {scope ? (
            <TileGrid>
              {/* the project's own: its org (one org per project) and a tile
                  per agent — the door to its page */}
              <OrgTile folder={scope.folder} />
              {sections
                .flatMap((sec) => sec.rows)
                .map((r) => (
                  <AgentTile key={r.agent.id} row={r} view={autonomy[r.agent.id] ?? null} now={nowTick} folder={scope.folder} />
                ))}
              {quietTile ? (
                <Tile
                  testId="tile-quiet"
                  name="Quiet agents"
                  quiet
                  door="All"
                  onOpen={() => setSheet('quiet')}
                  lead={quietTile.lead}
                  lines={quietTile.lines}
                  more={quietTile.more}
                />
              ) : null}
            </TileGrid>
          ) : null}
          {rows.length === 0 && todo.length === 0 ? <p className="font-mono text-[11px] text-ink-3">no agents yet</p> : null}
          {/* the page ends on its calmest fact: who is on your Claude
              subscription right now (it unfolds into the groups) */}
          {!scope ? <AmbientLine agents={agents} lead={[]} /> : null}

          {after}
        </div>
      </div>
      {sheet === 'needs-you' ? (
        <Sheet
          testId="sheet-needs-you"
          title="Needs you"
          sub={waiting.length === 0 ? 'Nothing needs you.' : `${waiting.length} stopping work until you act`}
          onClose={() => {
            releaseHold(inboxHoldId('needs-you', folder))
            closeHomeSheet()
          }}
        >
          {ceiling ? (
            <p data-testid="inbox-ceiling" className="mt-2 font-mono text-[11px] text-ink-2">
              {ceiling}
            </p>
          ) : null}
          <section aria-label="Needs you">
            <NeedsYouList
              waiting={waiting}
              folder={folder}
              renderRow={(i) => (
                <InboxRow
                  item={i}
                  agents={agents}
                  project={scope ? null : projectName(folderOfRow(i, agents))}
                  origin={{ kind: 'needs-you', ...(folder !== undefined ? { folder } : {}) }}
                  onOpenFile={setViewerPath}
                  onPlan={(it, act, reason, seen) => void resolvePlan(it, act, setInboxNotice, reason, seen)}
                  onSeen={(it) => void markSeen(it)}
                  onAnswer={(it, st) => void answer(it, st)}
                  onDecided={decided}
                  onProposal={(it, act) => void proposal(it, act)}
                  onBaseline={(it, exclude) => void keepBaseline(it, exclude)}
                  onAnswerWait={(it, text) => answerRow(it, text)}
                  onApprove={(it) => approveRow(it)}
                  rowError={i.kind === 'silo' && rowError?.key === i.item.key ? rowError.text : null}
                  proposalViews={proposalViews}
                />
              )}
            />
          </section>
          {inboxNotice ? <p className="mt-1 text-xs text-terracotta">{inboxNotice}</p> : null}
          {stillStuckLine}
          <Handoff
            handoff={handoff}
            stranded={stranded}
            onClear={() => {
              setHandoff([])
              setStranded(null)
            }}
          />
        </Sheet>
      ) : null}
      {sheet === 'yours' ? (
        <Sheet
          testId="sheet-yours"
          title="Yours to do"
          sub={
            <>
              {yoursSub.map((w, i) => (
                <Fragment key={w}>
                  {i > 0 ? ' · ' : ''}
                  {w}
                </Fragment>
              ))}
              {dueMine > 0 ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    data-testid="yours-in-needs-you"
                    onClick={() => setSheet('needs-you')}
                    className="underline-offset-2 hover:text-terracotta hover:underline"
                  >
                    {dueMine} more {dueMine === 1 ? 'is' : 'are'} in Needs you ›
                  </button>
                </>
              ) : null}{' '}
              ·{' '}
              <button
                type="button"
                data-testid="yours-in-tasks"
                onClick={() => changePage({ kind: 'tasks', view: 'mine', layout: 'list', ...(folder ? { project: [folder] } : {}) })}
                className="underline-offset-2 hover:text-terracotta hover:underline"
              >
                as a list in Tasks ›
              </button>
            </>
          }
          onClose={closeHomeSheet}
        >
          {todo.length === 0 && waitsStart.length === 0 && comingToYou.length === 0 ? (
            <p data-testid="yours-empty" className="mt-3 text-[14px] text-ink-2">
              {dueMine > 0 ? 'Nothing else is yours to do.' : 'Nothing is yours to do.'}
            </p>
          ) : null}
          {sections
            .filter((sec) => sec.plans.length > 0)
            .map((sec) => (
              <section key={sec.folder ?? ''} aria-label={sec.name} className="mt-4 first:mt-2">
                {!scope ? <h3 className="font-display text-[16px] text-ink">{sec.name}</h3> : null}
                <ul className="divide-y divide-line/60">
                  {sectionPlans(sec).flatMap((p) =>
                    p.standing
                      ? p.tasks.map((t) => (
                          <LooseTaskRow
                            key={inboxKey(t)}
                            item={t}
                            now={nowTick}
                            origin={{ kind: 'yours', ...(folder !== undefined ? { folder } : {}) }}
                            onDone={(it) => void resolvePlan(it, 'done', setPlanNotice)}
                            rowError={rowError}
                          />
                        ))
                      : [
                          <PlanGroupRow
                            key={p.key}
                            plan={p}
                            now={nowTick}
                            origin={{ kind: 'yours', ...(folder !== undefined ? { folder } : {}) }}
                            onDone={(it) => void resolvePlan(it, 'done', setPlanNotice)}
                            rowError={rowError}
                          />,
                        ],
                  )}
                </ul>
              </section>
            ))}
          {waitsStart.length > 0 || comingToYou.length > 0 ? (
            <section
              aria-label="Waiting on you to start, and coming to you"
              data-testid="yours-lines"
              className={sections.some((sec) => sec.plans.length > 0) ? 'mt-6 border-t border-line/60 pt-3' : 'mt-2'}
            >
              {waitsStart.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  data-testid="yours-waits-start-row"
                  onClick={() => goLine(r)}
                  className="group/l flex w-full items-center gap-3 py-2 text-left"
                >
                  <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center">
                    <span className="inline-block h-1.5 w-1.5 rounded-full border border-terracotta" />
                  </span>
                  <span className="min-w-0 flex-1 text-[14px] text-ink group-hover/l:text-terracotta">{taskLineWords(r)}</span>
                </button>
              ))}
              {comingToYou.map((r) => (
                <ComingToYou key={r.key} line={r} tasks={homeTasks.tasks} origin={{ kind: 'yours', ...(folder !== undefined ? { folder } : {}) }} />
              ))}
            </section>
          ) : null}
          {planNotice ? <p className="mt-1 text-xs text-terracotta">{planNotice}</p> : null}
          <Handoff
            handoff={handoff}
            stranded={stranded}
            onClear={() => {
              setHandoff([])
              setStranded(null)
            }}
          />
        </Sheet>
      ) : null}
      {sheet === 'working' ? (
        <Sheet
          testId="sheet-working"
          title="Working now"
          sub={[moving.length > 0 ? `${moving.length} working` : '', parked.length > 0 ? `${parked.length} waiting on something` : '']
            .filter(Boolean)
            .join(' · ')}
          onClose={closeHomeSheet}
        >
          <ul className="divide-y divide-line/60">
            {moving.map((w) => {
              const b = bg.get(`${w.s.folder}/${w.s.id}`)
              return (
                <li key={`${w.s.folder}/${w.s.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setSheet(null)
                      void useStore.getState().openSession(w.s.folder, w.s.id)
                    }}
                    className="group/w flex w-full items-center gap-3 py-2.5 text-left"
                  >
                    <Seal agent={w.agent} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-ink group-hover/w:text-terracotta">{w.s.title}</span>
                      <span className="block truncate font-mono text-[11px] text-ink-2">
                        {agentName(w.agent)} · {workingWord(b?.live ?? 0, b?.execution ?? null)}
                        {(() => {
                          const c = causeOf(w.s)
                          return c !== null ? ` · ${c}` : ''
                        })()}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-3">{relTime(w.s.mtime, nowTick)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {/* parked: they move by themselves when what they wait on answers —
              not working, not waiting on you. Each says on what, and since when */}
          {parked.length > 0 ? (
            <section aria-label="Waiting" data-testid="working-waiting" className={moving.length > 0 ? 'mt-5' : 'mt-2'}>
              <h3 className="flex items-center gap-1.5 font-mono text-[11px] lowercase text-ink-3">
                <Hourglass size={11} aria-hidden="true" />
                waiting on something · {parked.length}
              </h3>
              <ul className="mt-1 divide-y divide-line/60">
                {parked.map((c) => (
                  <li key={`${c.folder}/${c.id}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setSheet(null)
                        void useStore.getState().openSession(c.folder, c.id)
                      }}
                      className="group/p flex w-full items-center gap-3 py-2.5 text-left"
                    >
                      <Seal agent={byId(c.agentId)} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-ink group-hover/p:text-terracotta">{c.title}</span>
                        <span className="block truncate font-mono text-[11px] text-ink-2">
                          {agentName(byId(c.agentId))} · {waitingOnWords(c)}
                          {(() => {
                            const w = causeOf(sessionsByKey.get(`${c.folder}/${c.id}`))
                            return w !== null ? ` · ${w}` : ''
                          })()}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-3">{relTimeOf(c.waiting?.since, nowTick) ?? relTime(c.mtime, nowTick)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {/* the last line: tasks ready that nobody is on — /tasks?view=idle */}
          {idleLine ? (
            <button
              type="button"
              data-testid="working-idle-row"
              onClick={() => goLine(idleLine)}
              className={`group/i flex w-full items-center gap-3 border-t border-line/60 py-2.5 text-left ${moving.length + parked.length > 0 ? 'mt-4' : 'mt-1'}`}
            >
              <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center">
                <span className="inline-block h-1.5 w-1.5 rounded-full border border-ink-3" />
              </span>
              <span className="min-w-0 flex-1 text-[14px] text-ink-2 group-hover/i:text-terracotta">{taskLineWords(idleLine)}</span>
            </button>
          ) : null}
          {/* the door to the GLOBAL background view: work that hides inside
              conversations (a review spawning 15 verifiers shows as «1
              working» here) — shown exactly when there is some (no page may
              live on its URL alone) */}
          {(() => {
            const nBg = [...bg.values()].reduce((s, b) => s + b.live, 0)
            return nBg > 0 ? (
              <button
                type="button"
                data-testid="working-background-row"
                onClick={() => {
                  setSheet(null)
                  useStore.getState().changePage({ kind: 'background' })
                }}
                className={`group/bg flex w-full items-center gap-3 border-t border-line/60 py-2.5 text-left ${moving.length + parked.length > 0 || idleLine ? 'mt-4' : 'mt-1'}`}
              >
                <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink-3 dot-blink" />
                </span>
                <span className="min-w-0 flex-1 text-[14px] text-ink-2 group-hover/bg:text-terracotta">
                  {nBg === 1 ? '1 subagent at work' : `${nBg} subagents at work`} inside these conversations — see them all ›
                </span>
              </button>
            ) : null
          })()}
        </Sheet>
      ) : null}
      {sheet === 'quiet' && scope ? (
        <Sheet testId="sheet-quiet" title="Quiet agents" sub="nothing to say right now" onClose={closeHomeSheet}>
          <ul className="divide-y divide-line/60">
            {sections
              .flatMap((sec) => sec.quiet)
              .map((r) => ({
                key: r.agent.id,
                emoji: r.agent.emoji,
                label: agentName(r.agent),
                at: r.lastActive,
                go: () => changePage({ kind: 'agent', id: r.agent.id }),
              }))
              .map((q) => (
                <li key={q.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setSheet(null)
                      q.go()
                    }}
                    className="group/q flex w-full items-center gap-3 py-2.5 text-left"
                  >
                    <span aria-hidden="true" className="w-5 text-center">
                      {q.emoji}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14px] text-ink group-hover/q:text-terracotta">{q.label}</span>
                    {q.at ? <span className="shrink-0 font-mono text-[11px] text-ink-3">{relTime(q.at, nowTick)}</span> : null}
                  </button>
                </li>
              ))}
          </ul>
        </Sheet>
      ) : null}
      {sheet === 'digest' && (digest || finished.length > 0) ? (
        <Sheet
          testId="sheet-digest"
          title={digest ? 'While you were away' : 'Done today'}
          sub={!digest ? finishedWords(finished.length) : undefined}
          onClose={closeHomeSheet}
        >
          {digest ? (
            <DigestBand
              band={digest}
              now={nowTick}
              busy={digestBusy}
              onSeen={() => {
                closeHomeSheet()
                void digestSeen(digest)
              }}
              nameOf={(id, fallback) => byId(id)?.name ?? fallback}
            />
          ) : null}
          {/* the digest says the day in a paragraph; this is that day as a
              list — each finished conversation, one click from reopening */}
          {finished.length > 0 ? (
            <section aria-label="Finished today" data-testid="digest-finished" className={digest ? 'mt-7' : 'mt-2'}>
              {digest ? <h3 className="font-mono text-[11px] lowercase text-ink-3">finished today · {finished.length}</h3> : null}
              <ul className="mt-1 divide-y divide-line/60">
                {finished.map((c) => (
                  <li key={`${c.folder}/${c.id}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setSheet(null)
                        void useStore.getState().openSession(c.folder, c.id)
                      }}
                      className="group/d flex w-full items-center gap-3 py-2.5 text-left"
                    >
                      <Seal agent={byId(c.agentId)} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-ink group-hover/d:text-terracotta">{c.title}</span>
                        <span className="block truncate font-mono text-[11px] text-ink-2">
                          {agentName(byId(c.agentId))}
                          {(() => {
                            const w = causeOf(sessionsByKey.get(`${c.folder}/${c.id}`))
                            return w !== null ? ` · ${w}` : ''
                          })()}
                          {c.planTotal ? ` · checklist ${c.planDone ?? 0}/${c.planTotal}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-3">{relTime(c.mtime, nowTick)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </Sheet>
      ) : null}
      {sheet === 'since' && since ? (
        <SinceSheet
          since={since}
          now={nowTick}
          agents={agents}
          onClose={closeHomeSheet}
          onChanged={(agentId, still) => setSince((s) => (s ? { ...s, decided: s.decided.filter((x) => x.by !== agentId || still.has(x.id)) } : s))}
        />
      ) : null}
      {viewerPath ? <FileViewer path={viewerPath} onClose={() => setViewerPath(null)} /> : null}
    </div>
  )
}
