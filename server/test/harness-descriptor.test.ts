// harness-descriptor.test.ts — GET /api/harnesses (design D.4): the engines
// the web sees, in registration order; the web seed never drifts from the
// server's answer; a harness registered at run time shows up in the route
// with no edit to the seed; an agent bearer is treated like on /api/harness.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { describeHarnesses, type HarnessDescriptor } from '../src/harness-descriptor.js'
import { registerHarness, registeredHarnesses } from '../src/harnesses/registry.js'
import type { Harness } from '../src/harnesses/contract.js'
import { HarnessService } from '../src/harness.js'
import type { RunFn } from '../src/harness-run.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'
import { BUILT_INS, registeredIds } from './helpers/built-ins.js'

const LOCAL = { host: '127.0.0.1:3210' }
const OWNER = { ...LOCAL, 'x-token': 't0k' }
let app: FastifyInstance
let agentTokens: AgentTokens
const unregister: Array<() => void> = []

const run: RunFn = async (cmd, args) => {
  if (cmd === 'claude' && args[0] === '--version') return { stdout: '2.1.304 (Claude Code)\n', stderr: '' }
  if (cmd === 'which') return { stdout: '/home/u/.local/bin/claude\n', stderr: '' }
  if (cmd === '/sdk/claude') return { stdout: '2.1.300 (Claude Code)\n', stderr: '' }
  if (cmd === 'npm') return { stdout: '2.1.310\n', stderr: '' }
  throw new Error(`unexpected ${cmd}`)
}

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-desc-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  const folder = mkdtempSync(join(tmpdir(), 'harness-desc-folder-'))
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'Finance', folder })
  agentTokens = new AgentTokens(dataDir)
  const native = new NativeStore(join(dataDir, 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no sdk')
    },
  })
  app = buildServer({
    index,
    registry,
    native,
    chat,
    store: new SessionStore(root, dataDir),
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    token: 't0k',
    liveMs: 120_000,
    agentTokens,
    harness: new HarnessService({ run, engines: { 'claude-code': { chatBinary: () => '/sdk/claude' } }, now: () => 0 }),
  })
})

afterEach(async () => {
  while (unregister.length) unregister.pop()!()
  await app.close()
})

const get = (url: string, headers: Record<string, string> = OWNER) => app.inject({ method: 'GET', url, headers })

// a fake engine with every field the descriptor reads (traits, ui, providers)
const fakeEngine: Harness = {
  id: 'test-engine',
  label: 'Test Engine',
  ownsId: (id) => id.startsWith('tst_'),
  caps: {
    compaction: false,
    subagents: false,
    skills: false,
    thinking: false,
    costFromHarness: false,
    permissionsAsEvents: false,
    sendToConsole: false,
    outputStyles: false,
  },
  console: { idDiscovery: 'reported-by-plugin', command: () => ['test-engine'], env: () => ({}) },
  fencePermission: () => ({}),
  traits: { deletion: 'hide', handover: true, consolePinsModel: false, agentStateDirs: ['test-engine'] },
  providers: { kinds: ['anthropic-compatible', 'harness-native'] },
  ui: {
    contextPercent: false,
    models: 'none',
    ownLogin: true,
    territoryFenced: true,
    territoryNote: null,
    settingsAbout: 'A test engine.',
    loginImport: null,
    providerExport: null,
  },
}

describe('GET /api/harnesses', () => {
  it('answers 200 with every registered engine in registration order, the built-ins first', async () => {
    const res = await get('/api/harnesses')
    expect(res.statusCode).toBe(200)
    const body = res.json() as { harnesses: HarnessDescriptor[] }
    // registeredIds(): ['claude-code', 'opencode'] exactly while no third engine is registered
    expect(body.harnesses.map((h) => h.id)).toEqual(registeredIds())
    expect(body.harnesses.map((h) => h.id)).toEqual(registeredHarnesses().map((h) => h.id))
    expect(body).toEqual({ harnesses: describeHarnesses() })
    const [cc, oc] = body.harnesses
    expect(cc).toMatchObject({ label: 'Claude Code', default: true, modeSwitch: true, providerKinds: ['claude-account', 'anthropic-compatible'] })
    expect(oc).toMatchObject({
      label: 'OpenCode',
      default: false,
      modeSwitch: true,
      providerKinds: ['anthropic-compatible', 'harness-provider', 'harness-native'],
    })
  })

  it('every web seed entry equals the server entry with the same id', async () => {
    const seed = JSON.parse(readFileSync(new URL('../../web/src/lib/harnesses.seed.json', import.meta.url), 'utf8')) as { harnesses: HarnessDescriptor[] }
    // both built-ins ship in the seed (first paint must never show them as unknown);
    // a third engine need not — the live list brings it
    expect(seed.harnesses.map((h) => h.id)).toEqual(expect.arrayContaining([...BUILT_INS]))
    const server = ((await get('/api/harnesses')).json() as { harnesses: HarnessDescriptor[] }).harnesses
    for (const entry of seed.harnesses) {
      expect(entry).toEqual(server.find((h) => h.id === entry.id))
    }
  })

  it('a harness registered at test time appears without touching the seed', async () => {
    const before = registeredIds()
    unregister.push(registerHarness(fakeEngine))
    const res = await get('/api/harnesses')
    expect(res.statusCode).toBe(200)
    const list = (res.json() as { harnesses: HarnessDescriptor[] }).harnesses
    expect(list.map((h) => h.id)).toEqual([...before, 'test-engine'])
    expect(list[list.length - 1]).toEqual({
      id: 'test-engine',
      label: 'Test Engine',
      default: false,
      caps: fakeEngine.caps,
      providerKinds: ['anthropic-compatible', 'harness-native'],
      modeSwitch: true,
      ui: fakeEngine.ui,
    })
    const seed = JSON.parse(readFileSync(new URL('../../web/src/lib/harnesses.seed.json', import.meta.url), 'utf8')) as { harnesses: HarnessDescriptor[] }
    expect(seed.harnesses.some((h) => h.id === 'test-engine')).toBe(false)
  })

  it('an agent bearer gets what it gets on /api/harness: refused', async () => {
    const headers = { ...LOCAL, authorization: `Bearer ${agentTokens.tokenFor('finance')}` }
    const old = await get('/api/harness', headers)
    const res = await get('/api/harnesses', headers)
    expect(old.statusCode).toBe(403)
    expect(res.statusCode).toBe(old.statusCode)
    expect(old.json()).toEqual({ error: 'agent finance may not read /api/harness' })
    expect(res.json()).toEqual({ error: 'agent finance may not read /api/harnesses' })
    // the owner (local, no identity) reads both
    expect((await get('/api/harness')).statusCode).toBe(200)
    expect((await get('/api/harnesses')).statusCode).toBe(200)
  })

  it('a remote request without a token is refused like any other API route', async () => {
    const res = await get('/api/harnesses', { host: 'silos.example.com', 'cf-ray': 'x', 'x-forwarded-for': '203.0.113.7' })
    expect(res.statusCode).toBe(401)
  })
})
