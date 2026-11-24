// ContextColumn.tsx — the context column (300px, border-l, bg-canvas) —
// blocks derived from `detail.context` (ContextAccumulator) IN ORDER and
// ONLY if there's data: Needs you · Plan · Waiting · Links · Events · Files ·
// Tools. (Where the conversation continues from lives in its header —
// AgentPage's ContinuesFrom, one home.) Only visible from lg up —
// below that (tablet and mobile alike, "always a tab" in the brief) access
// is via AgentPage.tsx's (ConversationView) "Context" pill, never this
// column itself (the same threshold Sidebar.tsx uses for its wide version).
// From lg up it's PERMANENT (no title, no collapse control);
// the pill only matters below lg, or with a persisted contextOpen=false. Context belongs
// to the CONVERSATION — this column only mounts from ConversationView,
// never from an agent's dossier.
//
// the column hosts TWO natures with labeled scope — the "Now" zone
// (everything above: the conversation's live status, untouched) and the
// "Setup" zone (below): the agent's STABLE configuration
// (charter/skills/memory/model), a fixed footer collapsed by default
// (persisted as `setup` in ui.json), each row linking to its dossier facet
// via openDossier. Scope legibility is carried by the material (bg-panel,
// the column's only tinted stretch) and the cockpit's mono voice — nothing
// in Setup should read as conversation status.
import { isStandingPlan, planDoor, planHeading, standingProjectOf } from '../lib/tasks'
import { runningNote } from '../lib/running'
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { ChevronRight, Hourglass, X, TriangleAlert } from 'lucide-react'
import type { TaskOrigin } from '../lib/routes'
import { useStore } from '../store'
import { api, getToken } from '../lib/api'
import { MASTER_ID } from '../lib/constants'
import { runsOnLine, humanizeProviderIds, canonicalProviderId, providerLabel } from '../lib/runs-on'
import { useHarness } from '../lib/harnesses'
import { knownWindow, pastHalfWindow } from '../lib/context'
import { useConversationWork } from './tasks/TaskBits'
import { useTaskOpen } from './tasks/TaskMode'
import { cannotRun } from '../lib/providers'
import { paceFraction, usageResetLabel, usageSentence, usageTone } from '../lib/plan-usage'
import { noPriceWords, subagentTokens, tokenWords } from '../lib/usage'
import { relTime } from '../lib/rel-time'
import { capitalized } from '../lib/period'
import { agentAtWork, backgroundWorking, closedByClient, isLive, lastTurnClosed, parkedWords, sessionSignal, shellRunning, toolInFlight } from '../lib/live'
import { SessionDot } from './SessionDot'
import { formatElapsed } from './StatusLine'
import { Pulse } from './Pulse'
import { Asterisk } from './Glyph'
import { Turn as TurnRow } from './Turn'
import { MediaScope } from './MediaImage'
import { PlanModeRow } from './PlanProposal'
import { FileViewer } from './FileViewer'
import { resolvePath, useFileRef, usedFileDoor } from '../lib/file-refs'
import { useKnowsSources } from './knows/KnowsAnatomy'
import { StartedWithBlock } from './StartedWithBlock'
import { useKnowsHere } from './knows/knows-here'
import { agentToolsFigure } from '../lib/agent-tabs'
import { memoryNotes } from '../lib/knows-anatomy'
import { humanReadyTasks, isFinished, isPlanFile, planIsOf, planProjectFolder } from '../lib/team-plan'
import { loadPlan, type LoadedPlan } from '../lib/plan-record'
import {
  executionOver,
  executionProgress,
  executionWord,
  groupExecution,
  progressSource,
  spanWord,
  stepWord,
  type ExecutionProgress,
  type ExecutionTask,
} from '../lib/execution'
import {
  automationsInScope,
  isDone,
  MAX_ROWS_WIDE,
  nextRunIn,
  nextWiderScope,
  ownKindOf,
  runOutcomeWord,
  SCOPE_LABEL,
  SCOPE_ORDER,
  triggerSummary,
  type MachineryScope,
  type ScopeSession,
} from '../lib/automations'
import type {
  AgentView,
  PlanUsage,
  Automation,
  DiskSubagent,
  PlanTask,
  Run,
  SessionContext,
  SessionView,
  SubagentRef,
  Turn,
  RunStatus,
  VaultEntry,
  ConversationProcess,
} from '../lib/types'
import { effectiveVaultFor } from '../lib/vault-view'
import { ConfirmButton } from './ConfirmButton'
import { portsWords, processFacts, splitTail, STOP_PROCESS, SYSTEM_SILO } from '../lib/processes'
import { missionLine } from '../lib/mission'

function timeSince(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? relTime(ms) : ''
}

// each block is a COLLAPSIBLE SECTION (<details>) with a clickable header —
// a label + an optional counter + a chevron that rotates. This way, in a
// loaded session, the column stops being a wall: what's uninteresting
// collapses. The heavy blocks (Events/Files/Tools) start COLLAPSED
// (defaultOpen=false); the actionable/brief ones (Needs you, Plan,
// Waiting…) start open. `<details>` keeps its children in the DOM even
// while closed (neither focus nor search is lost).
function Block({
  title,
  count,
  note,
  defaultOpen = true,
  accent = false,
  action,
  children,
}: {
  title: string
  count?: number
  // note: a quiet summary that reads with the block CLOSED ("17 of 17
  // done · 16h ago" on a finished execution) — takes the count's slot.
  note?: string
  defaultOpen?: boolean
  // accent: an ACTIONABLE section (Needs you / Needs approval) — a terracotta
  // bar on the left + a terracotta label, so "something's waiting on you"
  // gains prominence over reference material (Files/Tools/…).
  accent?: boolean
  // action: a control that rides in the header (the Knows block's "+") —
  // clicks on it must not fold the block.
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <details open={defaultOpen} className={`group border-b border-line ${accent ? 'border-l-2 border-l-terracotta' : ''}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 hover:bg-panel [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-150 group-open:rotate-90 ${accent ? 'text-terracotta' : 'text-ink-2'}`}
        />
        <span className={`text-[11px] font-medium uppercase tracking-wider ${accent ? 'text-terracotta' : 'text-ink-2'}`}>{title}</span>
        {/* a note rides BESIDE a count when both are given (Processes: its
            ports, quietly, then how many) — alone it takes the count's slot */}
        {note !== undefined ? <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-ink-3">{note}</span> : null}
        {count !== undefined ? <span className={`${note !== undefined ? 'ml-2' : 'ml-auto'} shrink-0 font-mono text-[11px] text-ink-2`}>{count}</span> : null}
        {action ? (
          <span className={count === undefined && note === undefined ? 'ml-auto' : ''} onClick={(e) => e.preventDefault()}>
            {action}
          </span>
        ) : null}
      </summary>
      <div className="px-3 pb-3 pt-0.5">{children}</div>
    </details>
  )
}

// clicking an option asks the server first (POST …/answer); a chat turn
// goes out through the composer's own flow (store.send) only when the
// server says so.
function NeedsYou({ pending, folder, id }: { pending: NonNullable<SessionContext['pending']>; folder: string; id: string }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // one action, the server picks the engine: a running console gets the
  // digit + Enter typed in; an OpenCode ask gets its reply file ('ask');
  // only an explicit `engine: 'chat'` sends the label as a chat turn. A
  // failure (a stale ask answered in the TUI or timed out: 404) says so and
  // sends nothing — "Allow" typed into a session a live TUI holds is never
  // an answer.
  async function answer(i: number, label: string): Promise<void> {
    setBusy(i)
    setNotice(null)
    try {
      let r: Awaited<ReturnType<typeof api.answer>>
      try {
        r = await api.answer(folder, id, i)
      } catch (e) {
        setNotice(e instanceof Error && e.message ? e.message : 'Could not answer — nothing was sent.')
        return
      }
      if (r?.engine === 'chat') await useStore.getState().send(label)
    } finally {
      setBusy(null)
    }
  }
  // several questions in one call (or one that takes several answers): a
  // small form, every answer sent as ONE chat message — the one-click path
  // below answers a single question, which is all the console can take
  if ((pending.more?.length ?? 0) > 0 || pending.multiSelect) return <NeedsYouForm pending={pending} folder={folder} id={id} />
  return (
    <Block title="Needs you" accent>
      <p className="mb-2 text-sm text-ink">{pending.question}</p>
      {notice ? (
        <p role="status" className="mb-2 text-xs text-ink-2">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {pending.options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            disabled={busy !== null}
            onClick={() => void answer(i, o.label)}
            className="rounded-lg border border-line px-2.5 py-1.5 text-left text-sm text-ink hover:border-terracotta hover:text-terracotta"
          >
            {o.label}
            {o.description ? <span className="block text-xs text-ink-2">{o.description}</span> : null}
          </button>
        ))}
      </div>
    </Block>
  )
}

// The answer to every question as the message the agent reads: one line per
// question, «question → answer[, answer]».
export function composeAnswers(questions: readonly { question: string }[], picks: readonly (readonly string[])[]): string {
  return questions.map((q, i) => `${q.question} → ${(picks[i] ?? []).join(', ')}`).join('\n')
}

function NeedsYouForm({ pending, folder, id }: { pending: NonNullable<SessionContext['pending']>; folder: string; id: string }) {
  const questions = [pending, ...(pending.more ?? [])]
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []))
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const complete = picks.every((p) => p.length > 0)
  function toggle(qi: number, label: string, multi: boolean): void {
    setPicks((all) => all.map((p, i) => (i !== qi ? p : multi ? (p.includes(label) ? p.filter((l) => l !== label) : [...p, label]) : [label])))
  }
  // the server first: an engine that answers in place (an OpenCode
  // question — its plugin's reply file) takes the picks as they are; only
  // `engine: 'chat'` sends them as ONE composed message. A failure says so
  // and sends nothing.
  async function send(): Promise<void> {
    setSending(true)
    setNotice(null)
    try {
      let r: Awaited<ReturnType<typeof api.answer>>
      try {
        r = await api.answer(folder, id, 0, picks)
      } catch (e) {
        setNotice(e instanceof Error && e.message ? e.message : 'Could not answer — nothing was sent.')
        return
      }
      if (r?.engine === 'chat') await useStore.getState().send(composeAnswers(questions, picks))
    } finally {
      setSending(false)
    }
  }
  return (
    <Block title="Needs you" accent>
      {notice ? (
        <p role="status" className="mb-2 text-xs text-ink-2">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-col gap-3">
        {questions.map((q, qi) => (
          <fieldset key={qi} className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm text-ink">
              {q.question}
              {q.multiSelect ? <span className="ml-1 text-xs text-ink-3">· pick any</span> : null}
            </legend>
            {q.options.map((o) => {
              const on = picks[qi]!.includes(o.label)
              return (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={on}
                  disabled={sending}
                  onClick={() => toggle(qi, o.label, q.multiSelect === true)}
                  className={`rounded-lg border px-2.5 py-1.5 text-left text-sm ${on ? 'border-terracotta text-terracotta' : 'border-line text-ink hover:border-terracotta hover:text-terracotta'}`}
                >
                  {o.label}
                  {o.description ? <span className="block text-xs text-ink-2">{o.description}</span> : null}
                </button>
              )
            })}
          </fieldset>
        ))}
        <button
          type="button"
          disabled={!complete || sending}
          onClick={() => void send()}
          className="self-start rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
        >
          {questions.length > 1 ? 'Send answers' : 'Send answer'}
        </button>
      </div>
    </Block>
  )
}

// a block for THIS agent's automation approvals — the same visual pattern
// as NeedsYou (cards with actions), but the source is automationsPending
// (runs waiting_approval), not the turn's own context.pending. There can
// be several at once (one per waiting automation).
function AutomationApprovalsBlock({ pending, automations }: { pending: Run[]; automations: Automation[] }) {
  const approveRun = useStore((s) => s.approveRun)
  const skipRun = useStore((s) => s.skipRun)
  return (
    <Block title="Needs approval" count={pending.length} accent note="the agent’s, not only this conversation’s">
      <div className="flex flex-col gap-2">
        {pending.map((r) => {
          const a = automations.find((x) => x.id === r.automationId)
          return (
            <div key={r.id} className="rounded-lg border border-line px-2.5 py-1.5">
              <p className="text-sm text-ink">{a?.name ?? r.automationId}</p>
              {r.promptOverride ? <p className="truncate text-xs text-ink-2">{r.promptOverride}</p> : null}
              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void approveRun(r.id)}
                  className="rounded-full border border-terracotta/40 bg-terracotta-soft px-2 py-0.5 text-[11px] font-medium text-terracotta hover:border-terracotta"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => void skipRun(r.id)}
                  className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:border-ink-2 hover:text-ink"
                >
                  Skip
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </Block>
  )
}

// "the routine lives in ONE conversation that accumulates context" —
// visible when the open session IS an automation's keep thread (next fire,
// last run). Ink (not terracotta): informative, not an action.
// Automations — the agent's standing machinery, alive in the column now
// that the Automations tab is gone (above all, the active ones). One row per automation of THIS conversation's agent, the one
// whose keep-thread IS this conversation first and marked. The state is
// the point: an armed dot + a countdown to the next run + the RUN RAIL —
// the last runs as ticks (green ok · red failed · hollow skipped), real
// history at a glance, fetched lazily per row. Pause/Resume acts inline
// through the same API the sheet uses.
const RUN_TICK: Record<RunStatus, string> = {
  ok: 'bg-emerald-600 dark:bg-emerald-400',
  failed: 'bg-rose-600 dark:bg-rose-400',
  running: 'bg-terracotta animate-pulse',
  skipped: 'bg-line',
  queued: 'bg-amber-500',
  waiting_approval: 'bg-amber-500',
  waiting_reset: 'bg-amber-500',
}

const RAIL_MAX = 24

function RunRail({ runs, highlightId }: { runs: readonly Run[]; highlightId?: string }) {
  if (runs.length === 0) return null
  // oldest → newest, newest at the RIGHT edge (reading order of time)
  const all = [...runs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  // a provenance row fetches 50 runs to find its own: draw at most RAIL_MAX
  // (wider than the column pushed the caption into a tall sliver), the
  // newest ones — or, when the highlighted run is older, a window that
  // keeps it with its neighbours.
  const h = highlightId ? all.findIndex((r) => r.id === highlightId) : -1
  const end = h < 0 || h >= all.length - RAIL_MAX ? all.length : Math.min(all.length, h + Math.ceil(RAIL_MAX / 2))
  const ordered = all.slice(Math.max(0, end - RAIL_MAX), end)
  return (
    <span role="img" aria-label={`last ${ordered.length} runs`} className="inline-flex items-end gap-[3px]">
      {ordered.map((r) => (
        <span
          key={r.id}
          data-run-id={r.id}
          title={`${r.status} · ${new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${r.id === highlightId ? ' · this conversation' : ''}`}
          // the run that produced the open conversation stands taller and
          // ringed — "you are here" on the timeline
          className={`w-[3px] rounded-full ${RUN_TICK[r.status] ?? 'bg-line'} ${r.id === highlightId ? 'h-[13px] ring-1 ring-terracotta ring-offset-1 ring-offset-canvas' : 'h-[9px]'}`}
        />
      ))}
    </span>
  )
}

// the armed/paused/attention dot — the same two-state language as
// SessionDot, plus amber for "paused by Silos / last run failed".
function AutomationDot({ a }: { a: Automation }) {
  if (a.autoPaused || a.lastRunError) {
    return <span title={a.lastRunError ?? 'paused by Silos'} className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
  }
  // a finished once: settled ink, neither armed nor a switch to flip
  if (isDone(a)) {
    return <span title="done" className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-ink-3" />
  }
  if (a.paused) {
    return <span title="paused" className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full border border-ink-3" />
  }
  return <span title="active" className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-terracotta" />
}

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000)
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`
}

// one row = one automation at the chosen radius. `own` says what the open
// conversation is to it: the keep thread it LIVES in, a run that PRODUCED
// it, or nothing. With a run, the row reports THAT run — never the
// automation's latest, which may be a later one (a conversation was once
// captioned with the next day's run). `agentLabel` names the owner
// whenever the radius mixes agents (project / everywhere).
function AutomationRow({
  a,
  own,
  ownRunId,
  agentLabel,
  now,
  onToggle,
}: {
  a: Automation
  own: 'thread' | 'run' | null
  ownRunId?: string
  agentLabel?: string
  now: number
  onToggle: (a: Automation) => void
}) {
  const active = !a.paused && !a.autoPaused
  const done = isDone(a)
  const next = active ? nextRunIn(a, now) : null
  const last = a.lastRun ?? null
  const runNowAutomation = useStore((s) => s.runNowAutomation)
  // the run rail's history — fetched here, once per row, so the same list
  // also answers "which run produced this conversation". A provenance row
  // asks for more: its run may sit well behind the latest ten.
  const [runs, setRuns] = useState<Run[] | null>(null)
  useEffect(() => {
    let alive = true
    Promise.resolve(api.automations.runs(a.id, ownRunId ? 50 : 10))
      .then((r) => {
        if (alive) setRuns(r ?? [])
      })
      .catch(() => {
        if (alive) setRuns([])
      })
    return () => {
      alive = false
    }
  }, [a.id, ownRunId])
  const thisRun = ownRunId ? (runs?.find((r) => r.id === ownRunId) ?? null) : null
  const showAutomation = useStore((s) => s.showAutomation)
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <li className="group/auto rounded px-1 py-1 hover:bg-panel" data-testid="automation-row">
      <div className="flex items-start gap-2">
        <AutomationDot a={a} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            {/* the name opens the automation's full context — the agent's
                automations facet over the transcript, landing on it */}
            <button
              type="button"
              onClick={() => showAutomation(a.id)}
              title={a.name}
              className={`line-clamp-2 min-w-0 break-words text-left text-[13px] leading-snug hover:text-terracotta ${active ? 'text-ink' : 'text-ink-2'}`}
            >
              {a.name}
            </button>
            {/* a finished once is not resumed (that would re-fire it as if
                armed) — it is run AGAIN, on purpose, as a manual run. */}
            <button
              type="button"
              onClick={() => (done ? void runNowAutomation(a.id) : onToggle(a))}
              className="shrink-0 rounded-md border border-line px-1.5 py-px text-[10px] text-ink-2 opacity-0 transition-opacity hover:border-terracotta hover:text-terracotta focus-visible:opacity-100 group-hover/auto:opacity-100"
            >
              {done ? 'Run again' : a.paused ? 'Resume' : 'Pause'}
            </button>
          </div>
          <div className="text-[11px] text-ink-2">
            {agentLabel ? (
              <span className="text-ink-3" data-testid="automation-agent">
                {agentLabel} ·{' '}
              </span>
            ) : null}
            {done ? 'done · ' : a.paused || a.autoPaused ? 'paused · ' : ''}
            {triggerSummary(a.trigger)}
            {next ? (
              <>
                {' '}
                · <span className="text-ink">next {next}</span>
              </>
            ) : (
              ''
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ink-3">
            <RunRail runs={runs ?? []} highlightId={ownRunId} />
            {own === 'run' ? (
              <span data-testid="automation-this-run">
                this run
                {thisRun
                  ? ` · ${runOutcomeWord(thisRun)}${thisRun.durationMs !== undefined ? ` · ${fmtDuration(thisRun.durationMs)}` : ''} · ${when(thisRun.startedAt ?? thisRun.at)}`
                  : ''}
              </span>
            ) : last ? (
              <span>
                {last.status === 'ok' ? 'ok' : last.status} · {timeSince(last.at)}
              </span>
            ) : (
              <span>never ran</span>
            )}
          </div>
          {own === 'thread' ? <div className="text-[10px] text-terracotta/80">runs in this thread</div> : null}
          {own === 'run' ? <div className="text-[10px] text-terracotta/80">produced this conversation</div> : null}
        </div>
      </div>
    </li>
  )
}

// the radius dial, riding in the block's header: the machinery is the only
// thing in this column that wasn't already about the open conversation, so
// it is the only thing that needs to say how far it reaches. Same popover
// contract as the Knows block's "+" (outside click / Escape close it).
function ScopeMenu({
  scope,
  onPick,
  order = SCOPE_ORDER,
  what = 'Machinery',
}: {
  scope: MachineryScope
  onPick: (s: MachineryScope) => void
  order?: readonly MachineryScope[]
  what?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    if (!open) return
    // the menu contract: focus lands on the current radius, arrows walk the
    // list (roving focus), Escape closes — what a role=menu promises.
    items.current[order.indexOf(scope)]?.focus()
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus moves when the menu opens or the radius changes, not when a caller passes a new list
  }, [open, scope])
  function onMenuKey(e: { key: string; preventDefault(): void }): void {
    const n = order.length
    const i = items.current.findIndex((el) => el === document.activeElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items.current[e.key === 'ArrowDown' ? (i + 1 + n) % n : (i - 1 + n) % n]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items.current[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items.current[n - 1]?.focus()
    }
  }
  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${what} shown for ${SCOPE_LABEL[scope]} — change`}
        onClick={(e) => {
          e.preventDefault()
          setOpen((v) => !v)
        }}
        className="rounded-md border border-line px-1.5 py-px text-[10px] normal-case tracking-normal text-ink-2 hover:border-terracotta hover:text-terracotta"
      >
        {SCOPE_LABEL[scope]}
      </button>
      {open ? (
        <span role="menu" onKeyDown={onMenuKey} className="absolute right-0 z-20 mt-1 flex w-40 flex-col rounded-lg border border-line bg-panel py-1 shadow-lg">
          {order.map((s, i) => (
            <button
              key={s}
              ref={(el) => {
                items.current[i] = el
              }}
              role="menuitem"
              type="button"
              tabIndex={s === scope ? 0 : -1}
              onClick={(e) => {
                e.preventDefault()
                setOpen(false)
                onPick(s)
              }}
              className={`px-3 py-1 text-left text-xs normal-case tracking-normal hover:bg-canvas focus-visible:bg-canvas ${s === scope ? 'text-terracotta' : 'text-ink'}`}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  )
}

function AutomationsBlock({
  all,
  session,
  agents,
  scope,
  onScope,
  now,
  onToggle,
}: {
  all: Automation[]
  session: ScopeSession | null
  agents: { id: string; folder: string | null; name: string; emoji: string }[]
  scope: MachineryScope
  onScope: (s: MachineryScope) => void
  now: number
  onToggle: (a: Automation) => void
}) {
  const changePage = useStore((s) => s.changePage)
  const ctx = { session, agents }
  const inScope = automationsInScope(scope, all, ctx)
  // "this conversation's own" first at every radius — the keep thread it
  // lives in, or the run that produced it (ownKindOf).
  const own = (a: Automation) => ownKindOf(a, session)
  // armed first, then paused, then the finished one-shots (isDone)
  const rank = (a: Automation): number => (!a.paused && !a.autoPaused ? 0 : isDone(a) ? 2 : 1)
  const rows = [...inScope].sort((x, y) => {
    const t = Number(own(y) !== null) - Number(own(x) !== null)
    if (t !== 0) return t
    const r = rank(x) - rank(y)
    if (r !== 0) return r
    return x.name.localeCompare(y.name)
  })
  const activeCount = inScope.filter((a) => !a.paused && !a.autoPaused).length
  const doneCount = inScope.filter(isDone).length
  const idleWord = doneCount === inScope.length ? 'done' : doneCount === 0 ? 'paused' : 'paused or done'
  // beyond the conversation the column SUMMARIZES — a handful of rows, then
  // a pointer to the page that holds the rest (docs/product.md: "the column
  // never duplicates a page; it points to it"). Also what keeps the
  // per-row history fetches bounded at the wide radii.
  const capped = scope !== 'conversation' && rows.length > MAX_ROWS_WIDE
  const shown = capped ? rows.slice(0, MAX_ROWS_WIDE) : rows
  const mixesAgents = scope === 'project' || scope === 'all'
  const labelOf = (a: Automation): string | undefined => {
    if (!mixesAgents) return undefined
    const ag = agents.find((x) => x.id === a.agentId)
    if (!ag) return a.agentId
    return ag.id === MASTER_ID ? '✳ Anywhere' : `${ag.emoji} ${ag.name}`
  }
  // the rest live on the Automations page — narrowed to this agent at its radius
  const seeAll = (): void => {
    const agentId = session?.agentId
    changePage(scope === 'agent' && agentId ? { kind: 'automations', agent: agentId } : { kind: 'automations' })
  }
  // nothing is hidden without saying so (everything stays visible): one
  // quiet line names what the next radius adds —
  // rows AND armed, the header's own number — and widens it on click.
  const hidden = nextWiderScope(scope, all, ctx)
  return (
    <Block title="Automations" count={activeCount > 0 ? activeCount : undefined} action={<ScopeMenu scope={scope} onPick={onScope} />}>
      {rows.length > 0 ? (
        <ul role="list" className="-mx-1 space-y-0.5">
          {shown.map((a) => {
            const kind = own(a)
            return (
              <AutomationRow
                key={a.id}
                a={a}
                own={kind}
                ownRunId={kind === 'run' ? session?.origin?.runId : undefined}
                agentLabel={labelOf(a)}
                now={now}
                onToggle={onToggle}
              />
            )
          })}
        </ul>
      ) : (
        <p className="text-[11px] text-ink-3" data-testid="automations-empty-scope">
          {scope === 'conversation'
            ? 'No automation produced this conversation.'
            : scope === 'all'
              ? 'Nothing armed anywhere.'
              : `Nothing armed for ${SCOPE_LABEL[scope]}.`}
        </p>
      )}
      {capped ? (
        <button type="button" onClick={seeAll} data-testid="automations-see-all" className="mt-1 text-[11px] text-ink-2 hover:text-terracotta">
          +{rows.length - shown.length} more · all {rows.length} in Automations ›
        </button>
      ) : null}
      {rows.length > 0 && activeCount === 0 ? <p className="mt-1 text-[11px] text-ink-3">Nothing armed — every automation is {idleWord}.</p> : null}
      {hidden ? (
        <button
          type="button"
          onClick={() => onScope(hidden.scope)}
          data-testid="automations-wider"
          className="mt-1 block text-[11px] text-ink-2 hover:text-terracotta"
        >
          +{hidden.extra} {hidden.scope === 'all' ? 'everywhere' : `in ${SCOPE_LABEL[hidden.scope]}`}
          {hidden.armed > 0 ? ` · ${hidden.armed} armed` : ''}
        </button>
      ) : null}
    </Block>
  )
}

const TASK_GLYPH: Record<PlanTask['status'], string> = { completed: '✓', in_progress: '●', pending: '○' }

// Subagents not hanging off any plan task (or sessions with no plan), read
// from the transcript's tool calls. Each row is a SUBAGENT of the main
// agent: ● terracotta = alive, ◯ gray = finished. This block is only
// painted when the disk census is empty (old layout, deleted files,
// OpenCode), which is exactly when the server has no transcript to serve —
// so a row here is never a door: text, not a button. A subagent whose
// transcript exists is a census row (CensusBlock), and that one opens.
function AgentsBlock({ agents }: { agents: SubagentRef[] }) {
  // a preview of 5 + "Show all N" (UsedList) is
  // shown and, on expanding, a height cap with internal scroll — the column
  // never grows without end.
  return (
    <Block title="Subagents" count={agents.length} defaultOpen={false}>
      <UsedList
        items={agents}
        keyOf={(a) => a.id}
        render={(a) => (
          <div className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs">
            <span title={a.endedAt ? 'done' : 'running'} className={a.endedAt ? 'text-ink-3' : 'text-terracotta'}>
              {a.endedAt ? '◯' : '●'}
            </span>
            <span className="truncate text-ink">{a.description}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-2">{a.type}</span>
          </div>
        )}
      />
    </Block>
  )
}

// The model word for the bill chip: meta.json already says "opus"/"fable";
// a transcript id like claude-fable-5 reduces to its family word. Anything
// unrecognized shows as-is — never invented.
function shortModel(model: string): string {
  const m = /^claude-([a-z]+)/.exec(model)
  return m ? m[1]! : model
}

// The DISK census of background work (<session>/subagents/, detail.subagents):
// the complete truth of who works for this conversation. Live rows first —
// a skill run (forked-skill sidecar) is named by its skill and carries its
// children (parentId) nested under a left rail; each live row says what it
// is doing NOW (last tool_use of its transcript tail). Finished work folds
// behind "Earlier · N": history informs, it never crowds the live set.
// Clicking any row opens its transcript (same viewer as AgentsBlock).
function CensusBlock({ census, now, onOpen }: { census: DiskSubagent[]; now: number; onOpen: (s: SubagentRef) => void }) {
  const refOf = (a: DiskSubagent): SubagentRef => ({
    id: a.id,
    description: a.description ?? a.type ?? a.id,
    type: a.type ?? '',
    background: true,
    startedAt: '',
    ...(agentAtWork(a, now) ? {} : { endedAt: new Date(a.mtime).toISOString() }),
  })
  const byParent = new Map<string, DiskSubagent[]>()
  const roots: DiskSubagent[] = []
  const ids = new Set(census.map((a) => a.id))
  for (const a of census) {
    if (a.parentId !== undefined && ids.has(a.parentId)) {
      const kin = byParent.get(a.parentId) ?? []
      kin.push(a)
      byParent.set(a.parentId, kin)
    } else roots.push(a)
  }
  // live families first (a root is "live" if it or any child still writes),
  // then the rest, newest first — the top of the block is always the work.
  const familyLive = (r: DiskSubagent): boolean => agentAtWork(r, now) || (byParent.get(r.id) ?? []).some((c) => agentAtWork(c, now))
  const liveRoots = roots.filter(familyLive)
  const earlier = roots.filter((r) => !familyLive(r))

  // the bill chip: which model it runs on and how many tokens it has used
  // — Usage's definition of a row's tokens (every kind,
  // cache reads included: a subagent re-reads its own context each step,
  // and that is most of its bill), so the census and Usage never disagree.
  // The split and the cost live in the tooltip — the column points.
  const billTitle = (a: DiskSubagent): string | undefined => {
    if (a.usage === undefined) return a.model
    const u = a.usage
    const parts = [`in ${fmtTokens(u.input)}`, `out ${fmtTokens(u.output)}`]
    if (u.cacheRead + u.cacheWrite > 0) parts.push(`cache ${fmtTokens(u.cacheRead + u.cacheWrite)}`)
    parts.push(u.usd === null ? noPriceWords(a.model !== undefined ? [a.model] : []) : `$${u.usd.toFixed(2)}`)
    return `${a.model ?? '?'} · ${parts.join(' · ')}`
  }
  const bill = (a: DiskSubagent): string => {
    const model = a.model !== undefined ? shortModel(a.model) : ''
    if (a.usage === undefined) return model
    const tok = tokenWords(subagentTokens(a.usage))
    return model !== '' ? `${model} · ${tok}` : tok
  }

  const row = (a: DiskSubagent, nested: boolean) => {
    const live = agentAtWork(a, now)
    const kin = byParent.get(a.id) ?? []
    const kinLive = kin.filter((c) => agentAtWork(c, now))
    const kinDone = kin.length - kinLive.length
    return (
      <div key={a.id}>
        <button
          type="button"
          onClick={() => onOpen(refOf(a))}
          aria-label={`Open transcript of ${a.description ?? a.type ?? a.id}`}
          className="group/sub flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-panel"
        >
          <span title={live ? 'running' : 'done'} className={live ? 'live-phase text-terracotta' : 'text-ink-3'}>
            {live ? '●' : '◯'}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink">{a.description ?? a.type ?? a.id}</span>
          {a.skill !== undefined ? (
            <span className="shrink-0 rounded-full border border-line px-1.5 py-px font-mono text-[9px] text-ink-2">{a.skill}</span>
          ) : null}
          <span className="shrink-0 font-mono text-[10px] text-ink-3" title={billTitle(a)}>
            {bill(a)}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-ink-3">
            {live && a.startedAt !== undefined ? timeSince(new Date(a.startedAt).toISOString()) : relTime(a.mtime, now)}
          </span>
          <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-ink-3 group-hover/sub:text-terracotta" />
        </button>
        {live && a.lastTool !== undefined ? (
          <div className="truncate pl-6 pr-1 font-mono text-[10px] text-ink-2">
            {a.lastTool}
            {a.lastToolDetail !== undefined ? ` — ${a.lastToolDetail}` : ''}
          </div>
        ) : null}
        {kin.length > 0 ? (
          <div className="ml-[7px] border-l border-line pl-2">
            {kinLive.map((c) => row(c, true))}
            {kinDone > 0 ? (
              <div className="px-1 py-0.5 text-[10px] text-ink-3">
                {kinDone} finished{nested ? '' : ' — in its transcript'}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  // fan-out seen while it happens: how many agents this block lists (every
  // depth) and their tokens so far, on the header — readable folded. Who is
  // at work now is the status line's («N subagents at work»), said once.
  const spent = census.reduce((n, a) => n + (a.usage ? subagentTokens(a.usage) : 0), 0)
  const started = `${census.length} started${spent > 0 ? ` · ${tokenWords(spent)} tokens` : ''}`
  return (
    <Block title="Subagents" note={started} accent={false}>
      <div className="space-y-0.5 px-3 pb-2.5">
        {liveRoots.map((a) => row(a, false))}
        {earlier.length > 0 ? (
          <details className="group/earlier">
            <summary className="cursor-pointer list-none rounded px-1 py-0.5 text-[10px] uppercase tracking-wide text-ink-3 hover:bg-panel [&::-webkit-details-marker]:hidden">
              Earlier · {earlier.length}
            </summary>
            <div className="max-h-64 space-y-0.5 overflow-y-auto">{earlier.map((a) => row(a, false))}</div>
          </details>
        ) : null}
      </div>
    </Block>
  )
}

// A plan being EXECUTED with subagents (lib/execution.ts): the census rows
// whose names follow the subagent-driven-development templates, grouped
// by task. One row per task — its number, the implementer's title, when it
// last moved — and under it the steps in the order they ran (implement ·
// review · re-review round N), each a door to that subagent's transcript.
// Glyphs (an empty circle on a finished task is not intuitive): a task
// the PLAN calls done → ✓ in the Plan block's green;
// live → ● terracotta; finished but not marked done (or no plan) → ◯. A
// step is ● while it runs and a quiet ✓ once it ran — "it ran", not "it
// approved": a rejected review still ran, and the re-review that follows
// is right there. A live step shows its last tool as proof of life. Live
// tasks stay open; the rest fold as "Earlier".
// `over` (lib/execution.ts executionOver): nothing runs and nothing is
// left — the block is history, not state. It then reads "Executed" with
// the outcome in its header, CLOSED by default, and the column places it
// down with the agents instead of under the status (a finished run at the
// top is misleading; under show-older it collapses).
// a task opened from the column comes back to its conversation
function conversationOrigin(): { from?: TaskOrigin } {
  const sel = useStore.getState().selected
  return sel ? { from: { kind: 'conversation', folder: sel.folder, id: sel.id } } : {}
}

function ExecutionBlock({
  tasks,
  done,
  progress,
  now,
  onOpen,
  over = false,
  fromRecord = false,
  task = null,
}: {
  tasks: ExecutionTask[]
  done: Set<number>
  progress: ExecutionProgress
  now: number
  onOpen: (s: SubagentRef) => void
  over?: boolean
  fromRecord?: boolean
  task?: { key: string; ref: string } | null
}) {
  // «for plan#t3 ›»: the task this execution hangs from (task-view phase 5,
  // D2) — the door from the conversation to its task's page
  const forTask = task ? (
    <button
      type="button"
      data-testid="execution-task-door"
      onClick={() => {
        const i = task.key.lastIndexOf('/tasks/')
        if (i > 0)
          useStore.getState().changePage({ kind: 'task', plan: task.key.slice(0, i), task: task.key.slice(i + '/tasks/'.length), ...conversationOrigin() })
      }}
      className="mb-1 block px-1 text-left text-[11px] text-ink-2 hover:text-terracotta"
      title="Open the task this execution hangs from"
    >
      for <span className="font-mono text-[10.5px]">{task.ref}</span> ›
    </button>
  ) : null
  const refOf = (a: DiskSubagent): SubagentRef => ({
    id: a.id,
    description: a.description ?? a.type ?? a.id,
    type: a.type ?? '',
    background: true,
    startedAt: '',
    ...(agentAtWork(a, now) ? {} : { endedAt: new Date(a.mtime).toISOString() }),
  })
  const liveSteps = tasks.reduce((n, t) => n + t.steps.filter((s) => s.live).length, 0)
  const open = tasks.some((t) => t.live) ? tasks.filter((t) => t.live) : tasks.slice(0, 1)
  const earlier = tasks.filter((t) => !open.includes(t))
  // ◯ says why a task is not ✓: with the executor's record, in its words
  // (a fix round, or ran and not yet approved); without one, the plan's.
  const pendingTitle = (t: ExecutionTask): string => {
    if (!fromRecord) return 'finished — not marked done in the plan'
    if (t.state === 'fixing') return t.round !== undefined ? `fixing — round ${t.round}` : 'fixing'
    return 'ran — not approved yet'
  }

  const row = (t: ExecutionTask) => (
    <div key={t.n} data-testid={`execution-task-${t.n}`} className="rounded px-1 py-1">
      <div className="flex items-center gap-2 text-xs">
        {t.live ? (
          <span title="running" className="live-phase text-terracotta">
            ●
          </span>
        ) : done.has(t.n) || t.state === 'complete' ? (
          // `state` covers a complete task the document does not name
          // (a "Task 0: baseline"): it ran and was approved, so ✓ — it just
          // does not count toward the document's total.
          <span title="done" className="text-emerald-600 dark:text-emerald-400">
            ✓
          </span>
        ) : (
          <span title={pendingTitle(t)} className="text-ink-3">
            ◯
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-ink-2">Step {t.n}</span>
        <span className="min-w-0 flex-1 truncate text-ink">{t.title ?? ''}</span>
        <span className="shrink-0 font-mono text-[10px] text-ink-3">{relTime(t.mtime, now)}</span>
      </div>
      {t.steps.length > 0 ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5">
          {t.steps.map((s) => (
            <button
              key={s.sub.id}
              type="button"
              onClick={() => onOpen(refOf(s.sub))}
              aria-label={`Open transcript of ${s.sub.description ?? s.sub.id}`}
              className="group/step flex items-center gap-1 whitespace-nowrap rounded px-1 py-px text-[11px] hover:bg-panel"
            >
              <span aria-hidden="true" className={s.live ? 'live-phase text-terracotta' : 'text-ink-3'}>
                {s.live ? '●' : '✓'}
              </span>
              <span className={s.live ? 'text-ink group-hover/step:text-terracotta' : 'text-ink-2 group-hover/step:text-terracotta'}>{stepWord(s)}</span>
              {s.kin.length > 0 ? (
                <span className="font-mono text-[10px] text-ink-3" title={`${s.kin.length} subagent${s.kin.length === 1 ? '' : 's'} inside`}>
                  +{s.kin.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {t.detail !== undefined ? <div className="truncate pl-5 font-mono text-[10px] text-ink-3">{t.detail}</div> : null}
      {t.steps
        .filter((s) => s.live && s.sub.lastTool !== undefined)
        .slice(-1)
        .map((s) => (
          <div key={`${s.sub.id}-tool`} className="truncate pl-6 pr-1 font-mono text-[10px] text-ink-2">
            {s.sub.lastTool}
            {s.sub.lastToolDetail !== undefined ? ` — ${s.sub.lastToolDetail}` : ''}
          </div>
        ))}
    </div>
  )

  // the progress line: done/total against the record or plan when there is one, how
  // long the live step has run, and the pace extrapolated over what
  // remains — each part only when the data is there (lib/execution.ts).
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : null
  const parts: string[] = []
  if (progress.total !== null) parts.push(`${progress.done} of ${progress.total} done`)
  else if (progress.done > 0) parts.push(`${progress.done} step${progress.done === 1 ? '' : 's'} finished`)
  if (progress.current) parts.push(`${progress.current.word} for ${spanWord(progress.current.forMs)}`)
  if (progress.remainingMs !== null) parts.push(`about ${spanWord(progress.remainingMs)} left at this pace`)

  if (over) {
    const last = Math.max(...tasks.map((t) => t.mtime))
    return (
      <Block title="Executed" note={[...parts, relTime(last, now)].join(' · ')} defaultOpen={false}>
        <div data-testid="execution-over" className="max-h-64 space-y-0.5 overflow-y-auto">
          {forTask}
          {tasks.map(row)}
        </div>
      </Block>
    )
  }

  return (
    <Block title="Executing" count={liveSteps > 0 ? liveSteps : undefined}>
      <div data-testid="execution" className="space-y-0.5 px-3 pb-2.5">
        {forTask}
        {parts.length > 0 ? (
          <div data-testid="execution-progress" className="mb-1.5 px-1">
            {pct !== null ? (
              <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-panel" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-terracotta transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            ) : null}
            <p className="font-mono text-[11px] text-ink-2">{parts.join(' · ')}</p>
          </div>
        ) : null}
        {open.map(row)}
        {earlier.length > 0 ? (
          <details className="group/earlier">
            <summary className="cursor-pointer list-none rounded px-1 py-0.5 text-[10px] uppercase tracking-wide text-ink-3 hover:bg-panel [&::-webkit-details-marker]:hidden">
              Earlier · {earlier.length}
            </summary>
            <div className="max-h-64 space-y-0.5 overflow-y-auto">{earlier.map(row)}</div>
          </details>
        ) : null}
      </div>
    </Block>
  )
}

// Nested runs (births, plugin 0.7.0): the `claude -p` sessions this
// conversation's claude launched from Bash. The server names each run's
// EFFECTIVE parent (the thread's session that was current when it was
// born — a console keeps its launch key across /clear), so this walk
// follows only continuation rotations (the same sidebar row) and stops at
// a /clear link: the conversation on the other side has its own runs. They are never sidebar rows; this is where they live. Same dot
// as everywhere (blinking while it works, nothing when idle); a row opens
// the run's transcript (a nested run never opens a console).
export function nestedRunsOf(meta: Pick<SessionView, 'id' | 'parentKey' | 'parentKind'>, all: readonly SessionView[]): SessionView[] {
  const byKey = new Map(all.map((s) => [`${s.folder}/${s.id}`, s]))
  const thread = new Set<string>([meta.id])
  let cur: Pick<SessionView, 'parentKey' | 'parentKind'> | undefined = meta
  for (let i = 0; cur?.parentKey && cur.parentKind !== 'clear' && i < 64; i++) {
    const key: string = cur.parentKey
    thread.add(key.slice(key.lastIndexOf('/') + 1))
    cur = byKey.get(key)
  }
  return all.filter((s) => s.origin?.kind === 'nested' && s.origin.parent !== null && thread.has(s.origin.parent)).sort((a, b) => b.mtime - a.mtime)
}

function NestedRunsBlock({ runs, now, onOpen }: { runs: SessionView[]; now: number; onOpen: (s: SessionView) => void }) {
  return (
    <Block title="Nested runs" count={runs.length}>
      <div data-testid="nested-runs" className="-mx-1 max-h-64 space-y-0.5 overflow-y-auto">
        {runs.map((s) => (
          <button
            key={`${s.folder}/${s.id}`}
            type="button"
            onClick={() => onOpen(s)}
            title={s.title}
            className="group/sub flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-panel"
          >
            <span className="flex w-1.5 shrink-0 justify-center">
              <SessionDot signal={sessionSignal(s, now, false) === 'working' ? 'working' : undefined} />
            </span>
            <span className="min-w-0 flex-1 truncate text-ink">
              <span className="text-ink-2">nested run · </span>
              {s.title}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-ink-3">{relTime(s.mtime, now)}</span>
            <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-ink-3 group-hover/sub:text-terracotta" />
          </button>
        ))}
      </div>
    </Block>
  )
}

// Claude Code's own checklist (TaskCreate/TaskUpdate, Ctrl+T — context.plan)
// — titled "Checklist", its native name: «Tasks»
// are Silos' (plan tasks with an owner, ☑) and «Plan» is the file-based block
// below (TeamPlanBlock, plans/*.plan.json) — three things, three words.
// Processes — what THIS conversation (its whole thread) left running on the
// machine: builds, test runs, dev servers (the System silo's `process`
// records; closed by default). Moment 1, «What's
// happening?», scoped to the conversation and reached without navigating.
// At rest one folded line — «Processes · 3» with the ports quietly —, closed
// on every conversation (keyed by it), absent when there are none. Open: one
// row per process, its command cut in the middle (the tail is the telling
// part), its numbers at most one scan old, and Stop (the kernel-verb
// stop-process, a confirm) on the ones Silos may stop; the server's words
// stay on the row until a read a few seconds later drops it. Fresh: one read
// on opening the conversation, then on the silos signal (siloTick — the same
// one the System page follows, moved by each scan that changes something):
// no poll of its own.
const STOPPED_LINGER_MS = 5000
function ProcessesBlock({ folder, id, awaited = false }: { folder: string; id: string; awaited?: boolean }) {
  const siloTick = useStore((s) => s.siloTick)
  const nowTick = useStore((s) => s.nowTick)
  const changePage = useStore((s) => s.changePage)
  const [rows, setRows] = useState<ConversationProcess[]>([])
  // what each Stop answered, kept on its row: the words, when, and the row
  // as it was (so it keeps its place when the next read no longer lists it)
  const [said, setSaid] = useState<Record<string, { words: string; at: number; failed: boolean; row: ConversationProcess }>>({})
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.processes(folder, id))
      .then((ps) => {
        if (cancelled) return
        setRows(Array.isArray(ps) ? ps : [])
        // a stop answered more than a moment ago leaves with this read
        setSaid((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => Date.now() - v.at < STOPPED_LINGER_MS)))
      })
      .catch(() => {
        /* unread: the last reading stands */
      })
    return () => {
      cancelled = true
    }
  }, [folder, id, siloTick])

  async function stop(p: ConversationProcess): Promise<void> {
    setBusy(p.id)
    try {
      const r = await api.silos.kernelVerb(SYSTEM_SILO, { key: p.key, name: STOP_PROCESS })
      setSaid((m) => ({ ...m, [p.id]: { words: r.says, at: Date.now(), failed: r.outcome === 'partial', row: p } }))
    } catch (e) {
      setSaid((m) => ({ ...m, [p.id]: { words: e instanceof Error ? e.message : String(e), at: Date.now(), failed: true, row: p } }))
    } finally {
      setBusy(null)
    }
  }

  // the rows read, plus a stopped one the read no longer lists while its words linger
  const listed = [
    ...rows,
    ...Object.values(said)
      .filter((v) => !rows.some((r) => r.id === v.row.id))
      .map((v) => v.row),
  ]
  if (listed.length === 0) return null
  const ports = [...new Set(rows.flatMap((p) => portsWords(p.ports).split(' ').filter(Boolean)))]
  const note = ports.length === 0 ? undefined : ports.length > 3 ? `${ports.slice(0, 3).join(' ')} …` : ports.join(' ')
  return (
    <Block title="Processes" count={rows.length > 0 ? rows.length : undefined} note={note} defaultOpen={awaited}>
      <ul className="-mx-1 space-y-0.5" data-testid="processes-block">
        {listed.map((p) => {
          const words = said[p.id]
          const { head, tail } = splitTail(p.command, 18, 28)
          const facts = processFacts(p)
          const started = Date.parse(p.startedAt)
          return (
            <li key={p.id} className="group/p rounded-md px-1 py-1 hover:bg-panel">
              <div className="flex items-baseline gap-2">
                <button
                  type="button"
                  onClick={() => changePage({ kind: 'silo', id: SYSTEM_SILO, recordKey: p.key })}
                  title={typeof p.processes === 'number' && p.processes > 1 ? `${p.command}\n${p.processes} processes` : p.command}
                  className={`flex min-w-0 flex-1 items-baseline text-left font-mono text-[11.5px] leading-snug ${words ? 'text-ink-3' : 'text-ink'} hover:text-terracotta`}
                >
                  <span className="min-w-0 truncate">{head}</span>
                  {tail ? <span className="shrink-0 whitespace-pre">{` ${tail}`}</span> : null}
                </button>
                {busy === p.id && !words ? (
                  // from the confirm until the answer: said at rest, never clickable
                  // (the answer's words then take the row until a read drops it)
                  <span role="status" data-testid="process-stopping" className="shrink-0 text-[11px] text-terracotta motion-safe:animate-pulse">
                    Stopping…
                  </span>
                ) : p.stoppable && !words ? (
                  <ConfirmButton
                    onConfirm={() => void stop(p)}
                    disabled={busy !== null}
                    ariaLabel={`Stop ${p.command}`}
                    confirmLabel="Stop it?"
                    className="shrink-0 text-[11px] text-ink-3 opacity-60 underline-offset-2 hover:text-terracotta hover:underline group-hover/p:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
                    armedClassName="shrink-0 text-[11px] font-medium text-terracotta"
                  >
                    Stop
                  </ConfirmButton>
                ) : null}
              </div>
              {words ? (
                <p role="status" className={`mt-0.5 text-[11px] leading-snug ${words.failed ? 'text-terracotta' : 'text-ink-2'}`}>
                  {words.words}
                </p>
              ) : (
                <p className="mt-0.5 truncate font-mono text-[10.5px] leading-snug text-ink-3">
                  {p.state === 'left' ? (
                    <span className="text-ink-2" title={p.why}>
                      {p.stateLabel}
                    </span>
                  ) : null}
                  {((rest) => (p.state === 'left' && rest ? ` · ${rest}` : rest))(
                    [...facts, ...(Number.isFinite(started) ? [relTime(started, nowTick)] : [])].join(' · '),
                  )}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          onClick={() => changePage({ kind: 'silo', id: SYSTEM_SILO })}
          className="font-mono text-[10.5px] text-ink-3 underline-offset-2 hover:text-terracotta hover:underline"
        >
          System ›
        </button>
      </div>
    </Block>
  )
}

// `censusIds`: the subagent transcripts the server can actually serve. A
// row hung under a checklist step opens its transcript only when its id is
// in there; otherwise it is text — the same rule as AgentsBlock.
function TasksBlock({
  context,
  censusIds,
  onOpenSubagent,
}: {
  context: SessionContext
  censusIds: ReadonlySet<string>
  onOpenSubagent: (s: SubagentRef) => void
}) {
  const plan = context.plan!
  const pct = plan.total > 0 ? Math.round((plan.done / plan.total) * 100) : 0
  return (
    <Block title="Checklist" count={plan.total} defaultOpen={false}>
      <div className="mb-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-terracotta" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 font-mono text-xs text-ink-2">
          {plan.done}/{plan.total}
        </span>
      </div>
      <ul className="space-y-1.5">
        {plan.tasks.map((t) => {
          const subs = context.agents.filter((a) => a.taskId === t.id)
          return (
            <li key={t.id}>
              <div className="flex items-start gap-1.5 text-sm">
                <span aria-hidden="true" className="shrink-0 text-ink-2">
                  {TASK_GLYPH[t.status]}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink">{t.subject}</span>
                {t.durationMs !== undefined ? <span className="shrink-0 font-mono text-[11px] text-ink-2">{formatElapsed(t.durationMs)}</span> : null}
              </div>
              {subs.map((s) => {
                const body = (
                  <>
                    <span aria-hidden="true">└</span>
                    <span className="min-w-0 flex-1 truncate">{s.description || s.type}</span>
                    {!s.endedAt ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <Pulse />
                        live
                      </span>
                    ) : null}
                  </>
                )
                // a door only when the server holds its transcript (the census)
                return censusIds.has(s.id) ? (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onOpenSubagent(s)}
                    className="mt-0.5 flex w-full items-center gap-1.5 pl-5 text-left text-xs text-ink-2 hover:text-terracotta"
                  >
                    {body}
                  </button>
                ) : (
                  <div key={s.id} className="mt-0.5 flex w-full items-center gap-1.5 pl-5 text-left text-xs text-ink-2">
                    {body}
                  </div>
                )
              })}
            </li>
          )
        })}
      </ul>
    </Block>
  )
}

// Artifacts — the pages this conversation PUBLISHED (Artifact tool:
// frame-link path+url, title from the tool_result). Deliverables, the
// same standing as the files handed over with SendUserFile (if there are
// artifacts, they show in the right column too). One row
// per URL, newest first; the title links out, the file name rides small.
// What this conversation SENT to others and may still be waiting on (proof
// of life: a delegation must show in the column, not only in
// the active turn). Two kinds, both real transcript signals: an outbound
// cross-session message nothing answered yet (an open wait — hourglass),
// and an agent message (kind 'message') POSTed to an agent's inbox, shown with its LIVE inbox state
// (the server joins it at read time; 'gone' = the inbox pruned it).
const AGENT_MESSAGE_STATE: Record<string, string> = {
  new: 'unread',
  read: 'read',
  answered: 'answered',
  needs_owner: 'waiting on you',
  gone: 'no longer stored',
}
function OutboundBlock({ outbound, ctxAgents }: { outbound: NonNullable<SessionContext['outbound']>; ctxAgents: SessionContext['agents'] }) {
  const agents = useStore((s) => s.agents)
  // an agent message names a Silos agent (its id); a session wait names a session or
  // a subagent (a hex id the context's own agents can word)
  const who = (o: NonNullable<SessionContext['outbound']>[number]): string =>
    o.kind === 'message' ? (agents.find((a) => a.id === o.to)?.name ?? o.to) : (ctxAgents.find((a) => a.id === o.to)?.description ?? o.to)
  // open waits first, then the agent messages; newest first within each
  const rows = [...outbound].sort((x, y) => (x.kind === y.kind ? Date.parse(y.since || '0') - Date.parse(x.since || '0') : x.kind === 'session' ? -1 : 1))
  return (
    <Block title="Sent" count={rows.length}>
      <ul className="space-y-1.5">
        {rows.map((o, i) => (
          <li key={`${o.kind}:${o.to}:${o.messageId ?? o.since}:${i}`} className="min-w-0">
            <div className="flex items-baseline gap-1.5 text-[13px] text-ink">
              {o.kind === 'session' ? <Hourglass size={11} aria-hidden="true" className="shrink-0 self-center text-ink-2" /> : null}
              <span className="min-w-0 truncate">
                {o.kind === 'session' ? (
                  <>
                    Waiting on <span className="font-medium">{who(o)}</span>
                  </>
                ) : (
                  <>
                    Message to <span className="font-medium">{who(o)}</span>
                  </>
                )}
              </span>
              {o.since ? <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-ink-3">{timeSince(o.since)}</span> : null}
            </div>
            {o.summary !== '' || o.state !== undefined ? (
              <div className="truncate pl-0.5 font-mono text-[10px] text-ink-3" title={o.summary || undefined}>
                {o.summary !== '' ? `“${o.summary}”` : ''}
                {o.state !== undefined ? `${o.summary !== '' ? ' · ' : ''}${AGENT_MESSAGE_STATE[o.state] ?? o.state}` : ''}
              </div>
            ) : null}
            {o.answer !== undefined && o.answer !== '' ? (
              <div className="truncate pl-0.5 text-[11px] text-ink-2" title={o.answer}>
                ↳ {o.answer}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Block>
  )
}

function PublishedBlock({ artifacts }: { artifacts: SessionContext['links']['artifacts'] }) {
  const byUrl = new Map<string, SessionContext['links']['artifacts'][number]>()
  for (const a of artifacts) byUrl.set(a.url, a) // last write wins = the latest republish
  const rows = [...byUrl.values()].sort((x, y) => Date.parse(y.ts || '0') - Date.parse(x.ts || '0'))
  if (rows.length === 0) return null
  return (
    <Block title="Artifacts" count={rows.length}>
      <ul className="space-y-1.5 text-sm">
        {rows.map((a) => (
          <li key={a.url} className="min-w-0">
            {/* an explicit noopener, the same criterion as ArtifactsBlock/⌘K
                — noreferrer alone already implies it in current browsers,
                but the belt-and-suspenders gets written out in full. */}
            <a href={a.url} target="_blank" rel="noopener noreferrer" title={a.url} className="block truncate text-[13px] text-terracotta hover:underline">
              {a.title ?? baseName(a.path)}
            </a>
            {a.title ? <div className="truncate font-mono text-[10px] text-ink-3">{baseName(a.path)}</div> : null}
          </li>
        ))}
      </ul>
    </Block>
  )
}

// a HEAVY block (Files/Tools/Events) — these used to dump the entire list
// and grow the column without end in large sessions. Now: a preview of the
// first `PREVIEW` with the TOTAL on the title's right ("Files 247");
// "Show all N" expands the list into a FIXED-HEIGHT area with internal
// scroll (the column never grows without limit). Local state, not
// persisted (transient like the subagent reader): resets on a session
// change, which is the desired behavior.
const PREVIEW = 5

function baseName(path: string): string {
  const p = path.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

// What THIS conversation used — the files it touched, the tools it called,
// the links it made, its events (the sections are for what was USED; what
// is available lives in Knows). One folded block whose note is the
// count line; open, each kind is a line that unfolds its own list (5, then
// «Show all»). Four blocks became one.
function UsedBlock({
  files,
  tools,
  links,
  events,
  cwd,
  onOpenFile,
}: {
  files: SessionContext['files']
  tools: SessionContext['tools']
  links: SessionContext['links']
  events: SessionContext['events']
  cwd: string | null
  onOpenFile: (path: string) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const linkN = links.prs.length + (links.worktree ? 1 : 0)
  const kinds: Array<{ id: string; n: number; one: string; many: string; body: ReactNode }> = [
    {
      id: 'files',
      n: files.length,
      one: 'file',
      many: 'files',
      body: <UsedList items={files} keyOf={(f) => f.path} render={(f) => <UsedFileRow file={f} cwd={cwd} onOpenFile={onOpenFile} />} />,
    },
    {
      id: 'tools',
      n: tools.length,
      one: 'tool',
      many: 'tools',
      body: (
        <UsedList
          items={tools}
          keyOf={(t) => `${t.server ?? ''}:${t.name}`}
          render={(t) => (
            <div className="flex items-center justify-between gap-2 px-1 text-xs text-ink-2">
              <span className="min-w-0 flex-1 truncate">{t.server ? `${t.server} · ${t.name}` : t.name}</span>
              <span className="shrink-0 font-mono text-ink-3">{t.count}×</span>
            </div>
          )}
        />
      ),
    },
    {
      id: 'links',
      n: linkN,
      one: 'link',
      many: 'links',
      body: (
        <ul className="space-y-1 px-1 text-xs">
          {links.prs.map((pr) => (
            <li key={pr.url} className="truncate">
              <a href={pr.url} target="_blank" rel="noreferrer" className="text-terracotta hover:underline">
                #{pr.number} {pr.repo}
              </a>
            </li>
          ))}
          {links.worktree ? <li className="truncate text-ink-2">worktree: {links.worktree.name}</li> : null}
        </ul>
      ),
    },
    {
      id: 'events',
      n: events.length,
      one: 'event',
      many: 'events',
      body: (
        <UsedList
          items={events}
          keyOf={(_e, i) => String(i)}
          render={(e) => (
            <div className="flex gap-2 px-1 text-xs">
              <span className="shrink-0 font-mono text-ink-3">{timeSince(e.ts)}</span>
              <span className="min-w-0 text-ink-2">{e.text}</span>
            </div>
          )}
        />
      ),
    },
  ].filter((k) => k.n > 0)
  if (kinds.length === 0) return null
  const word = (k: { n: number; one: string; many: string }): string => `${k.n} ${k.n === 1 ? k.one : k.many}`
  return (
    <Block title="Used here" note={kinds.map(word).join(' · ')} defaultOpen={false}>
      <ul className="space-y-px" data-testid="used-here">
        {kinds.map((k) => (
          <li key={k.id}>
            <button
              type="button"
              aria-expanded={open === k.id}
              onClick={() => setOpen(open === k.id ? null : k.id)}
              className={`${ROW_BUTTON} flex items-baseline gap-2`}
            >
              <span className={ROW_LABEL}>{k.many}</span>
              <span className="min-w-0 flex-1 text-xs text-ink">{k.n}</span>
              <ChevronRight
                size={12}
                aria-hidden="true"
                className={`shrink-0 self-center text-ink-3 transition-transform ${open === k.id ? 'rotate-90' : ''}`}
              />
            </button>
            {open === k.id ? <div className="pb-1.5 pt-0.5">{k.body}</div> : null}
          </li>
        ))}
      </ul>
    </Block>
  )
}

// one file the conversation used: its click goes through usedFileDoor —
// the one viewer for a file that is there (memory notes included), plain
// words for one that is gone or that Silos can't reach from here
function UsedFileRow({ file: f, cwd, onOpenFile }: { file: SessionContext['files'][number]; cwd: string | null; onOpenFile: (path: string) => void }) {
  const meta = useFileRef(resolvePath(f.path, cwd))
  const door = usedFileDoor(f.path, cwd, meta)
  const how = f.sent ? `${f.sent} sent` : f.edits + f.writes + f.reads === 0 && f.disk ? 'on disk' : f.edits + f.writes > 0 ? 'written' : 'read'
  if (door.kind !== 'open') {
    const why = door.kind === 'gone' ? 'no longer there — moved or deleted since' : 'can’t open here — outside this project'
    return (
      <div title={`${f.path} — ${why}`} data-door={door.kind} className="flex w-full items-center justify-between gap-2 px-1 py-0.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-ink-3 line-through decoration-ink-3/50">{baseName(f.path)}</span>
        <span className="shrink-0 font-mono text-ink-3">{door.kind === 'gone' ? 'gone' : 'not here'}</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onOpenFile(door.path)}
      title={door.path}
      className="group/f flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-panel"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-ink-2 group-hover/f:text-terracotta">{baseName(f.path)}</span>
      <span className="shrink-0 font-mono text-ink-3">{how}</span>
    </button>
  )
}

function UsedList<T>({ items, keyOf, render }: { items: T[]; keyOf: (item: T, i: number) => string; render: (item: T) => ReactNode }) {
  const [all, setAll] = useState(false)
  const visible = all ? items : items.slice(0, PREVIEW)
  return (
    <>
      <ul className={`space-y-0.5 ${all ? 'max-h-60 overflow-y-auto pr-1' : ''}`}>
        {visible.map((item, i) => (
          <li key={keyOf(item, i)}>{render(item)}</li>
        ))}
      </ul>
      {items.length > PREVIEW ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="mt-1 px-1 text-[11px] font-medium text-ink-2 hover:text-terracotta"
        >
          {all ? 'Show less' : `Show all ${items.length}`}
        </button>
      ) : null}
    </>
  )
}

// clicking a subagent: its transcript in a screen MODAL, not in the 300px
// column. The same pattern as FileViewer: a portal to document.body, a
// scrim covering everything, Esc/click-outside close it (Esc with
// preventDefault so it doesn't cancel the turn). A subagent IS a separate
// mini-conversation: here it's read with room to breathe.
function SubagentModal({ folder, id, subagent, onClose }: { folder: string; id: string; subagent: SubagentRef; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setTurns(null)
    setError(null)
    api
      .subagentTranscript(folder, id, subagent.id)
      .then((r) => {
        if (!cancelled) setTurns(r.turns)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [folder, id, subagent.id])

  // Esc closes it (contract: preventDefault so it doesn't cancel the turn
  // in progress) + locks the body's scroll behind the scrim, like FileViewer.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/60 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Subagent · ${subagent.description || subagent.type}`}
        tabIndex={-1}
        className="modal-pop flex max-h-[85vh] w-[min(900px,92vw)] flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="shrink-0 rounded-full border border-line px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-ink-2">subagent</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{subagent.description || subagent.type}</span>
          <span className="shrink-0 font-mono text-[10px] text-ink-2">{subagent.type}</span>
          <button
            type="button"
            aria-label="Close subagent transcript"
            title="Close"
            onClick={onClose}
            className="shrink-0 rounded-full p-1 text-ink-2 hover:bg-panel hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {error ? <p className="text-xs text-ink-2">{error}</p> : null}
          {!error && turns === null ? <p className="text-xs text-ink-2">Loading…</p> : null}
          {turns ? (
            // subagent transcripts are where MOST of the real corpus'
            // images live — its own scope at /subagents/<id>/media/<ref>.
            <MediaScope base={`/api/sessions/${folder}/${id}/subagents/${subagent.id}`}>
              <div className="flex flex-col gap-3">
                {turns.map((t) => (
                  <TurnRow key={t.index} turn={t} isNew={false} />
                ))}
              </div>
            </MediaScope>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// the "Terminal · running" chip — visible if there's a live terminal open
// FOR THIS agent (by the agentId it was created with, not the one
// currently selected): a terminal is global (it survives navigating to
// another agent), but the chip should only light up on the page of the
// agent it belongs to.
function ChipTerminal() {
  const terminals = useStore((s) => s.terminals)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const toggleTerminalPanel = useStore((s) => s.toggleTerminalPanel)
  const terminalOpen = useStore((s) => s.terminalOpen)
  const hasTerminal = terminals.some((t) => t.agentId === selectedAgentId)
  if (!hasTerminal) return null
  return (
    <button
      type="button"
      onClick={() => {
        if (!terminalOpen) toggleTerminalPanel()
      }}
      className="mx-3 mt-3 flex w-fit items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-1 text-xs text-ink-2 hover:border-terracotta hover:text-terracotta"
    >
      <Pulse />
      Terminal · running
    </button>
  )
}

// Local HH:MM, always 24h regardless of the runtime locale — same format
// InChargeOf's heartbeat chip uses, so "next beat" reads identically
// wherever it appears.
function hhmmLocal(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

// How the agent runs, under the live status: the real model and account
// (lib/runs-on.ts — the conversation's own model first), «· pinned here»
// when this conversation pins any of it (the line never leaves you
// guessing whether a value is its own or its agent's), and the ONE gear that
// opens the agent's Settings, where its defaults are. Identity (name, role,
// project) is NOT here: it lives in the sentence under the conversation's
// title — each fact has one home.
// the model, then the account as one unit: when the line is too long the
// account moves to the next line whole ("· sam" never strands alone).
function RunsOnText({ text }: { text: string }) {
  const cut = text.indexOf(' · ')
  if (cut < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, cut)} · <span className="inline-block max-w-full">{text.slice(cut + 3)}</span>
    </>
  )
}

/** What this conversation runs on, in one line, and whether that is its OWN
 *  pin (provider, model or style) rather than its agent's — the runs-on line
 *  here and the conversation header's «· on X here» read this one truth. */
export function useRunsOn(agent: AgentView): {
  runsOn: string
  pinnedHere: boolean
  pinnedMark: boolean
  live: string | null
  pinned: string | null
  pinnedModel: string | null
} {
  const providers = useStore((s) => s.providers)
  const catalog = useStore((s) => s.catalog)
  const observedModel = useStore((s) => s.detail?.context?.flags.model ?? null)
  // the conversation's own account (its `provider` pref; a new chat's
  // pending one) — the same pin the chips edit, so both read one truth.
  const selected = useStore((s) => s.selected)
  const pinned = useStore((s) => (selected ? s.convPrefs.provider : s.pendingConvPrefs.provider) ?? null)
  const pinnedModel = useStore((s) => (selected ? s.convPrefs.model : s.pendingConvPrefs.model) ?? null)
  // a new conversation has no meta yet: the agent's own harness
  const harness = useStore((s) => s.detail?.meta.harness) ?? agent.framework
  const requestedModel = useStore((s) => s.detail?.meta.requestedModel ?? null)
  // runsOnLine reads the engine's descriptor: subscribe, so the line follows
  // the list GET /api/harnesses loads (an engine missing from the seed)
  const engine = useHarness(harness)
  // the voice, in a word, when it is not the plain one: the pin › the
  // agent's default (the operator's own setting is never claimed here)
  const pinnedStyle = useStore((s) => (selected ? s.convPrefs.outputStyle : s.pendingConvPrefs.outputStyle))
  const style = engine.caps.outputStyles ? (pinnedStyle ?? agent.outputStyle) : undefined
  // the account named is the one THIS console really runs on (its live
  // process) — the choice, when different, is said underneath (RunningLine)
  const running = useStore((s) => s.detail?.running)
  const live = runningNote(running, providers, pinned ?? agent.provider ?? null)?.runsOnId ?? null
  const runsOnBase = runsOnLine({ agent, providers, catalog, observedModel, pinnedProvider: live ?? pinned, pinnedModel, requestedModel, harness })
  const withStyle = style && style !== 'default' ? `${runsOnBase} · ${style}` : runsOnBase
  // its own pin of provider, model or style — the rest is its agent's.
  // (A console whose pin waits in its model picker already says «pinned: X».)
  const pinnedHere = pinned !== null || pinnedModel !== null || (engine.caps.outputStyles && pinnedStyle != null)
  const runsOn = withStyle
  const pinnedMark = pinnedHere && !withStyle.includes('· pinned: ')
  return { runsOn, pinnedHere, pinnedMark, live, pinned, pinnedModel }
}

function RunsOnLine({ agent }: { agent: AgentView }) {
  const providers = useStore((s) => s.providers)
  const { runsOn, pinnedMark, pinned, pinnedModel } = useRunsOn(agent)
  const diverted = agent.onFallback !== undefined && runsOn.endsWith('(fallback)')
  // the conversation cannot run (the provider's own words: a refused turn,
  // a key that is missing) → the line IS the alert, and a click opens the
  // "Run on…" panel to fix it right here (ProviderPanel)
  const turns = useStore((s) => s.detail?.turns)
  const openProviderPanel = useStore((s) => s.openProviderPanel)
  const blockedRaw = cannotRun(turns ? { turns } : null, providers, pinned ?? agent.provider, pinnedModel ?? agent.model ?? null)
  const blocked = blockedRaw === null ? null : humanizeProviderIds(blockedRaw, providers)
  return (
    <div className="flex items-center gap-1.5 pl-6">
      {blocked !== null ? (
        <button
          type="button"
          onClick={() => openProviderPanel(blocked)}
          data-panel-owned="run-on"
          title={`${blocked} — pick another login or paste a key`}
          className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md text-left font-mono text-[11px] leading-snug text-terracotta hover:underline"
        >
          <TriangleAlert size={12} aria-hidden="true" className="mt-px shrink-0" />
          <span className="min-w-0 flex-1 break-words">Can&rsquo;t run · {blocked}</span>
          <span className="shrink-0 font-medium">Fix ›</span>
        </button>
      ) : (
        // the line IS the control: a click opens "Run on…" — account and
        // model for this conversation, in chat and in console mode alike
        <button
          type="button"
          onClick={() => openProviderPanel(null)}
          data-panel-owned="run-on"
          aria-label="Change what it runs on"
          title={
            runsOn.includes('· pinned: ')
              ? 'The console runs the first model; your pick lands when you choose it in the console’s model picker'
              : 'Change the account or model this conversation runs on'
          }
          className={`group flex min-w-0 flex-1 items-start gap-1 rounded-md text-left font-mono text-[11px] leading-snug hover:text-ink ${diverted ? 'text-amber-700 dark:text-amber-400' : 'text-ink-2'}`}
        >
          <span className="min-w-0 flex-1 break-words">
            <RunsOnText text={`${runsOn}${diverted && agent.onFallback ? ` · until ${hhmmLocal(agent.onFallback.until)}` : ''}`} />
            {pinnedMark ? (
              <span data-testid="runs-on-pinned" className="whitespace-nowrap text-ink-3">
                {' '}
                · pinned here
              </span>
            ) : null}
          </span>
          <ChevronRight size={11} aria-hidden="true" className="mt-px shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}
    </div>
  )
}

// The install's unattended switch: when this
// conversation's last unattended turn ran on the provider Settings chose for
// turns with nobody in front, the column says so under the runs-on line —
// the line above is what the owner's own turns use, this is what the last
// heartbeat, wake or run spent.
function UnattendedOnLine() {
  const on = useStore((s) => s.detail?.unattendedOn ?? null)
  const providers = useStore((s) => s.providers)
  if (!on) return null
  return (
    <p className="pl-6 font-mono text-[11px] leading-snug text-ink-3" data-testid="unattended-on">
      on {providerLabel(providers, on)} · unattended setting
    </p>
  )
}

// The account line above names the account the console REALLY runs on
// (detail.running); nothing else is said about accounts here: with N
// accounts, only the active one matters now; changing it is the settings
// button's job (the runs-on ⚙).

// The subscription's windows, under the line that names the account: one
// row per window the account has (5h, week, a model's own week), each a
// bar with a hairline at how much of the window has gone by — a fill past
// the hairline spends faster than the window refills. Only for a Claude
// account (a key has no such windows); polled while the tab is visible.
// The server reads the account's token and never refreshes it, so an
// expired token keeps the last reading, dimmed with its time.
const PLAN_USAGE_POLL_MS = 60_000
const USAGE_FILL: Record<ReturnType<typeof usageTone>, string> = {
  calm: 'bg-ink-2',
  warn: 'bg-amber-600 dark:bg-amber-400',
  out: 'bg-terracotta',
}
const USAGE_TEXT: Record<ReturnType<typeof usageTone>, string> = {
  calm: 'text-ink-2',
  warn: 'text-amber-700 dark:text-amber-400',
  out: 'text-terracotta',
}

function PlanUsageBars({ agent }: { agent: AgentView }) {
  const providers = useStore((s) => s.providers)
  const selected = useStore((s) => s.selected)
  const pinned = useStore((s) => (selected ? s.convPrefs.provider : s.pendingConvPrefs.provider) ?? null)
  // the windows of the account the live process really spends (one holder
  // on a known account), else the account it is set to
  const running = useStore((s) => s.detail?.running)
  const live = running && running.length === 1 && running[0]!.providerId !== null ? running[0]!.providerId : null
  const providerId = canonicalProviderId(live ?? pinned ?? agent.provider)
  const isAccount = providers.some((p) => p.id === providerId && p.kind === 'claude-account')
  const [usage, setUsage] = useState<{ id: string; u: PlanUsage } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isAccount) return
    let alive = true
    const read = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      Promise.resolve(api.planUsage(providerId))
        .then((u) => {
          if (alive) {
            setUsage(u ? { id: providerId, u } : null)
            setNow(Date.now())
          }
        })
        .catch(() => {
          /* keep the last bars: a failed poll is not news */
        })
    }
    read()
    const t = setInterval(read, PLAN_USAGE_POLL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') read()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [providerId, isAccount])
  if (!isAccount || !usage || usage.id !== providerId || !usage.u.ok || usage.u.windows.length === 0) return null
  const { windows, stale, at } = usage.u
  return (
    <div
      className={`grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 gap-y-1 pl-6 font-mono text-[10.5px] leading-none ${stale ? 'opacity-60' : ''}`}
      data-testid="plan-usage"
      title={stale ? `As of ${hhmmLocal(new Date(at).toISOString())} — refreshes when a claude on this account runs` : undefined}
    >
      {windows.map((w) => {
        const tone = usageTone(w)
        const pace = paceFraction(w, now)
        const reset = usageResetLabel(w, now)
        const sentence = usageSentence(w, now)
        return (
          <div key={w.kind + w.label} title={stale ? undefined : sentence} className="contents">
            <span className={w.active || tone === 'out' ? USAGE_TEXT[tone] : 'text-ink-3'}>{w.label}</span>
            <span role="img" aria-label={sentence} className="relative h-[3px] rounded-full bg-line">
              <span className={`absolute inset-y-0 left-0 rounded-full ${USAGE_FILL[tone]}`} style={{ width: `${Math.min(100, Math.max(0, w.percent))}%` }} />
              {pace !== null && pace > 0 && pace < 1 ? (
                <span aria-hidden="true" className="absolute -top-[3px] h-[9px] w-px bg-ink" style={{ left: `${pace * 100}%` }} />
              ) : null}
            </span>
            <span className={`text-right tabular-nums ${USAGE_TEXT[tone]}`}>{Math.round(w.percent)}%</span>
            <span className="text-right text-ink-3">{reset ?? ''}</span>
          </div>
        )
      })}
    </div>
  )
}

// File history (rewind checkpoints) was a one-line block here —
// retired as premature: counts nobody could act
// on. The server keeps observing (context.fileHistory still travels); the
// surface returns the day it shows a per-file diff.

// Documents pasted into the conversation (they belong to
// the CONTEXT surface, never a viewer inside the transcript). The real
// transcript shape carries no filename — each row is type · size · when,
// and IS a link to the raw endpoint, so the browser renders the bytes
// (PDFs natively) in a new tab. Order of appearance = the address.
function DocumentsBlock({ documents, folder, id }: { documents: NonNullable<SessionContext['documents']>; folder: string; id: string }) {
  return (
    <section className="border-t border-line px-3 py-3">
      <h3 className="font-mono text-[10px] uppercase tracking-wider text-ink-3">Documents</h3>
      <ul className="mt-1.5 space-y-0.5">
        {documents.map((d, i) => (
          <li key={i}>
            <a
              href={`/api/sessions/${folder}/${id}/documents/${i}?token=${encodeURIComponent(getToken())}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] text-ink-2 hover:bg-canvas hover:text-ink"
            >
              <span className="min-w-0 flex-1 truncate">
                {docLabel(d.mediaType)} · {fmtBytes(d.bytes)}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-3">{hhmmLocal(d.ts)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function docLabel(mediaType: string): string {
  const sub = mediaType.split('/')[1] ?? mediaType
  return sub.toUpperCase()
}

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

// The conversation's cost — computed by the server from each assistant
// message's real usage × API list prices (recomputed
// server-side since the CLI stopped writing its cost-state
// aggregate mid-session). One quiet line under runs-on, in the column's
// mono voice. The ~ and "API price" carry the honesty: USD at list prices,
// notional under a subscription, real money only on an API key/provider.
// Per-model breakdown lives in the tooltip; a model without a price row is
// NAMED («no price for claude-fable-5-2», one wording with Usage) and its
// dollars are never shown as $0. No usage = no line (never an invented $0). A
// plan-priced conversation (OpenCode on a coding plan: every message
// reported $0 — a subscription paid, it was not free) says the tokens and
// "plan-priced" where the dollars would be, same size, same ink.
function CostLine() {
  const cost = useStore((s) => s.detail?.context?.cost ?? null)
  if (!cost) return null
  const tokensIn = (m: (typeof cost.byModel)[number]) => m.inputTokens + m.cacheCreationTokens + m.cacheReadTokens
  const noPrice = !cost.planPriced && cost.unknownModels ? (cost.unpricedModels ?? []) : []
  const isUnpriced = (model: string) => noPrice.includes(model)
  const tip = cost.byModel
    .map(
      (m) =>
        `${isUnpriced(m.model) ? noPriceWords([m.model]) : `${m.model}${cost.planPriced ? '' : ` $${m.usd.toFixed(2)}`}`} — ${fmtTokens(tokensIn(m))} in · ${fmtTokens(m.outputTokens)} out`,
    )
    .join('\n')
  const sumIn = cost.byModel.reduce((n, m) => n + tokensIn(m), 0)
  const sumOut = cost.byModel.reduce((n, m) => n + m.outputTokens, 0)
  // every model unpriced: the line is the missing price, no «$0.00» before it
  const somePriced = cost.byModel.some((m) => !isUnpriced(m.model))
  return (
    <div className="flex items-center gap-1.5 pl-6" title={tip || undefined}>
      <span className="min-w-0 flex-1 font-mono text-[11px] leading-snug text-ink-3">
        {cost.planPriced
          ? sumIn + sumOut > 0
            ? `${fmtTokens(sumIn)} in · ${fmtTokens(sumOut)} out · plan-priced`
            : 'plan-priced'
          : cost.unknownModels
            ? somePriced
              ? `~$${cost.totalUsd.toFixed(2)} · API price · ${noPriceWords(noPrice)}`
              : noPriceWords(noPrice)
            : `~$${cost.totalUsd.toFixed(2)} · API price`}
      </span>
    </div>
  )
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

// Knows — what this agent's conversations start with and what is its own
// (scope): one bar for the sum every conversation loads, split
// by who owns each piece (you · Silos · the project · the agent); then
// Memory (the notes ITS conversations learned, and how many here), Files
// (what it wrote for you, its working files) and Tools. Every row opens the
// agent page's tab over the conversation. Its unread messages are polled,
// so the Messages row never goes stale while the conversation stays open.

const ROW_LABEL = 'w-[4.5rem] shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-ink-3'
const ROW_BUTTON = 'group/k -mx-1 w-[calc(100%+0.5rem)] rounded-md px-1 py-1 text-left hover:bg-panel'

// What THIS conversation taught its agent: the notes whose origin is it
// («Learned here» belongs to the
// conversation's zone, the agent's zone counts what it reads). Live on the
// memory counter; nothing learned → no row.
function KnowsRow({ kind, summary, empty, onOpen }: { kind: string; summary: string | null; empty: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} aria-label={`Open ${kind.toLowerCase()}`} className={`${ROW_BUTTON} flex items-baseline gap-2`}>
        <span className={ROW_LABEL}>{kind}</span>
        <span className={`min-w-0 flex-1 text-xs leading-snug ${summary ? 'text-ink' : 'text-ink-2 italic'}`}>{summary ?? empty}</span>
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 self-center text-ink-3 group-hover/k:text-terracotta" />
      </button>
    </li>
  )
}

// `here` (the conversation column only): Knows is about THIS conversation
// (spec scope-ui-review §4.1, owner 24-11 «en la columna no hace falta
// filtros ni acciones»): one summary line per kind, the whole line a door to
// its agent's tab, carrying the conversation (the page's «‹ title», where
// its own line switches). Nothing unfolds, nothing switches, no dial.
// `cwd`: the project it runs in — what its Tools and Skills are read for.
export interface KnowsHere {
  id: string
  files: SessionContext['files']
  tools: SessionContext['tools']
  folder?: string
  cwd?: string | null
  automation?: boolean
}
// «2 notes · 1 learned here» — a zero part is not said
function hereWords(parts: ReadonlyArray<readonly [number, string]>): string | null {
  const said = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`)
  return said.length > 0 ? said.join(' · ') : null
}

export function KnowsBlock({ agent, here }: { agent: AgentView; here?: KnowsHere }) {
  const mine = here !== undefined
  // what the owner gave this conversation alone (its thread's folder)
  const contextVersion = useStore((s) => s.knowsVersion.context)
  const [given, setGiven] = useState(0)
  const hereId = here?.id
  useEffect(() => {
    if (hereId === undefined || !agent.folder) {
      setGiven(0)
      return
    }
    let cancelled = false
    Promise.resolve()
      .then(() => api.context.list(agent.id, hereId))
      .then((v) => {
        if (!cancelled) setGiven(v?.conversation?.length ?? 0)
      })
      .catch(() => {
        if (!cancelled) setGiven(0)
      })
    return () => {
      cancelled = true
    }
  }, [agent.id, agent.folder, hereId, contextVersion])
  const openKnows = useStore((s) => s.openKnows)
  const agentId = agent.id
  const folder = agent.folder

  // live (store.knowsVersion): a `knows` event bumps its kind's counter;
  // the sources re-read and keep the old numbers until the new ones land
  const knowsVersion = useStore((s) => s.knowsVersion)
  const knowsToast = useStore((s) => s.knowsToast)
  const dismissKnowsToast = useStore((s) => s.dismissKnowsToast)
  useEffect(() => {
    // a toast from the previous agent would open ITS item on this one
    return () => {
      useStore.getState().dismissKnowsToast()
    }
  }, [agentId, folder])
  const src = useKnowsSources(agent, knowsVersion.memory + knowsVersion.skills + knowsVersion.context)
  const openDossier = useStore((s) => s.openDossier)
  // what loads in THIS conversation, and what differs here (its own entries)
  const knowsHere = useKnowsHere(agent.id, here?.cwd ?? null, here?.id ?? '', knowsVersion.memory + knowsVersion.skills)
  // the secrets that reach it as env (the column shows the agent's secrets
  // too): a count, and how many it stored
  // itself in its own scope — the names live in the agent page's Vault tab
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setVaultEntries(null)
    Promise.resolve(api.vault.list())
      .then((v) => {
        if (!cancelled) setVaultEntries(v ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agentId])
  const secrets = vaultEntries ? effectiveVaultFor(vaultEntries, agent.id, agent.folder) : []
  const ownSecrets = secrets.filter((v) => v.entry.createdBy === agent.id).length
  const signedSecrets = secrets.filter((v) => v.entry.binding !== undefined).length
  // what every conversation starts with, by WHO owns each piece: the
  // column says the sum and the agent's own share
  const learned = memoryNotes(src.memory).filter((n) => n.author === agent.id).length
  const writtenFor = src.context?.agent.length ?? 0
  const working = src.produced?.length ?? 0
  // a folder-less agent has nowhere to keep context files: its row says so
  // (useKnowsSources answers an empty context for it), unless it produced some
  // learned in THIS conversation: the notes whose own origin is it

  // its mission's first line — the door opens it whole,
  // with its editor, without leaving the conversation
  const mission = missionLine(agent)
  const rules = agent.mission?.never.length ?? 0
  // this conversation's lines: counts and what differs here — never where
  // a thing comes from (the page's list says it, one click away)
  const notes = memoryNotes(src.memory)
  const learnedHere = here ? notes.filter((n) => n.origin === here.id).length : 0
  const topLevel = (fs: readonly { rel: string }[] | undefined): number => (fs ?? []).filter((f) => !f.rel.includes('/')).length
  const writtenHere = here ? here.files.filter((f) => f.writes + f.edits > 0).length : 0
  const activeSkills = (src.catalog ?? []).filter((x) => (x.state ?? 'active') === 'active').length
  const sk = knowsHere.skills
  const tl = knowsHere.tools
  const agentTools = agentToolsFigure(src)
  const ownToolsOn = (src.ownTools ?? []).filter((t) => t.state === 'active').length
  const hereRows: Array<{ kind: string; summary: string | null; empty: string; open: () => void }> = mine
    ? [
        {
          kind: 'Memory',
          summary:
            [
              notes.length > 0
                ? hereWords([
                    [notes.length, notes.length === 1 ? 'note' : 'notes'],
                    [learnedHere, 'learned here'],
                  ])
                : null,
              knowsHere.personalOff ? 'your instructions off here' : null,
              knowsHere.instructions && knowsHere.instructions.off > 0
                ? `${knowsHere.instructions.off} ${knowsHere.instructions.off === 1 ? 'file' : 'files'} off here${knowsHere.instructions.didntTake > 0 ? ` · ${knowsHere.instructions.didntTake} didn’t take` : ''}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
          empty: 'no notes yet',
          open: () => openDossier('memory'),
        },
        // always there for an agent with a folder: Files is where a file is GIVEN to
        // this conversation (its Upload offers «This conversation»)
        {
          kind: 'Files',
          summary:
            hereWords([
              [given, 'given here'],
              [writtenHere, 'written here'],
              [topLevel(src.context?.agent) + topLevel(src.context?.shared), 'told at start'],
            ]) ?? (agent.folder ? 'none yet — give it one' : null),
          empty: '',
          open: () => openDossier('context'),
        },
        {
          kind: 'Skills',
          summary: sk
            ? hereWords([
                [sk.load, 'load'],
                [sk.nameOnly, 'name only here'],
                [sk.off, 'off here'],
                [sk.onOnly, 'on only here'],
              ])
            : hereWords([[activeSkills, 'load']]),
          empty: 'none',
          open: () => openDossier('skills'),
        },
        {
          kind: 'Tools',
          summary: tl
            ? hereWords([
                [tl.load + ownToolsOn, 'load'],
                [tl.off, 'off here'],
                [tl.onOnly, 'on only here'],
              ])
            : hereWords([[agentTools ?? 0, 'load']]),
          empty: 'none',
          open: () => openDossier('tools'),
        },
        {
          kind: 'Secrets',
          summary: hereWords([
            [secrets.length - signedSecrets, 'in its environment'],
            [signedSecrets, 'signed by Silos'],
          ]),
          empty: '',
          open: () => openDossier('vault'),
        },
      ]
    : []
  return (
    <Block title="Knows">
      {mine ? (
        <ul className="space-y-px" data-testid="knows-here">
          {/* one line per kind, each a door to its agent's tab (no switch here) */}
          {hereRows
            .filter((r) => r.summary !== null || r.empty !== '')
            .map((r) => (
              <KnowsRow key={r.kind} kind={r.kind} summary={r.summary} empty={r.empty} onOpen={r.open} />
            ))}
          {/* its mission is inherited whole: said here too, as on «this agent» */}
          {mission ? (
            <KnowsRow
              kind="Mission"
              summary={`${agent.name}’s — ${rules > 0 ? `${mission} · ${rules} never ${rules === 1 ? 'rule' : 'rules'}` : mission}`}
              empty=""
              onOpen={() => openKnows('mission')}
            />
          ) : null}
        </ul>
      ) : null}
      {/* its agent's reach, in counts that open its tabs; what THIS
          conversation started with is measured above (StartedWithBlock).
          A kind with nothing renders nothing (no placeholders) */}
      {mine ? null : (
        <ul className="space-y-px">
          {src.memory && memoryNotes(src.memory).length > 0 ? (
            <KnowsRow
              kind="Memory"
              summary={`${memoryNotes(src.memory).length} notes it reads · ${learned} learned by ${agent.name}`}
              empty=""
              onOpen={() => openDossier('memory')}
            />
          ) : null}
          {writtenFor + working + (src.context?.shared.length ?? 0) > 0 ? (
            <KnowsRow
              kind="Files"
              summary={`${writtenFor} of its own · ${working} working · ${src.context?.shared.length ?? 0} shared`}
              empty=""
              onOpen={() => openDossier('context')}
            />
          ) : null}
          {src.catalog && src.catalog.some((x) => (x.state ?? 'active') === 'active') ? (
            <KnowsRow
              kind="Skills"
              summary={`${src.catalog.filter((x) => (x.state ?? 'active') === 'active').length} it can use`}
              empty=""
              onOpen={() => openDossier('skills')}
            />
          ) : null}
          {/* the agent's servers that do not depend on the login (project ·
            your machine); a conversation's claude.ai connectors are said in
            ITS zone, from its own transcript (never mix accounts) */}
          {src.loaded && src.loaded.mcp.some((m) => m.source !== 'account') ? (
            <KnowsRow
              kind="Tools"
              summary={`${src.loaded.mcp.filter((m) => m.source !== 'account').length} MCP servers · ${src.loaded.mcp.some((m) => m.source === 'agent') ? `${agent.name}, ` : ''}project and your machine`}
              empty=""
              onOpen={() => openDossier('tools')}
            />
          ) : null}
          {/* two classes: in its environment, or signed
            by Silos — never in its hands */}
          {secrets.length > 0 ? (
            <KnowsRow
              kind="Secrets"
              summary={[
                secrets.length - signedSecrets > 0 ? `${secrets.length - signedSecrets} in its environment` : null,
                signedSecrets > 0 ? `${signedSecrets} signed by Silos` : null,
                ownSecrets > 0 ? `${ownSecrets} stored by ${agent.name}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              empty=""
              onOpen={() => openDossier('vault')}
            />
          ) : null}
          {mission ? (
            <KnowsRow
              kind="Mission"
              summary={rules > 0 ? `${mission} · ${rules} never ${rules === 1 ? 'rule' : 'rules'}` : mission}
              empty=""
              onOpen={() => openKnows('mission')}
            />
          ) : null}
        </ul>
      )}
      {/* the live toast (store.knowsToast): one at a time, the latest write;
          it dismisses itself after 6 s, a click opens the drawer on the item */}
      {knowsToast ? (
        <button
          type="button"
          key={knowsToast.ts}
          onClick={() => {
            dismissKnowsToast()
            openKnows(knowsToast.kind, { openItem: knowsToast.name, openScope: knowsToast.scope })
          }}
          className="modal-pop mt-2 block w-full truncate rounded-md border border-line bg-panel px-2 py-1 text-left text-[11px] text-ink hover:border-terracotta hover:text-terracotta"
        >
          {knowsToast.action === 'removed' ? '−' : '+'} {knowsToast.kind} · {knowsToast.name}
        </button>
      ) : null}
    </Block>
  )
}

// a zone of the column: what follows is this conversation's, or its
// agent's — said once, never per row
function ZoneTitle({ children }: { children: string }) {
  return (
    <h3 className="flex items-center gap-2 px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">
      <span>{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </h3>
  )
}

// the column's HEADER zone — the conversation's LIVE status as its first
// line (honest: derived ONLY from real signals — this agent's active turn,
// the context's waiting, mtime — never simulated activity), then the agent
// and its context (AgentContext). One zone, not separate sections: this is
// "who's talking and what it knows", read top to bottom.
function ContextHeader({ agent, status }: { agent: AgentView | null; status: { label: string; live: boolean; waiting?: boolean; detail?: string } | null }) {
  if (!agent && !status) return null
  return (
    <div className="space-y-2 border-b border-line px-3 pb-3 pt-3">
      {/* idle says nothing the sidebar's dot and time don't (once per
          screen) — the line shows only live work or a wait */}
      {status && (status.live || status.waiting) ? (
        // the same vocabulary as the StatusLine, so "in motion" is ONE thing
        // across the app: live → the house ✻ spinning + the shimmering
        // label; idle → the same ✻ at rest, dimmed (orange is only for
        // what's live); waiting → an hourglass in ink, static.
        <div className="flex items-center gap-2">
          {status.live ? (
            <Asterisk className="glyph-live text-base text-terracotta" />
          ) : status.waiting ? (
            <Hourglass size={14} aria-hidden="true" className="shrink-0 text-ink-2" />
          ) : (
            <Asterisk className="text-base text-ink-3" />
          )}
          <span className={`text-sm font-medium ${status.live ? 'live-phase' : status.waiting ? 'text-ink' : 'text-ink-2'}`}>{status.label}</span>
          {status.detail ? <span className="ml-auto font-mono text-[11px] text-ink-3">{status.detail}</span> : null}
        </div>
      ) : null}
      {agent ? <RunsOnLine agent={agent} /> : null}
      <UnattendedOnLine />
      {agent ? <PlanUsageBars agent={agent} /> : null}
      <CostLine />
    </div>
  )
}

// Team plan — the live preview of the shared human/agent plans
// (plans/*.plan.json, written by the team-plan skill) THIS conversation
// authored (context.files — by tool call or by naming the path in a
// command) or holds a task of (claimed/linked, the server's inverse); the
// caller applies the cut. Read through the plans
// silo (lib/plan-record.ts: the record by its file — the file IS the truth,
// the kernel its reader) and re-read whenever the session moves (mtime). ONE plan in play is the card and
// every other plan folds under "N other plans" (every plan as a card
// reached 10 cards in one conversation). In play = among unfinished plans the ones
// waiting on a human first, then the newest file; a plan
// living in ANOTHER folder paints too, with its home named — "in my-project ›"
// opening that project (authorship over territory; plans merely read
// stay hidden); a plan in a folder no agent
// lives in reads «outside Silos' projects», read-only.
// Marking done is the silo's set-field, exactly like the full viewer's.
type FoundPlan = LoadedPlan

// the project folder a plan path belongs to (the segment before /plans/).
const planFolderOf = planProjectFolder

// The plan files THIS conversation authored or is linked to, read through the plans silo
// (the record by its file) and re-read whenever the session moves (mtime) or
// a plans/ folder changes on disk (knows event 'plans'). Shared by the Plan
// block (which paints and edits them) and the Executing block (which counts
// progress against them).
function useTeamPlans(
  paths: readonly string[],
  mtime: number,
): { found: FoundPlan[]; setFound: Dispatch<SetStateAction<FoundPlan[]>>; mtimes: Map<string, number> } {
  const [found, setFound] = useState<FoundPlan[]>([])
  // each plan file's mtime, from one listing per plans/ folder — orders the
  // plans (the newest unfinished one is in play) and dates them. Set in the
  // same tick as `found`, AFTER the listing resolves: plans painted before
  // their dates would pick the card by updatedAt, then switch it.
  const [mtimes, setMtimes] = useState<Map<string, number>>(new Map())
  const key = paths.join('\n')
  // a plans/ write in any of these plans' folders (knows event 'plans')
  // re-reads them, even when this conversation's transcript did not move.
  const plansVersion = useStore((s) => [...new Set(paths.map(planFolderOf))].map((f) => s.plansVersion[f] ?? 0).join(','))

  useEffect(() => {
    let alive = true
    void (async () => {
      const loaded = await Promise.all(
        paths.map(async (path): Promise<FoundPlan | null> => {
          try {
            return await loadPlan(path)
          } catch {
            return null // unreadable → dropped, honestly; its siblings still render
          }
        }),
      )
      const plans = loaded.filter((p): p is FoundPlan => p !== null)
      // one listing per plans/ folder dates every plan file in it
      const folders = [...new Set(plans.map((p) => planFolderOf(p.path)).filter((f) => f !== ''))]
      const dated = new Map<string, number>()
      await Promise.all(
        folders.map(async (folder) => {
          try {
            const listing = await api.file.dir(`${folder}/plans`)
            // an mtime of 0 is no date ("updated 20000d ago"): left out
            for (const e of listing?.entries ?? []) if (e.type === 'file' && e.mtime > 0) dated.set(`${folder}/plans/${e.name}`, e.mtime)
          } catch {
            /* unreadable folder — its plans fall back to their updatedAt */
          }
        }),
      )
      if (alive) {
        setFound(plans)
        setMtimes(dated)
      }
    })()
    return () => {
      alive = false
    }
  }, [key, mtime, plansVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  return { found, setFound, mtimes }
}

function TeamPlanBlock({
  found,
  mtimes,
  cwd,
  onOpenFile,
}: {
  found: FoundPlan[]
  mtimes: Map<string, number>
  cwd: string | null
  onOpenFile: (path: string) => void
}) {
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const now = useStore((s) => s.nowTick)
  if (found.length === 0) return null
  const agentIds = new Set(agents.map((a) => a.id))
  // accent condition (needs_you language): READY human tasks specifically
  // — the same cut the Board's plan-task needs_you source uses server-side.
  const onYou = (p: FoundPlan) => humanReadyTasks(p.plan, agentIds).length > 0
  const finished = (p: FoundPlan) => p.plan.tasks.length > 0 && p.plan.tasks.every((t) => isFinished(t.status))
  // human-ready plans first, finished ones last; within a rank the newest
  // file first (its listing mtime, else the plan's own updatedAt)
  const rank = (p: FoundPlan) => (onYou(p) ? 0 : finished(p) ? 2 : 1)
  const mtimeOf = (p: FoundPlan): number | undefined => mtimes.get(p.path)
  const newness = (p: FoundPlan): number => mtimeOf(p) ?? (Date.parse(p.plan.updatedAt ?? '') || 0)
  const here = [...found].sort((a, b) => rank(a) - rank(b) || newness(b) - newness(a))
  // the plan in play: the first unfinished one; when every plan is finished,
  // the newest finished one — there is always one card.
  const inPlay = here.find((p) => rank(p) < 2) ?? here[0]!
  const others = here.filter((p) => p !== inPlay)
  // a plan whose folder is not this conversation's cwd is painted with its
  // home — the owner sees the work AND that it lives in another project.
  const homeOf = (p: FoundPlan): string | null => {
    const folder = planFolderOf(p.path)
    return folder !== '' && folder !== cwd ? folder : null
  }
  // the header counts the card's open tasks only: the folded plans are history
  const open = inPlay.plan.tasks.filter((t) => !isFinished(t.status)).length

  // The WHOLE card is the door to the plan: one click
  // anywhere goes through the plan's door (planDoor — its house, Tasks
  // narrowed to it; a closed or outside plan's file). The two inner actions keep
  // their own meaning and stop the click: "Done" marks a task, the home
  // mark opens the project.
  // the project's list is no plan: never a plan card —
  // one door to the project's tasks, «Tasks of <project> ›», with its open count
  const openTasksOf = (p: FoundPlan): void => {
    const folder = standingProjectOf(p.path)
    changePage({ kind: 'tasks', view: 'open', ...(folder ? { project: [folder] } : {}), ...conversationOrigin() })
  }
  const openPlan = (p: FoundPlan): void => {
    const door = planDoor({ key: p.key, file: p.path, outside: p.outside })
    if (door?.kind === 'file')
      onOpenFile(door.path) // the column's own viewer
    else if (door) changePage({ ...door.page, ...conversationOrigin() })
  }
  // one line per plan (it leads straight to the plan view without showing
  // the task list): its progress, its name, what is open
  // and what is on you — the whole line is its door. The project's list is
  // no plan: its line opens the project's open tasks.
  const line = (p: FoundPlan, inPlayLine = false) => {
    const total = p.plan.tasks.length
    const doneN = p.plan.tasks.filter((t) => t.status === 'done').length
    const openN = p.plan.tasks.filter((t) => !isFinished(t.status)).length
    const youN = humanReadyTasks(p.plan, agentIds).length
    const mtime = mtimeOf(p)
    const home = homeOf(p)
    const facts = [
      openN > 0 ? `${openN} open` : null,
      youN > 0 ? `${youN} on you` : null,
      p.outside ? "outside Silos' projects" : home ? `in ${baseName(home)}` : null,
      mtime !== undefined ? relTime(mtime, now) : null,
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <button
        key={p.path}
        type="button"
        data-testid={isStandingPlan(p.path) ? 'column-standing-tasks' : inPlayLine ? `team-plan-${baseName(p.path)}` : `team-plan-row-${baseName(p.path)}`}
        aria-label={`Open ${planHeading(p.plan.title, p.path)}`}
        onClick={() => (isStandingPlan(p.path) ? openTasksOf(p) : openPlan(p))}
        title={p.path}
        className={`${ROW_BUTTON} flex flex-col gap-0.5`}
      >
        <span className="flex w-full items-baseline gap-2">
          {finished(p) ? (
            <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">✓</span>
          ) : isStandingPlan(p.path) ? null : (
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3">
              {doneN}/{total}
            </span>
          )}
          <span
            {...(inPlayLine ? { 'data-testid': 'team-plan-title' } : {})}
            className="min-w-0 flex-1 truncate text-[12.5px] text-ink group-hover/k:text-terracotta"
          >
            {planHeading(p.plan.title, p.path)}
          </span>
          <ChevronRight size={12} aria-hidden="true" className="shrink-0 self-center text-ink-3 group-hover/k:text-terracotta" />
        </span>
        {facts ? <span className={`block truncate pl-0.5 font-mono text-[10.5px] ${youN > 0 ? 'text-terracotta' : 'text-ink-3'}`}>{facts}</span> : null}
      </button>
    )
  }

  return (
    <Block title="Plan" count={open > 0 ? open : undefined} accent={here.some(onYou)}>
      <div className="space-y-px">
        {line(inPlay, true)}
        {others.length > 0 ? (
          <details data-testid="team-plan-others">
            <summary className="cursor-pointer list-none rounded px-1 py-0.5 text-[10px] uppercase tracking-wide text-ink-3 hover:bg-panel [&::-webkit-details-marker]:hidden">
              {others.length} other plan{others.length === 1 ? '' : 's'}
            </summary>
            <div className="space-y-px">{others.map((p) => line(p))}</div>
          </details>
        ) : null}
      </div>
    </Block>
  )
}

// A conversation that outgrew its work: its context is at or past
// half of its model's window (the window «% context» is measured against;
// unknown → nothing). ONE quiet line under the size — no accent, never a
// Needs-you row, nothing in the pulse — and one door. Working a task of its
// own agent: «Continue in a new conversation ›» — the task's door with
// `instead` (a NEW conversation of the agent briefed from the task, linked,
// this one released with the status kept). Working none: the gesture that
// makes one, where it lives (⌘K «Make this a task»). Chat and console alike.
function OutgrewLine({ meta, agentName }: { meta: SessionView; agentName: string | null }) {
  const d = useHarness(meta.harness)
  const work = useConversationWork(meta.id)
  const setModal = useStore((s) => s.setModal)
  const lead = work && work.working ? work.lead : null
  const ours = lead !== null && lead.view !== null && lead.view.owner === meta.agentId
  const opener = useTaskOpen({ taskKey: lead?.key ?? '', name: agentName ?? 'its agent', onDone: () => {} })
  if (!pastHalfWindow(meta.contextTokens, knownWindow(meta.model, d.ui.contextPercent))) return null
  return (
    <div className="mt-1 pl-[17px] text-[11px] leading-snug text-ink-2" data-testid="outgrew-line">
      <span>Past half of its context window.</span>{' '}
      {ours ? (
        <button
          type="button"
          disabled={opener.o.state === 'opening'}
          onClick={() => void opener.go('console', lead.key, meta.id)}
          className="text-ink underline decoration-line underline-offset-2 hover:text-terracotta disabled:opacity-60"
        >
          Continue in a new conversation ›
        </button>
      ) : lead === null ? (
        <span>
          <button
            type="button"
            onClick={() => {
              if (useStore.getState().modal === null) setModal('palette')
            }}
            className="text-ink underline decoration-line underline-offset-2 hover:text-terracotta"
          >
            Make this a task
          </button>
          <span className="text-ink-3"> (⌘K) to continue it in a new one</span>
        </span>
      ) : null}
      {opener.o.state !== 'idle' ? (
        <span className={`block ${opener.o.state === 'error' ? 'text-[var(--health-amber)]' : 'text-ink-3'}`}>{opener.o.words}</span>
      ) : null}
    </div>
  )
}

// `agent`: the conversation view's own agent. A NEW conversation has no
// meta yet, and the column used to paint nothing at all — but that is the
// moment the owner wants to choose what it runs on (model etc. BEFORE
// having to speak). So a new chat's column carries the
// same header (runs-on, usage) and Knows block, read from this agent.
export function ContextColumn({ agent: viewAgent }: { agent?: AgentView } = {}) {
  const detail = useStore((s) => s.detail)
  const newChatOpen = useStore((s) => s.newChatOpen)
  const selectedKey = useStore((s) => s.selected)
  // in a console the open question is answered in Claude's own dialog (all
  // its questions, not just the first) — the column only offers it in chat
  const consoleShown = useStore((s) => s.consoleShown)
  const agents = useStore((s) => s.agents)
  const openSession = useStore((s) => s.openSession)
  const automations = useStore((s) => s.automations)
  const automationsPending = useStore((s) => s.automationsPending)
  // the machinery radius opens on «this conversation» in every conversation
  // — a wider look is a moment, never remembered
  const [contextScope, setContextScope] = useState<MachineryScope>('conversation')
  const scopeKey = detail ? `${detail.meta.folder}/${detail.meta.id}` : ''
  useEffect(() => {
    setContextScope('conversation')
  }, [scopeKey])
  const active = useStore((s) => s.active)
  const nowTick = useStore((s) => s.nowTick)
  const [openSubagent, setOpenSubagent] = useState<SubagentRef | null>(null)
  // the file viewer/editor: the path open right now (a modal). Transient
  // state (not routed) — closes on a session change.
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)

  // changing sessions with a subagent or a file open shouldn't leave the
  // column stuck in ANOTHER session's panel/modal.
  useEffect(() => {
    setOpenSubagent(null)
    setOpenFilePath(null)
  }, [detail?.meta.folder, detail?.meta.id])

  const context = detail?.context ?? null
  const cwd = detail?.meta.cwd ?? null
  // SCOPE (no plans/files from other projects): the column paints only what THIS conversation
  // touched INSIDE ITS OWN project folder. Everything here already comes
  // from this conversation's transcript alone; this cut removes the paths
  // that live in another project. Files handed to the owner
  // (SendUserFile, usually built in a scratchpad) stay: they are this
  // conversation's deliverables, wherever they were built.
  // a conversation WITHOUT a folder (master/Anywhere) has no project
  // boundary — everything it touched is shown, as always.
  const inProject = (path: string) => cwd === null || path === cwd || path.startsWith(cwd + '/')
  // ANOTHER project's territory: any registered agent folder that isn't
  // this conversation's — the boundary: a
  // conversation working cross-repo must not flood its column with the
  // other repo's files. Territory ≠ authorship, hence the next rule.
  const otherRoots = agents.map((a) => a.folder).filter((f): f is string => f !== null && f !== cwd)
  const inAnotherProject = (path: string) => otherRoots.some((r) => path === r || path.startsWith(r + '/'))
  // a file the conversation WROTE in no-man's-land (~, a scratchpad) is
  // its deliverable — ~/reply-draft.txt must paint. Foreign READS stay
  // out: reading around is not work product.
  const wrote = (f: SessionContext['files'][number]) => f.edits + f.writes > 0
  const scopedFiles = (context?.files ?? []).filter((f) => inProject(f.path) || (f.sent ?? 0) > 0 || (wrote(f) && !inAnotherProject(f.path)))
  // plan files this conversation AUTHORED — with the plans it is linked to
  // (below), the only plans the column may paint. Authorship over territory (not "strictly this project's
  // own"): a conversation working on another repo
  // is still the author of the plan it writes there, and the plan is where
  // its progress lives — hiding it left the owner reading "Task 9" in
  // prose. Written = Write/Edit, or named by path in a command (disk).
  // Reading around is not authorship: a foreign plan only READ stays out,
  // which is what the territory rule was really protecting. A foreign plan says
  // where it lives (TeamPlanBlock's home line).
  const authored = (f: SessionContext['files'][number]) => f.edits + f.writes + (f.disk ?? 0) > 0
  const isPlanPath = (p: string) => isPlanFile(p.slice(p.lastIndexOf('/') + 1)) && p.includes('/plans/')
  // …and the plans holding a task LINKED to this conversation (claimed or
  // linked, current or past — the server's inverse the header reads): the
  // conversation works them whoever wrote the file (a script with a relative
  // path, another conversation). Linking is authorship's peer: such a plan
  // paints wherever it lives, its home named like any foreign plan's.
  // One line per plan, deduped by path.
  const work = useConversationWork(detail?.meta.id ?? null)
  const linkedPlans = new Set((work ? [work.lead, ...work.rest] : []).map((t) => t.file).filter((p): p is string => p !== null && isPlanPath(p)))
  const planPaths = [
    ...new Set([...(context?.files ?? []).filter((f) => isPlanPath(f.path) && (inProject(f.path) || authored(f))).map((f) => f.path), ...linkedPlans]),
  ]

  // machinery: the ONLY part of this column that wasn't already about the
  // open conversation, so it carries the radius dial (contextScope,
  // default 'conversation'). The block itself applies it;
  // here we only hand it the raw material.
  const scopeSession: ScopeSession | null = detail
    ? {
        id: detail.meta.id,
        agentId: detail.meta.agentId,
        cwd: detail.meta.cwd,
        ...(detail.meta.origin?.kind === 'automation' ? { origin: detail.meta.origin } : {}),
      }
    : null
  const scopeAgents = agents.map((a) => ({ id: a.id, folder: a.folder, name: a.name, emoji: a.emoji }))
  // pending approvals for THIS agent's automations — reuses Needs you's
  // visual pattern, with inline actions (see AutomationApprovalsBlock).
  // NOT governed by the dial on purpose: the radius is for reference
  // machinery, never for something WAITING ON YOU (the column's own rule —
  // an accent block outranks reference material).
  const pendingForThisAgent = detail ? automationsPending.filter((r) => automations.find((a) => a.id === r.automationId)?.agentId === detail.meta.agentId) : []
  // live status derived from REAL signals (never simulated, see
  // ContextHeader): this agent's active turn → Working; otherwise, the
  // context's waiting; otherwise, a recent mtime AND an unclosed turn →
  // Working; otherwise, Idle with "how long ago". Working ≠ live: a
  // CLOSED turn — via the CLI's turn_duration marker (lastTurnClosed) or
  // because this client witnessed the chat-done (closedByClient,
  // store.turnCloses) — is no longer "Working" even if mtime is still
  // within the live window; see lib/live.ts.
  const meta = detail?.meta ?? null
  const isNewChat = !meta && !selectedKey && newChatOpen
  const currentAgent = meta ? (agents.find((a) => a.id === meta.agentId) ?? null) : isNewChat ? (viewAgent ?? null) : null
  // Working states the CONVERSATION, never the agent: the
  // agent's stream in ANOTHER conversation must not light this column.
  // sessionKey is stamped on send (continuations) and corrected by
  // chat-init, so the strict key match is the whole rule; a new chat's
  // null key can't refer to an existing conversation.
  const working = !!meta && active?.status === 'streaming' && active.sessionKey === `${meta.folder}/${meta.id}`
  const turnCloses = useStore((s) => s.turnCloses)
  const turnClosed = !!meta && (lastTurnClosed(detail?.turns) || closedByClient(turnCloses[`${meta.folder}/${meta.id}`], meta.mtime))
  // the disk census of background work — a backgrounded skill CLOSES the
  // main turn while its agents keep writing under <session>/subagents/;
  // a census row at work (it writes, or a tool of its runs — live.ts
  // agentAtWork) means someone still works for this conversation, and Idle
  // over live work would be a lie. A subagent silent inside a
  // long command is at work too. The meta's own background signal
  // (backgroundWorking: the sidebar dot's) covers a census not loaded yet.
  const census = useMemo(() => detail?.subagents ?? [], [detail?.subagents])
  const censusLive = census.filter((a) => agentAtWork(a, nowTick))
  const backgroundLive = censusLive.length > 0 || (!!meta && backgroundWorking(meta, nowTick))
  // a background command it launched and awaits — working with the turn closed
  const shellLive = !!meta && shellRunning(meta, nowTick)
  // a plan executed with subagents (lib/execution.ts) takes its rows out of
  // the plain Subagents block: each shows once, under its task. The execution
  // record (the SDD ledger, served with the detail) names done/total and
  // titles first; the census overlays what runs now.
  const record = detail?.execution ?? null
  const execution = groupExecution(census, nowTick, record)
  const plainCensus = census.filter((a) => !execution.claimed.has(a.id))
  // the transcripts the server can serve — the only rows that may be doors
  const censusIds = useMemo(() => new Set(census.map((a) => a.id)), [census])
  const teamPlans = useTeamPlans(planPaths, meta?.mtime ?? 0)
  // of those, the ones that are THIS conversation's (planIsOf): the tasks it
  // holds decide, never a file it merely read or left a note in
  const wrotePlans = new Set((context?.files ?? []).filter((f) => isPlanPath(f.path) && authored(f)).map((f) => f.path))
  // a linked plan is its own by the link (the thread rule: the task may list
  // an ancestor of this conversation, a rotation planIsOf cannot see)
  const ownPlans = meta ? teamPlans.found.filter((p) => linkedPlans.has(p.path) || planIsOf(p.plan, meta.id, wrotePlans.has(p.path))) : []
  // done/total from the record alone — the one the Executions silo lists
  // for this conversation (no plans.json fallback since phase 5)
  const source = progressSource(record)
  // the plan task this execution hangs from: the door conversation → task
  const executionTask = detail?.executionTask ?? null
  const progress = executionProgress(execution.tasks, source, nowTick)
  const doneTasks = source?.done ?? new Set<number>()
  const over = executionOver(execution.tasks, progress)
  const executing = executionWord(census, nowTick)
  // the nested runs this conversation's claude launched (births)
  const nestedRuns = meta
    ? nestedRunsOf(
        meta,
        agents.flatMap((a) => a.sessions),
      )
    : []
  const atWork =
    executing ??
    (censusLive.length > 0
      ? `${censusLive.length} subagent${censusLive.length === 1 ? '' : 's'} at work`
      : shellLive
        ? `a command running · started ${relTime(meta!.shellSince!, nowTick)}`
        : backgroundLive
          ? 'subagents at work'
          : undefined)
  const status = meta
    ? working
      ? { label: 'Working', live: true, detail: atWork as string | undefined }
      : meta.pendingAsk === true
        ? // an open question / a plan to approve: it waits on you, it is not working
          { label: 'Waiting for you', live: false, waiting: true, detail: relTime(meta.mtime, nowTick) }
        : backgroundLive
          ? // its subagents at work (the one rule, live.ts): Working —
            // above a Monitor/workflow wait, which is the conversation's own
            // background thing, never the owner's turn
            { label: 'Working', live: true, detail: atWork }
          : context?.waiting
            ? {
                label: capitalized(parkedWords(context.waiting.kind, context.waiting.label)),
                live: false,
                waiting: true,
                detail: timeSince(context.waiting.since),
              }
            : (isLive(meta.mtime, nowTick) || toolInFlight(meta, nowTick)) && !turnClosed
              ? { label: 'Working', live: true, detail: undefined }
              : { label: 'Idle', live: false, detail: relTime(meta.mtime, nowTick) }
    : isNewChat
      ? { label: 'Not started', live: false, detail: 'pick what it runs on' }
      : null

  return (
    <aside className="hidden w-[300px] shrink-0 flex-col border-l border-line bg-canvas lg:flex">
      {/* no title, no collapse control: the column is permanent from lg up
          and it's obviously the conversation's context. */}
      <ChipTerminal />
      <div className="flex-1 overflow-y-auto">
        {/* ORDER AND PROMINENCE: the HEADER zone first (live status +
                the agent and its context, one piece — ContextHeader), then
                most to least urgent: ACTIONABLE (Needs you / approval,
                terracotta accent) → the work (Plan · Agents) → waits
                (Waiting · Scheduled) → collapsed REFERENCE (Chain · Links ·
                Events · Files · Tools). The automation blocks
                (approvals/Scheduled) derive from detail.meta + automations,
                not from `context` — that's why they live outside the
                `!context` guard. */}
        {/* two zones: what is THIS
                conversation's, then what is its agent's — never mixed */}
        <ZoneTitle>This conversation</ZoneTitle>
        <ContextHeader agent={currentAgent} status={status} />
        {meta ? (
          <StartedWithBlock
            folder={meta.folder}
            id={meta.id}
            ctx={{ agentName: currentAgent?.name, agentEmoji: currentAgent?.emoji, folder: currentAgent?.folder ?? meta.cwd }}
            after={<OutgrewLine meta={meta} agentName={currentAgent?.name ?? null} />}
          />
        ) : null}
        {/* a plan being executed step by step sits right under the
                status (at the very top, where the state is):
                it IS the state of this conversation, not reference. */}
        {execution.tasks.length > 0 && !over ? (
          <ExecutionBlock
            tasks={execution.tasks}
            done={doneTasks}
            progress={progress}
            now={nowTick}
            onOpen={setOpenSubagent}
            fromRecord={record !== null}
            task={executionTask}
          />
        ) : null}
        {context?.pending && meta && consoleShown !== `${meta.folder}/${meta.id}` ? (
          <NeedsYou pending={context.pending} folder={meta.folder} id={meta.id} />
        ) : null}
        {/* c6: the latest plan-mode plan — one row, jumps to its sheet */}
        {context?.planMode ? <PlanModeRow planMode={context.planMode} /> : null}
        {pendingForThisAgent.length > 0 ? <AutomationApprovalsBlock pending={pendingForThisAgent} automations={automations} /> : null}
        {context?.plan ? <TasksBlock context={context} censusIds={censusIds} onOpenSubagent={setOpenSubagent} /> : null}
        {meta && ownPlans.length > 0 ? <TeamPlanBlock found={ownPlans} mtimes={teamPlans.mtimes} cwd={meta.cwd} onOpenFile={setOpenFilePath} /> : null}
        {/* subagents with no task (or a session with no plan): listed all the same — they're real work.
                With a disk census (subagents dir) the census wins: it is the
                complete truth (a skill's children never reach context.agents);
                the legacy block stays for sessions predating the dir layout. */}
        {/* a FINISHED execution is history: folded, down here with the
                agents it was made of, never under the status. */}
        {execution.tasks.length > 0 && over ? (
          <ExecutionBlock
            over
            tasks={execution.tasks}
            done={doneTasks}
            progress={progress}
            now={nowTick}
            onOpen={setOpenSubagent}
            fromRecord={record !== null}
            task={executionTask}
          />
        ) : null}
        {plainCensus.length > 0 ? (
          <CensusBlock census={plainCensus} now={nowTick} onOpen={setOpenSubagent} />
        ) : census.length === 0 && context?.agents.some((a) => !a.taskId) ? (
          <AgentsBlock agents={context.agents.filter((a) => !a.taskId)} />
        ) : null}
        {context?.outbound !== undefined && context.outbound.length > 0 ? <OutboundBlock outbound={context.outbound} ctxAgents={context.agents} /> : null}
        {nestedRuns.length > 0 ? <NestedRunsBlock runs={nestedRuns} now={nowTick} onOpen={(s) => void openSession(s.folder, s.id)} /> : null}
        {/* what it left running on the machine — folded, absent when none;
                keyed so every conversation opens it closed */}
        {meta ? <ProcessesBlock key={`${meta.folder}/${meta.id}`} folder={meta.folder} id={meta.id} awaited={shellLive} /> : null}
        {context && context.links.artifacts.length > 0 ? <PublishedBlock artifacts={context.links.artifacts} /> : null}
        {context && (context.documents?.length ?? 0) > 0 && meta ? <DocumentsBlock documents={context.documents!} folder={meta.folder} id={meta.id} /> : null}
        {/* what the owner gave THIS conversation alone (its thread's own
                folder) — or the door to give it one */}
        {currentAgent ? (
          <>
            {/* no «Its agent» title: Knows and Automations each carry the
                    column's radius dial, on «this conversation» by default */}
            <KnowsBlock
              key={meta ? `${meta.folder}/${meta.id}` : 'new'}
              agent={currentAgent}
              {...(meta && context
                ? {
                    here: {
                      id: meta.id,
                      files: context.files,
                      tools: context.tools,
                      folder: meta.folder,
                      cwd: meta.cwd,
                      automation: meta.origin?.kind === 'automation',
                    },
                  }
                : {})}
            />
          </>
        ) : null}
        {automations.length > 0 && meta ? (
          <AutomationsBlock
            all={automations}
            session={scopeSession}
            agents={scopeAgents}
            scope={contextScope}
            onScope={setContextScope}
            now={nowTick}
            onToggle={(a) =>
              void api.automations
                .update(a.id, { paused: !a.paused })
                .then(() => useStore.getState().loadAutomations())
                .catch((e: unknown) => useStore.setState({ error: e instanceof Error ? e.message : String(e) }))
            }
          />
        ) : null}
        {context ? (
          <>
            <UsedBlock
              files={scopedFiles}
              tools={context.tools}
              links={context.links}
              events={context.events}
              cwd={meta?.cwd ?? null}
              onOpenFile={setOpenFilePath}
            />
          </>
        ) : null}
        {!context && !currentAgent && pendingForThisAgent.length === 0 && automations.length === 0 ? (
          <p className="px-3 py-3 text-sm text-ink-2">No context yet.</p>
        ) : null}
      </div>
      {/* a subagent's transcript — a MODAL (fixed inset-0): mounted here but
          covers the whole window, not the 300px column. */}
      {openSubagent && detail ? (
        <SubagentModal folder={detail.meta.folder} id={detail.meta.id} subagent={openSubagent} onClose={() => setOpenSubagent(null)} />
      ) : null}
      {/* the file viewer/editor — a modal (fixed inset-0): mounted here but
          covers the whole window, not just the column. */}
      {openFilePath ? <FileViewer path={openFilePath} onClose={() => setOpenFilePath(null)} /> : null}
    </aside>
  )
}
