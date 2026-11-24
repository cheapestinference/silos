// Edge-only silos (Silo Standard step 4, H1 + H2): spec.relations in the
// schema and the validator, the kernel's relation store (cycle, dangling,
// archived, corrupt file) and the owner-only routes (403 for an agent
// bearer). Generic: the fixtures name a relation the kernel never
// knows by name.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { validateSilo } from '../src/silos/validator.js'
import { readManifest } from '../src/silos/manifest.js'
import {
  activeRelations,
  agentChainRelation,
  chainUp,
  forest,
  RelationStore,
  relationsOf,
  rootOf,
  type AgentLookup,
  type RelationDecl,
} from '../src/silos/relations.js'
import { agentMayRead, agentMayWrite } from '../src/agent-authz.js'
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
import { buildServer } from '../src/server.js'
import { SiloRegistry } from '../src/silos/registry.js'

type Json = Record<string, any>
const NOW = Date.parse('2026-11-03T12:00:00Z')

// an edge-only manifest: one relation, a tree over it, a lens — no producer,
// no sources, no kinds
const edgeOnly = (over: Json = {}): Json => ({
  apiVersion: 'silo-standard/v0',
  metadata: { id: 'lines', version: '0.1.0', name: 'Lines' },
  spec: {
    relations: [{ name: 'answers_to', from: 'agent', to: 'agent', cardinality: 'one', acyclic: true, writableBy: 'owner' }],
    views: [{ id: 'tree', archetype: 'tree', relation: 'answers_to' }],
    surfaces: { lens: { over: 'tasks', label: 'by line', groupBy: { relation: 'answers_to', by: 'subtree' } } },
    ...over,
  },
})
const messages = (m: unknown): string[] => validateSilo(m, { now: NOW }).errors.map((e) => `${e.where}: ${e.message}`)

describe('the schema and the validator: edge-only silos', () => {
  it('an edge-only silo (relations, no producer/sources/kinds) validates', () => {
    const r = validateSilo(edgeOnly(), { now: NOW })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.preview).toMatchObject({ pulse: null, needsYou: [], list: null })
    const read = readManifest(edgeOnly())
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.conventions).toEqual([])
  })
  it('without relations, a silo still needs producer, sources and kinds', () => {
    const m = edgeOnly({ relations: undefined })
    delete m.spec.relations
    delete m.spec.views
    delete m.spec.surfaces
    const errs = messages(m)
    expect(errs.join('\n')).toMatch(/missing producer/)
    expect(errs.join('\n')).toMatch(/missing sources/)
    expect(errs.join('\n')).toMatch(/missing kinds/)
    // an empty list of relations is no relation
    expect(messages(edgeOnly({ relations: [], views: [], surfaces: {} })).join('\n')).toMatch(/missing sources/)
  })
  it('relations + sources without kinds is refused (records need their kind)', () => {
    const m = edgeOnly({ sources: [{ id: 'x', type: 'files', root: 'agent-state', glob: 'silos/x/*.json', parser: 'json' }] })
    expect(messages(m).join('\n')).toMatch(/missing kinds/)
  })
  it('a lens over an unknown relation is refused', () => {
    const errs = messages(edgeOnly({ surfaces: { lens: { over: 'tasks', groupBy: { relation: 'nope', by: 'subtree' } } } }))
    expect(errs).toEqual(['spec.surfaces.lens.groupBy.relation: nope is not a relation of this silo (answers_to)'])
  })
  it('a tree over an unknown or cyclic-allowed relation is refused', () => {
    expect(messages(edgeOnly({ views: [{ id: 'tree', archetype: 'tree', relation: 'nope' }] }))).toEqual([
      'spec.views[0].relation: nope is not a relation of this silo (answers_to)',
    ])
    const loose = edgeOnly({ relations: [{ name: 'answers_to', from: 'agent', to: 'agent', cardinality: 'one', acyclic: false, writableBy: 'owner' }] })
    const errs = messages(loose)
    expect(errs).toHaveLength(2) // the tree and the lens, each said
    expect(errs[0]).toMatch(/needs an acyclic relation/)
  })
  it('a tree without its relation, a relation to a hub the kernel does not keep, a duplicate name', () => {
    expect(messages(edgeOnly({ views: [{ id: 'tree', archetype: 'tree' }] })).join('\n')).toMatch(/missing relation/)
    expect(
      messages(edgeOnly({ relations: [{ name: 'answers_to', from: 'agent', to: 'folder', cardinality: 'one', acyclic: true, writableBy: 'owner' }] })).join(
        '\n',
      ),
    ).toMatch(/must be one of agent/)
    const dup = edgeOnly({ relations: [edgeOnly().spec.relations[0], edgeOnly().spec.relations[0]] })
    expect(messages(dup).join('\n')).toMatch(/answers_to is declared twice/)
  })
  it('the reference hierarchy manifest validates as an edge-only silo', () => {
    const m = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'hierarchy.silo.json'), 'utf8'))
    expect(validateSilo(m, { now: NOW }).errors).toEqual([])
  })
  it('a list view still needs its kind', () => {
    expect(messages(edgeOnly({ views: [{ id: 'l', archetype: 'list' }] })).join('\n')).toMatch(/missing kind/)
  })
})

// ── the store ───────────────────────────────────────────────────────────────

const DECL: RelationDecl = { name: 'answers_to', from: 'agent', to: 'agent', cardinality: 'one', acyclic: true, writableBy: 'owner' }
const lookup = (ok: string[], archived: string[] = []): AgentLookup => ({
  stateOf: (id) => (ok.includes(id) ? 'ok' : archived.includes(id) ? 'archived' : 'gone'),
})

describe('RelationStore', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'silo-relations-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const agents = lookup(['builder', 'finance', 'writer', 'support'], ['old'])

  it('sets, reads and clears an edge in <root>/<silo>/relations.json', () => {
    const s = new RelationStore(root)
    expect(s.set('lines', DECL, 'writer', 'builder', agents)).toEqual({ ok: true, edges: { writer: 'builder' } })
    expect(s.set('lines', DECL, 'finance', 'builder', agents).ok).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'lines', 'relations.json'), 'utf8'))).toEqual({
      version: 1,
      relations: { answers_to: { writer: 'builder', finance: 'builder' } },
    })
    expect(s.list('lines', 'answers_to', agents)).toEqual([
      { from: 'finance', to: 'builder' },
      { from: 'writer', to: 'builder' },
    ])
    expect(s.set('lines', DECL, 'writer', null, agents)).toEqual({ ok: true, edges: { finance: 'builder' } })
  })
  it('refuses a loop in words, naming the path', () => {
    const s = new RelationStore(root)
    s.set('lines', DECL, 'writer', 'finance', agents)
    s.set('lines', DECL, 'finance', 'builder', agents)
    const r = s.set('lines', DECL, 'builder', 'writer', agents, (id) => id.toUpperCase())
    expect(r).toEqual({ ok: false, code: 409, reason: 'that would close a loop — WRITER already answers_to BUILDER through FINANCE' })
    expect(s.set('lines', DECL, 'builder', 'builder', agents)).toMatchObject({ ok: false, code: 400 })
    // a relation that allows loops takes it
    expect(s.set('lines', { ...DECL, acyclic: false }, 'builder', 'writer', agents).ok).toBe(true)
  })
  it('refuses a dangling id and a new edge to an archived agent', () => {
    const s = new RelationStore(root)
    expect(s.set('lines', DECL, 'ghost', 'builder', agents)).toMatchObject({ ok: false, code: 400, reason: expect.stringMatching(/ghost is not an agent/) })
    expect(s.set('lines', DECL, 'writer', 'ghost', agents)).toMatchObject({ ok: false, code: 400, reason: expect.stringMatching(/ghost is not an agent/) })
    expect(s.set('lines', DECL, 'writer', 'old', agents)).toMatchObject({ ok: false, code: 400, reason: expect.stringMatching(/archived/) })
  })
  it('an agent archived afterwards: the edge stays in the file, marked, out of the chain', () => {
    const s = new RelationStore(root)
    s.set('lines', DECL, 'writer', 'finance', agents)
    s.set('lines', DECL, 'finance', 'builder', agents)
    const later = lookup(['builder', 'writer'], ['finance'])
    expect(s.list('lines', 'answers_to', later)).toEqual([
      { from: 'finance', to: 'builder', note: 'archived' },
      { from: 'writer', to: 'finance', note: 'archived' },
    ])
    expect(s.live('lines', 'answers_to', later)).toEqual({})
    expect(s.edges('lines', 'answers_to')).toEqual({ writer: 'finance', finance: 'builder' })
    // clearing the archived agent's own edge is allowed (the owner tidies)
    expect(s.set('lines', DECL, 'finance', null, later).ok).toBe(true)
  })
  it('a corrupt file is set aside and reads empty — never guessed', () => {
    mkdirSync(join(root, 'lines'), { recursive: true })
    writeFileSync(join(root, 'lines', 'relations.json'), '{ not json')
    const s = new RelationStore(root)
    expect(s.edges('lines', 'answers_to')).toEqual({})
    expect(readdirSync(join(root, 'lines')).some((f) => f.startsWith('relations.json.corrupt'))).toBe(true)
    expect(s.set('lines', DECL, 'writer', 'builder', agents).ok).toBe(true)
  })
})

describe('chains and trees (pure)', () => {
  const edges = { writer: 'finance', finance: 'builder', support: 'builder' }
  it('chainUp walks up, cycle-proof; rootOf names the top', () => {
    expect(chainUp(edges, 'writer')).toEqual(['finance', 'builder'])
    expect(chainUp(edges, 'builder')).toEqual([])
    expect(rootOf(edges, 'writer')).toBe('builder')
    expect(rootOf(edges, 'builder')).toBe('builder')
    expect(chainUp({ a: 'b', b: 'a' }, 'a')).toEqual(['b'])
  })
  it('forest: roots in order, children by the edge, a hand-written loop never drops a node', () => {
    const f = forest(['builder', 'finance', 'writer', 'support', 'silos'], edges)
    expect(f.map((n) => n.id)).toEqual(['builder', 'silos'])
    expect(f[0]!.children.map((n) => n.id)).toEqual(['finance', 'support'])
    expect(f[0]!.children[0]!.children.map((n) => n.id)).toEqual(['writer'])
    expect(forest(['a', 'b'], { a: 'b', b: 'a' }).map((n) => n.id)).toEqual(['a', 'b'])
  })
  it('activeRelations / agentChainRelation read only active silos', () => {
    const e = (id: string, state: string) => ({ id, manifest: edgeOnly() as Json, status: { state, manifest: { name: id } } })
    expect(activeRelations([e('lines', 'pending')])).toEqual([])
    expect(agentChainRelation([e('lines', 'active')])).toMatchObject({ silo: 'lines', decl: { name: 'answers_to' } })
    expect(relationsOf(edgeOnly())).toHaveLength(1)
  })
})

// ── the routes ──────────────────────────────────────────────────────────────

describe('GET/PUT /api/silos/:id/relations/:name', () => {
  const TOKEN = 't0k-relations'
  const LOCAL = { host: '127.0.0.1:3210' }
  let base: string
  let app: FastifyInstance
  let tokens: AgentTokens
  let registry: AgentRegistry
  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'silo-relations-api-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    const folder = join(base, 'p')
    for (const d of [root, join(dataDir, 'trash'), folder, join(dataDir, 'silos', 'registry', 'lines')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', 'lines', 'silo.json'), JSON.stringify(edgeOnly()))
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    for (const id of ['builder', 'finance', 'writer']) registry.create({ id, name: id[0]!.toUpperCase() + id.slice(1), folder })
    tokens = new AgentTokens(dataDir)
    const siloRegistry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
    siloRegistry.load()
    const native = new NativeStore(join(dataDir, 'native.json'))
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, dataDir),
      native,
      chat: new ChatService({
        registry,
        native,
        queryFn: () => {
          throw new Error('no turns here')
        },
        dataDir,
      }),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: TOKEN,
      liveMs: 120_000,
      agentTokens: tokens,
      siloRegistry,
    })
  })
  afterEach(async () => {
    await app.close()
    rmSync(base, { recursive: true, force: true })
  })
  const owner = { ...LOCAL, 'x-token': TOKEN }
  const bearer = (id: string) => ({ ...LOCAL, authorization: `Bearer ${tokens.tokenFor(id)}` })

  it('the owner draws, reads and is refused a loop in words', async () => {
    const put = (from: string, to: string | null) =>
      app.inject({ method: 'PUT', url: '/api/silos/lines/relations/answers_to', headers: owner, payload: { from, to } })
    expect((await put('writer', 'finance')).statusCode).toBe(200)
    expect((await put('finance', 'builder')).json().edges).toEqual([
      { from: 'finance', to: 'builder' },
      { from: 'writer', to: 'finance' },
    ])
    const loop = await put('builder', 'writer')
    expect(loop.statusCode).toBe(409)
    expect(loop.json().error).toBe('that would close a loop — Writer already answers_to Builder through Finance')
    expect((await put('writer', 'nobody')).statusCode).toBe(400)
    const got = await app.inject({ url: '/api/silos/lines/relations/answers_to', headers: owner })
    expect(got.json()).toMatchObject({
      silo: 'lines',
      relation: { name: 'answers_to', acyclic: true },
      edges: [
        { from: 'finance', to: 'builder' },
        { from: 'writer', to: 'finance' },
      ],
    })
    expect((await app.inject({ url: '/api/silos/lines/relations/nope', headers: owner })).statusCode).toBe(404)
    // the descriptor says the relation, the tree and the lens
    const d = (await app.inject({ url: '/api/silos', headers: owner })).json().silos[0]
    expect(d).toMatchObject({
      relations: [{ name: 'answers_to', from: 'agent', to: 'agent', acyclic: true }],
      tree: { view: 'tree', relation: 'answers_to' },
      lens: { over: 'tasks', label: 'by line', relation: 'answers_to', by: 'subtree' },
    })
    // an archived endpoint stays in the file, said
    registry.archive('finance')
    const g = await app.inject({ url: '/api/silos/lines/relations/answers_to', headers: owner })
    expect(g.json().edges).toEqual([
      { from: 'finance', to: 'builder', note: 'archived' },
      { from: 'writer', to: 'finance', note: 'archived' },
    ])
  })
  it('an agent bearer is refused (403), reading or writing — its own edge included', async () => {
    const r = await app.inject({ url: '/api/silos/lines/relations/answers_to', headers: bearer('writer') })
    expect(r.statusCode).toBe(403)
    const w = await app.inject({
      method: 'PUT',
      url: '/api/silos/lines/relations/answers_to',
      headers: bearer('writer'),
      payload: { from: 'writer', to: 'builder' },
    })
    expect(w.statusCode).toBe(403)
    expect(existsSync(join(base, 'data', 'silos', 'lines', 'relations.json'))).toBe(false)
    expect(agentMayRead('writer', '/api/silos/lines/relations/answers_to')).toBe(false)
    expect(agentMayWrite('writer', 'PUT', '/api/silos/lines/relations/answers_to')).toBe(false)
  })
})

describe('one org per project', () => {
  it('an edge never crosses projects; inside one it is written', () => {
    const root = mkdtempSync(join(tmpdir(), 'rel-proj-'))
    mkdirSync(join(root, 'lines'), { recursive: true })
    const folder: Record<string, string[]> = { builder: ['/p/alpha'], writer: ['/p/alpha'], finance: ['/p/beta'], web: ['/p/site', '/p/alpha'] }
    const lookup = { stateOf: () => 'ok' as const, projectsOf: (id: string) => folder[id] ?? [] }
    const s = new RelationStore(root)
    expect(s.set('lines', DECL, 'writer', 'builder', lookup).ok).toBe(true)
    const r = s.set('lines', DECL, 'finance', 'builder', lookup)
    expect(r).toMatchObject({ ok: false, code: 400 })
    expect(r.ok ? '' : r.reason).toMatch(/finance works in beta and builder in alpha — each project has its own org/)
    // a declared folder is membership (territoriesOf): Web, of site AND alpha, may report to Builder
    expect(s.set('lines', DECL, 'web', 'builder', lookup).ok).toBe(true)
  })
})
