// resident/core.ts — the state and the small operations every part of the
// resident shares: its deps and clock, the in-flight tracking, the turns
// THIS process started for a run/message/task (the «conversation finished»
// anti-loop), the restart-resume hints, the run log and the owner resolver.
// The parts (runs, schedule, wakes, messages, watchers, resumes) extend
// ResidentPart, whose forwarders let their code read `this.deps`,
// `this.now()`, `this.track(…)` exactly as it did inside the Resident class.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SessionOwners } from '../session-owner.js'
import type { Automation, Run } from '../automations-types.js'
import type { SessionMeta } from '../types.js'
import type { ResidentDeps } from './deps.js'

export class ResidentCore {
  readonly owners: SessionOwners
  readonly now: () => Date
  // This set only contains the turnId of turns THIS process started via an
  // automation run, and only while that specific turn hasn't yet emitted
  // its own terminal 'chat-done' (or 'chat-error'). It's populated in
  // executeChatTurn right before calling chat.send(), and pruned in
  // onChatEvent as soon as that turn's terminal event arrives. This closes
  // the loop on the run's own auto-trigger (including the post-timeout
  // zombie case, whose real chat-done arrives late but STAYS in this set
  // until then) without blocking any other turn — neither run #2+ of a
  // keep thread nor a manual turn from the owner on that same session.
  readonly liveRunTurnIds = new Set<string>()
  // Fire-and-forget runs (tick/webhook/files/conversation) — ONLY so tests
  // can wait for in-flight work to finish (drain()); production never
  // waits for them (that's the point: a hung run must not block anything else).
  private inflightPromises = new Set<Promise<unknown>>()
  // A run cut mid-turn by a server restart (tsx watch on every save under
  // server/src) already opened a session and did part of its work. The
  // re-dispatch that tick() fires for the overdue automation must CONTINUE
  // that session, not open a second conversation for the same intended run
  // ("one run, two rows"). reconcileStaleRuns leaves the hint
  // here; executeChatTurn consumes it on the automation's next dispatch —
  // only if that dispatch comes soon (SIX_HOURS_MS, the same missed-run
  // window) and the session file still exists on disk (index-independent:
  // the index is still warming at start()).
  readonly resumeAfterRestart = new Map<string, { sessionKey: string; runId: string; at: number }>()

  constructor(readonly deps: ResidentDeps) {
    this.owners =
      deps.owners ??
      new SessionOwners({
        registry: deps.registry,
        native: deps.native,
        lineage: deps.lineage ?? null,
        index: deps.index,
        trashDir: join(deps.dataDir, 'trash'),
      })
    this.now = deps.now ?? (() => new Date())
  }

  track(p: Promise<unknown>): void {
    const wrapped = p.catch((err) => {
      console.error('resident: uncaught run:', err)
    })
    this.inflightPromises.add(wrapped)
    void wrapped.finally(() => this.inflightPromises.delete(wrapped))
  }

  // Tests only: waits for all in-flight work to finish. Production NEVER
  // calls this — the resident is fire-and-forget on purpose (a hung run
  // must not block scheduling other automations). If there's a genuinely
  // hung run (timeout disabled or not yet due), drain() will hang too —
  // tests that force a hang use polling (`until`) instead, never drain().
  async drain(): Promise<void> {
    while (this.inflightPromises.size > 0) {
      await Promise.allSettled([...this.inflightPromises])
    }
  }

  // WHO a conversation belongs to — the same rule as the overview
  // (session-owner.ts): a /clear child or a --resume fork belongs to its
  // origin's agent, through buried ancestors, never to the folder default
  // just because its own file carries no marker.
  classifyAgentId(meta: SessionMeta): string {
    return this.owners.agentIdOf(meta)
  }

  recordSkippedRun(a: Automation, reason: string): void {
    this.appendRun(a.id, { id: randomUUID(), automationId: a.id, at: this.now().toISOString(), status: 'skipped', reason })
  }

  appendRun(automationId: string, run: Run): void {
    this.deps.store.appendRun(automationId, run)
    // a heartbeat's state follows its runs as they are written —
    // never re-derived from the history on a tick
    if (run.heartbeat) {
      const agentId =
        this.deps.store.get(automationId)?.agentId ?? (automationId.startsWith('heartbeat-') ? automationId.slice('heartbeat-'.length) : undefined)
      if (agentId) {
        try {
          this.deps.heartbeat?.store.noteRun(agentId, run)
        } catch (err) {
          console.warn(`resident: heartbeat state of ${agentId} not written —`, err instanceof Error ? err.message : err)
        }
      }
    }
    this.deps.broadcast({ ev: 'run', run })
    const a = this.deps.store.get(automationId)
    if (a) this.deps.broadcast({ ev: 'automation', automation: a })
  }

  // ---- keepAlive: best-effort parsing of "resets at HH:MM(am|pm)" --------

  parseResetFromText(text: string): string | undefined {
    const m = /resets?\s*(?:at)?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text)
    if (!m) return undefined
    let h = Number.parseInt(m[1] as string, 10)
    const min = Number.parseInt(m[2] as string, 10)
    const ampm = m[3]?.toLowerCase()
    if (ampm === 'pm' && h < 12) h += 12
    if (ampm === 'am' && h === 12) h = 0
    const now = this.now()
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0)
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
    return d.toISOString()
  }
}

export abstract class ResidentPart {
  constructor(protected readonly core: ResidentCore) {}
  protected get deps(): ResidentDeps {
    return this.core.deps
  }
  protected now(): Date {
    return this.core.now()
  }
  protected get liveRunTurnIds(): Set<string> {
    return this.core.liveRunTurnIds
  }
  protected get resumeAfterRestart(): ResidentCore['resumeAfterRestart'] {
    return this.core.resumeAfterRestart
  }
  protected track(p: Promise<unknown>): void {
    this.core.track(p)
  }
  protected classifyAgentId(meta: SessionMeta): string {
    return this.core.classifyAgentId(meta)
  }
  protected recordSkippedRun(a: Automation, reason: string): void {
    this.core.recordSkippedRun(a, reason)
  }
  protected appendRun(automationId: string, run: Run): void {
    this.core.appendRun(automationId, run)
  }
  protected parseResetFromText(text: string): string | undefined {
    return this.core.parseResetFromText(text)
  }
}
