// resident.ts — the automations resident. A durable scheduler: does a
// deterministic HEARTBEAT (cheap, no LLM) and only launches a real RUN (an
// agent session via ChatService) when there's actually something to judge —
// a deliberate cost criterion.
//
// ChatService remains the ONLY thing that talks to the SDK — the resident
// just invokes it (with `isolation` when applicable) and listens to its events.
//
// The class is the public face; its concerns live under ./resident/ (runs,
// schedule, wakes, task turns, watchers, resumes, over a shared core) and the
// methods here delegate to them.
import type { ChatEvent } from './chat-types.js'
import type { SessionMeta } from './types.js'
import type { Automation } from './automations-types.js'
import { MANUAL_CAUSE } from './automations-types.js'
import { DEFAULT_TICK_MS, RESTART_INTERRUPTED } from './resident/constants.js'
import type { ResidentDeps } from './resident/deps.js'
import { ResidentCore } from './resident/core.js'
import { RunEngine } from './resident/runs.js'
import { Schedule } from './resident/schedule.js'
import { TaskTurns, type TaskTurnInput, type TaskTurnResult } from './resident/task-turns.js'
import { Watchers } from './resident/watchers.js'
import { PendingResumeSweep } from './resident/resumes.js'

// Everything resident.ts exported before the split, from where it lives now.
export { MAX_RESUME_ATTEMPTS, RESUME_BATCH_PER_TICK } from './resident/constants.js'
export { RUN_OUTCOME_INSTRUCTION, withOutcomeInstruction, parseRunOutcome, commandFailureText } from './resident/outcome.js'
export { nextLocalMidnight } from './limits.js'
export { secretsMatch } from './resident/helpers.js'
export type { ResidentDeps } from './resident/deps.js'
export { isValidCron } from './cron.js'

export class Resident {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private core: ResidentCore
  private runs: RunEngine
  private schedule: Schedule
  private taskTurns: TaskTurns
  private watchers: Watchers
  private resumes: PendingResumeSweep
  private deps: ResidentDeps
  private now: () => Date
  private tickIntervalMs: number
  private chatEventHandler = (m: { agentId: string; event: ChatEvent }): void => this.watchers.onChatEvent(m)

  constructor(deps: ResidentDeps) {
    this.core = new ResidentCore(deps)
    this.deps = deps
    this.now = this.core.now
    this.runs = new RunEngine(this.core)
    this.schedule = new Schedule(this.core, this.runs)
    this.taskTurns = new TaskTurns(this.core)
    this.watchers = new Watchers(this.core, this.runs)
    this.resumes = new PendingResumeSweep(this.core)
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_MS
  }

  start(): void {
    this.schedule.reconcileStaleRuns()
    this.schedule.checkMissedOnStart()
    // Startup fingerprint for `needs_you` — any session that's ALREADY
    // pending when the resident starts does NOT count as a rising edge (or
    // a restart with a pending question would fire a spurious run). It's
    // initialized from the index's current state — but NOT here: at this
    // point index.allSessions() is EMPTY (index.init() hasn't run yet; the
    // index warms up in the background, see index.ts). Seeding here would
    // leave the baseline inert forever (init() refreshes with emit:false,
    // never repopulates it). The caller (index.ts) must invoke
    // seedPendingBaseline() once index.init() resolves. Not persisted to
    // disk (it only needs to survive while the process lives; after a
    // restart it's recalculated the same way from the real sessions).
    this.reconcileFileWatchers()
    this.deps.chat.on('chat-event', this.chatEventHandler)
    this.deps.index.on('session', (m: SessionMeta) => this.watchers.onSessionForNeedsYou(m))
    // CRITICAL: without .catch, a throw inside tick() (e.g. a malformed
    // automation) leaves an orphaned rejected promise → unhandledRejection
    // → Node 22 kills the process. tick() already runs in a cascade every
    // tickIntervalMs, so a failed tick simply retries on the next one — it
    // must never bring down the resident.
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error('resident: tick() failed:', err))
    }, this.tickIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.deps.chat.off('chat-event', this.chatEventHandler)
    this.watchers.closeAll()
  }

  // ---- fire-and-forget tracking (tests only, see drain()) ------

  private track(p: Promise<unknown>): void {
    this.core.track(p)
  }

  // Tests only: waits for all in-flight work to finish. Production NEVER
  // calls this — the resident is fire-and-forget on purpose (a hung run
  // must not block scheduling other automations). If there's a genuinely
  // hung run (timeout disabled or not yet due), drain() will hang too —
  // tests that force a hang use polling (`until`) instead, never drain().
  async drain(): Promise<void> {
    return this.core.drain()
  }

  // ---- `files` watchers — reconciled after any CRUD (resident/watchers.ts) ------
  reconcileFileWatchers(): void {
    this.watchers.reconcileFileWatchers()
  }

  get fileWatcherCount(): number {
    return this.watchers.fileWatcherCount
  }

  // Tests only — exposes the size of the anti-loop set to verify that a
  // turn dying in 'chat-error' doesn't leave it orphaned (same criterion
  // as fileWatcherCount above).
  get liveRunTurnIdsSize(): number {
    return this.core.liveRunTurnIds.size
  }

  // SIGTERM/SIGINT (index.ts): close the in-flight runs honestly before
  // the process dies — each gets the same RESTART_INTERRUPTED row a boot
  // reconcile would write, with the sessionKey this process already knows
  // in memory, so the next boot can CONTINUE the session
  // (reconcileStaleRuns reads the row back as a resume hint). Without
  // this, a server that stops and never restarts leaves runs saying
  // 'running' forever. tsx watch restarts via SIGTERM, so the normal dev
  // restart goes through here too.
  shutdown(): void {
    for (const [id, runId] of [...this.runs.liveRunIds]) {
      const run = this.deps.store.runById(id, runId)
      if (!run || (run.status !== 'running' && run.status !== 'queued')) continue
      const sessionKey = run.sessionKey ?? this.runs.runSessionKeys.get(run.id)
      this.core.appendRun(id, {
        ...run,
        ...(sessionKey !== undefined ? { sessionKey } : {}),
        status: 'failed',
        error: RESTART_INTERRUPTED,
        endedAt: this.now().toISOString(),
      })
    }
    this.stop()
  }

  // Must be called AFTER index.init() resolves — see the comment in
  // start(). Public on purpose, so index.ts can chain it after `await index.init()`.
  seedPendingBaseline(): void {
    this.watchers.seedPendingBaseline()
  }

  // ---- tick: cron / once / watch — webhook/files/conversation are event-driven ----
  //
  // tick() ONLY evaluates (cheap, synchronous) which automation is due —
  // it never AWAITs the real execution. Each due run is fired via
  // `track()` (fire-and-forget) so a hung run doesn't stop tick() from
  // finishing and evaluating/firing the other automations in this same
  // tick, or the next ones (the `ticking` flag only guards the evaluation
  // loop, which is always fast).

  async tick(now = this.now()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      // The control fields' invariants (an exemption ends at midnight) and
      // every agent's heartbeat brought to its control and rhythm
      // BEFORE anything due is evaluated. Isolated:
      // a failure here never starves the rest of the tick.
      try {
        this.deps.registry.revalidate(now.getTime())
      } catch (err) {
        console.warn('resident: agent revalidation failed —', err instanceof Error ? err.message : err)
      }
      if (this.deps.heartbeats) {
        try {
          this.deps.heartbeats.reconcile()
        } catch (err) {
          console.warn('resident: heartbeat reconcile failed —', err instanceof Error ? err.message : err)
        }
      }
      // the owner's «Run now» that waited for a slot asks again
      for (const id of [...this.manualQueue]) {
        const a = this.deps.store.get(id)
        if (!a) {
          this.manualQueue.delete(id)
          continue
        }
        this.track(
          this.runs.executeRun(a, { cause: MANUAL_CAUSE }).then((ran) => {
            if (ran) this.manualQueue.delete(id)
          }),
        )
      }
      // Task mode: the bound agents' task events (task-mode/engine.ts) —
      // isolated like the rest
      if (this.deps.taskMode) {
        try {
          this.deps.taskMode.look(now.getTime())
        } catch (err) {
          console.warn('resident: task mode failed —', err instanceof Error ? err.message : err)
        }
      }
      if (this.deps.escalation) {
        try {
          this.deps.escalation.tick(now.getTime())
        } catch (err) {
          console.warn('resident: escalation failed —', err instanceof Error ? err.message : err)
        }
      }
      if (this.deps.proposals) {
        try {
          // the inbox check of every tick sees the rows leave
          this.deps.proposals.expireDue(now.getTime())
        } catch (err) {
          console.warn('resident: proposal expiry failed —', err instanceof Error ? err.message : err)
        }
      }
      for (const a of this.deps.store.list()) {
        if (a.paused) continue
        // latestRun() is an in-memory index maintained by AutomationsStore
        // on every appendRun — O(1), no longer re-reads the whole
        // automation's runs.jsonl on EVERY tick.
        const latest = this.deps.store.latestRun(a.id)
        if (latest?.status === 'waiting_reset' && a.nextRunAt && new Date(a.nextRunAt) <= now) {
          this.track(this.schedule.retryWaitingReset(a, latest.promptOverride, now, latest.cause))
          continue
        }
        switch (a.trigger.kind) {
          case 'cron':
            this.schedule.fireCronIfDue(a, now)
            break
          case 'once':
            this.schedule.fireOnceIfDue(a, now)
            break
          case 'period':
            this.schedule.firePeriodIfDue(a, now)
            break
          case 'watch':
            this.schedule.fireWatchIfDue(a, now)
            break
          default:
            break
        }
      }
      // a think the spend cap, the account or the engine skipped, or that failed (never the ceiling)
      try {
        this.runs.heartbeats.rearm(now, (a) => this.track(this.schedule.runRearmed(a)))
      } catch (err) {
        console.warn('resident: heartbeat re-arm failed —', err instanceof Error ? err.message : err)
      }
      // Auto-resume for interactive chats: resends rate-limited
      // interactive turns whose resumeAt has passed — the SAME durable
      // lane as automations' waiting_reset, but for normal chats (turn
      // boundary: the resend is a NEW turn). Fire-and-forget (track), like
      // everything else in the tick.
      this.resumes.processPendingResumes(now)
      // Auto-titles: AFTER evaluating automations (low priority) and
      // fire-and-forget (same criterion — a slow sweep doesn't block
      // ticks). The titler self-limits: a max batch per sweep, a
      // persisted daily cap, a cooldown on rate limit, and a reentrancy flag.
      if (this.deps.titler) this.track(this.deps.titler.sweep(now))
      // The machine's vitals: self-limited to one sample per hour (and the
      // boot one), never two at once — same lane as the titler.
      if (this.deps.machine) this.track(this.deps.machine.sweep(now))
      // Prunes conversation-prefs — cheap and synchronous, after the rest
      // of the tick (low priority, same criterion as the titler).
      if (this.deps.prefsSweep) {
        try {
          this.deps.prefsSweep()
        } catch (err) {
          console.warn('prefsSweep: failed to prune conversation-prefs —', err instanceof Error ? err.message : err)
        }
      }
      // runs.jsonl rotation (hygiene): same low-priority lane — a SAFE
      // point by construction (single-threaded + synchronous appendRun:
      // never cuts an append mid-write). The check is an O(1) statSync per
      // file; the latestRun cache isn't touched (rotation moves old
      // history, the latest run is still the latest). See
      // AutomationsStore.rotateRunsIfNeeded.
      try {
        const rotated = this.deps.store.rotateRunsIfNeeded()
        if (rotated.length > 0) console.info(`resident: runs.jsonl rotated (${rotated.join(', ')})`)
      } catch (err) {
        console.warn('resident: runs.jsonl rotation failed —', err instanceof Error ? err.message : err)
      }
    } finally {
      this.ticking = false
    }
  }

  // ---- task turns (resident/task-turns.ts) -------------------------------

  // One task-mode turn (task-mode/engine.ts): the scoped briefing as an SDK
  // turn of the agent — on the task's own conversation (resume, append) or a
  // new one — through ChatService: routed by the agent's engine, registered
  // to the agent at birth, isolated like a run (no user hooks, the project's
  // settings), its turn id in liveRunTurnIds so an unattended turn never
  // fires «conversation finished» automations. The engine decides WHEN (held
  // while the conversation has a turn or a console); this only runs it.
  // `onSession` hears the session id at chat-init.
  openTaskTurn(input: TaskTurnInput): { turnId: string; done: Promise<TaskTurnResult> } {
    return this.taskTurns.openTaskTurn(input)
  }

  // ---- webhook: POST /api/hooks/:id (resident/watchers.ts) ----

  fireWebhook(automationId: string, secret: string, payload: unknown): { ok: true } | { error: string; code: number } {
    return this.watchers.fireWebhook(automationId, secret, payload)
  }

  // ---- run-now / pause / resume / approve / skip (routes) ---------------

  // Same contract as the webhook — fire-and-forget + 202. This used to
  // `await executeRun(a)`, which blocked the HTTP request for up to 30 min
  // (runTimeoutMs); a fetch/proxy that timed out earlier reported failure
  // in the UI even though the run was still alive, and an owner retry
  // collided with the `running` lock (a silent early-return, a misleading
  // "ok"). The real result already travels over WS (`ev: 'run'`).
  // ASYNC: a heartbeat's «Run now» asks its account's
  // plan reading first — at the margin, an honest 409, never a 202
  async runNowManual(automationId: string): Promise<{ ok: true } | { error: string; code: number }> {
    const a = this.deps.store.get(automationId)
    if (!a) return { error: 'automation not found', code: 404 }
    const margin = await this.runs.runNowMargin(a)
    if (margin !== null) return { error: margin, code: 409 }
    // The no-op cases executeRun would swallow are checkable HERE, before
    // dispatch — a 202 over a no-op told the owner a run started when
    // nothing did. executeRun keeps its own guard for the race.
    const busy = this.runs.busyReason(a)
    if (busy) return { error: busy, code: 409 }
    // the owner's gesture (cause manual): outside the cron's
    // budget, ahead of what Silos inferred in the live caps' queue — and,
    // when the caps are full, queued (asked again every tick), never lost
    this.manualQueue.add(a.id)
    this.track(
      this.runs.executeRun(a, { cause: MANUAL_CAUSE }).then((ran) => {
        if (ran) this.manualQueue.delete(a.id)
      }),
    )
    return { ok: true }
  }

  // the owner's «Run now» waiting for a live slot (turn-slots.ts)
  private manualQueue = new Set<string>()

  /** Why an automation's due run waits right now (the live caps), or null. */
  heldWhy(automationId: string): string | null {
    return this.runs.held.get(automationId) ?? null
  }

  /** The agent's automation runs in flight with a live turn (the sheet). */
  liveRunsOf(agentId: string): Array<{ turnId: string; what: string }> {
    return this.runs.liveRunsOf(agentId)
  }

  /** The run a live resident turn belongs to (the considered/sleep routes). */
  runOfTurn(turnId: string): { automationId: string; runId: string } | null {
    return this.runs.runOfTurn(turnId)
  }
  noteSlept(runId: string, until: string): void {
    this.runs.noteSlept(runId, until)
  }

  // pause/resume are the user's own switch (the UI buttons): both drop the
  // platform's auto-pause marker, so nothing un-pauses or re-pauses this
  // automation behind the user's back.
  /** Undo: cancel an automation's live run, if one runs here. */
  cancelLiveRun(id: string): boolean {
    return this.runs.cancelLiveRun(id)
  }

  pause(id: string): Automation {
    const a = this.deps.store.update(id, { paused: true, autoPaused: undefined })
    this.watchers.reconcileFileWatchers() // pausing closes a `files` trigger's watcher
    return a
  }

  resume(id: string): Automation {
    const a = this.deps.store.update(id, { paused: false, autoPaused: undefined })
    if (a.trigger.kind === 'cron' || a.trigger.kind === 'watch') {
      const expr = a.trigger.kind === 'cron' ? a.trigger.expr : a.trigger.every
      this.schedule.setNextRunAt(a, expr, this.now())
    } else if (a.trigger.kind === 'period') this.schedule.setNextSlot(a, this.now())
    this.watchers.reconcileFileWatchers() // resuming reopens the watcher if it's a `files` trigger
    return this.deps.store.get(id) ?? a
  }

  // Same criterion as runNowManual — fire-and-forget + 202.
  approveRun(runId: string): { ok: true } | { error: string } {
    const found = this.deps.store.findRun(runId)
    if (!found) return { error: 'run not found' }
    const { automationId, run } = found
    if (run.status !== 'waiting_approval') return { error: 'run is not waiting for approval' }
    const a = this.deps.store.get(automationId)
    if (!a) return { error: 'automation not found' }
    this.track(this.runs.runNow(a, run.id, run.promptOverride, run.cause))
    return { ok: true }
  }

  skipRun(runId: string): { ok: true } | { error: string } {
    const found = this.deps.store.findRun(runId)
    if (!found) return { error: 'run not found' }
    const { automationId, run } = found
    if (run.status !== 'waiting_approval') return { error: 'run is not waiting for approval' }
    this.core.appendRun(automationId, { ...run, status: 'skipped', reason: 'skipped by the owner', endedAt: this.now().toISOString() })
    return { ok: true }
  }

  // ---- the heart of it: budget → approval → real execution (resident/runs.ts) ----

  // Returns whether it EXECUTED something real (dispatched to runNow,
  // recorded a waiting_approval, or recorded a skipped due to budget) as
  // opposed to a pure NO-OP (the `running` lock from a run of THIS SAME
  // automation already in flight, or a latest already
  // waiting_approval/running/queued from an earlier call). Callers
  // (runOnceScheduled/runCronScheduled/retryWaitingReset) use this to skip
  // their post-processing (pause/reschedule) when nothing happened —
  // without it, a concurrent tick while a `once` is still in flight would
  // pause the automation mid-real-run.
  async executeRun(a: Automation, opts?: { promptOverride?: string; cause?: string; onDispatch?: () => void }): Promise<boolean> {
    return this.runs.executeRun(a, opts)
  }

  // Deleting an automation with pending 'waiting_approval' runs used to
  // leave them hanging in /api/automations/pending forever (Approve failed
  // with a 404 "automation not found"; only Skip removed them). Run
  // history isn't touched — only a new terminal snapshot is appended
  // (append-only, same criterion as everything else here).
  cancelPendingApprovals(automationId: string): void {
    for (const r of this.deps.store.listRuns(automationId)) {
      if (r.status === 'waiting_approval') {
        this.core.appendRun(automationId, { ...r, status: 'skipped', reason: 'automation deleted', endedAt: this.now().toISOString() })
      }
    }
  }
}
