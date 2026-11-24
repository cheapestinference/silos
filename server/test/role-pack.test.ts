import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AutomationsStore } from '../src/automations-store.js'
import { Resident } from '../src/resident.js'
import { buildServer } from '../src/server.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { AgentStateStore } from '../src/agent-state.js'
import { VaultStore } from '../src/vault-store.js'
import { AutomationTemplates, fromAutomation } from '../src/automation-templates.js'
import { checkPack, consequences, folderSkillsOf, PACK_KIND } from '../src/role-pack.js'
import { TerritoryStore } from '../src/territory-store.js'
import { PlatformSettingsStore } from '../src/platform-settings.js'
import { LoadsScopesStore } from '../src/loads-scopes.js'
import type { QueryArgs, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

const TOKEN = 't0k-rolepack'
let base: string, dataDir: string, folder: string
let registry: AgentRegistry, automations: AutomationsStore, resident: Resident, agentState: AgentStateStore
let agentTokens: AgentTokens, vault: VaultStore, templates: AutomationTemplates, app: FastifyInstance
let silos: Record<string, { producers: string[]; decision: string; provenance?: string }>
let submitted: unknown[]
let territoryStore: TerritoryStore
let loadsScopes: LoadsScopesStore

const noQuery = (_a: QueryArgs): SdkQueryHandle => ({
  async *[Symbol.asyncIterator]() {
    /* never */
  },
  async interrupt() {
    return undefined
  },
})

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'silos-rolepack-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  folder = join(base, 'company')
  for (const d of [root, join(dataDir, 'trash'), folder]) mkdirSync(d, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'), { folderCheck: { home: base, dataDir } })
  registry.load()
  registry.create({
    id: 'finance',
    name: 'Finance',
    emoji: '🧭',
    folder,
    mission: { text: 'Tax office deadlines met and Ledgerly up to date', never: ["file without the owner's OK"] },
  })
  agentTokens = new AgentTokens(dataDir)
  const native = new NativeStore(join(dataDir, 'native.json'))
  const chat = new ChatService({ registry, native, queryFn: noQuery, dataDir })
  automations = new AutomationsStore(dataDir)
  automations.load()
  agentState = new AgentStateStore(join(dataDir, 'agent-state'))
  resident = new Resident({ store: automations, registry, chat, native, index, root, dataDir, broadcast: () => {}, tickIntervalMs: 999_999_999 })
  vault = new VaultStore(join(dataDir, 'vault.json'))
  vault.load()
  templates = new AutomationTemplates(dataDir)
  territoryStore = new TerritoryStore(dataDir)
  territoryStore.load()
  // a fake silo stack: invoices installed and produced by finance; 'own' is the operator's own silo
  silos = { invoices: { producers: ['finance'], decision: 'approved', provenance: 'builtin' } }
  submitted = []
  mkdirSync(join(dataDir, 'silos', 'registry', 'invoices'), { recursive: true })
  const siloOperator = {
    get: (id: string) => silos[id] ?? null,
    list: () => Object.entries(silos).map(([id, s]) => ({ id, ...s })),
  }
  const siloRegistry = {
    registryDir: join(dataDir, 'silos', 'registry'),
    get: (id: string) => (silos[id] ? { id, manifest: {}, status: { manifest: { version: '0.1.1' } } } : null),
  }
  const siloInstaller = {
    operatorPatch: (id: string, body: { producers: string[] }) => {
      silos[id]!.producers = body.producers
      return { code: 200, body: {} }
    },
    submit: (body: unknown, _by: string, opts?: unknown) => {
      submitted.push({ body, opts })
      return { code: 201, body: {} }
    },
  }
  app = buildServer({
    index,
    registry,
    store: new SessionStore(root, dataDir),
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    token: TOKEN,
    liveMs: 120_000,
    automations,
    resident,
    agentTokens,
    agentState,
    vault,
    automationTemplates: templates,
    siloOperator: siloOperator as never,
    siloRegistry: siloRegistry as never,
    siloInstaller: siloInstaller as never,
    territoryStore,
    loadsScopes: (loadsScopes = new LoadsScopesStore(dataDir)),
    platformSettings: (() => {
      const p = new PlatformSettingsStore(dataDir)
      p.load()
      return p
    })(),
    home: join(base, 'home'),
  })
  // finance's role: one skill (two files), one automation of its own, a secret scoped to it
  const skills = join(agentState.dirFor('finance'), 'plugin', 'skills', 'quarterly-vat')
  mkdirSync(join(skills, 'ref'), { recursive: true })
  writeFileSync(join(skills, 'SKILL.md'), '---\nname: quarterly-vat\ndescription: the quarterly VAT return\n---\nQuarterly VAT steps.\n')
  writeFileSync(join(skills, 'ref', 'boxes.md'), 'box 71\n')
  vault.create({ name: 'LEDGERLY_API_KEY', value: 'lk-live-0123456789abcdef', scope: { type: 'agents', agentIds: ['finance'] } })
  automations.create({
    id: 'a-sync',
    name: 'Sync Ledgerly',
    agentId: 'finance',
    prompt: 'Sync with $LEDGERLY_API_KEY.',
    trigger: { kind: 'cron', expr: '15 6 * * *' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: true,
    paused: false,
    createdAt: '2026-11-07T00:00:00Z',
  })
})

afterEach(() => resident.stop())

const owner = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-token': TOKEN }, payload: payload as object })
const asCfo = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { host: '127.0.0.1:3210', authorization: `Bearer ${agentTokens.tokenFor('finance')}` }, payload: payload as object })

const minimal = (over: Record<string, unknown> = {}) => ({
  kind: PACK_KIND,
  version: 1,
  id: 'finance-es',
  packVersion: '0.1.0',
  name: 'Finance',
  files: {},
  ...over,
})

describe('a pack file is judged before anything happens', () => {
  it('refuses a secret value, a path outside the pack, a skill file nobody declares, a skill without SKILL.md, a broken template', () => {
    expect(() => checkPack(minimal({ secrets: [{ name: 'LEDGERLY_API_KEY', value: 'x' }] }))).toThrow('never carries its value')
    expect(() => checkPack(minimal({ files: { '../../.ssh/id': 'x' } }))).toThrow('not a path inside the pack')
    expect(() => checkPack(minimal({ files: { 'notes/x.md': 'x' } }))).toThrow('skills/<name>')
    expect(() => checkPack(minimal({ files: { 'skills/x/SKILL.md': 'x' } }))).toThrow('does not declare')
    expect(() => checkPack(minimal({ skills: [{ name: 'x' }] }))).toThrow('has no skills/x/SKILL.md')
    expect(() => checkPack(minimal({ automations: [{ template: 't' }], files: { 'automations/t.json': '{"kind":"nope"}' } }))).toThrow('automations/t.json')
    expect(() => checkPack({ kind: 'other' })).toThrow('not a role pack')
  })
  // role/charter/instructions became the mission — a
  // pack made before has no honest reading, and the route says why (400)
  it('a pack made before missions is refused, named so', async () => {
    for (const old of [{ role: 'Accounting' }, { charter: 'Tax office deadlines' }, { instructions: 'Never file' }]) {
      expect(() => checkPack(minimal(old))).toThrow('this pack predates missions')
      const res = await owner('POST', '/api/role-packs/preview', { pack: minimal(old), target: { id: 'x', folder } })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('this pack predates missions')
    }
    expect(() => checkPack(minimal({ mission: { text: '' } }))).toThrow('mission.text must be 1–2000 characters')
    expect(checkPack(minimal({ mission: { text: ' Books. ', never: ['pay', ''] } })).mission).toEqual({ text: 'Books.', never: ['pay'] })
    expect(checkPack(minimal()).mission).toBeUndefined()
  })
})

describe('Save as role pack', () => {
  it('takes the mission, the skills with their files, the automations as templates (never the beat), the silos and the secret NAMES', async () => {
    const res = await owner('GET', '/api/agents/finance/role-pack')
    expect(res.statusCode).toBe(200)
    const { pack, skipped } = res.json()
    expect(pack).toMatchObject({
      kind: PACK_KIND,
      id: 'finance',
      name: 'Finance',
      emoji: '🧭',
      mission: { text: 'Tax office deadlines met and Ledgerly up to date', never: ["file without the owner's OK"] },
    })
    expect('role' in pack || 'charter' in pack || 'instructions' in pack).toBe(false)
    expect(pack.skills).toEqual([{ name: 'quarterly-vat' }])
    expect(Object.keys(pack.files).sort()).toEqual(['automations/sync-ledgerly.json', 'skills/quarterly-vat/SKILL.md', 'skills/quarterly-vat/ref/boxes.md'])
    expect(pack.automations).toEqual([{ template: 'sync-ledgerly' }])
    expect(pack.produces).toEqual([{ silo: 'invoices', version: '0.1.1' }]) // a built-in travels by id
    expect(pack.secrets).toEqual([{ name: 'LEDGERLY_API_KEY', why: '' }])
    expect(JSON.stringify(pack)).not.toContain('lk-live')
    expect(skipped).toEqual([])
  })
  it('a secret value written into the role refuses the export, naming the variable', async () => {
    writeFileSync(join(agentState.dirFor('finance'), 'plugin', 'skills', 'quarterly-vat', 'SKILL.md'), 'uses lk-live-0123456789abcdef\n')
    const res = await owner('GET', '/api/agents/finance/role-pack')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('LEDGERLY_API_KEY')
    expect(res.json().error).not.toContain('lk-live')
    expect(res.json().secret).toMatchObject({ name: 'LEDGERLY_API_KEY', where: ['skills/quarterly-vat/SKILL.md'] })
  })
  it('a value the owner marks public in the Vault (a project id) exports — the refusal names its entry; a secret still refuses', async () => {
    const e = vault.create({ name: 'PROJECT_ID', value: 'public-company', scope: { type: 'agents', agentIds: ['other'] } })
    registry.update('finance', { mission: { text: 'Tax office deadlines of public-company' } })
    const refused = await owner('GET', '/api/agents/finance/role-pack')
    expect(refused.statusCode).toBe(400)
    expect(refused.json().secret).toEqual({ name: 'PROJECT_ID', where: ['its mission'], id: e.id })
    vault.setPublic(e.id, true)
    const ok = await owner('GET', '/api/agents/finance/role-pack')
    expect(ok.statusCode).toBe(200)
    expect(ok.json().pack.mission).toEqual({ text: 'Tax office deadlines of public-company', never: [] })
    // …and an automation holding it is exported too, not skipped
    automations.update('a-sync', { prompt: 'Sync public-company with $LEDGERLY_API_KEY.' })
    const again = (await owner('GET', '/api/agents/finance/role-pack')).json()
    expect(again.skipped).toEqual([])
    expect(again.pack.automations).toEqual([{ template: 'sync-ledgerly' }])
    // a public entry never lets a secret through
    writeFileSync(join(agentState.dirFor('finance'), 'plugin', 'skills', 'quarterly-vat', 'SKILL.md'), 'uses lk-live-0123456789abcdef\n')
    expect((await owner('GET', '/api/agents/finance/role-pack')).json().secret?.name).toBe('LEDGERLY_API_KEY')
  })
  it("is the owner's: the agent's own bearer gets 403", async () => {
    expect((await asCfo('GET', '/api/agents/finance/role-pack')).statusCode).toBe(403)
    expect((await asCfo('POST', '/api/role-packs/preview', { pack: minimal(), target: { id: 'x', folder } })).statusCode).toBe(403)
  })
})

describe('installing a pack', () => {
  const packOf = async () => (await owner('GET', '/api/agents/finance/role-pack')).json().pack
  // the project folder check (project-folder.ts) is the install's too: the
  // preview names the refusal, the install makes nothing
  it('a folder no project may have is a problem in the preview and a 400 at install, with no agent made', async () => {
    const pack = await packOf()
    for (const bad of [dataDir, join(folder, 'sub'), base]) {
      const preview = (await owner('POST', '/api/role-packs/preview', { pack, target: { id: 'finance-two', folder: bad } })).json().consequences
      expect(preview.problems.join(' '), bad).toMatch(/a project needs a folder of its own|inside the project at|holds/)
      expect((await owner('POST', '/api/role-packs/install', { pack, target: { id: 'finance-two', folder: bad } })).statusCode).toBe(400)
    }
    expect(registry.get('finance-two')).toBeNull()
  })
  // spec scopes §6: what one agent loads names this machine's things — a
  // pack never carries it, out or in
  it('carries none of what the agent loads at launch: not in the saved pack, not given to the agent a pack installs', async () => {
    loadsScopes.record('agents', 'finance', 'claude-code', 'mcp:user:ledger-mcp', {
      payload: { deniedMcpServers: [{ serverName: 'ledger-mcp' }] },
      changed: true,
      held: true,
    })
    const pack = await packOf()
    expect(JSON.stringify(pack)).not.toContain('ledger-mcp')
    const res = await owner('POST', '/api/role-packs/install', {
      pack: { ...pack, loads: { deniedMcpServers: [{ serverName: 'x' }] } },
      target: { id: 'finance-two', name: 'Finance-two', folder },
    })
    expect(res.statusCode).toBe(201)
    expect(loadsScopes.get('agents', 'finance-two', 'claude-code')).toBeNull()
  })
  it('the preview says what will happen and changes nothing', async () => {
    const pack = await packOf()
    const before = JSON.stringify(registry.list())
    const res = await owner('POST', '/api/role-packs/preview', { pack, target: { id: 'finance-demo', name: 'Finance-demo', folder } })
    expect(res.statusCode).toBe(200)
    const c = res.json().consequences
    expect(c.agent).toMatchObject({
      id: 'finance-demo',
      name: 'Finance-demo',
      mission: { text: 'Tax office deadlines met and Ledgerly up to date', never: ["file without the owner's OK"] },
    })
    expect(c.skills).toEqual([{ name: 'quarterly-vat', files: 2 }])
    expect(c.silos).toEqual([{ silo: 'invoices', action: 'bind', version: '0.1.1', wanted: '0.1.1' }])
    expect(c.automations).toMatchObject([{ template: 'sync-ledgerly', ready: true, ownerOnly: false, blanks: [] }])
    expect(c.secrets).toEqual([{ name: 'LEDGERLY_API_KEY', why: '', present: false }])
    expect(c.problems).toEqual([])
    expect(JSON.stringify(registry.list())).toBe(before)
  })
  it('installs: a new agent remembering its pack, with its mission, its skills + lockfile, the chosen automation, invoices bound, the secret stored for it alone', async () => {
    const pack = await packOf()
    const res = await owner('POST', '/api/role-packs/install', {
      pack,
      target: { id: 'finance-demo', name: 'Finance-demo', folder },
      automations: ['sync-ledgerly'],
      secrets: { LEDGERLY_API_KEY: 'lk-demo-9999999999' },
    })
    expect(res.statusCode).toBe(201)
    const { agent, report } = res.json()
    expect(agent).toMatchObject({
      id: 'finance-demo',
      name: 'Finance-demo',
      pack: { id: 'finance', packVersion: '0.1.0' },
      mission: { text: 'Tax office deadlines met and Ledgerly up to date', never: ["file without the owner's OK"], updatedAt: expect.any(String) },
    })
    expect(agent.responsibility).toBeUndefined()
    const dir = agentState.dirFor('finance-demo')
    expect(readFileSync(join(dir, 'plugin', 'skills', 'quarterly-vat', 'ref', 'boxes.md'), 'utf8')).toBe('box 71\n')
    expect(existsSync(join(dir, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true)
    const lock = JSON.parse(readFileSync(join(dir, 'plugin', '.pack.json'), 'utf8'))
    expect(Object.keys(lock.files).sort()).toEqual(['quarterly-vat/SKILL.md', 'quarterly-vat/ref/boxes.md'])
    expect(JSON.parse(readFileSync(join(dir, 'pack-state.json'), 'utf8')).pack).toEqual({ id: 'finance', packVersion: '0.1.0' })
    expect(report.skillFiles).toBe(2)
    const made = automations.list().filter((a) => a.agentId === 'finance-demo')
    // a mission is no old duty: no beat is materialized from it (t3 brings the heartbeat)
    expect(made.map((a) => a.name).sort()).toEqual(['Sync Ledgerly'])
    expect(report.automations[0]).toMatchObject({ template: 'sync-ledgerly', saved: 'finance-sync-ledgerly' })
    expect(templates.get('finance-sync-ledgerly')?.source).toBe('user')
    expect(silos.invoices!.producers).toEqual(['finance', 'finance-demo'])
    expect(report.silos).toEqual([{ silo: 'invoices', done: 'bound' }])
    const entry = vault.list().find((e) => e.value === 'lk-demo-9999999999')
    expect(entry?.scope).toEqual({ type: 'agents', agentIds: ['finance-demo'] })
    expect(report.secrets).toEqual([{ name: 'LEDGERLY_API_KEY', state: 'stored' }])
  })
  it('an automation not chosen is only saved as a template; a silo the pack carries is submitted, pending; one it lacks is said missing', async () => {
    const pack = await packOf()
    pack.produces.push({ silo: 'own' }, { silo: 'absent' })
    pack.files['silos/own.silo.json'] = JSON.stringify({ apiVersion: 'silos/v0', metadata: { id: 'own' } })
    const res = await owner('POST', '/api/role-packs/install', { pack, target: { id: 'finance-b', folder } })
    expect(res.statusCode).toBe(201)
    const { report } = res.json()
    expect(
      automations
        .list()
        .filter((a) => a.agentId === 'finance-b')
        .map((a) => a.name),
    ).toEqual([])
    expect(report.silos).toEqual([
      { silo: 'invoices', done: 'bound' },
      { silo: 'own', done: 'submitted' },
      { silo: 'absent', done: 'missing' },
    ])
    expect(submitted).toHaveLength(1)
    // the new agent is the submission's proposed producer: approving binds it with no choice to make
    expect(submitted[0]).toMatchObject({ opts: { producers: ['finance-b'] } })
    expect(report.secrets).toEqual([{ name: 'LEDGERLY_API_KEY', state: 'missing' }])
  })
  it('refuses an id already taken (one pack, many agents — never over an existing one)', async () => {
    const res = await owner('POST', '/api/role-packs/install', { pack: await packOf(), target: { id: 'finance', folder } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('already exists')
    expect(territoryStore.enabled()).toEqual([]) // a refused install fences nobody
  })
  // fence at birth is a rule of agent CREATION — the
  // agent a pack installs is born fenced, next to the ones already on
  it('the agent a pack installs is born fenced', async () => {
    territoryStore.setEnabled(['finance'])
    const res = await owner('POST', '/api/role-packs/install', { pack: await packOf(), target: { id: 'finance-f', folder } })
    expect(res.statusCode).toBe(201)
    expect(res.json().warn).toBeUndefined()
    expect(territoryStore.enabled()).toEqual(['finance', 'finance-f'])
    expect(JSON.parse(readFileSync(join(dataDir, 'territory.json'), 'utf8')).enabled).toEqual(['finance', 'finance-f'])
  })
  // review A7: the fence goes on right after the create — a failure later in
  // the install never leaves the agent created-but-unfenced
  it('a failure after the create leaves the agent fenced', async () => {
    const pack = await packOf()
    const update = registry.update.bind(registry)
    registry.update = ((id: string, patch: never) => {
      if (id === 'finance-x') throw new Error('disk full')
      return update(id, patch)
    }) as typeof registry.update
    const res = await owner('POST', '/api/role-packs/install', { pack, target: { id: 'finance-x', folder } })
    expect(res.statusCode).toBe(400)
    expect(registry.get('finance-x')).not.toBeNull()
    expect(territoryStore.isEnabled('finance-x')).toBe(true)
  })
  it('a fence that cannot be turned on: the install still lands, said in warn', async () => {
    territoryStore.setEnabled = () => {
      throw new Error('read-only data dir')
    }
    const res = await owner('POST', '/api/role-packs/install', { pack: await packOf(), target: { id: 'finance-w', folder } })
    expect(res.statusCode).toBe(201)
    expect(res.json().warn).toContain('read-only data dir')
    expect(res.json().warn).toContain('Turn it on in its Settings')
  })
  // the birth seam (starting-set.ts): a folder's first agent of an engine
  // sets what the project starts with — a folder that has one is untouched
  it('the agent a pack installs in a new folder gives it its starting set; in a project already, nothing', async () => {
    const fresh = join(base, 'fresh')
    mkdirSync(fresh)
    expect((await owner('POST', '/api/role-packs/install', { pack: await packOf(), target: { id: 'finance-n', folder: fresh } })).statusCode).toBe(201)
    expect(JSON.parse(readFileSync(join(fresh, '.claude', 'settings.local.json'), 'utf8'))).toEqual({
      syncClaudeAiPlugins: false,
      disableClaudeAiConnectors: true,
    })
    expect((await owner('POST', '/api/role-packs/install', { pack: await packOf(), target: { id: 'finance-p', folder } })).statusCode).toBe(201)
    expect(existsSync(join(folder, '.claude', 'settings.local.json'))).toBe(false)
  })
})

describe("skills from the agent's folder travel only when the owner ticks them", () => {
  it("the lister offers the folder's skills (not Silos' own, not the role's); the export carries the ticked ones; install makes them role skills", async () => {
    mkdirSync(join(folder, '.claude', 'skills', 'finance-company'), { recursive: true })
    writeFileSync(
      join(folder, '.claude', 'skills', 'finance-company', 'SKILL.md'),
      '---\nname: finance-company\ndescription: how this company keeps its books\n---\nBody.\n',
    )
    mkdirSync(join(folder, '.claude', 'skills', 'quarterly-vat'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'skills', 'quarterly-vat', 'SKILL.md'), 'dup of the role skill\n')
    const offered = (await owner('GET', '/api/agents/finance/role-pack/folder-skills')).json().skills
    expect(offered).toEqual([{ name: 'finance-company', description: 'how this company keeps its books', from: 'folder' }])
    expect((await owner('GET', '/api/agents/finance/role-pack')).json().pack.skills.map((s: { name: string }) => s.name)).toEqual(['quarterly-vat'])
    const pack = (await owner('GET', '/api/agents/finance/role-pack?folderSkills=finance-company,../../etc')).json().pack
    expect(pack.skills.map((s: { name: string }) => s.name).sort()).toEqual(['finance-company', 'quarterly-vat'])
    expect(pack.files['skills/finance-company/SKILL.md']).toContain('how this company keeps its books')
    await owner('POST', '/api/role-packs/install', { pack, target: { id: 'finance-z', folder } })
    expect(readFileSync(join(agentState.dirFor('finance-z'), 'plugin', 'skills', 'finance-company', 'SKILL.md'), 'utf8')).toContain('Body.')
    expect((await asCfo('GET', '/api/agents/finance/role-pack/folder-skills')).statusCode).toBe(403)
  })
})

describe('folderSkillsOf — where each offered skill comes from', () => {
  it("a personal skill is offered as personal; Silos' own and the role's are never offered; a folder wins a duplicate name", () => {
    const personal = join(base, 'home', '.claude', 'skills')
    for (const n of ['finance-acme', 'team-plan', 'shared']) {
      mkdirSync(join(personal, n), { recursive: true })
      writeFileSync(join(personal, n, 'SKILL.md'), `---\ndescription: ${n}\n---\n`)
    }
    const proj = join(folder, '.claude', 'skills', 'shared')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'SKILL.md'), '---\ndescription: project copy\n---\n')
    const got = folderSkillsOf(
      [
        { base: join(folder, '.claude', 'skills'), from: 'folder' },
        { base: personal, from: 'personal' },
      ],
      new Set(['team-plan']),
      new Set(['quarterly-vat']),
    )
    expect(got.map(({ name, from, description }) => ({ name, from, description }))).toEqual([
      { name: 'shared', from: 'folder', description: 'project copy' },
      { name: 'finance-acme', from: 'personal', description: 'finance-acme' },
    ])
  })
})

describe('a command in a pack is never scheduled by a plain opt-in', () => {
  it('chosen alone saves it as a template; confirmed by name makes it; the preview shows the literal command', async () => {
    automations.create({
      id: 'a-cmd',
      name: 'Nightly export',
      agentId: 'finance',
      prompt: '',
      trigger: { kind: 'cron', expr: '0 3 * * *' },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: true,
      paused: false,
      createdAt: '',
      run: { kind: 'command', argv: ['/usr/bin/python3', '/srv/export.py', '--all'], onFailure: 'inbox' },
    })
    const pack = (await owner('GET', '/api/agents/finance/role-pack')).json().pack
    const pre = (await owner('POST', '/api/role-packs/preview', { pack, target: { id: 'finance-x', folder } })).json().consequences
    expect(pre.automations.find((a: { template: string }) => a.template === 'nightly-export')).toMatchObject({
      ownerOnly: true,
      command: '/usr/bin/python3 /srv/export.py --all',
    })
    const plain = (await owner('POST', '/api/role-packs/install', { pack, target: { id: 'finance-x', folder }, automations: ['nightly-export'] })).json()
    expect(plain.report.automations.find((a: { template: string }) => a.template === 'nightly-export')).toMatchObject({
      error: expect.stringContaining('runs a command'),
    })
    expect(automations.list().some((a) => a.agentId === 'finance-x' && a.name === 'Nightly export')).toBe(false)
    await owner('POST', '/api/role-packs/install', {
      pack,
      target: { id: 'finance-y', folder },
      automations: ['nightly-export'],
      confirmCommands: ['nightly-export'],
    })
    expect(automations.list().some((a) => a.agentId === 'finance-y' && a.name === 'Nightly export')).toBe(true)
  })
})

describe('consequences — a template with blanks of its own is not made blind', () => {
  it('a template with a blank and no default is not ready, and says which blank', () => {
    const t = fromAutomation(
      {
        id: 'x',
        name: 'X',
        agentId: 'finance',
        prompt: 'p',
        trigger: { kind: 'cron', expr: '0 6 * * *' },
        thread: { mode: 'new' },
        approval: false,
        keepAlive: true,
        paused: false,
        createdAt: '',
      },
      { id: 'x' },
      [],
    )
    const withBlank = { ...t, params: [...t.params, { key: 'what', kind: 'text', label: 'What' }], automation: { ...t.automation, prompt: 'do {{what}}' } }
    const pack = checkPack(minimal({ automations: [{ template: 'x' }], files: { 'automations/x.json': JSON.stringify(withBlank) } }))
    const c = consequences(pack, { id: 'n', folder: '/srv' }, { agentExists: () => false, siloState: () => null, secretVisible: () => false })
    expect(c.automations[0]).toMatchObject({ ready: false, blanks: ['What'] })
  })
})
