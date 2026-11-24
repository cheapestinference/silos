// folder-loads.ts — what a folder's conversations load at start, one row per
// thing, read through each engine's own inventory (Harness.loads). Neutral:
// it gathers what the engines read from — the newest transcripts of the
// folder (and of the machine: a login's batch is the login's, matched in
// any folder), the tool-name ids its conversations called, the agents' own
// servers — and names no engine. An engine without `loads` adds no rows.
//
// The engines asked are those of the agents given the folder (as their
// folder or an extra one); a folder no agent of a declaring engine has is
// asked of the fallback engine (a loose conversation runs on it).
import {
  LoadsSwitchError,
  type Harness,
  type LoadsInput,
  type LoadsInventory,
  type LoadsLine,
  type LoadsMachineHead,
  type LoadsNotice,
  type LoadsOrigin,
  type LoadsOriginId,
  type LoadsRow,
  type LoadsScope,
  type LoadsSkillAsk,
  type LoadsSkillPlaces,
  type LoadsSkills,
  type LoadsSkillsInput,
  type LoadsSkillTarget,
  type ResolvedNotice,
} from './harnesses/contract.js'
import { fallbackHarness, findHarness, harnessOf, registeredHarnesses } from './harnesses/registry.js'
import type { AgentRegistry } from './agent-registry.js'
import type { ResolvedProvider } from './providers-store.js'
import type { SessionIndex } from './session-index.js'
import type { AgentStateStore } from './agent-state.js'
import { ownMcpServerNames } from './role-plugin.js'
import { asLoadsReadings, type ToolHealthLedger } from './tool-health.js'
import { healthBasis, healthOfRows, problemsOf, type HealthBasis, type StartProblem } from './start-health.js'
import {
  changedAtOf,
  conversationEntryState,
  originRecordKey,
  proofNamesOf,
  withPlaceProof,
  withProof,
  type ThreadOf,
  type ThreadStart,
} from './switch-proof.js'
import type { LoadsScopesStore } from './loads-scopes.js'

export interface FolderLoadsDeps {
  index: Pick<SessionIndex, 'allSessions' | 'getContext' | 'hasTranscriptFile' | 'pathOf'>
  registry: Pick<AgentRegistry, 'list'>
  home: string
  managedDir?: string
  agentState?: Pick<AgentStateStore, 'pathFor'>
  /** the status readings Silos kept (tool-health.ts): the rows' health */
  toolHealth?: Pick<ToolHealthLedger, 'readings' | 'runs'> & Partial<Pick<ToolHealthLedger, 'connectorsOf' | 'switches' | 'noteSwitch'>>
  /** the logins the folder's agents run on (the server resolves them):
   *  with the logins its conversations recorded, whose lists of what their
   *  account sends the engines are handed (LoadsInput.loginLists) */
  folderLogins?: string[]
  /** an engine's installed version as last read (null: not read yet) */
  engineVersion?: (harnessId: string) => string | null
  /** every login's own config dir (the skills its account sends sit there) */
  configDirs?: () => string[]
  /** what Silos keeps for the launch places (loads-scopes.ts): each agent's
   *  payload, handed to its engine as it is; absent: none kept */
  loadsScopes?: Pick<LoadsScopesStore, 'payloadOf' | 'record'> & Partial<Pick<LoadsScopesStore, 'get' | 'recordMany' | 'undoAt' | 'setUndo'>>
  /** a conversation's thread from its session id (the server's resolver):
   *  what a conversation's entry is kept under; absent: the id itself */
  threadOf?: ThreadOf
  /** the conversations of the folder Silos keeps an entry for (their
   *  thread ids, resolved by the server), each with its agent — a page's
   *  «Also off in …» facts; absent: none said */
  threadsHere?: (folder: string) => { thread: string; agent: string | null; tip?: { folder: string; id: string; title: string } }[]
  /** Silos' held store of a folder's own skill copies (skill-states.ts):
   *  what is out, and the moves out and back — a folder copy's project
   *  place in a bulk click on skills; absent: those copies are not moved */
  skillStore?: { held(folder: string): string[]; hold(folder: string, name: string): void; activate(folder: string, name: string): void }
}

/** ONE conversation asked about — its column (spec scopes §4, §6): the
 *  thread the SERVER resolved from the session id the web holds
 *  (`threadIdOf`), its agent, and the thread's sessions in this folder
 *  (their starts prove its entries). */
export interface FolderConversation {
  thread: string
  agent: string | null
  sessions: string[]
}

export interface FolderLoads {
  folder: string
  /** the engines that answered (a row names its engine; the screen says it
   *  only when there are several), with what each adds to its rows: status
   *  readings (health), switches, a check — an engine without them is said
   *  so on Tools, in one line */
  engines: { id: string; label: string; readsStatus?: true; switches?: true; checks?: true; scopes?: LoadsScope[] }[]
  rows: LoadsRow[]
  /** each engine's account origins: on/off here and the head's switch */
  origins: (LoadsOrigin & { engine: string })[]
  logins: LoadsInventory['logins']
  notes: string[]
  /** what the rows' health rests on: status readings, start notices (Tools
   *  says so when only notices do) */
  basis: HealthBasis
  /** a page's «Also off in …» doors: each conversation a row's line names
   *  (`LoadsLine.conversation`), with the session it continues in */
  conversations?: { thread: string; folder: string; id: string; title: string }[]
}

const FOLDER_TRANSCRIPTS = 12
const MACHINE_TRANSCRIPTS = 8
const TOOL_SESSIONS = 60
const NOTICE_SESSIONS = 40

/** The transcripts of the folder's newest conversations, then of the
 *  machine's (a login's batch is the login's, matched in any folder). */
function recentTranscripts(deps: Pick<FolderLoadsDeps, 'index'>, folder: string) {
  const sessions = deps.index
    .allSessions()
    .slice()
    .sort((a, b) => b.mtime - a.mtime)
  const here = sessions.filter((m) => m.cwd === folder)
  const transcripts: string[] = []
  const take = (list: typeof sessions, cap: number): void => {
    let n = 0
    for (const m of list) {
      if (n >= cap) break
      if (!deps.index.hasTranscriptFile(m.id)) continue
      try {
        const p = deps.index.pathOf(m.folder, m.id)
        if (!transcripts.includes(p)) {
          transcripts.push(p)
          n++
        }
      } catch {
        /* no file */
      }
    }
  }
  take(here, FOLDER_TRANSCRIPTS)
  take(sessions, MACHINE_TRANSCRIPTS)
  return { sessions, here, transcripts }
}

/** What each engine that declares `loads` is asked for the folder. */
export interface FolderInputs {
  engines: Harness[]
  stored: ReturnType<ToolHealthLedger['readings']>
  runs: ReturnType<ToolHealthLedger['runs']>
  notices: LoadsNotice[]
  inputOf: (h: Harness) => LoadsInput
}
export function folderInputs(
  deps: FolderLoadsDeps,
  folder: string,
  ensure?: string | readonly string[],
  only?: string,
  conv?: FolderConversation,
): FolderInputs {
  const agents = deps.registry.list(true).filter((a) => a.folder === folder || (a.folders ?? []).includes(folder))
  const ids =
    only !== undefined
      ? [only]
      : [
          ...new Set(
            agents.flatMap((a) => {
              try {
                return [harnessOf(a)]
              } catch {
                return []
              }
            }),
          ),
        ]
  const engines = (ids.length > 0 ? ids.map((id) => findHarness(id)).filter((h) => h !== undefined) : [fallbackHarness()]).filter((h) => h.loads !== undefined)
  if (engines.length === 0)
    return {
      engines,
      stored: [],
      runs: [],
      notices: [],
      inputOf: () => {
        throw new Error('no engine')
      },
    }

  const { here, transcripts } = recentTranscripts(deps, folder)
  const seen = new Set<string>()
  for (const m of here.slice(0, TOOL_SESSIONS)) for (const t of deps.index.getContext(m.folder, m.id)?.tools ?? []) if (t.server) seen.add(t.server)
  const agentServers: { agent: string; servers: string[] }[] = []
  for (const a of agents) {
    try {
      if (deps.agentState) agentServers.push({ agent: a.id, servers: ownMcpServerNames(deps.agentState.pathFor(a.id)) })
    } catch {
      /* unsafe id */
    }
  }

  // the start notices of the folder's listed conversations (one in the
  // trash is not listed, so never counted), newest first
  // — and the one conversation asked about (its column's alert), past the cap
  const notices: LoadsNotice[] = []
  const noticeOf = (m: (typeof here)[number]): LoadsNotice | null => {
    const c = deps.index.getContext(m.folder, m.id)
    const n = c?.start
    if (!n) return null
    const at = n.at ? Date.parse(n.at) : NaN
    return {
      conversation: m.id,
      login: c.flags.accountEmail ?? null,
      at: Number.isFinite(at) ? at : m.mtime,
      mode: n.mode,
      failed: n.failed,
      needsAuth: n.needsAuth,
      ...(n.needsAuthIds ? { needsAuthIds: n.needsAuthIds } : {}),
    }
  }
  for (const m of here) {
    if (notices.length >= NOTICE_SESSIONS) break
    const n = noticeOf(m)
    if (n) notices.push(n)
  }
  for (const id of ensure === undefined ? [] : typeof ensure === 'string' ? [ensure] : ensure) {
    if (notices.some((n) => n.conversation === id)) continue
    const m = here.find((x) => x.id === id)
    const n = m ? noticeOf(m) : null
    if (n) notices.push(n)
  }
  notices.sort((a, b) => b.at - a.at)

  let stored: ReturnType<ToolHealthLedger['readings']> = []
  let runs: ReturnType<ToolHealthLedger['runs']> = []
  try {
    stored = deps.toolHealth?.readings(folder) ?? []
    runs = stored.length > 0 ? (deps.toolHealth?.runs(folder) ?? []) : []
  } catch {
    stored = []
    runs = []
  }
  // each login's list of what its account sends (the ledger's logins.json):
  // the folder's agents' logins and those its conversations recorded
  const logins = [
    ...new Set(
      [...(deps.folderLogins ?? []), ...stored.map((r) => r.login), ...notices.map((n) => n.login)].filter(
        (l): l is string => typeof l === 'string' && l !== '',
      ),
    ),
  ].sort()
  const loginLists: NonNullable<LoadsInput['loginLists']> = []
  for (const login of logins) {
    try {
      const l = deps.toolHealth?.connectorsOf?.(login)
      if (l) loginLists.push({ login, at: l.at, connectors: l.connectors })
    } catch {
      /* not read */
    }
  }
  const inputOf = (h: Harness): LoadsInput => {
    let engineVersion: string | null = null
    try {
      engineVersion = deps.engineVersion?.(h.id) ?? null
    } catch {
      engineVersion = null
    }
    return {
      folder,
      home: deps.home,
      ...(deps.managedDir ? { managedDir: deps.managedDir } : {}),
      recentTranscripts: transcripts,
      seenToolIds: [...seen].sort(),
      readings: h.loads!.readsStatus ? asLoadsReadings(stored) : [],
      agentServers,
      engineVersion,
      notices,
      ...(loginLists.length > 0 ? { loginLists } : {}),
      // the launch places: the folder's agents in play, each with the
      // payload Silos keeps for it on this engine (loads-scopes.ts)
      ...(h.loads!.scopes ? { carried: carriedOf(h) } : {}),
    }
  }
  // the launch places: the folder's agents in play, each with the payload
  // Silos keeps for it on this engine (loads-scopes.ts); then ONE
  // conversation asked about (its column: its line and switch) — or, on a
  // page, the folder's conversations that keep an entry (facts, no switch).
  // A conversation's column never carries another conversation's entries.
  const carriedOf = (h: Harness): NonNullable<LoadsInput['carried']> => {
    const payloadOf = (place: 'agents' | 'conversations' | 'folders', id: string): unknown => deps.loadsScopes?.payloadOf(place, id, h.id) ?? null
    const out: NonNullable<LoadsInput['carried']> = {
      // an engine whose project place is carried at launch: the folder's own
      ...(launchPlace(h, 'project') ? { folder: { payload: payloadOf('folders', folder) } } : {}),
      agents: agents.filter((a) => !a.archived).map((a) => ({ id: a.id, payload: payloadOf('agents', a.id) })),
    }
    if (conv) {
      out.conversation = { id: conv.thread, payload: payloadOf('conversations', conv.thread), ...(conv.agent ? { agent: conv.agent } : {}) }
      return out
    }
    let threads: { thread: string; agent: string | null }[] = []
    try {
      threads = deps.threadsHere?.(folder) ?? []
    } catch {
      threads = []
    }
    const others = threads
      .map((t) => ({ id: t.thread, payload: payloadOf('conversations', t.thread), ...(t.agent ? { agent: t.agent } : {}) }))
      .filter((t) => t.payload !== null)
    if (others.length > 0) out.conversations = others
    return out
  }
  return { engines, stored, runs, notices, inputOf }
}

/** An agent's page reads its rows: the machine, the project and THAT
 *  agent's line — another agent's line (its entries) is never returned to
 *  it. The project line still says whom it reaches: the NAMES of every
 *  agent of the project (`agents`), never their entries. */
export function asAgentLines(at: readonly LoadsLine[], as: string): LoadsLine[] {
  const reach = at.filter((l) => l.place === 'agent').map((l) => l.agentName ?? 'an agent')
  return at.filter((l) => l.place !== 'agent' || l.agent === as).map((l) => (l.place === 'project' && reach.length > 0 ? { ...l, agents: reach } : l))
}

/** `as`: an agent's page asks — the rows answer the machine, the project
 *  and THAT agent's line; another agent's lines (its entries) are never
 *  returned to it (spec scopes §4: «on an agent's page the block shows
 *  machine, project and THAT agent»). `conv`: ONE conversation's column
 *  asks — its own line, its switch and where its entries stand; no other
 *  conversation's entries. */
export function folderLoads(deps: FolderLoadsDeps, folder: string, opts: { as?: string; conv?: FolderConversation } = {}): FolderLoads {
  const conv = opts.conv
  const out: FolderLoads = { folder, engines: [], rows: [], origins: [], logins: [], notes: [], basis: { readings: 0, notices: 0, consoles: 0 } }
  const { engines, stored, runs, notices, inputOf } = folderInputs(deps, folder, conv?.sessions, undefined, conv)
  const names = new Map(deps.registry.list(true).map((a) => [a.id, a.name]))
  for (const h of engines) {
    const inv = h.loads!.inventory(inputOf(h))
    // what an engine does not add, its rows never claim: no switch (nor a
    // refused one) from an engine that switches nothing
    if (!h.loads!.switch)
      inv.rows = inv.rows.map((r) => {
        const { switch: _s, refused: _r, ...rest } = r
        void _s
        void _r
        return rest
      })
    // nor a place from an engine that declares none: its rows keep today's single switch
    if (!h.loads!.scopes)
      inv.rows = inv.rows.map((r) => {
        const { at: _a, family: _f, ...rest } = r
        void _a
        void _f
        return rest
      })
    else
      inv.rows = inv.rows.map((r) => (r.at ? { ...r, at: r.at.map((l) => (l.agent && names.has(l.agent) ? { ...l, agentName: names.get(l.agent)! } : l)) } : r))
    // health is computed on every line (a holder's readings are skipped,
    // tool-health.ts heldBy); only then is the page's view narrowed
    // what each place expects (LoadsRow.expect) is the proof's input, read
    // here and never sent: it names every agent that holds the row
    const narrow = (rows: LoadsRow[]): LoadsRow[] =>
      rows.map((row) => {
        const { expect: _e, ...r } = row
        void _e
        return opts.as === undefined || !r.at ? r : { ...r, at: asAgentLines(r.at, opts.as) }
      })
    for (const raw of inv.origins ?? []) {
      // a head's places: only from an engine that declares them, its agents named
      const o = !h.loads!.scopes
        ? (({ at: _a, ...rest }) => {
            void _a
            return rest
          })(raw)
        : raw.at
          ? {
              ...raw,
              at: ((at: LoadsLine[]) => (opts.as === undefined ? at : asAgentLines(at, opts.as)))(
                raw.at.map((l) => (l.agent && names.has(l.agent) ? { ...l, agentName: names.get(l.agent)! } : l)),
              ),
            }
          : raw
      if (h.loads!.switchOrigin) out.origins.push({ ...o, engine: h.label })
      else {
        const { switch: _s, refused: _r, ...rest } = o
        void _s
        void _r
        out.origins.push({ ...rest, engine: h.label })
      }
    }
    out.engines.push({
      id: h.id,
      label: h.label,
      ...(h.loads!.readsStatus ? { readsStatus: true as const } : {}),
      ...(h.loads!.switch ? { switches: true as const } : {}),
      ...(h.loads!.check ? { checks: true as const } : {}),
      ...(h.loads!.scopes ? { scopes: h.loads!.scopes.map((sc) => ({ ...sc })) } : {}),
    })
    const named = <T extends { agent?: string; agentName?: string }>(read: T): T =>
      read.agent && names.has(read.agent) ? { ...read, agentName: names.get(read.agent)! } : read
    const rows = narrow(
      h.loads!.readsStatus
        ? proofOf(deps, h, folder, healthOfRows(inv.rows, stored, runs, inv.notices ?? [], deps.threadOf), stored, inv.notices ?? []).map((r) => ({
            ...r,
            ...(r.health ? { health: { ...r.health, read: named(r.health.read) } } : {}),
            ...(r.proof ? { proof: { ...r.proof, read: named(r.proof.read) } } : {}),
            ...(r.at?.some((l) => l.proof) ? { at: r.at.map((l) => (l.proof ? { ...l, proof: { ...l.proof, read: named(l.proof.read) } } : l)) } : {}),
          }))
        : inv.rows,
    )
    out.rows.push(...(conv && h.loads!.scopes ? withConversationState(deps, h, conv, rows, stored, inv.notices ?? []) : rows))
    out.logins.push(...inv.logins)
    out.notes.push(...inv.notes)
  }
  out.basis = healthBasis(stored, notices)
  if (!conv) {
    const named = new Set(out.rows.flatMap((r) => (r.at ?? []).flatMap((l) => (l.place === 'conversation' && l.conversation ? [l.conversation] : []))))
    if (named.size > 0) {
      let threads: ReturnType<NonNullable<FolderLoadsDeps['threadsHere']>> = []
      try {
        threads = deps.threadsHere?.(folder) ?? []
      } catch {
        threads = []
      }
      const doors = threads.filter((t) => named.has(t.thread) && t.tip).map((t) => ({ thread: t.thread, ...t.tip! }))
      if (doors.length > 0) out.conversations = doors
    }
  }
  return out
}

/** Each row's line for ONE conversation, where it has an entry of its own,
 *  gets where that entry stands (switch-proof.ts conversationEntryState):
 *  only its own thread's starts count — a turn's status reading (whole),
 *  a start notice (what went wrong only) — after that row's own time. */
function withConversationState(
  deps: FolderLoadsDeps,
  h: Harness,
  conv: FolderConversation,
  rows: LoadsRow[],
  stored: ReturnType<ToolHealthLedger['readings']>,
  notices: readonly ResolvedNotice[],
): LoadsRow[] {
  const rec = deps.loadsScopes?.get?.('conversations', conv.thread, h.id) ?? null
  if (!rec) return rows
  const mine = new Set(conv.sessions)
  const starts: ThreadStart[] = [
    ...stored
      .filter((r) => r.conversation !== undefined && mine.has(r.conversation))
      .map((r) => ({ from: r.started ?? r.at, names: r.servers.filter((s) => s.status !== 'disabled').map((s) => s.name), whole: true })),
    ...notices.filter((n) => mine.has(n.conversation)).map((n) => ({ from: n.at, names: n.servers.map((s) => s.name), whole: false })),
  ]
  return rows.map((r) => {
    const since = Object.prototype.hasOwnProperty.call(rec.at, r.key) ? rec.at[r.key]! : null
    if (!r.at || since === null) return r
    const names = proofNamesOf(r, rows)
    return {
      ...r,
      at: r.at.map((l) =>
        l.place === 'conversation' && l.conversation === conv.thread && l.entry ? { ...l, here: conversationEntryState(l.entry, since, names, starts) } : l,
      ),
    }
  })
}

/** What a NEW project of engine `harnessId` would be sent at `folder` —
 *  a folder no agent of it has yet (the first run's «At start»): that
 *  engine's inventory rows and its skills reading, as Tools would list
 *  them before any switch. null: the engine reads nothing. */
export function wouldLoad(deps: FolderLoadsDeps, folder: string, harnessId: string): { rows: LoadsRow[]; skills: LoadsSkills | null } | null {
  const { engines, inputOf } = folderInputs(deps, folder, undefined, harnessId)
  const h = engines[0]
  if (!h) return null
  let skills: LoadsSkills | null = null
  try {
    skills = h.loads!.skills?.(skillsInput(deps, folder)) ?? null
  } catch {
    skills = null
  }
  return { rows: h.loads!.inventory(inputOf(h)).rows, skills }
}

/** The rows a reading after their switch still lists, marked (switch-proof.ts):
 *  the project's — for an engine that says when its switch file changed —
 *  and each other place's on its line (the machine's file, each agent's and
 *  conversation's entry, by its own time). */
function proofOf(
  deps: FolderLoadsDeps,
  h: Harness,
  folder: string,
  rows: LoadsRow[],
  stored: ReturnType<ToolHealthLedger['readings']>,
  notices: NonNullable<LoadsInventory['notices']>,
): LoadsRow[] {
  const threadOf = deps.threadOf
  let out = rows
  if (h.loads!.switchesChangedAt && rows.some((r) => r.heldHere)) {
    try {
      const changed = h.loads!.switchesChangedAt(folder)
      const records = deps.toolHealth?.switches?.(folder) ?? []
      out = withProof(out, stored, notices, changed, records, threadOf)
    } catch {
      /* not read: no proof */
    }
  }
  if (!out.some((r) => r.expect && r.expect.length > 0)) return out
  let machineAt: number | null = null
  let machineRecords: ReturnType<ToolHealthLedger['switches']> = []
  try {
    machineAt = h.loads!.machineChangedAt?.(deps.home) ?? null
    machineRecords = machineAt !== null ? (deps.toolHealth?.switches?.(folder, 'machine') ?? []) : []
  } catch {
    machineAt = null
  }
  const entryAt = (place: 'agents' | 'conversations', id: string, key: string): number | null => {
    const at = deps.loadsScopes?.get?.(place, id, h.id)?.at
    return at && Object.prototype.hasOwnProperty.call(at, key) ? at[key]! : null
  }
  return withPlaceProof(
    out,
    stored,
    notices,
    {
      machine: (row, to) => changedAtOf(row, machineAt, machineRecords, to),
      agent: (agent, key) => entryAt('agents', agent, key),
      conversation: (thread, key) => entryAt('conversations', thread, key),
    },
    threadOf,
  )
}

/** Whether the engine declares `place` as one Silos carries at launch. */
export function launchPlace(h: Harness, place: string): boolean {
  return (h.loads!.scopes ?? []).some((sc) => sc.id === place && sc.carrier === 'launch')
}

/** Turns one row on or off for new conversations in the folder, through the
 *  engine whose inventory holds it (its `loads.switch`, the engine's one
 *  writer). 404 no such row; 409 an engine that switches nothing, or the
 *  engine's own refusal (LoadsSwitchError, saying what decides). */
export function switchFolderLoad(
  deps: FolderLoadsDeps,
  folder: string,
  key: string,
  to: 'on' | 'off',
  at?: { scope: 'project' | 'machine' } | { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: FolderConversation },
): void {
  const { engines, inputOf } = folderInputs(deps, folder, undefined, undefined, at?.scope === 'conversation' ? at.conversation : undefined)
  for (const h of engines) {
    const input = inputOf(h)
    const row = h.loads!.inventory(input).rows.find((r) => r.key === key)
    if (!row) continue
    if (!h.loads!.switch) throw new LoadsSwitchError(`${h.label} switches nothing from Silos — "${row.label}" is changed in its own file`, 409)
    // the project's place of an engine that carries it at launch (spec
    // scopes §9: OpenCode) is a launch place like an agent's — today's
    // plain click (no scope) lands there
    const projectLaunch = (at === undefined || at.scope === 'project') && launchPlace(h, 'project')
    if (at?.scope === 'agent' || at?.scope === 'conversation' || projectLaunch) {
      // a launch place: the engine is handed the payload Silos keeps and
      // returns the new one, writing nothing; Silos keeps it, with the
      // row's own time (loads-scopes.ts)
      if (!deps.loadsScopes) throw new LoadsSwitchError(`nothing keeps what one ${at?.scope === 'conversation' ? 'conversation' : 'agent'} loads here`, 409)
      if (at?.scope === 'agent') {
        if (!launchPlace(h, 'agent')) throw new LoadsSwitchError(`${h.label} has no place for one agent — "${row.label}" switches for this project only`, 409)
        const mine = input.carried?.agents.find((a) => a.id === at.agent)
        if (!mine) throw new LoadsSwitchError(`"${at.agent}" is not an agent of this project`, 404)
        const answer = h.loads!.switch(input, key, to, { scope: 'agent', agent: at.agent, payload: mine.payload })
        if (answer) deps.loadsScopes.record('agents', at.agent, h.id, key, answer)
      } else if (at?.scope === 'conversation') {
        if (!launchPlace(h, 'conversation'))
          throw new LoadsSwitchError(`${h.label} has no place for one conversation — "${row.label}" switches for this project only`, 409)
        const c = input.carried?.conversation
        if (!c) throw new LoadsSwitchError('no conversation here to switch for', 404)
        const answer = h.loads!.switch(input, key, to, { scope: 'conversation', ...(c.agent !== undefined ? { agent: c.agent } : {}), payload: c.payload })
        if (answer) deps.loadsScopes.record('conversations', c.id, h.id, key, answer)
      } else {
        const answer = h.loads!.switch(input, key, to, { scope: 'project', payload: input.carried?.folder?.payload ?? null })
        if (answer) deps.loadsScopes.record('folders', folder, h.id, key, answer)
      }
      return
    }
    // a file place the engine does not declare is never written
    if (at && at.scope !== 'project' && !(h.loads!.scopes ?? []).some((s) => s.id === at.scope && s.carrier === 'file')) {
      throw new LoadsSwitchError(`${h.label} has no place "${at.scope}" — "${row.label}" switches in this project only`, 409)
    }
    // the switched file's mtime: the machine's own, or the folder's
    const machine = at?.scope === 'machine'
    const changedAt = (): number | null => (machine ? h.loads!.machineChangedAt?.(deps.home) : h.loads!.switchesChangedAt?.(folder)) ?? null
    let before: number | null = null
    try {
      before = changedAt()
    } catch {
      before = null
    }
    if (at) h.loads!.switch(input, key, to, at)
    else h.loads!.switch(input, key, to)
    // the row's own switch time, kept with the file's mtime after the write,
    // keyed by place (a click that wrote nothing leaves the file as it was:
    // nothing kept)
    try {
      const after = changedAt()
      if (after !== null && after !== before) deps.toolHealth?.noteSwitch?.(folder, key, to, after, undefined, machine ? 'machine' : 'project')
    } catch (err) {
      console.warn('tool-health: a switch was not recorded:', err instanceof Error ? err.message : String(err))
    }
    return
  }
  throw new LoadsSwitchError(`unknown row "${key}" — not among what this folder loads`, 404)
}

/** How many projects Silos manages load the row `key` now — what the
 *  machine line's «off» says before it is clicked («<n> projects load it
 *  now»). Every managed folder whose engines include the one that lists
 *  the row in `folder`; a folder that cannot be read is not counted. */
export function machineReach(deps: FolderLoadsDeps, folder: string, key: string): { projects: number } {
  const { engines, inputOf } = folderInputs(deps, folder)
  const h = engines.find((e) => e.loads!.inventory(inputOf(e)).rows.some((r) => r.key === key))
  if (!h) throw new LoadsSwitchError(`unknown row "${key}" — not among what this folder loads`, 404)
  const folders = new Set<string>()
  for (const a of deps.registry.list()) for (const f of [a.folder, ...(a.folders ?? [])]) if (typeof f === 'string' && f !== '') folders.add(f)
  let projects = 0
  for (const f of folders) {
    try {
      const there = folderInputs(deps, f)
      const e = there.engines.find((x) => x.id === h.id)
      if (e && e.loads!.inventory(there.inputOf(e)).rows.some((r) => r.key === key && r.state === 'active')) projects++
    } catch {
      /* not read: not counted */
    }
  }
  return { projects }
}

/** An account origin's head (all of what it sends) on or off for new
 *  conversations in the folder, through every engine of the folder that
 *  has that origin (its `loads.switchOrigin`). 404 no engine has it; 409 an
 *  engine that switches no origin, or the engine's own refusal. */
export function switchFolderOrigin(
  deps: FolderLoadsDeps,
  folder: string,
  origin: LoadsOriginId,
  to: 'on' | 'off',
  at?: { scope: 'project' } | { scope: 'machine'; confirmed: boolean } | { scope: 'agent'; agent: string },
): void {
  const { engines, inputOf } = folderInputs(deps, folder)
  let found = false
  for (const h of engines) {
    const input = inputOf(h)
    if (!(h.loads!.inventory(input).origins ?? []).some((o) => o.id === origin)) continue
    if (!h.loads!.switchOrigin) throw new LoadsSwitchError(`${h.label} switches nothing from Silos — change it in its own file`, 409)
    if (at && at.scope !== 'project') {
      const sc = h.loads!.scopes?.find((x) => x.id === at.scope)
      if (!sc || (at.scope === 'agent' ? sc.carrier !== 'launch' : sc.carrier !== 'file'))
        throw new LoadsSwitchError(`${h.label} has no place "${at.scope}" for what an account sends`, 409)
      if (at.scope === 'machine') {
        h.loads!.switchOrigin(input, origin, to, { scope: 'machine', ...(at.confirmed ? { confirmed: true as const } : {}) })
        found = true
        continue
      }
      // a launch place: the engine answers the new payload, Silos keeps it
      // with the head's own time (loads-scopes.ts)
      if (!deps.loadsScopes) throw new LoadsSwitchError('nothing keeps what one agent loads here', 409)
      const mine = input.carried?.agents.find((a) => a.id === at.agent)
      if (!mine) throw new LoadsSwitchError(`"${at.agent}" is not an agent of this project`, 404)
      const answer = h.loads!.switchOrigin(input, origin, to, { scope: 'agent', agent: at.agent, payload: mine.payload })
      if (answer) deps.loadsScopes.record('agents', at.agent, h.id, originRecordKey(origin), answer)
      found = true
      continue
    }
    let before: number | null = null
    try {
      before = h.loads!.switchesChangedAt?.(folder) ?? null
    } catch {
      before = null
    }
    h.loads!.switchOrigin(input, origin, to)
    found = true
    // the head's own switch time, as a row's (switch-proof.ts reads it for
    // the rows that origin holds): `origin:<id>`
    try {
      const after = h.loads!.switchesChangedAt?.(folder) ?? null
      if (after !== null && after !== before) deps.toolHealth?.noteSwitch?.(folder, originRecordKey(origin), to, after)
    } catch (err) {
      console.warn('tool-health: a switch was not recorded:', err instanceof Error ? err.message : String(err))
    }
  }
  if (!found) throw new LoadsSwitchError(`no engine here has the origin "${origin}"`, 404)
}

/** What went wrong at ONE conversation's start, each on the row of the
 *  folder's inventory it lands on (start-health.ts problemsOf) — its column's
 *  alert. Its own reading: the status reading its turn took (a chat), else
 *  its start notice (a console), names resolved by the same inventory that
 *  builds the rows. `managed` false: a folder that is no project — names,
 *  no row. */
export function conversationProblems(deps: FolderLoadsDeps, conv: { folder: string; id: string; cwd: string | null }, managed: boolean): StartProblem[] {
  const c = deps.index.getContext(conv.folder, conv.id)
  const login = c?.flags.accountEmail ?? null
  let reading: ReturnType<ToolHealthLedger['readings']>[number] | undefined
  try {
    reading = conv.cwd ? deps.toolHealth?.readings(conv.cwd).find((r) => r.conversation === conv.id) : undefined
  } catch {
    reading = undefined
  }
  const raw = (): { name: string; status: string }[] => [
    ...(c?.start?.failed ?? []).map((f) => ({ name: f.name, status: 'failed' })),
    ...[...(c?.start?.needsAuth ?? []), ...(c?.start?.needsAuthIds ?? [])].map((name) => ({ name, status: 'needs-auth' })),
  ]
  if (!managed || !conv.cwd) return problemsOf(null, reading?.servers ?? raw(), login)
  const { engines, stored, runs, inputOf } = folderInputs(deps, conv.cwd, conv.id)
  const rows: LoadsRow[] = []
  let servers: { name: string; status: string; noAddress?: true }[] | null = reading?.servers ?? null
  for (const h of engines) {
    const inv = h.loads!.inventory(inputOf(h))
    rows.push(...(h.loads!.readsStatus ? healthOfRows(inv.rows, stored, runs, inv.notices ?? [], deps.threadOf) : inv.rows))
    servers ??= inv.notices?.find((n) => n.conversation === conv.id)?.servers ?? null
  }
  return problemsOf(rows, servers ?? [], login)
}

/** What a plugin this project does not load would add to every start, in
 *  its engine's own estimate (Harness.loads.projected) — or null: the row is
 *  no plugin, this project loads it (its weight is measured, never
 *  estimated), the engine has no estimate or can't say. Unknown row: 404.
 *  `providerOf`: the login a row's things load on (an account row's login;
 *  null = the machine's own) as the provider whose env runs the engine. */
export async function projectFolderLoad(
  deps: FolderLoadsDeps,
  folder: string,
  key: string,
  providerOf: (login: string | null) => Promise<ResolvedProvider | null>,
): Promise<{ key: string; tokens: number | null; by?: string }> {
  const { engines, inputOf } = folderInputs(deps, folder)
  for (const h of engines) {
    const input = inputOf(h)
    const row = h.loads!.inventory(input).rows.find((r) => r.key === key)
    if (!row) continue
    if (row.kind !== 'plugin' || row.state === 'active' || !h.loads!.projected) return { key, tokens: null }
    let provider: ResolvedProvider | null = null
    try {
      provider = await providerOf(row.origin.owner === 'account' ? (row.origin.login ?? null) : null)
    } catch {
      provider = null
    }
    const tokens = await h.loads!.projected({ folder, home: deps.home, row, provider, engineVersion: input.engineVersion ?? null })
    return { key, tokens, ...(tokens !== null && h.loads!.projectedBy ? { by: h.loads!.projectedBy } : {}) }
  }
  throw new LoadsSwitchError(`unknown row "${key}" — not among what this folder loads`, 404)
}

/** What an engine's skills reader (Harness.loads.skills) is handed for a
 *  folder — with `harnessId`, the launch places too: the folder's agents in
 *  play, each with the payload Silos keeps for it on that engine. */
export function skillsInput(deps: FolderLoadsDeps, folder: string, harnessId?: string, conv?: FolderConversation): LoadsSkillsInput {
  let configDirs: string[] = []
  try {
    configDirs = deps.configDirs?.() ?? []
  } catch {
    configDirs = []
  }
  const carried =
    harnessId === undefined
      ? undefined
      : {
          agents: deps.registry
            .list(true)
            .filter(
              (a) =>
                !a.archived &&
                (a.folder === folder || (a.folders ?? []).includes(folder)) &&
                (() => {
                  try {
                    return harnessOf(a) === harnessId
                  } catch {
                    return false
                  }
                })(),
            )
            .map((a) => ({ id: a.id, payload: deps.loadsScopes?.payloadOf('agents', a.id, harnessId) ?? null })),
          // ONE conversation asked about (its column): its line, after its agent's
          ...(conv
            ? {
                conversation: {
                  id: conv.thread,
                  payload: deps.loadsScopes?.payloadOf('conversations', conv.thread, harnessId) ?? null,
                  ...(conv.agent ? { agent: conv.agent } : {}),
                },
              }
            : {}),
        }
  return {
    folder,
    home: deps.home,
    ...(deps.managedDir ? { managedDir: deps.managedDir } : {}),
    configDirs,
    recentTranscripts: () => recentTranscripts(deps, folder).transcripts,
    ...(carried ? { carried } : {}),
  }
}

/** The skills engine `harnessId` reads for the folder — what its Claude
 *  account sends per login, each skill's position, the origin — or null
 *  for an engine without a skills reader (it is never another engine's). */
export function folderSkills(deps: FolderLoadsDeps, folder: string, harnessId: string): LoadsSkills | null {
  const h = findHarness(harnessId)
  if (!h?.loads?.skills) return null
  return h.loads.skills(skillsInput(deps, folder))
}

/** «Where it loads» of each skill asked (spec scopes T9), through engine
 *  `harnessId` — its lines, an agent's named — or null for an engine that
 *  declares no places for skills. */
export function folderSkillPlaces(
  deps: FolderLoadsDeps,
  folder: string,
  harnessId: string,
  asks: readonly LoadsSkillAsk[],
  conv?: FolderConversation,
): LoadsSkillPlaces[] | null {
  const h = findHarness(harnessId)
  if (!h?.loads?.skillPlaces || asks.length === 0) return null
  const names = new Map(deps.registry.list(true).map((a) => [a.id, a.name]))
  return h.loads.skillPlaces(skillsInput(deps, folder, harnessId, conv), asks).map((p) => ({
    ...p,
    lines: p.lines.map((l) => (l.agent && names.has(l.agent) ? { ...l, agentName: names.get(l.agent)! } : l)),
  }))
}

/** A skill's row key in what Silos keeps for a launch place (its own time). */
export const skillRecordKey = (name: string): string => `skill:${name}`

/** One skill's position, or the account origin, for new conversations in
 *  the folder — through the engine that reads the folder's skills (the
 *  fallback's when it starts there or nobody does, as the catalog). `at`:
 *  the project (default), the machine's file, or one agent's launches —
 *  the engine returns that agent's new payload and Silos keeps it here,
 *  with the skill's own time. 409 an engine that switches no skill, or its
 *  own refusal; 404 an agent that is not the folder's. */
export function switchFolderSkill(
  deps: FolderLoadsDeps,
  folder: string,
  harnessId: string,
  target: LoadsSkillTarget,
  to: string,
  at?: { scope: 'project' | 'machine' } | { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: FolderConversation },
): void {
  const h = findHarness(harnessId)
  if (!h?.loads?.skillSwitch) throw new LoadsSwitchError(`${h?.label ?? harnessId} switches no skill from Silos`, 409)
  if (at && at.scope !== 'project' && !h.loads.skillPlaces)
    throw new LoadsSwitchError(`${h.label} has no place ${at.scope} for a skill — it switches in this project only`, 409)
  if (at?.scope === 'conversation') {
    // ONE conversation's launches, kept under its thread (loads-scopes.ts)
    if (target.kind !== 'skill') throw new LoadsSwitchError('the skills your Claude account sends switch as a whole in this project only, for now', 409)
    if (!deps.loadsScopes) throw new LoadsSwitchError('nothing keeps what one conversation loads here', 409)
    const input = skillsInput(deps, folder, harnessId, at.conversation)
    const c = input.carried!.conversation!
    const answer = h.loads.skillSwitch(input, target, to, { scope: 'conversation', ...(c.agent !== undefined ? { agent: c.agent } : {}), payload: c.payload })
    if (answer) deps.loadsScopes.record('conversations', c.id, h.id, skillRecordKey(target.name), answer)
    return
  }
  if (at?.scope === 'agent') {
    if (target.kind !== 'skill') throw new LoadsSwitchError('the skills your Claude account sends switch as a whole in this project only, for now', 409)
    if (!deps.loadsScopes) throw new LoadsSwitchError('nothing keeps what one agent loads here', 409)
    const input = skillsInput(deps, folder, harnessId)
    const mine = input.carried?.agents.find((a) => a.id === at.agent)
    if (!mine) throw new LoadsSwitchError(`${at.agent} is not an agent of this project`, 404)
    const answer = h.loads.skillSwitch(input, target, to, { scope: 'agent', agent: at.agent, payload: mine.payload })
    if (answer) deps.loadsScopes.record('agents', at.agent, h.id, skillRecordKey(target.name), answer)
    return
  }
  const input = skillsInput(deps, folder, harnessId)
  if (at?.scope === 'machine') h.loads.skillSwitch(input, target, to, { scope: 'machine' })
  else h.loads.skillSwitch(input, target, to)
}

/** Each engine's heads for this whole machine (Harness.loads.machineHeads),
 *  outside any folder — Settings' «New projects» lines. */
export function machineHeadsOf(
  deps: Pick<FolderLoadsDeps, 'home' | 'managedDir' | 'engineVersion'>,
): { engine: string; label: string; heads: LoadsMachineHead[] }[] {
  const out: { engine: string; label: string; heads: LoadsMachineHead[] }[] = []
  for (const h of registeredHarnesses()) {
    if (!h.loads?.machineHeads) continue
    let engineVersion: string | null = null
    try {
      engineVersion = deps.engineVersion?.(h.id) ?? null
    } catch {
      engineVersion = null
    }
    try {
      out.push({
        engine: h.id,
        label: h.label,
        heads: h.loads.machineHeads({ home: deps.home, ...(deps.managedDir ? { managedDir: deps.managedDir } : {}), engineVersion }),
      })
    } catch (err) {
      console.warn(`loads: ${h.label}'s machine heads were not read:`, err instanceof Error ? err.message : String(err))
    }
  }
  return out
}

/** One engine's head for this whole machine on or off (its
 *  switchMachineHead). 404 an engine without one; its refusals as they are. */
export function switchMachineHeadOf(
  deps: Pick<FolderLoadsDeps, 'home' | 'managedDir' | 'engineVersion'>,
  harnessId: string,
  origin: LoadsOriginId,
  to: 'on' | 'off',
  confirmed: boolean,
): void {
  const h = findHarness(harnessId)
  if (!h?.loads?.switchMachineHead) throw new LoadsSwitchError(`no engine "${harnessId}" with a machine head`, 404)
  let engineVersion: string | null = null
  try {
    engineVersion = deps.engineVersion?.(h.id) ?? null
  } catch {
    engineVersion = null
  }
  h.loads.switchMachineHead({ home: deps.home, ...(deps.managedDir ? { managedDir: deps.managedDir } : {}), engineVersion }, origin, to, confirmed)
}
