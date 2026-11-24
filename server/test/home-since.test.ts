// Home's «Since …»: counted from the
// owner's PREVIOUS visit; the visit is stamped only under the owner's
// credential — an unknown local GET reads without effects.
import { describe, expect, it, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
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
import { buildServer } from '../src/server.js'
import { composeSince, weeklyPercentOf } from '../src/home-since.js'

const TOKEN = 'since-token'
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

describe('composeSince — the band from the facts', () => {
  const base = { done: 0, runs: [], stuck: 0, decided: [], needsYou: 0, accounts: [], costUsd: null }
  it('no visit before: from is now — nothing happened «since» a first look', () => {
    const s = composeSince(null, Date.parse('2026-11-10T09:00:00Z'), base)
    expect(s.from).toBe('2026-11-10T09:00:00.000Z')
  })
  it('runs count their automations; the most-used weekly account leads, with how many agents share it', () => {
    const s = composeSince('2026-11-09T09:00:00.000Z', Date.now(), {
      ...base,
      runs: [{ automationId: 'a' }, { automationId: 'a' }, { automationId: 'b' }],
      accounts: [
        { account: 'your Claude account', weeklyPercent: 34.4, agents: 3 },
        { account: 'second', weeklyPercent: 12, agents: 1 },
        { account: 'third', weeklyPercent: null, agents: 2 },
      ],
      costUsd: 2.104,
    })
    expect(s.automations).toEqual({ ran: 3, of: 2 })
    expect(s.usage).toEqual({ percent: 34, account: 'your Claude account', agents: 3 })
    expect(s.cost).toEqual({ usd: 2.1 })
  })
  it('the weekly window is the account-wide one when the reading has it', () => {
    const W = 7 * 24 * 3600_000
    expect(
      weeklyPercentOf([
        { kind: 'session', label: '5h', percent: 80, windowMs: 5 * 3600_000 },
        { kind: 'weekly_all', label: 'Week', percent: 34, windowMs: W },
        { kind: 'weekly_scoped', label: 'Fable', percent: 60, windowMs: W },
      ]),
    ).toBe(34)
    expect(weeklyPercentOf([{ kind: 'weekly_scoped', label: 'Fable', percent: 60, windowMs: W }])).toBe(60)
    expect(weeklyPercentOf([{ kind: 'session', label: '5h', percent: 80, windowMs: 5 * 3600_000 }])).toBeNull()
  })
})

describe('GET /api/home/since — the visit', () => {
  let app: FastifyInstance
  let dataDir: string
  beforeEach(async () => {
    const base = tmp('since-')
    const root = join(base, 'projects')
    dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
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
    const automations = new AutomationsStore(dataDir)
    automations.load()
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
      dataDir,
    })
  })

  it("the owner's read stamps the visit and the band counts from the one BEFORE it", async () => {
    const first = (await app.inject({ url: '/api/home/since', headers: { 'x-token': TOKEN } })).json()
    expect(existsSync(join(dataDir, 'visits.json'))).toBe(true)
    const stamped = JSON.parse(readFileSync(join(dataDir, 'visits.json'), 'utf8')).homeAt as string
    const second = (await app.inject({ url: '/api/home/since', headers: { 'x-token': TOKEN } })).json()
    expect(second.from).toBe(stamped)
    expect(Date.parse(first.from)).toBeLessThanOrEqual(Date.parse(stamped))
    expect(second).toMatchObject({ done: 0, automations: { ran: 0, of: 0 }, stuck: 0, decided: [], needsYou: 0, usage: null, cost: null })
  })

  it('an unknown local GET reads without stamping (no effects)', async () => {
    const r = await app.inject({ url: '/api/home/since' })
    expect(r.statusCode).toBe(200)
    expect(existsSync(join(dataDir, 'visits.json'))).toBe(false)
  })
})
