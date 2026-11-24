// harnesses/roster-text — the "Your fleet (Silos)" block, server-side. A
// line-for-line port of plugin/hooks/roster.py (the SessionStart hook's
// renderer for Claude Code) so an OpenCode process, which has no such hook,
// reads the very same roster in its context file. Change both together:
// server/test/roster-text.test.ts compares the two outputs.

import type { Agent } from '../types.js'

/** Python's str(): None/True/False spelled as Python spells them. */
const pyStr = (v: unknown): string => (v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v))
/** Python truthiness for JSON values. */
const truthy = (v: unknown): boolean =>
  !(
    v === null ||
    v === undefined ||
    v === false ||
    v === 0 ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
  )
/** `" ".join(str(s).split())`. */
const clean = (s: unknown): string => pyStr(s).split(/\s+/).filter(Boolean).join(' ')
/** `a.get(key, dflt)`: the default only when the key is absent. */
const get = (a: Record<string, unknown>, key: string, dflt: unknown): unknown => (key in a ? a[key] : dflt)

/** The first sentence of the agent's mission text ('' without one) —
 *  roster.py's mission_line, the regex of mission.ts firstSentence. */
function missionLine(a: Record<string, unknown>): string {
  const m = a.mission
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ''
  const text = (m as Record<string, unknown>).text
  if (!truthy(text)) return ''
  const s = clean(text)
  const hit = /^(.+?[.!?])(?=\s|$)/.exec(s)
  return hit ? hit[1]! : s
}

// Bounded like roster.py (the SessionStart hook's output is capped): at
// most LIST_MAX agents, each line at most LINE_MAX characters (code points,
// as Python counts), then one line with how many more and where.
const LIST_MAX = 12
const LINE_MAX = 160
const more = (n: number): string => `- … and ${n} more — the whole fleet: GET \${SILOS_API:-http://127.0.0.1:3210}/api/agents`
function clip(line: string): string {
  const cps = Array.from(line)
  return cps.length <= LINE_MAX ? line : cps.slice(0, LINE_MAX - 1).join('') + '…'
}

function foldersOf(a: Record<string, unknown>): string[] {
  const out: string[] = []
  if (truthy(a.folder)) out.push(clean(a.folder))
  const fs = truthy(a.folders) ? a.folders : []
  for (const f of Array.isArray(fs) ? fs : []) if (truthy(f)) out.push(clean(f))
  return out
}

/** The roster text, '' when there is no one to list (roster.py prints
 *  nothing). `me` is the reader's agent id ('' = none). `withBearer` is
 *  accepted for the launch contract; the roster itself carries no API
 *  recipes (they live in the briefing, already in the conditional-bearer
 *  form), so it does not change the lines. */
export function rosterText(agents: Agent[] | unknown[], me: string, _opts: { withBearer: boolean }): string {
  const lines = ['Your fleet (Silos):']
  const list = (agents as unknown[]).filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null && !Array.isArray(a))
  let listed = 0
  for (const a of list) {
    if (truthy(a.archived) || a.id === 'master') continue
    if (++listed > LIST_MAX) continue
    const parts = [clean(`${pyStr(get(a, 'emoji', ''))} ${pyStr(get(a, 'name', get(a, 'id', '')))}`)]
    const fl = foldersOf(a)
    if (fl.length) parts.push('in ' + fl.join(', '))
    // its mission's first sentence — nothing without one
    parts.push(missionLine(a))
    lines.push(clip('- ' + parts.filter(Boolean).join(' — ')))
  }
  if (lines.length === 1) return ''
  if (listed > LIST_MAX) lines.push(more(listed - LIST_MAX))
  const mine = me ? list.find((a) => a.id === me) : undefined
  if (mine && mine.id !== 'master' && foldersOf(mine).length) {
    lines.push(
      `You are ${clean(get(mine, 'name', me))}. Your territory: ${foldersOf(mine).join(', ')}. ` +
        'To get something done elsewhere, message its agent (see "Messages" below); ' +
        'do not work there.',
    )
  }
  return lines.join('\n')
}
