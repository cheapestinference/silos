// Providers v1 — per-agent env injection in ChatService and fallback at a
// turn boundary. The queryFn fakes capture the real options the SDK would
// receive: the EXACT env gets asserted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ProvidersStore } from '../src/providers-store.js'
import { cleanEnv } from '../src/env.js'
import { BRIEFED_ENV } from '../src/harnesses/briefing.js'
// the default env of a turn: cleanEnv() + SILOS_BRIEFING (its append carries
// the briefing — platform plumbing, never provider env)
const defaultEnv = (): Record<string, string | undefined> => ({ ...cleanEnv(), ...BRIEFED_ENV })
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { mungePath } from '../src/agent-registry.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

function fakeQuery(script: SdkMessage[], calls: QueryArgs[]): (args: QueryArgs) => SdkQueryHandle {
  return (args) => {
    // these tests are about the PROVIDER env; SILOS_SESSION_ID (births:
    // the conversation's id, a fresh UUID for a new session) and SILOS_API
    // (the server's address, agent-env.ts) are platform plumbing covered by
    // chat-service.test.ts — set aside here, SILOS_API checked present.
    // SILOS_TURN (the turn token, live-turns.test.ts) likewise.
    const env = args.options.env as Record<string, string> | undefined
    if (env) {
      const { SILOS_SESSION_ID: _sid, SILOS_TURN: _turn, SILOS_API: api, ...rest } = env
      expect(api).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      calls.push({ ...args, options: { ...args.options, env: rest } })
    } else calls.push(args)
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of script) yield m
      },
      async interrupt() {
        return {}
      },
    }
  }
}

const OK_SCRIPT: SdkMessage[] = [
  { type: 'system', subtype: 'init', session_id: 's-prov' },
  { type: 'result', subtype: 'success', total_cost_usd: 0 },
]

function limitedScript(resetsAtMs: number): SdkMessage[] {
  return [
    { type: 'system', subtype: 'init', session_id: 's-lim' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour', utilization: 100 } } as SdkMessage,
    { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
  ]
}

let registry: AgentRegistry, native: NativeStore, providers: ProvidersStore, calls: QueryArgs[], base: string
let keyProviderId: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-provchat-'))
  registry = new AgentRegistry(join(base, 'agents.json'))
  registry.load()
  native = new NativeStore(join(base, 'native.json'))
  providers = new ProvidersStore(base)
  providers.load()
  keyProviderId = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: 'sk-ci-abcdef123456' }).id
  mkdirSync(join(base, 'claude-accounts', 'alt'), { recursive: true })
  calls = []
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const e of gen) out.push(e)
  return out
}

function chatWith(script: SdkMessage[]): ChatService {
  return new ChatService({ registry, native, queryFn: fakeQuery(script, calls), providers })
}

describe('ChatService — per-provider env', () => {
  it('an agent with no provider (default) -> env byte-identical to cleanEnv()', async () => {
    registry.create({ id: 'a1', name: 'A1', folder: '/tmp/p1' })
    await drain(chatWith(OK_SCRIPT).send({ turnId: 't', agentId: 'a1', text: 'x' }))
    expect(calls[0]?.options.env).toEqual(defaultEnv())
  })

  it('with no ProvidersStore injected -> the default env (safe degradation)', async () => {
    registry.create({ id: 'a3', name: 'A3', folder: '/tmp/p3', provider: keyProviderId })
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(OK_SCRIPT, calls) })
    await drain(chat.send({ turnId: 't', agentId: 'a3', text: 'x' }))
    expect(calls[0]?.options.env).toEqual(defaultEnv())
  })

  it('an anthropic-compatible provider -> BASE_URL + AUTH_TOKEN, no CLAUDE_CONFIG_DIR', async () => {
    registry.create({ id: 'a4', name: 'A4', folder: '/tmp/p4', provider: keyProviderId })
    await drain(chatWith(OK_SCRIPT).send({ turnId: 't', agentId: 'a4', text: 'x' }))
    const env = calls[0]?.options.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.ci.test/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ci-abcdef123456')
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it("an account:<name> provider -> CLAUDE_CONFIG_DIR from the account's directory", async () => {
    registry.create({ id: 'a5', name: 'A5', folder: '/tmp/p5', provider: 'account:alt' })
    await drain(chatWith(OK_SCRIPT).send({ turnId: 't', agentId: 'a5', text: 'x' }))
    const env = calls[0]?.options.env as Record<string, string>
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(base, 'claude-accounts', 'alt'))
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('an unknown provider in agents.json -> default with a warning, the turn does not break', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registry.create({ id: 'a6', name: 'A6', folder: '/tmp/p6', provider: 'deleted' })
    await drain(chatWith(OK_SCRIPT).send({ turnId: 't', agentId: 'a6', text: 'x' }))
    expect(calls[0]?.options.env).toEqual(defaultEnv())
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('the key NEVER shows up in logs during a turn', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}))
    registry.create({ id: 'a7', name: 'A7', folder: '/tmp/p7', provider: keyProviderId })
    await drain(chatWith(OK_SCRIPT).send({ turnId: 't', agentId: 'a7', text: 'x' }))
    for (const s of spies) {
      for (const call of s.mock.calls) expect(call.map(String).join(' ')).not.toContain('sk-ci-abcdef123456')
    }
  })
})

describe('ChatService — fallback at a turn boundary', () => {
  it("a rejected rate limit arms the fallback: the NEXT turn goes out through the chain's provider", async () => {
    vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'))
    vi.useFakeTimers({ now: new Date('2026-08-20T10:00:00.000Z') })
    registry.create({ id: 'fb1', name: 'FB1', folder: '/tmp/fb1', fallback: [keyProviderId] })
    const resetsAt = Date.parse('2026-08-20T15:00:00.000Z')

    const limited = chatWith(limitedScript(resetsAt))
    await drain(limited.send({ turnId: 't1', agentId: 'fb1', text: 'x' }))
    // the limited turn went out with the default and did NOT change its own env
    expect(calls[0]?.options.env).toEqual(defaultEnv())
    expect(limited.fallbackStateOf('fb1')).toEqual({ providerId: keyProviderId, from: 'default', until: '2026-08-20T15:00:00.000Z' })

    // second turn (same instance — the state lives inside the service)
    const calls2: QueryArgs[] = []
    ;(limited as unknown as { deps: { queryFn: unknown } }).deps.queryFn = fakeQuery(OK_SCRIPT, calls2)
    await drain(limited.send({ turnId: 't2', agentId: 'fb1', text: 'y' }))
    const env = calls2[0]?.options.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.ci.test/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ci-abcdef123456')
  })

  it('past resetsAt, new turns go back to the primary', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-20T10:00:00.000Z') })
    registry.create({ id: 'fb2', name: 'FB2', folder: '/tmp/fb2', fallback: [keyProviderId] })
    const chat = chatWith(limitedScript(Date.parse('2026-08-20T11:00:00.000Z')))
    await drain(chat.send({ turnId: 't1', agentId: 'fb2', text: 'x' }))
    expect(chat.fallbackStateOf('fb2')).not.toBeNull()

    vi.setSystemTime(new Date('2026-08-20T11:00:01.000Z'))
    const calls2: QueryArgs[] = []
    ;(chat as unknown as { deps: { queryFn: unknown } }).deps.queryFn = fakeQuery(OK_SCRIPT, calls2)
    await drain(chat.send({ turnId: 't2', agentId: 'fb2', text: 'y' }))
    expect(calls2[0]?.options.env).toEqual(defaultEnv())
    expect(chat.fallbackStateOf('fb2')).toBeNull()
  })

  it('with no fallback chain, nothing gets armed (waiting/error as usual)', async () => {
    registry.create({ id: 'fb3', name: 'FB3', folder: '/tmp/fb3' })
    const chat = chatWith(limitedScript(Date.now() + 3600_000))
    await drain(chat.send({ turnId: 't1', agentId: 'fb3', text: 'x' }))
    expect(chat.fallbackStateOf('fb3')).toBeNull()
  })

  // if the turn that gets limited was ALREADY going out through the
  // fallback, the fallback is BURNED — the next turn goes back to the
  // primary (which will wait for its reset), never a retry loop against a
  // broken fallback.
  it('a rejected event from the fallback itself (even with no resetsAt) burns the tracker', async () => {
    registry.create({ id: 'fb5', name: 'FB5', folder: '/tmp/fb5', fallback: [keyProviderId] })
    const chat = chatWith(limitedScript(Date.now() + 5 * 3600_000))
    await drain(chat.send({ turnId: 't1', agentId: 'fb5', text: 'x' }))
    expect(chat.fallbackStateOf('fb5')).not.toBeNull()

    // second turn: goes out through the fallback and IT also gets limited —
    // a rejected event with no resetsAt (proxies that don't send the window)
    const script2: SdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 's-fb' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } } as SdkMessage,
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    ;(chat as unknown as { deps: { queryFn: unknown } }).deps.queryFn = fakeQuery(script2, [])
    await drain(chat.send({ turnId: 't2', agentId: 'fb5', text: 'y' }))
    expect(chat.fallbackStateOf('fb5')).toBeNull()

    // and the third turn goes back to the primary (default env)
    const calls3: QueryArgs[] = []
    ;(chat as unknown as { deps: { queryFn: unknown } }).deps.queryFn = fakeQuery(OK_SCRIPT, calls3)
    await drain(chat.send({ turnId: 't3', agentId: 'fb5', text: 'z' }))
    expect(calls3[0]?.options.env).toEqual(defaultEnv())
  })

  it('a TEXTUAL 429 from the fallback (chat-error, no rate_limit_event) also burns it', async () => {
    registry.create({ id: 'fb6', name: 'FB6', folder: '/tmp/fb6', fallback: [keyProviderId] })
    const chat = chatWith(limitedScript(Date.now() + 5 * 3600_000))
    await drain(chat.send({ turnId: 't1', agentId: 'fb6', text: 'x' }))
    expect(chat.fallbackStateOf('fb6')).not.toBeNull()

    // the iterator throws midway — chat-service turns it into a chat-error
    const throwing = (): SdkQueryHandle => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('429: rate limit reached for this pool')
      },
      async interrupt() {
        return {}
      },
    })
    ;(chat as unknown as { deps: { queryFn: unknown } }).deps.queryFn = throwing
    const events = await drain(chat.send({ turnId: 't2', agentId: 'fb6', text: 'y' }))
    expect((events.at(-1) as { ev: string }).ev).toBe('chat-error')
    expect(chat.fallbackStateOf('fb6')).toBeNull()
  })

  it('a textual error that does NOT smell like a rate limit does not touch the fallback', async () => {
    registry.create({ id: 'fb7', name: 'FB7', folder: '/tmp/fb7', fallback: [keyProviderId] })
    const chat = chatWith(limitedScript(Date.now() + 5 * 3600_000))
    await drain(chat.send({ turnId: 't1', agentId: 'fb7', text: 'x' }))
    const throwing = (): SdkQueryHandle => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('ECONNRESET')
      },
      async interrupt() {
        return {}
      },
    })
    ;(chat as unknown as { deps: { queryFn: unknown } }).deps.queryFn = throwing
    await drain(chat.send({ turnId: 't2', agentId: 'fb7', text: 'y' }))
    expect(chat.fallbackStateOf('fb7')).not.toBeNull() // a network drop does not burn the fallback
  })

  it("every rate limit seen gets attributed to the turn's provider (rateLimitOf)", async () => {
    registry.create({ id: 'fb4', name: 'FB4', folder: '/tmp/fb4' })
    const chat = chatWith(limitedScript(Date.parse('2026-08-20T15:00:00.000Z')))
    await drain(chat.send({ turnId: 't1', agentId: 'fb4', text: 'x' }))
    expect(chat.rateLimitOf('default')).toMatchObject({ status: 'rejected', resetsAt: '2026-08-20T15:00:00.000Z', kind: 'five_hour', utilization: 100 })
    expect(chat.rateLimitOf(keyProviderId)).toBeNull() // honest: no turn ever went through there
  })
})

// Provider as a cascade field: a conversation (or one turn) pinned to a
// Claude account or a key runs there — the agent's default is the agent
// level of the same cascade as model/effort/permissionMode.
describe('ChatService — provider per conversation and per turn', () => {
  function chatWithPrefs(script: SdkMessage[]): { chat: ChatService; prefs: ConversationPrefsStore } {
    const prefs = new ConversationPrefsStore(base)
    prefs.load()
    return { chat: new ChatService({ registry, native, queryFn: fakeQuery(script, calls), providers, convPrefs: prefs }), prefs }
  }

  it('a conversation pinned to an account sends its turns through that account (CLAUDE_CONFIG_DIR)', async () => {
    registry.create({ id: 'c1', name: 'C1', folder: '/tmp/c1' })
    const { chat, prefs } = chatWithPrefs(OK_SCRIPT)
    prefs.patch(mungePath('/tmp/c1'), 's-prov', { provider: 'account:alt' })
    await drain(chat.send({ turnId: 't', agentId: 'c1', text: 'x', resume: { sessionId: 's-prov', mode: 'append' } }))
    const env = calls[0]?.options.env as Record<string, string>
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(base, 'claude-accounts', 'alt'))
  })

  it('a turn override wins for that turn only (a key provider here)', async () => {
    registry.create({ id: 'c2', name: 'C2', folder: '/tmp/c2' })
    const { chat, prefs } = chatWithPrefs(OK_SCRIPT)
    prefs.patch(mungePath('/tmp/c2'), 's-prov', { provider: 'account:alt' })
    await drain(chat.send({ turnId: 't', agentId: 'c2', text: 'x', resume: { sessionId: 's-prov', mode: 'append' }, overrides: { provider: keyProviderId } }))
    const env = calls[0]?.options.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.ci.test/anthropic')
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it("an unknown provider id in the prefs falls back to the agent's own provider, with one warning", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registry.create({ id: 'c3', name: 'C3', folder: '/tmp/c3' })
    const { chat, prefs } = chatWithPrefs(OK_SCRIPT)
    prefs.patch(mungePath('/tmp/c3'), 's-prov', { provider: 'account:gone' })
    await drain(chat.send({ turnId: 't', agentId: 'c3', text: 'x', resume: { sessionId: 's-prov', mode: 'append' } }))
    expect(calls[0]?.options.env).toEqual(defaultEnv())
    expect(warn.mock.calls.some((c) => String(c[0]).includes('account:gone'))).toBe(true)
  })

  it("an unattended run ignores the conversation's provider (its env stays the agent's)", async () => {
    registry.create({ id: 'c4', name: 'C4', folder: '/tmp/c4' })
    const { chat, prefs } = chatWithPrefs(OK_SCRIPT)
    prefs.patch(mungePath('/tmp/c4'), 's-prov', { provider: 'account:alt' })
    await drain(chat.send({ turnId: 't', agentId: 'c4', text: 'x', resume: { sessionId: 's-prov', mode: 'append' }, unattended: true, turn: { class: 'run' } }))
    expect(calls[0]?.options.env).toEqual(defaultEnv())
  })

  it("the agent's fallback diverts only turns whose primary hit the limit — a conversation on another account keeps its account", async () => {
    vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'))
    vi.useFakeTimers({ now: new Date('2026-08-20T10:00:00.000Z') })
    registry.create({ id: 'c5', name: 'C5', folder: '/tmp/c5', fallback: [keyProviderId] })
    const resetsAt = Date.parse('2026-08-20T15:00:00.000Z')
    const { chat, prefs } = chatWithPrefs(limitedScript(resetsAt))
    // turn 1 on the default account hits the limit → fallback armed, from 'default'
    await drain(chat.send({ turnId: 't1', agentId: 'c5', text: 'x' }))
    expect(chat.fallbackStateOf('c5')).toEqual({ providerId: keyProviderId, from: 'default', until: '2026-08-20T15:00:00.000Z' })
    // turn 2: a conversation pinned to account alt is NOT diverted
    const calls2: QueryArgs[] = []
    ;(chat as unknown as { deps: { queryFn: unknown } }).deps.queryFn = fakeQuery(OK_SCRIPT, calls2)
    prefs.patch(mungePath('/tmp/c5'), 's-pinned', { provider: 'account:alt' })
    await drain(chat.send({ turnId: 't2', agentId: 'c5', text: 'y', resume: { sessionId: 's-pinned', mode: 'append' } }))
    expect((calls2[0]?.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(join(base, 'claude-accounts', 'alt'))
    // turn 3: a plain conversation (primary = default, the limited one) goes through the fallback
    const calls3: QueryArgs[] = []
    ;(chat as unknown as { deps: { queryFn: unknown } }).deps.queryFn = fakeQuery(OK_SCRIPT, calls3)
    await drain(chat.send({ turnId: 't3', agentId: 'c5', text: 'z' }))
    expect((calls3[0]?.options.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe('https://api.ci.test/anthropic')
  })

  it("consoleProviderFor: the provider a console spawn must honor — an explicit pick, else the conversation pin, else the agent's", () => {
    registry.create({ id: 'c6', name: 'C6', folder: '/tmp/c6' })
    const { chat, prefs } = chatWithPrefs(OK_SCRIPT)
    expect(chat.consoleProviderFor('c6', '/tmp/c6')).toMatchObject({ id: 'default', configDir: null })
    prefs.patch(mungePath('/tmp/c6'), 's-con', { provider: 'account:alt' })
    expect(chat.consoleProviderFor('c6', '/tmp/c6', 's-con')).toMatchObject({ id: 'account:alt', configDir: join(base, 'claude-accounts', 'alt') })
    // an explicit pick (a NEW console opened on an account) wins over everything
    expect(chat.consoleProviderFor('c6', '/tmp/c6', undefined, keyProviderId)).toMatchObject({ id: keyProviderId })
  })
})
