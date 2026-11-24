// harnesses/opencode/loads — OpenCode's Harness.loads (spec 2026-11-23 §10,
// spec scopes §9): the MCP servers of the operator's
// ~/.config/opencode/opencode.json(c) and of the folder's own — the files
// loadedAtStart reads — one row each, owned by «Your machine» or the
// project, and «Where it loads» on every row. The agent's own servers
// (`<agentId>_<name>`, assemble.ts) are Agent › Tools' rows, never here.
//
// Its places, broadest first (`OPENCODE_SCOPES`): this machine — a FILE, the
// global config, written only while it is strict JSON (global-config.ts);
// this project, each agent, one conversation — the LAUNCH: Silos keeps
// them (loads-scopes.ts) and carries them in the config content it
// generates for every launch (launch-entries.ts). The folder's own
// opencode.json(c) is the repository's (usually checked in, often with
// comments): a FACT between the machine and the project, never written —
// and a fenced launch does not read it at all.
//
// Every layer is an override (measured, 1.19.6: each later layer wins per
// key, both ways): global file ‹ the folder's file ‹ the launch content
// (project ‹ agent ‹ conversation, Silos' own merge). Above every line sit
// facts no place can change: a managed config (`/etc/opencode`), a remote
// organization config (which Silos can't read — said once, in the notes)
// and the OPENCODE_PERMISSION environment.
//
// No Claude account origin, no status reading, no start notice, no check,
// no proof. Read-only; the switch writes only the global file (the
// machine's line) — a launch place's switch returns the new payload.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LoadsSwitchError,
  type LoadsCarried,
  type LoadsCarriedSwitch,
  type LoadsInput,
  type LoadsInventory,
  type LoadsLine,
  type LoadsRow,
  type LoadsScope,
  type LoadsSwitchAt,
} from '../contract.js'
import { stripJsonComments } from './console-theme.js'
import { cleanOpencodeEntries, mcpEntryOf, setMcpEntry } from './launch-entries.js'
import { globalConfigFile, globalConfigRefusal, switchGlobalMcp } from './global-config.js'

const ENGINE = 'OpenCode'
const FILES = ['opencode.json', 'opencode.jsonc'] as const

/** OpenCode's places, broadest first (HarnessLoads.scopes). */
export const OPENCODE_SCOPES: readonly LoadsScope[] = [
  { id: 'machine', carrier: 'file', keptIn: '~/.config/opencode/opencode.json' },
  { id: 'project', carrier: 'launch' },
  { id: 'agent', carrier: 'launch' },
  { id: 'conversation', carrier: 'launch' },
]

/** Where OpenCode reads its managed config, as the engine itself resolves
 *  it (1.19.6: OPENCODE_TEST_MANAGED_CONFIG_DIR, else the OS's own dir). */
export function managedConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_TEST_MANAGED_CONFIG_DIR) return env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  return process.platform === 'darwin' ? '/Library/Application Support/opencode' : '/etc/opencode'
}

/** One `mcp` entry of an opencode.json(c): its name, whether it says
 *  `enabled` (and which way), and what it runs or dials — display only. */
export interface OpencodeMcpEntry {
  name: string
  enabled?: boolean
  detail?: string
}

/** The `mcp` entries of an opencode.json(c) text, by name; [] when it doesn't parse. */
export function opencodeMcpEntries(text: string): OpencodeMcpEntry[] {
  let cfg: unknown
  try {
    cfg = JSON.parse(stripJsonComments(text))
  } catch {
    return []
  }
  const mcp = typeof cfg === 'object' && cfg !== null ? (cfg as { mcp?: unknown }).mcp : undefined
  if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) return []
  return Object.entries(mcp as Record<string, unknown>)
    .map(([name, v]) => {
      const e = typeof v === 'object' && v !== null ? (v as { enabled?: unknown; url?: unknown; command?: unknown }) : {}
      // a url without its query (a token can ride there); a command as typed
      const detail =
        typeof e.url === 'string'
          ? e.url.split('?')[0]
          : Array.isArray(e.command) && e.command.every((c) => typeof c === 'string')
            ? (e.command as string[]).join(' ')
            : undefined
      return { name, ...(typeof e.enabled === 'boolean' ? { enabled: e.enabled } : {}), ...(detail ? { detail } : {}) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

type Say = { entry: 'on' | 'off'; file: string }

/** What OpenCode reads for a folder, file by file: the layers in its merge
 *  order and the facts above the launch content. */
interface OpencodeState {
  layers: { owner: 'you' | 'project'; file: string; entries: OpencodeMcpEntry[] }[]
  /** per server: the global files' say, the folder files' say, the managed
   *  config's say, OPENCODE_PERMISSION's deny */
  machine: (n: string) => Say | undefined
  repository: (n: string) => Say | undefined
  managed: (n: string) => Say | undefined
  envDeny: (n: string) => string | undefined
  machineFile: string
  machineRefusal: string | null
}

function readState(input: LoadsInput, env: NodeJS.ProcessEnv): OpencodeState {
  const read = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }
  const filesOf = (dir: string, shown: string): { file: string; entries: OpencodeMcpEntry[] }[] =>
    FILES.flatMap((f) => {
      const text = read(join(dir, f))
      return text === null ? [] : [{ file: `${shown}${f}`, entries: opencodeMcpEntries(text) }]
    })
  // the layers in OpenCode's merge order (launch.ts configContent: the
  // global config, then the project's), each file as loadedAtStart reads it
  const global = filesOf(join(input.home, '.config', 'opencode'), '~/.config/opencode/')
  const folder = filesOf(input.folder, '')
  const managed = filesOf(managedConfigDir(env), `${managedConfigDir(env).replace(/\/+$/, '')}/`)
  /** the last file of a set that says `enabled` for the name */
  const sayOf =
    (files: { file: string; entries: OpencodeMcpEntry[] }[]) =>
    (n: string): Say | undefined => {
      let say: Say | undefined
      for (const f of files) for (const e of f.entries) if (e.name === n && e.enabled !== undefined) say = { entry: e.enabled ? 'on' : 'off', file: f.file }
      return say
    }
  // OPENCODE_PERMISSION: a JSON permission object over everything; a deny of
  // the server's tools (`<name>_*` — how OpenCode turns a server's tools off)
  let perm: Record<string, unknown> = {}
  try {
    const p = JSON.parse(env.OPENCODE_PERMISSION ?? '') as unknown
    if (p && typeof p === 'object' && !Array.isArray(p)) perm = p as Record<string, unknown>
  } catch {
    /* absent or not JSON: says nothing */
  }
  const envDeny = (n: string): string | undefined => {
    const k = `${n}_*`
    return Object.prototype.hasOwnProperty.call(perm, k) && perm[k] === 'deny' ? k : undefined
  }
  return {
    layers: [...global.map((g) => ({ owner: 'you' as const, ...g })), ...folder.map((f) => ({ owner: 'project' as const, ...f }))],
    machine: sayOf(global),
    repository: sayOf(folder),
    managed: sayOf(managed),
    envDeny,
    machineFile: globalConfigFile(input.home).shown,
    machineRefusal: globalConfigRefusal(input.home),
  }
}

/** One server's lines, broadest first. Every kind here is an override: each
 *  line's own entry decides, either way, unless a fact above every line
 *  does (it locks them all). Pure over the state and the payloads. */
function linesOf(s: OpencodeState, name: string, carried: LoadsCarried | undefined): LoadsLine[] {
  const lines: LoadsLine[] = []
  const deny = s.envDeny(name)
  const managed = s.managed(name)
  // a fact above the launch content decides every line
  const above: 'on' | 'off' | null = deny ? 'off' : managed ? managed.entry : null
  if (deny) lines.push({ place: 'fact', fact: { who: 'engine', file: 'OPENCODE_PERMISSION', key: deny }, entry: 'off', result: 'off' })
  if (managed)
    lines.push({ place: 'fact', fact: { who: 'organization', file: managed.file, key: `mcp.${name}.enabled` }, entry: managed.entry, result: above! })
  let value: 'on' | 'off' = 'on'
  const step = (entry: 'on' | 'off' | undefined): Pick<LoadsLine, 'entry' | 'result' | 'locked'> => {
    if (entry) value = entry
    return { ...(entry ? { entry } : {}), ...(above ? { result: above, locked: { why: 'organization' as const, at: 'fact' as const } } : { result: value }) }
  }
  const sw = (l: LoadsLine): LoadsLine => (l.locked ? l : { ...l, switch: { names: [name] } })
  const machine = s.machine(name)
  const m = sw({ place: 'machine', keptIn: s.machineFile, ...step(machine?.entry) })
  // a global file Silos won't rewrite (comments, not an object): no switch,
  // the file named on its line
  if (s.machineRefusal && m.switch) {
    delete m.switch
    m.refused = { why: 'file', reason: s.machineRefusal }
  }
  lines.push(m)
  const repo = s.repository(name)
  if (repo) lines.push({ place: 'fact', fact: { who: 'repository', file: repo.file, key: `mcp.${name}.enabled` }, ...step(repo.entry) })
  lines.push(sw({ place: 'project', ...step(mcpEntryOf(carried?.folder?.payload, name)) }))
  // the agents and one conversation branch off the project
  const projectValue = value
  for (const a of carried?.agents ?? []) {
    value = projectValue
    lines.push(sw({ place: 'agent', agent: a.id, ...step(mcpEntryOf(a.payload, name)) }))
  }
  if (carried?.conversation) {
    value = projectValue
    lines.push(sw({ place: 'conversation', ...step(mcpEntryOf(carried.conversation.payload, name)) }))
  }
  return lines
}

export function opencodeLoadsInventory(input: LoadsInput, env: NodeJS.ProcessEnv = process.env): LoadsInventory {
  const s = readState(input, env)
  const rows: LoadsRow[] = []
  for (const l of s.layers) {
    for (const e of l.entries) {
      const key = `mcp:${l.owner === 'you' ? 'user' : 'project'}:${e.name}`
      if (rows.some((r) => r.key === key)) continue // its other file in the same folder named it first
      // a namesake in both places is one server in OpenCode's merge: the
      // same lines on both rows
      const at = linesOf(s, e.name, input.carried)
      const project = at.find((x) => x.place === 'project')!
      const fact = at.find((x) => x.place === 'fact' && (x.fact?.who === 'organization' || x.fact?.who === 'engine'))
      rows.push({
        key,
        engine: ENGINE,
        kind: 'mcp',
        name: e.name,
        label: e.name,
        exact: true,
        origin: { owner: l.owner, carrier: l.file },
        state: project.result === 'off' ? 'held' : 'active',
        family: 'override',
        at,
        // the project's own line is the row's plain switch; a fact above
        // every line decides instead — named, no button
        ...(project.locked && fact?.fact ? { decidedBy: { file: fact.fact.file, key: fact.fact.key } } : { switch: { names: [e.name] } }),
        ...(e.detail ? { detail: e.detail } : {}),
      })
    }
  }
  const notes =
    rows.length > 0
      ? [
          'Above every place, OpenCode also reads a remote organization config, a managed config and OPENCODE_PERMISSION — Silos never writes them, and shows the two it can read on the rows they decide.',
        ]
      : []
  return { engine: ENGINE, folder: input.folder, rows, logins: [], notes }
}

/** The payload a launch place is handed, from `at` or what the inventory was given. */
function payloadAt(input: LoadsInput, at: LoadsSwitchAt): unknown {
  if (at.payload !== undefined) return at.payload
  if (at.scope === 'project') return input.carried?.folder?.payload ?? null
  if (at.scope === 'agent') return input.carried?.agents.find((a) => a.id === at.agent)?.payload ?? null
  return input.carried?.conversation?.payload ?? null
}

/** `carried` with one place's payload replaced. */
function withPayload(carried: LoadsCarried, at: LoadsSwitchAt, payload: unknown): LoadsCarried {
  if (at.scope === 'project') return { ...carried, folder: { payload } }
  if (at.scope === 'agent') return { ...carried, agents: carried.agents.map((a) => (a.id === at.agent ? { id: a.id, payload } : a)) }
  return { ...carried, conversation: { id: carried.conversation?.id ?? '', payload } }
}

const lineAt = (r: LoadsRow, at: LoadsSwitchAt): LoadsLine | undefined =>
  r.at?.find((l) => l.place === at.scope && (at.scope !== 'agent' || l.agent === at.agent))

/** One row for one place. The machine: the global file's entry, written
 *  (global-config.ts) — returns nothing. A launch place: its entry in the
 *  payload Silos keeps, set where the place differs from what it follows
 *  and removed where it does not (rule 12) — returns the new payload,
 *  cleaned by the allowlist, writing nothing. */
export function opencodeLoadsSwitch(
  input: LoadsInput,
  key: string,
  to: 'on' | 'off',
  at?: LoadsSwitchAt,
  env: NodeJS.ProcessEnv = process.env,
): LoadsCarriedSwitch | void {
  const place: LoadsSwitchAt = at ?? { scope: 'project' }
  if (place.scope === 'agent' && !(input.carried?.agents ?? []).some((a) => a.id === place.agent))
    throw new LoadsSwitchError(`"${place.agent ?? ''}" is not an agent of this project`, 404)
  const inv = opencodeLoadsInventory(input, env)
  const row = inv.rows.find((r) => r.key === key)
  if (!row) throw new LoadsSwitchError(`unknown row "${key}" — not among what this folder loads`, 404)
  const line = lineAt(row, place)
  if (!line) throw new LoadsSwitchError(`"${row.label}" has no ${place.scope} line here`, 404)
  if (line.locked) {
    const fact = row.at!.find((l) => l.place === 'fact' && l.locked === undefined && (l.fact?.who === 'organization' || l.fact?.who === 'engine'))
    throw new LoadsSwitchError(
      `"${row.label}" is decided above every place${fact?.fact ? ` — ${fact.fact.key} in ${fact.fact.file}` : ''}; no place here can change it`,
      409,
    )
  }
  if (place.scope === 'machine') {
    // the machine follows OpenCode's own default (it loads a server):
    // «on» removes the entry, «off» writes it
    switchGlobalMcp(input.home, row.name, to)
    return
  }
  // a launch place
  const payload = cleanOpencodeEntries(payloadAt(input, place))
  const carried: LoadsCarried = input.carried ?? { agents: [] }
  // what the place follows: its own line without its entry (rule 12)
  const without = setMcpEntry(payload, row.name, null).payload
  const bare = opencodeLoadsInventory({ ...input, carried: withPayload(carried, place, without) }, env).rows.find((r) => r.key === key)
  const follows = (bare && lineAt(bare, place)?.result) ?? 'on'
  const r = setMcpEntry(payload, row.name, to === follows ? null : to)
  return { payload: r.payload, changed: r.changed, held: to !== follows }
}
