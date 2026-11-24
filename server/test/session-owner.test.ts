import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { LineageStore } from '../src/lineage.js'
import { SessionOwners } from '../src/session-owner.js'
import type { Birth } from '../src/births-store.js'

// WHO a session belongs to — one rule for every surface (overview, titler,
// resident): the origin of a thread decides, by its own transcript (cwd +
// skills) or by Silos' birth record (native.json); every continuation
// (/clear rotation, --resume fork) inherits that, and the inheritance is
// written down (lineage.json owners) the moment it is resolved with
// certainty — so burying the origin (trash) or purging it never changes
// the owner (a Builder thread once read as Writer after a mass trash of Writer's
// history took the thread's root with it).
const user = (text: string): string =>
  JSON.stringify({ type: 'user', cwd: '/tmp/p', timestamp: '2026-10-21T10:00:00Z', message: { role: 'user', content: text } }) + '\n'
const skillCall = (skill: string): string =>
  JSON.stringify({
    type: 'assistant',
    cwd: '/tmp/p',
    timestamp: '2026-10-21T10:00:01Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] },
  }) + '\n'

async function harness() {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  const root = join(base, 'projects')
  const data = join(base, 'data')
  mkdirSync(join(root, '-tmp-p'), { recursive: true })
  mkdirSync(join(data, 'trash', '-tmp-p'), { recursive: true })
  const registry = new AgentRegistry(join(data, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder: '/tmp/p', default: true })
  registry.create({ id: 'builder', name: 'Builder', folder: '/tmp/p', skills: ['builder-skill'] })
  const index = claudeSessionIndex(root, join(data, 'cache.json'))
  const lineage = new LineageStore(join(data, 'lineage.json'))
  const native = new NativeStore(join(data, 'native.json'))
  // the plugin's birth markers (births-store.ts), faked by id
  const births = new Map<string, Birth>()
  // the OpenCode reader's agent DBs (reader.ts agentOfDb), faked by id
  const agentDb = new Map<string, string>()
  // ids the reader found in more than one DB (reader.ts isContested)
  const contested = new Set<string>()
  const owners = new SessionOwners({
    registry,
    native,
    lineage,
    index,
    trashDir: join(data, 'trash'),
    births: { get: (id) => births.get(id) ?? null },
    agentOfDb: (id) => agentDb.get(id) ?? null,
    isContested: (id) => contested.has(id),
  })
  // ctimeMs 0 = landed long before any transcript (a genuine birth) unless a test says otherwise
  const mark = (id: string, agentId: string, over: Partial<Birth> = {}): void => {
    births.set(id, { sessionId: id, agentId, parent: null, cwd: '/tmp/p', source: 'startup', at: '2026-10-26T10:00:00Z', ctimeMs: 0, ...over })
  }
  const write = (id: string, body: string): void => writeFileSync(join(root, '-tmp-p', `${id}.jsonl`), body)
  const meta = (id: string) => {
    const m = index.getMeta('-tmp-p', id)
    if (!m) throw new Error(`not indexed: ${id}`)
    return m
  }
  const bury = (id: string): void => {
    renameSync(join(root, '-tmp-p', `${id}.jsonl`), join(data, 'trash', '-tmp-p', `${id}.jsonl`))
    index.remove('-tmp-p', id)
  }
  return { base, root, data, registry, index, lineage, native, owners, write, meta, bury, mark, agentDb, contested }
}

describe('SessionOwners — the origin decides, continuations inherit', () => {
  let h: Awaited<ReturnType<typeof harness>>
  afterEach(() => h?.index.stopHeartbeat())

  // a folder nobody has as PRIMARY (/tmp/q): its sessions are master's
  // until an agent declares it as a secondary territory (folders[]).
  const inQ = (text: string): string =>
    JSON.stringify({ type: 'user', cwd: '/tmp/q', timestamp: '2026-10-21T10:00:00Z', message: { role: 'user', content: text } }) + '\n'
  const writeQ = (id: string, body: string): void => {
    mkdirSync(join(h.root, '-tmp-q'), { recursive: true })
    writeFileSync(join(h.root, '-tmp-q', `${id}.jsonl`), body)
  }
  const metaQ = (id: string) => {
    const m = h.index.getMeta('-tmp-q', id)
    if (!m) throw new Error(`not indexed: ${id}`)
    return m
  }

  it('an unrecorded, child-less external root in a secondary territory moves to that agent', async () => {
    h = await harness()
    writeQ('lone', inQ('hello'))
    await h.index.init()
    expect(h.owners.agentIdOf(metaQ('lone'))).toBe('master')
    h.registry.update('builder', { folders: ['/tmp/q'] })
    expect(h.owners.agentIdOf(metaQ('lone'))).toBe('builder')
  })

  it('declaring a secondary territory never splits a thread whose chain already has a recorded owner', async () => {
    h = await harness()
    writeQ('r', inQ('root'))
    writeQ('c', inQ('after clear'))
    await h.index.init()
    h.lineage.record('-tmp-q/c', '-tmp-q/r')
    expect(h.owners.agentIdOf(metaQ('c'))).toBe('master')
    expect(h.lineage.ownerOf('c')).toBe('master') // stamped
    h.registry.update('builder', { folders: ['/tmp/q'] })
    expect(h.owners.agentIdOf(metaQ('r'))).toBe('master')
    expect(h.owners.agentIdOf(metaQ('c'))).toBe('master')
  })

  it('siblings under a BURIED root resolve to the same owner after a secondary declaration', async () => {
    h = await harness()
    writeQ('R', inQ('root'))
    writeQ('A', inQ('branch a'))
    writeQ('B', inQ('branch b'))
    await h.index.init()
    h.lineage.record('-tmp-q/A', '-tmp-q/R')
    h.lineage.record('-tmp-q/B', '-tmp-q/R')
    h.lineage.recordOwner('A', 'master') // A's inheritance was written while R was master's
    mkdirSync(join(h.data, 'trash', '-tmp-q'), { recursive: true })
    renameSync(join(h.root, '-tmp-q', 'R.jsonl'), join(h.data, 'trash', '-tmp-q', 'R.jsonl'))
    h.index.remove('-tmp-q', 'R')
    h.registry.update('builder', { folders: ['/tmp/q'] })
    expect(h.owners.agentIdOf(metaQ('A'))).toBe('master')
    expect(h.owners.agentIdOf(metaQ('B'))).toBe('master')
  })

  it('a secondary root resolution reads the session list O(1) times, and memoizes until lineage changes', async () => {
    h = await harness()
    writeQ('r', inQ('root'))
    writeQ('c', inQ('after clear'))
    writeQ('lone', inQ('alone'))
    await h.index.init()
    h.lineage.record('-tmp-q/c', '-tmp-q/r')
    h.lineage.recordOwner('c', 'master')
    h.registry.update('builder', { folders: ['/tmp/q'] })
    const spy = vi.spyOn(h.index, 'allSessions')
    expect(h.owners.agentIdOf(metaQ('r'))).toBe('master')
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2)
    spy.mockClear()
    expect(h.owners.agentIdOf(metaQ('r'))).toBe('master')
    expect(h.owners.agentIdOf(metaQ('lone'))).toBe('builder')
    expect(spy.mock.calls.length).toBe(0) // memo hit: lineage unchanged
    spy.mockRestore()
  })

  // counted work, never the clock («well under a second» failed
  // under load): resolving N roots must not list every session per root — that
  // was N × N. The full list is read a bounded number of times, whatever N.
  it('hundreds of secondary roots with stamped chains resolve without listing every session per root', async () => {
    h = await harness()
    const N = 300
    for (let i = 0; i < N; i++) {
      writeQ(`r${i}`, inQ(`root ${i}`))
      writeQ(`c${i}`, inQ(`child ${i}`))
    }
    await h.index.init()
    for (let i = 0; i < N; i++) h.lineage.record(`-tmp-q/c${i}`, `-tmp-q/r${i}`)
    for (let i = 0; i < N; i++) h.lineage.recordOwner(`c${i}`, i % 2 ? 'master' : 'writer')
    h.registry.update('builder', { folders: ['/tmp/q'] })
    const list = vi.spyOn(h.index, 'allSessions')
    const perPass: number[] = []
    for (let pass = 0; pass < 3; pass++) {
      list.mockClear()
      for (let i = 0; i < N; i++) expect(h.owners.agentIdOf(metaQ(`r${i}`))).toBe(i % 2 ? 'master' : 'writer')
      perPass.push(list.mock.calls.length)
    }
    // one listing for the first pass at most (the memo's build), none after
    expect(perPass[0]).toBeLessThanOrEqual(2)
    expect(perPass.slice(1)).toEqual([0, 0])
    list.mockRestore()
  }, 30_000)

  it('a root is classified by its own transcript; a /clear child inherits and the inheritance is written down', async () => {
    h = await harness()
    h.write('r', user('you are my builder') + skillCall('builder-skill'))
    h.write('c', user('after clear'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    expect(h.owners.agentIdOf(h.meta('r'))).toBe('builder')
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('builder')
    expect(h.lineage.ownerOf('c')).toBe('builder') // persisted
    expect(h.lineage.ownerOf('r')).toBeNull() // the root's own transcript is its record
  })

  it('a buried root changes nothing once the inheritance was written', async () => {
    h = await harness()
    h.write('r', user('you are my builder') + skillCall('builder-skill'))
    h.write('c', user('after clear'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    h.owners.agentIdOf(h.meta('c'))
    h.bury('r')
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('builder')
  })

  it('a buried root that was never resolved is read from the trash — and the answer is then written down', async () => {
    h = await harness()
    h.write('r', user('you are my builder') + skillCall('builder-skill'))
    h.write('c', user('after clear'))
    h.write('g', user('after two clears'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    h.lineage.record('-tmp-p/g', '-tmp-p/c')
    h.bury('r')
    expect(h.owners.agentIdOf(h.meta('g'))).toBe('builder')
    expect(h.lineage.ownerOf('g')).toBe('builder')
    expect(h.lineage.ownerOf('c')).toBe('builder') // the whole chain under the buried root
  })

  it('a buried root also PURGED from the trash, with nothing written: the honest fallback (folder default), not frozen', async () => {
    h = await harness()
    h.write('c', user('after clear'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r') // r: known to lineage, no transcript anywhere
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('writer')
    expect(h.lineage.ownerOf('c')).toBeNull() // uncertain answers are never written
  })

  it('an ancestor not indexed YET (warm-up) is not frozen: once it lands, the child follows it', async () => {
    h = await harness()
    h.write('c', user('after clear'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('writer')
    h.write('r', user('you are my builder') + skillCall('builder-skill'))
    await h.index.refresh('-tmp-p', 'r', false)
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('builder')
    expect(h.lineage.ownerOf('c')).toBe('builder')
  })

  it("a buried root that is itself a --resume twin of a PURGED session decides by its own transcript (a twin copies its parent's history)", async () => {
    h = await harness()
    const twin =
      JSON.stringify({
        type: 'assistant',
        cwd: '/tmp/p',
        session_id: 'x',
        sessionId: 'r',
        timestamp: '2026-10-21T10:00:01Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'builder-skill' } }] },
      }) + '\n'
    h.write('c', user('after clear'))
    await h.index.init()
    writeFileSync(join(h.data, 'trash', '-tmp-p', 'r.jsonl'), twin)
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('builder')
    expect(h.lineage.ownerOf('c')).toBe('builder')
  })

  it('a buried --resume twin whose origin is still INDEXED defers to that origin', async () => {
    h = await harness()
    const twin =
      JSON.stringify({
        type: 'assistant',
        cwd: '/tmp/p',
        session_id: 'x',
        sessionId: 'r',
        timestamp: '2026-10-21T10:00:01Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'builder-skill' } }] },
      }) + '\n'
    h.write('x', user('born in Silos'))
    h.write('c', user('after clear'))
    await h.index.init()
    h.native.register('-tmp-p', 'x', { agentId: 'writer', createdAt: '2026-10-21T10:00:00Z' }) // x: Writer's, by birth record
    writeFileSync(join(h.data, 'trash', '-tmp-p', 'r.jsonl'), twin)
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('writer')
    expect(h.lineage.ownerOf('c')).toBe('writer')
  })

  it('a buried --resume twin whose buried origin has a Silos birth record defers to the record', async () => {
    h = await harness()
    const twin =
      JSON.stringify({
        type: 'assistant',
        cwd: '/tmp/p',
        session_id: 'x',
        sessionId: 'r',
        timestamp: '2026-10-21T10:00:01Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'builder-skill' } }] },
      }) + '\n'
    h.write('c', user('after clear'))
    await h.index.init()
    h.native.register('-tmp-p', 'x', { agentId: 'writer', createdAt: '2026-10-21T10:00:00Z' })
    writeFileSync(join(h.data, 'trash', '-tmp-p', 'x.jsonl'), user('born in Silos'))
    writeFileSync(join(h.data, 'trash', '-tmp-p', 'r.jsonl'), twin)
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('writer')
  })

  it('a buried root trashed twice (suffixed copy) is still found', async () => {
    h = await harness()
    h.write('c', user('after clear'))
    await h.index.init()
    writeFileSync(join(h.data, 'trash', '-tmp-p', 'r-2.jsonl'), user('you are my builder') + skillCall('builder-skill'))
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('builder')
  })

  it('a Silos-born session (native.json) belongs to its birth agent, whatever its transcript says', async () => {
    h = await harness()
    h.write('n', user('hello') + skillCall('builder-skill'))
    await h.index.init()
    h.native.register('-tmp-p', 'n', { agentId: 'writer', createdAt: '2026-10-21T10:00:00Z' })
    expect(h.owners.agentIdOf(h.meta('n'))).toBe('writer')
  })

  it('an archived owner is out of play: the rule falls through to the transcript', async () => {
    h = await harness()
    h.write('r', user('you are my builder') + skillCall('builder-skill'))
    h.write('c', user('after clear'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    h.lineage.recordOwner('c', 'ghost') // an agent that no longer exists
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('builder')
  })

  it('stampThreadOf: before an ancestor is buried, every indexed descendant gets its owner written', async () => {
    h = await harness()
    h.write('r', user('you are my builder') + skillCall('builder-skill'))
    h.write('c', user('after clear'))
    h.write('g', user('after two clears'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    h.lineage.record('-tmp-p/g', '-tmp-p/c')
    const stamped = h.owners.stampDescendantsOf('r')
    expect(new Set(stamped)).toEqual(new Set(['c', 'g']))
    expect(JSON.parse(readFileSync(join(h.data, 'lineage.json'), 'utf8')).owners).toEqual({ c: 'builder', g: 'builder' })
  })

  // births (plugin 0.7.0): every session presents itself at start — a
  // `claude -p` an agent launched from Bash has no native.json record, but
  // its marker names the agent whose env it inherited.
  it('a startup birth marker beats classify-by-transcript', async () => {
    h = await harness()
    h.write('k', user('smoke run') + skillCall('builder-skill'))
    await h.index.init()
    h.mark('k', 'writer')
    expect(h.owners.agentIdOf(h.meta('k'))).toBe('writer')
  })

  it('the native record beats the marker (the owner moved the thread, or Silos launched it)', async () => {
    h = await harness()
    h.write('k', user('hello'))
    await h.index.init()
    h.mark('k', 'writer')
    h.native.register('-tmp-p', 'k', { agentId: 'builder', createdAt: '2026-10-26T10:00:00Z' })
    expect(h.owners.agentIdOf(h.meta('k'))).toBe('builder')
  })

  it('a marker naming an archived agent falls through to the transcript', async () => {
    h = await harness()
    h.write('k', user('hello') + skillCall('builder-skill'))
    await h.index.init()
    h.registry.update('writer', { archived: true })
    h.mark('k', 'writer')
    expect(h.owners.agentIdOf(h.meta('k'))).toBe('builder')
  })

  it("a clear/resume marker is a continuation, not a birth: the thread's origin still decides", async () => {
    h = await harness()
    h.write('r', user('you are my builder') + skillCall('builder-skill'))
    h.write('c', user('after clear'))
    await h.index.init()
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    h.mark('c', 'writer', { source: 'clear', parent: 'r' })
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('builder')
  })

  it('nestedBirthOf: a startup marker with no native record is nested; Silos-born or continuation is not', async () => {
    h = await harness()
    h.write('k', user('smoke'))
    h.write('n', user('owner chat'))
    h.write('c', user('after clear'))
    h.write('plain', user('external'))
    await h.index.init()
    h.mark('k', 'writer', { parent: 'n' })
    h.mark('n', 'writer', { parent: 'n' })
    h.native.register('-tmp-p', 'n', { agentId: 'writer', createdAt: '2026-10-26T10:00:00Z' })
    h.mark('c', 'writer', { source: 'clear' })
    expect(h.owners.nestedBirthOf(h.meta('k'))).toMatchObject({ agentId: 'writer', parent: 'n' })
    expect(h.owners.nestedBirthOf(h.meta('n'))).toBeNull()
    expect(h.owners.nestedBirthOf(h.meta('c'))).toBeNull()
    expect(h.owners.nestedBirthOf(h.meta('plain'))).toBeNull()
  })

  // security: a marker counts only if it landed (ctime —
  // cannot be backdated) no later than 120 s after the session's transcript
  // was born. Session ids are random UUIDs: a marker cannot be planted
  // ahead of time, and a late one is a forgery.
  it('a marker that landed after the session started (+120 s) is ignored, whatever its `at` says', async () => {
    h = await harness()
    h.write('k', user('owner chat') + skillCall('builder-skill'))
    await h.index.init()
    const started = h.meta('k').startedAt!
    expect(started).toBeGreaterThan(0)
    h.mark('k', 'writer', { ctimeMs: started + 121_000, at: '2000-01-01T00:00:00Z' })
    expect(h.owners.agentIdOf(h.meta('k'))).toBe('builder')
    expect(h.owners.nestedBirthOf(h.meta('k'))).toBeNull()
    h.mark('k', 'writer', { ctimeMs: started + 60_000 })
    expect(h.owners.agentIdOf(h.meta('k'))).toBe('writer')
  })

  it('nestedOf: a parent that resolves to another agent is nulled', async () => {
    h = await harness()
    h.write('p', user('builder thread') + skillCall('builder-skill'))
    h.write('k', user('smoke'))
    await h.index.init()
    h.mark('k', 'writer', { parent: 'p' })
    expect(h.owners.nestedOf(h.meta('k'))).toEqual({ agentId: 'writer', parent: null })
    h.native.register('-tmp-p', 'p', { agentId: 'writer', createdAt: '2026-10-26T10:00:00Z' })
    expect(h.owners.nestedOf(h.meta('k'))).toEqual({ agentId: 'writer', parent: 'p' })
  })

  it('nestedOf: an unindexed parent is nulled (loose)', async () => {
    h = await harness()
    h.write('k', user('smoke'))
    await h.index.init()
    h.mark('k', 'writer', { parent: 'nowhere' })
    expect(h.owners.nestedOf(h.meta('k'))).toEqual({ agentId: 'writer', parent: null })
  })

  // the console keeps the key it was launched with as SILOS_SESSION_ID
  // across /clear: the effective parent is the thread's session that was
  // current when the marker landed — the newest descendant started by then.
  it('nestedOf: the effective parent follows /clear by time, both directions', async () => {
    h = await harness()
    h.write('r', user('before clear'))
    await new Promise((res) => setTimeout(res, 30))
    h.write('c', user('after clear'))
    h.write('k', user('smoke'))
    await h.index.init()
    h.native.register('-tmp-p', 'r', { agentId: 'writer', createdAt: '2026-10-26T10:00:00Z' })
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    const cStart = h.meta('c').startedAt!
    expect(cStart).toBeGreaterThan(h.meta('r').startedAt!)
    h.mark('k', 'writer', { parent: 'r', ctimeMs: cStart - 5 })
    expect(h.owners.nestedOf(h.meta('k'))?.parent).toBe('r')
    h.mark('k', 'writer', { parent: 'r', ctimeMs: cStart + 5 })
    expect(h.owners.nestedOf(h.meta('k'))?.parent).toBe('c')
  })

  // session ids are readable on disk, so an agent could plant
  // an in-window startup marker for the owner's `--resume` fork or `/clear`
  // rotation. A genuine nested `claude -p` is never a continuation.
  it('a startup marker never claims a continuation (master --resume fork, /clear rotation)', async () => {
    h = await harness()
    const inQ = (text: string, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({ type: 'user', cwd: '/tmp/q', timestamp: '2026-10-26T10:00:00Z', message: { role: 'user', content: text }, ...extra }) + '\n'
    mkdirSync(join(h.root, '-tmp-q'), { recursive: true })
    writeFileSync(join(h.root, '-tmp-q', 'orig.jsonl'), inQ('owner terminal'))
    // a --resume fork: Claude Code stamps the new file with its origin
    writeFileSync(join(h.root, '-tmp-q', 'fork.jsonl'), inQ('owner terminal', { session_id: 'orig', sessionId: 'fork' }) + inQ('more', { sessionId: 'fork' }))
    h.write('r', user('you are my builder') + skillCall('builder-skill'))
    h.write('c', user('after clear'))
    await h.index.init()
    const fork = h.index.getMeta('-tmp-q', 'fork')!
    expect(fork.resumedFrom).toBe('orig')
    expect(h.owners.agentIdOf(fork)).toBe('master')
    h.mark('fork', 'writer')
    expect(h.owners.agentIdOf(fork)).toBe('master')
    expect(h.owners.nestedBirthOf(fork)).toBeNull()
    // a /clear rotation recorded in lineage
    h.lineage.record('-tmp-p/c', '-tmp-p/r')
    h.mark('c', 'writer')
    expect(h.owners.agentIdOf(h.meta('c'))).toBe('builder')
    expect(h.owners.nestedBirthOf(h.meta('c'))).toBeNull()
  })

  it('two agents claiming one session: neither marker counts, lineage/classify decide', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-claim-'))
    const { AgentStateStore } = await import('../src/agent-state.js')
    const { BirthsStore } = await import('../src/births-store.js')
    h = await harness()
    h.write('k', user('owner chat') + skillCall('builder-skill'))
    await h.index.init()
    const births = new BirthsStore(new AgentStateStore(base), { ttlMs: 0 })
    for (const agent of ['writer', 'builder']) {
      mkdirSync(join(base, agent, 'births'), { recursive: true })
      writeFileSync(
        join(base, agent, 'births', 'k.json'),
        JSON.stringify({ sessionId: 'k', agentId: agent, parent: null, cwd: '/tmp/p', source: 'startup', at: '2026-10-26T10:00:00Z' }),
      )
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const owners = new SessionOwners({ registry: h.registry, native: h.native, lineage: h.lineage, index: h.index, trashDir: null, births })
    h.mark('k', 'writer') // the harness fake is not used by this resolver
    expect(owners.nestedBirthOf(h.meta('k'))).toBeNull()
    expect(owners.agentIdOf(h.meta('k'))).toBe('builder') // by its transcript's skill
    warn.mockRestore()
  })
})

describe("SessionOwners — an agent's own OpenCode DB decides", () => {
  let h: Awaited<ReturnType<typeof harness>>
  afterEach(() => h?.index.stopHeartbeat())

  it('a session read from agents/<id>/opencode.db belongs to <id>, over the transcript and a startup marker', async () => {
    h = await harness()
    h.write('ses_c', user('hello') + skillCall('builder-skill'))
    await h.index.init()
    const m = { ...h.meta('ses_c'), harness: 'opencode' as const }
    expect(h.owners.agentIdOf(m)).toBe('builder') // classifier, before the DB says anything
    h.registry.create({ id: 'finance', name: 'Finance', folder: '/tmp/x' })
    h.agentDb.set('ses_c', 'finance')
    h.mark('ses_c', 'writer')
    expect(h.owners.agentIdOf(m)).toBe('finance')
  })

  it('a global-DB session (agentOfDb null) falls to the classifier; native still comes first', async () => {
    h = await harness()
    h.write('ses_g', user('hello') + skillCall('builder-skill'))
    await h.index.init()
    const m = { ...h.meta('ses_g'), harness: 'opencode' as const }
    expect(h.owners.agentIdOf(m)).toBe('builder')
    // native names a third agent — neither the classifier's (builder) nor the DB's (writer)
    h.registry.create({ id: 'finance', name: 'Finance', folder: '/tmp/x' })
    h.agentDb.set('ses_g', 'writer')
    h.native.register('-tmp-p', 'ses_g', { agentId: 'finance', createdAt: '2026-10-26T10:00:00Z' })
    expect(h.owners.agentIdOf(m)).toBe('finance')
  })

  // the seal-then-contest race: X copies Y's ses_ id into its
  // own DB and wins the registrar's sweep before Y's DB is discovered. Once
  // the reader reports the id in two DBs, the native record it sealed is
  // not honoured — the session has no owner on record, like the reader says.
  it('a native record for a CONTESTED OpenCode id is not honoured', async () => {
    h = await harness()
    h.write('ses_x', user('hello') + skillCall('builder-skill'))
    await h.index.init()
    const m = { ...h.meta('ses_x'), harness: 'opencode' as const }
    h.registry.create({ id: 'finance', name: 'Finance', folder: '/tmp/x' })
    h.native.register('-tmp-p', 'ses_x', { agentId: 'finance', createdAt: '2026-10-26T10:00:00Z' })
    expect(h.owners.agentIdOf(m)).toBe('finance')
    h.contested.add('ses_x')
    expect(h.owners.agentIdOf(m)).toBe('builder') // the classifier, as for any unowned session
  })

  it("a contest never voids a Claude session's native record (only ses_ ids are contestable)", async () => {
    h = await harness()
    h.write('n', user('hello') + skillCall('builder-skill'))
    await h.index.init()
    h.native.register('-tmp-p', 'n', { agentId: 'writer', createdAt: '2026-10-21T10:00:00Z' })
    h.contested.add('n')
    expect(h.owners.agentIdOf(h.meta('n'))).toBe('writer')
  })
})
