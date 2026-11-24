// harnesses/briefing — the Silos briefing as text, server-side: the same
// briefing + roster the SessionStart hook (plugin/hooks/session-start.sh)
// hands a claude started by hand. Every process Silos launches reads it
// from here, uncapped: an OpenCode console (its context file), an
// unattended Claude run whose hooks are off (briefing + roster in its
// append), and every Claude console and SDK turn with hooks (the briefing
// in its system-prompt append, BRIEFED_ENV telling the hook not to repeat
// it — a hook's additionalContext is cut at 10,000 characters). So an
// automation knows what a console knows: where deliverables go, the API
// recipes, the fleet.
//
// The briefing is composed per session from plugin/context/briefing.d/:
// no session is told to use a skill it does not have.
// base.md names no skill; each skill-bound rule is <name>.with.md (points at
// the skill) or <name>.without.md (the minimal recipe). The hook composes
// the same bytes with plugin/hooks/compose.py (briefing-compose.test.ts).

import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from '../types.js'
import { rosterText } from './roster-text.js'
import { BRIEFING_FRAGMENTS } from '../briefing-fragments.js'

/** plugin/context/briefing.d — the fragments the briefing is composed from. */
export function defaultBriefingDir(): string {
  return fileURLToPath(new URL('../../../plugin/context/briefing.d/', import.meta.url))
}

// the skill-bound fragments, in composition order (briefing-fragments.ts)
export { BRIEFING_FRAGMENTS }

/** plugin/context/recipes — the claim/release curls, the ONE source of each:
 *  team-plan's SKILL.md, team-plan.without.md and
 *  product.md quote them verbatim, the SessionStart hook reads the file, and
 *  every server prompt goes through recipeText (recipes-identical.test.ts). */
export function defaultRecipesDir(): string {
  return fileURLToPath(new URL('../../../plugin/context/recipes/', import.meta.url))
}

export type RecipeName = 'claim' | 'release'

/** A recipe as text: the canonical multiline curl, trailing newlines
 *  dropped, with the `<slug>` / `<id>` markers filled when `fill` is given
 *  (the same substitution session-start.sh makes with sed). Read on every
 *  call, like briefingText — no embedded fallback copy: an unreadable file
 *  is ''. */
export function recipeText(name: RecipeName, fill?: { slug: string; id: string }, dir = defaultRecipesDir()): string {
  const text = part(join(dir, `${name}.sh`))
  if (!fill) return text
  return text.split('<slug>').join(fill.slug).split('<id>').join(fill.id)
}

function part(path: string): string {
  try {
    return readFileSync(path, 'utf8').replace(/\n+$/, '')
  } catch {
    return ''
  }
}

// What a rule needs only now and then (the other automation triggers, the
// task file's format) lives in plugin/context/reference/ and the rule names
// the file: a fragment writes `{{context}}` and it is filled with the real
// path of plugin/context — briefing.d's parent — so the agent can read it
// from any folder. compose.py fills the same path.
const CONTEXT_MARK = '{{context}}'
function contextDir(briefingDir: string): string {
  const dir = resolve(briefingDir, '..')
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/** The briefing for a session whose skills are `has`: base → team-plan →
 *  vault-secrets → responsibility, each `.with` when the skill
 *  is there and `.without` otherwise, joined by "\n", no final "\n". An
 *  unreadable part is left out; '' when none reads. Read now (an edited
 *  fragment reaches the next run). */
export function briefingText(has: readonly string[], dir = defaultBriefingDir()): string {
  const set = new Set(has)
  const parts = [part(join(dir, 'base.md')), ...BRIEFING_FRAGMENTS.map((n) => part(join(dir, `${n}.${set.has(n) ? 'with' : 'without'}.md`)))]
  const text = parts.filter((p) => p !== '').join('\n')
  return text.includes(CONTEXT_MARK) ? text.split(CONTEXT_MARK).join(contextDir(dir)) : text
}

/** What a Claude launch exports when its system-prompt append carries the
 *  briefing (the console's --append-system-prompt-file, the SDK's
 *  systemPrompt.append): the SessionStart hook then never repeats it
 *  (plugin/hooks/session-start.sh) — in the system prompt it outlives
 *  /clear and compaction, and it is never cut at the hook's 10,000-character
 *  cap. */
export const BRIEFED_ENV: Readonly<Record<string, string>> = Object.freeze({ SILOS_BRIEFING: 'system-prompt' })

/** `append` + blank line + the briefing — the order a launch WITH hooks
 *  uses: the agent's own append first, so its charter still opens the
 *  Silos part of the system prompt (started-with.ts splitSystem). */
export function withBriefingAfter(append: string, briefing: string): string {
  if (briefing === '') return append
  return append === '' ? briefing : `${append}\n\n${briefing}`
}

/** briefing + blank line + roster — the composition session-start.sh hands
 *  Claude (shell `$(...)` drops trailing newlines; no roster, no blank line). */
export function contextText(briefing: string, roster: string): string {
  const b = briefing.replace(/\n+$/, '')
  return roster ? `${b}\n\n${roster}` : b
}

/** The briefing + roster for `me`, for a session whose skills are `has`
 *  (see the R7 table: the folder's active skills, the account's personal
 *  ones, an engine's skill roots). No fragments → the roster alone; '' when
 *  neither. */
export function silosBriefing(agents: Agent[], me: string, opts: { withBearer: boolean; has: readonly string[] }, dir = defaultBriefingDir()): string {
  return contextText(briefingText(opts.has, dir), rosterText(agents, me, opts))
}
