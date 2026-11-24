// harnesses/inbox-text — "Your Silos inbox" server-side, for a turn that
// never runs the SessionStart hook: a Claude SDK turn with its hooks off
// (wakes, runs, heartbeats — claude-code/headless.ts withBriefing) and every
// OpenCode launch (its context file, opencode/assemble.ts). A turn WITH hooks
// (a console, the owner's chat, an inheritHooks run) gets it from its own
// SessionStart (plugin/hooks/inbox.py) — never both.
// plugin/hooks/inbox.py is the single source of the rule; this is its
// derived twin, pinned byte for byte against the live script
// (inbox-text.test.ts runs python3 inbox.py over the same messages, served
// by a fake API — an edit to inbox.py's wording fails that test until this
// follows).
//
// Both render the recipient's `new` messages as the server's store holds
// them (the script asks GET /api/agents/<self>/messages?state=new, this
// reads the same store in-process), oldest first. Nothing unread → ''. The
// text has no final newline (what the hook's `$(…)` captures).
//
// Then the asks other agents left it through Silos (B2.4,
// H7 — inbox.py's GET /api/agents/<self>/asks, here task-asks.ts asksTo):
// linked, open, oldest first, in the same twin rule.
import type { AgentMessage } from '../types.js'
import type { AskLine } from '../task-asks.js'

// how many messages the text lists — only those were SERVED (message-reads.ts)
export const LIST_MAX = 5
const TEXT_MAX = 140
const ASK_TITLE_MAX = 120

// Python's str.split() whitespace (str.isspace), not JS's \s
const PY_SPACE = /[\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u

const clean = (v: string): string =>
  v
    .split(PY_SPACE)
    .filter((w) => w !== '')
    .join(' ')
// slices and lengths in code points, as Python's
const cps = (s: string): string[] => Array.from(s)
// Python compares strings by code point
const cmp = (a: string, b: string): number => {
  const x = cps(a),
    y = cps(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (d !== 0) return d
  }
  return x.length - y.length
}

function row(m: AgentMessage): string {
  let text = clean(m.text)
  if (cps(text).length > TEXT_MAX)
    text =
      cps(text)
        .slice(0, TEXT_MAX - 1)
        .join('') + '…'
  // the provenance of a message sent by a turn that read outside
  const outside = m.readOutside && m.readOutside.length > 0 ? ` — sent after reading the web (${m.readOutside.join(', ')})` : ''
  return `- ${cps(clean(m.at)).slice(0, 16).join('')} from ${clean(m.from)} (${clean(m.id)}): ${text}${outside}`
}

// Python's `s[: n - 1] + "…" if len(s) > n else s`, over clean(s)
const clip = (v: string, n: number): string => {
  const c = cps(clean(v))
  return c.length > n ? c.slice(0, n - 1).join('') + '…' : c.join('')
}

function askRow(a: AskLine): string {
  const who = clean(a.fromName || a.from || '?')
  if (a.silos)
    return `- ask:${clean(a.key)} — ${clean(a.ref)} «${clip(a.title, ASK_TITLE_MAX)}» is stuck and Silos asks you to help unstick it (${who} stays its owner)`
  const what = clean(a.asked) !== '' ? a.asked : a.action
  const outside = a.readOutside && a.readOutside.length > 0 ? ` — asked after reading the web (${a.readOutside.join(', ')})` : ''
  return `- ask:${clean(a.key)} — ${who} waits on you for ${clean(a.ref)}: «${clip(what, TEXT_MAX)}»${outside}`
}

/** The asks part inbox.py prints (render_asks), without the final newline. */
export function asksText(asks: readonly AskLine[]): string {
  if (asks.length === 0) return ''
  const todo = [...asks].sort((a, b) => cmp(a.at, b.at))
  const n = todo.length
  const lines = [
    `Asks waiting on you through Silos: ${n}. Answer each with POST /api/tasks/ask/answer ` +
      '{"key":"<key>","text":"<your answer>","turn":"$SILOS_TURN"} — it lands as your note on their task and moves it on; ' +
      '«not mine — ask the owner» is an answer too (your Tasks rule has the recipe).',
  ]
  for (const a of todo.slice(0, LIST_MAX)) lines.push(askRow(a))
  if (n > LIST_MAX) lines.push(`- … and ${n - LIST_MAX} more`)
  return lines.join('\n')
}

/** The inbox text inbox.py prints for these messages (the `new` ones are
 *  taken) and these asks, without the final newline. */
export function inboxText(messages: readonly AgentMessage[], asks: readonly AskLine[] = []): string {
  return [messagesText(messages), asksText(asks)].filter((t) => t !== '').join('\n')
}

function messagesText(messages: readonly AgentMessage[]): string {
  const fresh = messages.filter((m) => m.state === 'new')
  if (fresh.length === 0) return ''
  // oldest first (a stable sort, as Python's)
  const todo = [...fresh].sort((a, b) => cmp(a.at, b.at))
  const n = todo.length
  const lines = [
    `Your Silos inbox: ${n} unread message${n !== 1 ? 's' : ''}. Read them before other work unless the owner's request in this conversation is more urgent — ` +
      'GET /api/agents/$SILOS_AGENT_ID/messages?state=new, then PATCH each to answered (with an "answer") / read / needs_owner ' +
      '(your Messages rule has the exact curl).',
  ]
  for (const m of todo.slice(0, LIST_MAX)) lines.push(row(m))
  if (n > LIST_MAX) lines.push(`- … and ${n - LIST_MAX} more`)
  return lines.join('\n')
}

/** What a failed fetch says (the hook's line — nothing is marked). */
export const INBOX_UNFETCHED = 'Your Silos inbox could not be fetched this start'
