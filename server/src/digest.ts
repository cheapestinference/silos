// digest.ts — the daily digest, composed by the
// PLATFORM: counts and real rows, never prose, no LLM, no agent, never an
// automation run, zero tokens. Pure: the job (digest-job.ts) hands in the
// inbox (app.composeInbox — the same rows Home and the doorbell read) and
// the facts the server already indexes (app.digestFacts); this file adds
// them up.
//
// Three blocks:
//   waits     the inbox by urgency and its oldest wait — a SNAPSHOT at the
//             hour, so it never sums across digests
//   happened  since the last digest: conversations finished per agent,
//             urgent messages agents worked in conversations of their own
//             (origin message — never counted as «conversations finished»;
//             HISTORY: no longer written — no message wakes anyone: only conversations born before it),
//             automation runs split acted / no news / failed, failures that
//             healed on their own (they never reached the inbox — the digest
//             owns up to them), silo records that reached a terminal state
//             (the journal's «closed» — a plan's tasks among them since the
//             Plans silo is built in; digests written before still
//             carry their own «plan tasks done» and are summed as written)
//   coming    the silo Horizon: records whose `due` falls within 7 days, when
//             an active silo's kind declares the `due` role; absent otherwise
// A file per day, <dataDir>/digests/<YYYY-MM-DD>.json — auditable, survives
// restarts. Several unread files SUM into one band (`sumDigests`): the
// happened counts add up; waits and coming are the newest file's.
import type { InboxRow, InboxRowKind } from './inbox.js'
import type { Run } from './automations-types.js'

export interface DigestConversations {
  agentId: string
  name: string
  count: number
}
export interface DigestRuns {
  agentId: string
  name: string
  runs: number // every run that ended in the window (ok + failed)
  acted: number // ok, and the agent said it acted
  noNews: number // ok, and the agent said there was nothing to do
  ok: number // ok without an OUTCOME line (older runs, unclassified)
  failed: number // failed, and its automation is still failing
  recovered: number // failed, and a later run of the same automation ended ok
}
export interface DigestSiloDone {
  silo: string
  siloName: string
  to: string
  label: string
  count: number
}
export interface DigestHorizon {
  silo: string
  siloName: string
  kind: string
  count: number
  firstDue: string
}

export interface DigestFile {
  version: 1
  date: string // the local day of the hour it was composed for
  hour: string // 'HH:MM'
  from: string // ISO — the window starts where the previous digest ended
  to: string // ISO — the moment it was composed
  late?: true // composed after its hour (Silos was down, or the hour moved)
  // `lines`: the task lines at the hour (inbox taskLine — «Coming to you · 15»,
  // «3 tasks ready, nobody on them»), each by its count; never counted in
  // blocking/due/routine (P6). Absent: none (and in older digests).
  waits: {
    blocking: number
    due: number
    routine: number
    oldest: { at: string; kind: InboxRowKind; voice: string } | null
    lines?: Array<{ line: string; count: number; voice: string }>
  }
  happened: {
    conversations: DigestConversations[]
    // agents that worked urgent messages in their own conversations (absent
    // in older digests; HISTORY: no longer written — no message wakes anyone)
    messages?: DigestConversations[]
    runs: DigestRuns[]
    // plan tasks done (older digests: the diff of two snapshots);
    // null since the Plans silo — its tasks close in `silos`, by the journal
    planTasksDone: number | null
    silos: DigestSiloDone[]
  }
  coming: DigestHorizon[] | null // null: no active silo declares `due`
  // the done plan tasks at composition (older digests); [] since —
  // kept so every digest on disk reads with one shape
  planDone: string[]
}

// What the server indexes for a window (server.ts digestFacts).
export interface DigestFacts {
  nameOf: (agentId: string) => string
  // owner conversations (no automation, not nested) whose last activity fell
  // in the window and that are no longer live
  conversations: readonly { agentId: string }[]
  // conversations Silos opened for urgent messages, same window rule (history)
  messageConversations?: readonly { agentId: string }[]
  // runs that ENDED in the window, with what their automation did since
  runs: readonly { agentId: string; run: Run; healedLater: boolean }[]
  siloDone: readonly { silo: string; siloName: string; to: string; label: string }[]
  horizon: readonly DigestHorizon[] | null
}

export interface DigestInput {
  date: string
  hour: string
  from: number
  to: number
  late: boolean
  inbox: readonly InboxRow[]
  facts: DigestFacts
  previous: Pick<DigestFile, 'planDone'> | null
}

const iso = (ms: number): string => new Date(ms).toISOString()

export function composeDigest(input: DigestInput): DigestFile {
  const { facts } = input
  // waits — the inbox at the hour
  // a task line (inbox taskLine: «Coming to you · 15») is no wait: it is said
  // as its own line, by its count — never one routine wait (P6)
  const waitRows = input.inbox.filter((r) => r.kind !== 'taskLine')
  const lines = input.inbox.flatMap((r) => (r.kind === 'taskLine' ? [{ line: r.line, count: r.count, voice: r.voice }] : []))
  const count = (u: InboxRow['urgency']): number => waitRows.filter((r) => r.urgency === u).length
  const loud = waitRows.filter((r) => (r.urgency === 'blocking' || r.urgency === 'due') && r.at > 0)
  const oldest = loud.length > 0 ? loud.reduce((a, b) => (b.at < a.at ? b : a)) : null

  // conversations finished, per agent
  const conv = new Map<string, number>()
  for (const c of facts.conversations) conv.set(c.agentId, (conv.get(c.agentId) ?? 0) + 1)
  const msg = new Map<string, number>()
  for (const c of facts.messageConversations ?? []) msg.set(c.agentId, (msg.get(c.agentId) ?? 0) + 1)

  // runs, per agent
  const runs = new Map<string, DigestRuns>()
  for (const { agentId, run, healedLater } of facts.runs) {
    if (run.status !== 'ok' && run.status !== 'failed') continue
    const r = runs.get(agentId) ?? { agentId, name: facts.nameOf(agentId), runs: 0, acted: 0, noNews: 0, ok: 0, failed: 0, recovered: 0 }
    r.runs++
    if (run.status === 'failed') {
      if (healedLater) r.recovered++
      else r.failed++
    } else if (run.outcome === 'acted') r.acted++
    else if (run.outcome === 'nothing') r.noNews++
    else r.ok++
    runs.set(agentId, r)
  }

  // silo records that reached a terminal state, by silo and state
  const silos = new Map<string, DigestSiloDone>()
  for (const s of facts.siloDone) {
    const k = `${s.silo}\0${s.to}`
    const hit = silos.get(k)
    if (hit) hit.count++
    else silos.set(k, { silo: s.silo, siloName: s.siloName, to: s.to, label: s.label, count: 1 })
  }

  return {
    version: 1,
    date: input.date,
    hour: input.hour,
    from: iso(input.from),
    to: iso(input.to),
    ...(input.late ? { late: true as const } : {}),
    waits: {
      blocking: count('blocking'),
      due: count('due'),
      routine: count('routine'),
      oldest: oldest ? { at: iso(oldest.at), kind: oldest.kind, voice: oldest.voice } : null,
      ...(lines.length > 0 ? { lines } : {}),
    },
    happened: {
      conversations: [...conv]
        .map(([agentId, n]) => ({ agentId, name: facts.nameOf(agentId), count: n }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      ...(msg.size > 0
        ? {
            messages: [...msg]
              .map(([agentId, n]) => ({ agentId, name: facts.nameOf(agentId), count: n }))
              .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
          }
        : {}),
      runs: [...runs.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)),
      planTasksDone: null,
      silos: [...silos.values()].sort((a, b) => b.count - a.count),
    },
    coming: facts.horizon ? [...facts.horizon] : null,
    planDone: [],
  }
}

// The few numbers the morning push and the band's head say.
export function digestCounts(d: Pick<DigestFile, 'happened'>): { finished: number; runs: number; acted: number; failed: number; recovered: number } {
  const sum = (f: (r: DigestRuns) => number): number => d.happened.runs.reduce((n, r) => n + f(r), 0)
  return {
    finished: d.happened.conversations.reduce((n, c) => n + c.count, 0),
    runs: sum((r) => r.runs),
    acted: sum((r) => r.acted),
    failed: sum((r) => r.failed),
    recovered: sum((r) => r.recovered),
  }
}

// ── the band: unread digests summed ────────────────────────────────────────

export interface DigestBand {
  dates: string[] // the digests it sums, oldest first
  through: string // the newest — what Seen acknowledges
  hour: string
  from: string // where the oldest window started («since Friday 08:00»)
  to: string
  waits: DigestFile['waits'] // the newest digest's snapshot
  happened: DigestFile['happened']
  coming: DigestFile['coming'] // the newest digest's horizon
}

export function sumDigests(files: readonly DigestFile[]): DigestBand | null {
  if (files.length === 0) return null
  const sorted = [...files].sort((a, b) => a.date.localeCompare(b.date))
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  const conv = new Map<string, DigestConversations>()
  const msg = new Map<string, DigestConversations>()
  const runs = new Map<string, DigestRuns>()
  const silos = new Map<string, DigestSiloDone>()
  let plan: number | null = null
  for (const f of sorted) {
    for (const c of f.happened.conversations) {
      const hit = conv.get(c.agentId)
      if (hit) {
        hit.count += c.count
        hit.name = c.name
      } else conv.set(c.agentId, { ...c })
    }
    for (const c of f.happened.messages ?? []) {
      const hit = msg.get(c.agentId)
      if (hit) {
        hit.count += c.count
        hit.name = c.name
      } else msg.set(c.agentId, { ...c })
    }
    for (const r of f.happened.runs) {
      const hit = runs.get(r.agentId)
      if (!hit) {
        runs.set(r.agentId, { ...r })
        continue
      }
      hit.name = r.name
      hit.runs += r.runs
      hit.acted += r.acted
      hit.noNews += r.noNews
      hit.ok += r.ok
      hit.failed += r.failed
      hit.recovered += r.recovered
    }
    for (const s of f.happened.silos) {
      const k = `${s.silo}\0${s.to}`
      const hit = silos.get(k)
      if (hit) hit.count += s.count
      else silos.set(k, { ...s })
    }
    if (f.happened.planTasksDone !== null) plan = (plan ?? 0) + f.happened.planTasksDone
  }
  return {
    dates: sorted.map((f) => f.date),
    through: last.date,
    hour: last.hour,
    from: first.from,
    to: last.to,
    waits: last.waits,
    happened: {
      conversations: [...conv.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      ...(msg.size > 0 ? { messages: [...msg.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) } : {}),
      runs: [...runs.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)),
      planTasksDone: plan,
      silos: [...silos.values()].sort((a, b) => b.count - a.count),
    },
    coming: last.coming,
  }
}

// a file read back from disk: only the shape this module writes passes
export function isDigestFile(v: unknown): v is DigestFile {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Partial<DigestFile>
  return (
    d.version === 1 &&
    typeof d.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(d.date) &&
    typeof d.from === 'string' &&
    typeof d.to === 'string' &&
    typeof d.waits === 'object' &&
    d.waits !== null &&
    typeof d.happened === 'object' &&
    d.happened !== null &&
    Array.isArray(d.happened.conversations) &&
    Array.isArray(d.happened.runs) &&
    Array.isArray(d.happened.silos) &&
    Array.isArray(d.planDone)
  )
}
