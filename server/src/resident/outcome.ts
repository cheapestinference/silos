// resident/outcome.ts — a run's OUTCOME protocol and how a command leg's
// failure reads (pure; moved verbatim from resident.ts, which re-exports them).
import { RUN_OUTCOME_INSTRUCTION } from '../run-outcome.js'
import type { RunOutcome, CommandLeg } from '../automations-types.js'

// The run's OUTCOME instruction (run-outcome.ts, a leaf module). A prompt
// that already speaks the protocol (contains "OUTCOME:") is not given it twice.
export { RUN_OUTCOME_INSTRUCTION }

export function withOutcomeInstruction(prompt: string): string {
  return /OUTCOME:/.test(prompt) ? prompt : `${prompt}\n\n${RUN_OUTCOME_INSTRUCTION}`
}

// The LAST `OUTCOME: nothing|acted` line of a run's final message → the
// outcome, and the summary without that line (the sentence after it, or the
// rest of the message). No line → no outcome, summary untouched.
export function parseRunOutcome(finalMessage: string): { outcome?: RunOutcome; summary: string } {
  const lines = finalMessage.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*[*_`]*OUTCOME:[*_`]*\s*[*_`]*(nothing|acted)\b[*_`]*\s*[:\-—–.]?\s*(.*)$/i.exec(lines[i]!)
    if (!m) continue
    const outcome = m[1]!.toLowerCase() as RunOutcome
    const sameLine = m[2]!.trim()
    const after = lines
      .slice(i + 1)
      .join('\n')
      .trim()
    const before = lines.slice(0, i).join('\n').trim()
    const summary = sameLine || after || before
    return { outcome, summary }
  }
  return { summary: finalMessage.trim() }
}

// «exited 2» / «timed out after 10 min» / why it never started — how a
// command leg's failure reads in the run's error and the hand-over prompt.
export function commandFailureText(leg: Pick<CommandLeg, 'exitCode' | 'timedOut' | 'error'>, timeoutMs: number): string {
  if (leg.timedOut) return `timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} min`
  if (leg.error) return leg.error
  return `exited ${leg.exitCode ?? '?'}`
}
