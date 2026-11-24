// held-order.ts — a list does not reorder under the cursor (a pattern
// borrowed from Paperclip's UX). While the owner dispatches, the order is the one they
// started with: what closes keeps its gap a few seconds, what arrives enters where
// the fresh order puts it, and everything else stays put. The fresh order returns
// at an attention boundary: Esc on the list, another view, or two idle minutes.
//
// In memory on purpose: it is the state of this hand on this keyboard, it survives
// the round trip list → task → back and nothing else. A hold never decides what is
// true about a row, only where it stands.
import type { TaskOrigin, TasksQuery } from './routes'

export const GAP_MS = 5_000
export const HOLD_IDLE_MS = 2 * 60_000

export interface HeldRow {
  key: string
  goneAt: number | null
}

export interface ReconcileOpts {
  gapMs?: number
  // never dropped while it is under the cursor: Enter must not open the row below
  pin?: string | null
  // what this reading can speak about (a task's page reads a list's tasks, not its
  // other rows): anything outside it is left exactly as it is
  inScope?: (key: string) => boolean
}

export function reconcileHeld(held: readonly HeldRow[], fresh: readonly string[], now: number, opts: ReconcileOpts = {}): HeldRow[] {
  const gap = opts.gapMs ?? GAP_MS
  const scoped = opts.inScope ?? (() => true)
  const present = new Set(fresh)
  const rows: HeldRow[] = []
  for (const r of held) {
    if (!scoped(r.key)) {
      rows.push(r)
      continue
    }
    if (present.has(r.key)) {
      rows.push(r.goneAt === null ? r : { key: r.key, goneAt: null })
      continue
    }
    const goneAt = r.goneAt ?? now
    if (now - goneAt < gap || r.key === opts.pin) rows.push({ key: r.key, goneAt })
  }
  // a newcomer stands right after whatever precedes it in the fresh order
  const known = new Set(rows.map((r) => r.key))
  fresh.forEach((key, i) => {
    if (known.has(key)) return
    const before = i > 0 ? rows.findIndex((r) => r.key === fresh[i - 1]) : -1
    rows.splice(before + 1, 0, { key, goneAt: null })
    known.add(key)
  })
  return rows
}

export interface Hold {
  rows: HeldRow[]
  cursor: string | null
  keyboard: boolean
  touched: number
}

const holds = new Map<string, Hold>()

// the hold of this list, unless it went idle
export function readHold(id: string, now: number): Hold | null {
  const h = holds.get(id)
  if (!h) return null
  if (now - h.touched > HOLD_IDLE_MS) {
    holds.delete(id)
    return null
  }
  return h
}

// starts holding this order, or goes on holding the one already held
export function engageHold(id: string, fresh: readonly string[], now: number): Hold {
  const h = readHold(id, now) ?? { rows: fresh.map((key) => ({ key, goneAt: null })), cursor: null, keyboard: false, touched: now }
  h.touched = now
  holds.set(id, h)
  return h
}

export function releaseHold(id: string): void {
  holds.delete(id)
}

// tests
export function resetHolds(): void {
  holds.clear()
}

// one list, one id: a view of Tasks and the same view walked from a task's page,
// Home's lists on Home or on a project
export function tasksHoldId(q: TasksQuery): string {
  return `tasks:${JSON.stringify([q.view ?? 'mine', q.layout ?? 'list', q.agent ?? [], q.project ?? [], q.plan ?? []])}`
}
export function inboxHoldId(kind: 'needs-you' | 'yours', folder: string | undefined): string {
  return `${kind}:${folder ?? ''}`
}
export function holdIdOfOrigin(o: TaskOrigin | undefined): string | null {
  switch (o?.kind) {
    case 'tasks':
      return tasksHoldId(o.query)
    case 'needs-you':
    case 'yours':
      return inboxHoldId(o.kind, o.folder)
    default:
      return null
  }
}
