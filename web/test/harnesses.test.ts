// harnesses.test.ts — the web descriptor module (harness seam): the seed,
// the default and unknown-engine rules, validation that
// leaves the list unchanged, the store's boot load, and the catalogue URLs
// api.models()/refreshModels() build for each engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import seed from '../src/lib/harnesses.seed.json'
import { defaultHarnessId, descriptorOf, harnessDescriptors, setHarnessDescriptors, unknownDescriptor, useHarness } from '../src/lib/harnesses'
import { api } from '../src/lib/api'
import { useStore } from '../src/store'
import type { HarnessDescriptor } from '../src/lib/types'

const SEED = seed.harnesses as HarnessDescriptor[]
const [CLAUDE, OPEN] = SEED as [HarnessDescriptor, HarnessDescriptor]
const fake: HarnessDescriptor = { ...unknownDescriptor('fake'), label: 'Fake engine', ui: { ...unknownDescriptor('fake').ui, models: 'provider-model' } }

afterEach(() => {
  setHarnessDescriptors(SEED)
  vi.restoreAllMocks()
})

describe('descriptors', () => {
  it('starts as the seed, in order, with the default engine for an absent id', () => {
    expect(harnessDescriptors()).toEqual(SEED)
    expect(defaultHarnessId()).toBe(CLAUDE.id)
    expect(descriptorOf(undefined)).toEqual(CLAUDE)
    expect(descriptorOf(null)).toEqual(CLAUDE)
    expect(descriptorOf('')).toEqual(CLAUDE)
    expect(descriptorOf(OPEN.id)).toEqual(OPEN)
  })

  it('an unregistered id is the unknown engine — never the default one', () => {
    const d = descriptorOf('not-an-engine')
    expect(d).toEqual(unknownDescriptor('not-an-engine'))
    expect(d.label).toBe('not-an-engine')
    expect(d.default).toBe(false)
    expect(Object.values(d.caps).every((v) => v === false)).toBe(true)
    expect(d.providerKinds).toEqual([])
    expect(d.modeSwitch).toBe(false)
    expect(d.ui).toEqual({
      contextPercent: false,
      models: 'none',
      ownLogin: true,
      territoryFenced: true,
      territoryNote: null,
      settingsAbout: null,
      loginImport: null,
      providerExport: null,
    })
  })

  it('setHarnessDescriptors takes a valid list and refuses anything else, unchanged', () => {
    expect(setHarnessDescriptors([...SEED, fake])).toBe(true)
    expect(descriptorOf('fake').label).toBe('Fake engine')
    const before = harnessDescriptors()
    const bad: unknown[] = [
      undefined,
      null,
      {},
      [],
      'x',
      [...SEED, { ...fake, id: CLAUDE.id }], // duplicate id
      [{ ...CLAUDE, default: false }, OPEN], // no default
      [CLAUDE, { ...OPEN, default: true }], // two defaults
      [CLAUDE, { ...OPEN, caps: { ...OPEN.caps, skills: 'yes' } }],
      [CLAUDE, { ...OPEN, providerKinds: ['nope'] }],
      [CLAUDE, { ...OPEN, ui: { ...OPEN.ui, models: 'raw' } }],
      [CLAUDE, { ...OPEN, ui: { ...OPEN.ui, loginImport: { list: '/x' } } }],
      [CLAUDE, { ...OPEN, label: 3 }],
    ]
    for (const b of bad) expect(setHarnessDescriptors(b)).toBe(false)
    expect(harnessDescriptors()).toBe(before)
  })

  it('useHarness re-renders when the list changes', () => {
    const { result } = renderHook(() => useHarness('fake'))
    expect(result.current.label).toBe('fake')
    act(() => {
      setHarnessDescriptors([...SEED, fake])
    })
    expect(result.current.label).toBe('Fake engine')
  })
})

describe('store.loadHarnesses', () => {
  it('the boot load replaces the list on a valid answer', async () => {
    expect(harnessDescriptors()).toEqual(SEED)
    vi.spyOn(api, 'harnesses').mockResolvedValue({ harnesses: [...SEED, fake] })
    await useStore.getState().loadHarnesses()
    // the module list is the one copy (no store mirror)
    expect(harnessDescriptors().map((d) => d.id)).toEqual([CLAUDE.id, OPEN.id, 'fake'])
    expect('harnesses' in useStore.getState()).toBe(false)
    expect(descriptorOf('fake').label).toBe('Fake engine')
  })

  it('keeps the seed on undefined (automock), an invalid shape or a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spy = vi.spyOn(api, 'harnesses')
    spy.mockReturnValue(undefined as never)
    await useStore.getState().loadHarnesses()
    spy.mockResolvedValue({ harnesses: [{ id: 'x' }] } as never)
    await useStore.getState().loadHarnesses()
    spy.mockRejectedValue(new Error('down'))
    await useStore.getState().loadHarnesses()
    spy.mockImplementation(() => {
      throw new Error('sync')
    })
    await useStore.getState().loadHarnesses()
    expect(harnessDescriptors()).toEqual(SEED)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('catalogue URLs (unchanged for both engines)', () => {
  let urls: string[]
  beforeEach(() => {
    urls = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      urls.push(String(u))
      return { ok: true, status: 200, json: async () => ({ models: [] }) } as Response
    })
  })

  it('the default engine (or none) asks the bare route; any other engine names itself', async () => {
    await api.models()
    await api.models(CLAUDE.id)
    await api.models(OPEN.id, { provider: 'zai', agentId: 'builder' })
    await api.models('codex')
    await api.refreshModels()
    await api.refreshModels(CLAUDE.id)
    await api.refreshModels(OPEN.id)
    expect(urls.map((u) => u.replace(/^https?:\/\/[^/]+/, ''))).toEqual([
      '/api/models',
      '/api/models',
      `/api/models?harness=${OPEN.id}&provider=zai&agentId=builder`,
      '/api/models?harness=codex',
      '/api/models/refresh',
      '/api/models/refresh',
      `/api/models/refresh?harness=${OPEN.id}`,
    ])
  })

  it('engine logins follow the descriptor routes; an engine without them lists none', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (u) => {
      urls.push(String(u))
      return { ok: true, status: 200, json: async () => ({ ids: ['zai'], provider: { id: 'p' } }) } as Response
    })
    expect(await api.providers.engineLogins(OPEN)).toEqual(['zai'])
    expect(await api.providers.engineLogins(CLAUDE)).toEqual([])
    await api.providers.importLogin(OPEN, 'zai', 'Z')
    await expect(api.providers.importLogin(CLAUDE, 'zai', 'Z')).rejects.toThrow()
    expect(urls).toEqual([OPEN.ui.loginImport!.list, OPEN.ui.loginImport!.import])
  })

  it('OpenCode keeps the exact requests the retired opencodeLogins/importOpencode made', async () => {
    const calls: Array<[string, string | undefined, unknown]> = []
    vi.mocked(globalThis.fetch).mockImplementation(async (u, init) => {
      calls.push([String(u).replace(/^https?:\/\/[^/]+/, ''), init?.method, init?.body])
      return { ok: true, status: 200, json: async () => ({ ids: ['zai'], provider: { id: 'p' } }) } as Response
    })
    await api.providers.engineLogins(OPEN)
    await api.providers.importLogin(OPEN, 'zai-coding-plan', 'zai-coding-plan')
    expect(calls).toEqual([
      ['/api/providers/opencode/auth', undefined, undefined],
      ['/api/providers/import-opencode', 'POST', JSON.stringify({ providerId: 'zai-coding-plan', label: 'zai-coding-plan' })],
    ])
  })

  it("a third engine's login import calls ITS routes, never OpenCode's", async () => {
    const own: HarnessDescriptor = { ...fake, ui: { ...fake.ui, loginImport: { list: '/api/providers/fake/logins', import: '/api/providers/fake/import' } } }
    vi.mocked(globalThis.fetch).mockImplementation(async (u) => {
      urls.push(String(u).replace(/^https?:\/\/[^/]+/, ''))
      return { ok: true, status: 200, json: async () => ({ ids: ['acme'], provider: { id: 'p' } }) } as Response
    })
    expect(await api.providers.engineLogins(own)).toEqual(['acme'])
    await api.providers.importLogin(own, 'acme', 'acme')
    expect(urls).toEqual(['/api/providers/fake/logins', '/api/providers/fake/import'])
  })
})
