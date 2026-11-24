// plugin-enablement.ts — whether a Claude Code plugin is ON in a folder,
// resolved the way the installed Claude Code (2.1.316, `hJt`) resolves it:
//
//   1. an explicit `enabledPlugins` entry, by precedence —
//        managed (policy) settings  >  <folder>/.claude/settings.local.json
//        >  <folder>/.claude/settings.json  >  ~/.claude/settings.json
//      the most specific file that HAS an entry decides, a `true` in the
//      local file wins over a `false` in the user file and the other way
//      round; the managed layer comes first, so the organization's value
//      wins both ways (and a managed `false` is re-checked as a hard off);
//   2. no entry anywhere: the plugin manifest's `defaultEnabled`
//      (<installPath>/.claude-plugin/plugin.json — "Whether the plugin
//      starts enabled when the user has no explicit enabled/disabled
//      setting for it (default: true)");
//   3. otherwise ON.
//
// ONE resolver for every reader: the skills catalog (complete-service.ts:
// which plugin skills load) and the project's Tools piece (loads/inventory.ts:
// active / held, and which file decides). A first fix round read "no entry"
// as OFF — Claude Code loads such a plugin, so the catalog hid skills that
// ran and Tools showed an off that wasn't.
//
// What Silos does NOT model, and why:
//  - managed settings Silos can't read — server-managed (fetched from the
//    organization), the macOS managed-preferences plist, the Windows
//    registry. Only the managed-settings.json file and its
//    managed-settings.d/*.json drop-ins in the machine's managed directory
//    are read (claudeManagedSettingsDir); a policy delivered any other way
//    is invisible here.
//  - `--settings` flag settings: the only ones Silos passes are the
//    territory fence's (deny rules, no enabledPlugins).
//  - a marketplace's `installationPreference: "required"` (forces a plugin
//    on unless managed says off): it lives in marketplace metadata, not in
//    installed_plugins.json.
//  - non-boolean entry values: dropped as "no entry" (switchesOf).
//
// Plugins a claude.ai account sends (`<name>@synced`, the caller hands their
// live copies — harnesses/claude-code/loads/account-batches.ts) answer by the
// same rule, with one key above it: the origin's own, `syncClaudeAiPlugins:
// false`, which hides every synced plugin from sessions there. Read where
// the engine reads it — managed, the local file, the user file — never from
// the project's .claude/settings.json (the schema's own words); only `false`
// counts.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PluginSwitches = Record<string, boolean>

/** which source decided: the organization's managed settings, the local
 *  settings Silos writes, the project's checked-in settings, the
 *  operator's user settings, the plugin's own manifest (`defaultEnabled`),
 *  or nothing at all (the engine's default: on) */
export type PluginDecidedBy = 'managed' | 'local' | 'project-settings' | 'user' | 'plugin-default' | 'default'

export interface PluginResolution {
  enabled: boolean
  by: PluginDecidedBy
  /** decided by the origin's key (syncClaudeAiPlugins), not the plugin's own entry */
  origin?: true
}

export interface PluginLayers {
  managed: PluginSwitches
  local: PluginSwitches
  project: PluginSwitches
  user: PluginSwitches
  /** which layer sets `syncClaudeAiPlugins: false` (managed first), if any */
  accountPluginsOff?: 'managed' | 'local' | 'user' | null
}

/** The suffix of a plugin a claude.ai account sends. */
export const SYNCED_SUFFIX = '@synced'

/** Where the file readers find the machine's config. `managedDir` absent:
 *  no managed layer (direct unit construction). */
export interface PluginPaths {
  userSettingsPath: string // ~/.claude/settings.json — read-only
  installedPluginsPath: string // ~/.claude/plugins/installed_plugins.json — read-only
  managedDir?: string // e.g. /etc/claude-code — read-only
}

/** The managed-settings directory Claude Code reads on this platform. */
export function claudeManagedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

const emptySwitches = (): PluginSwitches => Object.create(null) as PluginSwitches

/** The boolean entries of a settings file's `enabledPlugins` (anything else
 *  — a missing file, a broken one, a non-boolean value — holds nothing).
 *  Own properties only: a plugin key is data, never a prototype lookup. */
export function switchesOf(settings: unknown): PluginSwitches {
  const s = typeof settings === 'object' && settings !== null && !Array.isArray(settings) ? (settings as Record<string, unknown>) : null
  const raw = s && Object.prototype.hasOwnProperty.call(s, 'enabledPlugins') ? s.enabledPlugins : undefined
  const out = emptySwitches()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'boolean') out[k] = v
  return out
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function managedFiles(managedDir: string | undefined): unknown[] {
  if (!managedDir) return []
  const files = [join(managedDir, 'managed-settings.json')]
  try {
    const dropDir = join(managedDir, 'managed-settings.d')
    for (const n of readdirSync(dropDir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort())
      files.push(join(dropDir, n))
  } catch {
    // no drop-in directory
  }
  return files.map(readJson)
}

/** managed-settings.json, then managed-settings.d/*.json in name order on
 *  top (a later file's entry for a key wins). Tolerant: a missing or broken
 *  file holds nothing. */
export function managedSwitches(managedDir: string | undefined): PluginSwitches {
  const out = emptySwitches()
  for (const json of managedFiles(managedDir)) Object.assign(out, switchesOf(json))
  return out
}

/** Whether a settings file sets the account-plugins origin off (only `false`). */
export function syncsAccountPluginsOff(settings: unknown): boolean {
  const s = typeof settings === 'object' && settings !== null && !Array.isArray(settings) ? (settings as Record<string, unknown>) : null
  return s !== null && Object.prototype.hasOwnProperty.call(s, 'syncClaudeAiPlugins') && s.syncClaudeAiPlugins === false
}

/** The layers for a folder (null folder: managed + user alone). */
export function pluginLayers(folder: string | null | undefined, userSettingsPath: string, managedDir?: string): PluginLayers {
  const managed = managedFiles(managedDir)
  const local = folder ? readJson(join(folder, '.claude', 'settings.local.json')) : null
  const user = readJson(userSettingsPath)
  const managedSw = emptySwitches()
  for (const json of managed) Object.assign(managedSw, switchesOf(json))
  return {
    managed: managedSw,
    local: switchesOf(local),
    project: folder ? switchesOf(readJson(join(folder, '.claude', 'settings.json'))) : emptySwitches(),
    user: switchesOf(user),
    accountPluginsOff: managed.some(syncsAccountPluginsOff)
      ? 'managed'
      : syncsAccountPluginsOff(local)
        ? 'local'
        : syncsAccountPluginsOff(user)
          ? 'user'
          : null,
  }
}

/** installed_plugins.json: plugin key → its live install path (the first
 *  record — the cache keeps stale versions side by side). A record with no
 *  string installPath maps to null. Tolerant: no file = no plugins. */
export function installedPlugins(installedPluginsPath: string): Map<string, string | null> {
  const raw = readJson(installedPluginsPath)
  const plugins = typeof raw === 'object' && raw !== null ? (raw as { plugins?: unknown }).plugins : undefined
  const out = new Map<string, string | null>()
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return out
  for (const key of Object.keys(plugins).sort()) {
    const recs = (plugins as Record<string, unknown>)[key]
    const first = Array.isArray(recs) ? (recs[0] as { installPath?: unknown } | undefined) : undefined
    out.set(key, typeof first?.installPath === 'string' ? first.installPath : null)
  }
  return out
}

/** The manifest's `defaultEnabled` (<installPath>/.claude-plugin/plugin.json),
 *  when it is a boolean; anything else (no manifest, broken JSON, another
 *  type) = undefined, i.e. the engine's default. */
export function manifestDefaultEnabled(installPath: string | null | undefined): boolean | undefined {
  if (!installPath) return undefined
  const m = readJson(join(installPath, '.claude-plugin', 'plugin.json'))
  const v = typeof m === 'object' && m !== null && !Array.isArray(m) ? (m as Record<string, unknown>).defaultEnabled : undefined
  return typeof v === 'boolean' ? v : undefined
}

const has = (o: PluginSwitches, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Claude Code's resolution for one plugin key: explicit entry by
 *  precedence, else the manifest's defaultEnabled, else on. */
export function resolvePlugin(key: string, layers: PluginLayers, defaultEnabled?: boolean): PluginResolution {
  if (key.endsWith(SYNCED_SUFFIX) && layers.accountPluginsOff) return { enabled: false, by: layers.accountPluginsOff, origin: true }
  if (has(layers.managed, key)) return { enabled: layers.managed[key] === true, by: 'managed' }
  if (has(layers.local, key)) return { enabled: layers.local[key] === true, by: 'local' }
  if (has(layers.project, key)) return { enabled: layers.project[key] === true, by: 'project-settings' }
  if (has(layers.user, key)) return { enabled: layers.user[key] === true, by: 'user' }
  if (defaultEnabled === false) return { enabled: false, by: 'plugin-default' }
  return { enabled: true, by: 'default' }
}

/** The one resolver bound to a folder: reads every file once, answers per
 *  plugin key — installed ones, and the `<name>@synced` ones the caller
 *  hands with their live copy (`synced`: id → directory). */
export function pluginResolver(
  folder: string | null | undefined,
  paths: PluginPaths,
  synced?: ReadonlyMap<string, string>,
): { installed: Map<string, string | null>; layers: PluginLayers; resolve: (key: string) => PluginResolution } {
  const installed = installedPlugins(paths.installedPluginsPath)
  const layers = pluginLayers(folder, paths.userSettingsPath, paths.managedDir)
  const dirOf = (key: string): string | null | undefined => (installed.has(key) ? installed.get(key) : synced?.get(key))
  return { installed, layers, resolve: (key) => resolvePlugin(key, layers, manifestDefaultEnabled(dirOf(key))) }
}
