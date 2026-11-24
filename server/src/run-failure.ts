// run-failure.ts — a failed run's raw error, said in plain words: THE one
// reading of why an automation failed. The server's inbox (inbox.ts, Home's
// Needs you, the digest, the doorbell) and the web's Automations page and
// run rows (web/src/lib/automations.ts imports this very file) say the same
// words, so Home and the Automations page can never disagree about a
// failure. A LEAF on purpose: no imports, no Node, no DOM —
// it compiles under both workspaces' settings.
//
// `class` is what the inbox's admission table reads (inbox.ts admitsFailure);
// `text` reads after «failed — » («Nightly sweep failed — the API rejected
// the request (400)»); failureSentence is the same words standing alone.

export type RunFailureClass = 'config' | 'rejected' | 'limit' | 'timeout' | 'restart' | 'too_long' | 'command' | 'other'
export interface RunFailure {
  class: RunFailureClass
  text: string
}

// the shape of a command run this reading needs (automations-types Run's
// `command` leg and `handover`) — structural, so this file stays a leaf
export interface CommandRunLike {
  command?: { timedOut?: boolean; error?: string; exitCode?: number | null; lastLine?: string }
  handover?: unknown
  error?: string
}

const cap = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

// A command run's failure:
// what the exec did — «exited 2 · <its last line>», «timed out», or why it
// never started — and, when its failure was handed to the agent and that
// turn failed too, the turn's reason after it. Never 'limit': a command
// never touches one, and a hand-over refused at a limit is still the
// command's failure, said once (the account's limit row is for agent runs).
function commandFailure(run: CommandRunLike): RunFailure {
  const leg = run.command!
  const what = leg.timedOut ? 'timed out' : leg.error ? leg.error : `exited ${leg.exitCode ?? '?'}`
  const head = leg.lastLine && !leg.timedOut && !leg.error ? `${what} · ${cap(leg.lastLine, 100)}` : what
  if (!run.handover) return { class: 'command', text: head }
  return { class: 'command', text: `${head} — handed over, but ${runFailure(run.error).text}` }
}

// the words when the run recorded no error at all
export const NO_REASON = 'no reason recorded'

// Pass the run itself when there is one: a command run reads from its
// command leg, not its error.
export function runFailure(error: string | undefined, run?: CommandRunLike): RunFailure {
  if (run?.command) return commandFailure(run)
  const raw = (error ?? '').trim()
  if (/reached your .*limit|hit your .*limit|rate.?limit|usage limit|session limit/i.test(raw)) return { class: 'limit', text: 'the usage limit was reached' }
  if (/API Error:\s*400\b/i.test(raw)) return { class: 'rejected', text: 'the API rejected the request (400)' }
  if (/^timeout$/i.test(raw) || /\btimed? ?out\b/i.test(raw)) return { class: 'timeout', text: 'it timed out after 30 min' }
  if (/interrupted by a server restart/i.test(raw)) return { class: 'restart', text: 'a Silos restart interrupted it' }
  if (/agent not found/i.test(raw)) return { class: 'config', text: 'its agent is missing or archived' }
  if (/needs a folder/i.test(raw)) return { class: 'config', text: 'Anywhere needs a folder for it' }
  if (/prompt is too long/i.test(raw)) return { class: 'too_long', text: 'its conversation grew too long' }
  if (/^the turn did not finish$|^result: /i.test(raw)) return { class: 'rejected', text: 'the turn did not finish' }
  if (raw === '') return { class: 'other', text: NO_REASON }
  return { class: 'other', text: raw.length > 120 ? `${raw.slice(0, 119)}…` : raw }
}

// The same words as a sentence of their own (a run row's lead, a list's
// second line): Silos' own phrases get a capital; an error quoted as the
// engine wrote it stays exactly as written.
export function failureSentence(error: string | undefined): string {
  const f = runFailure(error)
  const quoted = f.class === 'other' && f.text !== NO_REASON
  return quoted ? f.text : f.text.charAt(0).toUpperCase() + f.text.slice(1)
}
