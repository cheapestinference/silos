// turn-slots.ts — the live caps on unattended turns: OWN_TURNS_LIVE per agent and
// UNATTENDED_TURNS_LIVE_GLOBAL for the whole installation. One gate both
// lanes ask before starting an unattended turn — the resident's runs
// (heartbeats, automations of an agent) and Task mode's wakes — so the cap
// counts what really runs on the shared accounts.
//
// Excess is QUEUED, never lost, in TWO CLASSES: an entry born of an owner's
// gesture enters ahead of every non-gesture entry, FIFO inside each class
// (G1-r6: what Silos inferred never holds the owner's gesture by order — so
// «it starts when one ends» stays true). The queue holds REQUESTS that are
// re-asked: a waiting lane calls tryAcquire again on its next pass (the
// resident's tick, Task mode's deliver), which refreshes its place; an entry
// nobody re-asked for STALE_MS left (its wake was superseded, its run
// skipped) and stops holding anyone. Nothing here is persisted: what waits
// lives in its own lane (a due cron stays due, a queued wake stays queued),
// so a restart rebuilds the queue from the lanes themselves.
import { OWN_TURNS_LIVE, UNATTENDED_TURNS_LIVE_GLOBAL } from './limits.js'

export interface SlotRequest {
  id: string // stable per waiting unit: `run:<automationId>` · `wake:<agent>|<task>`
  agentId: string
  gesture: boolean // born of an owner's gesture (assign as the owner, an owner's note, Run now)
  at: number // when it started waiting (FIFO inside the class)
}

export type SlotAnswer = { ok: true; release: () => void } | { ok: false; cap: 'agent' | 'global'; running: number }

export const STALE_MS = 120_000

/** The words a held start is said with («things», never
 *  «turns»). */
export function heldWords(cap: 'agent' | 'global', running: number, name: string): string {
  const n = running === 1 ? '1 thing' : `${running} things`
  return cap === 'agent' ? `${name} is running ${n} already — it starts when one ends` : `the fleet is running ${n} — ${name} starts when one ends`
}

export class TurnSlots {
  private live = new Map<number, string>() // slot → agentId
  private seq = 0
  private waiting = new Map<string, SlotRequest & { seenAt: number }>()
  private now: () => number
  private agentMax: number
  private globalMax: number

  constructor(o: { now?: () => number; agentMax?: number; globalMax?: number } = {}) {
    this.now = o.now ?? Date.now
    this.agentMax = o.agentMax ?? OWN_TURNS_LIVE
    this.globalMax = o.globalMax ?? UNATTENDED_TURNS_LIVE_GLOBAL
  }

  liveOf(agentId: string): number {
    let n = 0
    for (const a of this.live.values()) if (a === agentId) n++
    return n
  }
  liveTotal(): number {
    return this.live.size
  }

  private prune(): void {
    const t = this.now()
    for (const [id, w] of this.waiting) if (t - w.seenAt > STALE_MS) this.waiting.delete(id)
  }

  // gesture class first, then FIFO by `at` (ties by id: deterministic)
  private static ahead(a: SlotRequest, b: SlotRequest): boolean {
    if (a.gesture !== b.gesture) return a.gesture
    if (a.at !== b.at) return a.at < b.at
    return a.id < b.id
  }

  /** Start now, or wait in line (said with its cap). A request granted
   *  leaves the line; its `release` frees the slot (idempotent). */
  tryAcquire(r: SlotRequest): SlotAnswer {
    this.prune()
    const t = this.now()
    const prev = this.waiting.get(r.id)
    const req = { ...r, at: prev ? Math.min(prev.at, r.at) : r.at, gesture: r.gesture || prev?.gesture === true, seenAt: t }
    const agentLive = this.liveOf(r.agentId)
    if (agentLive >= this.agentMax) {
      this.waiting.set(r.id, req)
      return { ok: false, cap: 'agent', running: agentLive }
    }
    if (this.live.size >= this.globalMax) {
      this.waiting.set(r.id, req)
      return { ok: false, cap: 'global', running: this.live.size }
    }
    // a request ranked ahead that could start now (its agent has room) goes
    // first: this one waits its turn behind it — the queue's order is the
    // truth, never who asked first in this pass
    const free = this.globalMax - this.live.size
    const before = [...this.waiting.values()].filter((w) => w.id !== r.id && TurnSlots.ahead(w, req) && this.liveOf(w.agentId) < this.agentMax)
    if (before.length >= free) {
      this.waiting.set(r.id, req)
      return { ok: false, cap: 'global', running: this.live.size }
    }
    this.waiting.delete(r.id)
    const slot = ++this.seq
    this.live.set(slot, r.agentId)
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        this.live.delete(slot)
      },
    }
  }

  /** Whether a NEW request of `agentId` would start right now — a probe
   *  that leaves nothing in the line (a heartbeat's
   *  look asks for room with it and, without room, is skipped — an entry
   *  left by tryAcquire would hold back the wakes that come after it). It
   *  ranks behind every request already waiting in its class, as a new one
   *  would — its own entry, when it already waits (`id`), aside. */
  wouldStart(agentId: string, gesture: boolean, id?: string): boolean {
    this.prune()
    if (this.liveOf(agentId) >= this.agentMax) return false
    if (this.live.size >= this.globalMax) return false
    const free = this.globalMax - this.live.size
    const mine = id !== undefined ? this.waiting.get(id) : undefined
    const before = [...this.waiting.values()].filter(
      (w) => w.id !== id && (mine ? TurnSlots.ahead(w, mine) : gesture ? w.gesture : true) && this.liveOf(w.agentId) < this.agentMax,
    )
    return before.length < free
  }

  /** Where a waiting request stands NOW, without granting anything: the cap
   *  that holds it and how many things run there — what the live line paints
   *  («X is running <n> things already» / «the fleet is running <n>
   *  things», R1/S5-r5). null: it is not waiting. A request behind others of
   *  a higher class with no cap full yet waits on the fleet's slots. */
  standing(id: string): { cap: 'agent' | 'global'; running: number } | null {
    this.prune()
    const w = this.waiting.get(id)
    if (!w) return null
    const agentLive = this.liveOf(w.agentId)
    if (agentLive >= this.agentMax) return { cap: 'agent', running: agentLive }
    return { cap: 'global', running: this.live.size }
  }

  /** Forget a waiting request (its unit was superseded, skipped, stopped). */
  forget(id: string): void {
    this.waiting.delete(id)
  }

  /** What waits, in queue order (tests, the live line). */
  queue(): SlotRequest[] {
    this.prune()
    return [...this.waiting.values()].sort((a, b) => (TurnSlots.ahead(a, b) ? -1 : 1)).map(({ seenAt: _s, ...r }) => r)
  }
}
