import { describe, it, expect, vi } from 'vitest'
import { screenShowsModel, settleModelOnScreen, tuiNames } from '../src/harnesses/opencode/tui-client.js'

// The TUI's selection is read from its SCREEN (the header "Build auto ·
// <model name> <provider name>") and moved with its own recent-models
// cycle — verified by the screen after each step, never assumed.
const PROVIDERS = JSON.stringify({
  providers: [
    { id: 'zai', name: 'Z.AI', models: { 'glm-5.1': { name: 'GLM-5.1' } } },
    { id: 'zai-coding-plan', name: 'Z.AI Coding Plan', models: { 'glm-5.3-highspeed': { name: 'GLM-5.3 Highspeed' }, 'glm-5.3': { name: 'GLM-5.3' } } },
  ],
})

function fakeFetch(state: { steps: number }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/config/providers')) return new Response(PROVIDERS, { status: 200 })
    if (u.endsWith('/tui/publish')) {
      expect(JSON.parse(String(init?.body))).toEqual({ type: 'tui.command.execute', properties: { command: 'model.cycle_recent' } })
      state.steps++
      return new Response('true', { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

describe('screenShowsModel — the header, exactly', () => {
  it('matches model AND provider names after the separator; a prefix of a longer name does not pass', () => {
    expect(screenShowsModel('┃  Build auto · GLM-5.3 Z.AI Coding Plan', 'GLM-5.3', 'Z.AI Coding Plan')).toBe(true)
    expect(screenShowsModel('┃  Build auto · GLM-5.3 Highspeed Z.AI Coding Plan', 'GLM-5.3', 'Z.AI Coding Plan')).toBe(false)
    expect(screenShowsModel('┃  Build auto · GLM-5.1 Z.AI', 'GLM-5.3', 'Z.AI Coding Plan')).toBe(false)
  })
})

describe('tuiNames', () => {
  it('reads provider and model display names from /config/providers', async () => {
    const names = await tuiNames({ port: 1, password: 'pw', fetchImpl: fakeFetch({ steps: 0 }) })
    expect(names.provider.get('zai-coding-plan')).toBe('Z.AI Coding Plan')
    expect(names.model.get('zai-coding-plan/glm-5.3')).toBe('GLM-5.3')
  })
})

describe('settleModelOnScreen', () => {
  it('cycles until the screen reads the pin, then stops', async () => {
    const state = { steps: 0 }
    const screen = vi.fn(() => `┃  Build auto · ${state.steps >= 2 ? 'GLM-5.3 Z.AI Coding Plan' : 'GLM-5.1 Z.AI'}`)
    const r = await settleModelOnScreen({
      port: 1,
      password: 'pw',
      providerID: 'zai-coding-plan',
      modelID: 'glm-5.3',
      screen,
      fetchImpl: fakeFetch(state),
      settleMs: 1,
    })
    expect(r).toBe('settled')
    expect(state.steps).toBe(2)
  })
  it('already on the pin: no step at all', async () => {
    const state = { steps: 0 }
    const r = await settleModelOnScreen({
      port: 1,
      password: null,
      providerID: 'zai',
      modelID: 'glm-5.1',
      screen: () => '┃  Build auto · GLM-5.1 Z.AI',
      fetchImpl: fakeFetch(state),
      settleMs: 1,
    })
    expect(r).toBe('settled')
    expect(state.steps).toBe(0)
  })
  it('gives up after maxSteps when the screen never shows it', async () => {
    const state = { steps: 0 }
    const r = await settleModelOnScreen({
      port: 1,
      password: 'pw',
      providerID: 'zai-coding-plan',
      modelID: 'glm-5.3',
      screen: () => '┃  Build auto · GLM-5.1 Z.AI',
      fetchImpl: fakeFetch(state),
      maxSteps: 3,
      settleMs: 1,
    })
    expect(r).toBe('unreachable')
    expect(state.steps).toBe(3)
  })
  it('maxSteps 0: reads the screen and never cycles (the in-place check)', async () => {
    const state = { steps: 0 }
    const r = await settleModelOnScreen({
      port: 1,
      password: 'pw',
      providerID: 'zai-coding-plan',
      modelID: 'glm-5.3',
      screen: () => '┃  Build auto · GLM-5.1 Z.AI',
      fetchImpl: fakeFetch(state),
      maxSteps: 0,
      settleMs: 1,
    })
    expect(r).toBe('unreachable')
    expect(state.steps).toBe(0)
  })
  it('a model the TUI does not list is unknown — nothing is cycled', async () => {
    const state = { steps: 0 }
    const r = await settleModelOnScreen({
      port: 1,
      password: 'pw',
      providerID: 'kimi-for-coding',
      modelID: 'k2p6',
      screen: () => '',
      fetchImpl: fakeFetch(state),
      settleMs: 1,
    })
    expect(r).toBe('unknown-model')
    expect(state.steps).toBe(0)
  })
})
