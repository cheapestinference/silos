import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs'
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
import { ProvidersStore } from '../src/providers-store.js'
import { validateAutomationCreate } from '../src/automations-validate.js'
import {
  AutomationTemplates,
  TEMPLATE_KIND,
  checkParam,
  checkTemplate,
  fillTemplate,
  fromAutomation,
  templateIdFrom,
  type TemplateParam,
} from '../src/automation-templates.js'
import { BUILTIN_TEMPLATES } from '../src/automation-templates-builtin.js'
import type { Automation } from '../src/automations-types.js'
import type { QueryArgs, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import { bearerWritesCarryTurns } from './helpers/live-turn.js'

const TOKEN = 't0k-templates'
let base: string, dataDir: string, folder: string
let registry: AgentRegistry
let automations: AutomationsStore
let resident: Resident
let agentTokens: AgentTokens
let templates: AutomationTemplates
let app: FastifyInstance

const noQuery = (_args: QueryArgs): SdkQueryHandle => ({
  async *[Symbol.asyncIterator]() {
    /* never run */
  },
  async interrupt() {
    return undefined
  },
})

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'silos-templates-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  folder = join(base, 'project')
  for (const d of [root, join(dataDir, 'trash'), folder]) mkdirSync(d, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder })
  registry.create({ id: 'builder', name: 'BUILDER', folder })
  agentTokens = new AgentTokens(dataDir)
  const native = new NativeStore(join(dataDir, 'native.json'))
  const chat = new ChatService({ registry, native, queryFn: noQuery, dataDir })
  automations = new AutomationsStore(dataDir)
  automations.load()
  resident = new Resident({ store: automations, registry, chat, native, index, root, dataDir, broadcast: () => {}, tickIntervalMs: 999_999_999 })
  const providers = new ProvidersStore(dataDir)
  providers.load()
  templates = new AutomationTemplates(dataDir)
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
    agentTokens,
    providers,
    automationTemplates: templates,
  })
  bearerWritesCarryTurns(app, chat, agentTokens)
})

afterEach(() => resident.stop())

const owner = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-token': TOKEN }, payload: payload as object })
const asAgent = (id: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { host: '127.0.0.1:3210', authorization: `Bearer ${agentTokens.tokenFor(id)}` }, payload: payload as object })

const tpl = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: TEMPLATE_KIND,
  version: 1,
  id: 'daily-check',
  name: 'Daily check',
  sentence: '{{agent}} checks {{what}} at {{at}}',
  description: '',
  params: [
    { key: 'agent', kind: 'agent', label: 'Who' },
    { key: 'what', kind: 'text', label: 'What' },
    { key: 'at', kind: 'time', label: 'At' },
  ],
  automation: { name: 'Check {{what}}', agentId: '{{agent}}', prompt: 'Check {{what}}.', trigger: { kind: 'cron', expr: '{{at.m}} {{at.h}} * * *' } },
  ...over,
})

describe('the built-in catalog', () => {
  it('every built-in is a valid template, fills with real answers, and the body passes the create validator', () => {
    const answers: Record<string, string> = {
      agent: 'finance',
      source: 'builder',
      url: 'https://example.com/health',
      time: '06:05',
      day: '5',
      what: 'the bank',
      command: '/usr/bin/python3 /srv/sync.py --full',
      folder: '/srv/inbox',
      glob: '*.pdf',
    }
    expect(BUILTIN_TEMPLATES.length).toBe(6)
    for (const raw of BUILTIN_TEMPLATES) {
      const t = checkTemplate(raw)
      const body = fillTemplate(t, answers, registry)
      expect(() => validateAutomationCreate(body, registry), t.id).not.toThrow()
      expect(JSON.stringify(body), t.id).not.toMatch(/\{\{/)
      expect(JSON.stringify(raw).toLowerCase(), t.id).not.toContain('cheapestinference')
    }
  })
  it('the listing marks the owner-only ones: those that exec without Claude', () => {
    const owners = templates
      .list()
      .filter((t) => t.ownerOnly)
      .map((t) => t.id)
      .sort()
    expect(owners).toEqual(['nightly-script', 'site-watch'])
    expect(templates.list().every((t) => t.source === 'builtin')).toBe(true)
  })
})

describe('filling', () => {
  it('a time gives .h and .m without leading zeros; a command spreads into argv', () => {
    const t = checkTemplate(BUILTIN_TEMPLATES.find((x) => (x as { id: string }).id === 'nightly-script'))
    const body = fillTemplate(t, { command: "/usr/bin/env 'two words' x", time: '03:07', agent: 'finance' }, registry) as {
      trigger: { expr: string }
      run: { argv: string[] }
    }
    expect(body.trigger.expr).toBe('7 3 * * *')
    expect(body.run.argv).toEqual(['/usr/bin/env', 'two words', 'x'])
  })
  it('a missing answer names the blank; a default fills it', () => {
    const t = checkTemplate(tpl())
    expect(() => fillTemplate(t, { agent: 'finance', what: 'x' }, registry)).toThrow('fill in At')
    const withDefault = checkTemplate(
      tpl({
        params: [
          { key: 'agent', kind: 'agent', label: 'Who' },
          { key: 'what', kind: 'text', label: 'What' },
          { key: 'at', kind: 'time', label: 'At', default: '09:30' },
        ],
      }),
    )
    expect((fillTemplate(withDefault, { agent: 'finance', what: 'x' }, registry) as { trigger: { expr: string } }).trigger.expr).toBe('30 9 * * *')
  })
})

describe('each blank kind refuses what it must', () => {
  const p = (kind: TemplateParam['kind']): TemplateParam => ({ key: 'x', kind, label: 'X' })
  const bad: [TemplateParam['kind'], string][] = [
    ['url', "https://a.com/'; rm -rf / #"],
    ['url', 'https://a.com/$(id)'],
    ['url', 'https://a.com/`id`'],
    ['url', 'ftp://a.com'],
    ['url', 'https://a b.com'],
    ['path', 'relative/dir'],
    ['path', "/srv/it's"],
    ['path', '/srv/$HOME'],
    ['time', '24:00'],
    ['time', '7:5'],
    ['day', '29'],
    ['day', '0'],
    ['day', '2.5'],
    ['glob', '../*.pdf'],
    ['text', 'x'.repeat(201)],
    ['text', 'two\nlines'],
    ['command', "unclosed 'quote"],
    ['agent', 'nobody'],
  ]
  for (const [kind, value] of bad) {
    it(`${kind} refuses ${JSON.stringify(value).slice(0, 40)}`, () => {
      expect(() => checkParam(p(kind), value, registry)).toThrow()
    })
  }
  it('an archived agent is not an answer', () => {
    registry.update('builder', { archived: true })
    expect(() => checkParam(p('agent'), 'builder', registry)).toThrow('no agent builder')
  })
})

describe('a template file is judged when it is saved', () => {
  const shellWatch = (command: string, kind = 'url'): Record<string, unknown> =>
    tpl({
      params: [
        { key: 'agent', kind: 'agent', label: 'Who' },
        { key: 'u', kind, label: 'U' },
      ],
      sentence: '{{agent}} {{u}}',
      automation: {
        name: 'W',
        agentId: '{{agent}}',
        prompt: 'look',
        trigger: { kind: 'watch', every: '*/5 * * * *', runWhen: 'changed', check: { type: 'command', cwd: '/', command } },
      },
    })
  it('a blank in a shell command must be a url or a path inside single quotes', () => {
    expect(() => checkTemplate(shellWatch("curl '{{u}}'"))).not.toThrow()
    expect(() => checkTemplate(shellWatch('curl {{u}}'))).toThrow('inside single quotes')
    expect(() => checkTemplate(shellWatch("curl '{{u}}'", 'text'))).toThrow('must be a url or a path')
  })
  it('a blank it never asks for, a param it never uses, a webhook, and a body that cannot validate are refused', () => {
    expect(() => checkTemplate(tpl({ automation: { ...(tpl().automation as object), prompt: 'Check {{nope}}.' } }))).toThrow('{{nope}} is not in params')
    expect(() =>
      checkTemplate(tpl({ automation: { name: 'n', agentId: '{{agent}}', prompt: 'p', trigger: { kind: 'cron', expr: '{{at.m}} {{at.h}} * * *' } } })),
    ).toThrow('what is never used')
    expect(() =>
      checkTemplate(tpl({ automation: { name: 'n {{what}} {{at}}', agentId: '{{agent}}', prompt: 'p', trigger: { kind: 'webhook', secret: 's' } } })),
    ).toThrow('webhook')
    expect(() =>
      checkTemplate(tpl({ automation: { name: 'n {{what}}', agentId: '{{agent}}', prompt: 'p', trigger: { kind: 'cron', expr: '{{at}} * * *' } } })),
    ).toThrow('not a valid automation')
    expect(() => checkTemplate({ ...tpl(), kind: 'something-else' })).toThrow('not a template file')
  })
})

describe('export', () => {
  const auto = (over: Partial<Automation> = {}): Automation => ({
    id: 'a1',
    name: 'Sync the bank',
    agentId: 'finance',
    prompt: 'Sync with $BANK_KEY from the Vault.',
    trigger: { kind: 'cron', expr: '0 6 * * *' },
    thread: { mode: 'keep', sessionId: 'sess-123' },
    approval: false,
    keepAlive: true,
    paused: false,
    createdAt: '2026-11-07T00:00:00Z',
    lastRun: { at: 'x', status: 'ok', durationMs: 1 },
    runsOn: { provider: 'acct-1', model: 'claude-opus-5-5' },
    ...over,
  })
  it('the agent becomes the one blank; the machine-bound state is left out', () => {
    const t = fromAutomation(auto(), { id: 'sync-the-bank' }, [])
    expect(t.params).toEqual([{ key: 'agent', kind: 'agent', label: 'Who runs it' }])
    expect(t.automation).toMatchObject({ agentId: '{{agent}}', thread: { mode: 'keep' }, runsOn: { model: 'claude-opus-5-5' } })
    expect(JSON.stringify(t)).not.toMatch(/sess-123|acct-1|lastRun/)
  })
  it('a secret value anywhere in the body refuses the export, naming the variable and never the value', () => {
    const leak = auto({ prompt: 'curl -H "Authorization: sk-live-0123456789abcdef" https://api.bank' })
    let msg = ''
    try {
      fromAutomation(leak, { id: 'x' }, [{ name: 'BANK_KEY', value: 'sk-live-0123456789abcdef' }])
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('BANK_KEY')
    expect(msg).not.toContain('sk-live')
  })
  it('a webhook, or text that would read as a blank, cannot be exported', () => {
    expect(() => fromAutomation(auto({ trigger: { kind: 'webhook', secret: 'abc' } }), { id: 'x' }, [])).toThrow('webhook')
    expect(() => fromAutomation(auto({ prompt: 'fill {{this}}' }), { id: 'x' }, [])).toThrow('read as a blank')
  })
  it('ids come from the name, free of taken ones', () => {
    expect(templateIdFrom('Month-end café — day 5', () => false)).toBe('month-end-cafe-day-5')
    expect(templateIdFrom('Watch', (id) => id === 'watch')).toBe('watch-2')
  })
})

describe('the routes', () => {
  it('owner: preview validates without creating; use creates the automation', async () => {
    const params = { agent: 'finance', day: '5', what: 'reconcile the bank' }
    const pre = await owner('POST', '/api/automations/templates/monthly-close/preview', { params })
    expect(pre.statusCode).toBe(200)
    expect(pre.json().automation).toMatchObject({ agentId: 'finance', trigger: { kind: 'cron', expr: '7 6 5 * *' } })
    expect(automations.list()).toHaveLength(0)
    const use = await owner('POST', '/api/automations/templates/monthly-close/use', { params })
    expect(use.statusCode).toBe(201)
    expect(automations.list()).toHaveLength(1)
    expect(automations.list()[0]!.prompt).toContain('reconcile the bank')
  })
  it('a bad answer is a 400 naming its field; an unknown template a 404', async () => {
    const r = await owner('POST', '/api/automations/templates/monthly-close/use', { params: { agent: 'finance', day: '31', what: 'x' } })
    expect(r.statusCode).toBe(400)
    expect(r.json().field).toBe('day')
    expect((await owner('POST', '/api/automations/templates/nope/use', { params: {} })).statusCode).toBe(404)
  })
  it('an agent reads the catalog but uses no template — it proposes', async () => {
    expect((await asAgent('builder', 'GET', '/api/automations/templates')).json().templates).toHaveLength(6)
    const mine = await asAgent('builder', 'POST', '/api/automations/templates/deadline-review/use', { params: { agent: 'builder', time: '08:00' } })
    expect(mine.statusCode).toBe(403)
    expect(mine.json().error).toMatch(/propose it \(POST \/api\/proposals\)/)
    const other = await asAgent('builder', 'POST', '/api/automations/templates/deadline-review/use', { params: { agent: 'finance', time: '08:00' } })
    expect(other.statusCode).toBe(403)
    const exec = await asAgent('builder', 'POST', '/api/automations/templates/site-watch/use', { params: { agent: 'builder', url: 'https://example.com' } })
    expect(exec.statusCode).toBe(403)
    expect(automations.list()).toHaveLength(0)
  })
  it("import, export and delete are the owner's", async () => {
    expect((await asAgent('builder', 'POST', '/api/automations/templates', { template: tpl() })).statusCode).toBe(403)
    expect((await asAgent('builder', 'DELETE', '/api/automations/templates/daily-check')).statusCode).toBe(403)
    const made = (await owner('POST', '/api/automations/templates/deadline-review/use', { params: { agent: 'builder', time: '08:00' } })).json().automation
    expect((await asAgent('builder', 'POST', `/api/automations/${made.id}/template`, {})).statusCode).toBe(403)
  })
  it('export → file → import elsewhere → use makes the same automation', async () => {
    const made = (await owner('POST', '/api/automations/templates/monthly-close/use', { params: { agent: 'finance', day: '3', what: 'the VAT book' } })).json()
      .automation
    const exported = await owner('POST', `/api/automations/${made.id}/template`, { name: 'VAT close' })
    expect(exported.statusCode).toBe(201)
    expect(exported.json().template).toMatchObject({ id: 'vat-close', source: 'user' })
    const file = await owner('GET', '/api/automations/templates/vat-close/file')
    expect(file.headers['content-disposition']).toContain('vat-close.silos-template.json')
    const travelled = JSON.parse(file.body)
    expect(travelled.source).toBeUndefined()
    // another Silos: a fresh catalog takes the file
    const elsewhere = new AutomationTemplates(mkdtempSync(join(tmpdir(), 'silos-elsewhere-')))
    elsewhere.save(travelled)
    const body = fillTemplate(elsewhere.get('vat-close')!, { agent: 'builder' }, registry)
    expect(body).toMatchObject({ agentId: 'builder', prompt: made.prompt, trigger: made.trigger })
  })
  it('import refuses a built-in id and a duplicate (unless replace); delete moves to the trash', async () => {
    expect((await owner('POST', '/api/automations/templates', { template: tpl({ id: 'site-watch' }) })).statusCode).toBe(409)
    expect((await owner('POST', '/api/automations/templates', { template: tpl() })).statusCode).toBe(201)
    expect((await owner('POST', '/api/automations/templates', { template: tpl() })).statusCode).toBe(409)
    expect((await owner('POST', '/api/automations/templates', { template: tpl({ name: 'Renamed' }), replace: true })).statusCode).toBe(201)
    expect(templates.get('daily-check')?.name).toBe('Renamed')
    expect((await owner('POST', '/api/automations/templates', { template: { nope: 1 } })).statusCode).toBe(400)
    expect((await owner('DELETE', '/api/automations/templates/site-watch')).statusCode).toBe(409)
    expect((await owner('DELETE', '/api/automations/templates/daily-check')).statusCode).toBe(200)
    expect(existsSync(join(dataDir, 'automation-templates', 'daily-check.json'))).toBe(false)
    expect(readdirSync(join(dataDir, 'trash', 'automation-templates'))).toHaveLength(1)
  })
})

describe("watching another agent's conversations is the owner's to set up (security review)", () => {
  const conv = (agentId: string, sourceAgentId?: string) => ({
    name: 'Review',
    agentId,
    prompt: 'check',
    trigger: { kind: 'conversation', when: 'finished', ...(sourceAgentId ? { sourceAgentId } : {}) },
  })
  it("an agent proposes a finished-trigger on its own conversations, never on another's; the owner may create either", async () => {
    expect((await asAgent('builder', 'POST', '/api/automations', conv('builder'))).statusCode).toBe(403) // it proposes (t1)
    expect((await owner('POST', '/api/automations', conv('builder', 'builder'))).statusCode).toBe(201)
    expect(
      (await asAgent('builder', 'POST', '/api/automations/templates/finished-review/use', { params: { agent: 'builder', source: 'finance' } })).statusCode,
    ).toBe(403)
    expect((await owner('POST', '/api/automations/templates/finished-review/use', { params: { agent: 'builder', source: 'finance' } })).statusCode).toBe(201)
  })
  it('an agent cannot PATCH its own automation into watching another agent', async () => {
    const mine = (await owner('POST', '/api/automations', conv('builder'))).json().automation
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/automations/${mine.id}`,
      headers: { host: '127.0.0.1:3210', authorization: `Bearer ${agentTokens.tokenFor('builder')}` },
      payload: { trigger: { kind: 'conversation', when: 'finished', sourceAgentId: 'finance' } },
    })
    expect(res.statusCode).toBe(403)
    expect(automations.get(mine.id)?.trigger).toEqual({ kind: 'conversation', when: 'finished' })
  })
})
