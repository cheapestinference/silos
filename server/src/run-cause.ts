// run-cause.ts — why the run working in a conversation RIGHT NOW was
// started (Run.cause: a standing wake's causes). Home reads it off the
// session view to say "woken by Builder" instead of a bare "working".
//
// A conversation is a run's when one of the automation's runs is still
// running AND either its keep thread points at the conversation, or the
// conversation was born by that very run (the first turn of a new thread,
// before the keep thread's sessionId is persisted). openRuns is an O(1)
// index read; there are a handful of automations, so a scan is fine for ONE
// session. A caller that answers many sessions (the overview) builds
// runCauseIndex once instead — same answers, one scan per request.
import type { Automation, Run } from './automations-types.js'

export interface RunCauseSource {
  list(): Automation[]
  /** the automation's open runs (AutomationsStore.openRuns) — a run in
   *  flight is found by its state and its id, never as «the latest» line */
  openRuns(automationId: string): Run[]
}

// the automation's runs working right now with a cause, newest last
const causedRunning = (src: RunCauseSource, id: string): Run[] => src.openRuns(id).filter((r) => r.status === 'running' && !!r.cause)

export function runCauseFor(sessionId: string, born: { automationId: string; runId: string } | null, src: RunCauseSource): string | null {
  for (const a of src.list()) {
    const live = causedRunning(src, a.id)
    if (live.length === 0) continue
    if (a.thread.mode === 'keep' && a.thread.sessionId === sessionId) return live[live.length - 1]!.cause!
    const bornRun = born !== null && born.automationId === a.id ? live.find((r) => r.id === born.runId) : undefined
    if (bornRun) return bornRun.cause!
  }
  return null
}

type Born = { automationId: string; runId: string } | null

// runCauseFor for many sessions: the running, caused runs are read ONCE
// into two maps (keep thread's session → first automation's position;
// automation id → its running runs by id), and each lookup picks the
// earlier of the two candidates in list() order — exactly the automation
// the loop in runCauseFor would have returned first.
export function runCauseIndex(src: RunCauseSource): (sessionId: string, born: Born) => string | null {
  const byKeepSession = new Map<string, { pos: number; cause: string }>()
  const byAutomation = new Map<string, { pos: number; runs: Map<string, string> }>()
  src.list().forEach((a, pos) => {
    const live = causedRunning(src, a.id)
    if (live.length === 0) return
    if (!byAutomation.has(a.id)) byAutomation.set(a.id, { pos, runs: new Map(live.map((r) => [r.id, r.cause!])) })
    if (a.thread.mode === 'keep' && a.thread.sessionId !== undefined && !byKeepSession.has(a.thread.sessionId)) {
      byKeepSession.set(a.thread.sessionId, { pos, cause: live[live.length - 1]!.cause! })
    }
  })
  return (sessionId, born) => {
    const keep = byKeepSession.get(sessionId)
    const b = born !== null ? byAutomation.get(born.automationId) : undefined
    const bornCause = b !== undefined ? b.runs.get(born!.runId) : undefined
    const bornHit = bornCause !== undefined ? { pos: b!.pos, cause: bornCause } : undefined
    if (keep && bornHit) return keep.pos <= bornHit.pos ? keep.cause : bornHit.cause
    return keep?.cause ?? bornHit?.cause ?? null
  }
}
