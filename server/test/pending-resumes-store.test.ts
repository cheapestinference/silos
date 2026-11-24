import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PendingResumesStore, type PendingResume } from '../src/pending-resumes-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-pending-'))
})
afterEach(() => {
  vi.restoreAllMocks()
})

function store(): PendingResumesStore {
  const s = new PendingResumesStore(dir)
  s.load()
  return s
}

function rec(overrides: Partial<PendingResume> = {}): PendingResume {
  return {
    agentId: 'finance',
    folder: '-proj',
    sessionId: 's1',
    text: 'carry on with the task',
    resetsAt: '2026-08-21T16:00:00.000Z',
    resumeAt: '2026-08-21T16:00:00.000Z',
    createdAt: '2026-08-21T12:00:00.000Z',
    attempts: 0,
    ...overrides,
  }
}

describe('PendingResumesStore', () => {
  it('with no file: get returns an honest null and list is empty', () => {
    const s = store()
    expect(s.get('-proj', 's1')).toBeNull()
    expect(s.list()).toEqual([])
  })

  it('upsert writes atomically (no leftover .tmp) and persists across loads', () => {
    const s = store()
    s.upsert(rec())
    expect(existsSync(join(dir, 'pending-resumes.json'))).toBe(true)
    expect(existsSync(join(dir, 'pending-resumes.json.tmp'))).toBe(false)
    const s2 = store()
    expect(s2.get('-proj', 's1')).toEqual(rec())
  })

  it('ONE record per folder/sessionId — a new one REPLACES the previous one', () => {
    const s = store()
    s.upsert(rec({ text: 'old', attempts: 0 }))
    s.upsert(rec({ text: 'new', attempts: 2 }))
    expect(s.list()).toHaveLength(1)
    expect(s.get('-proj', 's1')?.text).toBe('new')
    expect(s.get('-proj', 's1')?.attempts).toBe(2)
  })

  it('records for different sessions coexist', () => {
    const s = store()
    s.upsert(rec({ sessionId: 's1' }))
    s.upsert(rec({ sessionId: 's2' }))
    expect(s.list()).toHaveLength(2)
  })

  it('remove returns true if it deleted something, false if there was nothing', () => {
    const s = store()
    s.upsert(rec())
    expect(s.remove('-proj', 's1')).toBe(true)
    expect(s.get('-proj', 's1')).toBeNull()
    expect(s.remove('-proj', 's1')).toBe(false)
    // persisted: a reload does not resurrect it
    expect(store().get('-proj', 's1')).toBeNull()
  })

  it('corrupt JSON: backs up to .corrupt-* BEFORE starting fresh, never silently overwrites the original', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = join(dir, 'pending-resumes.json')
    writeFileSync(file, '{not json')
    const s = store()
    expect(s.list()).toEqual([])
    const backups = readdirSync(dir).filter((f) => f.startsWith('pending-resumes.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{not json')
  })

  it('a malformed entry (hand-edited) is discarded with a warning, the rest survives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(
      join(dir, 'pending-resumes.json'),
      JSON.stringify({
        pending: {
          '-proj/bad': { agentId: 'finance', folder: '-proj', sessionId: 'bad' }, // no text/resetsAt/etc.
          '-proj/good': rec({ sessionId: 'good' }),
        },
      }),
    )
    const s = store()
    expect(s.get('-proj', 'bad')).toBeNull()
    expect(s.get('-proj', 'good')).toEqual(rec({ sessionId: 'good' }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('-proj/bad'))
  })

  it('preserves the optional fields (cwd, fallbackProviderId, turnCount, mtime)', () => {
    const s = store()
    const full = rec({ cwd: '/home/u/proj', fallbackProviderId: 'prov_ci', turnCount: 7, mtime: 123456 })
    s.upsert(full)
    expect(store().get('-proj', 's1')).toEqual(full)
  })

  it('sweepOrphans drops records whose session is gone, keeps the known ones', () => {
    const s = store()
    s.upsert(rec({ sessionId: 'alive' }))
    s.upsert(rec({ sessionId: 'trashed' }))
    // only 'alive' is still a known session (a warm-index set)
    s.sweepOrphans(new Set(['-proj/alive']))
    expect(s.get('-proj', 'alive')).not.toBeNull()
    expect(s.get('-proj', 'trashed')).toBeNull() // the gone session's resume is dropped
    // persisted
    expect(store().get('-proj', 'trashed')).toBeNull()
  })
})
