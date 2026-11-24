// harnesses/claude-code/loads/inventory.ts — Harness.loads.inventory for
// Claude Code: everything a conversation in a folder loads at start, ONE row
// per thing, with its origin, whether this project loads it and the file
// that decides it when that is not the project's own local file.
//
// The rows are the UNION of what is configured on disk and what the engine
// was seen to load (spec tools-origin §2 rule 1):
//
//  · plugins — installed (installed_plugins.json) and sent by a claude.ai
//    account (plugins/synced/<org>_<account>/, account-batches.ts), each
//    asked of the ONE resolver (plugin-enablement.ts). A plugin installed AND
//    sent has one name in a transcript: a reading decides which copy loaded
//    (it lists a server only that copy declares); without one, the engine's
//    documented rule — «a plugin you installed with the same name takes
//    precedence» — installed and on: the installed copy; else the account's;
//  · every plugin's MCP servers under the engine's names, a row each under
//    its plugin; an entry with no address is a placeholder, entries sharing
//    an address are one server (plugin-servers.ts);
//  · the folder's .mcp.json servers and the operator's ~/.claude.json ones
//    (global and this folder's);
//  · claude.ai connectors, from status readings (exact names) — they are
//    not on disk;
//  · OBSERVED rows: a name a reading lists that nothing above declares (its
//    origin from the reading's source), and a tool-name id the folder's
//    conversations called that no known name has (no switch: an id is never
//    turned back into a name — names.ts).
//
// States: active (this project loads it) · held (a thing of yours or the
// project's, off here) · available (what the Claude account sends, not added
// here). Every settings layer is read on every call — a hand edit shows at
// once. `switch` is offered only where the folder's local file decides it
// (the one writer, local-settings.ts, through switch.ts), with the engine's
// exact names; a switch confirmed on a later engine than the installed one,
// and every switch of a home folder, is `refused` instead — said on the row.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoadsInput, LoadsInventory, LoadsOrigin, LoadsOwner, LoadsReading, LoadsRow, ResolvedNotice } from '../../contract.js'
import { claudeJsonProjectOf } from '../../../claude-project-key.js'
import {
  claudeManagedSettingsDir,
  managedFiles,
  manifestDefaultEnabled,
  pluginResolver,
  resolvePlugin,
  switchesOf,
  SYNCED_SUFFIX,
  type PluginResolution,
} from '../../../plugin-enablement.js'
import { compareVersions } from '../../../harness-run.js'
import { isConfigHome } from '../local-settings.js'
import { startLogins } from './start-logins.js'
import { matchBatches, readAccountBatches } from './account-batches.js'
import { carriesOf } from './carries.js'
import { CONNECTOR_PREFIX, nameResolver, pluginServerName } from './names.js'
import { signInOf } from './sign-in.js'
import { pluginServerEntries, sameServerAs, type PluginServerEntry } from './plugin-servers.js'
import { ACCOUNT_CONNECTORS_URL, expectsOf, linesOf, withParent, type RowTiers, type TierSay } from './places.js'
import { HEAD_OF, headOffIn, headTiers, MACHINE_HEAD_CONFIRMED_ON } from './heads.js'

const ENGINE = 'Claude Code'

/** The engine version each newer switch was confirmed on (spec tools-origin
 *  appendix, CLI 2.1.330): an account plugin's `enabledPlugins
 *  "<name>@synced": false` and a plugin server's `deniedMcpServers` entry
 *  measured; your server's and a connector's deny by name read in the
 *  engine's code on that release — proved on each install by rule 7. A
 *  .mcp.json server's and an installed plugin's switches predate the gate. */
export const SWITCH_CONFIRMED_ON = '2.1.330'

/** The engine version each key of the MACHINE line was confirmed on, at the
 *  user tier (spec scopes T1, CLI 2.1.331): a plugin's and an account
 *  plugin's `enabledPlugins` entry, a deny by name (a connector's
 *  included), measured at a session start. An older engine shows the line
 *  as a fact with «Update ›». */
export const MACHINE_CONFIRMED_ON = '2.1.331'

type Json = Record<string, unknown>
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const readJson = (path: string): Json | null => {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
const own = (o: object | null | undefined, k: string): boolean => o != null && Object.prototype.hasOwnProperty.call(o, k)
const field = (o: Json | null | undefined, k: string): unknown => (o && own(o, k) ? o[k] : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : [])

/** The settings layers in the engine's precedence (managed first). */
type LayerId = 'managed' | 'local' | 'project' | 'user'
interface Layer {
  id: LayerId
  json: Json | null
}

/** The words for a file that decides — never this project's local file. */
const FILE: Record<Exclude<LayerId, 'local'>, string> = {
  managed: 'managed settings',
  project: '.claude/settings.json',
  user: '~/.claude/settings.json',
}
const CLAUDE_JSON = '~/.claude.json'

/** The first layer whose `deniedMcpServers` names `name` verbatim (managed first). */
function deniedBy(layers: Layer[], name: string): LayerId | null {
  for (const l of layers) {
    for (const e of Array.isArray(field(l.json, 'deniedMcpServers')) ? (l.json!.deniedMcpServers as unknown[]) : []) {
      if (field(asObject(e), 'serverName') === name) return l.id
    }
  }
  return null
}

/** The server entries of a config file's `mcpServers` (name → url/command). */
function serversOf(file: Json | null): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  const raw = asObject(field(file, 'mcpServers'))
  if (!raw) return out
  for (const name of Object.keys(raw).sort()) {
    const s = asObject(raw[name])
    const url = field(s, 'url'),
      command = field(s, 'command')
    out.set(name, typeof url === 'string' ? url : typeof command === 'string' ? command : undefined)
  }
  return out
}

interface PluginCopy {
  /** enabledPlugins key: `<name>@<marketplace>` or `<name>@synced` */
  id: string
  name: string
  dir: string
  manifest: Json | null
  version?: string
  account?: { login: string | null; accountId: string; unmatched?: true }
  key: string
  resolution: PluginResolution
}

function decidedOfPlugin(c: PluginCopy): LoadsRow['decidedBy'] {
  const r = c.resolution
  if (r.origin) return r.by === 'managed' || r.by === 'user' ? { file: FILE[r.by], key: 'syncClaudeAiPlugins' } : undefined
  if (r.by === 'managed' || r.by === 'user') return { file: FILE[r.by], key: `enabledPlugins.${c.id}` }
  if (r.by === 'project-settings') return { file: FILE.project, key: `enabledPlugins.${c.id}` }
  if (r.by === 'plugin-default' && !r.enabled) return { file: `the ${c.name} plugin’s manifest`, key: 'defaultEnabled' }
  return undefined
}

/** Which server names a reading lists (exact). */
const listedNames = (readings: LoadsReading[]): Set<string> => new Set(readings.flatMap((r) => r.servers.map((s) => s.name)))

export function claudeLoadsInventory(input: LoadsInput): LoadsInventory {
  return claudeLoadsState(input).inventory
}

/** The inventory, and what a switch needs beyond it: how a plugin resolves
 *  without the folder's local file (what lies beneath a local entry). */
export function claudeLoadsState(input: LoadsInput): {
  inventory: LoadsInventory
  beneath: (pluginId: string) => PluginResolution
  launchOf: (rowKey: string) => RowTiers['launch']
} {
  const { folder, home } = input
  const claudeDir = join(home, '.claude')
  const managedDir = input.managedDir ?? claudeManagedSettingsDir()
  const userSettingsPath = join(claudeDir, 'settings.json')
  const installedPluginsPath = join(claudeDir, 'plugins', 'installed_plugins.json')
  const notes: string[] = []

  // ---- the settings layers, read now
  const managedJsons = managedFiles(managedDir).map(asObject)
  const merged: Json = {}
  for (const j of managedJsons) if (j) Object.assign(merged, j)
  const managedDeny = managedJsons.flatMap((j) => (Array.isArray(field(j, 'deniedMcpServers')) ? (j!.deniedMcpServers as unknown[]) : []))
  const layers: Layer[] = [
    { id: 'managed', json: { ...merged, deniedMcpServers: managedDeny } },
    { id: 'local', json: readJson(join(folder, '.claude', 'settings.local.json')) },
    { id: 'project', json: readJson(join(folder, '.claude', 'settings.json')) },
    { id: 'user', json: readJson(userSettingsPath) },
  ]
  const claudeJson = readJson(join(home, '.claude.json'))
  const perProject = claudeJsonProjectOf(claudeJson, folder)

  const rows: LoadsRow[] = []
  const row = (r: Omit<LoadsRow, 'engine'>): LoadsRow => {
    const out = { engine: ENGINE, ...r } as LoadsRow
    rows.push(out)
    return out
  }
  const listed = listedNames(input.readings)
  // «Where it loads»: what each tier says about a row (places.ts), by row key
  const tiers = new Map<string, RowTiers>()
  const layerOf = (id: LayerId): Json | null => layers.find((l) => l.id === id)!.json
  const deniedIn = (id: LayerId, name: string): boolean =>
    (Array.isArray(field(layerOf(id), 'deniedMcpServers')) ? (layerOf(id)!.deniedMcpServers as unknown[]) : []).some(
      (e) => field(asObject(e), 'serverName') === name,
    )
  /** an off-only say per tier: the first key that takes `name` out there */
  const offSays = (keys: ((id: LayerId) => string | null)[]): Record<LayerId, TierSay | undefined> => {
    const out = {} as Record<LayerId, TierSay | undefined>
    for (const id of ['managed', 'user', 'project', 'local'] as LayerId[]) {
      const k = keys.map((f) => f(id)).find((x) => x !== null)
      out[id] = k ? { removes: k } : undefined
    }
    return out
  }
  const byDeny =
    (name: string) =>
    (id: LayerId): string | null =>
      deniedIn(id, name) ? 'deniedMcpServers' : null

  // ---- the logins its starts recorded, and the account batches on disk
  const logins = startLogins(input.recentTranscripts)
  const batches = readAccountBatches(join(claudeDir, 'plugins', 'synced'))
  const matches = matchBatches(
    batches,
    logins.map((l) => ({ key: l.accountUuid, accountUuid: l.accountUuid })),
  )
  const emailOf = (accountUuid: string | undefined): string | null => logins.find((l) => l.accountUuid === accountUuid)?.email ?? null

  // ---- plugins: installed, then each batch's
  const synced = new Map<string, string>()
  for (const b of batches) for (const p of b.plugins) if (!synced.has(p.id)) synced.set(p.id, p.dir)
  const resolver = pluginResolver(folder, { userSettingsPath, installedPluginsPath, managedDir }, synced)
  const beneathLayers = {
    ...resolver.layers,
    local: switchesOf(null),
    accountPluginsOff: resolver.layers.accountPluginsOff === 'local' ? null : (resolver.layers.accountPluginsOff ?? null),
  }
  const beneath = (id: string): PluginResolution =>
    resolvePlugin(id, beneathLayers, manifestDefaultEnabled(resolver.installed.has(id) ? resolver.installed.get(id) : synced.get(id)))

  // the account origins' keys: the folder's local file, and another file
  // that turns the origin off (the head has no switch then). Account
  // plugins: `syncClaudeAiPlugins: false` — managed, local or the user's
  // file (the schema: never .claude/settings.json); connectors:
  // `disableClaudeAiConnectors: true` in ANY source wins.
  const syncOff = (j: Json | null): boolean => field(j, 'syncClaudeAiPlugins') === false
  const pluginsLocal = syncOff(layers[1]!.json)
  const pluginsOther: 'managed' | 'user' | null = managedJsons.some(syncOff) ? 'managed' : syncOff(layers[3]!.json) ? 'user' : null
  const connectorsOn = (l: Layer): boolean => field(l.json, 'disableClaudeAiConnectors') === true
  const connectorsLocal = connectorsOn(layers[1]!)
  const connectorsOther = (layers.find((l) => l.id !== 'local' && connectorsOn(l))?.id ?? null) as Exclude<LayerId, 'local'> | null

  // a switch, or why there is none: a home folder's file is the engine's
  // for every project; an engine older than the switch was confirmed on
  const home_ = isConfigHome(folder, home)
  const offer = (names: string[], confirmedOn?: string): Pick<LoadsRow, 'switch' | 'refused'> =>
    home_
      ? { refused: { why: 'home' } }
      : confirmedOn && typeof input.engineVersion === 'string' && compareVersions(input.engineVersion, confirmedOn) < 0
        ? { refused: { why: 'engine', needs: confirmedOn } }
        : { switch: { names } }
  // a launch line (an agent's) takes the same engine gate, never the home
  // folder's refusal: that is the project line's alone (spec scopes §4)
  const versionOk = (confirmedOn?: string): boolean =>
    !(confirmedOn && typeof input.engineVersion === 'string' && compareVersions(input.engineVersion, confirmedOn) < 0)
  // the machine line's switch (the user file, loads/machine.ts): a home
  // folder does not refuse it either — only an engine older than its keys'
  const machineOffer = (names: string[]): NonNullable<RowTiers['machineSwitch']> =>
    versionOk(MACHINE_CONFIRMED_ON) ? { names } : { refused: { why: 'engine', needs: MACHINE_CONFIRMED_ON } }
  const installedRaw = asObject(field(readJson(installedPluginsPath), 'plugins')) ?? {}
  const copies: PluginCopy[] = []
  for (const id of [...resolver.installed.keys()]) {
    if (id.endsWith(SYNCED_SUFFIX)) continue
    const entries = Array.isArray(installedRaw[id]) ? (installedRaw[id] as unknown[]).map(asObject).filter((e): e is Json => e !== null) : []
    const entry = entries.find((e) => e.projectPath === folder) ?? entries.find((e) => typeof e.projectPath !== 'string') ?? entries[0]
    const dir = typeof entry?.installPath === 'string' ? entry.installPath : resolver.installed.get(id)
    if (typeof dir !== 'string') continue
    const name = id.includes('@') ? id.slice(0, id.lastIndexOf('@')) : id
    copies.push({
      id,
      name,
      dir,
      manifest: readJson(join(dir, '.claude-plugin', 'plugin.json')),
      ...(typeof entry?.version === 'string' ? { version: entry.version } : {}),
      key: `plugin:${id}`,
      resolution: resolver.resolve(id),
    })
  }
  batches.forEach((b, i) => {
    const m = matches[i]
    for (const p of b.plugins) {
      const manifest = readJson(join(p.dir, '.claude-plugin', 'plugin.json'))
      // an account copy has no install entry: its version is its manifest's
      const version = field(manifest, 'version')
      copies.push({
        id: p.id,
        name: p.name,
        dir: p.dir,
        manifest,
        ...(typeof version === 'string' && version !== '' ? { version } : {}),
        account: { login: m ? emailOf(m.login) : null, accountId: b.accountUuid, ...(m ? {} : { unmatched: true as const }) },
        key: `plugin:${b.accountUuid}:${p.id}`,
        resolution: resolver.resolve(p.id),
      })
    }
  })

  // which copy of one plugin name loads: a reading that lists a server only
  // one on-copy declares names it; else the installed copy when it is on
  const entriesOf = new Map<string, PluginServerEntry[]>()
  for (const c of copies) entriesOf.set(c.key, pluginServerEntries(c.dir, c.manifest))
  const replaced = new Map<string, string>()
  const installedOn = new Map(copies.filter((c) => !c.account && c.resolution.enabled).map((c) => [c.name, c]))
  for (const c of copies) {
    if (!c.account || !c.resolution.enabled) continue
    const mine = installedOn.get(c.name)
    if (!mine) continue
    const only = (a: PluginCopy, b: PluginCopy): boolean => {
      const theirs = new Set((entriesOf.get(b.key) ?? []).map((e) => e.server))
      return (entriesOf.get(a.key) ?? []).some((e) => !theirs.has(e.server) && listed.has(pluginServerName(a.name, e.server)))
    }
    if (only(c, mine) && !only(mine, c)) replaced.set(mine.key, c.key)
    else replaced.set(c.key, mine.key)
  }

  const pluginState = (c: PluginCopy): LoadsRow['state'] => (c.resolution.enabled ? 'active' : c.account ? 'available' : 'held')
  const originOf = (c: PluginCopy, carrier: string): LoadsRow['origin'] =>
    c.account ? { owner: 'account', carrier, login: c.account.login, ...(c.account.unmatched ? { unmatched: true as const } : {}) } : { owner: 'you', carrier }

  // the servers of every LIVE plugin, in the engine's order, for «same server as»
  const live = (c: PluginCopy): boolean => c.resolution.enabled && !replaced.has(c.key)
  const serverKey = (c: PluginCopy, server: string): string => `server:${c.key.slice('plugin:'.length)}:${server}`
  const sameAs = sameServerAs(
    copies
      .filter(live)
      .flatMap((c) =>
        (entriesOf.get(c.key) ?? [])
          .filter((e) => deniedBy(layers, pluginServerName(c.name, e.server)) === null)
          .map((e) => ({ name: serverKey(c, e.server), url: e.url })),
      ),
  )
  // every live copy of one address, denied or not (the switch's names)
  const sharedBy = new Map<string, { key: string; name: string }[]>()
  for (const c of copies.filter(live)) {
    for (const e of entriesOf.get(c.key) ?? []) {
      if (e.url === null) continue
      const list = sharedBy.get(e.url) ?? []
      list.push({ key: serverKey(c, e.server), name: pluginServerName(c.name, e.server) })
      sharedBy.set(e.url, list)
    }
  }
  const withReach = (o: Pick<LoadsRow, 'switch' | 'refused'>, reaches: string[]): Pick<LoadsRow, 'switch' | 'refused'> =>
    o.switch && reaches.length > 0 ? { switch: { ...o.switch, reaches } } : o

  // connectors a reading names (exact): the account's, per login — then
  // each login's list (logins.json: its newest reading in ANY folder taken
  // with them on, or «See what it sends»), what a folder with the origin off
  // can't fetch itself: «could add» rows there; with no list known, none
  const connectorsOff = connectorsLocal || connectorsOther !== null
  const connectorRows: LoadsRow[] = []
  const placedNames = new Set<string>()
  const connectorRow = (login: string | null, name: string): void => {
    if (placedNames.has(`${login}\u0000${name}`)) return
    placedNames.add(`${login}\u0000${name}`)
    const denied = deniedBy(layers, name)
    const off = connectorsOff || denied !== null
    const says = offSays([(id) => (connectorsOn(layers.find((l) => l.id === id)!) ? 'disableClaudeAiConnectors' : null), byDeny(name)])
    tiers.set(`connector:${login ?? ''}:${name}`, {
      family: 'off-only',
      key: 'deniedMcpServers',
      managed: says.managed,
      user: says.user,
      repository: says.project,
      local: says.local,
      machine: true,
      account: { login, url: ACCOUNT_CONNECTORS_URL },
      head: 'disableClaudeAiConnectors',
      // by name at the machine; with the machine's head off, «on» adds this
      // one there and denies the others (rule 4 per place, machine.ts)
      machineSwitch: machineOffer([name]),
      launch: { key: { key: 'deniedMcpServers', names: [name] }, own: name, switchable: versionOk(SWITCH_CONFIRMED_ON) },
    })
    connectorRows.push({
      key: `connector:${login ?? ''}:${name}`,
      engine: ENGINE,
      kind: 'connector',
      name,
      label: name.startsWith('claude.ai ') ? name.slice('claude.ai '.length) : name,
      exact: true,
      origin: { owner: 'account', carrier: 'connector', login },
      state: off ? 'available' : 'active',
      // one connector off/on by name; with the origin off in this folder's
      // own file alone, «Add» (rule 4, switch.ts)
      ...(!connectorsOther && (denied === null || denied === 'local') ? offer([name], SWITCH_CONFIRMED_ON) : {}),
      ...(connectorsOther
        ? { decidedBy: { file: FILE[connectorsOther], key: 'disableClaudeAiConnectors' } }
        : denied && denied !== 'local'
          ? { decidedBy: { file: FILE[denied], key: 'deniedMcpServers' } }
          : {}),
      observed: { from: 'reading' },
      // what the local file switches off, a reading can prove (rule 7)
      ...(connectorsLocal && !connectorsOther
        ? { heldHere: { by: 'origin' as const, names: [name] } }
        : !connectorsOff && denied === 'local'
          ? { heldHere: { by: 'item' as const, names: [name] } }
          : {}),
    })
  }
  for (const r of input.readings) for (const s of r.servers) if (s.source === 'claudeai') connectorRow(r.login, s.name)
  for (const l of input.loginLists ?? []) for (const name of l.connectors) if (typeof name === 'string' && name !== '') connectorRow(l.login, name)
  const connectorFor = (server: string, login: string | null | undefined): string | undefined =>
    connectorRows.find((c) => c.label.toLowerCase() === server.toLowerCase() && (login === undefined || c.origin.login === login))?.key

  for (const c of copies) {
    const carries = carriesOf(c.dir)
    const replacedBy = replaced.get(c.key)
    {
      const L = resolver.layers
      const say = (sw: Record<string, boolean>, head: boolean): TierSay | undefined => {
        const e = own(sw, c.id) ? (sw[c.id] ? ('on' as const) : ('off' as const)) : undefined
        return e || head ? { ...(e ? { entry: e } : {}), ...(head ? { removes: 'syncClaudeAiPlugins' } : {}) } : undefined
      }
      const acc = c.account !== undefined
      tiers.set(c.key, {
        family: 'override',
        key: `enabledPlugins.${c.id}`,
        managed: say(L.managed, acc && managedJsons.some(syncOff)),
        user: say(L.user, acc && syncOff(layers[3]!.json)),
        repository: say(L.project, false),
        local: say(L.local, acc && pluginsLocal),
        ...(field(c.manifest, 'defaultEnabled') === false ? { defaultOff: { file: `the ${c.name} plugin’s manifest`, key: 'defaultEnabled' } } : {}),
        machine: true,
        ...(c.account ? { account: { login: c.account.login }, head: 'syncClaudeAiPlugins' as const } : {}),
        // its entry at the machine; with the machine's head off, an account
        // plugin's «on» adds it there and holds the others (rule 4, machine.ts)
        machineSwitch: machineOffer([c.id]),
        launch: { key: { key: 'enabledPlugins', id: c.id }, own: c.id, switchable: !replacedBy && versionOk(c.account ? SWITCH_CONFIRMED_ON : undefined) },
      })
    }
    row({
      key: c.key,
      kind: 'plugin',
      name: c.id,
      label: c.name,
      exact: true,
      origin: originOf(c, `${c.name} plugin`),
      state: pluginState(c),
      ...(decidedOfPlugin(c) ? { decidedBy: decidedOfPlugin(c)! } : {}),
      // a plugin the folder's local file decides (an account one by its
      // manifest name @synced); with the account's origin off in this
      // folder's own file alone, «Add» (rule 4, switch.ts) — unless the
      // organization keeps this one off
      // — and, an override kind, one the machine or the repository's file
      // keeps off: the project turns it ON over them (spec scopes §6)
      ...((!c.resolution.origin &&
        (c.resolution.enabled
          ? c.resolution.by !== 'managed'
          : c.resolution.by === 'local' || c.resolution.by === 'plugin-default' || c.resolution.by === 'user' || c.resolution.by === 'project-settings')) ||
      (c.account && c.resolution.origin && pluginsLocal && !pluginsOther && !(beneath(c.id).by === 'managed' && !beneath(c.id).enabled))
        ? offer([c.id], c.account ? SWITCH_CONFIRMED_ON : undefined)
        : {}),
      ...(replacedBy ? { replacedBy } : {}),
      ...(c.version ? { detail: c.version } : {}),
      carries,
      // off by the local file: a reading that lists one of its servers
      // (a placeholder included — present means loaded) proves it didn't take
      ...(!c.resolution.enabled && c.resolution.by === 'local' && (entriesOf.get(c.key) ?? []).length > 0
        ? {
            heldHere: {
              by: c.resolution.origin ? ('origin' as const) : ('item' as const),
              names: (entriesOf.get(c.key) ?? []).map((e) => pluginServerName(c.name, e.server)),
            },
          }
        : {}),
    })
    for (const e of entriesOf.get(c.key) ?? []) {
      const name = pluginServerName(c.name, e.server)
      const denied = deniedBy(layers, name)
      const key = serverKey(c, e.server)
      const first = sameAs.get(key)
      // one address the engine connects once: denying only the copy that
      // loaded hands it to the next — the switch writes every live copy's name
      const copiesOf = e.url === null ? [] : (sharedBy.get(e.url) ?? [])
      const group = copiesOf.length > 1 ? copiesOf : [{ key, name }]
      const state: LoadsRow['state'] = denied ? (c.account ? 'available' : 'held') : pluginState(c)
      {
        const says = offSays([byDeny(name)])
        tiers.set(key, {
          family: 'off-only',
          key: 'deniedMcpServers',
          managed: says.managed,
          user: says.user,
          repository: says.project,
          local: says.local,
          machine: true,
          ...(c.account ? { account: { login: c.account.login } } : {}),
          // denied by name at the machine, every live copy's name — a
          // server of a plugin that does not load comes and goes with it
          ...(live(c) && !e.placeholder ? { machineSwitch: machineOffer(group.map((g) => g.name)) } : {}),
          launch: {
            key: { key: 'deniedMcpServers', names: group.map((g) => g.name) },
            own: name,
            reaches: group.map((g) => g.key).filter((k) => k !== key),
            switchable: live(c) && !e.placeholder && versionOk(SWITCH_CONFIRMED_ON),
          },
        })
      }
      row({
        key,
        kind: 'mcp',
        name,
        label: e.server,
        exact: true,
        origin: originOf(c, `${c.name} plugin`),
        state,
        ...(denied && denied !== 'local' ? { decidedBy: { file: FILE[denied], key: 'deniedMcpServers' } } : {}),
        parent: c.key,
        // a placeholder loads nothing — nothing to switch; a server of a
        // plugin that does not load comes and goes with its plugin
        ...(live(c) && !e.placeholder && (denied === null || denied === 'local')
          ? withReach(
              offer(
                group.map((g) => g.name),
                SWITCH_CONFIRMED_ON,
              ),
              group.map((g) => g.key).filter((k) => k !== key),
            )
          : {}),
        ...(e.placeholder ? { placeholder: connectorFor(e.server, c.account?.login) ? { connector: connectorFor(e.server, c.account?.login)! } : {} } : {}),
        ...(first ? { sameAs: first } : {}),
        ...(replacedBy ? { replacedBy } : {}),
        ...((e.url ?? e.command) ? { detail: (e.url ?? e.command)! } : {}),
        ...(denied === 'local' && live(c) && !e.placeholder ? { heldHere: { by: 'item' as const, names: [name] } } : {}),
      })
    }
  }

  // ---- the folder's .mcp.json servers — the project's
  const disabledIn = (id: LayerId): string[] => strings(field(layers.find((l) => l.id === id)!.json, 'disabledMcpjsonServers'))
  const opDisabled = strings(field(perProject, 'disabledMcpServers'))
  for (const [name, detail] of serversOf(readJson(join(folder, '.mcp.json')))) {
    const by: LayerId | 'claude-json' | null = disabledIn('managed').includes(name)
      ? 'managed'
      : disabledIn('local').includes(name)
        ? 'local'
        : disabledIn('project').includes(name)
          ? 'project'
          : disabledIn('user').includes(name)
            ? 'user'
            : opDisabled.includes(name)
              ? 'claude-json'
              : null
    const denied = deniedBy(layers, name)
    const held = by !== null || denied !== null
    {
      const says = offSays([(id) => (disabledIn(id).includes(name) ? 'disabledMcpjsonServers' : null), byDeny(name)])
      tiers.set(`mcp:project:${name}`, {
        family: 'off-only',
        key: 'disabledMcpjsonServers',
        managed: says.managed,
        user: says.user,
        repository: says.project,
        local: says.local,
        ...(opDisabled.includes(name) ? { engineOff: true as const } : {}),
        machine: false,
        launch: { key: { key: 'disabledMcpjsonServers', name }, own: name, switchable: true },
      })
    }
    const decided =
      by === 'claude-json'
        ? { file: CLAUDE_JSON, key: 'disabledMcpServers' }
        : by && by !== 'local'
          ? { file: FILE[by], key: 'disabledMcpjsonServers' }
          : !by && denied && denied !== 'local'
            ? { file: FILE[denied], key: 'deniedMcpServers' }
            : undefined
    row({
      key: `mcp:project:${name}`,
      kind: 'mcp',
      name,
      label: name,
      exact: true,
      origin: { owner: 'project', carrier: '.mcp.json' },
      state: held ? 'held' : 'active',
      ...(decided ? { decidedBy: decided } : {}),
      // on, or held by the folder's own local file alone
      ...(!held || (by === 'local' && denied === null) ? offer([name]) : {}),
      ...(detail ? { detail } : {}),
      ...((by === 'local' && denied === null) || (by === null && denied === 'local') ? { heldHere: { by: 'item' as const, names: [name] } } : {}),
    })
  }

  // ---- the operator's ~/.claude.json servers: every folder's, and this folder's
  for (const [scope, list] of [
    ['user', serversOf(claudeJson)],
    ['local', serversOf(perProject)],
  ] as const) {
    for (const [name, detail] of list) {
      const off = scope === 'local' && opDisabled.includes(name)
      const denied = deniedBy(layers, name)
      {
        const says = offSays([byDeny(name)])
        tiers.set(`mcp:${scope}:${name}`, {
          family: 'off-only',
          key: 'deniedMcpServers',
          managed: says.managed,
          user: says.user,
          repository: says.project,
          local: says.local,
          ...(off ? { engineOff: true as const } : {}),
          machine: scope === 'user',
          ...(scope === 'user' ? { machineSwitch: machineOffer([name]) } : {}),
          launch: { key: { key: 'deniedMcpServers', names: [name] }, own: name, switchable: versionOk(SWITCH_CONFIRMED_ON) },
        })
      }
      row({
        key: `mcp:${scope}:${name}`,
        kind: 'mcp',
        name,
        label: name,
        exact: true,
        origin: { owner: 'you', carrier: scope === 'user' ? CLAUDE_JSON : `${CLAUDE_JSON} · this folder` },
        state: off || denied ? 'held' : 'active',
        // by name in the local file; ~/.claude.json itself is read, never written
        ...(!off && (denied === null || denied === 'local') ? offer([name], SWITCH_CONFIRMED_ON) : {}),
        ...(off
          ? { decidedBy: { file: CLAUDE_JSON, key: 'disabledMcpServers' } }
          : denied && denied !== 'local'
            ? { decidedBy: { file: FILE[denied], key: 'deniedMcpServers' } }
            : {}),
        ...(detail ? { detail } : {}),
        ...(!off && denied === 'local' ? { heldHere: { by: 'item' as const, names: [name] } } : {}),
      })
    }
  }

  // ---- the servers your organization provides (managed-mcp.json beside
  // its managed settings): on unless denied for yourself — an entry found
  // only in a project's files does not apply to them (the schema)
  for (const [name, detail] of serversOf(readJson(join(managedDir, 'managed-mcp.json')))) {
    const says = offSays([byDeny(name)])
    const off = says.managed !== undefined || says.user !== undefined
    tiers.set(`mcp:managed:${name}`, {
      family: 'off-only',
      key: 'deniedMcpServers',
      managed: says.managed,
      user: says.user,
      repository: says.project,
      local: says.local,
      machine: true,
      provided: true,
      machineSwitch: machineOffer([name]),
      launch: { key: { key: 'deniedMcpServers', names: [name] }, own: name, switchable: versionOk(SWITCH_CONFIRMED_ON) },
    })
    row({
      key: `mcp:managed:${name}`,
      kind: 'mcp',
      name,
      label: name,
      exact: true,
      origin: { owner: null, carrier: 'managed-mcp.json — your organization' },
      state: off ? 'held' : 'active',
      ...(off ? { decidedBy: { file: says.managed ? FILE.managed : FILE.user, key: 'deniedMcpServers' } } : {}),
      ...(detail ? { detail } : {}),
    })
  }

  rows.push(...connectorRows)

  // a deny by name reaches every server of that name: a ~/.claude.json
  // server's switch says which namesakes go off with it, a connector's the
  // same connector of another login in this project
  // (an agent's entry by name too: its launch line says the same)
  for (const r of rows) {
    if (!(r.key.startsWith('mcp:user:') || r.key.startsWith('mcp:local:') || r.kind === 'connector')) continue
    const namesakes = rows.filter((o) => o !== r && o.kind === r.kind && o.name === r.name).map((o) => o.key)
    if (namesakes.length === 0) continue
    if (r.switch) r.switch = { ...r.switch, reaches: namesakes }
    const t = tiers.get(r.key)
    if (t?.launch) t.launch = { ...t.launch, reaches: namesakes }
  }

  // ---- observed: names a reading lists that nothing declares
  const known = new Set(rows.map((r) => r.name))
  const agentNames = (input.agentServers ?? []).flatMap((a) => a.servers.map((s) => pluginServerName(a.agent, s)))
  for (const r of input.readings) {
    for (const s of r.servers) {
      if (known.has(s.name) || agentNames.includes(s.name)) continue
      known.add(s.name)
      const owner: LoadsOwner = s.source === 'project' ? 'project' : s.source === 'user' || s.source === 'local' ? 'you' : null
      row({
        key: `seen:${s.name}`,
        kind: 'mcp',
        name: s.name,
        label: s.name,
        exact: true,
        origin: {
          owner,
          carrier:
            s.source === 'project'
              ? '.mcp.json'
              : s.source === 'user' || s.source === 'local'
                ? CLAUDE_JSON
                : s.source === 'plugin'
                  ? 'a plugin'
                  : 'seen when it last loaded',
        },
        state: 'active',
        observed: { from: 'reading' },
      })
    }
  }
  // ---- observed: names a start notice gives that nothing above declares
  // (exact: the engine's own) — a connector by its name's form, on the
  // notice's login
  const notices = input.notices ?? []
  for (const n of notices) {
    for (const name of [...n.failed.map((f) => f.name), ...n.needsAuth]) {
      if (known.has(name) || agentNames.includes(name)) continue
      known.add(name)
      const connector = name.startsWith(CONNECTOR_PREFIX)
      row({
        key: connector ? `connector:${n.login ?? ''}:${name}` : `seen:${name}`,
        kind: connector ? 'connector' : 'mcp',
        name,
        label: connector ? name.slice(CONNECTOR_PREFIX.length) : name,
        exact: true,
        origin: connector ? { owner: 'account', carrier: 'connector', login: n.login } : { owner: null, carrier: 'seen when it last loaded' },
        state: 'active',
        observed: { from: 'notice' },
      })
    }
  }
  // ---- observed: tool-name ids no known name has — never turned back
  // (the ids a console's sign-in tool pair carries among them)
  const resolver2 = nameResolver([...known, ...agentNames])
  for (const id of [...new Set([...input.seenToolIds, ...notices.flatMap((n) => n.needsAuthIds ?? [])])].sort()) {
    if (resolver2.resolve(id).kind !== 'unknown') continue
    const connector = id.startsWith('claude_ai_')
    row({
      key: `seen:${id}`,
      kind: connector ? 'connector' : 'mcp',
      name: id,
      label: id,
      exact: false,
      origin: connector ? { owner: 'account', carrier: 'connector', login: null } : { owner: null, carrier: 'seen when it last loaded' },
      state: 'active',
      observed: { from: 'tool-id' },
    })
  }

  // ---- what is not on disk, said
  // (an origin off in this folder's own file is said by its head)
  if (pluginsOther && batches.some((b) => b.plugins.length > 0)) {
    notes.push(`Plugins your Claude account sends are off here — syncClaudeAiPlugins in ${FILE[pluginsOther]}.`)
  }
  if (connectorsOther) notes.push(`Connectors of your Claude account are off here — disableClaudeAiConnectors in ${FILE[connectorsOther]}.`)
  if (home_) notes.push('This folder’s .claude is Claude Code’s own config folder — its settings reach every project, so nothing here is switched from Silos.')
  // with the origin off a conversation here never names them: the head and
  // «See what it sends ›» say it instead
  if (connectorRows.length === 0 && !connectorsOff)
    notes.push('Connectors of your Claude account aren’t on disk — they are listed once a conversation here names them.')

  // ---- the notices, every name the engine's own: an id to the one known
  // name that has it, to its observed row (the id) when none has, dropped
  // when two have (unresolved — said by the id row's absence of health)
  const rowNames = new Set(rows.map((r) => r.name))
  const resolved: ResolvedNotice[] = notices.map((n) => {
    const servers: ResolvedNotice['servers'] = []
    const put = (name: string, status: 'failed' | 'needs-auth', reason?: string): void => {
      if (!rowNames.has(name) || servers.some((x) => x.name === name)) return
      servers.push({ name, status, ...(reason ? { reason } : {}) })
    }
    for (const f of n.failed) put(f.name, 'failed', f.reason)
    for (const name of n.needsAuth) put(name, 'needs-auth')
    for (const id of n.needsAuthIds ?? []) {
      const r = resolver2.resolve(id)
      if (r.kind === 'name') put(r.name, 'needs-auth')
      else if (r.kind === 'unknown') put(id, 'needs-auth')
    }
    return { conversation: n.conversation, login: n.login, at: n.at, mode: n.mode, servers }
  })

  // ---- the account origins' heads: on/off here, and their switch
  const head = (on: boolean, other: Exclude<LayerId, 'local'> | null, key: string, confirmedOn?: string): Omit<LoadsOrigin, 'id'> => {
    if (other) return { on, decidedBy: { file: FILE[other], key } }
    const o = offer([], confirmedOn)
    return { on, ...(o.switch ? { switch: true as const } : {}), ...(o.refused ? { refused: o.refused } : {}) }
  }
  const skillsOff = (j: Json | null): boolean => headOffIn(j, 'syncClaudeAiSkills')
  const skillsLocal = skillsOff(layers[1]!.json)
  const skillsOther: 'managed' | 'user' | null = managedJsons.some(skillsOff) ? 'managed' : skillsOff(layers[3]!.json) ? 'user' : null
  const origins: LoadsOrigin[] = [
    { id: 'plugins', ...head(!pluginsLocal && !pluginsOther, pluginsOther, 'syncClaudeAiPlugins', SWITCH_CONFIRMED_ON) },
    { id: 'skills', ...head(!skillsLocal && !skillsOther, skillsOther, 'syncClaudeAiSkills') },
    { id: 'connectors', ...head(!connectorsOff, connectorsOther, 'disableClaudeAiConnectors') },
  ]
  // each head's «Where it loads» (heads.ts): the door, the facts, the
  // machine, the project (the head's own switch), each agent
  for (const o of origins) {
    const key = HEAD_OF[o.id]
    const t = headTiers(
      o.id,
      {
        managed: managedJsons.some((j) => headOffIn(j, key)),
        user: headOffIn(layers[3]!.json, key),
        repository: headOffIn(layers[2]!.json, key),
        local: headOffIn(layers[1]!.json, key),
      },
      {
        machineSwitch: versionOk(MACHINE_HEAD_CONFIRMED_ON) ? { names: [key] } : { refused: { why: 'engine', needs: MACHINE_HEAD_CONFIRMED_ON } },
        launchSwitchable: versionOk(o.id === 'plugins' ? SWITCH_CONFIRMED_ON : undefined),
      },
    )
    o.at = linesOf(t, input.carried).map((l) =>
      l.place !== 'project' || l.locked ? l : o.switch ? { ...l, switch: { names: [key] } } : o.refused?.why === 'engine' ? { ...l, refused: o.refused } : l,
    )
  }

  // ---- «Where it loads»: each row's lines (places.ts) — a plugin's server
  // counts its plugin's line at the same place
  for (const r of rows) {
    const t = tiers.get(r.key)
    if (!t) continue
    r.family = t.family
    // the project line's switch is the row's own (the local file's)
    r.at = linesOf(t, input.carried).map((l) =>
      l.place !== 'project' || l.locked
        ? l
        : r.switch
          ? { ...l, switch: { names: [...r.switch.names] } }
          : r.refused?.why === 'engine'
            ? { ...l, refused: r.refused }
            : l,
    )
  }
  for (const r of rows) {
    const p = r.parent ? rows.find((x) => x.key === r.parent) : undefined
    if (r.at && p?.at) r.at = withParent(r.at, p.at)
  }
  // what each place a reading can prove expects of it (spec scopes §7):
  // the names a status reading lists if it loads — a server's or a
  // connector's own, a plugin's servers' (none: no proof); a row known only
  // by an id is never proven
  for (const r of rows) {
    if (!r.at || !r.family || !r.exact) continue
    const names = r.kind === 'plugin' ? rows.filter((x) => x.parent === r.key).map((x) => x.name) : [r.name]
    const expect = expectsOf(r.at, r.family, names)
    if (expect.length > 0) r.expect = expect
  }

  // ---- each server's and connector's sign-in door (sign-in.ts)
  for (const r of rows) {
    const door = signInOf(r)
    if (door) r.signIn = door
  }

  return {
    inventory: {
      engine: ENGINE,
      folder,
      rows,
      origins,
      ...(resolved.length > 0 ? { notices: resolved } : {}),
      logins: batches.map((b, i) => ({ login: matches[i] ? emailOf(matches[i]!.login) : null, accountId: b.accountUuid, matched: matches[i]?.by ?? null })),
      notes,
    },
    beneath,
    launchOf: (key: string) => tiers.get(key)?.launch,
  }
}
