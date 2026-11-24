// cannot-run.test.ts — "why can't this conversation run": the provider's own
// words, from two honest sources only (a pinned provider with no key; the
// engine's refusal band as the LAST turn) — never inferred.
import { describe, expect, it } from 'vitest'
import { CANNOT_RUN_CAP, cannotRun, gatewayAutoLabel, gatewayHost, gatewayModels } from '../src/lib/providers'
import type { ProviderView, Turn } from '../src/lib/types'

const providers = [
  {
    id: 'default',
    kind: 'claude-account',
    label: 'Claude (this machine)',
    window: null,
    account: { name: 'default', configDir: null, providerId: 'default', loggedIn: true, email: 'f@x.io', plan: null, shared: true },
  },
  {
    id: 'ci',
    kind: 'anthropic-compatible',
    label: 'cheapestinference · kimi-k3, qwen3.8-max',
    baseUrl: 'https://api.cheapestinference.com/anthropic',
    apiKey: 'sk-…3456',
    models: ['kimi-k3', 'qwen3.8-max'],
    createdAt: '2026-10-27',
    window: null,
  },
  { id: 'gone', kind: 'anthropic-compatible', label: 'old proxy', baseUrl: 'https://old.test', apiKey: '', createdAt: '2026-10-27', window: null },
  { id: 'nolist', kind: 'anthropic-compatible', label: 'byok', baseUrl: 'https://byok.test/v1', apiKey: 'sk-…9999', createdAt: '2026-10-27', window: null },
] as unknown as ProviderView[]

const turn = (over: Partial<Turn>): Turn => ({ index: 0, role: 'assistant', text: 'ok', tools: [], ts: null, ...over })

describe('cannotRun', () => {
  it("a refused last turn (the engine's synthetic band that closed the turn) is the reason, first line, as written", () => {
    const turns = [
      turn({ role: 'user', text: 'hi' }),
      turn({ synthetic: true, turnEnded: true, text: 'zai: Insufficient balance or no resource package. Please recharge. (429)\nsecond line' }),
    ]
    expect(cannotRun({ turns }, providers, undefined)).toBe('zai: Insufficient balance or no resource package. Please recharge. (429)')
  })
  it('an older refusal followed by a real answer is history, not a state', () => {
    const turns = [
      turn({ synthetic: true, turnEnded: true, text: 'zai: 429' }),
      turn({ role: 'user', text: 'retry' }),
      turn({ text: 'Hello!', turnEnded: true }),
    ]
    expect(cannotRun({ turns }, providers, undefined)).toBeNull()
  })
  it('a synthetic band still streaming (turn open) or empty is not a verdict yet', () => {
    expect(cannotRun({ turns: [turn({ synthetic: true, text: 'x' })] }, providers, undefined)).toBeNull()
    expect(cannotRun({ turns: [turn({ synthetic: true, turnEnded: true, text: '  ' })] }, providers, undefined)).toBeNull()
  })
  it('a pinned provider whose key the server cleared says so by name, before any turn', () => {
    expect(cannotRun(null, providers, 'gone')).toBe('old proxy: key needed')
    expect(cannotRun({ turns: [] }, providers, 'ci')).toBeNull()
    expect(cannotRun({ turns: [] }, providers, 'default')).toBeNull()
  })
  it('a long reason is capped with an ellipsis', () => {
    const long = 'p: ' + 'x'.repeat(400)
    const r = cannotRun({ turns: [turn({ synthetic: true, turnEnded: true, text: long })] }, providers, undefined)
    expect(r).toHaveLength(CANNOT_RUN_CAP)
    expect(r?.endsWith('…')).toBe(true)
  })
})

describe('gateway models + naming', () => {
  it("gatewayModels: the gateway's learned list, for any engine; null for the default, an account, or an unlisted gateway", () => {
    expect(gatewayModels(providers, 'ci')).toEqual(['kimi-k3', 'qwen3.8-max'])
    expect(gatewayModels(providers, 'nolist')).toBeNull()
    expect(gatewayModels(providers, 'default')).toBeNull()
    expect(gatewayModels(providers, undefined)).toBeNull()
  })
  it('gatewayHost / gatewayAutoLabel: the host, then what the key reaches; the partner by name; more than three fold', () => {
    expect(gatewayHost('https://api.cheapestinference.com/anthropic')).toBe('api.cheapestinference.com')
    expect(gatewayHost('not a url')).toBe('not a url')
    expect(gatewayAutoLabel('https://api.cheapestinference.com/anthropic', ['kimi-k3', 'qwen3.8-max'])).toBe('cheapestinference · kimi-k3, qwen3.8-max')
    expect(gatewayAutoLabel('https://byok.test/v1', [])).toBe('byok.test')
    expect(gatewayAutoLabel('https://byok.test/v1', ['a', 'b', 'c', 'd', 'e'])).toBe('byok.test · a, b, c +2')
  })
})
