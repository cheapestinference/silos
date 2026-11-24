// harnesses/claude-code/stores.ts — where Claude Code keeps what a
// conversation started in a folder leaves behind (Harness.projectStores):
//
//  · `<config dir>/projects/<name>/` — its transcripts (`<session>.jsonl`),
//    each session's subagents and tool results (`<session>/…`) and the
//    folder's auto memory (`memory/`). One per config dir: `~/.claude` and
//    every extra account (`<dataDir>/claude-accounts/<account>`, one glob for
//    all of them, so an account added after the launch is covered too).
//  · `<tmp>/claude-<uid>/<name>/<session>/` — its scratch space, background
//    task output. OBSERVED on the binary (scripts/territory-smoke-files.mts,
//    which reads it back), not a documented contract: an extra deny, never
//    the wall. `<tmp>` is the claude process's TMPDIR, which it inherits from
//    Silos (os.tmpdir()).
//
// `<name>` is the engine's munging of the folder (agent-registry.ts
// mungePath: `/` and `.` → `-`). It is not one-to-one: `/home/user/acme/web`
// and `/home/user/acme-web` are one name. A store whose name is, or
// extends, the name of one of the asking agent's own folders may hold that
// agent's own conversations (a conversation started in a subfolder has the
// subfolder's name), so it is never closed whole: its transcripts and session
// dirs are, its `memory/` is left open — an agent must never lose its own
// memory — and the store says so.

import { tmpdir } from 'node:os'
import { mungePath } from '../../agent-registry.js'
import type { ProjectStore } from '../contract.js'
import { CLAUDE_ACCOUNTS_DIR } from '../../territory.js'

const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p)

/** What a partly closed store still closes: the transcripts at its top and
 *  every session dir (a session id is a UUID — eight hex characters, then a
 *  dash: `memory/` never matches). */
export const CLAUDE_STORE_TRANSCRIPTS = ['*.jsonl', '????????-*/**'] as const

export function claudeProjectStores(
  folder: string,
  ctx: { home: string; dataDir: string; own: readonly string[]; tmp?: string; uid?: number },
): ProjectStore[] {
  const name = mungePath(strip(folder))
  const mine = ctx.own.map((o) => mungePath(strip(o)))
  const collides = mine.find((m) => name === m || name.startsWith(`${m}-`))
  const uid = ctx.uid ?? process.getuid?.() ?? null
  const roots = [
    `${strip(ctx.home)}/.claude/projects/${name}`,
    `${strip(ctx.dataDir)}/${CLAUDE_ACCOUNTS_DIR}/*/projects/${name}`,
    ...(uid === null ? [] : [`${strip(ctx.tmp ?? tmpdir())}/claude-${uid}/${name}`]),
  ]
  return roots.map((root) =>
    collides === undefined
      ? { path: root, deny: [root, `${root}/**`] }
      : {
          path: root,
          deny: CLAUDE_STORE_TRANSCRIPTS.map((g) => `${root}/${g}`),
          partly: `Claude Code names this store like ${collides === name ? 'one of its own folders' : 'a folder inside one of its own'} (it turns / and . into -): its conversations are closed, its memory/ stays open so the agent never loses its own`,
        },
  )
}
