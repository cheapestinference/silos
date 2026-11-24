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

export type HandoverTerminals = Pick<TerminalService, 'keyOfNativeId' | 'hasConsole' | 'killConsoleAndWait'>

/** The live console a chat turn on this session would have to close, or null. */
export async function handoverConsoleKey(terminals: HandoverTerminals | undefined, sessionId: string): Promise<string | null> {
  const engine = harnessById(harnessForId(sessionId))
  if (!terminals || !engine.traits.handover) return null
  return terminals.keyOfNativeId(sessionId) ?? ((await terminals.hasConsole(sessionId)) ? sessionId : null)
}

/** A chat turn must wait: the session's live console is still working (its
 *  turn is open) — handing over now would kill that work. */
export async function consoleBusyFor(terminals: HandoverTerminals | undefined, sessionId: string, turnOpen: boolean | undefined): Promise<boolean> {
  return turnOpen === true && (await handoverConsoleKey(terminals, sessionId)) !== null
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
