// harnesses/roster-text — the roster block, server-side: the agents of the
// reader's projects, never the install (project-scope.ts is the rule). A
// line-for-line port of plugin/hooks/roster.py (the SessionStart hook's
// renderer for Claude Code) so a hooks-off turn and an OpenCode process,
// which have no such hook, read the very same roster. Change both together:
// server/test/roster-text.test.ts compares the two outputs.
//
// · An agent: «Your projects (Silos): …», the agents it knows — each with
//   those of its folders that are the reader's projects too — and where the
//   wall is.
// · No identity, or the owner's desk (master): the agents of the folder it
//   runs in (`cwd`), under «This folder's agents (Silos):»; a folder that is
//   nobody's project gets nothing.

import type { Agent } from '../types.js'
import { sameProject } from '../project-scope.js'

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
const MASTER = 'master'
const more = (n: number): string => `- … and ${n} more — GET \${SILOS_API:-http://127.0.0.1:3210}/api/agents`
const WALL = 'Outside your projects there is nobody for you to reach: ask the owner. Do not work outside your projects.'
const APART = "Your projects are kept apart: do not carry one project's matters, files or messages into another unless the owner asks."
function clip(line: string): string {
  const cps = Array.from(line)
  return cps.length <= LINE_MAX ? line : cps.slice(0, LINE_MAX - 1).join('') + '…'
}

type Row = Record<string, unknown>
const strip = (p: string): string => (Array.from(p).length > 1 ? p.replace(/\/+$/, '') || '/' : p)

/** The declared folders, absolute, no trailing slash, each once. */
function foldersOf(a: Row): string[] {
  const out: string[] = []
  const more = Array.isArray(a.folders) ? a.folders : []
  for (const p of [a.folder, ...more]) {
    if (typeof p !== 'string' || !p.startsWith('/')) continue
    const f = strip(p)
    if (f !== '/' && !out.includes(f)) out.push(f)
  }
  return out
}
const inPlay = (a: Row): boolean => !truthy(a.archived) && a.id !== MASTER && foldersOf(a).length > 0
function knows(a: Row, b: Row): boolean {
  if (!inPlay(a) || !inPlay(b)) return false
  const fb = foldersOf(b)
  return foldersOf(a).some((f) => fb.some((g) => sameProject(f, g)))
}
function shared(a: Row, b: Row): string[] {
  const fa = foldersOf(a)
  return foldersOf(b).filter((g) => fa.some((f) => sameProject(f, g)))
}

function line(a: Row, folders: string[]): string {
  const parts = [clean(`${pyStr(get(a, 'emoji', ''))} ${pyStr(get(a, 'name', get(a, 'id', '')))}`)]
  if (folders.length) parts.push('in ' + folders.map(clean).join(', '))
  // its mission's first sentence — nothing without one
  parts.push(missionLine(a))
  return clip('- ' + parts.filter(Boolean).join(' — '))
}
function listed(rows: Array<[Row, string[]]>): string[] {
  const lines = rows.slice(0, LIST_MAX).map(([a, f]) => line(a, f))
  if (rows.length > LIST_MAX) lines.push(more(rows.length - LIST_MAX))
  return lines
}
/** More than one project among its own folders (nesting joins them). */
function apart(fl: string[]): boolean {
  let groups: string[][] = []
  for (const f of fl) {
    const hit = groups.filter((g) => g.some((x) => sameProject(f, x)))
    groups = [...groups.filter((g) => !hit.includes(g)), [f, ...hit.flat()]]
  }
  return groups.length > 1
}

/** The roster text, '' when there is nothing to say (roster.py prints
 *  nothing). `me` is the reader's agent id ('' = none); `cwd` the folder the
 *  session runs in (read only for no identity and the owner's desk).
 *  `withBearer` is accepted for the launch contract; the roster carries no
 *  API recipes (they live in the briefing), so it does not change the lines. */
export function rosterText(agents: Agent[] | unknown[], me: string, opts: { withBearer: boolean; cwd?: string | null }): string {
  const list = (agents as unknown[]).filter((a): a is Row => typeof a === 'object' && a !== null && !Array.isArray(a))
  const mine = me ? list.find((a) => a.id === me) : undefined
  if (me && mine === undefined) return ''
  if (mine !== undefined && mine.id !== MASTER) {
    if (!inPlay(mine)) return ''
    const fl = foldersOf(mine)
    const rows: Array<[Row, string[]]> = list.filter((a) => a.id !== me && knows(mine, a)).map((a) => [a, shared(mine, a)])
    const name = clean(get(mine, 'name', me))
    const lines = [`Your projects (Silos): ${fl.map(clean).join(', ')}`]
    if (rows.length > 0) {
      lines.push('Agents who work there with you:', ...listed(rows))
      lines.push(`You are ${name}. For work in a folder that is theirs and not yours, message that agent (see "Messages" below). ${WALL}`)
    } else {
      lines.push(`You are ${name}, the only agent there. ${WALL}`)
    }
    if (apart(fl)) lines.push(APART)
    return lines.join('\n')
  }
  // no identity, or the owner's desk: the agents of the folder it runs in
  const cwd = opts.cwd ?? ''
  if (!cwd || !cwd.startsWith('/') || strip(cwd) === '/') return ''
  const here = strip(cwd)
  const rows = list
    .filter(inPlay)
    .map((a): [Row, string[]] => [a, foldersOf(a).filter((f) => sameProject(f, here))])
    .filter(([, f]) => f.length > 0)
  if (rows.length === 0) return ''
  return ["This folder's agents (Silos):", ...listed(rows)].join('\n')
}
