// inbox-source.ts — reads the facts behind the inbox's kernel rows (A1
// failed runs, A3c missed retries, messages unread past their recipient's
// next chance to read them, the ceiling, spend, the cut…) from the stores that hold them, and
// hands them to inbox.ts's pure builders. Nothing here decides admission:
// the builders do, so a test can pin each rule with plain data.
import { localYmd } from './control.js'
import type { Agent } from './types.js'
import type { AutomationsStore } from './automations-store.js'
import type { AgentStateStore } from './agent-state.js'
import type { MessageStore } from './messages.js'
import type { Automation, Run } from './automations-types.js'
import type { OwnCapHit } from './own-turns.js'
import { MASTER_ID } from './agent-registry.js'
import {
  failedRunRow,
  missedRetryRow,
  auditUnreadableRow,
  taskAuditUnreadableRow,
  unreadMessagesRow,
  unreadWhyOf,
  territoryOffRow,
  cutRow,
  plansBaselineRow,
  MESSAGE_UNREAD_ROW,
  accountLimitRows,
  runFailure,
  RESIDENT_TICK_MS,
  taskLineRows,
  tasksStalledRow,
  ownTurnsCeilingRow,
  unpricedSpendRow,
  waitsOnRelayRows,
  closedPlansOpenRow,
  tasksUnreadableRows,
  idleConsoleRows,
  type ConsoleHeldWake,
  type InboxRow,
  type AccountUsage,
  type LimitedAutomation,
  type TaskFlowFact,
} from './inbox.js'

// how much run history a failure streak needs (newest first): enough to see
// "twice in a row" past a few budget skips
const STREAK_WINDOW = 12

export interface KernelInboxDeps {
  agents: readonly Agent[] // non-archived
  automations?: AutomationsStore
  agentState?: AgentStateStore
  messages?: MessageStore
  // why a stored `own` operates as told
  // right now — its territory off — or null (control.ts degradedWhy)
  degradedWhy?: (agent: Agent) => 'territory' | 'mission' | null
  nameOf: (agentId: string) => string
  now: number
  tickMs?: number
  // A1b: which account an automation's runs ran on (normalised provider id),
  // that account's last subscription reading (never a fetch — the caller
  // warms it), and how to name the account. Without providerOf, limit
  // failures stay per-automation rows as before.
  providerOf?: (a: Automation) => string
  usageOf?: (provider: string) => AccountUsage | null
  labelOf?: (provider: string) => string
  // whether the agent's heartbeat looks (its DERIVED control is own
  // and its rhythm day/week) — its next chance to read a message is its next
  // heartbeat; without one (told, own·never) it is MESSAGE_UNREAD_ROW. And
  // its heartbeat's runs, newest first. Without them, every agent is the
  // 24 h kind.
  heartbeatLooks?: (agent: Agent) => boolean
  heartbeatRuns?: (agentId: string) => readonly Run[]
  // the agent's engine is refused right now
  // (harness.ts peekRefusal): its automations' retries wait for the engine,
  // said once by the engineCompat row — never a missedRetry row each
  engineRefused?: (agentId: string) => boolean
  // every plan task with its flow, as the Plans silo's
  // voice evaluates it now (the evaluation taskFlowRecords uses) — the task
  // lines (routine) and the stalls nobody moves (due). Without it, none.
  taskFlows?: () => readonly TaskFlowFact[]
  // the agents Silos wakes on their tasks (Task mode bound) — their stalls
  // are the escalation's, never «nobody is moving them»
  isBoundToTasks?: (agentId: string) => boolean
  // whether a task's owner is an agent at all (archived ones included — an
  // archived agent's task is a stall nobody moves); default: in play
  isAgent?: (id: string) => boolean
  // the agents whose own turns hit the day's ceiling or spend cap
  // (TaskModeEngine.ceilingHits). Without it, no ceiling row.
  // an agent's day on its own (own-turns.ts): its unpriced turns make a row
  ownToday?: (agentId: string) => { unpriced: number; unpricedModels?: string[] } | null
  ownTurnsCeilings?: () => ReadonlyArray<OwnCapHit>
  // (fail closed) the tasks whose newest audited turn could not be
  // read (task-mode/store.ts unreadableAudits)
  taskAuditsUnreadable?: () => ReadonlyArray<{ task: string; agent: string; ref: string; title: string; session: string; turnId: string; at: string }>
  // the baseline's tasks still unknown, one entry per
  // folder (initiative.ts baseline)
  plansBaseline?: () => ReadonlyArray<{ folder: string; tasks: Array<{ key: string; title: string }> }>
  // the closed plans (plans/closed/) with how many
  // open tasks each still holds — read for this row only, never a list
  closedPlans?: () => ReadonlyArray<{ key: string; title: string; folder: string | null; file: string; open: number }>
  // (A1.8) per plan, the tasks its file holds that the reader could not build
  tasksUnreadable?: () => ReadonlyArray<{
    key: string
    id: string
    title: string
    folder: string | null
    file: string
    tasks: ReadonlyArray<{ id: string | null; reason: string }>
  }>
  // Task mode's queued wakes (its store) and the
  // conversation facts the idle-console row reads — threadLive and the 2 h
  // rule (conversation-live.ts CONVERSATION_BUSY_MS) from index.ts, a
  // session's title and folder; without both, no row
  queuedWakes?: () => readonly ConsoleHeldWake[]
  conversations?: {
    threadLive: (ids: readonly string[]) => boolean
    busyMs: number
    sessionOf: (id: string) => { title: string | null; folder: string | null } | null
  }
}

export function agentNameOf(agents: readonly Pick<Agent, 'id' | 'name'>[]): (id: string) => string {
  return (id) => (id === MASTER_ID ? 'Anywhere' : (agents.find((a) => a.id === id)?.name ?? id))
}

export function kernelInboxRows(d: KernelInboxDeps): InboxRow[] {
  const out: InboxRow[] = []
  const live = new Set(d.agents.map((a) => a.id))
  const tickMs = d.tickMs ?? RESIDENT_TICK_MS

  // A1 + A3c: one look at each automation's newest run (an O(1) cache); the
  // history is read only when that run is a failure or a skip.
  const limited: LimitedAutomation[] = []
  if (d.automations) {
    for (const a of d.automations.list()) {
      if (!live.has(a.agentId)) continue
      try {
        const latest = d.automations.latestRun(a.id)
        if (!latest) continue
        // (fail closed) its transcript could not be read: say so
        if (latest.audit) {
          const row = auditUnreadableRow(a, latest, { agentName: d.nameOf(a.agentId), heartbeat: a.origin === 'heartbeat', now: d.now })
          if (row) out.push(row)
        }
        if (latest.status === 'waiting_reset') {
          if (d.engineRefused?.(a.agentId)) continue
          const row = missedRetryRow(a, latest, d.now, d.nameOf(a.agentId), tickMs)
          if (row) out.push(row)
        } else if (latest.status === 'failed' || latest.status === 'skipped') {
          const runs = d.automations.listRuns(a.id, STREAK_WINDOW)
          const head = runs.find((r) => r.status !== 'skipped')
          if (d.providerOf && head?.status === 'failed' && runFailure(head.error, head).class === 'limit') {
            limited.push({ automation: a, runs, provider: d.providerOf(a) })
            continue
          }
          const row = failedRunRow(a, runs, d.nameOf(a.agentId))
          if (row) out.push(row)
        }
      } catch (err) {
        console.warn(`inbox: could not read the runs of automation ${a.id} —`, err instanceof Error ? err.message : err)
      }
    }
  }

  // A1b: the limit failures, one row per account
  if (limited.length > 0) {
    out.push(
      ...accountLimitRows(limited, {
        usageOf: d.usageOf ?? (() => null),
        labelOf: d.labelOf ?? ((p) => p),
        nameOf: d.nameOf,
        now: d.now,
      }),
    )
  }

  // an agent On its own whose territory turned off — it
  // operates as told until it is on again — and an agent Silos
  // stopped from creating work on its own
  for (const agent of d.agents) {
    try {
      if (d.degradedWhy?.(agent) === 'territory') out.push(territoryOffRow({ agentId: agent.id, agentName: d.nameOf(agent.id), now: d.now }))
      if (agent.cut) out.push(cutRow({ agentId: agent.id, agentName: d.nameOf(agent.id), cut: agent.cut, now: d.now }))
    } catch (err) {
      console.warn(`inbox: could not read the control of ${agent.id} —`, err instanceof Error ? err.message : err)
    }
  }

  // messages nobody read at their recipient's next chance — one row
  // per recipient·sender (the threshold by rhythm, the why from its heartbeat)
  if (d.messages) {
    for (const agent of d.agents) {
      try {
        out.push(...unreadMessageRows(d, agent))
      } catch (err) {
        console.warn(`inbox: could not read the inbox of ${agent.id} —`, err instanceof Error ? err.message : err)
      }
    }
  }
  // the task lines (routine), the stalls nobody moves (due) and
  // the agents at their task-wake ceiling (due)
  if (d.taskFlows) {
    try {
      const facts = d.taskFlows()
      out.push(...taskLineRows(facts, d.now))
      const row = tasksStalledRow(facts, { isAgent: d.isAgent ?? ((id) => live.has(id)), isBound: (id) => d.isBoundToTasks?.(id) === true, now: d.now })
      if (row) out.push(row)
      // (A1.6) the waits on an agent the owner relays for now
      out.push(...waitsOnRelayRows(facts, { nameOf: d.nameOf, now: d.now }))
    } catch (err) {
      console.warn('inbox: could not read the tasks —', err instanceof Error ? err.message : err)
    }
  }
  if (d.queuedWakes && d.conversations) {
    try {
      const c = d.conversations
      out.push(
        ...idleConsoleRows(
          d.queuedWakes().filter((w) => live.has(w.agent)),
          { threadLive: c.threadLive, busyMs: c.busyMs, sessionOf: c.sessionOf, nameOf: d.nameOf, now: d.now },
        ),
      )
    } catch (err) {
      console.warn('inbox: could not read the consoles holding wakes —', err instanceof Error ? err.message : err)
    }
  }
  if (d.taskAuditsUnreadable) {
    for (const a of d.taskAuditsUnreadable()) {
      if (!live.has(a.agent)) continue
      out.push(
        taskAuditUnreadableRow({
          agentId: a.agent,
          agentName: d.nameOf(a.agent),
          task: { key: a.task, ref: a.ref, title: a.title, session: a.session, turnId: a.turnId },
          at: a.at,
          now: d.now,
        }),
      )
    }
  }
  if (d.ownTurnsCeilings) {
    for (const c of d.ownTurnsCeilings()) {
      if (!live.has(c.agent)) continue
      out.push(
        ownTurnsCeilingRow({
          agentId: c.agent,
          agentName: d.nameOf(c.agent),
          used: c.used,
          perDay: c.perDay,
          waiting: c.waiting,
          until: c.until,
          day: c.day,
          now: d.now,
          cap: c.cap,
          spentUsd: c.spentUsd,
          ...(c.starts ? { starts: c.starts } : {}),
          ...(c.spent ? { spent: c.spent } : {}),
        }),
      )
    }
  }
  if (d.ownToday) {
    const day = localYmd(d.now)
    for (const id of live) {
      const t = d.ownToday(id)
      if (t && t.unpriced > 0)
        out.push(unpricedSpendRow({ agentId: id, agentName: d.nameOf(id), day, unpriced: t.unpriced, models: t.unpricedModels ?? [], now: d.now }))
    }
  }
  if (d.closedPlans) {
    try {
      const row = closedPlansOpenRow(d.closedPlans(), d.now)
      if (row) out.push(row)
    } catch (err) {
      console.warn('inbox: could not read the closed plans —', err instanceof Error ? err.message : err)
    }
  }
  if (d.tasksUnreadable) {
    try {
      out.push(...tasksUnreadableRows(d.tasksUnreadable(), d.now))
    } catch (err) {
      console.warn("inbox: could not read the plans' unreadable tasks —", err instanceof Error ? err.message : err)
    }
  }
  if (d.plansBaseline) {
    try {
      for (const b of d.plansBaseline()) if (b.tasks.length > 0) out.push(plansBaselineRow({ folder: b.folder, tasks: b.tasks, now: d.now }))
    } catch (err) {
      console.warn('inbox: could not read the plans baseline —', err instanceof Error ? err.message : err)
    }
  }
  return out
}

// An agent's unread messages past their threshold, one row per sender.
// Without a heartbeat that looks: still `new` MESSAGE_UNREAD_ROW after they
// came. With one: only once the FIRST heartbeat run after a message ended
// (skipped, failed, or a turn that did not mark it) — the row says why.
function unreadMessageRows(d: KernelInboxDeps, agent: Agent): InboxRow[] {
  const fresh = d.messages!.list(agent.id, 'new')
  if (fresh.length === 0) return []
  const looks = d.heartbeatLooks?.(agent) === true
  const runs = looks ? [...(d.heartbeatRuns?.(agent.id) ?? [])] : []
  const bySender = new Map<string, { messages: Array<{ id: string; at: number; readOutside?: string[] }>; why?: ReturnType<typeof unreadWhyOf> }>()
  for (const m of fresh) {
    const at = Date.parse(m.at) || 0
    let why: ReturnType<typeof unreadWhyOf> | undefined
    if (looks) {
      // the first heartbeat after the message that has ENDED (not running)
      const next = runs
        .filter((r) => r.status !== 'running' && (Date.parse(r.startedAt ?? r.at) || 0) > at)
        .sort((x, y) => (Date.parse(x.startedAt ?? x.at) || 0) - (Date.parse(y.startedAt ?? y.at) || 0))[0]
      if (!next) continue // its next chance has not come yet
      why = unreadWhyOf(next as Run & { heartbeat?: { skipped?: string } })
    } else if (d.now - at < MESSAGE_UNREAD_ROW) continue
    const g = bySender.get(m.from) ?? { messages: [] }
    g.messages.push({ id: m.id, at, ...(m.readOutside ? { readOutside: m.readOutside } : {}) })
    // the why of the newest message's missed chance
    if (why) g.why = why
    bySender.set(m.from, g)
  }
  const out: InboxRow[] = []
  for (const [from, g] of bySender) {
    const row = unreadMessagesRow({
      recipientId: agent.id,
      recipientName: d.nameOf(agent.id),
      from,
      fromName: d.nameOf(from),
      messages: g.messages,
      ...(g.why ? { why: g.why } : {}),
      now: d.now,
    })
    if (row) out.push(row)
  }
  return out
}

// The accounts whose reading the inbox will want (A1b): every account an
// automation whose newest run failed on a usage limit ran on. The board
// route warms these before composing, so the row can name the window.
export function limitedProviders(automations: AutomationsStore, live: ReadonlySet<string>, providerOf: (a: Automation) => string): string[] {
  const out = new Set<string>()
  for (const a of automations.list()) {
    if (a.paused || !live.has(a.agentId)) continue
    try {
      const latest = automations.latestRun(a.id)
      if (latest?.status === 'failed' && runFailure(latest.error).class === 'limit') out.add(providerOf(a))
    } catch {
      /* unreadable runs: no reading needed */
    }
  }
  return [...out]
}
