// server-messages.test.ts — the messages API:
// send without urgency, replyTo validated, the sender turn's run stamped by the
// server, and «read» marked by the CLASS of the turn the GET names.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { AgentStateStore } from '../src/agent-state.js'
import { MessageStore } from '../src/messages.js'
import { buildServer } from '../src/server.js'
import { AutomationsStore } from '../src/automations-store.js'
import { LineageStore } from '../src/lineage.js'
import { Resident } from '../src/resident.js'
import { asOwner } from './helpers/owner.js'
import { bearerWritesCarryTurns, liveTurnOf } from './helpers/live-turn.js'

const LOCAL = { host: '127.0.0.1:3210' }
let app: FastifyInstance, tokens: AgentTokens, messages: MessageStore
let release: () => void = () => {}
let deps: Parameters<typeof buildServer>[0]
let resident: Resident, automations: AutomationsStore, agentState: AgentStateStore, registry: AgentRegistry, chat: ChatService

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-msg-'))
  const root = join(base, 'projects')
  const folder = mkdtempSync(join(tmpdir(), 'deck-msg-folder-'))
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  mkdirSync(root, { recursive: true })
  const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'builder', name: 'Builder', folder })
  registry.create({ id: 'finance', name: 'Finance', folder })
  registry.create({ id: 'writer', name: 'Writer', folder })
  const native = new NativeStore(join(base, 'data', 'native.json'))
  chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no sdk')
    },
  })
  tokens = new AgentTokens(join(base, 'data'))
  agentState = new AgentStateStore(join(base, 'data', 'agent-state'), tokens)
  messages = new MessageStore(join(base, 'data'))
  automations = new AutomationsStore(join(base, 'data'))
  automations.load()
  const lineage = new LineageStore(join(base, 'data', 'lineage.json'))
  // The resident's own chat: a run that holds until the test lets it go,
  // so "in flight" is observable across two requests.
  const gate = new Promise<void>((res) => {
    release = res
  })
  const runChat = new ChatService({
    registry,
    native,
    dataDir: join(base, 'data'),
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        await gate
        yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
      },
      async interrupt() {
        return undefined
      },
    }),
  })
  resident = new Resident({
    store: automations,
    registry,
    chat: runChat,
    native,
    index,
    root,
    dataDir: join(base, 'data'),
    lineage,
    agentState,
    broadcast: () => {},
    claudeSessionsDir: join(base, 'no-claude-sessions'),
    tickIntervalMs: 999_999_999,
  })
  deps = {
    index,
    registry,
    native,
    chat,
    store: new SessionStore(root, join(base, 'data')),
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(join(base, 'data')),
    memory: new MemoryService(root, join(base, 'data'), registry),
    token: 't0k',
    liveMs: 120_000,
    agentTokens: tokens,
    agentState,
    messages,
    automations,
    resident,
  }
  app = buildServer(deps)
  bearerWritesCarryTurns(app, chat, tokens)
  asOwner(app, 't0k')
})
afterEach(async () => {
  release()
  resident.stop()
  await resident.drain()
  await app.close()
})

const as = (id: string) => ({ ...LOCAL, authorization: `Bearer ${tokens.tokenFor(id)}` })

describe('messages API', () => {
  it("agent builder POSTs to finance → 201 with from builder, lands in finance's inbox", async () => {
    const r = await app.inject({ method: 'POST', url: '/api/agents/finance/messages', headers: as('builder'), payload: { text: 'invoice?' } })
    expect(r.statusCode).toBe(201)
    const { message } = r.json()
    expect(message).toMatchObject({ from: 'builder', to: 'finance', text: 'invoice?', state: 'new' })
    expect(r.json()).not.toHaveProperty('wake')
    expect(messages.list('finance').map((m) => m.id)).toEqual([message.id])
  })

  it('owner (the owner token, loopback) POSTs → from owner', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/agents/finance/messages', headers: LOCAL, payload: { text: 'hi' } })
    expect(r.statusCode).toBe(201)
    expect(r.json().message).toMatchObject({ from: 'owner' })
    expect(r.json().message).not.toHaveProperty('run')
  })

  // «owner» only with the owner's credential
  it('no identity on loopback: a POST is 401 and nothing is sent — not even signed by X-Silos-Agent', async () => {
    const bare = buildServer(deps)
    try {
      const r = await bare.inject({
        method: 'POST',
        url: '/api/agents/finance/messages',
        headers: { ...LOCAL, 'x-silos-agent': 'builder' },
        payload: { text: 'forged' },
      })
      expect(r.statusCode).toBe(401)
      expect(messages.list('finance')).toEqual([])
    } finally {
      await bare.close()
    }
  })

  it('a GET with no identity reads, with no effects: the messages stay as they were', async () => {
    const m = messages.send({ from: 'builder', to: 'finance', text: 'a' })
    const bare = buildServer(deps)
    try {
      const r = await bare.inject({ method: 'GET', url: '/api/agents/finance/messages', headers: LOCAL })
      expect(r.statusCode).toBe(200)
      expect(r.json().messages.map((x: { id: string; state: string }) => [x.id, x.state])).toEqual([[m.id, 'new']])
      expect(messages.list('finance').map((x) => x.state)).toEqual(['new'])
    } finally {
      await bare.close()
    }
  })

  it('an agent may post to itself; unknown recipient → 404; empty text → 400', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/agents/builder/messages', headers: as('builder'), payload: { text: 'note to self' } })).statusCode,
    ).toBe(201)
    expect((await app.inject({ method: 'POST', url: '/api/agents/ghost/messages', headers: as('builder'), payload: { text: 'x' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/agents/finance/messages', headers: as('builder'), payload: { text: '  ' } })).statusCode).toBe(400)
  })

  it('a message to Anywhere (master) is refused — nobody reads that inbox; the refusal names the answer and needs_owner', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/agents/master/messages', headers: as('builder'), payload: { text: 'report' } })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/answer/)
    expect(r.json().error).toMatch(/needs_owner/)
    expect(messages.list('master')).toEqual([])
  })

  it('GET: owner and self may read; another agent → 403; ?state filters', async () => {
    const m = messages.send({ from: 'builder', to: 'finance', text: 'a' })
    messages.send({ from: 'builder', to: 'finance', text: 'b' })
    messages.setState('finance', m.id, 'read')
    const owner = await app.inject({ method: 'GET', url: '/api/agents/finance/messages', headers: LOCAL })
    expect(owner.statusCode).toBe(200)
    expect(owner.json().messages).toHaveLength(2)
    const self = await app.inject({ method: 'GET', url: '/api/agents/finance/messages?state=new', headers: as('finance') })
    expect(self.json().messages.map((x: { text: string }) => x.text)).toEqual(['b'])
    const other = await app.inject({ method: 'GET', url: '/api/agents/finance/messages', headers: as('builder') })
    expect(other.statusCode).toBe(403)
    // refused by the auth hook (agentMayRead) before the route's own check
    expect(other.json()).toEqual({ error: 'agent builder may not read /api/agents/finance/messages' })
    expect((await app.inject({ method: 'GET', url: '/api/agents/finance/messages?state=bogus', headers: LOCAL })).statusCode).toBe(400)
  })

  it('GET …/messages/sent: what an agent sent, across every inbox, with live state; marks nothing; owner and self only', async () => {
    const a = messages.send({ from: 'builder', to: 'finance', text: 'to finance' })
    messages.send({ from: 'builder', to: 'writer', text: 'to writer' })
    messages.send({ from: 'finance', to: 'builder', text: "not builder's" })
    messages.setState('finance', a.id, 'answered', 'done')
    const owner = await app.inject({ method: 'GET', url: '/api/agents/builder/messages/sent', headers: LOCAL })
    expect(owner.statusCode).toBe(200)
    const sent = owner.json().messages as Array<{ to: string; state: string; answer?: string }>
    expect(sent.map((m) => [m.to, m.state, m.answer])).toEqual([
      ['finance', 'answered', 'done'],
      ['writer', 'new', undefined],
    ])
    const self = await app.inject({ method: 'GET', url: '/api/agents/builder/messages/sent?turn=x', headers: as('builder') })
    expect(self.json().messages).toHaveLength(2)
    expect(messages.list('writer')[0]?.state).toBe('new') // the sender's read is not the recipient's
    expect((await app.inject({ method: 'GET', url: '/api/agents/builder/messages/sent', headers: as('finance') })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/agents/nobody/messages/sent', headers: LOCAL })).statusCode).toBe(404)
  })

  it("PATCH: recipient and owner may mark; builder PATCHing finance's message → 403; unknown id → 404", async () => {
    const m = messages.send({ from: 'builder', to: 'finance', text: 'a' })
    const forbidden = await app.inject({ method: 'PATCH', url: `/api/agents/finance/messages/${m.id}`, headers: as('builder'), payload: { state: 'read' } })
    expect(forbidden.statusCode).toBe(403)
    const self = await app.inject({ method: 'PATCH', url: `/api/agents/finance/messages/${m.id}`, headers: as('finance'), payload: { state: 'needs_owner' } })
    expect(self.statusCode).toBe(200)
    expect(self.json().message.state).toBe('needs_owner')
    const owner = await app.inject({ method: 'PATCH', url: `/api/agents/finance/messages/${m.id}`, headers: LOCAL, payload: { state: 'answered' } })
    expect(owner.json().message.state).toBe('answered')
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/agents/finance/messages/nope-000000', headers: LOCAL, payload: { state: 'read' } })).statusCode,
    ).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `/api/agents/finance/messages/${m.id}`, headers: LOCAL, payload: { state: 'bogus' } })).statusCode).toBe(
      400,
    )
  })

  it("agents may not read the board (it carries other agents' messages); the owner still sees the message row", async () => {
    const m = messages.send({ from: 'builder', to: 'finance', text: 'private to finance' })
    messages.setState('finance', m.id, 'needs_owner')
    const agent = await app.inject({ method: 'GET', url: '/api/board', headers: as('builder') })
    expect(agent.statusCode).toBe(403)
    expect(agent.json()).toEqual({ error: 'agent builder may not read /api/board' })
    expect((await app.inject({ method: 'GET', url: '/api/file/raw?path=/etc/hostname', headers: as('builder') })).statusCode).toBe(403)
    // an encoded spelling routes to the same handler — still refused
    const encoded = await app.inject({ method: 'GET', url: '/api/%62oard', headers: as('builder') })
    expect(encoded.statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/agents/%62uilder/messages', headers: as('builder') })).statusCode).toBe(200)
    const owner = await app.inject({ method: 'GET', url: '/api/board', headers: LOCAL })
    expect(owner.statusCode).toBe(200)
    expect(owner.json().needsYou).toContainEqual(expect.objectContaining({ kind: 'message', messageId: m.id }))
  })

  it('a needs_owner message shows in /api/board needsYou', async () => {
    const m = messages.send({ from: 'builder', to: 'finance', text: 'sign it' })
    messages.setState('finance', m.id, 'needs_owner')
    const r = await app.inject({ method: 'GET', url: '/api/board', headers: LOCAL })
    expect(r.json().needsYou).toContainEqual({ kind: 'message', agentId: 'finance', from: 'builder', messageId: m.id, text: 'sign it', at: m.at })
  })

  // a 400, never a silence — an old skill that sends it learns why
  it('`urgent` in any form → 400 with its words; nothing is stored', async () => {
    for (const urgent of [true, false, 'yes']) {
      const r = await app.inject({ method: 'POST', url: '/api/agents/finance/messages', headers: as('builder'), payload: { text: 'now!', urgent } })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe(
        "messages have no urgency any more: to move work now, assign your own task (POST /api/tasks/assign) or leave it to the owner's gesture",
      )
    }
    expect(messages.list('finance')).toEqual([])
  })

  it('replyTo names a message the replier received — else 400 «replyTo names no message of yours»', async () => {
    const q = messages.send({ from: 'builder', to: 'finance', text: 'question' })
    const ok = await app.inject({ method: 'POST', url: '/api/agents/builder/messages', headers: as('finance'), payload: { text: 'answer', replyTo: q.id } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().message).toMatchObject({ from: 'finance', to: 'builder', replyTo: q.id })
    const notMine = await app.inject({ method: 'POST', url: '/api/agents/finance/messages', headers: as('writer'), payload: { text: 'x', replyTo: q.id } })
    expect(notMine.statusCode).toBe(400)
    expect(notMine.json().error).toBe('replyTo names no message of yours')
    expect(
      (await app.inject({ method: 'POST', url: '/api/agents/finance/messages', headers: as('writer'), payload: { text: 'x', replyTo: 'nope-000000' } }))
        .statusCode,
    ).toBe(400)
  })

  it("a bearer's message is stamped with its turn's run — by the server, never from the body", async () => {
    const turn = liveTurnOf(chat, 'builder', { class: 'run', automationId: 'a1', runId: 'run-7' })
    const r = await app.inject({
      method: 'POST',
      url: '/api/agents/finance/messages',
      headers: as('builder'),
      payload: { text: 'from a run', turn, run: 'forged' },
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().message.run).toBe('run-7')
    expect(messages.get('finance', r.json().message.id)?.run).toBe('run-7')
  })

  it('the overview carries what waits in each inbox: { new }', async () => {
    messages.send({ from: 'builder', to: 'finance', text: 'a' })
    const ov = (await app.inject({ method: 'GET', url: '/api/overview', headers: LOCAL })).json()
    expect(ov.agents.find((a: { id: string }) => a.id === 'finance').inbox).toEqual({ new: 1 })
    expect(ov.agents.find((a: { id: string }) => a.id === 'builder').inbox).toEqual({ new: 0 })
  })
})

// «read» is marked by the CLASS of the turn the GET names
describe("messages API — the serving marks read by the turn's class", () => {
  const get = (headers: Record<string, string>, q = '') => app.inject({ method: 'GET', url: `/api/agents/finance/messages?state=new${q}`, headers })

  it('a bare bearer, the owner, an unknown token, an unattended turn: served, never marked', async () => {
    const m = messages.send({ from: 'builder', to: 'finance', text: 'look' })
    expect((await get(as('finance'))).json().messages.map((x: { id: string }) => x.id)).toEqual([m.id])
    await get(LOCAL)
    await get(as('finance'), `&turn=${'f'.repeat(32)}`)
    const wake = liveTurnOf(chat, 'finance', { class: 'wake', taskKey: 'k' })
    await get({ ...as('finance'), 'x-silos-turn': wake })
    expect(messages.get('finance', m.id)?.state).toBe('new')
    // the wake's serving was noted: its end WITH output marks it (chat-service)
    expect(chat.liveTurns.get(wake)?.servedMessages).toEqual([m.id])
  })

  it("a console's or the owner's chat's token marks what it served — by query or header", async () => {
    const a = messages.send({ from: 'builder', to: 'finance', text: 'a' })
    const console = chat.liveTurns.mintConsole('finance', 'finance-console')
    const r = await get(as('finance'), `&turn=${console}`)
    expect(r.json().messages.map((x: { id: string; state: string }) => [x.id, x.state])).toEqual([[a.id, 'new']])
    expect(messages.get('finance', a.id)?.state).toBe('read')
    const b = messages.send({ from: 'builder', to: 'finance', text: 'b' })
    await get({ ...as('finance'), 'x-silos-turn': liveTurnOf(chat, 'finance') })
    expect(messages.get('finance', b.id)?.state).toBe('read')
  })

  it("another agent's console token marks nothing", async () => {
    const m = messages.send({ from: 'builder', to: 'finance', text: 'look' })
    await get(as('finance'), `&turn=${chat.liveTurns.mintConsole('writer', 'writer-console')}`)
    expect(messages.get('finance', m.id)?.state).toBe('new')
  })
})

// Identity: bearer › X-Silos-Agent of an existing,
// non-archived agent › owner — honoured only on POST messages.
describe('messages API — X-Silos-Agent', () => {
  it('without a bearer the header names the sender; with a bearer the bearer wins; unknown or archived → owner', async () => {
    const byHeader = await app.inject({
      method: 'POST',
      url: '/api/agents/finance/messages',
      headers: { ...LOCAL, 'x-silos-agent': 'builder' },
      payload: { text: 'from builder' },
    })
    expect(byHeader.json().message.from).toBe('builder')
    const both = await app.inject({
      method: 'POST',
      url: '/api/agents/finance/messages',
      headers: { ...as('writer'), 'x-silos-agent': 'builder' },
      payload: { text: 'writer really' },
    })
    expect(both.json().message.from).toBe('writer')
    const ghost = await app.inject({
      method: 'POST',
      url: '/api/agents/finance/messages',
      headers: { ...LOCAL, 'x-silos-agent': 'ghost' },
      payload: { text: 'who' },
    })
    expect(ghost.json().message.from).toBe('owner')
    registry.update('writer', { archived: true })
    const archived = await app.inject({
      method: 'POST',
      url: '/api/agents/finance/messages',
      headers: { ...LOCAL, 'x-silos-agent': 'writer' },
      payload: { text: 'gone' },
    })
    expect(archived.json().message.from).toBe('owner')
  })
})

describe('messages API — answer', () => {
  it('PATCH accepts an answer: trimmed, one paragraph; empty, non-string or over 1000 → 400', async () => {
    const m = messages.send({ from: 'owner', to: 'finance', text: 'q' })
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/agents/finance/messages/${m.id}`,
      headers: as('finance'),
      payload: { state: 'answered', answer: '  Booked it.\n\nIt is in plans/q4.plan.json   ' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().message).toMatchObject({ state: 'answered', answer: 'Booked it. It is in plans/q4.plan.json' })
    expect(messages.get('finance', m.id)?.answer).toBe('Booked it. It is in plans/q4.plan.json')
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/agents/finance/messages/${m.id}`,
          headers: as('finance'),
          payload: { state: 'answered', answer: '   ' },
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/agents/finance/messages/${m.id}`,
          headers: as('finance'),
          payload: { state: 'answered', answer: 'x'.repeat(1001) },
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/agents/finance/messages/${m.id}`, headers: as('finance'), payload: { state: 'answered', answer: 7 } }))
        .statusCode,
    ).toBe(400)
  })
})
