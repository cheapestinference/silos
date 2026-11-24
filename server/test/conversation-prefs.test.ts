import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationPrefsStore } from '../src/conversation-prefs.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-convprefs-'))
})
afterEach(() => {
  vi.restoreAllMocks()
})

function store(): ConversationPrefsStore {
  const s = new ConversationPrefsStore(dir)
  s.load()
  return s
}

describe('ConversationPrefsStore', () => {
  it('with no file: get returns an honest null', () => {
    expect(store().get('-proj', 's1')).toBeNull()
  })

  it('patch writes atomically (no leftover .tmp) and persists across loads', () => {
    const s = store()
    s.patch('-proj', 's1', { model: 'sonnet', permissionMode: 'plan' })
    expect(existsSync(join(dir, 'conversation-prefs.json'))).toBe(true)
    expect(existsSync(join(dir, 'conversation-prefs.json.tmp'))).toBe(false)
    const s2 = store()
    expect(s2.get('-proj', 's1')).toEqual({ model: 'sonnet', permissionMode: 'plan' })
  })

  it('field-by-field merge: present overwrites, absent is kept, null deletes', () => {
    const s = store()
    s.patch('-proj', 's1', { model: 'sonnet', effort: 'low' })
    s.patch('-proj', 's1', { effort: 'max' })
    expect(s.get('-proj', 's1')).toEqual({ model: 'sonnet', effort: 'max' })
    s.patch('-proj', 's1', { model: null })
    expect(s.get('-proj', 's1')).toEqual({ effort: 'max' })
  })

  it('an entry that ends up empty disappears from the file', () => {
    const s = store()
    s.patch('-proj', 's1', { fastMode: true })
    s.patch('-proj', 's1', { fastMode: null })
    expect(s.get('-proj', 's1')).toBeNull()
    const raw = JSON.parse(readFileSync(join(dir, 'conversation-prefs.json'), 'utf8'))
    expect(raw.prefs).toEqual({})
  })

  it('corrupt JSON: backs up to .corrupt-* BEFORE starting fresh, never silently overwrites the original', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = join(dir, 'conversation-prefs.json')
    writeFileSync(file, '{not json')
    const s = store()
    expect(s.get('-proj', 's1')).toBeNull()
    const backups = readdirSync(dir).filter((f) => f.startsWith('conversation-prefs.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{not json')
  })

  it('a malformed entry (hand-edited) is discarded with a warning, the rest survives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(
      join(dir, 'conversation-prefs.json'),
      JSON.stringify({ prefs: { '-proj/bad': { permissionMode: 'dontAsk' }, '-proj/good': { model: 'haiku' } } }),
    )
    const s = store()
    expect(s.get('-proj', 'bad')).toBeNull()
    expect(s.get('-proj', 'good')).toEqual({ model: 'haiku' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('-proj/bad'))
  })

  // pruning runs on a SLOW sweep (the resident's tick), not on PATCH — and
  // recently-written keys get a grace window: a session that just started
  // (chat-init) isn't in the index yet (watcher latency), and its key is
  // indistinguishable from a ghost one without that grace period.
  describe('sweepOrphans', () => {
    it('sweeps old orphaned keys (loaded from disk, no grace), keeps live ones', () => {
      const s = store()
      s.patch('-proj', 'alive', { model: 'sonnet' })
      s.patch('-proj', 'trashed', { model: 'haiku' })
      // reload from disk: no "just written" marker -> already prunable
      const s2 = store()
      s2.sweepOrphans(new Set(['-proj/alive']))
      expect(s2.get('-proj', 'alive')).toEqual({ model: 'sonnet' })
      expect(s2.get('-proj', 'trashed')).toBeNull()
      const raw = JSON.parse(readFileSync(join(dir, 'conversation-prefs.json'), 'utf8'))
      expect(Object.keys(raw.prefs)).toEqual(['-proj/alive'])
    })

    it('a freshly-written key survives a sweep even if not yet in the index (grace); past the grace period it gets pruned', () => {
      let clock = 1_000_000
      const s = new ConversationPrefsStore(dir, () => clock)
      s.load()
      s.patch('-proj', 'new', { permissionMode: 'plan' })
      s.sweepOrphans(new Set()) // the index hasn't seen it yet — still within the grace period
      expect(s.get('-proj', 'new')).toEqual({ permissionMode: 'plan' })
      clock += 11 * 60_000 // past the window (10 min) and still not indexed: a real ghost
      s.sweepOrphans(new Set())
      expect(s.get('-proj', 'new')).toBeNull()
    })
  })

  // the grace marker for an entry that gets EMPTIED (field by field, with
  // null) must be cleared along with it — otherwise `touched` grows without
  // bound in a long-lived process.
  it('emptying an entry also clears its grace marker — no leak in touched', () => {
    const s = store()
    const internal = s as unknown as { touched: Map<string, number> }
    s.patch('-proj', 's1', { model: 'x' })
    s.patch('-proj', 's1', { model: null }) // entry becomes empty -> falls out of prefs
    expect(s.get('-proj', 's1')).toBeNull()
    expect(internal.touched.has('-proj/s1')).toBe(false)
    // a live key keeps its marker (the grace period still works)
    s.patch('-proj', 's2', { model: 'y' })
    expect(internal.touched.has('-proj/s2')).toBe(true)
  })

  // real inheritance on a fork — the source's prefs are copied to the new
  // key (and the copy counts as freshly-written: the sweep must not eat it
  // before the watcher indexes the new session).
  describe('copy', () => {
    it('copies the source prefs to the new key; a source with no prefs is a clean no-op', () => {
      const s = store()
      s.patch('-proj', 'origin', { permissionMode: 'plan', effort: 'max' })
      s.copy('-proj', 'origin', '-proj', 'branch')
      expect(s.get('-proj', 'branch')).toEqual({ permissionMode: 'plan', effort: 'max' })
      // the source stays intact and the two entries are independent
      s.patch('-proj', 'branch', { effort: null })
      expect(s.get('-proj', 'origin')).toEqual({ permissionMode: 'plan', effort: 'max' })

      s.copy('-proj', 'no-prefs', '-proj', 'branch2')
      expect(s.get('-proj', 'branch2')).toBeNull()
    })

    it('the copied key has grace protection against the sweep', () => {
      const clock = 1_000_000
      const s = new ConversationPrefsStore(dir, () => clock)
      s.load()
      s.patch('-proj', 'origin', { permissionMode: 'plan' })
      s.copy('-proj', 'origin', '-proj', 'branch')
      s.sweepOrphans(new Set(['-proj/origin']))
      expect(s.get('-proj', 'branch')).toEqual({ permissionMode: 'plan' })
    })
  })
})
