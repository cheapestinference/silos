import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SeenStore } from '../src/seen-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-seen-'))
})
afterEach(() => {
  vi.restoreAllMocks()
})

function store(now?: () => number): SeenStore {
  const s = new SeenStore(dir, now)
  s.load()
  return s
}

describe('SeenStore', () => {
  it('with no file: get returns an honest null', () => {
    expect(store().get('-proj', 's1')).toBeNull()
  })

  it('markSeen writes atomically (no leftover .tmp) and persists across loads', () => {
    const s = store(() => 12345)
    const at = s.markSeen('-proj', 's1')
    expect(at).toBe(12345)
    expect(existsSync(join(dir, 'seen.json'))).toBe(true)
    expect(existsSync(join(dir, 'seen.json.tmp'))).toBe(false)
    const s2 = store()
    expect(s2.get('-proj', 's1')).toBe(12345)
  })

  it('markSeen is idempotent and advances to the last seen instant', () => {
    let clock = 1000
    const s = store(() => clock)
    s.markSeen('-proj', 's1')
    clock = 5000
    s.markSeen('-proj', 's1')
    expect(s.get('-proj', 's1')).toBe(5000)
  })

  it('corrupt JSON: backs up to .corrupt-* BEFORE starting fresh, never silently overwrites the original', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = join(dir, 'seen.json')
    writeFileSync(file, '{this is not json')
    const s = store()
    expect(s.get('-proj', 's1')).toBeNull()
    const backups = readdirSync(dir).filter((f) => f.startsWith('seen.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{this is not json')
  })

  it('an entry with a non-numeric value (hand-edited) is discarded with a warning, the rest survives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(dir, 'seen.json'), JSON.stringify({ seen: { '-proj/bad': 'yesterday', '-proj/negative': -5, '-proj/good': 4242 } }))
    const s = store()
    expect(s.get('-proj', 'bad')).toBeNull()
    expect(s.get('-proj', 'negative')).toBeNull()
    expect(s.get('-proj', 'good')).toBe(4242)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('-proj/bad'))
  })

  it('a missing or malformed seen field in the JSON -> an empty map, no crash', () => {
    writeFileSync(join(dir, 'seen.json'), JSON.stringify({ seen: [1, 2, 3] }))
    expect(store().get('-proj', 's1')).toBeNull()
  })

  describe('sweepOrphans', () => {
    it('sweeps old orphaned keys (loaded from disk, no grace), keeps live ones', () => {
      const s = store()
      s.markSeen('-proj', 'alive')
      s.markSeen('-proj', 'trashed')
      // reload from disk: no "just written" marker -> already prunable
      const s2 = store()
      s2.sweepOrphans(new Set(['-proj/alive']))
      expect(s2.get('-proj', 'alive')).not.toBeNull()
      expect(s2.get('-proj', 'trashed')).toBeNull()
      const raw = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))
      expect(Object.keys(raw.seen)).toEqual(['-proj/alive'])
    })

    it('a freshly-marked key survives a sweep even if not yet in the index (grace); past the grace period it gets pruned', () => {
      let clock = 1_000_000
      const s = new SeenStore(dir, () => clock)
      s.load()
      s.markSeen('-proj', 'new')
      s.sweepOrphans(new Set()) // the index hasn't seen it yet — still within the grace period
      expect(s.get('-proj', 'new')).not.toBeNull()
      clock += 11 * 60_000 // past the window (10 min) and still not indexed
      s.sweepOrphans(new Set())
      expect(s.get('-proj', 'new')).toBeNull()
    })

    it('does not rewrite the file if nothing changed', () => {
      const s = store()
      s.markSeen('-proj', 'alive')
      const before = readFileSync(join(dir, 'seen.json'), 'utf8')
      s.sweepOrphans(new Set(['-proj/alive'])) // nothing to prune
      expect(readFileSync(join(dir, 'seen.json'), 'utf8')).toBe(before)
    })
  })
})
