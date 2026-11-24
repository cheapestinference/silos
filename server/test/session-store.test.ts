import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/session-store.js'

let root: string, dataDir: string, store: SessionStore
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  mkdirSync(join(root, '-tmp-p'), { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  writeFileSync(join(root, '-tmp-p', 'x.jsonl'), '{}\n')
  store = new SessionStore(root, dataDir)
})

describe('rename', () => {
  it('saves, reads and clears overrides', () => {
    expect(store.titleOverride('-tmp-p', 'x')).toBeNull()
    store.rename('-tmp-p', 'x', 'My title')
    expect(store.titleOverride('-tmp-p', 'x')).toBe('My title')
    expect(new SessionStore(root, dataDir).titleOverride('-tmp-p', 'x')).toBe('My title') // persisted
    store.rename('-tmp-p', 'x', '')
    expect(store.titleOverride('-tmp-p', 'x')).toBeNull()
  })
})

describe('autoTitles + precedence', () => {
  it('setAutoTitle saves and persists without touching manual titles', () => {
    store.rename('-tmp-p', 'x', 'Manual')
    store.setAutoTitle('-tmp-p', 'y', 'invoice sync')
    expect(store.autoTitle('-tmp-p', 'y')).toBe('invoice sync')
    const reloaded = new SessionStore(root, dataDir)
    expect(reloaded.autoTitle('-tmp-p', 'y')).toBe('invoice sync')
    expect(reloaded.titleOverride('-tmp-p', 'x')).toBe('Manual') // manual is sacred
  })
  it('resolver: manual > auto > raw, with origin', () => {
    store.rename('-tmp-p', 'a', 'Manual')
    store.setAutoTitle('-tmp-p', 'a', 'ignored auto')
    store.setAutoTitle('-tmp-p', 'b', 'deploy vps')
    const resolve = store.titleResolver()
    expect(resolve('-tmp-p', 'a', 'first sentence')).toEqual({ title: 'Manual', origin: 'manual' })
    expect(resolve('-tmp-p', 'b', 'first sentence')).toEqual({ title: 'deploy vps', origin: 'auto' })
    expect(resolve('-tmp-p', 'c', 'first sentence')).toEqual({ title: 'first sentence', origin: 'raw' })
  })
  it('a later rename wins over the existing autoTitle (precedence, not deletion)', () => {
    store.setAutoTitle('-tmp-p', 'x', 'auto title')
    store.rename('-tmp-p', 'x', 'The right one')
    expect(store.titleResolver()('-tmp-p', 'x', 'raw')).toEqual({ title: 'The right one', origin: 'manual' })
  })
  it('back-compat: an overrides.json without an autoTitles field reads as {}', () => {
    writeFileSync(join(dataDir, 'overrides.json'), JSON.stringify({ titles: { '-tmp-p/x': 'Old' } }) + '\n')
    const s = new SessionStore(root, dataDir)
    expect(s.autoTitle('-tmp-p', 'x')).toBeNull()
    expect(s.autoTitles()).toEqual({})
    expect(s.titleResolver()('-tmp-p', 'x', 'raw')).toEqual({ title: 'Old', origin: 'manual' })
    // writing an autoTitle over the legacy file doesn't lose the titles
    s.setAutoTitle('-tmp-p', 'y', 'new auto')
    const again = new SessionStore(root, dataDir)
    expect(again.titleOverride('-tmp-p', 'x')).toBe('Old')
    expect(again.autoTitle('-tmp-p', 'y')).toBe('new auto')
  })
})

describe('trash', () => {
  it('moves jsonl + subdir to trash without deleting anything', async () => {
    mkdirSync(join(root, '-tmp-p', 'x', 'subagents'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'x', 'subagents', 'a.jsonl'), '{}\n')
    const dest = await store.trash('-tmp-p', 'x')
    expect(existsSync(join(root, '-tmp-p', 'x.jsonl'))).toBe(false)
    expect(readFileSync(dest, 'utf8')).toBe('{}\n')
    expect(existsSync(join(dataDir, 'trash', '-tmp-p', 'x', 'subagents', 'a.jsonl'))).toBe(true)
  })
  it('a collision in trash -> suffix, never overwrites', async () => {
    const d1 = await store.trash('-tmp-p', 'x')
    writeFileSync(join(root, '-tmp-p', 'x.jsonl'), '{"v":2}\n')
    const d2 = await store.trash('-tmp-p', 'x')
    expect(d2).not.toBe(d1)
    expect(readFileSync(d1, 'utf8')).toBe('{}\n')
    expect(readFileSync(d2, 'utf8')).toBe('{"v":2}\n')
  })
  it('a nonexistent session throws', async () => {
    await expect(store.trash('-tmp-p', 'nobody')).rejects.toThrow('not found')
  })
  it('folder=".." -> belt and suspenders rejects it even if the server didn\'t filter it', async () => {
    // a decoy outside the index, at the exact spot join(root, '..', 'x.jsonl') would point to
    const decoy = join(root, '..', 'x.jsonl')
    writeFileSync(decoy, 'do not touch\n')
    await expect(store.trash('..', 'x')).rejects.toThrow('path outside the index')
    expect(existsSync(decoy)).toBe(true)
    expect(readFileSync(decoy, 'utf8')).toBe('do not touch\n')
  })
  it('shared suffix: jsonl and subdir stay paired across multiple collisions', async () => {
    // 1st: trash x with a subdir -> x.jsonl + x/
    mkdirSync(join(root, '-tmp-p', 'x', 'subagents'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'x', 'subagents', 'a.jsonl'), 'v1\n')
    const d1 = await store.trash('-tmp-p', 'x')
    expect(d1).toBe(join(dataDir, 'trash', '-tmp-p', 'x.jsonl'))
    expect(existsSync(join(dataDir, 'trash', '-tmp-p', 'x', 'subagents', 'a.jsonl'))).toBe(true)

    // 2nd: trash x without a subdir -> x-1.jsonl (jsonl only)
    writeFileSync(join(root, '-tmp-p', 'x.jsonl'), '{"v":2}\n')
    const d2 = await store.trash('-tmp-p', 'x')
    expect(d2).toBe(join(dataDir, 'trash', '-tmp-p', 'x-1.jsonl'))
    expect(existsSync(join(dataDir, 'trash', '-tmp-p', 'x-1'))).toBe(false)

    // 3rd: trash x with a subdir -> x-2.jsonl + x-2/ (not x-2.jsonl + x-1/!)
    mkdirSync(join(root, '-tmp-p', 'x', 'subagents'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'x.jsonl'), '{"v":3}\n')
    writeFileSync(join(root, '-tmp-p', 'x', 'subagents', 'a.jsonl'), 'v3\n')
    const d3 = await store.trash('-tmp-p', 'x')
    expect(d3).toBe(join(dataDir, 'trash', '-tmp-p', 'x-2.jsonl'))
    expect(readFileSync(d3, 'utf8')).toBe('{"v":3}\n')
    expect(existsSync(join(dataDir, 'trash', '-tmp-p', 'x-2', 'subagents', 'a.jsonl'))).toBe(true)
    expect(readFileSync(join(dataDir, 'trash', '-tmp-p', 'x-2', 'subagents', 'a.jsonl'), 'utf8')).toBe('v3\n')
    expect(existsSync(join(dataDir, 'trash', '-tmp-p', 'x-1'))).toBe(false) // crucial: x-1/ must NOT exist
  })
})

// Manual titles are "sacred": a corrupt overrides.json is backed up ONCE
// (readOverrides runs per operation — a flag keeps repeated reads from
// piling up timestamped copies) before the store starts fresh.
describe('corrupt overrides.json', () => {
  it('backs up to .corrupt-* exactly once across repeated reads', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(dataDir, 'overrides.json'), '{not json')
    expect(store.titleOverride('-tmp-p', 'x')).toBeNull()
    expect(store.titleOverride('-tmp-p', 'x')).toBeNull()
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('overrides.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dataDir, backups[0]!), 'utf8')).toBe('{not json')
  })
})
