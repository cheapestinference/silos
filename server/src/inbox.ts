// inbox.ts — THE inbox ("Needs you", docs/product.md moment 2), composed on
// the server so Home today — and the daily digest and the phone's doorbell
// tomorrow — can never disagree. Pure: every input is a fact the caller already read (inbox-source.ts
// does the reading); nothing here touches a file or a clock of its own.
//
// The rows, each with the silo standard's urgency (`blocking | due | routine`)
// — one vocabulary for inbox, doorbell and digest:
//   blocking  ask · escalated · needs_owner message · silo conflicts and
//             blocking entries
//   due       approval · an agent's proposal (automation, skill, mission) · failed run · stalled mission · messages
//             unread past their recipient's next chance · missed retry · silo due
//             entries, proposals and submissions (support's ONE summary row
//             among them: a silo, its due rows folded)
//   routine   silo routine — a plan's tasks of yours among them (the built-in
//             Plans silo; their own section, «Yours to do») · the
//             task lines (wait for you to start · coming to you ·
//             ready with nobody on them)
//   (due) the stalls nobody is moving · an agent's own turns at
//             its day's ceiling
//   ONE row for the engines its agents run on that Silos refuses or
//             must catch up with (engineCompat — due when it refuses, else
//             routine): names + the door to Settings, never one per engine
//   …except a plan task that is a GATE (an agent's task waits directly on it)
//   or whose own `due` date is a week away: plans.silo.json's first entry
//   makes it `due` and its row says why — «unblocks 2 tasks of Writer», «due Nov
//   27» (a gate must never sit invisible among identical routine rows)
// Admission: a row enters only if a real signal backs it, the
// owner is the one who can make it leave, and it will not leave on its own
// before the owner would see it. Each new row below cites the fact that makes
// it true — never a guess about silence.
//
// Folding: a silo's due/routine rows past SILO_INBOX_BUDGET fold into one
// line per silo (as before) — except a sub-kind's rows (a plan's tasks,
// `parent` set), listed one by one for Home to group by parent; an AGENT's kernel due rows that carry a Seen
// (failed run, missed retry, unread messages, the ceiling, spend, the cut…)
// fold the same way past AGENT_INBOX_BUDGET. Blocking never folds. Approvals
// never fold either: their Approve/Skip IS the resolution, and a fold would
// hide the buttons. An agent's proposals fold BY AGENT past the same budget
// (S12): «X suggests <n> things ›», one row that opens
// its sheet, where Accept/Dismiss stays one touch per proposal.
//
// Seen means one thing everywhere: «I know about THIS version». A row that
// can be Seen carries `ack: { kind, key, version }`; the store
// (needs-you-acks.ts) remembers key → version, and a changed row (a new run
// id, a newer status, another day) comes back on its own.
import type { Automation, Run } from './automations-types.js'
import type { NeedsYouItem, EscalatedNeedsYou, MessageNeedsYou, SiloNeedsYou } from './needs-you.js'
import type { AckKind } from './needs-you-acks.js'
import { runFailure, type RunFailure } from './run-failure.js'
import type { ProposalKind } from './proposals.js'
import type { ProposalWords } from './proposals-view.js'
import type { EngineCompat } from './harness-run.js'
import { sealRowWords, type SealRow } from './seals.js'
import { TRANSCRIPT_UNREADABLE } from './heartbeat-audit.js'
import type { SpentBy, StartsBy } from './own-turns.js'
import { stallExit } from './silos/task-flow.js'

export type Urgency = 'blocking' | 'due' | 'routine'

// The resident's heartbeat (resident.ts DEFAULT_TICK_MS): a retry or a beat
// that is late by more than two of these provably did not happen.
export const RESIDENT_TICK_MS = 30_000

// a silo's due/routine rows listed one by one before they fold into one line
export const SILO_INBOX_BUDGET = 3
// an agent's foldable kernel due rows listed one by one before one line
export const AGENT_INBOX_BUDGET = 3
// past this many unfolded blocking + due rows the inbox says so, once
export const INBOX_CEILING = 12

export interface InboxAck {
  kind: AckKind
  key: string
  version: string
}

interface RowBase {
  key: string
  urgency: Urgency
  at: number // ms — the moment the row's signal was born (newest first within an urgency)
  // the row in plain words, for surfaces that have no page around them (the
  // digest, a notification body when names are allowed) — Home draws its own
  voice: string
  // what makes the row leave on its own (the source's clear), said plainly
  clears: string
  ack?: InboxAck
}

// the automation an approval / a run row names
export interface InboxAutomationRef {
  id: string
  name: string
  agentId: string
}

export type InboxRow = RowBase &
  // `permission`: what an OpenCode agent waits on — answerable in place.
  // `cwd`: the conversation's working dir (a project page scopes by it).
  (
    | {
        kind: 'ask'
        agentId: string
        folder: string
        id: string
        title: string
        cwd: string | null
        permission?: { id: string; type: string; pattern: string | null }
      }
    | { kind: 'approval'; agentId: string | null; run: Run; automation: InboxAutomationRef | null }
    // what an agent proposed (proposals.ts):
    // an automation, a skill or a change to its mission. `review`: only
    // «Review ›» (+ Dismiss) — every mission, an automation with a command;
    // else Accept · Dismiss. The words are the server's (proposals-view.ts):
    // the title, the brake of the effective provider, the fence, the audit's
    // «written after reading the web». `inputHash`: what the row showed — the
    // accept sends it back (S1-r4).
    | ({
        kind: 'proposal'
        agentId: string
        proposalId: string
        proposalKind: ProposalKind
        reason: string
        review: boolean
        inputHash: string
      } & ProposalWords)
    // an agent's proposals past AGENT_INBOX_BUDGET, as one line (S12)
    | { kind: 'proposalSummary'; agentId: string; count: number; proposalIds: string[] }
    | { kind: 'escalated'; agentId: string; item: EscalatedNeedsYou }
    | { kind: 'message'; agentId: string; item: MessageNeedsYou }
    // a silo's folded / over-budget rows as one line; byAgent counts them per
    // anchored agent (a project's Home counts only its agents' — support's
    // «13 support tickets wait on you»)
    // lets a project page count only its own agents' cases
    // `readOutside`: a plan task's question asked by an unattended run that
    // read outside (plans-origins 'ask' mark, m15) — «asked after reading the
    // web (WebFetch)», the row's door to the run
    | { kind: 'silo'; item: SiloNeedsYou; readOutside?: string }
    | {
        kind: 'siloSummary'
        silo: string
        siloName: string
        count: number
        agentIds: string[]
        folders: string[]
        noun?: { one: string; many: string }
        byAgent?: Record<string, number>
      }
    // A1 — an automation whose current state is a failure the owner must act on
    | { kind: 'failedRun'; agentId: string; automation: InboxAutomationRef; runId: string; failure: RunFailure; streak: number }
    // A1b — a usage limit belongs to the ACCOUNT, not to the automation: every
    // automation whose newest failure is that account's limit, in ONE row
    | { kind: 'accountLimit'; provider: string; account: string; window: AccountWindow | null; automations: InboxAutomationRef[]; agentIds: string[] }
    // A3c — a waiting_reset whose retry time passed two ticks ago with no newer run
    | { kind: 'missedRetry'; agentId: string; automation: InboxAutomationRef; runId: string; dueAt: string }
    // messages from one sender its recipient has not
    // read past its next chance to read them — one row per recipient·sender;
    // `why`: what kept its heartbeat from looking (an agent with one)
    | { kind: 'unreadMessages'; agentId: string; from: string; count: number; messageIds: string[]; why?: UnreadWhy; readOutside?: string }
    // an agent's foldable due rows past AGENT_INBOX_BUDGET, as one line
    | { kind: 'agentSummary'; agentId: string; count: number; newest: string; runsOnly: boolean }
    // (E6/P2) a ROUTINE line of tasks: wait for you to start their
    // agent · coming to you · ready with nobody on them — Yours to do / Working
    // now, never Needs you's lead nor the bell. `door` is the web path it opens.
    | {
        kind: 'taskLine'
        line: TaskLine
        count: number
        keys: string[]
        door: string
        items: Array<{ key: string; ref: string; title: string; owner: string; says?: string }>
      }
    // (B3, A2.5) the stalls nobody is woken for, as
    // ONE row: the distinct SEATS whose way out is this row (stallExit 'row')
    | { kind: 'tasksStalled'; count: number; keys: string[]; door: string; agentIds: string[] }
    // (A2.8) a conversation whose open console holds task wakes while nobody
    // uses it — one `due` row per conversation, its door that conversation
    | {
        kind: 'consoleIdle'
        agentId: string
        session: { id: string; folder: string | null; title: string | null }
        count: number
        keys: string[]
        heldSince: string
      }
    // (A1.6, B2.5) a task waiting on an agent Silos does not
    // carry the question to (no linked ask in reach): the owner relays it — one
    // `due` row per task, door the task
    | { kind: 'waitsOnRelay'; task: { key: string; ref: string; title: string; owner: string }; on: string; action: string; agentIds: string[] }
    // (A1.7) closed plans (plans/closed/) still holding open tasks — ONE routine row
    | { kind: 'closedPlansOpen'; count: number; plans: Array<{ key: string; title: string; folder: string | null; file: string; open: number }> }
    // (A1.8) a plan's tasks the reader could not build — one `due` row per plan
    | {
        kind: 'tasksUnreadable'
        plan: { key: string; id: string; title: string; folder: string | null; file: string }
        count: number
        reason: string
        first?: string
      }
    // an agent's own starts (task wakes, runs of its own
    // automations — never its heartbeat) at its day's
    // ceiling, or its spend at its cap; `why`: the breakdown under the head
    | {
        kind: 'ownTurnsCeiling'
        agentId: string
        used: number
        perDay: number
        waiting: number
        day: string
        until: string
        cap: 'ceiling' | 'spend'
        spentUsd: number
        why: string
        starts?: StartsBy
        spent?: SpentBy
      }
    | { kind: 'territoryOff'; agentId: string }
    // an in-play agent's folder that breaks the project folder rule
    // (project-folder.ts auditProjectFolders): said, never fixed — one due row
    // per agent folder, its door the agent's Runs on
    | { kind: 'folderRefused'; agentId: string; folder: string; reason: string }
    // a file right in the Projects folder an engine could load into every
    // project in it (project-folder.ts loadablesInProjectsFolder): said, never
    // fixed — one due row per file, its door a project's Memory
    | { kind: 'projectsFolderFile'; path: string; projectsFolder: string; projects: string[] }
    // turns of its day the $ cap could not count: no price
    | { kind: 'spend'; agentId: string; day: string; unpriced: number; models: string[] }
    | { kind: 'cut'; agentId: string; why: string }
    // the tasks that existed before Silos watched a folder:
    // one row per folder, its door «Keep them all ›» (its sheet lists them and
    // lets the owner leave some out)
    | { kind: 'plansBaseline'; folder: string; tasks: Array<{ key: string; title: string }> }
    // (fail closed) Silos could not read an unattended run's transcript:
    // it counts as read outside — tainted in a heartbeat — and says so here.
    // A run hangs from its automation; a task turn (a wake, a talk) from its
    // TASK — the task is the record of its turns
    | {
        kind: 'auditUnreadable'
        agentId: string
        heartbeat: boolean
        automation?: InboxAutomationRef
        runId?: string
        task?: { key: string; ref: string; title: string; session: string; turnId: string }
      }
    // the engines in use that are not ok (harness.ts compatibility): each
    // verdict with the agents on it; one row, its door Settings › Engines
    | { kind: 'engineCompat'; engines: Array<EngineCompat & { agentIds: string[] }>; agentIds: string[] }
    // the reserve engine runs agents on this machine but is not WIRED to
    // Silos: the two hooks that hand a conversation the owner opens its
    // inbox, write the birth marker and gate native crons are not in the
    // operator's settings.json. They install with one click (the first run's
    // Create wires them; Settings › Engines is the door) and Silos never
    // re-adds them by itself — this row is the honest state meanwhile.
    | { kind: 'engineUnwired'; engine: string; agentIds: string[] }
    | { kind: 'silosUpdate'; installed: string; latest: string; installKind: string; how: string }
    // the seal: a control file changed outside Silos, a
    // credential rotated, a plugin path set aside or edited, an engine config
    // changed. `seal` is the row as the seal keeps it (its id is what the
    // doors under /api/seals/rows/:id take), `doors` the words of its buttons,
    // `agentId` the agent it speaks for when there is one.
    | { kind: 'integrity'; seal: SealRow; doors: string[]; agentId: string | null }
  )

export type InboxRowKind = InboxRow['kind']

// ---------------------------------------------------------------------------
// A1 — failed runs, by class
// ---------------------------------------------------------------------------

// The class and the plain words of a failure live in run-failure.ts — the
// one reading Home and the Automations page share (re-exported here for
// the inbox's callers).
export { runFailure, type RunFailure, type RunFailureClass } from './run-failure.js'

// Consecutive failures, newest first — budget skips don't break a streak
// (nothing ran), anything else that ran does.
export function failureStreak(runs: readonly Run[]): { newest: Run | null; streak: number } {
  let newest: Run | null = null
  let streak = 0
  for (const r of runs) {
    if (r.status === 'skipped') continue
    if (r.status !== 'failed') break
    newest ??= r
    streak++
  }
  return { newest, streak }
}

// Will this automation run again on its own schedule? (a cron, a period or a
// watch with a next run on the books). A once / webhook / files /
// conversation trigger has nothing scheduled that could heal a failure.
function scheduledAgain(a: Pick<Automation, 'trigger' | 'nextRunAt'>): boolean {
  return (a.trigger.kind === 'cron' || a.trigger.kind === 'period' || a.trigger.kind === 'watch') && typeof a.nextRunAt === 'string' && a.nextRunAt !== ''
}

// The admission table, for the NEWEST failure of a streak:
//   config, rejected (400, unfinished turn), any other refusal   at once
//   command (a command run that failed — exit code, timeout)     at once
//   usage limit, no keepAlive          at once if nothing is scheduled, else on the 2nd in a row
//   timeout, prompt too long           on the 2nd in a row (one slow run is weather; the
//                                      resident rotates a too-long thread on its own)
//   interrupted by a Silos restart     never on its own (the next dispatch resumes it) —
//                                      but it counts toward «2 in a row»
// `waiting_reset` is not a failure at all (it heals itself) — see missedRetryRow.
export function admitsFailure(failure: RunFailure, streak: number, a: Pick<Automation, 'trigger' | 'nextRunAt'>): boolean {
  switch (failure.class) {
    case 'restart':
      return false
    case 'timeout':
    case 'too_long':
      return streak >= 2
    case 'limit':
      return !scheduledAgain(a) || streak >= 2
    default:
      return true
  }
}

function timesWord(n: number): string {
  return n <= 1 ? 'failed' : n === 2 ? 'failed twice' : `failed ${n} times in a row`
}

// `runs`: the automation's run history, newest first (a handful is enough).
// Null = no row: the automation is paused (the owner silenced it), its newest
// run is fine or still on its way, or the failure's class waits for a second.
export function failedRunRow(a: Automation, runs: readonly Run[], agentName: string): InboxRow | null {
  if (a.paused) return null
  const head = runs.find((r) => r.status !== 'skipped')
  if (!head || head.status !== 'failed') return null
  const { newest, streak } = failureStreak(runs)
  if (!newest) return null
  const failure = runFailure(newest.error, newest)
  if (!admitsFailure(failure, streak, a)) return null
  const at = Date.parse(newest.endedAt ?? newest.at) || Date.parse(newest.at) || 0
  return {
    kind: 'failedRun',
    key: `failed-run:${a.id}`,
    urgency: 'due',
    at,
    agentId: a.agentId,
    automation: { id: a.id, name: a.name, agentId: a.agentId },
    runId: newest.id,
    failure,
    streak,
    voice: `${a.name} ${timesWord(streak)} — ${failure.text} · ${agentName}`,
    clears: 'a newer run of it ends well, or it is paused or deleted',
    ack: { kind: 'run', key: a.id, version: newest.id },
  }
}

// ---------------------------------------------------------------------------
// A1b — the account hit its limit
// ---------------------------------------------------------------------------
// A usage limit is a fact about an ACCOUNT (its 5-hour, weekly or per-model
// window), never about the automation that ran into it: once one weekly
// Fable window produced a failed-run row per automation, each with Claude
// Code's raw «You've reached your Fable limit», and none said which account
// or when it would be free. So the limit failures of every automation that
// ran on one account fold into ONE row that names the account, the window
// and its reset — the face Home shows until the standard's step 2 makes the
// limit episode a kernel record.
//
// Admission, per account:
//   a reading shows a window at its limit (not yet reset)   at once — the limit is a fact
//   a reading NEWER than the failures shows none            no row: the account is free and the
//                                                           next scheduled run heals each one
//   no reading (not a subscription account, or unread)      the A1 table: limit waits for the 2nd in a row
// An automation with nothing scheduled again never heals by itself: once the
// account is free it keeps its own failed-run row (failedRunRow), because
// only the owner can run it again.

// the window holding an account back, as the inbox says it
export interface AccountWindow {
  label: string
  percent: number
  resetsAt: string | null
}

// a subscription reading (harnesses/claude-code/plan-usage.ts PlanUsage, ok
// branch), in the shape this neutral module needs; null = no reading
export interface AccountUsage {
  at: number
  windows: readonly { label: string; percent: number; resetsAt: string | null; active: boolean }[]
}

export interface LimitedAutomation {
  automation: Automation
  runs: readonly Run[] // newest first
  provider: string // the account its runs ran on (normalised id)
}

// the window at its limit right now, or null (a passed reset is not a limit)
export function limitedWindow(u: AccountUsage, now: number): AccountWindow | null {
  const atLimit = u.windows.filter((w) => w.percent >= 100 && (w.resetsAt === null || Date.parse(w.resetsAt) > now))
  const w = atLimit.find((x) => x.active) ?? atLimit[0]
  return w ? { label: w.label, percent: Math.round(w.percent), resetsAt: w.resetsAt } : null
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// «at 06:00» today, «tomorrow at 06:00», else «Sat at 06:00» — local time
export function resetWords(iso: string, now: number): string {
  const t = Date.parse(iso)
  const d = new Date(t)
  const day = (ms: number): string => localDay(ms)
  const at = `at ${hhmm(t)}`
  if (day(t) === day(now)) return at
  if (day(t) === day(now + 86_400_000)) return `tomorrow ${at}`
  return `${WEEKDAY[d.getDay()]} ${at}`
}

function namesWords(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

// Splits the limit failures into one row per account, plus the failed-run
// rows of the ones that only the owner can heal (see the table above).
export function accountLimitRows(
  items: readonly LimitedAutomation[],
  f: { usageOf: (provider: string) => AccountUsage | null; labelOf: (provider: string) => string; nameOf: (agentId: string) => string; now: number },
): InboxRow[] {
  const out: InboxRow[] = []
  const byProvider = new Map<string, LimitedAutomation[]>()
  for (const it of items) byProvider.set(it.provider, [...(byProvider.get(it.provider) ?? []), it])
  for (const [provider, group] of byProvider) {
    const failing = group.flatMap((it) => {
      if (it.automation.paused) return []
      const head = it.runs.find((r) => r.status !== 'skipped')
      if (!head || head.status !== 'failed' || runFailure(head.error, head).class !== 'limit') return []
      const { newest, streak } = failureStreak(it.runs)
      if (!newest) return []
      const at = Date.parse(newest.endedAt ?? newest.at) || Date.parse(newest.at) || 0
      return [{ ...it, newest, streak, at }]
    })
    if (failing.length === 0) continue
    const usage = f.usageOf(provider)
    const window = usage ? limitedWindow(usage, f.now) : null
    const newestAt = Math.max(...failing.map((x) => x.at))
    let members = failing
    if (!window && usage && usage.at > newestAt) {
      // the account is free again: only what won't run again by itself stays, one by one
      for (const x of failing) {
        if (scheduledAgain(x.automation)) continue
        const row = failedRunRow(x.automation, x.runs, f.nameOf(x.automation.agentId))
        if (row) out.push(row)
      }
      continue
    }
    if (!window) members = failing.filter((x) => admitsFailure({ class: 'limit', text: '' }, x.streak, x.automation))
    if (members.length === 0) continue
    const account = f.labelOf(provider)
    const names = members.map((x) => x.automation.name)
    const head = window
      ? `${account}: ${window.label} at ${window.percent}%${window.resetsAt ? ` — resets ${resetWords(window.resetsAt, f.now)}` : ''}`
      : `${account} hit its usage limit`
    out.push({
      kind: 'accountLimit',
      key: `account-limit:${provider}`,
      urgency: 'due',
      at: Math.max(...members.map((x) => x.at)),
      provider,
      account,
      window,
      automations: members.map((x) => ({ id: x.automation.id, name: x.automation.name, agentId: x.automation.agentId })),
      agentIds: [...new Set(members.map((x) => x.automation.agentId))],
      voice: `${head} · ${members.length === 1 ? `${names[0]} couldn't run` : `${members.length} automations couldn't run: ${namesWords(names)}`}`,
      clears: window ? 'the window resets, or the runs end well again' : 'a newer run of each ends well, or they are paused',
      // Seen = this episode: the window's reset names it; without a reading,
      // the newest failed run does (a new failure is a new version)
      ack: {
        kind: 'limit',
        key: provider.replace(/[^\w.-]/g, '.'),
        version: window?.resetsAt ?? [...members].sort((a, b) => b.at - a.at)[0]!.newest.id,
      },
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// A3c — a retry that never happened
// ---------------------------------------------------------------------------

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// A `waiting_reset` run is the resident's promise to retry at its reset
// (resident.ts retryWaitingReset, fired once `nextRunAt` passes). When that
// moment is more than two ticks behind us and it is still the newest run,
// SILOS failed: the retry didn't happen. A paused automation never retries
// (the owner paused it) — no row.
export function missedRetryRow(a: Automation, latest: Run | null, now: number, agentName: string, tickMs = RESIDENT_TICK_MS): InboxRow | null {
  if (a.paused || !latest || latest.status !== 'waiting_reset') return null
  const times = [latest.resetsAt, a.nextRunAt].map((s) => (s ? Date.parse(s) : NaN)).filter((n) => !Number.isNaN(n))
  if (times.length === 0) return null
  const due = Math.max(...times)
  if (now - due <= 2 * tickMs) return null
  return {
    kind: 'missedRetry',
    key: `missed-retry:${a.id}`,
    urgency: 'due',
    at: due,
    agentId: a.agentId,
    automation: { id: a.id, name: a.name, agentId: a.agentId },
    runId: latest.id,
    dueAt: new Date(due).toISOString(),
    voice: `${a.name} was due to retry at ${hhmm(due)} and didn't · ${agentName}`,
    clears: 'any newer run of it',
    ack: { kind: 'run', key: a.id, version: latest.id },
  }
}

// local calendar day — the run budget's own day (automations-store runsToday)
export function localDay(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Messages nobody read at their next chance
// ---------------------------------------------------------------------------

// A message is read at the recipient's next conversation (R9) and «read» is
// the server's mark. The row's threshold is the recipient's NEXT
// CHANCE to read it: an agent with no heartbeat (Only when told, On its own ·
// never) — MESSAGE_UNREAD_ROW without any conversation listing it; an agent
// whose heartbeat looks (own·day, own·week) — only once its next heartbeat
// after the message PASSED without marking it read (m6-r7: skipped or
// failed — a heartbeat with a turn that ended with output marks it), and the
// row says why. The owner is no postman for a system that already has an
// hour to read (R10).
export const MESSAGE_UNREAD_ROW = 24 * 3600_000

// (a heartbeat is never held by the ceiling, so
// «its ceiling was spent» no longer happens; busy, engine and spend have
// their own words — q1 arbitration)
// noProject: held — its sender is an agent the recipient does not know
// (project-scope.ts servable): it is never served while they share no project
export type UnreadWhy = 'sleeping' | 'busy' | 'engine' | 'spend' | 'account' | 'failed' | 'noProject'
const UNREAD_WHY_WORDS: Record<UnreadWhy, string> = {
  sleeping: 'it was sleeping',
  busy: 'it was busy',
  engine: "its engine couldn't run",
  spend: 'its spend cap was reached',
  account: 'its account was at its limit',
  failed: 'its turn failed',
  noProject: 'they share no project',
}

/** Why the first heartbeat run after a message passed without marking it —
 *  from the run as the resident wrote it (its skip, else a failed or
 *  outputless turn). */
export function unreadWhyOf(run: Pick<Run, 'status'> & { heartbeat?: { skipped?: string } }): UnreadWhy {
  const s = run.heartbeat?.skipped
  if (s === 'sleeping' || s === 'busy' || s === 'engine' || s === 'spend' || s === 'account') return s
  return 'failed'
}

// how long something has waited, as a row says it: «40 min», «3 h», «2 d»
export function waitedWords(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}

/** One row per recipient·sender: the messages past their threshold (the
 *  caller admits them). Seen per message: a newer one brings it back. */
export function unreadMessagesRow(f: {
  recipientId: string
  recipientName: string
  from: string
  fromName: string
  messages: ReadonlyArray<{ id: string; at: number; readOutside?: readonly string[] }>
  why?: UnreadWhy
  now: number
}): InboxRow | null {
  if (f.messages.length === 0) return null
  const sorted = [...f.messages].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  const oldest = sorted[0]!
  const newest = sorted[sorted.length - 1]!
  const n = sorted.length
  const tools = [...new Set(sorted.flatMap((m) => m.readOutside ?? []))]
  const outside = tools.length > 0 ? `sent after reading the web (${tools.join(', ')})` : undefined
  const sender = f.from === 'owner' ? 'you' : f.fromName
  return {
    kind: 'unreadMessages',
    key: `unread-messages:${f.recipientId}/${f.from}`,
    urgency: 'due',
    at: newest.at,
    agentId: f.recipientId,
    from: f.from,
    count: n,
    messageIds: sorted.map((m) => m.id),
    ...(f.why ? { why: f.why } : {}),
    ...(outside ? { readOutside: outside } : {}),
    voice:
      f.why === 'noProject'
        ? `${sender} wrote to ${f.recipientName} — ${UNREAD_WHY_WORDS.noProject}: ${n === 1 ? 'the message is' : `${n} messages are`} held, never served · ${waitedWords(f.now - oldest.at)}`
        : `${f.recipientName} hasn't read ${n} message${n === 1 ? '' : 's'} from ${sender}${outside ? ` — ${outside}` : ''} · ${waitedWords(f.now - oldest.at)}${f.why ? ` — it hasn't looked yet: ${UNREAD_WHY_WORDS[f.why]}` : ''}`,
    clears: 'the messages are read or answered',
    ack: { kind: 'message', key: `${f.recipientId}/${f.from}`, version: newest.id },
  }
}

// ---------------------------------------------------------------------------
// Tasks: the routine lines, the stalls nobody moves, the ceiling
// ---------------------------------------------------------------------------

// One plan task as the kernel reads it at the composition's moment (the
// Plans silo's voice — index.ts taskFlows): its record key, its plan's key,
// whose, its state, whether `ready` holds, its flow and its turn sentence.
export interface TaskFlowFact {
  key: string
  planKey: string
  ref: string
  title: string
  owner: string
  state: string
  ready: boolean
  flow: {
    stalled: boolean
    stalledCause: string | null
    stalledBy: string | null
    stalledAt: string | null
    waitsStart: boolean
    idle: boolean
    waitsOnRelay?: boolean
    waitsOn?: { owner: string; action: string; asked?: string } | null
  }
  sentence?: string
}

export type TaskLine = 'waitsStart' | 'comingToYou' | 'idle'
const OPEN_TASK = (s: string): boolean => s !== 'done' && s !== 'cancelled'
// (E1) the task is the SEAT of its own stall — «stalled» as
// the owner's readers read it: a task waiting on another's stall is not
const isOwnSeat = (f: Pick<TaskFlowFact, 'key' | 'planKey' | 'flow'>): boolean =>
  f.flow.stalled && f.flow.stalledAt !== null && f.key === `${f.planKey}/tasks/${f.flow.stalledAt}`

// The three ROUTINE lines (E6, G4; P2): never Needs you's
// lead, never the bell (routine), counted by the digest.
//   waitsStart   «N tasks wait for you to start their agent ›» — Yours to do
//   comingToYou  «Coming to you · N» — the owner's tasks not ready yet, each
//                with what it waits on in words — Yours to do, a still fold;
//                never one that is its own stall's seat (A2.6, E1: that one is
//                tasksStalled's — a task waiting on another's stall stays)
//   idle         «N tasks ready, nobody on them ›» — Working now's last line
// One row per line with tasks, keyed by the line (no Seen: each task leaves
// on its own when it moves).
export function taskLineRows(facts: readonly TaskFlowFact[], now: number): InboxRow[] {
  const lines: Array<{ line: TaskLine; of: TaskFlowFact[]; door: string; voice: (n: number) => string; clears: string }> = [
    {
      line: 'waitsStart',
      of: facts.filter((f) => OPEN_TASK(f.state) && f.flow.waitsStart),
      door: '/tasks?view=start',
      voice: (n) => `${n} task${n === 1 ? '' : 's'} not started — ${n === 1 ? 'it opens' : 'they open'} with you`,
      clears: 'you open its agent on it (its door), or it moves',
    },
    {
      line: 'comingToYou',
      of: facts.filter((f) => f.owner === 'owner' && OPEN_TASK(f.state) && !f.ready && !isOwnSeat(f)),
      door: '/tasks?view=mine',
      voice: (n) => `Coming to you · ${n}`,
      clears: 'what it waits on is done — then it is yours to do',
    },
    {
      line: 'idle',
      of: facts.filter((f) => OPEN_TASK(f.state) && f.flow.idle),
      door: '/tasks?view=idle',
      voice: (n) => `${n} task${n === 1 ? '' : 's'} not started — nobody is on ${n === 1 ? 'it' : 'them'}`,
      clears: 'you start its agent on it («Start X ›», «Open console ›» / «Open chat ›»), or a conversation takes it',
    },
  ]
  const out: InboxRow[] = []
  for (const l of lines) {
    if (l.of.length === 0) continue
    out.push({
      kind: 'taskLine',
      key: `task-line:${l.line}`,
      urgency: 'routine',
      at: now,
      line: l.line,
      count: l.of.length,
      keys: l.of.map((f) => f.key),
      door: l.door,
      items: l.of.map((f) => ({ key: f.key, ref: f.ref, title: f.title, owner: f.owner, ...(f.sentence ? { says: f.sentence } : {}) })),
      voice: l.voice(l.of.length),
      clears: l.clears,
    })
  }
  return out
}

// B3 — the stalls nobody will move (A2.5): the distinct
// SEATS whose one way out is this row (task-flow.ts stallExit 'row') —
// nobody owns it, a person's, an agent Silos does not wake on its tasks, an
// owner that cannot run. A bound seat's way out is its wake (task mode
// escalates its own — escalation/); a task whose seat is another is never
// counted (its seat is, once), nor one parked BY a task waiting for its start
// (its fix is that start, already a line of Yours to do). ONE due row,
// «N tasks sit untouched — nobody is moving them ›», Seen for this set.
export function tasksStalledRow(
  facts: readonly TaskFlowFact[],
  f: { isAgent: (id: string) => boolean; isBound: (id: string) => boolean; now: number },
): InboxRow | null {
  const stalled = facts.filter(
    (x) =>
      OPEN_TASK(x.state) && isOwnSeat(x) && stallExit(x.flow, { id: x.flow.stalledAt!, owner: x.owner, bound: (o) => f.isAgent(o) && f.isBound(o) }) === 'row',
  )
  if (stalled.length === 0) return null
  const keys = stalled.map((x) => x.key).sort()
  const n = stalled.length
  // (R3) a task whose owner works in another project: nobody here moves it,
  // and the way out is to give it to an agent of its own project — said
  const outside = stalled.filter((x) => x.flow.stalledCause === 'owner-outside-project').length
  const nobody = `nobody is moving ${n === 1 ? 'it' : 'them'}`
  const why =
    outside === 0
      ? nobody
      : outside === n
        ? `${n === 1 ? 'its owner works' : 'their owners work'} in another project; give ${n === 1 ? 'it' : 'them'} to an agent of ${n === 1 ? 'its' : 'their'} own`
        : `${nobody}; ${outside} with an owner from another project`
  return {
    kind: 'tasksStalled',
    key: 'tasks-stalled',
    urgency: 'due',
    at: f.now,
    count: n,
    keys,
    door: '/tasks?view=untouched',
    // only agents (a person's or nobody's seat names none)
    agentIds: [...new Set(stalled.map((x) => x.owner).filter((o) => o !== '' && f.isAgent(o)))],
    voice: `${n} task${n === 1 ? ' sits' : 's sit'} untouched — ${why}`,
    clears: 'each task gets an explicit disposition, or its agent moves it',
    ack: { kind: 'tasksStalled', key: 'tasks', version: keys.join(',') },
  }
}

// (A1.6, amended by B2.5) a task whose wait names an AGENT
// (bound, told, archived, its own owner — never Silos' own «unstick …») and
// that Silos does not carry there (flow.waitsOnRelay: no ask linked to it,
// or the asked agent has no heartbeat in reach — task-flow.ts askLinked /
// askReaches): the wait is the OWNER's to relay — one `due` row per task, «X
// waits on Y — <action>», its door the task (a wait naming the task's own
// owner: «X wrote a wait on itself — <action>»; the row's eyebrow says the ref
// and «you relay» — who waits on whom is said once, here). The task stays
// guarded (it waits). An ask Silos carries is no row: the asked agent sees it
// by itself.
export function waitsOnRelayRows(facts: readonly TaskFlowFact[], f: { nameOf: (id: string) => string; now: number }): InboxRow[] {
  const out: InboxRow[] = []
  for (const x of facts) {
    const w = x.flow.waitsOn
    if (!OPEN_TASK(x.state) || x.flow.waitsOnRelay !== true || !w) continue
    const what = w.asked && w.asked.trim() !== '' ? w.asked.trim() : w.action.trim() !== '' ? w.action.trim() : x.title
    const who = x.owner === '' ? 'A task' : x.owner === 'owner' ? 'Your task' : f.nameOf(x.owner)
    out.push({
      kind: 'waitsOnRelay',
      key: `waits-on-relay:${x.key}`,
      urgency: 'due',
      at: f.now,
      task: { key: x.key, ref: x.ref, title: x.title, owner: x.owner },
      on: w.owner,
      action: what,
      agentIds: [...new Set([x.owner, w.owner].filter((a) => a !== '' && a !== 'owner'))],
      voice: w.owner === x.owner ? `${who} wrote a wait on itself — ${what}` : `${who} waits on ${f.nameOf(w.owner)} — ${what}`,
      clears: `the wait leaves ${x.ref} (its owner, or you, clears it), or the task closes`,
    })
  }
  return out
}

// (A2.8) a conversation whose open console holds task wakes
// while nobody uses it: read from Task mode's store ALONE — wakes queued with
// hold class `console`, the conversation that holds them (`holdSession`,
// absent when the console probe failed: never said open), the first pass
// held so (`heldSince`) — never a tmux probe at read time. One `due` row per
// conversation when its THREAD is not live (threadLive — after a /clear the
// one moving is a descendant) and its oldest heldSince is at least `busyMs`
// (CONVERSATION_BUSY_MS) old; door that conversation, Seen by (conversation,
// oldest heldSince) — a new hold episode comes back on its own.
export interface ConsoleHeldWake {
  agent: string
  task: string
  holdClass?: string
  holdSession?: string
  heldSince?: string
}
export function idleConsoleRows(
  wakes: readonly ConsoleHeldWake[],
  f: {
    threadLive: (ids: readonly string[]) => boolean
    busyMs: number
    sessionOf: (id: string) => { title: string | null; folder: string | null } | null
    nameOf: (id: string) => string
    now: number
  },
): InboxRow[] {
  const by = new Map<string, ConsoleHeldWake[]>()
  for (const w of wakes) {
    if (w.holdClass !== 'console' || !w.holdSession || !w.heldSince || Number.isNaN(Date.parse(w.heldSince))) continue
    by.set(w.holdSession, [...(by.get(w.holdSession) ?? []), w])
  }
  const out: InboxRow[] = []
  for (const [session, ws] of by) {
    const oldest = ws.reduce((a, w) => (Date.parse(w.heldSince!) < Date.parse(a) ? w.heldSince! : a), ws[0]!.heldSince!)
    if (f.now - Date.parse(oldest) < f.busyMs) continue
    if (f.threadLive([session])) continue
    const s = f.sessionOf(session)
    const agentId = ws[0]!.agent
    const n = ws.length
    out.push({
      kind: 'consoleIdle',
      key: `console-idle:${session}`,
      urgency: 'due',
      at: Date.parse(oldest),
      agentId,
      session: { id: session, folder: s?.folder ?? null, title: s?.title ?? null },
      count: n,
      keys: [...new Set(ws.map((w) => w.task))].sort(),
      heldSince: oldest,
      voice: `${f.nameOf(agentId)}'s console${s?.title ? ` on «${s.title}»` : ''} is open and idle — ${n} wake${n === 1 ? ' waits' : 's wait'} for it`,
      clears: 'you use its console or close it, or its wakes go',
      ack: { kind: 'consoleIdle', key: session, version: oldest },
    })
  }
  return out
}

// (A1.7) plans moved to plans/closed/ that still hold open
// tasks: nothing reads them live (they never enter a list, nobody wakes on
// them) — ONE routine row that says so, with a door to each plan.
export function closedPlansOpenRow(
  plans: ReadonlyArray<{ key: string; title: string; folder: string | null; file: string; open: number }>,
  now: number,
): InboxRow | null {
  const with_ = plans.filter((p) => p.open > 0)
  if (with_.length === 0) return null
  const n = with_.length
  return {
    kind: 'closedPlansOpen',
    key: 'closed-plans-open',
    urgency: 'routine',
    at: now,
    count: n,
    plans: with_.map((p) => ({ key: p.key, title: p.title, folder: p.folder, file: p.file, open: p.open })),
    voice: `${n} closed plan${n === 1 ? ' still has' : 's still have'} open tasks`,
    clears: 'their tasks are closed, or the plan comes back to plans/',
  }
}

// (A1.8) tasks a plan file holds that the reader could not
// build: they are in no list, no flow, no wake — one `due` row per plan,
// «N tasks in <plan> can't be read», with the reason of the first, its door
// the plan. The reader keeps what it accepts; the row only says it.
export function tasksUnreadableRows(
  plans: ReadonlyArray<{
    key: string
    id: string
    title: string
    folder: string | null
    file: string
    tasks: ReadonlyArray<{ id: string | null; reason: string }>
  }>,
  now: number,
): InboxRow[] {
  const out: InboxRow[] = []
  for (const p of plans) {
    if (p.tasks.length === 0) continue
    const n = p.tasks.length
    const first = p.tasks[0]!
    const name = p.title.trim() !== '' ? p.title : p.id
    out.push({
      kind: 'tasksUnreadable',
      key: `tasks-unreadable:${p.key}`,
      urgency: 'due',
      at: now,
      plan: { key: p.key, id: p.id, title: name, folder: p.folder, file: p.file },
      count: n,
      reason: first.reason,
      ...(first.id !== null ? { first: first.id } : {}),
      voice: `${n} task${n === 1 ? '' : 's'} in ${name} can't be read — ${first.id !== null ? `${first.id}: ` : ''}${first.reason}`,
      clears: 'the plan file is fixed and every task reads again',
    })
  }
  return out
}

// (R7) an agent at its day's ceiling — or its spend cap —
// on its own: one due row per agent, Seen per day, with its doors («Let it
// continue today — lifts today's turn and spend caps», «Raise ›», «See today
// ›»). (D5) The row says WHY — the head, and under it
// what the count (or the money) was made of.
export function ownTurnsCeilingRow(f: {
  agentId: string
  agentName: string
  used: number
  perDay: number
  waiting: number
  until: string
  day: string
  now: number
  cap?: 'ceiling' | 'spend'
  spentUsd?: number
  starts?: StartsBy
  spent?: SpentBy
}): InboxRow {
  const cap = f.cap ?? 'ceiling'
  const waits = f.waiting > 0 ? ` · ${f.waiting} wait for tomorrow` : ''
  return {
    kind: 'ownTurnsCeiling',
    key: `own-turns-ceiling:${f.agentId}`,
    urgency: 'due',
    at: f.now,
    agentId: f.agentId,
    used: f.used,
    perDay: f.perDay,
    waiting: f.waiting,
    day: f.day,
    until: f.until,
    cap,
    spentUsd: f.spentUsd ?? 0,
    why: ownCapWhy(cap, f.starts, f.spent),
    ...(f.starts ? { starts: f.starts } : {}),
    ...(f.spent ? { spent: f.spent } : {}),
    // the head says what happened: the count really used (after the owner
    // lowers the max it is above it), the same records as the line under it
    voice:
      cap === 'ceiling'
        ? `${f.agentName} started ${f.used} ${f.used === 1 ? 'time' : 'times'} without you today — its max${f.used > f.perDay ? ` is ${f.perDay}` : ''}${waits}`
        : `${f.agentName} spent $${(f.spentUsd ?? 0).toFixed(2)} without you today — its cap`,
    clears: 'midnight, «Let it continue today», or a higher number in its Limits, on its page',
    ack: { kind: 'ownTurns', key: f.agentId, version: f.day },
  }
}

/** The line under the ceiling's and the spend cap's head: the
 *  ceiling — «7 task starts · 3 runs of its own automations. The
 *  max keeps one agent from spending the day by itself.»; the spend cap —
 *  «$3.10 task starts · $1.90 heartbeat · $0.40 its automations». A part
 *  that is zero is left out; no breakdown at all, no line (''). */
export function ownCapWhy(cap: 'ceiling' | 'spend', starts?: StartsBy, spent?: SpentBy): string {
  if (cap === 'ceiling') {
    if (!starts) return ''
    const parts: string[] = []
    if (starts.wakes > 0) parts.push(`${starts.wakes} task ${starts.wakes === 1 ? 'start' : 'starts'}`)
    if (starts.self > 0) parts.push(`${starts.self} ${starts.self === 1 ? 'run' : 'runs'} of its own automations`)
    return `${parts.length > 0 ? `${parts.join(' · ')}. ` : ''}The max keeps one agent from spending the day by itself.`
  }
  if (!spent) return ''
  const usd = (n: number): string => `$${n.toFixed(2)}`
  const parts: string[] = []
  if (spent.wakes > 0) parts.push(`${usd(spent.wakes)} task starts`)
  if (spent.heartbeat > 0) parts.push(`${usd(spent.heartbeat)} heartbeat`)
  if (spent.self > 0) parts.push(`${usd(spent.self)} its automations`)
  return parts.join(' · ')
}

// (G5) turns of an agent's day without a
// price: counted and said, never held — one due row per agent and day, Seen
export function unpricedSpendRow(f: { agentId: string; agentName: string; day: string; unpriced: number; models: readonly string[]; now: number }): InboxRow {
  const models = [...new Set(f.models)]
  return {
    kind: 'spend',
    key: `spend-unpriced:${f.agentId}`,
    urgency: 'due',
    at: f.now,
    agentId: f.agentId,
    day: f.day,
    unpriced: f.unpriced,
    models,
    voice: `${f.agentName}: ${f.unpriced} unpriced today${models.length > 0 ? ` (${models.join(', ')})` : ''} — the $ cap can't count them; the plan's usage line is the brake`,
    clears: 'midnight',
    ack: { kind: 'spend', key: f.agentId, version: f.day },
  }
}

// (G5-r7, m1) an agent On its own whose
// territory turned off: it is Only when told until the territory is on —
// the row is the door; turning it on brings the heartbeat back by itself
export function territoryOffRow(f: { agentId: string; agentName: string; now: number }): InboxRow {
  return {
    kind: 'territoryOff',
    key: `territory-off:${f.agentId}`,
    urgency: 'due',
    at: f.now,
    agentId: f.agentId,
    voice: `${f.agentName}'s territory turned off — it is Only when told until it is on again ›`,
    clears: 'its territory is on again, or you set it Only when told',
  }
}

// a folder that breaks the project folder rule (project-folder.ts): the
// reason in the check's own words; it leaves when the folder changes
export function folderRefusedRow(f: { agentId: string; agentName: string; folder: string; reason: string; now: number }): InboxRow {
  return {
    kind: 'folderRefused',
    key: `folder-refused:${f.agentId}:${f.folder}`,
    urgency: 'due',
    at: f.now,
    agentId: f.agentId,
    folder: f.folder,
    reason: f.reason,
    voice: `${f.agentName} works in a folder no project may have: ${f.reason}`,
    clears: 'the agent gets another folder (its Runs on), or it is archived',
  }
}

// a file right in the Projects folder an engine loads into every project
// inside it: the owner's to keep or move; it leaves when the file does.
// `projects`: the registered projects it reaches (the door: their Memory,
// where the file shows with its off switch)
export function projectsFolderFileRow(f: { path: string; projectsFolder: string; projects: readonly string[]; now: number }): InboxRow {
  return {
    kind: 'projectsFolderFile',
    key: `projects-folder-file:${f.path}`,
    urgency: 'due',
    at: f.now,
    path: f.path,
    projectsFolder: f.projectsFolder,
    projects: [...f.projects],
    voice: `${f.path} sits in the Projects folder — every project in it loads it`,
    clears: 'the file leaves the Projects folder',
  }
}

// Silos cut the agent's capability of creating work on its own:
// «Allow again» (cut: null) or «Keep stopped» (Seen)
export function cutRow(f: { agentId: string; agentName: string; cut: { at: string; why: string; run?: string }; now: number }): InboxRow {
  return {
    kind: 'cut',
    key: `cut:${f.agentId}`,
    urgency: 'due',
    at: Date.parse(f.cut.at) || f.now,
    agentId: f.agentId,
    why: f.cut.why,
    voice: `Silos stopped ${f.agentName} from creating work on its own — ${f.cut.why}`,
    clears: 'you allow it again, or keep it stopped',
    ack: { kind: 'cut', key: f.agentId, version: f.cut.at },
  }
}

// The baseline's block door: the tasks found at a
// folder's first watch are `unknown` until blessed — one due row per folder
// instead of N touches for the operator's own history. It leaves when they
// are kept (or done/cancelled).
export function plansBaselineRow(f: { folder: string; tasks: Array<{ key: string; title: string }>; now: number }): InboxRow {
  const n = f.tasks.length
  return {
    kind: 'plansBaseline',
    key: `plans-baseline:${f.folder}`,
    urgency: 'due',
    at: f.now,
    folder: f.folder,
    tasks: f.tasks,
    voice: `${n} task${n === 1 ? '' : 's'} existed before Silos watched this folder — Keep them all ›`,
    clears: 'you keep them (all, or some), or they are done',
  }
}

/** «asked after reading the web (WebFetch)» — the ask row's mark (m15). */
export function askedOutsideWords(tools: readonly string[] | null | undefined): string | null {
  return tools && tools.length > 0 ? `asked after reading the web (${tools.join(', ')})` : null
}

// (fail closed) the audit could not read the run's transcript: an
// unreadable transcript is indistinguishable from a tampered one, so the run
// counts as having read outside — and the owner SEES it, never a silent
// verdict. Seen acks it; a newer run of the automation replaces it.
export function auditUnreadableRow(
  a: Pick<Automation, 'id' | 'name' | 'agentId'>,
  run: Run,
  f: { agentName: string; heartbeat: boolean; now: number },
): InboxRow | null {
  if (!run.audit?.readOutside.includes(TRANSCRIPT_UNREADABLE)) return null
  const what = f.heartbeat ? `${f.agentName}'s heartbeat` : `${f.agentName}'s ${a.name}`
  return {
    kind: 'auditUnreadable',
    key: `audit-unreadable:${a.id}`,
    urgency: 'due',
    at: Date.parse(run.endedAt ?? run.at) || f.now,
    agentId: a.agentId,
    automation: { id: a.id, name: a.name, agentId: a.agentId },
    runId: run.id,
    heartbeat: f.heartbeat,
    voice: `Silos couldn't read the transcript of ${what} — transcript unreadable, so it counts as having read outside${f.heartbeat ? ' — what it created is undone' : ''}`,
    clears: 'you mark it seen, or a newer run of it',
    ack: { kind: 'audit', key: a.id, version: run.id },
  }
}

// the same for a task turn: its row hangs from the task (ref + the session
// the turn ran in); Seen by that turn, a newer audited turn on the task
// replaces it
export function taskAuditUnreadableRow(f: {
  agentId: string
  agentName: string
  task: { key: string; ref: string; title: string; session: string; turnId: string }
  at: string
  now: number
}): InboxRow {
  return {
    kind: 'auditUnreadable',
    key: `audit-unreadable:task:${f.task.key}`,
    urgency: 'due',
    at: Date.parse(f.at) || f.now,
    agentId: f.agentId,
    heartbeat: false,
    task: f.task,
    voice: `Silos couldn't read the transcript of ${f.agentName}'s turn on ${f.task.ref} «${f.task.title}» — transcript unreadable, so it counts as having read outside`,
    clears: 'you mark it seen, or a newer turn on the task',
    ack: { kind: 'audit', key: `task:${f.task.key}`, version: f.task.turnId },
  }
}

// ---------------------------------------------------------------------------
// an agent proposes
// ---------------------------------------------------------------------------
// Admission: the proposal is pending (a real file-borne fact), only the owner
// can make it leave (Accept / Review's save / Dismiss — the agent may
// withdraw it, and Silos expires it at 14 d), and nothing else will. Due.

/** What a pending proposal brings to the composition: the fact plus the
 *  server's words (proposals-view.ts proposalWords). */
export interface ProposalFacts {
  id: string
  by: string
  at: string
  kind: ProposalKind
  reason: string
  review: boolean
  inputHash: string
  words: ProposalWords
}

export function proposalRow(p: ProposalFacts, nameOf: (agentId: string) => string): InboxRow {
  const w = p.words
  const mark = w.readOutside ? ` · ${w.readOutside}` : ''
  const voice =
    p.kind === 'skill'
      ? `${nameOf(p.by)} ${w.skillOf ? `changed a skill of ${w.skillOf}` : 'wrote a skill'}: ${w.title} — ${p.reason}${mark}`
      : // (R6) a crossing is said with the title, before the rhythm and the why
        `${nameOf(p.by)} suggests ${w.title}${w.crosses ? ` — outside its projects: ${w.crosses}` : ''}${w.brake ? ` · ${w.brake}` : ''} — ${p.reason}${mark}`
  return {
    kind: 'proposal',
    key: `proposal:${p.id}`,
    urgency: 'due',
    at: Date.parse(p.at) || 0,
    agentId: p.by,
    proposalId: p.id,
    proposalKind: p.kind,
    reason: p.reason,
    review: p.review,
    inputHash: p.inputHash,
    ...w,
    voice,
    clears: p.review ? 'you review and save it, or dismiss it (or the agent withdraws it)' : 'you accept it or dismiss it (or the agent withdraws it)',
  }
}

// ---------------------------------------------------------------------------
// an engine Silos refuses (older than its minimum, missing) or must
// catch up with (newer than the client library it ships). The fact: the
// adapter's verdict (harness.ts compatibility, kept warm every tick). Only
// an engine an agent in play runs on is a row — an engine nobody uses waits
// for nobody. It clears when the engine (or Silos) is updated; the owner is
// the one who can do that, so it carries no Seen.
// ---------------------------------------------------------------------------

export function engineCompatRow(
  verdicts: readonly EngineCompat[],
  f: { agents: readonly { id: string; harness: string }[]; nameOf: (agentId: string) => string; now: number },
): InboxRow | null {
  const engines = verdicts.flatMap((v) => {
    if (v.state === 'ok') return []
    const agentIds = f.agents.filter((a) => a.harness === v.harness).map((a) => a.id)
    return agentIds.length > 0 ? [{ ...v, agentIds }] : []
  })
  if (engines.length === 0) return null
  const refuses = engines.some((e) => e.refuses.length > 0)
  const agentIds = [...new Set(engines.flatMap((e) => e.agentIds))]
  return {
    kind: 'engineCompat',
    key: 'engine-compat',
    urgency: refuses ? 'due' : 'routine',
    at: f.now,
    engines,
    agentIds,
    voice:
      engines.length === 1
        ? `${engines[0]!.message ?? `${engines[0]!.name} needs an update`}${engines[0]!.refuses.length > 0 ? ` · ${namesWords(engines[0]!.agentIds.map(f.nameOf))} can't run on it` : ''}`
        : `${engines.length} engines need an update: ${engines.map((e) => e.name).join(', ')}`,
    clears: 'the engine (or Silos) is updated',
  }
}

// the reserve engine unwired (its Silos hooks missing from the operator's
// settings): ONE routine row, only while an agent runs on that engine —
// without one, nothing on this machine depends on the wiring.
// a newer Silos is published: ONE routine row, never due (an update stops
// nothing — the row that stops things is engineCompat 'ahead'). The key
// carries the version, so a new release is a new row (the signature moves).
// It clears by updating, which only the owner can do: no Seen.
export function silosUpdateRow(
  u: { installed: string; latest: string | null; newer: boolean; kind: string; how: string } | null,
  now: number,
): InboxRow | null {
  if (!u || !u.newer || u.latest === null) return null
  return {
    kind: 'silosUpdate',
    key: `silos-update:${u.latest}`,
    urgency: 'routine',
    at: now,
    installed: u.installed,
    latest: u.latest,
    installKind: u.kind,
    how: u.how,
    voice: `Silos ${u.latest} is out (this is ${u.installed}) — ${u.how}`,
    clears: 'this install is updated',
  }
}

export function engineUnwiredRow(
  wired: boolean,
  f: { engine: string; harnessId: string; agents: readonly { id: string; harness: string }[]; now: number },
): InboxRow | null {
  if (wired) return null
  const agentIds = f.agents.filter((a) => a.harness === f.harnessId).map((a) => a.id)
  if (agentIds.length === 0) return null
  return {
    kind: 'engineUnwired',
    key: 'engine-unwired',
    urgency: 'routine',
    at: f.now,
    engine: f.engine,
    agentIds,
    voice: `${f.engine} isn't wired to Silos — a conversation you open starts without the agent's inbox, the birth marker or the cron gate`,
    clears: 'its hooks are installed (Settings › Engines)',
  }
}

// ---------------------------------------------------------------------------
// the seal's rows (seals.ts) — all due; each leaves by
// its own door (Keep the edit / Discard / Put back / Delete / Seen)
// ---------------------------------------------------------------------------

export function sealInboxRows(rows: readonly SealRow[], nameOf: (agentId: string) => string): InboxRow[] {
  return rows.map((seal) => {
    const { text, doors } = sealRowWords(seal, nameOf)
    const agentId = 'agentId' in seal ? seal.agentId : seal.kind === 'configChanged' ? (seal.agentIds[0] ?? null) : null
    return {
      kind: 'integrity' as const,
      key: `integrity:${seal.id}`,
      urgency: 'due' as const,
      at: isoMs(seal.at),
      seal,
      doors,
      agentId,
      voice: text,
      clears: doors.length > 0 ? `you choose: ${doors.join(' · ')}` : 'you mark it seen',
    }
  })
}

// ---------------------------------------------------------------------------
// the composition
// ---------------------------------------------------------------------------

// a conversation waiting on an answer: the overview's pendingAsk (both
// engines) ∪ the Board's needs_you (the chat engine's context.pending)
export interface SessionAsk {
  agentId: string
  folder: string
  id: string
  title: string
  at: number
  cwd: string | null
}

export interface InboxInput {
  nameOf: (agentId: string) => string
  // in priority order — the first row for a conversation wins
  asks: readonly SessionAsk[]
  // the file-borne sources (needs-you.ts) and the active silos
  needsYou: readonly NeedsYouItem[]
  // runs in waiting_approval
  pending: readonly Run[]
  // the agents' pending proposals (proposals.ts), with their words
  proposals?: readonly ProposalFacts[]
  automations: readonly Pick<Automation, 'id' | 'name' | 'agentId'>[]
  // the kernel rows (failedRunRow, missedRetryRow, unreadMessagesRow…)
  kernel: readonly InboxRow[]
  // the owner's Seen: key → the version they saw (needs-you-acks.ts)
  ackedVersion?: (kind: AckKind, key: string) => string | null
  // the composition's clock (callers pass the board's; default: now)
  now?: number
  // a plan task's last question asked by an unattended run that read
  // outside (plans-origins 'ask' marks, m15): the tools, or null
  askedOutside?: (key: string) => readonly string[] | null
}

const isoMs = (s: string): number => Date.parse(s) || 0

export function rowAgentName(nameOf: (id: string) => string, id: string | null | undefined): string {
  return id ? nameOf(id) : 'an agent'
}

// the kernel kinds whose due rows fold per agent (failed runs, missed
// retries, unread messages, the ceiling, spend, the cut — and the seal's
// rows of an agent's config/plugin, m10-r7; proposals fold apart, below)
const AGENT_FOLDABLE: ReadonlySet<InboxRowKind> = new Set([
  'failedRun',
  'missedRetry',
  'unreadMessages',
  'ownTurnsCeiling',
  'territoryOff',
  'cut',
  'auditUnreadable',
  'spend',
  'integrity',
  'folderRefused',
])

const URGENCY_RANK: Record<Urgency, number> = { blocking: 0, due: 1, routine: 2 }
// the standard's floor: kernel asks and escalations always on top of their urgency
// within one urgency: a direct question first, then the concrete rows, and an
// aggregate summary («3 tasks stalled», a wake ceiling) after the rows it
// summarises — a count never pushes a dated task of yours off the tile
const FLOOR: Partial<Record<InboxRowKind, number>> = { ask: 0, escalated: 0, message: 0, tasksStalled: 2, ownTurnsCeiling: 2, taskLine: 2, engineCompat: 2 }

export function composeInbox(input: InboxInput): InboxRow[] {
  const { nameOf } = input
  const out: InboxRow[] = []
  const seen = new Set<string>()
  const push = (r: InboxRow): void => {
    if (seen.has(r.key)) return
    if (r.ack && input.ackedVersion?.(r.ack.kind, r.ack.key) === r.ack.version) return
    seen.add(r.key)
    out.push(r)
  }
  const askRow = (a: SessionAsk, permission?: { id: string; type: string; pattern: string | null }): InboxRow => ({
    kind: 'ask',
    key: `ask:${a.folder}\0${a.id}`,
    urgency: 'blocking',
    at: a.at,
    agentId: a.agentId,
    folder: a.folder,
    id: a.id,
    title: a.title,
    cwd: a.cwd,
    ...(permission ? { permission } : {}),
    voice: permission
      ? `${nameOf(a.agentId)} asks for a permission${permission.pattern ? `: ${permission.type} ${permission.pattern}` : ''}`
      : `${nameOf(a.agentId)} has a question for you`,
    clears: 'the question is answered',
  })

  // asks: a permission ask first (it carries Allow / Deny, so it wins the
  // conversation's key), newest first; then the conversations' own asks.
  const permissionAsks = input.needsYou.flatMap((n) => (n.kind === 'ask' ? [n] : [])).sort((a, b) => b.at.localeCompare(a.at))
  const cwdOf = new Map(input.asks.map((a) => [`${a.folder}\0${a.id}`, a.cwd]))
  for (const n of permissionAsks) {
    push(
      askRow(
        { agentId: n.agentId, folder: n.folder, id: n.sessionId, title: n.title, at: isoMs(n.at), cwd: cwdOf.get(`${n.folder}\0${n.sessionId}`) ?? null },
        { id: n.id, type: n.type, pattern: n.pattern },
      ),
    )
  }
  for (const a of input.asks) push(askRow(a))

  for (const r of input.pending) {
    const au = input.automations.find((a) => a.id === r.automationId)
    const automation = au ? { id: au.id, name: au.name, agentId: au.agentId } : null
    push({
      kind: 'approval',
      key: `approval:${r.id}`,
      urgency: 'due',
      at: isoMs(r.at),
      agentId: automation?.agentId ?? null,
      run: r,
      automation,
      voice: `${rowAgentName(nameOf, automation?.agentId)} wants your go to run ${automation?.name ?? 'an automation'}`,
      clears: 'you approve or skip it',
    })
  }

  // an agent's proposals fold WITH its other foldable rows: see
  // the per-agent pass below
  const proposalsBy = new Map<string, ProposalFacts[]>()
  for (const p of input.proposals ?? []) proposalsBy.set(p.by, [...(proposalsBy.get(p.by) ?? []), p])

  for (const n of input.needsYou) {
    switch (n.kind) {
      case 'message':
        push({
          kind: 'message',
          key: `message:${n.agentId}/${n.messageId}`,
          urgency: 'blocking',
          at: isoMs(n.at),
          agentId: n.agentId,
          item: n,
          voice: `${nameOf(n.agentId)} needs you about a message from ${n.from === 'owner' ? 'you' : nameOf(n.from)}`,
          clears: 'someone marks the message read or answered',
        })
        break
      case 'escalated':
        push({
          kind: 'escalated',
          key: `escalated:${n.agentId}`,
          urgency: 'blocking',
          at: isoMs(n.at),
          agentId: n.agentId,
          item: n,
          voice: `${nameOf(n.agentId)} escalated to you: ${n.summary}`,
          clears: 'a newer status from the agent',
          ack: { kind: 'escalated', key: n.agentId, version: n.at },
        })
        break
      default:
        break // asks above, silos below with their budget
    }
  }
  // silos: blocking rows (conflicts, proposals, submissions, blocking
  // entries) one by one; a silo's due/routine entries one by one up to its
  // budget, else — and for folded ones — one summary line per silo
  // (catalogs.md: the budget folds only due/routine).
  const siloRow = (n: SiloNeedsYou): InboxRow => ({
    kind: 'silo',
    key: `silo:${n.reason}:${n.silo}:${n.key}${n.proposal ? `#${n.proposal.id}` : n.conflict ? `#${n.conflict.field}` : ''}`,
    // a conflict nobody wins in silence; a proposal or a submission waits on a decision
    urgency: n.reason === 'conflict' ? 'blocking' : n.reason === 'entry' ? n.urgency : n.urgency === 'blocking' ? 'blocking' : 'due',
    at: isoMs(n.at),
    item: n,
    ...(() => {
      const w = askedOutsideWords(input.askedOutside?.(n.key))
      return w ? { readOutside: w } : {}
    })(),
    voice: `${n.siloName}: ${n.text}`,
    clears: n.clears ?? 'the record changes state',
  })
  const bySilo = new Map<string, SiloNeedsYou[]>()
  for (const n of input.needsYou) {
    if (n.kind !== 'silo') continue
    if (n.urgency === 'blocking' || n.reason !== 'entry') {
      push(siloRow(n))
      continue
    }
    // a sub-kind's row (a plan's task) is said one by one: Home groups such
    // rows by their parent (G5) — the budget would fold a fleet's plans into
    // one line. Its fold (an idle parent) rides the item for Home to say.
    if (n.parent) {
      push(siloRow(n))
      continue
    }
    bySilo.set(n.silo, [...(bySilo.get(n.silo) ?? []), n])
  }
  for (const [silo, items] of bySilo) {
    const open = items.filter((n) => !n.folded)
    if (open.length > 0 && open.length === items.length && open.length <= SILO_INBOX_BUDGET) {
      for (const n of open) push(siloRow(n))
    } else {
      const due = items.some((n) => n.urgency === 'due')
      push({
        kind: 'siloSummary',
        key: `silo-summary:${silo}`,
        urgency: due ? 'due' : 'routine',
        at: Math.max(...items.map((n) => isoMs(n.at))),
        silo,
        siloName: items[0]!.siloName,
        count: items.length,
        agentIds: [...new Set(items.flatMap((n) => (n.agentId ? [n.agentId] : [])))],
        folders: [...new Set(items.flatMap((n) => (n.folder ? [n.folder] : [])))],
        ...(items[0]!.noun ? { noun: items[0]!.noun } : {}),
        // per anchored agent, when every row has one and none anchors to a folder
        ...(items.every((n) => n.agentId && !n.folder)
          ? { byAgent: items.reduce<Record<string, number>>((m, n) => ({ ...m, [n.agentId!]: (m[n.agentId!] ?? 0) + 1 }), {}) }
          : {}),
        // the kind's noun when the manifest says it (support: «13 support
        // tickets wait on you»), else the silo's items
        voice: items[0]!.noun
          ? `${items.length} ${items.length === 1 ? items[0]!.noun.one : items[0]!.noun.many} ${items.length === 1 ? 'waits' : 'wait'} on you`
          : `${items.length} ${items[0]!.siloName} item${items.length === 1 ? ' waits' : 's wait'} on you`,
        clears: "each record's own clear",
      })
    }
  }

  // the new kernel rows: an agent's foldable due rows one by one up to its
  // budget, else one line for the agent (Seen ones already left above).
  const byAgent = new Map<string, InboxRow[]>()
  for (const r of input.kernel) {
    if (r.ack && input.ackedVersion?.(r.ack.kind, r.ack.key) === r.ack.version) continue
    if (r.urgency !== 'due' || !AGENT_FOLDABLE.has(r.kind) || !('agentId' in r) || typeof r.agentId !== 'string') {
      push(r)
      continue
    }
    byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r])
  }
  // proposals are AGENT_FOLDABLE too: within the agent's budget every
  // row stays loose; past it, ONE pending proposal keeps its own row and
  // several fold into «X suggests <n> things ›» — the other rows fold as ever
  for (const [agentId, ps] of proposalsBy) {
    const rows = byAgent.get(agentId) ?? []
    const loose = rows.length + ps.length <= AGENT_INBOX_BUDGET || ps.length === 1
    if (loose) {
      for (const p of ps) push(proposalRow(p, nameOf))
      continue
    }
    const sorted = [...ps].sort((a, b) => b.at.localeCompare(a.at))
    push({
      kind: 'proposalSummary',
      key: `proposal-summary:${agentId}`,
      urgency: 'due',
      at: Date.parse(sorted[0]!.at) || 0,
      agentId,
      count: ps.length,
      proposalIds: sorted.map((p) => p.id),
      voice: `${nameOf(agentId)} suggests ${ps.length} things`,
      clears: 'each proposal is decided on its own',
    })
  }
  for (const [agentId, rows] of byAgent) {
    if (rows.length <= AGENT_INBOX_BUDGET) {
      for (const r of rows) push(r)
      continue
    }
    const sorted = [...rows].sort((a, b) => b.at - a.at)
    const newest = sorted[0]!
    const runsOnly = rows.every((r) => r.kind === 'failedRun')
    const newestWords = newest.kind === 'failedRun' ? `${newest.automation.name} (${newest.failure.text})` : newest.voice
    push({
      kind: 'agentSummary',
      key: `agent-summary:${agentId}`,
      urgency: 'due',
      at: newest.at,
      agentId,
      count: rows.length,
      newest: newestWords,
      runsOnly,
      voice: runsOnly
        ? `${nameOf(agentId)}: ${rows.length} automations failing — newest: ${newestWords}`
        : `${nameOf(agentId)}: ${rows.length} things need you — newest: ${newestWords}`,
      clears: 'each of its rows clears on its own',
    })
  }

  return out.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || (FLOOR[a.kind] ?? 1) - (FLOOR[b.kind] ?? 1) || b.at - a.at)
}

// The inbox ceiling health line: past INBOX_CEILING unfolded
// blocking + due rows the inbox says so once — «14 rows — more than anyone
// reads; the oldest have waited 3 days». Null under the ceiling.
export function inboxCeiling(rows: readonly Pick<InboxRow, 'urgency' | 'at'>[]): { count: number; oldestAt: number } | null {
  const loud = rows.filter((r) => r.urgency === 'blocking' || r.urgency === 'due')
  if (loud.length <= INBOX_CEILING) return null
  const ats = loud.map((r) => r.at).filter((t) => t > 0)
  return { count: loud.length, oldestAt: ats.length > 0 ? Math.min(...ats) : 0 }
}

// What identifies the inbox's content: each row's key and version. Two
// compositions with the same signature say the same thing — the server
// tells the open page (and, later, the doorbell) only when it changes.
export function inboxSignature(rows: readonly InboxRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.key}=${r.ack?.version ?? ''}${r.kind === 'siloSummary' || r.kind === 'agentSummary' || r.kind === 'proposalSummary' || r.kind === 'taskLine' || r.kind === 'tasksStalled' ? `#${r.count}` : ''}${r.kind === 'engineCompat' ? `#${r.engines.map((e) => `${e.harness}:${e.state}:${e.installed}:${e.agentIds.join('+')}`).join(',')}` : ''}`,
    )
    .sort()
    .join('\n')
}
