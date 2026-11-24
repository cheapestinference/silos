// control-api.test.ts — the control and the heartbeat through the API: POST/PATCH /api/agents with
// decision 2, the heartbeat reconciled in the same request, the flip to Only
// when told, Run now held by spend / account (never the ceiling), and the two
// verbs only a heartbeat turn has.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { AgentStateStore } from '../src/agent-state.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AutomationsStore } from '../src/automations-store.js'
import { TerritoryStore } from '../src/territory-store.js'
import { Resident } from '../src/resident.js'
import { HeartbeatClock, heartbeatAutomationId } from '../src/heartbeat.js'
import { HeartbeatStore } from '../src/heartbeat-store.js'
import { buildServer } from '../src/server.js'
import { staggeredMinute } from '../src/control.js'
import { readFleetLog } from '../src/fleet-events.js'
import type { OwnTurnsToday } from '../src/own-turns.js'
import { asOwner } from './helpers/owner.js'
import { liveTurnOf } from './helpers/live-turn.js'

let base: string,
  app: FastifyInstance,
  registry: AgentRegistry,
  automations: AutomationsStore,
  territory: TerritoryStore,
  tokens: AgentTokens,
  chat: ChatService,
  resident: Resident
let today: OwnTurnsToday
let reset: string | null
let flips: string[]
const TOKEN = 't0k'

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'silos-ctl-api-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'), { folderCheck: { home: base, dataDir } })
  registry.load()
  automations = new AutomationsStore(dataDir)
  automations.load()
  territory = new TerritoryStore(dataDir)
  territory.load()
  tokens = new AgentTokens(dataDir)
  const native = new NativeStore(join(dataDir, 'native.json'))
  chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no turns here')
    },
    dataDir,
  })
  const heartbeats = new HeartbeatClock({ store: automations, agents: () => registry.list(true), fenceOn: (id) => territory.isEnabled(id) })
  resident = new Resident({
    store: automations,
    registry,
    chat,
    native,
    index,
    root,
    dataDir,
    broadcast: () => {},
    tickIntervalMs: 999_999_999,
    claudeSessionsDir: join(base, 'none'),
  })
  today = { used: 0, costUsd: 0, unpriced: 0, ceiling: 10, spendCap: 5, exempt: false }
  reset = null
  flips = []
  app = buildServer({
    index,
    registry,
    store: new SessionStore(root, dataDir),
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    token: TOKEN,
    liveMs: 120_000,
    automations,
    resident,
    territoryStore: territory,
    agentTokens: tokens,
    agentState: new AgentStateStore(join(dataDir, 'agent-state'), tokens),
    dataDir,
    heartbeats,
    heartbeatStore: new HeartbeatStore(dataDir),
    controlOf: (id) => (registry.get(id)?.control === 'own' && territory.isEnabled(id) ? 'own' : 'told'),
    ownToday: () => today,
    accountResetOf: () => reset,
    flipToTold: (id) => {
      flips.push(id)
      return { running: [{ turnId: 'turn-1', what: 'Close the month' }], stillRuns: [], queued: 2 }
    },
    liveTurnsOf: () => [],
    home: base,
  })
  asOwner(app, TOKEN)
})
afterEach(async () => {
  await app.close()
  resident.stop()
  rmSync(base, { recursive: true, force: true })
})

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as object, headers })
const patch = (url: string, payload: unknown) => app.inject({ method: 'PATCH', url, payload: payload as object })
const bearer = (id: string): Record<string, string> => ({ authorization: `Bearer ${tokens.tokenFor(id)}` })
const mkFolder = (n: string): string => {
  const f = join(base, n)
  mkdirSync(f, { recursive: true })
  return f
}

describe('POST /api/agents: own with a mission and a fence, told without', () => {
  it('a mission ⇒ On its own, fenced, with its heartbeat in the same request; none ⇒ Only when told, no heartbeat', async () => {
    const r = await post('/api/agents', { id: 'books', name: 'Books', folder: mkFolder('books'), mission: { text: 'Keep the books.' } })
    expect(r.statusCode).toBe(201)
    expect(r.json().agent).toMatchObject({ control: 'own', heartbeat: { period: { every: 1, unit: 'weeks', day: 1 } } })
    expect(territory.isEnabled('books')).toBe(true)
    expect(automations.get(heartbeatAutomationId('books'))).toMatchObject({ origin: 'heartbeat', agentId: 'books' })
    const t = await post('/api/agents', { id: 'helper', name: 'Helper', folder: mkFolder('helper') })
    expect(t.json().agent.control).toBe('told')
    expect(automations.get(heartbeatAutomationId('helper'))).toBeNull()
  })
  // the one ask a birth takes: LESS autonomy. «When you give it work» with a
  // mission is told (the mission only describes the job); own still needs one
  it('a birth may ask Only when told even with a mission — never On its own without one', async () => {
    const r = await post('/api/agents', { id: 'scribe', name: 'Scribe', folder: mkFolder('scribe'), mission: { text: 'Keep the notes.' }, control: 'told' })
    expect(r.statusCode).toBe(201)
    expect(r.json().agent.control).toBe('told')
    expect(automations.get(heartbeatAutomationId('scribe'))).toBeNull()
    const o = await post('/api/agents', { id: 'eager', name: 'Eager', folder: mkFolder('eager'), control: 'own' })
    expect(o.json().agent.control).toBe('told')
  })
  it("the control fields are never the body's at birth", async () => {
    const r = await post('/api/agents', { id: 'sly', name: 'Sly', folder: mkFolder('sly'), control: 'own', cut: null, ownTurnsPerDay: 200 })
    expect(r.json().agent.control).toBe('told')
    expect(r.json().agent.ownTurnsPerDay).toBeUndefined()
  })
})

// the New agent form asks a project, never a path: a new one by name
// (~/Silos/<slug>, made), or one Silos knows; the agent works in the
// project's folder itself
describe('POST /api/agents: its project', () => {
  it("a new project by name is made at ~/Silos/<slug> and is the agent's folder", async () => {
    const r = await post('/api/agents', { name: 'Ledger', project: { name: 'Acme Books' } })
    expect(r.statusCode).toBe(201)
    expect(r.json().agent.folder).toBe(join(base, 'Silos', 'acme-books'))
    expect(existsSync(join(base, 'Silos', 'acme-books'))).toBe(true)
  })
  it('an existing project must be one Silos knows: the agent joins that folder; any other path is refused, nothing made', async () => {
    const known = mkFolder('shop')
    expect((await post('/api/agents', { name: 'Clerk', folder: known })).statusCode).toBe(201)
    const r = await post('/api/agents', { name: 'Cashier', project: { folder: `${known}/` } })
    expect(r.statusCode).toBe(201)
    expect(r.json().agent.folder).toBe(known)
    const outside = mkFolder('elsewhere')
    const x = await post('/api/agents', { name: 'Stray', project: { folder: outside } })
    expect(x.statusCode).toBe(409)
    expect(x.json().error).toMatch(/not a project Silos knows/)
    expect(registry.get('stray')).toBeNull()
  })
  it('a new project whose folder is already a project, or an unknown folder with files, is refused; an empty one is taken', async () => {
    expect((await post('/api/agents', { name: 'Books', project: { name: 'Books' } })).statusCode).toBe(201)
    const clash = await post('/api/agents', { name: 'Auditor', project: { name: 'books' } })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error).toMatch(/a project called books exists/)
    mkdirSync(join(base, 'Silos', 'notes'), { recursive: true })
    writeFileSync(join(base, 'Silos', 'notes', 'todo.md'), 'x')
    const taken = await post('/api/agents', { name: 'Scribe', project: { name: 'Notes' } })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().error).toMatch(/already exists with files/)
    expect(registry.get('scribe')).toBeNull()
    mkdirSync(join(base, 'Silos', 'empty'), { recursive: true })
    expect((await post('/api/agents', { name: 'Scribe', project: { name: 'Empty' } })).json().agent.folder).toBe(join(base, 'Silos', 'empty'))
  })
  // the project folder check (project-folder.ts) at the API's doors: a
  // refusal is a 4xx with the reason, and leaves no agent
  it('POST and PATCH refuse a folder no project may have, with the reason; nothing is created or changed', async () => {
    for (const folder of [base, join(base, 'data'), join(base, 'Silos')]) {
      const r = await post('/api/agents', { name: 'Stray', folder })
      expect(r.statusCode, folder).toBe(400)
      expect(r.json().error).toMatch(/a project needs a folder of its own/)
    }
    expect(registry.get('stray')).toBeNull()
    const shop = mkFolder('shop')
    expect((await post('/api/agents', { name: 'Clerk', folder: shop })).statusCode).toBe(201)
    expect((await post('/api/agents', { name: 'Stray', folder: mkFolder('shop/src') })).statusCode).toBe(409)
    expect((await post('/api/agents', { name: 'Books', folder: mkFolder('books') })).statusCode).toBe(201)
    const p = await patch('/api/agents/books', { folders: [join(shop, 'src')] })
    expect(p.statusCode).toBe(409)
    expect(p.json().error).toMatch(/inside the project at/)
    expect(registry.get('books')?.folders).toBeUndefined()
    expect((await patch('/api/agents/books', { folders: [shop] })).statusCode).toBe(200)
  })
  it('a new project under a symlinked Projects folder is made and stored at its real place', async () => {
    const disk = mkdtempSync(join(tmpdir(), 'silos-ctl-disk-'))
    try {
      symlinkSync(disk, join(base, 'Silos'))
      const r = await post('/api/agents', { name: 'Ledger', project: { name: 'Acme Books' } })
      expect(r.statusCode).toBe(201)
      expect(r.json().agent.folder).toBe(join(disk, 'acme-books'))
      expect(existsSync(join(disk, 'acme-books'))).toBe(true)
      // the same name again is the same project, by either spelling
      expect((await post('/api/agents', { name: 'Auditor', project: { name: 'acme books' } })).statusCode).toBe(409)
    } finally {
      rmSync(disk, { recursive: true, force: true })
    }
  })
  it('a project and a folder together, a nameless project or another shape are 400s', async () => {
    expect((await post('/api/agents', { name: 'A', project: { name: 'P' }, folder: mkFolder('p') })).statusCode).toBe(400)
    expect((await post('/api/agents', { name: 'A', project: { name: '  ' } })).statusCode).toBe(400)
    expect((await post('/api/agents', { name: 'A', project: 'p' })).statusCode).toBe(400)
    expect((await post('/api/agents', { name: 'A', project: { name: 'P', folder: '/x' } })).statusCode).toBe(400)
    expect(registry.get('a')).toBeNull()
  })
})

// the ladder's third rung asked at birth: On its own plus Silos' default
// limits — never without a mission, never from the body's own fields
describe('POST /api/agents: Proactive at birth', () => {
  it('control «proactive» with a mission is born On its own, proactive, rounds every 3 hours by day', async () => {
    const r = await post('/api/agents', { name: 'Scout', project: { name: 'Scout' }, mission: { text: 'Find leads.' }, control: 'proactive' })
    expect(r.statusCode).toBe(201)
    expect(r.json().agent).toMatchObject({
      control: 'own',
      proactive: { perDay: 5, tools: true },
      heartbeat: { period: { every: 3, unit: 'hours', between: { from: '08:00', to: '20:00' } } },
    })
    expect(registry.get('scout')!.proactive).toEqual({ perDay: 5, tools: true })
    expect(automations.get(heartbeatAutomationId('scout'))).toMatchObject({ origin: 'heartbeat', agentId: 'scout' })
  })
  it('without a mission it is refused, and nothing is made', async () => {
    const r = await post('/api/agents', { name: 'Seeker', project: { name: 'Seeker' }, control: 'proactive' })
    expect(r.statusCode).toBe(409)
    expect(registry.get('seeker')).toBeNull()
    expect(existsSync(join(base, 'Silos', 'seeker'))).toBe(false)
  })
  it("a body's own proactive or heartbeat is still never taken at birth", async () => {
    const r = await post('/api/agents', {
      name: 'Sly',
      folder: mkFolder('sly'),
      mission: { text: 'x' },
      proactive: { perDay: 50, tools: true },
      heartbeat: { period: { every: 5, unit: 'minutes' } },
    })
    expect(r.json().agent.proactive).toBeUndefined()
    expect(r.json().agent.heartbeat.period.unit).toBe('weeks')
  })
})

describe('PATCH /api/agents/:id — control, heartbeat, knobs', () => {
  beforeEach(async () => {
    await post('/api/agents', { id: 'x', name: 'X', folder: mkFolder('x') })
  })
  it('own without a mission → 409 in its words; without territory → 409; with both → own and a heartbeat at once', async () => {
    const a = await patch('/api/agents/x', { control: 'own' })
    expect(a.statusCode).toBe(409)
    expect(a.json().error).toBe('Give X a mission first — on its own, it needs to know what it answers for')
    territory.setEnabled([])
    const b = await patch('/api/agents/x', { control: 'own', mission: { text: 'Do x.' } })
    expect(b.statusCode).toBe(409)
    expect(b.json().error).toBe("X's territory is off. Turn it on, then it can go on its own ›")
    territory.setEnabled(['x'])
    const c = await patch('/api/agents/x', { control: 'own', mission: { text: 'Do x.' }, heartbeat: { period: { every: 1, unit: 'days', at: '07:30' } } })
    expect(c.statusCode).toBe(200)
    const beat = automations.get(heartbeatAutomationId('x'))!
    expect(beat.trigger).toMatchObject({ kind: 'period', period: { every: 1, unit: 'days', at: '07:30' } })
    // no budget, and an account at its limit waits for the slot
    expect(beat.maxRunsPerDay).toBeUndefined()
    expect(beat.keepAlive).toBe(false)
    // clearing the mission of an own agent
    const d = await patch('/api/agents/x', { mission: null })
    expect(d.statusCode).toBe(409)
    expect(d.json().error).toBe('X is On its own and needs its mission — set it Only when told first, or write another mission')
    // never: the heartbeat goes, the control stays
    expect((await patch('/api/agents/x', { heartbeat: { period: null } })).statusCode).toBe(200)
    expect(automations.get(heartbeatAutomationId('x'))).toBeNull()
    // the fleet's control history (fleet-events.ts): the one move made, none of the refused ones
    expect(readFleetLog(join(base, 'data')).map((l) => (l.kind === 'control' ? `${l.agent}:${l.from}>${l.to}` : l.kind))).toEqual(['x:told>own'])
  })
  it("the heartbeat's 400s in their words; since is the server's and keeps its phase while unit and every stay", async () => {
    for (const [period, words] of [
      [{ every: 2, unit: 'minutes' }, 'a heartbeat runs every 5 minutes at most'],
      [{ every: 1, unit: 'days' }, 'heartbeat.period.at is needed with days or weeks'],
      [{ every: 1, unit: 'weeks', at: '09:00' }, 'heartbeat.period.day is needed with weeks'],
      [{ every: 5, unit: 'hours', at: '01:00', between: { from: '08:00', to: '09:00' } }, 'nothing falls between 08:00 and 09:00 — widen it'],
    ] as const) {
      const r = await patch('/api/agents/x', { heartbeat: { period } })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe(words)
    }
    const first = await patch('/api/agents/x', { heartbeat: { period: { every: 2, unit: 'days', at: '09:00', since: '1999-01-01' } } })
    const since = first.json().agent.heartbeat.period.since
    expect(since).not.toBe('1999-01-01')
    const moved = await patch('/api/agents/x', { heartbeat: { period: { every: 2, unit: 'days', at: '10:00' } } })
    expect(moved.json().agent.heartbeat.period).toEqual({ every: 2, unit: 'days', at: '10:00', since })
  })
  it("the flip to Only when told: its queued wakes superseded at once, the sheet's facts in `pending`, the heartbeat gone", async () => {
    await patch('/api/agents/x', { control: 'own', mission: { text: 'Do x.' } })
    expect(automations.get(heartbeatAutomationId('x'))).not.toBeNull()
    const r = await patch('/api/agents/x', { control: 'told' })
    expect(r.statusCode).toBe(200)
    expect(flips).toEqual(['x'])
    expect(r.json().pending).toEqual({ running: [{ turnId: 'turn-1', what: 'Close the month' }], stillRuns: [], queued: 2 })
    expect(automations.get(heartbeatAutomationId('x'))).toBeNull()
  })
  it('cut only takes null', async () => {
    expect((await patch('/api/agents/x', { cut: { at: 'x', why: 'y' } })).statusCode).toBe(400)
    registry.update('x', { cut: { at: '2026-11-10T00:00:00Z', why: 'w' } })
    expect((await patch('/api/agents/x', { cut: null })).json().agent.cut).toBeUndefined()
  })
  it('an agent bearer never patches an agent (owner only)', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/agents/x', headers: bearer('x'), payload: { control: 'own', turn: liveTurnOf(chat, 'x') } })
    expect(r.statusCode).toBe(403)
  })
})

describe("the heartbeat's doors", () => {
  beforeEach(async () => {
    await post('/api/agents', { id: 'x', name: 'X', folder: mkFolder('x'), mission: { text: 'Do x.' } })
  })
  it('Run now: never held by the ceiling; held by the spend cap and the account in their words (M3-r6, m2-r7)', async () => {
    today = { ...today, used: 10 }
    let r = await post('/api/agents/x/heartbeat/run-now', {})
    expect(r.statusCode).not.toBe(409)
    today = { ...today, used: 0, costUsd: 6.5 }
    r = await post('/api/agents/x/heartbeat/run-now', {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('X spent $6.50 without you today — its cap; let it continue today first')
    today = { ...today, costUsd: 6.5, exempt: true }
    reset = new Date(Date.now() + 3600_000).toISOString()
    r = await post('/api/agents/x/heartbeat/run-now', {})
    expect(r.json()).toEqual({ error: "X's account is at its usage limit — run it again after", until: reset })
  })
  it('considered and sleep: only from a heartbeat turn of its own; the owner wakes it', async () => {
    const fromChat = await app.inject({
      method: 'POST',
      url: '/api/agents/x/considered',
      headers: bearer('x'),
      payload: { idea: 'message:m1 — x', decision: 'dropped', why: 'no', turn: liveTurnOf(chat, 'x') },
    })
    expect(fromChat.statusCode).toBe(403)
    expect(fromChat.json().error).toBe('only a heartbeat turn records what it considered')
    const hb = liveTurnOf(chat, 'x', { class: 'heartbeat', kind: 'think', packetKeys: [] })
    const ok = await app.inject({
      method: 'POST',
      url: '/api/agents/x/considered',
      headers: bearer('x'),
      payload: { idea: 'message:m1 — x', decision: 'dropped', why: 'no', turn: hb },
    })
    expect(ok.statusCode).toBe(201)
    const bad = await app.inject({
      method: 'POST',
      url: '/api/agents/x/considered',
      headers: bearer('x'),
      payload: { idea: 'x', decision: 'maybe', why: 'no', turn: hb },
    })
    expect(bad.json().error).toBe('decision must be created, proposed, dropped or later')
    const noIdea = await app.inject({
      method: 'POST',
      url: '/api/agents/x/considered',
      headers: bearer('x'),
      payload: { idea: '', decision: 'later', why: 'no', turn: hb },
    })
    expect(noIdea.json().error).toBe('idea required (one line)')
    const far = await app.inject({
      method: 'POST',
      url: '/api/agents/x/heartbeat/sleep',
      headers: bearer('x'),
      payload: { until: new Date(Date.now() + 40 * 86400_000).toISOString(), why: 'quiet', turn: hb },
    })
    expect(far.json().error).toBe('until must be within 30 days')
    const notHb = await app.inject({
      method: 'POST',
      url: '/api/agents/x/heartbeat/sleep',
      headers: bearer('x'),
      payload: { until: new Date(Date.now() + 86400_000).toISOString(), why: 'quiet', turn: liveTurnOf(chat, 'x') },
    })
    expect(notHb.json().error).toBe('only a heartbeat turn sleeps')
    const slept = await app.inject({
      method: 'POST',
      url: '/api/agents/x/heartbeat/sleep',
      headers: bearer('x'),
      payload: { until: new Date(Date.now() + 86400_000).toISOString(), why: 'quiet', turn: hb },
    })
    expect(slept.statusCode).toBe(200)
    expect(registry.get('x')!.heartbeat!.sleepUntil).toBeDefined()
    expect((await post('/api/agents/x/heartbeat/wake', {})).statusCode).toBe(200)
    expect(registry.get('x')!.heartbeat!.sleepUntil).toBeUndefined()
    // another agent can never act for it
    await post('/api/agents', { id: 'y', name: 'Y', folder: mkFolder('y') })
    const other = await app.inject({
      method: 'POST',
      url: '/api/agents/x/considered',
      headers: bearer('y'),
      payload: { idea: 'x', decision: 'later', why: 'no', turn: liveTurnOf(chat, 'y', { class: 'heartbeat' }) },
    })
    expect(other.statusCode).toBe(403)
  })
  it('GET heartbeat: its period, the next fire, the sleep and the last run', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agents/x/heartbeat' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ period: { every: 1, unit: 'weeks', day: 1 }, sleeping: null, last: null })
    expect(r.json().rhythm).toBeUndefined()
    expect(typeof r.json().next).toBe('string')
  })
})

// proactive: «On its own» plus a setting,
// written only by the owner, its 400s and its 409s on the state the PATCH
// leaves, cleared by «Only when told»
describe('PATCH /api/agents/:id — proactive', () => {
  beforeEach(async () => {
    await post('/api/agents', { id: 'x', name: 'X', folder: mkFolder('x'), mission: { text: 'Do x.' } })
  })
  const short = { period: { every: 3, unit: 'hours', at: '08:22' } }
  it('an agent bearer never writes proactive (owner only) — not even its own', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/agents/x',
      headers: bearer('x'),
      payload: { proactive: { perDay: 50 }, turn: liveTurnOf(chat, 'x', { class: 'heartbeat', kind: 'round' }) },
    })
    expect(r.statusCode).toBe(403)
    expect(registry.get('x')!.proactive).toBeUndefined()
  })
  it('its 400s in their words; its defaults (5 a day, with its tools)', async () => {
    expect((await patch('/api/agents/x', { heartbeat: short, proactive: { perDay: 0 } })).json().error).toBe(
      'proactive.perDay must be a whole number from 1 to 50 — or leave it out for the default (5)',
    )
    expect((await patch('/api/agents/x', { heartbeat: short, proactive: { perDay: 2.5 } })).statusCode).toBe(400)
    expect((await patch('/api/agents/x', { heartbeat: short, proactive: { tools: 'yes' } })).json().error).toBe('proactive.tools must be true or false')
    const ok = await patch('/api/agents/x', { heartbeat: short, proactive: {} })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().agent.proactive).toEqual({ perDay: 5, tools: true })
  })
  it('its 409s on the state the PATCH would leave', async () => {
    // weekly (the default period): rounds need less than 7 days
    expect((await patch('/api/agents/x', { proactive: {} })).json()).toEqual({ error: 'X does rounds more often than weekly — pick how often' })
    expect((await patch('/api/agents/x', { heartbeat: { period: null }, proactive: {} })).json()).toEqual({
      error: 'X does no rounds while its heartbeat is set to never — pick how often first',
    })
    await patch('/api/agents/x', { control: 'told' })
    expect((await patch('/api/agents/x', { heartbeat: short, proactive: {} })).json()).toEqual({
      error: 'Proactive is On its own and more — set X On its own first',
    })
    // the switch's Proactive from told: control own + proactive in one write
    const r = await patch('/api/agents/x', { control: 'own', heartbeat: short, proactive: { perDay: 3, tools: false } })
    expect(r.statusCode).toBe(200)
    // a partial PATCH merges with what is stored: its tools stay off
    expect((await patch('/api/agents/x', { proactive: { perDay: 7 } })).json().agent.proactive).toEqual({ perDay: 7, tools: false })
    expect((await patch('/api/agents/x', { proactive: { tools: true } })).json().agent.proactive).toEqual({ perDay: 7, tools: true })
    // a period of a week or more, or never, on a proactive agent: refused
    expect((await patch('/api/agents/x', { heartbeat: { period: { every: 1, unit: 'weeks', day: 1, at: '09:00' } } })).statusCode).toBe(409)
    expect((await patch('/api/agents/x', { heartbeat: { period: null } })).statusCode).toBe(409)
  })
  it('«Only when told» CLEARS proactive in the same write; «On its own» sends proactive: null; own without naming it leaves it', async () => {
    await patch('/api/agents/x', { heartbeat: short, proactive: { perDay: 4 } })
    expect((await patch('/api/agents/x', { control: 'own' })).json().agent.proactive).toEqual({ perDay: 4, tools: true })
    expect((await patch('/api/agents/x', { control: 'own', proactive: null })).json().agent.proactive).toBeUndefined()
    await patch('/api/agents/x', { proactive: { perDay: 4 } })
    const told = await patch('/api/agents/x', { control: 'told' })
    expect(told.json().agent.proactive).toBeUndefined()
    // it never comes back by going On its own again
    expect((await patch('/api/agents/x', { control: 'own' })).json().agent.proactive).toBeUndefined()
  })
  it("GET heartbeat says today's skips with their cause and the last run's sealed regime (what q4 reads)", async () => {
    await patch('/api/agents/x', { heartbeat: short, proactive: {} })
    const id = heartbeatAutomationId('x')
    const now = new Date().toISOString()
    automations.appendRun(id, {
      id: 's1',
      automationId: id,
      at: now,
      status: 'skipped',
      reason: "X's account is at 88% of its 5-hour window — rounds wait so there is room for you",
      heartbeat: { kind: 'round', tools: true, perDay: 5, packet: { keys: [] }, created: [], proposed: [], considered: 0, skipped: 'headroom' },
    })
    const r = (await app.inject({ method: 'GET', url: '/api/agents/x/heartbeat' })).json()
    expect(r.skips).toEqual([
      { at: now, cause: 'headroom', kind: 'round', reason: "X's account is at 88% of its 5-hour window — rounds wait so there is room for you" },
    ])
    expect(r.last).toMatchObject({ kind: 'round', cause: 'headroom', tools: true })
    expect(r.beats).toEqual({ looks: 0, thinks: 0, rounds: 0 })
  })
  it('GET heartbeat says its last turn apart from a later skip, and the staggered minute the sheet anchors at', async () => {
    await patch('/api/agents/x', { heartbeat: short, proactive: {} })
    const id = heartbeatAutomationId('x')
    const t0 = new Date(Date.now() - 3 * 3600_000).toISOString(),
      t1 = new Date().toISOString()
    automations.appendRun(id, {
      id: 'r1',
      automationId: id,
      at: t0,
      status: 'ok',
      heartbeat: { kind: 'round', tools: true, perDay: 5, packet: { keys: [] }, created: ['a', 'b'], proposed: [], considered: 0 },
    })
    automations.appendRun(id, {
      id: 's1',
      automationId: id,
      at: t1,
      status: 'skipped',
      reason: 'the previous one is still running',
      heartbeat: { kind: 'round', tools: true, perDay: 5, packet: { keys: [] }, created: [], proposed: [], considered: 0, skipped: 'busy' },
    })
    const r = (await app.inject({ method: 'GET', url: '/api/agents/x/heartbeat' })).json()
    expect(r.last).toMatchObject({ at: t1, cause: 'busy' })
    expect(r.lastTurn).toEqual({ at: t0, kind: 'round', created: ['a', 'b'], proposed: [] })
    expect(r.staggerMinute).toBe(staggeredMinute('x'))
  })
  it('a rename of a proactive agent is no proactive transition (nothing re-judged)', async () => {
    await patch('/api/agents/x', { heartbeat: short, proactive: {} })
    expect((await patch('/api/agents/x', { name: 'Xavier' })).statusCode).toBe(200)
  })
})
