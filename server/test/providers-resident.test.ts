// Providers v1 — simple resident-side fallback: a keepAlive run that hits
// the primary's rate limit ends up waiting_reset (the record reflects the
// true state of the limit), but if the agent has a fallback chain, the
// RETRY is scheduled RIGHT AWAY and goes out through the fallback provider
// (a new turn = a turn boundary). With no chain, classic behavior: wait for
// resetsAt.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { LineageStore } from '../src/lineage.js'
import { ChatService } from '../src/chat-service.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AutomationsStore } from '../src/automations-store.js'
import { ProvidersStore } from '../src/providers-store.js'
import { Resident } from '../src/resident.js'
import { cleanEnv } from '../src/env.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import type { Automation } from '../src/automations-types.js'

let base: string, root: string, dataDir: string
let registry: AgentRegistry, store: AutomationsStore, chat: ChatService, providers: ProvidersStore
let calls: QueryArgs[]
let script: SdkMessage[]
// tests can override queryFn's behavior (e.g. an iterator that THROWS to
// simulate a proxy's textual 429) — the beforeEach wrapper still records
// the call in `calls` regardless.
let chatQueryFn: ((args: QueryArgs) => SdkQueryHandle) | null
let clock: Date
let residents: Resident[]
let keyId: string

const successScript = (sessionId: string): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: sessionId },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } } },
  { type: 'result', subtype: 'success', total_cost_usd: 0 },
]

const limitedScript = (resetsAtMs: number): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: 'sess-rl' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' } } as unknown as SdkMessage,
  { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
]

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-provres-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(base, 'project'), { recursive: true })
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  providers = new ProvidersStore(dataDir)
  providers.load()
  keyId = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: 'sk-ci-abcdef123456' }).id
  registry.create({ id: 'finance', name: 'FINANCE', folder: join(base, 'project'), fallback: [keyId] })
  registry.create({ id: 'solo', name: 'Solo', folder: join(base, 'project') }) // no chain
  calls = []
  clock = new Date('2026-08-20T09:00:00.000Z')
  script = successScript('s1')
  chatQueryFn = null
  chat = new ChatService({
    registry,
    native: new NativeStore(join(dataDir, 'native.json')),
    queryFn: (args) => {
      calls.push(args)
      if (chatQueryFn) return chatQueryFn(args)
      const s = script
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of s) yield m
        },
        async interrupt() {
          return undefined
        },
      } as SdkQueryHandle
    },
    dataDir,
    providers,
  })
  store = new AutomationsStore(dataDir)
  store.load()
  residents = []
})
afterEach(() => {
  for (const r of residents) r.stop()
})

function mkResident(): Resident {
  const r = new Resident({
    store,
    registry,
    chat,
    native: new NativeStore(join(dataDir, 'native.json')),
    index: claudeSessionIndex(root, join(dataDir, 'cache.json')),
    root,
    dataDir,
    lineage: new LineageStore(join(dataDir, 'lineage.json')),
    broadcast: () => {},
    now: () => clock,
    claudeSessionsDir: join(base, 'no-claude-sessions'),
    tickIntervalMs: 999_999_999,
  })
  residents.push(r)
  return r
}

function mkAutomation(overrides: Partial<Automation> & Pick<Automation, 'id' | 'trigger'>): Automation {
  return {
    name: 'Auto ' + overrides.id,
    agentId: 'finance',
    prompt: 'do the task',
    thread: { mode: 'new' },
    approval: false,
    keepAlive: true,
    paused: false,
    createdAt: clock.toISOString(),
    ...overrides,
  }
}

describe('Resident — waiting_reset with a fallback chain', () => {
  it('the retry is scheduled RIGHT AWAY and goes out through the fallback provider; the waiting_reset run keeps its resetsAt', async () => {
    store.create(mkAutomation({ id: 'fb1', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('fb1')!.nextRunAt as string)
    // relative to the REAL clock: ChatService resolves the fallback with
    // new Date() (production), while the resident runs on its injected
    // clock — a resetsAt "in the future" only for the resident's clock
    // would already have expired.
    const resetsAtMs = Date.now() + 2 * 3600_000
    script = limitedScript(resetsAtMs)
    await resident.tick(clock)
    await resident.drain()

    const run = store.listRuns('fb1')[0]!
    expect(run.status).toBe('waiting_reset')
    expect(run.resetsAt).toBe(new Date(resetsAtMs).toISOString())
    // the retry does NOT wait for the primary's reset: a fallback is armed
    expect(store.get('fb1')?.nextRunAt).toBe(clock.toISOString())

    // the retry (same instant or later) goes out through the fallback
    script = successScript('s2')
    await resident.tick(clock)
    await resident.drain()
    expect(store.listRuns('fb1')[0]?.status).toBe('ok')
    const env = calls[1]?.options.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.ci.test/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ci-abcdef123456')
  })

  // the fallback can also be rate-limited — its 429 arrives as TEXT
  // (proxies don't emit a rate_limit_event). Without burning the fallback,
  // this degenerated into a real call + a new Run on every tick (30s)
  // for the entire duration of the primary's reset window (~600 runs in 5h).
  it('if the retry through the fallback also gets limited (a textual 429), it burns and falls back to the classic resetsAt', async () => {
    store.create(mkAutomation({ id: 'fb3', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('fb3')!.nextRunAt as string)
    script = limitedScript(Date.now() + 5 * 3600_000) // primary limited, a real future resetsAt
    await resident.tick(clock)
    await resident.drain()
    expect(store.get('fb3')?.nextRunAt).toBe(clock.toISOString()) // an immediate retry is armed

    // the retry goes out through the fallback and IT responds with a
    // textual 429 (throw -> chat-error, no rate_limit_event)
    const scriptError = new Error('429: rate limit reached for this pool')
    chatQueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        throw scriptError
      },
      async interrupt() {
        return undefined
      },
    })
    await resident.tick(clock)
    await resident.drain()

    const run = store.listRuns('fb3')[0]!
    expect(run.status).toBe('waiting_reset') // keepAlive: still waiting, but...
    // ...the fallback got BURNED and the retry reschedules to the classic
    // reset (no parseable resetsAt in the text -> now+1h), NOT to "now".
    expect(chat.fallbackStateOf('finance')).toBeNull()
    expect(store.get('fb3')?.nextRunAt).toBe(new Date(clock.getTime() + 3600_000).toISOString())

    // and an immediate tick does NOT call the provider again (no 30s loop)
    const callsBefore = calls.length
    await resident.tick(new Date(clock.getTime() + 30_000))
    await resident.drain()
    expect(calls.length).toBe(callsBefore)
  })

  it('with no fallback chain the retry waits for resetsAt (classic behavior intact)', async () => {
    store.create(mkAutomation({ id: 'fb2', agentId: 'solo', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('fb2')!.nextRunAt as string)
    const resetsAtMs = clock.getTime() + 2 * 3600_000
    script = limitedScript(resetsAtMs)
    await resident.tick(clock)
    await resident.drain()

    expect(store.listRuns('fb2')[0]?.status).toBe('waiting_reset')
    expect(store.get('fb2')?.nextRunAt).toBe(new Date(resetsAtMs).toISOString())
    // the first turn went out with the usual default env (plus the
    // conversation's own id, births, and SILOS_BRIEFING: its append carries
    // the briefing — platform plumbing, not provider env)
    const {
      SILOS_SESSION_ID: sid,
      SILOS_TURN: _turn,
      SILOS_API: api,
      SILOS_BRIEFING: briefed,
      ...providerEnv
    } = calls[0]?.options.env as Record<string, string>
    expect(briefed).toBe('system-prompt')
    expect(typeof sid).toBe('string')
    expect(typeof api).toBe('string')
    expect(providerEnv).toEqual(cleanEnv())
  })
})
