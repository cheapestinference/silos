// doorbell.ts — how Silos reaches the owner when they are not looking
// A seam: `Doorbell.ring(payload)`; Web Push is the
// first adapter (web-push.ts), email/ntfy can come later without touching
// the inbox.
//
// WHAT a ring carries is decided by the lock screen, not the pipe:
// counts and kind words only — «2 things need you: a
// question · a failed run». Never an agent name, a customer, a voice line or
// any text from a row. `inboxPayload` and `morningPayload` are the only
// places a payload is composed, and they read nothing but urgency, kind and
// counts.
//
// WHEN it rings (InboxBell, over app.onInboxChange):
//   blocking  at once, as a new key enters the inbox
//   due       batched: a new due key waits DUE_BATCH_MS, then rides one ring
//             (if it is still there)
//   routine   never — the digest says it
//   at most one ring per MIN_GAP_MS; what comes inside the gap rides the next
//   once a morning, when the digest is written
// «New» is a key entering the loud (blocking + due) set. A Seen row is gone
// from the composition, so it never rings; a row that left and came back
// rings again — unless it carries a version and that version already rang
// (a flapping row is not news twice).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import type { InboxRow, InboxRowKind } from './inbox.js'
import type { DigestFile } from './digest.js'
import { digestCounts } from './digest.js'

export interface DoorbellPayload {
  title: string
  body: string
  tag: string // the notification slot: a newer ring replaces the older one
  url: string // where a tap lands — always Home
  // the counts the body was made of (for a client that wants to draw them)
  counts?: { blocking: number; due: number }
  ttl?: number // seconds the push service may hold it
  urgency?: 'normal' | 'high'
}

export interface Doorbell {
  ring(payload: DoorbellPayload): Promise<unknown>
}

export const DUE_BATCH_MS = 10 * 60_000
export const MIN_GAP_MS = 5 * 60_000

// ── the payload: counts and kinds, nothing else ────────────────────────────

// the kind of thing a row is, in the words a lock screen may show
const KIND_WORDS: Record<InboxRowKind, [one: string, many: string]> = {
  ask: ['a question', 'questions'],
  approval: ['an approval', 'approvals'],
  proposal: ['a suggestion', 'suggestions'],
  proposalSummary: ['suggestions', 'suggestions'],
  escalated: ['an escalation', 'escalations'],
  message: ['a message', 'messages'],
  silo: ['a record', 'records'],
  siloSummary: ['records', 'records'],
  failedRun: ['a failed run', 'failed runs'],
  accountLimit: ['a usage limit', 'usage limits'],
  missedRetry: ['a missed retry', 'missed retries'],
  territoryOff: ['an agent whose territory turned off', 'agents whose territory turned off'],
  folderRefused: ['an agent in a folder no project may have', 'agents in folders no project may have'],
  cut: ['an agent stopped from creating work', 'agents stopped from creating work'],
  plansBaseline: ['tasks from before Silos watched', 'tasks from before Silos watched'],
  auditUnreadable: ['a run Silos could not audit', 'runs Silos could not audit'],
  unreadMessages: ['an unread message', 'unread messages'],
  agentSummary: ['failing automations', 'failing automations'],
  taskLine: ['tasks', 'tasks'],
  tasksStalled: ['stalled tasks', 'stalled tasks'],
  // (B2.5) only a wait Silos does not carry: the owner relays it
  waitsOnRelay: ['a task you relay to an agent', 'tasks you relay to agents'],
  closedPlansOpen: ['closed plans with open tasks', 'closed plans with open tasks'],
  tasksUnreadable: ["tasks that can't be read", "tasks that can't be read"],
  consoleIdle: ['an open console nobody uses', 'open consoles nobody uses'],
  ownTurnsCeiling: ['an agent at its daily max', 'agents at their daily max'],
  spend: ['spend it could not count', 'spend it could not count'],
  engineCompat: ['an engine to update', 'engines to update'],
  engineUnwired: ['an engine to wire', 'engines to wire'],
  integrity: ['a file changed outside Silos', 'files changed outside Silos'],
}

// a permission ask reads as a permission, not a question; a silo summary
// by its kind's noun when the manifest says it («support tickets» — the
// kind, never a record's content); a sub-kind's row by its kind's own word
// («a task» — a plan's, from the built-in Plans silo; never its title)
type Phrased = Pick<InboxRow, 'kind'> & { permission?: unknown; noun?: { one: string; many: string }; item?: unknown }
function kindWord(r: Phrased): string {
  if (r.kind === 'siloSummary' && r.noun) return `noun:${r.noun.many}`
  if (r.kind === 'silo' && typeof r.item === 'object' && r.item !== null && (r.item as { parent?: unknown }).parent !== undefined) {
    const kind = String((r.item as { recordKind?: unknown }).recordKind ?? '')
    return `sub:${kind.split('/').pop() || 'record'}`
  }
  return r.kind === 'ask' && r.permission ? 'permission' : r.kind
}
const PERMISSION: [string, string] = ['a permission', 'permissions']

export function kindsPhrase(rows: readonly Phrased[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(kindWord(r), (counts.get(kindWord(r)) ?? 0) + 1)
  return [...counts]
    .map(([k, n]) => {
      const [one, many] =
        k === 'permission'
          ? PERMISSION
          : k.startsWith('noun:')
            ? [k.slice(5), k.slice(5)]
            : k.startsWith('sub:')
              ? [`a ${k.slice(4)}`, `${k.slice(4)}s`]
              : (KIND_WORDS[k as InboxRowKind] ?? ['something', 'things'])
      return n === 1 ? one : one === many ? many : `${n} ${many}`
    })
    .join(' · ')
}

// one ring for the rows that just became news; `total` is everything loud
// in the inbox right now (said only when there is more than the news)
export function inboxPayload(fresh: readonly InboxRow[], loud: readonly InboxRow[]): DoorbellPayload {
  const n = fresh.length
  const blocking = loud.filter((r) => r.urgency === 'blocking').length
  const due = loud.filter((r) => r.urgency === 'due').length
  const head = n === 1 ? 'Something new needs you' : `${n} new things need you`
  const rest = loud.length > n ? ` · ${loud.length} waiting in all` : ''
  return {
    title: 'Silos',
    body: `${head}: ${kindsPhrase(fresh)}${rest}`,
    tag: 'silos-inbox',
    url: '/',
    counts: { blocking, due },
    urgency: fresh.some((r) => r.urgency === 'blocking') ? 'high' : 'normal',
  }
}

// the morning push: «Morning: 3 need you · 14 finished · 1 failed and recovered»
export function morningPayload(d: DigestFile): DoorbellPayload {
  return { title: 'Silos', body: morningLine(d), tag: 'silos-digest', url: '/', counts: { blocking: d.waits.blocking, due: d.waits.due }, ttl: 12 * 3600 }
}

export function morningLine(d: DigestFile): string {
  const c = digestCounts(d)
  const parts: string[] = []
  const needs = d.waits.blocking + d.waits.due
  if (needs > 0) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`)
  if (c.finished > 0) parts.push(`${c.finished} finished`)
  if (c.acted > 0) parts.push(`${c.acted} run${c.acted === 1 ? '' : 's'} acted`)
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  if (c.recovered > 0) parts.push(`${c.recovered} failed and recovered`)
  return parts.length > 0 ? `Morning: ${parts.join(' · ')}` : 'Morning: nothing waits, nothing new'
}

// ── the ring rule ──────────────────────────────────────────────────────────

interface BellState {
  loud: string[] // the loud keys present at the last observation
  rang: Record<string, string> // key → the version that last rang (versioned rows only)
  lastRingAt: number
}

const RANG_KEEP = 500

export class InboxBell {
  private state: BellState | null = null
  // due keys waiting for their batch: key → when it entered
  private pendingDue = new Map<string, number>()
  // blocking keys that arrived inside the gap
  private pendingBlocking = new Set<string>()
  private rows: InboxRow[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private file: string

  constructor(private opts: { dataDir: string; bell: Doorbell; batchMs?: number; minGapMs?: number }) {
    this.file = join(opts.dataDir, 'doorbell.json')
  }

  private load(): BellState | null {
    if (this.state) return this.state
    if (!existsSync(this.file)) return null
    const text = readFileSync(this.file, 'utf8')
    try {
      const raw = JSON.parse(text) as Partial<BellState>
      this.state = {
        loud: Array.isArray(raw.loud) ? raw.loud.filter((k): k is string => typeof k === 'string') : [],
        rang:
          raw.rang && typeof raw.rang === 'object'
            ? (Object.fromEntries(Object.entries(raw.rang).filter(([, v]) => typeof v === 'string')) as Record<string, string>)
            : {},
        lastRingAt: typeof raw.lastRingAt === 'number' ? raw.lastRingAt : 0,
      }
    } catch {
      backupCorruptJson(this.file, text, 'doorbell')
      this.state = null
    }
    return this.state
  }

  private save(): void {
    if (!this.state) return
    const entries = Object.entries(this.state.rang)
    if (entries.length > RANG_KEEP) this.state.rang = Object.fromEntries(entries.slice(-RANG_KEEP))
    atomicWriteJson(this.file, this.state)
  }

  // The first composition ever is a baseline: what already waits is not news
  // (installing the doorbell floods nothing). After a restart the saved loud
  // set is the baseline, so what entered while Silos was down still rings.
  baseline(rows: readonly InboxRow[]): void {
    if (this.load()) return
    this.state = { loud: rows.filter(isLoud).map((r) => r.key), rang: {}, lastRingAt: 0 }
    for (const r of rows) if (isLoud(r) && r.ack) this.state.rang[r.key] = r.ack.version
    this.save()
  }

  // a new composition (app.onInboxChange)
  observe(rows: readonly InboxRow[], now: number = Date.now()): Promise<void> {
    const st = this.load()
    if (!st) {
      this.baseline(rows)
      return Promise.resolve()
    }
    this.rows = [...rows]
    const before = new Set(st.loud)
    const loud = rows.filter(isLoud)
    for (const r of loud) {
      if (before.has(r.key)) continue
      // a versioned row that already rang at this version is not news twice
      if (r.ack && st.rang[r.key] === r.ack.version) continue
      if (r.urgency === 'blocking') this.pendingBlocking.add(r.key)
      else if (!this.pendingDue.has(r.key)) this.pendingDue.set(r.key, now)
    }
    st.loud = loud.map((r) => r.key)
    // a pending key that left before its ring is not news any more
    const present = new Set(st.loud)
    for (const k of [...this.pendingDue.keys()]) if (!present.has(k)) this.pendingDue.delete(k)
    for (const k of [...this.pendingBlocking]) if (!present.has(k)) this.pendingBlocking.delete(k)
    this.save()
    return this.flush(now)
  }

  // ring what is ready: blocking at once, due once its batch has waited —
  // never two rings inside the gap
  async flush(now: number = Date.now()): Promise<void> {
    const st = this.load()
    if (!st) return
    const batchMs = this.opts.batchMs ?? DUE_BATCH_MS
    const gap = this.opts.minGapMs ?? MIN_GAP_MS
    const dueReady = [...this.pendingDue.values()].some((t) => now - t >= batchMs)
    if (this.pendingBlocking.size === 0 && !dueReady) return
    if (now - st.lastRingAt < gap) return
    const keys = new Set([...this.pendingBlocking, ...this.pendingDue.keys()])
    const fresh = this.rows.filter((r) => keys.has(r.key))
    this.pendingBlocking.clear()
    this.pendingDue.clear()
    if (fresh.length === 0) return
    st.lastRingAt = now
    for (const r of fresh) if (r.ack) st.rang[r.key] = r.ack.version
    this.save()
    try {
      await this.opts.bell.ring(inboxPayload(fresh, this.rows.filter(isLoud)))
    } catch (err) {
      console.warn('doorbell: ring failed —', err instanceof Error ? err.message : err)
    }
  }

  // the digest was written: one morning push (it counts as a ring for the gap)
  async morning(d: DigestFile, now: number = Date.now()): Promise<void> {
    const st = this.load()
    if (st) {
      st.lastRingAt = now
      this.save()
    }
    try {
      await this.opts.bell.ring(morningPayload(d))
    } catch (err) {
      console.warn('doorbell: morning ring failed —', err instanceof Error ? err.message : err)
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flush()
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

function isLoud(r: InboxRow): boolean {
  return r.urgency === 'blocking' || r.urgency === 'due'
}
