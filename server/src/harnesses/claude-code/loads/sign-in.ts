// harnesses/claude-code/loads/sign-in.ts — how Claude Code signs a waiting
// server in, as the door its row offers (contract LoadsSignIn).
//
// Walked on a real install (24-11): a claude.ai account connector is
// connected in claude.ai › Settings › Connectors — a Claude Code session
// answers that it «needs to be connected in claude.ai» and can't run that
// flow itself. A server of a plugin, of ~/.claude.json or of .mcp.json that
// waits for a sign-in gets the engine's `authenticate` tool pair in an
// interactive console only (measured 24-11, CLI 2.1.330: an Agent SDK chat
// exposes no such tool and answers it can't run the sign-in): the door is a
// console, its sentence names the server by the engine's EXACT name (never
// the id its tool names carry) and asks for that tool and its link. The
// link's redirect is localhost on the machine running Claude Code; a
// browser elsewhere ends on a connection error and Claude asks for that
// address back (`complete_authentication`). A row known only by that id
// names no server a sentence could ask for: its console door sends `/mcp`,
// the engine's own menu of its servers.
import type { LoadsRow, LoadsSignIn } from '../../contract.js'

/** Where a claude.ai account connector is connected. */
export const CONNECTORS_URL = 'https://claude.ai/settings/connectors'

/** The sentence a console sends to sign `name` in (the engine's exact name). */
export function signInDraft(name: string): string {
  return `Sign me in to the MCP server "${name}": call its authenticate tool and give me the link it returns.`
}

/** The door a row offers when it waits for your sign-in; null for a plugin
 *  (its servers carry theirs). */
export function signInOf(r: Pick<LoadsRow, 'kind' | 'name' | 'exact'>): LoadsSignIn | null {
  if (r.kind === 'plugin') return null
  if (r.kind === 'connector') return { via: 'link', url: CONNECTORS_URL, where: 'claude.ai' }
  if (!r.exact) return { via: 'console', draft: '/mcp', menu: true }
  return { via: 'console', draft: signInDraft(r.name) }
}
