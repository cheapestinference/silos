// loads-view.ts — how the inventory of what a folder loads (GET
// /api/folders/:folder/loads) is drawn on Tools: one group per owner, the
// Claude account split by login; a plugin row holding its own servers; the
// words a row says about its state, its placeholder, its shared address
// and the copy that takes its place. Pure — the screen only lays it out.
import type { FolderLoads, LoadsCarries, LoadsHealth, LoadsLine, LoadsOrigin, LoadsRow, LoadsSignIn, StartedWithPart, StartProblem } from './types'
import type { Owner } from './owners'
import { relTime } from './rel-time'

/** The group a row sits in: its owner, the account per login, or the
 *  things seen loading that Silos can't place. */
export function groupOf(r: LoadsRow): string {
  if (r.origin.owner === 'account') return `account:${r.origin.unmatched ? '?' : (r.origin.login ?? '')}`
  return r.origin.owner ?? SEEN
}
export const SEEN = 'seen'

/** The owner a group stands for — what is seen and not placed is the
 *  engine's (it loaded it; nothing says from where). */
export function ownerOfToolGroup(g: string): Owner {
  if (g.startsWith('account:')) return 'account'
  if (g === SEEN) return 'engine'
  return g as Owner
}

/** The login a Claude account group names: an email, '' when Silos can't
 *  say which login, '?' for a batch no recorded start matches. */
export function loginOfGroup(g: string): string | null {
  return g.startsWith('account:') ? g.slice('account:'.length) : null
}

/** Rows drawn at the top level: plugins and everything with no plugin row
 *  present; a plugin's servers sit under it. */
export function topLevel(rows: LoadsRow[]): LoadsRow[] {
  const keys = new Set(rows.map((r) => r.key))
  return rows.filter((r) => !r.parent || !keys.has(r.parent))
}
export function childrenOf(rows: LoadsRow[], key: string): LoadsRow[] {
  return rows.filter((r) => r.parent === key)
}

/** What a conversation here really gets: on, and not standing aside for another copy. */
export const loads = (r: LoadsRow): boolean => r.state === 'active' && !r.replacedBy

/** The row of the plugin a skill comes with, by the key the inventory made:
 *  of the plugin rows of that name, the copy that loads here, else any —
 *  undefined when the inventory has none (the door then opens the tab). */
export function pluginRowOf(rows: LoadsRow[], plugin: string): LoadsRow | undefined {
  const named = rows.filter((r) => r.kind === 'plugin' && r.label === plugin)
  return named.find(loads) ?? named[0]
}

/** A row waiting for your sign-in (its newest reading says so): «Sign in ›». */
export const needsSignIn = (r: LoadsRow): boolean => r.kind !== 'plugin' && loads(r) && r.health?.status === 'needs-auth'

/** The door a row offers for a sign-in, the engine's own (LoadsSignIn) —
 *  on EVERY row whose line says it waits, folded or flat: a server or
 *  connector its own; a plugin whose servers wait, the one waiting server's,
 *  or, several waiting, `unfold` (each server then shows its own) — unless
 *  they all go to one outside page, then that page. null: no door. */
export type SignInDoorOf = LoadsSignIn | { via: 'unfold'; servers: string[] }
export function signInDoorOf(r: LoadsRow, rows: LoadsRow[]): SignInDoorOf | null {
  if (r.kind !== 'plugin') return needsSignIn(r) ? (r.signIn ?? null) : null
  if (!loads(r)) return null
  const waiting = childrenOf(rows, r.key).filter(needsSignIn)
  if (waiting.length === 0) return null
  if (waiting.length === 1) return waiting[0]!.signIn ?? null
  return sharedLink(waiting.map((w) => w.signIn)) ?? { via: 'unfold', servers: waiting.map((w) => w.key) }
}

/** The one outside page a set of sign-ins all go to (connectors only:
 *  claude.ai), else null — a mixed set has no single door. */
export function sharedLink(doors: (LoadsSignIn | undefined)[]): Extract<LoadsSignIn, { via: 'link' }> | null {
  const first = doors[0]
  if (!first || first.via !== 'link') return null
  return doors.every((d) => d?.via === 'link' && d.url === first.url) ? first : null
}

/** A row's line for one agent (its «Only <agent>» line), where the engine
 *  answers places. */
export const agentLineOf = (r: LoadsRow, agentId: string): LoadsLine | undefined => r.at?.find((l) => l.place === 'agent' && l.agent === agentId)

/** Whether a conversation of this agent loads the row: its own line where
 *  the engine answers places, else what the project loads. */
export const loadsFor = (r: LoadsRow, agentId?: string): boolean => {
  const l = agentId !== undefined ? agentLineOf(r, agentId) : undefined
  return l ? l.result === 'on' && !r.replacedBy : loads(r)
}

/** The agent holds the row: the project loads it, this agent's own line
 *  keeps it off («off for Builder only» — kept in place on its page). */
export const heldByAgent = (r: LoadsRow, agentId?: string): boolean => agentId !== undefined && loads(r) && agentLineOf(r, agentId)?.result === 'off'

/** Agent › Tools: the rows that load for this agent — and those it alone
 *  holds, kept in place (spec scopes §5) — a plugin with its servers; what
 *  the project keeps off or could add is counted at the foot. */
export function agentRows(rows: LoadsRow[], agentId?: string): LoadsRow[] {
  const on = new Set(rows.filter((r) => loadsFor(r, agentId) || heldByAgent(r, agentId)).map((r) => r.key))
  return rows.filter((r) => on.has(r.key) && (!r.parent || on.has(r.parent) || !rows.some((p) => p.key === r.parent)))
}

/** The foot's counts: each thing once — a plugin's servers are counted only
 *  when one is off while its plugin is on. With an agent: what the project
 *  keeps off and the agent turns on is not «off», and `agentOff` counts
 *  what the agent alone holds. */
export function footCounts(rows: LoadsRow[], agentId?: string): { off: number; couldAdd: number; agentOff: number } {
  const byKey = new Map(rows.map((r) => [r.key, r]))
  let off = 0
  let couldAdd = 0
  let agentOff = 0
  for (const r of rows) {
    const parent = r.parent ? byKey.get(r.parent) : undefined
    if (heldByAgent(r, agentId)) {
      if (!(parent && heldByAgent(parent, agentId))) agentOff++
      continue
    }
    if (loadsFor(r, agentId)) continue
    if (parent && parent.state === r.state && !loadsFor(parent, agentId)) continue
    if (r.state === 'held') off++
    else if (r.state === 'available') couldAdd++
  }
  return { off, couldAdd, agentOff }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** «3 skills · 9 MCP servers · 2 placeholders · 4 hooks» — what is there, nothing for none. */
export function carriesWords(c: LoadsCarries): string {
  return [
    c.skills.length ? plural(c.skills.length, 'skill') : '',
    c.commands.length ? plural(c.commands.length, 'command') : '',
    c.agents.length ? plural(c.agents.length, 'subagent type') : '',
    c.mcp ? plural(c.mcp, 'MCP server') : '',
    c.placeholders ? plural(c.placeholders, 'placeholder') : '',
    c.hooks.count ? plural(c.hooks.count, 'hook') : '',
    c.lsp.length ? plural(c.lsp.length, 'LSP server') : '',
    c.outputStyles.length ? plural(c.outputStyles.length, 'output style') : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The line under a row's name: why it is in the state it is in, and what
 *  it is when that says more than its state. */
export function rowWords(r: LoadsRow, all: FolderLoads): string {
  const byKey = (k: string | undefined): LoadsRow | undefined => (k ? all.rows.find((x) => x.key === k) : undefined)
  if (r.observed?.from === 'tool-id') return 'seen when it last loaded — only its tool name is known'
  if (r.observed && r.origin.owner === null) return 'seen when it last loaded — Silos can’t tell where it is set up'
  if (r.replacedBy) {
    const other = byKey(r.replacedBy)
    return other?.origin.owner === 'account' ? 'your Claude account’s copy loads in its place' : 'your installed copy takes its place'
  }
  const decided = r.decidedBy ? `${r.decidedBy.key} in ${r.decidedBy.file}` : null
  if (r.state === 'held') return decided ? `off — ${decided}` : 'off in this project — new conversations here won’t load it'
  if (r.state === 'available') {
    const brings = r.kind === 'plugin' && r.carries ? carriesWords(r.carries) : ''
    return decided ? `not added — ${decided}` : `could add${brings ? ` — brings ${brings}` : ' — off in this project'}`
  }
  if (r.placeholder) {
    const c = byKey(r.placeholder.connector)
    return c
      ? `a placeholder — left to the ${c.label} connector${c.state === 'active' ? '' : ', off in this project'}`
      : 'a placeholder — no address; the plugin leaves it to a connector'
  }
  if (r.sameAs) {
    const first = byKey(r.sameAs)
    return first ? `the same server as ${first.label} · ${first.origin.carrier} — connected once` : 'the same address as another server — connected once'
  }
  if (r.decidedBy?.file === 'managed settings') return 'always on — your organization’s managed settings'
  if (r.kind === 'plugin') return [r.carries ? carriesWords(r.carries) : '', r.detail ?? ''].filter(Boolean).join(' · ') || 'a plugin'
  if (r.kind === 'connector') return 'a connector of your Claude account'
  return r.detail ? `${r.detail}` : r.origin.carrier
}

// ---- health (the turns' status readings, tool-health.ts on the server)

/** How a row's health reads: its tone (the dot), its word, how it was read,
 *  and the engine's message when it says why. */
export interface HealthWords {
  tone: 'ok' | 'warn' | 'bad' | 'quiet'
  word: string
  how?: string
  reason?: string
  /** a count of several servers: only the dot carries the tone */
  summary?: true
  /** how often it did not start — «didn’t start the last 12 times · since
   *  3 Nov» — with what was counted when it was start notices */
  count?: { words: string; partial?: string }
}

/** A server or connector a conversation here really dials: a placeholder,
 *  the same server as another, a copy standing aside and what is off have
 *  no health of their own. */
const dialed = (r: LoadsRow): boolean => r.kind !== 'plugin' && (r.exact || r.health !== undefined) && loads(r) && !r.placeholder && !r.sameAs

/** «read 2h ago, in a chat of Builder» · «read 2h ago, from a console’s start» */
export function howRead(read: LoadsHealth['read'], now: number): string {
  if (read.from === 'notice')
    return `read ${relTime(read.at, now)}, from a ${read.mode === 'chat' ? 'chat' : read.mode === 'console' ? 'console' : 'conversation'}’s start`
  const by = read.from === 'check' ? ', in a check' : read.via ? `, in a ${read.via}${read.agentName ? ` of ${read.agentName}` : ''}` : ''
  return `read ${relTime(read.at, now)}${by}`
}

const WORD: Record<LoadsHealth['status'], { tone: HealthWords['tone']; word: string }> = {
  connected: { tone: 'ok', word: 'connected' },
  'needs-auth': { tone: 'warn', word: 'needs your sign-in' },
  failed: { tone: 'bad', word: 'didn’t start' },
  pending: { tone: 'quiet', word: 'still connecting' },
  disabled: { tone: 'quiet', word: 'off in Claude Code' },
}

/** What start notices are, said wherever a count rests on them. */
export const NOTICES_PARTIAL = 'from start notices — they name some failures, not all'

const day = (at: number): string => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
/** «didn’t start the last 12 times · since 3 Nov» (the run — status
 *  readings), «didn’t start 3 of the last 20 times» (the window), «…the
 *  last 3 console starts» when start notices of consoles were counted. */
export function countWords(c: NonNullable<LoadsHealth['count']>): { words: string; partial?: string } {
  const unit = c.from === 'notices' ? (c.consoles ? 'console starts' : 'starts') : 'times'
  const one = c.from === 'notices' ? (c.consoles ? 'console start' : 'start') : 'time'
  const words =
    c.of !== undefined
      ? `didn’t start ${c.n} of the last ${c.of} ${c.of === 1 ? one : unit}`
      : c.n === 1
        ? `didn’t start the last ${one}`
        : `didn’t start the last ${c.n} ${unit}${c.since !== undefined ? ` · since ${day(c.since)}` : ''}`
  return { words, ...(c.from === 'notices' ? { partial: NOTICES_PARTIAL } : {}) }
}

/** A project where only start notices tell the health (no status reading
 *  kept): what the Tools tab says above its rows. null otherwise. */
export function noticesOnlyWords(all: FolderLoads): string | null {
  const b = all.basis
  if (!b || b.readings > 0 || b.notices === 0) return null
  return b.consoles === b.notices
    ? 'Only consoles ran here: health comes from their start notices — they name some failures, not all.'
    : 'Health here comes from start notices — they name some failures, not all.'
}

/** A row's health line; null where health is not a thing (a plugin — see
 *  pluginHealth —, a placeholder, what does not load, an engine that reads
 *  no status). */
export function healthOf(r: LoadsRow, all: FolderLoads, now: number): HealthWords | null {
  if (!dialed(r)) return null
  if (r.health) {
    const w = WORD[r.health.status]
    const tools = r.health.status === 'connected' && r.health.tools !== undefined ? ` · ${plural(r.health.tools, 'tool')}` : ''
    return {
      tone: w.tone,
      word: `${w.word}${tools}`,
      how: howRead(r.health.read, now),
      ...(r.health.reason && r.health.status !== 'connected' ? { reason: r.health.reason } : {}),
      ...(r.health.count ? { count: countWords(r.health.count) } : {}),
    }
  }
  return all.engines.some((e) => e.label === r.engine && e.readsStatus) ? { tone: 'quiet', word: 'not read yet' } : null
}

interface Tally {
  failed: number
  auth: number
  ok: number
  other: number
  unread: number
  newest: LoadsHealth['read'] | null
}
/** The health of what a set of rows dials, counted. */
function tally(rows: LoadsRow[]): Tally {
  const t: Tally = { failed: 0, auth: 0, ok: 0, other: 0, unread: 0, newest: null }
  for (const r of rows) {
    if (!dialed(r)) continue
    const h = r.health
    if (!h) {
      t.unread++
      continue
    }
    if (h.status === 'failed') t.failed++
    else if (h.status === 'needs-auth') t.auth++
    else if (h.status === 'connected') t.ok++
    else t.other++
    if (!t.newest || h.read.at > t.newest.at) t.newest = h.read
  }
  return t
}
// the worst first
const tallyWords = (t: Tally): string =>
  [
    t.failed ? `${t.failed} didn’t start` : '',
    t.auth ? `${t.auth} ${t.auth === 1 ? 'needs' : 'need'} your sign-in` : '',
    t.ok ? `${t.ok} connected` : '',
    t.other ? `${t.other} still connecting or off` : '',
    t.unread ? `${t.unread} not read yet` : '',
  ]
    .filter(Boolean)
    .join(' · ')

/** A plugin row's line: how its servers are, counted — nothing when none was read. */
export function pluginHealth(r: LoadsRow, all: FolderLoads, now: number): HealthWords | null {
  if (r.kind !== 'plugin' || !loads(r)) return null
  const t = tally(childrenOf(all.rows, r.key))
  if (!t.newest) return null
  return { tone: t.failed ? 'bad' : t.auth ? 'warn' : 'ok', word: tallyWords(t), how: howRead(t.newest, now), summary: true }
}

/** Agent › Now's Tools door: the state of what it loads, in a line. */
export function toolsDoorWords(all: FolderLoads, now: number): string {
  const base = 'plugins, servers, connectors it loads'
  if (!all.engines.some((e) => e.readsStatus)) return base
  const t = tally(agentRows(all.rows))
  if (!t.newest) return t.unread ? `${base} · not read yet` : base
  if (!t.failed && !t.auth && !t.other && !t.unread) return `all connected · ${howRead(t.newest, now)}`
  // what needs you first, the rest in one count
  const problems = tallyWords({ ...t, ok: 0, other: 0, unread: 0 })
  if (problems) return `${problems} · read ${relTime(t.newest.at, now)}`
  return `${t.ok} connected · ${t.other + t.unread} not connected yet · read ${relTime(t.newest.at, now)}`
}

// ---- the proof (rule 7): a switch that didn't take, said on its row

/** «still loaded — the switch didn’t take», where it was read and the way
 *  out: an account item turned off by its own name has its origin's head
 *  (that depends on no name); anything else, a fresh reading — «Check now»
 *  shows at once whether it takes. Never fixed for him. null: no proof. */
export interface ProofWords {
  line: string
  how: string
  /** what the reading said of it, opened: «plugin:design:figma — connected» */
  listed: string
  wayOut: 'origin' | 'check'
  /** the opened row's sentence: why, and what to do */
  long: string
}
export function proofWords(r: LoadsRow, now: number): ProofWords | null {
  const p = r.proof
  if (!p || r.state === 'active') return null
  const status = WORD[p.status].word
  const how = howRead(p.read, now)
  const wayOut = r.origin.owner === 'account' && p.by === 'item' ? 'origin' : 'check'
  const by = p.by === 'origin' ? 'the off switch for everything your Claude account sends' : 'its off switch'
  const long =
    wayOut === 'origin'
      ? `This project’s local settings hold ${by}, yet a conversation started after it still loaded ${p.name}. Turning off what your Claude account sends here, at its group’s head, doesn’t depend on the name — or check again to see whether it takes now.`
      : `This project’s local settings hold ${by}, yet a conversation started after it still loaded ${p.name}. The engine may read the key differently, or another file may turn it on. Check again to see whether it takes now.`
  return { line: 'still loaded — the switch didn’t take', how, listed: `${p.name} — ${status}`, wayOut, long }
}

/** A place's own entry that didn't take (spec scopes §7, LoadsLine.proof),
 *  the amber line naming the place: «still loaded for Builder — the switch
 *  didn’t take», «didn’t load for Builder — its own “on” didn’t take»; the
 *  machine's «… — this machine’s switch didn’t take»; in a conversation's
 *  column (`here`: its thread) «still loaded here». `agent`: an agent's
 *  page — only that agent's line and the machine's (another agent's lines
 *  are not this page's). One per line that has a proof, broadest first. */
export function placeProofWords(r: LoadsRow, now: number, only: { agent?: string; here?: string } = {}): (ProofWords & { key: string })[] {
  const out: (ProofWords & { key: string })[] = []
  for (const l of r.at ?? []) {
    const p = l.proof
    if (!p) continue
    if (l.place === 'agent' && only.agent !== undefined && l.agent !== only.agent) continue
    if (l.place === 'conversation' && only.here !== undefined && l.conversation !== only.here) continue
    const who = l.agentName ?? l.agent ?? 'this agent'
    const line =
      l.place === 'conversation' && only.here !== undefined
        ? p.to === 'off'
          ? 'still loaded here — the switch didn’t take'
          : 'didn’t load here — its own “on” didn’t take'
        : l.place === 'machine'
          ? p.to === 'off'
            ? 'still loaded — this machine’s switch didn’t take'
            : 'didn’t load — this machine’s “on” didn’t take'
          : l.place === 'conversation'
            ? p.to === 'off'
              ? 'still loaded in a conversation — its switch didn’t take'
              : 'didn’t load in a conversation — its own “on” didn’t take'
            : p.to === 'off'
              ? `still loaded for ${who} — the switch didn’t take`
              : `didn’t load for ${who} — its own “on” didn’t take`
    const where =
      l.place === 'machine'
        ? 'This machine’s settings hold'
        : l.place === 'agent'
          ? `What Silos keeps for ${who} holds`
          : 'What Silos keeps for this conversation holds'
    const long =
      p.to === 'off'
        ? `${where} its off switch, yet a conversation started after it still loaded ${p.name ?? r.name}. Check again to see whether it takes now.`
        : `${where} its “on”, yet a conversation started after it listed none of its servers. Check again to see whether it takes now.`
    out.push({
      key: `${l.place}:${l.agent ?? l.conversation ?? ''}`,
      line,
      how: howRead(p.read, now),
      listed: p.name ? `${p.name} — ${WORD[p.status ?? 'connected'].word}` : 'none of its servers listed',
      wayOut: 'check',
      long,
    })
  }
  return out
}

/** The Tools head's «Check now»: brought into view and focused, never
 *  clicked for him (it names the login and says its cost before the click). */
export function focusCheckNow(): void {
  const el = document.querySelector<HTMLElement>('[data-check-now]')
  if (!el) return
  el.scrollIntoView({ block: 'nearest' })
  el.focus()
}

// ---- the switch (POST …/loads/switch, the engine's one writer)

const COUNT_WORD = ['', 'one', 'both', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** What a click reaches beyond its own row, said BEFORE the click — null
 *  when it reaches only the row. A server several plugins ship is one
 *  address: «3 plugins ship it — turns off all three»; a deny by name
 *  takes a namesake with it. */
export function switchReach(r: LoadsRow, all: FolderLoads): string | null {
  const reached = (r.switch?.reaches ?? []).map((k) => all.rows.find((x) => x.key === k)).filter((x): x is LoadsRow => x !== undefined)
  if (reached.length === 0) return null
  const verb = loads(r) ? 'turns off' : 'turns on'
  if (r.parent && reached.every((x) => x.parent)) {
    const n = reached.length + 1
    return `${n} plugins ship it — ${verb} ${n === 2 ? 'both' : `all ${COUNT_WORD[n] ?? n}`}`
  }
  if (r.kind === 'connector') return `${verb} for every login in this project`
  const names = reached.map((x) => `${x.label} in ${x.origin.carrier}`).join(', ')
  return `it goes by name — also ${verb} ${names}`
}

// ---- the account origins' heads and rule 4 (spec tools-origin §7)

/** The account origin a row belongs to — plugins or connectors your Claude
 *  account sends — as its engine answered it; undefined for every other row
 *  (a plugin's servers come and go with their plugin). */
export function originOfRow(r: LoadsRow, all: FolderLoads): LoadsOrigin | undefined {
  if (r.origin.owner !== 'account' || r.parent) return undefined
  const id = r.kind === 'plugin' ? 'plugins' : r.kind === 'connector' ? 'connectors' : null
  return id ? all.origins?.find((o) => o.id === id && o.engine === r.engine) : undefined
}

/** «Add» on a row whose origin is off here: what the click does beyond the
 *  row, said before it — the others stay off; what the account sends later
 *  loads. null for any other click. */
export function addWords(r: LoadsRow, all: FolderLoads): string | null {
  if (!r.switch || r.state !== 'available' || originOfRow(r, all)?.on !== false) return null
  return `Adds only ${r.label} — the others stay off; what your Claude account sends later will load here`
}

/** Everything a row's click says before it happens (rule 4, a reach). */
export function switchSentence(r: LoadsRow, all: FolderLoads): string | null {
  const parts = [addWords(r, all), switchReach(r, all)].filter((x): x is string => x !== null)
  return parts.length ? parts.join('. ') : null
}

/** The word on a row's switch: what it does. */
export const switchVerb = (r: LoadsRow): string => (r.state === 'active' ? 'Turn off' : r.state === 'available' ? 'Add' : 'Turn on')

/** An origin's head as the shared head control takes it: on/off, whether
 *  it switches here, and what decides it instead. */
export function originHeadOf(o: LoadsOrigin): {
  on: boolean
  switches: boolean
  refused: { short: string; long: string; update?: true } | null
  offWhere?: string
} {
  const refused = o.decidedBy
    ? {
        short: o.decidedBy.file === 'managed settings' ? 'set by your organization' : `set in ${o.decidedBy.file}`,
        long: `decided by ${o.decidedBy.key} in ${o.decidedBy.file} — change it in that file; Silos only writes this project’s local settings`,
      }
    : o.refused?.why === 'engine'
      ? {
          short: `needs ${o.engine} ${o.refused.needs}`,
          long: `This switch was confirmed on ${o.engine} ${o.refused.needs} — this machine runs an older one.`,
          update: true as const,
        }
      : o.refused?.why === 'home'
        ? {
            short: `${o.engine}’s own folder`,
            long: `This folder is your home: its .claude holds ${o.engine}’s own settings for every project, so Silos switches nothing here.`,
          }
        : null
  // where it is off, from its own lines: the machine's head says so (never «this project»)
  const machine = o.at?.find((l) => l.place === 'machine')
  return { on: o.on, switches: o.switch === true, refused, ...(machine?.result === 'off' ? { offWhere: 'Off on this machine' } : {}) }
}

/** What a head turns on or off, in its title. */
/** a door's item that names no row but the account's groups of a project's
 *  Tools as a whole (KnowsLibrary scrolls to the first, its head in reach) */
export const ACCOUNT_GROUP = 'group:account'
export const ORIGIN_WHAT: Record<LoadsOrigin['id'], string> = {
  plugins: 'the plugins your Claude account sends',
  skills: 'the skills your Claude account sends',
  connectors: 'the connectors of your Claude account',
}

// ---- an engine that adds nothing to its rows (Harness.loads with the
// inventory alone): said once, above them, in its own label's words

/** One line per engine of the folder that switches nothing or reads no
 *  health — why its rows have no button and no dot, and where they change.
 *  [] when every engine has both. */
export function engineLimitWords(all: FolderLoads): string[] {
  return all.engines.flatMap((e) => {
    if (e.switches && e.readsStatus) return []
    if (!e.switches && !e.readsStatus)
      return [`${e.label} doesn’t say which of these it loaded, or let Silos switch them here — change each in the file it names.`]
    if (!e.switches) return [`Silos can’t switch ${e.label}’s tools here — change each in the file it names.`]
    return [`${e.label} doesn’t say which of these it loaded — no health is read here.`]
  })
}

/** Whether the row's engine switches nothing from Silos (its rows name their file). */
export function engineSwitchesNothing(r: LoadsRow, all: FolderLoads): boolean {
  return all.engines.some((e) => e.label === r.engine && !e.switches)
}

/** Why a row has no switch, said where the button would be: a file that
 *  decides it, an engine too old for this switch (with its door), a home
 *  folder. Null when it has a switch or nothing to say. */
export function refusedWords(r: LoadsRow): { short: string; long: string; update?: true } | null {
  if (r.switch) return null
  if (r.refused?.why === 'engine') {
    return {
      short: `needs ${r.engine} ${r.refused.needs}`,
      long: `This switch was confirmed on ${r.engine} ${r.refused.needs} — this machine runs an older one, so it isn’t offered until it is updated.`,
      update: true,
    }
  }
  if (r.refused?.why === 'home') {
    return {
      short: 'your home folder',
      long: `This folder is your home: its .claude holds ${r.engine}’s own settings for every project, so Silos switches nothing here.`,
    }
  }
  // a file that is one of the row's places is its line in «Where it loads»,
  // never a dead «set in» beside the row
  const place = r.decidedBy ? r.at?.find((l) => l.place !== 'fact' && l.keptIn === r.decidedBy!.file && l.entry !== undefined) : undefined
  if (r.decidedBy && !r.replacedBy && r.decidedBy.key !== 'defaultEnabled' && !place) {
    return { short: r.decidedBy.file === 'managed settings' ? 'set by your organization' : `set in ${r.decidedBy.file}`, long: '' }
  }
  return null
}

// ---- a conversation's start alert (the column): names and doors, never the error text
const tools = (n: number): string => `${n} ${n === 1 ? 'tool' : 'tools'}`
// «14 tools need your sign-in», «webstats needs your sign-in»
export const signInWords = (ps: StartProblem[]): string => (ps.length === 1 ? `${ps[0]!.label} needs your sign-in` : `${tools(ps.length)} need your sign-in`)

/** The alert's folded line: «webstats didn't start», «3 tools didn't
 *  start», «1 tool didn't start · 14 need your sign-in» — amber only when
 *  something didn't start (or a start hook's output was cut). */
export function alertWords(failed: StartProblem[], signIns: StartProblem[], cut: StartedWithPart[]): { text: string; amber: boolean } | null {
  const alone = (failed.length > 0 ? 1 : 0) + (signIns.length > 0 ? 1 : 0) + (cut.length > 0 ? 1 : 0) === 1
  const words: string[] = []
  if (failed.length > 0) words.push(failed.length === 1 && alone ? `${failed[0]!.label} didn’t start` : `${tools(failed.length)} didn’t start`)
  if (signIns.length > 0) words.push(alone ? signInWords(signIns) : `${signIns.length} ${signIns.length === 1 ? 'needs' : 'need'} your sign-in`)
  if (cut.length > 0)
    words.push(cut.length === 1 && alone ? `${cut[0]!.label}: start output cut` : `${cut.length} start ${cut.length === 1 ? 'output' : 'outputs'} cut`)
  return words.length === 0 ? null : { text: words.join(' · '), amber: failed.length > 0 || cut.length > 0 }
}
