// usage.test.ts — Usage: the windows, the
// attribution without double counting, one money, the caps' second line,
// and who may read it. Generic fixtures only.
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageLedger, consoleWindowId, parseLedgerLine } from '../src/usage-ledger.js'
import { UsageService, type UsageDeps } from '../src/usage.js'
import { attribute } from '../src/usage-attribution.js'
import type { UsageRecord } from '../src/harnesses/contract.js'
import type { SessionMeta } from '../src/types.js'
import { ownTurnsToday } from '../src/own-turns.js'
import { localYmd } from '../src/control.js'
import { agentMayRead } from '../src/agent-authz.js'
import { makeAncestry } from '../src/ancestry.js'
import { makeThreadRootKey } from '../src/thread-tools.js'
import { DATA_DIR_DENIED } from '../src/territory.js'
import { DATA_DIR_REGIMES } from '../src/seal-regimes.js'
import { ClaudeReader } from '../src/harnesses/claude-code/reader.js'
import { AutomationsStore } from '../src/automations-store.js'
import { ChatService } from '../src/chat-service.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import type { QueryFn, SdkMessage } from '../src/harnesses/claude-code/sdk-types.js'
import type { ChatEvent } from '../src/chat-types.js'

// a fixed local day: 10:00 local is the base of every fixture
const DAY = new Date(2026, 10, 11)
const at = (h: number, m = 0): number => new Date(DAY.getFullYear(), DAY.getMonth(), DAY.getDate(), h, m).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()
const DAY_FROM = at(0)
const DAY_TO = at(24)

const rec = (id: string, t: number, cost: number | null = 0.01, session = 's', tokens = 100): UsageRecord => ({
  id,
  at: t,
  model: 'model-x',
  tokens: { in: tokens, out: tokens, cacheRead: 0, cacheWrite: 0 },
  costUsd: cost,
  session,
})

const meta = (folder: string, id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, folder, title: `conv ${id}`, cwd: null, mtime: at(23), startedAt: at(1), ...extra }) as SessionMeta

interface World {
  dir: string
  ledger: UsageLedger
  metas: SessionMeta[]
  records: Map<string, UsageRecord[] | 'unmeasured'>
  thread: Map<string, string>
  nested: Map<string, string>
  own: UsageRecord[]
  writes: Array<{ id: string; cost: number | null }>
  deps: UsageDeps
  automations: Record<string, { name: string; own: boolean; accepted: boolean; heartbeat: boolean }>
}

function world(now = at(23)): World {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'))
  const ledger = new UsageLedger(join(dir, 'usage'), { now: () => now })
  const w = {
    dir,
    ledger,
    metas: [] as SessionMeta[],
    records: new Map(),
    thread: new Map(),
    nested: new Map(),
    own: [] as UsageRecord[],
    writes: [] as Array<{ id: string; cost: number | null }>,
    automations: {
      mine: { name: 'Its digest', own: true, accepted: false, heartbeat: false },
      accepted: { name: 'Its accepted', own: true, accepted: true, heartbeat: false },
      yours: { name: 'Your report', own: false, accepted: false, heartbeat: false },
      'heartbeat-a1': { name: "A1's heartbeat", own: true, accepted: false, heartbeat: true },
    },
  } as unknown as World
  w.deps = {
    ledger,
    sessions: {
      all: () => w.metas,
      usageRecords: async (folder, id) => w.records.get(`${folder}/${id}`) ?? null,
      silosOwnUsage: async (since) => w.own.filter((r) => r.at >= since),
    },
    threadKeyOf: (m) => w.thread.get(`${m.folder}/${m.id}`) ?? `${m.folder}/${m.id}`,
    nestedParentOf: (m) => w.nested.get(m.id) ?? null,
    engineLabelOf: (m) => (m.harness === 'other' ? 'Other Engine' : 'Main Engine'),
    labels: {
      agent: (id) => id.toUpperCase(),
      automation: (id) => w.automations[id]?.name ?? null,
      task: (key) => `Task ${key}`,
      provider: (id) => id,
    },
    runOfNow: (id) => {
      const a = w.automations[id]
      return a ? (a.own ? (a.accepted ? 'accepted' : 'own') : 'yours') : null
    },
    writeCost: (win, c) => {
      w.writes.push({ id: win.id, cost: c.costUsd })
      return 'done'
    },
    now: () => now,
    retryMs: 1,
  }
  return w
}

const open = (
  w: World,
  o: {
    id: string
    at: number
    cls: 'chat' | 'console' | 'heartbeat' | 'wake' | 'run'
    agent?: string
    session?: string
    priced?: boolean
    task?: string
    automation?: string
    run?: string
    gesture?: boolean
    account?: string
    provider?: string
  },
): void => {
  const [folder, id] = (o.session ?? 'f/s').split('/') as [string, string]
  w.ledger.open({
    id: o.id,
    at: iso(o.at),
    class: o.cls,
    agentId: o.agent ?? 'a1',
    session: { folder, id },
    provider: o.provider ?? (o.priced ? 'api' : 'default'),
    ...(o.priced ? {} : { account: o.account ?? 'default' }),
    priced: o.priced ?? false,
    ...(o.task ? { taskKey: o.task } : {}),
    ...(o.automation ? { automationId: o.automation } : {}),
    ...(o.run ? { runId: o.run } : {}),
    ...(o.gesture !== undefined ? { gesture: o.gesture } : {}),
    // a run seals whose automation it served, as turnOpened does
    ...(o.cls === 'run' && o.automation ? { runOf: w.deps.runOfNow?.(o.automation) ?? 'yours' } : {}),
  })
}

describe('the ledger (usage-ledger.ts)', () => {
  it('one open line and one close line per window, 0600 under a 0700 dir; the first close wins', () => {
    const w = world()
    open(w, { id: 't1', at: at(10), cls: 'wake', task: 'k' })
    expect(w.ledger.close('t1', 'timeout', iso(at(10, 30)))).toBe(true)
    expect(w.ledger.close('t1', 'cancelled')).toBe(false)
    const files = readdirSync(join(w.dir, 'usage'))
    expect(files).toEqual(['2026-11.jsonl'])
    const file = join(w.dir, 'usage', files[0]!)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(w.dir, 'usage')).mode & 0o777).toBe(0o700)
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ ev: 'open', id: 't1', class: 'wake', agentId: 'a1', taskKey: 'k', priced: false })
    expect(lines[1]).toMatchObject({ ev: 'close', id: 't1', outcome: 'timeout' })
    // read back by a new process
    const again = new UsageLedger(join(w.dir, 'usage'))
    expect(again.get('t1')).toMatchObject({ outcome: 'timeout', closedAt: iso(at(10, 30)) })
    expect(again.since()).toBe(at(10))
  })

  it('a kind is data among look, think and round; a line it does not recognise is skipped, never half-read', () => {
    const w = world()
    open(w, { id: 'h', at: at(9), cls: 'heartbeat', automation: 'heartbeat-a1', run: 'r' })
    w.ledger.open({ id: 'r1', class: 'heartbeat', kind: 'round', agentId: 'a1', session: { folder: 'f', id: 's' }, provider: 'default', priced: false })
    expect(w.ledger.get('r1')?.kind).toBe('round')
    expect(
      parseLedgerLine(
        '{"ev":"open","id":"x","at":"2026-11-11T10:00:00Z","class":"party","agentId":"a","session":{"folder":"f","id":"s"},"provider":"p","priced":false}',
      ),
    ).toBeNull()
    expect(parseLedgerLine('{"ev":"close","id":"x","at":"2026-11-11T10:00:00Z","outcome":"maybe"}')).toBeNull()
    expect(parseLedgerLine('not json')).toBeNull()
  })

  it('a half-written line never swallows the next event: append starts a fresh line, the loader salvages per event', () => {
    const w = world()
    open(w, { id: 'first', at: at(9), cls: 'chat' })
    const file = join(w.dir, 'usage', '2026-11.jsonl')
    // a process died mid-write: the file ends in half a line
    writeFileSync(file, readFileSync(file, 'utf8') + '{"ev":"open","id":"broken","at":"2026-11-11T10:0')
    const ledger = new UsageLedger(join(w.dir, 'usage'), { now: () => at(11) })
    expect(ledger.open({ id: 'after', at: iso(at(11)), class: 'wake', agentId: 'a1', session: { folder: 'f', id: 's' }, provider: 'p', priced: false })).toBe(
      true,
    )
    expect(new UsageLedger(join(w.dir, 'usage')).windows().map((x) => x.id)).toEqual(['first', 'after'])
    // a file already glued by an older writer: the whole event after the break is kept
    const glued = join(w.dir, 'usage', '2026-10.jsonl')
    writeFileSync(
      glued,
      '{"ev":"open","id":"half","at":"2026-10-0' +
        JSON.stringify({
          ev: 'open',
          id: 'kept',
          at: '2026-10-02T10:00:00.000Z',
          class: 'chat',
          agentId: 'a1',
          session: { folder: 'f', id: 's' },
          provider: 'p',
          priced: false,
        }) +
        '\n',
    )
    expect(new UsageLedger(join(w.dir, 'usage')).get('kept')).not.toBeNull()
  })

  it('usage/ is fenced from every agent and named outside the seal with its reason', () => {
    expect(DATA_DIR_DENIED).toContain('usage')
    expect(DATA_DIR_REGIMES.usage).toMatchObject({ regime: 'out-of-seal' })
    expect(DATA_DIR_REGIMES.usage!.why).toMatch(/fenced/)
    expect(DATA_DIR_REGIMES.usage!.specNamed).toBeUndefined()
  })
})

describe('attribution without double counting (usage-attribution.ts)', () => {
  it('a console and a wake over the same conversation split it — every record once, the more specific window wins', async () => {
    const w = world()
    w.metas.push(meta('f', 's'))
    // the console window opened at 09:00 and is still open (its tmux lives);
    // a wake ran on the same file 11:00–11:30
    w.ledger.open({
      id: consoleWindowId('s', at(9)),
      at: iso(at(9)),
      class: 'console',
      agentId: 'a1',
      session: { folder: 'f', id: 's' },
      provider: 'default',
      account: 'default',
      priced: false,
    })
    open(w, { id: 'wake1', at: at(11), cls: 'wake', task: 'k1' })
    w.ledger.close('wake1', 'done', iso(at(11, 30)))
    w.records.set('f/s', [rec('m1', at(9, 10)), rec('m2', at(11, 5)), rec('m3', at(11, 20)), rec('m4', at(12))])
    const svc = new UsageService(w.deps)
    const r = await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'kind' })
    const byKey = Object.fromEntries(r.rows.map((x) => [x.key, x]))
    expect(byKey.console!.tokens.in).toBe(200) // m1 + m4
    expect(byKey.wake!.tokens.in).toBe(200) // m2 + m3
    expect(r.totals.tokens.in).toBe(400) // never 600
    expect(byKey.console!.turns).toBe(1)
    expect(byKey.wake!.turns).toBe(1)
  })

  it('dedupes by message id per THREAD: a --resume copy in a new file is counted once', async () => {
    const w = world()
    w.metas.push(meta('f', 'old', { startedAt: at(1) }), meta('f', 'new', { startedAt: at(12) }))
    w.thread.set('f/new', 'f/old')
    open(w, { id: 'c1', at: at(10), cls: 'chat', session: 'f/old' })
    w.ledger.close('c1', 'done', iso(at(11)))
    open(w, { id: 'c2', at: at(12), cls: 'chat', session: 'f/new' })
    w.ledger.close('c2', 'done', iso(at(13)))
    w.records.set('f/old', [rec('m1', at(10, 10))])
    w.records.set('f/new', [rec('m1', at(10, 10)), rec('m2', at(12, 10))]) // m1 copied by the resume
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'conversation' })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.tokens.in).toBe(200)
    expect(r.rows[0]!.turns).toBe(2)
  })

  it("subagents and a nested session fall in the parent's window by their time", async () => {
    const w = world()
    w.metas.push(meta('f', 'p'), meta('f', 'n'))
    w.nested.set('n', 'p') // its birth marker names the parent
    open(w, { id: 'run1', at: at(10), cls: 'run', session: 'f/p', automation: 'mine', run: 'r1' })
    w.ledger.close('run1', 'done', iso(at(10, 40)))
    w.records.set('f/p', [rec('m1', at(10, 1)), rec('sub1', at(10, 5), 0.01, 'agent-abc')])
    w.records.set('f/n', [rec('n1', at(10, 20), 0.01, 'n')])
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'automation' })
    expect(r.rows.map((x) => [x.key, x.tokens.in])).toEqual([['automation:mine', 300]])
    expect(r.rows.find((x) => x.key === 'unattributed')).toBeUndefined()
  })

  it('what falls in no window is never guessed: «Unattributed» with its conversation, «before <date>» before the register', async () => {
    const w = world()
    w.metas.push(meta('f', 's'), meta('f', 'hand'))
    open(w, { id: 'c1', at: at(10), cls: 'chat', session: 'f/s' })
    w.ledger.close('c1', 'done', iso(at(10, 30)))
    w.records.set('f/s', [rec('early', at(8)), rec('in', at(10, 5))])
    w.records.set('f/hand', [rec('h1', at(15))]) // a conversation no window names
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    const keys = r.rows.map((x) => x.key)
    expect(keys).toEqual(['agent:a1', 'unattributed', 'before'])
    const un = r.rows.find((x) => x.key === 'unattributed')!
    expect(un.children?.map((c) => c.ref)).toEqual([{ folder: 'f', id: 'hand' }])
    expect(un.costUsd).toBeNull() // no window: no provider, no dollars
    const before = r.rows.find((x) => x.key === 'before')!
    expect(before.label).toBe(`before ${localYmd(at(10))}`)
    expect(before.children).toBeUndefined() // «before», whole, without class
    expect(r.series.find((d) => d.day === localYmd(at(10)))!.classes).toMatchObject({ 'with-you': 200, unattributed: 200, before: 200 })
  })

  it('the titler goes to «Silos itself»', async () => {
    const w = world()
    w.own.push(rec('t1', at(10), 0.001, 'titler'))
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    expect(r.rows.map((x) => [x.key, x.label])).toEqual([['silos', 'Silos itself']])
  })

  it('a turn on a plan shows no dollars — tokens and «on plan»; a priced provider shows its money', async () => {
    const w = world()
    w.metas.push(meta('f', 'p1'), meta('f', 'p2'))
    open(w, { id: 'plan', at: at(10), cls: 'chat', session: 'f/p1' })
    w.ledger.close('plan', 'done', iso(at(11)))
    open(w, { id: 'api', at: at(10), cls: 'chat', session: 'f/p2', priced: true })
    w.ledger.close('api', 'done', iso(at(11)))
    w.records.set('f/p1', [rec('a', at(10, 1), 0.5)])
    w.records.set('f/p2', [rec('b', at(10, 1), 0.25), rec('c', at(10, 2), null)])
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'account' })
    const plan = r.rows.find((x) => x.key === 'account:default')!
    const api = r.rows.find((x) => x.key === 'account:api')!
    expect(plan).toMatchObject({ costUsd: null, plan: true })
    expect(plan.tokens.in).toBe(100)
    expect(api).toMatchObject({ costUsd: 0.25, plan: false, unpriced: 1 })
    expect(r.priced).toEqual([{ provider: 'api', label: 'api', costUsd: 0.25 }])
    expect(r.accounts.map((a) => a.account)).toEqual(['default'])
  })

  it("an engine that can't say is «not measured on <engine>» — its turns counted, no tokens invented", async () => {
    const w = world()
    w.metas.push(meta('f', 'o1', { harness: 'other' } as Partial<SessionMeta>))
    w.records.set('f/o1', 'unmeasured')
    open(w, { id: 'o', at: at(10), cls: 'chat', session: 'f/o1' })
    w.ledger.close('o', 'done', iso(at(11)))
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    expect(r.notMeasured).toEqual(['Other Engine'])
    expect(r.rows[0]).toMatchObject({ key: 'agent:a1', turns: 1, notMeasured: ['Other Engine'] })
    expect(r.rows[0]!.tokens.in).toBe(0)
  })

  it('one day rule: a turn across midnight counts the day it opened — in the rows, the bars and the caps; what fell in no window, its own day', async () => {
    const w = world(at(23) + 24 * 3600_000)
    w.metas.push(meta('f', 'late', { mtime: at(24, 30) }), meta('f', 'loose', { mtime: at(24, 30) }))
    open(w, { id: 'late', at: at(23, 50), cls: 'wake', session: 'f/late', gesture: false, priced: true })
    w.ledger.close('late', 'done', iso(at(24, 20)))
    w.records.set('f/late', [rec('a', at(23, 55), 0.1), rec('b', at(24, 10), 0.2)])
    w.records.set('f/loose', [rec('x', at(24, 5))])
    const svc = new UsageService(w.deps)
    const today = await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    expect(today.rows.find((r) => r.key === 'agent:a1')!.tokens.in).toBe(200) // both records, the day it opened
    expect(today.rows.find((r) => r.key === 'unattributed')).toBeUndefined()
    const next = await svc.report({ from: DAY_TO, to: DAY_TO + 24 * 3600_000, by: 'agent' })
    expect(next.rows.map((r) => r.key)).toEqual(['unattributed']) // the loose record goes by its own time
    const week = await svc.report({ from: DAY_FROM, to: DAY_TO + 24 * 3600_000, by: 'agent' })
    expect(week.series.map((d) => [d.day, d.classes.task ?? 0])).toEqual([
      [localYmd(at(10)), 400],
      [localYmd(at(24, 1)), 0],
    ])
  })

  it('a console is the exception: open three days, its records of today show in Today (and its old ones on their days)', async () => {
    const w = world()
    w.metas.push(meta('f', 'k'))
    const threeAgo = at(9) - 3 * 24 * 3600_000
    w.ledger.open({
      id: consoleWindowId('k', threeAgo),
      at: iso(threeAgo),
      class: 'console',
      agentId: 'a1',
      session: { folder: 'f', id: 'k' },
      provider: 'default',
      account: 'default',
      priced: false,
    })
    w.records.set('f/k', [rec('old', threeAgo + 60_000), rec('now1', at(10)), rec('now2', at(11))])
    const svc = new UsageService(w.deps)
    const today = await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'kind' })
    expect(today.rows.map((r) => [r.key, r.tokens.in])).toEqual([['console', 200]])
    expect(today.series.map((d) => d.classes['with-you'])).toEqual([400])
    const week = await svc.report({ from: DAY_FROM - 3 * 24 * 3600_000, to: DAY_TO, by: 'kind' })
    expect(week.series.find((d) => d.day === localYmd(threeAgo))!.classes['with-you']).toBe(200)
  })

  it('a proactive round (q3) is a heartbeat with its class: the «Heartbeat» row, «Heartbeat · round» by kind', async () => {
    const w = world()
    w.metas.push(meta('f', 'r'))
    const svc = new UsageService(w.deps)
    svc.turnOpened({
      turnId: 'round1',
      agentId: 'a1',
      folder: 'f',
      sessionId: 'r',
      turn: { class: 'heartbeat', kind: 'round', automationId: 'heartbeat-a1', runId: 'run-round1' },
      provider: null,
    })
    expect(w.ledger.get('round1')?.kind).toBe('round')
    w.ledger.close('round1', 'done', iso(at(23, 30)))
    w.records.set('f/r', [rec('m', at(23, 10))])
    const byKind = await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'kind' })
    expect(byKind.rows.map((r) => [r.key, r.label])).toEqual([['heartbeat:round', 'Heartbeat · round']])
    const byAgent = await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    expect(byAgent.rows[0]!.children!.map((c) => c.label)).toEqual(['Heartbeat'])
  })

  it('By conversation: each row says its agent — two conversations with one title are told apart', async () => {
    const w = world()
    w.metas.push(meta('f', 'c1', { title: 'Fix the build' }), meta('f', 'c2', { title: 'Fix the build' }))
    open(w, { id: 't1', at: at(10), cls: 'chat', session: 'f/c1', agent: 'a1' })
    w.ledger.close('t1', 'done', iso(at(11)))
    open(w, { id: 't2', at: at(10), cls: 'chat', session: 'f/c2', agent: 'b2' })
    w.ledger.close('t2', 'done', iso(at(11)))
    w.records.set('f/c1', [rec('m1', at(10, 5))])
    w.records.set('f/c2', [rec('m2', at(10, 5), 0.01, 's', 300)])
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'conversation' })
    expect(r.rows.map((x) => [x.label, x.agents])).toEqual([
      ['Fix the build', ['B2']],
      ['Fix the build', ['A1']],
    ])
    // …and what tells them apart: the classes they ran as and the server's day
    expect(r.rows.map((x) => [x.classes, x.day])).toEqual([
      [['with-you'], localYmd(at(10))],
      [['with-you'], localYmd(at(10))],
    ])
  })

  it('a console is said as a console, never as a count of turns', async () => {
    const w = world()
    w.metas.push(meta('f', 'k'))
    w.ledger.open({
      id: consoleWindowId('k', at(9)),
      at: iso(at(9)),
      class: 'console',
      agentId: 'a1',
      session: { folder: 'f', id: 'k' },
      provider: 'default',
      account: 'default',
      priced: false,
    })
    open(w, { id: 'wk', at: at(11), cls: 'wake', session: 'f/k', task: 't' })
    w.ledger.close('wk', 'done', iso(at(11, 30)))
    w.records.set('f/k', [rec('a', at(10)), rec('b', at(11, 5))])
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'conversation' })
    expect(r.rows[0]).toMatchObject({ turns: 2, consoles: 1, classes: ['with-you', 'task'] })
    expect(r.totals).toMatchObject({ turns: 2, consoles: 1 })
  })

  it('pure: a record exactly at the close is inside; the latest-opened window holds an overlap', () => {
    const win = (id: string, a: number, c?: number) => ({
      window: {
        id,
        at: iso(a),
        ...(c !== undefined ? { closedAt: iso(c) } : {}),
        class: 'chat' as const,
        agentId: 'a',
        session: { folder: 'f', id: 's' },
        provider: 'p',
        priced: false,
      },
      threadKey: 'T',
    })
    const out = attribute({
      windows: [win('outer', at(9)), win('inner', at(10), at(11))],
      conversations: [{ sessionKey: 'f/s', threadKey: 'T', records: [rec('x', at(11)), rec('y', at(11, 1))] }],
      since: at(9),
      from: DAY_FROM,
      to: DAY_TO,
    })
    expect(out.map((a) => a.window?.id)).toEqual(['inner', 'outer'])
  })
})

describe('nothing a window holds vanishes from Usage (B)', () => {
  it('a turn whose conversation is no longer listed — hidden or trashed — still counts under its agent, its row «Hidden conversation» without title or path', async () => {
    const w = world()
    // the index does NOT list f/gone-from-list (muted folder, or trashed): the reader still reads it by {folder, id}
    open(w, { id: 't1', at: at(10), cls: 'wake', session: 'f/gone-from-list', task: 'k' })
    w.ledger.close('t1', 'done', iso(at(10, 30)))
    w.records.set('f/gone-from-list', [rec('m1', at(10, 5))])
    const svc = new UsageService(w.deps)
    const byAgent = await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    expect(byAgent.rows.map((r) => [r.key, r.tokens.in, r.turns])).toEqual([['agent:a1', 100, 1]])
    const byConv = await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'conversation' })
    expect(byConv.rows).toHaveLength(1)
    expect(byConv.rows[0]).toMatchObject({ label: 'Hidden conversation', hidden: true, agents: ['A1'] })
    expect(byConv.rows[0]!.ref).toBeUndefined()
  })

  it('a window whose transcript is gone stays a counted turn: «not measured — its transcript is gone»', async () => {
    const w = world()
    open(w, { id: 't2', at: at(10), cls: 'chat', session: 'f/purged' }) // no records anywhere
    w.ledger.close('t2', 'done', iso(at(10, 30)))
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    expect(r.totals.turns).toBe(1)
    expect(r.gone).toBe(1)
    expect(r.rows[0]).toMatchObject({ key: 'agent:a1', turns: 1, gone: 1 })
    expect(r.rows[0]!.tokens.in).toBe(0)
    // a "Nothing ran today" never hides it
    expect(r.rows.length).toBeGreaterThan(0)
  })

  it("Claude Code's reader reads a trashed transcript (and its subagents) from the trash while it is there", async () => {
    const { trashTranscript } = await import('../src/harnesses/claude-code/trash.js')
    const root = mkdtempSync(join(tmpdir(), 'usage-trash-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'usage-trash-data-'))
    mkdirSync(join(root, 'proj', 's9', 'subagents'), { recursive: true })
    const line = (id: string, ts: string): string =>
      JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 5 } } })
    writeFileSync(join(root, 'proj', 's9.jsonl'), line('msg_a', '2026-11-11T10:00:01Z') + '\n')
    writeFileSync(join(root, 'proj', 's9', 'subagents', 'agent-q.jsonl'), line('msg_b', '2026-11-11T10:00:02Z') + '\n')
    const reader = new ClaudeReader(root, join(root, 'cache.json'), [], null, join(dataDir, 'trash'))
    expect((await reader.usageRecords('proj', 's9'))?.map((r) => r.id)).toEqual(['msg_a', 'msg_b'])
    await trashTranscript(root, dataDir, 'proj', 's9')
    expect((await reader.usageRecords('proj', 's9'))?.map((r) => r.id)).toEqual(['msg_a', 'msg_b'])
    expect(await reader.usageRecords('proj', 'never')).toBeNull()
  })
})

describe('«Silos itself» and «Unattributed» carry their money (G)', () => {
  it("priced by the conversation's provider when known, else the machine's default; a plan stays without dollars", async () => {
    const w = world()
    w.metas.push(meta('f', 'api-conv'), meta('f', 'loose'))
    // a conversation on a priced provider: a turn, then a record outside it
    open(w, { id: 't', at: at(10), cls: 'chat', session: 'f/api-conv', priced: true, provider: 'api' })
    w.ledger.close('t', 'done', iso(at(10, 30)))
    w.records.set('f/api-conv', [rec('in', at(10, 5), 0.5), rec('after', at(12), 0.25)])
    w.records.set('f/loose', [rec('l', at(13), 0.1)]) // no window ever: the machine's default
    w.own.push(rec('titler', at(14), 0.05, 'titler'))
    const pricedDefault = new UsageService({
      ...w.deps,
      defaultProvider: () => ({ id: 'gw', kind: 'anthropic-compatible', label: 'Gateway', baseUrl: 'x', apiKey: 'k' }) as never,
    })
    const r = await pricedDefault.report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    const un = r.rows.find((x) => x.key === 'unattributed')!
    expect(un.costUsd).toBeCloseTo(0.25 + 0.1)
    expect(r.rows.find((x) => x.key === 'silos')!.costUsd).toBeCloseTo(0.05)
    expect(r.totals.costUsd).toBeCloseTo(0.5 + 0.25 + 0.1 + 0.05) // nothing missing from the totals
    expect(Object.fromEntries(r.priced.map((p) => [p.provider, p.costUsd]))).toEqual({ api: 0.75, gw: 0.15 })
    // the machine on a plan: the loose record and the titler show no dollars
    const plan = await new UsageService({
      ...w.deps,
      defaultProvider: () => ({ id: 'default', kind: 'claude-account', label: 'Claude', configDir: null }) as never,
    }).report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    expect(plan.rows.find((x) => x.key === 'silos')).toMatchObject({ costUsd: null, plan: true })
    expect(plan.rows.find((x) => x.key === 'unattributed')!.costUsd).toBeCloseTo(0.25) // its conversation's provider still prices
  })
})

describe('totals and the cut to 20 add up (H)', () => {
  it('totals say their unpriced records; By conversation keeps 20 and folds the rest into «N more conversations» with their sum', async () => {
    const w = world()
    for (let i = 0; i < 23; i++) {
      w.metas.push(meta('f', `c${i}`))
      open(w, { id: `t${i}`, at: at(10), cls: 'chat', session: `f/c${i}`, priced: true })
      w.ledger.close(`t${i}`, 'done', iso(at(11)))
      w.records.set(`f/c${i}`, [rec(`m${i}`, at(10, 5), i === 22 ? null : 0.01, 's', 100 + i)])
    }
    const r = await new UsageService(w.deps).report({ from: DAY_FROM, to: DAY_TO, by: 'conversation' })
    expect(r.totals.unpriced).toBe(1)
    expect(r.rows).toHaveLength(21)
    const more = r.rows[20]!
    expect(more).toMatchObject({ key: 'more', label: '3 more conversations', turns: 3 })
    const sum = (k: 'in' | 'out') => r.rows.reduce((n, x) => n + x.tokens[k], 0)
    expect(sum('in')).toBe(r.totals.tokens.in)
    expect(r.rows.reduce((n, x) => n + x.turns, 0)).toBe(r.totals.turns)
    expect(r.rows.reduce((n, x) => n + (x.costUsd ?? 0), 0)).toBeCloseTo(r.totals.costUsd!)
  })
})

describe('a console alive without a window gets one at the listing (D)', () => {
  it('a console launched before the register opens its window at the listing; what it used before stays unattributed; one is never opened twice', async () => {
    const w = world(at(12))
    w.metas.push(meta('f', 'old-console'))
    // the owner's console, alive since before the ledger: records before and after the listing
    w.records.set('f/old-console', [rec('before', at(11)), rec('after', at(13))])
    open(w, { id: 'seed', at: at(8), cls: 'chat', session: 'f/other' }) // the register exists since 08:00
    w.ledger.close('seed', 'done', iso(at(8, 5)))
    const svc = new UsageService(w.deps)
    let asked = 0
    const adopt = (key: string) => {
      asked++
      return key === 'old-console' ? { agentId: 'a1', folder: 'f', sessionId: 'old-console', provider: null } : null
    }
    svc.consolesAlive(new Set(['old-console', 'unknown']), adopt)
    expect(w.ledger.openConsoles().map((c) => [c.id, c.at])).toEqual([[consoleWindowId('old-console', at(12)), iso(at(12))]])
    svc.consolesAlive(new Set(['old-console', 'unknown']), adopt)
    expect(w.ledger.openConsoles()).toHaveLength(1) // never twice
    expect(asked).toBe(3) // the windowed console is not asked again
    const r = await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'kind' })
    expect(r.rows.find((x) => x.key === 'console')?.tokens.in).toBe(100) // the record after the listing
    expect(r.rows.find((x) => x.key === 'unattributed')?.tokens.in).toBe(100) // the one before: never guessed
  })
})

describe("a window's class is sealed when it opens (F)", () => {
  it('deleting or accepting an automation later never rewrites a past day', async () => {
    const w = world()
    w.metas.push(meta('f', 'r1'), meta('f', 'r2'))
    const svc = new UsageService(w.deps)
    svc.turnOpened({
      turnId: 'run-own',
      agentId: 'a1',
      folder: 'f',
      sessionId: 'r1',
      turn: { class: 'run', automationId: 'mine', runId: 'x1' },
      provider: null,
    })
    svc.turnOpened({
      turnId: 'run-yours',
      agentId: 'a1',
      folder: 'f',
      sessionId: 'r2',
      turn: { class: 'run', automationId: 'yours', runId: 'x2' },
      provider: null,
    })
    expect(w.ledger.get('run-own')?.runOf).toBe('own')
    expect(w.ledger.get('run-yours')?.runOf).toBe('yours')
    w.ledger.close('run-own', 'done', iso(at(23, 30)))
    w.ledger.close('run-yours', 'done', iso(at(23, 30)))
    w.records.set('f/r1', [rec('m1', at(23, 10))])
    w.records.set('f/r2', [rec('m2', at(23, 10))])
    const before = await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    // the owner accepts «mine» and deletes «yours»
    w.automations.mine = { ...w.automations.mine, accepted: true }
    delete (w.automations as Record<string, unknown>).yours
    const after = await new UsageService({ ...w.deps, ledger: new UsageLedger(join(w.dir, 'usage')) }).report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    const kids = (r: typeof before) => Object.fromEntries(r.rows[0]!.children!.map((c) => [c.key, { turns: c.turns, outsideMax: c.outsideMax ?? 0 }]))
    expect(kids(after)).toEqual(kids(before))
    expect(kids(after)).toEqual({ 'own-automation': { turns: 1, outsideMax: 0 }, 'your-automation': { turns: 1, outsideMax: 1 } })
  })
})

describe('turn windows: failed, timed out, cut by a restart — one money', () => {
  it("a turn that never said its price gets its transcript's, written where own-turns reads it", async () => {
    const w = world()
    w.metas.push(meta('f', 's'))
    w.records.set('f/s', [rec('m1', at(10, 1), 0.2), rec('m2', at(10, 2), 0.3)])
    const svc = new UsageService(w.deps)
    w.ledger.open({
      id: 'turn1',
      at: iso(at(10)),
      class: 'wake',
      agentId: 'a1',
      session: { folder: 'f', id: 's' },
      provider: 'api',
      priced: true,
      taskKey: 'k',
    })
    svc.turnClosed('turn1', 'failed', false)
    await new Promise((r) => setTimeout(r, 20))
    expect(w.ledger.get('turn1')?.outcome).toBe('failed')
    expect(w.writes).toEqual([{ id: 'turn1', cost: 0.5 }])
  })

  it("a timeout is the resident's word: stamped before the cancel, the window closes `timeout` when the turn ends", async () => {
    const w = world()
    const svc = new UsageService(w.deps)
    open(w, { id: 'turn2', at: at(10), cls: 'run', automation: 'mine', run: 'r2' })
    svc.markTimeout('turn2')
    svc.turnClosed('turn2', 'cancelled', true)
    expect(w.ledger.get('turn2')?.outcome).toBe('timeout')
  })

  it("a turn a restart cut closes `interrupted` at its conversation's last record; a console window survives the restart", async () => {
    const w = world()
    w.metas.push(meta('f', 's'))
    open(w, { id: 'cut', at: at(10), cls: 'heartbeat', automation: 'heartbeat-a1', run: 'r9' })
    w.ledger.open({
      id: consoleWindowId('k', at(9)),
      at: iso(at(9)),
      class: 'console',
      agentId: 'a1',
      session: { folder: 'f', id: 'k' },
      provider: 'default',
      priced: false,
    })
    w.records.set('f/s', [rec('m1', at(10, 3), 0.1), rec('m2', at(10, 7), 0.1)])
    // the next process
    const ledger = new UsageLedger(join(w.dir, 'usage'))
    const svc = new UsageService({ ...w.deps, ledger })
    expect(await svc.closeInterrupted()).toBe(1)
    expect(ledger.get('cut')).toMatchObject({ outcome: 'interrupted', closedAt: iso(at(10, 7)) })
    expect(ledger.openConsoles().map((c) => c.id)).toEqual([consoleWindowId('k', at(9))])
    await new Promise((r) => setTimeout(r, 20))
    expect(w.writes.map((x) => x.id)).toEqual(['cut'])
    // and the console closes once its tmux is found gone
    svc.consolesAlive(new Set(['other']))
    expect(ledger.openConsoles()).toEqual([])
  })

  it('a closed run gets the transcript cost once — never over a price it said, never moving «the latest run»', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-runs-'))
    const store = new AutomationsStore(dir)
    store.appendRun('au', { id: 'r1', automationId: 'au', at: iso(at(9)), status: 'running' })
    expect(store.patchRunCost('au', 'r1', { costUsd: 0.4, priced: true })).toBe('later')
    store.appendRun('au', { id: 'r1', automationId: 'au', at: iso(at(9)), status: 'failed', error: 'timeout', costUsd: null })
    store.appendRun('au', { id: 'r2', automationId: 'au', at: iso(at(10)), status: 'ok', costUsd: 0.1 })
    expect(store.patchRunCost('au', 'r1', { costUsd: 0.4, priced: true })).toBe('done')
    expect(store.listRuns('au').find((r) => r.id === 'r1')).toMatchObject({ costUsd: 0.4, priced: true, status: 'failed' })
    expect(store.latestRun('au')?.id).toBe('r2')
    expect(store.listRuns('au').map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(store.patchRunCost('au', 'r2', { costUsd: 9, priced: true })).toBe('skip')
  })
})

describe("the caps' rows: one source per row", () => {
  // a wake own-turns counted that Usage never saw (no window: before the
  // register, a lost line), a turn on a plan, a heartbeat, an accepted run:
  // whatever the mix, the head and the line under it are the same records
  const runsOf: Record<string, Array<{ id: string; automationId: string; at: string; status: 'ok' | 'running'; costUsd?: number | null; priced?: boolean }>> = {
    'heartbeat-a1': [{ id: 'h1', automationId: 'heartbeat-a1', at: iso(at(9)), status: 'ok', costUsd: 1.9 }],
    mine: [
      { id: 'm1', automationId: 'mine', at: iso(at(9)), status: 'ok', costUsd: 0.25 },
      { id: 'm2', automationId: 'mine', at: iso(at(11)), status: 'ok', costUsd: 0.5, priced: false },
    ],
    acc: [{ id: 'x1', automationId: 'acc', at: iso(at(9)), status: 'ok', costUsd: 0.15 }],
  }
  const autos = [
    { id: 'heartbeat-a1', agentId: 'a1', origin: 'self' },
    { id: 'mine', agentId: 'a1', origin: 'self' },
    { id: 'acc', agentId: 'a1', origin: 'self', acceptedFrom: 'o' },
  ]
  const deps = {
    automations: { list: () => autos, listRuns: (id: string) => runsOf[id] ?? [], get: () => undefined } as never,
    wakesToday: () => ({ charged: 3, costUsd: 4.6, unpriced: 0, turnIds: ['w1', 'w2', 'w-unseen'] }),
  }

  it('the head and its breakdown add up — starts by kind sum to the count, spend by kind to the money', () => {
    const t = ownTurnsToday(deps, { id: 'a1' }, at(12))
    expect(t.used).toBe(3 + 2) // 3 wakes + 2 own runs (the accepted one is outside the max)
    expect(t.starts).toEqual({ wakes: 3, self: 2 })
    expect(t.starts!.wakes + t.starts!.self).toBe(t.used)
    expect(t.spent!.wakes + t.spent!.heartbeat + t.spent!.self).toBeCloseTo(t.costUsd)
    expect(t.spent!.wakes).toBeCloseTo(4.6)
    expect(t.spent!.heartbeat).toBeCloseTo(1.9)
    expect(t.spent!.self).toBeCloseTo(0.25 + 0.15) // the plan run is no money
  })

  it("the row's head says what happened: the count used, even above a lowered max", async () => {
    const { ownTurnsCeilingRow } = await import('../src/inbox.js')
    const r = ownTurnsCeilingRow({
      agentId: 'a1',
      agentName: 'A1',
      used: 8,
      perDay: 5,
      waiting: 0,
      until: 'x',
      day: localYmd(at(12)),
      now: at(12),
      cap: 'ceiling',
      starts: { wakes: 6, self: 2 },
    })
    expect(r.voice).toBe('A1 started 8 times without you today — its max is 5')
    expect(r.why).toMatch(/^6 task starts · 2 runs of its own automations\./)
  })

  it('Usage no longer answers for the caps (no second reader, no periodic gather)', () => {
    const svc = new UsageService(world().deps) as unknown as Record<string, unknown>
    expect(svc.ownDay).toBeUndefined()
    expect(svc.computeOwnDay).toBeUndefined()
  })
})

describe('a thread is its whole chain (thread-tools.ts threadRootKey)', () => {
  it('twelve /clear rotations in one console stay one thread — the root, never the 9th ancestor; a cycle ends the walk', () => {
    // s0 ← s1 ← … ← s12: each rotation's continuation parent is the one before
    const parent = new Map<string, string>()
    for (let i = 1; i <= 12; i++) parent.set(`s${i}`, `s${i - 1}`)
    const lineage = {
      continuationParentIdOf: (id: string) => parent.get(id) ?? null,
      parentIdOf: (id: string) => parent.get(id) ?? null,
      folderOfKnown: () => 'f',
    } as never
    const metas = new Map(Array.from({ length: 13 }, (_, i) => [`s${i}`, meta('f', `s${i}`)]))
    const ancestry = makeAncestry({ lineage, metaById: (id) => metas.get(id) ?? null })
    const root = makeThreadRootKey({ ancestry, lineage, metaById: (id) => metas.get(id) ?? null })
    expect(root(metas.get('s12')!)).toBe('f/s0')
    expect(root(metas.get('s3')!)).toBe('f/s0')
    // a caller's own lookup is used for the walk
    let asked = 0
    expect(
      root(metas.get('s12')!, (id) => {
        asked++
        return metas.get(id) ?? null
      }),
    ).toBe('f/s0')
    expect(asked).toBeGreaterThan(0)
    parent.set('s0', 's12') // a cycle: the walk stops where it began
    expect(root(metas.get('s1')!)).toMatch(/^f\/s\d+$/)
  })
})

describe("one day, the server's (I)", () => {
  it('the page asks for a named period; the server computes its range from its own local midnight and names its days', async () => {
    const Fastify = (await import('fastify')).default
    const { usageRoutes } = await import('../src/routes/usage.js')
    const asked: Array<{ from: number; to: number }> = []
    const app = Fastify()
    usageRoutes(app, {
      now: () => at(15),
      usage: {
        report: async (q) => {
          asked.push({ from: q.from, to: q.to })
          return { ok: true } as never
        },
      },
    })
    for (const p of ['today', '7d', '30d']) expect((await app.inject({ method: 'GET', url: `/api/usage?period=${p}&by=agent` })).statusCode).toBe(200)
    expect(asked.map((q) => q.from)).toEqual([
      at(0),
      new Date(DAY.getFullYear(), DAY.getMonth(), DAY.getDate() - 6).getTime(),
      new Date(DAY.getFullYear(), DAY.getMonth(), DAY.getDate() - 29).getTime(),
    ])
    expect(asked.every((q) => q.to > at(15) - 1 && q.to <= at(15) + 1)).toBe(true)
    expect((await app.inject({ method: 'GET', url: '/api/usage?period=week' })).statusCode).toBe(400)
    const w = world(at(15))
    const r = await new UsageService(w.deps).report({ from: at(0), to: at(15), by: 'agent' })
    expect(r.today).toBe(localYmd(at(15)))
    expect(r.sinceDay).toBeNull()
    open(w, { id: 'x', at: at(9), cls: 'chat' })
    expect((await new UsageService(w.deps).report({ from: at(0), to: at(15), by: 'agent' })).sinceDay).toBe(localYmd(at(9)))
  })
})

describe('who reads Usage', () => {
  it("never a bearer: /api/usage is outside an agent's reads", () => {
    expect(agentMayRead('a1', '/api/usage')).toBe(false)
    expect(agentMayRead('a1', '/api/usage?by=agent&agent=a1')).toBe(false)
    expect(agentMayRead('a1', '/api/%75sage')).toBe(false)
  })
})

describe("Claude Code's usage records (contract.ts usageRecords)", () => {
  it('one record per message id (the first line with usage), subagents included, <synthetic> skipped, read incrementally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usage-claude-'))
    mkdirSync(join(root, 'proj', 's1', 'subagents'), { recursive: true })
    const line = (id: string, ts: string, model = 'claude-haiku-4-5', inTok = 10): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: { id, model, usage: { input_tokens: inTok, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      })
    const main = join(root, 'proj', 's1.jsonl')
    writeFileSync(
      main,
      [
        JSON.stringify({ type: 'user', timestamp: '2026-11-11T10:00:00Z', message: { content: 'hi' } }),
        line('msg_1', '2026-11-11T10:00:01Z'),
        line('msg_1', '2026-11-11T10:00:02Z'), // the same bill, another content block
        line('msg_s', '2026-11-11T10:00:03Z', '<synthetic>'),
      ].join('\n') + '\n',
    )
    writeFileSync(join(root, 'proj', 's1', 'subagents', 'agent-ab1.jsonl'), line('msg_sub', '2026-11-11T10:00:04Z') + '\n')
    const reader = new ClaudeReader(root, join(root, 'cache.json'))
    const first = await reader.usageRecords('proj', 's1')
    expect(first?.map((r) => [r.id, r.session])).toEqual([
      ['msg_1', 's1'],
      ['msg_sub', 'agent-ab1'],
    ])
    expect(first![0]!.costUsd).toBeGreaterThan(0)
    expect(first![0]!.tokens).toEqual({ in: 10, out: 5, cacheRead: 0, cacheWrite: 0 })
    writeFileSync(main, readFileSync(main, 'utf8') + line('msg_2', '2026-11-11T10:01:00Z', 'model-without-price') + '\n')
    const second = await reader.usageRecords('proj', 's1')
    expect(second?.map((r) => r.id)).toEqual(['msg_1', 'msg_2', 'msg_sub'])
    expect(second![1]!.costUsd).toBeNull()
    expect(await reader.usageRecords('proj', 'missing')).toBeNull()
  })
})

describe('reading cost stays bounded (J)', () => {
  it('the file cache forgets the least recently read files past its cap — and reads them again whole when asked', async () => {
    const { UsageFileCache } = await import('../src/harnesses/claude-code/usage-records.js')
    const dir = mkdtempSync(join(tmpdir(), 'usage-lru-'))
    const line = (id: string): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T10:00:00Z',
        message: { id, model: 'claude-haiku-4-5', usage: { input_tokens: 1, output_tokens: 1 } },
      })
    for (const f of ['a', 'b', 'c']) writeFileSync(join(dir, `${f}.jsonl`), `${line(`${f}1`)}\n${line(`${f}2`)}\n`)
    const cache = new UsageFileCache(3)
    await cache.read(join(dir, 'a.jsonl'), 'a')
    await cache.read(join(dir, 'b.jsonl'), 'b')
    expect(cache.size).toBe(2) // a forgotten
    await cache.read(join(dir, 'a.jsonl'), 'a') // read again whole
    expect((await cache.read(join(dir, 'a.jsonl'), 'a'))?.map((r) => r.id)).toEqual(['a1', 'a2'])
    await cache.read(join(dir, 'c.jsonl'), 'c')
    expect(cache.size).toBeLessThanOrEqual(3 + 1)
    expect((await cache.read(join(dir, 'b.jsonl'), 'b'))?.map((r) => r.id)).toEqual(['b1', 'b2'])
  })

  it("a read walks each thread with the read's own lookup, never the index per ancestor", async () => {
    const w = world()
    w.metas.push(meta('f', 's'))
    open(w, { id: 't', at: at(10), cls: 'chat', session: 'f/s' })
    w.ledger.close('t', 'done', iso(at(11)))
    w.records.set('f/s', [rec('m', at(10, 5))])
    let lookups = 0
    let allCalls = 0
    const svc = new UsageService({
      ...w.deps,
      sessions: {
        ...w.deps.sessions,
        all: () => {
          allCalls++
          return w.metas
        },
      },
      threadKeyOf: (m, lookup) => {
        lookups++
        expect(lookup('s')).toBe(w.metas[0])
        return `${m.folder}/${m.id}`
      },
    })
    await svc.report({ from: DAY_FROM, to: DAY_TO, by: 'agent' })
    expect(allCalls).toBe(1) // one listing per read
    expect(lookups).toBe(1) // one walk per session (memoised)
  })
})

describe("ChatService opens a turn's window at chat-init and closes it at its end", () => {
  it('done, failed and cancelled — a turn that never reached chat-init opens nothing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'usage-chat-'))
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'cl', name: 'Cl', folder: join(base, 'proj') })
    const native = new NativeStore(join(base, 'native.json'))
    const seen: Array<[string, string, ...unknown[]]> = []
    const usage = {
      turnOpened: (t: { turnId: string; sessionId: string; turn: { class: string } }) => {
        seen.push(['open', t.turnId, t.sessionId, t.turn.class])
      },
      turnClosed: (id: string, outcome: string, chatDone: boolean) => {
        seen.push(['close', id, outcome, chatDone])
      },
    }
    let script: SdkMessage[] = []
    const queryFn = (() => ({
      async *[Symbol.asyncIterator]() {
        for (const m of script) yield m
      },
      async interrupt() {
        return undefined
      },
    })) as unknown as QueryFn
    const chat = new ChatService({ registry, native, queryFn, usage })
    const drain = async (it: AsyncGenerator<ChatEvent>): Promise<void> => {
      try {
        for await (const _ of it) {
          /* drain */
        }
      } catch {
        /* a failed turn */
      }
    }
    const init = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm' } as unknown as SdkMessage
    script = [init, { type: 'result', subtype: 'success', total_cost_usd: 0.1 } as unknown as SdkMessage]
    await drain(chat.send({ turnId: 't-ok', agentId: 'cl', text: 'x' }))
    script = [init, { type: 'result', subtype: 'error_during_execution' } as unknown as SdkMessage]
    await drain(chat.send({ turnId: 't-bad', agentId: 'cl', text: 'x', unattended: true, turn: { class: 'wake', taskKey: 'k' } }))
    script = [{ type: 'result', subtype: 'success' } as unknown as SdkMessage]
    await drain(chat.send({ turnId: 't-none', agentId: 'cl', text: 'x' }))
    expect(seen).toEqual([
      ['open', 't-ok', 'sess-1', 'chat'],
      ['close', 't-ok', 'done', true],
      ['open', 't-bad', 'sess-1', 'wake'],
      ['close', 't-bad', 'failed', true],
    ])
  })
})

describe('the day bars follow By agent (q4 t46)', () => {
  it("each day splits its windowed tokens by agent — adding up to the windowed classes; what is no one's stays in the classes only", async () => {
    const w = world()
    const yesterday = (h: number): number => at(h) - 24 * 3600_000
    w.metas.push(meta('f', 'x', { startedAt: yesterday(1) }), meta('f', 'y'), meta('f', 'loose'))
    open(w, { id: 'x1', at: yesterday(10), cls: 'chat', session: 'f/x', agent: 'a1' })
    w.ledger.close('x1', 'done', iso(yesterday(11)))
    open(w, { id: 'x2', at: at(10), cls: 'wake', session: 'f/x', agent: 'a1', task: 'k' })
    w.ledger.close('x2', 'done', iso(at(11)))
    open(w, { id: 'y1', at: at(12), cls: 'run', session: 'f/y', agent: 'b2', automation: 'yours', run: 'r' })
    w.ledger.close('y1', 'done', iso(at(13)))
    // an agent no longer in the registry: still counted, under its id
    open(w, { id: 'z1', at: at(14), cls: 'heartbeat', session: 'f/y', agent: 'gone-agent' })
    w.ledger.close('z1', 'done', iso(at(15)))
    w.records.set('f/x', [rec('m1', yesterday(10), 0.01, 's', 50), rec('m2', at(10, 5))])
    w.records.set('f/y', [rec('m3', at(12, 5), 0.01, 's', 300), rec('m4', at(14, 5), 0.01, 's', 25)])
    w.records.set('f/loose', [rec('m5', at(16), 0.01, 's', 70)])
    w.own.push(rec('t1', at(17), 0.001, 'titler', 5))
    const svc = new UsageService(w.deps)
    const r = await svc.report({ from: yesterday(0), to: DAY_TO, by: 'agent' })
    const days = Object.fromEntries(r.series.map((d) => [d.day, d]))
    expect(days[localYmd(yesterday(10))]!.agents).toEqual({ a1: 100 })
    expect(days[localYmd(at(10))]!.agents).toEqual({ a1: 200, b2: 600, 'gone-agent': 50 })
    for (const d of r.series) {
      const windowed = (['with-you', 'task', 'heartbeat', 'own-automation', 'your-automation'] as const).reduce((s, c) => s + (d.classes[c] ?? 0), 0)
      expect(Object.values(d.agents ?? {}).reduce((s, n) => s + n, 0)).toBe(windowed)
    }
    expect(days[localYmd(at(10))]!.classes).toMatchObject({ unattributed: 140, silos: 10 })
    expect(r.rows.find((x) => x.key === 'agent:gone-agent')?.label).toBe('GONE-AGENT')

    // every other view, and a single agent focused, keep the payload lean
    for (const by of ['kind', 'task', 'automation', 'conversation', 'account'] as const) {
      expect((await svc.report({ from: yesterday(0), to: DAY_TO, by })).series.every((d) => d.agents === undefined)).toBe(true)
    }
    expect((await svc.report({ from: yesterday(0), to: DAY_TO, by: 'agent', agent: 'a1' })).series.every((d) => d.agents === undefined)).toBe(true)
  })
})
