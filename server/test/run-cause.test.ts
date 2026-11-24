import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationsStore } from '../src/automations-store.js'
import { runCauseFor, runCauseIndex } from '../src/run-cause.js'
import type { Automation, Run } from '../src/automations-types.js'

const auto = (id: string, thread: Automation['thread']): Automation => ({
  id,
  name: id,
  agentId: 'finance',
  prompt: 'p',
  trigger: { kind: 'cron', expr: '0 0 * * *' },
  thread,
  approval: false,
  keepAlive: false,
  paused: false,
  createdAt: '2026-10-23T00:00:00Z',
})
const run = (automationId: string, over: Partial<Run> = {}): Run => ({
  id: 'r1',
  automationId,
  at: '2026-10-23T09:00:00Z',
  status: 'running',
  cause: 'message:m1:builder',
  ...over,
})

function src(list: Automation[], runs: Record<string, Run>) {
  return { list: () => list, openRuns: (id: string) => (runs[id] ? [runs[id]] : []) }
}

describe('runCauseFor — the cause of the run working in a conversation right now', () => {
  it('a keep thread whose automation is running a caused run → that cause', () => {
    expect(runCauseFor('s1', null, src([auto('a', { mode: 'keep', sessionId: 's1' })], { a: run('a') }))).toBe('message:m1:builder')
  })
  it('the first run of a new thread: matched by its birth record (automation + run id)', () => {
    expect(runCauseFor('s9', { automationId: 'a', runId: 'r1' }, src([auto('a', { mode: 'keep' })], { a: run('a') }))).toBe('message:m1:builder')
    expect(runCauseFor('s9', { automationId: 'a', runId: 'older' }, src([auto('a', { mode: 'new' })], { a: run('a') }))).toBeNull()
  })
  it('a finished run, a run without cause, or another session → null', () => {
    const a = auto('a', { mode: 'keep', sessionId: 's1' })
    expect(runCauseFor('s1', null, src([a], { a: run('a', { status: 'ok' }) }))).toBeNull()
    expect(runCauseFor('s1', null, src([a], { a: run('a', { cause: undefined }) }))).toBeNull()
    expect(runCauseFor('s2', null, src([a], { a: run('a') }))).toBeNull()
  })
})

// The overview builds ONE index per request (runCauseIndex) instead of
// scanning every automation per session. Its answers must be exactly
// runCauseFor's — including which automation wins when two match.
describe('runCauseIndex — built once, same answers as runCauseFor', () => {
  const autos = [
    auto('a', { mode: 'keep', sessionId: 's1' }),
    auto('b', { mode: 'keep', sessionId: 's1' }), // a later keep thread on the same session: a wins
    auto('c', { mode: 'keep', sessionId: 's2' }),
    auto('d', { mode: 'new' }),
    auto('e', { mode: 'keep', sessionId: 's3' }), // not running
    auto('f', { mode: 'keep', sessionId: 's4' }), // running, no cause
    auto('g', { mode: 'keep', sessionId: 's5' }), // listed after d — d's birth match wins on s5
  ]
  const runs: Record<string, Run> = {
    a: run('a', { id: 'ra', cause: 'cause-a' }),
    b: run('b', { id: 'rb', cause: 'cause-b' }),
    c: run('c', { id: 'rc', cause: 'cause-c' }),
    d: run('d', { id: 'rd', cause: 'cause-d' }),
    e: run('e', { id: 're', cause: 'cause-e', status: 'ok' }),
    f: run('f', { id: 'rf', cause: undefined }),
    g: run('g', { id: 'rg', cause: 'cause-g' }),
  }
  const sessions = ['s1', 's2', 's3', 's4', 's5', 's6']
  const borns: ({ automationId: string; runId: string } | null)[] = [
    null,
    { automationId: 'a', runId: 'ra' },
    { automationId: 'b', runId: 'rb' },
    { automationId: 'd', runId: 'rd' },
    { automationId: 'd', runId: 'old' },
    { automationId: 'e', runId: 're' },
    { automationId: 'f', runId: 'rf' },
    { automationId: 'g', runId: 'rg' },
    { automationId: 'zz', runId: 'ra' },
  ]

  it('every (session, birth) pair answers as runCauseFor does', () => {
    const lookup = runCauseIndex(src(autos, runs))
    const table: string[] = []
    for (const sid of sessions) {
      for (const born of borns) {
        const expected = runCauseFor(sid, born, src(autos, runs))
        expect(lookup(sid, born)).toBe(expected)
        table.push(`${sid} ${born ? `${born.automationId}/${born.runId}` : '-'} → ${expected}`)
      }
    }
    // pinned: the answers themselves, so a change to both functions shows
    expect(table.filter((l) => !l.endsWith('null'))).toEqual([
      's1 - → cause-a',
      's1 a/ra → cause-a',
      's1 b/rb → cause-a',
      's1 d/rd → cause-a',
      's1 d/old → cause-a',
      's1 e/re → cause-a',
      's1 f/rf → cause-a',
      's1 g/rg → cause-a',
      's1 zz/ra → cause-a',
      's2 - → cause-c',
      's2 a/ra → cause-a',
      's2 b/rb → cause-b',
      's2 d/rd → cause-c',
      's2 d/old → cause-c',
      's2 e/re → cause-c',
      's2 f/rf → cause-c',
      's2 g/rg → cause-c',
      's2 zz/ra → cause-c',
      's3 a/ra → cause-a',
      's3 b/rb → cause-b',
      's3 d/rd → cause-d',
      's3 g/rg → cause-g',
      's4 a/ra → cause-a',
      's4 b/rb → cause-b',
      's4 d/rd → cause-d',
      's4 g/rg → cause-g',
      's5 - → cause-g',
      's5 a/ra → cause-a',
      's5 b/rb → cause-b',
      's5 d/rd → cause-d',
      's5 d/old → cause-g',
      's5 e/re → cause-g',
      's5 f/rf → cause-g',
      's5 g/rg → cause-g',
      's5 zz/ra → cause-g',
      's6 a/ra → cause-a',
      's6 b/rb → cause-b',
      's6 d/rd → cause-d',
      's6 g/rg → cause-g',
    ])
  })

  it('reads the automations once, however many sessions it answers', () => {
    let lists = 0,
      latest = 0
    const counting = {
      list: () => {
        lists++
        return autos
      },
      openRuns: (id: string) => {
        latest++
        return runs[id] ? [runs[id]] : []
      },
    }
    const lookup = runCauseIndex(counting)
    for (let i = 0; i < 100; i++) lookup(`s${i}`, null)
    expect(lists).toBe(1)
    expect(latest).toBe(autos.length)
  })
})

// A run in flight is found by its id among the open runs — a row written
// after it (a heartbeat's skip at its next slot) changes nothing.
describe('over the real store: a skip row after a running run', () => {
  it('the running run still says its cause — and the newest run stays the skip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'silos-rc-'))
    try {
      const store = new AutomationsStore(dir)
      store.load()
      store.create(auto('a', { mode: 'new' }))
      store.appendRun('a', run('a', { id: 'r1', cause: 'message:m1:builder' }))
      store.appendRun('a', { id: 'r2', automationId: 'a', at: '2026-10-23T10:00:00Z', status: 'skipped', reason: 'busy' })
      expect(runCauseFor('s9', { automationId: 'a', runId: 'r1' }, store)).toBe('message:m1:builder')
      expect(runCauseIndex(store)('s9', { automationId: 'a', runId: 'r1' })).toBe('message:m1:builder')
      // its terminal row: a re-write of an older run, never «the latest»
      store.appendRun('a', run('a', { id: 'r1', status: 'ok' }))
      expect(store.latestRun('a')!.id).toBe('r2')
      expect(new AutomationsStore(dir).latestRun('a')!.id).toBe('r2')
      expect(store.runById('a', 'r1')!.status).toBe('ok')
      expect(store.openRuns('a')).toEqual([])
      expect(runCauseFor('s9', { automationId: 'a', runId: 'r1' }, store)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
