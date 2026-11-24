import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationsStore, countsAgainstBudget } from '../src/automations-store.js'
import type { Automation, Run } from '../src/automations-types.js'

let dataDir: string
let store: AutomationsStore

function mkAutomation(id: string): Automation {
  return {
    id,
    name: 'Routine ' + id,
    agentId: 'finance',
    prompt: 'do X',
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: new Date().toISOString(),
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'deck-auto-'))
  store = new AutomationsStore(dataDir)
  store.load()
})

describe('AutomationsStore — atomic persistence of automations.json', () => {
  it('load() on an empty dataDir -> an empty list, no crash', () => {
    expect(store.list()).toEqual([])
  })

  it('create/list/get/update/delete round-trip', () => {
    const a = store.create(mkAutomation('routine-1'))
    expect(store.list()).toHaveLength(1)
    expect(store.get('routine-1')).toEqual(a)
    const updated = store.update('routine-1', { paused: true })
    expect(updated.paused).toBe(true)
    expect(store.get('routine-1')?.paused).toBe(true)
    store.delete('routine-1')
    expect(store.list()).toEqual([])
  })

  // update() used to mutate the SAME object IN PLACE (Object.assign) that
  // get() had already handed back to another caller — a caller holding
  // that reference for a while (the resident, up to 30 min per run) would
  // see its fields "shift" underneath it from any concurrent, unrelated
  // PATCH. The immutable merge freezes any reference already captured;
  // the store always exposes the latest state.
  it('update() never mutates an old reference captured by another caller — immutable merge', () => {
    store.create(mkAutomation('m8'))
    const captured = store.get('m8')! // e.g. what the resident would hold onto during a run
    store.update('m8', { paused: true })
    expect(captured.paused).toBe(false) // the old snapshot does not change
    expect(store.get('m8')?.paused).toBe(true) // the store does reflect the change

    // a second patch, on another field, must compose with the CURRENT
    // state (not lose the paused:true above) — last-writer-wins PER FIELD,
    // never per whole object.
    store.update('m8', { name: 'new name' })
    expect(store.get('m8')).toMatchObject({ paused: true, name: 'new name' })
  })

  it('create with a duplicate id throws', () => {
    store.create(mkAutomation('dup'))
    expect(() => store.create(mkAutomation('dup'))).toThrow()
  })

  it('update of a nonexistent automation throws', () => {
    expect(() => store.update('nope', { paused: true })).toThrow()
  })

  it('delete of a nonexistent automation throws', () => {
    expect(() => store.delete('nope')).toThrow()
  })

  it('persists to disk and a second Store on the same dataDir recovers it', () => {
    store.create(mkAutomation('r1'))
    store.create(mkAutomation('r2'))
    const store2 = new AutomationsStore(dataDir)
    store2.load()
    expect(
      store2
        .list()
        .map((a) => a.id)
        .sort(),
    ).toEqual(['r1', 'r2'])
  })

  // The shape validator only demands the REQUIRED fields — an automation
  // carrying the optional autonomy ones must survive a reload untouched
  // (otherwise a restart would silently drop a beat's wiring).
  it('keeps the optional autonomy fields across a reload', () => {
    store.create({ ...mkAutomation('auto-resp-finance'), projectSettings: true, autoPaused: true, origin: 'agent', maxRunsPerDay: 25 })
    const store2 = new AutomationsStore(dataDir)
    store2.load()
    expect(store2.get('auto-resp-finance')).toMatchObject({ projectSettings: true, autoPaused: true, origin: 'agent', maxRunsPerDay: 25 })
  })

  it('a persisted cron with a tz the validator now rejects still loads (it is not dropped from the file)', () => {
    store.create({ ...mkAutomation('tz-ok'), trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' } })
    store.create({ ...mkAutomation('tz-bad'), trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Phobos' } })
    const store2 = new AutomationsStore(dataDir)
    store2.load()
    expect(store2.get('tz-ok')?.trigger).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' })
    expect(store2.get('tz-bad')?.trigger).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Phobos' })
  })

  it('a corrupt automations.json -> load() does not crash, starts empty, and backs up the original BEFORE losing it', () => {
    store.create(mkAutomation('r1'))
    const file = join(dataDir, 'automations.json')
    const corruptText = '{ this is not json'
    writeFileSync(file, corruptText)
    const store2 = new AutomationsStore(dataDir)
    expect(() => store2.load()).not.toThrow()
    expect(store2.list()).toEqual([])

    // before this fix, the corrupt original (recoverable by hand) was lost
    // without a trace as soon as the next normal write rewrote the whole
    // file with automations:[].
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('automations.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dataDir, backups[0] as string), 'utf8')).toBe(corruptText)

    // the next normal write (creating a new automation) can no longer
    // overwrite the backup — it stays on disk.
    store2.create(mkAutomation('r2'))
    expect(existsSync(join(dataDir, backups[0] as string))).toBe(true)
  })

  it('an invalidly-shaped entry in automations.json is discarded with a warning, without crashing load() or losing the other valid entries', () => {
    const file = join(dataDir, 'automations.json')
    const good = mkAutomation('good')
    // an invalid shape: no trigger/thread/notify/approval/keepAlive/paused —
    // exactly the kind of entry that used to survive load() and then crash
    // tick() with a synchronous TypeError (a.trigger.kind on a nonexistent trigger).
    const bad = { id: 'bad', name: 'no trigger or thread' }
    writeFileSync(file, JSON.stringify({ automations: [good, bad] }))
    const store2 = new AutomationsStore(dataDir)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => store2.load()).not.toThrow()
    expect(store2.list().map((a) => a.id)).toEqual(['good'])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('save() writes atomically: never leaves the file half-written (uses tmp+rename)', () => {
    store.create(mkAutomation('r1'))
    const file = join(dataDir, 'automations.json')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(file + '.tmp')).toBe(false)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.automations).toHaveLength(1)
  })
})

describe('AutomationsStore — append-only runs', () => {
  const mkRun = (id: string, automationId: string, status: Run['status']): Run => ({
    id,
    automationId,
    at: new Date().toISOString(),
    status,
  })

  it('appendRun + listRuns: folds down to the LATEST snapshot per id', () => {
    store.appendRun('r1', mkRun('run-a', 'r1', 'queued'))
    store.appendRun('r1', mkRun('run-a', 'r1', 'running'))
    store.appendRun('r1', mkRun('run-a', 'r1', 'ok'))
    const runs = store.listRuns('r1')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('ok')
  })

  it('several runs: the most recent one (by creation order) first', () => {
    store.appendRun('r1', mkRun('run-1', 'r1', 'ok'))
    store.appendRun('r1', mkRun('run-2', 'r1', 'ok'))
    store.appendRun('r1', mkRun('run-3', 'r1', 'running'))
    const runs = store.listRuns('r1')
    expect(runs.map((r) => r.id)).toEqual(['run-3', 'run-2', 'run-1'])
  })

  it('listRuns for an automation with no runs.jsonl -> []', () => {
    expect(store.listRuns('never-ran')).toEqual([])
  })

  it('the file is genuinely append-only (jsonl with multiple lines)', () => {
    store.appendRun('r1', mkRun('run-a', 'r1', 'queued'))
    store.appendRun('r1', mkRun('run-a', 'r1', 'ok'))
    const raw = readFileSync(store.runsPath('r1'), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('findRun locates a run by id across every automation', () => {
    store.appendRun('r1', mkRun('run-x', 'r1', 'waiting_approval'))
    store.appendRun('r2', mkRun('run-y', 'r2', 'ok'))
    expect(store.findRun('run-x')?.automationId).toBe('r1')
    expect(store.findRun('run-y')?.automationId).toBe('r2')
    expect(store.findRun('nope')).toBeNull()
  })

  it('pendingApprovals gathers the waiting_approval runs across every automation', () => {
    store.appendRun('r1', mkRun('run-a', 'r1', 'waiting_approval'))
    store.appendRun('r2', mkRun('run-b', 'r2', 'ok'))
    store.appendRun('r2', mkRun('run-c', 'r2', 'waiting_approval'))
    const pending = store.pendingApprovals()
    expect(pending.map((r) => r.id).sort()).toEqual(['run-a', 'run-c'])
  })

  // hasRunWithSessionKey was retired: the anti-loop guard in resident.ts
  // that used it was rewritten around an in-memory set of live turnIds
  // (see resident.test.ts) — the method no longer had any caller in production.

  it('latestRun reflects the last snapshot without re-reading the whole file, and warms up on its own after a restart', () => {
    store.appendRun('r1', mkRun('run-a', 'r1', 'queued'))
    store.appendRun('r1', mkRun('run-a', 'r1', 'running'))
    expect(store.latestRun('r1')?.status).toBe('running')
    store.appendRun('r1', mkRun('run-a', 'r1', 'ok'))
    expect(store.latestRun('r1')?.status).toBe('ok')
    expect(store.latestRun('never-ran')).toBeNull()

    // "restart": a NEW instance on the same dataDir has nothing cached —
    // latestRun must warm up by reading the file (same result as listRuns).
    const store2 = new AutomationsStore(dataDir)
    store2.load()
    expect(store2.latestRun('r1')).toEqual(store.listRuns('r1')[0])
  })

  it('runsToday excludes runs from other days and skipped ones', () => {
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString()
    store.appendRun('r1', { id: 'run-yesterday', automationId: 'r1', at: yesterday, status: 'ok' })
    store.appendRun('r1', mkRun('run-today', 'r1', 'ok'))
    store.appendRun('r1', mkRun('run-today-skip', 'r1', 'skipped'))
    const today = store.runsToday('r1', new Date())
    expect(today.map((r) => r.id)).toEqual(['run-today'])
  })

  it('countsAgainstBudget: only runs where the model worked (or is about to) spend the daily budget', () => {
    const r = (status: Run['status'], extra: Partial<Run> = {}): Run => ({ id: 'x', automationId: 'r1', at: new Date().toISOString(), status, ...extra })
    const table: Array<[Run, boolean]> = [
      [r('ok'), true],
      [r('ok', { produced: true }), true],
      [r('running'), true],
      [r('queued'), true],
      [r('waiting_approval'), true],
      [r('skipped'), false],
      [r('failed', { produced: false, error: 'Claude Code returned an error result: API Error: 400' }), false],
      [r('failed', { produced: false, error: "You've reached your Fable limit." }), false],
      [r('waiting_reset', { produced: false }), false],
      [r('failed', { produced: true, error: 'Claude Code process exited with code 1' }), true],
      [r('waiting_reset', { produced: true }), true],
      [r('failed', { produced: true, error: 'timeout' }), true],
      [r('failed', { produced: false, error: 'timeout' }), false],
      // records written before `produced` existed
      [r('failed', { error: 'Claude Code returned an error result: API Error: 400' }), false],
      [r('failed', { error: 'timeout' }), true],
      [r('waiting_reset'), false],
    ]
    for (const [run, counts] of table)
      expect([run.status, run.produced, run.error, countsAgainstBudget(run)]).toEqual([run.status, run.produced, run.error, counts])
    store.appendRun('r1', r('failed', { id: 'f400', produced: false }))
    store.appendRun('r1', r('ok', { id: 'ok1', produced: true }))
    expect(store.runsToday('r1', new Date()).map((x) => x.id)).toEqual(['ok1'])
  })
})

describe('AutomationsStore — runs.jsonl rotation (hygiene, a known v1.x follow-up)', () => {
  const mkRun = (id: string, automationId: string, status: Run['status']): Run => ({
    id,
    automationId,
    at: new Date().toISOString(),
    status,
  })
  // a tiny threshold for the test: each Run line weighs ~100 bytes — with
  // 300 bytes, 3-4 appends already exceed it. In production the default is 2MB.
  const mkSmallStore = (bytes = 300): AutomationsStore => {
    const s = new AutomationsStore(dataDir, { runsRotateBytes: bytes })
    s.load()
    return s
  }

  it('below the threshold it does NOT rotate: no .1, file untouched', () => {
    const s = mkSmallStore(100_000)
    s.appendRun('r1', mkRun('run-1', 'r1', 'ok'))
    s.appendRun('r1', mkRun('run-2', 'r1', 'ok'))
    expect(s.rotateRunsIfNeeded()).toEqual([])
    expect(existsSync(s.runsPath('r1') + '.1')).toBe(false)
    expect(s.listRuns('r1')).toHaveLength(2)
  })

  it('above the threshold it rotates: current -> .1 (rename, never a copy), and the next append starts a fresh runs.jsonl', () => {
    const s = mkSmallStore()
    for (let i = 0; i < 6; i++) s.appendRun('r1', mkRun(`run-${i}`, 'r1', 'ok'))
    const before = readFileSync(s.runsPath('r1'), 'utf8')
    expect(s.rotateRunsIfNeeded()).toEqual(['r1'])
    // an atomic rename: the .1 holds EXACTLY what the current file used to
    // be; current disappears until the next append (never copy-then-truncate).
    expect(readFileSync(s.runsPath('r1') + '.1', 'utf8')).toBe(before)
    expect(existsSync(s.runsPath('r1'))).toBe(false)
    s.appendRun('r1', mkRun('run-new', 'r1', 'ok'))
    expect(readFileSync(s.runsPath('r1'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('listRuns folds across generations (.1 + current), most recent first, same shape as without rotation', () => {
    const s = mkSmallStore()
    for (let i = 0; i < 5; i++) s.appendRun('r1', mkRun(`run-${i}`, 'r1', 'ok'))
    // a run straddling the rotation: its 'running' snapshot lands in the
    // .1 and the terminal 'ok' lands in the new file — folding must see it as ONE.
    s.appendRun('r1', mkRun('run-horse', 'r1', 'running'))
    expect(s.rotateRunsIfNeeded()).toEqual(['r1'])
    s.appendRun('r1', mkRun('run-horse', 'r1', 'ok'))
    s.appendRun('r1', mkRun('run-post', 'r1', 'ok'))
    const runs = s.listRuns('r1')
    expect(runs.map((r) => r.id)).toEqual(['run-post', 'run-horse', 'run-4', 'run-3', 'run-2', 'run-1', 'run-0'])
    expect(runs.find((r) => r.id === 'run-horse')?.status).toBe('ok')
    // limit applies to the already-merged result (the route's contract).
    expect(s.listRuns('r1', 2).map((r) => r.id)).toEqual(['run-post', 'run-horse'])
  })

  it('a single generation: a second rotation DELETES the preexisting .1 (bounded disk usage, documented)', () => {
    const s = mkSmallStore()
    for (let i = 0; i < 6; i++) s.appendRun('r1', mkRun(`gen1-${i}`, 'r1', 'ok'))
    s.rotateRunsIfNeeded()
    for (let i = 0; i < 6; i++) s.appendRun('r1', mkRun(`gen2-${i}`, 'r1', 'ok'))
    expect(s.rotateRunsIfNeeded()).toEqual(['r1'])
    // gen1 is gone along with the old .1; gen2 now lives in the .1.
    const ids = s.listRuns('r1').map((r) => r.id)
    expect(ids).toHaveLength(6)
    expect(ids.every((id) => id.startsWith('gen2-'))).toBe(true)
  })

  it('latestRun survives a live rotation and also a restart (a cold cache warms up by reading both generations)', () => {
    const s = mkSmallStore()
    for (let i = 0; i < 6; i++) s.appendRun('r1', mkRun(`run-${i}`, 'r1', 'ok'))
    s.rotateRunsIfNeeded()
    // hot: the last run didn't change from rotating (it only moved files).
    expect(s.latestRun('r1')?.id).toBe('run-5')
    // a "restart" right after rotating (before any new append): the cold
    // cache must warm up by reading the .1 — the last run's state must
    // never be lost (reconcileStaleRuns and the tick lock depend on it).
    const s2 = mkSmallStore()
    expect(s2.latestRun('r1')?.id).toBe('run-5')
    expect(s2.latestRun('r1')).toEqual(s.listRuns('r1')[0])
  })

  it('crash window: if the process dies right after the rename (only the .1 exists), everything stays readable and the next append recomposes', () => {
    const s = mkSmallStore()
    s.appendRun('r1', mkRun('run-a', 'r1', 'ok'))
    s.appendRun('r1', mkRun('run-b', 'r1', 'waiting_approval'))
    // simulate the crash: rename done by hand, without going through
    // rotateRunsIfNeeded or a subsequent append — the on-disk state is
    // ONLY runs.jsonl.1.
    renameSync(s.runsPath('r1'), s.runsPath('r1') + '.1')
    const s2 = mkSmallStore()
    expect(s2.automationIdsWithRuns()).toEqual(['r1'])
    expect(s2.listRuns('r1').map((r) => r.id)).toEqual(['run-b', 'run-a'])
    expect(s2.latestRun('r1')?.id).toBe('run-b')
    expect(s2.findRun('run-b')?.automationId).toBe('r1')
    expect(s2.pendingApprovals().map((r) => r.id)).toEqual(['run-b'])
    // the next append creates a fresh runs.jsonl and the history merges.
    s2.appendRun('r1', { ...mkRun('run-b', 'r1', 'ok') })
    expect(s2.listRuns('r1')[0]?.status).toBe('ok')
  })

  it('runsToday counts across generations — the daily budget does not reset from rotating', () => {
    const s = mkSmallStore()
    for (let i = 0; i < 6; i++) s.appendRun('r1', mkRun(`today-${i}`, 'r1', 'ok'))
    s.rotateRunsIfNeeded()
    s.appendRun('r1', mkRun('today-post', 'r1', 'ok'))
    expect(s.runsToday('r1', new Date())).toHaveLength(7)
  })
})
