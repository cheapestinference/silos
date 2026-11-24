// resident/schedule.ts — the clock-driven automations: the startup
// reconcile (orphaned runs, the crash-loop cap, missed runs), cron / once /
// watch dispatch with its rescheduling, the waiting_reset retry, and the
// watch heartbeat (a cheap check, no LLM, that only fires a run when its
// runWhen matches). Moved verbatim from resident.ts; Resident's tick calls it.
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { nextRun } from '../cron.js'
import type { Automation, Run, WatchTrigger, WatchCheck, CronTrigger, OnceTrigger, PeriodTrigger } from '../automations-types.js'
import { isHeartbeat } from '../heartbeat.js'
import { nextSlot } from '../period.js'
import { SIX_HOURS_MS, RESTART_INTERRUPTED, CRASH_LOOP_CAP, WATCH_PROMPT_CAP } from './constants.js'
import { defaultExecFn, type CheckResult } from './helpers.js'
import { REARM_CAUSE } from './heartbeat.js'
import { ResidentPart, type ResidentCore } from './core.js'
import type { RunEngine } from './runs.js'

export class Schedule extends ResidentPart {
  private fetchFn: typeof fetch
  private execFn: (command: string, cwd: string) => Promise<{ stdout: string; code: number }>

  constructor(
    core: ResidentCore,
    private runs: RunEngine,
  ) {
    super(core)
    const deps = core.deps
    this.fetchFn = deps.fetchFn ?? fetch
    this.execFn = deps.execFn ?? defaultExecFn
  }

  private executeRun(a: Automation, opts?: { promptOverride?: string; cause?: string; onDispatch?: () => void }): Promise<boolean> {
    return this.runs.executeRun(a, opts)
  }

  // ---- startup: orphaned runs + missed-run policy ------------------

  reconcileStaleRuns(): void {
    // The union of LIVE automations + any id with run history on disk —
    // so a 'running' orphan from an automation deleted BETWEEN a crash and
    // this restart also gets reconciled, instead of staying a ghost
    // forever (store.list() alone no longer sees it).
    const ids = new Set([...this.deps.store.list().map((a) => a.id), ...this.deps.store.automationIdsWithRuns()])
    for (const id of ids) {
      // EVERY run left running with no live turn — not only the last line:
      // a skip row written after a heartbeat's round must not leave the
      // round `running` forever, unaudited
      for (const open of this.deps.store.openRuns(id)) {
        if (open.status !== 'running' && open.status !== 'queued') continue
        if (this.runs.liveRunIds.get(id) === open.id) continue
        const closed = { ...open, status: 'failed' as const, error: RESTART_INTERRUPTED, endedAt: this.now().toISOString() }
        this.appendRun(id, closed)
        // the audit at boot: the interrupted turn's transcript is on disk
        // — it is AUDITED and judged like any finished turn, by the regime
        // ITS run sealed, never undone unconditionally (a restart is no
        // infraction)
        const a = this.deps.store.get(id)
        if (a && closed.sessionKey !== undefined) this.track(this.runs.auditRun(a, closed))
      }
      // The leading interrupted STREAK — newest first, over 'skipped' rows
      // (so a suppressed catch-up doesn't reset the count at the next
      // boot), up to the first run that really finished.
      let streak = 0
      let head: Run | undefined
      for (const r of this.deps.store.listRuns(id)) {
        if (r.status === 'skipped') continue
        if (r.status === 'failed' && r.error === RESTART_INTERRUPTED) {
          streak++
          head ??= r
          continue
        }
        break
      }
      if (streak === 0) continue
      // a heartbeat never resumes and never catches up:
      // its next slot comes on its own (checkMissedOnStart)
      const beat = this.deps.store.get(id)
      if (beat && isHeartbeat(beat)) continue
      if (streak < CRASH_LOOP_CAP) {
        // chat-init had happened: the session exists and holds what the
        // cut run did — the next dispatch continues it (see
        // resumeAfterRestart). The row may have been closed by THIS boot
        // just above, or by shutdown() when the stop was clean: same row,
        // same continuation. A row with no endedAt is treated as stale.
        if (head?.sessionKey)
          this.resumeAfterRestart.set(id, { sessionKey: head.sessionKey, runId: head.id, at: head.endedAt ? new Date(head.endedAt).getTime() : 0 })
        continue
      }
      // CRASH_LOOP_CAP reached: no resume hint, and the overdue catch-up
      // (checkMissedOnStart leaves anything <6h for tick to fire NOW) is
      // skipped with an honest row. The next scheduled occurrence runs
      // normally — this caps the tight boot→relaunch→crash loop, it is
      // not a kill switch; Run now (the owner's gesture) always works.
      const a = this.deps.store.get(id)
      if (!a || a.paused) continue
      if (!a.nextRunAt || new Date(a.nextRunAt) > this.now()) continue
      this.recordSkippedRun(
        a,
        `interrupted by server restarts ${streak} times in a row — skipping the catch-up run; the next scheduled one goes ahead, and Run now always works`,
      )
      if (a.trigger.kind === 'cron') this.setNextRunAt(a, (a.trigger as CronTrigger).expr, this.now())
      else if (a.trigger.kind === 'watch') this.setNextRunAt(a, (a.trigger as WatchTrigger).every, this.now())
      else if (a.trigger.kind === 'period') this.setNextSlot(a, this.now())
      else this.deps.store.update(a.id, { nextRunAt: undefined })
    }
  }

  checkMissedOnStart(): void {
    const now = this.now()
    for (const a of this.deps.store.list()) {
      // checkMissedOnStart runs SYNCHRONOUSLY in start() — a throw here
      // (e.g. an automation with an unexpected shape that still passed
      // load(), or a disk race) would bring down the whole process's
      // startup. load() already filters invalid shapes, but this is belt
      // and suspenders: a broken automation must never stop the others
      // from starting.
      try {
        if (a.paused) continue
        if (a.trigger.kind === 'cron' || a.trigger.kind === 'watch') {
          const expr = a.trigger.kind === 'cron' ? (a.trigger as CronTrigger).expr : (a.trigger as WatchTrigger).every
          if (!a.nextRunAt) {
            this.setNextRunAt(a, expr, now)
            continue
          }
          const due = new Date(a.nextRunAt)
          if (due > now) continue
          if (now.getTime() - due.getTime() < SIX_HOURS_MS) continue // tick() picks it up: overdue, runs right away
          this.recordSkippedRun(a, 'missed the scheduled run (more than 6h)')
          this.setNextRunAt(a, expr, now)
        } else if (a.trigger.kind === 'period') {
          // a heartbeat recovers no slot: nextSlot(now)
          if (isHeartbeat(a)) {
            if (!a.nextRunAt || new Date(a.nextRunAt) <= now) this.setNextSlot(a, now)
            continue
          }
          // an owner's: cron's recovery rule, at most one run
          if (!a.nextRunAt) {
            this.setNextSlot(a, now)
            continue
          }
          const due = new Date(a.nextRunAt)
          if (due > now) continue
          if (now.getTime() - due.getTime() < SIX_HOURS_MS) continue // tick() picks it up: one run, right away
          this.recordSkippedRun(a, 'missed the scheduled run (more than 6h)')
          this.setNextSlot(a, now)
        } else if (a.trigger.kind === 'once') {
          const trig = a.trigger as OnceTrigger
          if (!a.nextRunAt) {
            this.deps.store.update(a.id, { nextRunAt: trig.at })
            continue
          }
          const due = new Date(trig.at)
          if (due > now) continue
          if (now.getTime() - due.getTime() < SIX_HOURS_MS) continue
          this.recordSkippedRun(a, 'missed the scheduled run (more than 6h)')
          this.deps.store.update(a.id, { paused: true, nextRunAt: undefined })
        }
      } catch (err) {
        console.error(`resident: checkMissedOnStart failed for automation ${a.id}:`, err)
      }
    }
  }

  setNextRunAt(a: Automation, expr: string, after: Date): void {
    try {
      // a cron reads its wall clock in trigger.tz when set; a watch's `every` in local time
      const tz = a.trigger.kind === 'cron' ? (a.trigger as CronTrigger).tz : undefined
      const next = nextRun(expr, after, tz)
      this.deps.store.update(a.id, { nextRunAt: next.toISOString() })
    } catch {
      this.deps.store.update(a.id, { nextRunAt: undefined, paused: true }) // the cron stopped being valid — shouldn't happen (validated at creation)
    }
  }

  /** A period's next slot after `after` (period.ts) — never a backlog: at
   *  most one slot is ever due. A period no slot
   *  falls in (only a hand-edited file) pauses, like a cron that stopped
   *  being valid. */
  setNextSlot(a: Automation, after: Date): void {
    const next = a.trigger.kind === 'period' ? nextSlot((a.trigger as PeriodTrigger).period, after.getTime()) : null
    if (next === null) {
      this.deps.store.update(a.id, { nextRunAt: undefined, paused: true })
      return
    }
    this.deps.store.update(a.id, { nextRunAt: new Date(next).toISOString() })
  }

  // A retry of a waiting_reset now dispatches through the same
  // post-processing as a normal trigger, based on trigger.kind (pause the
  // once / reschedule cron-watch), and only if the retry itself didn't
  // fall back into waiting_reset again (in which case runNow already left
  // nextRunAt pointing at the new resetsAt, untouched). It reuses the
  // effective promptOverride persisted on the Run (the webhook payload,
  // the watch fingerprint) — previously the retry lost that context and
  // retried with the automation's base prompt, silently running the wrong task.
  async retryWaitingReset(a: Automation, promptOverride: string | undefined, now: Date, cause?: string): Promise<void> {
    // the cause rides along: a rate-limited message run still reads
    // "woken by" on its retry
    // a period moves on when its retry STARTS, never when it ends
    const onDispatch = a.trigger.kind === 'period' ? { onDispatch: () => this.setNextSlot(this.deps.store.get(a.id) ?? a, now) } : {}
    const executed = await this.executeRun(a, { promptOverride, ...(cause !== undefined ? { cause } : {}), ...onDispatch })
    // If executeRun was a no-op (the `running` lock — another run of THIS
    // SAME automation was still in flight when this retry was dispatched),
    // there was NO real retry — don't touch paused/nextRunAt. The
    // in-flight run will reach its own terminal state on its own (and, if
    // it falls into waiting_reset again, will leave its own
    // nextRunAt=resetsAt untouched) — touching state here over a no-op is
    // exactly the bug this guards against (see runOnceScheduled below, same pattern).
    if (!executed) return
    if (this.deps.store.latestRun(a.id)?.status === 'waiting_reset') return
    const fresh = this.deps.store.get(a.id) ?? a
    if (a.trigger.kind === 'once') {
      this.deps.store.update(a.id, { paused: true, nextRunAt: undefined })
    } else if (a.trigger.kind === 'cron') {
      this.setNextRunAt(fresh, (a.trigger as CronTrigger).expr, now)
    } else if (a.trigger.kind === 'watch') {
      this.setNextRunAt(fresh, (a.trigger as WatchTrigger).every, now)
    }
  }

  // a heartbeat's re-armed think (resident/heartbeat.ts rearm): a
  // cron fire for every purpose (the budget check, counted by status) that
  // leaves the cron's own next fire where it is
  async runRearmed(a: Automation): Promise<void> {
    await this.executeRun(a, { cause: REARM_CAUSE })
  }

  fireCronIfDue(a: Automation, now: Date): void {
    const trig = a.trigger as CronTrigger
    if (!a.nextRunAt) {
      this.setNextRunAt(a, trig.expr, now)
      return
    }
    if (new Date(a.nextRunAt) > now) return
    this.track(this.runCronScheduled(a, trig.expr, now))
  }

  private async runCronScheduled(a: Automation, expr: string, now: Date): Promise<void> {
    const executed = await this.executeRun(a)
    // A concurrent tick while a previous run of THIS automation is still
    // in flight makes executeRun a no-op (the `running` lock) — without
    // touching nextRunAt here, the next tick simply tries again (another
    // no-op if it's still in flight, or a real reschedule once the real
    // run finishes).
    if (!executed) return
    // if the run ended in waiting_reset, runNow() ALREADY left nextRunAt
    // pointing at the exact resetsAt (keepAlive) — don't overwrite it with the normal cadence.
    if (this.deps.store.latestRun(a.id)?.status === 'waiting_reset') return
    this.setNextRunAt(this.deps.store.get(a.id) ?? a, expr, now)
  }

  /** The free period's clock — never cron's:
   *  nothing piles up, at most one slot is due. A heartbeat moves to its
   *  next slot at every slot, run or skipped (a think that waits for room
   *  keeps its slot due: queued, never lost); an owner's automation moves
   *  only when a run STARTS — until then it stays due (that IS its one
   *  pending run, and it survives a restart), and its end touches nothing. */
  firePeriodIfDue(a: Automation, now: Date): void {
    if (!a.nextRunAt) {
      this.setNextSlot(a, now)
      return
    }
    if (new Date(a.nextRunAt) > now) return
    this.track(this.executeRun(a, { onDispatch: () => this.setNextSlot(this.deps.store.get(a.id) ?? a, now) }))
  }

  fireOnceIfDue(a: Automation, now: Date): void {
    const trig = a.trigger as OnceTrigger
    if (!a.nextRunAt) {
      this.deps.store.update(a.id, { nextRunAt: trig.at })
      return
    }
    if (new Date(a.nextRunAt) > now) return
    this.track(this.runOnceScheduled(a))
  }

  private async runOnceScheduled(a: Automation): Promise<void> {
    const executed = await this.executeRun(a)
    // A `once` in flight (lasts minutes, normal with an LLM) still has an
    // overdue nextRunAt — nothing clears it when the run STARTS. Every
    // +30s tick in the meantime goes through fireOnceIfDue →
    // runOnceScheduled again, and executeRun is a no-op (the `running`
    // lock) having done NOTHING. Without this guard, the post-processing
    // below would run anyway over that no-op and pause the automation
    // mid-real-run — if that real run ended in waiting_reset, it would
    // stay paused:true forever (the tick skips paused ones) and the retry
    // would NEVER arrive: the "once" task would die silently. Only the
    // DISPATCH that actually executed something (dispatched to runNow,
    // recorded a waiting_approval, or recorded a skipped due to budget)
    // gets to decide the automation's final fate.
    if (!executed) return
    // Same guard as runCronScheduled/runWatchScheduled — if the run ended
    // in waiting_reset (rate limit + keepAlive), runNow() already left
    // nextRunAt pointing at the exact resetsAt for the tick's retry
    // (retryWaitingReset). Pausing unconditionally here would overwrite it
    // with paused:true/nextRunAt:undefined a microtask later: the owner's
    // scheduled task would NEVER run. We only pause once the run genuinely
    // finished (any other status).
    if (this.deps.store.latestRun(a.id)?.status === 'waiting_reset') return
    this.deps.store.update(a.id, { paused: true, nextRunAt: undefined })
  }

  fireWatchIfDue(a: Automation, now: Date): void {
    const trig = a.trigger as WatchTrigger
    if (!a.nextRunAt) {
      this.setNextRunAt(a, trig.every, now)
      return
    }
    if (new Date(a.nextRunAt) > now) return
    // its engine refused: the check waits too — run now it would spend the
    // change it saw on a run that can't happen; due, it runs once when ok
    if (this.runs.engineHeld(a) !== null) return
    this.track(this.runWatchScheduled(a, trig, now))
  }

  private async runWatchScheduled(a: Automation, trig: WatchTrigger, now: Date): Promise<void> {
    // Unlike once/cron, this setNextRunAt reschedules the check's
    // HEARTBEAT (cheap, no LLM, no `running` lock of its own) — not the
    // result of the LLM run the check might trigger downstream
    // (runWatchCheck → executeRun, conditional on `fires`). The check
    // itself has no notion of "in flight": it must re-evaluate on every
    // normal cadence even while a previous run is still going (executeRun
    // will simply no-op if needed). With no `paused` involved (watch never
    // pauses), no permanent lockout is possible here — deliberately
    // without runOnceScheduled's `executed` guard.
    await this.runWatchCheck(a, trig)
    // Same criterion as runCronScheduled: if the run the watch triggered
    // ended in waiting_reset, its nextRunAt (=resetsAt) is already set correctly.
    if (this.deps.store.latestRun(a.id)?.status === 'waiting_reset') return
    this.setNextRunAt(this.deps.store.get(a.id) ?? a, trig.every, now)
  }

  // ---- watch: heartbeat WITH NO LLM — only creates a run if runWhen matches ----

  private async runWatchCheck(a: Automation, trig: WatchTrigger): Promise<void> {
    let result: CheckResult
    try {
      result = await this.performCheck(trig.check)
    } catch (err) {
      result = { fingerprint: 'error:' + (err instanceof Error ? err.message : String(err)), summary: 'error running the check' }
    }
    const prevFingerprint = a.lastFingerprint
    const prevSummary = a.lastRun?.summary ?? '(no previous data)'

    let fires = false
    let reason = ''
    switch (trig.runWhen) {
      case 'changed':
        fires = prevFingerprint !== undefined && prevFingerprint !== result.fingerprint
        reason = 'changed'
        break
      case 'nonzero':
        fires = result.exitCode !== undefined && result.exitCode !== 0
        reason = `exit code ${result.exitCode ?? '?'}`
        break
      case 'zero':
        fires = result.exitCode !== undefined && result.exitCode === 0
        reason = `exit code ${result.exitCode ?? '?'}`
        break
      case 'matches':
        // Runtime guard: validateTrigger now rejects a bad pattern at creation,
        // but an automation persisted before that check could still hold one.
        // A throw here would abort the reschedule and busy-loop the check every
        // tick — degrade to "does not fire" and log instead.
        try {
          fires = trig.pattern !== undefined && result.matchedText !== undefined && new RegExp(trig.pattern).test(result.matchedText)
        } catch (err) {
          console.error('[watch] automation', a.id, 'has an invalid regex pattern', JSON.stringify(trig.pattern), '—', err instanceof Error ? err.message : err)
          fires = false
        }
        reason = `matches /${trig.pattern ?? ''}/`
        break
    }

    this.deps.store.update(a.id, { lastFingerprint: result.fingerprint })
    if (!fires) return

    const watchBlock = `Watch ${a.name} fired: ${reason}\n\nPrevious: ${prevSummary}\nNow: ${result.summary}`.slice(0, WATCH_PROMPT_CAP)
    const promptOverride = `${a.prompt}\n\n---\n${watchBlock}`
    await this.executeRun(this.deps.store.get(a.id) ?? a, { promptOverride })
  }

  private async performCheck(check: WatchCheck): Promise<CheckResult> {
    if (check.type === 'path') {
      const st = await stat(check.path).catch(() => null)
      if (!st) return { fingerprint: 'missing', summary: 'the file does not exist' }
      return { fingerprint: `${st.mtimeMs}:${st.size}`, summary: `mtime=${st.mtimeMs} size=${st.size}` }
    }
    if (check.type === 'command') {
      const { stdout, code } = await this.execFn(check.command, check.cwd)
      return {
        fingerprint: createHash('sha1').update(stdout).digest('hex'),
        summary: stdout.slice(0, 500),
        exitCode: code,
        matchedText: stdout,
      }
    }
    const res = await this.fetchFn(check.url, { method: check.method ?? 'GET', headers: check.headers })
    const body = await res.text()
    return { fingerprint: createHash('sha1').update(body).digest('hex'), summary: body.slice(0, 500), matchedText: body }
  }
}
