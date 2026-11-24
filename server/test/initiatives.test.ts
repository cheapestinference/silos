// initiatives.test.ts — around the ledger:
// the API birth of a task (identity, signal, quotas, server-only stamps), the
// assign gate on what appeared outside Silos, the owner's
// blessings (Keep it, Keep them all), Undo, Keep, the
// measure and the end-of-turn verdict (tainted undoes; cut only with
// creations or proposals; an engine gap alone never cuts).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CreationsStore } from '../src/creations.js'
import type { Automation } from '../src/automations-types.js'
import type { Cut } from '../src/control.js'
import { Initiative, PROVISIONAL_OWN_ASSIGN, UNDONE_BY_OWNER, UNKNOWN_ASSIGN } from '../src/initiative.js'
import type { LiveTurn } from '../src/live-turns.js'
import { PlansOrigins } from '../src/plans-origins.js'
import { OPEN_MAX_WORDS, SIGNAL_REQUIRED_HEARTBEAT, weekWords } from '../src/plans-provenance.js'

const NOW = Date.parse('2026-11-11T10:00:00Z')
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'init-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const creations = new CreationsStore(dir)
  const origins = new PlansOrigins(join(dir, 'plans-origins.json'))
  const tasks = new Map<string, { status: string; title: string; owner: string; file?: string; notes?: unknown[] }>()
  const autos: Automation[] = []
  const cuts: Array<{ agent: string; cut: Cut }> = []
  const stopped: string[] = []
  const dismissed: string[] = []
  const init = new Initiative({
    creations,
    origins,
    stamper: { expectOrigin: (k, o) => origins.set(k, o) },
    agent: (id) => (id === 'x' ? { id: 'x', name: 'X' } : null),
    agents: () => [{ id: 'x', name: 'X' }],
    automations: {
      list: () => autos,
      get: (id) => autos.find((a) => a.id === id),
      delete: (id) => {
        const i = autos.findIndex((a) => a.id === id)
        if (i >= 0) autos.splice(i, 1)
      },
      listRuns: () => [],
    } as never,
    trashDir: join(dir, 'trash', 'automations'),
    task: (k) => tasks.get(k) ?? null,
    writeTask: (k, mutate) => {
      const t = tasks.get(k)
      const child = t ? ({ ...t } as Record<string, unknown>) : null
      const out = mutate(child)
      if (typeof out === 'string') return { ok: false, reason: out }
      if (out.write && child) tasks.set(k, child as never)
      return { ok: true }
    },
    stopTask: (k) => {
      stopped.push(k)
    },
    stopAutomation: (id) => {
      stopped.push(id)
      return true
    },
    cut: (agent, cut) => {
      cuts.push({ agent, cut })
    },
    proposals: {
      restampRun: () => 0,
      dismissTainted: (_a, run) => {
        dismissed.push(run)
      },
      byRun: () => [],
    },
    now: () => NOW,
  })
  return { init, creations, origins, tasks, autos, cuts, stopped, dismissed }
}

const hb = (over: Partial<LiveTurn> = {}): LiveTurn => ({
  agentId: 'x',
  turnId: 'T1',
  runId: 'R1',
  unattended: true,
  class: 'heartbeat',
  kind: 'think',
  packetKeys: ['message:m1'],
  at: new Date(NOW).toISOString(),
  ...over,
})
const K = (id: string): string => `proj/tasks/tasks/${id}`

describe('the API birth of a task', () => {
  it('the server stamps createdBy/origin/run — the body never does — and registers before the write', () => {
    const { init, creations, origins } = setup()
    const r = init.prepareTask({ agentId: 'x', turn: hb() }, K('t1'), {
      id: 't1',
      title: 'A',
      owner: 'x',
      signal: 'message:m1',
      createdBy: 'owner',
      origin: 'pack',
      run: 'forged',
    })
    expect(r).toMatchObject({ ok: true, values: { createdBy: 'x', origin: 'self', run: 'R1', signal: 'message:m1' } })
    expect(origins.get(K('t1'))).toMatchObject({ by: 'x', how: 'creation' })
    expect(creations.byRef('x', K('t1'))).toMatchObject({ run: 'R1', signal: 'message:m1' })
  })
  it('a heartbeat without signal: 403 with its words, counted as rejected', () => {
    const { init, creations } = setup()
    expect(init.prepareTask({ agentId: 'x', turn: hb() }, K('t2'), { id: 't2', title: 'A', owner: 'x' })).toMatchObject({
      ok: false,
      code: 403,
      error: SIGNAL_REQUIRED_HEARTBEAT,
    })
    expect(init.measures('x').rejected).toBe(1)
    expect(creations.byRef('x', K('t2'))?.rejected).toBeDefined()
  })
  it('one initiative a week (429) and three open from the mission (429), never a cut', () => {
    const { init, cuts } = setup()
    expect(init.prepareTask({ agentId: 'x', turn: hb() }, K('m1'), { id: 'm1', title: 'A', owner: 'x', signal: 'mission' })).toMatchObject({ ok: true })
    expect(init.prepareTask({ agentId: 'x', turn: hb() }, K('m2'), { id: 'm2', title: 'B', owner: 'x', signal: 'mission' })).toMatchObject({
      ok: false,
      code: 429,
      error: weekWords('2026-11-11'),
    })
    expect(cuts).toEqual([])
  })
  it('INITIATIVES_OPEN_MAX counts own recurring work without acceptedFrom', () => {
    const { init, autos } = setup()
    for (let i = 0; i < 3; i++) autos.push({ id: `a${i}`, agentId: 'x', origin: 'self' } as Automation)
    expect(init.prepareTask({ agentId: 'x', turn: hb() }, K('m3'), { id: 'm3', title: 'A', owner: 'x', signal: 'mission' })).toMatchObject({
      ok: false,
      code: 429,
      error: OPEN_MAX_WORDS,
    })
    autos.forEach((a) => {
      a.acceptedFrom = 'p1'
    })
    expect(init.prepareTask({ agentId: 'x', turn: hb() }, K('m3'), { id: 'm3', title: 'A', owner: 'x', signal: 'mission' })).toMatchObject({ ok: true })
  })
  it('an attended turn is stamped createdBy, never judged; the owner is the owner', () => {
    const { init, origins } = setup()
    expect(init.prepareTask({ agentId: 'x', turn: hb({ class: 'console', unattended: false }) }, K('c1'), { id: 'c1', title: 'A', owner: 'x' })).toMatchObject({
      ok: true,
      values: { createdBy: 'x' },
    })
    expect(origins.get(K('c1'))).toMatchObject({ by: 'x', how: 'attended' })
    expect(init.prepareTask({ owner: true }, K('o1'), { id: 'o1', title: 'A', owner: 'x', createdBy: 'x' })).toMatchObject({
      ok: true,
      values: { createdBy: 'owner' },
    })
    expect(origins.get(K('o1'))).toMatchObject({ by: 'owner' })
  })
})

describe('the assign gate', () => {
  it('absent from both registries ⇒ unknown ⇒ 409', () => {
    expect(setup().init.assignRefusal(K('zz'), hb())).toEqual({ code: 409, error: UNKNOWN_ASSIGN })
  })
  it("a provisional attribution to the CALLER's own turn says its truth", () => {
    const { init, origins } = setup()
    origins.set(K('p1'), {
      by: 'unknown',
      how: 'unclaimed',
      at: 'x',
      provisional: { since: 'x', candidates: [{ agentId: 'x', turnId: 'T1', run: 'R1', startedAt: 'x' }] },
    })
    expect(init.assignRefusal(K('p1'), hb())).toEqual({ code: 409, error: PROVISIONAL_OWN_ASSIGN })
    expect(init.assignRefusal(K('p1'), hb({ turnId: 'other' }))).toEqual({ code: 409, error: UNKNOWN_ASSIGN })
  })
  it("only the owner's explicit gesture blesses; then assign passes", () => {
    const { init, origins, tasks } = setup()
    tasks.set(K('u1'), { status: 'pending', title: 'outside', owner: 'x' })
    origins.set(K('u1'), { by: 'unknown', how: 'unclaimed', at: 'x' })
    expect(init.assignRefusal(K('u1'), hb())).not.toBeNull()
    expect(init.bless(K('u1'), 'keep')).toBe(true)
    expect(origins.get(K('u1'))).toMatchObject({ by: 'owner', how: 'keep' })
    expect(init.assignRefusal(K('u1'), hb())).toBeNull()
  })
  it("the baseline's block door: one row per folder, Keep them all with exclusions", () => {
    const { init, origins, tasks } = setup()
    for (const id of ['b1', 'b2', 'b3']) {
      tasks.set(K(id), { status: 'pending', title: id, owner: 'x', file: '/w/proj/plans/tasks.plan.json' })
      origins.set(K(id), { by: 'unknown', how: 'baseline', at: 'x', file: '/w/proj/plans/tasks.plan.json' })
    }
    expect(init.baseline()).toEqual([
      {
        folder: '/w/proj',
        tasks: [
          { key: K('b1'), title: 'b1' },
          { key: K('b2'), title: 'b2' },
          { key: K('b3'), title: 'b3' },
        ],
      },
    ])
    expect(init.keepAll('/w/proj', [K('b2')])).toBe(2)
    expect(origins.get(K('b1'))?.by).toBe('owner')
    expect(origins.get(K('b2'))?.by).toBe('unknown')
  })
})

describe('Undo and Keep', () => {
  it('a task: cancelled with «Undone by the owner», its wakes stopped, undoneAt in the ledger', () => {
    const { init, tasks, stopped, creations } = setup()
    init.prepareTask({ agentId: 'x', turn: hb() }, K('t1'), { id: 't1', title: 'A', owner: 'x', signal: 'message:m1' })
    tasks.set(K('t1'), { status: 'pending', title: 'A', owner: 'x' })
    expect(init.undo({ task: K('t1') })).toEqual({ ok: true, undone: 'task', stopped: true })
    expect(tasks.get(K('t1'))).toMatchObject({ status: 'cancelled' })
    expect(JSON.stringify(tasks.get(K('t1'))?.notes)).toContain(UNDONE_BY_OWNER)
    expect(stopped).toContain(K('t1'))
    expect(creations.byRef('x', K('t1'))?.undoneAt).toBeDefined()
    expect(init.measures('x').reactive).toEqual({ created: 1, kept: 0, undone: 1 })
  })
  it('not its own decision ⇒ 409; nothing ⇒ 404', () => {
    const { init, origins, tasks, autos } = setup()
    tasks.set(K('o1'), { status: 'pending', title: 'A', owner: 'x' })
    origins.set(K('o1'), { by: 'owner', how: 'owner', at: 'x' })
    expect(init.undo({ task: K('o1') })).toMatchObject({ ok: false, code: 409 })
    autos.push({ id: 'own', agentId: 'x' } as Automation)
    expect(init.undo({ automation: 'own' })).toMatchObject({ ok: false, code: 409 })
    expect(init.undo({ automation: 'nope' })).toMatchObject({ ok: false, code: 404 })
  })
  it('an automation goes to the trash; Keep stamps keptAt, never acceptedFrom', () => {
    const { init, autos, creations } = setup()
    autos.push({ id: 'self1', agentId: 'x', origin: 'self', name: 'n' } as Automation)
    creations.add('x', { kind: 'automation', ref: 'self1', title: 'n', createdAt: new Date(NOW).toISOString(), by: 'x', signal: 'mission' })
    expect(init.keep('self1')).toBe(true)
    expect(creations.byRef('x', 'self1')?.keptAt).toBeDefined()
    expect(autos[0]!.acceptedFrom).toBeUndefined()
    expect(init.undo({ automation: 'self1' })).toMatchObject({ ok: true, undone: 'automation' })
    expect(autos).toHaveLength(0)
    expect(init.trashed('self1')?.id).toBe('self1')
  })
})

describe('the end of a turn', () => {
  it('a tainted heartbeat that created: undone, proposals dismissed, cut', () => {
    const { init, tasks, cuts, dismissed, creations } = setup()
    init.prepareTask({ agentId: 'x', turn: hb() }, K('t1'), { id: 't1', title: 'A', owner: 'x', signal: 'message:m1' })
    tasks.set(K('t1'), { status: 'pending', title: 'A', owner: 'x' })
    const cut = init.afterAudit('x', 'R1', { readOutside: ['WebFetch'] }, { heartbeat: true, gaps: { mcp: false, childSessions: false } })
    expect(cut?.why).toBe('created work after reading outside (WebFetch)')
    expect(cuts).toHaveLength(1)
    expect(tasks.get(K('t1'))?.status).toBe('cancelled')
    expect(dismissed).toEqual(['R1'])
    // the ledger carries the final readOutside (S7) and counts it tainted
    expect(creations.byRef('x', K('t1'))?.readOutside).toEqual(['WebFetch'])
    expect(init.measures('x').tainted).toBe(1)
  })
  it('what a run created, by the ledger — the heartbeat row counts it, undone ones included', () => {
    const { init, tasks } = setup()
    init.prepareTask({ agentId: 'x', turn: hb() }, K('t1'), { id: 't1', title: 'A', owner: 'x', signal: 'message:m1' })
    tasks.set(K('t1'), { status: 'pending', title: 'A', owner: 'x' })
    expect(init.createdOfRun('x', 'R1')).toEqual(['A'])
    expect(init.createdOfRun('x', 'R2')).toEqual([])
  })
  it('a tainted heartbeat that created nothing: marked, never cut', () => {
    const { init, cuts } = setup()
    expect(init.afterAudit('x', 'R9', { readOutside: ['WebFetch'] }, { heartbeat: true, gaps: { mcp: false, childSessions: false } })).toBeNull()
    expect(cuts).toEqual([])
  })
  it('only an engine gap (OpenCode mcp__) undoes but does not cut (S10)', () => {
    const { init, tasks, cuts } = setup()
    init.prepareTask({ agentId: 'x', turn: hb() }, K('t1'), { id: 't1', title: 'A', owner: 'x', signal: 'message:m1' })
    tasks.set(K('t1'), { status: 'pending', title: 'A', owner: 'x' })
    expect(init.afterAudit('x', 'R1', { readOutside: ['mcp__mail__read'] }, { heartbeat: true, gaps: { mcp: true, childSessions: false } })).toBeNull()
    expect(tasks.get(K('t1'))?.status).toBe('cancelled')
    expect(cuts).toEqual([])
  })
  it('a wake that read outside: provenance re-stamped, nothing undone', () => {
    const { init, tasks, creations } = setup()
    init.prepareTask({ agentId: 'x', turn: hb({ class: 'wake', kind: undefined, taskKey: 'k', runId: undefined, turnId: 'W1' }) }, K('w1'), {
      id: 'w1',
      title: 'A',
      owner: 'x',
      signal: 'task:k',
    })
    tasks.set(K('w1'), { status: 'pending', title: 'A', owner: 'x' })
    init.afterAudit('x', 'W1', { readOutside: ['WebFetch'] }, { heartbeat: false, gaps: { mcp: false, childSessions: false } })
    expect(tasks.get(K('w1'))?.status).toBe('pending')
    expect(creations.byRef('x', K('w1'))?.readOutside).toEqual(['WebFetch'])
  })
  it("the owner's credential USED in any unattended turn cuts", () => {
    const { init } = setup()
    expect(
      init.afterAudit('x', 'W2', { readOutside: [], ownerCredential: ['x-token: curl -H …'] }, { heartbeat: false, gaps: { mcp: false, childSessions: false } })
        ?.why,
    ).toContain("used the owner's credential")
  })
})

describe("its tasks added outside Silos: the agent page's line", () => {
  it("lists the agent's open unknown tasks — never another's, never a closed one, never a blessed one", () => {
    const { init, origins, tasks } = setup()
    const at = new Date(NOW).toISOString()
    tasks.set(K('u1'), { status: 'pending', title: 'Renew the domain', owner: 'x' })
    tasks.set(K('u2'), { status: 'done', title: 'Old', owner: 'x' })
    tasks.set(K('u3'), { status: 'pending', title: 'Theirs', owner: 'y' })
    tasks.set(K('k1'), { status: 'pending', title: 'Kept', owner: 'x' })
    for (const k of ['u1', 'u2', 'u3', 'k1']) origins.set(K(k), { by: 'unknown', how: 'baseline', at } as never)
    init.bless(K('k1'), 'keep')
    expect(init.outsideOf('x')).toEqual([{ key: K('u1'), title: 'Renew the domain' }])
  })
})

describe('what it decided alone is seen', () => {
  const auto = (id: string, paused: boolean): Automation => ({ id, name: id, agentId: 'x', paused }) as unknown as Automation
  it('a lone act shows while it holds — a pause while paused, a withdrawal while gone — and Since lists them newest first', () => {
    const { init, creations, autos } = setup()
    const at = (h: number): string => new Date(NOW - h * 3600_000).toISOString()
    autos.push(auto('a1', true))
    creations.add('x', { kind: 'automation', ref: 'a1', title: 'Read new tax law', createdAt: at(3), by: 'x', action: 'paused' })
    creations.add('x', { kind: 'automation', ref: 'a2', title: 'Weekly digest', createdAt: at(2), by: 'x', action: 'withdrew' })
    creations.add('x', { kind: 'task', ref: K('m1'), title: 'Read the new law', createdAt: at(1), by: 'x', signal: 'mission' })
    expect(init.decided('x').items.map((c) => c.action ?? 'created')).toEqual(['created', 'withdrew', 'paused'])
    expect(init.decidedSince(NOW - 2.5 * 3600_000).map((c) => c.title)).toEqual(['Read the new law', 'Weekly digest'])
    // the owner unpaused one and restored the other: no door left to offer
    autos[0]!.paused = false
    autos.push(auto('a2', false))
    expect(init.decided('x').items.map((c) => c.action ?? 'created')).toEqual(['created'])
  })
})
