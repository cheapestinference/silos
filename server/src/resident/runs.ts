// resident/runs.ts — the heart of a run: budget → approval → real
// execution (an agent turn through ChatService, or a command leg with an
// optional hand-over turn), the time cap that aborts a zombie turn, the
// terminal record, keep-thread rotation and the terminal collision check.
// Moved verbatim from resident.ts; Resident delegates to it.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mungePath } from '../agent-registry.js'
import { looksLikeRateLimit } from '../fallback.js'
import { EngineRefusedError } from '../harness-run.js'
import type { SessionMeta } from '../types.js'
import type { Automation, Run, RunStatus, RunOutcome, CommandRun, CommandLeg } from '../automations-types.js'
import { DEFAULT_MAX_RUNS_PER_DAY, COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MAX_MS, isCommandRun } from '../automations-types.js'
import { validateRun } from '../automations-validate.js'
import { runCommand, expandAgentState, lastNonEmptyLine, tailLines } from '../command-run.js'
import { agentProcessEnv } from '../agent-env.js'
import { SIX_HOURS_MS, ROTATION_THRESHOLD, COMMAND_KILL_SLACK_MS } from './constants.js'
import { ROUND_SLEEP_AFTER_OUTSIDE_MS, UNATTENDED_TURN_TIMEOUT_MS } from '../limits.js'
import type { MarginReading } from '../proactive.js'
import { MANUAL_CAUSE, type RunAudit, type RunHeartbeat } from '../automations-types.js'
import { marginOf, runNowMarginWords } from '../proactive.js'
import type { Agent } from '../types.js'
import { controlOf } from '../control.js'
import { isHeartbeat } from '../heartbeat.js'
import { ownCapHold, ownTurnsToday } from '../own-turns.js'
import { heldWords } from '../turn-slots.js'
import { HeartbeatRuns, type Prepared } from './heartbeat.js'
import { TRANSCRIPT_UNREADABLE, heartbeatVerdict, ownerCredentialCut } from '../heartbeat-audit.js'
import { withOutcomeInstruction, parseRunOutcome, commandFailureText } from './outcome.js'
import { contextWindowFor, looksLikeTooLong, defaultIsPidAlive } from './helpers.js'
import { ResidentPart, type ResidentCore } from './core.js'

export class RunEngine extends ResidentPart {
  readonly running = new Set<string>() // automationIds with an execution in progress IN THIS PROCESS
  // automationId → the id of the run in flight IN THIS PROCESS: a run is
  // found by its id, never as «the latest» (a skip row may follow it)
  readonly liveRunIds = new Map<string, string>()
  // runId → sessionKey, populated as soon as executeChatTurn sees
  // chat-init — lets runNow's timeout branch (which doesn't know turnId)
  // record the sessionKey on the 'failed'/timeout Run. Pruned in finishRun.
  readonly runSessionKeys = new Map<string, string>()
  // runId → turnId of the live SDK turn — so runNow's timeout branch can
  // ABORT the zombie turn (chat.cancel) instead of leaving it running
  // behind the released lock. Pruned in finishRun with runSessionKeys.
  private runTurnIds = new Map<string, string>()
  // runId → the command leg of a command run whose failure was handed to
  // the agent (executeCommandRun → executeChatTurn): finishRun folds it into
  // the terminal record, so the run keeps both legs. Pruned in finishRun.
  private commandLegs = new Map<string, CommandLeg>()
  private claudeSessionsDir: string
  private isPidAlive: (pid: number) => boolean
  private runTimeoutMs: number

  constructor(core: ResidentCore) {
    super(core)
    const deps = core.deps
    this.claudeSessionsDir = deps.claudeSessionsDir ?? join(process.env.HOME ?? '', '.claude', 'sessions')
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive
    this.runTimeoutMs = deps.runTimeoutMs ?? UNATTENDED_TURN_TIMEOUT_MS
    this.heartbeats = new HeartbeatRuns(core)
  }

  readonly heartbeats: HeartbeatRuns
  // runId → turnId and the reverse (the considered/sleep routes find the
  // heartbeat run of a live turn), and what a run's turn recorded meanwhile
  private turnRuns = new Map<string, { automationId: string; runId: string }>()
  private sleptUntil = new Map<string, string>()
  /** The run a live turn of the resident belongs to, or null. */
  runOfTurn(turnId: string): { automationId: string; runId: string } | null {
    return this.turnRuns.get(turnId) ?? null
  }
  /** The agent's runs with a live turn right now (turnId + the automation's name). */
  liveRunsOf(agentId: string): Array<{ turnId: string; what: string }> {
    const out: Array<{ turnId: string; what: string }> = []
    for (const [turnId, r] of this.turnRuns) {
      const a = this.deps.store.get(r.automationId)
      if (a && a.agentId === agentId) out.push({ turnId, what: a.name })
    }
    return out
  }

  /** A heartbeat turn slept: its run records it when it ends. */
  noteSlept(runId: string, until: string): void {
    this.sleptUntil.set(runId, until)
  }

  /** Why a new run of `a` would be a no-op right now, or null when it can
   *  run: the in-flight lock, or a run still in a live state (whatever rows
   *  were written after it). */
  busyReason(a: Automation): string | null {
    if (this.running.has(a.id)) return 'a run of this automation is still in flight (running)'
    const held = this.engineHeld(a)
    if (held !== null) return held
    const open = this.deps.store.openRuns(a.id)[0]
    if (open) return `its latest run is still ${open.status} — it must finish (or be approved/skipped) first`
    return null
  }

  /** Why `a` can't run on its agent's engine right now (refused: outdated,
   *  missing — harness.ts peekRefusal), or null. A command run needs no
   *  engine. While it is said, nothing runs and nothing is written: a due
   *  beat STAYS due and runs once when the engine is ok (missed beats
   *  collapse into that one run) — the owner hears it once, in the
   *  engineCompat row, never as a failed run per automation. */
  engineHeld(a: Automation): string | null {
    const current = this.deps.store.get(a.id) ?? a
    if (isCommandRun(current)) return null
    try {
      return this.deps.engineRefusal?.(current.agentId) ?? null
    } catch {
      return null
    }
  }

  // ---- the heart of it: budget → approval → real execution -----------

  // Returns whether it EXECUTED something real (dispatched to runNow,
  // recorded a waiting_approval, or recorded a skipped due to budget) as
  // opposed to a pure NO-OP (the `running` lock from a run of THIS SAME
  // automation already in flight, or a latest already
  // waiting_approval/running/queued from an earlier call). Callers
  // (runOnceScheduled/runCronScheduled/retryWaitingReset) use this to skip
  // their post-processing (pause/reschedule) when nothing happened —
  // without it, a concurrent tick while a `once` is still in flight would
  // pause the automation mid-real-run.
  // `onDispatch`: called once, synchronously, when this fire is CONSUMED —
  // a run starts, a skip is written, or (a heartbeat) the slot passes in
  // silence; never on a no-op. A period's clock moves on it:
  // an owner's automation advances when a run starts, a
  // heartbeat at every slot it runs or skips — and a think that waits for
  // room keeps its slot due.
  async executeRun(a: Automation, opts?: { promptOverride?: string; cause?: string; onDispatch?: () => void }): Promise<boolean> {
    const dispatched = (): void => {
      try {
        opts?.onDispatch?.()
      } catch (err) {
        console.warn(`resident: the clock of ${a.id} did not move —`, err instanceof Error ? err.message : err)
      }
    }
    if (isHeartbeat(a)) return this.executeHeartbeat(a, opts?.cause, dispatched)
    if (this.running.has(a.id)) return false
    // its engine refused: a no-op like the lock — the beat stays due
    if (this.engineHeld(a) !== null) return false
    if (this.deps.store.openRuns(a.id).length > 0) return false

    const now = this.now()
    // an owner's gesture («Run now», cause manual) skips the cron's budget
    // and never counts in it
    const manual = opts?.cause === MANUAL_CAUSE
    const agent = this.deps.registry.get(a.agentId)
    // the agent's OWN recurring work waits for its territory:
    // accepted ones included; the owner's automations run with or without
    if (a.origin === 'self' && agent && !this.fenceOn(agent.id)) {
      dispatched()
      this.recordSkippedRun(a, `${agent.name}'s territory is off — its own automation waits for it`)
      return true
    }
    if (!manual) {
      const budget = a.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY
      if (this.deps.store.runsToday(a.id, now).length >= budget) {
        dispatched()
        this.recordSkippedRun(a, `daily budget reached (${budget}/day)`)
        return true
      }
    }
    // its own recurring work, on the agent's day: the ceiling (an
    // accepted one runs outside it) and the spend cap (accepted included)
    if (a.origin === 'self' && agent) {
      const today = ownTurnsToday({ automations: this.deps.store, ...(this.deps.wakesToday ? { wakesToday: this.deps.wakesToday } : {}) }, agent, now.getTime())
      const hold = ownCapHold(today, { outsideCeiling: a.acceptedFrom !== undefined })
      if (hold) {
        dispatched()
        this.recordSkippedRun(
          a,
          hold === 'ceiling' ? `${agent.name}'s daily ceiling (${today.ceiling}) is spent` : `${agent.name}'s daily spend cap is reached`,
        )
        return true
      }
    }
    // the live caps: an agent turn of an agent waits for a slot —
    // queued, never lost: a due run stays due and asks again next tick, an
    // owner's gesture ahead of what Silos inferred
    let slot: { release: () => void } | null = null
    if (!isCommandRun(a) && this.deps.slots && !a.approval) {
      const ans = this.deps.slots.tryAcquire({ id: `run:${a.id}`, agentId: a.agentId, gesture: manual, at: now.getTime() })
      if (!ans.ok) {
        this.held.set(a.id, heldWords(ans.cap, ans.running, agent?.name ?? a.agentId))
        return false
      }
      slot = ans
    }
    this.held.delete(a.id)
    return this.dispatch(a, now, slot, dispatched, opts?.promptOverride, opts?.cause, null)
  }

  private fenceOn(id: string): boolean {
    try {
      return this.deps.heartbeat?.fenceOn(id) ?? true
    } catch {
      return false
    }
  }

  /** A heartbeat's fire (as amended): only for
   *  an agent On its own (reconcile deletes it otherwise — this guards the
   *  race); its kind, skips and packet decided with zero tokens and nothing
   *  awaited in between. It never asks the automation's daily budget (its
   *  period is its ceiling). */
  private async executeHeartbeat(a: Automation, cause: string | undefined, dispatched: () => void): Promise<boolean> {
    const agent0 = this.deps.registry.get(a.agentId)
    if (!agent0 || controlOf(agent0, this.fenceOn(agent0.id)) !== 'own') return false
    // a fire already asking for its reading: this one is a no-op (the slot
    // stays due) — never two heartbeats of one agent decided at once
    if (this.preparing.has(a.id)) return false
    // the plan reading is ASKED for BEFORE the run's lock:
    // it may take seconds. With it in hand, the lock, the probe for
    // room and steps 1–7 are decided at once, nothing awaited in between —
    // or a slot, a re-arm and a «Run now» could launch two heartbeats.
    const reading = await this.readingFor(a, agent0, cause)
    const agent = this.deps.registry.get(a.agentId)
    if (!agent || controlOf(agent, this.fenceOn(agent.id)) !== 'own') return false
    const now = this.now()
    const manual = cause === MANUAL_CAUSE
    const alive = this.running.has(a.id) || this.deps.store.openRuns(a.id).length > 0
    const slots = this.deps.slots
    // the probe never queues: a look skipped for want of room holds
    // no place in the line
    const acct = this.heartbeats.accountOf(agent, a)
    const due = this.deps.store.get(a.id)?.nextRunAt
    const p = this.heartbeats.prepare(a, agent, now, cause, {
      engine: this.engineHeld(a),
      alive,
      room: () => (slots ? slots.wouldStart(a.agentId, manual, `run:${a.id}`) : true),
      account: acct ? { ...acct, reading: reading ?? this.peekReading(acct.id, acct.readable) } : null,
      ...(due !== undefined && !Number.isNaN(Date.parse(due)) ? { slotAt: Date.parse(due) } : {}),
    })
    if ('pass' in p) {
      dispatched()
      return true
    }
    if ('skip' in p) {
      dispatched()
      this.appendRun(a.id, {
        id: randomUUID(),
        automationId: a.id,
        at: now.toISOString(),
        status: 'skipped',
        reason: p.reason,
        ...(p.until !== undefined ? { until: p.until } : {}),
        heartbeat: p.heartbeat,
        ...(cause !== undefined ? { cause } : {}),
      })
      return true
    }
    if ('wait' in p) {
      // a think waits — queued like today: it takes its place in the
      // line, and the line paints it
      if (p.wait === 'room' && slots) {
        const ans = slots.tryAcquire({ id: `run:${a.id}`, agentId: a.agentId, gesture: manual, at: now.getTime() })
        if (ans.ok) ans.release()
        else this.held.set(a.id, heldWords(ans.cap, ans.running, agent.name))
      }
      return false
    }
    let slot: { release: () => void } | null = null
    if (slots) {
      const ans = slots.tryAcquire({ id: `run:${a.id}`, agentId: a.agentId, gesture: manual, at: now.getTime() })
      if (!ans.ok) {
        // the probe said room a moment ago, in the same synchronous stretch
        // — only a look could get here; it waits like a think rather than
        // skip twice
        this.held.set(a.id, heldWords(ans.cap, ans.running, agent.name))
        return false
      }
      slot = ans
    }
    this.held.delete(a.id)
    return this.dispatch(a, now, slot, dispatched, undefined, cause, p)
  }

  // the heartbeats asking for their plan reading right now
  private preparing = new Set<string>()

  /** The reading a fire's margin needs, ASKED for (a round or a think on an
   *  account that does not price and can be read) — else null, and the
   *  cache is peeked synchronously at decision time. */
  private async readingFor(a: Automation, agent: Agent, cause: string | undefined): Promise<MarginReading | null> {
    const usage = this.deps.heartbeat?.usage
    if (!usage) return null
    const acct = this.heartbeats.accountOf(agent, a)
    if (!acct || !acct.readable) return null
    if (!this.heartbeats.needsMargin(this.heartbeats.kindOf(agent, this.now(), cause), acct)) return null
    this.preparing.add(a.id)
    try {
      return await usage.get(acct.id)
    } catch {
      return null
    } finally {
      this.preparing.delete(a.id)
    }
  }

  private peekReading(id: string, readable: boolean): MarginReading | null {
    if (!readable) return null
    try {
      return this.deps.heartbeat?.usage?.peek(id) ?? null
    } catch {
      return null
    }
  }

  /** «Run now» on a heartbeat: held by the account's
   *  margin with its 409 — the reading ASKED for; without a fresh one it
   *  runs (a gesture). null: it may run. */
  async runNowMargin(a: Automation): Promise<string | null> {
    if (!isHeartbeat(a)) return null
    const agent = this.deps.registry.get(a.agentId)
    if (!agent) return null
    const acct = this.heartbeats.accountOf(agent, a)
    if (!acct || acct.priced || !acct.readable) return null
    let reading: MarginReading | null = null
    try {
      reading = (await this.deps.heartbeat?.usage?.get(acct.id)) ?? null
    } catch {
      reading = null
    }
    const m = marginOf(reading, this.now().getTime())
    return m.over ? runNowMarginWords(agent.name, m.over) : null
  }

  private async dispatch(
    a: Automation,
    now: Date,
    slot: { release: () => void } | null,
    dispatched: () => void,
    promptOverride: string | undefined,
    cause: string | undefined,
    hb: Extract<Prepared, { kind: 'look' | 'think' | 'round' }> | null,
  ): Promise<boolean> {
    const opts = { ...(promptOverride !== undefined ? { promptOverride } : {}), ...(cause !== undefined ? { cause } : {}) }
    dispatched()
    const runId = randomUUID()
    try {
      if (a.approval) {
        this.appendRun(a.id, {
          id: runId,
          automationId: a.id,
          at: now.toISOString(),
          status: 'waiting_approval',
          ...(opts?.promptOverride !== undefined ? { promptOverride: opts.promptOverride } : {}),
          ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        })
        return true
      }
      await this.runNow(a, runId, hb ? hb.prompt : opts?.promptOverride, opts?.cause, hb ? { heartbeat: hb.heartbeat } : undefined)
      return true
    } finally {
      slot?.release()
    }
  }

  // why a due run of an automation waits for a slot right now (the live
  // line's words), cleared when it starts
  readonly held = new Map<string, string>()

  // runNow now runs executeChatTurn() against a time cap (runTimeoutMs). If
  // the timeout wins: 'failed'/timeout is recorded, `running` is released
  // immediately (finally), and the SDK's real turn is ABORTED (chat.cancel,
  // best effort); executeChatTurn checks `state.timedOut` before touching
  // the store again, so a late result (the abort racing the turn's own
  // finish) is discarded without overwriting the already-closed run.
  async runNow(aIn: Automation, runId: string, promptOverride?: string, cause?: string, extra?: { heartbeat?: RunHeartbeat }): Promise<void> {
    this.running.add(aIn.id)
    this.liveRunIds.set(aIn.id, runId)
    const startedAt = this.now().toISOString()
    // a heartbeat's kind and listed keys are written AT START: the
    // live turn's class reads them, never the finished run
    this.appendRun(aIn.id, {
      id: runId,
      automationId: aIn.id,
      at: startedAt,
      status: 'running',
      startedAt,
      ...(cause !== undefined ? { cause } : {}),
      ...(extra?.heartbeat ? { heartbeat: extra.heartbeat } : {}),
    })
    const t0 = Date.now()
    const state = { timedOut: false, produced: false }
    let timer: NodeJS.Timeout | undefined
    // the lane — what the automation runs NOW (an edit may have switched it
    // since the dispatch): a command replaces the chat turn and nothing else
    const current = this.deps.store.get(aIn.id) ?? aIn
    const command = isCommandRun(current) ? current.run : null
    // a command carries its own timeout; this cap only catches a lane that
    // never returns, with room for the kill and a hand-over turn
    const cap = command
      ? Math.min(command.timeoutMs ?? COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MAX_MS) +
        COMMAND_KILL_SLACK_MS +
        (command.onFailure === 'agent' ? this.runTimeoutMs : 0)
      : this.runTimeoutMs
    try {
      const work = command
        ? this.executeCommandRun(aIn, runId, startedAt, t0, promptOverride, state)
        : this.executeChatTurn(aIn, runId, startedAt, t0, promptOverride, state)
      this.track(work) // if abandoned due to timeout, it must not produce an unhandled rejection
      const timedOut = await new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), cap)
        timer.unref?.()
        work.then(
          () => resolve(false),
          () => resolve(false),
        )
      })
      if (timer) clearTimeout(timer)
      if (timedOut) {
        state.timedOut = true
        const a = this.deps.store.get(aIn.id) ?? aIn
        const sessionKey = this.runSessionKeys.get(runId)
        const turnId = this.runTurnIds.get(runId) // before finishRun prunes it
        this.finishRun(a, runId, startedAt, t0, {
          status: 'failed',
          error: 'timeout',
          produced: state.produced,
          ...(sessionKey !== undefined ? { sessionKey } : {}),
        })
        // The zombie turn is ABORTED, not just untracked: left alive it
        // keeps burning the account and can overlap the automation's next
        // run (the lock is already released). Best effort — the turn may
        // have just finished on its own.
        if (turnId !== undefined) {
          this.deps.usageTimeout?.(turnId)
          this.track(this.deps.chat.cancel(turnId))
        }
      }
    } finally {
      this.running.delete(aIn.id)
      this.liveRunIds.delete(aIn.id)
    }
  }

  // The command lane: the
  // automation's argv exec'd without a shell or a Claude, with the env an
  // agent's console gets (its Vault secrets, agent state, its bearer when
  // territory hands it one) plus PATH and HOME — never the server's whole
  // env. The log is redacted of every injected secret before it is written.
  // A failure either stays a failure (onFailure 'inbox': the Needs you row
  // of class `command`) or is handed, in the same run, to an agent turn
  // through the normal chat lane (onFailure 'agent').
  private async executeCommandRun(
    aIn: Automation,
    runId: string,
    startedAt: string,
    t0: number,
    promptOverride: string | undefined,
    state: { timedOut: boolean; produced: boolean },
  ): Promise<void> {
    const a = this.deps.store.get(aIn.id) ?? aIn
    const fail = (error: string): void => {
      if (!state.timedOut) this.finishRun(a, runId, startedAt, t0, { status: 'failed', error })
    }
    const agent = this.deps.registry.get(a.agentId)
    if (!agent || agent.archived) {
      fail('agent not found or archived')
      return
    }
    let run: CommandRun
    let argv: string[]
    let cwd: string
    let stateEnv: Record<string, string> = {}
    try {
      // what is stored is re-read through the API's own validator: a hand-
      // edited automations.json gets the same rules as a POST
      const v = validateRun(a.run)
      if (v?.kind !== 'command') throw new Error('not a command')
      run = v
      try {
        stateEnv = this.deps.agentState?.envFor(agent.id) ?? {}
      } catch {
        stateEnv = {}
      }
      const stateDir = stateEnv.SILOS_AGENT_STATE ?? null
      argv = run.argv.map((x) => expandAgentState(x, stateDir))
      const folder = run.cwd ?? agent.folder ?? (a.thread.mode === 'keep' ? a.thread.folder : undefined)
      if (!folder) throw new Error('a command on Anywhere needs a folder (run.cwd)')
      cwd = expandAgentState(folder, stateDir)
    } catch (err) {
      fail(`command: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // PATH/HOME from the server, then the agent's process env (agent-env.ts:
    // Vault, agent state, SILOS_API — no session: a command serves none)
    // a command run is a turn of its automation too:
    // its bearer writes carry a token of class `run`, minted here and
    // dropped when the command ends — by the same env channel as every turn
    const live = this.deps.chat.liveTurns
    const turnToken = live
      ? live.mintTurn({ agentId: agent.id, turnId: `command-${runId}`, turn: { class: 'run', automationId: a.id, runId }, unattended: true })
      : undefined
    const env: Record<string, string> = {
      ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
      ...agentProcessEnv({ vault: this.deps.vault, agentState: this.deps.agentState, silosApi: this.deps.silosApi }, agent, cwd, undefined, turnToken),
    }
    const secrets = [
      ...(this.deps.vault?.secretsFor?.(agent.id, cwd) ?? Object.values(this.deps.vault?.envFor(agent.id, cwd) ?? {})),
      ...(env.SILOS_AGENT_TOKEN ? [env.SILOS_AGENT_TOKEN] : []),
      ...(turnToken ? [turnToken] : []),
    ]
    const timeoutMs = Math.min(run.timeoutMs ?? COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MAX_MS)
    let res: Awaited<ReturnType<typeof runCommand>>
    try {
      res = await runCommand({ argv, cwd, env, timeoutMs, logFile: this.deps.store.runLogPath(a.id, runId), secrets })
    } finally {
      if (turnToken) live?.drop(turnToken)
    }
    // it ran (it started at all): that is a run's worth of work, same as a
    // turn that produced something — the daily budget counts it
    const started = res.exitCode !== undefined || res.timedOut || /^killed by/.test(res.error ?? '')
    if (started) state.produced = true
    if (state.timedOut) return

    const leg: CommandLeg = {
      ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
      ...(res.timedOut ? { timedOut: true } : {}),
      ...(res.error !== undefined ? { error: res.error } : {}),
      durationMs: res.durationMs,
      ...(res.lastLine !== undefined ? { lastLine: res.lastLine } : {}),
      logBytes: res.logBytes,
    }
    const ok = res.exitCode !== undefined && (run.okCodes ?? [0]).includes(res.exitCode)
    if (ok) {
      // the same OUTCOME line an agent run ends with, if the script prints it
      const parsed = parseRunOutcome(res.output)
      const summary = parsed.outcome ? lastNonEmptyLine(parsed.summary) : res.lastLine
      this.safeStoreUpdate(a.id, { lastRunError: undefined })
      this.finishRun(a, runId, startedAt, t0, {
        status: 'ok',
        produced: true,
        command: leg,
        ...(summary !== undefined ? { summary } : {}),
        ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
      })
      return
    }
    const failText = commandFailureText(leg, timeoutMs)
    if (run.onFailure !== 'agent') {
      this.safeStoreUpdate(a.id, { lastRunError: failText })
      this.finishRun(a, runId, startedAt, t0, {
        status: 'failed',
        error: failText,
        produced: state.produced,
        command: leg,
        ...(res.lastLine !== undefined ? { summary: res.lastLine } : {}),
      })
      return
    }
    // the hand-over: one agent turn inside this same run, through the
    // normal chat lane (its limits, its thread rotation); finishRun folds
    // the command leg into whatever that turn ends as. The tail is the
    // redacted log: a secret never reaches the model through it.
    const tail = tailLines(res.output, 40)
    const fence = '```'
    const told = tail.trim() !== '' ? ` The last 40 lines of its log:\n\n${fence}\n${tail}\n${fence}` : ' It printed nothing.'
    const prompt = `${promptOverride ?? a.prompt}\n\nThe command \`${run.argv.join(' ')}\` ${failText}.${told}`
    this.commandLegs.set(runId, leg)
    await this.executeChatTurn(a, runId, startedAt, t0, prompt, state, { handover: true })
  }

  private async executeChatTurn(
    aIn: Automation,
    runId: string,
    startedAt: string,
    t0: number,
    promptOverride: string | undefined,
    state: { timedOut: boolean; produced: boolean },
    opts?: { handover?: boolean },
  ): Promise<void> {
    // a hand-over never waits for a reset: the command already failed, and
    // the run says so with both reasons
    const keepAlive = aIn.keepAlive && !opts?.handover
    const a = this.deps.store.get(aIn.id) ?? aIn
    const agent = this.deps.registry.get(a.agentId)
    if (!agent || agent.archived) {
      if (!state.timedOut) this.finishRun(a, runId, startedAt, t0, { status: 'failed', error: 'agent not found or archived' })
      return
    }
    const isMaster = agent.folder === null

    let resume: { sessionId: string; mode: 'append' | 'fork' } | undefined
    let cwdOverride: string | undefined
    let promptPrefix = ''
    // Lineage: sessionKey ("folder/id") of the ROTATED-OUT session — if
    // this execution ends up rotating, the new session is born from it and
    // it needs to be recorded in lineage (below, as soon as sessionKey
    // confirms the new session via chat-init).
    let rotatedFromKey: string | undefined
    if (a.thread.mode === 'keep') {
      const effectiveCwd = isMaster ? a.thread.folder : (agent.folder ?? undefined)
      if (effectiveCwd === undefined) {
        if (!state.timedOut) this.finishRun(a, runId, startedAt, t0, { status: 'failed', error: 'Anywhere needs a folder on the thread (thread.folder)' })
        return
      }
      cwdOverride = isMaster ? effectiveCwd : undefined
      if (a.thread.sessionId) {
        const folderKey = mungePath(effectiveCwd)
        if (this.isOpenInTerminal(a.thread.sessionId)) {
          if (!state.timedOut) this.finishRun(a, runId, startedAt, t0, { status: 'skipped', reason: 'session open in terminal' })
          return
        }
        const meta = this.deps.index.getMeta(folderKey, a.thread.sessionId)
        if (this.needsRotation(meta, a)) {
          const summary = await this.lastAssistantSummary(folderKey, a.thread.sessionId)
          promptPrefix = `Continuing routine ${a.name}; summary of previous thread: ${summary}\n\n`
          resume = undefined
          rotatedFromKey = `${folderKey}/${a.thread.sessionId}`
        } else {
          resume = { sessionId: a.thread.sessionId, mode: 'append' }
        }
      }
    } else {
      if (isMaster) {
        if (!state.timedOut)
          this.finishRun(a, runId, startedAt, t0, { status: 'failed', error: 'Anywhere needs a folder on the thread (use thread.keep with a folder)' })
        return
      }
    }

    const turnId = randomUUID()
    // Registers this turnId as "started by an automation run" BEFORE
    // calling chat.send() — chat-service.ts emits 'chat-event' (which
    // onChatEvent listens to) SYNCHRONOUSLY before yielding that same
    // event to this for-await, so the guard must be armed before the
    // first event (chat-init) can arrive.
    this.liveRunTurnIds.add(turnId)
    this.runTurnIds.set(runId, turnId)
    // Isolation stays on (no user hooks/plugins); `projectSettings` only
    // widens the sources so the SDK can discover the skills installed in
    // the run's own folder (.claude/skills) — without it, an automation
    // whose prompt says "follow your X skill" runs blind.
    // a heartbeat runs with hooks off, FIXED: its
    // inheritHooks is never read
    const beat = isHeartbeat(a)
    const isolation =
      a.inheritHooks && !beat
        ? undefined
        : {
            settingSources: (a.projectSettings ? ['user', 'project'] : ['user']) as Array<'user' | 'project' | 'local'>,
            disableAllHooks: true,
          }
    const hbAtStart = this.deps.store.runById(a.id, runId)?.heartbeat
    // the regime SEALED at the start rides the live
    // turn: the engine's options, the judge and the audit read it there
    const turnClass = beat
      ? {
          class: 'heartbeat' as const,
          automationId: a.id,
          runId,
          ...(hbAtStart
            ? {
                kind: hbAtStart.kind,
                packetKeys: hbAtStart.packet.keys,
                ...(hbAtStart.perDay !== undefined ? { regime: { tools: hbAtStart.tools === true, perDay: hbAtStart.perDay } } : {}),
              }
            : {}),
        }
      : { class: 'run' as const, automationId: a.id, runId }
    this.turnRuns.set(turnId, { automationId: a.id, runId })
    // continuing a run the last server restart cut mid-turn: its session
    // already holds part of the work — resume it (append) instead of opening
    // a second conversation. Consumed on this dispatch whether or not it
    // applies (a stale or vanished session means a normal fresh run).
    // A heartbeat never resumes: the one a restart
    // cut stays `interrupted`, and its next slot is a fresh conversation.
    const interrupted = beat ? undefined : this.resumeAfterRestart.get(a.id)
    if (beat) this.resumeAfterRestart.delete(a.id)
    if (interrupted) {
      this.resumeAfterRestart.delete(a.id)
      const slash = interrupted.sessionKey.indexOf('/')
      const iFolder = interrupted.sessionKey.slice(0, slash)
      const iId = interrupted.sessionKey.slice(slash + 1)
      const fresh = this.now().getTime() - interrupted.at < SIX_HOURS_MS
      if (fresh && slash > 0 && existsSync(join(this.deps.root, iFolder, `${iId}.jsonl`))) {
        resume = { sessionId: iId, mode: 'append' }
        rotatedFromKey = undefined
        promptPrefix = `A Silos server restart interrupted the previous run of ${a.name} mid-turn. This conversation already holds what that run did — continue from there and do not redo what is done.\n\n${promptPrefix}`
      }
    }
    // a heartbeat's prompt has no OUTCOME line (the server measures it)
    const text = promptPrefix + (beat ? (promptOverride ?? a.prompt) : withOutcomeInstruction(promptOverride ?? a.prompt))

    let sessionKey: string | undefined
    // The run's summary is its FINAL assistant message — the text streamed
    // after the last tool call — not every narration line of the turn glued
    // together ("Loading the skill… step by step.It's"). Same rule as
    // lastAssistantSummary over a transcript: the last thing the agent said.
    let finalMessage = ''
    let toolSinceText = false
    let errorText: string | undefined
    let refused: string | undefined
    let doneSubtype: string | undefined
    let rateLimitRejected = false
    let rateLimitResetsAt: string | undefined
    // what the turn cost, from its chat-done; null: unsaid
    let costUsd: number | null = null

    try {
      // Every send from the resident is an unattended run — the flag is
      // explicit and independent of `isolation` (which travels as
      // undefined with inheritHooks:true). This is the ONLY call site of
      // chat.send() in resident.ts: runs, keep threads, rotations, and
      // retries all go through executeChatTurn.
      // what the automation runs on (runsOn) rides as the TURN level of the
      // cockpit cascade — over the kept conversation's pin and the agent's
      // default, on both engines (ChatService resolves it like a UI turn)
      const overrides = a.runsOn ? { ...a.runsOn } : undefined
      for await (const ev of this.deps.chat.send({
        turnId,
        agentId: agent.id,
        text,
        resume,
        cwd: cwdOverride,
        isolation,
        unattended: true,
        turn: turnClass,
        ...(overrides ? { overrides } : {}),
      })) {
        this.deps.broadcast(ev)
        // Also accessible by runId from runNow's timeout branch (which
        // doesn't know turnId) — so a run that times out can still record
        // its sessionKey on the 'failed' Run and close the anti-loop guard
        // even on a new thread's first turn.
        if (ev.ev === 'chat-init') {
          if (ev.model) this.runModels.set(runId, ev.model)
          sessionKey = `${ev.folder}/${ev.sessionId}`
          this.runSessionKeys.set(runId, sessionKey)
          // Persisted on the running row THERE AND THEN — a hard crash
          // (kill -9, OOM: no shutdown(), no finishRun) must still leave
          // the next boot the sessionKey to continue the session with.
          {
            const row = this.deps.store.runById(a.id, runId)
            if (row && row.status === 'running' && row.sessionKey === undefined) this.appendRun(a.id, { ...row, sessionKey })
          }
          // no `resume` = this run opened the session: its birth, recorded
          // once (a keep thread's later runs resume and record nothing).
          if (resume === undefined) this.deps.origins?.record(sessionKey, { kind: 'automation', automationId: a.id, runId, at: this.now().toISOString() })
        } else if (ev.ev === 'chat-delta') {
          if (toolSinceText && ev.text.trim() !== '') {
            finalMessage = ''
            toolSinceText = false
          }
          finalMessage += ev.text
          if (ev.text !== '') state.produced = true
        } else if (ev.ev === 'chat-tool') {
          toolSinceText = true
          state.produced = true
        } else if (ev.ev === 'chat-thinking') state.produced = true
        else if (ev.ev === 'chat-usage' && ev.outputTokens > 0) state.produced = true
        else if (ev.ev === 'chat-ratelimit' && ev.status === 'rejected') {
          rateLimitRejected = true
          rateLimitResetsAt = ev.resetsAt
        } else if (ev.ev === 'chat-error') errorText = ev.error
        else if (ev.ev === 'chat-done') {
          doneSubtype = ev.subtype
          costUsd = ev.costUsd
          if (ev.priced !== undefined) this.runPriced.set(runId, ev.priced)
        }
      }
    } catch (err) {
      if (err instanceof EngineRefusedError) refused = err.message
      else errorText = err instanceof Error ? err.message : String(err)
    } finally {
      // `chat.send` is an async generator — its own synchronous
      // validations (a missing/archived agent in a race, master with no
      // cwd, or the "a turn is already in progress for this session" lock
      // — plausible: a keep automation fires while the owner is mid-turn
      // on THAT session in the UI) throw BEFORE chat-service enters its own
      // try/catch (the only place that emits 'chat-error'), so that path
      // NEVER emits a terminal event for this turnId — without this
      // cleanup, the liveRunTurnIds entry would stay orphaned forever (the
      // 'chat-error' event only covers its own case, not its absence).
      // Idempotent: on the normal path, onChatEvent already deleted it via
      // chat-done/chat-error.
      this.liveRunTurnIds.delete(turnId)
      this.turnRuns.delete(turnId)
    }
    this.runCosts.set(runId, costUsd)

    // If the run was already declared 'failed'/timeout while this turn was
    // still in progress, don't touch anything else (thread, lastRunError,
    // a second run snapshot, or backup) — the real turn is still alive (we
    // don't kill it), but the resident already stopped counting it.
    if (state.timedOut) return

    // persist the keep thread's new sessionId/folder (first time or after a rotation)
    // From here on, the automation could have been deleted while the turn
    // was in flight (store.update() throws if the id no longer exists) —
    // safeStoreUpdate is used at every point in this stretch so the run
    // ALWAYS reaches finishRun/appendRun and ends up in a terminal state
    // in runs.jsonl, instead of a phantom 'running'.
    if (a.thread.mode === 'keep' && sessionKey) {
      // Epoch guard. `a` is the snapshot this run started from; the store
      // may have moved on while the turn was in flight — autonomy.reconcile()
      // runs on every resident tick and, on any run-mode transition, both
      // rewrites the prompt and reopens the thread. Persisting this run's
      // sessionId over that would resurrect a conversation the platform
      // just deliberately closed, and the next beat would resume it.
      // The prompt is the epoch marker: EVERY autonomy transition changes
      // it, and a plain user edit that changes it is an equally good reason
      // not to stamp an old session onto the new intent. A deleted
      // automation (get -> null) compares unequal too, which is right: there
      // is nothing left to persist into.
      // The thread is a second marker: a run that started on a keep thread
      // which was turned into `new` meanwhile (a standing duty's beat runs
      // in a fresh conversation each time — Autonomy.reconcile sets a
      // keep thread back to `new` without touching the prompt) must not turn
      // it back into keep.
      const current = this.deps.store.get(a.id)
      const superseded = current?.prompt !== a.prompt || current?.thread.mode !== 'keep'
      if (!superseded) {
        const [, sid] = sessionKey.split('/') as [string, string]
        const nextThread = isMaster ? { mode: 'keep' as const, folder: a.thread.folder, sessionId: sid } : { mode: 'keep' as const, sessionId: sid }
        this.safeStoreUpdate(a.id, { thread: nextThread })
      }
      // Lineage is a fact about the sessions themselves (this one was born
      // from that one), true regardless of which thread the automation now
      // points at — recorded either way.
      if (rotatedFromKey) this.deps.lineage?.record(sessionKey, rotatedFromKey)
    }

    const parsed = parseRunOutcome(finalMessage)
    const summary = parsed.summary.slice(0, 200)

    if (refused !== undefined && !state.produced) {
      // the engine was refused at send time (it went outdated since the last
      // reading): said plainly in the history, never a failure — the
      // engineCompat row is the owner's word, and the next beats wait for the
      // engine (engineHeld) instead of running
      this.finishRun(a, runId, startedAt, t0, { status: 'skipped', reason: `its engine can't run: ${refused}`, sessionKey })
    } else if (errorText) {
      this.safeStoreUpdate(a.id, { lastRunError: errorText })
      if (rateLimitRejected || looksLikeRateLimit(errorText)) {
        if (keepAlive) {
          const resetsAt = rateLimitResetsAt ?? this.parseResetFromText(errorText) ?? new Date(this.now().getTime() + 3600_000).toISOString()
          this.safeStoreUpdate(a.id, { nextRunAt: this.nextRetryAt(agent.id, resetsAt) })
          // Persists this specific run's EFFECTIVE promptOverride (the
          // webhook payload, the watch fingerprint) on the Run — without
          // this, the tick's retry (retryWaitingReset) would retry with
          // the automation's BASE prompt, silently losing the context that
          // was the run's reason for existing.
          this.finishRun(a, runId, startedAt, t0, { status: 'waiting_reset', error: errorText, resetsAt, sessionKey, promptOverride, produced: state.produced })
        } else {
          this.finishRun(a, runId, startedAt, t0, { status: 'failed', error: errorText, sessionKey, produced: state.produced })
        }
      } else {
        this.finishRun(a, runId, startedAt, t0, { status: 'failed', error: errorText, sessionKey, produced: state.produced })
      }
    } else if (rateLimitRejected && keepAlive) {
      const resetsAt = rateLimitResetsAt ?? new Date(this.now().getTime() + 3600_000).toISOString()
      this.safeStoreUpdate(a.id, { nextRunAt: this.nextRetryAt(agent.id, resetsAt) })
      // Same criterion as above — persists the effective promptOverride.
      this.finishRun(a, runId, startedAt, t0, { status: 'waiting_reset', resetsAt, sessionKey, promptOverride, produced: state.produced })
    } else if (doneSubtype === 'success') {
      this.safeStoreUpdate(a.id, { lastRunError: undefined })
      this.finishRun(a, runId, startedAt, t0, {
        status: 'ok',
        summary,
        sessionKey,
        produced: state.produced,
        ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
      })
    } else {
      this.finishRun(a, runId, startedAt, t0, {
        status: 'failed',
        error: doneSubtype ? `result: ${doneSubtype}` : 'the turn did not finish',
        sessionKey,
        produced: state.produced,
      })
    }
  }

  // Providers v1 — simple fallback, resident side: when the run's turn hit
  // a rate limit and that rate limit ARMED a fallback for the agent
  // (ChatService.noteRateLimit, the same event from this same turn), the
  // retry doesn't have to wait for the primary's resetsAt — it's scheduled
  // NOW (the next tick picks it up) and that retry, being a NEW turn, goes
  // out through the fallback provider (turn boundary: the failed run stays
  // waiting_reset with its real resetsAt, that record is untouched).
  // Without an armed fallback, the behavior is the usual one: wait for the
  // reset. An optional call on purpose: tests build ChatService fakes that
  // don't know about fallbackStateOf — safe degradation to the classic behavior.
  private nextRetryAt(agentId: string, resetsAt: string): string {
    const fb = this.deps.chat.fallbackStateOf?.(agentId, this.now())
    return fb ? this.now().toISOString() : resetsAt
  }

  private finishRun(
    a: Automation,
    runId: string,
    startedAt: string,
    t0: number,
    outIn: {
      status: RunStatus
      error?: string
      summary?: string
      outcome?: RunOutcome
      sessionKey?: string
      reason?: string
      resetsAt?: string
      promptOverride?: string
      produced?: boolean
      command?: CommandLeg
    },
  ): void {
    // a hand-over turn ending: the run keeps the command leg too, and a turn
    // that never ran (skipped on an open console, refused at a limit) leaves
    // the run failed — the command's failure is still unanswered
    const handedLeg = this.commandLegs.get(runId)
    this.commandLegs.delete(runId)
    let out = outIn
    if (handedLeg) {
      out = { ...outIn, command: handedLeg, produced: true }
      if (out.status === 'skipped') out = { ...out, status: 'failed', error: `the hand-over was skipped: ${out.reason ?? 'no reason'}` }
      if (out.status === 'waiting_reset') out = { ...out, status: 'failed' }
    }
    const command = out.command
    const endedAt = this.now().toISOString()
    const durationMs = Date.now() - t0
    // The cause lives on the initial record; carried onto the terminal one
    // (runs fold by id, last line wins) so the history still says why — the
    // run found BY ITS ID: a skip row written meanwhile is no reason to lose
    // its cause or its sealed regime
    const opened = this.deps.store.runById(a.id, runId)
    const cause = opened?.cause
    // a heartbeat run closes what its start opened: the considered
    // lines and the sleep its turn recorded
    const hbStart = opened?.heartbeat
    const slept = this.sleptUntil.get(runId)
    this.sleptUntil.delete(runId)
    const heartbeat: RunHeartbeat | undefined = hbStart
      ? { ...hbStart, considered: this.deps.heartbeat?.store.countForRun(a.agentId, runId) ?? hbStart.considered, ...(slept ? { sleptUntil: slept } : {}) }
      : undefined
    // every run says what it cost when it closes: its turn's
    // chat-done, null when it ran none (a command) or said no price
    const costUsd = this.runCosts.has(runId) ? (this.runCosts.get(runId) ?? null) : null
    this.runCosts.delete(runId)
    const model = this.runModels.get(runId)
    this.runModels.delete(runId)
    const priced = this.runPriced.get(runId)
    this.runPriced.delete(runId)
    const run: Run = {
      id: runId,
      automationId: a.id,
      at: startedAt,
      status: out.status,
      startedAt,
      endedAt,
      durationMs,
      ...(cause !== undefined ? { cause } : {}),
      ...(out.sessionKey !== undefined ? { sessionKey: out.sessionKey } : {}),
      ...(out.error !== undefined ? { error: out.error } : {}),
      ...(out.summary !== undefined ? { summary: out.summary } : {}),
      ...(out.outcome !== undefined ? { outcome: out.outcome } : {}),
      ...(out.reason !== undefined ? { reason: out.reason } : {}),
      ...(out.resetsAt !== undefined ? { resetsAt: out.resetsAt } : {}),
      ...(out.produced !== undefined ? { produced: out.produced } : {}),
      ...(command ? { command, ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}) } : {}),
      ...(handedLeg ? { handover: true } : {}),
      // Only relevant on 'waiting_reset' — the retry (retryWaitingReset)
      // re-reads it from this same Run.
      ...(out.promptOverride !== undefined ? { promptOverride: out.promptOverride } : {}),
      costUsd,
      ...(model ? { model } : {}),
      ...(priced !== undefined ? { priced } : {}),
      ...(heartbeat ? { heartbeat } : {}),
    }
    // appendRun (recording the terminal state in runs.jsonl) NEVER depends
    // on the automation still existing — that's what prevents a phantom
    // 'running' forever. Only the lastRun summary on the Automation itself
    // is skipped if it was already deleted.
    this.appendRun(a.id, run)
    this.safeStoreUpdate(a.id, {
      lastRun: {
        at: endedAt,
        status: out.status,
        durationMs,
        ...(out.sessionKey !== undefined ? { sessionKey: out.sessionKey } : {}),
        ...(out.summary !== undefined ? { summary: out.summary } : {}),
        ...(out.outcome !== undefined ? { outcome: out.outcome } : {}),
        ...(command?.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
      },
    })
    this.runSessionKeys.delete(runId) // the run already closed — no need to keep carrying the entry
    this.runTurnIds.delete(runId)
    // the transcript audit of every unattended agent turn, once the
    // turn is over: written onto the same run (runs fold by id)
    if (out.sessionKey !== undefined && !command) this.track(this.auditRun(a, run))
  }

  private runCosts = new Map<string, number | null>()
  // runId → the model its turn ran (chat-init), written on the closed run
  private runModels = new Map<string, string>()
  // runId → whether its turn's provider prices (chat-done), for the Run row
  private runPriced = new Map<string, boolean>()

  /** Undo: the live chat turn of an automation's run, cancelled —
   *  true when one was running in this process. */
  cancelLiveRun(automationId: string): boolean {
    const runId = this.liveRunIds.get(automationId)
    const turnId = runId !== undefined ? this.runTurnIds.get(runId) : undefined
    if (!turnId) return false
    void this.deps.chat.cancel(turnId).catch(() => false)
    return true
  }

  /** Read the finished turn's transcript (and its children,
   *  nested sessions included) and write `audit` onto its run; the verdict
   *  that follows lives in auditVerdict. Never throws: an audit that cannot
   *  read fails CLOSED — `transcript unreadable` in readOutside (tainted in
   *  a heartbeat), and its Needs you row says so (inbox auditUnreadableRow). */
  async auditRun(a: Automation, run: Run): Promise<void> {
    if (!this.deps.audit || run.sessionKey === undefined) return
    let audit: RunAudit | null = null
    try {
      audit = await this.deps.audit({ agentId: a.agentId, sessionKey: run.sessionKey, startedAt: run.startedAt ?? run.at })
    } catch (err) {
      console.warn(`resident: audit of run ${run.id} failed —`, err instanceof Error ? err.message : err)
      audit = { readOutside: [TRANSCRIPT_UNREADABLE] }
    }
    if (!audit) return
    const latest = this.deps.store.runById(a.id, run.id) ?? run
    this.appendRun(a.id, { ...latest, audit })
    // the regime its run SEALED — never the agent's now
    const tools = latest.heartbeat?.tools === true
    if (isHeartbeat(a) && tools && audit.readOutside.length > 0) this.boundSleep(a.agentId, latest)
    this.auditVerdict(a.agentId, run.id, audit, isHeartbeat(a), tools)
  }

  /** A sleep asked in a round WITH its tools that read outside is bounded to
   *  ROUND_SLEEP_AFTER_OUTSIDE: what it read must
   *  not buy a long silence. */
  private boundSleep(agentId: string, run: Run): void {
    const slept = run.heartbeat?.sleptUntil
    if (!slept) return
    const agent = this.deps.registry.get(agentId)
    const current = agent?.heartbeat?.sleepUntil
    const cap = this.now().getTime() + ROUND_SLEEP_AFTER_OUTSIDE_MS
    if (!agent || !current || current !== slept || Date.parse(current) <= cap) return
    try {
      this.deps.registry.update(agentId, { heartbeat: { sleepUntil: new Date(cap).toISOString() } })
    } catch (err) {
      console.warn(`resident: could not bound the sleep of ${agentId} —`, err instanceof Error ? err.message : err)
    }
  }

  /** The verdict of an audit: the USE of the owner's
   *  credential in any unattended turn is an infraction that cuts; a
   *  heartbeat that read outside is tainted — it undoes what it created and
   *  cuts only when it created or proposed (creations and proposals carry
   *  their run from t5 on: until then a taint is marked, never cut). */
  auditVerdict(agentId: string, runId: string, audit: RunAudit, heartbeat: boolean, tools = false): void {
    const agent = this.deps.registry.get(agentId)
    if (!agent) return
    // t5: the ledger exists — the run's creations and proposals are
    // re-stamped and, tainted, undone; the cut follows what it created or
    // proposed (initiative.ts afterAudit). A heartbeat sealed WITH its
    // tools is audited like a wake: marked, never undone
    if (this.deps.afterAudit) {
      const blocks = this.deps.heartbeat?.blocks(agent)
      try {
        this.deps.afterAudit(agentId, runId, audit, {
          heartbeat,
          tools,
          gaps: { mcp: blocks ? !blocks.connectors : false, childSessions: blocks ? !blocks.subagents : false },
        })
      } catch (err) {
        console.warn(`resident: the audit verdict of run ${runId} failed —`, err instanceof Error ? err.message : err)
      }
      return
    }
    // the credential's USE (credential position in a network command)
    // cuts in any unattended turn; naming it is provenance, never a cut
    let why = ownerCredentialCut(audit)
    if (!why && heartbeat && !tools) {
      // a tainted heartbeat undoes and cuts only when it created or proposed
      // something — creations and proposals carry their run from t5 on, so
      // here a taint is recorded on the run (audit.readOutside) and nothing
      // is cut: looking outside without creating is not the infraction
      const blocks = this.deps.heartbeat?.blocks(agent)
      const v = heartbeatVerdict(audit, {
        createdOrProposed: false,
        gaps: { mcp: blocks ? !blocks.connectors : false, childSessions: blocks ? !blocks.subagents : false },
      })
      why = v.cut ? v.why : null
    }
    if (!why) return
    try {
      this.deps.registry.update(agentId, { cut: { at: this.now().toISOString(), why, run: runId } })
    } catch (err) {
      console.warn(`resident: could not record the cut of ${agentId} —`, err instanceof Error ? err.message : err)
    }
  }

  // A tolerant wrapper — the automation could have been deleted while a
  // run was still in flight; AutomationsStore.update() throws if the id no
  // longer exists. Used in executeChatTurn/finishRun's final stretch,
  // where throwing would leave the run stuck in 'running' forever.
  private safeStoreUpdate(id: string, patch: Partial<Omit<Automation, 'id'>>): void {
    if (!this.deps.store.get(id)) return
    try {
      this.deps.store.update(id, patch)
    } catch {
      /* an unlikely race between the check and the update — the run has no owner left, we carry on */
    }
  }

  // ---- keep-thread rotation --------------------------------

  private needsRotation(meta: SessionMeta | null, a: Automation): boolean {
    if (a.lastRunError && looksLikeTooLong(a.lastRunError)) return true
    if (!meta || meta.contextTokens === undefined) return false
    return meta.contextTokens / contextWindowFor(meta.model) >= ROTATION_THRESHOLD
  }

  // public: a conversation trigger hands the finished conversation's last
  // words to its run (watchers.ts runOnFinished)
  async lastAssistantSummary(folder: string, id: string): Promise<string> {
    try {
      const turns = await this.deps.index.readTurns(folder, id)
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i]
        if (t && t.role === 'assistant' && t.text.trim() !== '') return t.text.slice(-2000)
      }
    } catch {
      /* session unreadable — proceed without a summary, not fatal */
    }
    return ''
  }

  // ---- collision with the terminal --------------------------------

  private isOpenInTerminal(sessionId: string): boolean {
    let entries: string[]
    try {
      entries = readdirSync(this.claudeSessionsDir)
    } catch {
      return false
    }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = JSON.parse(readFileSync(join(this.claudeSessionsDir, f), 'utf8')) as { pid?: unknown; sessionId?: unknown }
        if (raw.sessionId === sessionId && typeof raw.pid === 'number' && this.isPidAlive(raw.pid)) return true
      } catch {
        continue
      }
    }
    return false
  }
}
