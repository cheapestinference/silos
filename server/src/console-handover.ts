// console-handover.ts — one engine process per session, for an engine whose
// console and chat engine write the SAME session (traits.handover). OpenCode
// is one: the TUI (console) and `opencode run --session <id>` (the chat
// engine) write the SAME session in the agent's DB (so OpenCode gets
// the chat mode as well as the console, as Claude Code does).
// Claude Code is one too: the console is
// registered at birth (native.json), so a chat turn APPENDS to it through
// the SDK's resume, and the console comes back with --resume. What must
// never happen is both at once: two processes on one session. Before a chat
// turn on a session whose console is live, Silos closes that console (the
// same kill + wait the ↻ and the sleep sweep use) — never while that console
// is mid-turn: closing it would kill the work (consoleBusyFor, the route's 409).
import type { TerminalService } from './terminal-service.js'
import { harnessById, harnessForId } from './harnesses/registry.js'

export type HandoverTerminals = Pick<TerminalService, 'keyOfNativeId' | 'hasConsole' | 'killConsoleAndWait'> &
  Partial<Pick<TerminalService, 'consoleCreatedMs'>>

/** The live console a chat turn on this session would have to close, or null. */
export async function handoverConsoleKey(terminals: HandoverTerminals | undefined, sessionId: string): Promise<string | null> {
  const engine = harnessById(harnessForId(sessionId))
  if (!terminals || !engine.traits.handover) return null
  return terminals.keyOfNativeId(sessionId) ?? ((await terminals.hasConsole(sessionId)) ? sessionId : null)
}

/** A chat turn must wait: the session's live console is still working (its
 *  turn is open) — handing over now would kill that work.
 *
 *  An open turn alone is not work: a transcript whose last turn never
 *  closed (its claude crashed or was killed — every pre-Silos conversation
 *  adopted from disk can be one) stays open FOREVER, and the console the
 *  conversation page opens over it is a fresh `--resume` sitting idle — a
 *  busy answer there refused chat on that conversation for good. The
 *  console is working only if the transcript moved SINCE that console was
 *  created (tmux's own clock, consoleCreatedMs): a turn that this console
 *  is running writes records after its birth. No creation time (probe
 *  failed, console mid-spawn) stays conservative: busy. */
export async function consoleBusyFor(
  terminals: HandoverTerminals | undefined,
  sessionId: string,
  turnOpen: boolean | undefined,
  lastActivityMs?: number,
): Promise<boolean> {
  if (turnOpen !== true) return false
  const key = await handoverConsoleKey(terminals, sessionId)
  if (key === null) return false
  if (lastActivityMs === undefined || !terminals?.consoleCreatedMs) return true
  const created = await terminals.consoleCreatedMs(key)
  return created === null || lastActivityMs >= created
}

/** Returns the console key it closed, or null when nothing was live. */
export async function handOverConsoleForChat(
  terminals: HandoverTerminals | undefined,
  sessionId: string,
  log: (line: string) => void = console.log,
): Promise<string | null> {
  const engine = harnessById(harnessForId(sessionId))
  const key = await handoverConsoleKey(terminals, sessionId)
  if (key === null || !terminals) return null
  await terminals.killConsoleAndWait(key)
  log(`console ${key} closed: the chat engine takes session ${sessionId} (one ${engine.label} process per session)`)
  return key
}
