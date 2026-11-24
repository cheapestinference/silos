// The doorbell: what rings (a new blocking or due key;
// routine never; Seen never; a re-ring only when the key left and came back
// at a version that hasn't rung) and what a ring may carry (counts and kinds
// only — the lock screen is the leak surface).
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboxBell, inboxPayload, kindsPhrase, morningLine, morningPayload, DUE_BATCH_MS, MIN_GAP_MS, type DoorbellPayload } from '../src/doorbell.js'
import { composeInbox, type InboxRow } from '../src/inbox.js'
import type { DigestFile } from '../src/digest.js'

const T0 = Date.parse('2026-10-31T09:00:00Z')

// rows full of names and customer text — none of it may reach a payload
const ask = (id: string, at = T0): InboxRow => ({
  kind: 'ask',
  key: `ask:f\0${id}`,
  urgency: 'blocking',
  at,
  agentId: 'builder',
  folder: 'f',
  id,
  title: 'Acme SL refund for María',
  cwd: null,
  voice: 'Builder has a question for you',
  clears: '',
})
const failed = (auto: string, runId: string): InboxRow => ({
  kind: 'failedRun',
  key: `failed-run:${auto}`,
  urgency: 'due',
  at: T0,
  agentId: 'finance',
  automation: { id: auto, name: 'Ledgerly sync for Acme SL', agentId: 'finance' },
  runId,
  failure: { class: 'rejected', text: 'the API rejected the request (400)' },
  streak: 1,
  voice: 'Ledgerly sync for Acme SL failed · Finance',
  clears: '',
  ack: { kind: 'run', key: auto, version: runId },
})
// a plan task of the owner's: the built-in Plans silo's sub-kind row
const plan = (id: string, urgency: 'routine' | 'due' = 'routine'): InboxRow => ({
  kind: 'silo',
  key: `silo:entry:plans:folder:/p/x/tasks/${id}`,
  urgency,
  at: 0,
  voice: 'Plans: Call María — pending',
  clears: '',
  item: {
    kind: 'silo',
    reason: 'entry',
    silo: 'plans',
    siloName: 'Plans',
    key: `folder:/p/x/tasks/${id}`,
    recordKind: 'plan/task',
    urgency,
    text: 'Call María — pending',
    identity: 'Call María',
    at: '',
    file: '/p/plans/x.plan.json',
    parent: { key: 'folder:/p/x', kind: 'plan', identity: 'Secret plan', at: '' },
  },
})

class FakeBell {
  rings: DoorbellPayload[] = []
  async ring(p: DoorbellPayload) {
    this.rings.push(p)
  }
}

const NAMES = /Builder|Finance|Acme|María|Ledgerly|Secret|refund|400|question for you/

describe('the payload: counts and kinds, never names or row text', () => {
  it('kindsPhrase counts kinds in plain words', () => {
    expect(kindsPhrase([ask('1'), ask('2'), failed('a', 'r')])).toBe('2 questions · a failed run')
    expect(kindsPhrase([{ kind: 'ask', permission: {} }])).toBe('a permission')
    // a silo summary says its kind's noun — support's ONE row (now a silo)
    expect(kindsPhrase([{ kind: 'siloSummary', noun: { one: 'support ticket', many: 'support tickets' } }])).toBe('support tickets')
  })

  it('inboxPayload carries only title/body/tag/url/counts/urgency, and no row text', () => {
    const p = inboxPayload([ask('1'), failed('a', 'r')], [ask('1'), failed('a', 'r'), ask('9')])
    expect(Object.keys(p).sort()).toEqual(['body', 'counts', 'tag', 'title', 'urgency', 'url'])
    expect(p).toEqual({
      title: 'Silos',
      body: '2 new things need you: a question · a failed run · 3 waiting in all',
      tag: 'silos-inbox',
      url: '/',
      counts: { blocking: 2, due: 1 },
      urgency: 'high',
    })
    expect(JSON.stringify(p)).not.toMatch(NAMES)
    expect(inboxPayload([failed('a', 'r')], [failed('a', 'r')]).body).toBe('Something new needs you: a failed run')
  })

  it('the morning line says counts only', () => {
    const d = {
      waits: { blocking: 2, due: 1, routine: 4, oldest: { at: '', kind: 'ask', voice: 'Builder has a question for you' } },
      happened: {
        conversations: [{ agentId: 'builder', name: 'Builder', count: 14 }],
        runs: [{ agentId: 'finance', name: 'Finance', runs: 5, acted: 2, noNews: 2, ok: 0, failed: 0, recovered: 1 }],
        planTasksDone: 3,
        silos: [{ silo: 'f', siloName: 'Invoices', to: 'paid', label: 'paid', count: 3 }],
      },
    } as unknown as DigestFile
    expect(morningLine(d)).toBe('Morning: 3 need you · 14 finished · 2 runs acted · 1 failed and recovered')
    const p = morningPayload(d)
    expect(JSON.stringify(p)).not.toMatch(NAMES)
    expect(p.tag).toBe('silos-digest')
    expect(
      morningLine({
        waits: { blocking: 0, due: 0, routine: 0, oldest: null },
        happened: { conversations: [], runs: [], planTasksDone: null, silos: [] },
      } as unknown as DigestFile),
    ).toBe('Morning: nothing waits, nothing new')
  })
})

describe('InboxBell — the ring rule', () => {
  let dir: string, fake: FakeBell, bell: InboxBell
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bell-'))
    fake = new FakeBell()
    bell = new InboxBell({ dataDir: dir, bell: fake })
  })

  it('what already waits at the first composition is the baseline — nothing rings', async () => {
    bell.baseline([ask('1'), failed('a', 'r1')])
    await bell.observe([ask('1'), failed('a', 'r1')], T0)
    expect(fake.rings).toEqual([])
  })

  it('a new blocking key rings at once, and only once', async () => {
    bell.baseline([])
    await bell.observe([ask('1')], T0)
    expect(fake.rings.map((r) => r.body)).toEqual(['Something new needs you: a question'])
    await bell.observe([ask('1'), plan('t')], T0 + MIN_GAP_MS * 2)
    expect(fake.rings).toHaveLength(1)
  })

  it('a plan task that gates an agent rings as «a task» — its kind, never its title or its plan', async () => {
    bell.baseline([])
    await bell.observe([plan('g1', 'due'), plan('g2', 'due')], T0)
    await bell.flush(T0 + DUE_BATCH_MS + 1)
    expect(fake.rings.map((r) => r.body)).toEqual(['2 new things need you: 2 tasks'])
    expect(fake.rings[0]!.body).not.toMatch(NAMES)
  })

  it('routine never rings', async () => {
    bell.baseline([])
    await bell.observe([plan('t1'), plan('t2')], T0)
    await bell.flush(T0 + DUE_BATCH_MS * 3)
    expect(fake.rings).toEqual([])
  })

  it('due waits for its batch, then rides one ring with whatever else came', async () => {
    bell.baseline([])
    await bell.observe([failed('a', 'r1')], T0)
    expect(fake.rings).toEqual([])
    await bell.observe([failed('a', 'r1'), failed('b', 'r2')], T0 + 60_000)
    await bell.flush(T0 + DUE_BATCH_MS - 1)
    expect(fake.rings).toEqual([])
    await bell.flush(T0 + DUE_BATCH_MS)
    expect(fake.rings.map((r) => r.body)).toEqual(['2 new things need you: 2 failed runs'])
  })

  it('a due row that clears before its batch never rings', async () => {
    bell.baseline([])
    await bell.observe([failed('a', 'r1')], T0)
    await bell.observe([], T0 + 60_000)
    await bell.flush(T0 + DUE_BATCH_MS * 2)
    expect(fake.rings).toEqual([])
  })

  it('at most one ring per gap — the second blocking rides the next ring', async () => {
    bell.baseline([])
    await bell.observe([ask('1')], T0)
    await bell.observe([ask('1'), ask('2')], T0 + 60_000)
    expect(fake.rings).toHaveLength(1)
    await bell.flush(T0 + MIN_GAP_MS)
    expect(fake.rings.map((r) => r.body)).toEqual(['Something new needs you: a question', 'Something new needs you: a question · 2 waiting in all'])
  })

  it('Seen never rings: a Seen row is gone from the composition', async () => {
    const ackedVersion = (kind: string, key: string) => (kind === 'run' && key === 'a' ? 'r1' : null)
    const empty = { nameOf: (id: string) => id, asks: [], needsYou: [], pending: [], automations: [] }
    bell.baseline([])
    await bell.observe(composeInbox({ ...empty, kernel: [failed('a', 'r1')], ackedVersion }), T0)
    await bell.flush(T0 + DUE_BATCH_MS * 2)
    expect(fake.rings).toEqual([])
  })

  it('left and came back: an unversioned row rings again; a versioned one only at a new version', async () => {
    bell.baseline([])
    await bell.observe([ask('1')], T0)
    await bell.observe([], T0 + 1000)
    await bell.observe([ask('1')], T0 + MIN_GAP_MS * 2)
    expect(fake.rings).toHaveLength(2)

    await bell.observe([ask('1'), failed('a', 'r1')], T0 + MIN_GAP_MS * 4)
    await bell.flush(T0 + MIN_GAP_MS * 4 + DUE_BATCH_MS)
    expect(fake.rings).toHaveLength(3)
    // flapping at the same version: not news twice
    await bell.observe([ask('1')], T0 + MIN_GAP_MS * 8)
    await bell.observe([ask('1'), failed('a', 'r1')], T0 + MIN_GAP_MS * 9)
    await bell.flush(T0 + MIN_GAP_MS * 9 + DUE_BATCH_MS)
    expect(fake.rings).toHaveLength(3)
    // a new failure after it left: news
    await bell.observe([ask('1')], T0 + MIN_GAP_MS * 12)
    await bell.observe([ask('1'), failed('a', 'r2')], T0 + MIN_GAP_MS * 13)
    await bell.flush(T0 + MIN_GAP_MS * 13 + DUE_BATCH_MS)
    expect(fake.rings).toHaveLength(4)
  })

  it('the loud set survives a restart: what entered while down rings, what was known does not', async () => {
    bell.baseline([ask('1')])
    const after = new InboxBell({ dataDir: dir, bell: fake })
    after.baseline([ask('1'), ask('2')]) // a saved state wins over a new baseline
    await after.observe([ask('1'), ask('2')], T0)
    expect(fake.rings.map((r) => r.body)).toEqual(['Something new needs you: a question · 2 waiting in all'])
    expect(JSON.parse(readFileSync(join(dir, 'doorbell.json'), 'utf8')).loud).toEqual([ask('1').key, ask('2').key])
  })

  it('the morning push counts as a ring for the gap', async () => {
    bell.baseline([])
    await bell.morning(
      {
        waits: { blocking: 0, due: 0, routine: 0, oldest: null },
        happened: { conversations: [], runs: [], planTasksDone: null, silos: [] },
      } as unknown as DigestFile,
      T0,
    )
    await bell.observe([ask('1')], T0 + 1000)
    expect(fake.rings.map((r) => r.tag)).toEqual(['silos-digest'])
    await bell.flush(T0 + MIN_GAP_MS)
    expect(fake.rings.map((r) => r.tag)).toEqual(['silos-digest', 'silos-inbox'])
  })
})
