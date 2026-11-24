// agent-context.ts — the server (ChatService.withSkillsPrelude) prepends a
// `[silos-context] ... [/silos-context]` block to a new session's
// first message; it stays in the JSONL for real, but the UI must never
// show it to the owner. `Turn` uses this before rendering a user turn's
// text. A mirror of server/src/parser.ts (stripAgentContextForTitle) —
// same pattern, each side keeps its own copy (independent packages).
//
// the composer's memory mode prepends, client-side (unlike the skills
// preamble, which is server-side), a `[silos-memory path=...] ...
// [/silos-memory]` block — the same presentation treatment. Both
// markers can STACK at the start of the same message (a new session with
// skills AND memory mode at once), so the strip is a loop: it removes
// leading silos-* blocks until none remain at the start.
const AGENT_BLOCK_RE = /^\[silos-(context|memory)[^\]]*\][\s\S]*?\[\/silos-\1\]\s*/

export function stripAgentContext(text: string): string {
  let out = text
  let m: RegExpMatchArray | null
  while ((m = out.match(AGENT_BLOCK_RE))) {
    out = out.slice(m[0].length)
  }
  return out
}
