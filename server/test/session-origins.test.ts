// session-origins.test.ts — WHO gave birth to a session: recorded once,
// durable, backfilled from `thread: new` run history only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionOriginsStore, messageGist } from '../src/session-origins'
import { AutomationsStore } from '../src/automations-store'
import type { Automation } from '../src/automations-types'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'silos-origins-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

const origin = (automationId: string, runId: string) => ({ kind: 'automation' as const, automationId, runId, at: '2026-08-29T10:00:00.000Z' })
const auto = (id: string, mode: 'new' | 'keep'): Automation => ({
  id,
  name: id,
  agentId: 'finance',
  prompt: 'x',
  trigger: { kind: 'cron', expr: '* * * * *' },
  thread: { mode },
  approval: false,
  keepAlive: false,
  paused: false,
  createdAt: '2026-08-01T00:00:00.000Z',
})

describe('SessionOriginsStore', () => {
  it('records a birth, survives a reload, and the first record wins', () => {
    const s = new SessionOriginsStore(dataDir)
    expect(s.record('f/s1', origin('a1', 'r1'))).toBe(true)
    expect(s.record('f/s1', origin('a1', 'r2'))).toBe(false) // a keep thread's run #2
    expect(s.get('f/s1')).toMatchObject({ automationId: 'a1', runId: 'r1' })
    const again = new SessionOriginsStore(dataDir)
    again.load()
    expect(again.get('f/s1')).toMatchObject({ automationId: 'a1', runId: 'r1' })
    expect(again.get('f/nobody')).toBeNull()
  })

  it('a corrupt file is backed up, never fatal', () => {
    writeFileSync(join(dataDir, 'session-origins.json'), '{not json')
    const s = new SessionOriginsStore(dataDir)
    s.load()
    expect(s.get('f/s1')).toBeNull()
    expect(readdirSync(dataDir).some((f) => f.startsWith('session-origins') && f !== 'session-origins.json')).toBe(true)
  })

  it('invalid entries are discarded on load, valid ones kept', () => {
    writeFileSync(join(dataDir, 'session-origins.json'), JSON.stringify({ origins: { 'f/ok': origin('a1', 'r1'), 'f/bad': { kind: 'human' } } }))
    const s = new SessionOriginsStore(dataDir)
    s.load()
    expect(s.get('f/ok')).not.toBeNull()
    expect(s.get('f/bad')).toBeNull()
  })

  it('backfill adopts the run history of `thread: new` automations (oldest run = the birth), never keep threads', () => {
    const store = new AutomationsStore(dataDir)
    store.load()
    store.create(auto('nu', 'new'))
    store.create(auto('kp', 'keep'))
    store.appendRun('nu', { id: 'r-old', automationId: 'nu', at: '2026-08-20T00:00:00.000Z', status: 'ok', sessionKey: 'f/born1' })
    store.appendRun('nu', { id: 'r-new', automationId: 'nu', at: '2026-08-21T00:00:00.000Z', status: 'ok', sessionKey: 'f/born2' })
    store.appendRun('nu', { id: 'r-skip', automationId: 'nu', at: '2026-08-22T00:00:00.000Z', status: 'skipped', reason: 'x' })
    store.appendRun('kp', { id: 'r-keep', automationId: 'kp', at: '2026-08-21T00:00:00.000Z', status: 'ok', sessionKey: 'f/owners-chat' })
    const s = new SessionOriginsStore(dataDir)
    s.load()
    expect(s.backfill(store)).toBe(2)
    expect(s.get('f/born1')).toMatchObject({ automationId: 'nu', runId: 'r-old' })
    expect(s.get('f/born2')).toMatchObject({ automationId: 'nu', runId: 'r-new' })
    expect(s.get('f/owners-chat')).toBeNull()
    // idempotent: a second start adopts nothing new
    expect(s.backfill(store)).toBe(0)
    expect(existsSync(join(dataDir, 'session-origins.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'session-origins.json'), 'utf8')).origins['f/born1'].runId).toBe('r-old')
  })

  it('records a message birth (first wins), reads it back after a restart; automation() only answers runs', () => {
    const s = new SessionOriginsStore(dataDir)
    s.load()
    const born = { kind: 'message' as const, agentId: 'finance', messageId: 'm1', from: 'builder', gist: 'Close Q3', at: '2026-11-02T10:00:00.000Z' }
    expect(s.record('f/msg', born)).toBe(true)
    expect(s.record('f/msg', { ...born, messageId: 'm2' })).toBe(false)
    const again = new SessionOriginsStore(dataDir)
    again.load()
    expect(again.get('f/msg')).toEqual(born)
    expect(again.automation('f/msg')).toBeNull()
  })

  it('messageGist: the first non-empty line, cut at 120', () => {
    expect(messageGist('\n  Close the books  \nmore')).toBe('Close the books')
    expect(messageGist('x'.repeat(200))).toHaveLength(120)
  })
})
