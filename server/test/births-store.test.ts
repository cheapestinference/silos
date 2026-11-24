import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'
import { BirthsStore } from '../src/births-store.js'

// births-store.ts — the server's read of the plugin's birth markers
// (agent-state/<agent>/births/<session>.json, written by the SessionStart
// hook of every session that runs as a Silos agent).
function harness() {
  const base = mkdtempSync(join(tmpdir(), 'births-'))
  const state = new AgentStateStore(base)
  const births = new BirthsStore(state, { ttlMs: 0 })
  const put = (agent: string, id: string, body: unknown): void => {
    mkdirSync(join(base, agent, 'births'), { recursive: true })
    writeFileSync(join(base, agent, 'births', `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return { base, births, put }
}
const birth = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  agentId: 'builder',
  parent: 'p1',
  cwd: '/p/builder',
  source: 'startup',
  at: '2026-10-26T10:00:00Z',
  ...over,
})

describe('BirthsStore', () => {
  it("reads every agent's births and gets one by session id", () => {
    const h = harness()
    h.put('builder', 's1', birth())
    h.put('finance', 's2', birth({ sessionId: 's2', agentId: 'finance', parent: null }))
    expect(h.births.get('s1')).toMatchObject(birth())
    expect(h.births.get('s2')?.parent).toBeNull()
    expect(h.births.get('nope')).toBeNull()
    expect(
      h.births
        .all()
        .map((b) => b.sessionId)
        .sort(),
    ).toEqual(['s1', 's2'])
  })

  it('no agent-state dir, or agents without births: empty, never throws', () => {
    const h = harness()
    expect(h.births.all()).toEqual([])
    mkdirSync(join(h.base, 'builder'), { recursive: true })
    expect(h.births.get('s1')).toBeNull()
  })

  it('sees a marker written after the first read (the dir mtime moved)', () => {
    const h = harness()
    h.put('builder', 's1', birth())
    expect(h.births.get('s9')).toBeNull()
    h.put('builder', 's9', birth({ sessionId: 's9' }))
    expect(h.births.get('s9')?.sessionId).toBe('s9')
  })

  it('tolerates corrupt and malformed files, and ignores temp files', () => {
    const h = harness()
    h.put('builder', 'bad', '{nope')
    h.put('builder', 'shape', { sessionId: 'shape', agentId: 7 })
    h.put('builder', 's1', birth())
    mkdirSync(join(h.base, 'builder', 'births'), { recursive: true })
    writeFileSync(join(h.base, 'builder', 'births', '.s1.abc.tmp'), JSON.stringify(birth({ sessionId: 'tmp' })))
    expect(h.births.all().map((b) => b.sessionId)).toEqual(['s1'])
  })

  it('a marker whose file name and sessionId disagree is ignored', () => {
    const h = harness()
    h.put('builder', 's1', birth({ sessionId: 'other' }))
    expect(h.births.all()).toEqual([])
  })

  // two agents claiming one session — one is lying and
  // nothing says which. Neither is trusted (warned once).
  it("the same session claimed from two agents' dirs: neither marker counts", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness()
    h.put('finance', 's1', birth({ agentId: 'finance' }))
    h.put('builder', 's1', birth({ at: '2020-01-01T00:00:00Z' }))
    h.put('builder', 's2', birth({ sessionId: 's2' }))
    expect(h.births.get('s1')).toBeNull()
    expect(h.births.get('s2')?.agentId).toBe('builder')
    h.put('builder', 's3', birth({ sessionId: 's3' })) // a rescan
    expect(h.births.get('s1')).toBeNull()
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('s1'))).toHaveLength(1)
    warn.mockRestore()
  })

  // security: an agent writes only its OWN state dir, but
  // could name any agent inside the file — a marker counts only for the
  // agent whose directory holds it.
  it('a marker naming another agent than its directory is ignored', () => {
    const h = harness()
    h.put('builder', 's1', birth({ agentId: 'finance' }))
    h.put('builder', 's2', birth({ sessionId: 's2' }))
    expect(h.births.get('s1')).toBeNull()
    expect(h.births.get('s2')?.agentId).toBe('builder')
  })

  it("carries the file's ctime (the time it landed — cannot be backdated)", () => {
    const h = harness()
    const before = Date.now() - 1000
    h.put('builder', 's1', birth({ at: '2001-01-01T00:00:00Z' }))
    expect(h.births.get('s1')!.ctimeMs).toBeGreaterThanOrEqual(before)
  })

  it('caches between scans within the ttl', () => {
    const base = mkdtempSync(join(tmpdir(), 'births-'))
    const births = new BirthsStore(new AgentStateStore(base), { ttlMs: 60_000 })
    expect(births.get('s1')).toBeNull()
    mkdirSync(join(base, 'builder', 'births'), { recursive: true })
    writeFileSync(join(base, 'builder', 'births', 's1.json'), JSON.stringify(birth()))
    expect(births.get('s1')).toBeNull() // within the ttl: the previous scan stands
  })
  it('harness and consoleKey are read when present and well-typed, absent otherwise (Claude markers)', () => {
    const h = harness()
    h.put('writer', 'oc', birth({ sessionId: 'oc', agentId: 'writer', harness: 'opencode', consoleKey: 'k1' }))
    h.put('writer', 'oc2', birth({ sessionId: 'oc2', agentId: 'writer', harness: 'opencode', consoleKey: null }))
    h.put('writer', 'cc', birth({ sessionId: 'cc', agentId: 'writer' }))
    h.put('writer', 'odd', birth({ sessionId: 'odd', agentId: 'writer', harness: 7, consoleKey: 9 }))
    expect(h.births.get('oc')).toMatchObject({ harness: 'opencode', consoleKey: 'k1' })
    expect(h.births.get('oc2')?.consoleKey).toBeNull()
    const cc = h.births.get('cc')!
    expect('harness' in cc).toBe(false)
    expect('consoleKey' in cc).toBe(false)
    const odd = h.births.get('odd')!
    expect(odd.harness).toBeUndefined()
    expect(odd.consoleKey).toBeUndefined()
  })
})
