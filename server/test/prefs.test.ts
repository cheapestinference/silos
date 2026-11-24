import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrefsStore } from '../src/prefs-store.js'

describe('PrefsStore', () => {
  it('read() with no file -> {}', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(store.read()).toEqual({})
    // doesn't seed anything on read (unlike muted.json) — the file only
    // appears on the first patch.
    expect(existsSync(join(dataDir, 'ui.json'))).toBe(false)
  })

  it('read() with a corrupt file -> {}, does not overwrite it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    writeFileSync(join(dataDir, 'ui.json'), '{ this is not JSON')
    const store = new PrefsStore(dataDir)
    expect(store.read()).toEqual({})
    expect(readFileSync(join(dataDir, 'ui.json'), 'utf8')).toBe('{ this is not JSON')
  })

  it('patchProjects applies a field and persists — atomic write (tmp disappears)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    const out = store.patchProjects({ order: ['a', 'b'] })
    expect(out).toEqual({ projects: { order: ['a', 'b'] } })
    expect(store.read()).toEqual({ projects: { order: ['a', 'b'] } })
    expect(existsSync(join(dataDir, 'ui.json') + '.tmp')).toBe(false)
    expect(existsSync(join(dataDir, 'ui.json'))).toBe(true)
  })

  it('patchProjects does a shallow merge: a new field does not erase the others', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    store.patchProjects({ order: ['a', 'b'], pinned: ['a'] })
    const out = store.patchProjects({ collapsed: ['c'] })
    expect(out).toEqual({ projects: { order: ['a', 'b'], pinned: ['a'], collapsed: ['c'] } })
  })

  it('patchProjects replaces (does not merge) the array of a repeated field', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    store.patchProjects({ order: ['a', 'b'] })
    const out = store.patchProjects({ order: ['c'] })
    expect(out.projects?.order).toEqual(['c'])
  })

  it('patchProjects with an invalid shape (not an object) throws', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(() => store.patchProjects(['no', 'object'])).toThrow('projects must be an object')
    expect(() => store.patchProjects(null)).toThrow('projects must be an object')
  })

  it('patchProjects with a field that is not an array of strings throws', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(() => store.patchProjects({ order: [1, 2] })).toThrow('projects.order must be an array of strings')
    expect(() => store.patchProjects({ order: 'no-array' })).toThrow('projects.order must be an array of strings')
  })

  it('patchProjects with an unknown field throws', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(() => store.patchProjects({ zzz: ['x'] })).toThrow('unknown field in projects: zzz')
  })

  it('patchNotifications persists a boolean and read() returns it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    const out = store.patchNotifications(true)
    expect(out).toEqual({ notifications: true })
    expect(store.read()).toEqual({ notifications: true })
  })

  it('patchNotifications with a non-boolean throws', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(() => store.patchNotifications('yes')).toThrow('notifications must be a boolean')
  })

  it('notifications coexists with projects/contextOpen without overwriting them', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    store.patchProjects({ order: ['a'] })
    store.patchContext(false)
    const out = store.patchNotifications(true)
    expect(out).toEqual({ projects: { order: ['a'] }, contextOpen: false, notifications: true })
  })

  it('patchTerminal persists the height and read() returns it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    const out = store.patchTerminal({ height: 260 })
    expect(out).toEqual({ terminal: { height: 260 } })
    expect(store.read()).toEqual({ terminal: { height: 260 } })
  })

  it('patchTerminal with a non-number throws', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(() => store.patchTerminal({ height: 'big' })).toThrow('terminal.height must be a number')
  })

  it('patchTerminal persists the font size and merges it with the height', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    store.patchTerminal({ height: 260 })
    expect(store.patchTerminal({ fontSize: 15 })).toEqual({ terminal: { height: 260, fontSize: 15 } })
  })

  it('patchTerminal rejects a font size that is not an integer in range', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    for (const bad of [9, 25, 13.5, '13']) {
      expect(() => store.patchTerminal({ fontSize: bad })).toThrow('terminal.fontSize must be an integer between 10 and 24')
    }
  })

  it('patchTerminal with an unknown field throws', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(() => store.patchTerminal({ zzz: 1 })).toThrow('unknown field in terminal: zzz')
  })

  it('patchCollapsedAgents persists the array and read() returns it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    const out = store.patchCollapsedAgents(['a1', 'b2'])
    expect(out).toEqual({ collapsedAgents: ['a1', 'b2'] })
    expect(store.read()).toEqual({ collapsedAgents: ['a1', 'b2'] })
  })

  it('patchCollapsedAgents replaces (does not merge) the whole array', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    store.patchCollapsedAgents(['a1', 'b2'])
    const out = store.patchCollapsedAgents(['a1'])
    expect(out.collapsedAgents).toEqual(['a1'])
  })

  it('patchAgentOrder persists the array, replaces it whole, and rejects non-string arrays', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(store.patchAgentOrder(['b2', 'a1'])).toEqual({ agentOrder: ['b2', 'a1'] })
    expect(store.read()).toEqual({ agentOrder: ['b2', 'a1'] })
    expect(store.patchAgentOrder(['a1']).agentOrder).toEqual(['a1'])
    expect(() => store.patchAgentOrder([1])).toThrow('agentOrder must be an array of strings')
  })

  it('patchDetachedChains persists the array whole and rejects non-string arrays', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(store.patchDetachedChains(['f/s2'])).toEqual({ detachedChains: ['f/s2'] })
    expect(store.patchDetachedChains([]).detachedChains).toEqual([])
    expect(() => store.patchDetachedChains('x')).toThrow('detachedChains must be an array of strings')
  })

  it('patchCollapsedAgents with something that is not an array of strings throws', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(() => store.patchCollapsedAgents('no-array')).toThrow('collapsedAgents must be an array of strings')
    expect(() => store.patchCollapsedAgents([1, 2])).toThrow('collapsedAgents must be an array of strings')
  })

  it('collapsedAgents coexists with projects/contextOpen/terminal without overwriting them', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    store.patchProjects({ order: ['a'] })
    store.patchContext(false)
    const out = store.patchCollapsedAgents(['a1'])
    expect(out).toEqual({ projects: { order: ['a'] }, contextOpen: false, collapsedAgents: ['a1'] })
  })

  it('patchSetup persists a boolean and read() returns it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    const out = store.patchSetup(true)
    expect(out).toEqual({ setup: true })
    expect(store.read()).toEqual({ setup: true })
  })

  it('patchSetup with a non-boolean throws', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(() => store.patchSetup('yes')).toThrow('setup must be a boolean')
  })

  it('setup coexists with projects/contextOpen without overwriting them', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    store.patchProjects({ order: ['a'] })
    store.patchContext(false)
    const out = store.patchSetup(true)
    expect(out).toEqual({ projects: { order: ['a'] }, contextOpen: false, setup: true })
  })

  it('uses: patch keeps only known axes and windows, reads back, rejects a non-object', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(store.patchUses({ rows: 'project', cols: 'file', since: '7' }).uses).toEqual({ rows: 'project', cols: 'file', since: '7' })
    expect(store.read().uses).toEqual({ rows: 'project', cols: 'file', since: '7' })
    expect(store.patchUses({ rows: 'nope', cols: 'mcp', since: 'yesterday' }).uses).toEqual({ cols: 'mcp' })
    expect(store.patchUses({ since: 'all' }).uses).toEqual({ since: 'all' })
    expect(() => store.patchUses('agent')).toThrow()
  })
})

describe('console colours per engine (consoleTheme)', () => {
  it('patchConsoleTheme merges per engine and refuses an unknown engine, one without the setting, or a bad value', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const store = new PrefsStore(dataDir)
    expect(store.patchConsoleTheme({ opencode: 'own' })).toEqual({ consoleTheme: { opencode: 'own' } })
    expect(store.patchConsoleTheme({ opencode: 'silos' })).toEqual({ consoleTheme: { opencode: 'silos' } })
    expect(() => store.patchConsoleTheme({ 'claude-code': 'own' })).toThrow('consoleTheme: Claude Code has no console colours setting')
    expect(() => store.patchConsoleTheme({ 'not-an-engine': 'own' })).toThrow("consoleTheme: unknown engine 'not-an-engine'")
    expect(() => store.patchConsoleTheme({ opencode: 'neon' })).toThrow("consoleTheme.opencode must be 'silos' or 'own'")
    expect(() => store.patchConsoleTheme('own')).toThrow('consoleTheme must be an object')
  })
})

// ui.json read corrupt → {} stays (the long-standing contract), but the raw
// text is backed up ONCE first (read() runs per request — a flag keeps
// repeated reads from piling up copies), so the next patch never destroys
// the only copy of the owner's prefs.
describe('corrupt ui.json', () => {
  it('backs up to .corrupt-* exactly once across repeated reads', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    writeFileSync(join(dataDir, 'ui.json'), '{this is not json')
    const store = new PrefsStore(dataDir)
    expect(store.read()).toEqual({})
    expect(store.read()).toEqual({})
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('ui.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dataDir, backups[0]!), 'utf8')).toBe('{this is not json')
  })
})
