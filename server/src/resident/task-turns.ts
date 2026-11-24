// resident/task-turns.ts — one task-mode turn (task-mode/engine.ts asks for
// it): the resident runs it through ChatService. Moved out of the retired
// message delivery (no message wakes anyone).
import { randomUUID } from 'node:crypto'
import { UNATTENDED_TURN_TIMEOUT_MS } from '../limits.js'
import { TRANSCRIPT_UNREADABLE, ownerCredentialCut, type RunAudit } from '../heartbeat-audit.js'
import { looksLikeRateLimit } from '../fallback.js'
import { EngineRefusedError } from '../harness-run.js'
import { NO_OUTPUT } from './constants.js'
import { ResidentPart } from './core.js'
import type { TurnDeclaration } from '../live-turns.js'

// One task-mode turn, as task-mode/engine.ts asks for it (openTaskTurn).
export interface TaskTurnInput {
  agentId: string
  text: string
  resume: string | null
  onSession(sessionId: string): void
  onStarted?(): void
  origin?: { task: string; ref: string }
  // the turn's class (live-turns.ts) — a task wake:
  // { class: 'wake', taskKey }
  turn: TurnDeclaration
  // the transcript audit of the finished turn, once it is read — the
  // TASK is its record (task-mode/store.ts audits): an unreadable transcript
  // arrives as `transcript unreadable` (fail closed), never dropped
  onAudit?(audit: RunAudit, at: { sessionId: string }): void
}
export interface TaskTurnResult {
  costUsd: number | null
  model?: string
  priced?: boolean
  started: boolean
  limitedUntil?: string | null
  error?: string
  refused?: string
}

export class TaskTurns extends ResidentPart {
  // One task-mode turn (task-mode/engine.ts): the scoped briefing as an SDK
  // turn of the agent — on the task's own conversation (resume, append) or a
  // new one — through ChatService: routed by the
  // agent's engine, registered to the agent at birth, isolated like a run (no
  // user hooks, the project's settings), its turn id in liveRunTurnIds so an
  // unattended turn never fires «conversation finished» automations. The
  // engine decides WHEN (held while the conversation has a turn or a console);
  // this only runs it. `onSession` hears the session id at chat-init.
  // `done` settles with what the turn cost as its engine priced it
  // (chat-done costUsd — the wake cost MovesControl shows).
  // `onStarted` hears its first output — the moment task mode charges the
  // wake. `done` also says whether it ever
  // started: a turn the account's usage limit refused (limitedUntil: the
  // reset, as the engine or the account's reading says it) or that failed
  // before any output (error) did not, and task mode puts its wakes back in
  // the queue uncharged. A turn
  // that produced nothing at all did not start either (NO_OUTPUT), and one
  // the engine's compat gate refused says so (`refused`: held for the
  // engine, no attempt counted). `origin` (a wake turn): the task it works —
  // a NEW conversation is born with origin `task` (session-origins.ts), so
  // the digest and the counts never take it for the owner's own.
  openTaskTurn(input: TaskTurnInput): { turnId: string; done: Promise<TaskTurnResult> } {
    const agent = this.deps.registry.get(input.agentId)
    if (!agent || agent.archived) throw new Error(`no agent «${input.agentId}» in play`)
    if (!agent.folder) throw new Error(`${agent.name} has no folder`)
    const turnId = randomUUID()
    this.liveRunTurnIds.add(turnId)
    let sessionKey: string | null = null
    const run = async (): Promise<TaskTurnResult> => {
      let told = false
      let costUsd: number | null = null
      let model: string | undefined
      let priced: boolean | undefined
      let produced = false
      let limited = false
      let resetsAt: string | undefined
      let errorText: string | undefined
      let refused: string | undefined
      let doneSubtype: string | undefined
      try {
        for await (const ev of this.deps.chat.send({
          turnId,
          agentId: agent.id,
          text: input.text,
          unattended: true,
          turn: input.turn,
          isolation: { settingSources: ['user', 'project'], disableAllHooks: true },
          ...(input.resume ? { resume: { sessionId: input.resume, mode: 'append' as const } } : {}),
        })) {
          if (ev.ev === 'chat-init' && ev.turnId === turnId && ev.model) model = ev.model
          if (ev.ev === 'chat-init' && ev.turnId === turnId && !told) {
            told = true
            sessionKey = `${ev.folder}/${ev.sessionId}`
            // its birth: a task wake's conversation, never the owner's own
            if (!input.resume && input.origin)
              this.deps.origins?.record(`${ev.folder}/${ev.sessionId}`, {
                kind: 'task',
                agentId: agent.id,
                task: input.origin.task,
                ref: input.origin.ref,
                at: this.now().toISOString(),
              })
            try {
              input.onSession(ev.sessionId)
            } catch {
              /* the turn goes on; the link is said missing */
            }
          } else if (
            (ev.ev === 'chat-delta' && ev.text !== '') ||
            ev.ev === 'chat-tool' ||
            ev.ev === 'chat-thinking' ||
            (ev.ev === 'chat-usage' && ev.outputTokens > 0)
          ) {
            if (!produced) {
              produced = true
              try {
                input.onStarted?.()
              } catch {
                /* charged at its end */
              }
            }
          } else if (ev.ev === 'chat-ratelimit' && ev.status === 'rejected') {
            limited = true
            resetsAt = ev.resetsAt
          } else if (ev.ev === 'chat-error') errorText = ev.error
          if (ev.ev === 'chat-done' && ev.turnId === turnId) {
            costUsd = ev.costUsd
            doneSubtype = ev.subtype
            if (ev.priced !== undefined) priced = ev.priced
          }
          this.deps.broadcast(ev)
        }
      } catch (err) {
        if (err instanceof EngineRefusedError) refused = err.message
        else {
          errorText = err instanceof Error ? err.message : String(err)
          console.warn(`resident: ${agent.id}'s task turn failed —`, errorText)
        }
      } finally {
        this.liveRunTurnIds.delete(turnId)
      }
      if (produced) return { costUsd, started: true, ...(model ? { model } : {}), ...(priced !== undefined ? { priced } : {}) }
      if (refused !== undefined) return { costUsd, started: false, refused }
      if (limited || (errorText !== undefined && looksLikeRateLimit(errorText))) {
        const until = resetsAt ?? (errorText ? this.parseResetFromText(errorText) : undefined) ?? this.deps.accountResetOf?.(agent.id) ?? null
        return { costUsd, started: false, limitedUntil: until }
      }
      // nothing produced: it never started, whatever its result said
      return { costUsd, started: false, error: errorText ?? (doneSubtype !== undefined && doneSubtype !== 'success' ? `result: ${doneSubtype}` : NO_OUTPUT) }
    }
    // ONE wall cap for every unattended turn the resident launches: a
    // wake turn past it is cancelled, its lock
    // released, and it ends as a timeout — never a zombie burning the account
    const startedAt = this.now().toISOString()
    let timer: NodeJS.Timeout | undefined
    const capMs = this.deps.runTimeoutMs ?? UNATTENDED_TURN_TIMEOUT_MS
    const timeout = new Promise<TaskTurnResult>((resolve) => {
      timer = setTimeout(() => {
        this.liveRunTurnIds.delete(turnId)
        this.deps.usageTimeout?.(turnId)
        this.track(this.deps.chat.cancel(turnId))
        resolve({ costUsd: null, started: true, error: 'timeout' })
      }, capMs)
      timer.unref?.()
    })
    const work = run()
    this.track(work)
    const done = Promise.race([work, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    // the transcript audit of the finished wake: the owner's
    // credential USED in it cuts — a wake is unattended work too
    this.track(
      done.then(async () => {
        if (!sessionKey || !this.deps.audit) return
        // fail closed: an audit that cannot read is indistinguishable from a
        // transcript the agent tampered with in its own HOME
        const audit = await this.deps.audit({ agentId: agent.id, sessionKey, startedAt }).catch((err): RunAudit => {
          console.warn(`resident: audit of ${agent.id}'s task turn failed —`, err instanceof Error ? err.message : err)
          return { readOutside: [TRANSCRIPT_UNREADABLE] }
        })
        if (audit) {
          try {
            input.onAudit?.(audit, { sessionId: sessionKey.slice(sessionKey.indexOf('/') + 1) })
          } catch {
            /* the record is the task's; the cut below still runs */
          }
        }
        const why = ownerCredentialCut(audit)
        if (why) {
          try {
            this.deps.registry.update(agent.id, { cut: { at: this.now().toISOString(), why } })
          } catch {
            /* the next audit says it again */
          }
        }
      }),
    )
    return { turnId, done }
  }
}
