// loads-inventory.test.ts — Claude Code's Harness.loads.inventory
// (harnesses/claude-code/loads/inventory.ts): every kind a project's Tools
// lists yields its row with its origin, its state and the file that decides
// it across the settings layers; a managed row has no switch; a name only a
// reading knows is an observed row whose origin is the reading's source; a
// tool-name id no known name has is a row with no switch; a placeholder is
// never a failure; of two copies of one plugin the one a reading names
// loads, else the installed one when it is on; what a plugin carries is read
// from its manifest and folders and remembered until its tree moves.
// Temp dirs only — generic fixtures.
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeLoadsInventory } from '../src/harnesses/claude-code/loads/inventory.js'
import { carriesOf } from '../src/harnesses/claude-code/loads/carries.js'
import type { LoadsInput, LoadsRow } from '../src/harnesses/contract.js'
import { statusServers } from '../src/harnesses/claude-code/turn-status.js'
import { ToolHealthLedger, asLoadsReadings, withHealth } from '../src/tool-health.js'

const ORG = '00000000-0000-4000-8000-00000000000a'
const ACC = '00000000-0000-4000-8000-00000000000b'
const EMAIL = 'sam@example.com'

const write = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const json = (path: string, v: unknown): void => write(path, JSON.stringify(v))

let base: string, home: string, folder: string, managed: string, transcript: string
const claude = (...p: string[]): string => join(home, '.claude', ...p)

function installed(id: string, manifest: Record<string, unknown> = {}, extra: (dir: string) => void = () => {}): string {
  const dir = join(base, 'cache', id.replace('@', '-'))
  json(join(dir, '.claude-plugin', 'plugin.json'), { name: id.split('@')[0], ...manifest })
  extra(dir)
  return dir
}
function setInstalled(map: Record<string, string>): void {
  json(claude('plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: Object.fromEntries(Object.entries(map).map(([k, dir]) => [k, [{ scope: 'user', installPath: dir, version: '1.0.0' }]])),
  })
}
function synced(folderName: string, manifest: Record<string, unknown>): string {
  const dir = claude('plugins', 'synced', `${ORG}_${ACC}`, folderName)
  json(join(dir, '.claude-plugin', 'plugin.json'), manifest)
  return dir
}
const input = (over: Partial<LoadsInput> = {}): LoadsInput => ({
  folder,
  home,
  managedDir: managed,
  recentTranscripts: [transcript],
  seenToolIds: [],
  readings: [],
  ...over,
})
const rowsOf = (over: Partial<LoadsInput> = {}): LoadsRow[] => claudeLoadsInventory(input(over)).rows
const byKey = (rows: LoadsRow[], key: string): LoadsRow | undefined => rows.find((r) => r.key === key)
const local = (v: unknown): void => json(join(folder, '.claude', 'settings.local.json'), v)
const project = (v: unknown): void => json(join(folder, '.claude', 'settings.json'), v)
const user = (v: unknown): void => json(claude('settings.json'), v)

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'loads-inv-'))
  home = join(base, 'home')
  folder = join(base, 'proj')
  managed = join(base, 'managed')
  mkdirSync(folder, { recursive: true })
  mkdirSync(managed, { recursive: true })
  mkdirSync(claude('plugins'), { recursive: true })
  // a start in the folder recorded its login
  transcript = join(base, 't.jsonl')
  write(
    transcript,
    [
      JSON.stringify({ type: 'attachment', attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${EMAIL}.` } } }),
      JSON.stringify({ type: 'session-owner', accountUuid: ACC, organizationUuid: ORG, sessionId: 's1' }),
    ].join('\n') + '\n',
  )
})

describe('every kind yields its row — origin, state, the deciding file', () => {
  it("an installed plugin: on by no entry, off in each layer named, off by its manifest with today's switch", () => {
    setInstalled({
      'alpha@market': installed('alpha@market'),
      'beta@market': installed('beta@market'),
      'gamma@market': installed('gamma@market'),
      'delta@market': installed('delta@market', { defaultEnabled: false }),
    })
    user({ enabledPlugins: { 'beta@market': false } })
    project({ enabledPlugins: { 'gamma@market': false } })
    const rows = rowsOf()
    expect(byKey(rows, 'plugin:alpha@market')).toMatchObject({
      kind: 'plugin',
      name: 'alpha@market',
      origin: { owner: 'you', carrier: 'alpha plugin' },
      state: 'active',
      switch: { names: ['alpha@market'] },
      detail: '1.0.0',
    })
    expect(byKey(rows, 'plugin:beta@market')).toMatchObject({
      state: 'held',
      decidedBy: { file: '~/.claude/settings.json', key: 'enabledPlugins.beta@market' },
    })
    // an override kind: the project turns it on over the machine's «off»
    expect(byKey(rows, 'plugin:beta@market')?.switch).toEqual({ names: ['beta@market'] })
    expect(byKey(rows, 'plugin:gamma@market')).toMatchObject({ state: 'held', decidedBy: { file: '.claude/settings.json' } })
    expect(byKey(rows, 'plugin:delta@market')).toMatchObject({ state: 'held', decidedBy: { key: 'defaultEnabled' }, switch: { names: [expect.any(String)] } })
    // the project's own local file decides: no deciding file named, the switch stays
    local({ enabledPlugins: { 'alpha@market': false } })
    const off = byKey(rowsOf(), 'plugin:alpha@market')
    expect(off).toMatchObject({ state: 'held', switch: { names: [expect.any(String)] } })
    expect(off?.decidedBy).toBeUndefined()
  })

  it('a plugin the Claude account sends: its login named; off by the origin key is «available», in each layer', () => {
    synced('design~g2', { name: 'design', mcpServers: { files: { type: 'http', url: 'https://files.example.com/mcp' } } })
    let rows = rowsOf()
    const plugin = byKey(rows, `plugin:${ACC}:design@synced`)
    expect(plugin).toMatchObject({
      kind: 'plugin',
      name: 'design@synced',
      origin: { owner: 'account', carrier: 'design plugin', login: EMAIL },
      state: 'active',
    })
    expect(plugin?.switch).toEqual({ names: ['design@synced'] }) // by its manifest name, @synced
    expect(byKey(rows, `server:${ACC}:design@synced:files`)).toMatchObject({
      kind: 'mcp',
      name: 'plugin:design:files',
      parent: plugin!.key,
      origin: { owner: 'account', login: EMAIL },
      state: 'active',
    })
    user({ syncClaudeAiPlugins: false })
    rows = rowsOf()
    expect(byKey(rows, plugin!.key)).toMatchObject({ state: 'available', decidedBy: { file: '~/.claude/settings.json', key: 'syncClaudeAiPlugins' } })
    expect(byKey(rows, `server:${ACC}:design@synced:files`)).toMatchObject({ state: 'available' })
    // the project's .claude/settings.json is not read for it (the schema's words)
    user({})
    project({ syncClaudeAiPlugins: false })
    expect(byKey(rowsOf(), plugin!.key)).toMatchObject({ state: 'active' })
    // the local file: the project's own choice, no deciding file named
    local({ syncClaudeAiPlugins: false })
    const here = byKey(rowsOf(), plugin!.key)
    expect(here).toMatchObject({ state: 'available' })
    expect(here?.decidedBy).toBeUndefined()
    // a batch no start's login matches says so
    const unmatched = rowsOf({ recentTranscripts: [] })
    expect(byKey(unmatched, plugin!.key)?.origin).toMatchObject({ owner: 'account', login: null, unmatched: true })
  })

  it("a plugin's MCP servers: a row each under it, denied by name in a layer that is named", () => {
    setInstalled({
      'tools@market': installed('tools@market', {
        mcpServers: { search: { type: 'http', url: 'https://search.example.com' }, local: { command: 'tool-mcp' } },
      }),
    })
    project({ deniedMcpServers: [{ serverName: 'plugin:tools:search' }] })
    const rows = rowsOf()
    expect(byKey(rows, 'server:tools@market:search')).toMatchObject({
      name: 'plugin:tools:search',
      parent: 'plugin:tools@market',
      origin: { owner: 'you', carrier: 'tools plugin' },
      state: 'held',
      decidedBy: { file: '.claude/settings.json', key: 'deniedMcpServers' },
      detail: 'https://search.example.com',
    })
    expect(byKey(rows, 'server:tools@market:local')).toMatchObject({ state: 'active', detail: 'tool-mcp' })
  })

  it('placeholders and one address said in place; a placeholder points at the connector of its name', () => {
    setInstalled({
      'one@market': installed('one@market', { mcpServers: { mail: { type: 'http', url: '' }, docs: { type: 'http', url: 'https://docs.example.com/mcp' } } }),
      'two@market': installed('two@market', { mcpServers: { docs: { type: 'http', url: 'https://docs.example.com/mcp' } } }),
    })
    let rows = rowsOf()
    expect(byKey(rows, 'server:one@market:mail')).toMatchObject({ placeholder: {} })
    expect(byKey(rows, 'server:two@market:docs')).toMatchObject({ sameAs: 'server:one@market:docs' })
    expect(byKey(rows, 'server:one@market:docs')?.sameAs).toBeUndefined()
    rows = rowsOf({ readings: [{ at: 1, login: EMAIL, servers: [{ name: 'claude.ai Mail', status: 'connected', source: 'claudeai' }] }] })
    const connector = rows.find((r) => r.kind === 'connector')!
    expect(connector).toMatchObject({
      name: 'claude.ai Mail',
      label: 'Mail',
      origin: { owner: 'account', carrier: 'connector', login: EMAIL },
      state: 'active',
      exact: true,
    })
    expect(byKey(rows, 'server:one@market:mail')).toMatchObject({ placeholder: { connector: connector.key } })
  })

  it("the project's .mcp.json servers and your ~/.claude.json ones, held where each file says", () => {
    json(join(folder, '.mcp.json'), {
      mcpServers: { github: { type: 'http', url: 'https://gh.example.com' }, db: { command: 'db-mcp' }, files: { command: 'f' } },
    })
    project({ disabledMcpjsonServers: ['db'] })
    local({ disabledMcpjsonServers: ['files'] })
    json(join(home, '.claude.json'), {
      mcpServers: { linear: { url: 'https://linear.example.com' } },
      projects: { [folder]: { mcpServers: { grafana: { command: 'g' } }, disabledMcpServers: ['grafana'] } },
    })
    const rows = rowsOf()
    expect(byKey(rows, 'mcp:project:github')).toMatchObject({
      origin: { owner: 'project', carrier: '.mcp.json' },
      state: 'active',
      switch: { names: ['github'] },
    })
    expect(byKey(rows, 'mcp:project:db')).toMatchObject({ state: 'held', decidedBy: { file: '.claude/settings.json', key: 'disabledMcpjsonServers' } })
    expect(byKey(rows, 'mcp:project:db')?.switch).toBeUndefined()
    expect(byKey(rows, 'mcp:project:files')).toMatchObject({ state: 'held', switch: { names: ['files'] } })
    expect(byKey(rows, 'mcp:user:linear')).toMatchObject({ origin: { owner: 'you', carrier: '~/.claude.json' }, state: 'active' })
    expect(byKey(rows, 'mcp:user:linear')?.switch).toEqual({ names: ['linear'] }) // denied by name in the local file; ~/.claude.json is read, never written
    expect(byKey(rows, 'mcp:local:grafana')).toMatchObject({ state: 'held', decidedBy: { file: '~/.claude.json', key: 'disabledMcpServers' } })
  })

  it('a connector: off by the origin key in any layer is «available», the file named', () => {
    const reading = { at: 1, login: EMAIL, servers: [{ name: 'claude.ai Calendar', status: 'connected', source: 'claudeai' }] }
    user({ disableClaudeAiConnectors: true })
    const row = rowsOf({ readings: [reading] }).find((r) => r.kind === 'connector')
    expect(row).toMatchObject({ state: 'available', decidedBy: { file: '~/.claude/settings.json', key: 'disableClaudeAiConnectors' } })
  })
})

describe('managed settings', () => {
  it('a plugin the organization switches on or off has no switch and names managed settings', () => {
    setInstalled({ 'on@market': installed('on@market'), 'off@market': installed('off@market') })
    json(join(managed, 'managed-settings.json'), { enabledPlugins: { 'on@market': true, 'off@market': false } })
    local({ enabledPlugins: { 'on@market': false, 'off@market': true } })
    const rows = rowsOf()
    expect(byKey(rows, 'plugin:on@market')).toMatchObject({ state: 'active', decidedBy: { file: 'managed settings' } })
    expect(byKey(rows, 'plugin:off@market')).toMatchObject({ state: 'held', decidedBy: { file: 'managed settings' } })
    expect(byKey(rows, 'plugin:on@market')?.switch).toBeUndefined()
    expect(byKey(rows, 'plugin:off@market')?.switch).toBeUndefined()
  })
})

describe('observed rows — what was seen loading and is not on disk', () => {
  it("a name only a reading knows: its origin from the reading's source, exact", () => {
    const rows = rowsOf({
      readings: [
        {
          at: 1,
          login: EMAIL,
          servers: [
            { name: 'shared-db', status: 'connected', source: 'project' },
            { name: 'plugin:gone:thing', status: 'connected', source: 'plugin' },
            { name: 'claude.ai Drive', status: 'needs-auth', source: 'claudeai' },
          ],
        },
      ],
    })
    expect(byKey(rows, 'seen:shared-db')).toMatchObject({ exact: true, observed: { from: 'reading' }, origin: { owner: 'project' } })
    expect(byKey(rows, 'seen:plugin:gone:thing')).toMatchObject({ exact: true, observed: { from: 'reading' }, origin: { owner: null, carrier: 'a plugin' } })
    expect(rows.find((r) => r.name === 'claude.ai Drive')).toMatchObject({ kind: 'connector', origin: { owner: 'account', login: EMAIL } })
  })

  it('a name only a tool id knows: a row with no switch, never turned back into a name', () => {
    json(join(folder, '.mcp.json'), { mcpServers: { 'my.server': { command: 'x' } } })
    const rows = rowsOf({
      seenToolIds: ['claude_ai_Google_Drive', 'my_server', 'plugin_builder_notes', 'plugin_other_thing'],
      agentServers: [{ agent: 'builder', servers: ['notes'] }],
    })
    // a known name's id is that row, not another
    expect(rows.filter((r) => r.name === 'my_server')).toEqual([])
    // the agent's own server is its page's, not a row here
    expect(rows.find((r) => r.name === 'plugin_builder_notes')).toBeUndefined()
    const drive = byKey(rows, 'seen:claude_ai_Google_Drive')!
    expect(drive).toMatchObject({
      kind: 'connector',
      name: 'claude_ai_Google_Drive',
      exact: false,
      observed: { from: 'tool-id' },
      origin: { owner: 'account', login: null },
    })
    expect(drive.switch).toBeUndefined()
    expect(byKey(rows, 'seen:plugin_other_thing')).toMatchObject({ exact: false, origin: { owner: null } })
    expect(byKey(rows, 'seen:plugin_other_thing')?.switch).toBeUndefined()
  })

  it("a placeholder is never a failure: a reading's «failed» for it adds no row and changes nothing", () => {
    setInstalled({ 'one@market': installed('one@market', { mcpServers: { mail: { type: 'http' } } }) })
    const rows = rowsOf({ readings: [{ at: 1, login: EMAIL, servers: [{ name: 'plugin:one:mail', status: 'failed', source: 'plugin' }] }] })
    const mine = rows.filter((r) => r.name === 'plugin:one:mail')
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ placeholder: {}, state: 'active' })
    expect(mine[0]!.observed).toBeUndefined()
  })
})

describe('two copies of one plugin', () => {
  beforeEach(() => {
    setInstalled({ 'design@market': installed('design@market', { mcpServers: { files: { command: 'f' } } }) })
    synced('design', { name: 'design', mcpServers: { files: { command: 'f' }, chat: { url: 'https://chat.example.com' } } })
  })

  it('no reading: the installed copy loads when it is on, the account copy says it takes its place', () => {
    const rows = rowsOf()
    expect(byKey(rows, 'plugin:design@market')?.replacedBy).toBeUndefined()
    expect(byKey(rows, `plugin:${ACC}:design@synced`)).toMatchObject({ replacedBy: 'plugin:design@market' })
    expect(byKey(rows, `server:${ACC}:design@synced:chat`)).toMatchObject({ replacedBy: 'plugin:design@market' })
    // the installed copy off: the account's loads
    local({ enabledPlugins: { 'design@market': false } })
    const off = rowsOf()
    expect(byKey(off, `plugin:${ACC}:design@synced`)?.replacedBy).toBeUndefined()
  })

  it('a reading that names a server only the account copy declares: that copy is live', () => {
    const rows = rowsOf({ readings: [{ at: 1, login: EMAIL, servers: [{ name: 'plugin:design:chat', status: 'connected', source: 'plugin' }] }] })
    expect(byKey(rows, `plugin:${ACC}:design@synced`)?.replacedBy).toBeUndefined()
    expect(byKey(rows, 'plugin:design@market')).toMatchObject({ replacedBy: `plugin:${ACC}:design@synced` })
    // the server it named is a known row, not an observed one
    expect(rows.filter((r) => r.name === 'plugin:design:chat')).toHaveLength(1)
  })

  it('real status rows, kept by the ledger, decide the same: the copy whose own server is listed is live', () => {
    const ledger = new ToolHealthLedger(join(base, 'tool-health'))
    ledger.record({
      folder,
      conversation: 'c1',
      turnId: 't1',
      agentId: 'builder',
      login: EMAIL,
      via: 'chat',
      connectorsOn: true,
      servers: statusServers([
        {
          name: 'plugin:design:files',
          status: 'connected',
          source: 'plugin',
          scope: 'dynamic',
          config: { type: 'stdio', command: 'f' },
          tools: [{ name: 'list' }],
        },
        { name: 'plugin:design:chat', status: 'needs-auth', source: 'plugin', scope: 'dynamic', config: { type: 'http', url: 'https://chat.example.com' } },
      ]),
    })
    const rows = rowsOf({ readings: asLoadsReadings(ledger.readings(folder)) })
    expect(byKey(rows, `plugin:${ACC}:design@synced`)?.replacedBy).toBeUndefined()
    expect(byKey(rows, 'plugin:design@market')).toMatchObject({ replacedBy: `plugin:${ACC}:design@synced` })
    expect(withHealth(rows, ledger.readings(folder)).find((r) => r.key === `server:${ACC}:design@synced:chat`)?.health?.status).toBe('needs-auth')
  })
})

describe('what a plugin carries', () => {
  it('skills, commands, subagent types, hooks by event, servers and placeholders, LSP servers, output styles — remembered until the tree moves', () => {
    const dir = installed('kit@market', { mcpServers: { a: { command: 'a' }, b: { url: '' } }, commands: './extra' }, (d) => {
      write(join(d, 'skills', 'write', 'SKILL.md'), '# s')
      write(join(d, 'skills', 'review', 'SKILL.md'), '# s')
      write(join(d, 'commands', 'ship.md'), '# c')
      write(join(d, 'extra', 'tidy.md'), '# c')
      write(join(d, 'agents', 'planner.md'), '# a')
      json(join(d, 'hooks', 'hooks.json'), {
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }],
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'y' },
                { type: 'command', command: 'z' },
              ],
            },
          ],
        },
      })
      json(join(d, '.lsp.json'), { go: { command: 'gopls' } })
      write(join(d, 'output-styles', 'terse.md'), '# o')
    })
    expect(carriesOf(dir)).toEqual({
      skills: ['review', 'write'],
      commands: ['ship', 'tidy'],
      agents: ['planner'],
      hooks: { count: 3, events: ['PreToolUse', 'SessionStart'] },
      mcp: 1,
      placeholders: 1,
      lsp: ['go'],
      outputStyles: ['terse'],
    })
    setInstalled({ 'kit@market': dir })
    expect(byKey(rowsOf(), 'plugin:kit@market')?.carries?.skills).toEqual(['review', 'write'])
    // a new skill moves the skills folder's stamp: read again
    write(join(dir, 'skills', 'plan', 'SKILL.md'), '# s')
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(dir, 'skills'), later, later)
    expect(carriesOf(dir).skills).toEqual(['plan', 'review', 'write'])
  })
})

// «Where it loads» (spec scopes §2, §7, T2): one line per place and per
// fact, broadest first, each with its own entry, the result there and what
// locks it — override kinds decided by the narrowest entry, off-only kinds
// off by any; the agents' lines follow the project (Silos keeps no entry yet).
describe('where it loads — the places on every row', () => {
  const carried = {
    agents: [
      { id: 'builder', payload: null },
      { id: 'writer', payload: null },
    ],
  }
  const at =
    (over: Partial<LoadsInput> = {}) =>
    (key: string) =>
      byKey(rowsOf({ carried, ...over }), key)?.at ?? []
  const line = (lines: NonNullable<LoadsRow['at']>, place: string, extra: { agent?: string; who?: string } = {}) =>
    lines.find((l) => l.place === place && (extra.agent === undefined || l.agent === extra.agent) && (extra.who === undefined || l.fact?.who === extra.who))
  const userServer = (servers: Record<string, unknown>, projects: Record<string, unknown> = {}): void =>
    json(join(home, '.claude.json'), { mcpServers: servers, projects })

  it('a plugin (override): the narrowest entry decides, either way — no line is locked by a wider «off»', () => {
    setInstalled({ 'alpha@market': installed('alpha@market'), 'beta@market': installed('beta@market'), 'gamma@market': installed('gamma@market') })
    user({ enabledPlugins: { 'alpha@market': false, 'beta@market': false, 'gamma@market': true } })
    project({ enabledPlugins: { 'beta@market': true } })
    local({ enabledPlugins: { 'alpha@market': true, 'gamma@market': false } })
    const a = at()('plugin:alpha@market')
    expect(byKey(rowsOf({ carried }), 'plugin:alpha@market')?.family).toBe('override')
    expect(line(a, 'machine')).toMatchObject({ entry: 'off', result: 'off', keptIn: '~/.claude/settings.json' })
    expect(line(a, 'project')).toMatchObject({ entry: 'on', result: 'on', keptIn: '.claude/settings.local.json' })
    expect(line(a, 'project')?.locked).toBeUndefined()
    expect(line(a, 'agent', { agent: 'builder' })).toMatchObject({ result: 'on' })
    expect(line(a, 'agent', { agent: 'builder' })?.entry).toBeUndefined()
    // the repository's file turns it on over the machine's «off»
    const b = at()('plugin:beta@market')
    expect(line(b, 'fact', { who: 'repository' })).toMatchObject({
      entry: 'on',
      result: 'on',
      fact: { file: '.claude/settings.json', key: 'enabledPlugins.beta@market' },
    })
    expect(line(b, 'project')).toMatchObject({ result: 'on' })
    // the project turns it off under a machine «on»; every agent follows
    const g = at()('plugin:gamma@market')
    expect(line(g, 'machine')).toMatchObject({ entry: 'on', result: 'on' })
    expect(line(g, 'project')).toMatchObject({ entry: 'off', result: 'off' })
    expect(line(g, 'agent', { agent: 'writer' })).toMatchObject({ result: 'off' })
    expect(line(g, 'agent', { agent: 'writer' })?.locked).toBeUndefined()
  })

  it('a row the user file decides has a machine line with its entry, the project following it', () => {
    setInstalled({ 'alpha@market': installed('alpha@market') })
    user({ enabledPlugins: { 'alpha@market': false } })
    const a = at()('plugin:alpha@market')
    expect(line(a, 'machine')).toMatchObject({ entry: 'off', result: 'off' })
    expect(line(a, 'project')).toMatchObject({ result: 'off' })
    expect(line(a, 'project')?.entry).toBeUndefined()
    expect(a.map((l) => l.place)).toEqual(['machine', 'project', 'agent', 'agent'])
  })

  it('managed settings decide a plugin: a fact on top, every other line locked by the organization', () => {
    setInstalled({ 'alpha@market': installed('alpha@market') })
    json(join(managed, 'managed-settings.json'), { enabledPlugins: { 'alpha@market': false } })
    local({ enabledPlugins: { 'alpha@market': true } })
    const a = at()('plugin:alpha@market')
    expect(a[0]).toMatchObject({ place: 'fact', fact: { who: 'organization', file: 'managed settings' }, entry: 'off', result: 'off' })
    for (const l of a.slice(1)) expect(l).toMatchObject({ result: 'off', locked: { why: 'organization' } })
  })

  it('a plugin that starts off by its manifest: a default fact the machine line follows', () => {
    setInstalled({ 'delta@market': installed('delta@market', { defaultEnabled: false }) })
    const d = at()('plugin:delta@market')
    expect(line(d, 'fact', { who: 'default' })).toMatchObject({ entry: 'off', fact: { key: 'defaultEnabled' } })
    expect(line(d, 'machine')).toMatchObject({ result: 'off' })
    expect(line(d, 'machine')?.locked).toBeUndefined()
  })

  it('an account plugin: its door line first; the origin head off on the machine locks the narrower lines (off-only)', () => {
    synced('demo', { name: 'demo' })
    user({ syncClaudeAiPlugins: false })
    local({ enabledPlugins: { 'demo@synced': true } })
    const d = at()(`plugin:${ACC}:demo@synced`)
    expect(d[0]).toMatchObject({ place: 'account', door: { where: 'claude.ai' } })
    expect(line(d, 'machine')).toMatchObject({ entry: 'off', result: 'off' })
    expect(line(d, 'project')).toMatchObject({ entry: 'on', result: 'off', locked: { why: 'wider', at: 'machine' } })
  })

  it('a server of yours (off-only): off at any place is off — a wider «off» locks every narrower line', () => {
    userServer({ mine: { command: 'mine' }, other: { command: 'other' } })
    user({ deniedMcpServers: [{ serverName: 'mine' }] })
    local({ deniedMcpServers: [{ serverName: 'other' }] })
    const m = at()('mcp:user:mine')
    expect(byKey(rowsOf({ carried }), 'mcp:user:mine')?.family).toBe('off-only')
    expect(line(m, 'machine')).toMatchObject({ entry: 'off', result: 'off' })
    expect(line(m, 'project')).toMatchObject({ result: 'off', locked: { why: 'wider', at: 'machine' } })
    expect(line(m, 'agent', { agent: 'builder' })).toMatchObject({ result: 'off', locked: { why: 'wider', at: 'machine' } })
    const o = at()('mcp:user:other')
    expect(line(o, 'machine')).toMatchObject({ result: 'on' })
    expect(line(o, 'project')).toMatchObject({ entry: 'off', result: 'off' })
    expect(line(o, 'project')?.locked).toBeUndefined()
    expect(line(o, 'agent', { agent: 'writer' })).toMatchObject({ locked: { why: 'wider', at: 'project' } })
  })

  it('a server of the project (.mcp.json): no machine line until the user file holds it; the repository and managed as facts', () => {
    json(join(folder, '.mcp.json'), { mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' } } })
    project({ disabledMcpjsonServers: ['a'] })
    user({ disabledMcpjsonServers: ['b'] })
    json(join(managed, 'managed-settings.json'), { deniedMcpServers: [{ serverName: 'c' }] })
    const a = at()('mcp:project:a')
    expect(line(a, 'machine')).toBeUndefined()
    expect(line(a, 'fact', { who: 'repository' })).toMatchObject({ entry: 'off', result: 'off', fact: { key: 'disabledMcpjsonServers' } })
    expect(line(a, 'project')).toMatchObject({ result: 'off', locked: { why: 'wider', at: 'fact' } })
    const b = at()('mcp:project:b')
    expect(line(b, 'machine')).toMatchObject({ entry: 'off', result: 'off' })
    expect(line(b, 'project')).toMatchObject({ locked: { why: 'wider', at: 'machine' } })
    const c = at()('mcp:project:c')
    expect(c[0]).toMatchObject({ place: 'fact', fact: { who: 'organization', key: 'deniedMcpServers' }, result: 'off' })
    expect(line(c, 'project')).toMatchObject({ locked: { why: 'organization' } })
  })

  it("the per-project server of ~/.claude.json has no machine line; the engine's own toggle is a fact", () => {
    userServer({}, { [folder]: { mcpServers: { here: { command: 'h' }, quiet: { command: 'q' } }, disabledMcpServers: ['quiet'] } })
    const h = at()('mcp:local:here')
    expect(line(h, 'machine')).toBeUndefined()
    expect(line(h, 'project')).toMatchObject({ result: 'on' })
    const q = at()('mcp:local:quiet')
    expect(line(q, 'machine')).toBeUndefined()
    expect(line(q, 'fact', { who: 'engine' })).toMatchObject({ result: 'off', fact: { file: '~/.claude.json', key: 'disabledMcpServers' } })
    expect(line(q, 'project')).toMatchObject({ locked: { why: 'wider', at: 'fact' } })
  })

  it("a plugin's server: its own deny by place, and off wherever its plugin's line is off", () => {
    setInstalled({ 'alpha@market': installed('alpha@market', { mcpServers: { s: { command: 's' } } }) })
    local({ enabledPlugins: { 'alpha@market': false } })
    const lines = at()('server:alpha@market:s')
    expect(line(lines, 'machine')).toMatchObject({ result: 'on' })
    expect(line(lines, 'project')).toMatchObject({ result: 'off' })
    expect(line(lines, 'project')?.entry).toBeUndefined()
  })

  it("a connector: the account's door with its page; its head off in any file locks the narrower lines", () => {
    const reading = { at: 1, login: EMAIL, servers: [{ name: 'claude.ai Drive', status: 'connected', source: 'claudeai' }] }
    project({ disableClaudeAiConnectors: true })
    const c = at({ readings: [reading] })(`connector:${EMAIL}:claude.ai Drive`)
    expect(c[0]).toMatchObject({ place: 'account', door: { url: 'https://claude.ai/settings/connectors', login: EMAIL } })
    expect(line(c, 'machine')).toMatchObject({ result: 'on' })
    expect(line(c, 'fact', { who: 'repository' })).toMatchObject({ entry: 'off', fact: { key: 'disableClaudeAiConnectors' } })
    expect(line(c, 'project')).toMatchObject({ result: 'off', locked: { why: 'wider', at: 'fact' } })
  })

  it("a server the organization provides: an entry in the project's files locks only its project line", () => {
    json(join(managed, 'managed-mcp.json'), { mcpServers: { corp: { url: 'https://corp.example/mcp' }, gone: { url: 'https://gone.example/mcp' } } })
    local({ deniedMcpServers: [{ serverName: 'corp' }] })
    user({ deniedMcpServers: [{ serverName: 'gone' }] })
    const rows = rowsOf({ carried })
    expect(byKey(rows, 'mcp:managed:corp')).toMatchObject({ state: 'active', family: 'off-only' })
    const c = byKey(rows, 'mcp:managed:corp')!.at!
    expect(line(c, 'project')).toMatchObject({ entry: 'off', result: 'on', locked: { why: 'provided' } })
    expect(line(c, 'machine')?.locked).toBeUndefined()
    expect(line(c, 'agent', { agent: 'builder' })?.locked).toBeUndefined()
    const g = byKey(rows, 'mcp:managed:gone')!
    expect(g.state).toBe('held')
    expect(line(g.at!, 'machine')).toMatchObject({ entry: 'off', result: 'off' })
    expect(line(g.at!, 'project')).toMatchObject({ result: 'off', locked: { why: 'wider', at: 'machine' } })
  })

  it('no carried agents: no agent line; a row known only by its tool id has no line', () => {
    userServer({ mine: { command: 'mine' } })
    const rows = rowsOf({ seenToolIds: ['zz_unknown'] })
    expect(byKey(rows, 'mcp:user:mine')!.at!.map((l) => l.place)).toEqual(['machine', 'project'])
    expect(byKey(rows, 'seen:zz_unknown')?.at).toBeUndefined()
  })

  it("a plugin's or a server's name is data — __proto__ and constructor are names like any other", () => {
    setInstalled({ 'constructor@market': installed('constructor@market') })
    write(join(home, '.claude.json'), '{"mcpServers":{"__proto__":{"command":"p"},"constructor":{"command":"c"}}}')
    write(claude('settings.json'), '{"deniedMcpServers":[{"serverName":"__proto__"}],"enabledPlugins":{"__proto__":false}}')
    const rows = rowsOf({ carried })
    const k = byKey(rows, 'plugin:constructor@market')!.at!
    expect(line(k, 'machine')?.entry).toBeUndefined()
    expect(line(k, 'project')).toMatchObject({ result: 'on' })
    expect(line(byKey(rows, 'mcp:user:__proto__')!.at!, 'machine')).toMatchObject({ entry: 'off', result: 'off' })
    const c = byKey(rows, 'mcp:user:constructor')!.at!
    expect(line(c, 'machine')?.entry).toBeUndefined()
    expect(line(c, 'project')).toMatchObject({ result: 'on' })
  })
})
