// runs-on-opencode.test.ts — an OpenCode session's runs-on line names the
// model and provider the harness observed (provider/model), never a Claude
// catalog entry or a Claude account; the Claude path stays as it was.
import { describe, expect, it } from 'vitest'
import { humanizeProviderIds, runsOnLine } from '../src/lib/runs-on'
import type { AgentView, ModelInfo, ProviderView } from '../src/lib/types'

const catalog: ModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
]
const providers: ProviderView[] = [
  {
    id: 'default',
    kind: 'claude-account',
    label: 'Claude (this machine)',
    account: { name: 'default', configDir: null, providerId: 'default', loggedIn: true, email: 'f@x.io', plan: null, shared: true },
    window: null,
  },
] as ProviderView[]
const agent = { id: 'a', name: 'A', emoji: '', role: '', folder: null, skills: [], sessions: [], liveCount: 0, sessionCount: 0 } as unknown as AgentView

describe('runsOnLine — OpenCode', () => {
  it('prints the observed model and its provider id, not the Claude catalog or account', () => {
    const line = runsOnLine({ agent, providers, catalog, observedModel: 'minimax-coding-plan/MiniMax-M2.7', harness: 'opencode' })
    expect(line).toBe('MiniMax-M2.7 · minimax-coding-plan')
    expect(line).not.toMatch(/Opus|sam|Claude/)
  })

  it('an OpenCode model without a provider prefix still never borrows the Claude account', () => {
    expect(runsOnLine({ agent, providers, catalog, observedModel: 'MiniMax-M2.7', harness: 'opencode' })).toBe('MiniMax-M2.7')
  })

  it('claude-code (or no harness) keeps the Claude line byte-identical', () => {
    const base = runsOnLine({ agent, providers, catalog, observedModel: null })
    expect(base).toBe('Opus (1M context) · Claude subscription · f@x.io')
    expect(runsOnLine({ agent, providers, catalog, observedModel: null, harness: 'claude-code' })).toBe(base)
  })

  it("a Silos gateway prints the bare model and the gateway's brand — never the raw silos-<id>/ prefix nor the row's long name", () => {
    const withGw = [
      ...providers,
      {
        id: '51a19fc9-475c-41cb-86ac-c45c7154c45e',
        kind: 'anthropic-compatible',
        label: 'cheapestinference · mimo-v2.6-flash, deepseek-v4.1-flash',
        baseUrl: 'https://api.cheapestinference.com/anthropic',
        apiKey: 'sk-…ff07',
        models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'],
        createdAt: '2026-10-27',
        window: null,
      },
    ] as ProviderView[]
    expect(
      runsOnLine({ agent, providers: withGw, catalog, observedModel: 'silos-51a19fc9-475c-41cb-86ac-c45c7154c45e/deepseek-v4.1-flash', harness: 'opencode' }),
    ).toBe('deepseek-v4.1-flash · cheapestinference')
    // a typed name is kept whole; an unknown gateway id still drops the prefix
    const typed = [
      ...providers,
      { id: 'gw', kind: 'anthropic-compatible', label: 'my proxy', baseUrl: 'https://p.test', apiKey: 'sk-…1', createdAt: '2026-10-27', window: null },
    ] as ProviderView[]
    expect(runsOnLine({ agent, providers: typed, catalog, observedModel: 'silos-gw/glm-5.3', harness: 'opencode' })).toBe('glm-5.3 · my proxy')
    expect(runsOnLine({ agent, providers, catalog, observedModel: 'silos-gone/glm-5.3', harness: 'opencode' })).toBe('glm-5.3')
  })

  it("a pin beats the last answer's model when the console has not prompted yet; without a pin the observed one stands", () => {
    const withGw = [
      ...providers,
      {
        id: 'ci',
        kind: 'anthropic-compatible',
        label: 'cheapestinference · mimo-v2.6-flash, deepseek-v4.1-flash',
        baseUrl: 'https://api.cheapestinference.com/anthropic',
        apiKey: 'sk-…1',
        models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'],
        createdAt: '2026-10-27',
        window: null,
      },
    ] as ProviderView[]
    const pinned = runsOnLine({
      agent,
      providers: withGw,
      catalog,
      harness: 'opencode',
      pinnedProvider: 'ci',
      pinnedModel: 'mimo-v2.6-flash',
      observedModel: 'silos-ci/deepseek-v4.1-flash',
    })
    expect(pinned).toContain('mimo-v2.6-flash')
    expect(pinned).not.toContain('deepseek')
    expect(
      runsOnLine({ agent, providers: withGw, catalog, harness: 'opencode', pinnedProvider: 'ci', observedModel: 'silos-ci/deepseek-v4.1-flash' }),
    ).toContain('deepseek-v4.1-flash')
  })

  it('a live console whose next prompt runs a different model than the pin says both — the console first, the pin named (it lands when picked in the console)', () => {
    const withGw = [
      ...providers,
      {
        id: 'ci',
        kind: 'anthropic-compatible',
        label: 'cheapestinference · glm-5.3, minimax-m3',
        baseUrl: 'https://api.cheapestinference.com/anthropic',
        apiKey: 'sk-…1',
        models: ['glm-5.3', 'minimax-m3'],
        createdAt: '2026-10-27',
        window: null,
      },
    ] as ProviderView[]
    expect(
      runsOnLine({
        agent,
        providers: withGw,
        catalog,
        harness: 'opencode',
        pinnedProvider: 'ci',
        pinnedModel: 'glm-5.3',
        requestedModel: 'silos-ci/minimax-m3',
      }),
    ).toBe('minimax-m3 · cheapestinference · pinned: glm-5.3')
    // the same model: one truth, no echo
    expect(
      runsOnLine({ agent, providers: withGw, catalog, harness: 'opencode', pinnedProvider: 'ci', pinnedModel: 'glm-5.3', requestedModel: 'silos-ci/glm-5.3' }),
    ).toBe('glm-5.3 · cheapestinference')
  })

  it("without a pin, the TUI's own pick (the last prompt's model) beats the last answer's", () => {
    const withGw = [
      ...providers,
      {
        id: 'ci',
        kind: 'anthropic-compatible',
        label: 'cheapestinference · mimo-v2.6-flash, deepseek-v4.1-flash',
        baseUrl: 'https://api.cheapestinference.com/anthropic',
        apiKey: 'sk-…1',
        models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'],
        createdAt: '2026-10-27',
        window: null,
      },
    ] as ProviderView[]
    expect(
      runsOnLine({ agent, providers: withGw, catalog, harness: 'opencode', requestedModel: 'zai/glm-5.1', observedModel: 'silos-ci/deepseek-v4.1-flash' }),
    ).toBe('glm-5.1 · zai')
  })

  it('humanizeProviderIds: an engine\'s `silos-<uuid>` token reads as the key\'s brand; an unknown id as "a removed key"', () => {
    const ps = [
      ...providers,
      {
        id: '51a19fc9-475c-41cb-86ac-c45c7154c45e',
        kind: 'anthropic-compatible',
        label: 'cheapestinference · mimo-v2.6-flash, deepseek-v4.1-flash',
        baseUrl: 'https://api.cheapestinference.com/anthropic',
        apiKey: 'sk-…1',
        createdAt: '2026-10-27',
        window: null,
      },
    ] as ProviderView[]
    expect(humanizeProviderIds('silos-51a19fc9-475c-41cb-86ac-c45c7154c45e: Aborted', ps)).toBe('cheapestinference: Aborted')
    expect(humanizeProviderIds('silos-00000000-0000-4000-8000-000000000000: 404', ps)).toBe('a removed key: 404')
    expect(humanizeProviderIds('zai: Insufficient balance (429)', ps)).toBe('zai: Insufficient balance (429)')
  })
})
