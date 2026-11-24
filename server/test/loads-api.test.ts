// loads-api.test.ts — GET /api/folders/:folder/loads (folder-loads.ts over
// each engine's Harness.loads) and the switches Silos already had
// (POST …/loads/switch, the engine's one writer): the folder allowlist
// (managed folders only — never an arbitrary path from the request), the
// hold/activate round trip read back through the inventory, the owner-only
// boundary, and an engine without `loads` answering no rows. Temp dirs only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { buildServer } from '../src/server.js'
import { ToolHealthLedger } from '../src/tool-health.js'
import { LoadsScopesStore } from '../src/loads-scopes.js'
import { setSealHooks } from '../src/seal-hooks.js'
let scopes: LoadsScopesStore
import { LineageStore } from '../src/lineage.js'
let lineage: LineageStore
let ledger: ToolHealthLedger
import type { LoadsRow } from '../src/harnesses/contract.js'
import { registerHarness } from '../src/harnesses/registry.js'
import { makeFakeHarness } from './fixtures/fake-harness.js'
import { asOwner } from './helpers/owner.js'
import { AccountsService } from '../src/harnesses/claude-code/accounts.js'
import { fakeIdentity } from './helpers/fake-claude-auth.js'
import type { QueryArgs, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

const LOCAL = { host: '127.0.0.1:3210' }
// «Check now»'s engine query: a fake the test sets (never the real SDK)
let checkQuery: (a: QueryArgs) => SdkQueryHandle = () => {
  throw new Error('no check expected')
}
let idx: ReturnType<typeof claudeSessionIndex>
let app: FastifyInstance, tokens: AgentTokens, folder: string, home: string, registry: AgentRegistry, base: string
let makeApp: (extra?: Partial<Parameters<typeof buildServer>[0]>) => FastifyInstance

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-mcp-api-'))
  const root = join(base, 'projects')
  home = join(base, 'home')
  folder = join(base, 'proj')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://gh.example' } } }))
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 1, plugins: { 'team-plan@silos': [{ installPath: '/x' }] } }),
  )
  // installed and switched on explicitly (no entry would be on too — the engine's default)
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'team-plan@silos': true } }))
  const index = (idx = claudeSessionIndex(root, join(base, 'data', 'cache.json')))
  await index.init()
  registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder })
  tokens = new AgentTokens(join(base, 'data'))
  makeApp = (extra = {}) =>
    buildServer({
      ...extra,
      index,
      registry,
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat: new ChatService({
        registry,
        native: new NativeStore(join(base, 'data', 'native2.json')),
        queryFn: () => {
          throw new Error('no sdk')
        },
      }),
      store: new SessionStore(root, join(base, 'data')),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      token: 't0k',
      liveMs: 120_000,
      agentTokens: tokens,
      home,
      accountPath: join(home, '.claude.json'),
      claudeSettingsPath: join(home, '.claude', 'settings.json'),
      claudeManagedDir: join(base, 'managed'),
      toolHealth: (ledger = new ToolHealthLedger(join(base, 'data', 'tool-health'))),
      checkQueryFn: (a) => checkQuery(a),
      loadsScopes: (scopes = new LoadsScopesStore(join(base, 'data'))),
      lineage: (lineage = new LineageStore(join(base, 'data', 'lineage.json'))),
    })
  app = makeApp()
  asOwner(app, 't0k')
})
afterEach(async () => {
  await app.close()
})

const get = (url: string, headers: Record<string, string> = LOCAL) => app.inject({ method: 'GET', url, headers })
const post = (url: string, payload: unknown, headers: Record<string, string> = LOCAL) => app.inject({ method: 'POST', url, headers, payload: payload as never })
const key = () => mungePath(folder)
type Loads = { folder: string; rows: LoadsRow[]; engines: { id: string }[] }
const loads = async (): Promise<Loads> => (await get(`/api/folders/${key()}/loads`)).json() as Loads
const rowNamed = (body: Loads, kind: string, name: string) => body.rows.find((r) => r.kind === kind && r.name === name)

describe('GET /api/folders/:folder/loads', () => {
  // fourth review round, defect 3: Fastify's default maxParamLength (100)
  // answered 414 for any folder path past 100 chars once URI-encoded
  it('a folder whose path runs past 100 chars (150) answers like any other', async () => {
    const long = join(base, 'x'.repeat(150 - base.length - 1))
    expect(long.length).toBe(150)
    mkdirSync(long, { recursive: true })
    registry.create({ id: 'longdev', name: 'Long', folder: long })
    const r = await get(`/api/folders/${encodeURIComponent(long)}/loads`)
    expect(r.statusCode).toBe(200)
    expect((r.json() as { folder: string }).folder).toBe(long)
  })

  it('a managed folder (by its munged key) answers its rows', async () => {
    const r = await get(`/api/folders/${key()}/loads`)
    expect(r.statusCode).toBe(200)
    const body = r.json() as Loads
    expect(body.folder).toBe(folder)
    expect(rowNamed(body, 'mcp', 'github')).toMatchObject({
      origin: { owner: 'project', carrier: '.mcp.json' },
      state: 'active',
      switch: { names: ['github'] },
      detail: 'https://gh.example',
    })
    expect(rowNamed(body, 'plugin', 'team-plan@silos')).toMatchObject({ origin: { owner: 'you' }, state: 'active', switch: { names: ['team-plan@silos'] } })
  })

  it("a row says where it loads: the engine's places, an agent line per agent of the folder, named", async () => {
    registry.create({ id: 'builder', name: 'Builder', folder })
    const body = (await get(`/api/folders/${key()}/loads`)).json() as Loads & { engines: { scopes?: { id: string }[] }[] }
    expect(body.engines[0]!.scopes?.map((s) => s.id)).toEqual(['account', 'machine', 'project', 'agent', 'conversation'])
    const at = rowNamed(body, 'plugin', 'team-plan@silos')?.at ?? []
    expect(at.find((l) => l.place === 'machine')).toMatchObject({ entry: 'on', result: 'on' })
    expect(
      at
        .filter((l) => l.place === 'agent')
        .map((l) => [l.agent, l.agentName, l.result])
        .sort(),
    ).toEqual([
      ['builder', 'Builder', 'on'],
      ['writer', 'Writer', 'on'],
    ])
  })

  it("a row says its health from the newest reading, and who read it — never the engine's config", async () => {
    ledger.record({
      folder,
      conversation: 'c1',
      turnId: 't1',
      agentId: 'writer',
      login: null,
      via: 'chat',
      connectorsOn: false,
      servers: [{ name: 'github', status: 'failed', error: 'HTTP 401 from https://gh.example/mcp?token=abc', source: 'project' }],
    })
    const body = await loads()
    expect(rowNamed(body, 'mcp', 'github')?.health).toMatchObject({
      status: 'failed',
      reason: 'HTTP 401 from gh.example',
      read: { from: 'turn', via: 'chat', agent: 'writer', agentName: 'Writer' },
    })
    expect((body.engines[0] as { readsStatus?: true }).readsStatus).toBe(true)
  })

  // the web sends the folder's exact path: two managed folders whose munged
  // keys collide (proj.one / proj-one) each answer as themselves
  it('by its exact path, proj.one and proj-one never collide; the ambiguous munged key is 404', async () => {
    const dot = join(base, 'proj.one'),
      dash = join(base, 'proj-one')
    for (const [id, f, server] of [
      ['p1', dot, 'dotted'],
      ['p2', dash, 'dashed'],
    ] as const) {
      mkdirSync(f, { recursive: true })
      writeFileSync(join(f, '.mcp.json'), JSON.stringify({ mcpServers: { [server]: { command: 'x' } } }))
      registry.create({ id, name: id, folder: f })
    }
    const dotRows = (await get(`/api/folders/${encodeURIComponent(dot)}/loads`)).json() as Loads
    const dashRows = (await get(`/api/folders/${encodeURIComponent(dash)}/loads`)).json() as Loads
    expect(dotRows.folder).toBe(dot)
    expect(dotRows.rows.map((r) => r.name)).toContain('dotted')
    expect(dashRows.folder).toBe(dash)
    expect(dashRows.rows.map((r) => r.name)).toContain('dashed')
    expect((await get(`/api/folders/${mungePath(dot)}/loads`)).statusCode).toBe(404)
  })

  it('a folder no agent manages is 404 — never an arbitrary path from the request', async () => {
    expect((await get('/api/folders/-tmp-somewhere-else/loads')).statusCode).toBe(404)
    expect((await get(`/api/folders/${encodeURIComponent('../../etc')}/loads`)).statusCode).toBe(404)
    expect((await get(`/api/folders/${encodeURIComponent('/etc')}/loads`)).statusCode).toBe(404) // an exact path no agent manages
  })

  it("an agent bearer is refused: the routes are the owner's", async () => {
    const r = await get(`/api/folders/${key()}/loads`, { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` })
    expect(r.statusCode).toBe(403)
  })

  it('a folder whose agents run on an engine without `loads` answers no rows', async () => {
    const off = registerHarness(makeFakeHarness({ id: 'fake-loads', label: 'Fake', prefix: 'fakel_' }))
    try {
      const other = join(base, 'fake-proj')
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'x' } } }))
      registry.create({ id: 'faker', name: 'Faker', folder: other, framework: 'fake-loads' })
      const r = await get(`/api/folders/${encodeURIComponent(other)}/loads`)
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ folder: other, engines: [], rows: [] })
    } finally {
      off()
    }
  })
})

describe('POST /api/folders/:folder/loads/switch', () => {
  const at = () => encodeURIComponent(folder)
  const sw = (key: string, to: string, headers: Record<string, string> = LOCAL) => post(`/api/folders/${at()}/loads/switch`, { key, to }, headers)
  it('off writes <folder>/.claude/settings.local.json; the inventory reads it back; on removes it', async () => {
    const r = await sw('mcp:project:github', 'off')
    expect(r.statusCode).toBe(200)
    const held = rowNamed(await loads(), 'mcp', 'github')
    expect(held).toMatchObject({ state: 'held', switch: { names: ['github'] } })
    expect(held?.decidedBy).toBeUndefined() // the project's own local file
    const local = JSON.parse(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8')) as Record<string, unknown>
    expect(local.disabledMcpjsonServers).toEqual(['github'])
    expect((await sw('mcp:project:github', 'on')).statusCode).toBe(200)
    expect(rowNamed(await loads(), 'mcp', 'github')).toMatchObject({ state: 'active' })
  })

  it('a plugin switches through the same door, by its exact id', async () => {
    expect((await sw('plugin:team-plan@silos', 'off')).statusCode).toBe(200)
    const local = JSON.parse(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8')) as Record<string, unknown>
    expect(local.enabledPlugins).toEqual({ 'team-plan@silos': false })
  })

  it('bad input → 400; a key no row has → 404', async () => {
    expect((await sw('mcp:project:github', 'maybe')).statusCode).toBe(400)
    expect((await post(`/api/folders/${at()}/loads/switch`, { to: 'off' })).statusCode).toBe(400)
    const r = await sw('mcp:project:ghost', 'off')
    expect(r.statusCode).toBe(404)
    expect((r.json() as { error: string }).error).toContain('unknown row "mcp:project:ghost"')
  })

  it('a row another file decides → 409 saying what decides, nothing written', async () => {
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ disabledMcpjsonServers: ['github'] }))
    const r = await sw('mcp:project:github', 'on')
    expect(r.statusCode).toBe(409)
    expect((r.json() as { error: string }).error).toContain('disabledMcpjsonServers in .claude/settings.json')
    expect(existsSync(join(folder, '.claude', 'settings.local.json'))).toBe(false)
  })

  it('an unmanaged folder cannot be written through this route', async () => {
    expect((await post(`/api/folders/${encodeURIComponent('/etc')}/loads/switch`, { key: 'mcp:project:github', to: 'off' })).statusCode).toBe(404)
  })

  it('an agent bearer cannot switch', async () => {
    const r = await sw('mcp:project:github', 'off', { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` })
    expect(r.statusCode).toBe(403)
    expect(existsSync(join(folder, '.claude', 'settings.local.json'))).toBe(false)
  })

  it('a folder whose engine declares no loads has no row to switch — 404, nothing written', async () => {
    const off = registerHarness(makeFakeHarness({ id: 'fake-sw', label: 'Fake', prefix: 'fakes_' }))
    try {
      const other = join(base, 'fake-sw-proj')
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'x' } } }))
      registry.create({ id: 'fakesw', name: 'FakeSw', folder: other, framework: 'fake-sw' })
      const r = await post(`/api/folders/${encodeURIComponent(other)}/loads/switch`, { key: 'mcp:project:x', to: 'off' })
      expect(r.statusCode).toBe(404)
      expect(existsSync(join(other, '.claude'))).toBe(false)
    } finally {
      off()
    }
  })
})

// spec scopes §6, §8 (T3): «Only <agent>» — the agent's line of a row,
// kept by Silos (loads-scopes.ts), never in a file of the folder or ~/.claude
describe("POST …/loads/switch with scope agent — the agent's place", () => {
  const path = () => encodeURIComponent(folder)
  const swAgent = (key: string, to: string, agent: unknown, headers: Record<string, string> = LOCAL) =>
    post(`/api/folders/${path()}/loads/switch`, { key, to, scope: 'agent', agent }, headers)
  const tree = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : [])
  const scopesFile = () => join(base, 'data', 'loads-scopes.json')
  const lineFor = async (kind: string, name: string, agent: string) =>
    rowNamed(await loads(), kind, name)?.at?.find((l) => l.place === 'agent' && l.agent === agent)

  it("keeps the agent's entry in the store (0600), the row's own time beside it — nothing under the folder or ~/.claude is written", async () => {
    const before = JSON.stringify([tree(folder), tree(home)])
    const r = await swAgent('mcp:project:github', 'off', 'writer')
    expect(r.statusCode).toBe(200)
    expect(JSON.stringify([tree(folder), tree(home)])).toBe(before)
    expect(statSync(scopesFile()).mode & 0o777).toBe(0o600)
    const kept = JSON.parse(readFileSync(scopesFile(), 'utf8')) as { agents: Record<string, Record<string, { entries: unknown; at: Record<string, number> }>> }
    expect(kept.agents.writer!['claude-code']!.entries).toEqual({ disabledMcpjsonServers: ['github'] })
    expect(Object.keys(kept.agents.writer!['claude-code']!.at)).toEqual(['mcp:project:github'])
    expect(await lineFor('mcp', 'github', 'writer')).toMatchObject({ entry: 'off', result: 'off' })
    // the project's own line is untouched
    expect(rowNamed(await loads(), 'mcp', 'github')).toMatchObject({ state: 'active' })
    expect((await swAgent('mcp:project:github', 'on', 'writer')).statusCode).toBe(200)
    expect((await lineFor('mcp', 'github', 'writer'))?.entry).toBeUndefined()
  })

  it('a payload kept with other keys — permissions, hooks, env — rides nowhere and is dropped at the next switch', async () => {
    writeFileSync(
      scopesFile(),
      JSON.stringify({
        agents: {
          writer: {
            'claude-code': {
              entries: { permissions: { allow: ['Bash(*)'] }, hooks: { Stop: [] }, env: { X: '1' }, enabledPlugins: { 'team-plan@silos': false } },
              at: {},
            },
          },
        },
      }),
    )
    scopes.load()
    expect(await lineFor('plugin', 'team-plan@silos', 'writer')).toMatchObject({ entry: 'off', result: 'off' })
    expect((await swAgent('mcp:project:github', 'off', 'writer')).statusCode).toBe(200)
    const kept = JSON.parse(readFileSync(scopesFile(), 'utf8')) as { agents: Record<string, Record<string, { entries: unknown }>> }
    expect(kept.agents.writer!['claude-code']!.entries).toEqual({ enabledPlugins: { 'team-plan@silos': false }, disabledMcpjsonServers: ['github'] })
  })

  it('an agent that does not have the folder is 404; an archived one too; bad input 400; nothing kept', async () => {
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    registry.create({ id: 'outsider', name: 'Outsider', folder: elsewhere })
    expect((await swAgent('mcp:project:github', 'off', 'outsider')).statusCode).toBe(404)
    expect((await swAgent('mcp:project:github', 'off', 'nobody')).statusCode).toBe(404)
    registry.create({ id: 'retired', name: 'Retired', folder })
    registry.archive('retired')
    expect((await swAgent('mcp:project:github', 'off', 'retired')).statusCode).toBe(404)
    expect((await swAgent('mcp:project:github', 'off', '')).statusCode).toBe(400)
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'mcp:project:github', to: 'off', scope: 'everywhere' })).statusCode).toBe(400)
    // 'machine' is a place (T6) — but a server of one project has no machine line
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'mcp:project:github', to: 'off', scope: 'machine' })).statusCode).toBe(409)
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'mcp:project:github', to: 'off', agent: 'writer' })).statusCode).toBe(400)
    expect(existsSync(scopesFile())).toBe(false)
  })

  it("an agent bearer is refused: the store is the owner's", async () => {
    const r = await swAgent('mcp:project:github', 'off', 'writer', { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` })
    expect(r.statusCode).toBe(403)
    expect(existsSync(scopesFile())).toBe(false)
  })
})

// the engine's settings file is the CONFIGURED home's — a server given only
// `home` (the e2e harness: SILOS_HOME) never reads or writes the machine's own
describe('the engine settings path follows the configured home', () => {
  it('a server built with home alone reads and writes <home>/.claude/settings.json', async () => {
    const other = join(base, 'other-home')
    mkdirSync(join(other, '.claude'), { recursive: true })
    writeFileSync(join(other, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 41 }))
    const root = join(base, 'projects2')
    mkdirSync(root, { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'data', 'cache2.json'))
    await index.init()
    const app2 = buildServer({
      index,
      registry,
      native: new NativeStore(join(base, 'data', 'native3.json')),
      chat: new ChatService({
        registry,
        native: new NativeStore(join(base, 'data', 'native4.json')),
        queryFn: () => {
          throw new Error('no sdk')
        },
      }),
      store: new SessionStore(root, join(base, 'data')),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      token: 't0k',
      liveMs: 120_000,
      agentTokens: tokens,
      home: other,
    })
    asOwner(app2, 't0k')
    try {
      const r = await app2.inject({ method: 'GET', url: '/api/claude-settings', headers: LOCAL })
      expect(r.statusCode).toBe(200)
      expect(r.json().cleanupPeriodDays).toBe(41)
    } finally {
      await app2.close()
    }
  })
})

// Agent › Tools (spec scopes §4, §7; T4): the agent's page is the house of
// «this agent» — its plain click writes that agent's entry only, its rows
// carry no other agent's line, and «Check now» there starts as that agent
// and keeps its reading as the agent's, which the project's health skips
// on a row the agent holds
describe("Agent › Tools — the agent's page", () => {
  const path = () => encodeURIComponent(folder)
  const asAgent = async (agent: string) => get(`/api/folders/${path()}/loads?agent=${agent}`)
  const kept = () =>
    JSON.parse(readFileSync(join(base, 'data', 'loads-scopes.json'), 'utf8')) as { agents: Record<string, Record<string, { entries: unknown }>> }
  const swAgent = (key: string, to: string, agent: string) => post(`/api/folders/${path()}/loads/switch`, { key, to, scope: 'agent', agent })

  it("a switch from the agent's page changes only that agent's entry; another agent's lines are never returned to it", async () => {
    registry.create({ id: 'editor', name: 'Editor', folder })
    expect((await swAgent('mcp:project:github', 'off', 'editor')).statusCode).toBe(200)
    expect((await swAgent('plugin:team-plan@silos', 'off', 'writer')).statusCode).toBe(200)
    expect(existsSync(join(folder, '.claude', 'settings.local.json'))).toBe(false)
    expect(kept().agents.writer!['claude-code']!.entries).toEqual({ enabledPlugins: { 'team-plan@silos': false } })
    expect(kept().agents.editor!['claude-code']!.entries).toEqual({ disabledMcpjsonServers: ['github'] })
    const r = await asAgent('writer')
    expect(r.statusCode).toBe(200)
    const body = r.json() as Loads
    const agentsOn = (row: LoadsRow | undefined) => (row?.at ?? []).filter((l) => l.place === 'agent').map((l) => l.agent)
    for (const row of body.rows) if (row.at) expect(agentsOn(row)).toEqual(['writer'])
    expect(JSON.stringify(body)).not.toContain('editor')
    expect(rowNamed(body, 'plugin', 'team-plan@silos')?.at?.find((l) => l.place === 'agent')).toMatchObject({ entry: 'off', result: 'off' })
    expect(rowNamed(body, 'plugin', 'team-plan@silos')).toMatchObject({ state: 'active' })
    // its project line still names every agent of the project it reaches —
    // by name only, none of their entries
    for (const row of body.rows) {
      const project = row.at?.find((l) => l.place === 'project')
      if (project) expect([...((project as { agents?: string[] }).agents ?? [])].sort()).toEqual(['Editor', 'Writer'])
    }
    // the project's page keeps every agent's line
    expect(agentsOn(rowNamed(await loads(), 'mcp', 'github')).sort()).toEqual(['editor', 'writer'])
    // an archived agent's page reads with no agent line (none is carried for it)
    registry.archive('editor')
    const archived = (await asAgent('editor')).json() as Loads
    for (const row of archived.rows) expect(agentsOn(row)).toEqual([])
    // an agent that does not have the folder, an unknown id: 404
    mkdirSync(join(base, 'elsewhere'), { recursive: true })
    registry.create({ id: 'outsider', name: 'Outsider', folder: join(base, 'elsewhere') })
    for (const a of ['outsider', 'nobody']) expect((await asAgent(a)).statusCode).toBe(404)
    expect((await get(`/api/folders/${path()}/loads/check?agent=outsider`)).statusCode).toBe(404)
  })

  it("«Check now» as the agent carries its entries and keeps its reading as the agent's; the project's health skips it where the agent holds the row", async () => {
    expect((await swAgent('plugin:team-plan@silos', 'off', 'writer')).statusCode).toBe(200)
    expect((await swAgent('mcp:project:github', 'off', 'writer')).statusCode).toBe(200)
    const status = (await get(`/api/folders/${path()}/loads/check?agent=writer`)).json() as { targets: { agents: string[] }[] }
    expect(status.targets).toHaveLength(1)
    expect(status.targets[0]!.agents).toEqual(['Writer'])
    // the engine lists github failing in the agent's start (as if the deny had not taken)
    const p = checkProcess([{ name: 'github', status: 'failed', error: 'HTTP 500' }])
    expect((await post(`/api/folders/${path()}/loads/check`, { agent: 'writer' })).statusCode).toBe(200)
    expect(p.calls[0]!.options.settings).toMatchObject({
      disableAllHooks: true,
      enabledPlugins: { 'team-plan@silos': false },
      disabledMcpjsonServers: ['github'],
    })
    expect(ledger.readings(folder)[0]).toMatchObject({ from: 'check', agent: 'writer' })
    // the agent holds github: its reading is not the project's health
    expect(rowNamed(await loads(), 'mcp', 'github')?.health).toBeUndefined()
    // its page names its own check; the project's page does not take it as its last
    expect(((await get(`/api/folders/${path()}/loads/check?agent=writer`)).json() as { targets: { last?: unknown }[] }).targets[0]!.last).toBeDefined()
    expect(((await get(`/api/folders/${path()}/loads/check`)).json() as { targets: { last?: unknown }[] }).targets[0]!.last).toBeUndefined()
    // the project's own check: no overlay, kept as no agent's — and it is the health
    const q = checkProcess([{ name: 'github', status: 'connected' }])
    expect((await post(`/api/folders/${path()}/loads/check`, {})).statusCode).toBe(200)
    expect(q.calls[0]!.options.settings).toEqual({ disableAllHooks: true })
    expect(rowNamed(await loads(), 'mcp', 'github')?.health).toMatchObject({ status: 'connected' })
    // the agent lets go of github: its newer reading counts again
    expect((await swAgent('mcp:project:github', 'on', 'writer')).statusCode).toBe(200)
    checkProcess([{ name: 'github', status: 'failed', error: 'HTTP 500' }])
    expect((await post(`/api/folders/${path()}/loads/check`, { agent: 'writer' })).statusCode).toBe(200)
    expect(rowNamed(await loads(), 'mcp', 'github')?.health).toMatchObject({ status: 'failed', read: { from: 'check', agent: 'writer' } })
    // «See what it sends» is the project's, never one agent's
    expect((await post(`/api/folders/${path()}/loads/check`, { agent: 'writer', withoutLocal: true })).statusCode).toBe(400)
  })
})

// a fake engine process: answers its status once `gate` opens
function checkProcess(rows: unknown[], gate: Promise<void> = Promise.resolve(), email = 'owner@example.com'): { calls: QueryArgs[]; closed: () => number } {
  const calls: QueryArgs[] = []
  let closed = 0
  checkQuery = (a) => {
    calls.push(a)
    let release: () => void = () => {}
    const ended = new Promise<void>((r) => {
      release = r
    })
    return {
      async *[Symbol.asyncIterator]() {
        await ended
      },
      interrupt: async () => {
        release()
      },
      close: () => {
        closed++
        release()
      },
      initializationResult: async () => ({ account: { email } }),
      mcpServerStatus: async () => {
        await gate
        return rows
      },
    }
  }
  return { calls, closed: () => closed }
}
const snapshot = (dir: string): string => JSON.stringify(readdirRecursive(dir))
function readdirRecursive(dir: string): [string, string][] {
  const out: [string, string][] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push([p, 'dir'], ...readdirRecursive(p))
    else out.push([p, readFileSync(p, 'utf8')])
  }
  return out.sort()
}

describe('POST /api/folders/:folder/loads/check', () => {
  it("names the folder's login with its cost; a check's reading lands in the ledger as `check` and on the rows", async () => {
    const before = (await get(`/api/folders/${key()}/loads/check`)).json() as {
      targets: { provider: string; cost: string; agents: string[]; last?: unknown }[]
      running: unknown
    }
    expect(before.running).toBeNull()
    expect(before.targets).toHaveLength(1)
    expect(before.targets[0]).toMatchObject({ provider: 'default', agents: ['Writer'] })
    expect(before.targets[0]!.cost).not.toBe('')
    expect(before.targets[0]!.last).toBeUndefined()
    const p = checkProcess([
      {
        name: 'github',
        status: 'failed',
        error: 'HTTP 500 at https://gh.example/x?key=abc',
        source: 'project',
        config: { url: 'https://gh.example', headers: { authorization: 'Bearer s3cret' } },
      },
    ])
    const r = await post(`/api/folders/${key()}/loads/check`, {})
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ provider: 'default', login: 'owner@example.com', counts: { failed: 1 } })
    expect(p.calls).toHaveLength(1)
    expect(p.closed()).toBe(1)
    const kept = ledger.readings(folder)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({
      from: 'check',
      login: 'owner@example.com',
      servers: [{ name: 'github', status: 'failed', reason: 'HTTP 500 at gh.example' }],
    })
    expect(JSON.stringify(kept)).not.toContain('s3cret')
    expect(rowNamed(await loads(), 'mcp', 'github')?.health).toMatchObject({ status: 'failed', read: { from: 'check' } })
    const after = (await get(`/api/folders/${key()}/loads/check`)).json() as { targets: { last?: { at: number } }[] }
    expect(after.targets[0]!.last?.at).toBeGreaterThan(0)
  })

  it('one at a time per folder: a second check while one runs is 409', async () => {
    let open: () => void = () => {}
    checkProcess(
      [{ name: 'github', status: 'connected' }],
      new Promise<void>((r) => {
        open = r
      }),
    )
    const first = post(`/api/folders/${key()}/loads/check`, {})
    await new Promise((r) => setTimeout(r, 20))
    expect(((await get(`/api/folders/${key()}/loads/check`)).json() as { running: unknown }).running).toMatchObject({
      provider: 'default',
      withoutLocal: false,
    })
    expect((await post(`/api/folders/${key()}/loads/check`, {})).statusCode).toBe(409)
    open()
    expect((await first).statusCode).toBe(200)
    expect((await post(`/api/folders/${key()}/loads/check`, {})).statusCode).toBe(200)
  })

  it('an agent bearer is refused, the check never starts; an unknown folder or login is refused', async () => {
    const p = checkProcess([])
    const bearer = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` }
    expect((await post(`/api/folders/${key()}/loads/check`, {}, bearer)).statusCode).toBe(403)
    expect((await get(`/api/folders/${key()}/loads/check`, bearer)).statusCode).toBe(403)
    expect((await post('/api/folders/-tmp-elsewhere/loads/check', {})).statusCode).toBe(404)
    expect((await post(`/api/folders/${key()}/loads/check`, { provider: 'account:nobody' })).statusCode).toBe(400)
    expect(p.calls).toHaveLength(0)
  })

  it("«See what it sends» runs without the local layer, keeps only the login's connectors and writes nothing to the folder", async () => {
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ disableClaudeAiConnectors: true }))
    const status = (await get(`/api/folders/${key()}/loads/check`)).json() as { targets: { account: boolean; sendsHere: boolean }[] }
    expect(status.targets[0]).toMatchObject({ account: true, sendsHere: false })
    const p = checkProcess([
      { name: 'claude.ai Drive', status: 'connected', source: 'claudeai' },
      { name: 'github', status: 'connected', source: 'project' },
    ])
    const was = snapshot(folder)
    const r = await post(`/api/folders/${key()}/loads/check`, { withoutLocal: true })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ withoutLocal: true, connectors: ['claude.ai Drive'] })
    expect(p.calls[0]!.options.settingSources).toEqual(['user', 'project'])
    expect(snapshot(folder)).toBe(was)
    expect(ledger.readings(folder)).toEqual([])
    expect(ledger.connectorsOf('owner@example.com')?.connectors).toEqual(['claude.ai Drive'])
    // the login's list becomes «could add» rows here; the origin's head turns them on
    const drive = (await loads()).rows.find((r) => r.name === 'claude.ai Drive')
    expect(drive).toMatchObject({
      key: 'connector:owner@example.com:claude.ai Drive',
      state: 'available',
      origin: { owner: 'account', login: 'owner@example.com' },
    })
    expect(drive?.switch).toBeDefined()
    expect(((await loads()) as Loads & { origins: { id: string; on: boolean }[] }).origins).toContainEqual(
      expect.objectContaining({ id: 'connectors', on: false }),
    )
    expect((await post(`/api/folders/${key()}/loads/switch`, { origin: 'connectors', key: drive!.key, to: 'on' })).statusCode).toBe(400)
    expect((await post(`/api/folders/${key()}/loads/switch`, { origin: 'everything', to: 'on' })).statusCode).toBe(400)
    expect(
      (await post(`/api/folders/${key()}/loads/switch`, { origin: 'connectors', to: 'on' }, { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` }))
        .statusCode,
    ).toBe(403)
    expect((await post(`/api/folders/${key()}/loads/switch`, { origin: 'connectors', to: 'on' })).statusCode).toBe(200)
    expect(JSON.parse(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8'))).toEqual({})
    expect((await loads()).rows.find((r) => r.name === 'claude.ai Drive')).toMatchObject({ state: 'active' })
  })
})

// spec tools-origin §9 (T8): a conversation's start problems name the ROW KEY
// the folder's inventory made — the copy that really loaded — never a name
// the screen derives (the dead door: «Turn off ›» landed on a held local
// copy while the account's copy was the one that shipped the server)
describe('GET …/started-with problems: each on a row GET …/loads returns', () => {
  const ORG = '00000000-0000-4000-8000-00000000000a'
  const ACC = '00000000-0000-4000-8000-00000000000b'
  const EMAIL = 'sam@example.com'
  const SERVER = 'plugin:research:webstats'
  const pluginDir = (id: string, manifest: Record<string, unknown>): string => {
    const dir = join(base, 'cache', id.replace('@', '-'))
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
    return dir
  }
  const install = (map: Record<string, Record<string, unknown>>): void => {
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: Object.fromEntries(Object.entries(map).map(([id, m]) => [id, [{ scope: 'user', installPath: pluginDir(id, m), version: '1.0.0' }]])),
      }),
    )
  }
  const sendByAccount = (name: string, manifest: Record<string, unknown>): void => {
    const dir = join(home, '.claude', 'plugins', 'synced', `${ORG}_${ACC}`, name, '.claude-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  }
  const research = { name: 'research', mcpServers: { webstats: { type: 'http', url: 'https://stats.example.com/mcp' } } }
  // a conversation in the folder on the login, its start notice as given
  const conversation = async (id: string, notice: Record<string, unknown>, entrypoint = 'cli'): Promise<void> => {
    const dir = join(base, 'projects', mungePath(folder))
    mkdirSync(dir, { recursive: true })
    const at = '2026-11-20T10:00:00.000Z'
    const b = { cwd: folder, sessionId: id, entrypoint, timestamp: at }
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        { ...b, type: 'attachment', attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${EMAIL}.` } } },
        { type: 'session-owner', accountUuid: ACC, organizationUuid: ORG, sessionId: id },
        { ...b, type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: [], ...notice } },
        { ...b, type: 'user', message: { role: 'user', content: 'hello' } },
        { ...b, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10 } } },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
    )
    await idx.refresh(mungePath(folder), id, false)
  }
  type Problem = { kind: string; name: string; label: string; row?: string }
  const problemsOf = async (id: string): Promise<Problem[]> =>
    ((await get(`/api/sessions/${mungePath(folder)}/${id}/started-with`)).json() as { problems: Problem[] }).problems
  const failing = { failedMcpServers: [{ name: SERVER, error: 'HTTP 403' }] }
  const expectOnInventory = async (p: Problem | undefined): Promise<void> => {
    expect(p?.row).toBeDefined()
    expect((await loads()).rows.map((r) => r.key)).toContain(p!.row)
  }

  it("installed only: the installed copy's server", async () => {
    install({ 'research@market': research })
    await conversation('p1', failing)
    const [p] = await problemsOf('p1')
    expect(p).toMatchObject({ kind: 'failed', name: SERVER, label: 'webstats', row: 'server:research@market:webstats' })
    await expectOnInventory(p)
  })

  it("sent by the account only: the account copy's server", async () => {
    install({})
    sendByAccount('research', research)
    await conversation('p2', failing)
    const [p] = await problemsOf('p2')
    expect(p?.row).toBe(`server:${ACC}:research@synced:webstats`)
    await expectOnInventory(p)
  })

  it("installed AND sent, the installed copy off here: the account copy's server — never the held local one", async () => {
    install({ 'research@market': research })
    sendByAccount('research', research)
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'research@market': false } }))
    await conversation('p3', failing)
    const [p] = await problemsOf('p3')
    expect(p?.row).toBe(`server:${ACC}:research@synced:webstats`)
    await expectOnInventory(p)
  })

  it('declared nowhere: the row of what was seen loading', async () => {
    install({})
    await conversation('p4', failing)
    const [p] = await problemsOf('p4')
    expect(p?.row).toBe(`seen:${SERVER}`)
    await expectOnInventory(p)
  })

  it('a placeholder and the same server as another are never a problem', async () => {
    install({
      'mail@market': { name: 'mail', mcpServers: { inbox: { type: 'http', url: '' } } },
      'alpha@market': { name: 'alpha', mcpServers: { files: { type: 'http', url: 'https://files.example.com/mcp' } } },
      'beta@market': { name: 'beta', mcpServers: { files: { type: 'http', url: 'https://files.example.com/mcp' } } },
    })
    await conversation('p5', {
      failedMcpServers: [
        { name: 'plugin:mail:inbox', error: 'No URL configured for this server' },
        { name: 'plugin:beta:files', error: 'x' },
      ],
    })
    expect(await problemsOf('p5')).toEqual([])
    // a chat's own reading: an entry with no address is no failure either
    ledger.record({
      folder,
      conversation: 'p5',
      turnId: 't1',
      agentId: 'writer',
      login: EMAIL,
      via: 'chat',
      connectorsOn: false,
      servers: [{ name: 'plugin:mail:inbox', status: 'failed', error: 'No URL configured for this server', noAddress: true }],
    })
    expect(await problemsOf('p5')).toEqual([])
  })

  it('a server the owner turned off is not a problem — of course it did not start (owner 24-11)', async () => {
    install({ 'research@market': research })
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ deniedMcpServers: [{ serverName: SERVER }] }))
    await conversation('p6', failing)
    expect(await problemsOf('p6')).toEqual([])
    // a held sign-in is no problem either: nothing to sign in to
    await conversation('p7', { needsAuthMcpServers: [SERVER] })
    expect(await problemsOf('p7')).toEqual([])
  })

  it("a chat's own status reading is preferred to its notice: a sign-in lands on its row", async () => {
    install({ 'research@market': research })
    await conversation('p6', { failedMcpServers: [{ name: SERVER, error: 'stale notice' }] }, 'sdk-ts')
    ledger.record({
      folder,
      conversation: 'p6',
      turnId: 't1',
      agentId: 'writer',
      login: EMAIL,
      via: 'chat',
      connectorsOn: false,
      servers: [
        { name: SERVER, status: 'needs-auth', source: 'plugin' },
        { name: 'tracker', status: 'connected', source: 'project' },
      ],
    })
    const ps = await problemsOf('p6')
    // its door: a chat whose draft names the server by the engine's exact name
    expect(ps).toEqual([
      {
        kind: 'needs-auth',
        name: SERVER,
        label: 'webstats',
        row: 'server:research@market:webstats',
        signIn: { via: 'console', draft: expect.stringContaining(`"${SERVER}"`) },
      },
    ])
    await expectOnInventory(ps[0])
  })
})

describe('POST /api/folders/:folder/loads/projected', () => {
  // an engine whose inventory has a plugin the project does not load and one
  // it does; its estimate counts every time it is asked
  const projectedEngine = () => {
    const asked: { key: string; login: string | null }[] = []
    const plugin = (key: string, state: LoadsRow['state']): LoadsRow => ({
      key,
      engine: 'fake-proj',
      kind: 'plugin',
      name: `${key}@market`,
      label: key,
      exact: true,
      origin: { owner: 'you', carrier: `${key} plugin` },
      state,
    })
    const h = makeFakeHarness({ id: 'fake-proj', label: 'Fake', prefix: 'fakep_' })
    const off = registerHarness({
      ...h,
      loads: {
        inventory: (input) => ({
          engine: 'fake-proj',
          folder: input.folder,
          rows: [plugin('builder', 'available'), plugin('finance', 'active')],
          logins: [],
          notes: [],
        }),
        projected: async (input) => {
          asked.push({ key: input.row.key, login: input.provider?.id ?? null })
          return 2100
        },
        projectedBy: 'Fake’s estimate',
      },
    })
    const other = join(base, 'proj-projected')
    mkdirSync(other, { recursive: true })
    registry.create({ id: 'planner', name: 'Planner', folder: other, framework: 'fake-proj' })
    return { asked, off, other: encodeURIComponent(other) }
  }

  it("a plugin this project does not load: its engine's figure and whose estimate it is", async () => {
    const e = projectedEngine()
    try {
      const r = await post(`/api/folders/${e.other}/loads/projected`, { key: 'builder' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ key: 'builder', tokens: 2100, by: 'Fake’s estimate' })
      expect(e.asked).toEqual([{ key: 'builder', login: null }])
    } finally {
      e.off()
    }
  })

  it('a plugin this project loads is never estimated (its weight is measured): nothing, and the engine is not asked', async () => {
    const e = projectedEngine()
    try {
      const r = await post(`/api/folders/${e.other}/loads/projected`, { key: 'finance' })
      expect(r.json()).toEqual({ key: 'finance', tokens: null })
      expect(e.asked).toHaveLength(0)
    } finally {
      e.off()
    }
  })

  it('never run for an agent bearer; an unknown row is 404, a missing key 400, an unmanaged folder 404', async () => {
    const e = projectedEngine()
    try {
      const bearer = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('planner')}` }
      expect((await post(`/api/folders/${e.other}/loads/projected`, { key: 'builder' }, bearer)).statusCode).toBe(403)
      expect((await post(`/api/folders/${e.other}/loads/projected`, { key: 'nobody' })).statusCode).toBe(404)
      expect((await post(`/api/folders/${e.other}/loads/projected`, {})).statusCode).toBe(400)
      expect((await post('/api/folders/-tmp-elsewhere/loads/projected', { key: 'builder' })).statusCode).toBe(404)
      expect(e.asked).toHaveLength(0)
    } finally {
      e.off()
    }
  })
})

describe('GET/POST /api/folders/:folder/personal', () => {
  it('the owner turns personal instructions off and on; the file carries the exact paths', async () => {
    const before = (await get(`/api/folders/${key()}/personal`)).json() as { engines: { id: string; state: string }[] }
    expect(before.engines.map((e) => [e.id, e.state])).toEqual([['claude-code', 'on']])
    const off = await post(`/api/folders/${key()}/personal`, { to: 'off' })
    expect(off.statusCode).toBe(200)
    expect((off.json() as { engines: { state: string }[] }).engines[0]!.state).toBe('off')
    const file = join(folder, '.claude', 'settings.local.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).claudeMdExcludes).toEqual([join(home, '.claude', 'CLAUDE.md'), `${join(home, '.claude', 'rules')}/**`])
    expect((await post(`/api/folders/${key()}/personal`, { to: 'on' })).statusCode).toBe(200)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  it('an agent bearer is refused; an unmanaged folder is 404; a bad body is 400', async () => {
    const bearer = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` }
    expect((await get(`/api/folders/${key()}/personal`, bearer)).statusCode).toBe(403)
    expect((await post(`/api/folders/${key()}/personal`, { to: 'off' }, bearer)).statusCode).toBe(403)
    expect((await post(`/api/folders/${encodeURIComponent('/etc')}/personal`, { to: 'off' })).statusCode).toBe(404)
    expect((await post(`/api/folders/${key()}/personal`, { to: 'maybe' })).statusCode).toBe(400)
    expect(existsSync(join(folder, '.claude', 'settings.local.json'))).toBe(false)
  })

  // spec scopes T10: for one agent, for one conversation — kept by Silos
  // (the choice), nothing under the folder or ~/.claude written
  it("an agent's and a conversation's «off» are kept by Silos under the agent and the thread the server resolves", async () => {
    const tree = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : [])
    const mf = mungePath(folder)
    mkdirSync(join(base, 'projects', mf), { recursive: true })
    for (const id of ['conv-a', 'conv-b']) {
      writeFileSync(
        join(base, 'projects', mf, `${id}.jsonl`),
        JSON.stringify({ type: 'user', sessionId: id, cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) + '\n',
      )
      await idx.refresh(mf, id)
    }
    lineage.record(`${key()}/conv-b`, `${key()}/conv-a`)
    const before = JSON.stringify([tree(folder), tree(home)])
    expect((await post(`/api/folders/${key()}/personal`, { to: 'off', scope: 'agent', agent: 'writer' })).statusCode).toBe(200)
    expect((await post(`/api/folders/${key()}/personal`, { to: 'off', scope: 'conversation', conversation: 'conv-b' })).statusCode).toBe(409) // its agent keeps them out already
    expect((await post(`/api/folders/${key()}/personal`, { to: 'on', scope: 'agent', agent: 'writer' })).statusCode).toBe(200)
    const conv = await post(`/api/folders/${key()}/personal`, { to: 'off', scope: 'conversation', conversation: 'conv-b' })
    expect(conv.statusCode).toBe(200)
    expect((conv.json() as { conversation: { thread: string } }).conversation.thread).toBe('conv-a')
    expect(JSON.stringify([tree(folder), tree(home)])).toBe(before)
    const kept = JSON.parse(readFileSync(join(base, 'data', 'loads-scopes.json'), 'utf8')) as {
      agents: object
      conversations: Record<string, Record<string, { entries: unknown }>>
    }
    expect(kept.agents).toEqual({})
    expect(kept.conversations['conv-a']!['claude-code']!.entries).toEqual({ personalInstructions: 'off' })
    const read = (await get(`/api/folders/${key()}/personal?conversation=conv-a`)).json() as { engines: { at: { place: string; entry?: string }[] }[] }
    expect(read.engines[0]!.at.find((l) => l.place === 'conversation')).toMatchObject({ entry: 'off' })
    // what is no agent or no conversation of this project
    expect((await post(`/api/folders/${key()}/personal`, { to: 'off', scope: 'agent', agent: 'finance' })).statusCode).toBe(404)
    expect((await post(`/api/folders/${key()}/personal`, { to: 'off', scope: 'conversation', conversation: 'nope' })).statusCode).toBe(404)
    expect((await post(`/api/folders/${key()}/personal`, { to: 'off', scope: 'agent' })).statusCode).toBe(400)
    expect((await get(`/api/folders/${key()}/personal?agent=finance`)).statusCode).toBe(404)
  })
})

// spec scopes §4, §6, §7 (T5): «This conversation» — ONE conversation's
// line of a row, kept by Silos under the thread the SERVER resolves from
// the session id the web holds; never a file of the folder, ~/.claude, nor
// the agent's entries
describe('…/loads with a conversation — its place, its switch, where its entries stand', () => {
  const path = () => encodeURIComponent(folder)
  const tree = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : [])
  const scopesFile = () => join(base, 'data', 'loads-scopes.json')
  const swConv = (k: string, to: string, conversation: unknown, headers: Record<string, string> = LOCAL, where = path()) =>
    post(`/api/folders/${where}/loads/switch`, { key: k, to, scope: 'conversation', conversation }, headers)
  const loadsOf = async (conversation: string, where = path()) =>
    (await get(`/api/folders/${where}/loads?conversation=${conversation}`)).json() as Loads & {
      conversation?: { thread: string; agent: string | null }
      conversations?: { thread: string; id: string }[]
    }
  const convLine = (body: Loads, kind: string, name: string) => rowNamed(body, kind, name)?.at?.find((l) => l.place === 'conversation')
  // a started conversation: its transcript, indexed (a conversation not
  // started yet has no place — the index does not know it)
  const session = async (id: string, cwd: string, at = new Date().toISOString()) => {
    const mf = mungePath(cwd)
    mkdirSync(join(base, 'projects', mf), { recursive: true })
    writeFileSync(
      join(base, 'projects', mf, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: at, message: { role: 'user', content: 'hello' } }) + '\n',
    )
    await idx.refresh(mf, id)
  }
  const PLUGIN = 'team-plan@silos'
  const pluginKey = async () => rowNamed(await loads(), 'plugin', PLUGIN)!.key

  it('keeps the entry under the thread the server resolves — a resume, a /clear rotation and a same-project branch read it; a fork into another project does not', async () => {
    const other = join(base, 'other')
    mkdirSync(other, { recursive: true })
    registry.create({ id: 'helper', name: 'Helper', folder: other })
    for (const id of ['conv-a', 'conv-b', 'conv-c', 'conv-d']) await session(id, folder)
    await session('conv-e', other)
    // conv-b resumes conv-a, conv-c is a /clear of conv-b, conv-d a branch
    // of conv-a in the same project; conv-e a fork of conv-a elsewhere
    lineage.record(`${key()}/conv-b`, `${key()}/conv-a`)
    lineage.record(`${key()}/conv-c`, `${key()}/conv-b`)
    lineage.record(`${key()}/conv-d`, `${key()}/conv-a`)
    lineage.record(`${mungePath(other)}/conv-e`, `${key()}/conv-a`)
    const before = JSON.stringify([tree(folder), tree(home)])
    expect((await swConv('mcp:project:github', 'off', 'conv-c')).statusCode).toBe(200)
    expect(JSON.stringify([tree(folder), tree(home)])).toBe(before)
    const kept = JSON.parse(readFileSync(scopesFile(), 'utf8')) as { agents: object; conversations: Record<string, Record<string, { entries: unknown }>> }
    expect(Object.keys(kept.conversations)).toEqual(['conv-a'])
    expect(kept.conversations['conv-a']!['claude-code']!.entries).toEqual({ disabledMcpjsonServers: ['github'] })
    expect(kept.agents).toEqual({})
    for (const id of ['conv-a', 'conv-b', 'conv-c', 'conv-d']) {
      const body = await loadsOf(id)
      expect(body.conversation?.thread).toBe('conv-a')
      expect(convLine(body, 'mcp', 'github')).toMatchObject({ entry: 'off', result: 'off', conversation: 'conv-a', agent: 'writer' })
    }
    // the fork is another conversation: it starts with none, in its project
    expect((await swConv(await pluginKey(), 'off', 'conv-e', LOCAL, encodeURIComponent(other))).statusCode).toBe(200)
    const fork = await loadsOf('conv-e', encodeURIComponent(other))
    expect(fork.conversation?.thread).toBe('conv-e')
    expect(convLine(await loadsOf('conv-a'), 'plugin', PLUGIN)?.entry).toBeUndefined()
    // the project's own line and the agent's are untouched
    const body = await loadsOf('conv-a')
    expect(rowNamed(body, 'mcp', 'github')).toMatchObject({ state: 'active' })
    expect(rowNamed(body, 'mcp', 'github')!.at!.find((l) => l.place === 'agent')?.entry).toBeUndefined()
  })

  it('an override kind: the conversation wins over its agent; an off-only row held wider is refused, saying where', async () => {
    await session('conv-a', folder)
    const k = await pluginKey()
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: k, to: 'off', scope: 'agent', agent: 'writer' })).statusCode).toBe(200)
    expect(convLine(await loadsOf('conv-a'), 'plugin', PLUGIN)).toMatchObject({ result: 'off' })
    expect(convLine(await loadsOf('conv-a'), 'plugin', PLUGIN)?.entry).toBeUndefined()
    expect((await swConv(k, 'on', 'conv-a')).statusCode).toBe(200)
    expect(convLine(await loadsOf('conv-a'), 'plugin', PLUGIN)).toMatchObject({ entry: 'on', result: 'on' })
    // back to what it follows (its agent's «off»): the entry goes
    expect((await swConv(k, 'off', 'conv-a')).statusCode).toBe(200)
    expect(convLine(await loadsOf('conv-a'), 'plugin', PLUGIN)?.entry).toBeUndefined()
    // an MCP server its agent keeps off can't come back here
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'mcp:project:github', to: 'off', scope: 'agent', agent: 'writer' })).statusCode).toBe(200)
    expect(convLine(await loadsOf('conv-a'), 'mcp', 'github')).toMatchObject({ result: 'off', locked: { why: 'wider', at: 'agent' } })
    const r = await swConv('mcp:project:github', 'on', 'conv-a')
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/for the agent "writer"/)
    // and one the project keeps off
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'mcp:project:github', to: 'on', scope: 'agent', agent: 'writer' })).statusCode).toBe(200)
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'mcp:project:github', to: 'off' })).statusCode).toBe(200)
    const p = await swConv('mcp:project:github', 'on', 'conv-a')
    expect(p.statusCode).toBe(409)
    expect(p.json().error).toMatch(/in this project/)
  })

  it("pending while the entry is newer than the thread's last start; in effect after one that no longer has it; didn't take after one that does", async () => {
    await session('conv-a', folder)
    await session('conv-b', folder)
    lineage.record(`${key()}/conv-b`, `${key()}/conv-a`)
    expect((await swConv('mcp:project:github', 'off', 'conv-a')).statusCode).toBe(200)
    const since = scopes.get('conversations', 'conv-a', 'claude-code')!.at['mcp:project:github']!
    // a start writes its transcript: the session is touched then
    const reading = async (conversation: string, started: number, listed: boolean) => {
      await session(conversation, folder, new Date(started).toISOString())
      ledger.record({
        folder,
        conversation,
        login: null,
        started,
        at: started + 5,
        connectorsOn: false,
        servers: listed ? [{ name: 'github', status: 'connected' }] : [],
      })
    }
    // a turn that started before the click proves nothing
    await reading('conv-b', since - 1000, true)
    expect(convLine(await loadsOf('conv-b'), 'mcp', 'github')?.here).toMatchObject({ state: 'pending', since })
    // a start of the thread after it that still lists it: the switch didn't take
    await reading('conv-b', since + 10, true)
    expect(convLine(await loadsOf('conv-a'), 'mcp', 'github')?.here).toMatchObject({ state: 'didnt-take', read: since + 10 })
    // the same start never marks the project's row: conv-b is of a thread
    // (conv-a's, resolved by the server) that holds it
    expect(rowNamed(await loads(), 'mcp', 'github')?.health).toBeUndefined()
    // and T12's proof on the conversation's own line says so too
    expect(convLine(await loadsOf('conv-a'), 'mcp', 'github')?.proof).toMatchObject({ to: 'off', name: 'github' })
    // a newer one that no longer has it: in effect
    await reading('conv-a', since + 20, false)
    expect(convLine(await loadsOf('conv-b'), 'mcp', 'github')?.here).toMatchObject({ state: 'in-effect', read: since + 20 })
    // another conversation's start never counts
    await reading('conv-x', since + 30, true)
    expect(convLine(await loadsOf('conv-a'), 'mcp', 'github')?.here?.state).toBe('in-effect')
  })

  it("…/loads?conversation= returns no other conversation's entries; a page names each that differs, as a fact with its door", async () => {
    await session('conv-a', folder)
    await session('conv-x', folder)
    expect((await swConv('mcp:project:github', 'off', 'conv-x')).statusCode).toBe(200)
    const mine = await loadsOf('conv-a')
    expect(mine.rows.flatMap((r) => r.at ?? []).filter((l) => l.place === 'conversation' && l.conversation !== 'conv-a')).toEqual([])
    expect(convLine(mine, 'mcp', 'github')).toMatchObject({ conversation: 'conv-a', result: 'on' })
    expect('conversations' in mine).toBe(false)
    // the project's page: conv-x's line, no switch, and the door to it
    const page = (await get(`/api/folders/${path()}/loads`)).json() as Loads & { conversations?: { thread: string; id: string }[] }
    const fact = convLine(page, 'mcp', 'github')
    expect(fact).toMatchObject({ conversation: 'conv-x', entry: 'off' })
    expect(fact?.switch).toBeUndefined()
    expect(page.conversations).toEqual([expect.objectContaining({ thread: 'conv-x', id: 'conv-x' })])
  })

  it('a session that is no conversation of a managed folder is 404 — unknown, not started, elsewhere; bad input 400; nothing kept', async () => {
    const loose = join(base, 'loose')
    mkdirSync(loose, { recursive: true })
    await session('conv-l', loose)
    expect((await swConv('mcp:project:github', 'off', 'conv-l')).statusCode).toBe(404)
    expect((await swConv('mcp:project:github', 'off', 'never-started')).statusCode).toBe(404)
    expect((await get(`/api/folders/${path()}/loads?conversation=conv-l`)).statusCode).toBe(404)
    expect((await get(`/api/folders/${path()}/loads?conversation=never-started`)).statusCode).toBe(404)
    expect((await swConv('mcp:project:github', 'off', '')).statusCode).toBe(400)
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'mcp:project:github', to: 'off', conversation: 'conv-l' })).statusCode).toBe(400)
    expect(existsSync(scopesFile())).toBe(false)
  })

  it("an agent bearer is refused: a conversation's place is the owner's", async () => {
    await session('conv-a', folder)
    const r = await swConv('mcp:project:github', 'off', 'conv-a', { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` })
    expect(r.statusCode).toBe(403)
    expect(existsSync(scopesFile())).toBe(false)
  })
})

// «This machine» through the route (spec scopes T6): `scope: 'machine'`
// writes the user file and answers which logins Silos connects followed it
describe('POST …/loads/switch with scope machine', () => {
  const userFile = () => join(home, '.claude', 'settings.json')
  const readUser = () => JSON.parse(readFileSync(userFile(), 'utf8')) as Record<string, unknown>
  const machineSwitch = (payload: Record<string, unknown>, headers: Record<string, string> = LOCAL) =>
    post(`/api/folders/${key()}/loads/switch`, { scope: 'machine', ...payload }, headers)

  it("writes the user file and names a login that did not follow; never ~/.claude.json, never an account's file by hand", async () => {
    const dataDir = join(base, 'data')
    const accountsDir = join(dataDir, 'claude-accounts')
    mkdirSync(join(accountsDir, 'work'), { recursive: true })
    mkdirSync(join(accountsDir, 'broken'), { recursive: true })
    writeFileSync(join(accountsDir, 'broken', 'settings.json'), '{ not json')
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { search: { command: 's' } } }))
    const claudeJson = readFileSync(join(home, '.claude.json'), 'utf8')
    await app.close()
    app = makeApp({ accounts: new AccountsService({ dataDir, defaultConfigDir: join(home, '.claude'), identity: fakeIdentity(join(home, '.claude')) }) })
    asOwner(app, 't0k')
    const r = await machineSwitch({ key: 'plugin:team-plan@silos', to: 'off' })
    expect(r.statusCode).toBe(200)
    expect(r.json().logins).toEqual({
      followed: ['work'],
      missed: [{ name: 'broken', why: 'account-unreadable', file: join(accountsDir, 'broken', 'settings.json') }],
    })
    expect(readUser().enabledPlugins).toEqual({ 'team-plan@silos': false })
    // the follow copied it to the account that could; the broken one is untouched
    expect(JSON.parse(readFileSync(join(accountsDir, 'work', 'settings.json'), 'utf8')).enabledPlugins).toEqual({ 'team-plan@silos': false })
    expect(readFileSync(join(accountsDir, 'broken', 'settings.json'), 'utf8')).toBe('{ not json')
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(claudeJson)
    // a server of yours: exactly its {serverName}
    expect((await machineSwitch({ key: 'mcp:user:search', to: 'off' })).statusCode).toBe(200)
    expect(readUser().deniedMcpServers).toEqual([{ serverName: 'search' }])
  })

  it('a request without scope never writes the user file; an unknown scope is 400; a bearer is refused', async () => {
    const before = readFileSync(userFile(), 'utf8')
    expect((await post(`/api/folders/${key()}/loads/switch`, { key: 'plugin:team-plan@silos', to: 'off' })).statusCode).toBe(200)
    expect(readFileSync(userFile(), 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8')).enabledPlugins).toEqual({ 'team-plan@silos': false })
    expect((await machineSwitch({ key: 'plugin:team-plan@silos', to: 'off', scope: 'everywhere' })).statusCode).toBe(400)
    const bearer = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` }
    expect((await machineSwitch({ key: 'plugin:team-plan@silos', to: 'off' }, bearer)).statusCode).toBe(403)
    expect((await get(`/api/folders/${key()}/loads/reach?key=plugin:team-plan@silos`, bearer)).statusCode).toBe(403)
    expect(readFileSync(userFile(), 'utf8')).toBe(before)
  })

  it("a file it can't read is 409 naming it, untouched; the reach counts the projects that load the row now", async () => {
    const reach = async () =>
      (await get(`/api/folders/${key()}/loads/reach?key=${encodeURIComponent('plugin:team-plan@silos')}`)).json() as { projects: number }
    const other = join(base, 'other-proj')
    mkdirSync(other, { recursive: true })
    registry.create({ id: 'reader', name: 'Reader', folder: other })
    expect(await reach()).toEqual({ projects: 2 })
    await post(`/api/folders/${encodeURIComponent(other)}/loads/switch`, { key: 'plugin:team-plan@silos', to: 'off' })
    expect(await reach()).toEqual({ projects: 1 })
    writeFileSync(userFile(), '[]')
    const r = await machineSwitch({ key: 'plugin:team-plan@silos', to: 'off' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain(userFile())
    expect(readFileSync(userFile(), 'utf8')).toBe('[]')
  })
})

// spec scopes T9 — a skill's places through the same owner-only door as its
// project position: scope 'agent' kept by Silos, scope 'machine' the user file
describe('POST …/skills/:name/position with scope — a skill at every place', () => {
  const path = () => encodeURIComponent(folder)
  const pos = (name: string, body: Record<string, unknown>, headers: Record<string, string> = LOCAL) =>
    post(`/api/folders/${path()}/skills/${name}/position`, body, headers)
  const scopesFile = () => join(base, 'data', 'loads-scopes.json')
  const tree = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : [])
  beforeEach(() => {
    mkdirSync(join(home, '.claude', 'skills', 'vps-notes'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'vps-notes', 'SKILL.md'), '---\nname: vps-notes\ndescription: notes\n---\nbody\n')
  })

  it('an agent’s place is kept by Silos with the skill’s own time; the machine’s writes only its entry of the user file', async () => {
    const before = JSON.stringify([tree(folder), tree(home)])
    expect((await pos('vps-notes', { to: 'off', from: 'personal', scope: 'agent', agent: 'writer' })).statusCode).toBe(200)
    expect(JSON.stringify([tree(folder), tree(home)])).toBe(before)
    const kept = JSON.parse(readFileSync(scopesFile(), 'utf8')) as { agents: Record<string, Record<string, { entries: unknown; at: Record<string, number> }>> }
    expect(kept.agents.writer!['claude-code']).toMatchObject({
      entries: { skillOverrides: { 'vps-notes': 'off' } },
      at: { 'skill:vps-notes': expect.any(Number) },
    })
    const settings = join(home, '.claude', 'settings.json')
    const r = await pos('vps-notes', { to: 'name-only', from: 'personal', scope: 'machine' })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ enabledPlugins: { 'team-plan@silos': true }, skillOverrides: { 'vps-notes': 'name-only' } })
    expect((await pos('vps-notes', { to: 'on', from: 'personal', scope: 'machine' })).statusCode).toBe(200)
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ enabledPlugins: { 'team-plan@silos': true } })
    expect(existsSync(join(folder, '.claude', 'settings.local.json'))).toBe(false)
  })

  it('bad input 400; an agent of another folder 404; a project skill has no machine line (409); an agent bearer 403 — nothing written', async () => {
    mkdirSync(join(folder, '.claude', 'skills', 'deploy'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nbody\n')
    expect((await pos('vps-notes', { to: 'off', from: 'personal', scope: 'everywhere' })).statusCode).toBe(400)
    expect((await pos('vps-notes', { to: 'off', from: 'personal', scope: 'agent' })).statusCode).toBe(400)
    expect((await pos('vps-notes', { to: 'off', from: 'personal', agent: 'writer' })).statusCode).toBe(400)
    expect((await pos('vps-notes', { to: 'off', from: 'personal', scope: 'agent', agent: 'nobody' })).statusCode).toBe(404)
    expect((await pos('deploy', { to: 'off', from: 'project', scope: 'machine' })).statusCode).toBe(409)
    expect(
      (
        await pos(
          'vps-notes',
          { to: 'off', from: 'personal', scope: 'agent', agent: 'writer' },
          { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` },
        )
      ).statusCode,
    ).toBe(403)
    expect(existsSync(scopesFile())).toBe(false)
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))).toEqual({ enabledPlugins: { 'team-plan@silos': true } })
  })
})

// The heads of what an account sends at every place, through the routes
// (spec scopes T8): `origin` with `scope`; the machine's «off» only with
// `confirmed`; GET/POST /api/loads/machine outside any folder; owner-only.
describe("an origin's head at every place — the switch route and /api/loads/machine", () => {
  const userFile = () => join(home, '.claude', 'settings.json')
  const readUser = () => JSON.parse(readFileSync(userFile(), 'utf8')) as Record<string, unknown>
  const head = (payload: Record<string, unknown>, headers: Record<string, string> = LOCAL) => post(`/api/folders/${key()}/loads/switch`, payload, headers)
  const scopesFile = () => join(base, 'data', 'loads-scopes.json')

  it("the machine's «off» is 409 without confirmed — untouched; with it only the key is written; the answer names who followed", async () => {
    const before = readFileSync(userFile(), 'utf8')
    const refused = await head({ origin: 'plugins', to: 'off', scope: 'machine' })
    expect(refused.statusCode).toBe(409)
    expect(readFileSync(userFile(), 'utf8')).toBe(before)
    expect((await head({ origin: 'plugins', to: 'off', scope: 'machine', confirmed: 'yes' })).statusCode).toBe(400)
    const r = await head({ origin: 'skills', to: 'off', scope: 'machine', confirmed: true })
    expect(r.statusCode).toBe(200)
    expect(r.json().logins).toEqual({ followed: [], missed: [] })
    expect(readUser()).toEqual({ ...JSON.parse(before), syncClaudeAiSkills: false })
    expect((await head({ origin: 'skills', to: 'on', scope: 'machine' })).statusCode).toBe(200)
    expect(readFileSync(userFile(), 'utf8')).not.toContain('syncClaudeAiSkills')
    // the head's lines are in the folder's read, the project line its switch
    const o = ((await loads()) as Loads & { origins: { id: string; at?: { place: string; switch?: unknown; asks?: string }[] }[] }).origins.find(
      (x) => x.id === 'connectors',
    )!
    expect(o.at?.map((l) => l.place)).toEqual(['account', 'machine', 'project', 'agent'])
    expect(o.at?.find((l) => l.place === 'machine')?.asks).toBeTruthy()
  })

  it("an agent's head is kept in the store under the head's key — nothing on disk; a bearer is refused", async () => {
    const before = JSON.stringify([readFileSync(userFile(), 'utf8'), existsSync(join(folder, '.claude', 'settings.local.json'))])
    const r = await head({ origin: 'connectors', to: 'off', scope: 'agent', agent: 'writer' })
    expect(r.statusCode).toBe(200)
    const kept = JSON.parse(readFileSync(scopesFile(), 'utf8')) as { agents: Record<string, Record<string, { entries: unknown; at: Record<string, number> }>> }
    expect(kept.agents.writer!['claude-code']!.entries).toEqual({ disableClaudeAiConnectors: true })
    expect(Object.keys(kept.agents.writer!['claude-code']!.at)).toEqual(['origin:connectors'])
    expect(JSON.stringify([readFileSync(userFile(), 'utf8'), existsSync(join(folder, '.claude', 'settings.local.json'))])).toBe(before)
    expect((await head({ origin: 'connectors', to: 'on', scope: 'agent', agent: 'writer' })).statusCode).toBe(200)
    expect((await head({ origin: 'connectors', to: 'off', scope: 'agent', agent: 'nobody' })).statusCode).toBe(404)
    expect((await head({ origin: 'everything', to: 'off' })).statusCode).toBe(400)
    const bearer = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` }
    expect((await head({ origin: 'connectors', to: 'off', scope: 'agent', agent: 'writer' }, bearer)).statusCode).toBe(403)
    expect((await head({ origin: 'connectors', to: 'off', scope: 'machine', confirmed: true }, bearer)).statusCode).toBe(403)
  })

  it("/api/loads/machine: every engine's heads outside a folder, its «off» only confirmed; a bearer can neither read nor write", async () => {
    const g = (await get('/api/loads/machine')).json() as { engines: { engine: string; heads: { id: string; off: boolean; at: { place: string }[] }[] }[] }
    const claude = g.engines.find((e) => e.engine === 'claude-code')!
    expect(claude.heads.map((h) => [h.id, h.off])).toEqual([
      ['plugins', false],
      ['skills', false],
      ['connectors', false],
    ])
    const before = readFileSync(userFile(), 'utf8')
    expect((await post('/api/loads/machine', { engine: 'claude-code', origin: 'connectors', to: 'off' })).statusCode).toBe(409)
    expect(readFileSync(userFile(), 'utf8')).toBe(before)
    expect((await post('/api/loads/machine', { engine: 'claude-code', origin: 'connectors', to: 'off', confirmed: true })).statusCode).toBe(200)
    expect(readUser().disableClaudeAiConnectors).toBe(true)
    expect((await post('/api/loads/machine', { engine: 'nope', origin: 'connectors', to: 'off', confirmed: true })).statusCode).toBe(404)
    expect((await post('/api/loads/machine', { engine: 'claude-code', origin: 'connectors', to: 'maybe' })).statusCode).toBe(400)
    const bearer = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` }
    expect((await get('/api/loads/machine', bearer)).statusCode).toBe(403)
    expect((await post('/api/loads/machine', { engine: 'claude-code', origin: 'connectors', to: 'on' }, bearer)).statusCode).toBe(403)
    expect(readUser().disableClaudeAiConnectors).toBe(true)
  })
})

// spec scopes T11 — all / nothing at one place, its undo set, «Only <agent>»
describe('all / nothing at one place, «Undo», and «Only <agent>»', () => {
  const path = () => encodeURIComponent(folder)
  const localFile = () => join(folder, '.claude', 'settings.local.json')
  const readLocal = () => (existsSync(localFile()) ? JSON.parse(readFileSync(localFile(), 'utf8')) : {}) as Record<string, unknown>
  const userFile = () => join(home, '.claude', 'settings.json')
  const bulk = (payload: Record<string, unknown>, headers: Record<string, string> = LOCAL) =>
    post(`/api/folders/${path()}/loads/bulk`, { group: 'project', ...payload }, headers)
  const undo = (payload: Record<string, unknown>) => post(`/api/folders/${path()}/loads/bulk/undo`, { group: 'project', ...payload })
  const only = (payload: Record<string, unknown>, headers: Record<string, string> = LOCAL) => post(`/api/folders/${path()}/loads/only`, payload, headers)
  const KEYS = ['mcp:project:github', 'mcp:project:linear', 'plugin:team-plan@silos']
  type Line = { place: string; agent?: string; entry?: string; result: string }
  const lineOf = async (rowKey: string, place: string, agent?: string): Promise<Line | undefined> =>
    ((await loads()).rows.find((r) => r.key === rowKey)?.at as Line[] | undefined)?.find((l) => l.place === place && (agent === undefined || l.agent === agent))
  let writes = 0
  beforeEach(() => {
    writeFileSync(
      join(folder, '.mcp.json'),
      JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://gh.example' }, linear: { type: 'http', url: 'https://linear.example' } } }),
    )
    registry.create({ id: 'builder', name: 'Builder', folder })
    writes = 0
    setSealHooks({
      afterOwnEdit: () => {
        writes++
      },
    })
  })
  afterEach(() => {
    setSealHooks(null)
  })

  it('the preview counts what it will change and writes nothing; the click is ONE write at that place', async () => {
    const p = await bulk({ keys: KEYS, to: 'off', preview: true })
    expect(p.statusCode).toBe(200)
    expect(p.json().preview).toMatchObject({ to: 'off', scope: 'project', changes: { plugin: 1, mcp: 2, connector: 0 }, heads: [], cannot: 0 })
    expect(existsSync(localFile())).toBe(false)
    const r = await bulk({ keys: KEYS, to: 'off' })
    expect(r.statusCode).toBe(200)
    expect(writes).toBe(1)
    expect(readLocal()).toEqual({ disabledMcpjsonServers: ['github', 'linear'], enabledPlugins: { 'team-plan@silos': false } })
    // a second click in the same direction changes nothing and writes nothing
    expect((await bulk({ keys: KEYS, to: 'off' })).json().done.changes).toEqual({ plugin: 0, mcp: 0, connector: 0 })
    expect(writes).toBe(1)
  })

  it('what a wider place decides is counted as what it cannot change, and left alone', async () => {
    writeFileSync(userFile(), JSON.stringify({ enabledPlugins: { 'team-plan@silos': true }, deniedMcpServers: [{ serverName: 'linear' }] }))
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(localFile(), JSON.stringify({ disabledMcpjsonServers: ['github'] }))
    const p = (await bulk({ keys: KEYS, to: 'on', preview: true })).json().preview
    // github: the project's own «off» goes; linear: off for this whole machine (off-only) — can't
    expect(p).toMatchObject({ changes: { plugin: 0, mcp: 1 }, cannot: 1 })
    expect((await bulk({ keys: KEYS, to: 'on' })).statusCode).toBe(200)
    expect(readLocal().disabledMcpjsonServers).toBeUndefined()
    expect(JSON.parse(readFileSync(userFile(), 'utf8')).deniedMcpServers).toEqual([{ serverName: 'linear' }])
  })

  it("at an agent's place: one payload kept once; undo puts back exactly the entries it changed", async () => {
    // the project keeps the plugin off, Builder turns it back on (an override); github follows the project
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(localFile(), JSON.stringify({ enabledPlugins: { 'team-plan@silos': false } }))
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'plugin:team-plan@silos', to: 'on', scope: 'agent', agent: 'builder' })).statusCode).toBe(
      200,
    )
    const before = scopes.get('agents', 'builder', 'claude-code')!.entries
    const saves = vi.spyOn(scopes, 'recordMany')
    const one = vi.spyOn(scopes, 'record')
    const r = await bulk({ keys: KEYS, to: 'off', scope: 'agent', agent: 'builder', group: 'tab' })
    expect(r.json().done.changes).toEqual({ plugin: 1, mcp: 2, connector: 0 })
    expect(saves).toHaveBeenCalledTimes(1)
    expect(one).not.toHaveBeenCalled()
    expect(scopes.get('agents', 'builder', 'claude-code')!.entries).toEqual({ disabledMcpjsonServers: ['github', 'linear'] })
    // nothing on disk for an agent's click
    expect(readLocal()).toEqual({ enabledPlugins: { 'team-plan@silos': false } })
    const u = ((await loads()) as Loads & { undo: { scope: string; agent?: string; group: string; to: string }[] }).undo
    expect(u).toEqual([expect.objectContaining({ scope: 'agent', agent: 'builder', group: 'tab', to: 'off' })])
    // undo on another head is not this one's
    expect((await undo({ scope: 'agent', agent: 'builder', group: 'project' })).statusCode).toBe(404)
    expect((await undo({ scope: 'agent', agent: 'builder', group: 'tab' })).statusCode).toBe(200)
    expect(scopes.get('agents', 'builder', 'claude-code')!.entries).toEqual(before)
    expect(await lineOf('plugin:team-plan@silos', 'agent', 'builder')).toMatchObject({ entry: 'on', result: 'on' })
    // used: dropped
    expect(scopes.undoAt('agent:builder')).toBeNull()
    expect((await undo({ scope: 'agent', agent: 'builder', group: 'tab' })).statusCode).toBe(404)
  })

  it('the undo set is kept in loads-scopes.json, one per place, and survives a restart of the server', async () => {
    expect((await bulk({ keys: ['mcp:project:github'], to: 'off', group: 'project' })).statusCode).toBe(200)
    expect((await bulk({ keys: KEYS, to: 'off', group: 'tab' })).statusCode).toBe(200)
    const kept = JSON.parse(readFileSync(join(base, 'data', 'loads-scopes.json'), 'utf8')) as {
      undo: Record<string, { group: string; rows: Record<string, unknown> }>
    }
    // one per place: the second click replaced the first
    expect(Object.keys(kept.undo)).toEqual([`project:${folder}`])
    expect(kept.undo[`project:${folder}`]!.group).toBe('tab')
    expect(Object.keys(kept.undo[`project:${folder}`]!.rows).sort()).toEqual(['mcp:project:linear', 'plugin:team-plan@silos'])
    await app.close()
    // a new server: a new store, read from disk at boot
    app = makeApp()
    scopes.load()
    asOwner(app, 't0k')
    expect(((await loads()) as Loads & { undo: unknown[] }).undo).toHaveLength(1)
    expect((await undo({ group: 'tab' })).statusCode).toBe(200)
    // exactly the entries that click changed: github, off before it, stays off
    expect(readLocal()).toEqual({ disabledMcpjsonServers: ['github'] })
  })

  it('undo is refused — and the set dropped — once that place no longer reads as the click left it', async () => {
    expect((await bulk({ keys: KEYS, to: 'off' })).statusCode).toBe(200)
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'mcp:project:linear', to: 'on' })).statusCode).toBe(200)
    expect(((await loads()) as Loads & { undo: unknown[] }).undo).toEqual([])
    const r = await undo({})
    expect(r.statusCode).toBe(404)
    expect(readLocal()).toEqual({ disabledMcpjsonServers: ['github'], enabledPlugins: { 'team-plan@silos': false } })
    // a hand edit between the click and the undo: 409, nothing undone
    expect((await bulk({ keys: KEYS, to: 'on' })).statusCode).toBe(200)
    writeFileSync(localFile(), JSON.stringify({ disabledMcpjsonServers: ['github'] }))
    const refused = await undo({})
    expect(refused.statusCode).toBe(409)
    expect(readLocal()).toEqual({ disabledMcpjsonServers: ['github'] })
    expect(scopes.undoAt(`project:${folder}`)).toBeNull()
  })

  it("an account group uses its head key, not its items; the machine's head waits for its yes", async () => {
    const p = (await bulk({ origins: ['connectors'], to: 'off', preview: true })).json().preview
    expect(p.heads).toEqual(['connectors'])
    expect((await bulk({ origins: ['connectors'], to: 'off' })).statusCode).toBe(200)
    expect(readLocal()).toEqual({ disableClaudeAiConnectors: true })
    expect((await undo({})).statusCode).toBe(200)
    expect(readLocal().disableClaudeAiConnectors).toBeUndefined()
    // the machine: its sentence said in the preview, refused without the yes
    const m = (await bulk({ origins: ['connectors'], to: 'off', scope: 'machine', preview: true })).json().preview
    expect(m.asks).toHaveLength(1)
    const before = readFileSync(userFile(), 'utf8')
    expect((await bulk({ origins: ['connectors'], to: 'off', scope: 'machine' })).statusCode).toBe(409)
    expect(readFileSync(userFile(), 'utf8')).toBe(before)
    expect((await bulk({ origins: ['connectors'], to: 'off', scope: 'machine', confirmed: true })).statusCode).toBe(200)
    expect(JSON.parse(readFileSync(userFile(), 'utf8')).disableClaudeAiConnectors).toBe(true)
  })

  it('«Only <agent>» writes the two-sided set for each family', async () => {
    // an override kind (a plugin): off in the project, on for Builder; Writer's own «on» goes
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'plugin:team-plan@silos', to: 'off' })).statusCode).toBe(200)
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'plugin:team-plan@silos', to: 'on', scope: 'agent', agent: 'writer' })).statusCode).toBe(
      200,
    )
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'plugin:team-plan@silos', to: 'on' })).statusCode).toBe(200)
    const pv = (await only({ key: 'plugin:team-plan@silos', agent: 'builder', preview: true })).json().preview
    expect(pv).toMatchObject({ family: 'override', project: 'off', others: ['Writer'] })
    expect(readLocal().enabledPlugins).toBeUndefined()
    expect((await only({ key: 'plugin:team-plan@silos', agent: 'builder' })).statusCode).toBe(200)
    expect(readLocal().enabledPlugins).toEqual({ 'team-plan@silos': false })
    expect(await lineOf('plugin:team-plan@silos', 'agent', 'builder')).toMatchObject({ entry: 'on', result: 'on' })
    expect(await lineOf('plugin:team-plan@silos', 'agent', 'writer')).toMatchObject({ result: 'off' })
    expect((await lineOf('plugin:team-plan@silos', 'agent', 'writer'))?.entry).toBeUndefined()
    // an off-only kind (a server): on in the project, off for every other agent
    expect((await post(`/api/folders/${path()}/loads/switch`, { key: 'mcp:project:github', to: 'off' })).statusCode).toBe(200)
    expect((await only({ key: 'mcp:project:github', agent: 'builder', preview: true })).json().preview).toMatchObject({
      family: 'off-only',
      project: 'on',
      agents: [{ id: 'writer', to: 'off' }],
    })
    expect((await only({ key: 'mcp:project:github', agent: 'builder' })).statusCode).toBe(200)
    expect(readLocal().disabledMcpjsonServers).toBeUndefined()
    expect(await lineOf('mcp:project:github', 'agent', 'builder')).toMatchObject({ result: 'on' })
    expect(await lineOf('mcp:project:github', 'agent', 'writer')).toMatchObject({ entry: 'off', result: 'off' })
  })

  it("«Turn all off here» in a conversation's column: one payload kept under its thread, its undo there; an unknown session is 404", async () => {
    const mf = mungePath(folder)
    mkdirSync(join(base, 'projects', mf), { recursive: true })
    writeFileSync(
      join(base, 'projects', mf, 'conv-a.jsonl'),
      JSON.stringify({ type: 'user', sessionId: 'conv-a', cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) +
        '\n',
    )
    await idx.refresh(mf, 'conv-a')
    const saves = vi.spyOn(scopes, 'recordMany')
    const r = await bulk({ keys: KEYS, to: 'off', scope: 'conversation', conversation: 'conv-a', group: 'here' })
    expect(r.statusCode).toBe(200)
    expect(r.json().done.changes).toEqual({ plugin: 1, mcp: 2, connector: 0 })
    expect(saves).toHaveBeenCalledTimes(1)
    expect(existsSync(localFile())).toBe(false)
    const kept = scopes.get('conversations', 'conv-a', 'claude-code')!
    expect(kept.entries).toEqual({ disabledMcpjsonServers: ['github', 'linear'], enabledPlugins: { 'team-plan@silos': false } })
    const col = (await get(`/api/folders/${path()}/loads?conversation=conv-a`)).json() as { undo: { scope: string; group: string }[] }
    expect(col.undo).toEqual([expect.objectContaining({ scope: 'conversation', group: 'here' })])
    // the project's page does not carry the column's set
    expect(((await loads()) as Loads & { undo: unknown[] }).undo).toEqual([])
    expect((await undo({ scope: 'conversation', conversation: 'conv-a', group: 'here' })).statusCode).toBe(200)
    expect(scopes.get('conversations', 'conv-a', 'claude-code')).toBeNull()
    expect((await bulk({ keys: KEYS, to: 'off', scope: 'conversation', conversation: 'nope' })).statusCode).toBe(404)
  })

  it("«Only <agent>» for an agent that is not the folder's writes nothing; one the machine keeps off is refused, saying where; a bearer is refused", async () => {
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    registry.create({ id: 'outsider', name: 'Outsider', folder: elsewhere })
    const snapshot = () =>
      JSON.stringify([readLocal(), existsSync(join(base, 'data', 'loads-scopes.json')) ? readFileSync(join(base, 'data', 'loads-scopes.json'), 'utf8') : null])
    const before = snapshot()
    expect((await only({ key: 'mcp:project:github', agent: 'outsider' })).statusCode).toBe(404)
    expect((await only({ key: 'mcp:project:github', agent: 'nobody' })).statusCode).toBe(404)
    expect((await bulk({ keys: KEYS, to: 'off', scope: 'agent', agent: 'outsider' })).statusCode).toBe(404)
    expect(snapshot()).toBe(before)
    writeFileSync(userFile(), JSON.stringify({ enabledPlugins: { 'team-plan@silos': true }, deniedMcpServers: [{ serverName: 'linear' }] }))
    const r = await only({ key: 'mcp:project:linear', agent: 'builder' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('this whole machine')
    expect(snapshot()).toBe(before)
    const bearer = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` }
    expect((await only({ key: 'mcp:project:github', agent: 'builder' }, bearer)).statusCode).toBe(403)
    expect((await bulk({ keys: KEYS, to: 'off' }, bearer)).statusCode).toBe(403)
    expect((await post(`/api/folders/${path()}/loads/bulk/undo`, { group: 'project' }, bearer)).statusCode).toBe(403)
    expect((await bulk({ keys: 'all', to: 'off' })).statusCode).toBe(400)
    expect((await bulk({ keys: KEYS, to: 'off', group: '' })).statusCode).toBe(400)
    expect(snapshot()).toBe(before)
  })
})

// spec scopes §4 on Skills (T15) — all / nothing at one place for skills:
// `skillOverrides` entries in one write, a folder copy through the held
// store, the account's skills by their head key; undo exact, refused once
// the place changed; what the engine locks is never touched
describe('all / nothing on Skills, and its «Undo»', () => {
  const path = () => encodeURIComponent(folder)
  const localFile = () => join(folder, '.claude', 'settings.local.json')
  const readLocal = () => (existsSync(localFile()) ? JSON.parse(readFileSync(localFile(), 'utf8')) : {}) as Record<string, unknown>
  const userFile = () => join(home, '.claude', 'settings.json')
  const readUser = () => JSON.parse(readFileSync(userFile(), 'utf8')) as Record<string, unknown>
  const bulk = (payload: Record<string, unknown>) => post(`/api/folders/${path()}/loads/bulk`, { group: 'skills:you', ...payload })
  const undo = (payload: Record<string, unknown>) => post(`/api/folders/${path()}/loads/bulk/undo`, { group: 'skills:you', ...payload })
  const skillAt = (dir: string, name: string): void => {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does things\n---\nbody\n`)
  }
  const PERSONAL = [
    { name: 'brief', from: 'personal' },
    { name: 'digest', from: 'personal' },
    { name: '__proto__', from: 'personal' },
  ]
  let writes = 0
  beforeEach(() => {
    for (const n of ['brief', 'digest', '__proto__']) skillAt(join(home, '.claude', 'skills'), n)
    for (const n of ['notes', 'drafts'])
      skillAt(join(home, '.claude', 'skills', 'synced', '00000000-0000-4000-8000-00000000000a_00000000-0000-4000-8000-00000000000b'), n)
    skillAt(join(folder, '.claude', 'skills'), 'deploy')
    registry.create({ id: 'builder', name: 'Builder', folder })
    writes = 0
    setSealHooks({
      afterOwnEdit: () => {
        writes++
      },
    })
  })
  afterEach(() => {
    setSealHooks(null)
  })

  it("counts first and writes nothing; the click is ONE write of the place's entries; a locked skill is decided elsewhere and untouched", async () => {
    const p = await bulk({ skills: [...PERSONAL, { name: 'demo:helper', from: 'plugin' }], to: 'off', preview: true })
    expect(p.statusCode).toBe(200)
    // __proto__: a name settings can't store; a plugin's: comes and goes with its plugin — the engine ignores any entry
    expect(p.json().preview).toMatchObject({ to: 'off', scope: 'project', changes: { skill: 2 }, heads: [], cannot: 2 })
    expect(existsSync(localFile())).toBe(false)
    expect((await bulk({ skills: [...PERSONAL, { name: 'demo:helper', from: 'plugin' }], to: 'off' })).statusCode).toBe(200)
    expect(writes).toBe(1)
    expect(readLocal()).toEqual({ skillOverrides: { brief: 'off', digest: 'off' } })
    // «on»: each entry goes (what the project follows is no entry)
    expect((await bulk({ skills: PERSONAL, to: 'on' })).statusCode).toBe(200)
    expect(writes).toBe(2)
    expect(readLocal().skillOverrides).toBeUndefined()
    // tools and skills in one click, a skill of no known copy: refused, nothing written
    expect((await bulk({ skills: PERSONAL, keys: ['mcp:project:github'], to: 'off' })).statusCode).toBe(400)
    expect((await bulk({ skills: [{ name: 'brief', from: 'elsewhere' }], to: 'off' })).statusCode).toBe(400)
    expect(writes).toBe(2)
  })

  it("«on» writes «on» only where it must override a wider «off»; the machine's click writes the user's file and never reaches a project's own copy", async () => {
    const all = [...PERSONAL, { name: 'deploy', from: 'project' }]
    const m = (await bulk({ skills: all, to: 'off', scope: 'machine', preview: true })).json().preview
    expect(m).toMatchObject({ changes: { skill: 2 }, cannot: 1 })
    expect((await bulk({ skills: all, to: 'off', scope: 'machine' })).statusCode).toBe(200)
    expect(readUser().skillOverrides).toEqual({ brief: 'off', digest: 'off' })
    expect(readUser().enabledPlugins).toEqual({ 'team-plan@silos': true })
    expect(writes).toBe(0)
    expect((await bulk({ skills: PERSONAL, to: 'on' })).statusCode).toBe(200)
    expect(readLocal()).toEqual({ skillOverrides: { brief: 'on', digest: 'on' } })
  })

  it('undo puts back exactly each entry — a «name only» too — and is refused, the set dropped, once the place changed', async () => {
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(localFile(), JSON.stringify({ skillOverrides: { digest: 'name-only' }, permissions: { allow: ['Bash(ls)'] } }))
    expect((await bulk({ skills: PERSONAL, to: 'off' })).statusCode).toBe(200)
    expect(readLocal().skillOverrides).toEqual({ digest: 'off', brief: 'off' })
    const view = ((await loads()) as Loads & { undo: { group: string; kind?: string; counts: Record<string, number> }[] }).undo
    expect(view).toEqual([expect.objectContaining({ group: 'skills:you', kind: 'skills', counts: { skill: 2 } })])
    // another head of the same place is not this one's
    expect((await undo({ group: 'tab' })).statusCode).toBe(404)
    expect((await undo({})).statusCode).toBe(200)
    expect(writes).toBe(2)
    expect(readLocal()).toEqual({ skillOverrides: { digest: 'name-only' }, permissions: { allow: ['Bash(ls)'] } })
    expect(scopes.undoAt(`project:${folder}`)).toBeNull()
    // a switch between the click and the undo: 409, nothing undone
    expect((await bulk({ skills: PERSONAL, to: 'off' })).statusCode).toBe(200)
    expect((await post(`/api/folders/${path()}/skills/brief/position`, { to: 'on', from: 'personal' })).statusCode).toBe(200)
    const refused = await undo({})
    expect(refused.statusCode).toBe(409)
    expect(readLocal().skillOverrides).toEqual({ digest: 'off' })
    expect(scopes.undoAt(`project:${folder}`)).toBeNull()
  })

  it("at an agent's place: one payload kept once, nothing on disk; a project's own copy turns off there too; undo restores it", async () => {
    const saves = vi.spyOn(scopes, 'recordMany')
    const r = await bulk({ skills: [...PERSONAL, { name: 'deploy', from: 'project' }], to: 'off', scope: 'agent', agent: 'builder' })
    expect(r.statusCode).toBe(200)
    expect(r.json().done).toMatchObject({ changes: { skill: 3 }, cannot: 1 })
    expect(saves).toHaveBeenCalledTimes(1)
    expect(existsSync(localFile())).toBe(false)
    expect(scopes.get('agents', 'builder', 'claude-code')!.entries).toEqual({ skillOverrides: { brief: 'off', digest: 'off', deploy: 'off' } })
    expect((await undo({ scope: 'agent', agent: 'builder' })).statusCode).toBe(200)
    expect(scopes.get('agents', 'builder', 'claude-code')).toBeNull()
  })

  it("the Claude account's skills go by their head key: one entry, counted by the skills it reaches; undo takes it back", async () => {
    const acct = [
      { name: 'notes', from: 'account' },
      { name: 'drafts', from: 'account' },
    ]
    const p = (await bulk({ skills: acct, origins: ['skills'], to: 'off', preview: true, group: 'skills:account' })).json().preview
    expect(p).toMatchObject({ heads: ['skills'], changes: { skill: 2 }, cannot: 0 })
    expect((await bulk({ skills: acct, origins: ['skills'], to: 'off', group: 'skills:account' })).statusCode).toBe(200)
    expect(readLocal()).toEqual({ syncClaudeAiSkills: false })
    expect((await undo({ group: 'skills:account' })).statusCode).toBe(200)
    expect(readLocal().syncClaudeAiSkills).toBeUndefined()
  })

  it("a project's own copies at the project's place move to Silos' held store and back with Undo", async () => {
    await app.close()
    app = makeApp({ dataDir: join(base, 'data') })
    asOwner(app, 't0k')
    const own = [{ name: 'deploy', from: 'project' }]
    expect((await bulk({ skills: own, to: 'off', preview: true, group: 'skills:project' })).json().preview).toMatchObject({ changes: { skill: 1 }, cannot: 0 })
    expect((await bulk({ skills: own, to: 'off', group: 'skills:project' })).statusCode).toBe(200)
    expect(existsSync(join(folder, '.claude', 'skills', 'deploy', 'SKILL.md'))).toBe(false)
    expect(existsSync(localFile())).toBe(false)
    expect((await undo({ group: 'skills:project' })).statusCode).toBe(200)
    expect(existsSync(join(folder, '.claude', 'skills', 'deploy', 'SKILL.md'))).toBe(true)
  })
})
