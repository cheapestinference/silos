// The transition journal (Silo Standard step 1, Task 4): append-only, per
// convention, written when the kernel OBSERVES — baseline ≠ event, «arrived
// closed» ≠ «closed», removed when the file goes, dated to when it was seen.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TransitionJournal, arrivedTerminal, isCompletion, type Observation } from '../src/silos/journal.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { evaluate, parse } from '../src/silos/expressions.js'
import type { SiloLocations } from '../src/silos/files-source.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-journal-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const T0 = new Date('2026-10-30T09:00:00Z')
const T1 = new Date('2026-10-30T10:00:00Z')
const T2 = new Date('2026-10-30T11:00:00Z')
const obs = (entries: Array<[string, string, boolean?]>, extra: Partial<Observation> = {}): Observation => ({
  convention: 'agent-state:silos/invoices',
  dir: 'conv',
  silo: 'invoices',
  complete: true,
  preserve: [],
  entries: entries.map(([key, state, terminal]) => ({ key, kind: 'invoice', state, terminal: terminal === true })),
  ...extra,
})
const lines = (dir = 'conv'): Json[] =>
  readFileSync(join(base, dir, 'journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

describe('TransitionJournal', () => {
  it('the first observation is a baseline, never an event', () => {
    const j = new TransitionJournal(base)
    const out = j.observe(
      obs([
        ['agent:finance/a', 'open'],
        ['agent:finance/b', 'paid', true],
      ]),
      T0,
    )
    expect(out.map((l) => l.event)).toEqual(['opened', 'baseline', 'baseline'])
    expect(out[0]).toMatchObject({ reason: 'first observation', silo: 'invoices' })
    expect(out.some(isCompletion)).toBe(false)
    expect(out.some(arrivedTerminal)).toBe(false)
    expect(lines()).toHaveLength(3)
  })

  it('a change seen later is a transition dated to when it was SEEN, with its window and the file time as a hint', () => {
    const j = new TransitionJournal(base)
    j.observe(obs([['k', 'open']]), T0)
    j.observe(obs([['k', 'open']]), T1) // seen unchanged: the window moves
    const out = j.observe(
      { ...obs([]), entries: [{ key: 'k', kind: 'invoice', state: 'paid', terminal: true, fileWrittenAt: '2026-10-30T10:30:00.000Z' }] },
      T2,
    )
    expect(out).toEqual([
      {
        at: T2.toISOString(),
        event: 'transition',
        key: 'k',
        kind: 'invoice',
        from: 'open',
        to: 'paid',
        fromTerminal: false,
        toTerminal: true,
        prevSeenAt: T1.toISOString(),
        fileWrittenAt: '2026-10-30T10:30:00.000Z',
      },
    ])
    expect(isCompletion(out[0]!)).toBe(true)
  })

  it('terminal → terminal is not «closed»; nothing changed writes nothing', () => {
    const j = new TransitionJournal(base)
    j.observe(obs([['k', 'paid', true]]), T0)
    expect(j.observe(obs([['k', 'paid', true]]), T1)).toEqual([])
    const [l] = j.observe(obs([['k', 'refunded', true]]), T2)
    expect(l!.event).toBe('transition')
    expect(isCompletion(l!)).toBe(false)
  })

  it('a record first seen after the baseline appeared — already closed is «arrived closed», not «closed»', () => {
    const j = new TransitionJournal(base)
    j.observe(obs([['a', 'open']]), T0)
    const out = j.observe(
      obs([
        ['a', 'open'],
        ['b', 'open'],
        ['c', 'paid', true],
      ]),
      T1,
    )
    expect(out.map((l) => [l.key, l.event])).toEqual([
      ['b', 'appeared'],
      ['c', 'appeared'],
    ])
    expect(arrivedTerminal(out[1]!)).toBe(true)
    expect(out.some(isCompletion)).toBe(false)
  })

  it('a record whose file is gone is removed; an unreadable one is kept; a truncated reading removes nothing', () => {
    const j = new TransitionJournal(base)
    j.observe(
      obs([
        ['agent:finance/a', 'open'],
        ['agent:finance/b', 'open'],
        ['agent:finance/c', 'open'],
        ['agent:finance/d', 'open'],
      ]),
      T0,
    )
    expect(j.observe(obs([['agent:finance/a', 'open']], { complete: false }), T1)).toEqual([])
    const out = j.observe(obs([['agent:finance/a', 'open']], { preserve: ['agent:finance/b', 'agent:writer'] }), T2)
    expect(out.map((l) => [l.key, l.event, l.from, l.to])).toEqual([
      ['agent:finance/c', 'removed', 'open', null],
      ['agent:finance/d', 'removed', 'open', null],
    ])
    // a removed record that comes back appears again
    expect(
      new TransitionJournal(base)
        .observe(
          obs(
            [
              ['agent:finance/a', 'open'],
              ['agent:finance/c', 'open'],
            ],
            { preserve: ['agent:finance/b'] },
          ),
          new Date('2026-10-30T12:00:00Z'),
        )
        .map((l) => l.event),
    ).toEqual(['appeared'])
  })

  it('since(state): entry into the state from a transition or an arrival; a baseline says nothing about when', () => {
    const j = new TransitionJournal(base)
    j.observe(
      obs([
        ['a', 'waiting'],
        ['b', 'open'],
      ]),
      T0,
    )
    expect(j.since('conv', 'a', 'waiting')).toBeNull()
    j.observe(
      obs([
        ['a', 'open'],
        ['b', 'open'],
        ['c', 'waiting'],
      ]),
      T1,
    )
    j.observe(
      obs([
        ['a', 'waiting'],
        ['b', 'open'],
        ['c', 'waiting'],
      ]),
      T2,
    )
    expect(j.since('conv', 'a', 'waiting')).toBe(T2.getTime())
    expect(j.since('conv', 'c', 'waiting')).toBe(T1.getTime())
    expect(j.since('conv', 'b', 'waiting')).toBeNull()
    expect(j.since('conv', 'nope', 'waiting')).toBeNull()
    expect(j.history('conv', 'a').map((l) => l.event)).toEqual(['baseline', 'transition', 'transition'])
  })

  it('replays from disk: a restart continues the story, no second baseline', () => {
    new TransitionJournal(base).observe(obs([['a', 'open']]), T0)
    const j2 = new TransitionJournal(base)
    const out = j2.observe(obs([['a', 'paid', true]]), T1)
    expect(out.map((l) => l.event)).toEqual(['transition'])
    expect(out[0]!.prevSeenAt).toBe(T0.toISOString())
    expect(lines().filter((l) => l.event === 'opened')).toHaveLength(1)
  })

  it('a missing journal next to convention data restarts the story out loud', () => {
    mkdirSync(join(base, 'conv', 'data'), { recursive: true })
    const out = new TransitionJournal(base).observe(obs([['a', 'open']]), T0)
    expect(out[0]).toMatchObject({ event: 'opened', reason: 'the journal was missing — history restarts here' })
    expect(out[1]!.event).toBe('baseline')
  })

  it('unreadable lines are counted, not fatal', () => {
    new TransitionJournal(base).observe(obs([['a', 'open']]), T0)
    writeFileSync(join(base, 'conv', 'journal.jsonl'), readFileSync(join(base, 'conv', 'journal.jsonl'), 'utf8') + '{broken\n')
    const j = new TransitionJournal(base)
    expect(j.health('conv')).toEqual({ lines: 2, unreadableLines: 1, opened: true })
    expect(j.observe(obs([['a', 'open']]), T1)).toEqual([])
  })

  it('events(from, to): the window Done today reads', () => {
    const j = new TransitionJournal(base)
    j.observe(obs([['a', 'open']]), T0)
    j.observe(obs([['a', 'paid', true]]), T2)
    expect(
      j
        .events('conv', T1.getTime())
        .filter(isCompletion)
        .map((l) => l.key),
    ).toEqual(['a'])
    expect(j.events('conv', T0.getTime(), T1.getTime()).map((l) => l.event)).toEqual(['opened', 'baseline'])
  })
})

describe('the kernel journals ACTIVE silos, per convention', () => {
  const NOW0 = Date.parse('2026-10-30T09:00:00Z')
  function setup(operatorState: 'approved' | null, siloId = 'invoices', manifest = ref('invoices')) {
    const dataDir = join(base, 'data')
    const reg = join(dataDir, 'silos', 'registry', siloId)
    mkdirSync(reg, { recursive: true })
    manifest.metadata.id = siloId
    writeFileSync(join(reg, 'silo.json'), JSON.stringify(manifest))
    const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => operatorState, slotsOff: () => [] } })
    registry.load()
    const locs: SiloLocations = { agentStates: () => [{ agentId: 'finance', dir: join(base, 'as', 'finance') }], projects: () => [join(base, 'proj')] }
    let now = NOW0
    const journal = new TransitionJournal(registry.conventionsDir)
    const kernel = new SiloKernel({ registry, reader: new SiloReader(locs), journal, now: () => now })
    return {
      dataDir,
      registry,
      kernel,
      journal,
      tick: (ms: number) => {
        now += ms
      },
    }
  }
  const invoice = (over: Json = {}): Json => ({ ...ref('invoices').spec.kinds.invoice.examples[0], ...over })
  const put = (rel: string, v: unknown): string => {
    const f = join(base, rel)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, JSON.stringify(v))
    utimesSync(f, new Date(), new Date())
    return f
  }
  const convDir = (dataDir: string): string => join(dataDir, 'silos', 'conventions', encodeURIComponent('agent-state:silos/invoices'))

  it('baseline at the first reading, then the transition; since() reaches predicates', () => {
    put('as/finance/silos/invoices/inv-70a1.json', invoice())
    const { dataDir, kernel, tick } = setup('approved')
    kernel.refresh()
    expect(lines(convDir(dataDir).slice(base.length + 1)).map((l) => l.event)).toEqual(['opened', 'baseline'])
    tick(3_600_000)
    put('as/finance/silos/invoices/inv-70a1.json', invoice({ state: 'paid' }))
    kernel.refresh()
    const l = lines(convDir(dataDir).slice(base.length + 1))
    expect(l[2]).toMatchObject({ event: 'transition', key: 'agent:finance/inv-70a1', from: 'open', to: 'paid', toTerminal: true })
    const rec = kernel.reading('invoices')!.records[0]!.record
    const ast = parse('since(paid) >= now - 1h')
    if (!ast.ok) throw new Error()
    expect(evaluate(ast.ast, rec, { now: NOW0 + 3_600_000, since: kernel.sinceFor('invoices') })).toBe(true)
    expect(kernel.sinceFor('invoices')(rec, 'open')).toBeNull() // baseline: no entry time
  })

  it('a pending silo is read and counted but writes no journal', () => {
    put('as/finance/silos/invoices/inv-70a1.json', invoice())
    const { dataDir, kernel, registry } = setup(null)
    kernel.refresh()
    expect(registry.get('invoices')!.status.records.parsed).toBe(1)
    expect(existsSync(join(dataDir, 'silos', 'conventions'))).toBe(false)
  })

  it('sub-kinds with states are journaled under their parent; a skipped child is not read as removed', () => {
    const plan = {
      title: 'P',
      updatedAt: '2026-10-01',
      tasks: [
        { id: 't1', title: 'a', owner: 'writer', status: 'pending', dependsOn: [] },
        { id: 't2', title: 'b', owner: 'writer', status: 'pending' },
      ],
    }
    put('proj/plans/p.plan.json', plan)
    const { dataDir, kernel } = setup('approved', 'plans', ref('plans'))
    kernel.refresh()
    const dir = join(dataDir, 'silos', 'conventions', encodeURIComponent('project:plans'))
    const folderKey = `folder:${join(base, 'proj')}/p`
    expect(
      lines(dir.slice(base.length + 1))
        .filter((l) => l.event === 'baseline')
        .map((l) => l.key),
    ).toEqual([folderKey, `${folderKey}/tasks/t1`, `${folderKey}/tasks/t2`])
    put('proj/plans/p.plan.json', {
      ...plan,
      tasks: [
        { ...plan.tasks[0], status: 'done' },
        { ...plan.tasks[1], status: 'someday' },
      ],
    })
    kernel.refresh()
    const after = lines(dir.slice(base.length + 1)).slice(4)
    expect(after.map((l) => [l.key, l.event, l.to])).toEqual([[`${folderKey}/tasks/t1`, 'transition', 'done']])
  })

  it('pinned to the convention: uninstalling keeps it, and another silo reading the same convention continues it', () => {
    put('as/finance/silos/invoices/inv-70a1.json', invoice())
    const first = setup('approved')
    first.kernel.refresh()
    rmSync(join(first.dataDir, 'silos', 'registry', 'invoices'), { recursive: true })
    first.registry.load()
    expect(existsSync(join(convDir(first.dataDir), 'journal.jsonl'))).toBe(true)
    // a different silo id over the same files
    const second = setup('approved', 'accounts')
    put('as/finance/silos/invoices/inv-70a1.json', invoice({ state: 'paid' }))
    second.kernel.refresh()
    const l = lines(convDir(second.dataDir).slice(base.length + 1))
    expect(l.map((x) => x.event)).toEqual(['opened', 'baseline', 'transition'])
  })
})
