// claude-loads.test.ts — the engine facts every «what loads» reader stands
// on (harnesses/claude-code/loads/): the one name resolver (names → tool-name
// ids, one direction only), the account batches on disk (generations,
// matching to a login, unknown shapes), a plugin's server entries
// (placeholders by structure, one address = one server), and the one plugin
// resolver learning the `@synced` ids and their origin key.
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectorName, nameResolver, pluginServerName, toolIdOf } from '../src/harnesses/claude-code/loads/names.js'
import { matchBatches, readAccountBatches, type AccountBatch } from '../src/harnesses/claude-code/loads/account-batches.js'
import { pluginServerEntries, sameServerAs } from '../src/harnesses/claude-code/loads/plugin-servers.js'
import { pluginResolver } from '../src/plugin-enablement.js'

const write = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const json = (path: string, v: unknown): void => write(path, JSON.stringify(v))
const tmp = (): string => mkdtempSync(join(tmpdir(), 'claude-loads-'))

const ORG = '00000000-0000-4000-8000-00000000000a'
const ACC = '00000000-0000-4000-8000-00000000000b'
const ACC2 = '00000000-0000-4000-8000-00000000000c'
const PLUGIN_UUID = '00000000-0000-4000-8000-0000000000f1'

describe('names — one direction, never turned back', () => {
  it('joins names with spaces, hyphens, underscores and dots to their tool-name ids', () => {
    const known = [
      pluginServerName('product-management', 'similarweb'),
      pluginServerName('design', 'google calendar'),
      connectorName('Google Drive'),
      connectorName('example.com docs'),
      'my_server',
    ]
    const r = nameResolver(known)
    expect(toolIdOf('plugin:design:google calendar')).toBe('plugin_design_google_calendar')
    expect(r.resolve('plugin_product-management_similarweb')).toEqual({ kind: 'name', name: 'plugin:product-management:similarweb' })
    expect(r.resolve('plugin_design_google_calendar')).toEqual({ kind: 'name', name: 'plugin:design:google calendar' })
    expect(r.resolve('claude_ai_Google_Drive')).toEqual({ kind: 'name', name: 'claude.ai Google Drive' })
    expect(r.resolve('claude_ai_example_com_docs')).toEqual({ kind: 'name', name: 'claude.ai example.com docs' })
    expect(r.resolve('my_server')).toEqual({ kind: 'name', name: 'my_server' })
  })

  it('never turns an id back: an id no known name has stays unknown', () => {
    const r = nameResolver([connectorName('Gmail')])
    expect(r.resolve('claude_ai_Google_Drive')).toEqual({ kind: 'unknown' })
    expect(r.resolve('plugin_design_slack')).toEqual({ kind: 'unknown' })
    expect(nameResolver([]).resolve('claude_ai_Gmail')).toEqual({ kind: 'unknown' })
  })

  it('two known names with one id stay unresolved, and say which they are', () => {
    const r = nameResolver(['claude.ai Google Drive', 'claude.ai Google_Drive', 'claude.ai Google.Drive'])
    expect(r.resolve('claude_ai_Google_Drive')).toEqual({
      kind: 'ambiguous',
      names: ['claude.ai Google Drive', 'claude.ai Google.Drive', 'claude.ai Google_Drive'],
    })
  })

  it('names are data: __proto__ and constructor are names like any other', () => {
    const r = nameResolver(['__proto__', 'constructor'])
    expect(r.resolve('__proto__')).toEqual({ kind: 'name', name: '__proto__' })
    expect(r.resolve('constructor')).toEqual({ kind: 'name', name: 'constructor' })
    expect(r.resolve('toString')).toEqual({ kind: 'unknown' })
    expect(nameResolver([]).resolve('__proto__')).toEqual({ kind: 'unknown' })
  })
})

function syncedPlugin(batchDir: string, folder: string, manifest: unknown): string {
  const dir = join(batchDir, folder)
  json(join(dir, '.claude-plugin', 'plugin.json'), manifest)
  return dir
}

describe('account batches', () => {
  it('the highest generation of a folder wins; the id is the manifest name @synced, even for a UUID folder', () => {
    const root = tmp()
    const batch = join(root, `${ORG}_${ACC}`)
    syncedPlugin(batch, PLUGIN_UUID, { name: 'design' })
    syncedPlugin(batch, `${PLUGIN_UUID}~g3`, { name: 'design' })
    syncedPlugin(batch, `${PLUGIN_UUID}~g2`, { name: 'design' })
    syncedPlugin(batch, 'engineering~g2', { name: 'engineering' })
    const [b] = readAccountBatches(root)
    expect(b!.organizationUuid).toBe(ORG)
    expect(b!.accountUuid).toBe(ACC)
    expect(b!.plugins.map((p) => [p.id, p.generation, p.dir])).toEqual([
      ['design@synced', 3, join(batch, `${PLUGIN_UUID}~g3`)],
      ['engineering@synced', 2, join(batch, 'engineering~g2')],
    ])
  })

  it('unknown shapes are skipped: a batch name that is not two ids, a folder without a manifest or a name, a file, a broken manifest', () => {
    const root = tmp()
    syncedPlugin(join(root, 'not-a-batch'), 'p', { name: 'p' })
    syncedPlugin(join(root, `${ORG}_${ACC}_extra`), 'p', { name: 'p' })
    write(join(root, `${ORG}_${ACC2}`), 'a file, not a batch')
    const batch = join(root, `${ORG}_${ACC}`)
    mkdirSync(join(batch, 'empty'), { recursive: true })
    syncedPlugin(batch, 'nameless', { description: 'no name' })
    syncedPlugin(batch, 'numbered', { name: 7 })
    write(join(batch, 'broken', '.claude-plugin', 'plugin.json'), '{not json')
    write(join(batch, 'manifest.json'), '{"plugins":[]}')
    syncedPlugin(batch, 'good~g1', { name: 'good' })
    const batches = readAccountBatches(root)
    expect(batches.map((b) => b.accountUuid)).toEqual([ACC])
    expect(batches[0]!.plugins.map((p) => p.id)).toEqual(['good@synced'])
    expect(readAccountBatches(join(root, 'missing'))).toEqual([])
  })

  const batch = (accountUuid: string): AccountBatch => ({ dir: `/b/${accountUuid}`, organizationUuid: ORG, accountUuid, plugins: [] })

  it('matched by account id, exactly', () => {
    expect(
      matchBatches(
        [batch(ACC), batch(ACC2)],
        [
          { key: 'a', accountUuid: ACC2 },
          { key: 'b', accountUuid: ACC },
        ],
      ),
    ).toEqual([
      { login: 'b', by: 'account-id' },
      { login: 'a', by: 'account-id' },
    ])
  })

  it('by elimination when exactly one login and one batch remain', () => {
    expect(matchBatches([batch(ACC)], [{ key: 'a' }])).toEqual([{ login: 'a', by: 'elimination' }])
    expect(
      matchBatches(
        [batch(ACC), batch(ACC2)],
        [
          { key: 'a', accountUuid: ACC },
          { key: 'b', accountUuid: null },
        ],
      ),
    ).toEqual([
      { login: 'a', by: 'account-id' },
      { login: 'b', by: 'elimination' },
    ])
  })

  it('else left unmatched: two batches for one unknown login, a login whose recorded id has no batch', () => {
    expect(matchBatches([batch(ACC), batch(ACC2)], [{ key: 'a' }])).toEqual([null, null])
    expect(matchBatches([batch(ACC)], [{ key: 'a', accountUuid: ACC2 }])).toEqual([null])
    expect(matchBatches([batch(ACC)], [{ key: 'a' }, { key: 'b' }])).toEqual([null])
    expect(matchBatches([batch(ACC)], [])).toEqual([null])
  })
})

describe('plugin server entries', () => {
  it('an entry with no address is a placeholder, by structure — whatever its name', () => {
    const dir = tmp()
    json(join(dir, '.mcp.json'), {
      mcpServers: {
        gmail: { type: 'http', url: '' }, // named like a connector, no address
        'my tracker': { type: 'http' }, // any name, no address
        slack: { type: 'http', url: 'https://mcp.example.com/slack' },
        local: { command: 'node', args: ['server.js'] },
        junk: 'not an entry',
      },
    })
    expect(pluginServerEntries(dir, null).map((e) => [e.server, e.placeholder])).toEqual([
      ['gmail', true],
      ['local', false],
      ['my tracker', true],
      ['slack', false],
    ])
  })

  it("reads the manifest's mcpServers (a path or inline) before .mcp.json", () => {
    const dir = tmp()
    json(join(dir, '.mcp.json'), { mcpServers: { ignored: { url: 'https://example.com/a' } } })
    json(join(dir, 'servers.json'), { mcpServers: { viaPath: { url: 'https://example.com/b' } } })
    expect(pluginServerEntries(dir, { mcpServers: './servers.json' }).map((e) => e.server)).toEqual(['viaPath'])
    expect(pluginServerEntries(dir, { mcpServers: { inline: { command: 'x' } } }).map((e) => e.server)).toEqual(['inline'])
  })

  it('entries sharing an address are one server, under the first; placeholders and stdio share nothing', () => {
    const same = sameServerAs([
      { name: 'plugin:design:slack', url: 'https://mcp.example.com/slack' },
      { name: 'plugin:design:gmail', url: null },
      { name: 'plugin:engineering:slack', url: 'https://mcp.example.com/slack' },
      { name: 'plugin:engineering:gmail', url: null },
      { name: 'plugin:support:chat', url: 'https://mcp.example.com/slack' },
      { name: 'plugin:support:other', url: 'https://mcp.example.com/other' },
    ])
    expect([...same]).toEqual([
      ['plugin:engineering:slack', 'plugin:design:slack'],
      ['plugin:support:chat', 'plugin:design:slack'],
    ])
  })
})

describe('the one plugin resolver learns @synced ids and the origin key', () => {
  function setup(): {
    home: string
    folder: string
    paths: { userSettingsPath: string; installedPluginsPath: string; managedDir: string }
    synced: Map<string, string>
  } {
    const base = tmp()
    const home = join(base, 'home')
    const folder = join(home, 'work', 'proj')
    mkdirSync(folder, { recursive: true })
    const batch = join(home, '.claude', 'plugins', 'synced', `${ORG}_${ACC}`)
    const design = syncedPlugin(batch, PLUGIN_UUID, { name: 'design' })
    const quiet = syncedPlugin(batch, 'quiet', { name: 'quiet', defaultEnabled: false })
    return {
      home,
      folder,
      paths: {
        userSettingsPath: join(home, '.claude', 'settings.json'),
        installedPluginsPath: join(home, '.claude', 'plugins', 'installed_plugins.json'),
        managedDir: join(base, 'managed'),
      },
      synced: new Map([
        ['design@synced', design],
        ['quiet@synced', quiet],
      ]),
    }
  }

  it('no entry anywhere: on; the manifest defaultEnabled of the live copy; an explicit entry by precedence', () => {
    const s = setup()
    let r = pluginResolver(s.folder, s.paths, s.synced)
    expect(r.resolve('design@synced')).toEqual({ enabled: true, by: 'default' })
    expect(r.resolve('quiet@synced')).toEqual({ enabled: false, by: 'plugin-default' })
    json(join(s.folder, '.claude', 'settings.local.json'), { enabledPlugins: { 'design@synced': false, 'quiet@synced': true } })
    r = pluginResolver(s.folder, s.paths, s.synced)
    expect(r.resolve('design@synced')).toEqual({ enabled: false, by: 'local' })
    expect(r.resolve('quiet@synced')).toEqual({ enabled: true, by: 'local' })
  })

  it('syncClaudeAiPlugins: false hides every synced plugin — from managed, the local file or the user file, never the project file; only false counts', () => {
    const s = setup()
    json(join(s.folder, '.claude', 'settings.json'), { syncClaudeAiPlugins: false })
    expect(pluginResolver(s.folder, s.paths, s.synced).resolve('design@synced').enabled).toBe(true)
    json(join(s.folder, '.claude', 'settings.local.json'), { syncClaudeAiPlugins: true, enabledPlugins: { 'design@synced': true } })
    expect(pluginResolver(s.folder, s.paths, s.synced).resolve('design@synced')).toEqual({ enabled: true, by: 'local' })
    json(join(s.folder, '.claude', 'settings.local.json'), { syncClaudeAiPlugins: false, enabledPlugins: { 'design@synced': true } })
    expect(pluginResolver(s.folder, s.paths, s.synced).resolve('design@synced')).toEqual({ enabled: false, by: 'local', origin: true })
    json(join(s.folder, '.claude', 'settings.local.json'), {})
    json(s.paths.userSettingsPath, { syncClaudeAiPlugins: false })
    expect(pluginResolver(s.folder, s.paths, s.synced).resolve('design@synced')).toEqual({ enabled: false, by: 'user', origin: true })
    json(join(s.paths.managedDir, 'managed-settings.json'), { syncClaudeAiPlugins: false })
    expect(pluginResolver(s.folder, s.paths, s.synced).resolve('design@synced')).toEqual({ enabled: false, by: 'managed', origin: true })
    // an installed plugin is not the origin's
    expect(pluginResolver(s.folder, s.paths, s.synced).resolve('stripe@market').enabled).toBe(true)
  })

  it('plugin keys are data: __proto__ and constructor resolve like any other key', () => {
    const s = setup()
    json(s.paths.userSettingsPath, { enabledPlugins: JSON.parse('{"__proto__": false, "constructor": false}') })
    const r = pluginResolver(s.folder, s.paths, s.synced)
    expect(r.resolve('__proto__')).toEqual({ enabled: false, by: 'user' })
    expect(r.resolve('constructor')).toEqual({ enabled: false, by: 'user' })
    expect(r.resolve('toString')).toEqual({ enabled: true, by: 'default' })
  })
})
