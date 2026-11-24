// context-news.ts — the queue of files the owner GAVE one conversation
// (conversation files, «News»): `<dataDir>/context-news/<thread id>`,
// one line per file (the literal path the agent opens). Queued, never
// discovered: an upload or a move into a thread's folder appends; the
// thread's next turn prints the lines and clears them —
//   · the console's UserPromptSubmit hook drains it by RENAME, then read,
//     then delete (harnesses/claude-code/console.ts contextNewsHookCommand),
//     so a line appended meanwhile lands in a fresh file, never lost;
//   · an SDK turn reads it into its append and drops the lines it printed
//     only once that turn's `system/init` arrives (ChatService) — a launch
//     or a turn that failed before the model leaves them queued.
// A deleted conversation's pending lines are dropped with it.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const CONTEXT_NEWS_DIR = 'context-news'

// a thread id is a session id: one path segment, never a path (the same
// rule the conversation folder's segment keeps — context-service.ts)
export const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

export function contextNewsPath(dataDir: string, thread: string): string {
  if (!THREAD_ID_RE.test(thread)) throw new Error('invalid thread id')
  return join(dataDir, CONTEXT_NEWS_DIR, thread)
}

/** Append one line (a path) to a thread's queue. */
export function queueContextNews(dataDir: string, thread: string, line: string): void {
  if (line.includes('\n')) throw new Error('a queued line is one line')
  mkdirSync(join(dataDir, CONTEXT_NEWS_DIR), { recursive: true, mode: 0o700 })
  appendFileSync(contextNewsPath(dataDir, thread), line + '\n', { mode: 0o600 })
}

const linesOf = (text: string): string[] => text.split('\n').filter((l) => l !== '')

/** The queued lines, oldest first — a read, nothing consumed. */
export function readContextNews(dataDir: string, thread: string): string[] {
  try {
    return linesOf(readFileSync(contextNewsPath(dataDir, thread), 'utf8'))
  } catch {
    return []
  }
}

/** Drop the first `n` lines (the ones a turn printed): rename the queue
 *  aside, read it, put back whatever came after those `n`. */
export function consumeContextNews(dataDir: string, thread: string, n: number): void {
  if (n <= 0) return
  const q = contextNewsPath(dataDir, thread)
  const aside = `${q}.${process.pid}.consumed`
  try {
    renameSync(q, aside)
  } catch {
    return
  }
  let rest: string[] = []
  try {
    rest = linesOf(readFileSync(aside, 'utf8')).slice(n)
  } catch {
    /* unreadable: nothing to put back */
  }
  rmSync(aside, { force: true })
  if (rest.length > 0) appendFileSync(q, rest.join('\n') + '\n', { mode: 0o600 })
}

/** A deleted conversation: its pending lines go with it. */
export function dropContextNews(dataDir: string, thread: string): void {
  if (!THREAD_ID_RE.test(thread)) return
  rmSync(contextNewsPath(dataDir, thread), { force: true })
}
