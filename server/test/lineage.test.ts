import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { LineageStore } from '../src/lineage.js'

let store: LineageStore
let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'deck-')), 'lineage.json')
  store = new LineageStore(file)
})

describe('LineageStore', () => {
  it('with no record -> parentOf null and an empty chainOf', () => {
    expect(store.parentOf('f/a')).toBeNull()
    expect(store.chainOf('f/a')).toEqual([])
  })

  it('record + parentOf, persisted across instances', () => {
    store.record('f/child', 'f/parent')
    expect(store.parentOf('f/child')).toBe('f/parent')
    expect(new LineageStore(file).parentOf('f/child')).toBe('f/parent') // persisted
  })

  it('chainOf resolves transitively (rotation after rotation)', () => {
    store.record('f/c', 'f/b')
    store.record('f/b', 'f/a')
    expect(store.chainOf('f/c')).toEqual(['f/b', 'f/a'])
    expect(store.chainOf('f/b')).toEqual(['f/a'])
    expect(store.chainOf('f/a')).toEqual([])
  })

  it('anti-cycle guard: a hand-edited lineage.json does not hang chainOf', () => {
    // an a-b-a cycle, impossible to create via record() (which never
    // overwrites an existing entry) but possible by editing the file by hand
    writeFileSync(file, JSON.stringify({ parents: { 'f/a': 'f/b', 'f/b': 'f/a' } }))
    const fresh = new LineageStore(file)
    expect(fresh.chainOf('f/a')).toEqual(['f/b']) // cuts off when 'f/a' is seen again
  })

  it('record never overwrites an existing entry', () => {
    store.record('f/child', 'f/original')
    store.record('f/child', 'f/other')
    expect(store.parentOf('f/child')).toBe('f/original')
  })

  it('corrupt file -> starts fresh without crashing', () => {
    writeFileSync(file, '{rot')
    expect(new LineageStore(file).parentOf('f/x')).toBeNull()
  })
})

describe('LineageStore.absorbRotations', () => {
  it('turns <new>.json {from: consoleKey} files into child->parent records (same folder as the parent) and deletes them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'))
    writeFileSync(join(dir, 'y1.json'), JSON.stringify({ from: 'x' }))
    writeFileSync(join(dir, 'y2.json'), JSON.stringify({ from: 'unknown' }))
    writeFileSync(join(dir, 'junk.json'), 'not json')
    const absorbed = store.absorbRotations(dir, (id) => (id === 'x' ? 'f' : null))
    expect(absorbed).toEqual(['f/y1']) // the caller re-announces these sessions
    expect(store.parentOf('f/y1')).toBe('f/x')
    expect(existsSync(join(dir, 'y1.json'))).toBe(false)
    expect(existsSync(join(dir, 'y2.json'))).toBe(true) // parent not indexed yet: retried later
    expect(existsSync(join(dir, 'junk.json'))).toBe(false) // garbage never lingers
  })
  it('marks every absorbed child as born from a /clear (by id, once)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'))
    writeFileSync(join(dir, 'y1.json'), JSON.stringify({ from: 'x' }))
    store.absorbRotations(dir, (id) => (id === 'x' ? 'f' : null))
    store.record('f/z', 'f/y1') // a fork/rotation: not a /clear
    expect(store.isClear('y1')).toBe(true)
    expect(store.isClear('z')).toBe(false)
    expect(store.isClear('x')).toBe(false)
  })
  it('a missing dir is a no-op', () => {
    expect(store.absorbRotations('/nonexistent/dir', () => 'f')).toEqual([])
  })

  // Burying history never breaks the chain: the console key the hook names
  // is the console's FIRST session, which the owner may have trashed long
  // ago (Maintenance). The rotation still belongs to that console's latest
  // session — lineage itself knows the key's folder, no index needed.
  it('resolves a console key that is no longer indexed through lineage itself (an ancestor in the trash)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'))
    store.record('f/b', 'f/console') // the first rotation, absorbed while `console` was still indexed
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ from: 'console' }))
    const absorbed = store.absorbRotations(dir, () => null) // `console` is trashed: the index knows nothing
    expect(absorbed).toEqual(['f/c'])
    expect(store.parentOf('f/c')).toBe('f/b') // linear: under the console's latest session
    expect(existsSync(join(dir, 'c.json'))).toBe(false)
  })

  it('a console key known to NEITHER the index nor lineage is still left for a later pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'))
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ from: 'stranger' }))
    expect(store.absorbRotations(dir, () => null)).toEqual([])
    expect(existsSync(join(dir, 'c.json'))).toBe(true)
  })
})

describe("rotation lineage is LINEAR — each /clear hangs off the console's latest session", () => {
  it('absorbRotations records the second rotation under the first one, not under the console key', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const base = mkdtempSync(join(tmpdir(), 'lin-'))
    const rot = join(base, 'rot')
    mkdirSync(rot)
    const store = new LineageStore(join(base, 'lineage.json'))
    const folderOf = () => 'f'
    writeFileSync(join(rot, 'b.json'), JSON.stringify({ from: 'console' }))
    store.absorbRotations(rot, folderOf)
    writeFileSync(join(rot, 'c.json'), JSON.stringify({ from: 'console' })) // the hook always names the console key
    store.absorbRotations(rot, folderOf)
    expect(store.parentOf('f/b')).toBe('f/console')
    expect(store.parentOf('f/c')).toBe('f/b') // linear: c descends from b
    expect(store.tipOf('f/console')).toBe('f/c')
  })

  // 20-10: a stale SDK twin recorded under the console (an older child)
  // must not become the parent of the next /clear — the honest parent is
  // the most recently ACTIVE session of the thread.
  it('with activity known, a /clear hangs off the most recently active session, not a stale older child', () => {
    const base = mkdtempSync(join(tmpdir(), 'lin-'))
    const rot = join(base, 'rot')
    mkdirSync(rot)
    const store = new LineageStore(join(base, 'lineage.json'))
    store.record('f/twin', 'f/console') // an older SDK twin
    const mtimes: Record<string, number> = { 'f/console': 2000, 'f/twin': 1000 }
    writeFileSync(join(rot, 'next.json'), JSON.stringify({ from: 'console' }))
    store.absorbRotations(
      rot,
      () => 'f',
      (k) => mtimes[k] ?? null,
    )
    expect(store.parentOf('f/next')).toBe('f/console')
  })

  it('tipOf survives pre-fix star data (several children) and cycles', () => {
    const store = new LineageStore(join(mkdtempSync(join(tmpdir(), 'lin-')), 'lineage.json'))
    store.record('f/b', 'f/a')
    store.record('f/c', 'f/a') // star: two children of a — the last recorded wins
    expect(store.tipOf('f/a')).toBe('f/c')
    expect(store.tipOf('f/zz')).toBe('f/zz') // no children: the key itself
  })
})

describe('recentTipOf — the tip is the most recently ACTIVE of the key and its descendants', () => {
  const fresh = () => new LineageStore(join(mkdtempSync(join(tmpdir(), 'lin-')), 'lineage.json'))
  it('an OLDER child never wins over the key itself (a stale SDK fork under a live console)', () => {
    const store = fresh()
    store.record('f/stale', 'f/live')
    const m: Record<string, number> = { 'f/live': 1000, 'f/stale': 10 }
    expect(store.recentTipOf('f/live', (k) => m[k] ?? null)).toBe('f/live')
  })
  it('a NEWER child (a real rotation) is the tip; deep chains pick the max anywhere below', () => {
    const store = fresh()
    store.record('f/b', 'f/a')
    store.record('f/c', 'f/b')
    store.record('f/d', 'f/c')
    const m: Record<string, number> = { 'f/a': 50, 'f/b': 10, 'f/c': 90, 'f/d': 60 }
    expect(store.recentTipOf('f/a', (k) => m[k] ?? null)).toBe('f/c')
    expect(store.recentTipOf('f/c', (k) => m[k] ?? null)).toBe('f/c')
    expect(store.recentTipOf('f/d', (k) => m[k] ?? null)).toBe('f/d')
  })
  it('unknown descendants never win; an unknown key loses to any known descendant; cycles end', () => {
    const store = fresh()
    store.record('f/b', 'f/a')
    expect(store.recentTipOf('f/a', (k) => (k === 'f/a' ? 5 : null))).toBe('f/a')
    expect(store.recentTipOf('f/a', (k) => (k === 'f/b' ? 5 : null))).toBe('f/b')
    expect(store.recentTipOf('f/zz', () => null)).toBe('f/zz')
    store.record('f/a', 'f/b') // hand-edited cycle
    expect(store.recentTipOf('f/a', (k) => (k === 'f/b' ? 9 : 1))).toBe('f/b')
  })
})

// A console's claude can ENTER A WORKTREE (Claude Code's EnterWorktree moves
// its cwd), so its next `/clear` is born in another project folder
// (`-home-x--claude-worktrees-w`), not the console's. A child key that bakes
// in the PARENT's folder names a session that doesn't exist (2 real cases):
// GET /api/sessions on it 404s, and tipOf hands that phantom to
// POST /api/console's 409.
describe('a rotation born inside a worktree is recorded where its transcript lives', () => {
  const MAIN = '-home-x'
  const WT = '-home-x--claude-worktrees-w'
  const fresh = (): { store: LineageStore; rot: string; file: string } => {
    const base = mkdtempSync(join(tmpdir(), 'lin-'))
    const rot = join(base, 'rot')
    mkdirSync(rot)
    const file = join(base, 'lineage.json')
    return { store: new LineageStore(file), rot, file }
  }

  it("the child key takes the folder the index places the child in, not the parent's", () => {
    const { store, rot } = fresh()
    const where: Record<string, string> = { console: MAIN, c: WT }
    writeFileSync(join(rot, 'c.json'), JSON.stringify({ from: 'console' }))
    expect(store.absorbRotations(rot, (id) => where[id] ?? null)).toEqual([`${WT}/c`])
    expect(store.parentOf(`${WT}/c`)).toBe(`${MAIN}/console`)
    expect(store.parentOf(`${MAIN}/c`)).toBeNull()
    expect(store.tipOf(`${MAIN}/console`)).toBe(`${WT}/c`) // the 409's tip is a real session
    // still the console's own past, not a fork from another project
    expect(store.continuationParentIdOf('c')).toBe('console')
  })

  it("a child not indexed yet falls back to the parent's folder, and moves once the index places it", () => {
    const { store, rot } = fresh()
    const where: Record<string, string> = { console: MAIN }
    writeFileSync(join(rot, 'c.json'), JSON.stringify({ from: 'console' }))
    expect(store.absorbRotations(rot, (id) => where[id] ?? null)).toEqual([`${MAIN}/c`])
    where.c = WT // the watcher indexes the new JSONL
    store.absorbRotations(rot, (id) => where[id] ?? null) // nothing new to absorb: the repair alone
    expect(store.parentOf(`${MAIN}/c`)).toBeNull()
    expect(store.parentOf(`${WT}/c`)).toBe(`${MAIN}/console`)
    expect(store.tipOf(`${MAIN}/console`)).toBe(`${WT}/c`)
  })

  it('keys already recorded under the wrong folder are repaired on the next pass — both sides, order kept', () => {
    const { file, rot } = fresh()
    writeFileSync(
      file,
      JSON.stringify({
        parents: {
          [`${MAIN}/b`]: `${MAIN}/console`,
          [`${MAIN}/c`]: `${MAIN}/b`, // pre-fix: c and its parent b both live in the worktree now
          [`${MAIN}/d`]: `${MAIN}/console`, // star data: the LAST child must still win tipOf
        },
      }),
    )
    const where: Record<string, string> = { console: MAIN, b: WT, c: WT, d: WT }
    const store = new LineageStore(file) // a restart: the repair runs on the first pass
    expect(store.absorbRotations(rot, (id) => where[id] ?? null)).toEqual([])
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { parents: Record<string, string> }
    expect(onDisk.parents).toEqual({
      [`${WT}/b`]: `${MAIN}/console`,
      [`${WT}/c`]: `${WT}/b`,
      [`${WT}/d`]: `${MAIN}/console`,
    })
    expect(Object.keys(onDisk.parents)).toEqual([`${WT}/b`, `${WT}/c`, `${WT}/d`])
    expect(store.tipOf(`${MAIN}/console`)).toBe(`${WT}/d`)
    expect(store.chainOf(`${WT}/c`)).toEqual([`${WT}/b`, `${MAIN}/console`])
  })

  it("the restart repair waits for a finished scan: a mid-scan pass that can't place the key doesn't count", () => {
    const { file, rot } = fresh()
    writeFileSync(file, JSON.stringify({ parents: { [`${MAIN}/c`]: `${MAIN}/console` } }))
    const where: Record<string, string> = { console: MAIN } // c not scanned yet
    const store = new LineageStore(file)
    store.absorbRotations(rot, (id) => where[id] ?? null, undefined, false)
    expect(store.parentOf(`${MAIN}/c`)).toBe(`${MAIN}/console`)
    where.c = WT // the scan finishes
    store.absorbRotations(rot, (id) => where[id] ?? null, undefined, true)
    expect(store.parentOf(`${WT}/c`)).toBe(`${MAIN}/console`)
    expect(store.tipOf(`${MAIN}/console`)).toBe(`${WT}/c`)
  })

  it('the same id recorded under two folders collapses to one entry — the first, as record() rules', () => {
    const { file, rot } = fresh()
    writeFileSync(file, JSON.stringify({ parents: { [`${MAIN}/c`]: `${MAIN}/b`, [`${WT}/c`]: `${MAIN}/other` } }))
    const store = new LineageStore(file)
    store.absorbRotations(rot, (id) => (id === 'c' ? WT : id === 'b' || id === 'other' ? MAIN : null))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ parents: { [`${WT}/c`]: `${MAIN}/b` } })
  })

  it('a pass with nothing to repair never writes the file; an unindexed id keeps its recorded folder', () => {
    const { file, rot } = fresh()
    const store = new LineageStore(file)
    store.absorbRotations(rot, () => null)
    expect(existsSync(file)).toBe(false)
    store.record(`${MAIN}/c`, `${MAIN}/gone`) // gone is buried: no index entry, no move
    const before = statSync(file).mtimeMs
    const again = new LineageStore(file)
    again.absorbRotations(rot, (id) => (id === 'c' ? MAIN : null))
    expect(statSync(file).mtimeMs).toBe(before)
    expect(again.parentOf(`${MAIN}/c`)).toBe(`${MAIN}/gone`)
  })

  it('a fork from ANOTHER project is still not a continuation', () => {
    const { store } = fresh()
    store.record(`${MAIN}/n`, `-home-other/p`)
    expect(store.continuationParentIdOf('n')).toBeNull()
  })
})

// Who a thread belongs to is decided at its origin and inherited down the
// chain; the inheritance is written here the moment it is resolved, so
// burying or purging the origin never changes the owner (a
// Builder thread turned Writer when its root left the index under a mass trash).
describe('LineageStore owners', () => {
  it('ownerOf is null until recorded; recordOwner persists across instances', () => {
    expect(store.ownerOf('child')).toBeNull()
    store.recordOwner('child', 'builder')
    expect(store.ownerOf('child')).toBe('builder')
    expect(new LineageStore(file).ownerOf('child')).toBe('builder')
  })

  it('recordOwner never overwrites: the origin decided once', () => {
    store.recordOwner('child', 'builder')
    store.recordOwner('child', 'writer')
    expect(store.ownerOf('child')).toBe('builder')
  })

  it('owners survive the folder repair that rewrites parents', () => {
    store.recordOwner('n', 'builder')
    store.record('-f/n', '-f/p')
    const dir = mkdtempSync(join(tmpdir(), 'rot-'))
    store.absorbRotations(dir, (id) => (id === 'n' ? '-g' : null)) // n relocated → parents rewritten
    expect(store.parentOf('-g/n')).toBe('-f/p')
    expect(store.ownerOf('n')).toBe('builder')
  })

  it('a lineage.json without owners (older file) reads as no owners', () => {
    writeFileSync(file, JSON.stringify({ parents: { 'f/a': 'f/b' } }))
    expect(new LineageStore(file).ownerOf('a')).toBeNull()
  })
})

// Thread chains must never be silently lost: a corrupt lineage.json is
// backed up before the store starts fresh.
describe('corrupt lineage.json', () => {
  it('backs up to .corrupt-* before starting fresh', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(file, '{not json')
    expect(store.parentOf('f/child')).toBeNull()
    const dir = dirname(file)
    const backups = readdirSync(dir).filter((f) => f.startsWith('lineage.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{not json')
  })
})
