// loads-places.ts — «Where it loads» (spec scopes §4): a row's lines, one per
// place and per fact, as its block draws them, and the ONE phrase the row
// says when the places disagree. Pure: the engine answered every line
// (LoadsRow.at); this only words them. Neutral — every file, key and the
// account's word come from the line itself.
import type { LoadsLine, LoadsRow, LoadsScope, SkillCopy, SkillLine } from './types'
import type { HereMode } from './here-tools'

/** What a block is drawn for: a row, or an account origin's head (all it
 *  sends of one kind — `kind: 'head'`). */
export interface PlacesSubject {
  key: string
  label: string
  /** `instruction`: one instruction file (a Memory row) · `auto-memory`: auto memory as a whole */
  kind: LoadsRow['kind'] | 'head' | 'personal' | 'instruction' | 'auto-memory'
  engine: string
  at?: LoadsLine[]
}

/** The names a block's labels carry (spec scope-ui-review §3.1): the
 *  project's folder name, a conversation's title, an agent's own emoji. */
export interface PlaceNames {
  project?: string | null
  conversation?: string | null
  emojiOf?: (agentId: string) => string | undefined
}

/** The conversation an agent's page was opened from (its «‹ title»
 *  header): its block gains that conversation's line, with its switch.
 *  `id`/`folder`: the session the switch posts with (and its transcript
 *  folder, the way back); `thread`: the line it names; `cwd`: the project
 *  whose rows the page reads; `mode`: how it starts next. */
export interface PlacesFrom {
  id: string
  folder: string
  thread: string
  title: string
  cwd: string
  mode: HereMode
}

/** The page a row is drawn on: a project's Tools, or one agent's — opened
 *  from one of its conversations (`from`) or not — with the names its
 *  labels carry. */
export type PlacesPage = ({ scope: 'project' } | { scope: 'agent'; agentId: string; agentName: string; from?: PlacesFrom }) & { names?: PlaceNames }

/** «Conversation · <title>» — the conversation's line on its agent's page */
export const conversationLabel = (title: string): string => `Conversation · ${title}`

/** The page's own conversation line: the one it was opened from */
const fromThread = (page: PlacesPage): string | null => (page.scope === 'agent' && page.from ? page.from.thread : null)

const nameOf = (l: LoadsLine): string => l.agentName ?? l.agent ?? 'an agent'

/** «Builder» · «Builder and Writer» · «3 agents» */
export function agentsWords(names: string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.length} agents`
}

const lineOf = (r: LoadsRow, place: LoadsLine['place'], who?: NonNullable<LoadsLine['fact']>['who']): LoadsLine | undefined =>
  r.at?.find((l) => l.place === place && (who === undefined || l.fact?.who === who))

/** The phrase a row says when its places disagree — null when they agree,
 *  or when today's words already say it (the project holds it; a fact
 *  decides). */
export function placesPhrase(r: LoadsRow, page: PlacesPage): string | null {
  if (!r.at) return null
  if (lineOf(r, 'fact', 'organization')) return null
  const machine = lineOf(r, 'machine')
  const project = lineOf(r, 'project')
  if (!project) return null
  const agents = r.at.filter((l) => l.place === 'agent')
  if (page.scope === 'agent') {
    // the conversation it was opened from differs: said first (its narrowest line)
    const here = page.from ? r.at.find((l) => l.place === 'conversation' && l.conversation === page.from!.thread && l.entry !== undefined) : undefined
    if (here && page.from) return here.entry === 'off' ? `off in «${page.from.title}»` : `on only in «${page.from.title}»`
    const mine = agents.find((l) => l.agent === page.agentId)
    if (mine?.entry === 'off' && project.result === 'on') return `off for ${page.agentName} only`
    if (mine?.entry === 'on' && project.result === 'off') return `on for ${page.agentName} only — off in this project`
  } else {
    // one or more agents hold it, the project loads it
    const holding = agents.filter((l) => l.entry === 'off' && project.result === 'on')
    if (holding.length > 0) return `off for ${agentsWords(holding.map(nameOf))}`
    // the project holds it, agents override (an override kind)
    const only = agents.filter((l) => l.entry === 'on' && l.result === 'on' && project.result === 'off')
    if (only.length > 0) return `only ${agentsWords(only.map(nameOf))} ${only.length === 1 ? 'loads' : 'load'} it`
  }
  if (machine?.result === 'off' && project.result === 'on') {
    const repo = lineOf(r, 'fact', 'repository')
    if (repo?.entry === 'on' && !project.entry) return `on in this project — this repository’s ${repo.fact!.file} turns it on`
    return 'on in this project — off on the rest of this machine'
  }
  if (
    machine?.entry === 'off' &&
    project.result === 'off' &&
    !project.entry &&
    !r.at.some((l) => l.place === 'fact' && l.entry === 'off' && l.fact?.who !== 'default')
  )
    return 'off on this machine'
  return null
}

/** The lines a page's block shows: an agent's page shows only that agent's
 *  line among the agents; a project's every agent when five or fewer,
 *  else the ones with an entry of their own (`more`: how many it leaves). */
export function blockLines(r: Pick<PlacesSubject, 'at'>, page: PlacesPage): { lines: LoadsLine[]; more: number } {
  // a conversation is a line only on its agent's page opened from it; any
  // other is a fact at the block's end («Also off in …», alsoIn)
  const thread = fromThread(page)
  const all = (r.at ?? []).filter((l) => l.place !== 'conversation' || (thread !== null && l.conversation === thread))
  if (page.scope === 'agent') return { lines: all.filter((l) => l.place !== 'agent' || l.agent === page.agentId), more: 0 }
  const agents = all.filter((l) => l.place === 'agent')
  if (agents.length <= 5) return { lines: all, more: 0 }
  const shown = all.filter((l) => l.place !== 'agent' || l.entry !== undefined)
  return { lines: shown, more: agents.length - shown.filter((l) => l.place === 'agent').length }
}

/** The words of one line: the place, whom it reaches, where it is kept,
 *  what it follows when it has no entry, and why it is locked. */
export interface LineWords {
  place: string
  reach: string
  kept: string | null
  follows: string | null
  locked: string | null
}

/** A place's ONE label — the same words an origin uses after «From»
 *  (lib/owners.ts): «This machine», «Project · acme», «Agent · 🛠 Builder»,
 *  «Conversation · Fix the importer», «Your Claude account». A name the
 *  page doesn't know leaves the type word with its plain stand-in. */
function namedLabel(place: 'machine' | 'project' | 'agent' | 'conversation', l: { agent?: string; agentName?: string }, names: PlaceNames): string {
  if (place === 'machine') return 'This machine'
  if (place === 'project') return names.project ? `Project · ${names.project}` : 'This project'
  if (place === 'conversation') return names.conversation ? `Conversation · ${names.conversation}` : 'This conversation'
  const emoji = l.agent ? names.emojiOf?.(l.agent) : undefined
  return `Agent · ${emoji ? `${emoji} ` : ''}${l.agentName ?? l.agent ?? 'an agent'}`
}

export function placeLabel(l: LoadsLine, engine: string, names: PlaceNames = {}): string {
  if (l.place === 'account') return `Your ${l.door?.word ?? 'account'}`
  if (l.place === 'fact') {
    const who = l.fact?.who
    return who === 'organization' ? 'Your organization' : who === 'repository' ? 'This repository' : who === 'engine' ? engine : 'Its own default'
  }
  return namedLabel(l.place, l, names)
}

/** What a line with no entry follows, in plain words: «this machine», «the
 *  project», «Builder», «your organization». */
function followsWord(place: string, label: string, agentName?: string): string {
  if (place === 'machine') return 'this machine'
  if (place === 'project') return 'the project'
  if (place === 'agent') return agentName ?? 'its agent'
  return label
    .replace(/^This /, 'this ')
    .replace(/^Your /, 'your ')
    .replace(/^Its /, 'its ')
}

const OPEN_WORDS: Record<string, string> = { machine: 'for this machine', project: 'for this project' }
const AT_WORDS: Record<string, string> = {
  machine: 'on this machine',
  project: 'in this project',
  fact: 'above',
  account: 'in your account',
  agent: 'for this agent',
  conversation: 'in this conversation',
}

/** What the engine's places say about it (its `scopes`): whether it has
 *  logins of an account (its machine line reaches every one Silos
 *  connects), and whether its project place is carried at launch — kept by
 *  Silos, reaching only the conversations Silos starts there. */
export interface PlacesOf {
  logins: boolean
  projectLaunch: boolean
}

/** From an engine's declared places; none known: a file project and logins. */
export function placesOf(scopes: readonly LoadsScope[] | undefined): PlacesOf {
  if (!scopes) return { logins: true, projectLaunch: false }
  return { logins: scopes.some((s) => s.id === 'account'), projectLaunch: scopes.some((s) => s.id === 'project' && s.carrier === 'launch') }
}

export function lineWords(
  l: LoadsLine,
  i: number,
  lines: LoadsLine[],
  r: Pick<PlacesSubject, 'kind' | 'engine'>,
  agentNames: string[],
  places: PlacesOf = placesOf(undefined),
  names: PlaceNames = {},
): LineWords {
  const noun =
    r.kind === 'personal'
      ? 'they'
      : r.kind === 'instruction'
        ? 'the file'
        : r.kind === 'auto-memory'
          ? 'auto memory'
          : r.kind === 'connector'
            ? 'a connector'
            : r.kind === 'plugin'
              ? 'a plugin'
              : r.kind === 'head'
                ? 'what your account sends'
                : 'an MCP server'
  const launched = (l.place === 'project' && places.projectLaunch) || l.place === 'agent' || l.place === 'conversation'
  const reach =
    l.place === 'account'
      ? `${l.door?.login ? `${l.door.login} — ` : ''}everywhere it is signed in`
      : l.place === 'machine'
        ? places.logins
          ? 'every project and every claude on this machine, on every login Silos connects'
          : 'every project on this machine, and what you start here by hand'
        : l.place === 'project' && places.projectLaunch
          ? `the conversations Silos starts here${agentNames.length > 0 ? ` — ${agentNames.join(' · ')}` : ''}; not one started by hand`
          : l.place === 'project'
            ? `${agentNames.length > 0 ? `${agentNames.join(' · ')}, and` : 'every conversation in this folder, and'} what you start here by hand`
            : l.place === 'agent'
              ? `the conversations Silos starts for ${nameOf(l)} — not one started by hand`
              : l.place === 'conversation'
                ? 'the starts Silos makes of this one conversation'
                : `${l.fact!.key} in ${l.fact!.file}`
  const kept = l.place === 'fact' ? null : (l.keptIn ?? (launched && l.entry ? 'kept by Silos' : null))
  // what a line with no entry follows: the line above it in the chain (an
  // agent's: the project's; a conversation's: its agent's when that holds
  // an entry, else the project's)
  let follows: string | null = null
  if (!l.entry && l.place !== 'account' && l.place !== 'fact') {
    const above =
      l.place === 'conversation'
        ? (lines.find((x) => x.place === 'agent' && x.agent === l.agent && x.entry) ?? lines.find((x) => x.place === 'project'))
        : l.place === 'agent'
          ? lines.find((x) => x.place === 'project')
          : lines
              .slice(0, i)
              .reverse()
              .find((x) => x.place !== 'account' && x.place !== 'agent' && x.place !== 'conversation')
    follows = above ? `follows ${followsWord(above.place, placeLabel(above, r.engine, names), above.agentName ?? above.agent)}` : 'nothing kept — on by default'
    if (launched) follows = `nothing kept · ${follows}`
  }
  const locked = !l.locked
    ? null
    : l.locked.parent
      ? `goes with ${l.locked.parent} — off ${AT_WORDS[l.locked.at ?? 'fact']}`
      : l.locked.why === 'organization'
        ? 'your organization decides'
        : // its origin's whole head is off wider: that is what opens first
          l.locked.head
          ? `everything of its kind is off ${AT_WORDS[l.locked.at ?? 'fact']} — open it ${OPEN_WORDS[l.locked.at ?? 'fact'] ?? 'there'} first`
          : l.locked.why === 'provided'
            ? 'your organization provides it — an entry in this project’s files doesn’t apply'
            : `off ${AT_WORDS[l.locked.at ?? 'fact']} — ${noun} can’t be turned back on below it`
  return { place: placeLabel(l, r.engine, names), reach, kept, follows, locked }
}

/** A page's facts at the block's end: each conversation whose own entry
 *  names this row — «Also off in «title»», its door the session the thread
 *  continues in (null: the page has no door for it). On an agent's page,
 *  only that agent's conversations. */
export function alsoIn(
  r: Pick<PlacesSubject, 'at'>,
  page: PlacesPage,
  doors: readonly { thread: string; folder: string; id: string; title: string }[] | undefined,
): { words: string; title: string; door: { folder: string; id: string } | null }[] {
  const thread = fromThread(page)
  return (r.at ?? [])
    .filter(
      (l) =>
        l.place === 'conversation' &&
        l.entry !== undefined &&
        l.conversation &&
        l.conversation !== thread &&
        (page.scope !== 'agent' || l.agent === page.agentId),
    )
    .map((l) => {
      const d = doors?.find((x) => x.thread === l.conversation)
      return { words: `Also ${l.entry} in`, title: d?.title || 'a conversation', door: d ? { folder: d.folder, id: d.id } : null }
    })
}

/** The machine line's «off», said before the click (spec scopes §4): it
 *  reaches every project and every login Silos connects — with how many
 *  projects load it now, when read. */
export function machineOffSentence(projects: number | null, logins = true): string {
  const base = logins ? 'Turns it off in every project on this machine and every login Silos connects' : 'Turns it off in every project on this machine'
  if (projects === null) return `${base}.`
  return `${base} — ${projects === 0 ? 'no project loads it now' : `${projects} ${projects === 1 ? 'project loads' : 'projects load'} it now`}.`
}

/** The logins that did not follow the machine's file after a click, named
 *  (never in silence) — null when every one did. */
export function missedWords(missed: readonly { name: string; why: string }[]): string | null {
  if (missed.length === 0) return null
  const names = missed.length <= 2 ? missed.map((m) => m.name).join(' and ') : `${missed.length} logins`
  const why = missed.every((m) => m.why === 'account-unreadable')
    ? missed.length === 1
      ? 'its own settings file can’t be read'
      : 'their own settings files can’t be read'
    : missed.every((m) => m.why === 'machine-unreadable')
      ? 'this machine’s settings file can’t be read'
      : 'Silos couldn’t update it'
  return `Not followed by ${names} — ${why}; ${missed.length === 1 ? 'that login loads' : 'those logins load'} what it loaded before.`
}

// ---- a skill's «Where it loads» (spec scopes T9): the same grammar with
// three positions per line (on · name only · off) and, for a name several
// copies share, which copies each line's entry reaches.

const POSITION_WORD: Record<string, string> = { on: 'on', 'name-only': 'name only', off: 'off' }
/** a position as the screen says it — a value found by hand, as it is */
export const positionWord = (v: string): string => POSITION_WORD[v] ?? v

const COPY_WORD: Record<SkillCopy, string> = { personal: 'your personal copy', account: 'the account’s copy', project: 'this folder’s copy' }
const copiesWords = (c: readonly SkillCopy[]): string => c.map((x) => COPY_WORD[x]).join(' and ')

const skillNameOf = (l: SkillLine): string => l.agentName ?? l.agent ?? 'an agent'

/** The lines a page's block shows (blockLines' rule, for a skill's lines). */
export function skillBlockLines(every: readonly SkillLine[], page: PlacesPage): { lines: SkillLine[]; more: number } {
  const thread = fromThread(page)
  const all = every.filter((l) => l.place !== 'conversation' || (thread !== null && l.conversation === thread))
  if (page.scope === 'agent') return { lines: all.filter((l) => l.place !== 'agent' || l.agent === page.agentId), more: 0 }
  const agents = all.filter((l) => l.place === 'agent')
  if (agents.length <= 5) return { lines: [...all], more: 0 }
  const shown = all.filter((l) => l.place !== 'agent' || l.entry !== undefined)
  return { lines: shown, more: agents.length - shown.filter((l) => l.place === 'agent').length }
}

export function skillPlaceLabel(l: SkillLine, names: PlaceNames = {}): string {
  if (l.place === 'account') return `Your ${l.door?.word ?? 'account'}`
  if (l.place === 'fact') return l.fact?.who === 'organization' ? 'Your organization' : 'This repository'
  return namedLabel(l.place, l, names)
}

/** The words of one skill line: the place, whom it reaches, where it is
 *  kept, what it follows, why it is locked, and which copies its entry
 *  reaches when a name is shared. */
export interface SkillLineWords extends LineWords {
  copies: string | null
}

export function skillLineWords(l: SkillLine, i: number, lines: readonly SkillLine[], agentNames: string[], names: PlaceNames = {}): SkillLineWords {
  const reach =
    l.place === 'account'
      ? `${l.door?.login ? `${l.door.login} — ` : ''}everywhere it is signed in`
      : l.place === 'machine'
        ? 'every project and every claude on this machine, on every login Silos connects'
        : l.place === 'project'
          ? `${agentNames.length > 0 ? `${agentNames.join(' · ')}, and` : 'every conversation in this folder, and'} what you start here by hand`
          : l.place === 'agent'
            ? `the conversations Silos starts for ${skillNameOf(l)} — not one started by hand`
            : l.place === 'conversation'
              ? 'the starts Silos makes of this one conversation'
              : `${l.fact!.key} in ${l.fact!.file}`
  const kept =
    l.place === 'fact'
      ? null
      : l.store
        ? 'moved out of the folder by Silos when off'
        : (l.keptIn ?? ((l.place === 'agent' || l.place === 'conversation') && l.entry !== undefined ? 'kept by Silos' : null))
  let follows: string | null = null
  if (l.entry === undefined && l.place !== 'account' && l.place !== 'fact' && !l.locked) {
    const above =
      l.place === 'conversation'
        ? (lines.find((x) => x.place === 'agent' && x.agent === l.agent && x.entry !== undefined) ?? lines.find((x) => x.place === 'project'))
        : l.place === 'agent'
          ? lines.find((x) => x.place === 'project')
          : lines
              .slice(0, i)
              .reverse()
              .find((x) => x.place === 'machine' || x.place === 'fact')
    follows = above ? `follows ${followsWord(above.place, skillPlaceLabel(above, names), above.agentName ?? above.agent)}` : 'nothing kept — on by default'
    if (l.place === 'agent' || l.place === 'conversation') follows = `nothing kept · ${follows}`
  }
  const lk = l.locked
  const locked = !lk
    ? null
    : lk.why === 'organization'
      ? 'your organization decides'
      : lk.why === 'engine'
        ? lk.reason === 'plugin'
          ? 'a plugin’s skill — on and off with its plugin, in Tools'
          : 'a name settings can’t store — Claude Code ignores any position for it'
        : l.place === 'agent' && lk.at === 'project'
          ? 'out of this folder — an agent can’t bring it back alone'
          : lk.at === 'machine'
            ? 'off for this whole machine, with everything your Claude account sends'
            : lk.at === 'agent'
              ? 'off for this agent, with everything your Claude account sends'
              : 'off in this project, with everything your Claude account sends — add it here first'
  let copies: string | null = null
  if (l.reaches && l.reaches.length > 0) {
    const all = [...new Set(lines.flatMap((x) => x.reaches ?? []))]
    const missed = all.filter((c) => !l.reaches!.includes(c))
    const unsure = l.reaches.filter((c) => (l.unmeasured ?? []).includes(c))
    const sure = l.reaches.filter((c) => !unsure.includes(c))
    copies =
      `reaches ${missed.length > 0 && unsure.length === 0 ? 'only ' : ''}${copiesWords(sure.length > 0 ? sure : l.reaches)}` +
      (sure.length > 0 && unsure.length > 0 ? ` — ${copiesWords(unsure)} too, not measured` : '') +
      (missed.length > 0 ? ` — ${copiesWords(missed)} still loads` : '')
  }
  return { place: skillPlaceLabel(l, names), reach, kept, follows, locked, copies }
}

/** The phrase a skill's row says when its places disagree (placesPhrase's
 *  rule) — null when they agree, or today's words already say it. */
export function skillPlacesPhrase(lines: readonly SkillLine[] | undefined, page: PlacesPage): string | null {
  if (!lines) return null
  if (lines.some((l) => l.locked?.why === 'organization' || l.locked?.why === 'engine')) return null
  const machine = lines.find((l) => l.place === 'machine')
  const project = lines.find((l) => l.place === 'project')
  if (!project) return null
  const agents = lines.filter((l) => l.place === 'agent' && l.entry !== undefined && l.result !== project.result)
  if (page.scope === 'agent') {
    const here = page.from ? lines.find((l) => l.place === 'conversation' && l.conversation === page.from!.thread && l.entry !== undefined) : undefined
    if (here && page.from) return here.entry === 'off' ? `off in «${page.from.title}»` : `${positionWord(here.entry!)} only in «${page.from.title}»`
    const mine = agents.find((l) => l.agent === page.agentId)
    if (mine)
      return project.result === 'off'
        ? `${positionWord(mine.result)} for ${page.agentName} only — off in this project`
        : `${positionWord(mine.result)} for ${page.agentName} only`
  } else if (agents.length > 0) {
    const on = agents.filter((l) => l.result !== 'off')
    if (project.result === 'off' && on.length === agents.length) return `only ${agentsWords(on.map(skillNameOf))} ${on.length === 1 ? 'loads' : 'load'} it`
    const byResult = new Map<string, string[]>()
    for (const l of agents) byResult.set(l.result, [...(byResult.get(l.result) ?? []), skillNameOf(l)])
    return [...byResult].map(([r, names]) => `${positionWord(r)} for ${agentsWords(names)}`).join(' · ')
  }
  if (machine && machine.result !== 'on' && project.entry !== undefined && project.result !== machine.result) {
    return `${positionWord(project.result)} in this project — ${positionWord(machine.result)} on the rest of this machine`
  }
  if (
    machine?.entry !== undefined &&
    project.entry === undefined &&
    project.result === machine.result &&
    machine.result !== 'on' &&
    !lines.some((l) => l.place === 'fact')
  )
    return `${positionWord(machine.result)} on this machine`
  return null
}

/** Rule 4 at one line, said before the click (a line whose own «off» is its
 *  origin's head): only this one is added there, the others stay off; what
 *  the account sends later loads. `where`: «on this machine», «for Builder». */
export function addAtWords(label: string, where: string): string {
  return `Adds only ${label} ${where} — the others stay off there; what your account sends later will load.`
}
