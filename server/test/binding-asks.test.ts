// binding-asks.test.ts — the binding an agent proposes and the owner approves
// (t43). The proposal is read from a task's waitingOn on the owner, checked
// with the Vault's own rules, aimed at the entry the asking agent would sign
// with (a name that is not there is a BROKEN ask, never a prefill toward an
// entry made on the fly), marked «never seen» when its registrable domain is
// new to the install, and resolved by ANY successful save of that entry's
// binding — whatever values the owner saved — and never by a failed one.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { VaultStore, type VaultEntry } from '../src/vault-store.js'
import {
  askTasksOf,
  bindingAsksOf,
  proposedBindingOf,
  registrableDomain,
  resolveBindingWaits,
  seenDomains,
  type AskTask,
  type BindingAsk,
  type WaitWriter,
} from '../src/binding-asks.js'
import { OwnerNoteLedger } from '../src/task-mode/owner-notes.js'
import { plansManifest } from './helpers/plans-silo.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'

type Json = Record<string, any>
const AGENTS = ['finance', 'builder']
const isAgent = (v: string): boolean => AGENTS.includes(v)
const MCP = { entry: 'LEDGER_API_KEY', baseUrl: 'https://mcp.ledgerly.com', inject: { header: 'authorization', format: 'Bearer %s' } }

let base: string
let proj: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'binding-asks-'))
  proj = join(base, 'acme')
  mkdirSync(join(proj, 'plans'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const ask = (binding: unknown, extra: Json = {}): Json => ({
  owner: 'owner',
  action: 'sign LEDGER_API_KEY for the MCP endpoint',
  asked: 'Sign it for MCP?',
  binding,
  ...extra,
})
const task = (id: string, owner: string, status: string, more: Json = {}): Json => ({ id, title: `Task ${id}`, owner, status, dependsOn: [], ...more })

function putPlan(tasks: Json[]): string {
  const f = join(proj, 'plans', 'tasks.plan.json')
  writeFileSync(f, JSON.stringify({ title: '', tasks }, null, 2))
  return f
}

// the built-in Plans silo over the test's project, with the kernel's own
// verbs — what index.ts wires
function plans() {
  const dataDir = join(base, 'data')
  const m = plansManifest()
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(m))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [proj] }),
  })
  kernel.refresh()
  const events = new SiloEvents(registry.root)
  const actions = new SiloActions({
    registry,
    kernel,
    events,
    acks: new SiloAcks(registry.root),
    proposals: new SiloProposals(registry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent,
    agentMayReadLocation: () => false,
  })
  const tasks = (): AskTask[] => {
    kernel.refresh()
    return askTasksOf(kernel.reading('plans')!, new Set(['tasks']))
  }
  // the owner's answer, as index.ts wires it: taskGesture 'answer', ONE write (C14c)
  const writer: WaitWriter = {
    answer: (key, text) => {
      const r = actions.taskGesture('plans', key, 'answer', { text })
      if (!r.ok) return { ok: false, reason: r.reason }
      const id = key.slice(key.lastIndexOf('/') + 1)
      return { ok: true, state: String(((r.value.record as Json).tasks as Json[]).find((x) => x.id === id)?.state) }
    },
  }
  return { tasks, writer, eventsFile: join(registry.root, 'events.jsonl') }
}

function vaultOf(): VaultStore {
  const v = new VaultStore(join(base, 'vault.json'))
  v.load()
  return v
}

const ctxOf = (vault: VaultStore, engineHosts: string[] = []) => ({
  entries: vault.list(),
  winnerOf: (name: string, agentId: string | null, folders: string[]) => vault.winnerOf(name, agentId, folders),
  foldersOf: (id: string) => (isAgent(id) ? [proj] : null),
  engineHosts,
})

describe('the proposal as the file says it (schema)', () => {
  it("reads entry + baseUrl + inject, normalized by the Vault's own validator", () => {
    expect(proposedBindingOf(ask({ ...MCP, baseUrl: 'https://mcp.ledgerly.com/' }))).toEqual({
      entry: 'LEDGER_API_KEY',
      baseUrl: 'https://mcp.ledgerly.com',
      inject: { header: 'authorization', format: 'Bearer %s' },
      problem: null,
    })
  })

  it('an entry alone is a valid ask — the link without a shape', () => {
    expect(proposedBindingOf(ask({ entry: 'LEDGER_API_KEY' }))).toEqual({ entry: 'LEDGER_API_KEY', baseUrl: null, inject: null, problem: null })
  })

  it('no binding, or a wait on someone other than the owner, carries no proposal', () => {
    expect(proposedBindingOf({ owner: 'owner', action: 'x' })).toBeNull()
    expect(proposedBindingOf(ask(MCP, { owner: 'builder' }))).toBeNull()
    expect(proposedBindingOf(ask(MCP, { owner: 'sam' }))).toBeNull()
    expect(proposedBindingOf(null)).toBeNull()
  })

  it('a malformed shape is a problem said in words, never a throw', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['LEDGER_API_KEY', /must be \{ entry/],
      [{ baseUrl: MCP.baseUrl }, /names no Vault entry/],
      [{ entry: 'ledgerly key' }, /UPPER_SNAKE/],
      [{ entry: 'ANTHROPIC_API_KEY' }, /provider layer/],
      [{ entry: 'K', inject: MCP.inject }, /without a baseUrl/],
      [{ entry: 'K', baseUrl: 'https://x.example.com/?key=1' }, /query/],
      [{ entry: 'K', baseUrl: 'https://user:pw@x.example.com' }, /credentials/],
      [{ entry: 'K', baseUrl: 'ftp://x.example.com' }, /http\(s\)/],
      [{ entry: 'K', baseUrl: 'https://x.example.com', inject: { header: 'Bad Header', format: '%s' } }, /header name/],
      [{ entry: 'K', baseUrl: 'https://x.example.com', inject: { header: 'X-Key', format: 'no placeholder' } }, /%s exactly once/],
      [{ entry: 'K', baseUrl: 'https://x.example.com', inject: { header: 'Host', format: '%s' } }, /transport/],
    ]
    for (const [b, re] of cases) {
      const p = proposedBindingOf(ask(b))
      expect(p?.problem, JSON.stringify(b)).toMatch(re)
    }
  })
})

describe('the live asks — target, broken asks, every proposal, «never seen»', () => {
  it('a binding.entry that names no Vault entry is a broken ask: a problem, no target to prefill', () => {
    putPlan([task('t5', 'finance', 'blocked', { waitingOn: ask(MCP) })])
    const vault = vaultOf()
    const asks = bindingAsksOf(plans().tasks(), ctxOf(vault))
    expect(asks).toHaveLength(1)
    expect(asks[0]!.entryId).toBeNull()
    expect(asks[0]!.problem).toMatch(/not in the Vault/)
    // provenance travels even on a broken ask — the row says who asks
    expect([asks[0]!.ref, asks[0]!.owner]).toEqual(['acme#t5', 'finance'])
  })

  it('an entry the asking agent does not see is broken too; a public one is never signed', () => {
    putPlan([task('t5', 'finance', 'blocked', { waitingOn: ask(MCP) })])
    const vault = vaultOf()
    const other = vault.create({ name: 'LEDGER_API_KEY', value: 'sk-1', scope: { type: 'agents', agentIds: ['builder'] } })
    expect(bindingAsksOf(plans().tasks(), ctxOf(vault))[0]!.problem).toMatch(/not where finance sees it/)
    vault.remove(other.id)
    vault.create({ name: 'LEDGER_API_KEY', value: 'cfg', scope: { type: 'folder', folder: proj }, public: true })
    const a = bindingAsksOf(plans().tasks(), ctxOf(vault))[0]!
    expect([a.entryId, a.problem?.includes('Not a secret')]).toEqual([null, true])
  })

  it('targets the entry the agent would sign with, in clear (host, header, format) — never a value — with its current binding for the diff', () => {
    putPlan([task('t5', 'finance', 'blocked', { waitingOn: ask(MCP) })])
    const vault = vaultOf()
    const e = vault.create({
      name: 'LEDGER_API_KEY',
      value: 'sk-secret-1',
      scope: { type: 'agents', agentIds: ['finance'] },
      binding: { baseUrl: 'https://api.ledgerly.com', inject: { header: 'key', format: '%s' } },
    })
    const a = bindingAsksOf(plans().tasks(), ctxOf(vault))[0]!
    expect(a).toMatchObject({
      entry: 'LEDGER_API_KEY',
      entryId: e.id,
      baseUrl: 'https://mcp.ledgerly.com',
      inject: MCP.inject,
      host: 'mcp.ledgerly.com',
      registrable: 'ledgerly.com',
      problem: null,
      asked: 'Sign it for MCP?',
    })
    expect(a.current).toEqual({ baseUrl: 'https://api.ledgerly.com', inject: { header: 'key', format: '%s' } })
    expect(JSON.stringify(a)).not.toContain('sk-secret-1')
  })

  it('lists EVERY live proposal for one entry (each with its task); closed tasks and waits on agents carry none', () => {
    putPlan([
      task('t5', 'finance', 'blocked', { waitingOn: ask(MCP) }),
      task('t6', 'builder', 'blocked', {
        waitingOn: ask({ entry: 'LEDGER_API_KEY', baseUrl: 'https://api.ledgerly.com', inject: { header: 'key', format: '%s' } }),
      }),
      task('t7', 'finance', 'done', { waitingOn: ask(MCP) }),
      task('t8', 'finance', 'blocked', { waitingOn: ask(MCP, { owner: 'builder' }) }),
    ])
    const vault = vaultOf()
    const e = vault.create({ name: 'LEDGER_API_KEY', value: 'sk-1', scope: { type: 'folder', folder: proj } })
    const asks = bindingAsksOf(plans().tasks(), ctxOf(vault))
    expect(asks.map((a) => [a.ref, a.entryId, a.host])).toEqual([
      ['acme#t5', e.id, 'mcp.ledgerly.com'],
      ['acme#t6', e.id, 'api.ledgerly.com'],
    ])
  })

  it('«never seen»: a registrable domain no binding was signed for and no engine documents', () => {
    putPlan([
      task('t1', 'finance', 'blocked', { waitingOn: ask({ entry: 'A_KEY', baseUrl: 'https://mcp.ledgerly.com', inject: MCP.inject }) }),
      task('t2', 'finance', 'blocked', { waitingOn: ask({ entry: 'A_KEY', baseUrl: 'https://mcp.ledgerly-api.com', inject: MCP.inject }) }),
      task('t3', 'finance', 'blocked', { waitingOn: ask({ entry: 'A_KEY', baseUrl: 'https://uploads.github.com', inject: MCP.inject }) }),
      task('t4', 'finance', 'blocked', { waitingOn: ask({ entry: 'A_KEY', baseUrl: 'https://x.models.dev', inject: MCP.inject }) }),
      task('t9', 'finance', 'blocked', { waitingOn: ask({ entry: 'A_KEY' }) }),
    ])
    const vault = vaultOf()
    vault.create({ name: 'A_KEY', value: 'v', scope: { type: 'folder', folder: proj } })
    vault.create({
      name: 'OTHER',
      value: 'v',
      scope: { type: 'global' },
      binding: { baseUrl: 'https://api.ledgerly.com', inject: { header: 'key', format: '%s' } },
    })
    const asks = bindingAsksOf(plans().tasks(), ctxOf(vault, ['github.com', '*.opencode.ai', 'models.dev']))
    expect(asks.map((a) => [a.ref, a.neverSeen])).toEqual([
      ['acme#t1', false],
      ['acme#t2', true],
      ['acme#t3', false],
      ['acme#t4', false],
      ['acme#t9', false],
    ])
  })

  it('registrable domains: the last two labels, three under a known two-label suffix; IPs as they are', () => {
    expect(registrableDomain('mcp.ledgerly.com')).toBe('ledgerly.com')
    expect(registrableDomain('API.Example.COM.')).toBe('example.com')
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('shop.example.com.es')).toBe('example.com.es')
    expect(registrableDomain('203.0.113.9')).toBe('203.0.113.9')
    expect(registrableDomain('localhost')).toBe('localhost')
    expect([...seenDomains([], ['*-review.googlesource.com', '*.opencode.ai'])]).toEqual(['googlesource.com', 'opencode.ai'])
  })
})

describe('the save resolves the wait — any save of that entry, never a failed one', () => {
  function readTask(f: string, id: string): Json {
    return JSON.parse(readFileSync(f, 'utf8')).tasks.find((t: Json) => t.id === id)
  }

  it("the owner EDITED the proposed values: the wait still resolves — owner note (vouched as the owner's), wait cleared, blocked → pending", () => {
    const f = putPlan([
      task('t5', 'finance', 'blocked', { waitingOn: ask(MCP) }),
      task('t6', 'builder', 'blocked', { waitingOn: ask({ entry: 'LEDGER_API_KEY' }) }),
      task('t7', 'finance', 'blocked', { waitingOn: ask({ entry: 'STRIPE_KEY' }) }),
    ])
    const p = plans()
    const vault = vaultOf()
    const e = vault.create({ name: 'LEDGER_API_KEY', value: 'sk-1', scope: { type: 'folder', folder: proj } })
    vault.create({ name: 'STRIPE_KEY', value: 'sk-2', scope: { type: 'folder', folder: proj } })
    // what the owner saved is NOT what t5 proposed (another subdomain, another header)
    const saved = vault.setBinding(e.id, { baseUrl: 'https://mcp2.ledgerly.com', inject: { header: 'x-api-key', format: '%s' } })
    const tasks = p.tasks()
    const r = resolveBindingWaits(saved, bindingAsksOf(tasks, ctxOf(vault)), tasks, p.writer)
    expect(r.failed).toEqual([])
    expect(r.resolved.map((x) => [x.ref, x.owner, x.unblocked])).toEqual([
      ['acme#t5', 'finance', true],
      ['acme#t6', 'builder', true],
    ])
    for (const id of ['t5', 't6']) {
      const t = readTask(f, id)
      expect(t.waitingOn).toBeUndefined()
      expect(t.status).toBe('pending')
      expect(t.notes).toHaveLength(1)
      expect(t.notes[0].by).toBe('owner')
      // the note says what was SAVED and that the agent verifies — never the value
      expect(t.notes[0].text).toContain('https://mcp2.ledgerly.com · x-api-key: %s')
      expect(t.notes[0].text).toMatch(/check that a first signed call works/)
      expect(t.notes[0].text).not.toContain('sk-1')
      // the kernel recorded the owner writing it: task mode's owner-note wake reads it as the owner's
      const ledger = new OwnerNoteLedger(p.eventsFile, 'plans').checker()
      const key = tasks.find((x) => x.id === id)!.key
      expect(ledger(key, t.notes).fromOwner).toEqual([true])
    }
    // another entry's ask is untouched
    expect(readTask(f, 't7').waitingOn.binding.entry).toBe('STRIPE_KEY')
    expect(readTask(f, 't7').notes).toBeUndefined()
  })

  it('a task still held by an open dependency keeps blocked (the wait goes, the dependency stays)', () => {
    const f = putPlan([task('t1', 'builder', 'in_progress'), task('t5', 'finance', 'blocked', { dependsOn: ['t1'], waitingOn: ask(MCP) })])
    const p = plans()
    const vault = vaultOf()
    const e = vault.create({ name: 'LEDGER_API_KEY', value: 'sk-1', scope: { type: 'folder', folder: proj } })
    const saved = vault.setBinding(e.id, { baseUrl: MCP.baseUrl, inject: MCP.inject })
    const tasks = p.tasks()
    const r = resolveBindingWaits(saved, bindingAsksOf(tasks, ctxOf(vault)), tasks, p.writer)
    expect(r.resolved).toEqual([{ key: tasks[1]!.key, ref: 'acme#t5', owner: 'finance', unblocked: false }])
    const t = readTask(f, 't5')
    expect([t.status, t.waitingOn]).toEqual(['blocked', undefined])
  })

  it('an entry saved WITHOUT a binding (handed back) resolves nothing; a failed write is said and the rest go on', () => {
    putPlan([task('t5', 'finance', 'blocked', { waitingOn: ask(MCP) }), task('t6', 'finance', 'blocked', { waitingOn: ask(MCP) })])
    const p = plans()
    const vault = vaultOf()
    const e = vault.create({ name: 'LEDGER_API_KEY', value: 'sk-1', scope: { type: 'folder', folder: proj } })
    const tasks = p.tasks()
    expect(resolveBindingWaits(e, bindingAsksOf(tasks, ctxOf(vault)), tasks, p.writer)).toEqual({ resolved: [], failed: [] })
    const saved = vault.setBinding(e.id, { baseUrl: MCP.baseUrl, inject: MCP.inject })
    const calls: string[] = []
    const flaky: WaitWriter = {
      answer: (key, text) => {
        calls.push(`answer ${key.slice(-2)}`)
        return key.endsWith('t5') ? { ok: false, reason: 'the plan moved' } : p.writer.answer(key, text)
      },
    }
    const r = resolveBindingWaits(saved, bindingAsksOf(tasks, ctxOf(vault)), tasks, flaky)
    expect(r.failed).toEqual([{ key: tasks[0]!.key, ref: 'acme#t5', reason: 'the plan moved' }])
    expect(r.resolved.map((x) => x.ref)).toEqual(['acme#t6'])
    // one write per task: nothing of t5's answer was written
    expect(calls).toEqual(['answer t5', 'answer t6'])
    expect(readTask(join(proj, 'plans', 'tasks.plan.json'), 't5').notes).toBeUndefined()
  })
})

describe('the Vault routes — asks listed, resolution only after a successful save', () => {
  let app: FastifyInstance
  let vault: VaultStore
  let resolvedWith: VaultEntry[]
  const TOKEN = 't0k-asks'
  const listed: BindingAsk[] = [
    {
      key: 'k',
      ref: 'acme#t5',
      title: 'Task t5',
      owner: 'finance',
      folder: null,
      asked: null,
      entry: 'LEDGER_API_KEY',
      baseUrl: MCP.baseUrl,
      inject: MCP.inject,
      host: 'mcp.ledgerly.com',
      registrable: 'ledgerly.com',
      neverSeen: true,
      entryId: null,
      current: null,
      problem: null,
    },
  ]

  beforeEach(async () => {
    const root = join(base, 'projects')
    const dataDir = join(base, 'srv')
    for (const d of [root, join(dataDir, 'trash')]) mkdirSync(d, { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'finance', name: 'Finance', folder: proj })
    vault = vaultOf()
    resolvedWith = []
    const native = new NativeStore(join(dataDir, 'native.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => {
        throw new Error('no turns here')
      },
      dataDir,
    })
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
      vault,
      dataDir,
      bindingAsks: {
        list: () => listed,
        resolve: (e) => {
          resolvedWith.push(e)
          return { resolved: [{ key: 'k', ref: 'acme#t5', owner: 'finance', unblocked: true }], failed: [] }
        },
      },
    })
    await app.ready()
  })
  afterEach(async () => {
    await app.close()
  })

  const patch = (id: string, body: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/vault/${id}`, headers: { 'x-token': TOKEN, 'content-type': 'application/json' }, payload: JSON.stringify(body) })

  it('GET /api/vault carries the live asks beside the entries; /api/vault/asks alone', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/vault', headers: { 'x-token': TOKEN } })
    expect(r.json().asks).toEqual(listed)
    const a = await app.inject({ method: 'GET', url: '/api/vault/asks', headers: { 'x-token': TOKEN } })
    expect(a.json()).toEqual({ asks: listed })
  })

  it('a refused save resolves nothing; a hand-back resolves nothing; a successful save resolves and says so', async () => {
    const e = vault.create({ name: 'LEDGER_API_KEY', value: 'sk-1', scope: { type: 'agents', agentIds: ['finance'] } })
    const bad = await patch(e.id, { binding: { baseUrl: 'https://mcp.ledgerly.com/?k=1', inject: MCP.inject } })
    expect(bad.statusCode).toBe(400)
    const unknown = await patch('nope', { binding: { baseUrl: MCP.baseUrl, inject: MCP.inject } })
    expect(unknown.statusCode).toBe(404)
    expect(resolvedWith).toEqual([])
    const ok = await patch(e.id, { binding: { baseUrl: MCP.baseUrl, inject: MCP.inject } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().resolved.resolved[0].ref).toBe('acme#t5')
    expect(resolvedWith.map((x) => [x.id, x.binding?.baseUrl])).toEqual([[e.id, MCP.baseUrl]])
    const back = await patch(e.id, { binding: null })
    expect(back.statusCode).toBe(200)
    expect(back.json().resolved).toBeUndefined()
    expect(resolvedWith).toHaveLength(1)
  })

  it('an entry CREATED signed resolves too (the ask was broken until it existed); one created delivered does not', async () => {
    const plain = await app.inject({
      method: 'POST',
      url: '/api/vault',
      headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'B_KEY', value: 'v', scope: { type: 'global' } }),
    })
    expect(plain.statusCode).toBe(201)
    expect(resolvedWith).toEqual([])
    const signed = await app.inject({
      method: 'POST',
      url: '/api/vault',
      headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'LEDGER_API_KEY',
        value: 'v',
        scope: { type: 'agents', agentIds: ['finance'] },
        binding: { baseUrl: MCP.baseUrl, inject: MCP.inject },
      }),
    })
    expect(signed.statusCode).toBe(201)
    expect(resolvedWith.map((x) => x.name)).toEqual(['LEDGER_API_KEY'])
  })
})
