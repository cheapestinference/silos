// The daily digest: composed by the platform from the
// inbox and the facts the server indexes — three blocks, summed when several
// are unread, written once a day (idempotent), late after a missed hour.
import { describe, expect, it, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { composeDigest, digestCounts, sumDigests, type DigestFacts, type DigestFile } from '../src/digest.js'
import { DigestJob, DigestStore, NotificationPrefsStore, latestSlot, localDay } from '../src/digest-job.js'
import type { InboxRow } from '../src/inbox.js'
import type { Run } from '../src/automations-types.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { NeedsYouAcksStore } from '../src/needs-you-acks.js'
import { AutomationsStore } from '../src/automations-store.js'
import { buildServer } from '../src/server.js'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const H = (h: number, m = 0): number => new Date(2026, 9, 31, h, m).getTime() // local wall clock, 31 Oct 2026

const row = (key: string, urgency: InboxRow['urgency'], at: number, voice = key): InboxRow =>
  ({
    kind: 'failedRun',
    key,
    urgency,
    at,
    voice,
    clears: '',
    agentId: 'builder',
    automation: { id: key, name: key, agentId: 'builder' },
    runId: 'r',
    failure: { class: 'rejected', text: '' },
    streak: 1,
  }) as InboxRow
const run = (status: Run['status'], outcome?: Run['outcome']): Run => ({
  id: Math.random().toString(36).slice(2),
  automationId: 'a',
  at: new Date(H(3)).toISOString(),
  status,
  ...(outcome ? { outcome } : {}),
})

function facts(over: Partial<DigestFacts> = {}): DigestFacts {
  return { nameOf: (id) => id.charAt(0).toUpperCase() + id.slice(1), conversations: [], runs: [], siloDone: [], horizon: null, ...over }
}

describe('composeDigest — three blocks from counts and rows', () => {
  it('urgent messages worked in their own conversations are their own line, never «conversations finished»; they sum across digests', () => {
    const base = { date: '2026-10-31', hour: '08:00', from: 0, to: 1, late: false, inbox: [], previous: null }
    const d = composeDigest({
      ...base,
      facts: facts({ conversations: [{ agentId: 'builder' }], messageConversations: [{ agentId: 'builder' }, { agentId: 'builder' }, { agentId: 'finance' }] }),
    })
    expect(d.happened.conversations).toEqual([{ agentId: 'builder', name: 'Builder', count: 1 }])
    expect(d.happened.messages).toEqual([
      { agentId: 'builder', name: 'Builder', count: 2 },
      { agentId: 'finance', name: 'Finance', count: 1 },
    ])
    expect(digestCounts(d).finished).toBe(1)
    expect(composeDigest({ ...base, facts: facts() }).happened).not.toHaveProperty('messages')
    const next = composeDigest({ ...base, date: '2026-11-01', facts: facts({ messageConversations: [{ agentId: 'builder' }] }) })
    expect(sumDigests([d, next])!.happened.messages).toEqual([
      { agentId: 'builder', name: 'Builder', count: 3 },
      { agentId: 'finance', name: 'Finance', count: 1 },
    ])
  })

  it('waits: the inbox by urgency and its oldest loud row', () => {
    const d = composeDigest({
      date: '2026-10-31',
      hour: '08:00',
      from: H(8) - 86_400_000,
      to: H(8),
      late: false,
      inbox: [row('a', 'blocking', H(6), 'Builder has a question for you'), row('b', 'due', H(2), 'Nightly failed'), row('c', 'routine', H(1))],
      facts: facts(),
      previous: null,
    })
    expect(d.waits).toEqual({ blocking: 1, due: 1, routine: 1, oldest: { at: new Date(H(2)).toISOString(), kind: 'failedRun', voice: 'Nightly failed' } })
    expect(d.late).toBeUndefined()
  })
  it('P6 · a task line is its own line, by its count — never one routine wait', () => {
    const line = {
      kind: 'taskLine',
      key: 'task-line:comingToYou',
      urgency: 'routine',
      at: H(7),
      line: 'comingToYou',
      count: 15,
      keys: [],
      door: '/tasks?view=mine',
      items: [],
      voice: 'Coming to you · 15',
      clears: '',
    } as unknown as InboxRow
    const d = composeDigest({
      date: '2026-10-31',
      hour: '08:00',
      from: H(8) - 86_400_000,
      to: H(8),
      late: false,
      inbox: [row('c', 'routine', H(1)), line],
      facts: facts(),
      previous: null,
    })
    expect(d.waits).toEqual({ blocking: 0, due: 0, routine: 1, oldest: null, lines: [{ line: 'comingToYou', count: 15, voice: 'Coming to you · 15' }] })
  })

  it('happened: conversations per agent, runs split acted / no news / failed / recovered, plan tasks, silo completions', () => {
    const d = composeDigest({
      date: '2026-10-31',
      hour: '08:00',
      from: 0,
      to: H(8),
      late: true,
      inbox: [],
      facts: facts({
        conversations: [{ agentId: 'builder' }, { agentId: 'builder' }, { agentId: 'writer' }],
        runs: [
          { agentId: 'support', run: run('ok', 'acted'), healedLater: false },
          { agentId: 'support', run: run('ok', 'nothing'), healedLater: false },
          { agentId: 'support', run: run('ok', 'nothing'), healedLater: false },
          { agentId: 'support', run: run('ok'), healedLater: false },
          { agentId: 'support', run: run('failed'), healedLater: true },
          { agentId: 'builder', run: run('failed'), healedLater: false },
          { agentId: 'builder', run: run('skipped'), healedLater: false }, // nothing ran: not counted
        ],
        siloDone: [
          { silo: 'invoices', siloName: 'Invoices', to: 'paid', label: 'paid' },
          { silo: 'invoices', siloName: 'Invoices', to: 'paid', label: 'paid' },
        ],
      }),
      previous: { planDone: ['p#1'] },
    })
    // plan tasks close in `silos` now (the built-in Plans silo's journal)
    expect(d.late).toBe(true)
    expect(d.happened.conversations).toEqual([
      { agentId: 'builder', name: 'Builder', count: 2 },
      { agentId: 'writer', name: 'Writer', count: 1 },
    ])
    expect(d.happened.runs).toEqual([
      { agentId: 'support', name: 'Support', runs: 5, acted: 1, noNews: 2, ok: 1, failed: 0, recovered: 1 },
      { agentId: 'builder', name: 'Builder', runs: 1, acted: 0, noNews: 0, ok: 0, failed: 1, recovered: 0 },
    ])
    expect(d.happened.planTasksDone).toBeNull()
    expect(d.happened.silos).toEqual([{ silo: 'invoices', siloName: 'Invoices', to: 'paid', label: 'paid', count: 2 }])
    expect(d.planDone).toEqual([])
    expect(digestCounts(d)).toEqual({ finished: 3, runs: 6, acted: 1, failed: 1, recovered: 1 })
  })

  it("a plan task done is the Plans silo's completion: said under silos, never as «plan tasks done» again", () => {
    const d = composeDigest({
      date: '2026-10-31',
      hour: '08:00',
      from: 0,
      to: 1,
      late: false,
      inbox: [],
      facts: facts({ siloDone: [{ silo: 'plans', siloName: 'Plans', to: 'done', label: 'done' }] }),
      previous: null,
    })
    expect(d.happened.planTasksDone).toBeNull()
    expect(d.happened.silos).toEqual([{ silo: 'plans', siloName: 'Plans', to: 'done', label: 'done', count: 1 }])
  })

  it('coming: the Horizon when a silo declares due; absent (null) otherwise', () => {
    const base = { date: '2026-10-31', hour: '08:00', from: 0, to: 1, late: false, inbox: [], previous: null }
    expect(composeDigest({ ...base, facts: facts() }).coming).toBeNull()
    const h = [{ silo: 'invoices', siloName: 'Invoices', kind: 'invoice', count: 4, firstDue: '2026-11-03' }]
    expect(composeDigest({ ...base, facts: facts({ horizon: h }) }).coming).toEqual(h)
    expect(composeDigest({ ...base, facts: facts({ horizon: [] }) }).coming).toEqual([])
  })
})

function file(date: string, over: Partial<DigestFile['happened']> = {}, waits?: Partial<DigestFile['waits']>): DigestFile {
  return {
    version: 1,
    date,
    hour: '08:00',
    from: `${date}T00:00:00.000Z`,
    to: `${date}T08:00:00.000Z`,
    waits: { blocking: 0, due: 0, routine: 0, oldest: null, ...waits },
    happened: { conversations: [], runs: [], planTasksDone: null, silos: [], ...over },
    coming: null,
    planDone: [],
  }
}

describe('sumDigests — unread digests add up into one band', () => {
  it("happened counts sum; waits and coming are the newest digest's; the window spans them all", () => {
    const fri = file(
      '2026-10-30',
      {
        conversations: [{ agentId: 'builder', name: 'Builder', count: 3 }],
        runs: [{ agentId: 'support', name: 'Support', runs: 24, acted: 2, noNews: 22, ok: 0, failed: 0, recovered: 0 }],
        planTasksDone: 1,
        silos: [{ silo: 'invoices', siloName: 'Invoices', to: 'paid', label: 'paid', count: 2 }],
      },
      { blocking: 5 },
    )
    const sat = {
      ...file(
        '2026-10-31',
        {
          conversations: [
            { agentId: 'builder', name: 'Builder', count: 1 },
            { agentId: 'writer', name: 'Writer', count: 2 },
          ],
          runs: [{ agentId: 'support', name: 'Support', runs: 24, acted: 1, noNews: 22, ok: 0, failed: 0, recovered: 1 }],
          planTasksDone: null,
          silos: [{ silo: 'invoices', siloName: 'Invoices', to: 'paid', label: 'paid', count: 1 }],
        },
        { due: 2 },
      ),
      coming: [{ silo: 'invoices', siloName: 'Invoices', kind: 'invoice', count: 1, firstDue: '2026-11-03' }],
    }
    const band = sumDigests([sat, fri])!
    expect(band.dates).toEqual(['2026-10-30', '2026-10-31'])
    expect(band.through).toBe('2026-10-31')
    expect(band.from).toBe(fri.from)
    expect(band.to).toBe(sat.to)
    expect(band.waits).toEqual(sat.waits)
    expect(band.coming).toEqual(sat.coming)
    expect(band.happened.conversations).toEqual([
      { agentId: 'builder', name: 'Builder', count: 4 },
      { agentId: 'writer', name: 'Writer', count: 2 },
    ])
    expect(band.happened.runs).toEqual([{ agentId: 'support', name: 'Support', runs: 48, acted: 3, noNews: 44, ok: 0, failed: 0, recovered: 1 }])
    expect(band.happened.planTasksDone).toBe(1)
    expect(band.happened.silos).toEqual([{ silo: 'invoices', siloName: 'Invoices', to: 'paid', label: 'paid', count: 3 }])
  })

  it('nothing unread: no band', () => {
    expect(sumDigests([])).toBeNull()
  })
})

describe('the hour on the wall clock', () => {
  it("latestSlot is today's hour once it has come, else yesterday's", () => {
    expect(latestSlot('08:00', H(9))).toEqual({ at: H(8), date: '2026-10-31' })
    expect(latestSlot('08:00', H(8))).toEqual({ at: H(8), date: '2026-10-31' })
    expect(latestSlot('08:00', H(7, 59))).toEqual({
      at: H(8) - 86_400_000 + (new Date(H(8) - 86_400_000).getTimezoneOffset() - new Date(H(8)).getTimezoneOffset()) * 60_000,
      date: '2026-10-30',
    })
  })

  it('a time zone reads the day there', () => {
    expect(localDay(Date.parse('2026-10-31T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-11-01')
    expect(latestSlot('08:00', Date.parse('2026-10-31T00:30:00Z'), 'Asia/Tokyo')).toEqual({ at: Date.parse('2026-10-30T23:00:00Z'), date: '2026-10-31' })
  })
})

describe('NotificationPrefsStore', () => {
  it('defaults to 08:00, keeps a valid hour, refuses a bad one', () => {
    const dir = tmp('nprefs-')
    const p = new NotificationPrefsStore(dir)
    expect(p.get()).toEqual({ digestHour: '08:00' })
    p.setDigestHour('07:30')
    expect(new NotificationPrefsStore(dir).get()).toEqual({ digestHour: '07:30' })
    expect(() => p.setDigestHour('25:00')).toThrow()
    writeFileSync(join(dir, 'notifications.json'), '{nope')
    expect(new NotificationPrefsStore(dir).get()).toEqual({ digestHour: '08:00' })
  })
})

describe('DigestJob — one file a day, late after a missed hour, never twice', () => {
  let dir: string, store: DigestStore, written: DigestFile[], factsCalls: Array<[number, number]>
  const job = (hour = '08:00') =>
    new DigestJob({
      store,
      prefs: { get: () => ({ digestHour: hour }) },
      inbox: () => [row('a', 'blocking', H(1))],
      facts: (from, to) => {
        factsCalls.push([from, to])
        return facts({ conversations: [{ agentId: 'builder' }] })
      },
      onWritten: (f) => written.push(f),
    })
  beforeEach(() => {
    dir = tmp('digest-job-')
    store = new DigestStore(dir)
    written = []
    factsCalls = []
  })

  it("before the hour: yesterday's slot (written once); at the hour: today's; then nothing", () => {
    const j = job()
    const y = j.tick(H(7))!
    expect(y.date).toBe('2026-10-30')
    expect(y.late).toBe(true)
    expect(j.tick(H(7, 30))).toBeNull()
    const t = j.tick(H(8))!
    expect(t).toMatchObject({ date: '2026-10-31', hour: '08:00', waits: { blocking: 1 } })
    expect(t.late).toBeUndefined()
    // the window starts where yesterday's ended
    expect(t.from).toBe(y.to)
    expect(factsCalls[1]).toEqual([H(7), H(8)])
    expect(j.tick(H(9))).toBeNull()
    expect(j.tick(H(23))).toBeNull()
    expect(written.map((f) => f.date)).toEqual(['2026-10-30', '2026-10-31'])
    expect(existsSync(join(dir, 'digests', '2026-10-31.json'))).toBe(true)
  })

  it('the file is the record: a restart (a new job) skips a day already written', () => {
    job().tick(H(8))
    expect(job().tick(H(10))).toBeNull()
    expect(written).toHaveLength(1)
  })

  it('a restart after the hour writes it late, its window from the last digest (a weekend away)', () => {
    store.write(file('2026-10-28'))
    const f = job().tick(H(11))!
    expect(f).toMatchObject({ date: '2026-10-31', late: true, from: '2026-10-28T08:00:00.000Z' })
    // one file for the newest missed day, not one per day
    expect(store.dates()).toEqual(['2026-10-28', '2026-10-31'])
  })

  it('no earlier digest: the window is the 24 h before the hour', () => {
    job().tick(H(8))
    expect(factsCalls[0]).toEqual([H(8) - 86_400_000, H(8)])
  })

  it('unread() sums what is newer than the date seen, within a month', () => {
    store.write(file('2026-09-01', { planTasksDone: 9 }))
    store.write(file('2026-10-30', { planTasksDone: 1 }))
    store.write(file('2026-10-31', { planTasksDone: 2 }))
    expect(store.unread(null, '2026-10-31')!.dates).toEqual(['2026-10-30', '2026-10-31'])
    expect(store.unread('2026-10-30', '2026-10-31')!.happened.planTasksDone).toBe(2)
    expect(store.unread('2026-10-31', '2026-10-31')).toBeNull()
  })
})

describe("digestFacts — conversations quiet by the window's end, windows that tile", () => {
  it('a conversation counts in the window its last activity (shifted back by liveMs) falls in — once', async () => {
    const base = tmp('digest-conv-')
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    mkdirSync(join(root, '-tmp-project-x'), { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    const last = Date.now() - 10 * 60_000
    const FIX = new URL('./fixtures/basic.jsonl', import.meta.url).pathname
    writeFileSync(
      join(root, '-tmp-project-x', 'c1.jsonl'),
      readFileSync(FIX, 'utf8') +
        JSON.stringify({
          type: 'user',
          cwd: '/tmp/project-x',
          timestamp: new Date(last).toISOString(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
        }) +
        '\n',
    )
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'finance', name: 'FINANCE', folder: '/tmp/project-x', skills: [] })
    const native = new NativeStore(join(dataDir, 'native.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    const app = buildServer({
      index,
      registry,
      store: new SessionStore(root, dataDir),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: 't',
      liveMs: 120_000,
    })
    const liveMs = 120_000
    // the window ending right after its last activity: still live → not yet
    expect(app.digestFacts(last - 3_600_000, last + 60_000).conversations).toEqual([])
    // the next window (they tile): now quiet → counted, with its owner
    expect(app.digestFacts(last + 60_000, last + liveMs + 60_000).conversations).toEqual([{ agentId: 'finance' }])
    // and never again after that
    expect(app.digestFacts(last + liveMs + 60_000, last + 86_400_000).conversations).toEqual([])
  })
})

describe('GET /api/digest · POST /api/digest/seen · PUT /api/digest/hour · digestFacts', () => {
  const TOKEN = 't'
  const HD = { 'x-token': TOKEN }
  let app: FastifyInstance, dataDir: string, digests: DigestStore, automations: AutomationsStore, root: string

  beforeEach(async () => {
    const base = tmp('digest-api-')
    root = join(base, 'projects')
    dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder: join(base, 'proj'), skills: [] })
    mkdirSync(join(base, 'proj', 'plans'), { recursive: true })
    writeFileSync(
      join(base, 'proj', 'plans', 'x.plan.json'),
      JSON.stringify({
        title: 'X',
        tasks: [
          { id: 't1', title: 'a', owner: 'builder', status: 'done' },
          { id: 't2', title: 'b', owner: 'builder', status: 'pending' },
        ],
      }),
    )
    const store = new SessionStore(root, dataDir)
    const native = new NativeStore(join(dataDir, 'native.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    const needsYouAcks = new NeedsYouAcksStore(dataDir)
    needsYouAcks.load()
    automations = new AutomationsStore(dataDir)
    automations.load()
    digests = new DigestStore(dataDir)
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: TOKEN,
      liveMs: 120_000,
      needsYouAcks,
      automations,
      digests,
      notificationPrefs: new NotificationPrefsStore(dataDir),
    })
  })

  it('the band sums the unread files; Seen moves the mark forward, never back', async () => {
    const today = localDay(Date.now())
    const yesterday = localDay(Date.now() - 86_400_000)
    digests.write(file(yesterday, { planTasksDone: 1 }))
    digests.write(file(today, { planTasksDone: 2 }))
    let body = (await app.inject({ url: '/api/digest', headers: HD })).json()
    expect(body.hour).toBe('08:00')
    expect(body.band.dates).toEqual([yesterday, today])
    expect(body.band.happened.planTasksDone).toBe(3)
    expect((await app.inject({ method: 'POST', url: '/api/digest/seen', headers: HD, payload: { through: today } })).statusCode).toBe(204)
    expect((await app.inject({ url: '/api/digest', headers: HD })).json().band).toBeNull()
    expect((await app.inject({ method: 'POST', url: '/api/digest/seen', headers: HD, payload: { through: yesterday } })).statusCode).toBe(204)
    body = (await app.inject({ url: '/api/digest', headers: HD })).json()
    expect(body.band).toBeNull()
    expect(JSON.parse(readFileSync(join(dataDir, 'needs-you-acks.json'), 'utf8')).digest).toEqual({ home: today })
    expect((await app.inject({ method: 'POST', url: '/api/digest/seen', headers: HD, payload: { through: '1999-01-01' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/digest/seen', headers: HD, payload: { through: '../x' } })).statusCode).toBe(400)
  })

  it("the hour is the owner's, in plain HH:MM", async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/digest/hour', headers: HD, payload: { hour: '07:15' } })).json()).toEqual({ hour: '07:15' })
    expect((await app.inject({ url: '/api/digest', headers: HD })).json().hour).toBe('07:15')
    expect((await app.inject({ method: 'PUT', url: '/api/digest/hour', headers: HD, payload: { hour: '7am' } })).statusCode).toBe(400)
  })

  it("digestFacts: runs that ended in the window with their healing, conversations quiet by its end; no plan snapshot (the Plans silo's journal counts them)", () => {
    const now = Date.now()
    automations.create({
      id: 'a1',
      name: 'Sweep',
      agentId: 'builder',
      prompt: 'p',
      trigger: { kind: 'cron', expr: '0 * * * *' },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: false,
      paused: false,
      createdAt: new Date(now - 7_200_000).toISOString(),
    })
    const at = (ms: number) => new Date(ms).toISOString()
    automations.appendRun('a1', { id: 'r1', automationId: 'a1', at: at(now - 3_600_000), endedAt: at(now - 3_500_000), status: 'failed', error: 'timeout' })
    automations.appendRun('a1', { id: 'r2', automationId: 'a1', at: at(now - 1_800_000), endedAt: at(now - 1_700_000), status: 'ok', outcome: 'acted' })
    automations.appendRun('a1', { id: 'r3', automationId: 'a1', at: at(now - 86_400_000 * 3), endedAt: at(now - 86_400_000 * 3), status: 'ok' }) // outside
    const f = app.digestFacts(now - 86_400_000, now)
    expect(f.runs.map((r) => [r.run.id, r.healedLater])).toEqual([
      ['r2', false],
      ['r1', true],
    ])
    expect('planDone' in f).toBe(false)
    expect(f.horizon).toBeNull()
    expect(f.nameOf('builder')).toBe('Builder')
  })
})
