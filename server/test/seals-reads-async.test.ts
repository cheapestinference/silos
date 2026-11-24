// seals-reads-async.test.ts — the read-hash pass of the server's tick
// (Seals.reconcileReadsAsync, perf 21-11) gives the SAME results as the
// synchronous pass (reconcileReads) and never holds the event loop for the
// whole walk: async readdir, files read in batches with the loop released
// between them, never overlapping itself, and a file Silos itself checks or
// reseals meanwhile is left to that newer reading. Temp dirs only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Seals, READ_BATCH, walkFiles, walkFilesAsync, type SealRow } from '../src/seals.js'
import { setSealHooks } from '../src/seal-hooks.js'

let base: string, home: string, folder: string
let clock: number

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-seals-async-'))
  home = join(base, 'home')
  folder = join(base, 'work')
  mkdirSync(join(folder, '.claude'), { recursive: true })
  mkdirSync(home, { recursive: true })
  clock = Date.parse('2026-11-10T10:00:00Z')
})
afterEach(() => {
  setSealHooks(null)
  rmSync(base, { recursive: true, force: true })
})

function seals(name: string): Seals {
  const dataDir = join(base, `data-${name}`)
  mkdirSync(dataDir, { recursive: true })
  return new Seals({
    dataDir,
    home,
    now: () => clock,
    log: () => {},
    agents: () => [{ id: 'writer', name: 'Writer', folder }],
    configFilesOf: (f) => [`${f}/.mcp.json`, `${f}/.claude/agents/**`],
  })
}

// what a pass leaves: rows (without their random id), page lines, the cache's reads
const outcome = (s: Seals): unknown => ({
  rows: s.rows().map((r: SealRow) => {
    const { id: _id, ...rest } = r as SealRow & { id: string }
    return rest
  }),
  lines: s.pageLines(),
  watched: s.watchedReads().map((w) => w.file),
})

const pluginsDir = (): string => join(home, '.claude', 'plugins')
const versionDir = (v: string): string => join(pluginsDir(), 'cache', 'm', 'p', v)
function record(v: string | null): void {
  mkdirSync(pluginsDir(), { recursive: true })
  writeFileSync(
    join(pluginsDir(), 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: v === null ? {} : { 'p@m': [{ scope: 'user', installPath: versionDir(v), version: v }] } }),
  )
}
function tree(dir: string, n: number, body = (i: number) => `file ${i}`): void {
  for (let i = 0; i < n; i++) {
    const d = join(dir, `d${i % 7}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `f${i}.md`), body(i))
  }
}

describe('the async read-hash pass = the sync one', () => {
  it('walkFilesAsync lists the same files in the same order, with the same bound', async () => {
    tree(join(base, 'w'), 300)
    mkdirSync(join(base, 'w', 'empty'))
    symlinkSync(join(base, 'w', 'd0', 'f0.md'), join(base, 'w', 'link.md'))
    for (const max of [0, 1, 150, 10_000]) {
      expect(await walkFilesAsync(join(base, 'w'), max)).toEqual(walkFiles(join(base, 'w'), max))
      expect(await walkFilesAsync(join(base, 'w'), max, { links: true })).toEqual(walkFiles(join(base, 'w'), max, { links: true }))
    }
    expect(await walkFilesAsync(join(base, 'nope'), 10)).toEqual([])
  })

  it('every kind of change, step by step: rows, page lines and the watch list are identical', async () => {
    const local = join(folder, '.claude', 'settings.local.json')
    writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }))
    writeFileSync(join(folder, '.mcp.json'), '{}')
    tree(join(folder, '.claude', 'agents'), 40)
    tree(join(home, '.claude', 'commands'), 200)
    tree(versionDir('1.0.0'), 120)
    tree(join(pluginsDir(), 'marketplaces', 'm'), 150) // the engine's storage: never a row
    record('1.0.0')
    // a big file (streamed hash) inside what the record names
    writeFileSync(join(versionDir('1.0.0'), 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7))

    const sync = seals('sync'),
      async_ = seals('async')
    sync.boot()
    sync.endBoot()
    async_.boot()
    async_.endBoot()
    const step = async (): Promise<void> => {
      clock += 60_000
      sync.reconcileReads()
      await async_.reconcileReadsAsync()
      expect(outcome(async_)).toEqual(outcome(sync))
    }
    await step() // nothing changed
    writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(ls)', 'WebFetch'] } })) // engine keys only: a page line
    await step()
    writeFileSync(join(folder, '.mcp.json'), '{"mcpServers":{"evil":{"command":"x"}}}') // a named file: a row
    await step()
    writeFileSync(join(folder, '.claude', 'agents', 'd0', 'planted.md'), 'appeared') // appeared in a walked dir
    writeFileSync(join(home, '.claude', 'commands', 'd1', 'f1.md'), 'edited in place')
    await step()
    writeFileSync(join(versionDir('1.0.0'), 'd2', 'f2.md'), 'edited plugin file') // inside what the record names
    writeFileSync(join(versionDir('1.0.0'), 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 8))
    rmSync(join(versionDir('1.0.0'), 'd3', 'f3.md')) // a deletion the walk no longer finds
    writeFileSync(join(pluginsDir(), 'marketplaces', 'm', 'd0', 'f0.md'), 'catalog churn')
    await step()
    mkdirSync(join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0', '.in_use'), { recursive: true })
    writeFileSync(join(versionDir('1.0.0'), '.in_use', '4242'), '') // the engine's bookkeeping
    await step()
    tree(versionDir('1.1.0'), 30)
    record('1.1.0') // the engine moved the plugin: a page line
    await step()
    record(null) // removed outside Silos: a row
    await step()
    expect(async_.rows().length).toBeGreaterThan(0)
  })
})

describe('the async pass never holds the loop, never overlaps itself', () => {
  it('the loop runs between batches (an immediate queued before the pass runs before it ends)', async () => {
    tree(join(home, '.claude', 'commands'), READ_BATCH * 5)
    const s = seals('loop')
    s.boot()
    s.endBoot()
    let ticks = 0
    let on = true
    const spin = (): void => {
      if (!on) return
      ticks++
      setImmediate(spin)
    }
    setImmediate(spin)
    await s.reconcileReadsAsync()
    on = false
    // at least one turn of the loop per batch (5 batches + the walk's awaits)
    expect(ticks).toBeGreaterThanOrEqual(5)
  })

  it('a call while a pass runs gets that pass', async () => {
    tree(join(home, '.claude', 'commands'), 100)
    const s = seals('overlap')
    s.boot()
    s.endBoot()
    const a = s.reconcileReadsAsync()
    const b = s.reconcileReadsAsync()
    expect(b).toBe(a)
    await a
    const c = s.reconcileReadsAsync()
    expect(c).not.toBe(a)
    await c
  })

  it('a file Silos reseals during the pass is left to that newer reading (no row over its own write)', async () => {
    const local = join(folder, '.claude', 'settings.local.json')
    writeFileSync(local, '{}')
    tree(join(home, '.claude', 'commands'), READ_BATCH * 3)
    const s = seals('touch')
    s.boot()
    s.endBoot()
    const pass = s.reconcileReadsAsync()
    // Silos' own write lands while the pass is walking (an owner's settings write)
    writeFileSync(local, '{"enabledPlugins":{"x@m":true}}')
    s.resealRead(local)
    await pass
    expect(s.rows()).toEqual([])
    // and the next pass agrees: nothing changed since Silos' own write
    await s.reconcileReadsAsync()
    expect(s.rows()).toEqual([])
  })
})
