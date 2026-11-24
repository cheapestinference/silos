import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { purgeTrash, TRASH_KEEP_MS } from '../src/trash-purge.js'

// the trash empties itself after 30 days — what sat in the trash
// longer than 30 days (by ctime: trashing is a rename) is removed.
describe('purgeTrash', () => {
  function setup() {
    const base = mkdtempSync(join(tmpdir(), 'trash-'))
    const trash = join(base, 'trash')
    mkdirSync(join(trash, '-home-x', 'a'), { recursive: true })
    writeFileSync(join(trash, '-home-x', 'a.jsonl'), '{}\n')
    writeFileSync(join(trash, '-home-x', 'a', 'sub.jsonl'), '{}\n')
    mkdirSync(join(trash, '-home-y'), { recursive: true })
    writeFileSync(join(trash, '-home-y', 'b.jsonl'), '{}\n')
    const outside = join(base, 'keep.jsonl')
    writeFileSync(outside, '{}\n')
    return { trash, outside, ctime: lstatSync(join(trash, '-home-x', 'a.jsonl')).ctimeMs }
  }

  it('keeps everything trashed within the window', () => {
    const { trash, ctime } = setup()
    expect(purgeTrash(trash, ctime + TRASH_KEEP_MS - 1000)).toEqual({ removed: 0 })
    expect(existsSync(join(trash, '-home-x', 'a.jsonl'))).toBe(true)
  })

  it('removes transcripts and their sidecar dirs past the window, and the folders left empty — nothing outside the trash', () => {
    const { trash, outside, ctime } = setup()
    expect(purgeTrash(trash, ctime + TRASH_KEEP_MS + 60_000)).toEqual({ removed: 3 })
    expect(existsSync(join(trash, '-home-x'))).toBe(false)
    expect(existsSync(join(trash, '-home-y'))).toBe(false)
    expect(existsSync(trash)).toBe(true)
    expect(existsSync(outside)).toBe(true)
  })

  it('a missing trash dir is a no-op', () => {
    expect(purgeTrash(join(tmpdir(), 'no-such-trash-dir-xyz'))).toEqual({ removed: 0 })
  })
})
