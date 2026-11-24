import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'
import { BirthsStore } from '../src/births-store.js'
import { NativeStore } from '../src/native-store.js'
import { mungePath } from '../src/agent-registry.js'
import { ConsoleRegistrar } from '../src/harnesses/opencode/registrar.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { TerminalService } from '../src/terminal-service.js'

// An OpenCode console cannot be born under a Silos-chosen id: the plugin
// reports the id it got in a birth marker (consoleKey = the console Silos
// launched it in), and the registrar seals it — native.json + the
// console's key ↔ native id binding — once that console is live.
function harness() {
  const base = mkdtempSync(join(tmpdir(), 'oc-reg-'))
  const births = new BirthsStore(new AgentStateStore(join(base, 'agent-state')), { ttlMs: 0 })
  const native = new NativeStore(join(base, 'native.json'))
  const bound: [string, string][] = []
  // live consoles: the agent Silos launched each for (null = not recorded)
  // and when tmux created it; bindings as TerminalService keeps them
  const consoles = new Map<string, { agent: string | null; createdMs: number | null }>([
    ['live', { agent: 'writer', createdMs: 0 }],
    ['builder-live', { agent: 'builder', createdMs: 0 }],
    ['unrecorded', { agent: null, createdMs: 0 }],
    ['young', { agent: 'writer', createdMs: Date.now() + 60_000 }], // created after any marker written now
  ])
  const byKey = new Map<string, string>()
  // the reader's agentOfDb — put() files each session in its agent's DB unless told otherwise
  const agentDb = new Map<string, string>()
  let listings = 0
  const terminals = {
    listConsoles: () => {
      listings++
      return [...consoles].map(([key, c]) => ({ key, attached: 0, createdMs: c.createdMs }))
    },
    consoleAgent: (k: string) => consoles.get(k)?.agent ?? null,
    nativeIdOf: (k: string) => byKey.get(k) ?? null,
    bindNativeId: (k: string, id: string) => {
      bound.push([k, id])
      byKey.set(k, id)
    },
    setConsoleAgent: (k: string, agentId: string) => {
      const c = consoles.get(k)
      if (c) c.agent = agentId
    },
    consoleRecords: () => [],
    // the Silos-owned record: launch agent, creation time, the account picked
    consoleRecord: (k: string) => {
      const c = consoles.get(k)
      return c
        ? {
            key: k,
            agentId: c.agent,
            harness: 'opencode' as const,
            createdMs: c.createdMs ?? 0,
            ...(picks.has(k) ? { providerPick: picks.get(k)! } : {}),
            ...(modelPicks.has(k) ? { modelPick: modelPicks.get(k)! } : {}),
          }
        : null
    },
  }
  const picks = new Map<string, string>()
  const modelPicks = new Map<string, string>()
  const pinned: [string, string, string][] = []
  const pinnedModels: [string, string, string][] = []
  // ids the reader found in more than one DB (reader.ts isContested)
  const contested = new Set<string>()
  const registrar = new ConsoleRegistrar({
    births,
    native,
    terminals,
    mungePath,
    agentOfDb: (id) => agentDb.get(id) ?? null,
    isContested: (id) => contested.has(id),
    pinProvider: (folder, id, provider) => {
      pinned.push([folder, id, provider])
    },
    pinModel: (folder, id, model) => {
      pinnedModels.push([folder, id, model])
    },
  })
  const put = (agent: string, id: string, over: Record<string, unknown> = {}, inDb: string | null = agent): void => {
    const dir = join(base, 'agent-state', agent, 'births')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        sessionId: id,
        agentId: agent,
        parent: null,
        cwd: '/p',
        source: 'startup',
        harness: 'opencode',
        consoleKey: 'live',
        at: '2026-10-26T10:00:00Z',
        ...over,
      }),
    )
    if (inDb) agentDb.set(id, inDb)
    else agentDb.delete(id)
  }
  return { births, native, bound, registrar, put, byKey, agentDb, contested, consoles, picks, pinned, listings: () => listings, modelPicks, pinnedModels }
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('ConsoleRegistrar', () => {
  it('seals a marker whose console is live; a dead console is left alone; idempotent', async () => {
    const h = harness()
    h.put('writer', 'ses_a')
    h.put('writer', 'ses_b', { consoleKey: 'dead' })
    expect(await h.registrar.sweep()).toBe(1)
    expect(h.native.get('-p', 'ses_a')).toEqual({ agentId: 'writer', createdAt: '2026-10-26T10:00:00Z' })
    expect(h.native.get('-p', 'ses_b')).toBeNull()
    expect(h.bound).toEqual([['live', 'ses_a']])
    expect(await h.registrar.sweep()).toBe(0)
    expect(h.bound).toHaveLength(1)
  })

  it("never seals a child/subagent session (it shares its parent's consoleKey)", async () => {
    const h = harness()
    h.put('writer', 'ses_child', { parent: 'ses_a' })
    expect(await h.registrar.sweep()).toBe(0)
    expect(h.native.get('-p', 'ses_child')).toBeNull()
    expect(h.bound).toEqual([])
  })

  it('ignores Claude markers and markers without a consoleKey', async () => {
    const h = harness()
    h.put('writer', 'claude-1', { harness: undefined, consoleKey: undefined })
    h.put('writer', 'ses_x', { consoleKey: null })
    expect(await h.registrar.sweep()).toBe(0)
    expect(h.bound).toEqual([])
  })

  it('a marker without a cwd is skipped with one warning', async () => {
    const h = harness()
    h.put('writer', 'ses_nocwd', { cwd: null })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    expect(await h.registrar.sweep()).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    expect(h.bound).toEqual([])
  })

  // agents share the uid and can read every console key off
  // the tmux socket — a live key alone proves nothing.
  it("a marker naming ANOTHER agent's live console is refused, warned once", async () => {
    const h = harness()
    h.put('writer', 'ses_steal', { consoleKey: 'builder-live' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    expect(await h.registrar.sweep()).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^opencode registrar: marker ses_steal refused — /)
    warn.mockRestore()
    expect(h.native.get('-p', 'ses_steal')).toBeNull()
    expect(h.bound).toEqual([])
  })

  it("a session the reader attributes to a different agent's DB is refused; unknown (null) is allowed", async () => {
    const h = harness()
    h.put('writer', 'ses_other')
    h.agentDb.set('ses_other', 'builder')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    warn.mockRestore()
    expect(h.bound).toEqual([])
    h.agentDb.set('ses_other', 'writer')
    expect(await h.registrar.sweep()).toBe(1)
  })

  it('an already-bound console key is never re-bound', async () => {
    const h = harness()
    h.byKey.set('live', 'ses_first')
    h.put('writer', 'ses_second')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    warn.mockRestore()
    expect(h.native.get('-p', 'ses_second')).toBeNull()
    expect(h.bound).toEqual([])
  })

  it('one console listing per sweep, and none when nothing is pending', async () => {
    const h = harness()
    h.put('writer', 'ses_a')
    h.put('writer', 'ses_b', { consoleKey: 'dead' })
    h.put('writer', 'ses_c', { consoleKey: 'dead2' })
    await h.registrar.sweep()
    expect(h.listings()).toBe(1)
    const h2 = harness()
    h2.put('writer', 'claude-1', { harness: undefined, consoleKey: undefined })
    await h2.registrar.sweep()
    expect(h2.listings()).toBe(0)
  })

  // the session id itself must be the agent's own
  // OpenCode session — a marker can name ANY id (a Claude UUID of another
  // agent, a global-DB ses_) and a native record would beat every other rule.
  it('a marker naming a Claude session (unknown to the reader) is never sealed — silently waits', async () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.put('writer', '0b9c6a52-1111-4222-8333-444455556666', { cwd: '/tmp/victim' }, null)
    expect(await h.registrar.sweep()).toBe(0)
    expect(h.native.get('-tmp-victim', '0b9c6a52-1111-4222-8333-444455556666')).toBeNull()
    expect(h.bound).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a marker naming a global-DB ses_ session (agentOfDb null) is never sealed', async () => {
    const h = harness()
    h.put('writer', 'ses_global', {}, null)
    expect(await h.registrar.sweep()).toBe(0)
    expect(h.native.get('-p', 'ses_global')).toBeNull()
    expect(h.bound).toEqual([])
  })

  it('a marker older than the console it names is refused', async () => {
    const h = harness()
    h.put('writer', 'ses_planted', { consoleKey: 'young' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/marker ses_planted refused — the marker is older than console young/)
    warn.mockRestore()
    expect(h.native.get('-p', 'ses_planted')).toBeNull()
    expect(h.bound).toEqual([])
  })

  it("a marker whose session lands in the agent's DB later is sealed on the following sweep", async () => {
    const h = harness()
    h.put('writer', 'ses_late', {}, null)
    expect(await h.registrar.sweep()).toBe(0)
    h.agentDb.set('ses_late', 'writer')
    expect(await h.registrar.sweep()).toBe(1)
    expect(h.native.get('-p', 'ses_late')).toEqual({ agentId: 'writer', createdAt: '2026-10-26T10:00:00Z' })
    expect(h.bound).toEqual([['live', 'ses_late']])
  })

  it('a console whose agent is not recorded yet: wait, no warning', async () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.put('writer', 'ses_early', { consoleKey: 'unrecorded' })
    expect(await h.registrar.sweep()).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(h.bound).toEqual([])
  })

  // an id copied into a second DB is contested —
  // the reader drops its owner, and the registrar never seals it.
  it('a contested id is refused (warned once), never sealed', async () => {
    const h = harness()
    h.put('writer', 'ses_dup')
    h.contested.add('ses_dup')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    expect(await h.registrar.sweep()).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/marker ses_dup refused — the session is in more than one database/)
    warn.mockRestore()
    expect(h.native.get('-p', 'ses_dup')).toBeNull()
    expect(h.bound).toEqual([])
  })
})

// After a Silos restart the terminals' key ↔ native id map and each
// console's launch agent are gone (memory only) while the tmux consoles
// live on. rehydrate() rebuilds both from the Silos-owned console records
// only (terminal-service: written at launch and on bind), intersected with
// the live tmux keys — never from a marker (agent-writable).
describe('ConsoleRegistrar.rehydrate', () => {
  type Rec = { key: string; agentId: string | null; harness: 'opencode' | 'claude-code'; createdMs: number; nativeId?: string }
  function withRecords(records: Rec[]) {
    const h = harness()
    for (const k of h.consoles.keys()) h.consoles.get(k)!.agent = null // restart: nothing in memory
    const terminals = {
      listConsoles: () => [...h.consoles].map(([key, c]) => ({ key, attached: 0, createdMs: c.createdMs })),
      consoleAgent: (k: string) => h.consoles.get(k)?.agent ?? null,
      nativeIdOf: (k: string) => h.byKey.get(k) ?? null,
      bindNativeId: (k: string, id: string) => {
        h.bound.push([k, id])
        h.byKey.set(k, id)
      },
      setConsoleAgent: (k: string, a: string) => {
        const c = h.consoles.get(k)
        if (c) c.agent = a
      },
      consoleRecords: () => records,
      consoleRecord: (k: string) => records.find((r) => r.key === k) ?? null,
    }
    const registrar = new ConsoleRegistrar({
      births: h.births,
      native: h.native,
      terminals,
      mungePath,
      agentOfDb: (id) => h.agentDb.get(id) ?? null,
      isContested: (id) => h.contested.has(id),
    })
    return { ...h, registrar }
  }

  it('rebinds a live console from its record and restores its launch agent', async () => {
    const h = withRecords([{ key: 'live', agentId: 'writer', harness: 'opencode', createdMs: 0, nativeId: 'ses_a' }])
    expect(await h.registrar.rehydrate()).toBe(1)
    expect(h.bound).toEqual([['live', 'ses_a']])
    expect(h.consoles.get('live')!.agent).toBe('writer')
  })

  it('an unbound record restores the agent only (the registrar can then seal its marker)', async () => {
    const h = withRecords([{ key: 'live', agentId: 'writer', harness: 'opencode', createdMs: 0 }])
    expect(await h.registrar.rehydrate()).toBe(0)
    expect(h.consoles.get('live')!.agent).toBe('writer')
    h.put('writer', 'ses_after')
    expect(await h.registrar.sweep()).toBe(1)
    expect(h.bound).toEqual([['live', 'ses_after']])
  })

  // agent X rewrites its own sealed marker to name Y's live
  // console — at boot that must not make the console X's nor bind it.
  it("a forged marker naming another agent's live console does not rehydrate", async () => {
    const h = withRecords([{ key: 'builder-live', agentId: 'builder', harness: 'opencode', createdMs: 0 }])
    h.put('writer', 'ses_x', { consoleKey: 'builder-live' })
    h.native.register('-p', 'ses_x', { agentId: 'writer', createdAt: 'x' })
    await h.registrar.rehydrate()
    expect(h.bound).toEqual([])
    expect(h.consoles.get('builder-live')!.agent).toBe('builder')
  })

  it('no record → nothing; a record of a dead console, a Claude console or a contested id → no binding', async () => {
    const h = withRecords([
      { key: 'gone', agentId: 'writer', harness: 'opencode', createdMs: 0, nativeId: 'ses_g' },
      { key: 'young', agentId: 'writer', harness: 'claude-code', createdMs: 0, nativeId: 'ses_c' },
      { key: 'unrecorded', agentId: 'writer', harness: 'opencode', createdMs: 0, nativeId: 'ses_dup' },
    ])
    h.contested.add('ses_dup')
    h.put('writer', 'ses_a') // a marker without a record proves nothing at boot
    h.native.register('-p', 'ses_a', { agentId: 'writer', createdAt: 'x' })
    expect(await h.registrar.rehydrate()).toBe(0)
    expect(h.bound).toEqual([])
    expect(h.consoles.get('live')!.agent).toBeNull()
    expect(h.consoles.get('young')!.agent).toBeNull()
  })

  it('an already-bound key is left as it is', async () => {
    const h = withRecords([{ key: 'live', agentId: 'writer', harness: 'opencode', createdMs: 0, nativeId: 'ses_a' }])
    h.byKey.set('live', 'ses_now')
    expect(await h.registrar.rehydrate()).toBe(0)
    expect(h.bound).toEqual([])
  })
})

describe('ConsoleRegistrar.sweep — one key, one claim', () => {
  it('two markers claiming one console key seal nothing (warned once each)', async () => {
    const h = harness()
    h.put('writer', 'ses_1')
    h.put('writer', 'ses_2')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    expect(await h.registrar.sweep()).toBe(0)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/claimed by more than one marker/)
    warn.mockRestore()
    expect(h.bound).toEqual([])
    expect(h.native.get('-p', 'ses_1')).toBeNull()
  })

  it('a key the route already bound to this very id is sealed (the binding stands)', async () => {
    const h = harness()
    h.byKey.set('live', 'ses_a')
    h.put('writer', 'ses_a')
    expect(await h.registrar.sweep()).toBe(1)
    expect(h.native.get('-p', 'ses_a')?.agentId).toBe('writer')
  })
})

// the same against real TerminalServices (fake tmux): one launches and
// binds, a fresh one (the restart) reads the records back.
describe('ConsoleRegistrar.rehydrate — real TerminalService across a restart', () => {
  const svcs: TerminalService[] = []
  afterEach(async () => {
    for (const s of svcs.splice(0)) {
      s.killAll()
      s.stopReaper()
    }
  })

  it('records written at launch and bind rebuild nativeIdOf / keyOfNativeId / consoleAgent / consolePort', async () => {
    const base = mkdtempSync(join(tmpdir(), 'oc-reh-'))
    const cwd = mkdtempSync(join(tmpdir(), 'oc-reh-cwd-'))
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder: cwd })
    mkdirSync(join(base, 'projects'), { recursive: true })
    const index = claudeSessionIndex(join(base, 'projects'), join(base, 'cache.json'))
    await index.init()
    const mk = (): TerminalService => {
      const s = new TerminalService(registry, index, 30 * 60_000, 60_000, {
        tmuxSocket: `silos-reh-${process.pid}`,
        envDir: join(base, 'env'),
        consolesDir: join(base, 'consoles'),
      })
      ;(s as unknown as { tmux: (a: string[]) => void }).tmux = () => {}
      vi.spyOn(s, 'listConsoles').mockReturnValue([{ key: 'k-new', attached: 0, createdMs: 0 }])
      svcs.push(s)
      return s
    }
    const before = mk()
    await before.ensureConsole({ cwd, key: 'k-new', command: ['opencode'], agentId: 'writer', harness: 'opencode', port: 4321, serverPassword: 'pw' })
    before.bindNativeId('k-new', 'ses_born')
    expect(statSync(join(base, 'consoles')).mode & 0o777).toBe(0o700)
    expect(statSync(join(base, 'consoles', 'k-new.json')).mode & 0o777).toBe(0o600)
    const after = mk() // the restart: empty maps
    expect(after.nativeIdOf('k-new')).toBeNull()
    const registrar = new ConsoleRegistrar({
      births: new BirthsStore(new AgentStateStore(join(base, 'agent-state')), { ttlMs: 0 }),
      native: new NativeStore(join(base, 'native.json')),
      terminals: after,
      mungePath,
      agentOfDb: () => null,
      isContested: () => false,
    })
    expect(await registrar.rehydrate()).toBe(1)
    expect(after.nativeIdOf('k-new')).toBe('ses_born')
    expect(after.keyOfNativeId('ses_born')).toBe('k-new')
    expect(after.consoleAgent('k-new')).toBe('writer')
    expect(after.consolePort('k-new')).toBe(4321)
    expect(after.consoleRecord('k-new')?.serverPassword).toBe('pw')
    // killing the console removes its record
    await after.killConsole('k-new')
    expect(existsSync(join(base, 'consoles', 'k-new.json'))).toBe(false)
  })

  // the record is written BEFORE the spawn (a crash after it can never leave
  // a live console without one) and removed when tmux fails
  it('when tmux fails to spawn, no record remains', async () => {
    const base = mkdtempSync(join(tmpdir(), 'oc-rec-'))
    const cwd = mkdtempSync(join(tmpdir(), 'oc-rec-cwd-'))
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder: cwd })
    mkdirSync(join(base, 'projects'), { recursive: true })
    const index = claudeSessionIndex(join(base, 'projects'), join(base, 'cache.json'))
    await index.init()
    const s = new TerminalService(registry, index, 30 * 60_000, 60_000, {
      tmuxSocket: `silos-rec-${process.pid}`,
      envDir: join(base, 'env'),
      consolesDir: join(base, 'consoles'),
    })
    svcs.push(s)
    let seenBeforeSpawn = false
    ;(s as unknown as { tmux: (a: string[]) => void }).tmux = (a) => {
      if (a.includes('new-session')) {
        seenBeforeSpawn = existsSync(join(base, 'consoles', 'k-fail.json'))
        throw new Error('tmux new-session failed: boom')
      }
    }
    await expect(
      s.ensureConsole({ cwd, key: 'k-fail', command: ['opencode'], agentId: 'writer', harness: 'opencode', port: 1, serverPassword: 'pw' }),
    ).rejects.toThrow(/boom/)
    expect(seenBeforeSpawn).toBe(true)
    expect(existsSync(join(base, 'consoles', 'k-fail.json'))).toBe(false)
    expect(s.consoleRecord('k-fail')).toBeNull()
  })
})

// The account the owner picked for a NEW OpenCode
// console lives in its Silos-owned record until the session id is known;
// the seal pins it on the conversation, so a wake, a headless turn or the
// runs-on line never fall back to the agent's provider in silence.
describe("ConsoleRegistrar.sweep — the console's account pick", () => {
  it("a seal copies the record's providerPick to the conversation", async () => {
    const h = harness()
    h.picks.set('live', 'p-minimax')
    h.put('writer', 'ses_a')
    expect(await h.registrar.sweep()).toBe(1)
    expect(h.pinned).toEqual([['-p', 'ses_a', 'p-minimax']])
  })

  it("a seal copies the record's modelPick to the conversation too (the panel's pending pin for a new console)", async () => {
    const h = harness()
    h.picks.set('live', 'p-minimax')
    h.modelPicks.set('live', 'MiniMax-M3')
    h.put('writer', 'ses_a')
    expect(await h.registrar.sweep()).toBe(1)
    expect(h.pinned).toEqual([['-p', 'ses_a', 'p-minimax']])
    expect(h.pinnedModels).toEqual([['-p', 'ses_a', 'MiniMax-M3']])
  })

  it('no pick → nothing pinned (the conversation follows the agent, as before)', async () => {
    const h = harness()
    h.put('writer', 'ses_a')
    expect(await h.registrar.sweep()).toBe(1)
    expect(h.pinned).toEqual([])
  })
})

// `/new` inside an OpenCode console starts a second
// session under the SAME console key. Same agent + same key + newer than the
// current seal is the proof: it is sealed as a new conversation and the
// binding moves to it; the previous one keeps its record.
describe('ConsoleRegistrar.sweep — /new inside a console', () => {
  it("two markers on one key, both in the agent's DB, sealed one after the other: both native, binding on the newer", async () => {
    const h = harness()
    h.picks.set('live', 'p-minimax')
    h.put('writer', 'ses_first')
    expect(await h.registrar.sweep()).toBe(1)
    await tick()
    h.put('writer', 'ses_second')
    expect(await h.registrar.sweep()).toBe(1)
    expect(h.native.get('-p', 'ses_first')?.agentId).toBe('writer')
    expect(h.native.get('-p', 'ses_second')?.agentId).toBe('writer')
    expect(h.bound).toEqual([
      ['live', 'ses_first'],
      ['live', 'ses_second'],
    ])
    expect(h.byKey.get('live')).toBe('ses_second')
    // the console's account rides along to the new conversation
    expect(h.pinned).toEqual([
      ['-p', 'ses_first', 'p-minimax'],
      ['-p', 'ses_second', 'p-minimax'],
    ])
    expect(await h.registrar.sweep()).toBe(0) // idempotent
  })

  it('a marker from ANOTHER agent naming that key is refused as before', async () => {
    const h = harness()
    h.put('writer', 'ses_first')
    expect(await h.registrar.sweep()).toBe(1)
    await tick()
    h.put('builder', 'ses_intruder', { consoleKey: 'live' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    warn.mockRestore()
    expect(h.native.get('-p', 'ses_intruder')).toBeNull()
    expect(h.byKey.get('live')).toBe('ses_first')
  })

  it('a marker older than the current seal is refused', async () => {
    const h = harness()
    h.put('writer', 'ses_old')
    h.agentDb.delete('ses_old') // not in the DB yet: waits
    expect(await h.registrar.sweep()).toBe(0)
    await tick()
    // the console's current seal is a NEWER session (sealed and bound)
    h.put('writer', 'ses_current')
    h.native.register('-p', 'ses_current', { agentId: 'writer', createdAt: 'x' })
    h.byKey.set('live', 'ses_current')
    h.agentDb.set('ses_old', 'writer')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/marker ses_old refused — .*older than the session console live is bound to/)
    warn.mockRestore()
    expect(h.native.get('-p', 'ses_old')).toBeNull()
    expect(h.byKey.get('live')).toBe('ses_current')
  })

  // a nested `opencode run` from the console's shell writes
  // a marker with the TUI session as parent (shell.env) — never a new
  // conversation, never a move of the binding. A marker without a console
  // key never touches a console either.
  it('a nested run under a bound key (parent set, or no consoleKey) is not sealed; the binding stays', async () => {
    const h = harness()
    h.put('writer', 'ses_first')
    expect(await h.registrar.sweep()).toBe(1)
    await tick()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.put('writer', 'ses_nested', { parent: 'ses_first' })
    h.put('writer', 'ses_nokey', { consoleKey: null, parent: 'ses_first' })
    h.put('writer', 'ses_nokey_root', { consoleKey: null })
    expect(await h.registrar.sweep()).toBe(0)
    warn.mockRestore()
    for (const id of ['ses_nested', 'ses_nokey', 'ses_nokey_root']) expect(h.native.get('-p', id)).toBeNull()
    expect(h.byKey.get('live')).toBe('ses_first')
    expect(h.bound).toEqual([['live', 'ses_first']])
  })

  it('a key bound to a session that was never sealed for this agent is not moved', async () => {
    const h = harness()
    h.byKey.set('live', 'ses_foreign') // no native record of writer's
    h.put('writer', 'ses_second')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    warn.mockRestore()
    expect(h.byKey.get('live')).toBe('ses_foreign')
  })

  it('a marker older than the console record is refused', async () => {
    const h = harness()
    h.put('writer', 'ses_first')
    expect(await h.registrar.sweep()).toBe(1)
    h.put('writer', 'ses_second')
    // the record says the console was (re)created after the marker landed
    h.consoles.get('live')!.createdMs = Date.now() + 60_000
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.registrar.sweep()).toBe(0)
    warn.mockRestore()
    expect(h.byKey.get('live')).toBe('ses_first')
  })
})
