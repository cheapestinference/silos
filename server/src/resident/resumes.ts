// resident/resumes.ts — auto-resume for interactive chats: rate-limited
// turns resent once their reset passes, throttled per tick and by a daily
// budget, with an honest terminal state when it gives up.
// Moved verbatim from resident.ts; Resident's tick calls it.
import { randomUUID } from 'node:crypto'
import { looksLikeRateLimit } from '../fallback.js'
import type { SessionMeta } from '../types.js'
import type { PendingResume } from '../pending-resumes-store.js'
import { DEFAULT_MAX_RUNS_PER_DAY } from '../automations-types.js'
import { MAX_RESUME_ATTEMPTS, RESUME_BATCH_PER_TICK } from './constants.js'
import { ResidentPart, type ResidentCore } from './core.js'

export class PendingResumeSweep extends ResidentPart {
  // Auto-resume: "folder/sessionId" keys with a resend in flight IN THIS
  // PROCESS — prevents two overlapping ticks from sending the same turn
  // twice (same criterion as `running` for automations).
  private resumingKeys = new Set<string>()
  // Auto-resume's daily budget — an in-memory counter per calendar day
  // (same criterion as resumingKeys/pendingSeen: only needs to live while
  // the process does; a restart recalculates it from scratch, honestly).
  private resumeBatchPerTick: number
  private resumeDailyBudget: number
  private resumeDayKey = ''
  private resumesToday = 0

  constructor(core: ResidentCore) {
    super(core)
    const deps = core.deps
    this.resumeBatchPerTick = deps.resumeBatchPerTick ?? RESUME_BATCH_PER_TICK
    this.resumeDailyBudget = deps.resumeDailyBudget ?? DEFAULT_MAX_RUNS_PER_DAY
  }

  // ---- auto-resume for interactive chats ------------------
  //
  // The "Silos will resume this on its own" banner is only honest if it
  // really does resume. server.ts arms the record when an INTERACTIVE turn
  // hits the limit and doesn't continue via a fallback; here the heartbeat
  // resends it once its resumeAt passes. A successful resend deletes the
  // record; a re-limit re-arms it with the new resetsAt (capped at
  // MAX_RESUME_ATTEMPTS); a non-limit error gives up honestly (deletes —
  // we don't keep promising a resume).

  processPendingResumes(now: Date): void {
    const store = this.deps.pendingResumes
    if (!store) return
    // Resets the daily counter when crossing into a new calendar day.
    const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`
    if (this.resumeDayKey !== dayKey) {
      this.resumeDayKey = dayKey
      this.resumesToday = 0
    }
    let firedThisTick = 0
    for (const pr of store.list()) {
      // Per-tick throttle + daily budget — a reset shared by N chats
      // doesn't fire N SDK turns at once, and auto-resumes count against
      // the same budget as automations instead of escaping it.
      if (firedThisTick >= this.resumeBatchPerTick) break
      if (this.resumesToday >= this.resumeDailyBudget) break
      // A TERMINAL record (gaveUp) is never retried — it only exists so
      // the banner tells the truth until the owner dismisses it (DELETE).
      if (pr.gaveUp) continue
      const key = `${pr.folder}/${pr.sessionId}`
      if (this.resumingKeys.has(key)) continue // a resend already in flight in this process
      if (new Date(pr.resumeAt).getTime() > now.getTime()) continue // not due yet
      // Anti-double-send guard: if the owner resent by hand and the
      // session advanced (more turns / a newer mtime than the snapshot
      // taken when the record was created), we do NOT resend the same
      // turn — the record is dropped SILENTLY (the owner already
      // continued on their own: there's no broken promise to announce,
      // unlike a give-up).
      const meta = this.deps.index.getMeta(pr.folder, pr.sessionId)
      if (meta && this.sessionAdvanced(pr, meta)) {
        this.clearPending(pr)
        continue
      }
      this.resumingKeys.add(key)
      this.resumesToday += 1
      firedThisTick += 1
      this.track(this.resumePending(pr, now).finally(() => this.resumingKeys.delete(key)))
    }
  }

  private sessionAdvanced(pr: PendingResume, meta: SessionMeta): boolean {
    if (pr.turnCount !== undefined && meta.turnCount > pr.turnCount) return true
    if (pr.mtime !== undefined && meta.mtime > pr.mtime) return true
    return false
  }

  private async resumePending(pr: PendingResume, now: Date): Promise<void> {
    const agent = this.deps.registry.get(pr.agentId)
    // An unrecoverable destination (agent deleted/archived, or master with
    // no cwd) is NOT silently deleted, it's marked terminal so the banner
    // says so ("couldn't resume automatically").
    if (!agent || agent.archived) {
      this.giveUp(pr, 'unrecoverable', pr.attempts)
      return
    }
    const isMaster = agent.folder === null
    if (isMaster && pr.cwd === undefined) {
      this.giveUp(pr, 'unrecoverable', pr.attempts)
      return
    }
    const cwd = isMaster ? pr.cwd : undefined

    const turnId = randomUUID()
    let ok = false
    let rejected = false
    let resetsAt: string | undefined
    let errorText: string | undefined
    let lockBusy = false
    try {
      for await (const ev of this.deps.chat.send({
        turnId,
        agentId: agent.id,
        text: pr.text,
        resume: { sessionId: pr.sessionId, mode: 'append' },
        cwd,
        unattended: true,
        // the owner's own chat turn, resent at its reset — nobody in front
        // (the token carries both: class chat, unattended)
        turn: { class: 'chat' },
      })) {
        this.deps.broadcast(ev)
        if (ev.ev === 'chat-ratelimit' && ev.status === 'rejected') {
          rejected = true
          resetsAt = ev.resetsAt
        } else if (ev.ev === 'chat-error') errorText = ev.error
        else if (ev.ev === 'chat-done') ok = ev.subtype === 'success'
      }
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err)
      // ChatService's lock ("a turn is already in progress for this
      // session") fires if the owner is mid-turn on THAT session — this
      // isn't a resume failure, just timing: the record is left intact
      // and retried on the next tick (never deleted for this reason).
      if (/already in progress/.test(errorText)) lockBusy = true
    }
    if (lockBusy) return

    if (ok && !rejected) {
      this.clearPending(pr)
      return
    } // genuinely resumed → the promise is fulfilled

    if (rejected || (errorText !== undefined && looksLikeRateLimit(errorText))) {
      const attempts = pr.attempts + 1
      // Retries exhausted → an honest TERMINAL state (gaveUp), NOT a
      // silent deletion. The owner saw "will resume at 4pm"; if the
      // provider is still limited after 5 resets, they have to FIND OUT
      // that auto-resume gave up, not have the promise vanish quietly.
      if (attempts >= MAX_RESUME_ATTEMPTS) {
        this.giveUp(pr, 'max-attempts', attempts)
        return
      }
      const newReset = resetsAt ?? this.parseResetFromText(errorText ?? '') ?? new Date(now.getTime() + 3600_000).toISOString()
      // Was a fallback left armed by THIS turn? (ChatService.noteRateLimit)
      // → an immediate retry through the fallback; otherwise, wait for the new reset.
      const fb = this.deps.chat.fallbackStateOf?.(agent.id, now) ?? null
      this.upsertPending({
        ...pr,
        attempts,
        resetsAt: newReset,
        resumeAt: fb ? now.toISOString() : newReset,
        ...(fb ? { fallbackProviderId: fb.providerId } : { fallbackProviderId: undefined }),
      })
      return
    }
    // A non-limit error (network, a non-success result, etc.): we give up
    // — auto-resume is specifically for limits, it doesn't retry generic
    // errors forever. An honest terminal state, not a silent deletion.
    this.giveUp(pr, 'error', pr.attempts + 1)
  }

  // Marks the record as TERMINAL (doesn't delete it) so the banner shows
  // an honest state ("couldn't resume automatically after N tries — send
  // again when you're ready") instead of the promise disappearing without
  // notice. processPendingResumes never retries a gaveUp record; only the
  // owner removes it (DELETE /api/pending-resumes) or replaces it by
  // resending. The turnCount/mtime snapshot is kept so the anti-double-send
  // guard still applies if the owner resends by hand.
  private giveUp(pr: PendingResume, reason: string, tries: number): void {
    this.upsertPending({ ...pr, gaveUp: { reason, tries } })
  }

  private clearPending(pr: PendingResume): void {
    if (this.deps.pendingResumes?.remove(pr.folder, pr.sessionId)) {
      this.deps.broadcast({ ev: 'pending-resume-removed', folder: pr.folder, id: pr.sessionId })
    }
  }

  private upsertPending(pr: PendingResume): void {
    // strips the optional field if it's undefined (never persist `fallbackProviderId: undefined`)
    const clean: PendingResume =
      pr.fallbackProviderId === undefined
        ? (() => {
            const { fallbackProviderId: _drop, ...rest } = pr
            return rest
          })()
        : pr
    this.deps.pendingResumes?.upsert(clean)
    this.deps.broadcast({ ev: 'pending-resume', pending: clean })
  }
}
