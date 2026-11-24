import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { TerminalService } from '../src/terminal-service.js'
import { PlatformSettingsStore } from '../src/platform-settings.js'
import { buildServer } from '../src/server.js'
import { bornFolders, startingFacts } from '../src/starting-set.js'
import type { LoadsRow } from '../src/harnesses/contract.js'
import { claudeStartingSet } from '../src/harnesses/claude-code/loads/starting-set.js'

// The birth seam (spec tools-origin §8): a folder given to its FIRST agent of
// an engine — by create, a folder change, an extra folder — gets the
// starting set once, key by key, never over a choice already in its file;
// a folder that had an agent (archived included) is untouched; a folder it
// cannot write is a warn, never a failed birth.
const TOKEN = 'testtoken'
const RECOMMENDED = { syncClaudeAiPlugins: false, disableClaudeAiConnectors: true }
let base: string, home: string, dataDir: string
let app: FastifyInstance
let registry: AgentRegistry
let settings: PlatformSettingsStore

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'silos-birth-'))
  home = join(base, 'home')
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  for (const d of [home, root, join(dataDir, 'trash'), join(base, 'claude-sessions')]) mkdirSync(d, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  const native = new NativeStore(join(dataDir, 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {},
      async interrupt() {
        return undefined
      },
    }),
  })
  const terminals = new TerminalService(registry, index, undefined, undefined, {
    sessionsDir: join(base, 'claude-sessions'),
    tmuxSocket: 'silos-birthtest-none',
  })
  settings = new PlatformSettingsStore(dataDir)
  settings.load()
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
    terminals,
    home,
    dataDir,
    platformSettings: settings,
  })
})
afterEach(async () => {
  await app.close()
})

const headers = { 'x-token': TOKEN }
const post = (payload: object) => app.inject({ method: 'POST', url: '/api/agents', headers, payload })
const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/agents/${id}`, headers, payload })
const local = (folder: string): Record<string, unknown> | null => {
  const f = join(folder, '.claude', 'settings.local.json')
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>) : null
}
const existing = (name: string): string => {
  const f = join(base, name)
  mkdirSync(f, { recursive: true })
  return f
}

describe('the birth seam — every path that gives a folder its first agent of an engine', () => {
  it('create, no folder chosen: the directory Silos makes is born with the set', async () => {
    const res = await post({ name: 'Builder' })
    expect(res.statusCode).toBe(201)
    expect(res.json().startWarn).toBeUndefined()
    expect(local(join(home, 'Silos', 'builder'))).toEqual(RECOMMENDED)
  })

  it('create in a folder that existed: born with the set, key by key — a key already in the file is kept', async () => {
    const f = existing('shop')
    mkdirSync(join(f, '.claude'))
    writeFileSync(join(f, '.claude', 'settings.local.json'), JSON.stringify({ syncClaudeAiPlugins: true, permissions: { allow: ['Bash(ls)'] } }))
    expect((await post({ name: 'Builder', folder: f })).statusCode).toBe(201)
    expect(local(f)).toEqual({ syncClaudeAiPlugins: true, permissions: { allow: ['Bash(ls)'] }, disableClaudeAiConnectors: true })
  })

  it('writes once: a second agent in the same folder is no birth — what the owner changed since stays', async () => {
    const f = existing('shop')
    await post({ name: 'Builder', folder: f })
    writeFileSync(join(f, '.claude', 'settings.local.json'), '{}\n') // the owner turned both on
    expect((await post({ name: 'Finance', folder: f })).statusCode).toBe(201)
    expect(local(f)).toEqual({})
  })

  it('a folder that had an agent — archived included — is untouched', async () => {
    const f = existing('old')
    registry.create({ id: 'retired', name: 'Retired', folder: f })
    registry.archive('retired')
    expect((await post({ name: 'Builder', folder: f })).statusCode).toBe(201)
    expect(local(f)).toBeNull()
    // as another agent's extra folder too
    const g = existing('shared')
    registry.create({ id: 'keeper', name: 'Keeper', folder: existing('keeper'), folders: [g] })
    expect((await post({ name: 'Second', folder: g })).statusCode).toBe(201)
    expect(local(g)).toBeNull()
  })

  it('a folder change gives the new folder its birth; the old one is left as it is', async () => {
    const a = existing('a'),
      b = existing('b')
    registry.create({ id: 'builder', name: 'Builder', folder: a })
    const res = await patch('builder', { folder: b })
    expect(res.statusCode).toBe(200)
    expect(local(b)).toEqual(RECOMMENDED)
    expect(local(a)).toBeNull()
    // and a PATCH that changes nothing about folders sets nothing again
    writeFileSync(join(b, '.claude', 'settings.local.json'), '{}\n')
    expect((await patch('builder', { emoji: '🛠' })).statusCode).toBe(200)
    expect(local(b)).toEqual({})
  })

  it('an extra folder is a birth too — for a directory that existed', async () => {
    const a = existing('a'),
      extra = existing('extra')
    registry.create({ id: 'builder', name: 'Builder', folder: a })
    expect((await patch('builder', { folders: [extra] })).statusCode).toBe(200)
    expect(local(extra)).toEqual(RECOMMENDED)
  })

  it('an engine change: the folder is born for the engine it now runs on — never for one that declares no class', () => {
    const f = existing('mixed')
    const oc = { id: 'oc', folder: f, framework: 'opencode' as const }
    // the first agent of OpenCode there: a birth for OpenCode (which sets nothing)
    expect(bornFolders(oc, null, [oc])).toHaveLength(1)
    // the same agent moved to Claude Code: born for Claude Code
    const cc = { ...oc, framework: 'claude-code' as const }
    expect(bornFolders(cc, oc, [cc])).toHaveLength(1)
    // a Claude Code agent already there: no birth
    const other = { id: 'x', folder: f, framework: 'claude-code' as const, archived: true }
    expect(bornFolders(cc, oc, [cc, other])).toEqual([])
    // an archived agent is born nowhere
    expect(bornFolders({ ...cc, archived: true }, null, [cc])).toEqual([])
  })

  it('an agent on an engine with no class writes nothing', async () => {
    const f = existing('oc')
    expect((await post({ name: 'Oc', folder: f, framework: 'opencode' })).statusCode).toBe(201)
    expect(local(f)).toBeNull()
  })

  it('a home folder: warn, nothing written, the agent exists', async () => {
    const res = await post({ name: 'Builder', folder: home })
    expect(res.statusCode).toBe(201)
    expect(res.json().startWarn).toMatch(/plugins and connectors from your Claude account load in/)
    expect(registry.get('builder')).not.toBeNull()
    expect(existsSync(join(home, '.claude', 'settings.local.json'))).toBe(false)
  })

  it('an unwritable file: warn, nothing written, the agent exists', async () => {
    const f = existing('locked')
    mkdirSync(join(f, '.claude'))
    writeFileSync(join(f, '.claude', 'settings.local.json'), '{"model": "x"}')
    chmodSync(join(f, '.claude', 'settings.local.json'), 0o000)
    try {
      const res = await post({ name: 'Builder', folder: f })
      expect(res.statusCode).toBe(201)
      expect(typeof res.json().startWarn).toBe('string')
      expect(registry.get('builder')).not.toBeNull()
    } finally {
      chmodSync(join(f, '.claude', 'settings.local.json'), 0o600)
    }
    expect(local(f)).toEqual({ model: 'x' })
  })

  it('a corrupt file is refused untouched, said as a warn', async () => {
    const f = existing('corrupt')
    mkdirSync(join(f, '.claude'))
    writeFileSync(join(f, '.claude', 'settings.local.json'), '{ not json')
    const res = await post({ name: 'Builder', folder: f })
    expect(res.statusCode).toBe(201)
    expect(res.json().startWarn).toMatch(/not valid JSON/)
    expect(readFileSync(join(f, '.claude', 'settings.local.json'), 'utf8')).toBe('{ not json')
  })

  it("the user's own set decides: what they turned on is not written, what they turned off is", async () => {
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          headers,
          payload: { startingSet: { 'claude-code': { 'account-plugins': true, 'account-skills': false } } },
        })
      ).statusCode,
    ).toBe(200)
    const f = existing('mine')
    await post({ name: 'Builder', folder: f })
    expect(local(f)).toEqual({ disableClaudeAiConnectors: true, syncClaudeAiSkills: false })
  })
})

describe('the starting set, the setting', () => {
  const put = (startingSet: unknown) => app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { startingSet } })
  it('a class the engine does not declare is refused — and an engine with none, and an unknown engine', async () => {
    expect((await put({ 'claude-code': { hooks: false } })).statusCode).toBe(400)
    expect((await put({ opencode: { 'account-plugins': false } })).statusCode).toBe(400)
    expect((await put({ 'no-such-engine': {} })).statusCode).toBe(400)
    expect((await put({ 'claude-code': { 'account-plugins': 'yes' } })).statusCode).toBe(400)
    // a name is data: `__proto__` is no class
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          headers: { ...headers, 'content-type': 'application/json' },
          payload: '{"startingSet":{"claude-code":{"__proto__":false}}}',
        })
      ).statusCode,
    ).toBe(400)
    expect(settings.startingSet('claude-code')).toEqual({})
  })
  it('stores a choice, says it beside Recommended, and null takes it back', async () => {
    const r = await put({ 'claude-code': { 'account-connectors': true } })
    expect(r.statusCode).toBe(200)
    const classes = r.json().startingSet['claude-code'] as { id: string; recommended: boolean; chosen?: boolean }[]
    expect(classes.find((c) => c.id === 'account-connectors')).toMatchObject({ recommended: false, chosen: true })
    expect(classes.find((c) => c.id === 'account-plugins')?.chosen).toBeUndefined()
    expect(r.json().startingSet.opencode).toBeUndefined()
    // persisted, 0600, beside the unattended provider
    const again = new PlatformSettingsStore(dataDir)
    again.load()
    expect(again.startingSet('claude-code')).toEqual({ 'account-connectors': true })
    expect(
      (await put({ 'claude-code': { 'account-connectors': null } }))
        .json()
        .startingSet['claude-code'].find((c: { id: string }) => c.id === 'account-connectors').chosen,
    ).toBeUndefined()
    expect(settings.startingSet('claude-code')).toEqual({})
  })
  it("the New agent form's line: the set, whether the folder exists, and whom it joins", async () => {
    const f = existing('shop')
    const fresh = (await app.inject({ url: `/api/starting-set?framework=claude-code&folder=${encodeURIComponent(f)}`, headers })).json()
    expect(fresh).toMatchObject({ exists: true, joins: null })
    expect(fresh.classes.map((c: { id: string; on: boolean }) => [c.id, c.on])).toEqual([
      ['account-plugins', false],
      ['account-connectors', false],
      ['account-skills', true],
    ])
    registry.create({ id: 'builder', name: 'Builder', folder: f })
    expect((await app.inject({ url: `/api/starting-set?framework=claude-code&folder=${encodeURIComponent(f)}`, headers })).json().joins).toEqual({
      agents: [{ id: 'builder', name: 'Builder' }],
    })
    // another engine's agent there: still a birth for this one
    expect((await app.inject({ url: `/api/starting-set?framework=opencode&folder=${encodeURIComponent(f)}`, headers })).json()).toMatchObject({
      joins: null,
      classes: [],
    })
  })
})

describe("the first run's facts", () => {
  const headers = { 'x-token': TOKEN }
  it('counts what you set up on this machine and names nothing the engine has not read — only with facts=1', async () => {
    mkdirSync(join(home, '.claude', 'skills', 'notes'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: take notes\n---\nbody\n')
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { search: { command: 'search-server' }, scratch: { command: 'scratch-server' } } }))
    // the machine keeps one off: counted apart, named — never «always on»
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ deniedMcpServers: [{ serverName: 'scratch' }] }))
    const r = (await app.inject({ url: '/api/starting-set?framework=claude-code&facts=1', headers })).json()
    expect(r.facts.machine).toEqual(
      expect.arrayContaining([
        { what: 'MCP servers', n: 1, off: ['scratch'] },
        { what: 'skills', n: 1, off: [] },
      ]),
    )
    expect(Object.keys(r.facts.sends).sort()).toEqual(['account-connectors', 'account-plugins', 'account-skills'])
    expect((await app.inject({ url: '/api/starting-set?framework=claude-code', headers })).json().facts).toBeUndefined()
    // an engine with no class: no facts at all
    expect((await app.inject({ url: '/api/starting-set?framework=opencode&facts=1', headers })).json().facts).toBeUndefined()
  })
  it("names each class from its origin's rows of its kind — a plugin's servers never on their own", () => {
    const row = (name: string, kind: LoadsRow['kind'], owner: LoadsRow['origin']['owner'], parent?: string): LoadsRow => ({
      key: `${kind}:${name}`,
      engine: 'claude-code',
      kind,
      name,
      label: name,
      exact: true,
      origin: { owner, carrier: 'x' },
      state: 'available',
      ...(parent ? { parent } : {}),
    })
    const f = startingFacts(
      [
        { id: 'p', what: 'plugins', from: 'an account', recommended: false, covers: 'plugin' },
        { id: 'c', what: 'connectors', from: 'an account', recommended: false, covers: 'connector' },
        { id: 's', what: 'skills', from: 'an account', recommended: true, covers: 'skill' },
      ],
      {
        rows: [
          row('Linear', 'connector', 'account'),
          row('design', 'plugin', 'account'),
          row('design-srv', 'mcp', 'account', 'plugin:design'),
          row('lint', 'plugin', 'you'),
          row('db', 'mcp', 'you'),
          row('db-child', 'mcp', 'you', 'plugin:lint'),
          row('repo', 'mcp', 'project'),
        ],
        skills: {
          accounts: [
            { login: 'a@example.com', accountId: '1', skills: [{ name: 'pdf', file: '/x' }] },
            {
              login: 'b@example.com',
              accountId: '2',
              skills: [
                { name: 'pdf', file: '/y' },
                { name: 'docx', file: '/z' },
              ],
            },
          ],
          origin: { on: true },
          overrides: [],
          personal: [],
        },
      },
    )
    expect(f.machine).toEqual([
      { what: 'plugins', n: 1, off: [] },
      { what: 'MCP servers', n: 1, off: [] },
    ])
    expect(f.sends).toEqual({ p: ['design'], c: ['Linear'], s: ['docx', 'pdf'] })
  })
})

describe("Claude Code's apply", () => {
  it('writes nothing — not even a file — when every class stays on', () => {
    const f = existing('allon')
    expect(claudeStartingSet.apply({ folder: f, home }, { 'account-plugins': true, 'account-connectors': true })).toEqual([])
    expect(existsSync(join(f, '.claude'))).toBe(false)
  })
})
