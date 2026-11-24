import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelCatalog, type ModelInfo } from '../src/model-catalog.js'

const MODELS: ModelInfo[] = [
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-catalog-'))
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ModelCatalog', () => {
  it('with no file and no source: an honest empty result', () => {
    const c = new ModelCatalog(dir)
    c.load()
    expect(c.view()).toEqual({ models: [], fetchedAt: null })
  })

  it('refresh persists (atomically) and a fresh load reads it back without re-spawning', async () => {
    const fetch = vi.fn().mockResolvedValue(MODELS)
    const c = new ModelCatalog(dir, fetch, () => new Date('2026-08-20T12:00:00Z'))
    c.load()
    const v = await c.refresh()
    expect(v.models).toHaveLength(2)
    expect(v.fetchedAt).toBe('2026-08-20T12:00:00.000Z')
    expect(existsSync(join(dir, 'model-catalog.json.tmp'))).toBe(false)

    const c2 = new ModelCatalog(dir) // no source: can only read the file
    c2.load()
    expect(c2.view().models.map((m) => m.value)).toEqual(['sonnet', 'haiku'])
  })

  it('maybeRefreshOnBoot: refreshes ONLY when there is no persisted catalog (tsx watch does not spawn on every restart)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetch = vi.fn().mockResolvedValue(MODELS)
    const c = new ModelCatalog(dir, fetch)
    c.load()
    await c.maybeRefreshOnBoot()
    expect(fetch).toHaveBeenCalledTimes(1)

    const c2 = new ModelCatalog(dir, fetch)
    c2.load() // a file already exists
    await c2.maybeRefreshOnBoot()
    expect(fetch).toHaveBeenCalledTimes(1) // no new call
  })

  it('a failed refresh NEVER overwrites the previous catalog', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(MODELS).mockRejectedValueOnce(new Error('CLI down'))
    const c = new ModelCatalog(dir, fetch)
    c.load()
    await c.refresh()
    await expect(c.refresh()).rejects.toThrow('CLI down')
    expect(c.view().models).toHaveLength(2)
  })

  it('the SDK returning an empty list is an error (never a "verified empty catalog")', async () => {
    const c = new ModelCatalog(dir, vi.fn().mockResolvedValue([]))
    c.load()
    await expect(c.refresh()).rejects.toThrow('the SDK did not return any models')
  })

  it('concurrent refreshes coalesce into a single spawn', async () => {
    let resolver: (v: ModelInfo[]) => void = () => {}
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise<ModelInfo[]>((r) => {
          resolver = r
        }),
    )
    const c = new ModelCatalog(dir, fetch)
    c.load()
    const p1 = c.refresh()
    const p2 = c.refresh()
    resolver(MODELS)
    await Promise.all([p1, p2])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a corrupt cache -> empty with no backup (it is regenerable), malformed entries are filtered', () => {
    writeFileSync(join(dir, 'model-catalog.json'), '{broken')
    const c = new ModelCatalog(dir)
    c.load()
    expect(c.view()).toEqual({ models: [], fetchedAt: null })

    writeFileSync(join(dir, 'model-catalog.json'), JSON.stringify({ fetchedAt: 'x', models: [{ value: 'ok', displayName: 'OK' }, { shapeless: true }, 42] }))
    const c2 = new ModelCatalog(dir)
    c2.load()
    expect(c2.view().models.map((m) => m.value)).toEqual(['ok'])
  })
})
