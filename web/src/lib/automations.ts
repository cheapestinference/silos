// automations.ts — helpers shared by the composer (caret ▾ + sheet), the
// Schedule tab, the Automations dimension and the sidebar (⏰ under topics):
// an automatic name from the prompt, cron presets ↔ readable fields
// (Weekdays/Daily/Weekly/Custom), and the human trigger summary shown
// across all those surfaces.
// The cron fields (EveryFields/cronFromEvery/everyFromCron/
// defaultEveryFields) and the human summary (humanCron) live in
// lib/cron-summary.ts — its own module with direct tests; they're
// re-exported as-is so AutomationSheet.tsx and this file's other existing
// imports don't break.
import { periodWords } from './period'
import { humanCron, cronFromEvery, everyFromCron, defaultEveryFields, type EveryFields, type EveryPreset } from './cron-summary'
import type { Automation, CommandLeg, CommandRun, Run, RunStatus, Trigger } from './types'
import { resumeLabel } from './rate-limits'
import { isBeatAutomation } from './automations-signal'
// the one reading of a failed run, shared with the server's Needs you
import { failureSentence, runFailure, NO_REASON } from '../../../server/src/run-failure'

export { cronFromEvery, everyFromCron, defaultEveryFields }
export type { EveryFields, EveryPreset }

// an automatic name: the prompt's first ~6 words, trimmed — editable by
// hand in the sheet (the caller just needs to mark `nameEdited` and stop
// calling this on every keystroke).
export function autoName(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/g, ' ')
  if (!clean) return ''
  const words = clean.split(' ').slice(0, 6).join(' ')
  return words.length > 60 ? `${words.slice(0, 57)}…` : words
}

function formatOnce(at: string): string {
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return at
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// a trigger's human summary — used in the Schedule tab, the Automations
// dimension and the sidebar's ⏰.
export function triggerSummary(t: Trigger): string {
  switch (t.kind) {
    case 'once':
      return `once · ${formatOnce(t.at)}`
    case 'cron':
      return humanCron(t.expr)
    case 'period':
      return periodWords(t.period)
    case 'webhook':
      return 'webhook'
    case 'files':
      return `files · ${t.glob}`
    case 'conversation':
      return t.when === 'finished' ? 'on finished' : 'on needs you'
    case 'watch':
      return `watch ${t.check.type} · ${t.runWhen}`
    default:
      return ''
  }
}

// A `once` that has run is DONE — a terminal state of its own, not
// "paused". The resident parks a fired once as paused:true (it has no
// other switch: resident.ts runOnceScheduled), and every surface used to
// read that word literally: the builder's sidebar counted 12 automations of
// which 9 were finished probes, each offering a "Resume" that would have
// re-fired the probe. One rule, read by the sidebar, the
// column, the agent page and the Board: done is not counted among the
// standing automations, never says "paused", offers "Run again" (a manual
// run) instead of Resume, and folds away. A once paused BEFORE it fired
// is still paused; a fired once that failed or was skipped is done too —
// nothing will fire it again on its own.
export function isDone(a: Automation): boolean {
  return a.trigger.kind === 'once' && a.paused && a.lastRun !== undefined
}

function formatDay(at: string): string {
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return at
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric' })
}

// what a finished once says in place of a timetable: its outcome and day.
export function doneLabel(a: Automation): string {
  const status = a.lastRun?.status
  const word = status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : status === 'ok' || status === undefined ? 'ran' : runStatusLabel(status)
  return a.lastRun ? `${word} ${formatDay(a.lastRun.at)}` : word
}

export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'waiting_approval':
      return 'needs approval'
    case 'running':
      return 'running'
    case 'ok':
      return 'ok'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
    case 'waiting_reset':
      return 'waiting · resumes'
    default:
      return status
  }
}

// the word a run leads with in a history: what it DID when the agent said so
// (its OUTCOME line, see the resident), else the bare status as before.
export function runOutcomeWord(run: Pick<Run, 'status' | 'outcome'>): string {
  if (run.status === 'ok' && run.outcome === 'acted') return 'acted'
  if (run.status === 'ok' && run.outcome === 'nothing') return 'no news'
  return runStatusLabel(run.status)
}

// a failed run's raw error, said in plain words — the server's own reading
// (server/src/run-failure.ts, the one Home's Needs you uses: one source, so
// the two pages never disagree); the raw text stays on the row's title for
// whoever needs it. `retry` is the HH:MM a usage limit lifts, when the run
// carries it. A command run says what the exec did; a hand-over that failed
// adds why.
export function explainRunError(run: Pick<Run, 'error' | 'resetsAt'> & Partial<Pick<Run, 'command' | 'handover'>>): { text: string; retry?: string } {
  if (run.command) {
    const said = commandOutcome(run.command)
    if (!run.handover) return { text: said }
    const why = explainRunError({ error: run.error, resetsAt: run.resetsAt })
    return { text: `${said} — handed over, but ${why.text.charAt(0).toLowerCase()}${why.text.slice(1)}` }
  }
  const text = failureSentence(run.error)
  if (runFailure(run.error).class !== 'limit') return { text }
  const ms = run.resetsAt ? Date.parse(run.resetsAt) : NaN
  return Number.isNaN(ms) ? { text } : { text, retry: `retries at ${new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` }
}

// A run history folds what goes as usual: consecutive runs
// that ended ok with the same outcome — no news, acted, or unclassified (a
// command that exited 0) — fold into one quiet row, so a routine that acts
// every 2 h is one line and what CHANGES stands out: a failure, a wait, an
// "acted" among no-news runs (it breaks the streak, it is its own row).
// Failed and waiting runs never fold. A lone run stays a plain row.
export type RoutineKey = 'nothing' | 'acted' | 'ok'
export type RunHistoryItem = { kind: 'run'; run: Run } | { kind: 'fold'; runs: Run[]; key: RoutineKey }
function routineKey(r: Run): RoutineKey | null {
  if (r.status !== 'ok') return null
  return r.outcome === 'nothing' ? 'nothing' : r.outcome === 'acted' ? 'acted' : 'ok'
}
export function foldRoutine(runs: readonly Run[]): RunHistoryItem[] {
  const out: RunHistoryItem[] = []
  let streak: Run[] = []
  let key: RoutineKey | null = null
  const flush = () => {
    if (streak.length >= 2 && key !== null) out.push({ kind: 'fold', runs: streak, key })
    else for (const r of streak) out.push({ kind: 'run', run: r })
    streak = []
    key = null
  }
  for (const r of runs) {
    const k = routineKey(r)
    if (k === null) {
      flush()
      out.push({ kind: 'run', run: r })
      continue
    }
    if (k !== key) flush()
    key = k
    streak.push(r)
  }
  flush()
  return out
}

// what a fold says it holds
export function foldWords(n: number, key: RoutineKey): string {
  if (key === 'nothing') return `${n} runs with no news`
  if (key === 'acted') return `${n} runs that acted, as usual`
  return `${n} runs, all ok`
}

// "<oldest> – <newest>" of a fold (runs arrive newest first); one day says
// its day once.
export function foldRangeLabel(runs: readonly Pick<Run, 'at'>[]): string {
  const ms = runs.map((r) => Date.parse(r.at)).filter((n) => !Number.isNaN(n))
  if (ms.length === 0) return ''
  const first = new Date(Math.min(...ms))
  const last = new Date(Math.max(...ms))
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return day(first) === day(last) ? `${day(first)} ${time(first)} – ${time(last)}` : `${day(first)} ${time(first)} – ${day(last)} ${time(last)}`
}

// the weekly label: a bare time is misleading when the reset is weekly
// (HH:MM of which day?) — resumeLabel adds the day + "weekly" past a 24h view.
export function resumesAtLabel(run: Run): string | null {
  if (run.status !== 'waiting_reset' || !run.resetsAt) return null
  const label = resumeLabel(run.resetsAt)
  // the caller prepends "resumes" (runStatusLabel: 'waiting · resumes') —
  // this returns only the time part, so the common prefix is trimmed here.
  return label === null ? null : label.replace(/^resumes /, '')
}

export function nextRunLabel(a: Automation): string | null {
  if (!a.nextRunAt) return null
  const ms = Date.parse(a.nextRunAt)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// "next in 1h 12m" — the countdown the context column paints for an ARMED
// automation (relative beats absolute for "is this alive?"). Past-due says
// "due now" (the resident fires on its next tick); beyond 48h falls back
// to the absolute label (a countdown in days reads worse than a date).
export function nextRunIn(a: Automation, nowMs: number): string | null {
  if (!a.nextRunAt) return null
  const ms = Date.parse(a.nextRunAt)
  if (Number.isNaN(ms)) return null
  const d = ms - nowMs
  if (d <= 0) return 'due now'
  if (d > 48 * 3_600_000) return nextRunLabel(a)
  const h = Math.floor(d / 3_600_000)
  const m = Math.floor((d % 3_600_000) / 60_000)
  if (h > 0) return `in ${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `in ${m}m`
  return 'in <1m'
}

// --- machinery scope: how wide the column's machinery reaches -------------
//
// The context column is ALREADY about the open conversation almost
// everywhere (its plan, its subagents, its files, its artifacts — all
// computed per session). The machinery blocks were the exception: they
// showed the whole AGENT's automations while you read one conversation
// (the owner wants to see only this conversation's automations by default,
// with a scope that can be changed).
//
// So the radius becomes explicit and persisted, one dial for the class:
//   conversation — the automation that produced this conversation (its run,
//                  or the keep thread that IS it). 0 or 1: provenance.
//   agent        — every automation of this conversation's agent (the old
//                  behaviour, now a choice).
//   project      — every automation whose agent lives in this project, plus
//                  Anywhere's aimed at this project's folder.
//   all          — everything, everywhere.
export type MachineryScope = 'conversation' | 'agent' | 'project' | 'all'

export const SCOPE_ORDER: MachineryScope[] = ['conversation', 'agent', 'project', 'all']
export const SCOPE_LABEL: Record<MachineryScope, string> = {
  conversation: 'this conversation',
  agent: 'this agent',
  project: 'this project',
  all: 'everywhere',
}

export interface ScopeSession {
  id: string
  agentId: string
  cwd: string | null
  origin?: { kind: 'automation'; automationId: string; runId: string }
}

// the project a conversation belongs to: where it actually runs, falling
// back to its agent's folder (Anywhere has none of its own).
function projectOf(session: ScopeSession, agents: readonly { id: string; folder: string | null }[]): string | null {
  return session.cwd ?? agents.find((a) => a.id === session.agentId)?.folder ?? null
}

export function automationsInScope(
  scope: MachineryScope,
  automations: readonly Automation[],
  ctx: { session: ScopeSession | null; agents: readonly { id: string; folder: string | null }[] },
): Automation[] {
  const { session, agents } = ctx
  // The beat (heartbeat-<agent>) left every automations enumeration (its
  // home is the agent's Now, the control block's Heartbeat
  // row) — so beyond the
  // conversation the dial never counts or lists it, or the column would
  // disagree with the Automations page. At the CONVERSATION radius the
  // beat's own run conversation still names its provenance: that row is
  // about THIS conversation.
  if (scope === 'conversation') {
    if (!session) return []
    return automations.filter((a) => a.id === session.origin?.automationId || (a.thread.mode === 'keep' && a.thread.sessionId === session.id))
  }
  const listed = automations.filter((a) => !isBeatAutomation(a))
  if (scope === 'all') return listed
  // no open conversation = no radius to measure from; only 'all' says anything.
  if (!session) return []
  if (scope === 'agent') return listed.filter((a) => a.agentId === session.agentId)
  const project = projectOf(session, agents)
  // a conversation with no folder has no project — the honest answer there
  // is its agent's machinery, not everyone's.
  if (project === null) return listed.filter((a) => a.agentId === session.agentId)
  return listed.filter((a) => {
    const folder = agents.find((x) => x.id === a.agentId)?.folder ?? null
    if (folder === project) return true
    return a.thread.mode === 'keep' && a.thread.folder === project
  })
}

// the next radius out that would actually show MORE than the current one —
// what the block offers as "+N in this agent · M armed". Both numbers, so
// the hint speaks the header's language (armed) AND the list's (rows).
// null when nothing is hidden.
export function nextWiderScope(
  scope: MachineryScope,
  automations: readonly Automation[],
  ctx: { session: ScopeSession | null; agents: readonly { id: string; folder: string | null }[] },
): { scope: MachineryScope; extra: number; armed: number } | null {
  const here = automationsInScope(scope, automations, ctx)
  const hereIds = new Set(here.map((a) => a.id))
  for (const wider of SCOPE_ORDER.slice(SCOPE_ORDER.indexOf(scope) + 1)) {
    const added = automationsInScope(wider, automations, ctx).filter((a) => !hereIds.has(a.id))
    if (added.length > 0) return { scope: wider, extra: added.length, armed: added.filter((a) => !a.paused && !a.autoPaused).length }
  }
  return null
}

// beyond the conversation, the column only SUMMARIZES (docs/product.md:
// "the column never duplicates a page; it points to it") — this many rows,
// then a pointer to the page that holds the rest.
export const MAX_ROWS_WIDE = 5

// what a conversation is to an automation: the keep THREAD it lives in, a
// RUN that produced it, or nothing. A keep thread's first run is both —
// the thread wins (it still lives here).
export function ownKindOf(a: Automation, session: ScopeSession | null): 'thread' | 'run' | null {
  if (!session) return null
  if (a.thread.mode === 'keep' && a.thread.sessionId === session.id) return 'thread'
  if (a.id === session.origin?.automationId) return 'run'
  return null
}

// --- the one line that says what an automation DOES -----------------------
//
// promptGist (an automation's first sentence, literal) lives in
// server/src/automation-words.ts beside the argv helpers
export { promptGist } from '../../../server/src/automation-words'

// --- the Automations page (one list) ---------------------------------------

// An agent's standing beat (materialized from its responsibility) never
// enumerates on these surfaces at all (its home is the «In
// charge of» card) — the ONE shared predicate is isBeatAutomation in
// lib/automations-signal.ts; the origin-based isBeat() that used to live
// here was removed with it so there is never a second, drifting check.

// When the next run lands, in the words a person plans with: "in 14 min",
// "today 18:58", "tomorrow 06:30", then the date. A countdown to the minute
// ("in 12h 47m") is precision nobody reads.
export function nextRunWhen(a: Pick<Automation, 'nextRunAt'>, nowMs: number): string | null {
  if (!a.nextRunAt) return null
  const ms = Date.parse(a.nextRunAt)
  if (Number.isNaN(ms)) return null
  const d = ms - nowMs
  if (d <= 0) return 'due now'
  if (d < 3_600_000) return `in ${Math.max(1, Math.round(d / 60_000))} min`
  const at = new Date(ms)
  const hhmm = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  const day = (t: number) => {
    const x = new Date(t)
    x.setHours(0, 0, 0, 0)
    return x.getTime()
  }
  const days = Math.round((day(ms) - day(nowMs)) / 86_400_000)
  if (days === 0) return `today ${hhmm}`
  if (days === 1) return `tomorrow ${hhmm}`
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${hhmm}`
}

// What a row says on its second line: what the last run DID (its final
// message), or why it failed; null when it has not run or said nothing — the
// row then reads the prompt's gist.
export function lastRunLine(a: Pick<Automation, 'lastRun' | 'lastRunError'> & Partial<Pick<Automation, 'run'>>): { text: string; failed: boolean } | null {
  const last = a.lastRun
  if (!last) return null
  if (last.status === 'failed') return { text: failureReason(a.lastRunError, a), failed: true }
  const summary = last.summary?.trim()
  return summary ? { text: summary, failed: false } : null
}

// why it failed, in plain words — never the bare word "failed" again next to
// a row that already says it. A command's own failure ('exited 2', 'timed
// out after 10 min', 'not found: …') is already plain: said as is, with the
// last line it printed.
const COMMAND_FAILURE = /^(exited -?\d+|timed out after \d+ min|not found: |its folder does not exist|killed by |command: |no command to run)/
export function failureReason(error: string | undefined, a?: Pick<Automation, 'run' | 'lastRun'>): string {
  if (a?.run?.kind === 'command' && error && COMMAND_FAILURE.test(error)) {
    const line = a.lastRun?.summary?.trim()
    return line && /^exited/.test(error) ? `${error} · ${line}` : error
  }
  if (!error?.trim()) return `${NO_REASON} — open it to see the run`
  const why = explainRunError({ error })
  return why.retry ? `${why.text} · ${why.retry}` : why.text
}

// "Needs a look": what the page leads with, only when something is off — a
// run waiting for the owner's go, or an armed automation whose last run
// failed. Paused and finished ones are not asking for anything.
export interface LookItem {
  automation: Automation
  reason: 'approval' | 'failed'
  text: string
  at: string | null
}
export function needsALook(automations: readonly Automation[], pendingIds: ReadonlySet<string>): LookItem[] {
  const out: LookItem[] = []
  for (const a of automations) {
    if (pendingIds.has(a.id)) out.push({ automation: a, reason: 'approval', text: 'waiting for your go', at: null })
    else if (a.lastRun?.status === 'failed' && !a.paused && !isDone(a)) {
      out.push({ automation: a, reason: 'failed', text: failureReason(a.lastRunError, a), at: a.lastRun.at })
    }
  }
  return out
}

// --- command automations ----------------------------------------------------
//
// An automation can run a command instead of an agent turn: argv, no
// shell, no Claude. Only the owner creates or edits one.

export function commandOf(a: Pick<Automation, 'run'>): CommandRun | null {
  return a.run?.kind === 'command' ? a.run : null
}

// argvLine / argvShort live in server/src/automation-words.ts — the inbox
// words a proposed command with them too (one wording for both sides)
export { argvLine, argvShort, parseArgvLine } from '../../../server/src/automation-words'

function seconds(ms: number): string {
  if (ms < 1000) return '<1 s'
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  return `${Math.round(ms / 60_000)} min`
}

// what the exec did, in a word or two: «exit 0», «timed out», «didn't start: …»
export function commandOutcome(leg: CommandLeg): string {
  if (leg.timedOut) return 'timed out'
  if (leg.error) return `didn't start: ${leg.error.replace(/^not found: /, 'no ')}`
  return `exit ${leg.exitCode ?? '?'}`
}

// a command run's row: «exit 0 · 4 s · <last line>»
export function commandRunLine(leg: CommandLeg): string {
  return [commandOutcome(leg), seconds(leg.durationMs), leg.lastLine ?? null].filter(Boolean).join(' · ')
}

// A standing duty's beat once ran in ONE kept thread (it later moved to a
// fresh conversation per beat, leaving the old one
// as history). The beat's page names it: the
// newest sessionKey that two or more of its runs share — a kept thread by
// construction — other than the thread it keeps now. Runs come newest
// first; null when no thread was ever shared.
export function earlierKeptThread(runs: ReadonlyArray<Pick<Run, 'sessionKey'>>, current: string | null = null): { folder: string; id: string } | null {
  const seen = new Map<string, number>()
  const order: string[] = []
  for (const r of runs) {
    if (!r.sessionKey || r.sessionKey === current) continue
    const n = seen.get(r.sessionKey) ?? 0
    if (n === 0) order.push(r.sessionKey)
    seen.set(r.sessionKey, n + 1)
  }
  const key = order.find((k) => (seen.get(k) ?? 0) >= 2)
  if (!key) return null
  const slash = key.indexOf('/')
  return slash > 0 ? { folder: key.slice(0, slash), id: key.slice(slash + 1) } : null
}
