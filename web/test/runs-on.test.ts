import { describe, expect, it } from 'vitest'
import { modelLabel, prettyModelId, providerLabel, providerRunsOn, providerShortLabel, runsOnLine } from '../src/lib/runs-on'
import type { AgentView, ModelInfo, ProviderView } from '../src/lib/types'

const catalog: ModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
]
const providers: ProviderView[] = [
  {
    id: 'default',
    kind: 'claude-account',
    label: 'Claude (this machine)',
    account: { name: 'default', configDir: null, providerId: 'default', loggedIn: true, email: 'f@x.io', plan: null, shared: true },
    window: null,
  },
  {
    id: 'account:kai',
    kind: 'claude-account',
    label: 'Claude · kai',
    account: { name: 'kai', configDir: '/x', providerId: 'account:kai', loggedIn: true, email: null, plan: 'Max', shared: true },
    window: null,
  },
  {
    id: 'ci',
    kind: 'anthropic-compatible',
    label: 'cheapestinference',
    baseUrl: 'https://api.cheapestinference.com/anthropic',
    apiKey: 'k',
    createdAt: '2026-08-01',
  },
] as ProviderView[]
const agent = (o: Partial<AgentView> = {}): AgentView =>
  ({ id: 'a', name: 'A', emoji: '', role: '', folder: null, skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...o }) as AgentView

describe('modelLabel', () => {
  it('names the default by what it resolves to, never "Default (recommended)"', () => {
    expect(modelLabel(catalog, undefined)).toBe('Opus (1M context)')
    expect(modelLabel(catalog, 'default')).toBe('Opus (1M context)')
  })
  it('resolves a catalog value or an observed resolved id to its display name', () => {
    expect(modelLabel(catalog, 'sonnet')).toBe('Sonnet')
    expect(modelLabel(catalog, 'claude-sonnet-5')).toBe('Sonnet')
  })
  it('prettifies an id the catalog does not know', () => {
    expect(modelLabel(catalog, 'claude-fable-5')).toBe('Fable 5')
    expect(prettyModelId('claude-opus-5[1m]')).toBe('Opus 5 · 1M')
    expect(prettyModelId('claude-sonnet-4-5')).toBe('Sonnet 4.5')
  })
  it('with an empty catalog says so honestly', () => {
    expect(modelLabel([], undefined)).toBe('default model')
  })
})

describe('providerRunsOn', () => {
  it("'' / default = this machine's Claude subscription, with who", () => {
    expect(providerRunsOn(providers, agent())).toContain('f@x.io')
    expect(providerRunsOn(providers, agent({ provider: 'default' }))).toContain('f@x.io')
  })
  it('a named account shows its plan and name; a proxy its label', () => {
    expect(providerRunsOn(providers, agent({ provider: 'account:kai' }))).toBe('Claude Max · kai')
    expect(providerRunsOn(providers, agent({ provider: 'ci' }))).toBe('cheapestinference')
  })
  it('an active fallback names where it is running NOW', () => {
    expect(providerRunsOn(providers, agent({ provider: 'default', onFallback: { providerId: 'ci', from: 'default', until: '2026-08-26T12:00:00Z' } }))).toBe(
      'cheapestinference (fallback)',
    )
  })
})

describe('runsOnLine', () => {
  it('prefers the model observed in the conversation over the agent setting', () => {
    expect(runsOnLine({ agent: agent({ model: 'sonnet' }), providers, catalog, observedModel: 'claude-opus-5[1m]' })).toMatch(/^Opus/)
  })
  it("the conversation's own pin comes first, on Claude too: the observed model is the last answer's and lags a switch", () => {
    const line = runsOnLine({ agent: agent({ model: 'opus' }), providers, catalog, observedModel: 'claude-opus-5[1m]', pinnedModel: 'sonnet' })
    expect(line).toMatch(/^Sonnet/)
    expect(line).not.toMatch(/^Opus/)
    expect(runsOnLine({ agent: agent({ model: 'sonnet' }), providers, catalog })).toBe('Sonnet · Claude subscription · f@x.io')
  })
})

// The conversation's pin and the scoped fallback (switching accounts is
// declared, never silent — the line names whose account runs).
describe("providerRunsOn — the conversation's pin wins over the agent's provider", () => {
  it('a pinned conversation names its own account or key', () => {
    expect(providerRunsOn(providers, agent({ provider: 'account:kai' }), 'ci')).toBe('cheapestinference')
    expect(providerRunsOn(providers, agent({ provider: 'ci' }), 'default')).toBe('Claude subscription · f@x.io')
  })
  it("the agent's fallback shows only when it diverts THIS conversation (its primary is the limited one)", () => {
    const onFallback = { providerId: 'ci', from: 'default', until: '2026-10-23T15:00:00.000Z' }
    expect(providerRunsOn(providers, agent({ provider: 'default', onFallback }))).toBe('cheapestinference (fallback)')
    expect(providerRunsOn(providers, agent({ provider: 'default', onFallback }), 'account:kai')).toBe('Claude Max · kai')
  })
  it('runsOnLine carries the pin', () => {
    expect(runsOnLine({ agent: agent({ model: 'sonnet' }), providers, catalog, pinnedProvider: 'account:kai' })).toContain('kai')
  })
})

describe('providerLabel / providerShortLabel — one voice for accounts and keys', () => {
  it('full form: plan and who; short form: who (or "this machine"); unknown ids read as themselves', () => {
    expect(providerLabel(providers, 'account:kai')).toBe('Claude Max · kai')
    expect(providerLabel(providers, '')).toBe('Claude subscription · f@x.io')
    expect(providerLabel(providers, 'account:gone')).toBe('account:gone')
    expect(providerShortLabel(providers, 'default')).toBe('f')
    expect(providerShortLabel(providers, 'account:kai')).toBe('kai')
    expect(providerShortLabel(providers, 'ci')).toBe('cheapestinference')
    expect(providerShortLabel([], 'default')).toBe('this machine')
  })
})
